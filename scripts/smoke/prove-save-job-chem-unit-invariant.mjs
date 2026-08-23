#!/usr/bin/env node
// Isolated, re-runnable proof for
//   supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql
//
// WHY THIS EXISTS. The first version of this work claimed "eight behaviour tests passed"
// in the changelog with nothing committed to run, so no reviewer could re-run or falsify
// it (compliance review, 2026-08-23). Rows 889/890 register a prover; this one does too.
//
// WHAT IT PROVES, in order:
//   1. the harness loads a real-shape schema and the three live unit/money helpers;
//   2. the pre-change body recorded in 20260706080000 hashes to EXACTLY the md5 the
//      migration pins -- so the pin is checked against the repo, not against a comment;
//   3. against a DIFFERENT body the migration ABORTS with PREFLIGHT_BODY_DRIFT and leaves
//      the function BYTE-FOR-BYTE UNCHANGED. This is the atomicity property; the pin used
//      to live in its own migration file, where a committed pin plus a failed replacement
//      left the next run free to overwrite an unvalidated body (Codex P1, round 3);
//   4. against the reviewed body it applies and its postflight assertions pass;
//   5. re-applying it is a no-op, so it is safe to replay;
//   6. fourteen behaviour tests;
//   7. five mutation phases, each of which must turn a NAMED test red. A mutation phase
//      that goes red for any other reason is treated as a failure of this prover.
//
// Runs on PostgreSQL 17 to match production (17.6). Requires Docker. Touches NOTHING
// outside its own throwaway container -- it never connects to Supabase, never reads
// credentials, and makes no network calls beyond pulling the postgres image.
//
//   node scripts/smoke/prove-save-job-chem-unit-invariant.mjs
//
// Exits 0 only if every phase passes, including the mutation phases, which must FAIL.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CONTAINER = "crx-prove-save-job-chem-unit";
const IMAGE = "postgres:17";

const MIGRATION = join(REPO, "supabase", "migrations",
  "20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql");
const PRECHANGE_MIGRATION = join(REPO, "supabase", "migrations",
  "20260706080000_customer_supplied_chemicals.sql");
const HARNESS = join(HERE, "fixtures", "save-job-chem-unit-harness.sql");
const TESTS = join(HERE, "fixtures", "save-job-chem-unit-tests.sql");

const TEST_IDS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10",
                  "T11", "T12", "T13", "T14"];

const log = (m) => process.stdout.write(`${m}\n`);
const docker = (args, opts = {}) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", ...opts });

/** Run a file inside the container. Returns {ok, out}. Never throws. */
function psqlFile(containerPath) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", containerPath],
    { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function psqlCmd(sql) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}
/** Run a file WITHOUT ON_ERROR_STOP, so every test reports instead of the script halting
 * at the first failure. Used only by the mutation phases: with the strict runner, psql
 * stops at whichever test happens to break first, so "the suite went red" could never be
 * attributed to the guard actually under test. Not used for the real phases, where a
 * mid-file error must abort. */
function psqlFileLenient(containerPath) {
  const r = spawnSync("docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-f", containerPath],
    { encoding: "utf8" });
  return { out: `${r.stdout || ""}${r.stderr || ""}` };
}
/** Single value, untabulated -- for reading md5s out of the container. */
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

function fail(msg, detail) {
  log(`\nFAIL: ${msg}`);
  if (detail) log(detail.trim());
  cleanup();
  process.exit(1);
}

// --- read the migration, and take the pin FROM it -------------------------------
// The expected md5 is parsed out of the migration rather than restated here. A prover
// that carries its own copy of the number cannot detect the two drifting apart.
const migrationSrc = readFileSync(MIGRATION, "utf8");
const pinMatch = /md5\(v_src\)\s*<>\s*'([0-9a-f]{32})'/.exec(migrationSrc);
if (!pinMatch) fail("could not find the preflight md5 pin inside the migration -- the prover is stale");
const PINNED_MD5 = pinMatch[1];

const markerMatch = /position\('([a-z0-9_]+)' IN v_src\)/.exec(migrationSrc);
if (!markerMatch) fail("could not find the body marker the preflight keys its no-op on");
const MARKER = markerMatch[1];
if (!migrationSrc.includes(`BODY MARKER: ${MARKER}`)) {
  fail(`the preflight looks for the marker "${MARKER}" but the body does not declare it`);
}

