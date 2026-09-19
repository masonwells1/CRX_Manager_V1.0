#!/usr/bin/env node
// Container proof for supabase/migrations/20260908140000_number_generators_year_chicago.sql
// (issue #617: six next_*_number generators stamp the UTC year, not the Chicago year).
//
// Runs the real migration against a throwaway PostgreSQL 17 container holding a
// minimal stand-in for the live objects the six functions touch, and proves:
//
//   0. the harness matches live: each LIVE body is derived from the migration's
//      candidate body by reversing its one year line, and must hash to the live
//      md5 pinned in the file (read read-only from pg_proc.prosrc on 2026-09-19) —
//      so the migration's bodies are a byte-exact transcription of live apart from
//      that one line, and the pins are not fiction
//   1. the file passes assertWrappable(), the only sanctioned apply door
//   2. the migration applies and each result matches its candidate pin
//   3. SECURITY DEFINER, search_path, owner, signature and every EXECUTE ACL
//      (which differ per function) survive the re-emit
//   4. a replay is idempotent
//   5. a drifted body, a stripped search_path, a SECURITY INVOKER body, a changed
//      owner, a second overload, a changed signature, and a changed volatility,
//      strictness or cost are each REFUSED
//   6. behaviour: each REAL body, with its clock pinned to 2029-01-01 02:00 UTC
//      (= 2028-12-31 20:00 Chicago), returns a 2029 number before the fix and a
//      2028 number after it; outside the window both agree; numbering continues
//      from the existing MAX for the year
//   7. the ACL assertions actually FIRE (mutations): anon direct, anon indirect,
//      NULL ACL, a third-party grantee, authenticated added to a server-only
//      generator, authenticated removed from a browser-called one, service_role
//      removed, a grant option on an expected grantee, and a missing
//      service_role or authenticated role (refused, never skipped)
//
// Read-only with respect to production: this never touches Supabase.
// Usage: node scripts/smoke/prove-number-generators-year-chicago.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWrappable } from "../../.claude/hooks/migration-wrappability-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const MIGRATION_NAME = "20260908140000_number_generators_year_chicago";
const MIGRATION = path.join(REPO, "supabase", "migrations", `${MIGRATION_NAME}.sql`);
const CONTAINER = `crx-ngy-proof-${process.pid}`;
// Pinned by digest so a recorded result is reproducible (PostgreSQL patch level,
// Alpine base and tzdata cannot drift between runs). postgres:17-alpine as of 2026-09-19.
const IMAGE = "postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";

const CHICAGO = "(now() AT TIME ZONE 'America/Chicago')::date";

// Live facts, read read-only from pg_proc on 2026-09-19.
const FUNCTIONS = [
  {
    name: "next_application_record_number", table: "application_records", column: "record_number",
    prefix: "APP", width: 4, browser: false,
    liveMd5: "4d26d0ee0176d8e6b630314c34b1cc4e", candidateMd5: "9bf10abef4830cd6b0ee3aea41c07469",
    oldLine: "v_year := extract(year FROM current_date)::text;",
    newLine: `v_year := extract(year FROM ${CHICAGO})::text;`,
  },
  {
    name: "next_commission_payment_number", table: "commission_payments", column: "payment_number",
    prefix: "CP", width: 4, browser: false,
    liveMd5: "6d4208fe79a2b021fd9752e862266f45", candidateMd5: "3f876d7588865bccd77b9b4a384ab8d7",
    oldLine: "v_year := to_char(CURRENT_DATE, 'YYYY');",
    newLine: `v_year := to_char(${CHICAGO}, 'YYYY');`,
  },
  {
    name: "next_cycle_count_number", table: "cycle_counts", column: "count_number",
    prefix: "CC", width: 5, browser: true,
    liveMd5: "2bce8cb943a36951bc605ed55f2636df", candidateMd5: "d6626bf1550a996716f4188c407975d4",
    oldLine: "v_year := EXTRACT(YEAR FROM CURRENT_DATE)::text;",
    newLine: `v_year := EXTRACT(YEAR FROM ${CHICAGO})::text;`,
  },
  {
    name: "next_job_number", table: "jobs", column: "job_number",
    prefix: "JOB", width: 4, browser: true,
    liveMd5: "183721b3349f15162c068f58e2877b5d", candidateMd5: "b97a23c4ba96e772278e063111d3ebf6",
    oldLine: "v_year := extract(year FROM current_date)::text;",
    newLine: `v_year := extract(year FROM ${CHICAGO})::text;`,
  },
  {
    name: "next_po_number", table: "purchase_orders", column: "po_number",
    prefix: "PO", width: 4, browser: false,
    liveMd5: "448fc5d0dbfbba0a8ae11b96e4ee9fcb", candidateMd5: "0fd0c7861511a67d5dbe12069914d7f9",
    oldLine: "v_year := extract(year FROM current_date)::text;",
    newLine: `v_year := extract(year FROM ${CHICAGO})::text;`,
  },
  {
    name: "next_return_number", table: "returns", column: "return_number",
    prefix: "RMA", width: 4, browser: false,
    liveMd5: "8e8acd85a14248cfeccfd7cc5a047c29", candidateMd5: "0c5ab61fc8293ac2be8670289528d9c2",
    oldLine: "v_year := extract(year FROM current_date)::text;",
    newLine: `v_year := extract(year FROM ${CHICAGO})::text;`,
  },
];

