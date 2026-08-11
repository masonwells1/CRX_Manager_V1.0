#!/usr/bin/env node
// Tests for actor-binding-check.mjs — the write-time half of the actor-forgery
// sweeps (predicates/actor-forgery.sql, predicates/actor-forgery-fin-audit.sql).
// Spawns the real hook with crafted Write-tool stdin payloads.
// Run: node .claude/hooks/actor-binding-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
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

// fn(body, params, security) — `security` goes in the common pre-body attribute
// region. Separate probes below cover PostgreSQL's legal post-body form too.
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

const POST_BODY_UNBOUND = `CREATE OR REPLACE FUNCTION public.post_body_actor(p_performed_by uuid)
RETURNS void AS $function$
BEGIN
  UPDATE invoices SET created_by = p_performed_by;
END
$function$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;`;
r = runHook(POST_BODY_UNBOUND);
ok(isDeny(r), "post-body LANGUAGE ... SECURITY DEFINER cannot bypass actor binding");

r = runHook(POST_BODY_UNBOUND.replace(
  "$function$ LANGUAGE",
  "$function$ /* legal trailing comment; still attributes */ LANGUAGE"
));
ok(isDeny(r), "a semicolon inside a trailing comment cannot truncate post-body attributes");

r = runHook(POST_BODY_UNBOUND.replace(
  "UPDATE invoices SET created_by = p_performed_by;",
  "IF p_performed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; " +
    "UPDATE invoices SET created_by = auth.uid();"
));
ok(!isDeny(r), "a correctly bound post-body SECURITY DEFINER function remains allowed");

r = runHook(POST_BODY_UNBOUND.replace(/;$/, ""));
ok(isDeny(r), "a function body without a readable terminating semicolon fails closed");
ok(r.stdout.includes("could not parse its AS"), "missing function terminator explains the deny");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER").replace("test_fn", "first_invoker") +
  "\n" + fn("RETURN '{}'::jsonb;", "", "SECURITY DEFINER").replace("test_fn", "later_definer")
);
ok(!isDeny(r), "SECURITY DEFINER in a later statement does not contaminate an earlier function");

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

r = runHook(fn(MUTATION, "/* legal */ p_performed_by uuid"));
ok(isDeny(r), "a comment before an actor parameter cannot hide its declared name");

r = runHook(fn("UPDATE/* legal */ invoices SET created_by = p_performed_by;"));
ok(isDeny(r), "a comment between UPDATE and its target cannot hide a mutation");

r = runHook(fn("EXECUTE 'UPDATE invoices SET created_by = $1' USING p_performed_by;"));
ok(isDeny(r), "a single-quoted dynamic UPDATE cannot disappear during string masking");

r = runHook(fn("EXECUTE format('INSERT INTO financial_audit_log (actor_user_id) VALUES (%L)', p_performed_by);"));
ok(isDeny(r), "an EXECUTE format() dynamic INSERT is treated as potentially mutating");

r = runHook(fn(`PERFORM cron.schedule(
  'actor-forgery-job',
  '* * * * *',
  format('INSERT INTO financial_audit_log (actor_user_id) VALUES (%L)', p_user_id)
);`, "p_user_id uuid"));
ok(isDeny(r), "mutation text passed to cron.schedule cannot disappear inside an executable string");

r = runHook(fn("EXECUTE 'SELECT 1';"));
ok(isDeny(r), "opaque dynamic SQL with an unbound actor parameter fails closed");

r = runHook(fn(MUTATION).replace(
  MUTATION,
  "/* historical text: ACTOR_MISMATCH */\n" + MUTATION
));
ok(isDeny(r), "ACTOR_MISMATCH text inside a comment does not count as actor binding");

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

r = runHook(fn(
  MUTATION,
  "p_note text DEFAULT '/* harmless literal text', p_performed_by uuid"
));
ok(isDeny(r), "comment syntax inside a quoted default cannot erase a later actor parameter");

r = runHook(fn(
  MUTATION,
  "p_note text DEFAULT $d$/* harmless literal text$d$, p_performed_by uuid"
));
ok(isDeny(r), "comment syntax inside a dollar-quoted default cannot erase a later actor parameter");

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
// BOUND_DDL doubles its inner quotes for embedding in an outer single-quoted
// SQL string. Dollar-quoted containers need the function's literal SQL text.
const BOUND_DDL_DOLLAR = BOUND_DDL.replaceAll("''", "'");
const QUOTED_UNBOUND_DDL = UNBOUND_DDL.replace(
  "public.dynamic_actor",
  '"public" . "dynamic_actor"'
);
const UNICODE_UNBOUND_DDL = UNBOUND_DDL.replace(
  "public.dynamic_actor",
  'U&"\\0070ublic".U&"\\0064ynamic_actor"'
);
const STAGED_DDL = `CREATE TEMP TABLE staged_cron_sql (command text);
INSERT INTO staged_cron_sql (command) VALUES ($staged$${UNBOUND_DDL}$staged$);`;

r = runHook(`DO $do$ BEGIN EXECUTE $ddl$${QUOTED_UNBOUND_DDL}$ddl$; END $do$;`);
ok(isDeny(r), "direct EXECUTE cannot hide an unsafe quoted qualified function name");

r = runHook(`DO $do$ BEGIN EXECUTE $ddl$${UNICODE_UNBOUND_DDL}$ddl$; END $do$;`);
ok(isDeny(r), "direct EXECUTE cannot hide an unsafe Unicode-qualified function name");

r = runHook(`DO $do$ BEGIN EXECUTE $ddl$${UNBOUND_DDL.replace(
  "public.dynamic_actor",
  '"public"."dynamic""actor"'
)}$ddl$; END $do$;`);
ok(isDeny(r), "a doubled quote inside a function identifier remains inspectable");

r = runHook(`DO $do$ BEGIN EXECUTE $ddl$${BOUND_DDL_DOLLAR.replace(
  "public.dynamic_bound",
  '"public"."dynamic_bound"'
)}$ddl$; END $do$;`);
ok(!isDeny(r), "a bound direct function with a quoted qualified name remains allowed");

r = runHook(`SELECT cron.schedule(
  'delayed-actor-ddl',
  '* * * * *',
  $job$${UNBOUND_DDL}$job$
);`);
ok(isDeny(r), "top-level cron.schedule cannot hide a delayed unbound actor function");
ok(r.stdout.includes("builds a CREATE FUNCTION"), "scheduled DDL denial explains the fail-closed boundary");

r = runHook(`SELECT cron.schedule(
  'existing-safe-job',
  '0 6 * * *',
  $job$SELECT public.existing_safe_job()$job$
);`);
ok(!isDeny(r), "a normal top-level cron.schedule call without function DDL remains allowed");

r = runHook(`${STAGED_DDL}
SELECT cron.schedule('staged-actor-ddl', '* * * * *',
  (SELECT command FROM staged_cron_sql LIMIT 1));`);
ok(isDeny(r), "a subquery cannot stage actor DDL into cron.schedule");
ok(r.stdout.includes("stores a pg_cron command"), "opaque scheduled-command denial explains the manual-review boundary");

