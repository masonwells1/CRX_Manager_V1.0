#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for
 *   supabase/migrations/20260904180000_invoice_season_follows_invoice_date.sql
 * (two invoice bodies stop taking `season` from an independent UTC clock read and
 * derive it from the same date the invoice is stamped with).
 *
 * Built on the harness of prove-invoice-date-fallbacks-chicago.mjs: it restores the
 * supported schema baseline, replays the ledger-selected post-baseline migrations to
 * bring the schema forward (each wrapped in one transaction exactly as
 * scripts/apply-migration-file.mjs transmits it), installs production's exact bodies
 * from the byte-exact fixture, applies the PREDECESSOR migration 20260904160000 to
 * reach the state production is in RIGHT NOW, and never reads a DB URL.
 *
 * WHY THE PREDECESSOR IS APPLIED HERE: this candidate's starting pins ARE the
 * predecessor's candidate pins. Applying it in-container reproduces the live starting
 * bodies from tracked files rather than from a second hand-made fixture.
 *
 * WHAT IT PROVES, in order:
 *   1. baseline + replay + live-body fixture + predecessor apply reproduces BOTH of this
 *      candidate's live starting pins byte for byte;
 *   2. BEFORE the candidate, through the REAL installed functions:
 *        2a. save_invoice with invoice_date 2026-10-01 and no season stamps season 2026
 *            -- the invoice is dated in season 2027 and filed in 2026 (the defect);
 *        2b. the field-application save with invoice_date 2026-10-01 stamps season 2026
 *            AND charges the season-2026 customer_application_rates rate -- the wrong
 *            year AND the wrong price;
 *   3. against a drifted body the candidate ABORTS with PREFLIGHT_BODY_DRIFT and both
 *      bodies are byte-for-byte unchanged. NOTE this shows drift refusal, NOT atomicity:
 *      the preflight aborts before the first CREATE OR REPLACE, so the bodies would be
 *      unchanged under either wrapping. Atomicity comes from scripts/apply-migration-file.mjs
 *      wrapping the file, and from the candidate's own POSTFLIGHT_ATOMICITY transaction-id
 *      check, neither of which this prover mutates (rls-security-reviewer L7);
 *   4. against the pinned bodies it applies, PREFLIGHT_OK + POSTFLIGHT_OK are raised,
 *      both installed bodies hash to the candidate pins, stay LF, stay SECURITY DEFINER
 *      with the pinned search_path, and keep the exact access surface they started with
 *      (PHASE 1b first sets that surface to production's, because the clean-rebuild baseline
 *      leaves these impls PUBLIC-executable -- without it the assertion is vacuous and the
 *      PHASE 8c widening mutation degenerates into a no-op);
 *   5. re-applying reinstalls identical bodies (safe to replay);
 *   6. AFTER the candidate the same two calls stamp season 2027 and charge the
 *      season-2027 rate; the mirror calls at 2026-09-30 stamp 2026 and charge the
 *      2026 rate -- both sides of the boundary the 2026-09-30 window sits on; and the
 *      no-invoice_date fallback satisfies season = compute_season(invoice_date);
 *   7. CLOCK WIRING, instrumented: with compute_season temporarily replaced by a shim
 *      that encodes its argument as YYYYMMDD, and a session zone whose calendar day
 *      differs from Chicago's, the season BEFORE the candidate encodes the SESSION
 *      (UTC-side) day and AFTER it encodes the CHICAGO day. That is the exact swap the
 *      2026-09-30 19:00-Chicago window turns on, shown at today's instant;
 *   8. mutations, each of which must FAIL: a candidate that leaves either site on the
 *      current-season helper aborts in POSTFLIGHT_SEASON_CLOCK with nothing installed; a
 *      candidate whose drift pin for one function is removed silently OVERWRITES that
 *      function's drifted body (the pin is load-bearing); a candidate that widens the
 *      access surface aborts in POSTFLIGHT_GRANT; and -- the one no static guard can catch
 *      -- a candidate that binds the fee lookup to the NEW-invoice season instead of the
 *      row's own season APPLIES cleanly and is caught only behaviourally, filing an edited
 *      invoice under 2026 while charging the 2027 rate. Every mutant is then discarded.
 *
 * Requires Docker. Touches NOTHING outside its own throwaway, network-less container.
 *
 *   node scripts/smoke/prove-invoice-season-follows-invoice-date.mjs
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
const NAME = `crx-invoice-season-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260904180000_invoice_season_follows_invoice_date.sql');
const PREDECESSOR = path.join(ROOT, 'supabase', 'migrations', '20260904160000_invoice_date_fallbacks_chicago.sql');
// The same byte-exact live-body fixture the predecessor's own prover uses: the four
// bodies as production held them on 2026-09-03, BEFORE 20260904160000 was applied.
const LIVE_BODIES = path.join(ROOT, 'scripts', 'smoke', 'fixtures', 'invoice-date-fallbacks-live-bodies-20260903.sql');
// Replay stops before this file for the reason documented in the predecessor's prover:
// its precondition pins a legacy body whose baseline line endings differ from live.
const REPLAY_STOP_BEFORE = '20260817120000_carry_allocated_line_cents_through_lifecycle.sql';
const FUNCS = [
  '_save_invoice_lineage_unaware_impl_20260827',
  '_save_field_app_invoice_impl_20260714',
];
const ADMIN = '00000000-0000-4000-8000-00000000d001';
// Distinguishable seeded rates. If a lookup misses both seasons it falls back to the
// service default, which is a THIRD value -- so a wrong answer can never be mistaken
// for a right one.
const RATE_CUR = 1111;
const RATE_NEXT = 2222;
const RATE_DEFAULT = 9999;
const ACRES = 10;
// The boundary dates are DERIVED from the season the database is currently in, never
// hardcoded. compute_season rolls at October 1, so for the current season Y, `Y-09-30` is
// always in season Y (the ambient one) and `Y-10-01` is always in season Y+1. Hardcoding
// 2026-09-30/2026-10-01 would have made this prover fail from 2026-10-01 onward -- reading
// as a broken migration when nothing is broken (rls-security-reviewer L-4, 2026-09-04).
let SEASON_NOW = 0;
let DATE_IN_SEASON = '';   // Y-09-30: same season as today
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

// ---------------------------------------------------------------------------
// The candidate names every pin in its own refusal messages; read them from the file
// rather than re-typing them here, so a re-pinned candidate cannot pass a stale prover.
const candidateSql = readFileSync(CANDIDATE, 'utf8');
assert.equal(candidateSql.includes('\r'), false, 'candidate must be LF');
const pins = {};
for (const fn of FUNCS) {
  const m = new RegExp(`PREFLIGHT_BODY_DRIFT: public\\.${fn} live body md5 is %, expected ([0-9a-f]{32}) \\(the reviewed starting body as installed on production\\) or ([0-9a-f]{32}) \\(this file`).exec(candidateSql);
  assert.ok(m, `candidate does not pin ${fn}`);
  pins[fn] = { live: m[1], candidate: m[2] };
  assert.notEqual(m[1], m[2], `${fn}: live and candidate pins must differ`);
}
// The candidate bodies are the text between each function's $function$ delimiters.
for (const fn of FUNCS) {
  const start = candidateSql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  assert.notEqual(start, -1, `candidate lacks CREATE for ${fn}`);
  const open = candidateSql.indexOf('$function$', start) + '$function$'.length;
  const close = candidateSql.indexOf('$function$', open);
  assert.equal(md5(candidateSql.slice(open, close)), pins[fn].candidate, `candidate body text for ${fn} does not hash to its own candidate pin`);
}
log(`pins read from the candidate: ${FUNCS.map((fn) => `${fn}=${pins[fn].live.slice(0, 8)}->${pins[fn].candidate.slice(0, 8)}`).join(', ')}`);

const workDir = mkdtempSync(path.join(tmpdir(), 'crx-invoice-season-'));

const smokeSetup = `
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'season-admin@example.invalid', '{"full_name":"Season Admin","role":"admin"}')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email, role, is_active) VALUES
    ('${ADMIN}', 'season-admin@example.invalid', 'admin', true)
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
 * save_invoice (lineage-unaware impl) with an explicit invoice_date and NO season.
 * Returns { date, season, seasonOfDate } -- the row as stamped, plus what the season
 * SHOULD be for that date. Everything the probe writes is rolled back.
 */
