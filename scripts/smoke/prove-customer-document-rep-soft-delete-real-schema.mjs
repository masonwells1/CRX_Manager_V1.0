#!/usr/bin/env node
/**
 * Full-chain proof for the parked 20260921180000 soft_delete_customer_document
 * candidate (a sales rep cannot remove a customer document).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a
 * network-disabled Supabase PostgreSQL 17 container, replays every ordered
 * post-baseline migration that is applied live (the still-parked commission
 * files are skipped), then, using the REAL customer_documents policies,
 * guard trigger and idempotency helpers (no stand-ins), as the `authenticated`
 * role exactly like a browser session through PostgREST:
 *   1. THE BUG, BEFORE: an assigned, active sales rep's direct soft-delete
 *      UPDATE (the old page code) is refused by row-level security, with and
 *      without RETURNING, while an admin's succeeds;
 *   2. the candidate applies;
 *   3. THE FIX: the same rep removes the document through the function; the
 *      row carries deleted_at and deleted_by = the rep, and the receipt is
 *      bound to the rep and the document;
 *   4. the same key replays the same result without touching the row again;
 *      the same key on a different document is IDEMPOTENCY_INTENT_MISMATCH and
 *      another rep holding the key is IDEMPOTENCY_ACTOR_MISMATCH;
 *   5. NOBODY GAINS ACCESS: an unassigned rep, a removed document, and a
 *      missing document are the same CUSTOMER_DOCUMENT_NOT_FOUND; a driver and
 *      a deactivated rep are INSUFFICIENT_ROLE; a blank or 256-character key
 *      is refused; anon and service_role cannot execute the function; the rep
 *      still cannot see the removed row, and the rep's direct soft-delete
 *      UPDATE is still refused (no policy changed);
 *   5b. LOCKS: with another session holding the rep's profile row, or the
 *      customer row, the removal waits (lock timeout) and changes nothing;
 *   6. an admin can remove a document of any customer;
 *   7. the candidate re-applies cleanly, and an extra grantee (metabase_ro)
 *      makes the re-apply fail its exact-ACL postflight;
 *   8. MUTATION: with the assignment test removed from the body, step 5's
 *      unassigned-rep refusal fails — so that assertion really tests the check.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-customer-doc-delete-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260921180000_soft_delete_customer_document_rpc.sql');
const SIG = 'public.soft_delete_customer_document(uuid,text)';

// Written but not applied live on 2026-09-21; replaying them would build a
// schema production does not have. None of them touches customer_documents
// (asserted below).
const PARKED = new Set([
  '20260914100500_commission_dates_follow_chicago_business_day.sql',
  '20260914100600_latest_commission_recipient_label.sql',
  '20260914100800_bind_transfer_invoice_intent.sql',
  '20260914100900_repair_commission_history_label_snapshots.sql',
  '20260914100450_customer_document_bytes_server_only.sql',
]);
// PR #761's parked file reaches disk only once that PR merges. It is skipped
// while unapplied, like the rest; it does touch customer_documents, but only
// its storage objects and a storage_path CHECK, which this function never
// changes.
const OPTIONAL_PARKED = new Set(['20260914100450_customer_document_bytes_server_only.sql']);

const ADMIN = '5d000000-0000-4000-8000-00000000000a';
const REP = '5d000000-0000-4000-8000-00000000000b';
const REP2 = '5d000000-0000-4000-8000-00000000000c';
const DRIVER = '5d000000-0000-4000-8000-00000000000d';
const INACTIVE_REP = '5d000000-0000-4000-8000-00000000000e';
const CUSTOMER_MINE = '5d000000-0000-4000-8000-0000000000c1';
const CUSTOMER_OTHER = '5d000000-0000-4000-8000-0000000000c2';
const DOC = {
  before: '5d000000-0000-4000-8000-0000000000d1',
  adminBefore: '5d000000-0000-4000-8000-0000000000d2',
  fix: '5d000000-0000-4000-8000-0000000000d3',
  second: '5d000000-0000-4000-8000-0000000000d4',
  other: '5d000000-0000-4000-8000-0000000000d5',
  roleCheck: '5d000000-0000-4000-8000-0000000000d6',
  mutation: '5d000000-0000-4000-8000-0000000000d7',
};
const MISSING_DOC = '5d000000-0000-4000-8000-0000000000ff';

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') {
  return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
}
function psql(sql, options = {}) {
  return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure });
}
function scalar(sql) {
  return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function stageSql(file, name, transform = (s) => s) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try {
    writeFileSync(staged, transform(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')), 'utf8');
    docker(['cp', staged, `${NAME}:/tmp/${name}`]);
  } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove staged file ${staged}: ${e.message}`); }
  }
}
function apply(name, allowFailure = false) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function selected() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const candidate = all.indexOf(CANDIDATE);
  assert.ok(candidate >= 0, 'soft_delete_customer_document candidate must be selected for post-baseline replay');
  const before = all.slice(0, candidate);
  const skipped = before.filter((f) => PARKED.has(path.basename(f)));
  for (const name of PARKED) {
    if (!OPTIONAL_PARKED.has(name)) assert.ok(skipped.some((f) => path.basename(f) === name), `${name} must be in the replay plan (re-check the PARKED list against the live ledger)`);
  }
  for (const file of skipped) {
    if (OPTIONAL_PARKED.has(path.basename(file))) {
      // Skipping it is only sound while it leaves this table's row policies,
      // triggers and grants alone.
      const sql = readFileSync(file, 'utf8');
      assert.ok(
        !/(POLICY\s+\w+\s+ON\s+public\.customer_documents|TRIGGER[^;]*ON\s+public\.customer_documents|(GRANT|REVOKE)[^;]*ON\s+(TABLE\s+)?public\.customer_documents|guard_customer_document_update|soft_delete_customer_document)/i.test(sql),
        `${path.basename(file)} now changes customer_documents policies, triggers or grants; replay it or re-think the skip`,
      );
      continue;
    }
    assert.ok(!/customer_documents|soft_delete_customer_document/i.test(readFileSync(file, 'utf8')), `${path.basename(file)} touches customer documents; skipping it would change the proof`);
  }
  return before.filter((f) => !PARKED.has(path.basename(f)));
}
// Same replay repair the other real-schema provers use: live stores this one
// body with CRLF line endings, and a later migration pins that exact body.
function restoreLiveCrLfCloseRemainder() {
  const definingPath = path.join(ROOT, 'supabase', 'migrations', '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
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
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}

// The image's auth.uid() may read request.jwt.claim.sub before request.jwt.claims; set both.
function asUser(uid, role = 'authenticated') {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"${role}"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);\nSET LOCAL ROLE ${role};`;
}
/** One committed statement as `uid`; returns the last output line or the error text. */
function runAs(uid, sql, role = 'authenticated') {
  const r = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;\n${asUser(uid, role)}\n${sql}\nCOMMIT;\n`,
    allowFailure: true,
  });
  const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return { ok: r.status === 0, last, error: r.stderr.trim() };
}
function removeAs(uid, documentId, key, role = 'authenticated') {
  const keySql = key === null ? 'NULL' : `'${key}'`;
  const r = runAs(uid, `SELECT public.soft_delete_customer_document('${documentId}'::uuid, ${keySql})::text;`, role);
  return { ...r, result: r.ok ? JSON.parse(r.last) : null };
}
function expectRefusal(call, pattern, label) {
  assert.equal(call.ok, false, `${label}: expected a refusal, got ${call.last}`);
  assert.match(call.error, pattern, `${label}: wrong refusal:\n${call.error}`);
}
/** Open a session that takes a row lock and keeps it until releaseLock(). */
function holdLock(lockSql) {
  const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`lock holder never reported LOCK_HELD:\n${err}`)); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('LOCK_HELD')) { clearTimeout(timer); resolve(child); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(`BEGIN;\n${lockSql}\nSELECT 'LOCK_HELD';\n`);
  });
}
function releaseLock(child) {
  return new Promise((resolve) => {
    child.on('close', resolve);
    child.stdin.end('ROLLBACK;\n');
  });
}
function docState(id) {
  return scalar(`SELECT coalesce(deleted_by::text, 'live') || '|' || updated_at::text FROM public.customer_documents WHERE id = '${id}';`);
}
function directSoftDelete(uid, id, returning) {
  return runAs(uid, `UPDATE public.customer_documents SET deleted_at = now(), deleted_by = '${uid}' WHERE id = '${id}' AND deleted_at IS NULL${returning ? ' RETURNING id' : ''};`);
}

// Only an admin may change is_active (_guard_profile_role_lock), so this runs
// with the admin's claims.
function setActive(uid, active) {
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    UPDATE public.profiles SET is_active = ${active} WHERE id = '${uid}';
    COMMIT;`);
}