// --- reconstruct the reviewed PRE-CHANGE body from the repo ----------------------
// prosrc stores exactly the text between the dollar-quote delimiters. The source file is
// checked out CRLF on Windows while the live body stores LF, so strip CR before use --
// see .gitattributes. Normalising here is correct precisely because it reproduces what
// the live catalog holds; normalising the LIVE text before comparing would be the bug.
const preSrc = readFileSync(PRECHANGE_MIGRATION, "utf8").replace(/\r/g, "");
const preStart = preSrc.indexOf("CREATE OR REPLACE FUNCTION public.save_job(");
if (preStart === -1) fail("20260706080000 no longer contains the pre-change save_job definition");
const preOpen = preSrc.indexOf("$function$", preStart);
const preClose = preSrc.indexOf("$function$", preOpen + "$function$".length);
if (preOpen === -1 || preClose === -1) fail("could not delimit the pre-change save_job body");
const PRECHANGE_DDL = `${preSrc.slice(preStart, preClose + "$function$".length)};`;

// Production revokes PUBLIC and grants authenticated + service_role. A fresh CREATE in a
// bare container would instead carry the default PUBLIC EXECUTE, so the postflight would
// be asserting against a shape production does not have.
const ACL = `
REVOKE ALL ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO authenticated, service_role;
`;

// A deliberately WRONG body, used only to prove the pin refuses and rolls back.
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
docker(["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=proveonly", IMAGE]);

// Wait for readiness by polling pg_isready rather than sleeping a guessed interval.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let ready = false;
for (let i = 0; i < 60; i++) {
  const probe = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
  if (probe.status === 0) { ready = true; break; }
  sleep(1000);
}
if (!ready) fail("PostgreSQL never became ready in the container.");

const scratch = mkdtempSync(join(tmpdir(), "crx-prove-save-job-"));
const localPre = join(scratch, "prechange.sql");
writeFileSync(localPre, `${PRECHANGE_DDL}\n${ACL}`, "utf8");

copyIn(HARNESS, "/tmp/harness.sql");
copyIn(TESTS, "/tmp/tests.sql");
copyIn(MIGRATION, "/tmp/migration.sql");
copyIn(localPre, "/tmp/prechange.sql");

/** Rebuild a clean database carrying the reviewed pre-change body. Fails loudly. */
function rebuild(label) {
  let s = psqlCmd("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA auth CASCADE;");
  if (!s.ok) fail(`${label}: could not drop the schema`, s.out);
  s = psqlFile("/tmp/harness.sql");
  if (!s.ok) fail(`${label}: harness failed to reload`, s.out);
  s = psqlFile("/tmp/prechange.sql");
  if (!s.ok) fail(`${label}: pre-change body failed to reinstall`, s.out);
}

// --- phase 1: harness ----------------------------------------------------------
let r = psqlFile("/tmp/harness.sql");
if (!r.ok) fail("harness failed to load", r.out);
log("PHASE 1 OK  real-shape schema + the three live helper bodies loaded");

// --- phase 2: the reviewed pre-change body, and the pin checked against it -------
r = psqlFile("/tmp/prechange.sql");
if (!r.ok) fail("could not install the pre-change save_job body from 20260706080000", r.out);

