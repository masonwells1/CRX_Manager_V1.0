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
 *   3. the candidate applies, leaves exactly ONE signature installed whose IDENTITY and full
 *      argument declaration -- DEFAULTs included -- are asserted from the catalog, keeps
 *      SECURITY DEFINER + the pinned search_path, and restores live's access surface -- in
 *      particular anon does NOT regain EXECUTE, the regression 20260624030000 had to
 *      correct out of band the last time this function was DROP+CREATEd. A separate probe
 *      calls the installed 5-argument function with only FOUR arguments, because the
 *      deploy-order fallback both docs promise ("the reverse order is safe") rests entirely
 *      on those DEFAULTs and was previously never executed;
 *   4. AFTER the candidate every case in phase 2 AGREES, including the Y-09-30 and Y-10-01
 *      cases on both sides of the boundary, and a reopened invoice whose STORED season
 *      disagrees with its own new invoice_date;
 *   5. re-applying is safe: the preflight takes its REPLAY path, the postflight still runs,
 *      and the single signature, grants and behaviour are unchanged;
 *   6. mutations, each of which MUST be caught -- this is what makes the phase-4 pass mean
 *      something rather than rubber-stamping the same misunderstanding. TEN test the
 *      migration's own apply-time guards by a NAMED abort and THREE test its behaviour
 *      (those three install cleanly; no static guard can see a season-logic regression,
 *      which is precisely why the behavioural probes exist):
 *        2d. a wrong preflight body pin must abort the apply (PREFLIGHT_BODY_DRIFT) so a
 *            live body another lane changed is never silently overwritten;
 *        2e. a function handed to a different owner must abort (PREFLIGHT_OWNER), because
 *            DROP+CREATE re-owns to the applying role and 20260729015706's column revoke on
 *            application_services.cost_per_acre_cents needs this to stay postgres-owned;
 *        5a. a wrong POSTFLIGHT body pin must abort a REPLAY (POSTFLIGHT_BODY). That pin
 *            catches an edited CREATE and a CRLF smudge -- NOT a patched live body, which
 *            it structurally cannot see, because it reads prosrc after the DROP+CREATE;
 *        5b. dropping p_invoice_date from the CREATE must abort at POSTFLIGHT_SIGNATURE.
 *            The ACL statements name the 5-argument signature, so a naive version of this
 *            mutant is refused at the REVOKE -- by a different guard, leaving the check
 *            under test unproven. The ACL signatures are rewritten too, so the check under
 *            test is the only thing left standing;
 *        5c. dropping only "DEFAULT NULL::date" must abort at POSTFLIGHT_ARGUMENT_DEFAULTS.
 *            Types are unchanged, so 5b's check passes and the body md5 is untouched -- this
 *            is the one guard that can see it, and it is what keeps the deploy-order fallback
 *            real rather than asserted;
 *        5d. a live 5-argument body patched by another lane, then re-applied, must abort at
 *            PREFLIGHT_REPLAY_BODY_DRIFT and LEAVE THE PATCH IN PLACE. This is the scenario
 *            5a's comment used to claim -- wrongly -- that the postflight covered;
 *        5e. neutering the 5-argument DROP must abort at POSTFLIGHT_OVERLOAD with the
 *            transaction rolled back to one signature;
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
 *            apply; 6d is what proves the REVOKE itself is what closes the grant;
 *        6e. deleting the whole REVOKE/GRANT block -- the fail-open case, which 6c does not
 *            cover because it only drops the anon line. Measured outcome: proacl comes back
 *            NON-null with an explicit PUBLIC entry (Supabase's ALTER DEFAULT PRIVILEGES
 *            materialises it on every fresh CREATE), so POSTFLIGHT_GRANT_PUBLIC is what
 *            refuses it and POSTFLIGHT_ACL_DEFAULT is unreachable on this project. The
 *            migration says so at that check rather than claiming coverage it does not have;
 *        6f. granting EXECUTE to a role outside the reviewed set must abort at
 *            POSTFLIGHT_GRANT_UNEXPECTED and name the offending grantee. Without it the file
 *            would only ever assert "anon and PUBLIC absent, authenticated and service_role
 *            present", which a third grantee satisfies.
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
// The migration that last emitted the 4-argument preview body live still runs.
const PREVIEW_PREDECESSOR_SOURCE = path.join(MIGRATIONS, '20260630180000_field_app_pricing_unit_fix.sql');
const LIVE_BODIES = path.join(ROOT, 'scripts', 'smoke', 'fixtures', 'invoice-date-fallbacks-live-bodies-20260903.sql');
// Same documented stop marker as the save-side prover: 20260817120000's precondition pins a
// legacy body whose baseline line endings differ from live.
const REPLAY_STOP_BEFORE = '20260817120000_carry_allocated_line_cents_through_lifecycle.sql';
const PREVIEW = 'preview_field_app_invoice_split';
// Read read-only from live on 2026-09-06:
//   SELECT md5(p.prosrc) ... WHERE p.proname = 'preview_field_app_invoice_split'
const LIVE_PREVIEW_BODY_MD5 = 'ca33fb973d86dbf3a2788dc11fbc49a5';
// The body this file installs. Both the migration's replay preflight and its postflight pin it.
const CANDIDATE_BODY_MD5 = '83f6600412ced085d0876a3c7339ff12';
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