r = runHook(`SELECT public.execute_sql_readonly($outer$
  SELECT cron.schedule('nested-delayed-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$);`);
ok(isDeny(r), "execute_sql_readonly cannot hide a nested pg_cron actor-DDL call");

r = runHook(`SELECT public.execute_sql_readonly($outer$
  SELECT cron.schedule('nested-quoted-actor-ddl', '* * * * *',
    $job$${QUOTED_UNBOUND_DDL}$job$)
$outer$);`);
ok(isDeny(r), "the legacy executor recognizes quoted function DDL recursively");

r = runHook(`SELECT public.execute_sql_readonly($query$SELECT 1 AS safe_value$query$);`);
ok(!isDeny(r), "execute_sql_readonly with a direct harmless query remains allowed");

r = runHook(`SELECT public.execute_sql_readonly(sql_query => $outer$
  SELECT cron.schedule('named-nested-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$);`);
ok(isDeny(r), "a named execute_sql_readonly argument cannot hide scheduled actor DDL");

r = runHook(`CREATE TEMP TABLE staged_executor_sql (query text);
INSERT INTO staged_executor_sql (query) VALUES ($outer$
  SELECT cron.schedule('staged-executor-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$);
SELECT public.execute_sql_readonly(
  (SELECT query FROM staged_executor_sql LIMIT 1)
);`);
ok(isDeny(r), "execute_sql_readonly rejects a staged SQL expression");

r = runHook(`SELECT public.store_documentation($doc$${UNBOUND_DDL}$doc$);`);
ok(isDeny(r), "an unproven documentation callable cannot receive function-bearing SQL");

r = runHook(`SELECT public.actor_sql_alias($outer$
  SELECT cron.schedule('alias-delayed-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$);`);
ok(isDeny(r), "an unknown callable cannot receive function-bearing SQL without manual review");

r = runHook(`SELECT public.actor_sql_alias('connection-name', $outer$${UNBOUND_DDL}$outer$);`);
ok(isDeny(r), "a later positional argument cannot hide function-bearing SQL");

r = runHook(`SELECT public.actor_sql_alias(mode => 'read', sql_query => $outer$${UNBOUND_DDL}$outer$);`);
ok(isDeny(r), "a later named argument cannot hide function-bearing SQL");

r = runHook(`SELECT public.actor_sql_alias(CAST($outer$${UNBOUND_DDL}$outer$ AS text));`);
ok(isDeny(r), "a cast wrapper cannot hide function-bearing SQL from its outer callable");

r = runHook(`SELECT public.actor_sql_alias(($outer$${UNBOUND_DDL}$outer$));`);
ok(isDeny(r), "a parenthesized argument cannot hide function-bearing SQL");

r = runHook(`SELECT dblink_exec('connection-name', $outer$${UNBOUND_DDL}$outer$);`);
ok(isDeny(r), "dblink_exec cannot receive delayed actor-forgery SQL in a later argument");

r = runHook(`SELECT dblink_exec(
  'connection-name',
  format('%s%s', 'CREATE ', $tail$${UNBOUND_DDL.slice("CREATE ".length)}$tail$)
);`);
ok(isDeny(r), "dblink_exec cannot assemble actor-forgery DDL from harmless-looking fragments");

r = runHook(`SELECT dblink_exec(
  'connection-name',
  U&'\\0043REATE OR REPLACE FUNCTION public.encoded_actor(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS \\0024fn\\0024 BEGIN UPDATE invoices SET created_by = p_performed_by; END \\0024fn\\0024;'
);`);
ok(isDeny(r), "Unicode-encoded function DDL cannot cross an unproven callable boundary");

r = runHook(`CREATE TEMP TABLE staged_dblink_sql (sql_text text);
INSERT INTO staged_dblink_sql (sql_text) VALUES ($outer$${UNBOUND_DDL}$outer$);
WITH staged AS (SELECT sql_text FROM staged_dblink_sql)
SELECT dblink_exec('connection-name', sql_text) FROM staged;`);
ok(isDeny(r), "a CTE column cannot stage actor-forgery DDL for an unproven SQL executor");

r = runHook(`CREATE TEMP TABLE staged_harmless_dblink_sql (sql_text text);
INSERT INTO staged_harmless_dblink_sql (sql_text) VALUES ('SELECT 1');
WITH staged AS (SELECT sql_text FROM staged_harmless_dblink_sql)
SELECT dblink_exec('connection-name', sql_text) FROM staged;`);
ok(isDeny(r), "indirect SQL text stays fail-closed even when its staged value looks harmless");

r = runHook(`SELECT query_to_xml(
  'SEL' || chr(69) || 'CT cron.schedule(''delayed-actor-ddl'', ''* * * * *'', ''CRE'' || chr(65) || ''TE OR REPLACE FUNCTION public.dynamic_actor(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN UPDATE invoices SET created_by = p_performed_by; END $fn$;'')',
  true,
  false,
  ''
);`);
ok(isDeny(r), "an unproven callable cannot receive dynamically obscured SQL");

r = runHook(`SELECT query_to_xml('SELECT 1', true, false, '');`);
ok(!isDeny(r), "an unproven callable may receive one direct harmless SQL literal");

r = runHook(`SELECT query_to_xml(
  query => 'SELECT 1', nulls => true, tableforest => false, targetns => ''
);`);
ok(!isDeny(r), "named direct SQL and obvious scalar options remain inspectable");

r = runHook(`CREATE OR REPLACE FUNCTION public.safe_search(p_query text)
RETURNS TABLE(label text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  RETURN QUERY (
    SELECT 'customer-'::text || p_query
  );
END;
$fn$;`);
ok(!isDeny(r), "RETURN QUERY syntax is not mistaken for an unproven callable");

r = runHook(`SELECT public."Execute_SQL_Readonly"($outer$${UNBOUND_DDL}$outer$);`);
ok(isDeny(r), "a quoted mixed-case callable cannot inherit a trusted executor identity");

r = runHook(`SELECT public."execute_sql_readonly"($query$SELECT 1$query$);`);
ok(!isDeny(r), "the exact quoted trusted executor keeps its harmless direct-literal behavior");

r = runHook(`ALTER FUNCTION public.execute_sql_readonly(text) RENAME TO actor_sql_alias;`);
ok(isDeny(r), "the known SQL executor cannot be renamed past the name-bound reader");
ok(r.stdout.includes("renames or moves execute_sql_readonly"),
  "the executor rename reaches the dedicated identity-change guard");

r = runHook(`ALTER FUNCTION public.execute_sql_readonly(text) RENAME TO actor_sql_alias;
SELECT public.actor_sql_alias($outer$
  SELECT cron.schedule('renamed-executor-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$);
ALTER FUNCTION public.actor_sql_alias(text) RENAME TO execute_sql_readonly;`);
ok(isDeny(r), "rename-call-restore cannot hide delayed actor-forgery SQL");

r = runHook(`SELECT U&"\\0065xecute_sql_readonly"($outer$
  SELECT cron.schedule('unicode-executor-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$);`);
ok(isDeny(r), "a Unicode executor name cannot hide nested scheduled actor DDL");

