#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 regression for the general and financial-audit
 * actor-forgery predicates. Catalog argument names are untrusted regex input:
 * a legal `$` in a named parameter must be matched literally, while `$1`
 * positional forwarding must remain covered. PostgreSQL comparison symbols
 * are also overloadable operators, so a custom mutating `=` must be caught.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREDICATE_DIR = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates');
const GENERAL = path.join(PREDICATE_DIR, 'actor-forgery.sql');
const FINANCIAL_AUDIT = path.join(PREDICATE_DIR, 'actor-forgery-fin-audit.sql');
const PREFIX = 'crx-actor-forgery-predicates-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql) {
  return docker(
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tAX'],
    { input: sql },
  ).stdout.trim();
}

function predicateRows(file) {
  const output = psql(readFileSync(file, 'utf8'));
  return output ? output.split(/\r?\n/) : [];
}

function assertCoversNamedAndPositional(rows, prefix) {
  const suspects = rows
    .filter((row) => row.startsWith(prefix))
    .map((row) => row.slice(row.lastIndexOf('|') + 1));
  assert.deepEqual(
    suspects,
    ['p_actor$source', 'p_actor$source'],
    `${prefix} must catch both named p_actor$source and positional $1 forwarding`,
  );
}

try {
  docker([
    'run', '--detach', '--name', CONTAINER, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
    '--env', 'POSTGRES_PASSWORD=disposable-only', 'postgres:17-alpine',
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  assert.ok(ready, 'disposable PostgreSQL container did not become ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);

  psql(`
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
CREATE TABLE public.financial_audit_log (actor_user_id uuid);
CREATE FUNCTION public.forward_actor(uuid) RETURNS uuid
LANGUAGE sql AS 'SELECT $1';

CREATE FUNCTION public.forward_actor_named(p_note text, p_actor_source uuid) RETURNS uuid
LANGUAGE sql AS 'SELECT $2';

CREATE FUNCTION public.actor_forward_named(p_actor$source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  PERFORM public.forward_actor(p_actor$source);
END;
$body$;

CREATE FUNCTION public.actor_forward_positional(p_actor$source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  PERFORM public.forward_actor($1);
END;
$body$;

CREATE FUNCTION public.actor_audit_named(p_actor$source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor$source);
END;
$body$;

CREATE FUNCTION public.actor_audit_positional(p_actor$source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES ($1);
END;
$body$;

CREATE TYPE public.actor_token AS (value uuid);
CREATE FUNCTION public.actor_equality_impl(p_actor public.actor_token, p_identity public.actor_token)
RETURNS boolean LANGUAGE plpgsql AS $body$
BEGIN
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES ((p_actor).value);
  RETURN true;
END;
$body$;
CREATE OPERATOR public.= (
  LEFTARG = public.actor_token,
  RIGHTARG = public.actor_token,
  FUNCTION = public.actor_equality_impl
);
CREATE FUNCTION public.actor_uuid_equality_impl(p_actor public.actor_token, p_identity uuid)
RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE OPERATOR public.= (
  LEFTARG = public.actor_token,
  RIGHTARG = uuid,
  FUNCTION = public.actor_uuid_equality_impl
);
CREATE FUNCTION public.uuid_actor_equality_impl(p_identity uuid, p_actor public.actor_token)
RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE OPERATOR public.= (
  LEFTARG = uuid,
  RIGHTARG = public.actor_token,
  FUNCTION = public.uuid_actor_equality_impl
);
CREATE FUNCTION public.actor_token_from_uuid(p_identity uuid) RETURNS public.actor_token
LANGUAGE sql IMMUTABLE AS 'SELECT ROW(p_identity)::public.actor_token';
CREATE CAST (uuid AS public.actor_token)
WITH FUNCTION public.actor_token_from_uuid(uuid) AS IMPLICIT;
CREATE FUNCTION public.actor_overloaded_equality(p_actor_source public.actor_token) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RETURN p_actor_source = ROW(gen_random_uuid())::public.actor_token;
END;
$body$;

CREATE FUNCTION public.actor_parenthesized_equality(p_actor_source public.actor_token) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RETURN ((p_actor_source))::public.actor_token = ROW(gen_random_uuid())::public.actor_token;
END;
$body$;

CREATE FUNCTION public.actor_reverse_equality(p_actor_source public.actor_token) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RETURN ROW(gen_random_uuid())::public.actor_token = CAST(p_actor_source AS public.actor_token);
END;
$body$;

CREATE FUNCTION public.actor_custom_refusal_forward(p_actor_source public.actor_token) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor((p_actor_source).value);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES ((p_actor_source).value);
END;
$body$;

CREATE FUNCTION public.actor_pre_refusal_forward(p_actor_source uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  SELECT public.forward_actor(p_actor_source) INTO v_actor;
  IF p_actor_source IS DISTINCT FROM gen_random_uuid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  RETURN v_actor;
END;
$body$;

CREATE FUNCTION public.actor_comment_token_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  -- IF p_actor_source IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_nested_comment_guard_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  /* outer comment
     /* nested comment */
     IF p_actor_source IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH';
  */
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_notice_token_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RAISE NOTICE 'ACTOR_MISMATCH';
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_string_guard_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RAISE NOTICE 'IF p_actor_source IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION ''ACTOR_MISMATCH'';';
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_dollar_guard_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RAISE NOTICE $notice$IF p_actor_source IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH';$notice$;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_escape_guard_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RAISE NOTICE E'IF p_actor_source IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION ''ACTOR_MISMATCH'';';
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_unicode_guard_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  PERFORM U&'IF p_actor_source IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION ''ACTOR_MISMATCH'';';
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_caught_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  BEGIN
    IF p_actor_source IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'ACTOR_MISMATCH';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_safe_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_safe_local_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  v_actor := auth.uid();
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Rebinding AFTER a passing refusal: a PL/pgSQL parameter is an ordinary local,
-- so the refusal proves nothing about the value that reaches the sinks below it.
-- Truncating the scanned body at the refusal is exactly what used to hide this.
CREATE FUNCTION public.actor_rebound_param_forward(p_actor_source uuid, p_target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  p_actor_source := p_target_id;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- The false positive the rebinding rule must NOT produce. PL/pgSQL named-argument
-- syntax is lexically identical to assignment, so an unpinned arg-then-walrus
-- match flags this correctly-bound routine. Modelled on live
-- batch_cancel_deliveries, which passes its actor by named argument.
CREATE FUNCTION public.actor_named_argument_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  v_actor := auth.uid();
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor_named(p_note := 'batch', p_actor_source := v_actor);
END;
$body$;

CREATE FUNCTION public.actor_local_pre_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  v_actor := auth.uid();
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
END;
$body$;

CREATE FUNCTION public.actor_quoted_set_config_forgery(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_previous_subject text;
BEGIN
  v_previous_subject := pg_catalog."set_config"(
    'request.jwt.claim.sub',
    p_actor_source::text,
    true
  );
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- The refusal is textually canonical but logically dead: the condition is
-- weakened inside itself, so the RAISE can never run. Slop between the
-- comparison and THEN used to accept this and truncate everything after it.
-- The block counter accepts it too, because there is only one IF.
CREATE FUNCTION public.actor_weakened_condition_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() AND false THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- The same weakening on the bound-local form, which has its own refusal regex.
CREATE FUNCTION public.actor_weakened_local_condition_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  v_actor := auth.uid();
  IF p_actor_source IS DISTINCT FROM v_actor AND false THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- The audit sink is written by DYNAMIC SQL, so the lexer masks it out of
-- executable_src. Scope must be decided on raw source or this routine silently
-- leaves the financial-audit predicate while its actor parameter stays visible.
CREATE FUNCTION public.actor_dynamic_audit_sink_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  PERFORM public.forward_actor(p_actor_source);
  EXECUTE 'INSERT INTO public.financial_audit_log(actor_user_id) VALUES ($1)' USING p_actor_source;
END;
$body$;

-- PL/pgSQL accepts a plain equals sign as the assignment operator too, and the
-- write-time hook already treats that spelling as a rebinding. A sweep matching
-- only the walrus form would leave the cheaper spelling open.
CREATE FUNCTION public.actor_equals_rebound_param_forward(p_actor_source uuid, p_target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  p_actor_source = p_target_id;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Stash-then-rebind: the caller value is copied to a local, the parameter is
-- overwritten with auth.uid() so the canonical refusal can never fire, and the
-- STASHED value is what reaches the sinks. The refusal is textually perfect.
CREATE FUNCTION public.actor_stash_then_rebind_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_saved uuid;
BEGIN
  SELECT p_actor_source INTO v_saved;
  p_actor_source := auth.uid();
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(v_saved);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (v_saved);
END;
$body$;

-- A local refusal is only worth crediting when the local was bound from
-- auth.uid(). Here v_actor is seeded from the forgeable parameter itself, so the
-- comparison can never fire and the body below it must NOT be stripped.
CREATE FUNCTION public.actor_unbound_local_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  SELECT p_actor_source INTO v_actor;
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_custom_local_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor public.actor_token;
BEGIN
  v_actor := auth.uid();
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.actor_out_before_positional(OUT p_result uuid, IN p_actor_source uuid)
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  PERFORM public.forward_actor($2);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES ($2);
  p_result := $2;
END;
$body$;

-- A trailing backslash is DATA in an ordinary SQL string. Applying the E'...'
-- escape branch to it swallowed the closing quote, so the lexer ran on to the
-- next quote and masked the executable statements in between -- the routine
-- read as clean.
--
-- The run-on consumes an ODD number of quotes (its own, the one it ate, and
-- the one it stopped at), so it can only end balanced -- fail OPEN instead of
-- tripping lex_error -- when the routine contains an odd total. The lone quote
-- inside the line comment supplies it, and is also where the run-on stops.
CREATE FUNCTION public.actor_backslash_guard_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RAISE NOTICE 'ends with backslash \\';
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
  -- an apostrophe in prose: '
  RAISE NOTICE 'done';
END;
$body$;

-- Same run-on, reached the other way: the E of LIKE is not an escape-string
-- prefix, so the string after it must be lexed with ordinary rules.
CREATE FUNCTION public.actor_word_adjacent_escape_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_flag boolean;
BEGIN
  v_flag := 'sample' LIKE'ends with backslash \\';
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
  -- an apostrophe in prose: '
  RAISE NOTICE 'done';
END;
$body$;

-- The refusal is real, canonical, and never executes. Nothing required it to be
-- reachable, so matching it truncated the whole scanned body.
CREATE FUNCTION public.actor_unreachable_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF false THEN
    IF p_actor_source IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'ACTOR_MISMATCH';
    END IF;
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Control for the reachability rule: a CLOSED block before a top-level refusal
-- must still let the refusal end the scan, or the rule degenerates into
-- flagging every routine.
CREATE FUNCTION public.actor_closed_block_then_refusal(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS NULL THEN
    RAISE NOTICE 'null actor';
  END IF;
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- ---------------------------------------------------------------------------
-- The four LEGITIMATE guard styles live code actually uses (2026-09-02 triage).
-- Every one of these binds the caller identity and refuses on mismatch; the
-- predicate credited none of them while it demanded one exact spelling, which
-- is what took the live sweep from 1 row to 56. They must NOT be reported.
-- ---------------------------------------------------------------------------

-- Style 1: the actor local is bound in the DECLARE initializer rather than by a
-- separate assignment statement. 17 live routines.
CREATE FUNCTION public.actor_declare_init_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Style 2: null-tolerant refusal with the <> spelling. The parameter is
-- attribution-only when omitted and must match the caller when supplied.
-- 10 live routines.
CREATE FUNCTION public.actor_null_tolerant_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_actor_source IS NOT NULL AND p_actor_source <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Style 3: prose refusal message, no canonical token anywhere. 6 live routines.
CREATE FUNCTION public.actor_prose_message_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Style 4: canonical token with a descriptive suffix, and a semicolon INSIDE the
-- message. The semicolon is the point: the refusal-statement match may only be
-- safe because the lexer masks the literal first. 5 live routines use this form.
CREATE FUNCTION public.actor_prefixed_message_refusal_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: caller is not the actor; refusing';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- ---------------------------------------------------------------------------
-- CANARIES for the loosening itself. Accepting four message spellings and two
-- binding forms must not degrade into "anything shaped like an IF counts".
-- Each of these is a near-miss of a style above and must STILL be reported.
-- ---------------------------------------------------------------------------

-- Compares against the caller correctly but only RAISEs a NOTICE, so execution
-- continues and the actor still reaches the sink. Message-agnostic matching must
-- not drop the requirement that the statement be RAISE EXCEPTION.
CREATE FUNCTION public.actor_notice_not_exception_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE NOTICE 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- DECLARE initializer that binds the local to the PARAMETER instead of
-- auth.uid(), so the comparison is always false and the refusal can never fire.
-- Accepting the initializer form must not mean accepting any initializer.
CREATE FUNCTION public.actor_selfbound_declare_init_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid := p_actor_source;
BEGIN
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Null-tolerant shape compared against a fresh random uuid rather than the
-- caller identity: refuses every caller-supplied actor and attributes nothing,
-- but proves nothing about the caller. The null-tolerant prefix must not be a
-- way to smuggle in an arbitrary right-hand side.
CREATE FUNCTION public.actor_null_tolerant_wrong_identity_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS NOT NULL AND p_actor_source <> gen_random_uuid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- ---------------------------------------------------------------------------
-- Fixtures from the exact-SHA Codex review of c1beab619.
-- ---------------------------------------------------------------------------

-- HIGH #1. An ISOLATED dynamic audit write: the whole INSERT lives inside a
-- string literal, so the lexer masks financial_audit_log out of the analysed
-- source, and the actor arrives via USING rather than inside a call.
--
-- This deliberately carries NO other statement. actor_dynamic_audit_sink_forward
-- above also has a PERFORM public.forward_actor(p_actor_source) immediately
-- before its EXECUTE, and that unrelated call satisfies the callable-forwarding
-- arm -- so that fixture would keep passing even with the dynamic-sink arm
-- removed, which is exactly how this gap survived review. Nothing here can
-- satisfy any arm except raw-source correlation.
CREATE FUNCTION public.actor_dynamic_audit_sink_only(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  EXECUTE 'INSERT INTO public.financial_audit_log(actor_user_id) VALUES ($1)' USING p_actor_source;
END;
$body$;

-- HIGH #2. A TEXT actor cast to uuid on its way into the immutable ledger. The
-- first draft of the type gate dropped every non-uuid built-in from candidacy,
-- which removed this shape from the sweep entirely.
CREATE FUNCTION public.actor_text_cast_audit_forward(p_performed_by text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_performed_by::uuid);
END;
$body$;

-- P1. A BARE inequality refusal. Textually it looks like a correct guard, but
-- p_actor_source <> auth.uid() evaluates to NULL when the actor argument is
-- NULL, so the IF never fires and the refusal never raises. Accepting the
-- inequality spelling without a null guard credits a guard that cannot refuse --
-- same defect class as actor_selfbound_declare_init_forward. Must be REPORTED.
CREATE FUNCTION public.actor_bare_inequality_forward(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source <> auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- P1. The local is bound to auth.uid() and then OVERWRITTEN with a
-- caller-controlled value before the refusal reads it, so the comparison proves
-- nothing. Ordering alone would credit this. Must be REPORTED.
CREATE FUNCTION public.actor_poisoned_local_before_refusal(p_actor_source uuid, p_target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_actor uuid;
BEGIN
  v_actor := auth.uid();
  v_actor := p_target_id;
  IF p_actor_source IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

CREATE FUNCTION public.financial_audit_log_probe() RETURNS void
LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM 1;
END;
$body$;

-- ---------------------------------------------------------------------------
-- Round 2 of the exact-SHA Codex review, on 39a3d817f. All three are shapes the
-- BASE predicate reports and the rewrite had stopped reporting.
-- ---------------------------------------------------------------------------

-- HIGH. A TEXT actor used in a role lookup, never cast to uuid and never compared
-- to auth.uid(). The type gate accepted only uuid, user-defined types, or a
-- parameter the body visibly casts — so this left candidacy entirely. The gate is
-- now gone; base reports this and so must we.
CREATE FUNCTION public.actor_text_role_lookup(p_user_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id::text = p_user_id;
  RETURN v_role = 'admin';
END;
$body$;

-- HIGH. A benign VISIBLE mention of the ledger beside a MASKED dynamic write.
-- The previous gate required financial_audit_log to be absent from the entire
-- lexed body, so this one harmless probe call switched detection off completely.
CREATE FUNCTION public.actor_visible_probe_plus_dynamic_write(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  PERFORM public.financial_audit_log_probe();
  EXECUTE 'INSERT INTO public.financial_audit_log(actor_user_id) VALUES ($1)' USING p_actor_source;
END;
$body$;

-- Round 3 P1. SELECT ... INTO is an assignment path the rebinding rule did not
-- read: the canonical refusal passes, then the actor parameter is overwritten
-- from a caller-controlled row before it reaches the sink. Recorded as an open
-- residual in the 2026-09-01 cap entry. Must be REPORTED.
CREATE FUNCTION public.actor_into_rebound_param_forward(p_actor_source uuid, p_target_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_actor_source IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT p_target_id INTO p_actor_source;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- Round 3 P1. A legal quoted identifier containing a control-flow keyword. The
-- refusal sits inside IF false THEN and can never run, but "END IF" as an
-- identifier balances the block counts, so the unreachable refusal was credited
-- and everything after it vanished from analysis. Must be REPORTED.
CREATE FUNCTION public.actor_quoted_identifier_block_spoof(p_actor_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE "END IF" integer := 1;
BEGIN
  IF false THEN
    IF p_actor_source IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'ACTOR_MISMATCH';
    END IF;
  END IF;
  PERFORM public.forward_actor(p_actor_source);
  INSERT INTO public.financial_audit_log(actor_user_id) VALUES (p_actor_source);
END;
$body$;

-- HIGH. Authorization derived from a forgeable actor through DYNAMIC SQL. The
-- lexer masks the string, so neither the role arm nor any other lexed arm sees
-- it; the general predicate had no raw-source fallback at all.
CREATE FUNCTION public.actor_dynamic_role_authorization(p_actor_source uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE v_role text;
BEGIN
  EXECUTE 'SELECT role FROM public.profiles WHERE id = $1' INTO v_role USING p_actor_source;
  RETURN v_role = 'admin';
END;
$body$;
`);

  const forgedActor = '00000000-0000-0000-0000-000000000001';
  psql(`TRUNCATE public.financial_audit_log;
SELECT public.actor_quoted_set_config_forgery('${forgedActor}');`);
  assert.equal(
    psql('SELECT actor_user_id::text FROM public.financial_audit_log;'),
    forgedActor,
    'quoted set_config exploit must be executable in disposable PostgreSQL before predicate detection',
  );

  assertCoversNamedAndPositional(predicateRows(GENERAL), 'actor_forward_');
  assertCoversNamedAndPositional(predicateRows(FINANCIAL_AUDIT), 'actor_audit_');
  const generalRows = predicateRows(GENERAL);
  const financialRows = predicateRows(FINANCIAL_AUDIT);
  assert.ok(
    generalRows.some((row) => row.startsWith('actor_quoted_set_config_forgery(') && row.endsWith('|p_actor_source')),
    `general predicate must catch quoted callable identity replacement before refusal: ${generalRows.join(', ')}`,
  );
  assert.ok(
    financialRows.some((row) => row.startsWith('actor_quoted_set_config_forgery(') && row.endsWith('|p_actor_source')),
    `financial predicate must catch quoted callable identity replacement before audit attribution: ${financialRows.join(', ')}`,
  );
  assert.ok(
    generalRows.some((row) =>
      row.startsWith('actor_overloaded_equality(') && row.endsWith('|p_actor_source')
    ),
    `general predicate must catch an overloaded comparison operator receiving an actor: ${generalRows.join(', ')}`,
  );
  for (const routine of ['actor_parenthesized_equality', 'actor_reverse_equality', 'actor_pre_refusal_forward']) {
    assert.ok(
      generalRows.some((row) => row.startsWith(`${routine}(`) && row.endsWith('|p_actor_source')),
      `general predicate must catch ${routine}: ${generalRows.join(', ')}`,
    );
  }
  for (const routine of [
    'actor_comment_token_forward',
    'actor_nested_comment_guard_forward',
    'actor_notice_token_forward',
    'actor_string_guard_forward',
    'actor_caught_refusal_forward',
    'actor_escape_guard_forward',
    'actor_unicode_guard_forward',
    'actor_out_before_positional',
    'actor_local_pre_refusal_forward',
    'actor_rebound_param_forward',
    'actor_weakened_condition_forward',
    'actor_weakened_local_condition_forward',
    'actor_dynamic_audit_sink_forward',
    'actor_equals_rebound_param_forward',
    'actor_stash_then_rebind_forward',
    'actor_unbound_local_refusal_forward',
    'actor_custom_local_refusal_forward',
    'actor_custom_refusal_forward',
    'actor_dollar_guard_forward',
    'actor_backslash_guard_forward',
    'actor_word_adjacent_escape_forward',
    'actor_unreachable_refusal_forward',
    // Canaries for the 2026-09-02 shape-matching loosening. Each is a near-miss
    // of a style the predicate now accepts; if one of these stops being reported,
    // the credit rule has gone from "recognises the real guard shapes" to
    // "accepts anything shaped like an IF".
    'actor_notice_not_exception_forward',
    'actor_selfbound_declare_init_forward',
    'actor_null_tolerant_wrong_identity_forward',
    // Codex P1s on c1beab619: a guard that cannot fire, and a guard reading a
    // local that was poisoned after it was bound.
    'actor_bare_inequality_forward',
    'actor_poisoned_local_before_refusal',
    // Codex round 3: INTO as an assignment path, and a quoted identifier
    // balancing the control-flow counts around an unreachable refusal.
    'actor_into_rebound_param_forward',
    'actor_quoted_identifier_block_spoof',
  ]) {
    assert.ok(
      generalRows.some((row) => row.startsWith(`${routine}(`) && row.endsWith('|p_actor_source')),
      `general predicate must ignore non-refusing ACTOR_MISMATCH text in ${routine}: ${generalRows.join(', ')}`,
    );
    assert.ok(
      financialRows.some((row) => row.startsWith(`${routine}(`) && row.endsWith('|p_actor_source')),
      `financial predicate must ignore non-refusing ACTOR_MISMATCH text in ${routine}: ${financialRows.join(', ')}`,
    );
  }
  for (const routine of [
    'actor_safe_refusal_forward',
    'actor_safe_local_refusal_forward',
    'actor_closed_block_then_refusal',
    'actor_named_argument_forward',
    // The four legitimate live guard styles (2026-09-02 triage). Pinned here so
    // a future tightening cannot quietly retake the live sweep from 1 row to 56.
    'actor_declare_init_refusal_forward',
    'actor_null_tolerant_refusal_forward',
    'actor_prose_message_refusal_forward',
    'actor_prefixed_message_refusal_forward',
  ]) {
    assert.ok(
      !generalRows.some((row) => row.startsWith(`${routine}(`)),
      `general predicate must stop at the executable uncaught refusal in ${routine}: ${generalRows.join(', ')}`,
    );
    assert.ok(
      !financialRows.some((row) => row.startsWith(`${routine}(`)),
      `financial predicate must stop at the executable uncaught refusal in ${routine}: ${financialRows.join(', ')}`,
    );
  }
  // ── Codex c1beab619 HIGH #1 and #2, asserted against the FINANCIAL predicate ──
  // These two are audit-ledger shapes. The general predicate has no
  // financial_audit_log arm and is not expected to report them, so asserting the
  // must-report loop's both-predicates rule would be asserting the wrong thing.
  for (const routine of [
    'actor_dynamic_audit_sink_only',
    'actor_text_cast_audit_forward',
    // Codex round 2: one benign VISIBLE ledger reference must not switch dynamic
    // detection off for the masked write beside it.
    'actor_visible_probe_plus_dynamic_write',
  ]) {
    assert.ok(
      financialRows.some((row) => row.startsWith(`${routine}(`)),
      `financial predicate must catch ${routine} — forged authorship reaching the immutable ` +
        `ledger is this predicate's whole remit: ${financialRows.join(', ')}`,
    );
  }

  // Codex round 2, general predicate: base coverage that the lexer removed.
  // A text actor in a role lookup (no cast anywhere) and authorization derived
  // from a forgeable actor through dynamic SQL.
  for (const routine of ['actor_text_role_lookup', 'actor_dynamic_role_authorization']) {
    assert.ok(
      generalRows.some((row) => row.startsWith(`${routine}(`)),
      `general predicate must catch ${routine} — the base predicate reports it and the ` +
        `rewrite must not lose that: ${generalRows.join(', ')}`,
    );
  }

  console.log('ACTOR_FORGERY_PREDICATES_TEST_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['stop', '--time', '1', CONTAINER], { allowFailure: true });
    docker(['rm', CONTAINER], { allowFailure: true });
  }
}
