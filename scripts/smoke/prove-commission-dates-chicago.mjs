#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for
 *   supabase/migrations/20260905200400_commission_dates_follow_chicago_business_day.sql
 *
 * The commission-creating helpers stop trusting the caller's date and derive it from the
 * record the commission belongs to (orders.order_date / invoices.invoice_date). Five live
 * callers pass the server's UTC CURRENT_DATE, which after ~7pm Chicago is already
 * tomorrow — and on September 30 that also moves the crop season.
 *
 * Built on the same harness as prove-invoice-date-fallbacks-chicago.mjs: restores the
 * supported schema baseline, replays the ledger-selected post-baseline migrations, and
 * never reads a DB URL. Touches NOTHING outside its own throwaway, network-less container.
 *
 * WHAT IT PROVES, in order:
 *   1. baseline restored and post-baseline migrations replayed;
 *   1a. the UNTOUCHED clean-rebuild bodies of both helpers hash to pins the candidate
 *       accepts — a disaster-recovery rebuild must not be refused (this is the exact
 *       class of HIGH that the invoice-date candidate drew on its first review round);
 *   2. BEFORE the candidate, with the session clock in a zone whose calendar day differs
 *       from Chicago's, a caller passing CURRENT_DATE stamps the SESSION day onto
 *       commissions.order_date even though the order/invoice is dated otherwise — the
 *       defect, and the discriminator for phase 4;
 *   3. against a DRIFTED body the candidate ABORTS with PREFLIGHT_DRIFT and both bodies
 *       are byte-for-byte unchanged;
 *   4. against the pinned bodies it applies; AFTER it, the same caller passing the same
 *       CURRENT_DATE now stamps the ORDER's / INVOICE's own date;
 *   5. re-applying is safe (identical bodies);
 *   6. orders.order_date's column default no longer mentions CURRENT_DATE;
 *   7. MUTATION: a candidate whose order-path derivation is reverted to the caller's date
 *       must ABORT in POSTFLIGHT_RESIDUAL with nothing installed — proving the postflight
 *       is load-bearing rather than decorative. Then it is discarded.
 *
 * Requires Docker.
 *
 *   node scripts/smoke/prove-commission-dates-chicago.mjs
 *
 * Exits 0 only if every phase passes, including the mutation phase, which must FAIL.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWrappable } from '../../.claude/hooks/migration-wrappability-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-commission-dates-chicago-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260905200400_commission_dates_follow_chicago_business_day.sql');
const REPLAY_STOP_BEFORE = '20260817120000_carry_allocated_line_cents_through_lifecycle.sql';
const FUNCS = ['_insert_commissions_for_order', '_insert_commissions_for_job'];
const ADMIN = '00000000-0000-4000-8000-00000000c001';