function invoiceProbe(label, invoiceDate) {
  const dateExpr = invoiceDate === null ? 'NULL' : `'${invoiceDate}'`;
  const payloadDate = invoiceDate === null ? '' : `, 'invoice_date', ${dateExpr}`;
  const sql = `
DO $probe$
DECLARE v_cust uuid; v_inv uuid; v_date date; v_season int; v_expected int;
BEGIN
${AUTHENTICATE}
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] season ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_cust;
  -- Call the impl this candidate rewrites directly: the public save_invoice wrapper in
  -- this harness predates the 20260827 lineage cutover and routes to an older impl.
  v_inv := _save_invoice_lineage_unaware_impl_20260827(
    jsonb_build_object('customer_id', v_cust, 'invoice_type', 'misc_charge', 'status', 'draft'${payloadDate}),
    '[]'::jsonb, NULL);
  SELECT invoice_date, season INTO v_date, v_season FROM invoices WHERE id = v_inv;
  v_expected := compute_season(v_date);
  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} date=% season=% expected=%', v_date, v_season, v_expected;
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ date=(\S+) season=(\S+) expected=(\S+)/.exec(out);
  assert.ok(m, `${label}: probe did not reach its rollback marker:\n${out.slice(-1500)}`);
  return { date: m[1], season: Number(m[2]), expected: Number(m[3]) };
}

/**
 * The field-application save, with a per-customer application rate seeded for BOTH
 * seasons at different prices. Returns the stamped season/date AND the rate actually
 * charged on the application-fee line -- so a wrong season is visible as a wrong PRICE,
 * not only as a wrong label. Everything the probe writes is rolled back.
 */
function fieldAppProbe(label, invoiceDate) {
  const sql = `
DO $probe$
DECLARE
  v_cust uuid; v_field uuid; v_svc uuid; v_res jsonb; v_inv uuid;
  v_date date; v_season int; v_expected int; v_rate bigint;
BEGIN
${AUTHENTICATE}
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] fieldapp ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_cust;
  INSERT INTO fields (customer_id, field_name, total_acres) VALUES (v_cust, '[SMOKE] field ${label}', ${ACRES}) RETURNING id INTO v_field;
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active)
    VALUES ('[SMOKE] service ${label}', ${RATE_DEFAULT}, 0, true) RETURNING id INTO v_svc;
  INSERT INTO customer_application_rates (customer_id, application_service_id, rate_per_acre_cents, season)
    VALUES (v_cust, v_svc, ${RATE_CUR}, ${SEASON_NOW}), (v_cust, v_svc, ${RATE_NEXT}, ${SEASON_NOW + 1});

  v_res := _save_field_app_invoice_impl_20260714(
    NULL,
    jsonb_build_object('invoice_date', '${invoiceDate}'),
    jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})),
    '[]'::jsonb,
    '${ADMIN}'::uuid,
    v_svc,
    NULL);

  SELECT i.id, i.invoice_date, i.season INTO v_inv, v_date, v_season
    FROM invoices i WHERE i.customer_id = v_cust AND i.invoice_type = 'field_application' LIMIT 1;
  IF v_inv IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: no field_application invoice was created (result %)', v_res; END IF;
  SELECT ii.unit_price_cents INTO v_rate FROM invoice_items ii WHERE ii.invoice_id = v_inv AND ii.is_application_fee LIMIT 1;
  IF v_rate IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: no application-fee line on invoice %', v_inv; END IF;
  v_expected := compute_season(v_date);
  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} date=% season=% expected=% rate=%', v_date, v_season, v_expected, v_rate;
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ date=(\S+) season=(\S+) expected=(\S+) rate=(\S+)/.exec(out);
  assert.ok(m, `${label}: field-app probe did not reach its rollback marker:\n${out.slice(-2500)}`);
  return { date: m[1], season: Number(m[2]), expected: Number(m[3]), rate: Number(m[4]) };
}

/**
 * The EDIT path. Creates a field-application invoice at `createDate`, then re-saves the
 * SAME invoice with `editDate`, and reports what the row carries afterwards plus the rate
 * the application fee was charged at. The invariant under test is the one the shipped file
 * claims: the fee is priced at the season THIS INVOICE IS FILED UNDER, whichever path wrote
 * it. Everything the probe writes is rolled back.
 */