const liveAcl = (fn) => (fn.browser
  ? "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}"
  : "{postgres=X/postgres,service_role=X/postgres}");

let failures = 0;
const ok = (cond, label) => {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
};

const docker = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", ...opts });

const psql = (sql) =>
  docker(["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
          "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]).trim();

const psqlFile = (containerPath) =>
  docker(["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
          "-v", "ON_ERROR_STOP=1", "-f", containerPath], { stdio: "pipe" });

let scratch;
function writeTmp(name, contents) {
  const hostPath = path.join(scratch, name);
  writeFileSync(hostPath, contents);
  docker(["cp", hostPath, `${CONTAINER}:/tmp/${name}`]);
  return `/tmp/${name}`;
}

// Runs the migration and reports whether it was refused, and with what message.
function applyMigration() {
  try {
    psqlFile("/tmp/migration.sql");
    return { refused: false, message: "" };
  } catch (error) {
    return { refused: true, message: String(error.stderr || error.message || "") };
  }
}

const fnRow = (name, expr) => psql(
  `SELECT ${expr} FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ` +
  `WHERE n.nspname = 'public' AND p.proname = '${name}'`,
);
const bodyMd5 = (name) => fnRow(name, "md5(p.prosrc)");
const allMd5s = () => FUNCTIONS.map((fn) => bodyMd5(fn.name)).join(",");

// Pulls each candidate body out of the migration: the text between `AS $fn$` and
// `$fn$;` that follows that function's CREATE OR REPLACE.
function extractCandidateBodies(sql) {
  const bodies = {};
  for (const fn of FUNCTIONS) {
    const head = `CREATE OR REPLACE FUNCTION public.${fn.name}()`;
    const at = sql.indexOf(head);
    if (at < 0) throw new Error(`${fn.name}: CREATE OR REPLACE not found in the migration`);
    const open = sql.indexOf("AS $fn$", at) + "AS $fn$".length;
    const close = sql.indexOf("$fn$;", open);
    bodies[fn.name] = sql.slice(open, close);
  }
  return bodies;
}

const HEADER = (name) => `CREATE OR REPLACE FUNCTION public.${name}()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$`;

function grantsFor(fn) {
  const sig = `public.${fn.name}()`;
  return [
    // Revoke from every role a mutation step may touch, so grant options and
    // stray grants never leak from one step into the next.
    `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`,
    // Grant order fixes the ACL string order; live lists authenticated before service_role.
    ...(fn.browser ? [`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`] : []),
    `GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`,
  ].join("\n");
}

// Installs the six LIVE bodies with their live grants. `nullAclFor` names one
// function to install with no REVOKE/GRANT at all, so its proacl stays NULL.
function installLiveBodies(liveBodies, { nullAclFor = null } = {}) {
  const parts = [];
  for (const fn of FUNCTIONS) {
    if (fn.name === nullAclFor) parts.push(`DROP FUNCTION IF EXISTS public.${fn.name}();`);
    parts.push(`${HEADER(fn.name)}${liveBodies[fn.name]}$fn$;`);
    if (fn.name !== nullAclFor) parts.push(grantsFor(fn));
  }
  psqlFile(writeTmp("install-live.sql", parts.join("\n\n")));
}

const SETUP = `
CREATE ROLE service_role;
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true, role text NOT NULL);
INSERT INTO public.profiles VALUES ('11111111-1111-1111-1111-111111111111', true, 'admin');
${FUNCTIONS.map((fn) => `CREATE TABLE public.${fn.table} (${fn.column} text);`).join("\n")}
`;

// Evaluates a body with its clock pinned: installs a scratch copy under another name
// whose only difference is the clock expression, calls it, and drops it.
function callAtInstant(fn, body, instant) {
  const pinned = body
    .replaceAll("now()", `timestamptz '${instant}'`)
    .replaceAll("current_date", `(timestamptz '${instant}' AT TIME ZONE 'UTC')::date`)
    .replaceAll("CURRENT_DATE", `(timestamptz '${instant}' AT TIME ZONE 'UTC')::date`);
  const scratchName = `proof_${fn.name}`;
  psqlFile(writeTmp("pinned.sql", `${HEADER(scratchName)}${pinned}$fn$;`));
  const result = psql(`SELECT public.${scratchName}()`);
  psql(`DROP FUNCTION public.${scratchName}()`);
  return result;
}

const pad = (fn, n) => String(n).padStart(fn.width, "0");

function main() {
  scratch = mkdtempSync(path.join(tmpdir(), "crx-ngy-proof-"));
  console.log(`\nContainer proof: ${MIGRATION_NAME}\n`);

  const migrationSql = readFileSync(MIGRATION, "utf8");
  ok(!migrationSql.includes("\r"), "the migration file on disk is LF-only (a CR would break every md5 pin)");

  const candidateBodies = extractCandidateBodies(migrationSql);
  const liveBodies = {};
  for (const fn of FUNCTIONS) {
    const body = candidateBodies[fn.name];
    ok(body.split(fn.newLine).length === 2, `${fn.name}: candidate body holds the Chicago year line exactly once`);
    liveBodies[fn.name] = body.replace(fn.newLine, fn.oldLine);
  }

  console.log("Starting throwaway PostgreSQL 17...");
  docker(["run", "--rm", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=proof", IMAGE], { stdio: "pipe" });
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      docker(["exec", CONTAINER, "pg_isready", "-U", "postgres"], { stdio: "pipe" });
      ready = true;
    } catch {
      sleep(1000);
    }
  }
  if (!ready) throw new Error("PostgreSQL container never became ready");
  sleep(1500);

  psqlFile(writeTmp("setup.sql", SETUP));
  installLiveBodies(liveBodies);

  console.log("\n0. The harness matches live — each derived live body reproduces the live md5 pin");
  for (const fn of FUNCTIONS) {
    ok(bodyMd5(fn.name) === fn.liveMd5, `${fn.name}: installed live body md5 === live pin ${fn.liveMd5}`);
    ok(fnRow(fn.name, "p.proacl::text") === liveAcl(fn), `${fn.name}: harness ACL matches live ${liveAcl(fn)}`);
  }

  console.log("\n1. The file passes the only sanctioned apply door");
  let wrappable = true;
  let wrappableReason = "";
  try {
    assertWrappable(migrationSql, MIGRATION_NAME);
  } catch (error) {
    wrappable = false;
    wrappableReason = String(error.message || error);
  }
  ok(wrappable, `assertWrappable accepts the file${wrappable ? "" : ` — ${wrappableReason}`}`);

  // Applied through the wrapped shape the real applier uses.
  writeTmp("migration.sql", `BEGIN;\n${migrationSql}\nCOMMIT;\n`);

  // The pinned instants are in 2028/2029 on purpose: neither expected year is the
  // year this prover runs in, so a clock substitution that silently missed would
  // read the real clock and FAIL rather than pass by coincidence.
  console.log("\n6a. BEFORE the fix, the real live bodies mint next year's number at 20:00 Chicago on 31 Dec");
  const INSIDE = "2029-01-01 02:00:00+00";
  const OUTSIDE = "2028-12-31 23:30:00+00";
  ok(psql(`SELECT (timestamptz '${INSIDE}' AT TIME ZONE 'America/Chicago')::text`) === "2028-12-31 20:00:00",
     `${INSIDE} is 2028-12-31 20:00 in Chicago`);
  for (const fn of FUNCTIONS) {
    const got = callAtInstant(fn, liveBodies[fn.name], INSIDE);
    ok(got === `${fn.prefix}-2029-${pad(fn, 1)}`, `${fn.name} (live body): ${got} — the bug`);
  }

  console.log("\n2. The migration applies, and each result matches its candidate pin");
  const applied = applyMigration();
  ok(!applied.refused, `the migration applies${applied.refused ? ` — ${applied.message}` : ""}`);
  for (const fn of FUNCTIONS) {
    ok(bodyMd5(fn.name) === fn.candidateMd5, `${fn.name}: body md5 === candidate pin ${fn.candidateMd5}`);
    ok(fnRow(fn.name, "p.prosrc ~* 'current_date'") === "f", `${fn.name}: no UTC CURRENT_DATE left in the body`);
  }

  console.log("\n3. Security properties and signatures survived the re-emit");
  for (const fn of FUNCTIONS) {
    ok(fnRow(fn.name, "count(*)") === "1", `${fn.name}: still exactly ONE overload`);
    ok(fnRow(fn.name, "p.pronargs") === "0", `${fn.name}: still takes no arguments`);
    ok(fnRow(fn.name, "p.prosecdef") === "t", `${fn.name}: SECURITY DEFINER preserved`);
    ok(fnRow(fn.name, "p.proconfig::text") === '{"search_path=public, pg_temp"}', `${fn.name}: search_path preserved`);
    ok(fnRow(fn.name, "p.proowner::regrole::text") === "postgres", `${fn.name}: owner is postgres`);
    ok(fnRow(fn.name, "p.proacl::text") === liveAcl(fn), `${fn.name}: ACL unchanged (${liveAcl(fn)})`);
  }

  console.log("\n6b. AFTER the fix, the same instant mints the Chicago year; outside the window both agree");
  for (const fn of FUNCTIONS) {
    const inside = callAtInstant(fn, candidateBodies[fn.name], INSIDE);
    ok(inside === `${fn.prefix}-2028-${pad(fn, 1)}`, `${fn.name} (fixed body) at 20:00 Chicago 31 Dec: ${inside}`);
    const before = callAtInstant(fn, liveBodies[fn.name], OUTSIDE);
    const after = callAtInstant(fn, candidateBodies[fn.name], OUTSIDE);
    ok(before === after && after === `${fn.prefix}-2028-${pad(fn, 1)}`,
       `${fn.name} outside the window (17:30 Chicago 31 Dec): old ${before} === new ${after}`);
  }

  console.log("\n6c. Numbering continues from the year's existing MAX (the real installed functions)");
  const year = psql("SELECT extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text");
  for (const fn of FUNCTIONS) {
    psql(`INSERT INTO public.${fn.table} (${fn.column}) VALUES ` +
         `('${fn.prefix}-${year}-${pad(fn, 41)}'), ('${fn.prefix}-${Number(year) - 1}-${pad(fn, 900)}')`);
    const got = psql(`SELECT public.${fn.name}()`);
    ok(got === `${fn.prefix}-${year}-${pad(fn, 42)}`, `${fn.name}(): ${got} (follows ${fn.prefix}-${year}-${pad(fn, 41)}, ignores last year)`);
  }

  console.log("\n4. Replay is idempotent");
  const replay = applyMigration();
  ok(!replay.refused, `re-running the migration succeeds${replay.refused ? ` — ${replay.message}` : ""}`);
  ok(FUNCTIONS.every((fn) => bodyMd5(fn.name) === fn.candidateMd5), "all six bodies unchanged after replay");

  console.log("\n5. Drift is REFUSED with nothing changed");
  // 5a — one drifted body.
  psqlFile(writeTmp("drift.sql", `${HEADER("next_po_number")}\nBEGIN\n  RETURN 'DRIFTED';\nEND;\n$fn$;`));
  let before = allMd5s();
  let result = applyMigration();
  ok(result.refused && /next_po_number: installed body has DRIFTED/.test(result.message),
     "a drifted next_po_number body is refused, and the refusal names it");
  ok(allMd5s() === before, "no function changed (the whole transaction rolled back)");
  installLiveBodies(liveBodies);

  // 5b — search_path stripped out of band.
  psql("ALTER FUNCTION public.next_job_number() RESET search_path");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_job_number: the LIVE search_path/.test(result.message),
     "a stripped search_path is refused rather than silently repaired");
  ok(allMd5s() === before, "no function changed");
  installLiveBodies(liveBodies);

  // 5c — downgraded to SECURITY INVOKER out of band.
  psql("ALTER FUNCTION public.next_return_number() SECURITY INVOKER");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_return_number: the LIVE function is not SECURITY DEFINER/.test(result.message),
     "a SECURITY INVOKER body is refused rather than silently repaired");
  ok(allMd5s() === before, "no function changed");
  installLiveBodies(liveBodies);

  // 5d — owner changed out of band.
  psql("CREATE ROLE other_owner; ALTER FUNCTION public.next_cycle_count_number() OWNER TO other_owner");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_cycle_count_number: owner is other_owner/.test(result.message),
     "a changed owner is refused");
  ok(allMd5s() === before, "no function changed");
  psql("ALTER FUNCTION public.next_cycle_count_number() OWNER TO postgres");

  // 5e — a second overload beside the reviewed one.
  psql("CREATE FUNCTION public.next_job_number(p_x integer) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_job_number: expected exactly 1 overload, found 2/.test(result.message),
     "a second overload is refused");
  ok(allMd5s() === before, "no function changed");
  psql("DROP FUNCTION public.next_job_number(integer)");

  // 5f — the only overload now takes an argument.
  psql("DROP FUNCTION public.next_po_number(); " +
       "CREATE FUNCTION public.next_po_number(p_x integer) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_po_number: live signature has 1 arguments, expected 0/.test(result.message),
     "a changed signature is refused");
  ok(allMd5s() === before, "no function changed");
  psql("DROP FUNCTION public.next_po_number(integer)");
  installLiveBodies(liveBodies);

  // 5g — volatility changed out of band.
  psql("ALTER FUNCTION public.next_application_record_number() STABLE");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_application_record_number: the LIVE function attributes are plpgsql\/s\//.test(result.message),
     "a changed volatility is refused");
  ok(allMd5s() === before, "no function changed");
  installLiveBodies(liveBodies);

  // 5h — strictness changed out of band (the re-emit would silently reset it).
  psql("ALTER FUNCTION public.next_commission_payment_number() STRICT");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_commission_payment_number: the LIVE function attributes are plpgsql\/v\/t\//.test(result.message),
     "a changed strictness is refused");
  ok(allMd5s() === before, "no function changed");
  installLiveBodies(liveBodies);
  psql("ALTER FUNCTION public.next_commission_payment_number() CALLED ON NULL INPUT");

  // 5i — cost changed out of band.
  psql("ALTER FUNCTION public.next_return_number() COST 5");
  before = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_return_number: the LIVE function attributes are plpgsql\/v\/f\/u\/f\/5\//.test(result.message),
     "a changed cost is refused");
  ok(allMd5s() === before, "no function changed");
  psql("ALTER FUNCTION public.next_return_number() COST 100");
  installLiveBodies(liveBodies);
  ok(FUNCTIONS.every((fn) => bodyMd5(fn.name) === fn.liveMd5), "starting state restored to the live bodies");
  ok(FUNCTIONS.every((fn) => fnRow(fn.name, "p.proacl::text") === liveAcl(fn)
                          && fnRow(fn.name, "p.provolatile") === "v"
                          && fnRow(fn.name, "p.proisstrict") === "f"
                          && fnRow(fn.name, "p.procost") === "100"
                          && fnRow(fn.name, "p.proowner::regrole::text") === "postgres"),
     "starting ACLs, volatility, strictness, cost and owners restored to live");

  console.log("\n7. The ACL assertions actually FIRE (mutation tests)");
  const expectRefusal = (setupSql, pattern, label) => {
    if (setupSql) psqlFile(writeTmp("mutation.sql", setupSql));
    const md5s = allMd5s();
    const r = applyMigration();
    ok(r.refused && pattern.test(r.message), `${label}${r.refused ? "" : " — NOT refused"}`);
    ok(allMd5s() === md5s, "  ...and nothing changed");
    installLiveBodies(liveBodies);
  };

  expectRefusal("GRANT EXECUTE ON FUNCTION public.next_job_number() TO anon;",
    /next_job_number: anon holds EXECUTE/, "7a anon granted EXECUTE directly on a browser-called generator");
  psql("REVOKE EXECUTE ON FUNCTION public.next_job_number() FROM anon");

  expectRefusal(`CREATE ROLE reporting_reader;
GRANT reporting_reader TO anon;
GRANT EXECUTE ON FUNCTION public.next_po_number() TO reporting_reader;`,
    /next_po_number: anon holds EXECUTE/, "7b anon reaching EXECUTE through role membership");
  psql("REVOKE EXECUTE ON FUNCTION public.next_po_number() FROM reporting_reader");
  psql("REVOKE reporting_reader FROM anon");

  installLiveBodies(liveBodies, { nullAclFor: "next_application_record_number" });
  ok(fnRow("next_application_record_number", "COALESCE(p.proacl::text, '(NULL)')") === "(NULL)",
     "a function nobody granted on has a NULL ACL");
  expectRefusal(null, /next_application_record_number: proacl is NULL/, "7c a NULL ACL (= EXECUTE TO PUBLIC)");

  expectRefusal("GRANT EXECUTE ON FUNCTION public.next_commission_payment_number() TO reporting_reader;",
    /next_commission_payment_number: EXECUTE is held by reporting_reader/, "7d a third-party grantee anon cannot reach");
  psql("REVOKE EXECUTE ON FUNCTION public.next_commission_payment_number() FROM reporting_reader");

  expectRefusal("GRANT EXECUTE ON FUNCTION public.next_return_number() TO authenticated;",
    /next_return_number: authenticated holds EXECUTE/, "7e authenticated added to a server-only generator");
  psql("REVOKE EXECUTE ON FUNCTION public.next_return_number() FROM authenticated");
  ok(FUNCTIONS.every((fn) => fnRow(fn.name, "p.proacl::text") === liveAcl(fn)),
     "every ACL is back to live before 7f/7g, so they test only their own mutation");

  expectRefusal("REVOKE EXECUTE ON FUNCTION public.next_cycle_count_number() FROM authenticated;",
    /next_cycle_count_number: authenticated LOST EXECUTE/, "7f authenticated removed from a browser-called generator");

  expectRefusal("REVOKE EXECUTE ON FUNCTION public.next_job_number() FROM service_role;",
    /next_job_number: service_role LOST EXECUTE/, "7g service_role removed");

  // 7h — a grant WITH GRANT OPTION to an expected grantee. Every role-level check
  // passes it; only the exact-ACL pin sees the asterisk.
  expectRefusal("GRANT EXECUTE ON FUNCTION public.next_po_number() TO service_role WITH GRANT OPTION;",
    /next_po_number: ACL is \{postgres=X\/postgres,service_role=X\*\/postgres\}/,
    "7h a grant option on service_role (invisible to the role checks)");

  // 7i — the service_role role does not exist. It must be REFUSED, not skipped.
  psqlFile(writeTmp("drop-service-role.sql",
    [...FUNCTIONS.map((fn) => `REVOKE ALL ON FUNCTION public.${fn.name}() FROM service_role;`),
     "DROP ROLE service_role;"].join("\n")));
  let md5s = allMd5s();
  result = applyMigration();
  ok(result.refused && /service_role LOST EXECUTE or does not exist/.test(result.message),
     "7i a missing service_role is refused, not skipped");
  ok(allMd5s() === md5s, "  ...and nothing changed");
  psql("CREATE ROLE service_role");
  installLiveBodies(liveBodies);

  // 7j — the authenticated role does not exist: the two browser-called
  // generators would be uncallable, so this is refused too.
  psqlFile(writeTmp("drop-authenticated.sql",
    [...FUNCTIONS.map((fn) => `REVOKE ALL ON FUNCTION public.${fn.name}() FROM authenticated;`),
     "DROP ROLE authenticated;"].join("\n")));
  md5s = allMd5s();
  result = applyMigration();
  ok(result.refused && /next_cycle_count_number: authenticated LOST EXECUTE or does not exist/.test(result.message),
     "7j a missing authenticated role is refused, not skipped");
  ok(allMd5s() === md5s, "  ...and nothing changed");
  psql("CREATE ROLE authenticated");
  installLiveBodies(liveBodies);
  ok(FUNCTIONS.every((fn) => fnRow(fn.name, "p.proacl::text") === liveAcl(fn)), "every ACL restored to live at the end");

  console.log(`\n${failures === 0 ? "NUMBER_GENERATORS_YEAR_CHICAGO_PROOF_PASS" : `PROOF FAILED — ${failures} check(s)`}\n`);
}

try {
  main();
} finally {
  try { docker(["rm", "-f", CONTAINER], { stdio: "pipe" }); } catch { /* already gone */ }
  if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
}

process.exit(failures === 0 ? 0 : 1);
