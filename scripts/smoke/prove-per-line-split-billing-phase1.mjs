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
  '20260720231000_per_line_split_billing_phase1_schema.sql',
);

const ID = {
  actor: '00000000-0000-4000-8000-000000000001',
  actorB: '00000000-0000-4000-8000-000000000002',
  customerA: '00000000-0000-4000-8000-000000000011',
  customerB: '00000000-0000-4000-8000-000000000012',
  set: '00000000-0000-4000-8000-000000000021',
  setB: '00000000-0000-4000-8000-000000000022',
  group: '00000000-0000-4000-8000-000000000023',
  lineA: '00000000-0000-4000-8000-000000000031',
  lineB: '00000000-0000-4000-8000-000000000032',
  draftInvoice: '00000000-0000-4000-8000-000000000041',
  postedInvoice: '00000000-0000-4000-8000-000000000042',
  otherDraftInvoice: '00000000-0000-4000-8000-000000000043',
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
-- A constraint name is only unique per table in PostgreSQL. This decoy proves
-- the migration scopes its idempotency check to public.invoices instead of
-- trusting a same-named constraint on an unrelated table.
CREATE TABLE public.constraint_name_decoy (
  value integer CONSTRAINT invoices_send_disposition_ck CHECK (value > 0)
);
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
  acres numeric(12,2),
  unit_price_cents bigint NOT NULL DEFAULT 0,
  extended_cents bigint NOT NULL DEFAULT 0
);
GRANT UPDATE ON public.invoices TO authenticated;
`);

  const migration = readFileSync(MIGRATION, 'utf8');
  for (const marker of [
    'CREATE TABLE IF NOT EXISTS public.field_app_billing_lines',
    'CREATE TABLE IF NOT EXISTS public.invoice_line_share_post_snapshots',
    'CREATE CONSTRAINT TRIGGER trg_invoice_line_shares_sum_100',
    'CREATE TRIGGER trg_invoice_line_shares_frozen_when_posted',
    'CREATE TRIGGER trg_invoice_items_shared_parent_frozen_when_posted',
    'CREATE TRIGGER trg_capture_invoice_line_share_post_snapshot',
  ]) {
    if (!migration.includes(marker)) fail(`migration lost required marker: ${marker}`);
  }
  runSql(migration);
}

function resetFixture() {
  runSql(`
-- The production history table is intentionally non-truncatable. This disposable
-- superuser fixture bypasses its trigger only to isolate each proof case.
SET session_replication_role = replica;
TRUNCATE TABLE public.invoice_line_share_post_snapshots;
SET session_replication_role = origin;

TRUNCATE TABLE
  public.invoice_line_shares,
  public.field_app_billing_lines,
  public.field_app_billing_sets,
  public.invoice_items,
  public.invoices,
  public.customers,
  public.profiles
CASCADE;

INSERT INTO public.profiles (id) VALUES ('${ID.actor}'), ('${ID.actorB}');
INSERT INTO public.customers (id) VALUES ('${ID.customerA}'), ('${ID.customerB}');
INSERT INTO public.invoices (
  id, status, posted_at, total_amount_cents, created_by, salesman_id
) VALUES
  ('${ID.draftInvoice}', 'draft', NULL, 0, '${ID.actor}', '${ID.actor}'),
  ('${ID.postedInvoice}', 'posted', now(), 1000, '${ID.actor}', '${ID.actor}'),
  ('${ID.otherDraftInvoice}', 'draft', NULL, 0, '${ID.actor}', '${ID.actor}');