// The CREATE statement on its own, so it can be re-emitted as CREATE OR REPLACE. Two phases need
// this: PHASE 5d simulates another lane patching the live body, and several phases have to put the
// reviewed body back afterwards -- which the candidate file itself can no longer do, because its
// replay preflight (correctly) refuses to apply over a body that does not match its pin.
// Boundaries are asserted rather than assumed: a silent mis-slice would make those phases vacuous.
const realCreate = (() => {
  const start = candidateSql.indexOf('CREATE FUNCTION public.');
  const open = candidateSql.indexOf('$function$', start);
  const close = candidateSql.indexOf('$function$', open + '$function$'.length);
  assert.ok(start > 0 && open > start && close > open, 'could not isolate the CREATE statement');
  assert.equal(candidateSql.indexOf('CREATE FUNCTION public.', start + 1), -1, 'the file must contain exactly one CREATE FUNCTION');
  const statement = `${candidateSql.slice(start, close + '$function$'.length)};`;
  // Round-trip the slice rather than counting markers across the file: the postflight's comments
  // mention the $function$ markers in prose, so a whole-file count is not a count of delimiters.
  // What actually matters is that this slice is the complete CREATE and carries the exact body the
  // md5 pins cover -- assert that directly.
  assert.ok(statement.endsWith('$function$;'), 'the isolated CREATE must end at the closing dollar quote');
  assert.equal(statement.split(candidateBody).length, 2, 'the isolated CREATE must contain the pinned body exactly once');
  return statement;
})();
const asReplace = (sql) => {
  const replaced = sql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  assert.notEqual(replaced, sql, 'the CREATE could not be rewritten as CREATE OR REPLACE');
  return replaced;
};
// A one-line addition that changes md5(prosrc) and nothing an operator would notice. It stands in
// for "another lane patched this function after the migration was applied".
const patchAsOtherLane = asReplace(realCreate).replace('DECLARE', 'DECLARE\n  crx_replay_patch_probe int := 1;');
assert.ok(patchAsOtherLane.includes('crx_replay_patch_probe'), 'the simulated other-lane patch must actually change the body');