r = runHook(`SELECT cron.schedule(
  job_name => 'named-safe-job',
  schedule => '0 6 * * *',
  command => $job$SELECT public.existing_safe_job()$job$
);`);
ok(!isDeny(r), "a named direct-literal cron.schedule command remains allowed");

r = runHook(`SELECT cron.unschedule('existing-safe-job');`);
ok(!isDeny(r), "cron.unschedule remains allowed because it does not store command text");

r = runHook(`SELECT cron.unschedule(42);`);
ok(!isDeny(r), "numeric cron.unschedule remains allowed because it has no command input");

r = runHook(`${STAGED_DDL}
SELECT cron."UnScHeDuLe"(command) FROM staged_cron_sql;`);
ok(isDeny(r), "a quoted mixed-case cron API cannot inherit the unschedule exemption");

r = runHook(`SELECT cron."unschedule"(42);`);
ok(!isDeny(r), "the exact quoted cron.unschedule name remains allowed");

r = runHook(`SELECT "cron"."schedule"(
  'quoted-delayed-actor-ddl',
  '* * * * *',
  $job$${UNBOUND_DDL}$job$
);`);
ok(isDeny(r), "quoted cron.schedule identifiers cannot hide delayed actor DDL");

r = runHook(`SELECT "cron"."schedule"(
  'quoted-safe-job',
  '0 6 * * *',
  $job$SELECT public.existing_safe_job()$job$
);`);
ok(!isDeny(r), "quoted cron.schedule without function DDL remains allowed");

r = runHook(`SET search_path = cron, public;
SELECT schedule(
  'search-path-delayed-actor-ddl',
  '* * * * *',
  $job$${UNBOUND_DDL}$job$
);`);
ok(isDeny(r), "search_path cannot hide an unqualified cron.schedule actor-DDL call");

r = runHook(`SET LOCAL search_path TO "cron", public;
SELECT "schedule"(
  'quoted-search-path-delayed-actor-ddl',
  '* * * * *',
  $job$${UNBOUND_DDL}$job$
);`);
ok(isDeny(r), "quoted unqualified cron.schedule remains fail-closed through search_path");

r = runHook(`SET search_path = cron, public;
SELECT schedule_in_database(
  'unqualified-cross-db-actor-ddl',
  '* * * * *',
  $job$${UNBOUND_DDL}$job$,
  'postgres'
);`);
ok(isDeny(r), "search_path cannot hide unqualified cron.schedule_in_database actor DDL");

r = runHook(`SET search_path = cron, public;
SELECT alter_job(42, command := $job$${UNBOUND_DDL}$job$);`);
ok(isDeny(r), "search_path cannot hide an unqualified cron.alter_job command replacement");

r = runHook(`SET search_path = cron, public;
SELECT schedule(
  'search-path-safe-job',
  '0 6 * * *',
  $job$SELECT public.existing_safe_job()$job$
);`);
ok(!isDeny(r), "unqualified cron.schedule without function DDL remains allowed");

r = runHook(`UPDATE cron.job
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobname = 'existing-job';`);
ok(isDeny(r), "UPDATE cron.job.command cannot store delayed unbound actor DDL");

r = runHook(`UPDATE "cron"."job" AS existing
SET "command" = $job$${UNBOUND_DDL}$job$
WHERE existing.jobname = 'quoted-existing-job';`);
ok(isDeny(r), "quoted UPDATE of cron.job.command remains fail-closed");

r = runHook(`UPDATE ONLY cron.job AS existing
SET command = $job$${UNBOUND_DDL}$job$
WHERE existing.jobname = 'only-existing-job';`);
ok(isDeny(r), "UPDATE ONLY/alias of cron.job.command remains fail-closed");

r = runHook(`UPDATE cron.job
SET (command, active) = ($job$${UNBOUND_DDL}$job$, true)
WHERE jobid = 42;`);
ok(isDeny(r), "tuple UPDATE of cron.job.command remains fail-closed");

r = runHook(`UPDATE cron.job
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobname = 'safe-existing-job';`);
ok(!isDeny(r), "UPDATE cron.job.command without function DDL remains allowed");