INSERT INTO public.invoice_items (id, invoice_id, quantity, acres) VALUES
  ('${ID.itemA}', '${ID.draftInvoice}', 1, 1),
  ('${ID.itemB}', '${ID.otherDraftInvoice}', 1, 1),
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
        'trg_invoice_line_shares_frozen_when_posted',
        'trg_invoice_items_shared_parent_frozen_when_posted',
        'trg_invoice_line_share_post_snapshots_immutable',
        'trg_capture_invoice_line_share_post_snapshot'
      );
  `);
  const passed = posture === '6|6|6|6';
  return {
    label: 'all invariant triggers use a locked-down RLS-bypass definer context',
    passed,
    detail: passed
      ? '6 SECURITY DEFINER + fixed search_path + no client EXECUTE + BYPASSRLS owner'
      : `catalog posture definer|search_path|locked_execute|bypass_owner = ${posture}`,
  };
}

function proveNewForeignKeysAreIndexed() {
  const indexed = scalar(`
    SELECT count(*)::text
      FROM unnest(ARRAY[
        'public.idx_field_app_billing_sets_primary_customer',
        'public.idx_field_app_billing_sets_created_by',
        'public.idx_field_app_billing_lines_product',
        'public.idx_field_app_billing_lines_application_service',
        'public.idx_invoice_line_shares_created_by'
      ]) AS expected(index_name)
     WHERE to_regclass(expected.index_name) IS NOT NULL;
  `);
  return {
    label: 'every newly added foreign-key column has a supporting index',
    passed: indexed === '5',
    detail: `${indexed}/5 previously uncovered foreign-key indexes exist`,
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

function proveSharedPostedItemCannotMoveToDraft() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'posted parent reparent source line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
UPDATE public.invoices
   SET status = 'posted', posted_at = now()
 WHERE id = '${ID.draftInvoice}';
`);
  return expectRejected(
    'a shared invoice item cannot move from a posted invoice to a draft invoice',
    `UPDATE public.invoice_items
        SET invoice_id = '${ID.otherDraftInvoice}'
      WHERE id = '${ID.itemA}';`,
    /frozen.*posted/i,
  );
}

function proveSharedPostedItemMaterialFieldsAreFrozen() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'posted material-field source line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
UPDATE public.invoices
   SET status = 'posted', posted_at = now()
 WHERE id = '${ID.draftInvoice}';
`);

  const attempts = [
    ['quantity', '2'],
    ['acres', '2'],
    ['unit_price_cents', '2000'],
    ['extended_cents', '2000'],
  ];
  const failures = [];
  for (const [column, value] of attempts) {
    const result = runSql(
      `UPDATE public.invoice_items SET ${column} = ${value} WHERE id = '${ID.itemA}';`,
      { allowFailure: true },
    );
    const detail = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status === 0 || !/frozen.*posted/i.test(detail)) {
      failures.push(`${column}: status=${result.status}; ${detail.trim() || 'unsafe update committed'}`);
    }
  }

  const finalState = scalar(`
SELECT quantity::text || '|' || acres::text || '|' ||
       unit_price_cents::text || '|' || extended_cents::text
  FROM public.invoice_items
 WHERE id = '${ID.itemA}';
`);
  const passed = failures.length === 0 && finalState === '1.0000|1.00|0|0';
  return {
    label: 'posted split invoice-item allocation fields are frozen with their share snapshot',
    passed,
    detail: passed
      ? 'quantity, acres, unit price, and extended cents were all rejected; stored values stayed unchanged'
      : `${failures.join('\n')}${failures.length ? '\n' : ''}stored quantity|acres|unit|extended = ${finalState}`,
  };
}

function proveSharedDraftItemMaterialFieldsRemainEditable() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'draft material-field source line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
UPDATE public.invoice_items
   SET quantity = 2,
       acres = 2,
       unit_price_cents = 2000,
       extended_cents = 4000
 WHERE id = '${ID.itemA}';
`);
  const finalState = scalar(`
SELECT quantity::text || '|' || acres::text || '|' ||
       unit_price_cents::text || '|' || extended_cents::text
  FROM public.invoice_items
 WHERE id = '${ID.itemA}';
`);
  return {
    label: 'draft split invoice-item allocation fields remain editable',
    passed: finalState === '2.0000|2.00|2000|4000',
    detail: `stored quantity|acres|unit|extended = ${finalState}`,
  };
}

