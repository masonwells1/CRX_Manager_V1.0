#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for the save_field actor-binding predicate.
 * It proves unsafe and cosmetically altered bodies fail closed, then applies
 * the exact checked-in migration and requires zero violations.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'save-field-actor-binding.sql');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260729222311_bind_save_field_actor.sql');
const PREFIX = 'crx-save-field-actor-predicate-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const VIOLATION = 'save_field(uuid, jsonb, jsonb, uuid, text)';
const EXPECTED_HASH = '10a53c6b4c218a3836b0a5269fc558cc214eb8741a2df6669133885919f50ff2';

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
  );
}

function predicateRows() {
  const text = psql(readFileSync(PREDICATE, 'utf8')).stdout.trim();
  return text ? text.split(/\r?\n/) : [];
}

function createUnsafeSaveField(body) {
  psql(`
CREATE OR REPLACE FUNCTION public.save_field(
  p_field_id uuid,
  p_field_payload jsonb,
  p_billing_defaults jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_field_id uuid := gen_random_uuid();
  v_actor uuid;
BEGIN
${body}
  RETURN v_field_id;
END;
$function$;
`);
}

try {
  assert.ok(existsSync(PREDICATE), `missing predicate: ${PREDICATE}`);
  assert.ok(existsSync(MIGRATION), `missing migration: ${MIGRATION}`);

  docker([
    'run', '--detach', '--name', CONTAINER, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
    '--env', 'POSTGRES_PASSWORD=disposable-only', 'postgres:17-alpine',
  ]);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);

  psql(`
CREATE EXTENSION pgcrypto;
CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, role text, is_active boolean, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_name text
);
CREATE TABLE public.fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, field_name text,
  legal_description text, county text, state text, total_acres numeric,
  fsa_farm_number text, fsa_tract_number text, fsa_field_number text,
  crop_type text, soil_type text, irrigation boolean, notes text, is_active boolean
);
CREATE TABLE public.field_billing_defaults (
  field_id uuid, customer_id uuid, split_pct numeric, is_primary boolean,
  notes text, price_override_cents bigint, pricing_note text
);
CREATE TABLE public.activity_feed (
  event_type text, description text, performed_by uuid,
  related_entity_type text, related_entity_id uuid
);
CREATE TABLE public.idempotency_keys (
  idempotency_key text, operation text, result jsonb
);
CREATE FUNCTION public.require_admin_or_sales_rep() RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
CREATE FUNCTION public.check_idempotency(text, text) RETURNS jsonb
LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
CREATE FUNCTION public.save_idempotency(text, text, jsonb) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;
INSERT INTO public.profiles VALUES (
  '00000000-0000-0000-0000-000000000001', 'admin', true, now()
);
`);

  createUnsafeSaveField(`
  /* v_actor := auth.uid();
     IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
       RAISE EXCEPTION 'ACTOR_MISMATCH';
     END IF; */
  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES ('field_saved', 'comment fake guard', p_performed_by, 'field', v_field_id);`);
  assert.deepEqual(predicateRows(), [VIOLATION], 'comment-only guard must fail closed');

  createUnsafeSaveField(`
  v_actor := auth.uid();
  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES ('field_saved', 'late guard', p_performed_by, 'field', v_field_id);
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;`);
  assert.deepEqual(predicateRows(), [VIOLATION], 'guard after caller-trusted write must fail closed');

  psql(readFileSync(MIGRATION, 'utf8'));
  assert.equal(
    psql("SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure").stdout.trim(),
    EXPECTED_HASH,
    'exact migration must emit the reviewed body fingerprint',
  );
  assert.deepEqual(predicateRows(), [], 'exact migration must satisfy the predicate');

  const secureDefinition = psql(
    "SELECT pg_get_functiondef('public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure)",
  ).stdout;
  const alteredDefinition = secureDefinition.replace('RETURN v_field_id;', 'RETURN v_field_id ;');
  assert.notEqual(alteredDefinition, secureDefinition, 'alteration fixture must change the body');
  psql(alteredDefinition);
  assert.deepEqual(predicateRows(), [VIOLATION], 'any reviewed-body drift must fail closed');

  console.log('SAVE_FIELD_ACTOR_BINDING_PREDICATE_TEST_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
