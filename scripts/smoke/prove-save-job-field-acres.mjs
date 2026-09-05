#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for 20260904185900_refuse_null_job_field_acres.sql.
 * Proves the exact F06 source pin, atomic apply, replay, hotfix refusal, A1-A4
 * behaviour, five apply-abort placement mutants, six apply-abort security/ACL
 * mutants, and four runtime break-it canaries. Touches no external database.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const MIGRATION = join(REPO, "supabase", "migrations",
  "20260904185900_refuse_null_job_field_acres.sql");
const SOURCE = join(REPO, "supabase", "migrations",
  "20260903150000_job_chemicals_persist_driver.sql");
const HARNESS = join(HERE, "fixtures", "save-job-chem-unit-harness.sql");
const TESTS = join(HERE, "fixtures", "save-job-field-acres-tests.sql");
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const CONTAINER = `crx-prove-save-job-acres-${RUN_ID}`;
const OWNER_LABEL = "crx.prover=save-job-field-acres";
const IMAGE = "postgres:17";
const EXPECTED_SOURCE_MD5 = "18d08d5f40aea91fe13ac3e5a686c549";
const log = (message) => process.stdout.write(`${message}\n`);
const docker = (args, options = {}) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: "pipe", ...options });

function runDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: `${result.stdout || ""}${result.stderr || ""}`,
  };
}
const psqlFile = (path, stop = true) => runDocker([
  "exec", CONTAINER, "psql", "-U", "postgres",
  ...(stop ? ["-v", "ON_ERROR_STOP=1"] : []), "-f", path,
]);
const psqlMigration = (path) => runDocker([
  "exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1",
  "--single-transaction", "-f", path,
]);
const psqlCmd = (sql) => runDocker([
  "exec", CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql,
]);
const psqlScalar = (sql) => runDocker([
  "exec", CONTAINER, "psql", "-U", "postgres", "-t", "-A",
  "-v", "ON_ERROR_STOP=1", "-c", sql,
]);
const copyIn = (local, remote) => docker(["cp", local, `${CONTAINER}:${remote}`]);
const cleanup = () => {
  try { docker(["rm", "-f", CONTAINER], { stdio: "ignore" }); } catch { /* absent */ }
};
function fail(message, detail = "") {
  cleanup();
  throw new Error(`${message}${detail ? `\n${detail.trim()}` : ""}`);
}
function reapStale() {
  let ids = "";
  for (const status of ["exited", "dead", "created"]) {
    try {
      ids += docker(["ps", "-aq", "--filter", `label=${OWNER_LABEL}`, "--filter", `status=${status}`]);
    } catch { /* none */ }
  }
  for (const id of ids.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try { docker(["rm", "-f", id], { stdio: "ignore" }); } catch { /* raced */ }
  }
}
function functionDdl(text) {
  const lf = text.replace(/\r/g, "");
  const start = lf.indexOf("CREATE OR REPLACE FUNCTION public.save_job(");
  const open = lf.indexOf("$function$", start);
  const close = lf.indexOf("$function$", open + "$function$".length);
  if (start < 0 || open < 0 || close < 0) throw new Error("save_job body delimiters moved");
  const afterClose = close + "$function$".length;
  const semicolon = lf.indexOf(";", afterClose);
  if (semicolon < 0 || lf.slice(afterClose, semicolon).trim() !== "") {
    throw new Error("save_job closing delimiter is not followed by its statement terminator");
  }
  return lf.slice(start, semicolon + 1);
}
function bodyMd5(text) {
  const ddl = functionDdl(text);
  const open = ddl.indexOf("$function$") + "$function$".length;
  const close = ddl.indexOf("$function$", open);
  return createHash("md5").update(ddl.slice(open, close)).digest("hex");
}
function functionBody(text) {
  const ddl = functionDdl(text);
  const open = ddl.indexOf("$function$") + "$function$".length;
  return ddl.slice(open, ddl.indexOf("$function$", open));
}
function replaceOnce(text, from, to, label) {
  if (!from || text.split(from).length !== 2) fail(`F06_DELTA_ALLOWLIST_DRIFT: ${label} anchor is absent or ambiguous`);
  return text.replace(from, to);
}