function proveDraftItemCanMoveWithShareRebuild() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'draft parent rebuild source line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;

BEGIN;
DELETE FROM public.invoice_line_shares WHERE id = '${ID.shareA}';
UPDATE public.invoice_items
   SET invoice_id = '${ID.otherDraftInvoice}'
 WHERE id = '${ID.itemA}';
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
`);
  const finalState = scalar(`
SELECT ii.invoice_id::text || '|' || count(s.id)::text
  FROM public.invoice_items ii
  LEFT JOIN public.invoice_line_shares s ON s.invoice_item_id = ii.id
 WHERE ii.id = '${ID.itemA}'
 GROUP BY ii.invoice_id;
`);
  return {
    label: 'draft workflows can deliberately rebuild shares around an item reparent',
    passed: finalState === `${ID.otherDraftInvoice}|1`,
    detail: `final invoice|share count = ${finalState}`,
  };
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

function proveOneBillingSetPerInvoiceGroup() {
  resetFixture();
  runSql(`
UPDATE public.field_app_billing_sets
   SET invoice_group_id = '${ID.group}'
 WHERE id = '${ID.set}';
`);
  return expectRejected(
    'one invoice group cannot be attached to competing billing sets',
    `INSERT INTO public.field_app_billing_sets (
       id, invoice_group_id, primary_customer_id, created_by
     ) VALUES (
       '${ID.setB}', '${ID.group}', '${ID.customerB}', '${ID.actor}'
     );`,
    /unique|duplicate key|invoice_group/i,
  );
}

function proveApplicatorCannotReadBillingSources() {
  resetFixture();
  runSql(`
CREATE OR REPLACE FUNCTION public.is_applicator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
`);
  const visibleRows = scalar(`
SET ROLE authenticated;
SELECT
  (SELECT count(*) FROM public.field_app_billing_sets)::text || '|' ||
  (SELECT count(*) FROM public.field_app_billing_lines)::text;
RESET ROLE;
`);
  runSql(`
CREATE OR REPLACE FUNCTION public.is_applicator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$;
`);
  return {
    label: 'applicators cannot read unrelated split-billing source data',
    passed: visibleRows === '0|0',
    detail: `visible billing sets|lines = ${visibleRows}`,
  };
}

function proveSalesRepBillingSourceReadsAreOwnerScoped() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'sales-rep source scope line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
CREATE OR REPLACE FUNCTION public.is_sales_rep() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
`);

  const outsiderRows = scalar(`
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '${ID.actorB}', false);
SELECT
  (SELECT count(*) FROM public.field_app_billing_sets)::text || '|' ||
  (SELECT count(*) FROM public.field_app_billing_lines)::text;
RESET ROLE;
`);
  const ownerRows = scalar(`
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '${ID.actor}', false);
SELECT
  (SELECT count(*) FROM public.field_app_billing_sets)::text || '|' ||
  (SELECT count(*) FROM public.field_app_billing_lines)::text;
RESET ROLE;
`);
  runSql(`
CREATE OR REPLACE FUNCTION public.is_sales_rep() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$;
`);

  return {
    label: 'sales reps can read their own billing sources but not another rep\'s',
    passed: outsiderRows === '0|0' && ownerRows === '1|1',
    detail: `outsider sets|lines = ${outsiderRows}; owner sets|lines = ${ownerRows}`,
  };
}

function proveSalesRepShareAndHistoryReadsRequireActiveRole() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'active-role share/history scope line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
UPDATE public.invoices
   SET status = 'posted', posted_at = '2026-07-18T15:00:00Z'
 WHERE id = '${ID.draftInvoice}';
CREATE OR REPLACE FUNCTION public.is_sales_rep() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
`);

  const activeRows = scalar(`
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '${ID.actor}', false);
SELECT
  (SELECT count(*) FROM public.invoice_line_shares)::text || '|' ||
  (SELECT count(*) FROM public.invoice_line_share_post_snapshots)::text;
