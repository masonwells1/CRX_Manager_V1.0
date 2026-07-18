#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for per-line split-billing Phase 1 invariants.
 *
 * Safety properties:
 * - creates a uniquely named Docker container with a narrow, validated prefix;
 * - uses --network none and a tmpfs data directory;
 * - applies the checked-in Phase 1 migration verbatim; and
 * - removes the container in finally on PASS or FAIL.
 */

import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-split-phase1-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const PASSWORD = 'split-phase1-disposable-only';
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260718210000_per_line_split_billing_phase1_schema.sql',
);

const ID = {
  actor: '00000000-0000-4000-8000-000000000001',
  customerA: '00000000-0000-4000-8000-000000000011',
  customerB: '00000000-0000-4000-8000-000000000012',
  set: '00000000-0000-4000-8000-000000000021',
  lineA: '00000000-0000-4000-8000-000000000031',
  lineB: '00000000-0000-4000-8000-000000000032',
  draftInvoice: '00000000-0000-4000-8000-000000000041',
  postedInvoice: '00000000-0000-4000-8000-000000000042',
  itemA: '00000000-0000-4000-8000-000000000051',
  itemB: '00000000-0000-4000-8000-000000000052',
  postedItem: '00000000-0000-4000-8000-000000000053',
  shareA: '00000000-0000-4000-8000-000000000061',
  shareB: '00000000-0000-4000-8000-000000000062',
};

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function assertSafeContainerName() {
  if (!CONTAINER.startsWith(PREFIX) || !/^[a-z0-9][a-z0-9_.-]+$/.test(CONTAINER)) {
    fail(`refusing unsafe container name: ${CONTAINER}`);
  }
}

function dockerSync(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) fail(`docker could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(
      `docker ${args.join(' ')} failed with exit ${result.status}`,
      `${result.stdout || ''}${result.stderr || ''}`.trim(),
    );
  }
  return result;
}

function psqlArgs() {
  return [
    'exec', '-i', CONTAINER,
    'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  ];
}

function runSql(sql, { allowFailure = false } = {}) {
  return dockerSync(psqlArgs(), { input: sql, allowFailure });
}

function scalar(sql) {
  const output = runSql(sql).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (output === undefined) fail('scalar query returned no value', sql);
  return output;
}

function startSqlWithMarker(sql, marker) {
  const child = spawn('docker', psqlArgs(), {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readySettled = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      readyReject(new Error(`timed out waiting for SQL marker ${marker}`));
    }
  }, 10_000);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!readySettled && stdout.includes(marker)) {
      readySettled = true;
      clearTimeout(timeout);
      readyResolve();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);

  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (!readySettled) readyReject(error);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (!readySettled) {
        readySettled = true;
        readyReject(new Error(`SQL exited before ${marker}: ${stderr || stdout}`));
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { ready, completion };
}

function startSql(sql) {
  const child = spawn('docker', psqlArgs(), {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function prepareContainer() {
  assertSafeContainerName();
  const existing = dockerSync(['container', 'inspect', CONTAINER], { allowFailure: true });
  if (existing.status === 0) fail(`refusing to reuse existing container ${CONTAINER}`);

  dockerSync([
    'run', '--detach', '--name', CONTAINER,
    '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
    '--env', `POSTGRES_PASSWORD=${PASSWORD}`,
    IMAGE,
  ]);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = dockerSync(
      ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    );
    if (ready.status === 0) {
      sleepSync(2_000);
      const stable = dockerSync(
        ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
        { allowFailure: true },
      );
      if (stable.status === 0) return;
    }
  }
  fail('disposable PostgreSQL container did not become ready within 30 seconds');
}

function installSchema() {
  runSql(`
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;

-- Mirror the live Supabase default privilege posture that originally granted
-- authenticated more than row DML on newly created public tables. The migration
-- must reduce its three new tables to explicit SELECT-only client access.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO authenticated;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.is_sales_rep() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.is_applicator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY);
CREATE TABLE public.customers (id uuid PRIMARY KEY);
CREATE TABLE public.jobs (id uuid PRIMARY KEY);
CREATE TABLE public.products (id uuid PRIMARY KEY);
CREATE TABLE public.application_services (id uuid PRIMARY KEY);
CREATE TABLE public.app_settings (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL,
  description text
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  posted_at timestamptz,
  invoice_group_id uuid,
  total_amount_cents bigint NOT NULL DEFAULT 0,
  created_by uuid REFERENCES public.profiles(id),
  salesman_id uuid REFERENCES public.profiles(id)
);
CREATE TABLE public.invoice_items (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id),
  quantity numeric(12,4),
  acres numeric(12,2)
);
GRANT UPDATE ON public.invoices TO authenticated;
`);

  const migration = readFileSync(MIGRATION, 'utf8');
  for (const marker of [
    'CREATE TABLE IF NOT EXISTS public.field_app_billing_lines',
    'CREATE CONSTRAINT TRIGGER trg_invoice_line_shares_sum_100',
    'CREATE TRIGGER trg_invoice_line_shares_frozen_when_posted',
  ]) {
    if (!migration.includes(marker)) fail(`migration lost required marker: ${marker}`);
  }
  runSql(migration);
}

function resetFixture() {
  runSql(`