let migration = readFileSync(MIGRATION, "utf8").replace(/\r/g, "");
const source = readFileSync(SOURCE, "utf8").replace(/\r/g, "");
const candidateMd5 = bodyMd5(migration);
if (migration.includes("__CANDIDATE_MD5__")) {
  fail(`replace __CANDIDATE_MD5__ with ${candidateMd5}`);
}
if (bodyMd5(source) !== EXPECTED_SOURCE_MD5) {
  fail(`F06 source drifted: expected ${EXPECTED_SOURCE_MD5}, got ${bodyMd5(source)}`);
}
const declared = [...migration.matchAll(/md5\(v_src\)\s*<>\s*'([0-9a-f]{32})'/g)]
  .map((match) => match[1]);
if (declared[0] !== EXPECTED_SOURCE_MD5 || declared[1] !== candidateMd5) {
  fail(`preflight pins are not source/candidate: ${declared.join(", ")}; candidate=${candidateMd5}`);
}
// The candidate may differ from F06 in exactly two executable body edits (the
// acreage-shape guard immediately before the existing SUM and the sole job_fields
// blank normalization) plus two exact comment-block replacements.
// This check runs before Docker so an unrelated
// re-emission cannot borrow the container's green behaviour tests.
const f06Body = functionBody(source);
const candidateBody = functionBody(migration);
const sumAnchor = "  SELECT COALESCE(SUM(COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0)), 0)";
const oldMarker = "  -- BODY MARKER: chem_unit_invariant_v3\n"
  + "  -- Do not remove or reword this string. The preflight pin at the top of this file keys\n"
  + "  -- its re-apply no-op on it, and any future revision of this body MUST bump the version\n"
  + "  -- suffix (v3 -> v4) so that replaying this migration is refused rather than silently\n"
  + "  -- reverting that revision. The previous token must not survive ANYWHERE in the body,\n"
  + "  -- not even in a comment: 20260820120000 keys its replay on finding its own marker text,\n"
  + "  -- so a stray mention would let that file replay over this body unrefused. (v2 -> v3 on\n"
  + "  -- 2026-09-03: F06, the calculator driver is now read from the payload and stored.) (v1 -> v2 on 2026-08-25, when round 26 added the\n"
  + "  -- punctuation-only folded-empty arm -- the drift reviewer caught that the revision had\n"
  + "  -- not bumped it, which would have let a pre-round-26 copy of this file replay over the\n"
  + "  -- revised body unrefused. No v1 body was ever applied anywhere, so no live or ledgered\n"
  + "  -- state distinguishes the two; the bump exists so that stays true.)\n"
  + "  -- ==========================================================================\n";
const newMarker = "  -- BODY MARKER: chem_unit_invariant_v4\n"
  + "  -- 2026-09-04: missing and JSON-null field acreage are refused before any write.\n"
  + "  -- NEW direct-RPC compatibility: non-null empty acreage stores as numeric zero; UI already sends zero.\n"
  + "  -- ==========================================================================\n";
const missingGuard = "  -- JOB FIELD ACREAGE SHAPE GUARD: missing and JSON-null are invalid and\n"
  + "  -- diagnosed separately. Both checks precede every acres COALESCE; non-null\n"
  + "  -- empty acreage is newly stored as numeric zero.\n"
  + "  IF EXISTS (\n    SELECT 1\n      FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f\n"
  + "     WHERE NOT (f ? 'acres_to_treat')\n  ) THEN\n"
  + "    RAISE EXCEPTION\n      'JOB_ACRES_NOT_FINITE: One of the fields on this job is missing the acreage key. Every field must carry a finite, non-negative acreage; an intentional blank is stored as zero.';\n  END IF;\n\n";
