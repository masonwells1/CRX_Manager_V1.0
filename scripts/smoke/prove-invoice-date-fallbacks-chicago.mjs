#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for
 *   supabase/migrations/20260903170000_invoice_date_fallbacks_chicago.sql
 * (the four server-side invoice_date fallbacks move from the UTC CURRENT_DATE to the
 * America/Chicago business date; Mason's 2026-09-03 decision, DECISION_LOG).
 *
 * Built on the same harness as prove-quote-customer-row-version-real-schema.mjs: it
 * restores the supported schema baseline, replays the ledger-selected post-baseline
 * migrations to bring the schema forward (each wrapped in one transaction exactly as
 * scripts/apply-migration-file.mjs transmits it), installs production's exact starting
 * bodies from a byte-exact fixture, and never reads a DB URL.
 *
 * WHAT IT PROVES, in order:
 *   1. the four installed live bodies hash to ALL FOUR live pins the candidate names in
 *      its own PREFLIGHT_BODY_DRIFT messages (the pins are read from the file, not
 *      re-typed here), including the CRLF form of the split-invoice body -- the same
 *      check the migration's preflight performs on production;
 *   2. BEFORE the candidate, with the session clock set to a zone whose calendar day
 *      differs from Chicago's at this instant, save_invoice with no invoice_date stamps
 *      the SESSION day (the defect), so the behavioural test below discriminates;
 *   3. against one drifted body the candidate ABORTS with PREFLIGHT_BODY_DRIFT and all
 *      four bodies are byte-for-byte unchanged (pins, replacements and postflight share
 *      one transaction);
 *   4. against the pinned bodies it applies, POSTFLIGHT_OK is raised, and all four
 *      installed bodies hash to the candidate pins the file names;
 *   5. re-applying reinstalls the identical bodies (safe to replay);
 *   6. AFTER the candidate, the same save_invoice call stamps the America/Chicago day,
 *      not the session day;
 *   7. mutation: a candidate whose split-invoice season fallback is left on CURRENT_DATE
 *      must abort in POSTFLIGHT_CURRENT_DATE with nothing installed; a candidate whose
 *      drift pin for one function is removed must NO LONGER refuse that function's
 *      drift (proving the pin is load-bearing) -- and is then discarded.
 *
 * Requires Docker. Touches NOTHING outside its own throwaway, network-less container.
 *
 *   node scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs
 *
 * Exits 0 only if every phase passes, including the mutation phases, which must FAIL.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertWrappable } from '../../.claude/hooks/migration-wrappability-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-invoice-date-chicago-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260903170000_invoice_date_fallbacks_chicago.sql');
// Byte-exact LIVE definitions of the four functions (pg_get_functiondef, read 2026-09-03;
// the split body keeps its CRLF as production does). The ledger replay cannot reproduce
// production's exact starting bodies: the baseline dump and this checkout disagree with
// live on line endings for legacy bodies, which is a harness limitation, not a property
// of this candidate. So the replay brings the SCHEMA forward and this fixture installs
// the exact starting bodies; the prover then asserts each hashes to the candidate's own
// live pin, which is the same check the migration's preflight performs on production.
const LIVE_BODIES = path.join(ROOT, 'scripts', 'smoke', 'fixtures', 'invoice-date-fallbacks-live-bodies-20260903.sql');
// Replay stops before this file: its own precondition pins a legacy body whose baseline
// line endings differ from live, so it cannot replay on this harness. Everything the four
// bodies need at runtime exists by then; the fixture above supplies the bodies themselves.
const REPLAY_STOP_BEFORE = '20260817120000_carry_allocated_line_cents_through_lifecycle.sql';
const FUNCS = [
  '_price_order_below_cost_impl_20260810',
  '_save_invoice_lineage_unaware_impl_20260827',
  '_save_field_app_invoice_impl_20260714',
  '_save_field_app_split_invoice_impl',
];
const ADMIN = '00000000-0000-4000-8000-00000000c001';

