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
// The container name is UNIQUE PER RUN and every container this prover starts carries
// OWNER_LABEL. cleanup() then force-removes only a name this process generated, never a
// fixed name a developer's own container might also be using -- 'docker rm -f' on a
// shared constant is a destructive action aimed at something you have not proved you own.
// Raised by the exact-SHA gpt-5.6-sol gate, 2026-08-24.
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const CONTAINER = `crx-prove-save-job-chem-unit-${RUN_ID}`;
const OWNER_LABEL = "crx.prover=save-job-chem-unit";
const IMAGE = "postgres:17";

const MIGRATION = join(REPO, "supabase", "migrations",
  "20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql");
const PRECHANGE_MIGRATION = join(REPO, "supabase", "migrations",
  "20260706080000_customer_supplied_chemicals.sql");
const HARNESS = join(HERE, "fixtures", "save-job-chem-unit-harness.sql");
const TESTS = join(HERE, "fixtures", "save-job-chem-unit-tests.sql");

const TEST_IDS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10",
                  "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19",
                  "T20", "T21", "T22", "T23", "T24", "T25", "T26", "T27", "T28", "T29", "T30",
                  "T31", "T32", "T33", "T34", "T35", "T36", "T37", "T38", "T39",
                  "T40", "T41", "T42", "T43", "T44", "T45", "T46", "T47", "T48"];

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
/** Apply the MIGRATION, and only the migration, in ONE transaction (`--single-transaction`).
 *
 * This is not a tidiness preference -- without it the proof quietly overstated itself.
 * psql autocommits each statement, so when a postflight mutant raised, the CREATE OR REPLACE
 * and the ACL statements ahead of it had ALREADY committed. The prover reported "aborted the
 * apply (as required)" -- true of psql's exit status -- while the container was left carrying
 * the mutated body. Supabase's apply_migration wraps the file in a transaction, so the real
 * channel rolls back and the prover did not model it. Phase 3 could not catch the gap either:
 * its preflight raises before any write, so "the body is unchanged" held trivially there.
 *
 * Only migration applies use this. The harness, the pre-change migration and the behaviour
 * tests deliberately stay outside it: those files are SETUP and ASSERTIONS, and wrapping the
 * test file would roll back the committed rows T8 counts at the end.
 *
 * Raised by CodeRabbit on 2026-08-24, which also pointed at the repo's existing precedent in
 * scripts/smoke/prove-blend-ticket-fractional-cents.mjs.
 */
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

/** Reap containers left behind by a PREVIOUS run of THIS prover that was killed before it
 * could clean up. Filtering on our own label is what keeps this safe: an unrelated
 * container cannot carry it, so nothing outside this prover is ever a candidate. */