function fieldAppEditProbe(label, createDate, editDate, options = {}) {
  const seasons = options.seedSeasons ?? [SEASON_NOW, SEASON_NOW + 1];
  const rateFor = (s) => (s === SEASON_NOW ? RATE_CUR : RATE_NEXT);
  const rateRows = seasons.map((s) => `(v_cust, v_svc, ${rateFor(s)}, ${s})`).join(', ');
  const sql = `
DO $probe$
DECLARE
  v_cust uuid; v_field uuid; v_svc uuid; v_res jsonb; v_inv uuid;
  v_date date; v_season int; v_rate bigint; v_created_season int;
BEGIN
${AUTHENTICATE}
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] edit ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_cust;
  INSERT INTO fields (customer_id, field_name, total_acres) VALUES (v_cust, '[SMOKE] field ${label}', ${ACRES}) RETURNING id INTO v_field;
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active)
    VALUES ('[SMOKE] service ${label}', ${RATE_DEFAULT}, 0, true) RETURNING id INTO v_svc;
  INSERT INTO customer_application_rates (customer_id, application_service_id, rate_per_acre_cents, season)
    VALUES ${rateRows};

  -- CREATE at the first date.
  v_res := _save_field_app_invoice_impl_20260714(
    NULL, jsonb_build_object('invoice_date', '${createDate}'),
    jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})),
    '[]'::jsonb, '${ADMIN}'::uuid, v_svc, NULL);
  SELECT i.id, i.season INTO v_inv, v_created_season
    FROM invoices i WHERE i.customer_id = v_cust AND i.invoice_type = 'field_application' LIMIT 1;
  IF v_inv IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: no invoice created (result %)', v_res; END IF;

  -- EDIT the SAME invoice to the second date.
  v_res := _save_field_app_invoice_impl_20260714(
    v_inv, jsonb_build_object('invoice_date', '${editDate}'),
    jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})),
    '[]'::jsonb, '${ADMIN}'::uuid, v_svc, NULL);

  SELECT i.invoice_date, i.season INTO v_date, v_season FROM invoices i WHERE i.id = v_inv;
  SELECT ii.unit_price_cents INTO v_rate FROM invoice_items ii WHERE ii.invoice_id = v_inv AND ii.is_application_fee LIMIT 1;
  IF v_rate IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: no application-fee line after the edit on invoice %', v_inv; END IF;
  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} created_season=% date=% season=% rate=%', v_created_season, v_date, v_season, v_rate;
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ created_season=(\S+) date=(\S+) season=(\S+) rate=(\S+)/.exec(out);
  assert.ok(m, `${label}: edit probe did not reach its rollback marker:\n${out.slice(-2500)}`);
  const date = m[2];
  return {
    createdSeason: Number(m[1]),
    date,
    season: Number(m[3]),
    rate: Number(m[4]),
    // What the season WOULD be if it followed the edited date -- used to state the accepted
    // stamp divergence explicitly rather than leaving it implied.
    expectedAfterEdit: Number(date.slice(5, 7)) >= 10 ? Number(date.slice(0, 4)) + 1 : Number(date.slice(0, 4)),
  };
}

/**
 * The MULTI-GROWER group edit. Creates a field split between two growers (so
 * derive_customer_shares_from_fields returns two customers and the save opens an invoice
 * GROUP), then re-saves the group at a date in the next season after adding a THIRD grower.
 * Reports what each invoice ends up filed under and charged. Everything is rolled back.
 */
function fieldAppGroupEditProbe(label, createDate, editDate) {
  const sql = `
DO $probe$
DECLARE
  v_a uuid; v_b uuid; v_c uuid; v_field uuid; v_svc uuid; v_res jsonb;
  v_grp uuid; v_a_season int; v_a_rate bigint; v_c_season int; v_c_rate bigint; v_c_grp uuid;
  v_a_id uuid; v_c_id uuid;
BEGIN
${AUTHENTICATE}
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] grpA ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_a;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] grpB ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_b;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] grpC ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_c;
  INSERT INTO fields (customer_id, field_name, total_acres) VALUES (v_a, '[SMOKE] field ${label}', ${ACRES}) RETURNING id INTO v_field;
  INSERT INTO application_services (name, default_rate_per_acre_cents, cost_per_acre_cents, is_active)
    VALUES ('[SMOKE] service ${label}', ${RATE_DEFAULT}, 0, true) RETURNING id INTO v_svc;
  -- Same rates for every grower, so a price difference can ONLY come from the season used.
  INSERT INTO customer_application_rates (customer_id, application_service_id, rate_per_acre_cents, season)
    VALUES (v_a, v_svc, ${RATE_CUR}, ${SEASON_NOW}), (v_a, v_svc, ${RATE_NEXT}, ${SEASON_NOW + 1}),
           (v_b, v_svc, ${RATE_CUR}, ${SEASON_NOW}), (v_b, v_svc, ${RATE_NEXT}, ${SEASON_NOW + 1}),
           (v_c, v_svc, ${RATE_CUR}, ${SEASON_NOW}), (v_c, v_svc, ${RATE_NEXT}, ${SEASON_NOW + 1});
  -- Two growers on the field => two invoices in one group.
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_a, 50, true), (v_field, v_b, 50, false);

  v_res := _save_field_app_invoice_impl_20260714(
    NULL, jsonb_build_object('invoice_date', '${createDate}'),
    jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})),
    '[]'::jsonb, '${ADMIN}'::uuid, v_svc, NULL);
  SELECT i.invoice_group_id INTO v_grp FROM invoices i WHERE i.customer_id = v_a AND i.invoice_type = 'field_application' LIMIT 1;
  IF v_grp IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: expected an invoice GROUP, got none (result %)', v_res; END IF;

  -- ADD a third grower, then re-save the whole group at a date in the next season.
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_c, 50, false);
  UPDATE field_billing_defaults SET split_pct = 25 WHERE field_id = v_field AND customer_id IN (v_a, v_b);
  v_res := _save_field_app_invoice_impl_20260714(
    (SELECT id FROM invoices WHERE customer_id = v_a AND invoice_group_id = v_grp AND deleted_at IS NULL LIMIT 1),
    jsonb_build_object('invoice_date', '${editDate}'),
    jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', ${ACRES})),
    '[]'::jsonb, '${ADMIN}'::uuid, v_svc, NULL);

  -- Bind every read-back to the ACTIVE invoice in the EDITED group, and read the fee line
  -- through that invoice's id (CodeRabbit, 2026-09-04). The previous form matched on
  -- customer_id alone with a bare LIMIT 1 and no deleted_at filter, so it could have read a
  -- soft-deleted or unrelated field-application invoice for the same customer. That would not
  -- have failed loudly -- it would have silently compared the WRONG invoice's season and rate,
  -- which is how a mutation test quietly stops discriminating (PHASE 8d/8e depend on this).
  SELECT i.id, i.season, i.invoice_group_id INTO v_a_id, v_a_season, v_grp
    FROM invoices i
   WHERE i.customer_id = v_a AND i.invoice_type = 'field_application'
     AND i.deleted_at IS NULL AND i.invoice_group_id = v_grp
   ORDER BY i.created_at DESC, i.id DESC LIMIT 1;
  -- Deliberately NOT filtered by v_grp: line ~698 asserts groupId = addedGroupId ("or this phase
  -- proves nothing"), and constraining this read to the group would make that assertion
  -- tautological -- the same can-never-fail flaw being fixed above.
  SELECT i.id, i.season, i.invoice_group_id INTO v_c_id, v_c_season, v_c_grp
    FROM invoices i
   WHERE i.customer_id = v_c AND i.invoice_type = 'field_application'
     AND i.deleted_at IS NULL
   ORDER BY i.created_at DESC, i.id DESC LIMIT 1;
  IF v_a_id IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: no ACTIVE invoice for the edited grower in group % (result %)', v_grp, v_res; END IF;
  IF v_c_season IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: the added grower got no invoice (result %)', v_res; END IF;
  SELECT ii.unit_price_cents INTO v_a_rate FROM invoice_items ii
   WHERE ii.invoice_id = v_a_id AND ii.is_application_fee LIMIT 1;
  SELECT ii.unit_price_cents INTO v_c_rate FROM invoice_items ii
   WHERE ii.invoice_id = v_c_id AND ii.is_application_fee LIMIT 1;
  IF v_a_rate IS NULL OR v_c_rate IS NULL THEN RAISE EXCEPTION 'PROBE_SETUP ${label}: missing application-fee line (a %, c %)', v_a_rate, v_c_rate; END IF;
  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} grp=% a_season=% a_rate=% c_grp=% c_season=% c_rate=%', v_grp, v_a_season, v_a_rate, v_c_grp, v_c_season, v_c_rate;
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ grp=(\S+) a_season=(\S+) a_rate=(\S+) c_grp=(\S+) c_season=(\S+) c_rate=(\S+)/.exec(out);
  assert.ok(m, `${label}: group-edit probe did not reach its rollback marker:\n${out.slice(-3000)}`);
  return {
    groupId: m[1],
    existingSeason: Number(m[2]),
    existingRate: Number(m[3]),
    addedGroupId: m[4],
    addedSeason: Number(m[5]),
    addedRate: Number(m[6]),
  };
}