const log = (m) => process.stdout.write(`${m}\n`);
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 120 * 1024 * 1024, ...options });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${result.error?.message ?? ''}\n${result.stderr || result.stdout}`.trim());
  }
  return result;
}
function psql(sql, options = {}) {
  return docker(
    ['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(options.wrap ? ['-1'] : [])],
    { input: sql, allowFailure: options.allowFailure },
  );
}
// scripts/apply-migration-file.mjs transmits every wrappable file inside ONE transaction
// (a file that carries top-level transaction control or a non-transactional statement is
// refused there; older replayed history may legitimately carry its own BEGIN/COMMIT).
// Mirror that here with the SAME classifier, so files that use SET LOCAL / LOCK TABLE at
// top level behave exactly as they did live, and a PL/pgSQL body's BEGIN/END is never
// mistaken for transaction control.
function isWrappable(text) {
  try { assertWrappable(text, 'replay'); return true; } catch { return false; }
}
const wrapByName = new Map();
function scalar(sql) {
  const r = docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atqc', sql]);
  return r.stdout.trim();
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function copyLf(local, name, dir) {
  const lf = readFileSync(local, 'utf8').replace(/\r\n/g, '\n');
  const tmp = path.join(dir, name);
  writeFileSync(tmp, lf, 'utf8');
  wrapByName.set(name, isWrappable(lf));
  copy(tmp, name);
}
function copyMigrationText(text, name, dir) {
  const tmp = path.join(dir, name);
  writeFileSync(tmp, text, 'utf8');
  wrapByName.set(name, isWrappable(text));
  copy(tmp, name);
}
function apply(name, user) { return psql(`\\i /tmp/${name}`, { user, wrap: wrapByName.get(name) ?? false }); }
function applyExpectFail(name, token) {
  const r = psql(`\\i /tmp/${name}`, { allowFailure: true, wrap: wrapByName.get(name) ?? false });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.notEqual(r.status, 0, `${name} unexpectedly succeeded`);
  assert.match(out, new RegExp(token), `${name} did not fail with ${token}:\n${out.slice(-1500)}`);
  return out;
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const logs = docker(['logs', NAME], { allowFailure: true });
    const initComplete = `${logs.stdout}\n${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.');
    const ready = initComplete
      && docker(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0;
    if (ready) {
      const q = docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'], { allowFailure: true });
      if (q.status === 0 && q.stdout.trim() === '1') return;
    }
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
function bodyMd5(fn) { return scalar(`SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`); }
function bodyState() { return Object.fromEntries(FUNCS.map((fn) => [fn, bodyMd5(fn)])); }
function functionDef(fn) { return scalar(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`); }

// The candidate names every pin in its own refusal messages; read them from the file.
const candidateSql = readFileSync(CANDIDATE, 'utf8');
assert.equal(candidateSql.includes('\r'), false, 'candidate must be LF');
const pins = {};
for (const fn of FUNCS) {
  const m = new RegExp(`PREFLIGHT_BODY_DRIFT: public\\.${fn} live body md5 is %, expected ([0-9a-f]{32}) \\(the reviewed starting body\\) or ([0-9a-f]{32}) \\(this file`).exec(candidateSql);
  assert.ok(m, `candidate does not pin ${fn}`);
  pins[fn] = { live: m[1], candidate: m[2] };
}
// The candidate bodies are the text between each function's $function$ delimiters.
for (const fn of FUNCS) {
  const start = candidateSql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  assert.notEqual(start, -1, `candidate lacks CREATE for ${fn}`);
  const open = candidateSql.indexOf('$function$', start) + '$function$'.length;
  const close = candidateSql.indexOf('$function$', open);
  const body = candidateSql.slice(open, close);
  assert.equal(md5(body), pins[fn].candidate, `candidate body text for ${fn} does not hash to its own candidate pin`);
}
log(`pins read from the candidate: ${FUNCS.map((fn) => `${fn}=${pins[fn].live.slice(0, 8)}->${pins[fn].candidate.slice(0, 8)}`).join(', ')}`);

const workDir = mkdtempSync(path.join(tmpdir(), 'crx-invoice-date-chicago-'));
const smokeSetup = `
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'chicago-admin@example.invalid', '{"full_name":"Chicago Admin","role":"admin"}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email, role, is_active) VALUES
    ('${ADMIN}', 'chicago-admin@example.invalid', 'admin', true)
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
`;
// Session zone whose calendar day differs from Chicago's RIGHT NOW: the far-east zone is
// tomorrow from 05:00 Chicago onwards; the far-west zone is yesterday before 06:00
// Chicago. One of the two always differs, and the SQL asserts which.
function saveInvoiceProbe(label) {
  const sql = `
DO $probe$
DECLARE
  v_chi date; v_sess date; v_inv uuid; v_stamped date; v_cust uuid; v_zone text;
BEGIN
  -- Both claim conventions: the platform overlay's auth.uid() reads the JSON claims,
  -- older helpers read the per-claim keys.
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
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] chicago ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_cust;
  -- Call the impl this candidate rewrites directly: the public save_invoice wrapper in
  -- this harness predates the 20260827 lineage cutover and routes to an older impl.
  v_inv := _save_invoice_lineage_unaware_impl_20260827(jsonb_build_object('customer_id', v_cust, 'invoice_type', 'misc_charge', 'status', 'draft'), '[]'::jsonb, NULL);
  SELECT invoice_date INTO v_stamped FROM invoices WHERE id = v_inv;
  RAISE NOTICE 'PROBE_RESULT ${label} zone=% session_day=% chicago_day=% stamped=%', v_zone, v_sess, v_chi, v_stamped;
  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} session=% chicago=% stamped=%', v_sess, v_chi, v_stamped;
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ session=(\S+) chicago=(\S+) stamped=(\S+)/.exec(out);
  assert.ok(m, `${label}: probe did not reach its rollback marker:\n${out.slice(-1500)}`);
  return { session: m[1], chicago: m[2], stamped: m[3] };
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
  log(`PHASE 1: baseline restored and ${stopIdx} post-baseline migrations replayed (schema brought forward to ${path.basename(migrations[stopIdx - 1])})`);

  // Install production's exact starting bodies, byte for byte (CR preserved).
  copy(LIVE_BODIES, 'live-bodies.sql');
  apply('live-bodies.sql');
  const before = bodyState();
  for (const fn of FUNCS) assert.equal(before[fn], pins[fn].live, `installed live body for ${fn} hashes to ${before[fn]}, not the candidate's live pin ${pins[fn].live}`);
  const splitHasCr = scalar(`SELECT position(E'\\r' IN p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_save_field_app_split_invoice_impl'`);
  assert.equal(splitHasCr, 't', 'the split-invoice body must carry CRLF like production (the pin is its CRLF md5)');
  log('PHASE 1b: all four live bodies installed byte-exact and hash to the candidate\'s live pins (split body CRLF, as live)');

  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(smokeSetup);

  const preProbe = saveInvoiceProbe('BEFORE');
  assert.notEqual(preProbe.session, preProbe.chicago, 'probe precondition: session day must differ from the Chicago day');
  assert.equal(preProbe.stamped, preProbe.session, `BEFORE the candidate the fallback must stamp the SESSION day (the defect): ${JSON.stringify(preProbe)}`);
  log(`PHASE 2: defect reproduced -- save_invoice with no invoice_date stamped the session day ${preProbe.stamped}, not the Chicago day ${preProbe.chicago}`);

  // Capture every pre-apply definition so later phases can reset to the live pins.
  const preApplyDefs = Object.fromEntries(FUNCS.map((fn) => [fn, functionDef(fn)]));

  // PHASE 3: drift refusal is atomic across all four bodies.
  const originalDef = preApplyDefs[FUNCS[0]];
  const driftedDef = originalDef.replace('$function$\n', '$function$\n-- drifted out of band\n');
  assert.notEqual(driftedDef, originalDef, 'could not build the drifted body');
  psql(driftedDef);
  const drifted = bodyState();
  assert.notEqual(drifted[FUNCS[0]], pins[FUNCS[0]].live, 'drift did not change the body');
  copyMigrationText(candidateSql, 'candidate.sql', workDir);
  applyExpectFail('candidate.sql', 'PREFLIGHT_BODY_DRIFT');
  assert.deepEqual(bodyState(), drifted, 'a refused apply must leave every body exactly as it found it');
  psql(originalDef);
  assert.deepEqual(bodyState(), before, 'restoring the original body must reproduce the live pins');
  log('PHASE 3: drifted body refused with PREFLIGHT_BODY_DRIFT; all four bodies untouched; original restored');

  // PHASE 4: apply.
  const applied = apply('candidate.sql');
  const applyOut = `${applied.stdout}\n${applied.stderr}`;
  assert.match(applyOut, /PREFLIGHT_OK/, 'apply did not report PREFLIGHT_OK');
  assert.match(applyOut, /POSTFLIGHT_OK/, 'apply did not report POSTFLIGHT_OK');
  const after = bodyState();
  for (const fn of FUNCS) assert.equal(after[fn], pins[fn].candidate, `${fn} installed md5 ${after[fn]} != candidate pin`);
  for (const fn of FUNCS) {
    const cr = scalar(`SELECT position(E'\\r' IN p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`);
    assert.equal(cr, 'f', `${fn} installed body must be LF`);
    const secdef = scalar(`SELECT p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`);
    assert.equal(secdef, 't', `${fn} must stay SECURITY DEFINER with the pinned search_path`);
  }
  log('PHASE 4: candidate applied; PREFLIGHT_OK + POSTFLIGHT_OK; all four bodies at their candidate pins, LF, SECDEF + search_path intact');

  // PHASE 5: replay.
  const replayed = apply('candidate.sql');
  assert.match(`${replayed.stdout}\n${replayed.stderr}`, /POSTFLIGHT_OK/, 'replay did not report POSTFLIGHT_OK');
  assert.deepEqual(bodyState(), after, 'replay must reinstall the identical bodies');
  log('PHASE 5: replay reinstalls the identical bodies');

  // PHASE 6: behaviour after the candidate.
  const postProbe = saveInvoiceProbe('AFTER');
  assert.notEqual(postProbe.session, postProbe.chicago, 'probe precondition: session day must differ from the Chicago day');
  assert.equal(postProbe.stamped, postProbe.chicago, `AFTER the candidate the fallback must stamp the Chicago day: ${JSON.stringify(postProbe)}`);
  log(`PHASE 6: fixed -- save_invoice with no invoice_date stamped the Chicago day ${postProbe.stamped}, not the session day ${postProbe.session}`);

  // PHASE 7a: a candidate that leaves the split season fallback on CURRENT_DATE must be
  // caught by POSTFLIGHT_CURRENT_DATE, and nothing may stay installed (one transaction).
  const seasonLine = "compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date)),";
  assert.equal(candidateSql.split(seasonLine).length - 1, 1, 'expected exactly one season fallback line in the candidate');
  let mutantA = candidateSql.replace(seasonLine, "compute_season(COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE)),");
  // Make the mutant SELF-CONSISTENT: re-pin the split body to the mutant's own md5 so the
  // md5 postflight (which would otherwise catch it first) passes, and the CURRENT_DATE
  // count guard is exercised on its own.
  {
    const fn = '_save_field_app_split_invoice_impl';
    const start = mutantA.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    const open = mutantA.indexOf('$function$', start) + '$function$'.length;
    const close = mutantA.indexOf('$function$', open);
    const mutantBodyMd5 = md5(mutantA.slice(open, close));
    assert.notEqual(mutantBodyMd5, pins[fn].candidate, 'mutant A body must differ from the candidate body');
    mutantA = mutantA.split(pins[fn].candidate).join(mutantBodyMd5);
  }
  copyMigrationText(mutantA, 'mutant-a.sql', workDir);
  // Reset to the pre-candidate bodies first so the mutant runs the fresh-apply arm.
  // (Reinstall each live body from the replayed definitions captured before PHASE 4.)
  psql(originalDef); // FUNCS[0] back to live
  // The other three are restored from their pre-apply definitions:
  for (const fn of FUNCS.slice(1)) psql(preApplyDefs[fn]);
  assert.deepEqual(bodyState(), before, 'reset to the live pins before the mutant apply');
  applyExpectFail('mutant-a.sql', 'POSTFLIGHT_CURRENT_DATE');
  assert.deepEqual(bodyState(), before, 'mutant A must leave every body at its live pin (nothing installed)');
  log('PHASE 7a: a candidate that leaves CURRENT_DATE in the split season fallback aborts in POSTFLIGHT_CURRENT_DATE with nothing installed');

  // PHASE 7b: removing one function's drift pin must make that drift go unrefused.
  const pinBlock = new RegExp(`  IF v_row\\.body_md5 <> '${pins[FUNCS[0]].live}' AND v_row\\.body_md5 <> '${pins[FUNCS[0]].candidate}' THEN\\n[^\\n]*\\n  END IF;\\n`);
  assert.match(candidateSql, pinBlock, 'could not locate the drift pin block for the first function');
  const mutantB = candidateSql.replace(pinBlock, '');
  assert.notEqual(mutantB, candidateSql, 'mutant B did not remove the pin block');
  copyMigrationText(mutantB, 'mutant-b.sql', workDir);
  psql(driftedDef);
  const rB = psql('\\i /tmp/mutant-b.sql', { allowFailure: true, wrap: true });
  const outB = `${rB.stdout}\n${rB.stderr}`;
  assert.doesNotMatch(outB, /PREFLIGHT_BODY_DRIFT/, 'with the pin removed the drift must NOT be refused by the drift pin (proves the pin is load-bearing)');
  log('PHASE 7b: with the first function\'s drift pin removed, its drifted body is no longer refused -- the pin is load-bearing (mutant discarded)');

  log('ALL PHASES PASSED');
} catch (error) {
  console.error(`INVOICE_DATE_CHICAGO_PROOF_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
