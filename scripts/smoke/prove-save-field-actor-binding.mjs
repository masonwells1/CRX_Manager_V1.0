#!/usr/bin/env node
/**
 * Disposable save_field proof. It never reads a DB URL or connects to
 * Supabase: a unique PostgreSQL 17 container runs with no network and tmpfs
 * storage. The exact migration and rollback smoke are loaded verbatim.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-save-field-actor-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260729222311_bind_save_field_actor.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-save-field-actor-binding.sql');
const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    killSignal: 'SIGTERM',
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql, { allowFailure = false } = {}) {
  return docker(
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, allowFailure },
  );
}

function assertInputs() {
  for (const file of [MIGRATION, SMOKE]) {
    assert.ok(existsSync(file), `missing checked-in proof input: ${file}`);
  }
  const migration = readFileSync(MIGRATION, 'utf8');
  const smoke = readFileSync(SMOKE, 'utf8');
  for (const marker of [
    'CREATE OR REPLACE FUNCTION public.save_field(',
    'v_actor := auth.uid()',
    "RAISE EXCEPTION 'ACTOR_MISMATCH'",
    'v_actor, \'field\', v_field_id',
  ]) {
    assert.ok(migration.includes(marker), `migration marker missing: ${marker}`);
  }
  for (const marker of [
    PASS_TOKEN,
    'accepted forged actor',
    'nullable-actor replay',
    'truthful field activity',
  ]) {
    assert.ok(smoke.includes(marker), `smoke marker missing: ${marker}`);
  }
}

function startContainer() {
  assert.match(CONTAINER, /^[a-z0-9][a-z0-9_.-]+$/);
  docker([
    'run', '--detach', '--name', CONTAINER, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
    '--env', 'POSTGRES_PASSWORD=disposable-only', 'postgres:17-alpine',
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('disposable PostgreSQL container did not become ready');
}

function installMinimumSchema() {
  psql(`
CREATE EXTENSION pgcrypto;
CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$fn$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, role text NOT NULL, is_active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farm_name text NOT NULL
);
CREATE TABLE public.fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  field_name text NOT NULL, legal_description text, county text, state text,
  total_acres numeric, fsa_farm_number text, fsa_tract_number text,
  fsa_field_number text, crop_type text, soil_type text, irrigation boolean,
  notes text, is_active boolean
);
CREATE TABLE public.field_billing_defaults (
  field_id uuid NOT NULL REFERENCES public.fields(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  split_pct numeric NOT NULL, is_primary boolean NOT NULL, notes text,
  price_override_cents bigint, pricing_note text
);
CREATE TABLE public.activity_feed (
  event_type text NOT NULL, description text NOT NULL,
  performed_by uuid NOT NULL REFERENCES public.profiles(id),
  related_entity_type text NOT NULL, related_entity_id uuid NOT NULL
);
CREATE TABLE public.idempotency_keys (
  idempotency_key text NOT NULL, operation text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY (idempotency_key, operation)
);

CREATE FUNCTION public.require_admin_or_sales_rep() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
END
$fn$;

CREATE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
  SELECT result FROM public.idempotency_keys
  WHERE idempotency_key = p_key AND operation = p_operation
$fn$;

CREATE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key, operation) DO NOTHING;
END
$fn$;

INSERT INTO public.profiles (id, role, is_active) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', true),
  ('00000000-0000-0000-0000-000000000002', 'sales_rep', true);
`);
}

try {
  assertInputs();
  startContainer();
  installMinimumSchema();
  psql(readFileSync(MIGRATION, 'utf8'));

  const smoke = psql(readFileSync(SMOKE, 'utf8'), { allowFailure: true });
  const output = `${smoke.stdout || ''}\n${smoke.stderr || ''}`;
  assert.notEqual(smoke.status, 0, 'rollback smoke unexpectedly committed');
  assert.match(output, new RegExp(PASS_TOKEN), output);

  console.log('SAVE_FIELD_ACTOR_BINDING_PROOF_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