function seed() {
  // The baseline auth.users is a stub; deactivating a profile fires
  // _sync_auth_access_on_profile_active, which writes the real column set.
  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(`
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','doc-prover-admin@example.invalid','{"full_name":"[PROVER] Doc Admin","role":"admin"}'::jsonb),
      ('${REP}','doc-prover-rep@example.invalid','{"full_name":"[PROVER] Doc Rep","role":"sales_rep"}'::jsonb),
      ('${REP2}','doc-prover-rep2@example.invalid','{"full_name":"[PROVER] Doc Rep Two","role":"sales_rep"}'::jsonb),
      ('${DRIVER}','doc-prover-driver@example.invalid','{"full_name":"[PROVER] Doc Driver","role":"driver"}'::jsonb),
      ('${INACTIVE_REP}','doc-prover-inactive@example.invalid','{"full_name":"[PROVER] Doc Inactive Rep","role":"sales_rep"}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${ADMIN}','doc-prover-admin@example.invalid','[PROVER] Doc Admin','admin',true),
      ('${REP}','doc-prover-rep@example.invalid','[PROVER] Doc Rep','sales_rep',true),
      ('${REP2}','doc-prover-rep2@example.invalid','[PROVER] Doc Rep Two','sales_rep',true),
      ('${DRIVER}','doc-prover-driver@example.invalid','[PROVER] Doc Driver','driver',true),
      ('${INACTIVE_REP}','doc-prover-inactive@example.invalid','[PROVER] Doc Inactive Rep','sales_rep',true)
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, role=EXCLUDED.role, is_active=EXCLUDED.is_active;
    INSERT INTO public.customers (id,farm_name,assigned_sales_rep,is_active) VALUES
      ('${CUSTOMER_MINE}','[PROVER] Rep Farm','${REP}',true),
      ('${CUSTOMER_OTHER}','[PROVER] Other Farm','${REP2}',true);
  `);
  const docs = Object.entries(DOC).map(([label, id]) => {
    const customer = label === 'other' ? CUSTOMER_OTHER : CUSTOMER_MINE;
    return `('${id}','${customer}','other','${customer}/${label}.pdf','${label}.pdf','application/pdf',100,'${ADMIN}','rep')`;
  });
  psql(`INSERT INTO public.customer_documents (id,customer_id,document_type,storage_path,filename,mime_type,size_bytes,uploaded_by,source) VALUES ${docs.join(',')};`);
}