const nullGuard = "  IF EXISTS (\n    SELECT 1\n      FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f\n"
  + "     WHERE jsonb_typeof(f->'acres_to_treat') = 'null'\n  ) THEN\n"
  + "    RAISE EXCEPTION\n      'JOB_ACRES_NOT_FINITE: One of the fields on this job carries JSON null acreage. Every field must carry a finite, non-negative acreage; an intentional blank is stored as zero.';\n  END IF;\n\n";
const shapeGuard = `${missingGuard}${nullGuard}`;
let derived = replaceOnce(f06Body, oldMarker, newMarker, "marker transformation");
derived = replaceOnce(derived, sumAnchor, `${shapeGuard}${sumAnchor}`, "shape-guard transformation");
derived = replaceOnce(derived, "      (v_field->>'acres_to_treat')::numeric,", "      COALESCE(NULLIF(v_field->>'acres_to_treat','')::numeric, 0),", "blank-normalization transformation");
derived = replaceOnce(derived,
  "  -- Reachability, stated honestly because the gate overstated it: the gate said the\n  -- client key is \"retained after uncertain failures\". It is not. There is exactly one\n  -- live caller (src/pages/JobDetail.tsx:2210) and runJobSave calls resetKey() at the\n  -- START of every save attempt as well as after a success, so the ordinary UI mints a\n  -- fresh key per attempt and cannot reach the silent-no-op. What remains real is the\n  -- hardening gap itself -- any caller presenting a spent key gets the old result -- and\n  -- that is worth closing on a SECURITY DEFINER money path regardless of today's client.\n",
  "  -- Reachability, stated honestly because the gate overstated it: one in-repository CRX\n  -- Manager browser caller is JobDetail.tsx (performSave near line 2360; save_job call\n  -- near line 2468). runJobSave\n  -- normally resets its key for a new save; the license-override direct performSave path\n  -- may deliberately reuse one after an uncertain outcome. What remains real is the\n  -- hardening gap itself -- any caller presenting a spent key gets the old result -- and\n  -- that is worth closing on a SECURITY DEFINER money path regardless of today's client.\n",
  "caller-reachability comment transformation");
if (derived !== candidateBody) {
  fail(`F06_DELTA_ALLOWLIST_DRIFT: expected exactly two executable edits and two exact comment-block replacements (f06=${bodyMd5(source)} candidate=${candidateMd5})`);
}

const scratch = mkdtempSync(join(tmpdir(), "crx-prove-save-job-acres-"));
const bootstrapPath = join(scratch, "bootstrap.sql");
const candidatePath = join(scratch, "candidate.sql");
const acl = `
REVOKE ALL ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text) TO authenticated, service_role;
`;
writeFileSync(bootstrapPath, `
ALTER TABLE public.job_chemicals ADD COLUMN IF NOT EXISTS driver text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.job_chemicals'::regclass AND conname='job_chemicals_driver_chk') THEN
    ALTER TABLE public.job_chemicals ADD CONSTRAINT job_chemicals_driver_chk
      CHECK (driver IS NULL OR driver IN ('rate','qty'));
  END IF;
END $$;
${functionDdl(source)}
${acl}`, "utf8");
writeFileSync(candidatePath, migration, "utf8");

