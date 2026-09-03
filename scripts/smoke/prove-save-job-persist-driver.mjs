#!/usr/bin/env node
// Isolated, re-runnable proof for
//   supabase/migrations/20260903150000_job_chemicals_persist_driver.sql
// (F06: job_chemicals.driver, written by save_job so a reloaded chemical line knows which
// field the operator typed).
//
// Sibling of prove-save-job-chem-unit-invariant.mjs and built on the same harness: the
// "pre-change" body here is the APPLIED 20260820120000 save_job (the one this migration
// pins), installed from that file, so the pin is checked against the repo rather than
// against a comment.
//
// WHAT IT PROVES, in order:
//   1. the real-shape harness loads;
//   2. the 20260820120000 body installs and hashes to EXACTLY the md5 this migration pins;
//   3. against a DIFFERENT body the migration ABORTS with PREFLIGHT_BODY_DRIFT, the function
//      is byte-for-byte unchanged AND the new column is absent -- the ALTER, the pin and
//      the replacement share one transaction;
//   4. against the pinned body it applies (over a deliberately bad ACL, which it must
//      correct), the column and its CHECK exist, and every postflight passes;
//   5. re-applying reinstalls the identical body (safe to replay);
//   6. the existing T1-T66 behaviour tests still pass against the v3 body, and the new
//      driver tests (D1-D8) pass;
//   7. mutation: each named guard is broken and a NAMED test must go red, or the APPLY
//      itself must abort with the specific postflight assertion written to catch it.
//
// Runs on PostgreSQL 17 to match production (17.6). Requires Docker. Touches NOTHING
// outside its own throwaway container.
//
//   node scripts/smoke/prove-save-job-persist-driver.mjs
//
// Exits 0 only if every phase passes, including the mutation phases, which must FAIL.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const CONTAINER = `crx-prove-save-job-driver-${RUN_ID}`;
const OWNER_LABEL = "crx.prover=save-job-persist-driver";
const IMAGE = "postgres:17";

const MIGRATION = join(REPO, "supabase", "migrations",
  "20260903150000_job_chemicals_persist_driver.sql");
const PRECHANGE_MIGRATION = join(REPO, "supabase", "migrations",
  "20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql");
const HARNESS = join(HERE, "fixtures", "save-job-chem-unit-harness.sql");
const TESTS = join(HERE, "fixtures", "save-job-chem-unit-tests.sql");
const DRIVER_TESTS = join(HERE, "fixtures", "save-job-persist-driver-tests.sql");

const CHEM_TEST_IDS = Array.from({ length: 66 }, (_, i) => `T${i + 1}`);
const DRIVER_TEST_IDS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];

const log = (m) => process.stdout.write(`${m}\n`);
const docker = (args, opts = {}) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", ...opts });

function psqlFile(containerPath) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", containerPath],
    { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}
/** Apply a migration in ONE transaction, as Supabase's apply path does. */
function psqlMigration(containerPath) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1",
     "--single-transaction", "-f", containerPath],
    { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function psqlCmd(sql) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}
