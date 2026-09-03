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

function proc(body, params = "p_performed_by uuid", security = "SECURITY DEFINER") {
  return `CREATE OR REPLACE PROCEDURE public.test_proc(${params}) LANGUAGE plpgsql ${security} SET search_path TO 'public', 'pg_temp' AS $procedure$\n${body}\n$procedure$;`;
}

const MUTATION = "INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);";
const BOUND = `
  DECLARE v_actor uuid;
  BEGIN
  v_actor := auth.uid();
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must equal auth.uid()';
  END IF;
  INSERT INTO financial_audit_log (actor_user_id) VALUES (v_actor);
  END;
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

const MERGE_INSERT_MUTATION = `
BEGIN
  MERGE INTO public.invoices AS target
  USING (VALUES (p_performed_by)) AS source(actor_id)
  ON false
  WHEN NOT MATCHED THEN INSERT (created_by) VALUES (source.actor_id);
END;
`;
r = runHook(fn(MERGE_INSERT_MUTATION));
ok(isDeny(r), "an unbound SECURITY DEFINER function cannot hide an actor write in a MERGE insert branch");

const MERGE_DELETE_MUTATION = `
BEGIN
  MERGE INTO public.invoices AS target
  USING (VALUES (p_performed_by)) AS source(actor_id)
  ON target.created_by = source.actor_id
  WHEN MATCHED THEN DELETE;
END;
`;
r = runHook(proc(MERGE_DELETE_MUTATION));
ok(isDeny(r), "an unbound SECURITY DEFINER procedure cannot hide an actor write in a MERGE delete branch");

const INVOKER_ACTOR_HELPER = `CREATE OR REPLACE FUNCTION public.record_event_internal(p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $helper$
BEGIN
  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_actor);
  RETURN p_actor;
END
$helper$;`;

function forwardedActorWrapper(statement) {
  const returnType = statement.startsWith("RETURN QUERY") ? "SETOF uuid" : "uuid";
  return `${INVOKER_ACTOR_HELPER}
CREATE OR REPLACE FUNCTION public.forward_actor(p_performed_by uuid)
RETURNS ${returnType} LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $wrapper$
DECLARE v_id uuid;
BEGIN
  ${statement}
END
$wrapper$;
GRANT EXECUTE ON FUNCTION public.forward_actor(uuid) TO authenticated;`;
}

r = runHook(forwardedActorWrapper("SELECT public.record_event_internal(p_performed_by) INTO v_id; RETURN v_id;"));
ok(isDeny(r), "SELECT cannot forward an unbound actor through an invoker helper from a definer wrapper");

r = runHook(forwardedActorWrapper("v_id := public.record_event_internal(p_performed_by); RETURN v_id;"));
ok(isDeny(r), "assignment cannot forward an unbound actor through a callable expression");

r = runHook(forwardedActorWrapper("RETURN public.record_event_internal(p_performed_by);"));
ok(isDeny(r), "RETURN cannot forward an unbound actor through a callable expression");

r = runHook(forwardedActorWrapper("RETURN QUERY SELECT public.record_event_internal(p_performed_by);"));
ok(isDeny(r), "RETURN QUERY cannot forward an unbound actor through a callable expression");

r = runHook(forwardedActorWrapper("RETURN public.record_event_internal($1);"));
ok(isDeny(r), "a PostgreSQL positional alias cannot forward an unbound actor through a callable expression");

function compositeForwardedActorWrapper(binding = "") {
  return `${INVOKER_ACTOR_HELPER}
