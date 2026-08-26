#!/usr/bin/env node
/**
 * Real-schema, network-isolated PostgreSQL 17 proof for vendor-bill versus
 * period-close serialization.  The barriers are disposable triggers only;
 * writers call the real restored RPCs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForDatabaseReadiness } from './vendor-bill-period-close-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-vendor-period-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.141';
const BASE = path.join(ROOT, 'supabase', 'baselines');
const BASELINE_MANIFEST = JSON.parse(readFileSync(path.join(BASE, 'manifest.json'), 'utf8'));
const MIGRATION_SUFFIX = '_vendor_bill_period_close_lock.sql';
const IDEMPOTENCY_RECHECK_SUFFIX = '_close_accounting_period_idempotency_recheck.sql';
const IMMUTABLE_DATE_MATH_SUFFIX = '_accounting_period_immutable_date_math.sql';
const AP_BOUNDARY_HARDENING_SUFFIX = '_ap_period_close_boundary_hardening.sql';
const migrationDir = path.join(ROOT, 'supabase', 'migrations');
const migrationMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(MIGRATION_SUFFIX));
assert.equal(migrationMatches.length, 1, `expected exactly one ${MIGRATION_SUFFIX} migration, found ${migrationMatches.join(', ') || 'none'}`);
const MIGRATION = path.join(migrationDir, migrationMatches[0]);
const idempotencyRecheckMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(IDEMPOTENCY_RECHECK_SUFFIX));
assert.equal(idempotencyRecheckMatches.length, 1, `expected exactly one ${IDEMPOTENCY_RECHECK_SUFFIX} migration, found ${idempotencyRecheckMatches.join(', ') || 'none'}`);
const IDEMPOTENCY_RECHECK_MIGRATION = path.join(migrationDir, idempotencyRecheckMatches[0]);
const immutableDateMathMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(IMMUTABLE_DATE_MATH_SUFFIX));
assert.equal(immutableDateMathMatches.length, 1, `expected exactly one ${IMMUTABLE_DATE_MATH_SUFFIX} migration, found ${immutableDateMathMatches.join(', ') || 'none'}`);
const IMMUTABLE_DATE_MATH_MIGRATION = path.join(migrationDir, immutableDateMathMatches[0]);
const apBoundaryHardeningMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(AP_BOUNDARY_HARDENING_SUFFIX));
assert.equal(apBoundaryHardeningMatches.length, 1, `expected exactly one ${AP_BOUNDARY_HARDENING_SUFFIX} migration, found ${apBoundaryHardeningMatches.join(', ') || 'none'}`);
const AP_BOUNDARY_HARDENING_MIGRATION = path.join(migrationDir, apBoundaryHardeningMatches[0]);
const HELPER_ACL_POSTFLIGHT_SUFFIX = '_vendor_bill_month_lock_helper_acl_postflight.sql';
const helperAclPostflightMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(HELPER_ACL_POSTFLIGHT_SUFFIX));
assert.equal(helperAclPostflightMatches.length, 1, `expected exactly one ${HELPER_ACL_POSTFLIGHT_SUFFIX} migration, found ${helperAclPostflightMatches.join(', ') || 'none'}`);
const HELPER_ACL_POSTFLIGHT_MIGRATION = path.join(migrationDir, helperAclPostflightMatches[0]);
const CANDIDATE_MIGRATIONS = [
  MIGRATION,
  IDEMPOTENCY_RECHECK_MIGRATION,
  IMMUTABLE_DATE_MATH_MIGRATION,
  HELPER_ACL_POSTFLIGHT_MIGRATION,
];
const candidateMigrationPaths = new Set(CANDIDATE_MIGRATIONS.map((local) => path.resolve(local)));
const SIBLING_SMOKES = [
  'smoke-section9-po-ap-high-remediation.sql',
  'smoke-finance-charge-month-dedup.sql',
  'smoke-delivery-accounting-period-guard.sql',
];
const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const KEY = 818181;
const BARRIER_SECONDS = 8;

function run(args, { input, fail = false } = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 60 * 1024 * 1024 });
  if (r.error || (!fail && r.status !== 0)) throw new Error(`${r.error?.message || ''}\n${r.stderr || r.stdout}`);
  return r;
}
function psqlArgs() { return ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']; }
function sql(s, o = {}) { return run(psqlArgs(), { input: s, fail: o.fail }); }
function adminSql(s, o = {}) { return run(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: s, fail: o.fail }); }
function scalar(s) { const out = sql(s).stdout.trim().split(/\r?\n/).filter(Boolean); return out.at(-1); }
function session(s, marker) {
  const child = spawn('docker', psqlArgs(), { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', resolved = false, resolve, reject, timer;
  const ready = new Promise((r, j) => { resolve = r; reject = j; timer = setTimeout(() => { if (!resolved) { resolved = true; j(new Error(`timeout ${marker}: ${out}\n${err}`)); } }, 20000); });
  // Every caller uses a deterministic marker, but retain a rejection handler
  // so an unexpected child exit never becomes an unhandled promise rejection.
  ready.catch(() => {});
  child.stdout.on('data', x => { out += x; if (!resolved && out.includes(marker)) { resolved = true; clearTimeout(timer); resolve(); } });
  child.stderr.on('data', x => { err += x; });
  child.stdin.end(s);
  const done = new Promise(r => child.on('close', code => { if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error(`ended before ${marker}: ${out}\n${err}`)); } r({ code, out, err }); }));
  return { ready, done };
}
async function waitForLock({ classId, objectId, mode, granted, count = 1 }, label) {
  assert.match(mode, /^(ExclusiveLock|ShareLock)$/);
  const query = `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=${classId} AND objid=${objectId} AND mode='${mode}' AND granted IS ${granted ? 'TRUE' : 'FALSE'};`;
  return waitForDatabaseReadiness({
    label,
    observe: async () => {
      const observed = Number(scalar(query));
      return { ready: observed >= count, observed, required: count };
    },
  });
}
function waitForBarrierWaiters(count, label) {
  return waitForLock({ classId: 0, objectId: KEY, mode: 'ExclusiveLock', granted: false, count }, label);
}
function waitForMonthLock(month, mode, granted, count, label) {
  return waitForLock({ classId: 73492010, objectId: month, mode, granted, count }, label);
}
function waitForSessionLock(applicationName, label) {
  const query = `SELECT count(*) FROM pg_stat_activity WHERE application_name='${applicationName}' AND wait_event_type='Lock';`;
  return waitForDatabaseReadiness({
    label,
    observe: async () => {
      const observed = Number(scalar(query));
      return { ready: observed >= 1, observed, applicationName, wait_event_type: 'Lock' };
    },
  });
}
function claims() { return `SET request.jwt.claim.sub='${ADMIN}'; SET request.jwt.claim.role='authenticated';`; }
function expectError(r, code, label) { assert.notEqual(r.code, 0, `${label} unexpectedly succeeded`); assert.match(`${r.out}\n${r.err}`, new RegExp(code), `${label}: ${r.out}\n${r.err}`); }
function jsonResult(r, label) {
  const line = r.out.split(/\r?\n/).map((value) => value.trim()).find((value) => value.startsWith('{'));
  assert.ok(line, `${label} returned no JSON result: ${r.out}\n${r.err}`);
  return JSON.parse(line);
}
function applyFile(name) { return sql(`BEGIN;\n\\i /tmp/${name}\nCOMMIT;`); }
function copySql(local, remote) {
  const staged = path.join(tmpdir(), `${NAME}-${remote}`);
  let operationError;
  try {
    writeFileSync(staged, readFileSync(local, 'utf8').replaceAll('\r\n', '\n'), 'utf8');
    run(['cp', staged, `${NAME}:/tmp/${remote}`]);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      unlinkSync(staged);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (operationError) console.error(`Failed to clean staged SQL ${staged}:`, error);
        else throw error;
      }
    }
  }
}
function baselineArtifact(suffix) {
  const hits = Object.keys(BASELINE_MANIFEST.artifacts ?? {}).filter((name) => name.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one baseline artifact *${suffix}, found ${hits.join(', ') || 'none'}`);
  const local = path.join(BASE, hits[0]);
  assert.ok(existsSync(local), `baseline artifact is missing: ${local}`);
  const actualSha = createHash('sha256').update(readFileSync(local)).digest('hex').toUpperCase();
  assert.equal(
    actualSha,
    BASELINE_MANIFEST.artifacts[hits[0]].sha256,
    `baseline artifact ${hits[0]} does not match its manifest SHA-256`,
  );
  return local;
}
function postBaselineMigrations() {
  const script = path.join(ROOT, 'scripts', 'list-post-baseline-migrations.mjs');
  assert.ok(existsSync(script), `post-baseline migration enumerator is missing: ${script}`);
  const history = path.basename(baselineArtifact('_migration_history.sql'));
  assert.equal(
    history.slice(0, 14),
    BASELINE_MANIFEST.migrations_high_water,
    `baseline history ${history} does not match migrations_high_water ${BASELINE_MANIFEST.migrations_high_water}`,
  );
  const schemaArtifacts = Object.keys(BASELINE_MANIFEST.artifacts ?? {})
    .filter((name) => name.endsWith('_public_schema.sql.br'));
  assert.equal(schemaArtifacts.length, 1, `expected exactly one baseline schema artifact, found ${schemaArtifacts.join(', ') || 'none'}`);
  assert.equal(
    schemaArtifacts[0].slice(0, 14),
    BASELINE_MANIFEST.migrations_high_water,
    `baseline schema ${schemaArtifacts[0]} does not match migrations_high_water ${BASELINE_MANIFEST.migrations_high_water}`,
  );
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `could not enumerate post-baseline migrations:\n${result.stderr || result.stdout}`);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((relative) => {
    assert.match(relative, /^supabase\/migrations\/\d{14}_[^/]+\.sql$/, `unexpected post-baseline output: ${relative}`);
    const local = path.join(ROOT, relative);
    assert.ok(existsSync(local), `listed post-baseline migration is missing: ${relative}`);
    return local;
  });
}
const pendingMigrations = postBaselineMigrations();
const candidateIndices = CANDIDATE_MIGRATIONS.map((local) =>
  pendingMigrations.findIndex((pending) => path.resolve(pending) === path.resolve(local)));
assert.ok(candidateIndices.every((index) => index >= 0), 'all release candidate migrations must be in the post-baseline replay');
assert.deepEqual(
  candidateIndices,
  candidateIndices.map((_, offset) => candidateIndices[0] + offset),
  'the release candidate migrations must be consecutive and in release order',
);
const apBoundaryHardeningIndex = pendingMigrations.findIndex((pending) =>
  path.resolve(pending) === path.resolve(AP_BOUNDARY_HARDENING_MIGRATION));
assert.ok(apBoundaryHardeningIndex > candidateIndices.at(-1), 'AP boundary hardening must replay after the original release candidate group');
const preCandidateMigrations = pendingMigrations.slice(0, candidateIndices[0]);
const postCandidateMigrations = pendingMigrations.slice(candidateIndices.at(-1) + 1);
assert.ok(
  [...preCandidateMigrations, ...postCandidateMigrations]
    .every((local) => !candidateMigrationPaths.has(path.resolve(local))),
  'candidate migration was classified into the surrounding replay',
);
function applyMigration(local, marker) {
  const name = path.basename(local);
  const remote = `${marker}_${name}`;
  copySql(local, remote);
  const ownsTransaction = /^[ \t]*BEGIN[ \t]*;/mi.test(readFileSync(local, 'utf8'));
  if (ownsTransaction) sql(`\\i /tmp/${remote}`);
  else applyFile(remote);
  console.log(`POST_BASELINE_MIGRATION_APPLIED ${name}${ownsTransaction ? ' (self-transacted)' : ''}`);
}

function expectValidationFailure(local, marker, expectedError) {
  const name = path.basename(local);
  const remote = `${marker}_${name}`;
  copySql(local, remote);
  const result = sql(`BEGIN;\n\\i /tmp/${remote}\nCOMMIT;`, { fail: true });
  assert.notEqual(result.status, 0, `${marker}: validation migration unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(expectedError), `${marker}: wrong validation failure`);
  console.log(`CANDIDATE_VALIDATION_MUTATION_REJECTED ${marker}`);
}

function restoreLiveCrLfCloseRemainder() {
  const definingPath = path.join(
    ROOT,
    'supabase',
    'migrations',
    '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql',
  );
  const source = readFileSync(definingPath, 'utf8').replace(/\r\n/g, '\n');
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  assert.ok(tag, 'close-remainder body has no dollar quote');
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  assert.ok(bodyEnd > bodyStart, 'close-remainder body is unterminated');
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  assert.equal(
    createHash('md5').update(body, 'utf8').digest('hex'),
    'e2d4b46c47be7561a8829191c30dc0a7',
    'close-remainder live CRLF body hash drifted',
  );
  sql(`
CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(
  p_order_id uuid, p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $live_crlf_close$${body}$live_crlf_close$;
`);
  console.log('FULL_SCHEMA_LIVE_BODY_RESTORED _close_undelivered_order_remainder_20260718 crlf=true');
}

try {
  run(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  let ok = false;
  for (let i = 0; i < 60; i += 1) {
    if (run(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { fail: true }).status === 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      if (run(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { fail: true }).status === 0) { ok = true; break; }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  assert.ok(ok, 'PostgreSQL 17 did not start');
  adminSql('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);');
  run(['cp', baselineArtifact('_extensions.sql'), `${NAME}:/tmp/extensions.sql`]);
  run(['cp', baselineArtifact('_acl_lockdown.sql'), `${NAME}:/tmp/acl.sql`]);
  run(['cp', baselineArtifact('_platform_overlay.sql'), `${NAME}:/tmp/platform.sql`]);
  run(['cp', baselineArtifact('_migration_history.sql'), `${NAME}:/tmp/migration-history.sql`]);
  applyFile('extensions.sql');
  const decoded = spawnSync('node', ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 60 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  run(psqlArgs(), { input: decoded.stdout });
  adminSql(`
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL,
  name text NOT NULL, owner_id text
);
CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[] LANGUAGE sql IMMUTABLE
AS $$ SELECT string_to_array(name, '/') $$;
CREATE OR REPLACE FUNCTION storage.filename(name text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
`);
  applyFile('acl.sql');
  adminSql('\\i /tmp/platform.sql');
  sql(`
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  statements text[]
);
\\i /tmp/migration-history.sql
`);
  for (const local of preCandidateMigrations) applyMigration(local, 'pre_candidate');
  console.log(`PRE_CANDIDATE_POST_BASELINE_REPLAY_PASS count=${preCandidateMigrations.length} baseline_high_water=${BASELINE_MANIFEST.migrations_high_water}`);
  // The concurrency contract is entirely in public/auth. The storage platform
  // overlay is intentionally not needed by these RPC paths on a networkless
  // disposable PostgreSQL image.
  // The verified migration-ledger baseline is restored because later
  // post-baseline migration preflights read its high-water mark. No platform
  // mutation or network access is involved.
  sql(`${claims()} INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${ADMIN}','period-proof@example.invalid','{"full_name":"Period Proof Admin","role":"admin"}'::jsonb) ON CONFLICT DO NOTHING; INSERT INTO public.profiles(id,email,role,is_active) VALUES ('${ADMIN}','period-proof@example.invalid','admin',true) ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role,is_active=true;`);

  const vendor = scalar(`INSERT INTO public.vendors(name) VALUES ('[PROOF] period vendor ${process.pid}') RETURNING id;`);
  const date = '2025-01-15', end = '2025-01-31', monthKey = 2025 * 12 + 1 - 1;
  const bill = (key, d = date) => `${claims()} SELECT public.create_vendor_bill('${vendor}'::uuid,NULL,'proof-${key}','${d}',NULL,NULL,1000,0,NULL,'${key}');`;
  const close = key => `${claims()} SELECT public.close_accounting_period('${end}'::date,'${ADMIN}'::uuid,'${key}');`;
  const recordPayment = (billId, key, amount = 100) => `${claims()} SELECT public.record_vendor_payment('${billId}'::uuid,${amount},'${date}'::date,'check',NULL,NULL,'${key}');`;
  const voidPayment = (paymentId, key) => `${claims()} SELECT public.void_vendor_payment('${paymentId}'::uuid,'proof void','${key}');`;
  const voidBill = (billId, key) => `${claims()} SELECT public.void_vendor_bill('${billId}'::uuid,'proof void','${key}');`;

  // Baseline: pause the real writer after its real period check, close, then
  // release it. This proves the old check-then-write race.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_bill() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_bill BEFORE INSERT OR UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_bill();`);
  const holder = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await holder.ready;
  const oldWriter = session(`BEGIN; SET application_name='baseline-writer'; ${bill('baseline-create')} COMMIT; SELECT 'BASELINE_WRITER_DONE';`, 'BASELINE_WRITER_DONE');
  await waitForBarrierWaiters(1, 'baseline writer trigger barrier');
  const oldClose = sql(`BEGIN; ${close('baseline-close')} COMMIT;`); assert.equal(oldClose.status, 0, oldClose.stderr);
  const oldResult = await oldWriter.done; assert.equal(oldResult.code, 0, oldResult.err);
  assert.equal(scalar(`SELECT status FROM public.accounting_periods WHERE period_start='2025-01-01'`), 'closed');
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_bills WHERE bill_number='proof-baseline-create'`), '1');
  console.log('BASELINE_CREATE_CLOSE_RACE_REPRODUCED');

  sql(`DELETE FROM public.vendor_bills WHERE bill_number='proof-baseline-create'; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DROP TRIGGER proof_pause_bill ON public.vendor_bills; DROP FUNCTION public._proof_pause_bill();`);
  for (const local of CANDIDATE_MIGRATIONS) {
    if (local !== HELPER_ACL_POSTFLIGHT_MIGRATION) {
      applyMigration(local, 'candidate');
      continue;
    }

    sql(`CREATE ROLE proof_untrusted_helper_owner NOLOGIN; GRANT proof_untrusted_helper_owner TO postgres; GRANT USAGE, CREATE ON SCHEMA public TO proof_untrusted_helper_owner; ALTER FUNCTION public._lock_accounting_months(date[], boolean) OWNER TO proof_untrusted_helper_owner;`);
    expectValidationFailure(local, 'helper-untrusted-owner', 'VENDOR_BILL_MONTH_LOCK_HELPER_TRUSTED_OWNER_DRIFT');
    sql(`ALTER FUNCTION public._lock_accounting_months(date[], boolean) OWNER TO postgres; REVOKE ALL ON SCHEMA public FROM proof_untrusted_helper_owner; REVOKE proof_untrusted_helper_owner FROM postgres; DROP ROLE proof_untrusted_helper_owner;`);

    sql(`CREATE ROLE proof_helper_exec_grantee NOLOGIN; GRANT EXECUTE ON FUNCTION public._lock_accounting_months(date[], boolean) TO proof_helper_exec_grantee;`);
    expectValidationFailure(local, 'helper-custom-execute', 'VENDOR_BILL_MONTH_LOCK_HELPER_ACL_DRIFT');
    sql(`REVOKE EXECUTE ON FUNCTION public._lock_accounting_months(date[], boolean) FROM proof_helper_exec_grantee; DROP ROLE proof_helper_exec_grantee;`);

    applyMigration(local, 'candidate');
  }
  for (const local of postCandidateMigrations) {
    if (path.basename(local) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') {
      restoreLiveCrLfCloseRemainder();
    }
    if (path.basename(local) === '20260826125456_bind_section9_ap_receiving_intent_and_month_dashboard.sql') {
      sql(`
DELETE FROM public.idempotency_keys
 WHERE expires_at >= now()
   AND operation IN (
     'create_vendor_bill', 'update_vendor_bill', 'record_vendor_payment',
     'void_vendor_payment', 'void_vendor_bill', 'receive_po_items'
   )
   AND (request_actor_id IS NULL OR request_fingerprint IS NULL);
`);
      const cutoverRemote = `section9-cutover-${path.basename(local)}`;
      copySql(local, cutoverRemote);
      const legacyWriter = session(`
BEGIN;
SET application_name='section9-legacy-receipt-writer';
INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
VALUES ('section9-cutover-held-receipt', 'record_vendor_payment', '{"payment_id":"00000000-0000-0000-0000-000000000099"}'::jsonb);
SELECT 'SECTION9_LEGACY_RECEIPT_HELD';
SELECT pg_sleep(${BARRIER_SECONDS});
COMMIT;
`, 'SECTION9_LEGACY_RECEIPT_HELD');
      await legacyWriter.ready;
      const cutover = session(`
BEGIN;
SET application_name='section9-cutover-migration';
SELECT 'SECTION9_CUTOVER_STARTED';
\\i /tmp/${cutoverRemote}
COMMIT;
`, 'SECTION9_CUTOVER_STARTED');
      await cutover.ready;
      await waitForSessionLock('section9-cutover-migration', 'Section 9 cutover waiting for legacy receipt writer');
      const [legacyWriterResult, cutoverResult] = await Promise.all([legacyWriter.done, cutover.done]);
      assert.equal(legacyWriterResult.code, 0, legacyWriterResult.err);
      expectError(cutoverResult, 'SECTION9_ACTIVE_LEGACY_IDEMPOTENCY_RECEIPTS', 'Section 9 drained cutover preflight');
      console.log('CANDIDATE_SECTION9_CUTOVER_DRAINS_LEGACY_WRITER_PASS');
      const legacyCount = Number(scalar(`
SELECT count(*)
  FROM public.idempotency_keys
 WHERE expires_at >= now()
   AND operation IN (
     'create_vendor_bill', 'update_vendor_bill', 'record_vendor_payment',
     'void_vendor_payment', 'void_vendor_bill', 'receive_po_items'
   )
   AND (request_actor_id IS NULL OR request_fingerprint IS NULL);
`));
      assert.ok(legacyCount > 0, 'legacy-receipt mutation proof had no synthetic receipt to remove');
      sql(`
DELETE FROM public.idempotency_keys
 WHERE expires_at >= now()
   AND operation IN (
     'create_vendor_bill', 'update_vendor_bill', 'record_vendor_payment',
     'void_vendor_payment', 'void_vendor_bill', 'receive_po_items'
   )
   AND (request_actor_id IS NULL OR request_fingerprint IS NULL);
`);
      console.log(`CANDIDATE_ACTIVE_LEGACY_RECEIPT_GUARD_PASS removed_disposable=${legacyCount}`);
    }
    applyMigration(local, 'post_candidate');
  }
  console.log(`FULL_POST_BASELINE_REPLAY_PASS count=${pendingMigrations.length} baseline_high_water=${BASELINE_MANIFEST.migrations_high_water}`);

  // A request that resolved an old function body before cutover can resume
  // afterwards. Its private implementation has no binding context, so the
  // receipt trigger must reject the INSERT and roll back the payment itself.
  const lateOldBodyBill = scalar(`${bill('section9-late-old-body-bill')}`);
  const lateOldBody = sql(`${claims()}
SELECT public._section9_record_vendor_payment_intent_impl_20260826(
  '${lateOldBodyBill}'::uuid, 100, '${date}'::date, 'check', NULL, NULL,
  'section9-late-old-body-payment'
);`, { fail: true });
  assert.notEqual(lateOldBody.status, 0, 'late old payment body unexpectedly succeeded');
  assert.match(`${lateOldBody.stdout}\n${lateOldBody.stderr}`, /SECTION9_UNBOUND_IDEMPOTENCY_RECEIPT/);
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_payments WHERE vendor_bill_id='${lateOldBodyBill}'::uuid`), '0');
  assert.equal(scalar(`SELECT paid_cents FROM public.vendor_bills WHERE id='${lateOldBodyBill}'::uuid`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='section9-late-old-body-payment'`), '0');
  sql(`DELETE FROM public.vendor_bills WHERE id='${lateOldBodyBill}'::uuid; DELETE FROM public.idempotency_keys WHERE idempotency_key='section9-late-old-body-bill';`);
  console.log('CANDIDATE_SECTION9_LATE_OLD_BODY_ROLLBACK_PASS');

  // The candidate must be visibly present before the registered business chains
  // and two-session schedules run.
  assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid='public.accounting_periods'::regclass AND conname='accounting_periods_whole_calendar_month_check'`), '1');
  assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid='public.accounting_periods'::regclass AND conname='accounting_periods_whole_calendar_month_check' AND pg_get_constraintdef(oid, true) LIKE '%timestamp without time zone%'`), '1');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['create_vendor_bill','update_vendor_bill','close_accounting_period']) AND (NOT p.prosecdef OR NOT has_function_privilege(p.proowner, 'public._lock_accounting_months(date[],boolean)'::regprocedure, 'EXECUTE'))`), '0');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['create_vendor_bill','update_vendor_bill','check_period_open','close_accounting_period']) AND (NOT p.prosecdef OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))`), '0');
  console.log('CANDIDATE_POSTFLIGHT_OWNER_AND_ACL_PASS');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['record_vendor_payment','void_vendor_payment','void_vendor_bill']) AND (NOT p.prosecdef OR NOT has_function_privilege(p.proowner, 'public._lock_accounting_months(date[],boolean)'::regprocedure, 'EXECUTE') OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))`), '0');
  assert.equal(scalar(`SELECT (has_table_privilege('authenticated', 'public.accounting_periods', 'INSERT') OR has_table_privilege('authenticated', 'public.accounting_periods', 'UPDATE') OR has_table_privilege('authenticated', 'public.accounting_periods', 'DELETE') OR has_table_privilege('authenticated', 'public.accounting_periods', 'TRUNCATE') OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.accounting_periods'::regclass AND polcmd IN ('a','w','d','*')))::int`), '0');
  const directPeriodWrite = sql(`BEGIN; ${claims()} SET LOCAL ROLE authenticated; INSERT INTO public.accounting_periods(period_start,period_end,status,closed_by) VALUES ('2031-01-01','2031-01-31','open','${ADMIN}'::uuid); COMMIT;`, { fail: true });
  assert.notEqual(directPeriodWrite.status, 0, 'authenticated direct accounting-period insert unexpectedly succeeded');
  assert.match(`${directPeriodWrite.stdout}\n${directPeriodWrite.stderr}`, /permission denied|row-level security/i);
  assert.equal(scalar(`SELECT count(*) FROM public.accounting_periods WHERE period_start='2031-01-01'`), '0');
  console.log('CANDIDATE_AP_BOUNDARY_POSTFLIGHT_PASS');
  console.log('CANDIDATE_ACCOUNTING_PERIODS_DIRECT_WRITE_DENIED_PASS');
  // Same idempotency key: pause the first real close after its exclusive month
  // lock but before its upsert. The current check_idempotency helper serializes
  // this key before that lock, so this schedule proves helper serialization and
  // replay, not that the later defense-in-depth lookup is causally necessary.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_period() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_period BEFORE INSERT ON public.accounting_periods FOR EACH ROW EXECUTE FUNCTION public._proof_pause_period();`);
  const sameKeyHolder = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await sameKeyHolder.ready;
  const sameKeyFirst = session(`BEGIN; ${close('same-key-close')} COMMIT; SELECT 'SAME_KEY_FIRST_DONE';`, 'SAME_KEY_FIRST_DONE');
  await waitForBarrierWaiters(1, 'same-key first close insert trigger barrier');
  await waitForMonthLock(monthKey, 'ExclusiveLock', true, 1, 'same-key first close exclusive month lock');
  const sameKeySecond = session(`BEGIN; SET application_name='same-key-second-close'; SELECT 'SAME_KEY_SECOND_STARTED'; ${close('same-key-close')} COMMIT; SELECT 'SAME_KEY_SECOND_DONE';`, 'SAME_KEY_SECOND_STARTED');
  await sameKeySecond.ready;
  // check_idempotency intentionally serializes this exact key before the
  // month helper, so observe that real advisory-lock wait rather than assume
  // this child remains alive for an arbitrary duration.
  await waitForSessionLock('same-key-second-close', 'same-key second close waiting on its idempotency lock');
  await sameKeyHolder.done;
  const [sameFirstResult, sameSecondResult] = await Promise.all([sameKeyFirst.done, sameKeySecond.done]);
  assert.equal(sameFirstResult.code, 0, sameFirstResult.err);
  assert.equal(sameSecondResult.code, 0, sameSecondResult.err);
  assert.deepEqual(jsonResult(sameFirstResult, 'same-key first close'), jsonResult(sameSecondResult, 'same-key second close'));
  assert.equal(scalar(`SELECT count(*) FROM public.accounting_periods WHERE period_start='2025-01-01'`), '1');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='same-key-close' AND operation='close_accounting_period'`), '1');
  sql(`DROP TRIGGER proof_pause_period ON public.accounting_periods; DROP FUNCTION public._proof_pause_period(); DELETE FROM public.accounting_periods WHERE period_start='2025-01-01';`);
  console.log('CANDIDATE_CLOSE_SAME_KEY_SERIALIZATION_PASS');
  sql(`${claims()} INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('00000000-0000-0000-0000-0000000000a2','period-proof-applicator@example.invalid','{"full_name":"Period Proof Applicator","role":"applicator"}'::jsonb) ON CONFLICT DO NOTHING; INSERT INTO public.profiles(id,email,role,is_active) VALUES ('00000000-0000-0000-0000-0000000000a2','period-proof-applicator@example.invalid','applicator',true) ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role,is_active=true;`);
  sql(`INSERT INTO public.products(product_name) VALUES ('[PROOF] sibling smoke product ${process.pid}');`);
  for (const sibling of SIBLING_SMOKES) {
    run(['cp', path.join(ROOT, 'scripts', 'smoke', sibling), `${NAME}:/tmp/${sibling}`]);
    const siblingResult = sql(`${claims()}\n\\i /tmp/${sibling}`, { fail: true });
    assert.match(`${siblingResult.stdout}\n${siblingResult.stderr}`, /SMOKE_PASS_ROLLBACK/, `${sibling} did not reach rollback marker`);
    console.log(`SIBLING_${sibling.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_PASS`);
  }

  // Candidate writer-first: its actual check owns shared 73492010/month while
  // the proof trigger pauses before INSERT; close must wait on that advisory key.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_bill() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_bill BEFORE INSERT OR UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_bill();`);
  const h1 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h1.ready;
  const writer = session(`BEGIN; ${bill('candidate-writer-first')} COMMIT; SELECT 'WRITER_DONE';`, 'WRITER_DONE');
  await waitForBarrierWaiters(1, 'candidate writer trigger barrier');
  await waitForMonthLock(monthKey, 'ShareLock', true, 1, 'candidate writer shared month lock');
  const closer = session(`BEGIN; ${close('candidate-writer-close')} COMMIT; SELECT 'CLOSE_DONE';`, 'CLOSE_DONE');
  await waitForMonthLock(monthKey, 'ExclusiveLock', false, 1, 'candidate close waiting on writer month lock');
  const [wr, cr] = await Promise.all([writer.done, closer.done]); assert.equal(wr.code, 0, wr.err); assert.equal(cr.code, 0, cr.err);
  console.log('CANDIDATE_WRITER_FIRST_CLOSE_WAITS_PASS');

  sql(`DELETE FROM public.vendor_bills WHERE bill_number='proof-candidate-writer-first'; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DROP TRIGGER proof_pause_bill ON public.vendor_bills; DROP FUNCTION public._proof_pause_bill();`);
  // Candidate close-first: pause the real close at accounting_periods INSERT;
  // writer waits, then sees closed state and leaves no side effects.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_period() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_period BEFORE INSERT ON public.accounting_periods FOR EACH ROW EXECUTE FUNCTION public._proof_pause_period();`);
  const h2 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h2.ready;
  const cfirst = session(`BEGIN; ${close('candidate-close-first')} COMMIT; SELECT 'CLOSE_FIRST_DONE';`, 'CLOSE_FIRST_DONE');
  await waitForBarrierWaiters(1, 'candidate close-first insert trigger barrier');
  const wfirst = session(`BEGIN; SELECT 'WRITER_STARTED'; ${bill('candidate-close-first-writer')} COMMIT;`, 'WRITER_STARTED'); await wfirst.ready;
  await waitForMonthLock(monthKey, 'ShareLock', false, 1, 'candidate writer waiting on close month lock');
  const [cf, wf] = await Promise.all([cfirst.done, wfirst.done]); assert.equal(cf.code, 0, cf.err); expectError(wf, 'closed accounting period', 'close-first writer');
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_bills WHERE bill_number='proof-candidate-close-first-writer'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='candidate-close-first-writer'`), '0');
  console.log('CANDIDATE_CLOSE_FIRST_FAIL_CLOSED_PASS');

  sql(`DROP TRIGGER proof_pause_period ON public.accounting_periods; DROP FUNCTION public._proof_pause_period(); DELETE FROM public.accounting_periods WHERE period_start='2025-01-01';`);
  const update = (id, d, key) => `${claims()} SELECT public.update_vendor_bill('${id}'::uuid,1000,0,'${d}'::date,'${d}'::date,'[PROOF] ${key}','${key}');`;
  const updateSource = scalar(`${bill('update-source')} `);
  // Update writer-first: actual update locks its bill row, then both old/new
  // months before the proof-only BEFORE UPDATE barrier. Closing January waits.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_bill_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_bill_update BEFORE UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_bill_update();`);
  const h3 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h3.ready;
  const updateWriter = session(`BEGIN; ${update(updateSource, '2025-02-15', 'update-writer-first')} COMMIT; SELECT 'UPDATE_WRITER_DONE';`, 'UPDATE_WRITER_DONE');
  await waitForBarrierWaiters(1, 'update writer trigger barrier');
  await waitForMonthLock(monthKey, 'ShareLock', true, 1, 'update writer shared January lock');
  const updateClose = session(`BEGIN; ${close('update-writer-close')} COMMIT; SELECT 'UPDATE_CLOSE_DONE';`, 'UPDATE_CLOSE_DONE');
  await waitForMonthLock(monthKey, 'ExclusiveLock', false, 1, 'update close waiting on writer month lock');
  const [uw, uc] = await Promise.all([updateWriter.done, updateClose.done]); assert.equal(uw.code, 0, uw.err); assert.equal(uc.code, 0, uc.err);
  assert.equal(scalar(`SELECT bill_date::text FROM public.vendor_bills WHERE id='${updateSource}'::uuid`), '2025-02-15');
  console.log('CANDIDATE_UPDATE_WRITER_FIRST_CLOSE_WAITS_PASS');

  sql(`DELETE FROM public.vendor_bills WHERE id='${updateSource}'::uuid; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DROP TRIGGER proof_pause_bill_update ON public.vendor_bills; DROP FUNCTION public._proof_pause_bill_update();`);
  const closeFirstBill = scalar(`${bill('update-close-first')}`);
  const auditBefore = scalar(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id='${closeFirstBill}'::uuid`);
  const feedBefore = scalar(`SELECT count(*) FROM public.activity_feed WHERE related_entity_id='${closeFirstBill}'::uuid`);
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_period() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_period BEFORE INSERT ON public.accounting_periods FOR EACH ROW EXECUTE FUNCTION public._proof_pause_period();`);
  const h4 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h4.ready;
  const updateCfirst = session(`BEGIN; ${close('update-close-first-close')} COMMIT; SELECT 'UPDATE_CLOSE_FIRST_DONE';`, 'UPDATE_CLOSE_FIRST_DONE');
  await waitForBarrierWaiters(1, 'update close-first insert trigger barrier');
  const updateBlocked = session(`BEGIN; SELECT 'UPDATE_STARTED'; ${update(closeFirstBill, '2025-02-15', 'update-close-first-writer')} COMMIT;`, 'UPDATE_STARTED'); await updateBlocked.ready;
  await waitForMonthLock(monthKey, 'ShareLock', false, 1, 'update writer waiting on close month lock');
  const [ucf, ub] = await Promise.all([updateCfirst.done, updateBlocked.done]); assert.equal(ucf.code, 0, ucf.err); expectError(ub, 'closed accounting period', 'close-first update');
  assert.equal(scalar(`SELECT bill_date::text FROM public.vendor_bills WHERE id='${closeFirstBill}'::uuid`), '2025-01-15');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='update-close-first-writer'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id='${closeFirstBill}'::uuid`), auditBefore);
  assert.equal(scalar(`SELECT count(*) FROM public.activity_feed WHERE related_entity_id='${closeFirstBill}'::uuid`), feedBefore);
  console.log('CANDIDATE_UPDATE_CLOSE_FIRST_FAIL_CLOSED_PASS');

  sql(`DROP TRIGGER proof_pause_period ON public.accounting_periods; DROP FUNCTION public._proof_pause_period(); DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DELETE FROM public.vendor_bills WHERE id='${closeFirstBill}'::uuid;`);
  const janBill = scalar(`${bill('reverse-jan', '2025-01-15')}`);
  const febBill = scalar(`${bill('reverse-feb', '2025-02-15')}`);
  // Both distinct rows request opposite directions simultaneously. A
  // disposable post-check UPDATE barrier holds both real RPCs after they have
  // acquired their helper locks, making the two-session assertion deterministic.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_bill_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_bill_update BEFORE UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_bill_update();`);
  const h5 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h5.ready;
  const reverseA = session(`BEGIN; SET lock_timeout='10s'; SELECT 'REVERSE_A_STARTED'; ${update(janBill, '2025-02-15', 'reverse-a')} COMMIT; SELECT 'REVERSE_A_DONE';`, 'REVERSE_A_STARTED');
  const reverseB = session(`BEGIN; SET lock_timeout='10s'; SELECT 'REVERSE_B_STARTED'; ${update(febBill, '2025-01-15', 'reverse-b')} COMMIT; SELECT 'REVERSE_B_DONE';`, 'REVERSE_B_STARTED');
  await Promise.all([reverseA.ready, reverseB.ready]);
  const febKey = 2025 * 12 + 2 - 1;
  await waitForBarrierWaiters(2, 'opposite-direction update trigger barriers');
  await waitForMonthLock(monthKey, 'ShareLock', true, 2, 'opposite-direction updates shared January locks');
  await waitForMonthLock(febKey, 'ShareLock', true, 2, 'opposite-direction updates shared February locks');
  await h5.done;
  const [ra, rb] = await Promise.all([reverseA.done, reverseB.done]); assert.equal(ra.code, 0, ra.err); assert.equal(rb.code, 0, rb.err);
  assert.equal(scalar(`SELECT bill_date::text FROM public.vendor_bills WHERE id='${janBill}'::uuid`), '2025-02-15');
  assert.equal(scalar(`SELECT bill_date::text FROM public.vendor_bills WHERE id='${febBill}'::uuid`), '2025-01-15');
  sql(`DROP TRIGGER proof_pause_bill_update ON public.vendor_bills; DROP FUNCTION public._proof_pause_bill_update();`);
  console.log('CANDIDATE_UPDATE_SHARED_REVERSE_MONTH_COMPLETION_PASS');

  // Mutation-sensitive canonical-order proof. The reverse input is Feb -> Jan,
  // and this live candidate demonstrably requests Jan first: holding Jan
  // exclusively leaves it NOT GRANTED with no granted Feb lock. The static
  // source test separately requires the helper's ascending ORDER BY clause.
  const reverseInput = scalar(`${bill('order-reverse-input', '2025-02-15')}`);
  const h6 = session(`BEGIN; SELECT pg_advisory_xact_lock(73492010, ${monthKey}); SELECT 'JAN_EXCLUSIVE_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); COMMIT;`, 'JAN_EXCLUSIVE_HELD'); await h6.ready;
  const reverseOrder = session(`BEGIN; SELECT 'REVERSE_ORDER_STARTED'; ${update(reverseInput, '2025-01-15', 'order-reverse-input-update')} COMMIT; SELECT 'REVERSE_ORDER_DONE';`, 'REVERSE_ORDER_STARTED'); await reverseOrder.ready;
  await waitForMonthLock(monthKey, 'ShareLock', false, 1, 'reverse-input canonical first January lock');
  assert.equal(scalar(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=73492010 AND objid=${febKey} AND mode='ShareLock' AND granted`), '0');
  await h6.done; const reverseOrderResult = await reverseOrder.done; assert.equal(reverseOrderResult.code, 0, reverseOrderResult.err);
  assert.equal(scalar(`SELECT bill_date::text FROM public.vendor_bills WHERE id='${reverseInput}'::uuid`), '2025-01-15');
  console.log('CANDIDATE_UPDATE_CANONICAL_JAN_FIRST_PASS');

  // The forward input Jan -> Feb complements the reverse proof: hold Feb and
  // observe granted Jan plus a NOT GRANTED Feb request from the actual RPC.
  const forwardInput = scalar(`${bill('order-forward-input', '2025-01-15')}`);
  const h7 = session(`BEGIN; SELECT pg_advisory_xact_lock(73492010, ${febKey}); SELECT 'FEB_EXCLUSIVE_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); COMMIT;`, 'FEB_EXCLUSIVE_HELD'); await h7.ready;
  const forwardOrder = session(`BEGIN; SELECT 'FORWARD_ORDER_STARTED'; ${update(forwardInput, '2025-02-15', 'order-forward-input-update')} COMMIT; SELECT 'FORWARD_ORDER_DONE';`, 'FORWARD_ORDER_STARTED'); await forwardOrder.ready;
  await waitForMonthLock(monthKey, 'ShareLock', true, 1, 'forward-input first January lock');
  await waitForMonthLock(febKey, 'ShareLock', false, 1, 'forward-input waiting February lock');
  await h7.done; const forwardOrderResult = await forwardOrder.done; assert.equal(forwardOrderResult.code, 0, forwardOrderResult.err);
  assert.equal(scalar(`SELECT bill_date::text FROM public.vendor_bills WHERE id='${forwardInput}'::uuid`), '2025-02-15');
  console.log('CANDIDATE_UPDATE_CANONICAL_FORWARD_ORDER_PASS');

  // AP writers use the same month-lock boundary as vendor-bill creation. These
  // disposable barriers fire only after each real RPC has checked the period.
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_ap_writer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_ap_payment_insert BEFORE INSERT ON public.vendor_payments FOR EACH ROW EXECUTE FUNCTION public._proof_pause_ap_writer();`);
  const recordWriterFirstBill = scalar(`${bill('ap-record-writer-first-bill')}`);
  const h8 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h8.ready;
  const recordWriterFirst = session(`BEGIN; SELECT 'AP_RECORD_WRITER_STARTED'; ${recordPayment(recordWriterFirstBill, 'ap-record-writer-first')} COMMIT; SELECT 'AP_RECORD_WRITER_DONE';`, 'AP_RECORD_WRITER_STARTED'); await recordWriterFirst.ready;
  await waitForBarrierWaiters(1, 'record payment writer-first trigger barrier');
  await waitForMonthLock(monthKey, 'ShareLock', true, 1, 'record payment writer shared January lock');
  const recordWriterClose = session(`BEGIN; ${close('ap-record-writer-close')} COMMIT; SELECT 'AP_RECORD_CLOSE_DONE';`, 'AP_RECORD_CLOSE_DONE');
  await waitForMonthLock(monthKey, 'ExclusiveLock', false, 1, 'record payment close waiting on writer month lock');
  await h8.done;
  const [rw, rc] = await Promise.all([recordWriterFirst.done, recordWriterClose.done]); assert.equal(rw.code, 0, rw.err); assert.equal(rc.code, 0, rc.err);
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_payments WHERE vendor_bill_id='${recordWriterFirstBill}'::uuid`), '1');
  assert.equal(scalar(`SELECT paid_cents FROM public.vendor_bills WHERE id='${recordWriterFirstBill}'::uuid`), '100');
  sql(`DROP TRIGGER proof_pause_ap_payment_insert ON public.vendor_payments; DELETE FROM public.vendor_payments WHERE vendor_bill_id='${recordWriterFirstBill}'::uuid; DELETE FROM public.vendor_bills WHERE id='${recordWriterFirstBill}'::uuid; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01';`);
  console.log('CANDIDATE_AP_RECORD_PAYMENT_WRITER_FIRST_CLOSE_WAITS_PASS');

  const recordCloseFirstBill = scalar(`${bill('ap-record-close-first-bill')}`);
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_ap_period() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_ap_period BEFORE INSERT ON public.accounting_periods FOR EACH ROW EXECUTE FUNCTION public._proof_pause_ap_period();`);
  const h9 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h9.ready;
  const recordCloseFirst = session(`BEGIN; ${close('ap-record-close-first-close')} COMMIT; SELECT 'AP_RECORD_CLOSE_FIRST_DONE';`, 'AP_RECORD_CLOSE_FIRST_DONE');
  await waitForBarrierWaiters(1, 'record payment close-first period barrier');
  const recordBlocked = session(`BEGIN; SELECT 'AP_RECORD_BLOCKED_STARTED'; ${recordPayment(recordCloseFirstBill, 'ap-record-close-first')} COMMIT;`, 'AP_RECORD_BLOCKED_STARTED'); await recordBlocked.ready;
  await waitForMonthLock(monthKey, 'ShareLock', false, 1, 'record payment waiting on close month lock');
  await h9.done;
  const [rcf, recordBlockedResult] = await Promise.all([recordCloseFirst.done, recordBlocked.done]); assert.equal(rcf.code, 0, rcf.err); expectError(recordBlockedResult, 'closed accounting period', 'close-first record payment');
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_payments WHERE vendor_bill_id='${recordCloseFirstBill}'::uuid`), '0');
  assert.equal(scalar(`SELECT paid_cents FROM public.vendor_bills WHERE id='${recordCloseFirstBill}'::uuid`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='ap-record-close-first'`), '0');
  sql(`DROP TRIGGER proof_pause_ap_period ON public.accounting_periods; DROP FUNCTION public._proof_pause_ap_period(); DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DELETE FROM public.vendor_bills WHERE id='${recordCloseFirstBill}'::uuid;`);
  console.log('CANDIDATE_AP_RECORD_PAYMENT_CLOSE_FIRST_FAIL_CLOSED_PASS');

  const voidPaymentWriterBill = scalar(`${bill('ap-void-payment-writer-first-bill')}`);
  const voidPaymentWriterId = scalar(`${recordPayment(voidPaymentWriterBill, 'ap-void-payment-writer-seed', 400)}`);
  sql(`CREATE TRIGGER proof_pause_ap_payment_void BEFORE UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_ap_writer();`);
  const h10 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h10.ready;
  const voidPaymentWriter = session(`BEGIN; SELECT 'AP_VOID_PAYMENT_WRITER_STARTED'; ${voidPayment(voidPaymentWriterId, 'ap-void-payment-writer-first')} COMMIT; SELECT 'AP_VOID_PAYMENT_WRITER_DONE';`, 'AP_VOID_PAYMENT_WRITER_STARTED'); await voidPaymentWriter.ready;
  await waitForBarrierWaiters(1, 'void payment writer-first trigger barrier');
  await waitForMonthLock(monthKey, 'ShareLock', true, 1, 'void payment writer shared January lock');
  const voidPaymentWriterClose = session(`BEGIN; ${close('ap-void-payment-writer-close')} COMMIT; SELECT 'AP_VOID_PAYMENT_CLOSE_DONE';`, 'AP_VOID_PAYMENT_CLOSE_DONE');
  await waitForMonthLock(monthKey, 'ExclusiveLock', false, 1, 'void payment close waiting on writer month lock');
  await h10.done;
  const [vpw, vpwc] = await Promise.all([voidPaymentWriter.done, voidPaymentWriterClose.done]); assert.equal(vpw.code, 0, vpw.err); assert.equal(vpwc.code, 0, vpwc.err);
  assert.equal(scalar(`SELECT (voided_at IS NOT NULL)::int FROM public.vendor_payments WHERE id='${voidPaymentWriterId}'::uuid`), '1');
  assert.equal(scalar(`SELECT paid_cents FROM public.vendor_bills WHERE id='${voidPaymentWriterBill}'::uuid`), '0');
  sql(`DROP TRIGGER proof_pause_ap_payment_void ON public.vendor_bills; DELETE FROM public.vendor_payments WHERE vendor_bill_id='${voidPaymentWriterBill}'::uuid; DELETE FROM public.vendor_bills WHERE id='${voidPaymentWriterBill}'::uuid; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01';`);
  console.log('CANDIDATE_AP_VOID_PAYMENT_WRITER_FIRST_CLOSE_WAITS_PASS');

  const voidPaymentCloseBill = scalar(`${bill('ap-void-payment-close-first-bill')}`);
  const voidPaymentCloseId = scalar(`${recordPayment(voidPaymentCloseBill, 'ap-void-payment-close-seed', 400)}`);
  const voidPaymentAuditBefore = scalar(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id IN ('${voidPaymentCloseBill}'::uuid,'${voidPaymentCloseId}'::uuid)`);
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_ap_period() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_ap_period BEFORE INSERT ON public.accounting_periods FOR EACH ROW EXECUTE FUNCTION public._proof_pause_ap_period();`);
  const h11 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h11.ready;
  const voidPaymentClose = session(`BEGIN; ${close('ap-void-payment-close-first-close')} COMMIT; SELECT 'AP_VOID_PAYMENT_CLOSE_FIRST_DONE';`, 'AP_VOID_PAYMENT_CLOSE_FIRST_DONE');
  await waitForBarrierWaiters(1, 'void payment close-first period barrier');
  const voidPaymentBlocked = session(`BEGIN; SELECT 'AP_VOID_PAYMENT_BLOCKED_STARTED'; ${voidPayment(voidPaymentCloseId, 'ap-void-payment-close-first')} COMMIT;`, 'AP_VOID_PAYMENT_BLOCKED_STARTED'); await voidPaymentBlocked.ready;
  await waitForMonthLock(monthKey, 'ShareLock', false, 1, 'void payment waiting on close month lock');
  await h11.done;
  const [vpc, vpb] = await Promise.all([voidPaymentClose.done, voidPaymentBlocked.done]); assert.equal(vpc.code, 0, vpc.err); expectError(vpb, 'closed accounting period', 'close-first void payment');
  assert.equal(scalar(`SELECT (voided_at IS NULL)::int FROM public.vendor_payments WHERE id='${voidPaymentCloseId}'::uuid`), '1');
  assert.equal(scalar(`SELECT paid_cents FROM public.vendor_bills WHERE id='${voidPaymentCloseBill}'::uuid`), '400');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='ap-void-payment-close-first'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id IN ('${voidPaymentCloseBill}'::uuid,'${voidPaymentCloseId}'::uuid)`), voidPaymentAuditBefore);
  sql(`DROP TRIGGER proof_pause_ap_period ON public.accounting_periods; DROP FUNCTION public._proof_pause_ap_period(); DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DELETE FROM public.vendor_payments WHERE vendor_bill_id='${voidPaymentCloseBill}'::uuid; DELETE FROM public.vendor_bills WHERE id='${voidPaymentCloseBill}'::uuid;`);
  console.log('CANDIDATE_AP_VOID_PAYMENT_CLOSE_FIRST_FAIL_CLOSED_PASS');

  const voidBillWriterFirst = scalar(`${bill('ap-void-bill-writer-first-bill')}`);
  sql(`CREATE TRIGGER proof_pause_ap_bill_void BEFORE UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public._proof_pause_ap_writer();`);
  const h12 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h12.ready;
  const voidBillWriter = session(`BEGIN; SELECT 'AP_VOID_BILL_WRITER_STARTED'; ${voidBill(voidBillWriterFirst, 'ap-void-bill-writer-first')} COMMIT; SELECT 'AP_VOID_BILL_WRITER_DONE';`, 'AP_VOID_BILL_WRITER_STARTED'); await voidBillWriter.ready;
  await waitForBarrierWaiters(1, 'void bill writer-first trigger barrier');
  await waitForMonthLock(monthKey, 'ShareLock', true, 1, 'void bill writer shared January lock');
  const voidBillWriterClose = session(`BEGIN; ${close('ap-void-bill-writer-close')} COMMIT; SELECT 'AP_VOID_BILL_CLOSE_DONE';`, 'AP_VOID_BILL_CLOSE_DONE');
  await waitForMonthLock(monthKey, 'ExclusiveLock', false, 1, 'void bill close waiting on writer month lock');
  await h12.done;
  const [vbw, vbwc] = await Promise.all([voidBillWriter.done, voidBillWriterClose.done]); assert.equal(vbw.code, 0, vbw.err); assert.equal(vbwc.code, 0, vbwc.err);
  assert.equal(scalar(`SELECT status FROM public.vendor_bills WHERE id='${voidBillWriterFirst}'::uuid`), 'voided');
  sql(`DROP TRIGGER proof_pause_ap_bill_void ON public.vendor_bills; DELETE FROM public.vendor_bills WHERE id='${voidBillWriterFirst}'::uuid; DELETE FROM public.accounting_periods WHERE period_start='2025-01-01';`);
  console.log('CANDIDATE_AP_VOID_BILL_WRITER_FIRST_CLOSE_WAITS_PASS');

  const voidBillCloseFirst = scalar(`${bill('ap-void-bill-close-first-bill')}`);
  const voidBillAuditBefore = scalar(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id='${voidBillCloseFirst}'::uuid`);
  sql(`CREATE OR REPLACE FUNCTION public._proof_pause_ap_period() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_lock(${KEY}); PERFORM pg_advisory_unlock(${KEY}); RETURN NEW; END$$; CREATE TRIGGER proof_pause_ap_period BEFORE INSERT ON public.accounting_periods FOR EACH ROW EXECUTE FUNCTION public._proof_pause_ap_period();`);
  const h13 = session(`BEGIN; SELECT pg_advisory_lock(${KEY}); SELECT 'BARRIER_HELD'; SELECT pg_sleep(${BARRIER_SECONDS}); SELECT pg_advisory_unlock(${KEY}); COMMIT;`, 'BARRIER_HELD'); await h13.ready;
  const voidBillClose = session(`BEGIN; ${close('ap-void-bill-close-first-close')} COMMIT; SELECT 'AP_VOID_BILL_CLOSE_FIRST_DONE';`, 'AP_VOID_BILL_CLOSE_FIRST_DONE');
  await waitForBarrierWaiters(1, 'void bill close-first period barrier');
  const voidBillBlocked = session(`BEGIN; SELECT 'AP_VOID_BILL_BLOCKED_STARTED'; ${voidBill(voidBillCloseFirst, 'ap-void-bill-close-first')} COMMIT;`, 'AP_VOID_BILL_BLOCKED_STARTED'); await voidBillBlocked.ready;
  await waitForMonthLock(monthKey, 'ShareLock', false, 1, 'void bill waiting on close month lock');
  await h13.done;
  const [vbc, vbb] = await Promise.all([voidBillClose.done, voidBillBlocked.done]); assert.equal(vbc.code, 0, vbc.err); expectError(vbb, 'closed accounting period', 'close-first void bill');
  assert.equal(scalar(`SELECT status FROM public.vendor_bills WHERE id='${voidBillCloseFirst}'::uuid`), 'unpaid');
  assert.equal(scalar(`SELECT voided_at IS NULL FROM public.vendor_bills WHERE id='${voidBillCloseFirst}'::uuid`), 't');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='ap-void-bill-close-first'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.financial_audit_log WHERE entity_id='${voidBillCloseFirst}'::uuid`), voidBillAuditBefore);
  sql(`DROP TRIGGER proof_pause_ap_period ON public.accounting_periods; DROP FUNCTION public._proof_pause_ap_period(); DELETE FROM public.accounting_periods WHERE period_start='2025-01-01'; DELETE FROM public.vendor_bills WHERE id='${voidBillCloseFirst}'::uuid; DROP FUNCTION public._proof_pause_ap_writer();`);
  console.log('CANDIDATE_AP_VOID_BILL_CLOSE_FIRST_FAIL_CLOSED_PASS');
  console.log('VENDOR_BILL_PERIOD_CLOSE_CONCURRENCY_PASS');
} finally { run(['rm', '-f', NAME], { fail: true }); }