r = runHook(`CREATE TEMP VIEW cron_job_alias AS SELECT * FROM cron.job;
UPDATE cron_job_alias
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "an updatable view cannot alias unsafe actor DDL into cron.job.command");

r = runHook(`CREATE TEMP VIEW cron_job_alias AS SELECT * FROM cron.job;
UPDATE cron_job_alias
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`);
ok(!isDeny(r), "an updatable cron.job view keeps a direct harmless command allowed");

r = runHook(`${STAGED_DDL}
CREATE TEMP VIEW cron_job_alias AS SELECT * FROM cron.job;
UPDATE cron_job_alias
SET command = (SELECT command FROM staged_cron_sql LIMIT 1)
WHERE jobid = 42;`);
ok(isDeny(r), "an updatable cron.job view cannot receive an opaque staged command");

r = runHook(`CREATE TEMP VIEW ordinary_job_alias AS SELECT * FROM public.job;
UPDATE ordinary_job_alias
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(!isDeny(r), "an ordinary non-cron view remains a data-only destination");

r = runHook(`CREATE TEMP VIEW cron_job_alias AS SELECT * FROM cron.job;
CREATE TEMP VIEW "CronJobFacade" AS SELECT * FROM cron_job_alias;
UPDATE "CronJobFacade"
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "quoted transitive views cannot hide a cron.job command write");

r = runHook(`CREATE VIEW public.cron_job_facade AS SELECT * FROM cron.job;
UPDATE cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "a search-path-resolved qualified view keeps the cron.job sink identity");

const crossMigrationRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-cron-view-"));
const crossMigrationDir = path.join(crossMigrationRoot, "supabase", "migrations");
mkdirSync(crossMigrationDir, { recursive: true });
writeFileSync(
  path.join(crossMigrationDir, "20260807000001_create_cron_job_facade.sql"),
  "CREATE VIEW persistent_cron_job_facade AS SELECT * FROM cron.job;\n"
);
const crossMigrationTarget = path.join(
  crossMigrationDir,
  "20260807000002_update_cron_job_facade.sql"
);
r = runHook(`UPDATE public.persistent_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, crossMigrationTarget);
ok(isDeny(r), "a persistent cron.job view from an earlier migration remains an unsafe command sink");

r = runHook(`${STAGED_DDL}
UPDATE public.persistent_cron_job_facade
SET command = (SELECT command FROM staged_cron_sql LIMIT 1)
WHERE jobid = 42;`, crossMigrationTarget);
ok(isDeny(r), "an earlier persistent cron.job view cannot receive staged actor DDL");

r = runHook(`UPDATE public.persistent_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, crossMigrationTarget);
ok(!isDeny(r), "an earlier persistent cron.job view keeps a direct harmless command allowed");

writeFileSync(
  path.join(crossMigrationDir, "20260807000002_rename_cron_job_facade.sql"),
  "ALTER VIEW persistent_cron_job_facade RENAME TO renamed_cron_job_facade;\n"
);
const renamedCrossMigrationTarget = path.join(
  crossMigrationDir,
  "20260807000003_update_renamed_cron_job_facade.sql"
);
r = runHook(`UPDATE public.renamed_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, renamedCrossMigrationTarget);
ok(isDeny(r), "renaming a persistent cron.job view in an earlier migration cannot erase its sink identity");

writeFileSync(
  path.join(crossMigrationDir, "20260807000004_create_temp_cron_job_facade.sql"),
  "CREATE TEMP VIEW prior_temp_cron_job_facade AS SELECT * FROM cron.job;\n"
);
const priorTempCrossMigrationTarget = path.join(
  crossMigrationDir,
  "20260807000005_update_prior_temp_cron_job_facade.sql"
);
r = runHook(`UPDATE public.prior_temp_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, priorTempCrossMigrationTarget);
ok(!isDeny(r), "a temporary cron.job view from an earlier migration does not persist as a sink alias");

const missingHistoryTarget = path.join(
  crossMigrationRoot,
  "missing",
  "supabase",
  "migrations",
  "20260807000006_missing_history.sql"
);
r = runHook(`UPDATE public.unknown_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, missingHistoryTarget);
ok(isDeny(r), "unreadable migration history fails closed for an unknown command target");
rmSync(crossMigrationRoot, { recursive: true, force: true });

const schemaLifecycleRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-cron-schema-"));
const schemaLifecycleDir = path.join(schemaLifecycleRoot, "supabase", "migrations");
mkdirSync(schemaLifecycleDir, { recursive: true });
writeFileSync(
  path.join(schemaLifecycleDir, "20260807000101_create_schema_cron_job_facade.sql"),
  "CREATE VIEW public.schema_cron_job_facade AS SELECT * FROM cron.job;\n"
);
writeFileSync(
  path.join(schemaLifecycleDir, "20260807000102_move_schema_cron_job_facade.sql"),
  "ALTER VIEW public.schema_cron_job_facade SET SCHEMA archive;\n"
);
const schemaLifecycleTarget = path.join(
  schemaLifecycleDir,
  "20260807000103_update_schema_cron_job_facade.sql"
);
r = runHook(`UPDATE archive.schema_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, schemaLifecycleTarget);
ok(isDeny(r), "moving a persistent cron.job view to another schema cannot erase its sink identity");
rmSync(schemaLifecycleRoot, { recursive: true, force: true });

const dropLifecycleRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-cron-drop-"));
const dropLifecycleDir = path.join(dropLifecycleRoot, "supabase", "migrations");
mkdirSync(dropLifecycleDir, { recursive: true });
writeFileSync(
  path.join(dropLifecycleDir, "20260807000201_create_drop_cron_job_facade.sql"),
  "CREATE VIEW public.reused_job_facade AS SELECT * FROM cron.job;\n"
);
writeFileSync(
  path.join(dropLifecycleDir, "20260807000202_reuse_drop_cron_job_facade.sql"),
  "DROP VIEW public.reused_job_facade;\n" +
    "CREATE VIEW public.reused_job_facade AS SELECT * FROM public.job;\n"
);
const dropLifecycleTarget = path.join(
  dropLifecycleDir,
  "20260807000203_update_reused_job_facade.sql"
);
r = runHook(`UPDATE public.reused_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, dropLifecycleTarget);
ok(isDeny(r), "a dropped and reused cron.job alias stays conservatively review-only");
r = runHook(`UPDATE public.reused_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, dropLifecycleTarget);
ok(!isDeny(r), "a dropped and reused alias still permits a direct harmless command");
rmSync(dropLifecycleRoot, { recursive: true, force: true });

r = runHook(`${STAGED_DDL}
UPDATE cron.job
SET command = (SELECT command FROM staged_cron_sql LIMIT 1)
WHERE jobname = 'staged-existing-job';`);
ok(isDeny(r), "a subquery cannot stage actor DDL into cron.job.command");

r = runHook(`${STAGED_DDL}
UPDATE cron.job
SET (command, active) = ((SELECT command FROM staged_cron_sql LIMIT 1), true)
WHERE jobid = 42;`);
ok(isDeny(r), "a tuple assignment cannot stage actor DDL into cron.job.command");

r = runHook(`INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username, active, jobname)
VALUES ('* * * * *', $job$${UNBOUND_DDL}$job$, 'localhost', 5432, 'postgres', 'postgres', true, 'inserted-actor-ddl');`);
ok(isDeny(r), "INSERT INTO cron.job cannot create a delayed unbound actor-DDL job");

r = runHook(`SET search_path = cron, public;
INSERT INTO "job" (schedule, "command", nodename, nodeport, database, username, active, jobname)
VALUES ('0 6 * * *', $job$${UNBOUND_DDL}$job$, 'localhost', 5432, 'postgres', 'postgres', true, 'unqualified-inserted-actor-ddl');`);
ok(isDeny(r), "search_path cannot hide an unqualified quoted cron.job INSERT");

r = runHook(`INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username, active, jobname)
VALUES ('0 6 * * *', $job$SELECT public.existing_safe_job()$job$, 'localhost', 5432, 'postgres', 'postgres', true, 'safe-inserted-job');`);
ok(!isDeny(r), "INSERT INTO cron.job without function DDL remains allowed");

r = runHook(`${STAGED_DDL}
WITH safe_job AS (
  INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username, active, jobname)
  VALUES ('0 6 * * *', $job$SELECT public.existing_safe_job()$job$, 'localhost', 5432, 'postgres', 'postgres', true, 'safe-cte-job')
  RETURNING jobid
), staged_job AS (
  INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username, active, jobname)
  SELECT '* * * * *', command, 'localhost', 5432, 'postgres', 'postgres', true, 'staged-cte-job'
  FROM staged_cron_sql
  RETURNING jobid
)
SELECT count(*) FROM safe_job, staged_job;`);
ok(isDeny(r), "a safe first CTE insert cannot hide a later staged cron.job command");

r = runHook(`${STAGED_DDL}
INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username, active, jobname)
SELECT '* * * * *', command, 'localhost', 5432, 'postgres', 'postgres', true, 'staged-inserted-job'
FROM staged_cron_sql;`);
ok(isDeny(r), "INSERT SELECT cannot stage actor DDL into cron.job.command");

r = runHook(`${STAGED_DDL}
INSERT INTO cron.job (jobid, schedule, command, nodename, nodeport, database, username, active, jobname)
VALUES (42, '0 6 * * *', $job$SELECT public.existing_safe_job()$job$, 'localhost', 5432, 'postgres', 'postgres', true, 'upserted-job')
ON CONFLICT (jobid) DO UPDATE SET command = (SELECT command FROM staged_cron_sql LIMIT 1);`);
ok(isDeny(r), "ON CONFLICT UPDATE cannot stage actor DDL into cron.job.command");

r = runHook(`INSERT INTO cron.job (jobid, schedule, command, nodename, nodeport, database, username, active, jobname)
VALUES (42, '0 6 * * *', $job$SELECT public.existing_safe_job()$job$, 'localhost', 5432, 'postgres', 'postgres', true, 'safe-upserted-job')
ON CONFLICT (jobid) DO UPDATE SET command = $job$SELECT public.existing_safe_job()$job$;`);
ok(!isDeny(r), "ON CONFLICT UPDATE with direct safe command literals remains allowed");

r = runHook(`COPY cron.job (command) FROM '/tmp/cron-commands.csv';`);
ok(isDeny(r), "COPY into cron.job requires the explicit manual-review path");

r = runHook(`COPY public.job (command) FROM '/tmp/ordinary-commands.csv';`);
ok(!isDeny(r), "COPY into an explicitly non-cron schema.job remains ordinary data");

r = runHook(`UPDATE public.job SET command = $job$${UNBOUND_DDL}$job$ WHERE jobid = 42;`);
ok(!isDeny(r), "an explicitly non-cron schema.job UPDATE is not a cron sink");

r = runHook(`INSERT INTO public.job (command) VALUES ($job$${UNBOUND_DDL}$job$);`);
ok(!isDeny(r), "an explicitly non-cron schema.job INSERT is not a cron sink");

r = runHook(`MERGE INTO public.job AS target USING (VALUES (42)) AS source(jobid)
ON target.jobid = source.jobid WHEN MATCHED THEN UPDATE SET command = $job$${UNBOUND_DDL}$job$;`);
ok(!isDeny(r), "an explicitly non-cron schema.job MERGE is not a cron sink");

r = runHook(`WITH target_job AS (
  SELECT jobid FROM cron.job WHERE jobname = 'cte-existing-job'
)
UPDATE cron.job
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid IN (SELECT jobid FROM target_job);`);
ok(isDeny(r), "a CTE prefix cannot hide UPDATE cron.job.command actor DDL");

r = runHook(`WITH unrelated_write AS (
  UPDATE public.job
  SET command = $job$${UNBOUND_DDL}$job$
  WHERE jobid = 42
)
UPDATE cron.job
SET active = false
WHERE jobid = 42;`);
ok(!isDeny(r), "a CTE data assignment cannot impersonate the outer cron.job update tail");

r = runHook(`WITH target_job AS (
  SELECT jobid FROM cron.job WHERE jobname = 'cte-safe-job'
)
UPDATE cron.job
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid IN (SELECT jobid FROM target_job);`);
ok(!isDeny(r), "a CTE-prefixed cron.job UPDATE without function DDL remains allowed");

r = runHook(`MERGE INTO cron.job AS target
USING (VALUES (42)) AS source(jobid)
ON target.jobid = source.jobid
WHEN MATCHED THEN UPDATE SET command = $job$${UNBOUND_DDL}$job$;`);
ok(isDeny(r), "MERGE UPDATE cannot store cron.job.command actor DDL");

r = runHook(`MERGE INTO cron.job AS target
USING (VALUES (42)) AS source(jobid)
ON target.jobid = source.jobid
WHEN MATCHED THEN UPDATE SET command = $job$SELECT public.existing_safe_job()$job$;`);
ok(!isDeny(r), "MERGE without function DDL remains allowed");

r = runHook(`${STAGED_DDL}
MERGE INTO cron.job AS target
USING (SELECT 42 AS jobid, command FROM staged_cron_sql) AS source
ON target.jobid = source.jobid
WHEN MATCHED THEN UPDATE SET command = source.command;`);
ok(isDeny(r), "MERGE cannot stage actor DDL into cron.job.command");

r = runHook(`${STAGED_DDL}
MERGE INTO cron.job AS target
USING (SELECT 'mixed-branch-job'::text AS jobname, command FROM staged_cron_sql) AS source
ON target.jobname = source.jobname
WHEN MATCHED THEN UPDATE SET command = $safe$SELECT public.existing_safe_job()$safe$
WHEN NOT MATCHED THEN
  INSERT (schedule, command, nodename, nodeport, database, username, active, jobname)
  VALUES ('0 6 * * *', source.command, 'localhost', 5432, current_database(), current_user, true, source.jobname);`);
ok(isDeny(r), "a direct safe MERGE update cannot hide an opaque insert branch");

r = runHook(`${STAGED_DDL}
MERGE INTO cron.job AS target
USING (SELECT 42::bigint AS jobid, 'columnless-branch-job'::text AS jobname,
              command FROM staged_cron_sql) AS source
ON target.jobid = source.jobid
WHEN MATCHED THEN UPDATE SET command = $safe$SELECT public.existing_safe_job()$safe$
WHEN NOT MATCHED THEN
  INSERT VALUES (source.jobid, '0 6 * * *', source.command, 'localhost', 5432,
                 current_database(), current_user, true, source.jobname);`);
ok(isDeny(r), "a columnless MERGE insert action remains review-only");

r = runHook(`SELECT U&"\\0063ron".schedule(
  'unicode-delayed-actor-ddl',
  '* * * * *',
  $job$${UNBOUND_DDL}$job$
);`);
ok(isDeny(r), "a Unicode-escaped cron schema cannot hide scheduled actor DDL");

r = runHook(`${STAGED_DDL}
SET search_path = cron, public;
SELECT U&"\\0061lter_job"(42,
  command => (SELECT command FROM staged_cron_sql LIMIT 1));`);
ok(isDeny(r), "an unqualified Unicode API name cannot receive a staged command");

r = runHook(`${STAGED_DDL}
SELECT cron.alter_job(42,
  U&"\\0063ommand" => (SELECT command FROM staged_cron_sql LIMIT 1));`);
ok(isDeny(r), "a Unicode named argument cannot hide a staged command");

r = runHook(`${STAGED_DDL}
SELECT cron.alter_job(42,
  U&"!0063ommand" UESCAPE '!' => (SELECT command FROM staged_cron_sql LIMIT 1));`);
ok(isDeny(r), "a custom-UESCAPE named argument cannot hide staged SQL");

r = runHook(`${STAGED_DDL}
SET search_path = cron, public;
SELECT U&"!0061lter_job" UESCAPE '!'(42,
  command => (SELECT command FROM staged_cron_sql LIMIT 1));`);
ok(isDeny(r), "a custom-UESCAPE Unicode API name cannot receive staged SQL");

r = runHook(`SET search_path = cron, public;
SELECT U&"\\0073chedule"('unicode-safe-job', '0 6 * * *',
  $job$SELECT public.existing_safe_job()$job$);`);
ok(!isDeny(r), "an unqualified Unicode API call with only direct safe literals remains allowed");

r = runHook(`UPDATE U&"\\0063ron".job
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobname = 'unicode-existing-job';`);
ok(isDeny(r), "a Unicode-escaped cron schema cannot hide a command-table write");

r = runHook(`SELECT $note$U&"\\0063ron".schedule('ignored', 'CREATE FUNCTION public.not_executable()')$note$;`);
ok(!isDeny(r), "Unicode pg_cron-looking text inside a data literal remains ignored");

r = runHook(`SELECT cron.schedule_in_database(
  'cross-db-actor-ddl',
  '* * * * *',
  $job$${UNBOUND_DDL}$job$,
  'postgres'
);`);
ok(isDeny(r), "cron.schedule_in_database cannot hide delayed actor DDL");

r = runHook(`SELECT cron.schedule_in_database(
  'cross-db-safe-job',
  '0 6 * * *',
  $job$SELECT public.existing_safe_job()$job$,
  'postgres'
);`);
ok(!isDeny(r), "cron.schedule_in_database without function DDL remains allowed");

r = runHook(`SELECT cron.schedule_in_database(
  'cross-db-safe-mixed-job',
  '0 6 * * *',
  $job$SELECT public.existing_safe_job()$job$,
  'postgres',
  username => 'postgres',
  active => true
);`);
ok(!isDeny(r), "a harmless positional schedule_in_database command allows later named options");

r = runHook(`${STAGED_DDL}
SELECT cron.schedule_in_database(
  'cross-db-staged-mixed-job',
  '0 6 * * *',
  (SELECT command FROM staged_cron_sql LIMIT 1),
  'postgres',
  active => true
);`);
ok(isDeny(r), "named options cannot hide a staged positional schedule_in_database command");

r = runHook(`SELECT cron.alter_job(
  42,
  command := $job$${UNBOUND_DDL}$job$
);`);
ok(isDeny(r), "cron.alter_job cannot replace a command with hidden actor DDL");

r = runHook(`${STAGED_DDL}
SELECT cron.alter_job(42, command := (SELECT command FROM staged_cron_sql LIMIT 1));`);
ok(isDeny(r), "cron.alter_job cannot receive a staged command expression");

r = runHook(`${STAGED_DDL}
SELECT cron.alter_job(
  42,
  '* * * * *',
  (SELECT command FROM staged_cron_sql LIMIT 1),
  active => true
);`);
ok(isDeny(r), "named options cannot hide a staged positional cron.alter_job command");

r = runHook(`SELECT cron.alter_job(
  42,
  '0 6 * * *',
  $job$SELECT public.existing_safe_job()$job$,
  active => true
);`);
ok(!isDeny(r), "a harmless positional cron.alter_job command remains allowed with named options");

r = runHook(`SELECT cron.alter_job(42, active := false);`);
ok(!isDeny(r), "cron.alter_job without function DDL remains allowed");

r = runHook(`SELECT cron.alter_job(42, schedule := '0 0 * * *', active := false);`);
ok(!isDeny(r), "named alter_job options do not impersonate positional command three");

r = runHook(`SELECT $note$ "cron"."schedule"('ignored', 'CREATE FUNCTION public.not_executable()')$note$;`);
ok(!isDeny(r), "cron-looking text inside a data literal is not treated as an API call");

r = runHook(`SELECT ' "cron"."schedule"(''ignored'', ''CREATE FUNCTION public.not_executable()'')';`);
ok(!isDeny(r), "cron-looking text inside a single-quoted data literal is ignored");

r = runHook(`SELECT $note$schedule('ignored', 'CREATE FUNCTION public.not_executable()')$note$;`);
ok(!isDeny(r), "unqualified pg_cron-looking text inside a data literal remains ignored");

r = runHook(`-- "cron"."schedule"('ignored', 'CREATE FUNCTION public.not_executable()')
SELECT $note$CREATE FUNCTION public.not_executable()$note$;`);
ok(!isDeny(r), "cron-looking text inside a line comment is ignored");

r = runHook(`/* outer /* nested */ "cron"."schedule"('ignored', 'CREATE FUNCTION public.not_executable()') */
SELECT $note$CREATE FUNCTION public.not_executable()$note$;`);
ok(!isDeny(r), "cron-looking text inside a nested block comment is ignored");

r = runHook(`SELECT cron.schedule(
  'split-actor-ddl',
  '* * * * *',
  $head$CREATE $head$ || $tail$${UNBOUND_DDL.replace(/^CREATE /, "")}$tail$
);`);
ok(isDeny(r), "cron.schedule DDL split across literals fails closed");

r = runHook(`SELECT cron.schedule(
  'bound-but-fancy-ddl',
  '* * * * *',
  $job$${BOUND_DDL_DOLLAR}$job$
);`);
ok(isDeny(r), "scheduled function DDL uses exemption even when its current text appears bound");

r = runHook(`DO $do$ BEGIN EXECUTE '${UNBOUND_DDL}'; END $do$;`);
ok(isDeny(r), "an unbound actor function in one EXECUTE string is lexed and blocked");

r = runHook(`DO LANGUAGE plpgsql $do$ BEGIN EXECUTE '${UNBOUND_DDL}'; END $do$;`);
ok(isDeny(r), "DO LANGUAGE with a dollar-quoted body cannot hide dynamic actor DDL");
ok(r.stdout.includes("public.dynamic_actor"), "the DO LANGUAGE dollar probe reaches actor inspection");

const UNBOUND_SINGLE_DO = `BEGIN EXECUTE '${UNBOUND_DDL}'; END`.replaceAll("'", "''");
r = runHook(`DO LANGUAGE plpgsql '${UNBOUND_SINGLE_DO}';`);
ok(isDeny(r), "DO LANGUAGE with a single-quoted body cannot hide dynamic actor DDL");
ok(r.stdout.includes("nested-quoted"), "the single-quoted DO probe explains its fail-closed parse boundary");

const BOUND_SINGLE_DO = `BEGIN EXECUTE '${BOUND_DDL}'; END`.replaceAll("'", "''");
r = runHook(`DO LANGUAGE plpgsql '${BOUND_SINGLE_DO}';`);
ok(isDeny(r), "a nested-quoted single-string DO body fails closed even when currently bound");

const DOUBLED_QUOTE_COMMENT_BYPASS = (
  "CREATE OR REPLACE FUNCTION public.quoted_comment_actor(p_performed_by uuid) " +
  "RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN " +
  "RAISE NOTICE '-- harmless literal'; UPDATE invoices SET created_by = p_performed_by; END $fn$;"
).replaceAll("'", "''");
r = runHook(`DO $do$ BEGIN EXECUTE '${DOUBLED_QUOTE_COMMENT_BYPASS}'; END $do$;`);
ok(isDeny(r), "doubled quotes cannot turn an inner string into a fake comment that hides mutation");
ok(r.stdout.includes("nested-quoted"), "the doubled-quote denial explains the fail-closed parse boundary");

r = runHook(`DO LANGUAGE plpgsql E'${BOUND_SINGLE_DO}';`);
ok(isDeny(r), "an escape-string DO body the lexer cannot decode fails closed");
ok(r.stdout.includes("could not parse"), "the escape-string DO denial explains the parse boundary");

const SPLIT_SINGLE_DO_TAIL = `EXECUTE '${UNBOUND_DDL}'; END`.replaceAll("'", "''");
r = runHook(`DO 'BEGIN\n'\n'${SPLIT_SINGLE_DO_TAIL}';`);
ok(isDeny(r), "newline-concatenated strings cannot split a procedural body past inspection");

r = runHook(`DO U&'${UNBOUND_SINGLE_DO}';`);
ok(isDeny(r), "a Unicode-escape DO body the lexer cannot decode fails closed");

r = runHook(`DO $do$ BEGIN EXECUTE '${UNBOUND_DDL.replace("dynamic_actor(", "dynamic_actor /* legal */ (")}'; END $do$;`);
ok(isDeny(r), "a comment-hidden header inside a dynamic string is still classified and blocked");

r = runHook(`DO $do$ BEGIN EXECUTE '${UNBOUND_DDL.replace("dynamic_actor(", "dynamic_actor /* outer /* inner */ open */ (")}'; END $do$;`);
ok(isDeny(r), "a nested comment cannot hide a function header inside a dynamic string");

r = runHook(`DO $do$ BEGIN EXECUTE $ddl$${UNBOUND_DDL.replace("dynamic_actor(", "dynamic_actor /* outer /* inner */ open */ (")}$ddl$; END $do$;`);
ok(isDeny(r), "a nested comment cannot hide a dynamic dollar-quoted function header");

r = runHook(`DO $do$ BEGIN EXECUTE '${BOUND_DDL}'; END $do$;`);
ok(isDeny(r), "a nested-quoted EXECUTE string fails closed even when its current function is bound");

r = runHook(`DO $do$ BEGIN EXECUTE $ddl$${BOUND_DDL_DOLLAR}$ddl$; END $do$;`);
ok(!isDeny(r), "a bound actor function in one complete dollar-quoted EXECUTE literal remains allowed");

r = runHook("GRANT EXECUTE ON FUNCTION public.bound_actor(uuid) TO authenticated, service_role;");
ok(!isDeny(r), "GRANT EXECUTE privilege syntax is not mistaken for runtime dynamic SQL");

r = runHook("REVOKE EXECUTE ON FUNCTION public.bound_actor(uuid) FROM PUBLIC, anon;");
ok(!isDeny(r), "REVOKE EXECUTE privilege syntax is not mistaken for runtime dynamic SQL");

r = runHook(`CREATE TRIGGER trg_recalc_order_totals
AFTER INSERT OR UPDATE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.recalc_order_totals();`);
ok(!isDeny(r), "CREATE TRIGGER EXECUTE FUNCTION is declarative syntax, not runtime SQL");

r = runHook(`CREATE EVENT TRIGGER audit_ddl
ON ddl_command_end
WHEN TAG IN ('CREATE FUNCTION')
EXECUTE FUNCTION public.audit_ddl();`);
ok(!isDeny(r), "CREATE EVENT TRIGGER EXECUTE FUNCTION is declarative syntax, not runtime SQL");

r = runHook(`CREATE TRIGGER trg_safe AFTER UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.safe_trigger() EXECUTE v_ddl;`);
ok(isDeny(r), "a trigger-shaped statement with a second EXECUTE token still fails closed");

r = runHook(`CREATE TRIGGER trg_safe AFTER UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.safe_trigger() USING v_ddl;`);
ok(isDeny(r), "a trigger-shaped statement with trailing non-call syntax still fails closed");

r = runHook(`DO $do$ BEGIN
  EXECUTE 'SELECT id FROM invoices WHERE id = $1' USING p_invoice_id;
END $do$;`);
ok(!isDeny(r), "a direct command literal may bind parameters with USING");

r = runHook(`DO $do$ DECLARE v_id uuid; BEGIN
  EXECUTE 'SELECT id FROM invoices LIMIT 1' INTO v_id;
END $do$;`);
ok(!isDeny(r), "a direct command literal may capture a result with INTO");

r = runHook(`DO $do$ DECLARE v_id uuid; BEGIN
  EXECUTE ('SELECT id FROM invoices WHERE note = $1') INTO STRICT v_id USING 'safe data';
END $do$;`);
ok(!isDeny(r), "a parenthesized direct literal may use INTO STRICT and literal USING data");

r = runHook(`DO $do$ BEGIN EXECUTE v_sql USING p_invoice_id; END $do$;`);
ok(isDeny(r), "USING does not make a variable command readable");

r = runHook(`DO $do$ BEGIN EXECUTE v_sql USING 'safe data'; END $do$;`);
ok(isDeny(r), "a USING data literal is not mistaken for the command literal");

r = runHook(`DO $do$ BEGIN EXECUTE 'SELECT ' || '1' USING p_invoice_id; END $do$;`);
ok(isDeny(r), "USING does not allow a concatenated command");

r = runHook(`DO $do$ BEGIN EXECUTE format('%s', 'SELECT 1') USING p_invoice_id; END $do$;`);
ok(isDeny(r), "USING does not allow a format-built command");

r = runHook(`DO $do$ BEGIN EXECUTE 'SELECT 1' USING p_invoice_id EXECUTE v_sql; END $do$;`);
ok(isDeny(r), "a direct literal with a second EXECUTE token still fails closed");

r = runHook(`DO $do$ DECLARE v_id int; BEGIN EXECUTE 'SELECT 1' USING p_invoice_id INTO v_id; END $do$;`);
ok(isDeny(r), "USING before INTO is not accepted as a supported direct-literal shape");

const SECURE_GRANTED_FUNCTION = `CREATE OR REPLACE FUNCTION public.bound_actor(p_performed_by uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  UPDATE invoices SET created_by = auth.uid();
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.bound_actor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bound_actor(uuid) TO authenticated, service_role;`;
r = runHook(SECURE_GRANTED_FUNCTION);
ok(!isDeny(r), "a complete bound SECURITY DEFINER migration with deliberate grants remains allowed");

r = runHook(`DO $do$ DECLARE v_ddl text := $ddl$SELECT 1$ddl$; BEGIN EXECUTE v_ddl; END $do$;`);
ok(isDeny(r), "the privilege exception does not allow indirect procedural EXECUTE");

r = runHook("GRANT EXECUTE ON FUNCTION public.bound_actor(uuid) TO authenticated EXECUTE v_ddl;");
ok(isDeny(r), "a privilege-headed statement containing a second EXECUTE token still fails closed");

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

r = runHook(`DO $do$
DECLARE
  v_head text;
  v_tail text;
  v_ddl text;
BEGIN
  v_head := 'CREATE OR REPLACE ';
  v_tail := 'FUNCTION public.cross_statement_actor(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN UPDATE invoices SET created_by = p_performed_by; END $fn$;';
  v_ddl := v_head || v_tail;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "function DDL assembled across separate statements is refused");
ok(r.stdout.includes("assembled through variables or multiple statements"), "cross-statement deny explains why indirect assembly is unreadable");

r = runHook(`DO $do$ BEGIN EXECUTE format('%s', '${BOUND_DDL}'); END $do$;`);
ok(isDeny(r), "even a bound definition wrapped in format() is refused because it uses multiple literals");

r = runHook(`DO $do$
DECLARE v_suffix text := 'performed_by';
BEGIN
  EXECUTE format($fmt$CREATE FUNCTION public.templated_actor(p_%1$s uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN UPDATE invoices SET created_by = p_%1$s; END $fn$;$fmt$, v_suffix);
END $do$;`);
ok(isDeny(r), "a one-literal format() template cannot substitute an actor parameter at runtime");
ok(r.stdout.includes("supplied directly to EXECUTE"), "the template deny explains why one template literal is incomplete");

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

r = runHook(`DO $do$ DECLARE v_ddl text := '${UNBOUND_DDL}'; BEGIN EXECUTE v_ddl; END $do$;`);
ok(isDeny(r), "a declaration initializer using := cannot hide runtime DDL");

r = runHook(`DO $do$ DECLARE v_ddl text = '${UNBOUND_DDL}'; BEGIN EXECUTE v_ddl; END $do$;`);
ok(isDeny(r), "a declaration initializer using = cannot hide runtime DDL");

r = runHook(`DO $do$ DECLARE v_ddl text DEFAULT '${UNBOUND_DDL}'; BEGIN EXECUTE v_ddl; END $do$;`);
ok(isDeny(r), "a declaration initializer using DEFAULT cannot hide runtime DDL");

r = runHook(`DO $do$
DECLARE v_ddl text := 'CREATE OR REPLACE ' ||
  'FUNCTION public.declaration_split(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN UPDATE invoices SET created_by = p_performed_by; END $fn$;';
BEGIN EXECUTE v_ddl; END $do$;`);
ok(isDeny(r), "a declaration initializer split across literals is refused");

r = runHook(`DO $do$ DECLARE v_ddl text; BEGIN VALUES ('${UNBOUND_DDL}') INTO v_ddl; EXECUTE v_ddl; END $do$;`);
ok(isDeny(r), "VALUES (...) INTO runtime DDL is inspected and blocked");

r = runHook(`DO $do$ DECLARE v_ddl text; BEGIN
  VALUES ('CREATE OR REPLACE ' ||
    'FUNCTION public.values_split(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$ BEGIN UPDATE invoices SET created_by = p_performed_by; END $fn$;')
  INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "VALUES (...) INTO DDL split across literals is refused");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl := $ddl$${BOUND_DDL_DOLLAR}$ddl$;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "even a previously bound assignment cannot make indirect EXECUTE readable");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  SELECT $ddl$${BOUND_DDL_DOLLAR}$ddl$ INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "even a previously bound SELECT cannot make indirect EXECUTE readable");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  SELECT $ddl$${BOUND_DDL_DOLLAR}$ddl$ INTO v_ddl;
  SELECT body INTO STRICT v_ddl FROM ddl_staging WHERE name = 'unbound_actor_function';
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "SELECT INTO STRICT cannot overwrite a proven DDL variable without invalidating it");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  SELECT $ddl$${BOUND_DDL_DOLLAR}$ddl$ INTO v_ddl;
  EXECUTE 'SELECT body FROM ddl_staging LIMIT 1' INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "EXECUTE INTO cannot overwrite a proven DDL variable without invalidating it");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl := $ddl$${BOUND_DDL_DOLLAR}$ddl$;
  UPDATE ddl_staging SET body = current_setting('app.dynamic_ddl') RETURNING body INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "RETURNING INTO cannot make an indirect EXECUTE trustworthy");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  v_ddl := $ddl$${BOUND_DDL_DOLLAR}$ddl$;
  IF true THEN v_ddl := current_setting('app.dynamic_ddl'); END IF;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "an assignment inside IF cannot make an indirect EXECUTE trustworthy");

