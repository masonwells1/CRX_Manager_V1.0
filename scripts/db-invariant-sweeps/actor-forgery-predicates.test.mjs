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
CREATE TABLE public.financial_audit_log (actor_user_id uuid);
CREATE FUNCTION public.forward_actor(uuid) RETURNS uuid
LANGUAGE sql AS 'SELECT $1';

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
  RETURN (p_actor).value IS NOT DISTINCT FROM (p_identity).value;
END;
$body$;
CREATE OPERATOR public.= (
  LEFTARG = public.actor_token,
  RIGHTARG = public.actor_token,
  FUNCTION = public.actor_equality_impl
);
CREATE FUNCTION public.actor_overloaded_equality(p_actor_source public.actor_token) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  RETURN p_actor_source = ROW(gen_random_uuid())::public.actor_token;
END;
$body$;
`);

  assertCoversNamedAndPositional(predicateRows(GENERAL), 'actor_forward_');
  assertCoversNamedAndPositional(predicateRows(FINANCIAL_AUDIT), 'actor_audit_');
  const generalRows = predicateRows(GENERAL);
  assert.ok(
    generalRows.some((row) =>
      row.startsWith('actor_overloaded_equality(') && row.endsWith('|p_actor_source')
    ),
    `general predicate must catch an overloaded comparison operator receiving an actor: ${generalRows.join(', ')}`,
  );
  console.log('ACTOR_FORGERY_PREDICATES_TEST_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['stop', '--time', '1', CONTAINER], { allowFailure: true });
    docker(['rm', CONTAINER], { allowFailure: true });
  }
}
