#!/usr/bin/env node
// Tests for actor-binding-check.mjs — the write-time half of the actor-forgery
// sweeps (predicates/actor-forgery.sql, predicates/actor-forgery-fin-audit.sql).
// Spawns the real hook with crafted Write-tool stdin payloads.
// Run: node .claude/hooks/actor-binding-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runHook(content, filePath = "supabase/migrations/20260807000000_test.sql") {
  const payload = { tool_input: { file_path: filePath, content } };
  return spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}
function isDeny(r) { return r.stdout.includes('"permissionDecision":"deny"'); }

// fn(body, params, security) — `security` goes in the attribute region between
// the closing paren and AS, exactly where SECURITY DEFINER really sits.
function fn(body, params = "p_performed_by uuid", security = "SECURITY DEFINER") {
  return `CREATE OR REPLACE FUNCTION public.test_fn(${params}) RETURNS jsonb LANGUAGE plpgsql ${security} SET search_path TO 'public', 'pg_temp' AS $function$\n${body}\n$function$;`;
}

const MUTATION = "INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);";
const BOUND = `
  v_actor := auth.uid();
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must equal auth.uid()';
  END IF;
  INSERT INTO financial_audit_log (actor_user_id) VALUES (v_actor);
`;

// ── scope: only migration .sql files ───────────────────────────────────────
let r = runHook(fn(MUTATION), "src/pages/Foo.tsx");
eq(r.status, 0, "non-migration file exits 0");
ok(!isDeny(r), "non-.sql file never denied (allowed)");

r = runHook(fn(MUTATION), "supabase/functions/send-email/index.sql");
ok(!isDeny(r), ".sql outside supabase/migrations/ is out of scope (allowed)");

r = runHook("");
ok(!isDeny(r), "empty content allowed");

// ── POSITIVE: the bug class this hook exists for ───────────────────────────
r = runHook(fn(MUTATION));
ok(isDeny(r), "SECDEF + mutation + p_performed_by with no ACTOR_MISMATCH is BLOCKED");
ok(r.stdout.includes("ACTOR BINDING VIOLATION"), "block message is labelled");
ok(r.stdout.includes("p_performed_by"), "block message names the forgeable parameter");
ok(r.stdout.includes("20260617171500"), "block message cites the link_blend_ticket_to_order fix");

// the other two actor-parameter shapes the live predicates key on
r = runHook(fn("UPDATE invoices SET paid_amount_cents = 0 WHERE created_by = p_actor_id;", "p_actor_id uuid"));
ok(isDeny(r), "p_actor* shaped parameter is blocked");

r = runHook(fn("DELETE FROM payments WHERE created_by = p_user_id;", "p_user_id uuid"));
ok(isDeny(r), "p_user* shaped parameter is blocked");

r = runHook(fn(MUTATION, "p_created_by uuid"));
ok(isDeny(r), "p_<anything>by shaped parameter is blocked");

// actor param buried among others, with a parenthesised type in the list
r = runHook(fn(MUTATION, "p_invoice_id uuid, p_amount numeric(12,2), p_performed_by uuid DEFAULT NULL::uuid"));
ok(isDeny(r), "actor param found among multiple params incl. a parenthesised type");

// IN mode keyword before the name must not hide the parameter
r = runHook(fn(MUTATION, "IN p_performed_by uuid"));
ok(isDeny(r), "leading IN mode keyword does not hide the actor parameter");

r = runHook(fn(MUTATION, '"p_performed_by" uuid'));
ok(isDeny(r), "a quoted actor parameter name remains visible after structural masking");

// two functions in one migration: the second one is the offender
r = runHook(
  fn(BOUND, "p_performed_by uuid").replace("test_fn", "good_fn") +
  "\n" +
  fn(MUTATION, "p_performed_by uuid").replace("test_fn", "bad_fn"),
);
ok(isDeny(r), "a later offending function in the same file is still caught");
ok(r.stdout.includes("bad_fn"), "the offending function is the one named");

// ── hardened SQL reader: comments, quotes, and fail-closed parsing ─────────
// PostgreSQL allows comments anywhere whitespace is allowed. Matching raw text
// missed a function when a comment sat between its name and parameter list.
r = runHook(fn(MUTATION).replace("public.test_fn(", "public.test_fn /* legal */ ("));
ok(isDeny(r), "a block comment between the function name and ( cannot hide the actor parameter");