TRUNCATE TABLE
  public.invoice_line_shares,
  public.field_app_billing_lines,
  public.field_app_billing_sets,
  public.invoice_items,
  public.invoices,
  public.customers,
  public.profiles
CASCADE;

INSERT INTO public.profiles (id) VALUES ('${ID.actor}');
INSERT INTO public.customers (id) VALUES ('${ID.customerA}'), ('${ID.customerB}');
INSERT INTO public.invoices (
  id, status, posted_at, total_amount_cents, created_by, salesman_id
) VALUES
  ('${ID.draftInvoice}', 'draft', NULL, 0, '${ID.actor}', '${ID.actor}'),
  ('${ID.postedInvoice}', 'posted', now(), 1000, '${ID.actor}', '${ID.actor}');
INSERT INTO public.invoice_items (id, invoice_id, quantity, acres) VALUES
  ('${ID.itemA}', '${ID.draftInvoice}', 1, 1),
  ('${ID.itemB}', '${ID.draftInvoice}', 1, 1),
  ('${ID.postedItem}', '${ID.postedInvoice}', 1, 1);
INSERT INTO public.field_app_billing_sets (id, primary_customer_id, created_by)
VALUES ('${ID.set}', '${ID.customerA}', '${ID.actor}');
`);
}

function lineSql(id, description) {
  return `
INSERT INTO public.field_app_billing_lines (
  id, billing_set_id, line_kind, price_basis, description,
  source_quantity, source_acres, source_unit_price_cents, source_amount_cents
) VALUES (
  '${id}', '${ID.set}', 'chemical', 'same_price', '${description}',
  1, 1, 1000, 1000
);`;
}

function shareSql({ id, line, item, customer, split = 100000000 }) {
  return `
INSERT INTO public.invoice_line_shares (
  id, billing_line_id, invoice_item_id, customer_id,
  split_mode, split_micro_pct, allocated_quantity, allocated_acres,
  base_unit_price_cents, base_price_source, price_mode, unit_price_cents,
  amount_cents, calculation_hash, vector_hash, created_by
) VALUES (
  '${id}', '${line}', '${item}', '${customer}',
  'field_default', ${split}, 1, 1,
  1000, 'proof', 'default', 1000,
  1000, 'proof-calculation', 'proof-vector', '${ID.actor}'
);`;
}

function expectRejected(label, sql, expectedPattern) {
  const result = runSql(sql, { allowFailure: true });
  const detail = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status === 0) {
    return { label, passed: false, detail: 'unsafe transaction committed' };
  }
  if (expectedPattern && !expectedPattern.test(detail)) {
    return { label, passed: false, detail: `rejected for the wrong reason:\n${detail.trim()}` };
  }
  return { label, passed: true, detail: detail.trim().split(/\r?\n/).at(-1) };
}

function proveTriggerSecurityContext() {
  const posture = scalar(`
    SELECT
      count(*) FILTER (WHERE p.prosecdef)::text || '|' ||
      count(*) FILTER (
        WHERE p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
      )::text || '|' ||
      count(*) FILTER (
        WHERE NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )::text || '|' ||
      count(*) FILTER (WHERE r.rolbypassrls)::text
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'trg_invoice_line_shares_sum_100',
        'trg_field_app_billing_line_has_shares',
        'trg_invoice_line_shares_frozen_when_posted'
      );
  `);
  const passed = posture === '3|3|3|3';
  return {
    label: 'all invariant triggers use a locked-down RLS-bypass definer context',
    passed,
    detail: passed
      ? '3 SECURITY DEFINER + fixed search_path + no client EXECUTE + BYPASSRLS owner'
      : `catalog posture definer|search_path|locked_execute|bypass_owner = ${posture}`,
  };
}

function proveMovedSourceLine() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'source line')}
${lineSql(ID.lineB, 'destination line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
${shareSql({ id: ID.shareB, line: ID.lineB, item: ID.itemB, customer: ID.customerB })}
COMMIT;
`);
  return expectRejected(
    'moving a share cannot leave its source line at 0%',
    `BEGIN;
     UPDATE public.invoice_line_shares
        SET billing_line_id = '${ID.lineB}'
      WHERE id = '${ID.shareA}';
     UPDATE public.invoice_line_shares
        SET split_micro_pct = 0
      WHERE id = '${ID.shareB}';
     COMMIT;`,
    /sums to 0 micro-pct/i,
  );
}