function reapStale() {
  // STOPPED containers only. The label is shared by every run of this prover, so filtering
  // on the label ALONE also matched a CONCURRENT run's live container and force-removed it
  // mid-proof -- two developers, or two CI jobs, and the second run silently killed the
  // first. The unique per-run name does not help here, because this lookup is by label.
  // A running container is by definition not stale, so restricting to terminal states is
  // both the fix and the honest reading of "stale". Raised by CodeRabbit on 2026-08-24.
  let ids = "";
  for (const status of ["exited", "dead", "created"]) {
    try {
      ids += docker(["ps", "-aq", "--filter", `label=${OWNER_LABEL}`, "--filter", `status=${status}`]);
    } catch { /* daemon unavailable or no match; nothing to reap for this status */ }
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
reapStale();
docker(["run", "-d", "--name", CONTAINER, "--label", OWNER_LABEL,
        "-e", "POSTGRES_PASSWORD=proveonly", IMAGE]);

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

r = psqlMigration("/tmp/migration.sql");
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
r = psqlMigration("/tmp/migration.sql");
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
    // Deleting the whole form-aware block restores the exact BLOCKER the gate found:
    // fl oz and oz collapse to one unit on a DRY product and the equality shortcut bills
    // a line the app's own converter calls unpriceable. T37 must go red by name.
    name: "form-aware dry fl-oz refusal removed",
    from: "    IF v_form = 'dry'\n",
    to: "    IF false\n",
    expect: "T37",
  },
  {
    // Reverts the canonicalisation to whitespace-only, which is precisely the round-12
    // rule the gate returned as a P1: 'fl. oz' stops folding to 'fl oz', escapes the
    // concept match, and rides the equality shortcut into the money. Deliberately narrow
    // -- it leaves the rule itself standing, so T34 (no periods) must STAY GREEN while
    // T39 alone goes red. A mutant that reddened both would not prove the period handling
    // is what is being tested.
    // The fold is removed entirely: the raw lowercased unit must then BE 'floz' with no
    // separator at all, so even the plainest spelling 'fl oz' stops matching. T34 is the
    // plain both-sides dry line, so it is the test that must go red.
    name: "separator folding removed from the dry fl-oz rule",
    from: "regexp_replace(lower(COALESCE(raw_unit, '')), '[^a-z0-9]', '', 'g')",
    to: "lower(COALESCE(raw_unit, ''))",
    expect: "T34",
  },
  {
    // Reverts the fold from "delete everything that is not a letter or digit" to the round-14
    // ASCII list. Every escape rounds 12-14 closed stays closed, so T39/T40/T44 remain green
    // -- and T45 alone goes red, because U+2010, U+2011 and U+202F are in no ASCII class.
    // That split is the evidence: it proves the LIST-FREE property specifically, which is the
    // only thing separating this round from four rounds that each got beaten by one more
    // character.
    name: "fold narrowed back to an ASCII separator list",
    from: "'[^a-z0-9]', '', 'g')",
    to: "'[[:space:].-]', '', 'g')",
    expect: "T45",
  },
  {
    // Restores the UNCONDITIONAL zero-quantity exit, which billed the customer nothing for a
    // product the rate and acreage say was applied. T46 must go red; T20 and T47 (the two
    // legitimate zero-quantity shapes) must stay green, which is what proves the rule is
    // discriminating between them rather than just firing.
    name: "zero-quantity exit made unconditional again",
    from: "    IF v_qty = 0 THEN\n      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);",
    to: "    CONTINUE WHEN v_qty = 0;\n    IF false THEN\n      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);",
    expect: "T46",
  },
  {
    // Drops the unverifiable-quantity refusal, restoring the switch-it-off-by-omitting-the-
    // rate bypass that round 15 left open. T48 must go red.
    name: "unverifiable priced quantity allowed through again",
    from: "      IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0 THEN\n        SELECT p.product_name INTO v_product_name\n          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;\n        RAISE EXCEPTION\n          'CHEM_QUANTITY_UNVERIFIABLE",
    to: "      IF false THEN\n        SELECT p.product_name INTO v_product_name\n          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;\n        RAISE EXCEPTION\n          'CHEM_QUANTITY_UNVERIFIABLE",
    expect: "T48",
  },
  {
    // Restores the bare equality shortcut, which proved the two sides shared a unit and
    // nothing about the quantity -- the caller then set the money directly. T42 must go red.
    name: "equality shortcut restored as a free pass for the quantity",
    from: "    IF v_qty_unit = v_price_unit THEN\n      v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;",
    to: "    CONTINUE WHEN v_qty_unit = v_price_unit;\n    IF false THEN\n      v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;",
    expect: "T42",
  },
  {
    // Removes the leading-denominator arm only, leaving the two separator-bounded patterns.
    // 'per cwt' then survives normalisation and bills. T43 must go red.
    name: "leading denominator arm removed from the per-acre rule",
    from: "            OR v_denom_probe ~ '^[\\s-]*per[\\s-]+') THEN",
    to: "            OR false) THEN",
    expect: "T43",
  },
  {
    // Forces EVERY line down the equal-units branch, so the units are never compared at all.
    // A genuinely mismatched line (T4: oz measured, lb priced) is then either waved through or
    // reported as a quantity problem -- both wrong, and either way T4 goes red by name.
    // (The anchor moved in round 15: the bare `CONTINUE WHEN v_qty_unit = v_price_unit` became
    // a block when the equality shortcut stopped being a free pass for the quantity.)
    name: "unit comparison disabled",
    from: "IF v_qty_unit = v_price_unit THEN",
    to: "IF true THEN",
    expect: "T4",
  },
  {
    name: "caller-supplied cost total restored",
    from: "      v_total_cost_cents,\n",
    to: "      COALESCE((p_job_payload->>'total_cost_cents')::bigint, 0),\n",
    expect: "T6",
  },
  {
    // Reverting the single-strip guard to two unconditional strips restores the exact
    // 'oz per acre/ac' bypass. T35 must go red by name.
    name: "per-acre strip reverted to two unconditional passes",
    from: "    IF v_denom_probe = v_raw_rate_unit THEN\n",
    to: "    IF true THEN\n",
    expect: "T35",
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
    // `all: true` is load-bearing, not tidiness. Since round 15 the acreage finiteness bound
    // exists in BOTH the equal-units branch and the mismatched branch, and the mutant is named
    // for removing EVERY one. Left as a first-match replace it edited only the equal-units
    // copy, T11 (a mismatched line) never saw the mutation, and the phase reported the test as
    // weak when the test had simply not been reached.
    name: "every finiteness bound on the acreage path removed",
    edits: [
      { from: "AND v_acres > 0 AND v_acres < 'Infinity'::numeric", to: "AND v_acres > 0", all: true },
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
    // Anchor widened in round 17. The bare CONTINUE line stopped being unique once the
    // zero-quantity block gained its own customer-supplied exemption, and the new ambiguity
    // check refused it rather than silently editing whichever came first. The exemption this
    // mutant is named for is the BLANK-UNIT one that T19 covers, so the anchor now carries
    // the cost_per_unit_cents line that follows it there and nowhere else.
    name: "customer-supplied exemption removed",
    from: "      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);\n" +
          "      CONTINUE WHEN COALESCE(NULLIF(v_chem->>'cost_per_unit_cents', '')::bigint, 0) = 0",
    to: "      CONTINUE WHEN COALESCE(NULLIF(v_chem->>'cost_per_unit_cents', '')::bigint, 0) = 0",
    expect: "T19",
  },
  {
    // The round-7 defect itself, reproduced as a mutant: put the zero-quantity skip back
    // BELOW the blank-unit refusal. That is exactly how the code shipped when the refusal
    // was first written, and it falsely refused an ordinary UI shape. Without this mutant
    // the ordering is asserted only by a comment.
    // Re-cut in round 17: the skip became a conditional block, so "move the one-line skip"
    // no longer describes anything. Disabling the block reproduces the same defect by the
    // same mechanism -- a zero-quantity line stops being handled early and falls through
    // into the blank-unit refusal, which is precisely what refused the ordinary UI shape.
    name: "zero-quantity handling moved back below the blank-unit refusal",
    from: "    IF v_qty = 0 THEN\n      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);",
    to: "    IF false THEN\n      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);",
    expect: "T20",
  },
  {
    // Codex's BLOCKER (2026-08-24), reproduced as a mutant: revert the subtractive probe to
    // the old "does it END in a per-acre suffix" exclusion form. That form accepts a STACKED
    // denominator -- oz/cwt/ac ends in /ac, so every exclusion is satisfied, and the base
    // derivation then discards cwt. Without this mutant the tightening is asserted only by a
    // comment.
    name: "denominator rule reverted to the end-with-per-acre exclusion form",
    // (Anchor re-cut in round 15, when the condition gained its leading-denominator arm. The
    // revert deliberately drops that arm too -- the exclusion form it restores had no such
    // arm -- so this mutant reddens T24 by name and would redden T43 as well, which is the
    // honest reproduction of the old rule rather than a half-revert.)
    from:
      "    IF v_raw_rate_unit <> ''\n" +
      "       AND (position('/' IN v_denom_probe) > 0\n" +
      "            OR v_denom_probe ~ '[\\s-]+per[\\s-]+'\n" +
      "            OR v_denom_probe ~ '^[\\s-]*per[\\s-]+') THEN",
    to:
      "    IF v_raw_rate_unit <> ''\n" +
      "       AND v_raw_rate_unit !~ '\\s*/\\s*(acres|acre|ac|a)\\s*$'\n" +
      "       AND v_raw_rate_unit !~ '[\\s-]+per[\\s-]+(acres|acre|ac|a)$'\n" +
      "       AND (position('/' IN v_raw_rate_unit) > 0 OR v_raw_rate_unit ~ '[\\s-]+per[\\s-]+') THEN",
    expect: "T24",
  },
  {
    // Revert to the raw, unlocked, operation-filtered lookup the live body still carries.
    // T30 must go red by name -- the assertion below is what this mutant is scored on.
    // (This comment used to name T26. The cross-operation defect T26 covers is real, but
    // the key-only helper still raises on it, so T26 stays GREEN under this mutant; what
    // actually breaks is the changed-payload replay, which is T30. Naming the wrong test
    // in a comment is how a reader concludes the wrong guard is covered.)
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
    // An AMBIGUOUS anchor is refused outright unless the mutant opts into `all`. Without this
    // the failure is silent and actively misleading: String.replace takes the FIRST match, so
    // when a guard came to exist in two places the mutant quietly edited the copy it did not
    // mean, left the real one standing, and the phase reported "MUTATION NOT DETECTED" -- which
    // reads as "the test is weak" when in fact the test was never exercised. That is exactly
    // what happened when the equality shortcut gained its own copy of the acreage finiteness
    // bound in round 15. A mutant must land where it says it lands.
    const hits = mutated.split(e.from).length - 1;
    if (hits > 1 && !e.all) {
      fail(`mutation "${m.name}" has an AMBIGUOUS anchor: "${e.from.slice(0, 60)}..." occurs ` +
           `${hits} times. String.replace would silently take the first one. Either make the ` +
           `anchor unique or set all:true if every occurrence is genuinely meant.`);
    }
    // The replacement MUST go through a function. String.replace treats $&, $`, $' and $1
    // in a string replacement as substitution patterns, and SQL regex literals here end in
    // `$'` all the time -- e.g. '\s*/\s*(acres|acre|ac|a)\s*$'. Passed as a plain string
    // that silently splices the whole remainder of the migration into the mutant, which
    // then fails to install with a syntax error hundreds of lines away from the edit. A
    // function replacement is taken verbatim. Found while adding the stacked-denominator
    // mutant; every mutant whose `to` contains a dollar sign depended on this.
    mutated = e.all ? mutated.split(e.from).join(e.to) : mutated.replace(e.from, () => e.to);
  }
  const p = join(scratch, "mutant.sql");
  writeFileSync(p, mutated, "utf8");
  copyIn(p, "/tmp/mutant.sql");

  rebuild(`mutant "${m.name}"`);
  if (m.stage) {
    const staged = psqlCmd(m.stage);
    if (!staged.ok) fail(`could not stage the precondition for mutant "${m.name}"`, staged.out);
  }
  const applied = psqlMigration("/tmp/mutant.sql");

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
r = psqlMigration("/tmp/migration.sql");
if (!r.ok) fail("final clean re-apply failed", r.out);
r = psqlFile("/tmp/tests.sql");
if (!r.ok) fail("final clean run failed", r.out);

cleanup();
log(`\nSAVE_JOB_CHEM_UNIT_PROOF_PASS  (PostgreSQL 17; md5 pin reproduced from source, ` +
    `atomic drift refusal, postflight assertions, ${TEST_IDS.length} behaviour tests, ` +
    `${MUTANTS.length} mutation phases)`);
