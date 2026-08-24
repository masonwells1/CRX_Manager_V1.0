#!/usr/bin/env node
// Isolated, re-runnable proof for
//   supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql
//
// WHY THIS EXISTS. The first version of this work claimed "eight behaviour tests passed"
// in the changelog with nothing committed to run, so no reviewer could re-run or falsify
// it (compliance review, 2026-08-23). Rows 889/890 register a prover; this one does too.
//
// WHAT IT PROVES, in order:
//   1. the harness loads a real-shape schema and the four live unit/money/idempotency helpers;
//   2. the pre-change body recorded in 20260706080000 hashes to EXACTLY the md5 the
//      migration pins -- so the pin is checked against the repo, not against a comment;
//   3. against a DIFFERENT body the migration ABORTS with PREFLIGHT_BODY_DRIFT and leaves
//      the function BYTE-FOR-BYTE UNCHANGED. This is the atomicity property; the pin used
//      to live in its own migration file, where a committed pin plus a failed replacement
//      left the next run free to overwrite an unvalidated body (Codex P1, round 3);
//   4. against the reviewed body it applies and its postflight assertions pass;
//   5. re-applying it is a no-op, so it is safe to replay;
//   6. the behaviour tests in fixtures/save-job-chem-unit-tests.sql (count printed at the end);
//   7. mutation phases in TWO shapes, because two different kinds of guard live in this
//      file. Most mutants must let the migration install and then turn a NAMED behaviour
//      test red; a mutant that goes red for any OTHER reason is treated as a failure of
//      this prover, not as a detection. The security mutants must instead make the APPLY
//      ITSELF abort, with the specific postflight assertion written to catch them -- those
//      assertions cannot fail against a correct file, so a behaviour test could never
//      exercise them. The exact counts are derived from the arrays below and printed in the
//      final line rather than restated here, because every earlier version of this comment
//      went stale within a round.
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
                  "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19",
                  "T20", "T21", "T22", "T23", "T24", "T25", "T26", "T27", "T28", "T29", "T30"];

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
// md5 AND exact octet length. "byte-for-byte unchanged" is a strong claim, and an md5 on
// its own does not support it; pairing it with the length is what makes the wording honest
// (compliance review, round 3).
const BODY_FINGERPRINT =
  "SELECT md5(prosrc) || ':' || octet_length(prosrc)::text FROM pg_proc " +
  " WHERE pronamespace = 'public'::regnamespace AND proname = 'save_job' AND pronargs = 6";
const beforeDrift = psqlScalar(BODY_FINGERPRINT);
if (!beforeDrift.ok) fail("could not read the stub body fingerprint", beforeDrift.out);

r = psqlFile("/tmp/migration.sql");
if (r.ok) fail("the migration APPLIED over a body that is not the reviewed one", r.out);
if (!/PREFLIGHT_BODY_DRIFT/.test(r.out)) {
  fail("the migration aborted, but not with PREFLIGHT_BODY_DRIFT", r.out);
}
const afterDrift = psqlScalar(BODY_FINGERPRINT);
if (!afterDrift.ok) fail("could not re-read the body fingerprint after the refused apply", afterDrift.out);
if (afterDrift.value !== beforeDrift.value) {
  fail(`NOT ATOMIC: the preflight refused, but the function body changed anyway ` +
       `(${beforeDrift.value} -> ${afterDrift.value}). The pin and the replacement are ` +
       `not sharing one transaction, which is the whole reason the pin lives in this file.`);
}
log("PHASE 3 OK  drift refused (PREFLIGHT_BODY_DRIFT) and the live body was left untouched");

// --- phase 4: apply over the reviewed body; the postflight must pass -------------
// Deliberately starts from a BAD ACL: anon is granted EXECUTE first. That is the shape a
// from-scratch replay of this repo actually produces -- no migration has ever revoked this
// function from anon or PUBLIC -- and it is the shape the round-3 security review said the
// file asserted but never established. If the migration only asserted, it would abort here.
rebuild("phase 4");
r = psqlCmd("GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO anon;");
if (!r.ok) fail("could not stage the bad ACL", r.out);
r = psqlCmd("REVOKE EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM service_role;");
if (!r.ok) fail("could not stage the missing service_role grant", r.out);

r = psqlFile("/tmp/migration.sql");
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
  fail(`the migration did not ESTABLISH the intended ACL. Expected anon=false, ` +
       `authenticated=true, service_role=true; got "${aclAfter.value}". A file that ` +
       `asserts a security property must also set it, or a rebuilt database keeps the ` +
       `inherited grant and only the assertion stands between anon and a SECDEF write.`);
}
log("PHASE 4 OK  applied over a deliberately BAD ACL; anon revoked, authenticated + service_role granted, postflight passed");