RESET ROLE;
`);
  runSql(`
CREATE OR REPLACE FUNCTION public.is_sales_rep() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT false $$;
`);
  const downgradedRows = scalar(`
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '${ID.actor}', false);
SELECT
  (SELECT count(*) FROM public.invoice_line_shares)::text || '|' ||
  (SELECT count(*) FROM public.invoice_line_share_post_snapshots)::text;
RESET ROLE;
`);

  return {
    label: 'share and posting-history reads require a currently active sales role',
    passed: activeRows === '1|1' && downgradedRows === '0|0',
    detail: `active shares|history = ${activeRows}; downgraded shares|history = ${downgradedRows}`,
  };
}

function proveBlankSplitOverrideReasonRejected() {
  resetFixture();
  return expectRejected(
    'custom split overrides require a nonblank audit reason',
    `BEGIN;
     ${lineSql(ID.lineA, 'blank split reason line')}
     INSERT INTO public.invoice_line_shares (
       id, billing_line_id, invoice_item_id, customer_id,
       split_mode, split_micro_pct, allocated_quantity, allocated_acres,
       base_unit_price_cents, base_price_source, price_mode, unit_price_cents,
       amount_cents, split_override_reason, calculation_hash, vector_hash, created_by
     ) VALUES (
       '${ID.shareA}', '${ID.lineA}', '${ID.itemA}', '${ID.customerA}',
       'custom', 100000000, 1, 1,
       1000, 'proof', 'default', 1000,
       1000, '   ', 'proof-calculation', 'proof-vector', '${ID.actor}'
     );
     COMMIT;`,
    /split_reason|check constraint|audit reason/i,
  );
}

function proveBlankPriceOverrideReasonRejected() {
  resetFixture();
  return expectRejected(
    'price overrides require a nonblank audit reason',
    `BEGIN;
     ${lineSql(ID.lineA, 'blank price reason line')}
     INSERT INTO public.invoice_line_shares (
       id, billing_line_id, invoice_item_id, customer_id,
       split_mode, split_micro_pct, allocated_quantity, allocated_acres,
       base_unit_price_cents, base_price_source, price_mode, unit_price_cents,
       amount_cents, price_override_reason, calculation_hash, vector_hash, created_by
     ) VALUES (
       '${ID.shareA}', '${ID.lineA}', '${ID.itemA}', '${ID.customerA}',
       'field_default', 100000000, 1, 1,
       1000, 'proof', 'override', 1100,
       1100, E'\t', 'proof-calculation', 'proof-vector', '${ID.actor}'
     );
     COMMIT;`,
    /price_reason|check constraint|audit reason/i,
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

function proveSendDispositionConstraintIsScopedToInvoices() {
  const constraintCounts = scalar(`
SELECT
  count(*) FILTER (
    WHERE conrelid = 'public.invoices'::regclass
      AND conname = 'invoices_send_disposition_ck'
  )::text || '|' ||
  count(*) FILTER (
    WHERE conrelid = 'public.constraint_name_decoy'::regclass
      AND conname = 'invoices_send_disposition_ck'
  )::text
FROM pg_constraint
WHERE conname = 'invoices_send_disposition_ck';
`);
  return {
    label: 'send-disposition CHECK is installed on invoices despite a same-named decoy',
    passed: constraintCounts === '1|1',
    detail: `invoice constraint|decoy constraint = ${constraintCounts}`,
  };
}

function proveTerminalInvoiceRejectsNewShare() {
  resetFixture();
  runSql(`
UPDATE public.invoices
   SET status = 'cancelled'
 WHERE id = '${ID.draftInvoice}';