/** Without ON_ERROR_STOP, so every test reports (mutation phases only). */
function psqlFileLenient(containerPath) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-f", containerPath],
    { encoding: "utf8" });
  return { out: `${r.stdout || ""}${r.stderr || ""}` };
}
function psqlScalar(sql) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" });
  return { ok: r.status === 0, value: (r.stdout || "").trim(), out: `${r.stdout || ""}${r.stderr || ""}` };
}
function copyIn(localPath, containerPath) {
  docker(["cp", localPath, `${CONTAINER}:${containerPath}`]);
}
function cleanup() {
  try { docker(["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch { /* not running */ }
}
/** Reap STOPPED containers left by a killed earlier run of THIS prover (own label only). */
function reapStale() {
  let ids = "";
  for (const status of ["exited", "dead", "created"]) {
    try {
      ids += docker(["ps", "-aq", "--filter", `label=${OWNER_LABEL}`, "--filter", `status=${status}`]);
    } catch { /* nothing to reap */ }
  }
  for (const id of ids.split("\n").map((x) => x.trim()).filter(Boolean)) {
    try { docker(["rm", "-f", id], { stdio: "ignore" }); } catch { /* already gone */ }
  }
}
function fail(msg, detail) {
  log(`\nFAIL: ${msg}`);
  if (detail) log(detail.trim());
  cleanup();
  process.exit(1);
}

// --- read the migration, and take the pin FROM it -------------------------------
const migrationSrc = readFileSync(MIGRATION, "utf8");
// Two pins live in the preflight: the reviewed STARTING body (20260820120000) and the
// EXACT body this file installs (accepted only for an identical replay). Both are taken
// from the file, never restated here.
const pins = [...migrationSrc.matchAll(/md5\(v_src\)\s*<>\s*'([0-9a-f]{32})'/g)].map((m) => m[1]);
if (pins.length < 2) fail("could not find both preflight md5 pins inside the migration -- the prover is stale");
const PINNED_MD5 = pins[0];
const CAND_MD5 = pins[1];
if (PINNED_MD5 === CAND_MD5) fail("the two preflight pins are identical; the replay arm pins nothing new");
const markerMatch = /position\('([a-z0-9_]+)' IN v_src\)/.exec(migrationSrc);
if (!markerMatch) fail("could not find the body marker the postflight asserts");
const MARKER = markerMatch[1];
if (!migrationSrc.includes(`BODY MARKER: ${MARKER}`)) {
  fail(`the postflight looks for the marker "${MARKER}" but the body does not declare it`);
}
/** md5 of the save_job body a migration TEXT would install (CR stripped, as prosrc stores it). */
function bodyMd5Of(text) {
  const lf = text.replace(/\r/g, "");
  const s = lf.indexOf("CREATE OR REPLACE FUNCTION public.save_job(");
  const o = lf.indexOf("$function$", s) + "$function$".length;
  const c = lf.indexOf("$function$", o);
  return createHash("md5").update(lf.slice(o, c)).digest("hex");
}
if (bodyMd5Of(migrationSrc) !== CAND_MD5) {
  fail(`the migration pins candidate body ${CAND_MD5} but the body it carries hashes to ${bodyMd5Of(migrationSrc)} -- regenerate the pin`);
}
/** The candidate CREATE ... $function$; block, for building a "hotfixed" body in phase 5b. */
const candSrcLf = migrationSrc.replace(/\r/g, "");
const candStart = candSrcLf.indexOf("CREATE OR REPLACE FUNCTION public.save_job(");
const candClose = candSrcLf.indexOf("$function$", candSrcLf.indexOf("$function$", candStart) + 10);
const CANDIDATE_DDL = `${candSrcLf.slice(candStart, candClose + "$function$".length)};`;

// --- reconstruct the PRE-CHANGE body (the applied 20260820120000 save_job) -------------
// prosrc stores exactly the text between the dollar-quote delimiters; the checkout may be
// CRLF while live stores LF, so strip CR (see .gitattributes).
const preSrc = readFileSync(PRECHANGE_MIGRATION, "utf8").replace(/\r/g, "");
const preStart = preSrc.indexOf("CREATE OR REPLACE FUNCTION public.save_job(");
if (preStart === -1) fail("20260820120000 no longer contains the save_job definition");
const preOpen = preSrc.indexOf("$function$", preStart);
const preClose = preSrc.indexOf("$function$", preOpen + "$function$".length);
if (preOpen === -1 || preClose === -1) fail("could not delimit the 20260820120000 save_job body");
const PRECHANGE_DDL = `${preSrc.slice(preStart, preClose + "$function$".length)};`;

const ACL = `
REVOKE ALL ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO authenticated, service_role;
`;
const STUB = `
CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb,
  p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ BEGIN RETURN NULL; END $stub$;
${ACL}`;

// --- preconditions -------------------------------------------------------------
try { docker(["--version"]); }
catch { fail("Docker is not available. This proof needs a throwaway PostgreSQL 17 container."); }

cleanup();
log(`Starting ${IMAGE} (throwaway container ${CONTAINER})...`);
reapStale();
docker(["run", "-d", "--name", CONTAINER, "--label", OWNER_LABEL,
        "-e", "POSTGRES_PASSWORD=proveonly", IMAGE]);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let ready = false;
for (let i = 0; i < 60; i++) {
  const probe = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
  if (probe.status === 0) { ready = true; break; }
  sleep(1000);
}
if (!ready) fail("PostgreSQL never became ready in the container.");

const scratch = mkdtempSync(join(tmpdir(), "crx-prove-save-job-driver-"));
const localPre = join(scratch, "prechange.sql");
writeFileSync(localPre, `${PRECHANGE_DDL}\n${ACL}`, "utf8");

copyIn(HARNESS, "/tmp/harness.sql");
copyIn(TESTS, "/tmp/tests.sql");
copyIn(DRIVER_TESTS, "/tmp/driver-tests.sql");
copyIn(MIGRATION, "/tmp/migration.sql");
copyIn(localPre, "/tmp/prechange.sql");

function rebuild(label) {
  let s = psqlCmd("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA auth CASCADE;");
  if (!s.ok) fail(`${label}: could not drop the schema`, s.out);
  s = psqlFile("/tmp/harness.sql");
  if (!s.ok) fail(`${label}: harness failed to reload`, s.out);
  s = psqlFile("/tmp/prechange.sql");
  if (!s.ok) fail(`${label}: pre-change body failed to reinstall`, s.out);
}

const BODY_FINGERPRINT =
  "SELECT md5(prosrc) || ':' || octet_length(prosrc)::text FROM pg_proc " +
  " WHERE pronamespace = 'public'::regnamespace AND proname = 'save_job' AND pronargs = 6";
const DRIVER_COLUMN_EXISTS =
  "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.job_chemicals'::regclass " +
  " AND attname = 'driver' AND NOT attisdropped)::text";
const DRIVER_CHECK_DEF =
  "SELECT COALESCE(pg_get_constraintdef(c.oid), '') FROM pg_constraint c " +
  " WHERE c.conrelid = 'public.job_chemicals'::regclass AND c.conname = 'job_chemicals_driver_chk'";

// --- phase 1: harness ----------------------------------------------------------
let r = psqlFile("/tmp/harness.sql");
if (!r.ok) fail("harness failed to load", r.out);
log("PHASE 1 OK  real-shape schema + the live helper bodies loaded");

// --- phase 2: the pinned pre-change body ------------------------------------------
r = psqlFile("/tmp/prechange.sql");
if (!r.ok) fail("could not install the 20260820120000 save_job body", r.out);
const got = psqlScalar(
  "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
if (!got.ok) fail("could not read the installed body md5", got.out);
if (got.value !== PINNED_MD5) {
  fail(`PIN MISMATCH: the migration pins ${PINNED_MD5}, but the body recorded in ` +
       `20260820120000 installs as ${got.value}. Either the pin is wrong or that file ` +
       `changed; do not apply this migration until they agree.`);
}
log(`PHASE 2 OK  the pinned md5 (${PINNED_MD5}) reproduces from 20260820120000`);

// --- phase 3: drift is refused, atomically, INCLUDING the ALTER -------------------
r = psqlCmd(STUB);
if (!r.ok) fail("could not install the drift stub", r.out);
const beforeDrift = psqlScalar(BODY_FINGERPRINT);
if (!beforeDrift.ok) fail("could not read the stub body fingerprint", beforeDrift.out);
r = psqlMigration("/tmp/migration.sql");
if (r.ok) fail("the migration APPLIED over a body that is not the reviewed one", r.out);
if (!/PREFLIGHT_BODY_DRIFT/.test(r.out)) fail("the migration aborted, but not with PREFLIGHT_BODY_DRIFT", r.out);
const afterDrift = psqlScalar(BODY_FINGERPRINT);
if (!afterDrift.ok) fail("could not re-read the body fingerprint after the refused apply", afterDrift.out);
if (afterDrift.value !== beforeDrift.value) {
  fail(`NOT ATOMIC: the preflight refused, but the function body changed anyway ` +
       `(${beforeDrift.value} -> ${afterDrift.value}).`);
}
const colAfterDrift = psqlScalar(DRIVER_COLUMN_EXISTS);
if (!colAfterDrift.ok) fail("could not read the column state after the refused apply", colAfterDrift.out);
if (colAfterDrift.value !== "false") {
  fail("NOT ATOMIC: the preflight refused, but job_chemicals.driver was added anyway -- the " +
       "ALTER and the pin are not sharing one transaction.");
}
log("PHASE 3 OK  drift refused (PREFLIGHT_BODY_DRIFT); body untouched and the column was NOT added");

// --- phase 4: apply over the pinned body; bad ACL corrected; column + CHECK present ---
rebuild("phase 4");
r = psqlCmd("GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO anon;");
if (!r.ok) fail("could not stage the bad ACL", r.out);
r = psqlCmd("REVOKE EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM service_role;");
if (!r.ok) fail("could not stage the missing service_role grant", r.out);
r = psqlMigration("/tmp/migration.sql");
if (!r.ok) fail("the migration failed to apply (its own postflight may have refused it)", r.out);
if (!/PREFLIGHT_OK/.test(r.out)) fail("the migration applied without the preflight reporting PREFLIGHT_OK", r.out);
const aclAfter = psqlScalar(
  "SELECT has_function_privilege('anon', p.oid, 'EXECUTE')::text || ',' || " +
  "       has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || ',' || " +
  "       has_function_privilege('service_role', p.oid, 'EXECUTE')::text " +
  "  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace " +
  "   AND p.proname = 'save_job' AND p.pronargs = 6");
if (!aclAfter.ok) fail("could not read the ACL after apply", aclAfter.out);
if (aclAfter.value !== "false,true,true") {
  fail(`the migration did not ESTABLISH the intended ACL (anon=false, authenticated=true, service_role=true); got "${aclAfter.value}".`);
}
const colAfter = psqlScalar(DRIVER_COLUMN_EXISTS);
if (!colAfter.ok || colAfter.value !== "true") fail("job_chemicals.driver is absent after apply", colAfter.out);
const chk = psqlScalar(DRIVER_CHECK_DEF);
if (!chk.ok || !/'rate'/.test(chk.value) || !/'qty'/.test(chk.value)) {
  fail(`job_chemicals_driver_chk is missing or wrong after apply: "${chk.value}"`);
}
const markerAfter = psqlScalar(
  `SELECT (position('${MARKER}' IN prosrc) > 0)::text FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')`);
if (!markerAfter.ok || markerAfter.value !== "true") fail(`the installed body does not carry ${MARKER}`);
const installedMd5 = psqlScalar(
  "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
if (!installedMd5.ok || installedMd5.value !== CAND_MD5) {
  fail(`the installed body hashes to ${installedMd5.value}, not the candidate pin ${CAND_MD5} the file declares`);
}
log(`PHASE 4 OK  applied over a deliberately BAD ACL; ACL corrected; driver column + CHECK present; marker ${MARKER}; installed body = candidate pin ${CAND_MD5}; postflights passed`);

// --- phase 5: re-applying must be safe (identical reinstall) ------------------------
const beforeReplay = psqlScalar(BODY_FINGERPRINT);
r = psqlMigration("/tmp/migration.sql");
if (!r.ok) fail("the migration refused its own already-applied body; it is not replayable", r.out);
const afterReplay = psqlScalar(BODY_FINGERPRINT);
if (!beforeReplay.ok || !afterReplay.ok) fail("could not fingerprint the body around the replay");
if (beforeReplay.value !== afterReplay.value) {
  fail(`a replay changed the installed body (${beforeReplay.value} -> ${afterReplay.value})`);
}
log(`PHASE 5 OK  replay reinstalls the IDENTICAL body via the exact candidate pin; ADD COLUMN IF NOT EXISTS and the guarded CHECK are safe to replay`);

// --- phase 5b: a HOTFIXED body that kept the marker must NOT be overwritten by a replay --
// The gpt-5.6-sol review (2026-09-03, HIGH): keying the replay arm on marker presence would
// let this file, replayed after a later hotfix, silently revert that hotfix on a
// money-mutating RPC. The replay arm therefore pins the exact candidate md5, and this
// phase is what proves it.
const HOTFIXED_DDL = CANDIDATE_DDL.replace(
  "DECLARE\n  v_actor uuid;",
  "DECLARE\n  -- hotfix applied after this migration; the marker below is untouched\n  v_actor uuid;");
if (HOTFIXED_DDL === CANDIDATE_DDL) fail("could not build the hotfixed body -- the DECLARE anchor moved");
const localHot = join(scratch, "hotfixed.sql");
writeFileSync(localHot, `${HOTFIXED_DDL}\n${ACL}`, "utf8");
copyIn(localHot, "/tmp/hotfixed.sql");
r = psqlFile("/tmp/hotfixed.sql");
if (!r.ok) fail("could not install the hotfixed body", r.out);
const hotMarker = psqlScalar(
  `SELECT (position('${MARKER}' IN prosrc) > 0)::text FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')`);
if (!hotMarker.ok || hotMarker.value !== "true") fail("the hotfixed body lost the marker; the phase would prove nothing");
const beforeHotReplay = psqlScalar(BODY_FINGERPRINT);
r = psqlMigration("/tmp/migration.sql");
if (r.ok) fail("REPLAY OVERWROTE A HOTFIX: the migration re-applied over a modified body that merely kept the marker", r.out);
// Two independent rules refuse this shape and either is a correct, atomic refusal: the
// column-drift pin fires first (the column exists while the body is not the candidate), and
// the body pin would fire next. The mutant below has to widen BOTH before a replay overwrites.
if (!/PREFLIGHT_(BODY|COLUMN)_DRIFT/.test(r.out)) fail("the replay over the hotfixed body aborted, but not with a PREFLIGHT_*_DRIFT refusal", r.out);
const afterHotReplay = psqlScalar(BODY_FINGERPRINT);
if (!beforeHotReplay.ok || !afterHotReplay.ok || beforeHotReplay.value !== afterHotReplay.value) {
  fail(`NOT ATOMIC: the hotfixed body changed across the refused replay (${beforeHotReplay.value} -> ${afterHotReplay.value})`);
}
log("PHASE 5b OK  a hotfixed body that kept the v3 marker is REFUSED on replay (PREFLIGHT_BODY_DRIFT) and left untouched");
// Restore the proven state for the behaviour phases.
rebuild("phase 5b restore");
r = psqlMigration("/tmp/migration.sql");
if (!r.ok) fail("could not re-apply after phase 5b", r.out);

// --- phase 6: behaviour -----------------------------------------------------------
r = psqlFile("/tmp/tests.sql");
if (!r.ok) fail("the existing T1-T66 behaviour tests failed against the v3 body", r.out);
for (const t of CHEM_TEST_IDS) {
  if (!new RegExp(`${t} PASS`).test(r.out)) fail(`${t} did not report PASS`, r.out);
}
log(`PHASE 6a OK  all ${CHEM_TEST_IDS.length} existing chemical-invariant tests pass against the v3 body`);
r = psqlFile("/tmp/driver-tests.sql");
if (!r.ok) fail("driver behaviour tests failed", r.out);
for (const t of DRIVER_TEST_IDS) {
  if (!new RegExp(`${t} PASS`).test(r.out)) fail(`${t} did not report PASS`, r.out);
}
log(r.out.split("\n").filter((l) => /PASS/.test(l)).join("\n"));
log(`PHASE 6b OK  all ${DRIVER_TEST_IDS.length} driver tests passed`);

// --- phase 7: mutation ------------------------------------------------------------
const MUTANTS = [
  {
    // The refusal is what keeps a garbage driver from being stored (or, with the CHECK,
    // from surfacing as a raw constraint error instead of a named refusal). D5 asserts the
    // named message, so it goes red when the validation is gone.
    name: "driver validation removed",
    from: "    IF v_driver IS NOT NULL AND v_driver NOT IN ('rate', 'qty') THEN\n",
    to: "    IF false THEN\n",
    expect: "D5",
  },
  {
    // The column is added and named in the INSERT list, but NULL is written: the F06
    // postflight still passes (it checks the column list), so only a behaviour test can
    // catch this. D1 must go red.
    name: "driver never written to the row",
    from: "      NULLIF(v_chem->>'driver', '')\n    );\n",
    to: "      NULL\n    );\n",
    expect: "D1",
  },
  {
    // The whole point of the marker bump. Without it, 20260820120000 could replay over
    // this body unrefused. The F06 postflight must abort the apply.
    name: "v3 body marker missing",
    from: "  -- BODY MARKER: chem_unit_invariant_v3\n",
    to: "  -- BODY MARKER: chem_unit_invariant_vX\n",
    expectApplyAbort: "POSTFLIGHT_F06_MARKER",
  },
  {
    // A stray mention of the OLD token is just as dangerous as a missing new one, because
    // 20260820120000 keys its replay on position() of its own marker text.
    name: "old v2 marker token left in a comment",
    from: "  -- BODY MARKER: chem_unit_invariant_v3\n",
    to: "  -- BODY MARKER: chem_unit_invariant_v3\n  -- (was chem_unit_invariant_v2)\n",
    expectApplyAbort: "POSTFLIGHT_F06_MARKER",
  },
  {
    name: "table CHECK not added",
    from: "    ALTER TABLE public.job_chemicals\n      ADD CONSTRAINT job_chemicals_driver_chk\n      CHECK (driver IS NULL OR driver IN ('rate', 'qty'));\n",
    to: "    NULL;\n",
    expectApplyAbort: "POSTFLIGHT_F06_CHECK",
  },
  {
    // The ALTER, the CHECK and the column COMMENT all come out (each of the latter two
    // would otherwise raise a raw "column does not exist" first), so the first thing to
    // notice the missing column is the preflight assertion written for it.
    name: "column not added",
    edits: [
      { from: "ALTER TABLE public.job_chemicals ADD COLUMN IF NOT EXISTS driver text;\n", to: "" },
      { from: "    ALTER TABLE public.job_chemicals\n      ADD CONSTRAINT job_chemicals_driver_chk\n      CHECK (driver IS NULL OR driver IN ('rate', 'qty'));\n", to: "    NULL;\n" },
      { from: "COMMENT ON COLUMN public.job_chemicals.driver IS\n", to: "COMMENT ON TABLE public.job_chemicals IS\n" },
    ],
    expectApplyAbort: "PREFLIGHT_MISSING_COLUMN",
  },
  {
    // gpt-5.6-sol HIGH (2026-09-03): a pre-existing drifted column must be refused, not
    // silently accepted by ADD COLUMN IF NOT EXISTS. `text NOT NULL DEFAULT 'rate'` would
    // label every legacy row rate-driven. No edit to the file; the DATABASE is drifted.
    name: "pre-existing NOT NULL DEFAULT 'rate' driver column",
    edits: [],
    stage: "ALTER TABLE public.job_chemicals ADD COLUMN driver text NOT NULL DEFAULT 'rate';",
    expectApplyAbort: "PREFLIGHT_COLUMN_DRIFT",
  },
  {
    name: "pre-existing generated driver column",
    edits: [],
    stage: "ALTER TABLE public.job_chemicals ADD COLUMN driver text GENERATED ALWAYS AS ('rate') STORED;",
    expectApplyAbort: "PREFLIGHT_COLUMN_DRIFT",
  },
  {
    name: "pre-existing CHECK of the same name admitting a third value",
    edits: [],
    stage: "ALTER TABLE public.job_chemicals ADD COLUMN driver text; " +
           "ALTER TABLE public.job_chemicals ADD CONSTRAINT job_chemicals_driver_chk CHECK (driver IN ('rate', 'qty', 'total'));",
    expectApplyAbort: "PREFLIGHT_COLUMN_DRIFT",
  },
  {
    // gpt-5.6-sol HIGH (2026-09-03, round 4): an EXACT-shaped pre-existing column whose rows
    // already carry 'rate' would pass a shape check and hand the client false provenance.
    // On a fresh apply (base body installed) the column must be ABSENT, full stop.
    name: "pre-existing exact-shaped driver column carrying a legacy 'rate' value",
    edits: [],
    stage: "ALTER TABLE public.job_chemicals ADD COLUMN driver text; " +
           "ALTER TABLE public.job_chemicals ADD CONSTRAINT job_chemicals_driver_chk CHECK (driver IS NULL OR driver IN ('rate', 'qty')); " +
           "INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, driver) " +
           "VALUES ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-0000-0000-0000-000000000002', 150, 'pt', 1.5, 'pt/ac', 'rate');",
    expectApplyAbort: "PREFLIGHT_COLUMN_DRIFT",
  },
  {
    // Second line of defence: with BOTH preflight column rules removed, the postflight's
    // exact-shape assertion must still refuse a drifted column.
    name: "column-drift preflight removed, drifted column staged",
    edits: [
      { from: `  IF v_body_md5 IS DISTINCT FROM '${CAND_MD5}' AND (v_col OR v_def IS NOT NULL) THEN\n`, to: "  IF false THEN\n" },
      { from: "    IF v_type <> 'text' OR v_notnull OR v_gen <> '' OR v_hasdef THEN\n", to: "    IF false THEN\n" },
    ],
    stage: "ALTER TABLE public.job_chemicals ADD COLUMN driver text NOT NULL DEFAULT 'rate';",
    expectApplyAbort: "POSTFLIGHT_F06_COLUMN",
  },
  {
    // gpt-5.6-sol MEDIUM (2026-09-03, round 4): the binding-column assertion must be armed.
    name: "idempotency binding column missing from the database",
    edits: [],
    stage: "ALTER TABLE public.idempotency_keys DROP COLUMN request_fingerprint;",
    expectApplyAbort: "PREFLIGHT_MISSING_HELPER",
  },
  {
    // Widen the replay arm back to marker presence. The phase-5b oracle must then FAIL:
    // the hotfixed body gets overwritten. That is what shows the exact pin is load-bearing.
    name: "replay arm widened back to marker presence",
    // Both exact-md5 comparisons are widened: the body pin AND the column-drift pin's
    // "is this a replay?" test. Widening only one leaves the other refusing the hotfixed
    // body, which is a strengthening the prover recorded when round 4 added the second rule.
    edits: [
      { from: `     AND md5(v_src) <> '${CAND_MD5}' THEN\n`, to: `     AND position('${MARKER}' IN v_src) = 0 THEN\n` },
      { from: `  IF v_body_md5 IS DISTINCT FROM '${CAND_MD5}' AND (v_col OR v_def IS NOT NULL) THEN\n`,
        to: "  IF false AND (v_col OR v_def IS NOT NULL) THEN\n" },
    ],
    expectReplayOverwrite: true,
  },
  // The security tripwires copied from 20260820120000 must still be armed in this file.
  {
    name: "SECURITY DEFINER downgraded to INVOKER",
    from: "SECURITY DEFINER\nSET search_path TO 'public', 'pg_temp'",
    to: "SECURITY INVOKER\nSET search_path TO 'public', 'pg_temp'",
    expectApplyAbort: "POSTFLIGHT_NOT_SECURITY_DEFINER",
  },
  {
    name: "search_path pin removed",
    from: "SECURITY DEFINER\nSET search_path TO 'public', 'pg_temp'",
    to: "SECURITY DEFINER",
    expectApplyAbort: "POSTFLIGHT_SEARCH_PATH",
  },
  {
    name: "anon left holding EXECUTE",
    from: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM anon;",
    to: "",
    stage: "GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO anon;",
    expectApplyAbort: "POSTFLIGHT_ANON_EXECUTE",
  },
  {
    name: "PUBLIC left holding EXECUTE",
    from: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC;",
    to: "",
    stage: "GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO PUBLIC;",
    expectApplyAbort: "POSTFLIGHT_PUBLIC_EXECUTE",
  },
  {
    name: "service_role grant dropped",
    from: "TO authenticated, service_role;",
    to: "TO authenticated;",
    stage: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM service_role;",
    expectApplyAbort: "POSTFLIGHT_GRANT_LOST",
  },
  {
    name: "function re-owned away from postgres",
    edits: [],
    stage: "ALTER FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) OWNER TO service_role;",
    expectApplyAbort: "POSTFLIGHT_OWNER",
  },
  {
    // The carried-over invariant must still be live in the v3 body: one representative
    // guard from the parent prover, so a copy that silently lost the invariant is caught.
    name: "unit comparison disabled (carried-over invariant)",
    from: "IF v_qty_unit = v_price_unit THEN",
    to: "IF true THEN",
    expect: "T4",
  },
];

for (const m of MUTANTS) {
  const edits = m.edits ?? [{ from: m.from, to: m.to }];
  let mutated = migrationSrc;
  for (const e of edits) {
    if (!mutated.includes(e.from)) {
      fail(`mutation "${m.name}" could not find its anchor -- the prover is stale relative to the migration`);
    }
    const hits = mutated.split(e.from).length - 1;
    if (hits > 1 && !e.all) {
      fail(`mutation "${m.name}" has an AMBIGUOUS anchor: "${e.from.slice(0, 60)}..." occurs ${hits} times.`);
    }
    // Function replacement: SQL regex literals contain `$'`, which String.replace would
    // otherwise treat as a substitution pattern.
    mutated = e.all ? mutated.split(e.from).join(e.to) : mutated.replace(e.from, () => e.to);
  }
  // A mutant that edits the BODY is "as if the author regenerated the file with that
  // change", so its candidate pin is recomputed the way the generator does. Otherwise
  // every body mutant would abort on POSTFLIGHT_F06_BODY and prove nothing about the
  // guard it was written for.
  const mutatedMd5 = bodyMd5Of(mutated);
  if (mutatedMd5 !== CAND_MD5) mutated = mutated.split(CAND_MD5).join(mutatedMd5);
  const p = join(scratch, "mutant.sql");
  writeFileSync(p, mutated, "utf8");
  copyIn(p, "/tmp/mutant.sql");

  rebuild(`mutant "${m.name}"`);
  if (m.stage) {
    const staged = psqlCmd(m.stage);
    if (!staged.ok) fail(`could not stage the precondition for mutant "${m.name}"`, staged.out);
  }
  const applied = psqlMigration("/tmp/mutant.sql");

  if (m.expectReplayOverwrite) {
    if (!applied.ok) fail(`mutant "${m.name}" would not install -- it was never exercised`, applied.out);
    const hot = psqlFile("/tmp/hotfixed.sql");
    if (!hot.ok) fail(`could not install the hotfixed body under mutant "${m.name}"`, hot.out);
    const replay = psqlMigration("/tmp/mutant.sql");
    const bodyNow = psqlScalar(
      "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
    if (!replay.ok || !bodyNow.ok || bodyNow.value !== mutatedMd5) {
      fail(`MUTATION NOT DETECTED: with "${m.name}", the replay over a hotfixed body was still refused ` +
           `(ok=${replay.ok}, body now ${bodyNow.value}). Something other than the exact pin is holding the line, ` +
           `so phase 5b is not proving what it claims.`, replay.out);
    }
    log(`PHASE 7 OK  mutant "${m.name}" let the replay OVERWRITE the hotfixed body -- the exact candidate pin is load-bearing`);
    continue;
  }

  if (m.expectApplyAbort) {
    if (applied.ok) {
      fail(`TRIPWIRE NOT ARMED: with "${m.name}", the migration applied successfully. ` +
           `${m.expectApplyAbort} did not fire, so nothing is checking that property.`, applied.out);
    }
    if (!new RegExp(m.expectApplyAbort).test(applied.out)) {
      fail(`MUTATION MIS-ATTRIBUTED: "${m.name}" aborted the apply, but not with ${m.expectApplyAbort}.`, applied.out);
    }
    log(`PHASE 7 OK  mutant "${m.name}" aborted the apply with ${m.expectApplyAbort} (as required)`);
    continue;
  }

  if (!applied.ok) fail(`mutant "${m.name}" would not install -- it was never exercised`, applied.out);
  const after = psqlFileLenient(m.expect.startsWith("D") ? "/tmp/driver-tests.sql" : "/tmp/tests.sql");
  if (!new RegExp(`${m.expect} FAIL`).test(after.out)) {
    fail(`MUTATION NOT DETECTED BY ITS OWN TEST: with "${m.name}" installed, ${m.expect} did not report FAIL.`, after.out);
  }
  log(`PHASE 7 OK  mutant "${m.name}" turned ${m.expect} red (as required)`);
}

// --- restore a clean, unmutated final state and re-prove --------------------------
rebuild("final");
r = psqlMigration("/tmp/migration.sql");
if (!r.ok) fail("final clean re-apply failed", r.out);
r = psqlFile("/tmp/tests.sql");
if (!r.ok) fail("final clean run of T1-T66 failed", r.out);
r = psqlFile("/tmp/driver-tests.sql");
if (!r.ok) fail("final clean run of D1-D8 failed", r.out);

cleanup();
log(`\nALL PHASES PASSED: pin, atomic drift refusal (body + column), apply, replay, ` +
    `${CHEM_TEST_IDS.length} + ${DRIVER_TEST_IDS.length} behaviour tests, ${MUTANTS.length} mutants.`);