const got = psqlScalar(
  "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
if (!got.ok) fail("could not read the installed body md5", got.out);
if (got.value !== PINNED_MD5) {
  fail(`PIN MISMATCH: the migration pins ${PINNED_MD5}, but the body recorded in ` +
       `20260706080000 installs as ${got.value}. Either the pin is wrong or the ` +
       `pre-change definition changed; do not apply this migration until they agree.`);
}
log(`PHASE 2 OK  the pinned md5 (${PINNED_MD5}) reproduces from 20260706080000`);

// --- phase 3: drift is refused, AND the refusal is atomic ------------------------
r = psqlCmd(STUB);
if (!r.ok) fail("could not install the drift stub", r.out);
const beforeDrift = psqlScalar(
  "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
if (!beforeDrift.ok) fail("could not read the stub body md5", beforeDrift.out);

r = psqlFile("/tmp/migration.sql");
if (r.ok) fail("the migration APPLIED over a body that is not the reviewed one", r.out);
if (!/PREFLIGHT_BODY_DRIFT/.test(r.out)) {
  fail("the migration aborted, but not with PREFLIGHT_BODY_DRIFT", r.out);
}
const afterDrift = psqlScalar(
  "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
if (!afterDrift.ok) fail("could not re-read the body md5 after the refused apply", afterDrift.out);
if (afterDrift.value !== beforeDrift.value) {
  fail(`NOT ATOMIC: the preflight refused, but the function body changed anyway ` +
       `(${beforeDrift.value} -> ${afterDrift.value}). The pin and the replacement are ` +
       `not sharing one transaction, which is the whole reason the pin lives in this file.`);
}
log("PHASE 3 OK  drift refused (PREFLIGHT_BODY_DRIFT) and the live body was left untouched");

// --- phase 4: apply over the reviewed body; the postflight must pass -------------
rebuild("phase 4");
r = psqlFile("/tmp/migration.sql");
if (!r.ok) fail("the migration failed to apply (its own postflight may have refused it)", r.out);
if (!/PREFLIGHT_OK/.test(r.out)) fail("the migration applied without the preflight reporting PREFLIGHT_OK", r.out);
log("PHASE 4 OK  migration applied over the reviewed body; postflight assertions passed");

// --- phase 5: re-applying must be a no-op (safely replayable) --------------------
r = psqlFile("/tmp/migration.sql");
if (!r.ok) fail("the migration refused its own already-applied body; it is not replayable", r.out);
log(`PHASE 5 OK  replay is a no-op via the "${MARKER}" marker`);

// --- phase 6: behaviour ---------------------------------------------------------
r = psqlFile("/tmp/tests.sql");
if (!r.ok) fail("behaviour tests failed", r.out);
for (const t of TEST_IDS) {
  if (!new RegExp(`${t} PASS`).test(r.out)) fail(`${t} did not report PASS`, r.out);
}
log(r.out.split("\n").filter((l) => /PASS/.test(l)).join("\n"));
log(`PHASE 6 OK  all ${TEST_IDS.length} behaviour tests passed`);

// --- phase 7: mutation. Break each guard; a NAMED test must go red ---------------
// Asserting only "the suite went red" is not enough: a mutant that fails to install, or
// that breaks an unrelated test, would score as a detection while the guard under test
// was never exercised. Each mutant therefore names the test that must fail.
const MUTANTS = [
  {
    name: "unit comparison disabled",
    from: "CONTINUE WHEN v_qty_unit = v_price_unit;",
    to: "CONTINUE;",
    expect: "T4",
  },
  {
    name: "caller-supplied cost total restored",
    from: "      v_total_cost_cents,\n",
    to: "      COALESCE((p_job_payload->>'total_cost_cents')::bigint, 0),\n",
    expect: "T6",
  },
  {
    name: "spelled-out and hyphenated denominator rule removed",
    from: " OR v_raw_rate_unit ~ '[\\s-]+per[\\s-]+'",
    to: "",
    expect: "T9",
  },
  {
    // BOTH bounds must come out together. Each one independently closes the NaN path, so
    // removing either alone leaves the other holding and proves nothing -- the earlier
    // single-anchor version of this mutant scored a false detection until the
    // named-test assertion above caught it.
    name: "every finiteness bound on the acreage path removed",
    edits: [
      { from: "AND v_acres > 0 AND v_acres < 'Infinity'::numeric", to: "AND v_acres > 0" },
      { from: "         AND v_carried > '-Infinity'::numeric\n         AND v_carried < 'Infinity'::numeric\n", to: "" },
    ],
    expect: "T11",
  },
  {
    name: "non-finite/negative quantity refusal removed",
    from: "IF NOT (v_qty >= 0 AND v_qty < 'Infinity'::numeric) THEN",
    to: "IF false THEN",
    expect: "T12",
  },
];

for (const m of MUTANTS) {
  // A mutant may need several edits at once: where two independent checks each close the
  // same hole, removing one still leaves the other holding, and the mutant would score a
  // detection it did not earn.
  const edits = m.edits ?? [{ from: m.from, to: m.to }];
  let mutated = migrationSrc;
  for (const e of edits) {
    if (!mutated.includes(e.from)) {
      fail(`mutation "${m.name}" could not find its anchor -- the prover is stale relative to the migration`);
    }
    mutated = mutated.replace(e.from, e.to);
  }
  const p = join(scratch, "mutant.sql");
  writeFileSync(p, mutated, "utf8");
  copyIn(p, "/tmp/mutant.sql");

  rebuild(`mutant "${m.name}"`);
  const applied = psqlFile("/tmp/mutant.sql");
  if (!applied.ok) fail(`mutant "${m.name}" would not install -- it was never exercised`, applied.out);

  const after = psqlFileLenient("/tmp/tests.sql");
  if (!new RegExp(`${m.expect} FAIL`).test(after.out)) {
    fail(`MUTATION NOT DETECTED BY ITS OWN TEST: with "${m.name}" installed, ${m.expect} did ` +
         `not report FAIL. Either that test does not actually hold the guard up, or the ` +
         `mutant never reached it.`, after.out);
  }
  log(`PHASE 7 OK  mutant "${m.name}" turned ${m.expect} red (as required)`);
}

// --- restore a clean, unmutated final state and re-prove ------------------------
rebuild("final");
r = psqlFile("/tmp/migration.sql");
if (!r.ok) fail("final clean re-apply failed", r.out);
r = psqlFile("/tmp/tests.sql");
if (!r.ok) fail("final clean run failed", r.out);

cleanup();
log(`\nSAVE_JOB_CHEM_UNIT_PROOF_PASS  (PostgreSQL 17; md5 pin reproduced from source, ` +
    `atomic drift refusal, postflight assertions, ${TEST_IDS.length} behaviour tests, ` +
    `${MUTANTS.length} mutation phases)`);
