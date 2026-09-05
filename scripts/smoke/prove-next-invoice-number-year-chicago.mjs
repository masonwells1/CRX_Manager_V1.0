#!/usr/bin/env node
// Container proof for supabase/migrations/20260905090000_next_invoice_number_year_chicago.sql
//
// Runs the real migration against a throwaway PostgreSQL 17 container holding a
// minimal stand-in for the live objects the function touches, and proves:
//
//   1. the reviewed starting body reproduces the pinned live md5
//      (b53499d077bd84b78a6f8fec142741bc) — so the pin is not fiction
//   2. the migration APPLIES on that body and the result matches the candidate
//      pin (7cbf50ddfe3abda50cc241f3374e98a3)
//   3. SECURITY DEFINER, search_path and the EXECUTE ACL survive the re-emit
//   4. a REPLAY is idempotent (the file accepts its own output)
//   5. a DRIFTED body is REFUSED with nothing changed
//   6. the behaviour actually changes: at 2026-12-31 23:30 UTC the old
//      expression yields 2027 and the new one yields 2026
//
// Read-only with respect to production: this never touches Supabase.
// Usage: node scripts/smoke/prove-next-invoice-number-year-chicago.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const MIGRATION = path.join(REPO, "supabase", "migrations", "20260905090000_next_invoice_number_year_chicago.sql");

const LIVE_MD5 = "b53499d077bd84b78a6f8fec142741bc";
const CANDIDATE_MD5 = "7cbf50ddfe3abda50cc241f3374e98a3";
// pronargs/pronargdefaults/default-expression, read read-only from live pg_proc
// on 2026-09-05. md5(prosrc) is blind to all three — see step 0.
const LIVE_SIGNATURE = "1/1/'field_application'::text";
const CONTAINER = `crx-nin-proof-${process.pid}`;
const IMAGE = "postgres:17-alpine";

let failures = 0;
const ok = (cond, label) => {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
};

const docker = (args, opts = {}) =>
  execFileSync("docker", args, { encoding: "utf8", ...opts });

// psql inside the container. Returns stdout; throws on non-zero exit.
const psql = (sql, { tuples = true } = {}) =>
  docker([
    "exec", "-i", CONTAINER,
    "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    ...(tuples ? ["-t", "-A"] : []),
    "-c", sql,
  ]).trim();

const psqlFile = (containerPath) =>
  docker([
    "exec", "-i", CONTAINER,
    "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-f", containerPath,
  ]);

// The reviewed LIVE body, transcribed from pg_proc.prosrc on 2026-09-05.
// Step 1 proves this text hashes to the pinned live md5.
const LIVE_BODY = `
DECLARE
  v_actor uuid;
  v_year text := extract(year FROM now())::text;
  v_seq int;
  v_max int;
  v_prefix text;
  v_sequence regclass;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  CASE p_invoice_type
    WHEN 'chemical_sale' THEN
      v_prefix := 'CS';
      v_sequence := 'public.cs_invoice_number_seq'::regclass;
    WHEN 'misc_charge' THEN
      v_prefix := 'MC';
      v_sequence := 'public.mc_invoice_number_seq'::regclass;
    WHEN 'credit_memo' THEN
      v_prefix := 'CM';
      v_sequence := 'public.cm_invoice_number_seq'::regclass;
    ELSE
      v_prefix := 'INV';
      v_sequence := 'public.invoice_number_seq'::regclass;
  END CASE;

  PERFORM pg_advisory_xact_lock(hashtext('invoice_number:' || v_prefix || ':' || v_year));

  SELECT COALESCE(MAX(regexp_replace(invoice_number, '^' || v_prefix || '-[0-9]{4}-', '')::integer), 0)
    INTO v_max
    FROM public.invoices
   WHERE invoice_number ~ ('^' || v_prefix || '-' || v_year || '-[0-9]+$');

  v_seq := nextval(v_sequence);
  IF v_seq <= v_max THEN
    PERFORM setval(v_sequence, v_max, true);
    v_seq := nextval(v_sequence);
  END IF;

  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END;
`;