CREATE OR REPLACE FUNCTION public.forward_composite_actor(p_performed_by uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $wrapper$
DECLARE v_profile public.profiles%ROWTYPE;
BEGIN
  ${binding}
  v_profile.id := p_performed_by;
  PERFORM public.record_event_internal(v_profile.id);
  RETURN v_profile.id;
END
$wrapper$;
GRANT EXECUTE ON FUNCTION public.forward_composite_actor(uuid) TO authenticated;`;
}

r = runHook(compositeForwardedActorWrapper());
ok(isDeny(r), "a composite-record field cannot forward an unbound actor through a callable expression");

r = runHook(compositeForwardedActorWrapper(`
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;`));
ok(!isDeny(r), "a composite-record field remains allowed after its source actor is soundly bound");

const UNICODE_ACTOR_PARAMETER = 'U&"p_\\0075ser_id"';
r = runHook(fn(
  `BEGIN INSERT INTO financial_audit_log (actor_user_id) VALUES (${UNICODE_ACTOR_PARAMETER}); RETURN '{}'::jsonb; END;`,
  `${UNICODE_ACTOR_PARAMETER} uuid`
));
ok(isDeny(r), "a Unicode-escaped named actor parameter cannot bypass actor binding review");

r = runHook(fn(
  "BEGIN INSERT INTO financial_audit_log (actor_user_id) VALUES ($1); RETURN '{}'::jsonb; END;",
  `${UNICODE_ACTOR_PARAMETER} uuid`
));
ok(isDeny(r), "a Unicode-escaped actor parameter cannot hide behind its PostgreSQL positional alias");

r = runHook(fn(`
  BEGIN
  IF $1 IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO financial_audit_log (actor_user_id) VALUES (auth.uid());
  RETURN '{}'::jsonb;
  END;
`, `${UNICODE_ACTOR_PARAMETER} uuid`));
ok(!isDeny(r), "a Unicode-named input remains allowed after its positional alias is soundly bound");

r = runHook(fn(
  "BEGIN PERFORM public.record_event_internal($2); RETURN '{}'::jsonb; END;",
  "p_note text, p_performed_by uuid"
));
ok(isDeny(r), "a later actor parameter keeps its exact PostgreSQL input position");

r = runHook(fn(
  "BEGIN RETURN public.record_event_internal($10); END;",
  "p_performed_by uuid, p_2 uuid, p_3 uuid, p_4 uuid, p_5 uuid, p_6 uuid, p_7 uuid, p_8 uuid, p_9 uuid, p_10 uuid"
));
ok(!isDeny(r), "$1 does not partially match PostgreSQL positional alias $10");

r = runHook(`CREATE FUNCTION public.out_gap(OUT p_result uuid, IN p_performed_by uuid)
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN p_result := public.record_event_internal($2); END
$fn$;`);
ok(isDeny(r), "an actor's PostgreSQL positional alias follows full declaration order including OUT parameters");

r = runHook(`CREATE FUNCTION public.custom_actor_refusal(p_actor public.actor_token) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $wrapper$
BEGIN
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO financial_audit_log(actor_user_id) VALUES ((p_actor).value);
END
$wrapper$;`);
ok(isDeny(r), "a custom actor declaration cannot use overloaded equality as identity proof");

r = runHook(`CREATE FUNCTION public.custom_local_actor_refusal(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $wrapper$
DECLARE v_actor public.actor_token := auth.uid();
BEGIN
  IF p_actor IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO financial_audit_log(actor_user_id) VALUES (p_actor);
END
$wrapper$;`);
ok(isDeny(r), "a custom local identity type cannot satisfy a UUID actor refusal");

r = runHook(forwardedActorWrapper("RETURN p_performed_by OPERATOR(public.##) auth.uid();"));
ok(isDeny(r), "an explicit user-defined operator cannot receive an unbound actor from a definer wrapper");

r = runHook(forwardedActorWrapper("v_id := p_performed_by; RETURN v_id OPERATOR(public.##) auth.uid();"));
ok(isDeny(r), "a local assignment cannot launder an actor into an explicit user-defined operator");

const INVOKER_ACTOR_OPERATOR = `CREATE OR REPLACE FUNCTION public.record_actor_operator(p_actor uuid, p_identity uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $helper$
BEGIN
  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_actor);
  RETURN p_actor = p_identity;
END
$helper$;
CREATE OPERATOR public.## (
  LEFTARG = uuid,
  RIGHTARG = uuid,
  FUNCTION = public.record_actor_operator
);`;

r = runHook(`${INVOKER_ACTOR_OPERATOR}
CREATE OR REPLACE FUNCTION public.forward_actor_operator(p_performed_by uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $wrapper$
BEGIN
  RETURN p_performed_by ## auth.uid();
END
$wrapper$;
GRANT EXECUTE ON FUNCTION public.forward_actor_operator(uuid) TO authenticated;`);
ok(isDeny(r), "an unqualified user-defined operator cannot receive an unbound actor from a definer wrapper");

r = runHook(forwardedActorWrapper("RETURN $1 ## auth.uid();"));
ok(isDeny(r), "an unqualified user-defined operator cannot receive a PostgreSQL positional actor alias");

r = runHook(forwardedActorWrapper("v_id := p_performed_by; RETURN auth.uid() ## v_id;"));
ok(isDeny(r), "a local assignment cannot launder an actor into either side of an unqualified operator");

const OVERLOADED_ACTOR_COMPARISON = `CREATE TYPE public.actor_token AS (value uuid);
CREATE OR REPLACE FUNCTION public.record_actor_equality(p_actor public.actor_token, p_identity public.actor_token)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $helper$
BEGIN
  INSERT INTO financial_audit_log (actor_user_id) VALUES ((p_actor).value);
  RETURN true;
END
$helper$;
CREATE OPERATOR public.= (
  LEFTARG = public.actor_token,
  RIGHTARG = public.actor_token,
  FUNCTION = public.record_actor_equality
);
CREATE OR REPLACE FUNCTION public.record_actor_uuid_equality(p_actor public.actor_token, p_identity uuid)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path TO 'public', 'pg_temp'
AS 'SELECT true';
CREATE OPERATOR public.= (
  LEFTARG = public.actor_token,
  RIGHTARG = uuid,
  FUNCTION = public.record_actor_uuid_equality
);
CREATE OR REPLACE FUNCTION public.forward_actor_equality(p_actor public.actor_token)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $wrapper$
BEGIN
  RETURN p_actor = ROW(auth.uid())::public.actor_token;
END
$wrapper$;
GRANT EXECUTE ON FUNCTION public.forward_actor_equality(public.actor_token) TO authenticated;`;

r = runHook(OVERLOADED_ACTOR_COMPARISON);
ok(isDeny(r), "an overloaded comparison operator cannot receive an unbound actor from a definer wrapper");

r = runHook(OVERLOADED_ACTOR_COMPARISON.replace(
  "BEGIN\n  RETURN p_actor = ROW(auth.uid())::public.actor_token;\nEND",
  `BEGIN
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO financial_audit_log (actor_user_id) VALUES ((p_actor).value);
  RETURN true;
END`
));
ok(isDeny(r), "an overloaded equality operator cannot make a custom actor type's mismatch refusal trustworthy");

r = runHook(`CREATE TYPE public.actor_token AS (value uuid);
CREATE FUNCTION public.actor_token_from_uuid(p_identity uuid) RETURNS public.actor_token
LANGUAGE sql IMMUTABLE AS 'SELECT ROW(p_identity)::public.actor_token';
CREATE CAST (uuid AS public.actor_token)
WITH FUNCTION public.actor_token_from_uuid(uuid) AS IMPLICIT;
CREATE FUNCTION public.uuid_actor_equality(p_identity uuid, p_actor public.actor_token)
RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
CREATE OPERATOR public.= (
  LEFTARG = uuid,
  RIGHTARG = public.actor_token,
  FUNCTION = public.uuid_actor_equality
);
CREATE FUNCTION public.custom_local_actor_refusal(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $wrapper$
DECLARE v_actor public.actor_token := auth.uid();
BEGIN
  IF p_actor IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO financial_audit_log(actor_user_id) VALUES (p_actor);
END
$wrapper$;`);
ok(isDeny(r), "a custom-typed local identity cannot make a UUID actor's mismatch refusal trustworthy");

r = runHook(OVERLOADED_ACTOR_COMPARISON.replace(
  "RETURN p_actor = ROW(auth.uid())::public.actor_token;",
  "RETURN (p_actor) = ROW(auth.uid())::public.actor_token;"
));
ok(isDeny(r), "parentheses cannot hide an actor from an overloaded comparison operator");

r = runHook(OVERLOADED_ACTOR_COMPARISON.replace(
  "RETURN p_actor = ROW(auth.uid())::public.actor_token;",
  "RETURN CAST(p_actor AS public.actor_token) = ROW(auth.uid())::public.actor_token;"
));
ok(isDeny(r), "a CAST wrapper cannot hide an actor from an overloaded comparison operator");

r = runHook(OVERLOADED_ACTOR_COMPARISON.replace(
  "RETURN p_actor = ROW(auth.uid())::public.actor_token;",
  "RETURN ROW(auth.uid())::public.actor_token = (p_actor);"
));
ok(isDeny(r), "a reverse operand cannot hide an actor from an overloaded comparison operator");

r = runHook(OVERLOADED_ACTOR_COMPARISON.replace(
  "RETURN p_actor = ROW(auth.uid())::public.actor_token;",
  "RETURN ((p_actor))::public.actor_token = ROW(auth.uid())::public.actor_token;"
));
ok(isDeny(r), "combined grouping and casts cannot hide an actor from an overloaded comparison operator");

function preRefusalCallableWrapper(prefix, helper = INVOKER_ACTOR_HELPER) {
  return `${helper}
CREATE OR REPLACE FUNCTION public.pre_refusal_actor(p_performed_by uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $wrapper$
DECLARE v_id uuid;
BEGIN
  ${prefix}
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN v_id;
END
$wrapper$;
GRANT EXECUTE ON FUNCTION public.pre_refusal_actor(uuid) TO authenticated;`;
}

r = runHook(preRefusalCallableWrapper("SELECT public.record_event_internal(p_performed_by) INTO v_id;"));
ok(isDeny(r), "SELECT cannot call a mutating actor helper before the accepted refusal");

r = runHook(preRefusalCallableWrapper("v_id := public.record_event_internal(p_performed_by);"));
ok(isDeny(r), "assignment cannot call a mutating actor helper before the accepted refusal");

r = runHook(preRefusalCallableWrapper(
  "v_id := coalesce(public.record_event_internal(p_performed_by), auth.uid());"
));
ok(isDeny(r), "a nested callable cannot mutate with an actor before the accepted refusal");

r = runHook(preRefusalCallableWrapper(
  "v_id := CASE WHEN p_performed_by ## auth.uid() THEN p_performed_by ELSE auth.uid() END;",
  INVOKER_ACTOR_OPERATOR
));
ok(isDeny(r), "an actor operator cannot execute before the accepted refusal");

r = runHook(fn("BEGIN RETURN p_performed_by = auth.uid(); END;"));
ok(isDeny(r), "an unproven actor identity comparison fails closed because its operator type is unknown");

r = runHook(forwardedActorWrapper("v_id := p_performed_by; RETURN public.record_event_internal(v_id);"));
ok(isDeny(r), "a local assignment cannot launder an unbound actor before a callable expression");

r = runHook(forwardedActorWrapper("SELECT p_performed_by INTO v_id; RETURN public.record_event_internal(v_id);"));
ok(isDeny(r), "SELECT INTO cannot launder an unbound actor before a callable expression");

r = runHook(`${INVOKER_ACTOR_HELPER}
CREATE OR REPLACE FUNCTION public.forward_actor_alias(p_performed_by uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $wrapper$
DECLARE
  v_actor ALIAS FOR p_performed_by;
BEGIN
  RETURN public.record_event_internal(v_actor);
END
$wrapper$;`);
ok(isDeny(r), "a PL/pgSQL ALIAS cannot launder an unbound actor before a callable expression");

r = runHook(fn(`BEGIN IF (p_performed_by IS NULL) THEN RETURN '{}'::jsonb; END IF; RETURN '{}'::jsonb; END;`));
ok(!isDeny(r), "control-flow parentheses alone do not turn a non-mutating definer into an actor-forwarding call");

r = runHook(fn(`BEGIN RETURN auth.uid() OPERATOR(public.##) auth.uid(); END;`));
ok(!isDeny(r), "an explicit operator with no actor reference does not trigger actor-binding review");

r = runHook(fn(`
  BEGIN
  IF $1 IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN public.record_event_internal($1);
  END;
`));
ok(!isDeny(r), "a canonical refusal may bind the actor through its PostgreSQL positional alias");

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

r = runHook(fn(
  'INSERT INTO financial_audit_log (actor_user_id) VALUES ("p_actor[");',
  '"p_actor[" uuid'
));
ok(isDeny(r) && !r.stderr.includes("internal error"),
  "a quoted actor parameter with regex metacharacters is denied without failing open");

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
const UNBOUND_PROCEDURE_DDL =
  "CREATE OR REPLACE PROCEDURE public.dynamic_actor_proc(p_performed_by uuid) " +
  "LANGUAGE plpgsql SECURITY DEFINER AS $proc$ BEGIN " +
  "INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by); END $proc$;";
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
  'delayed-actor-procedure-ddl',
  '* * * * *',
  $job$${UNBOUND_PROCEDURE_DDL}$job$
);`);
ok(isDeny(r), "top-level cron.schedule cannot hide a delayed unbound actor procedure");

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

r = runHook(`CREATE OPERATOR public.## (
  RIGHTARG = text,
  FUNCTION = public.execute_sql_readonly
);
SELECT OPERATOR(public.##) $outer$
  SELECT cron.schedule('operator-delayed-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$;`);
ok(isDeny(r), "an operator alias cannot pass function-bearing SQL to a protected executor");

r = runHook(`CREATE OPERATOR public.## (
  RIGHTARG = text,
  FUNCTION = public.execute_sql_readonly
);`);
ok(isDeny(r), "creating an operator alias for the protected executor fails closed before later use");

r = runHook(`DO $do$ BEGIN
  EXECUTE $ddl$CREATE OPERATOR public.## (
    RIGHTARG = text,
    FUNCTION = public.execute_sql_readonly
  )$ddl$;
END $do$;`);
ok(isDeny(r), "dynamic SQL cannot create an operator alias for the protected executor");

r = runHook(`CREATE OPERATOR public.## (
  RIGHTARG = text,
  FUNCTION = U&"\\0070ublic".U&"\\0065xecute_sql_readonly"
);`);
ok(isDeny(r), "a Unicode executor identity cannot hide behind an operator alias");

r = runHook(`CREATE OPERATOR public.## (
  RIGHTARG = text,
  FUNCTION = public.store_documentation
);`);
ok(!isDeny(r), "an operator definition for an unrelated function is not an executor identity alias");

r = runHook(`SELECT OPERATOR(public.##) $query$SELECT 1$query$;`);
ok(!isDeny(r), "an operator expression without function-bearing SQL remains outside this guard");

r = runHook(`COPY (SELECT $outer$
  SELECT cron.schedule('program-delayed-actor-ddl', '* * * * *',
    $job$${UNBOUND_DDL}$job$)
$outer$) TO PROGRAM 'psql';`);
ok(isDeny(r), "COPY TO PROGRAM cannot receive function-bearing SQL for an external executor");

r = runHook(`COPY (SELECT 1) TO PROGRAM $program$
  psql -c "SELECT cron.schedule('program-command-actor-ddl', '* * * * *',
    '${UNBOUND_DDL}')"
$program$;`);
ok(isDeny(r), "a COPY PROGRAM command cannot embed function-bearing SQL for psql");

r = runHook(`COPY (SELECT 1) TO PROGRAM 'gzip > /tmp/export.gz';`);
ok(!isDeny(r), "a COPY PROGRAM command without function-bearing SQL remains outside this guard");

r = runHook(`COPY (SELECT $data$ordinary export data$data$) TO STDOUT;`);
ok(!isDeny(r), "ordinary COPY data without a PROGRAM sink remains allowed");

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

r = runHook(`ALTER TABLE cron.job RENAME TO job_shadow;
UPDATE cron.job_shadow SET command = $job$${UNBOUND_DDL}$job$ WHERE jobid = 42;
ALTER TABLE cron.job_shadow RENAME TO job;`);
ok(isDeny(r), "rename-update-restore cannot hide delayed actor-forgery SQL in cron.job");
ok(r.stdout.includes("renames or moves cron.job, or renames its command column"),
  "the cron table rename reaches the dedicated identity-change guard");

r = runHook(`ALTER SCHEMA cron RENAME TO cron_shadow;
UPDATE cron_shadow.job SET command = $job$${UNBOUND_DDL}$job$ WHERE jobid = 42;
ALTER SCHEMA cron_shadow RENAME TO cron;`);
ok(isDeny(r), "schema-rename-update-restore cannot hide delayed actor-forgery SQL in cron.job");

r = runHook(`ALTER SCHEMA "cron" RENAME TO cron_shadow;`);
ok(isDeny(r), "a quoted cron schema cannot be renamed past the name-bound reader");

r = runHook(`ALTER SCHEMA public RENAME TO public_archive;`);
ok(!isDeny(r), "an unrelated schema rename remains allowed");

r = runHook(`ALTER TABLE cron.job SET SCHEMA archive;
UPDATE archive.job SET command = $job$${UNBOUND_DDL}$job$ WHERE jobid = 42;
ALTER TABLE archive.job SET SCHEMA cron;`);
ok(isDeny(r), "schema-move-update-restore cannot hide delayed actor-forgery SQL in cron.job");

r = runHook(`ALTER TABLE cron.job RENAME COLUMN command TO payload;
UPDATE cron.job SET payload = $job$${UNBOUND_DDL}$job$ WHERE jobid = 42;
ALTER TABLE cron.job RENAME COLUMN payload TO command;`);
ok(isDeny(r), "column-rename-update-restore cannot hide delayed actor-forgery SQL in cron.job");

r = runHook(`ALTER TABLE cron.job ALTER COLUMN command TYPE varchar
USING $job$${UNBOUND_DDL}$job$;`);
ok(isDeny(r), "ALTER COLUMN USING cannot rewrite cron.job.command to delayed actor-forgery SQL");

r = runHook(`ALTER TABLE public.job ALTER COLUMN command TYPE varchar USING command::varchar;`);
ok(!isDeny(r), "an unrelated job table may still rewrite its command-named column");

r = runHook(`ALTER TABLE "cron"."job" RENAME COLUMN "command" TO payload;`);
ok(isDeny(r), "quoted physical cron.job command identity changes require manual review");

r = runHook(`SET search_path = cron, public;
ALTER TABLE job RENAME TO job_shadow;`);
ok(isDeny(r), "a search-path-resolved cron job table cannot be renamed past the reader");

r = runHook(`DO $do$ BEGIN
  EXECUTE $ddl$ALTER TABLE cron.job RENAME TO job_shadow$ddl$;
END $do$;`);
ok(isDeny(r), "direct dynamic SQL cannot rename cron.job past the name-bound reader");

r = runHook(`ALTER TABLE U&"\\0063ron".job RENAME TO job_shadow;`);
ok(isDeny(r), "an opaque Unicode cron.job identity change requires manual review");

r = runHook(`ALTER TABLE cron.job RENAME COLUMN U&"\\0063ommand" TO payload;`);
ok(isDeny(r), "an opaque Unicode cron.job column rename requires manual review");

r = runHook(`ALTER TABLE public.job RENAME TO archived_job;`);
ok(!isDeny(r), "an unrelated qualified job table can still be renamed");

r = runHook(`ALTER TABLE cron.job RENAME COLUMN jobname TO display_name;`);
ok(!isDeny(r), "renaming a non-command cron.job column remains outside the SQL sink identity");

r = runHook(`SELECT 'ALTER TABLE cron.job RENAME TO documented_job';`);
ok(!isDeny(r), "cron.job identity-change text held only as data remains allowed");

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

r = runHook(`SELECT cron.schedule('renamed-column-probe', '* * * * *', 'SELECT 1');
CREATE VIEW public.cron_job_facade (job_id, payload, job_name) AS
SELECT jobid, command, jobname FROM cron.job;
UPDATE public.cron_job_facade
SET payload = $job$${UNBOUND_DDL}$job$
WHERE job_name = 'renamed-column-probe';`);
ok(isDeny(r), "an explicit view column list cannot rename an unsafe cron.job command out of inspection");

r = runHook(`CREATE VIEW public.cron_job_facade AS
SELECT jobid, command AS payload, jobname FROM cron.job;
UPDATE public.cron_job_facade
SET payload = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "a SELECT alias cannot rename an unsafe cron.job command out of inspection");

r = runHook(`CREATE VIEW public.cron_job_facade AS
SELECT jobid, command AS payload, jobname FROM cron.job;
UPDATE public.cron_job_facade
SET payload = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`);
ok(isDeny(r), "an unproven renamed cron.job column requires manual review even for harmless SQL");

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

r = runHook(`DO $do$
BEGIN
  EXECUTE $view$CREATE VIEW public.dynamic_cron_job_facade AS SELECT * FROM cron.job$view$;
END
$do$;
UPDATE public.dynamic_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "a directly executed cron.job view cannot hide an unsafe same-file command update");

r = runHook(`DO $do$
BEGIN
  EXECUTE $view$CREATE VIEW public.dynamic_cron_job_facade AS SELECT * FROM cron.job$view$;
END
$do$;
UPDATE public.dynamic_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`);
ok(!isDeny(r), "a directly executed cron.job view keeps a harmless same-file command allowed");

r = runHook(`DO $do$
BEGIN
  EXECUTE ('CREATE VIEW public.parenthesized_dynamic_cron_job_facade AS SELECT * FROM cron.job');
END
$do$;
UPDATE public.parenthesized_dynamic_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "a parenthesized direct EXECUTE literal still registers its cron.job view alias");

r = runHook(`SELECT 'CREATE VIEW public.documented_cron_job_facade AS SELECT * FROM cron.job';
UPDATE public.documented_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(!isDeny(r), "cron.job view text held only as ordinary data does not invent an executable alias");

r = runHook(`DO $do$
BEGIN
  EXECUTE $view$CREATE VIEW public.dynamic_ordinary_job_facade AS SELECT * FROM public.job$view$;
END
$do$;
UPDATE public.dynamic_ordinary_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(!isDeny(r), "a dynamically created non-cron view remains a data-only destination");

r = runHook(`CREATE TEMP VIEW unicode_source_cron_job_alias AS
SELECT * FROM U&"\\0063ron".job;
UPDATE unicode_source_cron_job_alias
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "a Unicode-escaped cron.job view source remains an unsafe command sink");

r = runHook(`CREATE TEMP VIEW unicode_source_cron_job_alias AS
SELECT * FROM U&"\\0063ron".job;
UPDATE unicode_source_cron_job_alias
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`);
ok(!isDeny(r), "a Unicode-source cron.job view keeps a direct harmless command allowed");

r = runHook(`CREATE TEMP VIEW custom_escape_cron_job_alias AS
SELECT * FROM U&"!0063ron" UESCAPE '!'.job;
UPDATE custom_escape_cron_job_alias
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`);
ok(isDeny(r), "a custom-UESCAPE cron.job view source fails closed");

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
  path.join(crossMigrationDir, "20260807000002_create_renamed_cron_job_facade.sql"),
  "CREATE VIEW persistent_renamed_cron_job_facade AS SELECT jobid, command AS payload FROM cron.job;\n"
);
const renamedColumnCrossMigrationTarget = path.join(
  crossMigrationDir,
  "20260807000003_update_renamed_cron_job_facade.sql"
);
r = runHook(`UPDATE public.persistent_renamed_cron_job_facade
SET payload = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, renamedColumnCrossMigrationTarget);
ok(isDeny(r), "a renamed cron.job command column remains fail-closed across migrations");

writeFileSync(
  path.join(crossMigrationDir, "20260807000002_create_unicode_source_facade.sql"),
  "CREATE VIEW persistent_unicode_source_facade AS SELECT * FROM U&\"\\0063ron\".job;\n"
);
const unicodeSourceCrossMigrationTarget = path.join(
  crossMigrationDir,
  "20260807000003_update_unicode_source_facade.sql"
);
r = runHook(`UPDATE public.persistent_unicode_source_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, unicodeSourceCrossMigrationTarget);
ok(isDeny(r), "a Unicode-source cron.job view remains a sink across migrations");
r = runHook(`UPDATE public.persistent_unicode_source_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, unicodeSourceCrossMigrationTarget);
ok(!isDeny(r), "a historical Unicode-source alias keeps direct harmless SQL allowed");

writeFileSync(
  path.join(crossMigrationDir, "20260807000004_rename_cron_job_facade.sql"),
  "ALTER VIEW persistent_cron_job_facade RENAME TO renamed_cron_job_facade;\n"
);
const renamedCrossMigrationTarget = path.join(
  crossMigrationDir,
  "20260807000005_update_renamed_cron_job_facade.sql"
);
r = runHook(`UPDATE public.renamed_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, renamedCrossMigrationTarget);
ok(isDeny(r), "renaming a persistent cron.job view in an earlier migration cannot erase its sink identity");

writeFileSync(
  path.join(crossMigrationDir, "20260807000006_create_temp_cron_job_facade.sql"),
  "CREATE TEMP VIEW prior_temp_cron_job_facade AS SELECT * FROM cron.job;\n"
);
const priorTempCrossMigrationTarget = path.join(
  crossMigrationDir,
  "20260807000007_update_prior_temp_cron_job_facade.sql"
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
  "20260807000008_missing_history.sql"
);
r = runHook(`UPDATE public.unknown_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, missingHistoryTarget);
ok(isDeny(r), "unreadable migration history fails closed for an unknown command target");
rmSync(crossMigrationRoot, { recursive: true, force: true });

const dynamicViewRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-dynamic-cron-view-"));
const dynamicViewDir = path.join(dynamicViewRoot, "supabase", "migrations");
mkdirSync(dynamicViewDir, { recursive: true });
writeFileSync(
  path.join(dynamicViewDir, "20260807000001_create_dynamic_cron_job_facade.sql"),
  `DO $do$
BEGIN
  EXECUTE $view$CREATE VIEW public.dynamic_persistent_cron_job_facade AS SELECT * FROM cron.job$view$;
  EXECUTE 'CREATE VIEW public.quoted_dynamic_cron_job_facade AS SELECT * FROM cron.job WHERE ''cron'' = ''cron''';
END
$do$;\n`
);
const dynamicCrossMigrationTarget = path.join(
  dynamicViewDir,
  "20260807000002_update_dynamic_cron_job_facade.sql"
);
r = runHook(`UPDATE public.dynamic_persistent_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, dynamicCrossMigrationTarget);
ok(isDeny(r), "a dynamically created persistent cron.job view remains an unsafe sink across migrations");
r = runHook(`UPDATE public.dynamic_persistent_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, dynamicCrossMigrationTarget);
ok(!isDeny(r), "a dynamically created persistent cron.job view keeps harmless cross-file SQL allowed");
r = runHook(`UPDATE public.quoted_dynamic_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, dynamicCrossMigrationTarget);
ok(isDeny(r), "a quoted direct EXECUTE view with inner string data remains unsafe across migrations");
r = runHook(`UPDATE public.quoted_dynamic_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, dynamicCrossMigrationTarget);
ok(!isDeny(r), "a quoted direct EXECUTE view with inner string data keeps harmless SQL allowed");

writeFileSync(
  path.join(dynamicViewDir, "20260807000002_move_and_rename_dynamic_cron_job_facade.sql"),
  `DO $do$
BEGIN
  EXECUTE 'ALTER VIEW public.dynamic_persistent_cron_job_facade SET SCHEMA archive';
  EXECUTE 'ALTER VIEW archive.dynamic_persistent_cron_job_facade RENAME TO dynamic_renamed_cron_job_facade';
END
$do$;\n`
);
const dynamicLifecycleTarget = path.join(
  dynamicViewDir,
  "20260807000003_update_dynamic_renamed_cron_job_facade.sql"
);
r = runHook(`UPDATE archive.dynamic_renamed_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, dynamicLifecycleTarget);
ok(isDeny(r), "dynamic schema movement and rename cannot erase a persistent cron.job alias");
r = runHook(`UPDATE archive.dynamic_renamed_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, dynamicLifecycleTarget);
ok(!isDeny(r), "a dynamically moved and renamed alias keeps harmless SQL allowed");

writeFileSync(
  path.join(dynamicViewDir, "20260807000004_create_dynamic_temp_cron_job_facade.sql"),
  `DO $do$
BEGIN
  EXECUTE $view$CREATE TEMP VIEW dynamic_prior_temp_cron_job_facade AS SELECT * FROM cron.job$view$;
END
$do$;\n`
);
const dynamicTempTarget = path.join(
  dynamicViewDir,
  "20260807000005_update_dynamic_prior_temp_cron_job_facade.sql"
);
r = runHook(`UPDATE public.dynamic_prior_temp_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, dynamicTempTarget);
ok(!isDeny(r), "a dynamically created temporary view does not persist into a later migration");
rmSync(dynamicViewRoot, { recursive: true, force: true });

const scheduledViewRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-scheduled-cron-view-"));
const scheduledViewDir = path.join(scheduledViewRoot, "supabase", "migrations");
mkdirSync(scheduledViewDir, { recursive: true });
writeFileSync(
  path.join(scheduledViewDir, "20260807000001_schedule_cron_job_facades.sql"),
  `SELECT cron.schedule(
  'create-scheduled-cron-job-facade',
  '* * * * *',
  $command$CREATE VIEW public.scheduled_cron_job_facade AS SELECT * FROM cron.job$command$
);
SELECT cron.schedule(
  job_name => 'create-named-scheduled-cron-job-facade',
  schedule => '* * * * *',
  command => $command$CREATE VIEW public.named_scheduled_cron_job_facade AS SELECT * FROM cron.job$command$
);
SELECT cron.alter_job(
  42,
  '* * * * *',
  $command$CREATE VIEW public.altered_scheduled_cron_job_facade AS SELECT * FROM cron.job$command$,
  active => true
);
SELECT cron.schedule_in_database(
  'create-cross-db-scheduled-cron-job-facade',
  '* * * * *',
  $command$CREATE VIEW public.cross_db_scheduled_cron_job_facade AS SELECT * FROM cron.job$command$,
  'postgres',
  active => true
);
SELECT cron.schedule(
  'create-nested-scheduled-cron-job-facade',
  '* * * * *',
  $outer$SELECT cron.schedule(
    'nested-create-view',
    '* * * * *',
    $inner$CREATE VIEW public.nested_scheduled_cron_job_facade AS SELECT * FROM cron.job$inner$
  )$outer$
);
SELECT cron.schedule(
  'create-scheduled-temp-cron-job-facade',
  '* * * * *',
  $command$CREATE TEMP VIEW scheduled_temp_cron_job_facade AS SELECT * FROM cron.job$command$
);
SELECT public.schedule(
  'ordinary-non-cron-call',
  '* * * * *',
  $command$CREATE VIEW public.ordinary_scheduled_job_facade AS SELECT * FROM cron.job$command$
);
SELECT cron.schedule(
  'create-scheduled-non-cron-facade',
  '* * * * *',
  $command$CREATE VIEW public.scheduled_non_cron_facade AS SELECT * FROM public.job$command$
);
DO $do$
BEGIN
  PERFORM cron.schedule(
    'create-procedural-scheduled-cron-job-facade',
    '* * * * *',
    $command$CREATE VIEW public.procedural_scheduled_cron_job_facade AS SELECT * FROM cron.job$command$
  );
END
$do$;
`
);
writeFileSync(
  path.join(scheduledViewDir, "20260807000002_move_scheduled_cron_job_facade.sql"),
  `SELECT cron.schedule(
  'move-scheduled-cron-job-facade',
  '* * * * *',
  $command$ALTER VIEW public.scheduled_cron_job_facade SET SCHEMA archive;
ALTER VIEW archive.scheduled_cron_job_facade RENAME TO renamed_scheduled_cron_job_facade$command$
);
`
);
const scheduledCrossMigrationTarget = path.join(
  scheduledViewDir,
  "20260807000003_update_scheduled_cron_job_facades.sql"
);
for (const alias of [
  "public.named_scheduled_cron_job_facade",
  "public.altered_scheduled_cron_job_facade",
  "public.cross_db_scheduled_cron_job_facade",
  "public.nested_scheduled_cron_job_facade",
  "public.procedural_scheduled_cron_job_facade",
  "archive.renamed_scheduled_cron_job_facade",
]) {
  r = runHook(`UPDATE ${alias}
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, scheduledCrossMigrationTarget);
  ok(isDeny(r), `a delayed pg_cron command keeps ${alias} unsafe across migrations`);
  r = runHook(`UPDATE ${alias}
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, scheduledCrossMigrationTarget);
  ok(!isDeny(r), `a delayed pg_cron alias keeps harmless SQL allowed through ${alias}`);
}
r = runHook(`UPDATE public.scheduled_temp_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, scheduledCrossMigrationTarget);
ok(!isDeny(r), "a view created in a delayed TEMP command does not persist across migrations");
r = runHook(`UPDATE public.ordinary_scheduled_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, scheduledCrossMigrationTarget);
ok(!isDeny(r), "an ordinary non-cron schedule-like call does not invent a persistent alias");
r = runHook(`UPDATE public.scheduled_non_cron_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, scheduledCrossMigrationTarget);
ok(!isDeny(r), "a delayed view over a non-cron relation remains ordinary data");
rmSync(scheduledViewRoot, { recursive: true, force: true });

const opaqueScheduledViewRoot = mkdtempSync(
  path.join(os.tmpdir(), "actor-binding-opaque-scheduled-cron-view-")
);
const opaqueScheduledViewDir = path.join(opaqueScheduledViewRoot, "supabase", "migrations");
mkdirSync(opaqueScheduledViewDir, { recursive: true });
writeFileSync(
  path.join(opaqueScheduledViewDir, "20260807000001_schedule_opaque_cron_job_facade.sql"),
  `SELECT cron.schedule(
  'create-opaque-scheduled-cron-job-facade',
  '* * * * *',
  $command$DO E'BEGIN EXECUTE ''CREATE VIEW public.opaque_scheduled_cron_job_facade AS SELECT * FROM cron.job''; END'$command$
);
`
);
const opaqueScheduledTarget = path.join(
  opaqueScheduledViewDir,
  "20260807000002_update_opaque_scheduled_cron_job_facade.sql"
);
r = runHook(`UPDATE public.opaque_scheduled_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, opaqueScheduledTarget);
ok(isDeny(r), "an unreadable delayed pg_cron alias lifecycle fails closed across migrations");
r = runHook(`UPDATE public.opaque_scheduled_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, opaqueScheduledTarget);
ok(!isDeny(r), "the delayed pg_cron manual-review fallback keeps harmless SQL allowed");
rmSync(opaqueScheduledViewRoot, { recursive: true, force: true });

const builtScheduledViewRoot = mkdtempSync(
  path.join(os.tmpdir(), "actor-binding-built-scheduled-cron-view-")
);
const builtScheduledViewDir = path.join(builtScheduledViewRoot, "supabase", "migrations");
mkdirSync(builtScheduledViewDir, { recursive: true });
writeFileSync(
  path.join(builtScheduledViewDir, "20260807000001_schedule_built_cron_job_facade.sql"),
  `SELECT cron.schedule(
  'create-built-scheduled-cron-job-facade',
  '* * * * *',
  'CREATE ' || 'VIEW public.built_scheduled_cron_job_facade AS SELECT * FROM cron.' || 'job'
);
`
);
const builtScheduledTarget = path.join(
  builtScheduledViewDir,
  "20260807000002_update_built_scheduled_cron_job_facade.sql"
);
r = runHook(`UPDATE public.built_scheduled_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, builtScheduledTarget);
ok(isDeny(r), "an opaque built pg_cron alias lifecycle fails closed across migrations");
r = runHook(`UPDATE public.built_scheduled_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, builtScheduledTarget);
ok(!isDeny(r), "the built pg_cron manual-review fallback keeps harmless SQL allowed");
rmSync(builtScheduledViewRoot, { recursive: true, force: true });

const proceduralBuiltScheduledViewRoot = mkdtempSync(
  path.join(os.tmpdir(), "actor-binding-procedural-built-scheduled-cron-view-")
);
const proceduralBuiltScheduledViewDir = path.join(
  proceduralBuiltScheduledViewRoot,
  "supabase",
  "migrations"
);
mkdirSync(proceduralBuiltScheduledViewDir, { recursive: true });
writeFileSync(
  path.join(
    proceduralBuiltScheduledViewDir,
    "20260807000001_schedule_procedural_built_cron_job_facade.sql"
  ),
  `DO $do$
BEGIN
  PERFORM cron.schedule(
    'create-procedural-built-scheduled-cron-job-facade',
    '* * * * *',
    'CREATE ' || 'VIEW public.procedural_built_scheduled_cron_job_facade ' ||
      'AS SELECT * FROM cron.' || 'job'
  );
END
$do$;
`
);
const proceduralBuiltScheduledTarget = path.join(
  proceduralBuiltScheduledViewDir,
  "20260807000002_update_procedural_built_scheduled_cron_job_facade.sql"
);
r = runHook(`UPDATE public.procedural_built_scheduled_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, proceduralBuiltScheduledTarget);
ok(isDeny(r), "an opaque pg_cron alias builder inside procedural SQL fails closed across migrations");
r = runHook(`UPDATE public.procedural_built_scheduled_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, proceduralBuiltScheduledTarget);
ok(!isDeny(r), "the procedural pg_cron manual-review fallback keeps harmless SQL allowed");
rmSync(proceduralBuiltScheduledViewRoot, { recursive: true, force: true });

const encodedViewRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-encoded-cron-view-"));
const encodedViewDir = path.join(encodedViewRoot, "supabase", "migrations");
mkdirSync(encodedViewDir, { recursive: true });
writeFileSync(
  path.join(encodedViewDir, "20260807000001_create_encoded_cron_job_facade.sql"),
  `DO E'BEGIN EXECUTE ''CREATE VIEW public.encoded_dynamic_cron_job_facade AS SELECT * FROM cron.job''; END';\n`
);
const encodedDynamicTarget = path.join(
  encodedViewDir,
  "20260807000002_update_encoded_dynamic_cron_job_facade.sql"
);
r = runHook(`UPDATE public.encoded_dynamic_cron_job_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, encodedDynamicTarget);
ok(isDeny(r), "an unreadable encoded executable alias requires manual review across migrations");
r = runHook(`UPDATE public.encoded_dynamic_cron_job_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, encodedDynamicTarget);
ok(!isDeny(r), "the encoded-alias manual-review fallback still permits harmless commands");
rmSync(encodedViewRoot, { recursive: true, force: true });

const unicodeAliasRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-cron-unicode-alias-"));
const unicodeAliasDir = path.join(unicodeAliasRoot, "supabase", "migrations");
mkdirSync(unicodeAliasDir, { recursive: true });
writeFileSync(
  path.join(unicodeAliasDir, "20260807000001_create_unicode_named_facade.sql"),
  "CREATE VIEW U&\"\\0075nicode_named_facade\" AS SELECT * FROM cron.job;\n"
);
const unicodeNamedCrossMigrationTarget = path.join(
  unicodeAliasDir,
  "20260807000002_update_unicode_named_facade.sql"
);
r = runHook(`UPDATE public.unicode_named_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, unicodeNamedCrossMigrationTarget);
ok(isDeny(r), "an opaque Unicode view identity fails closed across migrations");
r = runHook(`UPDATE public.unicode_named_facade
SET command = $job$SELECT public.existing_safe_job()$job$
WHERE jobid = 42;`, unicodeNamedCrossMigrationTarget);
ok(!isDeny(r), "an opaque Unicode view identity still permits direct harmless SQL");
rmSync(unicodeAliasRoot, { recursive: true, force: true });

const unicodeRenameRoot = mkdtempSync(path.join(os.tmpdir(), "actor-binding-cron-unicode-rename-"));
const unicodeRenameDir = path.join(unicodeRenameRoot, "supabase", "migrations");
mkdirSync(unicodeRenameDir, { recursive: true });
writeFileSync(
  path.join(unicodeRenameDir, "20260807000001_create_rename_facade.sql"),
  "CREATE VIEW persistent_cron_job_facade AS SELECT * FROM cron.job;\n"
);
writeFileSync(
  path.join(unicodeRenameDir, "20260807000002_rename_facade_to_unicode.sql"),
  "ALTER VIEW persistent_cron_job_facade RENAME TO U&\"\\0075nicode_renamed_facade\";\n"
);
const unicodeRenameCrossMigrationTarget = path.join(
  unicodeRenameDir,
  "20260807000003_update_unicode_renamed_facade.sql"
);
r = runHook(`UPDATE public.unicode_renamed_facade
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, unicodeRenameCrossMigrationTarget);
ok(isDeny(r), "renaming a tracked alias through Unicode notation fails closed");
rmSync(unicodeRenameRoot, { recursive: true, force: true });

const unicodeRenameSourceRoot = mkdtempSync(
  path.join(os.tmpdir(), "actor-binding-cron-unicode-rename-source-")
);
const unicodeRenameSourceDir = path.join(unicodeRenameSourceRoot, "supabase", "migrations");
mkdirSync(unicodeRenameSourceDir, { recursive: true });
writeFileSync(
  path.join(unicodeRenameSourceDir, "20260807000001_create_rename_source_facade.sql"),
  "CREATE VIEW persistent_cron_job_facade AS SELECT * FROM cron.job;\n"
);
writeFileSync(
  path.join(unicodeRenameSourceDir, "20260807000002_rename_facade_from_unicode.sql"),
  "ALTER VIEW U&\"\\0070ersistent_cron_job_facade\" RENAME TO renamed_from_unicode;\n"
);
const unicodeRenameSourceTarget = path.join(
  unicodeRenameSourceDir,
  "20260807000003_update_renamed_from_unicode.sql"
);
r = runHook(`UPDATE public.renamed_from_unicode
SET command = $job$${UNBOUND_DDL}$job$
WHERE jobid = 42;`, unicodeRenameSourceTarget);
ok(isDeny(r), "a Unicode-spelled source alias cannot escape rename tracking");
rmSync(unicodeRenameSourceRoot, { recursive: true, force: true });

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

r = runHook("GRANT EXECUTE ON PROCEDURE public.post_invoice(uuid) TO authenticated;");
ok(!isDeny(r), "GRANT EXECUTE ON PROCEDURE is declarative privilege syntax");

r = runHook("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;");
ok(!isDeny(r), "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA is declarative privilege syntax");

r = runHook(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT EXECUTE ON FUNCTIONS TO authenticated;`);
ok(!isDeny(r), "ALTER DEFAULT PRIVILEGES GRANT EXECUTE is declarative privilege syntax");

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

const SHADOWED_UUID_SETUP = `CREATE DOMAIN public.uuid AS pg_catalog.uuid;
SET search_path = public, pg_catalog;
CREATE FUNCTION public.shadowed_uuid_eq(public.uuid, pg_catalog.uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $eq$SELECT true$eq$;
CREATE OPERATOR public.= (
  LEFTARG = public.uuid,
  RIGHTARG = pg_catalog.uuid,
  FUNCTION = public.shadowed_uuid_eq
);
CREATE FUNCTION public.shadowed_local_uuid_eq(pg_catalog.uuid, public.uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $eq$SELECT true$eq$;
CREATE OPERATOR public.= (
  LEFTARG = pg_catalog.uuid,
  RIGHTARG = public.uuid,
  FUNCTION = public.shadowed_local_uuid_eq
);
CREATE FUNCTION public.shadowed_catalog_uuid_eq(pg_catalog.uuid, pg_catalog.uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $eq$SELECT true$eq$;
CREATE OPERATOR public.= (
  LEFTARG = pg_catalog.uuid,
  RIGHTARG = pg_catalog.uuid,
  FUNCTION = public.shadowed_catalog_uuid_eq
);`;

r = runHook(`${SHADOWED_UUID_SETUP}
CREATE FUNCTION public.shadowed_actor_parameter(p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
BEGIN
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor);
END
$body$;`);
ok(isDeny(r), "a search-path shadowed bare uuid actor cannot prove caller identity");

r = runHook(`${SHADOWED_UUID_SETUP}
CREATE FUNCTION public.shadowed_actor_local(p_actor pg_catalog.uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF p_actor IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor);
END
$body$;`);
ok(isDeny(r), "a search-path shadowed bare uuid local cannot prove caller identity");

r = runHook(`${SHADOWED_UUID_SETUP}
CREATE FUNCTION public.shadowed_uuid_operator(p_actor pg_catalog.uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $body$
BEGIN
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor);
END
$body$;`);
ok(isDeny(r), "a user-schema equality operator cannot impersonate pg_catalog uuid identity");

r = runHook(`${SHADOWED_UUID_SETUP}
CREATE FUNCTION public.catalog_first_uuid_actor(p_actor pg_catalog.uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
BEGIN
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor);
END
$body$;`);
ok(!isDeny(r), "implicit catalog-first lookup keeps explicit pg_catalog uuid identity reviewable");

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
  BEGIN
    IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(!isDeny(r), "the current-main actor-specific authenticated-user refusal remains compatible");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(!isDeny(r), "the current-August stable v_actor refusal remains compatible");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    BEGIN
      RAISE EXCEPTION '%', p_performed_by;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_actor = MESSAGE_TEXT;
    END;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    INSERT INTO financial_audit_log (actor_user_id) VALUES (v_actor);
  END
`));
ok(isDeny(r), "GET STACKED DIAGNOSTICS cannot launder a forged actor into a trusted auth.uid local");

r = runHook(fn(`
  DECLARE
    v_previous_subject text;
  BEGIN
    v_previous_subject := pg_catalog."set_config"(
      'request.jwt.claim.sub',
      p_performed_by::text,
      true
    );
    IF p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);
  END
`));
ok(isDeny(r), "a quoted callable cannot replace the JWT subject before the actor refusal");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid() OPERATOR(public.##) p_target;
  BEGIN
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`, "p_performed_by uuid, p_target uuid"));
ok(isDeny(r), "a declaration initializer must bind the local to exactly auth.uid()");

r = runHook(fn(`
  DECLARE
    v_actor uuid;
  BEGIN
    v_actor := auth.uid() OPERATOR(public.##) p_target;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`, "p_performed_by uuid, p_target uuid"));
ok(isDeny(r), "a later assignment must bind the local to exactly auth.uid()");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
      RAISE EXCEPTION 'ACTOR_MISMATCH';
    END IF;
    INSERT INTO financial_audit_log (actor_user_id) VALUES (v_actor);
  END
`));
ok(!isDeny(r), "an explicit nullable actor guard may use <> after its non-null check");

r = runHook(fn(`
  BEGIN
    IF p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'ACTOR_MISMATCH';
    END IF;
    BEGIN
      PERFORM public.cleanup_after_write();
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);
  END
`));
ok(!isDeny(r), "a nested handler after an outer actor refusal does not create a false denial");

r = runHook(fn(`
  DECLARE
    v_actor uuid;
  BEGIN
    v_actor := auth.uid();
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(!isDeny(r), "an unconditional top-level auth.uid assignment remains compatible");

r = runHook(fn(`
  DECLARE
    v_actor uuid;
  BEGIN
    IF false THEN
      v_actor := auth.uid();
    END IF;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a conditional auth.uid assignment cannot establish a stable identity binding");

r = runHook(fn(`
  BEGIN
    IF p_created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_created_by does not match authenticated user';
    END IF;
    INSERT INTO financial_audit_log (actor_user_id) VALUES (p_approved_by);
  END
`, "p_created_by uuid, p_approved_by uuid"));
ok(isDeny(r), "one guarded actor parameter cannot clear a second unguarded actor parameter");

r = runHook(fn(`
  BEGIN
    IF p_created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_created_by does not match authenticated user';
    END IF;
    IF p_approved_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_approved_by does not match authenticated user';
    END IF;
    INSERT INTO financial_audit_log (actor_user_id) VALUES (p_approved_by);
  END
`, "p_created_by uuid, p_approved_by uuid"));
ok(!isDeny(r), "independent enforced refusals preserve multiple actor parameters");

r = runHook(fn(
  'BEGIN\n' +
    'IF "p_actor[" IS DISTINCT FROM auth.uid() THEN\n' +
    "  RAISE EXCEPTION 'p_actor[ does not match authenticated user';\n" +
    "END IF;\n" +
    'INSERT INTO financial_audit_log (actor_user_id) VALUES ("p_actor[");\n' +
    'END',
  '"p_actor[" uuid'
));
ok(!isDeny(r), "a metacharacter actor name can use an enforced authenticated-user refusal");

r = runHook(fn(`
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE NOTICE 'p_performed_by does not match authenticated user';
  END IF;
  ${MUTATION}
`));
ok(isDeny(r), "a legacy refusal emitted only as RAISE NOTICE does not count");

r = runHook(fn(`
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    v_message := 'p_performed_by does not match authenticated user';
  END IF;
  ${MUTATION}
`));
ok(isDeny(r), "a legacy refusal assigned as data does not count");

r = runHook(fn(`
  PERFORM 'p_performed_by does not match authenticated user';
  ${MUTATION}
`));
ok(isDeny(r), "an unrelated legacy-refusal string does not count");

r = runHook(fn(
  "RAISE EXCEPTION 'p_performed_by does not match authenticated user';\n" + MUTATION
));
ok(isDeny(r), "an unconditional legacy RAISE EXCEPTION does not prove actor binding");

r = runHook(fn(`
  IF p_invoice_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  ${MUTATION}
`, "p_performed_by uuid, p_invoice_id uuid"));
ok(isDeny(r), "a comparison involving a different parameter does not bind the actor");

r = runHook(fn(`
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_created_by does not match authenticated user';
  END IF;
  ${MUTATION}
`));
ok(isDeny(r), "a legacy exception naming a different parameter does not bind the actor");

r = runHook(fn(`
  IF false AND p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  ${MUTATION}
`));
ok(isDeny(r), "an always-false condition cannot disguise a legacy refusal");

r = runHook(fn(`
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    IF false THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
  END IF;
  ${MUTATION}
`));
ok(isDeny(r), "a legacy exception hidden behind a nested false branch does not count");

r = runHook(fn(`
  BEGIN
    BEGIN
      IF p_performed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'p_performed_by does not match authenticated user';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a swallowed legacy exception cannot satisfy actor binding");

r = runHook(fn(`
  BEGIN
    IF p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    ${MUTATION}
  END
`));
ok(isDeny(r), "an exception handler cannot turn a top-level refusal into a forged mutation");

r = runHook(fn(`
  DECLARE
    v_iteration integer;
  BEGIN
    FOR v_iteration IN 1..0 LOOP
      IF p_performed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'p_performed_by does not match authenticated user';
      END IF;
    END LOOP;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a legacy guard inside a zero-iteration loop does not count");

r = runHook(fn(`
  DECLARE
    v_row record;
  BEGIN
    FOR v_row IN SELECT 1 AS "END LOOP" WHERE false LOOP
      IF p_performed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'p_performed_by does not match authenticated user';
      END IF;
    END LOOP;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a quoted END LOOP alias cannot cancel an enclosing zero-iteration loop");

r = runHook(fn(`
  DECLARE
    "END IF" boolean := false;
  BEGIN
    IF p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(!isDeny(r), "a harmless quoted END IF identifier does not corrupt top-level guard depth");

r = runHook(fn(`
  BEGIN
    CASE "END CASE"
      WHEN 0 THEN
        IF p_performed_by IS DISTINCT FROM auth.uid() THEN
          RAISE EXCEPTION 'p_performed_by does not match authenticated user';
        END IF;
      ELSE NULL;
    END CASE;
    ${MUTATION}
  END
`, '"END CASE" integer, p_performed_by uuid'));
ok(isDeny(r), "a quoted END CASE parameter cannot cancel an enclosing CASE branch");

r = runHook(fn(`
  BEGIN
    ${MUTATION}
    IF p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
  END
`));
ok(isDeny(r), "a legacy guard after a recognized mutation does not dominate it");

r = runHook(fn(`
  BEGIN
    IF p_performed_by IS NOT NULL THEN
      RETURN public.record_actor(p_performed_by);
    END IF;
    IF p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
    RETURN '{}'::jsonb;
  END
`));
ok(isDeny(r), "an early RETURN through a side-effecting helper cannot bypass actor binding");

r = runHook(fn(`
  BEGIN
    IF p_performed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
    RETURN '{}'::jsonb;
  END
`));
ok(!isDeny(r), "a RETURN after the actor guard and mutation remains compatible");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    FOREACH v_actor IN ARRAY ARRAY[p_performed_by] LOOP
      NULL;
    END LOOP;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a FOREACH loop target cannot overwrite a stable auth.uid binding");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    CALL public.overwrite_actor(v_actor);
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a CALL argument cannot be assumed to preserve a stable auth.uid binding");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    v_actor := p_performed_by;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a reassigned auth.uid local cannot satisfy the legacy guard");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    "v_actor" := p_performed_by;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a quoted spelling cannot hide an auth.uid binding overwrite");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    U&"\\0076_actor" := p_performed_by;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a Unicode spelling cannot hide an auth.uid binding overwrite");

r = runHook(fn(`
  BEGIN
    IF p_performed_by <> auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a null-unsafe <> comparison cannot satisfy the legacy guard");

r = runHook(fn(`
  BEGIN
    IF p_performed_by != auth.uid() THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a null-unsafe != comparison cannot satisfy the legacy guard");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    test_fn.v_actor := p_performed_by;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a function-block-qualified reassignment cannot preserve a stable auth.uid binding");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    "test_fn".v_actor := p_performed_by;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a quoted function-block qualifier cannot hide an auth.uid binding overwrite");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    U&"\\0074est_fn".v_actor := p_performed_by;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a Unicode function-block qualifier cannot hide an auth.uid binding overwrite");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
    v_note text;
  BEGIN
    test_fn.v_note := 'harmless';
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    INSERT INTO financial_audit_log (actor_user_id) VALUES (v_actor);
  END
`));
ok(!isDeny(r), "a harmless function-block-qualified assignment leaves the auth.uid binding stable");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    v_actor = p_performed_by;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a local reassigned with legacy equals syntax cannot satisfy the guard");

r = runHook(fn(`
  DECLARE
    v_actor uuid := auth.uid();
  BEGIN
    SELECT p_performed_by INTO v_actor;
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a local overwritten through SELECT INTO cannot satisfy the guard");

r = runHook(fn(`
  DECLARE
    v_actor uuid := p_performed_by;
  BEGIN
    IF p_performed_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'p_performed_by does not match authenticated user';
    END IF;
    ${MUTATION}
  END
`));
ok(isDeny(r), "a local not initialized from auth.uid cannot satisfy the legacy guard");

r = runHook(fn(
  "-- p_performed_by does not match authenticated user\n" + MUTATION
));
ok(isDeny(r), "the current-main refusal text inside a comment does not count as actor binding");

r = runHook(fn(
  "RAISE EXCEPTION 'p_performed_by does not match authenticated user';\n" + MUTATION,
  "p_created_by uuid"
));
ok(isDeny(r), "a refusal naming a different actor parameter does not satisfy the guard");

r = runHook(fn(`
  BEGIN
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  EXECUTE 'SELECT 1';
  END;
`));
ok(!isDeny(r), "a bound actor function may still use dynamic SQL");

r = runHook(fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER"));
ok(!isDeny(r), "SECURITY INVOKER function is out of scope (RLS still applies)");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER").replace("test_fn", "later_definer") +
  "\nALTER FUNCTION public.later_definer(uuid) SECURITY DEFINER;"
);
ok(isDeny(r), "ALTER FUNCTION SECURITY DEFINER cannot elevate an unbound actor mutator past the guard");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER").replace("test_fn", "volatile_later_definer") +
  "\nALTER FUNCTION public.volatile_later_definer(uuid) VOLATILE SECURITY DEFINER;"
);
ok(isDeny(r), "a preceding ALTER FUNCTION action cannot hide SECURITY DEFINER elevation");

r = runHook(
  proc(MUTATION, "p_performed_by uuid", "SECURITY INVOKER").replace("test_proc", "external_later_definer") +
  "\nALTER PROCEDURE public.external_later_definer(uuid) EXTERNAL SECURITY DEFINER;"
);
ok(isDeny(r), "ALTER PROCEDURE EXTERNAL SECURITY DEFINER cannot bypass actor review");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER").replace("test_fn", "final_alter_invoker") +
  "\nALTER FUNCTION public.final_alter_invoker(uuid) SECURITY DEFINER VOLATILE SECURITY INVOKER;"
);
ok(!isDeny(r), "the final security mode in a complete ALTER action list is authoritative");

r = runHook(
  fn(BOUND, "p_performed_by uuid", "SECURITY INVOKER").replace("test_fn", "bound_later_definer") +
  "\nALTER ROUTINE public.bound_later_definer(uuid) SECURITY DEFINER;"
);
ok(!isDeny(r), "ALTER ROUTINE SECURITY DEFINER keeps a correctly bound actor mutator allowed");

r = runHook(
  fn("UPDATE invoices SET note = p_note;", "p_note text", "SECURITY INVOKER")
    .replace("test_fn", "overloaded_actor") +
  "\nALTER FUNCTION public.overloaded_actor(uuid) SECURITY DEFINER;"
);
ok(isDeny(r), "a readable safe overload cannot hide SECURITY DEFINER elevation of another signature");

r = runHook(proc(MUTATION));
ok(isDeny(r), "an unbound SECURITY DEFINER procedure cannot forge its actor parameter");

const INTERNAL_ONLY_PROC = proc(MUTATION).replace(
  /;$/,
  `;
REVOKE ALL ON PROCEDURE public.test_proc(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON PROCEDURE public.test_proc(uuid) TO postgres;`
);
r = runHook(INTERNAL_ONLY_PROC);
ok(isDeny(r), "static client-role revokes cannot prove an unbound actor procedure is unreachable");

r = runHook(`${INTERNAL_ONLY_PROC}
GRANT EXECUTE ON PROCEDURE public.test_proc(uuid) TO authenticated;`);
ok(isDeny(r), "a later authenticated grant reopens an internal procedure to actor binding review");

r = runHook(`${INTERNAL_ONLY_PROC}
GRANT EXECUTE ON PROCEDURE public.test_proc(uuid) TO U&"\\0061uthenticated";`);
ok(isDeny(r), "a Unicode-escaped authenticated procedure grant remains under actor binding review");

r = runHook(`${INTERNAL_ONLY_PROC}
GRANT EXECUTE ON PROCEDURE public.test_proc(uuid) TO office_workers;`);
ok(isDeny(r), "an unrecognized role grant remains under actor binding review");

const INTERNAL_ONLY_FN = fn(MUTATION).replace(
  /;$/,
  `;
REVOKE ALL ON FUNCTION public.test_fn(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.test_fn(uuid) TO postgres;`
);
r = runHook(`${INTERNAL_ONLY_FN}
DO $do$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.test_fn(uuid) TO authenticated';
END
$do$;`);
ok(isDeny(r), "a dynamic authenticated re-grant cannot reopen an internal actor mutator");

r = runHook(`${INTERNAL_ONLY_FN}
DO $do$
DECLARE
  v_acl text := 'GR' || 'ANT EXECUTE ON FUNCTION public.test_fn(uuid) TO authenticated';
BEGIN
  EXECUTE v_acl;
END
$do$;`);
ok(isDeny(r), "an assembled dynamic re-grant cannot reopen an internal actor mutator");

r = runHook(`${INTERNAL_ONLY_FN}
SELECT cron.schedule(
  'reopen-internal-actor-mutator',
  '* * * * *',
  $job$GRANT EXECUTE ON FUNCTION public.test_fn(uuid) TO authenticated$job$
);`);
ok(isDeny(r), "a delayed authenticated re-grant cannot reopen an internal actor mutator");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT EXECUTE ON FUNCTION public.test_fn(uuid) TO U&"\\0061uthenticated";`);
ok(isDeny(r), "a Unicode-escaped authenticated function grant cannot bypass actor binding review");

r = runHook(`GRANT office_queue_executor TO authenticated;
${INTERNAL_ONLY_FN}`);
ok(isDeny(r), "a browser-role membership grant before an internal ACL keeps actor binding review enabled");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT office_queue_executor TO authenticated;`);
ok(isDeny(r), "a browser-role membership grant after an internal ACL keeps actor binding review enabled");

r = runHook(fn(MUTATION).replace(
  "public.test_fn",
  "public.bad_acl_overload"
).replace(
  /;$/,
  `;
REVOKE ALL ON FUNCTION public.bad_acl_overload(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bad_acl_overload(text) TO postgres;`
));
ok(isDeny(r), "a private ACL on a different overload cannot hide an unbound actor mutator");

r = runHook(fn(MUTATION).replace(
  /;$/,
  `;
REVOKE ALL ON FUNCTION public.test_fn(uuid) FROM PUBLIC, authenticated;`
));
ok(isDeny(r), "revoking only PUBLIC and authenticated cannot hide an anon-callable actor mutator");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;`);
ok(isDeny(r), "a schema-wide authenticated grant cannot hide an unbound actor mutator");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "public" TO authenticated;`);
ok(isDeny(r), "a quoted schema-wide authenticated grant cannot hide an unbound actor mutator");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA U&"\\0070ublic" TO authenticated;`);
ok(isDeny(r), "a Unicode-escaped schema-wide authenticated grant cannot hide an unbound actor mutator");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT ALL PRIVILEGES ON FUNCTION public.test_fn(uuid) TO authenticated;`);
ok(isDeny(r), "GRANT ALL PRIVILEGES cannot reopen an internal actor mutator to authenticated callers");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT ALL ON FUNCTION public.test_fn(uuid) TO authenticated;`);
ok(isDeny(r), "the GRANT ALL shorthand cannot reopen an internal actor mutator to authenticated callers");

r = runHook(`${INTERNAL_ONLY_FN}
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO authenticated;`);
ok(isDeny(r), "schema-wide GRANT ALL PRIVILEGES cannot hide an unbound actor mutator");

r = runHook(proc(`
  BEGIN
  IF p_created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_approved_by);
  END;
`, "p_created_by uuid, p_approved_by uuid"));
ok(isDeny(r), "one canonical ACTOR_MISMATCH guard cannot clear a second procedure actor parameter");

r = runHook(proc(`
  BEGIN
  IF p_created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF p_approved_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_approved_by);
  END;
`, "p_created_by uuid, p_approved_by uuid"));
ok(!isDeny(r), "independent canonical actor refusals keep a procedure allowed");

r = runHook(proc("CALL public.invoker_audit_helper(p_actor_id);", "p_actor_id uuid"));
ok(isDeny(r), "an unbound SECURITY DEFINER procedure CALL is a possible forged write");

r = runHook(proc("PERFORM public.invoker_audit_helper(p_actor_id);", "p_actor_id uuid"));
ok(isDeny(r), "an unbound SECURITY DEFINER procedure PERFORM is a possible forged write");

r = runHook(
  proc(MUTATION).replace("test_proc", "wrapped_actor_proc") +
  "\n" +
  fn("CALL public.wrapped_actor_proc(p_performed_by);", "p_performed_by uuid", "SECURITY INVOKER")
    .replace("test_fn", "wrapped_actor_fn")
);
ok(isDeny(r), "an invoker function wrapper cannot hide an unbound SECURITY DEFINER procedure");

r = runHook("ALTER PROCEDURE public.existing_actor_proc(uuid) SECURITY DEFINER;");
ok(isDeny(r), "ALTER PROCEDURE cannot elevate an existing unreadable routine past the guard");

r = runHook(`DO $do$
BEGIN
  EXECUTE 'ALTER FUNCTION public.existing_actor(uuid) SECURITY DEFINER';
END
$do$;`);
ok(isDeny(r), "direct dynamic ALTER FUNCTION cannot elevate an unreadable routine past the guard");

r = runHook(proc(BOUND));
ok(!isDeny(r), "a correctly bound SECURITY DEFINER procedure remains allowed");

r = runHook(
  proc(MUTATION, "p_performed_by uuid", "SECURITY DEFINER").replace("test_proc", "demoted_proc") +
  "\nALTER PROCEDURE public.demoted_proc(uuid) SECURITY INVOKER;"
);
ok(!isDeny(r), "ALTER PROCEDURE SECURITY INVOKER can demote a readable procedure safely");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY DEFINER")
    .replace("public.test_fn", "public.shared_name") +
  "\n" +
  fn("NULL;", "p_actor_id uuid", "SECURITY INVOKER")
    .replace("public.test_fn", "private.shared_name") +
  "\nALTER FUNCTION private.shared_name(uuid) SECURITY INVOKER;"
);
ok(isDeny(r), "an unrelated cross-schema invoker ALTER cannot demote an unbound SECURITY DEFINER mutator");

r = runHook(
  fn("NULL;", "p_actor_id uuid", "SECURITY INVOKER")
    .replace("public.test_fn", "public.shared_name") +
  "\nALTER FUNCTION private.shared_name(uuid) SECURITY DEFINER;"
);
ok(isDeny(r), "a readable cross-schema invoker cannot hide SECURITY DEFINER elevation of an existing routine");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY DEFINER")
    .replace("public.test_fn", "public.unqualified_mode") +
  "\nALTER FUNCTION unqualified_mode(uuid) SECURITY INVOKER;"
);
ok(isDeny(r), "an unqualified ALTER cannot ambiguously demote a schema-qualified SECURITY DEFINER mutator");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY INVOKER").replace("test_fn", "final_invoker") +
  "\nALTER FUNCTION public.final_invoker(uuid) SECURITY DEFINER;" +
  "\nALTER FUNCTION public.final_invoker(uuid) SECURITY INVOKER;"
);
ok(!isDeny(r), "a final ALTER FUNCTION SECURITY INVOKER remains outside the owner-rights guard");

r = runHook(
  fn(MUTATION, "p_performed_by uuid", "SECURITY DEFINER").replace("test_fn", "demoted_invoker") +
  "\nALTER FUNCTION public.demoted_invoker(uuid) SECURITY INVOKER;"
);
ok(!isDeny(r), "ALTER FUNCTION SECURITY INVOKER overrides an earlier CREATE SECURITY DEFINER mode");

r = runHook(fn(MUTATION, "p_performed_by uuid", ""));
ok(!isDeny(r), "function with no SECURITY clause (invoker default) is out of scope");

r = runHook(fn("SELECT * FROM invoices WHERE created_by = p_performed_by;"));
ok(isDeny(r), "an actor comparison is not provably non-mutating when its operator type is unknown");

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

// ── PROPAGATION direction: an actor laundered into a local before forwarding ─
// The stableAuthUidBindings() probes elsewhere in this file assert the opposite
// INVALIDATION direction (a loop/FETCH/diagnostics write destroys a trusted
// auth.uid() local). They passed the whole time these laundering channels were
// open, so they are not coverage for this direction. Each case below forwards
// the laundered local to a helper and nothing else, so the ONLY thing that can
// make the hook deny is that the taint reached the helper argument.
const LAUNDER_CASES = [
  ["a pre-list SELECT INTO target",
   "DECLARE v_id uuid;\nBEGIN\n  SELECT INTO v_id p_performed_by;\n  PERFORM public.record_actor(v_id);\nEND;"],
  ["a FOREACH loop variable",
   "DECLARE v_id uuid;\nBEGIN\n  FOREACH v_id IN ARRAY ARRAY[p_performed_by] LOOP\n    PERFORM public.record_actor(v_id);\n  END LOOP;\nEND;"],
  ["a FOR ... IN SELECT loop variable",
   "DECLARE v_row record;\nBEGIN\n  FOR v_row IN SELECT p_performed_by AS a LOOP\n    PERFORM public.record_actor(v_row);\n  END LOOP;\nEND;"],
  ["a cursor FETCH INTO target",
   "DECLARE c refcursor; v_id uuid;\nBEGIN\n  OPEN c FOR SELECT p_performed_by;\n  FETCH c INTO v_id;\n  PERFORM public.record_actor(v_id);\nEND;"],
  ["the correlated target of a multi-column INTO",
   "DECLARE v_dummy int; v_id uuid;\nBEGIN\n  SELECT 1, p_performed_by INTO v_dummy, v_id;\n  PERFORM public.record_actor(v_id);\nEND;"],
  ["a GET STACKED DIAGNOSTICS target",
   "DECLARE v_id text;\nBEGIN\n  BEGIN\n    RAISE EXCEPTION '%', p_performed_by;\n  EXCEPTION WHEN OTHERS THEN\n    GET STACKED DIAGNOSTICS v_id = MESSAGE_TEXT;\n  END;\n  PERFORM public.record_actor(v_id);\nEND;"],
  ["a SELECT INTO STRICT target",
   "DECLARE v_id uuid;\nBEGIN\n  SELECT p_performed_by INTO STRICT v_id;\n  PERFORM public.record_actor(v_id);\nEND;"],
  // The field is never named again -- only the composite that now contains it.
  ["a record FIELD written by SELECT INTO, then forwarded as the whole record",
   "DECLARE v_rec public.audit_row;\nBEGIN\n  SELECT p_performed_by INTO v_rec.actor;\n  PERFORM public.record_actor(v_rec);\nEND;"],
  // The assigned expression runs to the ';', not to the end of the line.
  ["an assignment whose expression continues onto later lines",
   "DECLARE v_id uuid;\nBEGIN\n  v_id := CASE\n    WHEN true THEN p_performed_by\n    ELSE NULL\n  END;\n  PERFORM public.record_actor(v_id);\nEND;"],
  // The loop's iterator never names the actor -- the cursor definition does.
  ["a bound cursor consumed by FOR ... IN <cursor> LOOP",
   "DECLARE c CURSOR FOR SELECT p_performed_by; v_row record;\nBEGIN\n  FOR v_row IN c LOOP\n    PERFORM public.record_actor(v_row);\n  END LOOP;\nEND;"],
  ["a cursor opened with OPEN ... FOR then consumed",
   "DECLARE c refcursor; v_id uuid;\nBEGIN\n  OPEN c FOR SELECT p_performed_by;\n  FETCH c INTO v_id;\n  PERFORM public.record_actor(c);\nEND;"],
  // DECLARE on the same line as the first declaration used to be captured as
  // the target, leaving the real local untainted.
  ["a same-line DECLARE ... DEFAULT initialiser",
   "DECLARE v_id uuid := p_performed_by;\nBEGIN\n  PERFORM public.record_actor(v_id);\nEND;"],
];
for (const [label, body] of LAUNDER_CASES) {
  r = runHook(fn(body));
  ok(isDeny(r), `an unbound actor forwarded through ${label} is BLOCKED`);
}

// A laundered local must not be able to launder a second time.
r = runHook(fn(
  "DECLARE v_a uuid; v_b uuid;\nBEGIN\n  SELECT INTO v_a p_performed_by;\n" +
  "  SELECT 0, v_a INTO v_b, v_b;\n  PERFORM public.record_actor(v_b);\nEND;"
));
ok(isDeny(r), "taint propagates transitively through a second laundering hop");

// Correlation must be positional: an uncorrelated sibling target is NOT tainted
// on its own, so this stays allowed and proves the fix is not a blanket deny.
r = runHook(fn(
  "DECLARE v_dummy int; v_id uuid;\nBEGIN\n  SELECT 1, p_performed_by INTO v_dummy, v_id;\n" +
  "  PERFORM public.record_count(v_dummy);\nEND;"
));
ok(!isDeny(r), "a multi-column INTO taints only the positionally matching target");

// U&"..." targets are deliberately opaque to this reader, so they can never
// enter the taint set. stableAuthUidBindings() already treats a U& write as
// destroying trust; the propagation direction has to fail closed the same way.
r = runHook(fn(
  'DECLARE U&"\\0076_id" uuid;\nBEGIN\n  SELECT p_performed_by INTO U&"\\0076_id";\n' +
  '  PERFORM public.record_actor(U&"\\0076_id");\nEND;'
));
ok(isDeny(r), "an actor written into a Unicode-escaped opaque target is BLOCKED");
r = runHook(fn(
  'DECLARE U&"\\0076_id" uuid;\nBEGIN\n' +
  '  FOREACH U&"\\0076_id" IN ARRAY ARRAY[p_performed_by] LOOP\n' +
  '    PERFORM public.record_actor(U&"\\0076_id");\n  END LOOP;\nEND;'
));
ok(isDeny(r), "a Unicode-escaped loop variable cannot hide an actor either");
r = runHook(fn(
  'DECLARE U&"\\0076_x" text;\nBEGIN\n  U&"\\0076_x" := \'unrelated\';\n' +
  '  RETURN to_jsonb(U&"\\0076_x");\nEND;'
));
ok(!isDeny(r), "an opaque target in a statement with no actor reference stays allowed");

// ── casts are callable boundaries when the target type is user-defined ──────
r = runHook(fn("BEGIN\n  RETURN CAST(p_performed_by AS public.actor_token);\nEND;"));
ok(isDeny(r), "CAST(actor AS <user type>) runs a user cast function and is BLOCKED");
r = runHook(fn("BEGIN\n  RETURN p_performed_by::public.actor_token;\nEND;"));
ok(isDeny(r), "actor::<user type> is the same user cast function and is BLOCKED");
r = runHook(fn("BEGIN\n  RETURN CAST(p_performed_by AS text);\nEND;"));
ok(!isDeny(r), "CAST(actor AS text) is a pg_catalog conversion, not a callable boundary");
r = runHook(fn("BEGIN\n  RETURN p_performed_by::pg_catalog.text;\nEND;"));
ok(!isDeny(r), "actor::pg_catalog.text is a pg_catalog conversion, not a callable boundary");
r = runHook(fn("BEGIN\n  RETURN to_jsonb(p_performed_by::uuid[]);\nEND;"));
ok(isDeny(r), "a built-in cast does not excuse the surrounding helper call");

// ── ROUND 2: PostgreSQL needs no whitespace before a quoted identifier ──────
// Every `\s+` sitting between a keyword and an IDENTIFIER position was a hole,
// not a separator. UPDATE"t", INTO"v", FOR"v", FUNCTION"f"( and ALTER
// FUNCTION"f"( are all legal SQL that the reader used to skip entirely.
const GUARD_LINE =
  "  IF p_performed_by IS DISTINCT FROM auth.uid() THEN\n" +
  "    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must equal auth.uid()';\n" +
  "  END IF;";

r = runHook(
  'CREATE OR REPLACE FUNCTION"public"."test_fn"(p_performed_by uuid) RETURNS jsonb ' +
  "LANGUAGE plpgsql SECURITY DEFINER AS $f$\nBEGIN\n" +
  "  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);\nEND;\n$f$;"
);
ok(isDeny(r), 'CREATE FUNCTION"name"( with no space after FUNCTION is still inspected');

r = runHook(
  'CREATE OR REPLACE PROCEDURE"public"."test_proc"(p_performed_by uuid) ' +
  "LANGUAGE plpgsql SECURITY DEFINER AS $p$\nBEGIN\n" +
  "  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);\nEND;\n$p$;"
);
ok(isDeny(r), 'CREATE PROCEDURE"name"( with no space after PROCEDURE is still inspected');

r = runHook('ALTER FUNCTION"public"."other_fn"(uuid) SECURITY DEFINER;');
ok(isDeny(r), 'ALTER FUNCTION"name"( elevating to SECURITY DEFINER is still inspected');

// UPDATE was the one static mutation keyword whose target can abut it, because
// INSERT/DELETE/MERGE all require a second keyword first. Combined with a
// wrapper that keeps the actor away from any operator -- (SELECT actor) or
// CASE ... THEN actor END -- it made the whole routine read as non-mutating.
r = runHook(fn(
  'BEGIN\n  UPDATE"financial_audit_log" SET actor_user_id = (SELECT p_performed_by) ' +
  "WHERE id = 1;\nEND;"
));
ok(isDeny(r), 'UPDATE"table" behind a (SELECT actor) wrapper is still a mutation');
r = runHook(fn(
  'BEGIN\n  UPDATE"financial_audit_log" SET actor_user_id = ' +
  "CASE WHEN true THEN p_performed_by END WHERE id = 1;\nEND;"
));
ok(isDeny(r), 'UPDATE"table" behind a CASE expression is still a mutation');
r = runHook(fn(
  "DECLARE v_x uuid;\nBEGIN\n  SELECT p_performed_by INTO v_x;\n" +
  '  UPDATE"financial_audit_log" SET actor_user_id = (SELECT v_x) WHERE id = 1;\nEND;'
));
ok(isDeny(r), 'a local laundered into UPDATE"table" is still a mutation');

// INTO"v" / INTO STRICT"v" / FOR"v" hid an overwrite of a trusted auth.uid()
// local, which let a legacy guard compare the actor against a caller value.
for (const [label, overwrite] of [
  ['SELECT ... INTO"v_actor"', '  SELECT p_target_id INTO"v_actor";'],
  ['SELECT ... INTO STRICT"v_actor"', '  SELECT p_target_id INTO STRICT"v_actor";'],
  ['SELECT ... INTO a second v_actor target',
    '  SELECT p_target_id, p_target_id INTO p_target_id, v_actor;'],
  ['FOR"v_actor" IN ... LOOP', '  FOR"v_actor" IN SELECT p_target_id LOOP NULL; END LOOP;'],
]) {
  r = runHook(fn(
    "DECLARE v_actor uuid;\nBEGIN\n  v_actor := auth.uid();\n" + overwrite + "\n" +
    "  IF p_performed_by IS DISTINCT FROM v_actor THEN\n" +
    "    RAISE EXCEPTION 'ACTOR_MISMATCH: x';\n  END IF;\n" +
    "  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);\nEND;",
    "p_performed_by uuid, p_target_id uuid"
  ));
  ok(isDeny(r), `${label} destroys the trusted auth.uid() binding and is BLOCKED`);
}

// ── ROUND 2: the refusal proves a NAME, and the name can be re-bound ────────
// A PL/pgSQL parameter is an ordinary mutable local. A passing guard followed
// by `p_performed_by := p_target_id;` stamps a value auth.uid() never approved
// while the guard still reads as bound.
for (const [label, rebind] of [
  [":= assignment", "  p_performed_by := p_target_id;"],
  ["= assignment", "  p_performed_by = p_target_id;"],
  ["SELECT ... INTO the parameter", "  SELECT p_target_id INTO p_performed_by;"],
  ["SELECT ... INTO a second target", "  SELECT p_target_id, p_target_id INTO p_target_id, p_performed_by;"],
  ["SELECT ... INTO the second positional actor target",
    "  SELECT p_target_id, p_target_id INTO p_target_id, $1;"],
  ["RETURNING ... INTO a second target",
    "  UPDATE financial_audit_log SET actor_user_id = p_target_id WHERE false " +
      "RETURNING actor_user_id, actor_user_id INTO p_target_id, p_performed_by;"],
  ["FETCH ... INTO a second target", "  FETCH p_cursor INTO p_target_id, p_performed_by;"],
  ["EXECUTE ... INTO a second target",
    "  EXECUTE 'SELECT $1, $1' INTO p_target_id, p_performed_by USING p_target_id;"],
  ["a FOR loop target", "  FOR p_performed_by IN SELECT p_target_id LOOP NULL; END LOOP;"],
  ["a quoted target", '  "p_performed_by" := p_target_id;'],
  ["a block-qualified target", "  test_fn.p_performed_by := p_target_id;"],
  ["a nested block", "  BEGIN p_performed_by := p_target_id; END;"],
]) {
  r = runHook(fn(
    "BEGIN\n" + GUARD_LINE + "\n" + rebind + "\n" +
    "  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);\nEND;",
    "p_performed_by uuid, p_target_id uuid, p_cursor refcursor"
  ));
  ok(isDeny(r), `a refusal followed by ${label} of the actor parameter is BLOCKED`);
}
// The rebinding rule must not deny the canonical shape it is protecting.
r = runHook(fn("BEGIN\n" + GUARD_LINE + "\n" +
  "  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);\nEND;"));
ok(!isDeny(r), "the canonical direct-parameter refusal is still ALLOWED");

// A non-first INTO target is not suspicious by itself. The actor may appear in
// the output list while the guarded actor parameter remains untouched.
r = runHook(fn(
  "BEGIN\n" + GUARD_LINE + "\n" +
  "  SELECT p_performed_by, p_target_id INTO p_target_id, p_spare_id;\n" +
  "  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);\nEND;",
  "p_performed_by uuid, p_target_id uuid, p_spare_id uuid"
));
ok(!isDeny(r), "an actor source with only non-actor INTO targets is still ALLOWED");

// ── ROUND 2: operator resolution and file scope ────────────────────────────
// `SET search_path TO 'evil', 'pg_catalog'` is the spelling every CRX migration
// uses, and masking blanks string CONTENTS -- so the check that a user schema
// precedes pg_catalog could never see the standard form.
r = runHook(
  "CREATE OR REPLACE FUNCTION public.test_fn(p_performed_by uuid) RETURNS jsonb " +
  "LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'evil', 'pg_catalog' AS $f$\n" +
  "BEGIN\n" + GUARD_LINE + "\n" +
  "  INSERT INTO financial_audit_log (actor_user_id) VALUES (p_performed_by);\nEND;\n$f$;"
);
ok(isDeny(r), "a single-quoted user schema before 'pg_catalog' defeats the refusal proof");

// Windows and macOS resolve paths case-insensitively, so these land in the very
// same supabase/migrations/ directory.
for (const scopePath of [
  "supabase/migrations/20260901000000_x.SQL",
  "Supabase/Migrations/20260901000000_x.sql",
  "SUPABASE/MIGRATIONS/20260901000000_x.SQL",
]) {
  r = runHook(fn(MUTATION), scopePath);
  ok(isDeny(r), `${scopePath} is the same migration directory and is still inspected`);
}
r = runHook(fn(MUTATION), "src/pages/Foo.tsx");
ok(!isDeny(r), "case-insensitive scope matching does not widen the guard past migrations");

// An edit shape this reader cannot reconstruct must not reconstruct to "".
// The settings matcher `Write|Edit` is an unanchored regex, so a batched edit
// payload reaches this hook with neither `content` nor `new_string`.
{
  const payload = {
    tool_input: {
      file_path: "supabase/migrations/20260901000000_x.sql",
      edits: [{ old_string: "SELECT 1;", new_string: fn(MUTATION) }],
    },
  };
  const res = spawnSync(process.execPath, [path.join(__dirname, "actor-binding-check.mjs")], {
    input: JSON.stringify(payload), encoding: "utf8",
  });
  ok(res.stdout.includes('"permissionDecision":"deny"'),
    "an unreconstructable edit payload for a migration fails CLOSED");
}

console.log(`actor-binding-check: ${pass} assertions passed`);