r = runHook(`DO $do$
DECLARE v_ddl text;
DECLARE c CURSOR FOR SELECT body FROM ddl_staging;
BEGIN
  v_ddl := $ddl$${BOUND_DDL_DOLLAR}$ddl$;
  OPEN c;
  FETCH c INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "FETCH INTO cannot make an indirect EXECUTE trustworthy");

r = runHook(`DO $do$
DECLARE v_ddl text := $ddl$${BOUND_DDL_DOLLAR}$ddl$;
BEGIN
  CALL replace_dynamic_ddl(v_ddl);
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "CALL INOUT cannot make an indirect EXECUTE trustworthy");

r = runHook(`DO $do$ BEGIN EXECUTE format('%s', 'SELECT 1'); END $do$;`);
ok(isDeny(r), "an EXECUTE expression is refused even when its current literals look harmless");

r = runHook(`DO $do$
DECLARE v_ddl text;
BEGIN
  SELECT $ddl$${UNBOUND_DDL}$ddl$ /* outer /* inner */ still open ; */ INTO v_ddl;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "a nested-comment semicolon cannot hide SELECT ... INTO runtime DDL");

r = runHook(`CREATE FUNCTION public.outer_builder() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $outer$
BEGIN
  EXECUTE '${UNBOUND_DDL.replaceAll("dynamic_actor", "nested_actor")}';
END
$outer$;`);
ok(isDeny(r), "an unbound dynamic function nested inside another function body is independently inspected");
ok(r.stdout.includes("public.nested_actor"), "the nested actor function is the offender named in the deny");

r = runHook(`CREATE FUNCTION public.outer_bound_builder() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $outer$
BEGIN
  EXECUTE '${BOUND_DDL.replaceAll("dynamic_bound", "nested_bound")}';
END
$outer$;`);
ok(isDeny(r), "a nested-quoted dynamic function fails closed even when currently bound");

r = runHook(`INSERT INTO docs (body) VALUES ('CREATE OR REPLACE ' || 'FUNCTION public.example(p_performed_by uuid)');`);
ok(!isDeny(r), "function-shaped fragments in a plain INSERT are data, not runtime DDL");

r = runHook(`UPDATE docs SET body = '${UNBOUND_DDL}' WHERE id = 1;`);
ok(!isDeny(r), "a complete function-shaped string in a plain UPDATE remains data");

r = runHook(`DO $do$ DECLARE v_ddl text; BEGIN
  INSERT INTO ddl_staging (body) VALUES ('${UNBOUND_DDL}');
  SELECT body INTO v_ddl FROM ddl_staging LIMIT 1;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "single-quoted function DDL stored inside procedural code cannot disappear from inspection");