// The 4-argument predecessor, lifted verbatim from the migration that last emitted it. PHASE 5e
// needs to put the container back on the single 4-argument signature, and it must be the REAL
// body: the candidate's own preflight pins md5(prosrc) to ca33fb..., so a reconstructed
// approximation would be refused and the phase would abort on the wrong guard.
const predecessorCreate = (() => {
  const sql = readFileSync(PREVIEW_PREDECESSOR_SOURCE, 'utf8');
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${PREVIEW}(p_locations jsonb`);
  const open = sql.indexOf('$function$', start);
  const close = sql.indexOf('$function$', open + '$function$'.length);
  assert.ok(start > 0 && open > start && close > open, 'could not isolate the 4-argument predecessor');
  const statement = `${sql.slice(start, close + '$function$'.length)};`;
  assert.ok(statement.includes('p_invoice_id uuid DEFAULT NULL::uuid)'), 'the predecessor must be the 4-argument shape');
  assert.equal(statement.includes('p_invoice_date'), false, 'the predecessor must not carry the new parameter');
  return statement;
})();

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
// Put the reviewed body back after a mutant or a simulated patch left something else installed.
// The candidate file cannot do this itself: its replay preflight refuses to apply over a body that
// does not match its pin, which is exactly the protection PHASE 5d proves.
function restoreReviewedBody() {
  psql('\\i /tmp/restore-body.sql', { wrap: true });
  assert.equal(previewBodyMd5(), CANDIDATE_BODY_MD5, "restoring the reviewed body must reinstate this file's pin");
}

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
  copyText(asReplace(realCreate), 'restore-body.sql', workDir);

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

  // PHASE 4d: the deploy-order fallback, EXECUTED rather than asserted. This file's header, the
  // changelog and migration-history all promise that applying the migration before the frontend
  // ships is safe because "an already-deployed 4-argument caller still resolves through the
  // DEFAULT". Every other probe here passes five arguments, so that promise had never actually
  // been run. Call the installed 5-argument function with exactly FOUR named arguments -- the
  // shape the currently-deployed frontend sends -- and require it to resolve and price correctly.
  // Dated in-season so the Chicago fallback and the invoice date land in the same season, which is
  // what makes agreement the right expectation rather than a coincidence.
  const fourArgCaller = parityProbe('AFTER_FOUR_ARGUMENT_CALLER', { mode: 'new', invoiceDate: DATE_IN_SEASON, withDate: false });
  assertAgrees(fourArgCaller);
  assert.equal(fourArgCaller.previewRate, RATE_CUR,
    `a 4-argument caller must still resolve through the DEFAULTs and price at ${RATE_CUR}: ${JSON.stringify(fourArgCaller)}`);
  log(`PHASE 4d: the deploy-order fallback is real -- a 4-argument caller resolves against the 5-argument function and quotes ${fourArgCaller.previewRate}c/acre`);

  // ---- PHASE 5: re-apply is safe ----------------------------------------------------
  const replayOut = said(apply('candidate.sql'));
  assert.match(replayOut, /this apply is a replay/, 'the second apply must take the preflight replay path');
  assert.match(replayOut, /POSTFLIGHT_OK/, 'the replay must still be checked by the postflight');
  assert.equal(previewSignatures(), afterSignatures, 're-applying must leave exactly the same single signature');
  assert.equal(previewGrants(), startGrants, 're-applying must leave the same grants');
  assertAgrees(parityProbe('REAPPLY_NEW_NEXT_SEASON', { mode: 'new', invoiceDate: DATE_NEXT_SEASON, withDate: true }));
  log('PHASE 5: re-apply is safe -- replay path taken, postflight still ran, same signature, grants and behaviour');

  // PHASE 5a: the postflight body pin. Be precise about what it protects, because an earlier
  // revision of this comment claimed it guarded the replay path and it structurally cannot: the
  // postflight reads prosrc AFTER the DROP+CREATE, so it always sees this file's own body. What it
  // does catch is a CREATE body edited without updating the constant, and a CRLF smudge -- which
  // PREFLIGHT_BODY_DRIFT cannot see, because that one hashes the LIVE body. The patched-live-body
  // case is PHASE 5d, against PREFLIGHT_REPLAY_BODY_DRIFT.
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
    .replaceAll(`ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid, date)`, `ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid)`),
  { mustFail: true });
  assert.match(said(abortedSig), /POSTFLIGHT_SIGNATURE/, 'dropping the new parameter must be refused by the postflight signature check, by name');
  assert.equal(previewSignatures(), afterSignatures, 'the refused apply must leave the 5-argument signature installed');
  log('PHASE 5b: the postflight signature check is load-bearing -- dropping p_invoice_date aborts the apply and changes nothing');

  // PHASE 5c: the DEFAULTs. Drop ONLY "DEFAULT NULL::date" and nothing else -- the types are
  // unchanged, so POSTFLIGHT_SIGNATURE passes; the body is untouched, so both md5 pins pass. The
  // installed function now demands all five arguments, so every already-deployed 4-argument caller
  // breaks with PGRST202 and the deploy-order fallback this file's header promises is gone. Only
  // POSTFLIGHT_ARGUMENT_DEFAULTS can see this, so assert it by name.
  // Dropping ONLY the last DEFAULT is not a possible edit: PostgreSQL itself refuses it with
  // "input parameters after one with a default value must also have defaults". So the mutant drops
  // all three DEFAULTs, which is the edit that IS possible and is the one that makes every argument
  // mandatory. Types and names are untouched, so POSTFLIGHT_SIGNATURE passes and the body md5 is
  // unchanged -- POSTFLIGHT_ARGUMENT_DEFAULTS is the only check that can see it.
  const CREATE_LINE = candidateSql.slice(candidateSql.indexOf('CREATE FUNCTION public.'), candidateSql.indexOf('\n', candidateSql.indexOf('CREATE FUNCTION public.')));
  assert.equal(CREATE_LINE.split(' DEFAULT NULL::').length, 4, 'the CREATE line must carry exactly three DEFAULTs');
  const abortedDefaults = applyMutant('drops-every-default',
    (sql) => sql.replace(CREATE_LINE, CREATE_LINE.replaceAll(' DEFAULT NULL::uuid', '').replaceAll(' DEFAULT NULL::date', '')), { mustFail: true });
  assert.match(said(abortedDefaults), /POSTFLIGHT_ARGUMENT_DEFAULTS/, 'dropping the DEFAULT must be refused by the argument-declaration check, by name');
  assert.doesNotMatch(said(abortedDefaults), /POSTFLIGHT_SIGNATURE/, 'the signature check must NOT be what caught it, or the defaults check is untested');
  assert.equal(previewSignatures(), afterSignatures, 'the refused apply must leave the 5-argument signature installed');
  log('PHASE 5c: the argument-declaration check is load-bearing -- dropping the DEFAULT aborts at POSTFLIGHT_ARGUMENT_DEFAULTS, not at the signature check');

  // PHASE 5d: the replay body pin -- the finding that made this phase necessary. Simulate another
  // lane patching the live 5-argument body (CREATE OR REPLACE, one changed line), then re-apply
  // this file. Without PREFLIGHT_REPLAY_BODY_DRIFT the preflight returns early on the replay path,
  // the DROP destroys the patch, the CREATE reinstalls this file's body, and the postflight
  // cheerfully reports POSTFLIGHT_OK -- a silent revert of somebody else's fix. The apply must
  // refuse, AND the patch must still be there afterwards; the second assertion is the one that
  // proves nothing was destroyed before the refusal.
  copyText(patchAsOtherLane, 'patched-body.sql', workDir);
  psql('\\i /tmp/patched-body.sql', { wrap: true });
  const patchedMd5 = previewBodyMd5();
  assert.notEqual(patchedMd5, CANDIDATE_BODY_MD5, 'precondition: the simulated other-lane patch must change the installed body md5');
  assert.equal(previewSignatures(), afterSignatures, 'precondition: the patch must leave the signature alone, so only the BODY differs');

  // No mutation: the real, unmodified file is re-applied. That is exactly the scenario -- a retried
  // apply of a correct file over a body somebody else changed.
  const abortedReplayDrift = psql('\\i /tmp/candidate.sql', { wrap: true, allowFailure: true });
  assert.notEqual(abortedReplayDrift.status, 0, 'replaying over a patched body must ABORT and did not');
  assert.match(said(abortedReplayDrift), /PREFLIGHT_REPLAY_BODY_DRIFT/, 'replaying over a patched 5-argument body must abort at the replay body pin, by name');
  assert.equal(previewBodyMd5(), patchedMd5, "the refused replay must LEAVE THE OTHER LANE'S PATCH IN PLACE -- that is the whole point of the check");

  // Restore. The candidate itself can no longer be applied over the patch (by design), so put the
  // reviewed body back the same way the other lane put its patch in.
  restoreReviewedBody();
  log('PHASE 5d: the replay body pin is load-bearing -- a patched live body aborts the replay at PREFLIGHT_REPLAY_BODY_DRIFT and SURVIVES it');

  // PHASE 5e: POSTFLIGHT_OVERLOAD. Reaching it takes care, and the two ways that DON'T work are
  // worth recording, because each looks like a pass and proves nothing:
  //   - neutering the 5-argument DROP on a replay makes the CREATE collide with the installed
  //     function, and PostgreSQL refuses it first with "already exists with same argument types";
  //   - leaving a second overload in place BEFORE the apply is caught by PREFLIGHT_OVERLOAD.
  // The one state that actually exercises the postflight's count is: start from the single
  // 4-argument predecessor, and neuter the 4-argument DROP. The preflight then sees exactly one
  // overload and passes, the CREATE adds a second, and only the postflight can notice. Two
  // overloads make every PostgREST call ambiguous (PGRST203), so it must abort and roll back.
  copyText(predecessorCreate, 'predecessor-preview.sql', workDir);
  psql('\\i /tmp/predecessor-preview.sql', { wrap: true });
  psql(`DROP FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid, date);
        REVOKE ALL ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid) TO authenticated, service_role;`, { wrap: true });
  assert.equal(previewSignatures(), startSignatures, 'precondition: the container must be back on the single 4-argument predecessor');
  assert.equal(previewBodyMd5(), LIVE_PREVIEW_BODY_MD5, "precondition: the restored predecessor must be live's body, or the candidate's own preflight would refuse it");

  const DROP_FOUR = `DROP FUNCTION IF EXISTS public.${PREVIEW}(jsonb, jsonb, uuid, uuid);`;
  assert.equal(candidateSql.split(DROP_FOUR).length, 2, 'the 4-argument DROP must appear exactly once');
  const abortedOverload = applyMutant('keeps-the-old-overload',
    (sql) => sql.replace(DROP_FOUR, `-- ${DROP_FOUR}`), { mustFail: true });
  assert.match(said(abortedOverload), /POSTFLIGHT_OVERLOAD/, 'leaving a second overload installed must abort at the overload check, by name');
  assert.equal(previewSignatures(), startSignatures, 'the refused apply must roll back to exactly the one predecessor signature');

  apply('candidate.sql');
  assert.equal(previewSignatures(), afterSignatures, 'the real candidate must reinstate exactly one 5-argument signature');
  assert.equal(previewGrants(), startGrants, "the real candidate must reinstate live's access surface");
  log('PHASE 5e: the overload check is load-bearing -- a surviving second signature aborts at POSTFLIGHT_OVERLOAD and rolls back');

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
  // Every mutant below is applied over the REVIEWED body, never over the previous mutant's. The
  // preflight's replay pin would otherwise abort the second and later mutants at
  // PREFLIGHT_REPLAY_BODY_DRIFT -- an abort, so the phase would still "fail as required", but by
  // the wrong guard, leaving the guard actually under test unexercised. Restoring first keeps each
  // assertion about the check it names.

  // 6a: the fix removed. Takes the date, ignores it, still reads the clock.
  applyMutant('clock', (sql) => withoutBodyPin(sql).replace('         AND car.season = v_price_season LIMIT 1;', '         AND car.season = current_season() LIMIT 1;'));
  const mutantClockNew = parityProbe('MUTANT_CLOCK_NEW_NEXT_SEASON', { mode: 'new', invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assertDisagrees(mutantClockNew);
  const mutantClockReopen = parityProbe('MUTANT_CLOCK_REOPEN', { mode: 'reopen', createDate: DATE_NEXT_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assertDisagrees(mutantClockReopen);
  log(`PHASE 6a: mutant CAUGHT -- with the fix removed, the new-invoice window is back to ${mutantClockNew.previewRate} vs ${mutantClockNew.savedRate} and the reopen window to ${mutantClockReopen.previewRate} vs ${mutantClockReopen.savedRate}`);

  // 6b: recomputes the season from the date every time and never reads the stored season.
  restoreReviewedBody();
  applyMutant('ignores-stored-season', (sql) => withoutBodyPin(sql).replace('      v_price_season := COALESCE(v_row_season, v_new_season);', '      v_price_season := v_new_season;'));
  const mutantStored = parityProbe('MUTANT_STORED_SEASON_CROSS_EDIT', { mode: 'reopen', createDate: DATE_IN_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true });
  assertDisagrees(mutantStored);
  assert.equal(mutantStored.previewRate, RATE_NEXT, `the mutant should quote the date's season: ${JSON.stringify(mutantStored)}`);
  assert.equal(mutantStored.savedRate, RATE_CUR, `save should still charge the stored season: ${JSON.stringify(mutantStored)}`);
  log(`PHASE 6b: mutant CAUGHT -- ignoring the row's stored season re-breaks the edited-across-the-boundary case (${mutantStored.previewRate} vs ${mutantStored.savedRate})`);

  // Restore the real candidate so the last mutation starts from a correct body.
  restoreReviewedBody();
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
  // BOTH postflight checks that can see an anon grant have to go, not just the named one: the
  // catch-all POSTFLIGHT_GRANT_UNEXPECTED also refuses anon, since anon is outside the reviewed
  // set. Leaving it in would abort the apply and this phase would prove the opposite of what it is
  // for -- it needs the grant to actually LAND so the leak can be observed empirically.
  applyMutant('no-anon-revoke-no-check', (sql) => sql
    .replace(anonRevoke, '')
    .replace('  IF v_has_anon THEN', '  IF false THEN')
    .replace('  IF v_extra IS NOT NULL THEN', '  IF false THEN'));
  const leakedGrants = previewGrants();
  assert.match(leakedGrants, /anon=true/, `dropping the anon REVOKE should leave anon executable, got ${leakedGrants}`);
  assert.notEqual(leakedGrants, startGrants, 'the anon REVOKE must be load-bearing');
  log(`PHASE 6d: mutant CAUGHT -- with both the REVOKE and its postflight check removed the grants become ${leakedGrants} instead of ${startGrants}`);

  apply('candidate.sql');
  assert.equal(previewGrants(), startGrants, 'the real candidate must close the anon grant the mutant opened');

  // 6e: the whole REVOKE/GRANT block deleted -- the FAIL-OPEN case, and not the same as 6c, which
  // only drops the anon line.
  //
  // Measured, not assumed: on THIS project the result is a non-NULL proacl that explicitly carries
  // PUBLIC=X, because Supabase's ALTER DEFAULT PRIVILEGES fires on every fresh CREATE and
  // materialises the ACL. So POSTFLIGHT_ACL_DEFAULT (which refuses a NULL proacl) is unreachable
  // here, and POSTFLIGHT_GRANT_PUBLIC is what actually closes this case. Assert the check that
  // genuinely fires; asserting the other one would have been a mutant that "passed" against a
  // guard doing no work. POSTFLIGHT_ACL_DEFAULT stays in the file as the correct check for a
  // database without those default privileges, but it is NOT claimed as mutation-proven.
  const aclBlockStart = candidateSql.indexOf(`REVOKE ALL ON FUNCTION public.${PREVIEW}`);
  const aclBlockEnd = candidateSql.indexOf('\n', candidateSql.indexOf('TO authenticated, service_role;', aclBlockStart));
  assert.ok(aclBlockStart > 0 && aclBlockEnd > aclBlockStart, 'could not isolate the REVOKE/GRANT block');
  const aclBlock = candidateSql.slice(aclBlockStart, aclBlockEnd);
  assert.ok(aclBlock.includes('FROM PUBLIC') && aclBlock.includes('FROM anon') && aclBlock.includes('TO authenticated'),
    'the isolated block must contain all three ACL statements, or this mutant tests less than it claims');
  const abortedAclDefault = applyMutant('no-acl-statements-at-all',
    (sql) => sql.replace(aclBlock, ''), { mustFail: true });
  assert.match(said(abortedAclDefault), /POSTFLIGHT_GRANT_PUBLIC/, 'deleting every ACL statement must be refused because PUBLIC regains EXECUTE, by name');
  assert.equal(previewGrants(), startGrants, 'the aborted apply must roll back completely');
  assert.equal(publicHasExecute(), 'false', 'PUBLIC must not hold EXECUTE after the rollback');
  log('PHASE 6e: mutant CAUGHT AND BLOCKED -- deleting every ACL statement hands PUBLIC EXECUTE and aborts at POSTFLIGHT_GRANT_PUBLIC');

  // 6f: EXECUTE granted to a role outside the reviewed set. 6c and 6d only ever ask about anon and
  // PUBLIC, so without this the file would be asserting "these two are absent and those two are
  // present" while a third grantee -- a future reporting or read-only role -- passed unremarked.
  // POSTFLIGHT_GRANT_UNEXPECTED is deliberately the LAST check in the block, so this also confirms
  // it did not shadow POSTFLIGHT_GRANT_ANON on the way past (6c above still aborts by its own name).
  const grantLine = `GRANT EXECUTE ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid, date) TO authenticated, service_role;`;
  assert.equal(candidateSql.split(grantLine).length, 2, 'the GRANT must appear exactly once');
  psql('CREATE ROLE preview_grant_probe;', { wrap: true });
  const abortedExtraGrant = applyMutant('grants-a-third-role',
    (sql) => sql.replace(grantLine, `${grantLine}\nGRANT EXECUTE ON FUNCTION public.${PREVIEW}(jsonb, jsonb, uuid, uuid, date) TO preview_grant_probe;`),
    { mustFail: true });
  assert.match(said(abortedExtraGrant), /POSTFLIGHT_GRANT_UNEXPECTED/, 'a grantee outside the reviewed set must be refused by name');
  assert.match(said(abortedExtraGrant), /preview_grant_probe/, 'the refusal must name the unexpected grantee, so an operator can act on it');
  assert.equal(previewGrants(), startGrants, 'the aborted apply must roll back completely');
  log('PHASE 6f: mutant CAUGHT AND BLOCKED -- granting EXECUTE to a third role aborts at POSTFLIGHT_GRANT_UNEXPECTED');

  // Leave the container on the real candidate.
  apply('candidate.sql');
  assert.equal(previewGrants(), startGrants, 'the real candidate must leave live\'s access surface');
  assert.equal(previewOwner(), 'postgres', 'the real candidate must leave the function postgres-owned');
  assert.equal(previewSignatures(), afterSignatures, 'the real candidate must leave exactly one signature');
  assertAgrees(parityProbe('FINAL_CROSS_EDIT', { mode: 'reopen', createDate: DATE_IN_SEASON, invoiceDate: DATE_NEXT_SEASON, withDate: true }));
  log('PHASE 7: real candidate reinstalled over the mutants -- owner, grants, signature and behaviour back to live posture');

  log('\nPREVIEW_SEASON_PROOF_PASS all phases, including all thirteen mutation phases -- ten refused by a named abort, three caught behaviourally -- behaved as required');
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