// --- phase 5: re-applying must be safe (an identical re-install, not a skip) -----
// Precise wording matters here. The marker arm only suppresses the drift RAISE; the
// CREATE OR REPLACE, the grants, the postflight and the COMMENT all still execute. So a
// replay REINSTALLS THE IDENTICAL BODY -- it does not skip. Calling that "a no-op" was a
// review finding, because a reader would assume the second run touches nothing.
const beforeReplay = psqlScalar(BODY_FINGERPRINT);
r = psqlFile("/tmp/migration.sql");
if (!r.ok) fail("the migration refused its own already-applied body; it is not replayable", r.out);
const afterReplay = psqlScalar(BODY_FINGERPRINT);
if (!beforeReplay.ok || !afterReplay.ok) fail("could not fingerprint the body around the replay");
if (beforeReplay.value !== afterReplay.value) {
  fail(`a replay changed the installed body (${beforeReplay.value} -> ${afterReplay.value})`);
}
log(`PHASE 5 OK  replay reinstalls the IDENTICAL body via the "${MARKER}" marker (same md5 and length)`);

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
    from: " OR v_denom_probe ~ '[\\s-]+per[\\s-]+'",
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
  {
    name: "blank-unit refusal reverted to a skip",
    from: "    IF v_qty_unit IS NULL OR v_price_unit IS NULL THEN",
    to: "    IF false THEN",
    expect: "T17",
  },
  // These two do not turn a behaviour test red -- they make the APPLY abort, which is the
  // postflight doing its job. Without them the four security assertions were never
  // exercised by anything (compliance review, round 3): the prover used to hand the
  // container a correct ACL and a correct SECDEF declaration, so the tripwires could not
  // fire even in principle.
  {
    name: "SECURITY DEFINER downgraded to INVOKER",
    from: "SECURITY DEFINER\nSET search_path TO 'public', 'pg_temp'",
    to: "SECURITY INVOKER\nSET search_path TO 'public', 'pg_temp'",
    expectApplyAbort: "POSTFLIGHT_NOT_SECURITY_DEFINER",
  },
  {
    name: "anon left holding EXECUTE",
    from: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM anon;",
    to: "",
    // Staged deliberately: with the REVOKE removed, the mutant only differs from the real
    // file on a database where anon actually holds the grant -- which is exactly the
    // from-scratch-replay shape this statement exists for.
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
    name: "search_path pin removed",
    from: "SECURITY DEFINER\nSET search_path TO 'public', 'pg_temp'",
    to: "SECURITY DEFINER",
    expectApplyAbort: "POSTFLIGHT_SEARCH_PATH",
  },
  {
    name: "customer-supplied exemption removed",
    from: "      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);\n",
    to: "",
    expect: "T19",
  },
  {
    // The round-7 defect itself, reproduced as a mutant: put the zero-quantity skip back
    // BELOW the blank-unit refusal. That is exactly how the code shipped when the refusal
    // was first written, and it falsely refused an ordinary UI shape. Without this mutant
    // the ordering is asserted only by a comment.
    name: "zero-quantity skip moved back below the blank-unit refusal",
    edits: [
      { from: "    CONTINUE WHEN v_qty = 0;\n\n    -- A BLANK unit", to: "    -- A BLANK unit" },
      {
        from: "    -- (the zero-quantity skip moved ABOVE the blank-unit refusal -- see the comment there)",
        to: "    CONTINUE WHEN v_qty = 0;",
      },
    ],
    expect: "T20",
  },
  {
    // Codex's BLOCKER (2026-08-24), reproduced as a mutant: revert the subtractive probe to
    // the old "does it END in a per-acre suffix" exclusion form. That form accepts a STACKED
    // denominator -- oz/cwt/ac ends in /ac, so every exclusion is satisfied, and the base
    // derivation then discards cwt. Without this mutant the tightening is asserted only by a
    // comment.
    name: "denominator rule reverted to the end-with-per-acre exclusion form",
    from:
      "    IF v_raw_rate_unit <> ''\n" +
      "       AND (position('/' IN v_denom_probe) > 0 OR v_denom_probe ~ '[\\s-]+per[\\s-]+') THEN",
    to:
      "    IF v_raw_rate_unit <> ''\n" +
      "       AND v_raw_rate_unit !~ '\\s*/\\s*(acres|acre|ac|a)\\s*$'\n" +
      "       AND v_raw_rate_unit !~ '[\\s-]+per[\\s-]+(acres|acre|ac|a)$'\n" +
      "       AND (position('/' IN v_raw_rate_unit) > 0 OR v_raw_rate_unit ~ '[\\s-]+per[\\s-]+') THEN",
    expect: "T24",
  },
  {
    // Revert to the raw, unlocked, operation-filtered lookup the live body still carries.
    // T26 must go red: a key already spent by another operation becomes invisible again,
    // the job is created, and the receipt is swallowed by ON CONFLICT DO NOTHING.
    // Drop back to the key-only helper: no actor, no fingerprint. A completed key reused
    // for a CHANGED payload then replays the old success and silently saves nothing,
    // which is exactly the defect the gate described. Two edits, because the key-only
    // helper returns the bare result while the intent helper returns a wrapper -- reverting
    // one without the other would break the shape rather than restore the old behaviour,
    // and the mutant would be scored for the wrong reason.
    name: "idempotency reverted to the key-only helper (no actor or intent binding)",
    edits: [
      {
        from: "    v_existing := check_idempotency_intent(p_idempotency_key, 'save_job', v_actor, v_fingerprint);",
        to: "    v_existing := check_idempotency(p_idempotency_key, 'save_job');",
      },
      {
        from:
          "      IF v_existing -> 'result' IS NULL\n" +
          "         OR jsonb_typeof(v_existing -> 'result') IS DISTINCT FROM 'object'\n" +
          "         OR NULLIF(v_existing -> 'result' ->> 'job_id', '') IS NULL THEN\n" +
          "        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';\n" +
          "      END IF;\n" +
          "      RETURN v_existing -> 'result';",
        to: "      RETURN v_existing;",
      },
    ],
    expect: "T30",
  },
  {
    // Stop binding the receipt. The row is then written with both binding columns NULL,
    // and check_idempotency_intent's deployment bridge fails closed on it -- so the very
    // next legitimate retry of that key is REFUSED. T27 is the ordinary same-key replay,
    // so it is the test that must go red.
    name: "receipt no longer bound to actor and fingerprint",
    from:
      "    UPDATE idempotency_keys\n" +
      "       SET request_fingerprint = v_fingerprint,\n" +
      "           request_actor_id    = v_actor\n" +
      "     WHERE idempotency_key = p_idempotency_key\n" +
      "       AND operation = 'save_job';\n" +
      "    IF NOT FOUND THEN\n" +
      "      RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';\n" +
      "    END IF;\n",
    to: "",
    expect: "T27",
  },
  {
    // No edit to the migration at all -- an EMPTY edits list, deliberately. What is
    // mutated is the DATABASE: the helper the new body calls is dropped first. PL/pgSQL
    // resolves that call at run time, so without the preflight assertion this migration
    // would apply perfectly cleanly and then fail on the first real job save. The apply
    // must refuse instead.
    name: "check_idempotency_intent helper missing from the database",
    edits: [],
    stage: "DROP FUNCTION public.check_idempotency_intent(text, text, uuid, text);",
    expectApplyAbort: "PREFLIGHT_MISSING_HELPER",
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
    // The replacement MUST go through a function. String.replace treats $&, $`, $' and $1
    // in a string replacement as substitution patterns, and SQL regex literals here end in
    // `$'` all the time -- e.g. '\s*/\s*(acres|acre|ac|a)\s*$'. Passed as a plain string
    // that silently splices the whole remainder of the migration into the mutant, which
    // then fails to install with a syntax error hundreds of lines away from the edit. A
    // function replacement is taken verbatim. Found while adding the stacked-denominator
    // mutant; every mutant whose `to` contains a dollar sign depended on this.
    mutated = mutated.replace(e.from, () => e.to);
  }
  const p = join(scratch, "mutant.sql");
  writeFileSync(p, mutated, "utf8");
  copyIn(p, "/tmp/mutant.sql");

  rebuild(`mutant "${m.name}"`);
  if (m.stage) {
    const staged = psqlCmd(m.stage);
    if (!staged.ok) fail(`could not stage the precondition for mutant "${m.name}"`, staged.out);
  }
  const applied = psqlFile("/tmp/mutant.sql");

  // Two shapes of mutant. Most must let the migration install and then turn a named
  // behaviour test red. The security mutants must instead make the APPLY ITSELF abort,
  // with the specific postflight assertion that is supposed to catch them.
  if (m.expectApplyAbort) {
    if (applied.ok) {
      fail(`SECURITY TRIPWIRE NOT ARMED: with "${m.name}", the migration applied ` +
           `successfully. The postflight assertion ${m.expectApplyAbort} did not fire, so ` +
           `nothing is checking that property.`, applied.out);
    }
    if (!new RegExp(m.expectApplyAbort).test(applied.out)) {
      fail(`MUTATION MIS-ATTRIBUTED: "${m.name}" aborted the apply, but not with ` +
           `${m.expectApplyAbort}. Something else failed first, so this mutant proves ` +
           `nothing about the assertion it was written for.`, applied.out);
    }
    log(`PHASE 7 OK  mutant "${m.name}" aborted the apply with ${m.expectApplyAbort} (as required)`);
    continue;
  }

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
