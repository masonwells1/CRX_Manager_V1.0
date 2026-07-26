#!/usr/bin/env node
/**
 * Disposable catalog regression for predicate (j). It loads the checked-in
 * predicate into isolated PostgreSQL 17 and proves that an unsafe `save_field`
 * is caught, while both the established canonical guard and a semantic guard
 * with a noncanonical error token are safe. Replacing `save_field` with the
 * safe body must leave zero rows. No Supabase URL is read or contacted.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'actor-forgery-activity-feed.sql');
const PREFIX = 'crx-actor-feed-predicate-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql, allowFailure = false) {
  return docker(
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tAX'],
    { input: sql, allowFailure },
  );
}

function rows() {
  const result = psql(readFileSync(PREDICATE, 'utf8'));
  return result.stdout.trim()
    ? result.stdout.trim().split(/\r?\n/).map((line) => line.split('|')[0])
    : [];
}

try {
  assert.ok(existsSync(PREDICATE), `missing predicate: ${PREDICATE}`);
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
  assert.equal(ready, true, 'PostgreSQL did not become ready');
  // The official image's init server briefly reports ready before its final
  // handoff to the long-running server; match the other disposable proof.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  psql(`
CREATE SCHEMA auth;
CREATE ROLE authenticated;
CREATE TABLE public.activity_feed (performed_by uuid);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION public.save_field(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.activity_feed (performed_by) VALUES (p_performed_by);
END;
$$;
CREATE FUNCTION public.safe_noncanonical_actor_write(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_authenticated_actor uuid := auth.uid();
BEGIN
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_authenticated_actor THEN
    RAISE EXCEPTION 'caller identity does not agree with supplied audit actor';
  END IF;
  INSERT INTO public.activity_feed (performed_by) VALUES (v_authenticated_actor);
END;
$$;
CREATE FUNCTION public.safe_direct_actor_write(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'caller identity does not agree with supplied audit actor';
  END IF;
  INSERT INTO public.activity_feed (performed_by) VALUES (auth.uid());
END;
$$;
CREATE FUNCTION public.safe_assigned_actor_write(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_actor uuid;
BEGIN
  v_actor := auth.uid();
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'caller identity does not agree with supplied audit actor';
  END IF;
  INSERT INTO public.activity_feed (performed_by) VALUES (v_actor);
END;
$$;
CREATE FUNCTION public.safe_not_equal_actor_write(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'caller identity does not agree with supplied audit actor';
  END IF;
  INSERT INTO public.activity_feed (performed_by) VALUES (v_actor);
END;
$$;
CREATE FUNCTION public.safe_canonical_actor_write(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_performed_by IS NOT NULL AND NOT (p_performed_by = auth.uid()) THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: supplied actor differs from caller';
  END IF;
  INSERT INTO public.activity_feed (performed_by) VALUES (p_performed_by);
END;
$$;
GRANT EXECUTE ON FUNCTION public.save_field(uuid), public.safe_noncanonical_actor_write(uuid), public.safe_direct_actor_write(uuid), public.safe_assigned_actor_write(uuid), public.safe_not_equal_actor_write(uuid), public.safe_canonical_actor_write(uuid) TO authenticated;
`);
  assert.deepEqual(rows(), ['save_field(p_performed_by uuid)'], 'unsafe pre-apply save_field must be the only predicate row');
  psql(`
CREATE OR REPLACE FUNCTION public.save_field(p_performed_by uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_authenticated_actor uuid := auth.uid();
BEGIN
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_authenticated_actor THEN
    RAISE EXCEPTION 'supplied actor differs from caller';
  END IF;
  INSERT INTO public.activity_feed (performed_by) VALUES (v_authenticated_actor);
END;
$$;
`);
  assert.deepEqual(rows(), [], 'safe post-apply catalog must return zero predicate rows');
  console.log('ACTOR_FORGERY_ACTIVITY_FEED_PREDICATE_TEST_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) docker(['rm', '--force', CONTAINER], { allowFailure: true });
}