const log = (m) => process.stdout.write(`${m}\n`);

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (!options.allowFailure && r.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
function psql(sql, options = {}) {
  const r = docker(
    ['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(options.wrap ? ['-1'] : [])],
    { input: sql, allowFailure: options.allowFailure },
  );
  if (!options.allowFailure && r.status !== 0) throw new Error(`psql failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}
// scripts/apply-migration-file.mjs transmits every wrappable file inside ONE transaction.
// Mirror that with the SAME classifier so files using SET LOCAL / LOCK TABLE at top level
// behave exactly as they did live, and a PL/pgSQL body's BEGIN/END is never mistaken for
// transaction control.
function isWrappable(text) {
  try { assertWrappable(text, 'replay'); return true; } catch { return false; }
}
const wrapByName = new Map();
function scalar(sql) {
  return docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atqc', sql]).stdout.trim();
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function copyLf(local, name, dir) {
  const lf = readFileSync(local, 'utf8').replace(/\r\n/g, '\n');
  const tmp = path.join(dir, name);
  writeFileSync(tmp, lf, 'utf8');
  wrapByName.set(name, isWrappable(lf));
  copy(tmp, name);
}
// Every copyText caller is a MUTANT of the candidate, so it inherits the candidate's
// precondition: it must take the real single-transaction delivery path. Assert rather than
// branch — a mutant that silently fell back to an unwrapped apply would prove nothing about
// how the migration actually reaches production.
function copyText(text, name, dir) {
  assertWrappable(text, name);
  const tmp = path.join(dir, name);
  writeFileSync(tmp, text, 'utf8');
  wrapByName.set(name, true);
  copy(tmp, name);
}
function apply(name, user) { return psql(`\\i /tmp/${name}`, { user, wrap: wrapByName.get(name) ?? false }); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let i = 0; i < 120; i += 1) {
    const q = docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'], { allowFailure: true });
    if (q.status === 0 && q.stdout.trim() === '1') return;
    wait(500);
  }
  throw new Error(`disposable PostgreSQL failed readiness: ${docker(['logs', NAME], { allowFailure: true }).stderr}`);
}
function selectedMigrations() {
  const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const migrations = result.stdout.split(/\r?\n/).filter((l) => l.startsWith('supabase/migrations/')).map((rel) => path.join(ROOT, rel));
  const idx = migrations.indexOf(CANDIDATE);
  assert.notEqual(idx, -1, 'candidate migration is not in the ledger-selected post-baseline replay');
  return migrations.slice(0, idx + 1);
}
function bodyMd5(fn) {
  return scalar(`SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`);
}
function bodyState() { return Object.fromEntries(FUNCS.map((fn) => [fn, bodyMd5(fn)])); }
function functionDef(fn) {
  return scalar(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`);
}

const candidateSql = readFileSync(CANDIDATE, 'utf8');
assert.equal(candidateSql.includes('\r'), false, 'candidate must be LF');

// WRAPPABILITY IS A PRECONDITION, NOT AN INPUT. scripts/apply-migration-file.mjs runs this
// exact check and REFUSES to transmit a file that fails it, so a non-wrappable candidate has
// no sanctioned route to production at all. This harness used to call isWrappable() and then
// BRANCH on the answer to decide whether to pass psql -1 — which meant a candidate carrying a
// top-level BEGIN;/COMMIT; was applied by the one route the real system will not use, and the
// run passed. That is a harness accommodating the defect instead of catching it. Assert here,
// unconditionally, before any phase reports anything.
assertWrappable(candidateSql.replace(/\r\n/g, '\n'), path.basename(CANDIDATE));

// Read the pins out of the candidate itself rather than re-typing them, so this prover
// cannot silently disagree with the file it is proving.
// Each helper carries TWO accepted hashes (pre-image, post-image); the FIRST is the
// pre-image, which is what a clean rebuild and production both present.
const pinBlock = /'_insert_commissions_for_order',\s*jsonb_build_array\('([0-9a-f]{32})',\s*'([0-9a-f]{32})'\)[\s\S]*?'_insert_commissions_for_job',\s*jsonb_build_array\('([0-9a-f]{32})',\s*'([0-9a-f]{32})'\)/.exec(candidateSql);
assert.ok(pinBlock, 'could not read the md5 pin pairs out of the candidate');
const PINS = { _insert_commissions_for_order: pinBlock[1], _insert_commissions_for_job: pinBlock[3] };
const POST_PINS = { _insert_commissions_for_order: pinBlock[2], _insert_commissions_for_job: pinBlock[4] };

const workDir = mkdtempSync(path.join(tmpdir(), 'crx-commission-dates-'));

// A session zone whose calendar day differs from Chicago's RIGHT NOW. The far-east zone
// is tomorrow from 05:00 Chicago onwards; the far-west zone is yesterday before 06:00
// Chicago. One of the two always differs, and the SQL asserts which.
function commissionProbe(label) {
  const sql = `
DO $probe$
DECLARE
  v_chi date; v_sess date; v_cust uuid; v_order uuid; v_inv uuid;
  v_doc_date constant date := DATE '2026-09-30';   -- the season boundary
  v_stamped_order date; v_stamped_job date; v_zone text; v_job uuid;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '${ADMIN}', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('TimeZone', 'Pacific/Kiritimati', true);
  v_chi := (now() AT TIME ZONE 'America/Chicago')::date;
  IF CURRENT_DATE = v_chi THEN
    PERFORM set_config('TimeZone', 'Etc/GMT+12', true);
  END IF;
  v_zone := current_setting('TimeZone');
  v_sess := CURRENT_DATE;
  IF v_sess = v_chi THEN
    RAISE EXCEPTION 'PROBE_SETUP: no session zone differs from Chicago at this instant (chi %, sess %)', v_chi, v_sess;
  END IF;

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] commission-date ${label} ' || substr(gen_random_uuid()::text, 1, 8))
    RETURNING id INTO v_cust;

  -- An ORDER explicitly dated on the season boundary.
  INSERT INTO orders (order_number, customer_id, status, order_date)
    VALUES ('[SMOKE]-O-' || substr(gen_random_uuid()::text, 1, 12), v_cust, 'confirmed', v_doc_date)
    RETURNING id INTO v_order;

  -- The five broken callers pass CURRENT_DATE. Reproduce that exactly.
  PERFORM _insert_commissions_for_order(
    v_order, v_cust, 100.00,
    jsonb_build_object('splits', jsonb_build_array(jsonb_build_object('recipient', 'Chicago Admin', 'percentage', 100))),
    CURRENT_DATE);
  SELECT order_date INTO v_stamped_order FROM commissions WHERE order_id = v_order LIMIT 1;

  -- An INVOICE explicitly dated on the season boundary, for the job path.
  INSERT INTO invoices (invoice_number, customer_id, invoice_date, status, invoice_type)
    VALUES ('[SMOKE]-I-' || substr(gen_random_uuid()::text, 1, 12), v_cust, v_doc_date, 'draft', 'misc_charge')
    RETURNING id INTO v_inv;
  -- chk_commission_source requires order_id OR job_id, so the job path needs a real job.
  INSERT INTO jobs (job_number, customer_id, job_date)
    VALUES ('[SMOKE]-J-' || substr(gen_random_uuid()::text, 1, 12), v_cust, v_doc_date)
    RETURNING id INTO v_job;

  PERFORM _insert_commissions_for_job(
    v_job, v_inv, v_cust, 100.00,
    jsonb_build_object('splits', jsonb_build_array(jsonb_build_object('recipient', 'Chicago Admin', 'percentage', 100))),
    CURRENT_DATE);
  SELECT order_date INTO v_stamped_job FROM commissions WHERE invoice_id = v_inv LIMIT 1;

  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} zone=% session=% chicago=% doc=% order_stamped=% job_stamped=%',
    v_zone, v_sess, v_chi, v_doc_date, v_stamped_order, v_stamped_job;
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ zone=(\S+) session=(\S+) chicago=(\S+) doc=(\S+) order_stamped=(\S+) job_stamped=(\S+)/.exec(out);
  assert.ok(m, `${label}: probe did not reach its rollback marker:\n${out.slice(-2500)}`);
  return { zone: m[1], session: m[2], chicago: m[3], doc: m[4], order: m[5], job: m[6] };
}

try {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();

  const artifacts = ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql'];
  for (const artifact of artifacts) copy(path.join(BASELINE, artifact), artifact);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 40 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(`baseline decompression failed: ${schema.stderr.toString()}`);
  apply('20260727174805_extensions.sql');
  psql(schema.stdout.toString());
  psql(`
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL,
      name text NOT NULL, owner_id text
    );
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
  `, { user: 'supabase_admin' });
  apply('20260727174805_acl_lockdown.sql');
  apply('20260727174805_platform_overlay.sql', 'supabase_admin');
  apply('20260727174805_cron_jobs.sql');
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  apply('20260727174805_migration_history.sql');

  const migrations = selectedMigrations();
  assert.equal(migrations.at(-1), CANDIDATE, 'candidate must be the final ledger-selected migration');
  const stopIdx = migrations.findIndex((m) => path.basename(m) === REPLAY_STOP_BEFORE);
  assert.notEqual(stopIdx, -1, `replay stop marker ${REPLAY_STOP_BEFORE} is not in the ledger-selected list`);
  for (const [index, migration] of migrations.slice(0, stopIdx).entries()) {
    const name = `migration-${index}.sql`;
    copyLf(migration, name, workDir);
    apply(name);
  }
  log(`PHASE 1: baseline restored and ${stopIdx} post-baseline migrations replayed`);

  psql(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${ADMIN}', 'chicago-admin@example.invalid', '{"full_name":"Chicago Admin","role":"admin"}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
      ('${ADMIN}', 'chicago-admin@example.invalid', 'Chicago Admin', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true, full_name = EXCLUDED.full_name;
  `);

  // PHASE 1a: the disaster-recovery question. A clean rebuild reaches this migration with
  // the helpers in their replayed form. If that form is not a pin the candidate accepts,
  // the candidate would refuse a rebuild.
  const rebuild = bodyState();
  for (const fn of FUNCS) {
    assert.equal(rebuild[fn], PINS[fn],
      `${fn}: the clean-rebuild body hashes to ${rebuild[fn]} but the candidate pins ${PINS[fn]}. ` +
      'The candidate would REFUSE a disaster-recovery rebuild. Add the rebuild form to the pin list.');
  }
  log('PHASE 1a: both clean-rebuild helper bodies hash to the candidate pins — a rebuild is not refused');

  // PHASE 2: the defect, before the candidate.
  const before = commissionProbe('before');
  log(`PHASE 2 probe(before): zone=${before.zone} session=${before.session} chicago=${before.chicago} doc=${before.doc} order_stamped=${before.order} job_stamped=${before.job}`);
  assert.equal(before.order, before.session, 'BEFORE: the order-path commission should carry the SESSION day (the defect)');
  assert.equal(before.job, before.session, 'BEFORE: the job-path commission should carry the SESSION day (the defect)');
  assert.notEqual(before.order, before.doc, 'BEFORE: the defect requires the stamped date to differ from the document date');
  log('PHASE 2: the defect reproduces — a caller passing CURRENT_DATE stamps the session day, not the document date');

  // PHASE 3: drift refusal. The helpers live in the schema BASELINE, not in a replayed
  // post-baseline migration, so capture their definitions byte-for-byte to restore from.
  const originalDefs = Object.fromEntries(FUNCS.map((fn) => [fn, functionDef(fn)]));
  const restoreHelpers = () => {
    psql(Object.values(originalDefs).join('\n;\n'));
    assert.deepEqual(bodyState(), rebuild, 'pinned bodies not restored');
  };
  const driftBodies = bodyState();
  psql(`
    CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
      p_order_id uuid, p_customer_id uuid, p_order_profit numeric,
      p_commission_split jsonb, p_order_date date DEFAULT CURRENT_DATE)
    RETURNS integer LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
    AS $drift$ BEGIN RETURN 0; END; $drift$;
  `);
  copyLf(CANDIDATE, 'candidate.sql', workDir);
  const drifted = psql('\\i /tmp/candidate.sql', { allowFailure: true, wrap: wrapByName.get('candidate.sql') ?? false });
  assert.match(`${drifted.stdout}\n${drifted.stderr}`, /PREFLIGHT_DRIFT/, 'the candidate must ABORT on a drifted helper body');
  assert.equal(bodyMd5('_insert_commissions_for_job'), driftBodies._insert_commissions_for_job, 'the job helper must be untouched after the refused apply');
  log('PHASE 3: the candidate ABORTS with PREFLIGHT_DRIFT on a drifted body and changes nothing');

  restoreHelpers();

  // PHASE 4: the real apply.
  const applied = psql('\\i /tmp/candidate.sql', { allowFailure: true, wrap: wrapByName.get('candidate.sql') ?? false });
  assert.equal(applied.status, 0, `the candidate must apply over the pinned bodies:\n${applied.stdout}\n${applied.stderr}`);
  const afterBodies = bodyState();
  for (const fn of FUNCS) assert.notEqual(afterBodies[fn], PINS[fn], `${fn} should have been replaced`);
  log('PHASE 4: the candidate applied over the pinned bodies');

  const after = commissionProbe('after');
  log(`PHASE 4 probe(after):  zone=${after.zone} session=${after.session} chicago=${after.chicago} doc=${after.doc} order_stamped=${after.order} job_stamped=${after.job}`);
  assert.equal(after.order, after.doc, 'AFTER: the order-path commission must carry the ORDER date');
  assert.equal(after.job, after.doc, 'AFTER: the job-path commission must carry the INVOICE date');
  assert.notEqual(after.order, after.session, 'AFTER: the commission must no longer follow the session clock');
  log('PHASE 4a: AFTER the candidate, the same caller passing CURRENT_DATE stamps the document date — the defect is closed');

  // PHASE 5: replay safety. A migration that aborts on its OWN output is fail-closed but
  // hostile to a re-run, so the candidate accepts the post-image md5 as well as the
  // pre-image — the same two-value shape 20260905200200 uses for its recorder pins.
  log(`PHASE 5 post-image md5s: ${JSON.stringify(afterBodies)}`);
  const replay = psql('\\i /tmp/candidate.sql', { allowFailure: true, wrap: wrapByName.get('candidate.sql') ?? false });
  assert.deepEqual(bodyState(), afterBodies, 're-applying must leave the converted bodies in place');
  assert.equal(replay.status, 0,
    `re-applying the candidate must succeed, not abort on its own output:\n${replay.stdout}\n${replay.stderr}`);
  log('PHASE 5: re-applying the candidate is safe');

  // PHASE 6: the column default.
  const colDefault = scalar(`SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='order_date'`);
  assert.match(colDefault, /America\/Chicago/, `orders.order_date default should be Chicago-based, got ${colDefault}`);
  log(`PHASE 6: orders.order_date default is now ${colDefault}`);

  // PHASE 7: mutation — the postflight must be load-bearing.
  restoreHelpers();
  const mutated = candidateSql.replace(/    v_order_date,\n    'pending'/, "    p_order_date,\n    'pending'");
  assert.notEqual(mutated, candidateSql, 'mutation did not alter the candidate');
  copyText(mutated, 'mutant.sql', workDir);
  const mutantRun = psql('\\i /tmp/mutant.sql', { allowFailure: true, wrap: wrapByName.get('mutant.sql') ?? false });
  assert.match(`${mutantRun.stdout}\n${mutantRun.stderr}`, /POSTFLIGHT_RESIDUAL/,
    'a candidate that still writes the caller-supplied date MUST abort in POSTFLIGHT_RESIDUAL — the postflight is not load-bearing');
  assert.deepEqual(bodyState(), rebuild, 'the mutant must leave the pinned bodies installed (its transaction rolled back)');
  log('PHASE 7: MUTATION — reverting the order-path derivation aborts in POSTFLIGHT_RESIDUAL and installs nothing');

  log('\nALL PHASES PASSED');
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
  log(`(disposable container ${NAME} removed; work dir ${workDir})`);
}