const SETUP = `
CREATE ROLE service_role;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true,
  role text NOT NULL
);
INSERT INTO public.profiles (id, is_active, role)
VALUES ('11111111-1111-1111-1111-111111111111', true, 'admin');

CREATE TABLE public.invoices (invoice_number text);

CREATE SEQUENCE public.invoice_number_seq;
CREATE SEQUENCE public.cs_invoice_number_seq;
CREATE SEQUENCE public.mc_invoice_number_seq;
CREATE SEQUENCE public.cm_invoice_number_seq;
`;

// The DEFAULT is part of the live declaration (pg_proc: pronargs 1,
// pronargdefaults 1, default 'field_application'::text) and MUST be reproduced
// here. An earlier version of this harness omitted it — the same omission the
// migration itself had — so the container agreed with the mistake and the proof
// came back green on a migration that could never have applied. A mock that
// reproduces the bug under test proves nothing. Step 0 now asserts the setup
// matches the live signature before anything else runs.
// `grants: false` reproduces a function that nobody ever revoked or granted on, so
// pg_proc.proacl stays NULL. That is not "no privileges" — NULL means DEFAULT
// privileges, and the default for a function is EXECUTE TO PUBLIC. Step 7 uses it to
// prove the postflight refuses that state.
function installLiveBody({ grants = true } = {}) {
  const sql = `
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_invoice_type text DEFAULT 'field_application'::text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$${LIVE_BODY}$fn$;
${grants ? `REVOKE ALL ON FUNCTION public.next_invoice_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_invoice_number(text) TO service_role;` : ""}

-- invoices.invoice_number defaults through the function on live; reproducing that
-- dependency means a DROP FUNCTION "repair" would fail here exactly as it would
-- on production.
ALTER TABLE public.invoices
  ALTER COLUMN invoice_number SET DEFAULT next_invoice_number('field_application'::text);
`;
  psqlFile(writeTmp("install-live.sql", sql));
}

function signature() {
  return psql(
    "SELECT p.pronargs || '/' || p.pronargdefaults || '/' || COALESCE(pg_get_expr(p.proargdefaults, 0::oid), '(none)') " +
    "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
    "WHERE n.nspname='public' AND p.proname='next_invoice_number'",
  );
}

let scratch;
function writeTmp(name, contents) {
  const hostPath = path.join(scratch, name);
  writeFileSync(hostPath, contents);
  docker(["cp", hostPath, `${CONTAINER}:/tmp/${name}`]);
  return `/tmp/${name}`;
}

function bodyMd5() {
  return psql(
    "SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
    "WHERE n.nspname='public' AND p.proname='next_invoice_number'",
  );
}

