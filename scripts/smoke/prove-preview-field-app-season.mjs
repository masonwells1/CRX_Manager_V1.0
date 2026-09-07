#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for
 *   supabase/migrations/20260906120000_preview_field_app_season_follows_invoice_date.sql
 * (CRX-SEC-001: the field-application invoice PREVIEW stops pricing the application fee
 * from an independent clock read and prices it at the season the invoice is, or would be,
 * filed under -- the same season SAVE already uses since 20260904180000).
 *
 * Built on the harness of prove-invoice-season-follows-invoice-date.mjs, which is the
 * prover for the SAVE-side half of this same defect: restore the supported schema
 * baseline, replay the ledger-selected post-baseline migrations up to the documented stop
 * marker, install production's exact bodies from the byte-exact fixture, then apply
 * 20260904160000 and 20260904180000 to reach the state production is in RIGHT NOW.
 * It never reads a DB URL and touches nothing outside its own network-less container.
 *
 * PRECONDITION, asserted not assumed: once that history is replayed, the installed
 * preview_field_app_invoice_split body must hash to the md5 read read-only from live on
 * 2026-09-06. If it does not, the container is not standing in for production and every
 * later phase is void.
 *
 * WHAT IT PROVES, in order:
 *   1. the container reproduces live's preview body byte for byte, and live's exact
 *      access surface (authenticated + service_role EXECUTE; NO anon, NO PUBLIC);
 *   2. BEFORE the candidate, through the REAL installed functions, preview and save
 *      DISAGREE on the per-acre application rate in the two windows Mason is exposed to:
 *        2a. NEW invoice dated Y-10-01 (the ~5-hour 2026-09-30 window): preview quotes the
 *            season-Y rate, save charges season Y+1;
 *        2b. REOPENED invoice filed under season Y+1 (the ALL-YEAR window): preview quotes
 *            the season-Y rate, save charges the season-Y+1 rate the row carries;
 *      and AGREE on a same-season invoice, so the probe can tell a fix from a coincidence;
 *   3. the candidate applies, leaves exactly ONE signature installed, keeps SECURITY
 *      DEFINER + the pinned search_path, and restores live's access surface -- in
 *      particular anon does NOT regain EXECUTE, the regression 20260624030000 had to
 *      correct out of band the last time this function was DROP+CREATEd;
 *   4. AFTER the candidate every case in phase 2 AGREES, including the Y-09-30 and Y-10-01
 *      cases on both sides of the boundary, and a reopened invoice whose STORED season
 *      disagrees with its own new invoice_date;
 *   5. re-applying is safe: the preflight takes its REPLAY path, the postflight still runs,
 *      and the single signature, grants and behaviour are unchanged;
 *   6. mutations, each of which MUST be caught -- this is what makes the phase-4 pass mean
 *      something rather than rubber-stamping the same misunderstanding. Four test the
 *      migration's own apply-time guards and three test its behaviour:
 *        2d. a wrong preflight body pin must abort the apply (PREFLIGHT_BODY_DRIFT) so a
 *            live body another lane changed is never silently overwritten;
 *        2e. a function handed to a different owner must abort (PREFLIGHT_OWNER), because
 *            DROP+CREATE re-owns to the applying role and 20260729015706's column revoke on
 *            application_services.cost_per_acre_cents needs this to stay postgres-owned;
 *        5a. a wrong POSTFLIGHT body pin must abort a REPLAY (POSTFLIGHT_BODY). The replay
 *            path skips the preflight's pin, so this postflight pin is the only thing
 *            standing between a re-apply and overwriting a patched 5-argument body;
 *        6a. a candidate that accepts p_invoice_date but still calls current_season()
 *            (i.e. the fix removed) leaves every window mis-priced;
 *        6b. a candidate that always uses compute_season(p_invoice_date) and never reads
 *            the row's STORED season mis-prices a reopened invoice edited across the
 *            boundary -- the case DECISION_LOG 2026-09-04 settled, and the one no static
 *            guard can catch;
 *        6c. a candidate that omits the anon REVOKE must abort at POSTFLIGHT_GRANT_ANON and
 *            roll back completely, leaving live's access surface intact;
 *        6d. the same omission WITH the postflight's anon check also removed must install and
 *            empirically show anon=true. 6c alone would prove only that something refused the
 *            apply; 6d is what proves the REVOKE itself is what closes the grant.
 *      6a and 6b change the body, so they must also relax the postflight body pin -- done
 *      explicitly, and only after 2d and 5a have established that the pin is load-bearing.
 *      Every mutant is discarded; none is ever written to supabase/migrations/.
 *
 * Requires Docker.
 *
 *   node scripts/smoke/prove-preview-field-app-season.mjs
 *
 * Exits 0 only if every phase passes, including the mutation phases, which must FAIL.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-preview-season-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20260906120000_preview_field_app_season_follows_invoice_date.sql');