r = runHook(fn(MUTATION).replace("public.test_fn(", "public.test_fn -- legal\n("));
ok(isDeny(r), "a line comment between the function name and ( cannot hide the actor parameter");

r = runHook(fn(MUTATION).replace("public.test_fn(", "public.test_fn /* outer /* inner */ still open */ ("));
ok(isDeny(r), "a nested block comment between the function name and ( is skipped to the right depth");

r = runHook(fn(MUTATION).replace(
  "CREATE OR REPLACE FUNCTION public.test_fn(",
  "CREATE /* c1 */ OR REPLACE FUNCTION /* c2 */ public.test_fn /* c3 */ ("
));
ok(isDeny(r), "comments at every whitespace position in the function header stay visible through masking");

// Comments containing fake DDL/body syntax are data and must not redirect the
// reader away from the real function that follows.
r = runHook("-- legacy CREATE FUNCTION public.old_rpc(\n" + fn(BOUND));
ok(!isDeny(r), "a commented-out unmatched function header does not false-deny a bound function");

r = runHook(fn(MUTATION).replace(
  "SECURITY DEFINER",
  "SECURITY DEFINER /* legacy shim: AS $fake$ SELECT 1; $fake$ */"
));
ok(isDeny(r), "a fake AS $tag$ body inside a comment cannot hide the real unbound body");

// Dollar-quoted defaults are string data. A paren inside one must not change
// the parameter-list nesting depth.
r = runHook(fn(
  MUTATION,
  "p_note text DEFAULT $d$normalize ($d$, p_performed_by uuid"
));
ok(isDeny(r), "a paren inside a dollar-quoted default cannot hide a later actor parameter");
ok(
  r.stdout.includes("forgeable actor parameter(s) [p_performed_by]"),
  "the dollar-default probe reaches the actor check, not only a parse backstop"
);

// Anything the structural reader cannot safely close is denied, not skipped.
r = runHook(fn(MUTATION, "p_note numeric((, p_performed_by uuid"));
ok(isDeny(r), "an unparseable parameter list fails CLOSED");
ok(r.stdout.includes("could not parse its parameter list"), "parameter parse failure explains the deny");

r = runHook(
  "CREATE FUNCTION public.no_body(p_performed_by uuid) RETURNS void " +
  "LANGUAGE plpgsql SECURITY DEFINER;"
);
ok(isDeny(r), "a function definition whose body cannot be read fails CLOSED");
ok(r.stdout.includes("could not parse its AS"), "body parse failure explains the deny");

r = runHook("CREATE FUNCTION public.unterminated(p_performed_by uuid) RETURNS void AS $fn$ BEGIN");
ok(isDeny(r), "an unterminated dollar-quote fails CLOSED at the file level");
ok(r.stdout.includes("This migration could not parse"), "file-level parse failure explains the deny");

// ── runtime-built DDL: one complete literal or refuse it ───────────────────
const UNBOUND_DDL =
  "CREATE OR REPLACE FUNCTION public.dynamic_actor(p_performed_by uuid) " +
  "RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN " +
  "UPDATE invoices SET created_by = p_performed_by; END $fn$;";
const BOUND_DDL =
  "CREATE OR REPLACE FUNCTION public.dynamic_bound(p_performed_by uuid) " +
  "RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN " +
  "IF p_performed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION ''ACTOR_MISMATCH''; END IF; " +
  "UPDATE invoices SET created_by = auth.uid(); END $fn$;";

r = runHook(`DO $do$ BEGIN EXECUTE '${UNBOUND_DDL}'; END $do$;`);
ok(isDeny(r), "an unbound actor function in one EXECUTE string is lexed and blocked");

r = runHook(`DO $do$ BEGIN EXECUTE '${UNBOUND_DDL.replace("dynamic_actor(", "dynamic_actor /* legal */ (")}'; END $do$;`);
ok(isDeny(r), "a comment-hidden header inside a dynamic string is still classified and blocked");