`);
  return expectRejected(
    'a terminal invoice cannot receive a new split-billing share',
    `BEGIN;
     ${lineSql(ID.lineA, 'cancelled invoice share line')}
     ${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
     COMMIT;`,
    /frozen|draft|unposted|terminal/i,
  );
}

function proveTerminalSharedInvoiceItemIsFrozen() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'cancelled invoice material line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
UPDATE public.invoices
   SET status = 'cancelled'
 WHERE id = '${ID.draftInvoice}';
`);
  return expectRejected(
    'split invoice-item allocation fields freeze when the invoice becomes terminal',
    `UPDATE public.invoice_items
        SET quantity = 2
      WHERE id = '${ID.itemA}';`,
    /frozen|draft|unposted|terminal/i,
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

function provePostHistorySurvivesUnpostEditRepost() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'append-only repost history line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}

UPDATE public.invoices
   SET status = 'posted', posted_at = '2026-07-18T12:00:00Z'
 WHERE id = '${ID.draftInvoice}';

UPDATE public.invoices
   SET status = 'unposted', posted_at = NULL
 WHERE id = '${ID.draftInvoice}';

UPDATE public.field_app_billing_sets
   SET rounding_policy_version = 2
 WHERE id = '${ID.set}';

UPDATE public.invoice_items
   SET quantity = 0.7500,
       acres = 0.75,
       unit_price_cents = 1200,
       extended_cents = 900
 WHERE id = '${ID.itemA}';
UPDATE public.invoice_line_shares
   SET split_mode = 'custom',
       split_override_reason = 'repost proof adjustment',
       allocated_quantity = 0.7500,
       allocated_acres = 0.7500,
       unit_price_cents = 1200,
       amount_cents = 900,
       calculation_hash = 'proof-calculation-repost',
       vector_hash = 'proof-vector-repost'
 WHERE id = '${ID.shareA}';

UPDATE public.invoices
   SET status = 'posted', posted_at = '2026-07-18T13:00:00Z'
 WHERE id = '${ID.draftInvoice}';

-- A later draft rebuild may remove every working source row. The two historical
-- posts must remain self-contained and queryable.
UPDATE public.invoices
   SET status = 'unposted', posted_at = NULL
 WHERE id = '${ID.draftInvoice}';
DELETE FROM public.invoice_line_shares WHERE id = '${ID.shareA}';
DELETE FROM public.field_app_billing_lines WHERE id = '${ID.lineA}';
DELETE FROM public.invoice_items WHERE id = '${ID.itemA}';
COMMIT;
`);

  const history = scalar(`
    SELECT count(*)::text || '|' ||
           string_agg(post_sequence::text || ':' || amount_cents::text || ':' ||
             calculation_hash || ':v' || rounding_policy_version::text || ':' ||
             to_char(posted_at AT TIME ZONE 'UTC', 'HH24:MI'),
             ',' ORDER BY post_sequence)
      FROM public.invoice_line_share_post_snapshots
     WHERE invoice_id = '${ID.draftInvoice}'
       AND source_share_id = '${ID.shareA}';
  `);
  const mutation = runSql(`
    UPDATE public.invoice_line_share_post_snapshots
       SET amount_cents = 1
     WHERE invoice_id = '${ID.draftInvoice}';
  `, { allowFailure: true });
  const mutationDetail = `${mutation.stdout || ''}${mutation.stderr || ''}`;
  const truncate = runSql(`
    TRUNCATE TABLE public.invoice_line_share_post_snapshots;
  `, { allowFailure: true });
  const truncateDetail = `${truncate.stdout || ''}${truncate.stderr || ''}`;
  const expectedHistory = '2|1:1000:proof-calculation:v1:12:00,2:900:proof-calculation-repost:v2:13:00';
  const passed = history === expectedHistory
    && mutation.status !== 0
    && /append-only|immutable/i.test(mutationDetail)
    && truncate.status !== 0
    && /append-only|immutable/i.test(truncateDetail);
  return {
    label: 'unpost/edit/repost preserves immutable append-only allocation history',
    passed,
    detail: passed
      ? `history = ${history} after working rows were deleted; direct UPDATE/TRUNCATE rejected`
      : `history = ${history}; update = ${mutation.status}; truncate = ${truncate.status}; ${mutationDetail.trim()} ${truncateDetail.trim()}`,
  };
}

function proveSplitInvoiceCannotPostWithoutTimestampAndHistory() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'missing post timestamp line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
`);
  return expectRejected(
    'a split invoice cannot become posted and frozen without a post timestamp/history snapshot',
    `UPDATE public.invoices
        SET status = 'posted', posted_at = NULL
      WHERE id = '${ID.draftInvoice}';`,
    /posted_at|required|snapshot|not null/i,
  );
}