const SAVE_SIDE = path.join(MIGRATIONS, '20260904180000_invoice_season_follows_invoice_date.sql');
const PREDECESSOR = path.join(MIGRATIONS, '20260904160000_invoice_date_fallbacks_chicago.sql');
const LIVE_BODIES = path.join(ROOT, 'scripts', 'smoke', 'fixtures', 'invoice-date-fallbacks-live-bodies-20260903.sql');
// Same documented stop marker as the save-side prover: 20260817120000's precondition pins a
// legacy body whose baseline line endings differ from live.
const REPLAY_STOP_BEFORE = '20260817120000_carry_allocated_line_cents_through_lifecycle.sql';
const PREVIEW = 'preview_field_app_invoice_split';
// Read read-only from live on 2026-09-06:
//   SELECT md5(p.prosrc) ... WHERE p.proname = 'preview_field_app_invoice_split'
const LIVE_PREVIEW_BODY_MD5 = 'ca33fb973d86dbf3a2788dc11fbc49a5';
const SAVE_IMPL = '_save_field_app_invoice_impl_20260714';
const ADMIN = '00000000-0000-4000-8000-00000000e001';
// Three distinguishable rates, so a wrong answer can never be mistaken for a right one:
// if a lookup misses BOTH seeded seasons it falls back to the service default, a third value.
const RATE_CUR = 1111;
const RATE_NEXT = 2222;
const RATE_DEFAULT = 9999;
const ACRES = 10;
// Boundary dates are DERIVED from the season the container is actually in, never hardcoded,
// so this prover does not start failing on 2026-10-01 and read as a broken migration.
let SEASON_NOW = 0;
let DATE_IN_SEASON = '';   // Y-09-30: the ambient season
let DATE_NEXT_SEASON = ''; // Y-10-01: the next season

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
function scalar(sql) {
  return docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { input: sql }).stdout.trim();
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function copyLf(local, name, dir) { copyText(readFileSync(local, 'utf8'), name, dir); }
function copyText(text, name, dir) {
  const staged = path.join(dir, name);
  writeFileSync(staged, text.replaceAll('\r\n', '\n'), 'utf8');
  copy(staged, name);
}
function apply(name, user) { return psql(`\\i /tmp/${name}`, { user, wrap: true }); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const logs = docker(['logs', NAME], { allowFailure: true });
    const initComplete = `${logs.stdout}\n${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.');
    if (initComplete && docker(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) {
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
  return result.stdout.split(/\r?\n/).filter((l) => l.startsWith('supabase/migrations/')).map((rel) => path.join(ROOT, rel));
}
function previewBodyMd5() {
  return scalar(`SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${PREVIEW}'`);
}
function previewSignatures() {
  return scalar(`SELECT coalesce(string_agg(p.oid::regprocedure::text, ' | ' ORDER BY p.oid::regprocedure::text), '<none>')
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = '${PREVIEW}'`);
}
function previewGrants() {
  return scalar(`SELECT string_agg(r.rolname || '=' || has_function_privilege(r.rolname, p.oid, 'EXECUTE')::text, ',' ORDER BY r.rolname)
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                        (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
                  WHERE n.nspname = 'public' AND p.proname = '${PREVIEW}'`);
}
function publicHasExecute() {
  return scalar(`SELECT bool_or(acl.grantee = 0)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                      LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE n.nspname = 'public' AND p.proname = '${PREVIEW}' AND acl.privilege_type = 'EXECUTE'`);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'crx-preview-season-'));
const candidateSql = readFileSync(CANDIDATE, 'utf8');
assert.equal(candidateSql.includes('\r'), false, 'candidate must be LF');
assert.ok(candidateSql.includes(`DROP FUNCTION IF EXISTS public.${PREVIEW}(jsonb, jsonb, uuid, uuid);`), 'candidate must drop the old 4-argument signature');
assert.ok(/REVOKE EXECUTE ON FUNCTION public\.preview_field_app_invoice_split\(jsonb, jsonb, uuid, uuid, date\) FROM anon;/.test(candidateSql), 'candidate must revoke the anon grant a fresh CREATE re-acquires');
assert.ok(candidateSql.includes('$preflight$'), 'candidate must carry an in-transaction preflight');
assert.ok(candidateSql.includes('$postflight$'), 'candidate must carry an in-transaction postflight');
assert.ok(candidateSql.includes(LIVE_PREVIEW_BODY_MD5), 'the preflight must pin the reviewed live body md5');
// Only the EXECUTABLE body matters here; the header comment names current_season() to say
// what was replaced, and a substring check over the whole file would flag that prose.
const candidateBody = (() => {
  const open = candidateSql.indexOf('$function$') + '$function$'.length;
  const close = candidateSql.indexOf('$function$', open);
  assert.ok(open > 9 && close > open, 'candidate body is not dollar-quoted as expected');
  return candidateSql.slice(open, close);
})();
assert.equal(candidateBody.includes('current_season()'), false, 'candidate body must not price from an independent clock read');

const smokeSetup = `
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'preview-season-admin@example.invalid', '{"full_name":"Preview Season Admin","role":"admin"}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email, role, is_active) VALUES
    ('${ADMIN}', 'preview-season-admin@example.invalid', 'admin', true)
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
`;
// Both claim conventions: the platform overlay's auth.uid() reads the JSON claims,
// older helpers read the per-claim keys.
const AUTHENTICATE = `
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '${ADMIN}', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '${ADMIN}', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
`;