/**
 * Clock-wiring instrumentation. compute_season is temporarily replaced by a shim that
 * encodes its argument as YYYYMMDD, so the season column literally reports WHICH DATE
 * fed it. With no invoice_date in the payload and a session zone whose calendar day
 * differs from Chicago's, the answer is either the session (UTC-side) day or the
 * Chicago day -- which is exactly what the 2026-09-30 19:00-Chicago window turns on.
 */
const SHIM = `
CREATE OR REPLACE FUNCTION public.compute_season(p_date date) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public
AS $shim$
  SELECT extract(year FROM p_date)::integer * 10000
       + extract(month FROM p_date)::integer * 100
       + extract(day FROM p_date)::integer;
$shim$;`;
function wiringProbe(label) {
  const sql = `
DO $probe$
DECLARE v_cust uuid; v_inv uuid; v_season int; v_chi date; v_sess date; v_zone text;
BEGIN
${AUTHENTICATE}
  -- A zone whose calendar day differs from Chicago's at this instant: the far-east zone
  -- is tomorrow from 05:00 Chicago onwards, the far-west zone is yesterday before 06:00.
  -- One of the two always differs, and the probe asserts which.
  PERFORM set_config('TimeZone', 'Pacific/Kiritimati', true);
  v_chi := (now() AT TIME ZONE 'America/Chicago')::date;
  IF CURRENT_DATE = v_chi THEN PERFORM set_config('TimeZone', 'Etc/GMT+12', true); END IF;
  v_zone := current_setting('TimeZone');
  v_sess := CURRENT_DATE;
  IF v_sess = v_chi THEN
    RAISE EXCEPTION 'PROBE_SETUP: no session zone differs from Chicago at this instant (chi %, sess %)', v_chi, v_sess;
  END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] wiring ${label} ' || substr(gen_random_uuid()::text, 1, 8)) RETURNING id INTO v_cust;
  v_inv := _save_invoice_lineage_unaware_impl_20260827(
    jsonb_build_object('customer_id', v_cust, 'invoice_type', 'misc_charge', 'status', 'draft'),
    '[]'::jsonb, NULL);
  SELECT season INTO v_season FROM invoices WHERE id = v_inv;
  RAISE EXCEPTION 'PROBE_ROLLBACK ${label} zone=% session=% chicago=% season_encodes=%', v_zone, v_sess, v_chi, v_season;
END
$probe$;`;
  const r = psql(sql, { allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /PROBE_ROLLBACK \S+ zone=(\S+) session=(\S+) chicago=(\S+) season_encodes=(\S+)/.exec(out);
  assert.ok(m, `${label}: wiring probe did not reach its rollback marker:\n${out.slice(-1500)}`);
  const enc = (d) => Number(d.replace(/-/g, ''));
  return { zone: m[1], session: m[2], chicago: m[3], encodes: Number(m[4]), sessionEnc: enc(m[2]), chicagoEnc: enc(m[3]) };
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
  assert.ok(migrations.includes(PREDECESSOR), 'the predecessor 20260904160000 must be in the ledger-selected replay');
  const stopIdx = migrations.findIndex((m) => path.basename(m) === REPLAY_STOP_BEFORE);
  assert.notEqual(stopIdx, -1, `replay stop marker ${REPLAY_STOP_BEFORE} is not in the ledger-selected list`);
  for (const [index, migration] of migrations.slice(0, stopIdx).entries()) {
    const name = `migration-${index}.sql`;
    copyLf(migration, name, workDir);
    apply(name);
  }
  log(`PHASE 1: baseline restored and ${stopIdx} post-baseline migrations replayed`);

  // Production's exact bodies as of 2026-09-03 (before the predecessor), byte for byte.
  copy(LIVE_BODIES, 'live-bodies.sql');
  apply('live-bodies.sql');
  // Then the predecessor, which is what production actually ran on 2026-09-04. Its own
  // preflight will refuse if the fixture is not what it expects, so this step is itself
  // a check that the fixture is the right starting point.
  copyLf(PREDECESSOR, 'predecessor.sql', workDir);
  const predOut = apply('predecessor.sql');
  assert.match(`${predOut.stdout}\n${predOut.stderr}`, /POSTFLIGHT_OK/, 'the predecessor migration did not reach its own POSTFLIGHT_OK');
  const before = bodyState();
  for (const fn of FUNCS) {
    assert.equal(before[fn], pins[fn].live,
      `after replaying production's own history, ${fn} hashes to ${before[fn]}, not this candidate's live pin ${pins[fn].live}`);
  }
  log("PHASE 1a: predecessor 20260904160000 applied; both bodies reproduce this candidate's LIVE pins byte for byte");

  // PHASE 1b: reproduce PRODUCTION'S ACCESS SURFACE. The clean-rebuild baseline leaves these
  // impls executable by PUBLIC (so anon and authenticated inherit EXECUTE); production has
  // them locked to postgres, plus service_role for the field-app impl -- read read-only on
  // 2026-09-04 as `postgres=X/postgres` and `postgres=X/postgres | service_role=X/postgres`.
  // Without this step two things go wrong: PHASE 4's "access surface unchanged" assertion is
  // vacuous, and PHASE 8c's widening mutation is a NO-OP rather than a widening -- it would
  // report the guard as broken when the guard is fine and the MUTATION is invalid. That is
  // exactly what happened on the first run of this prover.
  psql(`
    REVOKE ALL ON FUNCTION public.${FUNCS[0]}(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION public.${FUNCS[1]}(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.${FUNCS[1]}(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) TO service_role;
  `);
  for (const fn of FUNCS) {
    assert.equal(
      scalar(`SELECT has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`),
      'f',
      `${fn}: the container must now match production, where neither web role can execute this impl`,
    );
  }
  assert.deepEqual(bodyState(), before, 'changing grants must not have touched any body');
  log('PHASE 1b: container access surface set to match production (postgres only; service_role on the field-app impl); neither anon nor authenticated can execute either impl');

  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(smokeSetup);

  // Derive the boundary dates from the season the database is actually in, so this prover
  // does not expire on 2026-10-01 (rls-security-reviewer L-4).
  SEASON_NOW = Number(scalar('SELECT current_season()'));
  assert.ok(Number.isInteger(SEASON_NOW) && SEASON_NOW > 2000, `could not read current_season(): ${SEASON_NOW}`);
  DATE_IN_SEASON = `${SEASON_NOW}-09-30`;
  DATE_NEXT_SEASON = `${SEASON_NOW}-10-01`;
  assert.equal(Number(scalar(`SELECT compute_season(DATE '${DATE_IN_SEASON}')`)), SEASON_NOW, `${DATE_IN_SEASON} must be in the ambient season`);
  assert.equal(Number(scalar(`SELECT compute_season(DATE '${DATE_NEXT_SEASON}')`)), SEASON_NOW + 1, `${DATE_NEXT_SEASON} must be in the next season`);
  log(`PHASE 1c: boundary derived from the live clock -- ambient season ${SEASON_NOW}; ${DATE_IN_SEASON} is season ${SEASON_NOW}, ${DATE_NEXT_SEASON} is season ${SEASON_NOW + 1}`);

  // ---- PHASE 2: reproduce the defect through the REAL installed functions ----------
  const beforeInvoiceOct = invoiceProbe('BEFORE_INVOICE_NEXT_SEASON', DATE_NEXT_SEASON);
  assert.equal(beforeInvoiceOct.date, DATE_NEXT_SEASON, 'probe precondition: the payload date must be stamped');
  assert.equal(beforeInvoiceOct.expected, SEASON_NOW + 1, `probe precondition: ${DATE_NEXT_SEASON} is season ${SEASON_NOW + 1}`);
  assert.notEqual(beforeInvoiceOct.season, beforeInvoiceOct.expected,
    `BEFORE the candidate save_invoice must MIS-stamp the season: ${JSON.stringify(beforeInvoiceOct)}`);
  log(`PHASE 2a: defect reproduced -- save_invoice dated ${beforeInvoiceOct.date} (season ${beforeInvoiceOct.expected}) was filed under season ${beforeInvoiceOct.season}`);

  const beforeFieldOct = fieldAppProbe('BEFORE_FIELDAPP_NEXT_SEASON', DATE_NEXT_SEASON);
  assert.equal(beforeFieldOct.date, DATE_NEXT_SEASON, 'probe precondition: the payload date must be stamped');
  assert.equal(beforeFieldOct.expected, SEASON_NOW + 1, `probe precondition: ${DATE_NEXT_SEASON} is season ${SEASON_NOW + 1}`);
  assert.notEqual(beforeFieldOct.season, beforeFieldOct.expected,
    `BEFORE the candidate the field-app save must MIS-stamp the season: ${JSON.stringify(beforeFieldOct)}`);
  assert.notEqual(beforeFieldOct.rate, RATE_DEFAULT, 'probe precondition: a seeded per-customer rate must have been found, not the service default');
  assert.notEqual(beforeFieldOct.rate, RATE_NEXT,
    `BEFORE the candidate the field-app save must charge the WRONG season's rate: ${JSON.stringify(beforeFieldOct)}`);
  assert.equal(beforeFieldOct.rate, RATE_CUR, `expected the season-${SEASON_NOW} rate ${RATE_CUR}: ${JSON.stringify(beforeFieldOct)}`);
  log(`PHASE 2b: defect reproduced -- field-app invoice dated ${beforeFieldOct.date} (season ${beforeFieldOct.expected}) filed under season ${beforeFieldOct.season} AND charged the season-${SEASON_NOW} rate ${beforeFieldOct.rate}c/acre instead of ${RATE_NEXT}c`);

  // Capture every pre-apply definition so later phases can reset to the live pins, and the
  // pre-apply access surface so PHASE 4 can assert the replacement did not WIDEN it.
  // (Absolute grant state is NOT assertable here: a clean-rebuild container legitimately
  // starts from a different ACL than production, where these impls are postgres-only, plus
  // service_role for the field-app impl -- read read-only on 2026-09-04 and asserted by the
  // migration's own postflight against the surface it records in its preflight.)
  const preApplyDefs = Object.fromEntries(FUNCS.map((fn) => [fn, functionDef(fn)]));
  const aclOf = (fn) => scalar(`SELECT coalesce(p.proacl::text, '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`);
  const preApplyAcl = Object.fromEntries(FUNCS.map((fn) => [fn, aclOf(fn)]));

  // ---- PHASE 3: drift refusal is atomic across both bodies -------------------------
  copyMigrationText(candidateSql, 'candidate.sql', workDir);
  const originalDef = preApplyDefs[FUNCS[0]];
  const driftedDef = originalDef.replace('$function$\n', '$function$\n-- drifted out of band\n');
  assert.notEqual(driftedDef, originalDef, 'could not build the drifted body');
  psql(driftedDef);
  const drifted = bodyState();
  assert.notEqual(drifted[FUNCS[0]], pins[FUNCS[0]].live, 'drift did not change the body');
  applyExpectFail('candidate.sql', 'PREFLIGHT_BODY_DRIFT');
  assert.deepEqual(bodyState(), drifted, 'a refused apply must leave every body exactly as it found it');
  psql(originalDef);
  assert.deepEqual(bodyState(), before, 'restoring the original body must reproduce the live pins');
  log('PHASE 3: drifted body refused with PREFLIGHT_BODY_DRIFT; both bodies untouched; original restored');

  // ---- PHASE 4: apply --------------------------------------------------------------
  const applied = apply('candidate.sql');
  const applyOut = `${applied.stdout}\n${applied.stderr}`;
  assert.match(applyOut, /PREFLIGHT_OK/, 'apply did not report PREFLIGHT_OK');
  assert.match(applyOut, /POSTFLIGHT_OK/, 'apply did not report POSTFLIGHT_OK');
  const after = bodyState();
  for (const fn of FUNCS) {
    assert.equal(after[fn], pins[fn].candidate, `${fn} installed md5 ${after[fn]} != candidate pin`);
    assert.equal(scalar(`SELECT position(E'\\r' IN p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`), 'f', `${fn} installed body must be LF`);
    assert.equal(scalar(`SELECT p.prosecdef AND 'search_path=public, pg_temp' = ANY (p.proconfig) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}'`), 't', `${fn} must stay SECURITY DEFINER with the pinned search_path`);
    assert.equal(aclOf(fn), preApplyAcl[fn], `${fn}: CREATE OR REPLACE must leave the access surface exactly as it found it (was ${preApplyAcl[fn]}, now ${aclOf(fn)})`);
  }
  log('PHASE 4: candidate applied; PREFLIGHT_OK + POSTFLIGHT_OK; both bodies at their candidate pins, LF, SECDEF + search_path intact, access surface unchanged');

  // ---- PHASE 5: replay -------------------------------------------------------------
  const replayed = apply('candidate.sql');
  assert.match(`${replayed.stdout}\n${replayed.stderr}`, /POSTFLIGHT_OK/, 'replay did not report POSTFLIGHT_OK');
  assert.deepEqual(bodyState(), after, 'replay must reinstall the identical bodies');
  log('PHASE 5: replay reinstalls the identical bodies');

  // ---- PHASE 6: behaviour after the candidate --------------------------------------
  const afterInvoiceOct = invoiceProbe('AFTER_INVOICE_NEXT_SEASON', DATE_NEXT_SEASON);
  assert.equal(afterInvoiceOct.season, afterInvoiceOct.expected,
    `AFTER the candidate save_invoice must file the season of its own date: ${JSON.stringify(afterInvoiceOct)}`);
  const afterInvoiceSep = invoiceProbe('AFTER_INVOICE_IN_SEASON', DATE_IN_SEASON);
  assert.equal(afterInvoiceSep.season, SEASON_NOW, `${DATE_IN_SEASON} must file under season ${SEASON_NOW}: ${JSON.stringify(afterInvoiceSep)}`);
  const afterInvoiceFallback = invoiceProbe('AFTER_INVOICE_FALLBACK', null);
  assert.equal(afterInvoiceFallback.season, afterInvoiceFallback.expected,
    `AFTER the candidate the no-invoice_date fallback must satisfy season = compute_season(invoice_date): ${JSON.stringify(afterInvoiceFallback)}`);
  log(`PHASE 6a: fixed -- save_invoice files season ${afterInvoiceOct.season} for ${DATE_NEXT_SEASON}, ${afterInvoiceSep.season} for ${DATE_IN_SEASON}, and the no-date fallback stamped ${afterInvoiceFallback.date}/season ${afterInvoiceFallback.season}`);

  const afterFieldOct = fieldAppProbe('AFTER_FIELDAPP_NEXT_SEASON', DATE_NEXT_SEASON);
  assert.equal(afterFieldOct.season, afterFieldOct.expected,
    `AFTER the candidate the field-app save must file the season of its own date: ${JSON.stringify(afterFieldOct)}`);
  assert.equal(afterFieldOct.rate, RATE_NEXT,
    `AFTER the candidate the field-app save must charge the season-${SEASON_NOW + 1} rate ${RATE_NEXT}: ${JSON.stringify(afterFieldOct)}`);
  const afterFieldSep = fieldAppProbe('AFTER_FIELDAPP_IN_SEASON', DATE_IN_SEASON);
  assert.equal(afterFieldSep.season, SEASON_NOW, `${DATE_IN_SEASON} must file under season ${SEASON_NOW}: ${JSON.stringify(afterFieldSep)}`);
  assert.equal(afterFieldSep.rate, RATE_CUR,
    `${DATE_IN_SEASON} must charge the season-${SEASON_NOW} rate ${RATE_CUR}: ${JSON.stringify(afterFieldSep)}`);
  log(`PHASE 6b: fixed -- field-app invoice dated ${DATE_NEXT_SEASON} files season ${afterFieldOct.season} and charges ${afterFieldOct.rate}c/acre; dated ${DATE_IN_SEASON} it files ${afterFieldSep.season} and charges ${afterFieldSep.rate}c/acre. The stamp and the price now move together across the boundary.`);

  // PHASE 6c: the EDIT path. Both reviewers raised this on 2026-09-04 (rls-security-reviewer
  // M3, migration-drift-reviewer H1): the UPDATE branch never writes `season`, so binding the
  // rate lookup to the NEW invoice's season would file a row in one season and price it in
  // another. The shipped file binds the lookup to the season the ROW carries instead.
  const afterEdit = fieldAppEditProbe('AFTER_EDIT_ACROSS_BOUNDARY', DATE_IN_SEASON, DATE_NEXT_SEASON);
  assert.equal(afterEdit.createdSeason, SEASON_NOW, `probe precondition: created at ${DATE_IN_SEASON} the invoice files under ${SEASON_NOW}: ${JSON.stringify(afterEdit)}`);
  assert.equal(afterEdit.date, DATE_NEXT_SEASON, 'the edit must have moved the invoice date across the boundary');
  assert.equal(afterEdit.season, SEASON_NOW, `the edit must NOT re-season an existing invoice: ${JSON.stringify(afterEdit)}`);
  assert.equal(afterEdit.rate, RATE_CUR,
    `the fee must be priced at the season the invoice is FILED under (${afterEdit.season} -> ${RATE_CUR}), not at the new date's season: ${JSON.stringify(afterEdit)}`);
  log(`PHASE 6c: edit path consistent -- moving the date to ${afterEdit.date} left the invoice filed under season ${afterEdit.season} and priced at ${afterEdit.rate}c/acre, the season-${SEASON_NOW} rate. Filed and priced agree.`);
  log(`PHASE 6c ACCEPTED RESIDUAL, observed not inferred: that invoice is now dated ${afterEdit.date} (season ${afterEdit.expectedAfterEdit}) while filed under season ${afterEdit.season}. The two stamps DIVERGE on an edit across the boundary -- the documented price of never re-seasoning an existing record.`);

  // PHASE 6d: the MULTI-GROWER group edit (migration-drift-reviewer H1 round 2). Adding a
  // grower during a cross-boundary edit prices the pre-existing invoices at their stored
  // season and the new one at the invoice date's season, so two growers on the SAME
  // application are billed at different seasons' rates. OBSERVE it, so it is a recorded
  // outcome for Mason to rule on rather than an inference from reading the code.
  const groupEdit = fieldAppGroupEditProbe('AFTER_GROUP_EDIT', DATE_IN_SEASON, DATE_NEXT_SEASON);
  assert.equal(groupEdit.existingSeason, SEASON_NOW, `the pre-existing grower keeps season ${SEASON_NOW}: ${JSON.stringify(groupEdit)}`);
  assert.equal(groupEdit.existingRate, RATE_CUR, `the pre-existing grower is priced at its stored season: ${JSON.stringify(groupEdit)}`);
  assert.equal(groupEdit.addedSeason, SEASON_NOW + 1, `the ADDED grower takes the invoice date's season: ${JSON.stringify(groupEdit)}`);
  assert.equal(groupEdit.addedRate, RATE_NEXT, `the ADDED grower is priced at the invoice date's season: ${JSON.stringify(groupEdit)}`);
  assert.notEqual(groupEdit.existingRate, groupEdit.addedRate, 'this phase exists to record that the two rates DIFFER');
  assert.equal(groupEdit.groupId, groupEdit.addedGroupId, 'both invoices must really be in the same group, or this phase proves nothing');
  log(`PHASE 6d: ACCEPTED CONSEQUENCE, observed -- on one application dated ${DATE_NEXT_SEASON} in ONE invoice group, the pre-existing grower is filed season ${groupEdit.existingSeason} at ${groupEdit.existingRate}c/acre and the newly added grower is filed season ${groupEdit.addedSeason} at ${groupEdit.addedRate}c/acre. Two growers, same application, different rates. OPEN OWNER DECISION.`);

  // PHASE 6e: the silent default-rate fallback (rls-security-reviewer M-A round 2). If no
  // customer_application_rates row exists for the season the invoice is FILED under, the fee
  // falls back to the service default with no warning. Pre-existing behaviour, newly reachable.
  const missingRate = fieldAppEditProbe('AFTER_EDIT_NO_RATE_ROW', DATE_IN_SEASON, DATE_NEXT_SEASON, { seedSeasons: [SEASON_NOW + 1] });
  assert.equal(missingRate.season, SEASON_NOW, 'the edited invoice is still filed under the current season');
  assert.equal(missingRate.rate, RATE_DEFAULT,
    `with no rate row for the filed season the fee must fall back to the service default ${RATE_DEFAULT}: ${JSON.stringify(missingRate)}`);
  log(`PHASE 6e: ACCEPTED CONSEQUENCE, observed -- with a rate row for season ${SEASON_NOW + 1} but NONE for the filed season ${missingRate.season}, the fee silently billed the service default ${missingRate.rate}c/acre instead of a negotiated rate. Pre-existing fallback, newly reachable. OPEN OWNER DECISION.`);

  // ---- PHASE 7: clock wiring, instrumented -----------------------------------------
  // Which clock feeds `season` when the caller supplies no date? The shim makes the
  // season column report the DATE it was handed. This is the exact swap the
  // 2026-09-30 19:00-Chicago window turns on, observable at today's instant.
  const realComputeSeason = functionDef('compute_season');
  // Captured BEFORE the shim is installed. The restoration check below used to compare
  // bodyMd5('compute_season') against a literal copy of bodyMd5's own query -- both operands read
  // the CURRENT body, so it was a tautology that passed even if the shim were still installed
  // (CodeRabbit, 2026-09-04). Pinning the real hash here is what makes the later assertion able
  // to fail: if the shim survived, or realComputeSeason restored something else, it goes red.
  const realComputeSeasonMd5 = bodyMd5('compute_season');
  for (const fn of FUNCS) psql(preApplyDefs[fn]);          // back to the pre-candidate bodies
  assert.deepEqual(bodyState(), before, 'reset to the live pins before the wiring probe');
  psql(SHIM);
  const wiringBefore = wiringProbe('BEFORE_WIRING');
  assert.equal(wiringBefore.encodes, wiringBefore.sessionEnc,
    `BEFORE the candidate the season must follow the SESSION (UTC-side) day: ${JSON.stringify(wiringBefore)}`);
  psql(realComputeSeason);
  apply('candidate.sql');
  assert.deepEqual(bodyState(), after, 'candidate must be reinstalled for the AFTER wiring probe');
  psql(SHIM);
  const wiringAfter = wiringProbe('AFTER_WIRING');
  assert.equal(wiringAfter.encodes, wiringAfter.chicagoEnc,
    `AFTER the candidate the season must follow the CHICAGO business day: ${JSON.stringify(wiringAfter)}`);
  assert.notEqual(wiringAfter.chicagoEnc, wiringAfter.sessionEnc, 'wiring probe precondition: the two days must differ');
  psql(realComputeSeason);
  assert.equal(bodyMd5('compute_season'), realComputeSeasonMd5,
    'compute_season must be byte-identical to its PRE-shim body: every later phase reads season through it, so a surviving shim would silently invalidate PHASE 8');
  log(`PHASE 7: clock wiring proven -- with session day ${wiringBefore.session} vs Chicago day ${wiringBefore.chicago}, season followed the SESSION day before (${wiringBefore.encodes}) and the CHICAGO day after (${wiringAfter.encodes})`);

  // ---- PHASE 8a: mutation -- either site left on the current-season helper -----------
  // Reset to the pre-candidate bodies so the mutants run the fresh-apply arm.
  for (const fn of FUNCS) psql(preApplyDefs[fn]);
  assert.deepEqual(bodyState(), before, 'reset to the live pins before the mutant applies');

  const MUTATIONS = [
    {
      tag: 'stamp',
      fn: '_save_field_app_invoice_impl_20260714',
      from: '        v_season\n      ) RETURNING id, season INTO v_invoice_id, v_invoice_season;\n',
      to: '        current_season()\n      ) RETURNING id, season INTO v_invoice_id, v_invoice_season;\n',
    },
    {
      tag: 'rate-lookup',
      fn: '_save_field_app_invoice_impl_20260714',
      from: '         AND car.season                 = v_invoice_season\n',
      to: '         AND car.season                 = current_season()\n',
    },
  ];
  for (const mutation of MUTATIONS) {
    assert.equal(candidateSql.split(mutation.from).length - 1, 1, `expected exactly one ${mutation.tag} site in the candidate`);
    let mutant = candidateSql.replace(mutation.from, mutation.to);
    // Make the mutant SELF-CONSISTENT: re-pin the body to the mutant's own md5 so the
    // md5 postflight (which would otherwise catch it first) passes, and the
    // season-clock guard is exercised on its own.
    const start = mutant.indexOf(`CREATE OR REPLACE FUNCTION public.${mutation.fn}(`);
    const open = mutant.indexOf('$function$', start) + '$function$'.length;
    const close = mutant.indexOf('$function$', open);
    const mutantMd5 = md5(mutant.slice(open, close));
    assert.notEqual(mutantMd5, pins[mutation.fn].candidate, `${mutation.tag}: mutant body must differ from the candidate body`);
    mutant = mutant.split(pins[mutation.fn].candidate).join(mutantMd5);
    copyMigrationText(mutant, `mutant-${mutation.tag}.sql`, workDir);
    applyExpectFail(`mutant-${mutation.tag}.sql`, 'POSTFLIGHT_SEASON_CLOCK');
    assert.deepEqual(bodyState(), before, `${mutation.tag}: a refused mutant must leave every body at its live pin (nothing installed)`);
    log(`PHASE 8a[${mutation.tag}]: a candidate that leaves this site on the current-season helper aborts in POSTFLIGHT_SEASON_CLOCK with nothing installed`);
  }

  // ---- PHASE 8b: removing one drift pin must make that drift go unrefused -----------
  const pinBlock = new RegExp(`  IF v_row\\.body_md5 <> '${pins[FUNCS[0]].live}' AND v_row\\.body_md5 <> '${pins[FUNCS[0]].candidate}' THEN\\n[^\\n]*\\n  END IF;\\n`);
  assert.match(candidateSql, pinBlock, 'could not locate the drift pin block for the first function');
  const mutantB = candidateSql.replace(pinBlock, '');
  assert.notEqual(mutantB, candidateSql, 'mutant B did not remove the pin block');
  copyMigrationText(mutantB, 'mutant-pin.sql', workDir);
  psql(driftedDef);
  const rB = psql('\\i /tmp/mutant-pin.sql', { allowFailure: true, wrap: wrapByName.get('mutant-pin.sql') ?? false });
  const outB = `${rB.stdout}\n${rB.stderr}`;
  assert.doesNotMatch(outB, /PREFLIGHT_BODY_DRIFT/, 'with the pin removed the drift must NOT be refused by the drift pin');
  // Asserting only that an error token is ABSENT lets ANY unrelated failure false-green
  // this phase. Require the mutant to have actually SUCCEEDED and to have actually
  // overwritten the drifted body -- the positive form of the claim.
  assert.equal(rB.status, 0, `with the pin removed the mutant must APPLY successfully, not fail for an unrelated reason (exit ${rB.status}): ${outB}`);
  assert.match(outB, /POSTFLIGHT_OK/, 'the mutant apply must reach POSTFLIGHT_OK -- otherwise the absent drift token proves nothing');
  assert.equal(bodyMd5(FUNCS[0]), pins[FUNCS[0]].candidate,
    `with the pin removed the DRIFTED body must be overwritten to the candidate pin (that is the damage the pin prevents); got ${bodyMd5(FUNCS[0])}`);
  log("PHASE 8b: with the first function's drift pin removed, its drifted body applies cleanly and is OVERWRITTEN to the candidate pin -- the pin is load-bearing (mutant discarded)");

  // ---- PHASE 8c: mutation -- the access surface must not be allowed to widen ---------
  // The POSTFLIGHT_GRANT check states a NOT-WIDENED claim, so prove it actually catches a
  // widening: a mutant that grants EXECUTE to `authenticated` between the replacement and
  // the postflight must abort, with the grant rolled back along with everything else.
  for (const fn of FUNCS) psql(preApplyDefs[fn]);
  assert.deepEqual(bodyState(), before, 'reset to the live pins before the grant mutant');
  const grantMarker = '\nDO $postflight$';
  assert.equal(candidateSql.split(grantMarker).length - 1, 1, 'expected exactly one postflight block');
  const mutantC = candidateSql.replace(
    grantMarker,
    `\nGRANT EXECUTE ON FUNCTION public.${FUNCS[0]}(jsonb, jsonb, text) TO authenticated;\n${grantMarker}`,
  );
  assert.notEqual(mutantC, candidateSql, 'mutant C did not insert the widening grant');
  copyMigrationText(mutantC, 'mutant-grant.sql', workDir);
  const aclSql = `SELECT coalesce(p.proacl::text, '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${FUNCS[0]}'`;
  const aclBefore = scalar(aclSql);
  applyExpectFail('mutant-grant.sql', 'POSTFLIGHT_GRANT');
  assert.deepEqual(bodyState(), before, 'the grant mutant must leave every body at its live pin (nothing installed)');
  assert.equal(scalar(aclSql), aclBefore, 'the refused grant must have rolled back with the rest of the transaction');
  log('PHASE 8c: a candidate that widens the access surface aborts in POSTFLIGHT_GRANT and the grant rolls back -- the not-widened claim is load-bearing (mutant discarded)');

  // ---- PHASE 8d: mutation -- binding the fee lookup to the NEW-invoice season is a REAL BUG --
  // No postflight guard catches this one: it uses no clock helper, so POSTFLIGHT_SEASON_CLOCK
  // stays quiet and (re-pinned) the md5 guard passes too. It has to be caught BEHAVIOURALLY.
  // This is the exact code both reviewers flagged on 2026-09-04, so prove it really does file a
  // row in one season and price it in another -- and that the shipped binding does not.
  const mutantD = (() => {
    const from = '         AND car.season                 = v_invoice_season\n';
    const to = '         AND car.season                 = v_season\n';
    assert.equal(candidateSql.split(from).length - 1, 1, 'expected exactly one fee-lookup binding in the candidate');
    let m = candidateSql.replace(from, to);
    const fn = '_save_field_app_invoice_impl_20260714';
    const start = m.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    const open = m.indexOf('$function$', start) + '$function$'.length;
    const close = m.indexOf('$function$', open);
    const mMd5 = md5(m.slice(open, close));
    assert.notEqual(mMd5, pins[fn].candidate, 'mutant D body must differ from the candidate body');
    return m.split(pins[fn].candidate).join(mMd5);
  })();
  for (const fn of FUNCS) psql(preApplyDefs[fn]);
  assert.deepEqual(bodyState(), before, 'reset to the live pins before mutant D');
  copyMigrationText(mutantD, 'mutant-lookup.sql', workDir);
  const mdOut = apply('mutant-lookup.sql');
  assert.match(`${mdOut.stdout}\n${mdOut.stderr}`, /POSTFLIGHT_OK/, 'mutant D must APPLY -- no static guard catches it, which is the point of this phase');
  const mutantEdit = fieldAppEditProbe('MUTANT_EDIT_ACROSS_BOUNDARY', DATE_IN_SEASON, DATE_NEXT_SEASON);
  assert.equal(mutantEdit.season, SEASON_NOW, `mutant D: the invoice is still filed under season ${SEASON_NOW}`);
  assert.equal(mutantEdit.rate, RATE_NEXT,
    `mutant D must reproduce the reviewers' defect -- filed under ${SEASON_NOW} but priced at the season-${SEASON_NOW + 1} rate: ${JSON.stringify(mutantEdit)}`);
  assert.notEqual(mutantEdit.rate, afterEdit.rate, 'mutant D must differ from the shipped candidate, or this phase proves nothing');
  log(`PHASE 8d: the reviewers' defect reproduced on purpose -- binding the fee lookup to the NEW-invoice season files the edited invoice under season ${mutantEdit.season} while charging ${mutantEdit.rate}c/acre (the season-${SEASON_NOW + 1} rate). The shipped binding charged ${afterEdit.rate}c. No static guard catches this; only the behavioural check does. (mutant discarded)`);

  // ---- PHASE 8e: mutation -- dropping the UPDATE's read-back is also invisible statically --
  // rls-security-reviewer L-3: nothing proved the `RETURNING season INTO v_invoice_season` on
  // the UPDATE branch is load-bearing. Remove it and the edit path leaves v_invoice_season NULL,
  // so `car.season = NULL` matches nothing and the fee silently bills the service default.
  const mutantE = (() => {
    const from = '      RETURNING season INTO v_invoice_season;\n';
    const to = '      ;\n';
    assert.equal(candidateSql.split(from).length - 1, 1, "expected exactly one UPDATE read-back in the candidate");
    let m = candidateSql.replace(from, to);
    const fn = '_save_field_app_invoice_impl_20260714';
    const start = m.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    const open = m.indexOf('$function$', start) + '$function$'.length;
    const close = m.indexOf('$function$', open);
    const mMd5 = md5(m.slice(open, close));
    assert.notEqual(mMd5, pins[fn].candidate, 'mutant E body must differ from the candidate body');
    return m.split(pins[fn].candidate).join(mMd5);
  })();
  for (const fn of FUNCS) psql(preApplyDefs[fn]);
  assert.deepEqual(bodyState(), before, 'reset to the live pins before mutant E');
  copyMigrationText(mutantE, 'mutant-readback.sql', workDir);
  const meOut = apply('mutant-readback.sql');
  assert.match(`${meOut.stdout}\n${meOut.stderr}`, /POSTFLIGHT_OK/, 'mutant E must APPLY -- no static guard catches it, which is the point');
  const mutantEEdit = fieldAppEditProbe('MUTANT_E_EDIT', DATE_IN_SEASON, DATE_NEXT_SEASON);
  assert.equal(mutantEEdit.rate, RATE_DEFAULT,
    `mutant E must silently bill the service default because v_invoice_season is NULL on the edit path: ${JSON.stringify(mutantEEdit)}`);
  assert.notEqual(mutantEEdit.rate, afterEdit.rate, 'mutant E must differ from the shipped candidate');
  log(`PHASE 8e: dropping the UPDATE read-back applies cleanly and silently bills the service default ${mutantEEdit.rate}c/acre where the shipped code billed ${afterEdit.rate}c -- the read-back is load-bearing (mutant discarded)`);

  // Reset and reinstall the real candidate, so the container ends on the shipped bytes.
  for (const fn of FUNCS) psql(preApplyDefs[fn]);
  apply('candidate.sql');
  assert.deepEqual(bodyState(), after, 'the shipped candidate must reinstall after the mutants');
  assert.deepEqual(bodyState(), after, 'final reinstall of the candidate');

  log('ALL PHASES PASSED');
} catch (error) {
  console.error(`INVOICE_SEASON_PROOF_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