function provePostedSplitInvoiceCanBeVoidedWithoutLosingHistory() {
  resetFixture();
  const result = runSql(`
BEGIN;
${lineSql(ID.lineA, 'posted to voided lifecycle line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
UPDATE public.invoices
   SET status = 'posted', posted_at = '2026-07-18T14:00:00Z'
 WHERE id = '${ID.draftInvoice}';
UPDATE public.invoices
   SET status = 'voided'
 WHERE id = '${ID.draftInvoice}';
COMMIT;
`, { allowFailure: true });
  const detail = `${result.stdout || ''}${result.stderr || ''}`;
  const finalState = result.status === 0
    ? scalar(`
        SELECT status || '|' || (posted_at IS NOT NULL)::text || '|' ||
               (SELECT count(*)::text
                  FROM public.invoice_line_share_post_snapshots
                 WHERE invoice_id = '${ID.draftInvoice}')
          FROM public.invoices
         WHERE id = '${ID.draftInvoice}';
      `)
    : 'transaction rejected';
  return {
    label: 'a posted split invoice can be voided while retaining its one immutable post history',
    passed: result.status === 0 && finalState === 'voided|true|1',
    detail: result.status === 0 ? `status|timestamp|history = ${finalState}` : detail.trim(),
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

  const topology = scalar(`
    SELECT count(DISTINCT invoice_id)::text
      FROM public.invoice_items
     WHERE id IN ('${ID.itemA}', '${ID.itemB}');
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
  const passed = topology === '2' && successCount === 1 && sum === '100000000';
  return {
    label: 'concurrent writers cannot commit two full vectors for one line',
    passed,
    detail: passed
      ? 'two child invoices raced; one writer committed; the other was rejected; final sum = 100000000'
      : `child invoices = ${topology}; successful writers = ${successCount}; final sum = ${sum}`,
  };
}

async function proveShareWriteSerializesWithPost() {
  resetFixture();
  runSql(`
BEGIN;
${lineSql(ID.lineA, 'freeze race line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
COMMIT;
`);

  const writer = startSqlWithMarker(`
BEGIN;
UPDATE public.invoice_line_shares
   SET amount_cents = 999
 WHERE id = '${ID.shareA}';
SELECT 'SHARE_WRITE_CHECKED_DRAFT';
SELECT pg_sleep(2);
COMMIT;
`, 'SHARE_WRITE_CHECKED_DRAFT');

  await writer.ready;
  const poster = startSql(`
SET lock_timeout = '500ms';
UPDATE public.invoices
   SET status = 'posted', posted_at = now()
 WHERE id = '${ID.draftInvoice}';
`);

  const [writeResult, postResult] = await Promise.all([writer.completion, poster]);
  const finalState = scalar(`
SELECT status || '|' || (posted_at IS NOT NULL)::text || '|' ||
       (SELECT amount_cents::text
          FROM public.invoice_line_shares
         WHERE id = '${ID.shareA}')
  FROM public.invoices
 WHERE id = '${ID.draftInvoice}';
`);
  const postDetail = `${postResult.stdout || ''}${postResult.stderr || ''}`;
  const passed = writeResult.code === 0
    && postResult.code !== 0
    && /lock timeout/i.test(postDetail)
    && finalState === 'draft|false|999';
  return {
    label: 'share writes serialize with invoice posting at the freeze boundary',
    passed,
    detail: passed
      ? 'share writer held the invoice row; concurrent post timed out and no post crossed the write'
      : `writer=${writeResult.code} poster=${postResult.code} final=${finalState}`,
  };
}

async function proveShareInsertSerializesWithItemReparent() {
  resetFixture();

  const writer = startSqlWithMarker(`
BEGIN;
${lineSql(ID.lineA, 'parent reparent race line')}
${shareSql({ id: ID.shareA, line: ID.lineA, item: ID.itemA, customer: ID.customerA })}
SELECT 'SHARE_INSERT_LOCKED_ITEM';
SELECT pg_sleep(2);
COMMIT;
`, 'SHARE_INSERT_LOCKED_ITEM');

  await writer.ready;
  const mover = startSql(`
SET lock_timeout = '500ms';
UPDATE public.invoice_items
   SET invoice_id = '${ID.postedInvoice}'
 WHERE id = '${ID.itemA}';
`);

  const [writeResult, moveResult] = await Promise.all([writer.completion, mover]);
  const finalState = scalar(`
SELECT ii.invoice_id::text || '|' || count(s.id)::text
  FROM public.invoice_items ii
  LEFT JOIN public.invoice_line_shares s ON s.invoice_item_id = ii.id
 WHERE ii.id = '${ID.itemA}'
 GROUP BY ii.invoice_id;
`);
  const moveDetail = `${moveResult.stdout || ''}${moveResult.stderr || ''}`;
  const passed = writeResult.code === 0
    && moveResult.code !== 0
    && /lock timeout/i.test(moveDetail)
    && finalState === `${ID.draftInvoice}|1`;
  return {
    label: 'share insertion serializes with invoice-item parent reparenting',
    passed,
    detail: passed
      ? 'share insert held the item row; concurrent reparent timed out and the snapshot stayed draft-linked'
      : `writer=${writeResult.code} mover=${moveResult.code} final=${finalState}`,
  };
}

async function main() {
  prepareContainer();
  installSchema();

  const results = [
    proveTriggerSecurityContext(),
    proveNewForeignKeysAreIndexed(),
    proveMovedSourceLine(),
    provePostedReparent(),
    provePostedParentCascade(),
    proveSharedPostedItemCannotMoveToDraft(),
    proveSharedPostedItemMaterialFieldsAreFrozen(),
    proveSharedDraftItemMaterialFieldsRemainEditable(),
    proveDraftItemCanMoveWithShareRebuild(),
    proveClientCannotTruncate(),
    proveOneBillingSetPerInvoiceGroup(),
    proveApplicatorCannotReadBillingSources(),
    proveSalesRepBillingSourceReadsAreOwnerScoped(),
    proveSalesRepShareAndHistoryReadsRequireActiveRole(),
    proveBlankSplitOverrideReasonRejected(),
    proveBlankPriceOverrideReasonRejected(),
    proveClientCannotSetSendDisposition(),
    proveSendDispositionConstraintIsScopedToInvoices(),
    proveSuppressionRequiresZeroTotal(),
    proveServerCanSuppressZeroTotal(),
    proveTerminalInvoiceRejectsNewShare(),
    proveTerminalSharedInvoiceItemIsFrozen(),
    proveSplitInvoiceCannotPostWithoutTimestampAndHistory(),
    provePostedSplitInvoiceCanBeVoidedWithoutLosingHistory(),
    provePostHistorySurvivesUnpostEditRepost(),
    proveEmptyLine(),
    await proveConcurrentVectors(),
    await proveShareWriteSerializesWithPost(),
    await proveShareInsertSerializesWithItemReparent(),
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
    const cleanup = dockerSync(['rm', '--force', CONTAINER], { allowFailure: true });
    if (cleanup.status !== 0) {
      fail(
        `docker cleanup failed with exit ${cleanup.status}`,
        `${cleanup.stdout || ''}${cleanup.stderr || ''}`.trim(),
      );
    }
  } catch (cleanupError) {
    exitCode = 1;
    process.stderr.write(`cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
  }
}
process.exitCode = exitCode;