/**
 * The whole point of the change, exercised end to end through the REAL installed
 * functions: PREVIEW the form the operator is looking at, then SAVE that same form, and
 * report both application-fee rates and both grand totals.
 *
 * `mode` selects which of the two exposure windows is under test:
 *   'new'      -- a brand new invoice dated `invoiceDate` (the 2026-09-30 window);
 *   'reopen'   -- an invoice CREATED at `createDate`, then previewed and re-saved at
 *                 `invoiceDate` (the all-year window). Save deliberately does not
 *                 re-season an existing invoice, so when `createDate` and `invoiceDate`
 *                 straddle October 1 the row's STORED season disagrees with its own
 *                 invoice_date -- the case that separates a real fix from one that only
 *                 recomputes the season from the date it was handed.
 *
 * `withDate` is false before the candidate, where the function has no date parameter at
 * all -- which is precisely why this could never be fixed in the frontend.
 * Everything the probe writes is rolled back by its own terminating exception.
 */
function parityProbe(label, { mode, invoiceDate, createDate = null, withDate }) {
  const previewArgs = withDate
    ? `jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})), '[]'::jsonb, v_svc, v_inv, DATE '${invoiceDate}'`
    : `jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})), '[]'::jsonb, v_svc, v_inv`;
  const createStep = mode === 'reopen'
    ? `
  v_res := ${SAVE_IMPL}(
    NULL, jsonb_build_object('invoice_date', '${createDate}'),
    jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})),
    '[]'::jsonb, '${ADMIN}'::uuid, v_svc, NULL);
  SELECT i.id INTO v_inv FROM invoices i WHERE i.customer_id = v_cust AND i.invoice_type = 'field_application' LIMIT 1;
  IF v_inv IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: the invoice under edit was not created (result %)', v_res; END IF;
  SELECT i.season INTO v_stored_season FROM invoices i WHERE i.id = v_inv;`
    : '';
  const sql = `
DO $probe$
DECLARE
  v_cust uuid; v_field uuid; v_svc uuid; v_res jsonb; v_inv uuid := NULL;
  v_preview jsonb; v_preview_rate bigint; v_preview_total bigint;
  v_saved_rate bigint; v_saved_total bigint; v_saved_season int; v_stored_season int := NULL;
BEGIN
${AUTHENTICATE}
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] preview ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_cust;
  INSERT INTO fields (customer_id, field_name, total_acres) VALUES (v_cust, '[SMOKE] field ${label}', ${ACRES}) RETURNING id INTO v_field;
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active)
    VALUES ('[SMOKE] service ${label}', ${RATE_DEFAULT}, 0, true) RETURNING id INTO v_svc;
  INSERT INTO customer_application_rates (customer_id, application_service_id, rate_per_acre_cents, season)
    VALUES (v_cust, v_svc, ${RATE_CUR}, ${SEASON_NOW}), (v_cust, v_svc, ${RATE_NEXT}, ${SEASON_NOW + 1});
${createStep}

  -- What Mason sees on the Customers tab, for the form as it stands right now.
  v_preview := ${PREVIEW}(${previewArgs});
  SELECT (line->>'unit_price_cents')::bigint INTO v_preview_rate
    FROM jsonb_array_elements(v_preview -> 'per_customer') pc,
         jsonb_array_elements(pc -> 'lines') line
   WHERE line->>'kind' = 'service_fee' LIMIT 1;
  IF v_preview_rate IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: preview returned no service_fee line (%)', v_preview; END IF;
  v_preview_total := (v_preview->>'grand_total_cents')::bigint;

  -- What he is actually charged when he then clicks Save on that same form.
  v_res := ${SAVE_IMPL}(
    v_inv, jsonb_build_object('invoice_date', '${invoiceDate}'),
    jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})),
    '[]'::jsonb, '${ADMIN}'::uuid, v_svc, NULL);
  SELECT i.id, i.season, i.total_amount_cents INTO v_inv, v_saved_season, v_saved_total
    FROM invoices i WHERE i.customer_id = v_cust AND i.invoice_type = 'field_application' AND i.deleted_at IS NULL LIMIT 1;
  IF v_inv IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: no saved field_application invoice (result %)', v_res; END IF;
  SELECT ii.unit_price_cents INTO v_saved_rate FROM invoice_items ii WHERE ii.invoice_id = v_inv AND ii.is_application_fee LIMIT 1;
  IF v_saved_rate IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: no application-fee line on invoice %', v_inv; END IF;

  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} preview_rate=% saved_rate=% preview_total=% saved_total=% saved_season=% stored_season=%',
    v_preview_rate, v_saved_rate, v_preview_total, v_saved_total, v_saved_season, coalesce(v_stored_season::text, 'none');
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ preview_rate=(\S+) saved_rate=(\S+) preview_total=(\S+) saved_total=(\S+) saved_season=(\S+) stored_season=(\S+)/.exec(out);
  assert.ok(m, `${label}: parity probe did not reach its rollback marker:\n${out.slice(-2500)}`);
  return {
    label,
    previewRate: Number(m[1]),
    savedRate: Number(m[2]),
    previewTotal: Number(m[3]),
    savedTotal: Number(m[4]),
    savedSeason: Number(m[5]),
    storedSeason: m[6] === 'none' ? null : Number(m[6]),
  };
}

function assertAgrees(p) {
  assert.notEqual(p.previewRate, RATE_DEFAULT, `${p.label}: precondition -- a seeded per-customer rate must be found, not the service default`);
  assert.equal(p.previewRate, p.savedRate, `${p.label}: preview quoted ${p.previewRate}c/acre but save charged ${p.savedRate}c/acre: ${JSON.stringify(p)}`);
  assert.equal(p.previewTotal, p.savedTotal, `${p.label}: preview total ${p.previewTotal} != saved total ${p.savedTotal}: ${JSON.stringify(p)}`);
}
function assertDisagrees(p) {
  assert.notEqual(p.previewRate, RATE_DEFAULT, `${p.label}: precondition -- a seeded per-customer rate must be found, not the service default`);
  assert.notEqual(p.previewRate, p.savedRate, `${p.label}: expected preview and save to DISAGREE, both said ${p.previewRate}c/acre: ${JSON.stringify(p)}`);
}

/** Applies a one-off mutated copy of the candidate. Never written to supabase/migrations/. */
function applyMutant(label, mutate, options = {}) {
  const mutated = mutate(candidateSql);
  assert.notEqual(mutated, candidateSql, `${label}: mutation was a no-op, so it proves nothing`);
  copyText(mutated, `mutant-${label}.sql`, workDir);
  const out = psql(`\\i /tmp/mutant-${label}.sql`, { wrap: true, allowFailure: options.mustFail === true });
  if (options.mustFail) {
    assert.notEqual(out.status, 0, `${label}: the apply was expected to ABORT and did not`);
  }
  return out;
}

/** Everything psql printed, since RAISE NOTICE and ERROR both go to stderr. */
function said(out) { return `${out.stdout}\n${out.stderr}`; }

function previewOwner() {
  return scalar(`SELECT p.proowner::regrole::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = '${PREVIEW}'`);
}

try {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1536m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();

  // ---- PHASE 1: reproduce production's schema ---------------------------------------
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
    copyLf(migration, `migration-${index}.sql`, workDir);
    apply(`migration-${index}.sql`);
  }
  log(`PHASE 1: baseline restored and ${stopIdx} post-baseline migrations replayed`);

  copy(LIVE_BODIES, 'live-bodies.sql');
  apply('live-bodies.sql');
  copyLf(PREDECESSOR, 'predecessor.sql', workDir);
  const predOut = apply('predecessor.sql');
  assert.match(`${predOut.stdout}
${predOut.stderr}`, /POSTFLIGHT_OK/, 'the 20260904160000 predecessor did not reach its own POSTFLIGHT_OK');
  copyLf(SAVE_SIDE, 'save-side.sql', workDir);
  const saveOut = apply('save-side.sql');
  assert.match(`${saveOut.stdout}
${saveOut.stderr}`, /POSTFLIGHT_OK/, 'the 20260904180000 save-side migration did not reach its own POSTFLIGHT_OK');
  log('PHASE 1a: 20260904160000 and 20260904180000 applied -- the container is now in the state production is in');

  // The precondition everything else rests on: this container's preview function IS live's.
  assert.equal(previewBodyMd5(), LIVE_PREVIEW_BODY_MD5,
    `the replayed preview body hashes to ${previewBodyMd5()}, not live's ${LIVE_PREVIEW_BODY_MD5}; the container is not standing in for production`);
  const startSignatures = previewSignatures();
  assert.equal(startSignatures, `${PREVIEW}(jsonb,jsonb,uuid,uuid)`, `expected exactly live's one signature, got: ${startSignatures}`);
  log(`PHASE 1b: installed preview body reproduces live md5 ${LIVE_PREVIEW_BODY_MD5}; exactly one signature ${startSignatures}`);

  // Reproduce live's access surface. A clean rebuild leaves anon holding the default grant
  // Supabase's ALTER DEFAULT PRIVILEGES hands every new function; production does not.
  psql(`REVOKE ALL ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid) TO authenticated, service_role;`);
  const startGrants = previewGrants();
  assert.equal(startGrants, 'anon=false,authenticated=true,service_role=true', `container grants must match live, got: ${startGrants}`);
  assert.equal(publicHasExecute(), 'false', 'PUBLIC must not hold EXECUTE at the start, or the phase-3 assertion is vacuous');
  log(`PHASE 1c: access surface set to live's -- ${startGrants}, PUBLIC=false`);

  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(smokeSetup);

  SEASON_NOW = Number(scalar('SELECT current_season()'));
  assert.ok(Number.isInteger(SEASON_NOW) && SEASON_NOW > 2000, `could not read current_season(): ${SEASON_NOW}`);
  DATE_IN_SEASON = `${SEASON_NOW}-09-30`;
  DATE_NEXT_SEASON = `${SEASON_NOW}-10-01`;
  assert.equal(Number(scalar(`SELECT compute_season(DATE '${DATE_IN_SEASON}')`)), SEASON_NOW, `${DATE_IN_SEASON} must be in the ambient season`);
  assert.equal(Number(scalar(`SELECT compute_season(DATE '${DATE_NEXT_SEASON}')`)), SEASON_NOW + 1, `${DATE_NEXT_SEASON} must be in the next season`);
  log(`PHASE 1d: boundary derived from the container clock -- ambient season ${SEASON_NOW}; ${DATE_IN_SEASON} is ${SEASON_NOW}, ${DATE_NEXT_SEASON} is ${SEASON_NOW + 1}`);

  // ---- PHASE 2: reproduce the defect through the REAL installed functions ------------
  const beforeSameSeason = parityProbe('BEFORE_NEW_SAME_SEASON', { mode: 'new', invoiceDate: DATE_IN_SEASON, withDate: false });
  assertAgrees(beforeSameSeason);
  log(`PHASE 2a: control -- a same-season invoice dated ${DATE_IN_SEASON} already agrees (${beforeSameSeason.previewRate}c/acre both sides), so a later PASS is not just "everything agrees"`);

  const beforeNewOct = parityProbe('BEFORE_NEW_NEXT_SEASON', { mode: 'new', invoiceDate: DATE_NEXT_SEASON, withDate: false });
  assertDisagrees(beforeNewOct);
  assert.equal(beforeNewOct.previewRate, RATE_CUR, `preview should quote the clock season's rate: ${JSON.stringify(beforeNewOct)}`);
  assert.equal(beforeNewOct.savedRate, RATE_NEXT, `save should charge the invoice date's season rate: ${JSON.stringify(beforeNewOct)}`);
  log(`PHASE 2b: DEFECT REPRODUCED (2026-09-30 window) -- new invoice dated ${DATE_NEXT_SEASON}: preview quoted ${beforeNewOct.previewRate}c/acre, save charged ${beforeNewOct.savedRate}c/acre (totals ${beforeNewOct.previewTotal} vs ${beforeNewOct.savedTotal})`);

  const beforeReopen = parityProbe('BEFORE_REOPEN_NEXT_SEASON', { mode: 'reopen', createDate: DATE_NEXT_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: false });
  assert.equal(beforeReopen.storedSeason, SEASON_NOW + 1, `precondition: the reopened invoice must be filed under season ${SEASON_NOW + 1}: ${JSON.stringify(beforeReopen)}`);
  assertDisagrees(beforeReopen);
  assert.equal(beforeReopen.previewRate, RATE_CUR, `preview should quote the clock season's rate: ${JSON.stringify(beforeReopen)}`);
  assert.equal(beforeReopen.savedRate, RATE_NEXT, `save should charge the stored season's rate: ${JSON.stringify(beforeReopen)}`);
  log(`PHASE 2c: DEFECT REPRODUCED (all-year window) -- reopening an invoice filed under season ${beforeReopen.storedSeason}: preview quoted ${beforeReopen.previewRate}c/acre, save charged ${beforeReopen.savedRate}c/acre`);

  copyLf(CANDIDATE, 'candidate.sql', workDir);

  // ---- PHASE 2d/2e: the apply-time guards, tested against the REAL pre-apply state -----
  // The BODY PIN runs here, not with the behavioural mutants below, because it inspects the
  // 4-argument predecessor: once the candidate is installed the preflight takes its replay path
  // and skips that pin, so a later test of it would prove nothing. The OWNER guard sits ahead of
  // the replay RETURN and would in fact still be reachable later -- it is tested here only so both
  // preflight guards are exercised against the real pre-apply state.

  // 2d: the body pin. Point it at a hash the installed body cannot have; the apply must refuse
  // rather than silently overwrite whatever another lane left in the live function.
  // The md5 appears twice: once in the header prose and once in the preflight's comparison.
  // Mutating it by bare substring hits the COMMENT first and proves nothing -- that no-op is
  // what the first run of this phase actually did. Target the executable comparison by name.
  const PIN_TEST = `md5(v_src) <> '${LIVE_PREVIEW_BODY_MD5}'`;
  assert.equal(candidateSql.split(PIN_TEST).length, 2, 'the preflight must compare the body md5 exactly once, so the mutation below cannot miss it');
  const abortedPin = applyMutant('wrong-body-pin',
    (sql) => sql.replace(PIN_TEST, `md5(v_src) <> '${'0'.repeat(32)}'`), { mustFail: true });
  assert.match(said(abortedPin), /PREFLIGHT_BODY_DRIFT/, 'the wrong-pin apply must be refused by the body pin, by name');
  assert.equal(previewSignatures(), startSignatures, 'the refused apply must leave the 4-argument predecessor untouched');
  log('PHASE 2d: preflight body pin is load-bearing -- a wrong pin aborts the apply at PREFLIGHT_BODY_DRIFT and changes nothing');

  // 2e: the owner guard. DROP+CREATE re-owns the function to the applying role, and
  // 20260729015706's column revoke on application_services.cost_per_acre_cents is safe only
  // because this function is a postgres-owned SECURITY DEFINER. Hand it to another role and the
  // apply must refuse before dropping anything.
  // PostgreSQL 17 requires the current role to be able to SET ROLE to the new owner, so the
  // probe role is granted to the applying role before the handover.
  psql(`CREATE ROLE preview_owner_probe; GRANT CREATE ON SCHEMA public TO preview_owner_probe;
        GRANT preview_owner_probe TO postgres;
        ALTER FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid) OWNER TO preview_owner_probe;`);
  const abortedOwner = psql('\\i /tmp/candidate.sql', { wrap: true, allowFailure: true });
  assert.notEqual(abortedOwner.status, 0, 'applying over a non-postgres-owned function must ABORT');
  assert.match(said(abortedOwner), /PREFLIGHT_OWNER/, 'the refusal must come from the owner guard, by name');
  assert.equal(previewOwner(), 'preview_owner_probe', 'the refused apply must have changed nothing, including the owner');
  psql(`ALTER FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid) OWNER TO postgres;
        REVOKE CREATE ON SCHEMA public FROM preview_owner_probe; DROP ROLE preview_owner_probe;`);
  assert.equal(previewGrants(), startGrants, 'the owner probe must leave live\'s access surface intact');
  log('PHASE 2e: owner guard is load-bearing -- a re-owned function aborts the apply at PREFLIGHT_OWNER');

  // ---- PHASE 3: apply the candidate for real -----------------------------------------
  const applyOut = said(apply('candidate.sql'));
  assert.match(applyOut, /PREFLIGHT_OK/, 'the preflight must have run and passed, not been skipped');
  assert.match(applyOut, /POSTFLIGHT_OK/, 'the postflight must have run and passed, not been skipped');
  assert.equal(previewOwner(), 'postgres', 'the replacement must remain postgres-owned; DROP+CREATE re-owns to the applying role');
  const afterSignatures = previewSignatures();
  assert.equal(afterSignatures, `${PREVIEW}(jsonb,jsonb,uuid,uuid,date)`,
    `exactly ONE signature must remain after the candidate, got: ${afterSignatures}`);
  assert.equal(previewGrants(), startGrants, `the candidate must restore live's exact access surface; got ${previewGrants()} vs ${startGrants}`);
  assert.equal(publicHasExecute(), 'false', 'the candidate must not leave PUBLIC holding EXECUTE on this SECURITY DEFINER pricing function');
  assert.equal(scalar(`SELECT p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname='${PREVIEW}'`),
    'true search_path=public, pg_temp', 'the candidate must keep SECURITY DEFINER and the pinned search_path');
  log(`PHASE 3: candidate applied -- one signature ${afterSignatures}, grants ${previewGrants()}, PUBLIC=false, SECURITY DEFINER with search_path=public, pg_temp`);

  // ---- PHASE 4: the same probes must now AGREE --------------------------------------
  const afterSameSeason = parityProbe('AFTER_NEW_SAME_SEASON', { mode: 'new', invoiceDate: DATE_IN_SEASON, withDate: true });
  assertAgrees(afterSameSeason);
  assert.equal(afterSameSeason.previewRate, RATE_CUR, `${DATE_IN_SEASON} must still price at the season-${SEASON_NOW} rate: ${JSON.stringify(afterSameSeason)}`);

  const afterNewOct = parityProbe('AFTER_NEW_NEXT_SEASON', { mode: 'new', invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assertAgrees(afterNewOct);
  assert.equal(afterNewOct.previewRate, RATE_NEXT, `${DATE_NEXT_SEASON} must price at the season-${SEASON_NOW + 1} rate: ${JSON.stringify(afterNewOct)}`);
  log(`PHASE 4a: FIXED across the boundary -- ${DATE_IN_SEASON} quotes and charges ${afterSameSeason.previewRate}c/acre; ${DATE_NEXT_SEASON} quotes and charges ${afterNewOct.previewRate}c/acre`);

  const afterReopen = parityProbe('AFTER_REOPEN_NEXT_SEASON', { mode: 'reopen', createDate: DATE_NEXT_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assert.equal(afterReopen.storedSeason, SEASON_NOW + 1, `precondition: the reopened invoice must be filed under season ${SEASON_NOW + 1}`);
  assertAgrees(afterReopen);
  assert.equal(afterReopen.previewRate, RATE_NEXT, `a reopened season-${SEASON_NOW + 1} invoice must quote ${RATE_NEXT}: ${JSON.stringify(afterReopen)}`);
  log(`PHASE 4b: FIXED in the all-year window -- reopening a season-${afterReopen.storedSeason} invoice quotes and charges ${afterReopen.previewRate}c/acre`);

  // The decisive case: an invoice CREATED in season Y and re-saved with a date in season
  // Y+1. Save does not re-season an existing invoice (DECISION_LOG 2026-09-04), so the row
  // stays in season Y and is charged the season-Y rate. A preview that merely recomputed
  // the season from the date it was handed would quote season Y+1 and be wrong again.
  const afterCrossEdit = parityProbe('AFTER_REOPEN_CROSSES_BOUNDARY', { mode: 'reopen', createDate: DATE_IN_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assert.equal(afterCrossEdit.storedSeason, SEASON_NOW, `precondition: the invoice must have been filed under season ${SEASON_NOW}`);
  assert.equal(afterCrossEdit.savedSeason, SEASON_NOW, 'precondition: save must NOT re-season an existing invoice');
  assertAgrees(afterCrossEdit);
  assert.equal(afterCrossEdit.previewRate, RATE_CUR,
    `a season-${SEASON_NOW} invoice edited to a ${SEASON_NOW + 1} date must still quote the STORED season's rate ${RATE_CUR}: ${JSON.stringify(afterCrossEdit)}`);
  log(`PHASE 4c: FIXED on the settled edge case -- a season-${afterCrossEdit.storedSeason} invoice re-dated ${DATE_NEXT_SEASON} quotes and charges ${afterCrossEdit.previewRate}c/acre, not ${RATE_NEXT}c`);

  // ---- PHASE 5: re-apply is safe ----------------------------------------------------
  const replayOut = said(apply('candidate.sql'));
  assert.match(replayOut, /this apply is a replay/, 'the second apply must take the preflight replay path');
  assert.match(replayOut, /POSTFLIGHT_OK/, 'the replay must still be checked by the postflight');
  assert.equal(previewSignatures(), afterSignatures, 're-applying must leave exactly the same single signature');
  assert.equal(previewGrants(), startGrants, 're-applying must leave the same grants');
  assertAgrees(parityProbe('REAPPLY_NEW_NEXT_SEASON', { mode: 'new', invoiceDate: DATE_NEXT_SEASON, withDate: true }));
  log('PHASE 5: re-apply is safe -- replay path taken, postflight still ran, same signature, grants and behaviour');

  // PHASE 5a: the replay path skips the preflight's body pin, so the POSTFLIGHT body pin is the
  // only thing standing between a re-apply and silently overwriting a body another lane patched.
  // Prove it is load-bearing: point it at a hash the installed body cannot have and the replay
  // must abort, leaving the installed function untouched.
  const POSTFLIGHT_PIN = "v_body_md5 <> '83f6600412ced085d0876a3c7339ff12'";
  assert.equal(candidateSql.split(POSTFLIGHT_PIN).length, 2, 'the postflight must pin the installed body exactly once as an executable test');
  const abortedReplayPin = applyMutant('wrong-postflight-body-pin',
    (sql) => sql.replace(POSTFLIGHT_PIN, `v_body_md5 <> '${'1'.repeat(32)}'`), { mustFail: true });
  assert.match(said(abortedReplayPin), /POSTFLIGHT_BODY/, 'the refusal must come from the postflight body pin, by name');
  assert.equal(previewSignatures(), afterSignatures, 'the refused replay must leave the installed function untouched');
  assertAgrees(parityProbe('AFTER_REFUSED_REPLAY', { mode: 'new', invoiceDate: DATE_NEXT_SEASON, withDate: true }));
  log('PHASE 5a: the postflight body pin is load-bearing on the replay path -- a wrong pin aborts at POSTFLIGHT_BODY and changes nothing');

  // PHASE 5b: the postflight signature check. Counting signatures is not checking WHICH one:
  // an edit that dropped p_invoice_date would leave the count at 1 and the body md5 unchanged,
  // so every other postflight check would pass while Preview failed with PGRST202 for everyone.
  // Drop the parameter from the CREATE and the apply must refuse. The ACL statements name the
  // 5-argument signature explicitly, so a naive version of this mutant aborts at the REVOKE
  // before the postflight ever runs -- refused, but by a different guard, which would leave
  // POSTFLIGHT_SIGNATURE untested. Rewrite the ACL signatures too, so the ONLY thing left to
  // catch the arity change is the check under test, and assert on its name.
  const abortedSig = applyMutant('drops-the-new-parameter', (sql) => sql
    .replace(', p_invoice_date date DEFAULT NULL::date)', ')')
    .replace("p_invoice_date, (now() AT TIME ZONE 'America/Chicago')::date", "(now() AT TIME ZONE 'America/Chicago')::date")
    .replaceAll(`ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid, date)`, `ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid)`)
    .replace(POSTFLIGHT_PIN, 'v_body_md5 <> v_body_md5'),
  { mustFail: true });
  assert.match(said(abortedSig), /POSTFLIGHT_SIGNATURE/, 'dropping the new parameter must be refused by the postflight signature check, by name');
  assert.equal(previewSignatures(), afterSignatures, 'the refused apply must leave the 5-argument signature installed');
  log('PHASE 5b: the postflight signature check is load-bearing -- dropping p_invoice_date aborts the apply and changes nothing');

  // ---- PHASE 6: mutations, each of which MUST be caught ------------------------------
  // The next two mutants change the BODY, so the postflight body pin proven in 5a would refuse
  // them before they could be observed misbehaving -- and the point of these two is the season
  // logic, not the pin. Neutralise the pin for them only, and only after 2d and 5a have already
  // established that it is load-bearing. 6c and 6d leave the body untouched and keep the pin live.
  const withoutBodyPin = (sql) => {
    const relaxed = sql.replace(POSTFLIGHT_PIN, "v_body_md5 <> v_body_md5");
    assert.notEqual(relaxed, sql, 'the body-pin relaxation must actually match, or the mutant below cannot install');
    return relaxed;
  };

  // 6a: the fix removed. Takes the date, ignores it, still reads the clock.
  applyMutant('clock', (sql) => withoutBodyPin(sql).replace('         AND car.season = v_price_season LIMIT 1;', '         AND car.season = current_season() LIMIT 1;'));
  const mutantClockNew = parityProbe('MUTANT_CLOCK_NEW_NEXT_SEASON', { mode: 'new', invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assertDisagrees(mutantClockNew);
  const mutantClockReopen = parityProbe('MUTANT_CLOCK_REOPEN', { mode: 'reopen', createDate: DATE_NEXT_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assertDisagrees(mutantClockReopen);
  log(`PHASE 6a: mutant CAUGHT -- with the fix removed, the new-invoice window is back to ${mutantClockNew.previewRate} vs ${mutantClockNew.savedRate} and the reopen window to ${mutantClockReopen.previewRate} vs ${mutantClockReopen.savedRate}`);

  // 6b: recomputes the season from the date every time and never reads the stored season.
  applyMutant('ignores-stored-season', (sql) => withoutBodyPin(sql).replace('      v_price_season := COALESCE(v_row_season, v_new_season);', '      v_price_season := v_new_season;'));
  const mutantStored = parityProbe('MUTANT_STORED_SEASON_CROSS_EDIT', { mode: 'reopen', createDate: DATE_IN_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assertDisagrees(mutantStored);
  assert.equal(mutantStored.previewRate, RATE_NEXT, `the mutant should quote the date's season: ${JSON.stringify(mutantStored)}`);
  assert.equal(mutantStored.savedRate, RATE_CUR, `save should still charge the stored season: ${JSON.stringify(mutantStored)}`);
  log(`PHASE 6b: mutant CAUGHT -- ignoring the row's stored season re-breaks the edited-across-the-boundary case (${mutantStored.previewRate} vs ${mutantStored.savedRate})`);

  // Restore the real candidate so the last mutation starts from a correct body.
  apply('candidate.sql');
  assertAgrees(parityProbe('RESTORED_CROSS_EDIT', { mode: 'reopen', createDate: DATE_IN_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true }));

  // 6c: the anon REVOKE dropped. Supabase's ALTER DEFAULT PRIVILEGES re-grants anon on every
  // fresh CREATE, and REVOKE ALL FROM PUBLIC does not remove it -- the exact regression
  // 20260624030000 had to correct out of band after 20260624020000 DROP+CREATEd this function.
  // The file now catches this itself: the apply must ABORT in the postflight, and because the
  // migration runs in a single transaction the function must be left exactly as it was.
  const anonRevoke = `REVOKE EXECUTE ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid, date) FROM anon;\n`;
  const abortedAnon = applyMutant('no-anon-revoke', (sql) => sql.replace(anonRevoke, ''), { mustFail: true });
  assert.match(said(abortedAnon), /POSTFLIGHT_GRANT_ANON/, 'the postflight must be what refuses the anon regression, by name');
  assert.equal(previewGrants(), startGrants, 'the aborted apply must roll back completely, leaving live\'s access surface intact');
  assert.equal(previewSignatures(), afterSignatures, 'the aborted apply must roll back completely, leaving one signature');
  log(`PHASE 6c: mutant CAUGHT AND BLOCKED -- dropping the anon REVOKE aborts the apply at POSTFLIGHT_GRANT_ANON and rolls back to ${previewGrants()}`);

  // 6d: the same mutation with the postflight's anon check ALSO removed. Without this the previous
  // phase proves only that something refused the apply, not that the REVOKE is what closes the
  // grant. Here the apply succeeds and anon empirically regains EXECUTE -- so the REVOKE is
  // load-bearing, and 6c's abort is the postflight catching exactly that.
  applyMutant('no-anon-revoke-no-check', (sql) => sql
    .replace(anonRevoke, '')
    .replace('  IF v_has_anon THEN', '  IF false THEN'));
  const leakedGrants = previewGrants();
  assert.match(leakedGrants, /anon=true/, `dropping the anon REVOKE should leave anon executable, got ${leakedGrants}`);
  assert.notEqual(leakedGrants, startGrants, 'the anon REVOKE must be load-bearing');
  log(`PHASE 6d: mutant CAUGHT -- with both the REVOKE and its postflight check removed the grants become ${leakedGrants} instead of ${startGrants}`);

  apply('candidate.sql');
  assert.equal(previewGrants(), startGrants, 'the real candidate must close the anon grant the mutant opened');

  // Leave the container on the real candidate.
  apply('candidate.sql');
  assert.equal(previewGrants(), startGrants, 'the real candidate must leave live\'s access surface');
  assert.equal(previewOwner(), 'postgres', 'the real candidate must leave the function postgres-owned');
  assert.equal(previewSignatures(), afterSignatures, 'the real candidate must leave exactly one signature');
  assertAgrees(parityProbe('FINAL_CROSS_EDIT', { mode: 'reopen', createDate: DATE_IN_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true }));
  log('PHASE 7: real candidate reinstalled over the mutants -- owner, grants, signature and behaviour back to live posture');

  log('\nPREVIEW_SEASON_PROOF_PASS all phases, including all eight mutation phases, behaved as required');
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