function main() {
  scratch = mkdtempSync(path.join(tmpdir(), "crx-nin-proof-"));
  console.log(`\nContainer proof: 20260905090000_next_invoice_number_year_chicago\n`);

  console.log("Starting throwaway PostgreSQL 17...");
  docker(["run", "--rm", "-d", "--name", CONTAINER,
          "-e", "POSTGRES_PASSWORD=proof", IMAGE], { stdio: "pipe" });

  // Wait for readiness (synchronous sleep between probes).
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
  sleep(500); // pg_isready can report up a beat before it accepts connections

  psqlFile(writeTmp("setup.sql", SETUP));
  installLiveBody();

  console.log("\n0. The harness itself matches live (guards against a mock that agrees with the bug)");
  const setupSig = signature();
  ok(setupSig === LIVE_SIGNATURE,
     `setup signature ${setupSig} === live pronargs/pronargdefaults/default ${LIVE_SIGNATURE}`);

  console.log("\n1. The pin is real — the reviewed body reproduces the live md5");
  const installed = bodyMd5();
  ok(installed === LIVE_MD5, `installed body md5 ${installed} === live pin ${LIVE_MD5}`);

  console.log("\n2. The migration applies, and the result matches the candidate pin");
  const migrationSql = readFileSync(MIGRATION, "utf8");
  psqlFile(writeTmp("migration.sql", migrationSql));
  const afterApply = bodyMd5();
  ok(afterApply === CANDIDATE_MD5, `body md5 ${afterApply} === candidate pin ${CANDIDATE_MD5}`);
  ok(psql("SELECT prosrc LIKE '%America/Chicago%' FROM pg_proc WHERE proname='next_invoice_number'") === "t",
     "installed body now derives the year from America/Chicago");
  ok(psql("SELECT prosrc LIKE '%extract(year FROM now())%' FROM pg_proc WHERE proname='next_invoice_number'") === "f",
     "the bare now() year derivation is gone");

  console.log("\n3. Security properties survived the re-emit");
  ok(psql("SELECT prosecdef FROM pg_proc WHERE proname='next_invoice_number'") === "t",
     "SECURITY DEFINER preserved");
  ok(psql("SELECT proconfig::text FROM pg_proc WHERE proname='next_invoice_number'")
       === '{"search_path=public, pg_temp"}',
     "search_path = public, pg_temp preserved");
  ok(psql("SELECT proacl::text FROM pg_proc WHERE proname='next_invoice_number'")
       === "{postgres=X/postgres,service_role=X/postgres}",
     "EXECUTE ACL unchanged (postgres + service_role only; not anon/authenticated)");
  ok(psql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace " +
          "WHERE n.nspname='public' AND p.proname='next_invoice_number'") === "1",
     "still exactly ONE overload — no accidental fork");
  const sigAfter = signature();
  ok(sigAfter === LIVE_SIGNATURE, `signature preserved: ${sigAfter} (the parameter DEFAULT survives)`);
  ok(psql("SELECT next_invoice_number() LIKE 'INV-%'") === "t",
     "a ZERO-ARGUMENT call still resolves — live callers depend on the default");

  console.log("\n4. Replay is idempotent (the file accepts its own output)");
  let replayed = true;
  try { psqlFile("/tmp/migration.sql"); } catch { replayed = false; }
  ok(replayed, "re-running the migration succeeds");
  ok(bodyMd5() === CANDIDATE_MD5, "body unchanged after replay");

  console.log("\n5. A drifted body is REFUSED with nothing changed");
  // The drift fixture keeps the parameter DEFAULT: PostgreSQL refuses to remove one
  // via CREATE OR REPLACE, so a fixture without it cannot even install. (That refusal
  // is exactly the blocker this harness originally hid by omitting the default in its
  // own setup.)
  psqlFile(writeTmp("drift.sql", `
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_invoice_type text DEFAULT 'field_application'::text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  RETURN 'DRIFTED-' || p_invoice_type;
END;
$fn$;`));
  const driftedMd5 = bodyMd5();
  let refused = false;
  let refusalMessage = "";
  try {
    psqlFile("/tmp/migration.sql");
  } catch (error) {
    refused = true;
    refusalMessage = String(error.stderr || error.message || "");
  }
  ok(refused, "the migration REFUSES to run against a drifted body");
  ok(/DRIFTED/i.test(refusalMessage), "the refusal names drift as the reason");
  ok(bodyMd5() === driftedMd5, "the drifted body is left untouched (transaction rolled back)");

  console.log("\n6. The behaviour actually changes inside the divergence window");
  // December is CST (UTC-6), so midnight UTC on 1 Jan is 6 pm Chicago on 31 Dec.
  // The window where the two disagree is 00:00-06:00 UTC on 1 January.
  // 02:00 UTC = 2026-12-31 20:00 Chicago.
  const INSTANT = "timestamptz '2027-01-01 02:00:00+00'";
  const chicagoLocal = psql(`SELECT (${INSTANT} AT TIME ZONE 'America/Chicago')::text`);
  const utcYear = psql(`SELECT extract(year FROM (${INSTANT} AT TIME ZONE 'UTC'))::text`);
  const chiYear = psql(`SELECT extract(year FROM (${INSTANT} AT TIME ZONE 'America/Chicago')::date)::text`);
  ok(chicagoLocal === "2026-12-31 20:00:00", `02:00 UTC is ${chicagoLocal} in Chicago — still 31 December`);
  ok(utcYear === "2027", `the OLD expression yields ${utcYear} there (the bug: a 2027 invoice number)`);
  ok(chiYear === "2026", `the NEW expression yields ${chiYear} there (the fix)`);

  // Guard against a false-green window: outside it, both must agree.
  const OUTSIDE = "timestamptz '2026-12-31 23:30:00+00'";
  const utcOutside = psql(`SELECT extract(year FROM (${OUTSIDE} AT TIME ZONE 'UTC'))::text`);
  const chiOutside = psql(`SELECT extract(year FROM (${OUTSIDE} AT TIME ZONE 'America/Chicago')::date)::text`);
  ok(utcOutside === "2026" && chiOutside === "2026",
     `outside the window (23:30 UTC on 31 Dec) both agree on ${utcOutside} — the fix is narrow`);

  console.log("\n7. The EXECUTE-privilege assertion actually FIRES (mutation test)");
  // A guard nobody has watched refuse anything is not a proven guard. Codex found the
  // first version of this assertion fail-open on a NULL ACL; these three mutations make
  // the refusal observable instead of assumed.
  installLiveBody();
  ok(bodyMd5() === LIVE_MD5, "starting body restored to the reviewed live body (step 5 left a drifted one)");

  // 7a — EXECUTE granted DIRECTLY to anon.
  psqlFile(writeTmp("grant-anon.sql", `
CREATE ROLE anon;
GRANT EXECUTE ON FUNCTION public.next_invoice_number(text) TO anon;`));
  let anonRefused = false;
  let anonMessage = "";
  try {
    psqlFile("/tmp/migration.sql");
  } catch (error) {
    anonRefused = true;
    anonMessage = String(error.stderr || error.message || "");
  }
  ok(anonRefused, "the migration REFUSES to apply while anon holds EXECUTE directly");
  ok(/anon holds EXECUTE/i.test(anonMessage), "the refusal names anon as the holder");
  ok(bodyMd5() === LIVE_MD5, "the body is left untouched (transaction rolled back)");

  // 7b — EXECUTE reaching anon INDIRECTLY through role membership. The ACL string
  // never mentions anon, so the old text match could not have seen this at all.
  psqlFile(writeTmp("grant-indirect.sql", `
REVOKE EXECUTE ON FUNCTION public.next_invoice_number(text) FROM anon;
CREATE ROLE reporting_reader;
GRANT reporting_reader TO anon;
GRANT EXECUTE ON FUNCTION public.next_invoice_number(text) TO reporting_reader;`));
  const indirectAcl = psql("SELECT proacl::text FROM pg_proc WHERE proname='next_invoice_number'");
  ok(!/anon=/.test(indirectAcl),
     `the ACL string does NOT mention anon (${indirectAcl}) — a text match would miss this`);
  let indirectRefused = false;
  let indirectMessage = "";
  try {
    psqlFile("/tmp/migration.sql");
  } catch (error) {
    indirectRefused = true;
    indirectMessage = String(error.stderr || error.message || "");
  }
  ok(indirectRefused, "the migration REFUSES when anon reaches EXECUTE through role membership");
  ok(/anon holds EXECUTE/i.test(indirectMessage), "the refusal still names anon");

  // 7c — a NULL proacl. This is the exact state the earlier `v_acl IS NOT NULL` guard
  // skipped, and it is the most open one PostgreSQL has.
  psqlFile(writeTmp("null-acl.sql", `
ALTER TABLE public.invoices ALTER COLUMN invoice_number DROP DEFAULT;
DROP FUNCTION public.next_invoice_number(text);`));
  installLiveBody({ grants: false });
  const nullAcl = psql("SELECT COALESCE(proacl::text, '(NULL)') FROM pg_proc WHERE proname='next_invoice_number'");
  ok(nullAcl === "(NULL)", "a function nobody granted on has a NULL ACL");
  ok(psql("SELECT has_function_privilege('anon', p.oid, 'EXECUTE')::text FROM pg_proc p " +
          "WHERE p.proname='next_invoice_number'") === "true",
     "anon really CAN execute it in that state — NULL means EXECUTE TO PUBLIC, not 'no grants'");
  let nullRefused = false;
  let nullMessage = "";
  try {
    psqlFile("/tmp/migration.sql");
  } catch (error) {
    nullRefused = true;
    nullMessage = String(error.stderr || error.message || "");
  }
  ok(nullRefused, "the migration REFUSES to apply against a NULL ACL");
  ok(/proacl is NULL/i.test(nullMessage), "the refusal names the NULL ACL as the reason");

  console.log(`\n${failures === 0 ? "NEXT_INVOICE_NUMBER_YEAR_CHICAGO_PROOF_PASS" : `PROOF FAILED — ${failures} check(s)`}\n`);
}

try {
  main();
} finally {
  try { docker(["rm", "-f", CONTAINER], { stdio: "pipe" }); } catch { /* already gone */ }
  if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
}

process.exit(failures === 0 ? 0 : 1);
