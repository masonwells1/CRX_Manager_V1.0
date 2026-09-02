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
    'actor_equals_rebound_param_forward',
    'actor_stash_then_rebind_forward',
    'actor_unbound_local_refusal_forward',
    'actor_custom_local_refusal_forward',
    'actor_custom_refusal_forward',
    'actor_dollar_guard_forward',
    'actor_backslash_guard_forward',
    'actor_word_adjacent_escape_forward',
    'actor_unreachable_refusal_forward',
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
  console.log('ACTOR_FORGERY_PREDICATES_TEST_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['stop', '--time', '1', CONTAINER], { allowFailure: true });
    docker(['rm', CONTAINER], { allowFailure: true });
  }
}
