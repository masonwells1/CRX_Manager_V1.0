#!/usr/bin/env node
/**
 * Disposable Section 1 proof. It never reads a DB URL or connects to Supabase:
 * a unique PostgreSQL 17 container runs with --network none and tmpfs storage.
 * The exact checked-in migration and rollback smoke are loaded verbatim, then
 * the smoke must terminate with SMOKE_PASS_ROLLBACK. The container is removed
 * in finally on both success and failure.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-section1-number-field-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260725234503_harden_section1_number_and_field_actor.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-section1-number-and-field-actor.sql');
const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) fail(`docker could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(`docker ${args.join(' ')} failed with exit ${result.status}`,
      `${result.stdout || ''}${result.stderr || ''}`.trim());
  }
  return result;
}

function psql(sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', CONTAINER,
    'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ], { input: sql, allowFailure });
}

function assertInputs() {
  for (const file of [MIGRATION, SMOKE]) {
    if (!existsSync(file)) fail(`required checked-in file is missing: ${file}`);
  }
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const smoke = readFileSync(SMOKE, 'utf8').replace(/\r\n/g, '\n');
  for (const marker of [
    'CREATE OR REPLACE FUNCTION public.next_application_record_number()',
    'CREATE OR REPLACE FUNCTION public.next_commission_payment_number()',
    'CREATE OR REPLACE FUNCTION public.next_cycle_count_number()',
    'CREATE OR REPLACE FUNCTION public.next_delivery_number()',
    'CREATE OR REPLACE FUNCTION public.next_job_number()',
    'CREATE OR REPLACE FUNCTION public.next_po_number()',
    'CREATE OR REPLACE FUNCTION public.save_field(',
    "RAISE EXCEPTION 'ACTOR_MISMATCH'",
    'REVOKE EXECUTE ON FUNCTION public.next_application_record_number() FROM PUBLIC, anon;',
    'GRANT EXECUTE ON FUNCTION public.save_field(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;',
  ]) assert.ok(migration.includes(marker), `migration marker missing: ${marker}`);
  for (const marker of [PASS_TOKEN, 'grant/search_path contract', 'inactive actor', 'nullable-actor replay']) {
    assert.ok(smoke.includes(marker), `smoke marker missing: ${marker}`);
  }
}

function startContainer() {
  if (!CONTAINER.startsWith(PREFIX) || !/^[a-z0-9][a-z0-9_.-]+$/.test(CONTAINER)) {
    fail(`refusing unsafe container name: ${CONTAINER}`);
  }
  if (docker(['container', 'inspect', CONTAINER], { allowFailure: true }).status === 0) {
    fail(`refusing to reuse existing container ${CONTAINER}`);
  }
  docker([
    'run', '--detach', '--name', CONTAINER,
    '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
    '--env', 'POSTGRES_PASSWORD=section1-disposable-only',
    IMAGE,
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      return;
    }
  }
  fail('disposable PostgreSQL container did not become ready');
}

function installLiveShapedMinimum() {
  psql(`
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $fn$
  SELECT NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
$fn$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_name text NOT NULL
);
CREATE TABLE public.application_records (record_number text NOT NULL);
CREATE TABLE public.commission_payments (payment_number text NOT NULL);
CREATE TABLE public.cycle_counts (count_number text NOT NULL);
CREATE TABLE public.deliveries (delivery_number text NOT NULL);
CREATE TABLE public.jobs (job_number text NOT NULL);
CREATE TABLE public.purchase_orders (po_number text NOT NULL);
CREATE TABLE public.fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  field_name text NOT NULL,
  legal_description text,
  county text,
  state text,
  total_acres numeric,
  fsa_farm_number text,
  fsa_tract_number text,
  fsa_field_number text,
  crop_type text,
  soil_type text,
  irrigation boolean,
  notes text,
  is_active boolean
);
CREATE TABLE public.field_billing_defaults (
  field_id uuid NOT NULL REFERENCES public.fields(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  split_pct numeric NOT NULL,
  is_primary boolean NOT NULL,
  notes text,
  price_override_cents bigint,
  pricing_note text
);
CREATE TABLE public.activity_feed (
  event_type text NOT NULL,
  description text NOT NULL,
  performed_by uuid NOT NULL REFERENCES public.profiles(id),
  related_entity_type text NOT NULL,
  related_entity_id uuid NOT NULL
);
CREATE TABLE public.idempotency_keys (
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (idempotency_key, operation)
);

CREATE OR REPLACE FUNCTION public.require_admin_or_sales_rep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
END;
$fn$;
CREATE OR REPLACE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $fn$
  SELECT result FROM public.idempotency_keys
  WHERE idempotency_key = p_key AND operation = p_operation;
$fn$;
CREATE OR REPLACE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key, operation) DO NOTHING;
END;
$fn$;

INSERT INTO public.profiles (id, role, is_active) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', true),
  ('00000000-0000-0000-0000-000000000002', 'sales_rep', true),
  ('00000000-0000-0000-0000-000000000003', 'applicator', true),
  ('00000000-0000-0000-0000-000000000004', 'driver', true),
  ('00000000-0000-0000-0000-000000000005', 'viewer', true),
  ('00000000-0000-0000-0000-000000000006', 'admin', false);

-- Baseline rows exercise the unchanged captured number-generator bodies. The
-- rollback smoke adds a higher valid value plus a safely ignored malformed or
-- out-of-scope value, then asserts the exact next number for every role.
INSERT INTO public.application_records (record_number)
SELECT 'APP-' || to_char(current_date, 'YYYY') || '-0004';
INSERT INTO public.commission_payments (payment_number)
SELECT 'CP-' || to_char(current_date, 'YYYY') || '-0004';
INSERT INTO public.cycle_counts (count_number)
SELECT 'CC-' || to_char(current_date, 'YYYY') || '-00004';
INSERT INTO public.deliveries (delivery_number) VALUES ('DEL-00004');
INSERT INTO public.jobs (job_number)
SELECT 'JOB-' || to_char(current_date, 'YYYY') || '-0004';
INSERT INTO public.purchase_orders (po_number)
SELECT 'PO-' || to_char(current_date, 'YYYY') || '-0004';
INSERT INTO public.commission_payments (payment_number)
SELECT 'CP-' || to_char(current_date - interval '1 year', 'YYYY') || '-not-a-number';
`);
}

try {
  assertInputs();
  startContainer();
  installLiveShapedMinimum();
  psql(readFileSync(MIGRATION, 'utf8'));
  const smoke = psql(readFileSync(SMOKE, 'utf8'), { allowFailure: true });
  const output = `${smoke.stdout || ''}\n${smoke.stderr || ''}`;
  assert.notEqual(smoke.status, 0, 'rollback smoke unexpectedly succeeded without terminal rollback');
  assert.match(output, new RegExp(PASS_TOKEN), output);
  console.log('SECTION1_NUMBER_AND_FIELD_ACTOR_PROOF_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
