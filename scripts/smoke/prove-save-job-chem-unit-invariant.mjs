#!/usr/bin/env node
// Isolated, re-runnable proof for the two save_job migrations:
//   20260820115900_pin_save_job_body_before_chem_unit_invariant.sql  (the drift pin)
//   20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql
//
// WHY THIS EXISTS. The first version of this work claimed "eight behaviour tests passed"
// in the changelog with nothing committed to run, so no reviewer could re-run or falsify
// it (compliance review, 2026-08-23). Rows 889/890 register a prover; this one does too.
//
// Runs on PostgreSQL 17 to match production (17.6). Requires Docker. Touches NOTHING
// outside its own throwaway container -- it never connects to Supabase, never reads
// credentials, and makes no network calls beyond pulling the postgres image.
//
//   node scripts/smoke/prove-save-job-chem-unit-invariant.mjs
//
// Exits 0 only if every phase passes, including the two mutation phases, which must FAIL.

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
const PREFLIGHT = join(REPO, "supabase", "migrations",
  "20260820115900_pin_save_job_body_before_chem_unit_invariant.sql");
const HARNESS = join(HERE, "fixtures", "save-job-chem-unit-harness.sql");
const TESTS = join(HERE, "fixtures", "save-job-chem-unit-tests.sql");

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

// --- phase 1: harness ----------------------------------------------------------
copyIn(HARNESS, "/tmp/harness.sql");
let r = psqlFile("/tmp/harness.sql");
if (!r.ok) fail("harness failed to load", r.out);
log("PHASE 1 OK  real-shape schema + the three live helper bodies loaded");

// --- phase 2: a stub with the production ACL, so the postflight is meaningful ----
// On live the function already exists and CREATE OR REPLACE preserves its ACL (PUBLIC
// revoked, authenticated + service_role granted). A fresh CREATE in a bare container
// would instead carry the default PUBLIC EXECUTE, so the postflight would be asserting
// against a shape production does not have. Reproduce the real ACL first.
const STUB = `
CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb,
  p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ BEGIN RETURN NULL; END $stub$;
REVOKE ALL ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO authenticated, service_role;
`;
r = psqlCmd(STUB);
if (!r.ok) fail("could not install the pre-change stub", r.out);
log("PHASE 2 OK  stub installed with production's ACL (PUBLIC revoked)");

// --- phase 3: the preflight pin must DETECT drift -------------------------------
copyIn(PREFLIGHT, "/tmp/preflight.sql");
r = psqlFile("/tmp/preflight.sql");
if (r.ok) fail("the preflight pin ACCEPTED a body that is not the reviewed one", r.out);
if (!/PREFLIGHT_BODY_DRIFT/.test(r.out)) {
  fail("the preflight aborted, but not with PREFLIGHT_BODY_DRIFT", r.out);
}
log("PHASE 3 OK  preflight pin refused an unreviewed body (PREFLIGHT_BODY_DRIFT)");

// --- phase 4: apply the migration; its postflight must pass ---------------------
copyIn(MIGRATION, "/tmp/migration.sql");
r = psqlFile("/tmp/migration.sql");
if (!r.ok) fail("the migration failed to apply (its own postflight may have refused it)", r.out);
log("PHASE 4 OK  migration applied; postflight assertions passed");

// --- phase 5: the preflight must now be a no-op (safely re-runnable) ------------
r = psqlFile("/tmp/preflight.sql");
if (!r.ok) fail("the preflight refused an already-migrated body; it is not re-runnable", r.out);
log("PHASE 5 OK  preflight is a no-op once applied (re-runnable)");

// --- phase 6: behaviour ---------------------------------------------------------
copyIn(TESTS, "/tmp/tests.sql");
r = psqlFile("/tmp/tests.sql");
if (!r.ok) fail("behaviour tests failed", r.out);
for (const t of ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"]) {
  if (!new RegExp(`${t} PASS`).test(r.out)) fail(`${t} did not report PASS`, r.out);
}
log(r.out.split("\n").filter((l) => /PASS/.test(l)).join("\n"));
log("PHASE 6 OK  all 10 behaviour tests passed");

// --- phase 7: mutation. Break each half; the tests MUST go red ------------------
// A test that still passes against a broken guard is not holding the guard up.
const src = readFileSync(MIGRATION, "utf8");
const scratch = mkdtempSync(join(tmpdir(), "crx-mutate-"));

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
    expect: "T1",
  },
  {
    name: "spelled-out denominator rule removed",
    from: " OR v_raw_rate_unit ~ '\\s+per\\s+'",
    to: "",
    expect: "T9",
  },
];

for (const m of MUTANTS) {
  if (!src.includes(m.from)) fail(`mutation "${m.name}" could not find its anchor -- the prover is stale`);
  const mutated = src.replace(m.from, m.to);
  const p = join(scratch, "mutant.sql");
  writeFileSync(p, mutated, "utf8");
  copyIn(p, "/tmp/mutant.sql");

  // Rebuild a clean database so earlier rows do not confuse the row-count assertions.
  psqlCmd("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA auth CASCADE;");
  psqlFile("/tmp/harness.sql");
  psqlCmd(STUB);
  const applied = psqlFile("/tmp/mutant.sql");
  if (!applied.ok) fail(`mutant "${m.name}" would not install`, applied.out);

  const after = psqlFile("/tmp/tests.sql");
  if (after.ok) fail(`MUTATION NOT DETECTED: with "${m.name}", every test still passed. The tests are not load-bearing.`);
  log(`PHASE 7 OK  mutant "${m.name}" turned the suite red (as required)`);
}

// --- restore a clean, unmutated final state and re-prove ------------------------
psqlCmd("DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA auth CASCADE;");
psqlFile("/tmp/harness.sql");
psqlCmd(STUB);
r = psqlFile("/tmp/migration.sql");
if (!r.ok) fail("final clean re-apply failed", r.out);
r = psqlFile("/tmp/tests.sql");
if (!r.ok) fail("final clean run failed", r.out);

cleanup();
log("\nSAVE_JOB_CHEM_UNIT_PROOF_PASS  (PostgreSQL 17; preflight pin, postflight assertions, 10 behaviour tests, 3 mutation phases)");