try {
  docker(["--version"]);
  cleanup();
  reapStale();
  docker(["run", "-d", "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=512m", "--name", CONTAINER, "--label", OWNER_LABEL,
    "-e", "POSTGRES_PASSWORD=proveonly", IMAGE]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = runDocker(["exec", CONTAINER, "pg_isready", "-U", "postgres"]);
    if (probe.ok) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (!ready) fail("PostgreSQL did not become ready");
  copyIn(HARNESS, "/tmp/harness.sql");
  copyIn(TESTS, "/tmp/tests.sql");
  copyIn(bootstrapPath, "/tmp/bootstrap.sql");
  copyIn(candidatePath, "/tmp/candidate.sql");

  const rebuild = (label) => {
    const reset = psqlCmd("DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS extensions CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    if (!reset.ok) fail(`${label}: reset failed`, reset.out);
    let result = psqlFile("/tmp/harness.sql");
    if (!result.ok) fail(`${label}: harness failed`, result.out);
    result = psqlFile("/tmp/bootstrap.sql");
    if (!result.ok) fail(`${label}: F06 bootstrap failed`, result.out);
    const installed = psqlScalar("SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
    if (!installed.ok || installed.out.trim() !== EXPECTED_SOURCE_MD5) {
      fail(`${label}: bootstrap did not install exact F06 source`, installed.out);
    }
  };

  const assertExactF06Body = (label) => {
    const installed = psqlScalar("SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)')");
    if (!installed.ok || installed.out.trim() !== EXPECTED_SOURCE_MD5) {
      fail(`${label}: refused apply changed the installed save_job body`, installed.out);
    }
  };

  rebuild("column-shape drift");
  let result = psqlCmd("ALTER TABLE public.job_chemicals ALTER COLUMN driver SET DEFAULT 'rate'");
  if (!result.ok) fail("could not stage wrong-shape driver column", result.out);
  result = psqlMigration("/tmp/candidate.sql");
  if (result.ok || !/PREFLIGHT_COLUMN_DRIFT/.test(result.out)) {
    fail("wrong-shape driver column did not raise PREFLIGHT_COLUMN_DRIFT", result.out);
  }
  assertExactF06Body("column-shape drift");
  log("PREFLIGHT DRIFT OK  wrong-shape driver column refused; exact F06 body unchanged");

  rebuild("driver-CHECK drift");
  result = psqlCmd("ALTER TABLE public.job_chemicals DROP CONSTRAINT job_chemicals_driver_chk; ALTER TABLE public.job_chemicals ADD CONSTRAINT job_chemicals_driver_chk CHECK (driver IS NULL OR driver IN ('rate','qty','total'))");
  if (!result.ok) fail("could not stage widened driver CHECK", result.out);
  result = psqlMigration("/tmp/candidate.sql");
  if (result.ok || !/PREFLIGHT_CHECK_DRIFT/.test(result.out)) {
    fail("widened driver CHECK did not raise PREFLIGHT_CHECK_DRIFT", result.out);
  }
  assertExactF06Body("driver-CHECK drift");
  log("PREFLIGHT DRIFT OK  widened driver CHECK refused; exact F06 body unchanged");

  rebuild("clean");
  result = psqlMigration("/tmp/candidate.sql");
  if (!result.ok) fail("candidate migration failed", result.out);
  log(`PHASE 1 OK  exact F06 source ${EXPECTED_SOURCE_MD5} -> candidate ${candidateMd5}`);

  result = psqlFile("/tmp/tests.sql");
  if (!result.ok) fail("A1-A4 behaviour failed", result.out);
  for (const id of ["A1", "A2", "A3", "A4"]) {
    if (!new RegExp(`${id} PASS`).test(result.out)) fail(`${id} did not report PASS`, result.out);
  }
  log(result.out.split("\n").filter((line) => /A[1-4] PASS/.test(line)).join("\n"));

  result = psqlMigration("/tmp/candidate.sql");
  if (!result.ok) fail("exact replay was refused", result.out);
  log("PHASE 2 OK  exact candidate replay accepted");

  const hotfixDdl = functionDdl(migration).replace(
    "DECLARE\n  v_actor uuid;",
    "DECLARE\n  -- simulated later hotfix\n  v_actor uuid;",
  );
  const hotfixPath = join(scratch, "hotfix.sql");
  writeFileSync(hotfixPath, `${hotfixDdl}\n${acl}`, "utf8");
  copyIn(hotfixPath, "/tmp/hotfix.sql");
  result = psqlFile("/tmp/hotfix.sql");
  if (!result.ok) fail("could not stage a later hotfix", result.out);
  result = psqlMigration("/tmp/candidate.sql");
  if (result.ok || !/PREFLIGHT_BODY_DRIFT/.test(result.out)) {
    fail("candidate replay did not refuse a modified later body", result.out);
  }
  log("PHASE 3 OK  marker-preserving later body refused by exact hash");

  const replaceExact = (text, from, to, label) => {
    if (text.split(from).length !== 2) fail(`mutation anchor stale or ambiguous: ${label}`);
    return text.replace(from, to);
  };
  const repinBody = (text, label) => {
    if (text.split(candidateMd5).length - 1 !== 2) fail(`candidate MD5 pins must occur exactly twice: ${label}`);
    const md5 = bodyMd5(text);
    // The two occurrences are the preflight and postflight executable body pins.
    return text.replace(candidateMd5, md5).replace(candidateMd5, md5);
  };
  const applyAbortMutants = [
    { name: "marker", from: "  -- BODY MARKER: chem_unit_invariant_v4", to: "  -- BODY MARKER: chem_unit_invariant_v3", expect: "POSTFLIGHT_FIELD_ACRES_MARKER" },
    { name: "blank", from: "      COALESCE(NULLIF(v_field->>'acres_to_treat','')::numeric, 0),", to: "      (v_field->>'acres_to_treat')::numeric,", expect: "POSTFLIGHT_FIELD_ACRES_BLANK" },
    { name: "missing-guard-deleted", from: missingGuard, to: "", expect: "POSTFLIGHT_FIELD_ACRES_ORDER" },
    { name: "null-guard-deleted", from: nullGuard, to: "", expect: "POSTFLIGHT_FIELD_ACRES_ORDER" },
  ];
  const guardBlock = shapeGuard;
  for (const mutant of applyAbortMutants) {
    let changed = replaceExact(migration, mutant.from, mutant.to, mutant.name);
    changed = repinBody(changed, mutant.name);
    writeFileSync(join(scratch, "abort.sql"), changed, "utf8"); copyIn(join(scratch, "abort.sql"), "/tmp/abort.sql");
    rebuild(`apply-abort ${mutant.name}`); result = psqlMigration("/tmp/abort.sql");
    if (result.ok || !result.out.includes(mutant.expect)) fail(`apply-abort ${mutant.name} missed ${mutant.expect}`, result.out);
    assertExactF06Body(`apply-abort ${mutant.name}`); log(`APPLY-ABORT MUTATION OK  ${mutant.name} -> ${mutant.expect}`);
  }
  const sumStatement = `${sumAnchor}\n    INTO v_acres\n    FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f;`;
  let moved = replaceExact(migration, `${guardBlock}${sumStatement}`, `${sumStatement}\n\n${guardBlock}`, "order");
  moved = repinBody(moved, "order");
  writeFileSync(join(scratch, "abort.sql"), moved, "utf8"); copyIn(join(scratch, "abort.sql"), "/tmp/abort.sql");
  rebuild("apply-abort order"); result = psqlMigration("/tmp/abort.sql");
  if (result.ok || !result.out.includes("POSTFLIGHT_FIELD_ACRES_ORDER")) fail("apply-abort order missed POSTFLIGHT_FIELD_ACRES_ORDER", result.out);
  assertExactF06Body("apply-abort order"); log("APPLY-ABORT MUTATION OK  order -> POSTFLIGHT_FIELD_ACRES_ORDER");

  const aclMutants = [
    { name: "security-definer", from: "LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path", to: "LANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path", expect: "POSTFLIGHT_NOT_SECURITY_DEFINER" },
    { name: "search-path", from: "SET search_path TO 'public', 'pg_temp'", to: "SET search_path TO 'public'", expect: "POSTFLIGHT_SEARCH_PATH" },
    { name: "public-execute", from: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC;", to: "GRANT EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO PUBLIC;", expect: "POSTFLIGHT_PUBLIC_EXECUTE" },
    { name: "anon-execute", from: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM anon;", to: "GRANT EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO anon;", expect: "POSTFLIGHT_ANON_EXECUTE" },
    { name: "authenticated-grant-loss", from: "GRANT  EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated, service_role;", to: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM authenticated;\nGRANT EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO service_role;", expect: "POSTFLIGHT_GRANT_LOST" },
    { name: "service-role-grant-loss", from: "GRANT  EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated, service_role;", to: "REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM service_role;\nGRANT EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated;", expect: "POSTFLIGHT_GRANT_LOST" },
  ];
  for (const mutant of aclMutants) {
    const changed = replaceExact(migration, mutant.from, mutant.to, mutant.name);
    writeFileSync(join(scratch, "abort.sql"), changed, "utf8"); copyIn(join(scratch, "abort.sql"), "/tmp/abort.sql");
    rebuild(`apply-abort ${mutant.name}`); result = psqlMigration("/tmp/abort.sql");
    if (result.ok || !result.out.includes(mutant.expect)) fail(`apply-abort ${mutant.name} missed ${mutant.expect}`, result.out);
    assertExactF06Body(`apply-abort ${mutant.name}`); log(`APPLY-ABORT MUTATION OK  ${mutant.name} -> ${mutant.expect}`);
  }

  // Runtime canaries intentionally bypass only the separately proven postflight that
  // would otherwise prevent installing their broken body; each proves its SQL arm fires.
  const mutants = [
    {
      name: "missing-acreage arm disabled",
      from: missingGuard,
      to: "",
      postflightFrom: "  v_missing_guard := position('WHERE NOT (f ? ''acres_to_treat'')' IN v_src);",
      postflightTo: "  v_missing_guard := 1; -- runtime A1 mutant bypasses only static order postflight",
      expect: "A1 FAIL",
    },
    {
      name: "JSON-null arm disabled",
      from: nullGuard,
      to: "",
      postflightFrom: "  v_null_guard := position('WHERE jsonb_typeof(f->''acres_to_treat'') = ''null''' IN v_src);",
      postflightTo: "  v_null_guard := v_missing_guard + 1; -- runtime A2 mutant bypasses only static order postflight",
      expect: "A2 FAIL",
    },
    {
      name: "blank normalization disabled",
      from: "      COALESCE(NULLIF(v_field->>'acres_to_treat','')::numeric, 0),",
      to: "      (v_field->>'acres_to_treat')::numeric,",
      postflightFrom: "  IF position('COALESCE(NULLIF(v_field->>''acres_to_treat'','''')::numeric, 0)' IN v_src) = 0 THEN",
      postflightTo: "  IF false THEN -- runtime A3 mutant bypasses only blank static postflight",
      expect: "A3 FAIL",
    },
    {
      name: "inherited nonblank finite guard disabled",
      from: "     WHERE NOT (COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0) >= 0\n                AND COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0) < 'Infinity'::numeric)",
      to: "     WHERE false",
      expect: "A4 FAIL",
    },
  ];
  for (const mutant of mutants) {
    let changed = replaceExact(migration, mutant.from, mutant.to, mutant.name);
    if (mutant.postflightFrom) {
      changed = replaceExact(changed, mutant.postflightFrom, mutant.postflightTo, `${mutant.name} postflight bypass`);
    }
    changed = repinBody(changed, mutant.name);
    const mutantPath = join(scratch, "mutant.sql");
    writeFileSync(mutantPath, changed, "utf8");
    copyIn(mutantPath, "/tmp/mutant.sql");
    rebuild(mutant.name);
    result = psqlMigration("/tmp/mutant.sql");
    if (!result.ok) fail(`${mutant.name}: mutant never installed`, result.out);
    result = psqlFile("/tmp/tests.sql", false);
    if (!result.out.includes(mutant.expect)) {
      fail(`${mutant.name}: expected ${mutant.expect}`, result.out);
    }
    log(`MUTATION OK  ${mutant.name} -> ${mutant.expect}`);
  }

  rebuild("final");
  result = psqlMigration("/tmp/candidate.sql");
  if (!result.ok) fail("final clean apply failed", result.out);
  result = psqlFile("/tmp/tests.sql");
  if (!result.ok) fail("final clean A1-A4 failed", result.out);
  cleanup();
  log("ALL PHASES PASSED: 2 preflight drift refusals, exact pins, apply/replay/hotfix refusal, A1-A4, 11 apply-abort mutations, 4 runtime break-it canaries.");
} catch (error) {
  cleanup();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