r = runHook(`DO $do$ BEGIN EXECUTE '${UNBOUND_DDL.replace("dynamic_actor(", "dynamic_actor /* outer /* inner */ open */ (")}'; END $do$;`);
ok(isDeny(r), "a nested comment cannot hide a function header inside a dynamic string");

r = runHook(`DO $do$ BEGIN EXECUTE $ddl$${UNBOUND_DDL.replace("dynamic_actor(", "dynamic_actor /* outer /* inner */ open */ (")}$ddl$; END $do$;`);
ok(isDeny(r), "a nested comment cannot hide a dynamic dollar-quoted function header");

r = runHook(`DO $do$ BEGIN EXECUTE '${BOUND_DDL}'; END $do$;`);
ok(!isDeny(r), "a bound actor function in one complete EXECUTE string remains allowed");

r = runHook(`DO $do$ BEGIN
  EXECUTE 'CREATE OR REPLACE FUNCTION public.split_actor(p_performed_by uuid) RETURNS void '
    || 'LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN UPDATE invoices SET created_by = p_performed_by; END $fn$;';
END $do$;`);
ok(isDeny(r), "a CREATE FUNCTION definition split across concatenated literals is refused");
ok(r.stdout.includes("one complete literal"), "split dynamic DDL deny explains the supported shape");

r = runHook(`DO $do$ BEGIN
  EXECUTE 'CREATE OR REPLACE ' || 'FUNCTION public.split_header(' ||
    'p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN UPDATE invoices SET created_by = p_performed_by; END $fn$;';
END $do$;`);
ok(isDeny(r), "a CREATE FUNCTION header split across literals is refused before it can disappear from the lexer");

r = runHook(`DO $do$ BEGIN EXECUTE format('%s', '${BOUND_DDL}'); END $do$;`);
ok(isDeny(r), "even a bound definition wrapped in format() is refused because it uses multiple literals");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl := $ddl$${UNBOUND_DDL}$ddl$;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "an unbound actor function assigned to a DDL variable is still inspected");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl = $ddl$${UNBOUND_DDL}$ddl$;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "plain = assignment of runtime DDL is still inspected");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  SELECT $ddl$${UNBOUND_DDL}$ddl$ /* outer /* inner */ still open ; */ INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "a nested-comment semicolon cannot hide SELECT ... INTO runtime DDL");

r = runHook(`INSERT INTO docs (body) VALUES ('CREATE OR REPLACE ' || 'FUNCTION public.example(p_performed_by uuid)');`);
ok(!isDeny(r), "function-shaped fragments in a plain INSERT are data, not runtime DDL");

// ── NEGATIVE: correctly bound / out of scope / exempt ──────────────────────
r = runHook(fn(BOUND));
ok(!isDeny(r), "body raising ACTOR_MISMATCH is allowed");

r = runHook(fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER"));
ok(!isDeny(r), "SECURITY INVOKER function is out of scope (RLS still applies)");

r = runHook(fn(MUTATION, "p_performed_by uuid", ""));
ok(!isDeny(r), "function with no SECURITY clause (invoker default) is out of scope");

r = runHook(fn("SELECT * FROM invoices WHERE created_by = p_performed_by;"));
ok(!isDeny(r), "non-mutating SECDEF function is allowed even with an actor param");

r = runHook(fn(MUTATION, "p_invoice_id uuid, p_amount_cents bigint"));
ok(!isDeny(r), "SECDEF mutator with NO actor-shaped parameter is allowed");

r = runHook("-- actor-binding-check: exempt\n" + fn(MUTATION));
ok(!isDeny(r), "file-level exempt marker skips the check entirely");

// Edit-tool payloads use new_string rather than content
r = spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], {
  input: JSON.stringify({ tool_input: { file_path: "supabase/migrations/20260807000000_test.sql", new_string: fn(MUTATION) } }),
  encoding: "utf8",
});
ok(isDeny(r), "Edit-tool new_string payload is checked the same as Write content");

// malformed JSON on stdin must fail OPEN, not crash the session
r = spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], { input: "not json", encoding: "utf8" });
eq(r.status, 0, "malformed stdin exits 0 (fail-open)");
ok(!isDeny(r), "malformed stdin is allowed, never denied");

console.log(`actor-binding-check: ${pass} assertions passed`);