async function main() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });

  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageSql(file, name); const r = apply(name, true);
    if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} applied post-baseline migrations (parked files skipped)`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'soft_delete_customer_document';`), '0', 'function must not exist before the candidate');

  seed();

  // 1. THE BUG, BEFORE.
  const repPlain = directSoftDelete(REP, DOC.before, false);
  expectRefusal(repPlain, /new row violates row-level security policy for table "customer_documents"/, 'rep direct UPDATE (no RETURNING)');
  const repReturning = directSoftDelete(REP, DOC.before, true);
  expectRefusal(repReturning, /new row violates row-level security policy for table "customer_documents"/, 'rep direct UPDATE (RETURNING)');
  assert.match(docState(DOC.before), /^live\|/, 'refused rep UPDATE changed the row');
  const adminDirect = directSoftDelete(ADMIN, DOC.adminBefore, true);
  assert.ok(adminDirect.ok && adminDirect.last === DOC.adminBefore, `admin direct UPDATE should work before the fix:\n${adminDirect.error}`);
  console.log('[prover] BEFORE: assigned rep soft-delete refused by RLS (with and without RETURNING); admin succeeds');

  // 2. Apply.
  stageSql(CANDIDATE, 'candidate.sql');
  const applied = apply('candidate.sql', true);
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);

  // 3. THE FIX.
  const fixed = removeAs(REP, DOC.fix, 'prover-rep-key-1');
  assert.ok(fixed.ok, `assigned rep removal failed:\n${fixed.error}`);
  assert.equal(fixed.result.success, true);
  assert.equal(fixed.result.document_id, DOC.fix);
  assert.equal(fixed.result.customer_id, CUSTOMER_MINE);
  const afterFix = docState(DOC.fix);
  assert.match(afterFix, new RegExp(`^${REP}\\|`), `row not stamped deleted_by = rep: ${afterFix}`);
  assert.equal(
    scalar(`SELECT request_actor_id::text || '|' || (request_fingerprint <> '')::text FROM public.idempotency_keys WHERE idempotency_key = 'prover-rep-key-1' AND operation = 'soft_delete_customer_document';`),
    `${REP}|true`,
    'receipt is not bound to the rep',
  );
  console.log('[prover] FIX: assigned rep removed the document; deleted_by = rep; receipt bound to the rep');

  // 4. Replay semantics.
  const replay = removeAs(REP, DOC.fix, 'prover-rep-key-1');
  assert.ok(replay.ok, `same-key replay failed:\n${replay.error}`);
  assert.deepEqual(replay.result, fixed.result, 'replay returned a different result');
  assert.equal(docState(DOC.fix), afterFix, 'replay touched the row again');
  expectRefusal(removeAs(REP, DOC.second, 'prover-rep-key-1'), /IDEMPOTENCY_INTENT_MISMATCH/, 'same key, different document');
  assert.match(docState(DOC.second), /^live\|/, 'intent mismatch removed the second document');
  expectRefusal(removeAs(REP2, DOC.fix, 'prover-rep-key-1'), /IDEMPOTENCY_ACTOR_MISMATCH/, 'another rep holding the key');
  // A replay is re-authorised: once the customer is reassigned, the rep's own
  // key no longer returns the receipt.
  psql(`UPDATE public.customers SET assigned_sales_rep = '${REP2}' WHERE id = '${CUSTOMER_MINE}';`);
  expectRefusal(removeAs(REP, DOC.fix, 'prover-rep-key-1'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'replay after the customer was reassigned');
  psql(`UPDATE public.customers SET assigned_sales_rep = '${REP}' WHERE id = '${CUSTOMER_MINE}';`);
  const replayBack = removeAs(REP, DOC.fix, 'prover-rep-key-1');
  assert.ok(replayBack.ok && replayBack.result.document_id === DOC.fix, `replay after re-assignment back failed:\n${replayBack.error}`);
  // The role gate runs BEFORE the receipt lookup: a deactivated rep replaying
  // their own valid key is refused, not handed the receipt.
  setActive(REP, false);
  expectRefusal(removeAs(REP, DOC.fix, 'prover-rep-key-1'), /INSUFFICIENT_ROLE/, 'deactivated rep replaying their own key');
  setActive(REP, true);
  console.log('[prover] replay: same key replays; different document -> INTENT_MISMATCH; other rep -> ACTOR_MISMATCH');

  // 5. Nobody gains access.
  expectRefusal(removeAs(REP, DOC.other, 'prover-rep-key-2'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'unassigned customer');
  assert.match(docState(DOC.other), /^live\|/, 'unassigned rep removed another customer\'s document');
  expectRefusal(removeAs(REP, DOC.fix, 'prover-rep-key-3'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'already removed');
  expectRefusal(removeAs(REP, MISSING_DOC, 'prover-rep-key-4'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'missing document');
  expectRefusal(removeAs(DRIVER, DOC.roleCheck, 'prover-driver-key'), /INSUFFICIENT_ROLE/, 'driver');
  psql(`UPDATE public.customers SET assigned_sales_rep = '${INACTIVE_REP}' WHERE id = '${CUSTOMER_OTHER}';`);
  setActive(INACTIVE_REP, false);
  expectRefusal(removeAs(INACTIVE_REP, DOC.other, 'prover-inactive-key'), /INSUFFICIENT_ROLE/, 'deactivated assigned rep');
  psql(`UPDATE public.customers SET assigned_sales_rep = '${REP2}' WHERE id = '${CUSTOMER_OTHER}';`);
  expectRefusal(removeAs(REP, DOC.roleCheck, null), /IDEMPOTENCY_KEY_REQUIRED/, 'missing key');
  expectRefusal(removeAs(REP, DOC.roleCheck, '   '), /IDEMPOTENCY_KEY_REQUIRED/, 'blank key');
  expectRefusal(removeAs(REP, DOC.roleCheck, 'k'.repeat(256)), /IDEMPOTENCY_KEY_REQUIRED/, '256-character key');
  expectRefusal(removeAs(REP, DOC.roleCheck, 'prover-anon-key', 'anon'), /permission denied for function soft_delete_customer_document/, 'anon');
  expectRefusal(removeAs(REP, DOC.roleCheck, 'prover-service-key', 'service_role'), /permission denied for function soft_delete_customer_document/, 'service_role');
  assert.match(docState(DOC.roleCheck), /^live\|/, 'a refused caller changed the role-check document');
  const repSeesRemoved = runAs(REP, `SELECT count(*) FROM public.customer_documents WHERE id = '${DOC.fix}';`);
  assert.ok(repSeesRemoved.ok && repSeesRemoved.last === '0', `rep can see the removed document: ${repSeesRemoved.last}`);
  expectRefusal(directSoftDelete(REP, DOC.second, false), /new row violates row-level security policy/, 'rep direct UPDATE after the fix (policy unchanged)');
  const repNotes = runAs(REP, `UPDATE public.customer_documents SET notes = 'prover note' WHERE id = '${DOC.second}' RETURNING id;`);
  assert.ok(repNotes.ok && repNotes.last === DOC.second, `rep can no longer edit notes (existing access lost):\n${repNotes.error}`);
  console.log('[prover] no new access: unassigned/removed/missing -> NOT_FOUND; driver/inactive -> INSUFFICIENT_ROLE; blank key refused; anon/service_role denied; removed row still hidden; policies unchanged');

  // 5b. LOCKS: while another session holds the rep's profile row (a
  // deactivation in progress) or the customer row (a reassignment in
  // progress), the removal must WAIT, not run on the pre-change state. A short
  // lock_timeout turns "waited" into an observable 55P03, and nothing commits.
  for (const [label, holder] of [
    ['profile (deactivation in progress)', `SELECT 1 FROM public.profiles WHERE id = '${REP}' FOR UPDATE;`],
    ['customer (reassignment in progress)', `SELECT 1 FROM public.customers WHERE id = '${CUSTOMER_MINE}' FOR UPDATE;`],
  ]) {
    const held = await holdLock(holder);
    try {
      const blocked = runAs(REP, `SET LOCAL lock_timeout = '750ms';\nSELECT public.soft_delete_customer_document('${DOC.roleCheck}'::uuid, 'prover-lock-${label.split(' ')[0]}')::text;`);
      expectRefusal(blocked, /canceling statement due to lock timeout/, `removal while the ${label} is locked`);
    } finally {
      await releaseLock(held);
    }
    assert.match(docState(DOC.roleCheck), /^live\|/, `removal ran past a held ${label} lock`);
  }
  console.log('[prover] locks: removal waits on a held profile row and a held customer row');

  // 6. Admin path.
  const adminRemove = removeAs(ADMIN, DOC.other, 'prover-admin-key');
  assert.ok(adminRemove.ok, `admin removal failed:\n${adminRemove.error}`);
  assert.match(docState(DOC.other), new RegExp(`^${ADMIN}\\|`), 'admin removal not stamped');
  console.log('[prover] admin removed a document of a customer not assigned to them');

  // 7. Re-apply, and the exact-ACL postflight.
  const reapplied = apply('candidate.sql', true);
  assert.equal(reapplied.status, 0, `candidate failed to re-apply:\n${reapplied.output}`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'soft_delete_customer_document';`), '1');
  psql(`GRANT EXECUTE ON FUNCTION ${SIG} TO metabase_ro;`);
  const drifted = apply('candidate.sql', true);
  assert.notEqual(drifted.status, 0, 'candidate re-applied over a drifted metabase_ro grant');
  assert.match(drifted.output, /POSTFLIGHT_ACL: .* non-owner grantees are authenticated,metabase_ro/, drifted.output);
  psql(`REVOKE EXECUTE ON FUNCTION ${SIG} FROM metabase_ro;`);
  const clean = apply('candidate.sql', true);
  assert.equal(clean.status, 0, `candidate failed to re-apply after the drift was removed:\n${clean.output}`);
  console.log('[prover] candidate re-applies cleanly; one overload; a drifted extra grantee fails the apply');

  // 8. MUTATION: drop the assignment test; the unassigned refusal must now fail.
  const guard = /AND \(v_is_admin OR c\.assigned_sales_rep = v_actor\)/;
  stageSql(CANDIDATE, 'mutant.sql', (sql) => {
    assert.ok(guard.test(sql), 'mutation anchor (assignment test) not found in the candidate');
    return sql.replace(guard, 'AND (v_is_admin OR true)');
  });
  const mutant = apply('mutant.sql', true);
  assert.equal(mutant.status, 0, `mutant failed to apply:\n${mutant.output}`);
  const mutantCall = removeAs(REP, DOC.mutation, 'prover-mutant-key');
  assert.ok(mutantCall.ok, 'sanity: mutant still removes an assigned document');
  psql(`INSERT INTO public.customer_documents (id,customer_id,document_type,storage_path,filename,mime_type,size_bytes,uploaded_by,source) VALUES ('5d000000-0000-4000-8000-0000000000e1','${CUSTOMER_OTHER}','other','${CUSTOMER_OTHER}/mutant.pdf','mutant.pdf','application/pdf',100,'${ADMIN}','rep');`);
  const leaked = removeAs(REP, '5d000000-0000-4000-8000-0000000000e1', 'prover-mutant-key-2');
  assert.ok(leaked.ok, 'MUTATION NOT DETECTED: without the assignment check the unassigned rep was still refused, so step 5 does not test that check');
  const restored = apply('candidate.sql', true);
  assert.equal(restored.status, 0, `candidate failed to restore after the mutation:\n${restored.output}`);
  console.log('[prover] MUTATION: removing the assignment check lets an unassigned rep remove a document — step 5 detects it');

  console.log('CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS before=rls_refused fix=rep_removes replay=bound no_new_access=true admin=ok reapply=ok mutation=detected');
}

try { await main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
