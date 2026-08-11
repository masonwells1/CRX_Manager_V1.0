#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-assign-customers-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260811230423_log_customer_sales_rep_assignment.sql',
);
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-assign-customers-sales-rep.sql');
const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const SALES_REP_ID = '00000000-0000-0000-0000-000000000002';

function docker(args, { input, allowFailure = false, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    timeout,
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
    [
      'exec', '-i', CONTAINER,
      'psql', '-U', 'postgres', '-d', 'postgres',
      '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    ],
    { input: sql, allowFailure },
  );
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec', '-i', CONTAINER,
        'psql', '-U', 'postgres', '-d', 'postgres',
        '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
      ],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('asynchronous database proof timed out'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(sql);
  });
}

function assertInputs() {
  for (const file of [MIGRATION, SMOKE]) {
    assert.ok(existsSync(file), `missing checked-in proof input: ${file}`);
  }
  const migration = readFileSync(MIGRATION, 'utf8');
  for (const marker of [
    'FOR SHARE;',
    'updated_at = now()',
    'INSERT INTO public.activity_feed',
    'ASSIGNMENT_AUDIT_COUNT_MISMATCH',
    'PERFORM public.save_idempotency(',
  ]) {
    assert.ok(migration.includes(marker), `migration marker missing: ${marker}`);
  }
  const smoke = readFileSync(SMOKE, 'utf8');
  for (const marker of [
    PASS_TOKEN,
    'assignment wrote % activity rows instead of 2',
    'exact replay duplicated',
    'positive assignment did not advance both customer timestamps',
  ]) {
    assert.ok(smoke.includes(marker), `smoke marker missing: ${marker}`);
  }
}

function startContainer() {
  assert.match(CONTAINER, /^[a-z0-9][a-z0-9_.-]+$/);
  docker([
    'run', '--detach', '--name', CONTAINER, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
    '--env', 'POSTGRES_PASSWORD=disposable-only',
    'postgres:17-alpine',
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = docker(
      ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    );
    if (ready.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('disposable PostgreSQL container did not become ready');
}

function installMinimumShape() {
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
  id uuid PRIMARY KEY,
  full_name text,
  role text NOT NULL,
  is_active boolean NOT NULL
);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  farm_name text NOT NULL,
  assigned_sales_rep uuid REFERENCES public.profiles(id),
  is_active boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z'
);
CREATE TABLE public.activity_feed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  description text NOT NULL,
  performed_by uuid NOT NULL REFERENCES public.profiles(id),
  related_entity_type text,
  related_entity_id uuid,
  customer_id uuid REFERENCES public.customers(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.idempotency_keys (
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (idempotency_key, operation)
);

CREATE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
  SELECT result
    FROM public.idempotency_keys
   WHERE idempotency_key = p_key AND operation = p_operation
$fn$;

CREATE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result);
END
$fn$;

INSERT INTO public.profiles (id, full_name, role, is_active) VALUES
  ('${ADMIN_ID}', 'Disposable Admin', 'admin', true),
  ('${SALES_REP_ID}', 'Disposable Rep', 'sales_rep', true);
INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active) VALUES
  ('00000000-0000-0000-0000-000000000011', 'North Test Farm', NULL, true),
  ('00000000-0000-0000-0000-000000000012', 'South Test Farm', NULL, true);
`);
}

async function waitUntilDeactivationOwnsTheRowLock() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = psql(`
SELECT count(*)
  FROM pg_stat_activity
 WHERE application_name = 'assignment-target-deactivation-proof'
   AND wait_event_type = 'Timeout'
   AND wait_event = 'PgSleep';
`);
    if (result.stdout.trim() === '1') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('target-deactivation session never reached its held-row-lock barrier');
}

async function proveTargetDeactivationWinsBeforeValidation() {
  const deactivate = psqlAsync(`
SET application_name = 'assignment-target-deactivation-proof';
BEGIN;
UPDATE public.profiles SET is_active = false WHERE id = '${SALES_REP_ID}';
SELECT pg_sleep(3);
COMMIT;
`);
  await waitUntilDeactivationOwnsTheRowLock();

  const assignment = psql(`
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', '${ADMIN_ID}', 'role', 'authenticated')::text,
  false
);
SELECT public.assign_customers_sales_rep(
  ARRAY['00000000-0000-0000-0000-000000000011'::uuid],
  '${SALES_REP_ID}'::uuid,
  'disposable:target-deactivation-wins'
);
`, { allowFailure: true });
  const assignmentOutput = `${assignment.stdout}\n${assignment.stderr}`;
  assert.notEqual(assignment.status, 0, 'assignment unexpectedly beat the existing deactivation lock');
  assert.match(assignmentOutput, /ASSIGNMENT_SALES_REP_INACTIVE/, assignmentOutput);

  const deactivation = await deactivate;
  assert.equal(deactivation.status, 0, deactivation.stderr || deactivation.stdout);
  const residue = psql(`
SELECT
  (SELECT count(*) FROM public.customers WHERE assigned_sales_rep IS NOT NULL),
  (SELECT count(*) FROM public.activity_feed),
  (SELECT count(*) FROM public.idempotency_keys),
  (SELECT count(*) FROM public.customers WHERE updated_at <> '2000-01-01T00:00:00Z');
UPDATE public.profiles SET is_active = true WHERE id = '${SALES_REP_ID}';
`).stdout.trim().split(/\r?\n/)[0];
  assert.equal(residue, '0|0|0|0', `deactivation race left mutation residue: ${residue}`);
}

async function run() {
  assertInputs();
  startContainer();
  installMinimumShape();
  psql(readFileSync(MIGRATION, 'utf8'));
  await proveTargetDeactivationWinsBeforeValidation();

  const smoke = psql(readFileSync(SMOKE, 'utf8'), { allowFailure: true });
  const output = `${smoke.stdout || ''}\n${smoke.stderr || ''}`;
  assert.notEqual(smoke.status, 0, 'rollback smoke unexpectedly committed');
  assert.match(output, new RegExp(PASS_TOKEN), output);

  const postSmoke = psql(`
SELECT
  (SELECT count(*) FROM public.customers WHERE assigned_sales_rep IS NOT NULL),
  (SELECT count(*) FROM public.activity_feed),
  (SELECT count(*) FROM public.idempotency_keys),
  (SELECT count(*) FROM public.customers WHERE updated_at <> '2000-01-01T00:00:00Z');
`).stdout.trim();
  assert.equal(postSmoke, '0|0|0|0', `rollback smoke left residue: ${postSmoke}`);

  console.log(
    'ASSIGN_CUSTOMERS_SALES_REP_PROOF_PASS migration=exact smoke=rollback updated_at=advanced activity=2 replay=dedup target_deactivation=blocked',
  );
}

try {
  await run();
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