r = runHook(`DO $do$ DECLARE v_ddl text; BEGIN
  INSERT INTO ddl_staging (body) VALUES ($ddl$${UNBOUND_DDL}$ddl$);
  SELECT body INTO v_ddl FROM ddl_staging LIMIT 1;
  EXECUTE v_ddl;
END $do$;`);
ok(isDeny(r), "dollar-quoted function DDL stored inside procedural code cannot disappear from inspection");

// ── NEGATIVE: correctly bound / out of scope / exempt ──────────────────────
r = runHook(fn(BOUND));
ok(!isDeny(r), "body raising ACTOR_MISMATCH is allowed");

r = runHook(fn(`
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  EXECUTE 'SELECT 1';
`));
ok(!isDeny(r), "a bound actor function may still use dynamic SQL");

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

const editRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-edit-"));
const editMigration = path.join(editRoot, "supabase", "migrations", "20260807000001_edit.sql");
mkdirSync(path.dirname(editMigration), { recursive: true });
const safeEditFile = fn(BOUND);
writeFileSync(editMigration, safeEditFile);
r = spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], {
  input: JSON.stringify({
    tool_input: {
      file_path: editMigration,
      old_string: "$function$;",
      new_string: "$function$;\n",
    },
  }),
  encoding: "utf8",
});
ok(!isDeny(r), "Edit fragments are reconstructed into the complete resulting migration");
rmSync(editRoot, { recursive: true, force: true });

// malformed JSON on stdin must fail OPEN, not crash the session
r = spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], { input: "not json", encoding: "utf8" });
eq(r.status, 0, "malformed stdin exits 0 (fail-open)");
ok(!isDeny(r), "malformed stdin is allowed, never denied");

console.log(`actor-binding-check: ${pass} assertions passed`);