function provePostedReparent() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'draft source line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
`);
  return expectRejected(
    'a draft share cannot be reparented onto a posted invoice item',
    `UPDATE public.invoice_line_shares
        SET invoice_item_id = '${ID.postedItem}'
      WHERE id = '${ID.shareA}';`,
    /frozen.*posted/i,
  );
}

function provePostedParentCascade() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'posted cascade source line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
UPDATE public.invoices
   SET status = 'posted', posted_at = now()
 WHERE id = '${ID.draftInvoice}';
`);
  return expectRejected(
    'posted allocation snapshots cannot be erased through parent cascades',
    `BEGIN;
     DELETE FROM public.invoice_items WHERE id = '${ID.itemA}';
     DELETE FROM public.field_app_billing_lines WHERE id = '${ID.lineA}';
     COMMIT;`,
    /foreign key|still referenced|frozen.*posted/i,
  );
}

function proveClientCannotTruncate() {
  resetFixture();
  return expectRejected(
    'authenticated is SELECT-only and cannot TRUNCATE allocation tables',
    `BEGIN;
     SET LOCAL ROLE authenticated;
     TRUNCATE TABLE public.field_app_billing_sets CASCADE;
     COMMIT;`,
    /permission denied/i,
  );
}

function proveClientCannotSetSendDisposition() {
  resetFixture();
  return expectRejected(
    'browser roles cannot change the server-controlled send disposition',
    `BEGIN;
     SET LOCAL ROLE authenticated;
     UPDATE public.invoices
        SET send_disposition = 'suppressed_zero_total'
      WHERE id = '${ID.draftInvoice}';
     COMMIT;`,
    /server-controlled|permission denied/i,
  );
}

function proveSuppressionRequiresZeroTotal() {
  resetFixture();
  return expectRejected(
    'suppressed_zero_total cannot be assigned to a nonzero invoice',
    `UPDATE public.invoices
        SET send_disposition = 'suppressed_zero_total'
      WHERE id = '${ID.postedInvoice}';`,
    /send_disposition|check constraint|zero total/i,
  );
}

function proveServerCanSuppressZeroTotal() {
  resetFixture();
  runSql(`
UPDATE public.invoices
   SET send_disposition = 'suppressed_zero_total'
 WHERE id = '${ID.draftInvoice}';
`);
  const disposition = scalar(`
    SELECT send_disposition
      FROM public.invoices
     WHERE id = '${ID.draftInvoice}';
  `);
  return {
    label: 'server authority can suppress a zero-total invoice',
    passed: disposition === 'suppressed_zero_total',
    detail: `stored disposition = ${disposition}`,
  };
}

function proveEmptyLine() {
  resetFixture();
  return expectRejected(
    'a billing line cannot commit without an exact share vector',
    `BEGIN;
     ${lineSql(ID.lineA, 'empty line')}
     COMMIT;`,
    /has no invoice_line_shares|sums to 0 micro-pct/i,
  );
}

async function proveConcurrentVectors() {
  resetFixture();
  // Seed an empty parent while triggers are disabled solely to exercise the share
  // trigger's write-skew defense. Production must reject this parent state itself.
  runSql(`
SET session_replication_role = replica;
${lineSql(ID.lineA, 'concurrency proof line')}
SET session_replication_role = origin;
`);

  const sessionA = startSqlWithMarker(`
BEGIN;
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'SESSION_A_VECTOR_CHECKED';
SELECT pg_sleep(2);
COMMIT;
`, 'SESSION_A_VECTOR_CHECKED');

  await sessionA.ready;
  const sessionB = startSql(`
BEGIN;
${shareSql({ id: ID.shareB, line: ID.lineA, item: ID.itemB, customer: ID.customerB })}
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
`);

  const [resultA, resultB] = await Promise.all([sessionA.completion, sessionB]);
  const successCount = [resultA, resultB].filter((result) => result.code === 0).length;
  const sum = scalar(`
    SELECT COALESCE(SUM(split_micro_pct), 0)::text
    FROM public.invoice_line_shares
    WHERE billing_line_id = '${ID.lineA}';
  `);
  const passed = successCount === 1 && sum === '100000000';
  return {
    label: 'concurrent writers cannot commit two full vectors for one line',
    passed,
    detail: passed
      ? 'one writer committed; the other was rejected; final sum = 100000000'
      : `successful writers = ${successCount}; final sum = ${sum}`,
  };
}

async function main() {
  prepareContainer();
  installSchema();

  const results = [
    proveTriggerSecurityContext(),
    proveMovedSourceLine(),
    provePostedReparent(),
    provePostedParentCascade(),
    proveClientCannotTruncate(),
    proveClientCannotSetSendDisposition(),
    proveSuppressionRequiresZeroTotal(),
    proveServerCanSuppressZeroTotal(),
    proveEmptyLine(),
    await proveConcurrentVectors(),
  ];

  for (const result of results) {
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}: ${result.label}\n  ${result.detail}\n`);
  }
  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0) {
    fail(`${failures.length} Phase 1 invariant proof(s) failed`);
  }
  process.stdout.write('PHASE1_SPLIT_BILLING_PROOF_PASS\n');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  try {
    assertSafeContainerName();
    dockerSync(['rm', '--force', CONTAINER], { allowFailure: true });
  } catch (cleanupError) {
    exitCode = 1;
    process.stderr.write(`cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
  }
}
process.exitCode = exitCode;
