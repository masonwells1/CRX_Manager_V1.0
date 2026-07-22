#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 two-session proof for the Section 9
 * create_vendor_bill vs cancel_purchase_order race, in both winning orders,
 * plus same-product lost-update and opposite-product-order deadlock probes.
 *
 * The disposable functions contain only the reviewed lock/status/bill slice;
 * marker assertions bind that slice to the checked-in full migration bodies.
 * The container has no network, uses tmpfs, and is removed in finally.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-section9-po-ap-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const PASSWORD = 'section9-disposable-only';
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260722191804_section9_po_ap_high_remediation.sql',
);
const CANCEL_MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260716120104_gauntlet_access_boundaries.sql',
);

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function dockerSync(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
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
  return runSql(sql).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
}

function startSqlWithMarker(sql, marker) {
  const child = spawn('docker', psqlArgs(), {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      readyReject(new Error(`timed out waiting for marker ${marker}`));
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
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { ready, completion };
}

function prepareContainer() {
  if (!CONTAINER.startsWith(PREFIX) || !/^[a-z0-9][a-z0-9_.-]+$/.test(CONTAINER)) {
    fail(`refusing unsafe container name: ${CONTAINER}`);
  }
  if (dockerSync(['container', 'inspect', CONTAINER], { allowFailure: true }).status === 0) {
    fail(`refusing to reuse existing container ${CONTAINER}`);
  }
  dockerSync([
    'run', '--detach', '--name', CONTAINER,
    '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      if (dockerSync(
        ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
        { allowFailure: true },
      ).status === 0) return;
    }
  }
  fail('disposable PostgreSQL container did not become ready');
}

function assertCheckedInMarkers() {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const cancel = readFileSync(CANCEL_MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  assert.match(
    migration,
    /FROM public\.purchase_orders\n\s+WHERE id = p_purchase_order_id\n\s+FOR UPDATE;/,
  );
  assert.match(migration, /v_po_status NOT IN \(\n\s+'submitted',\n\s+'partially_received',\n\s+'fully_received'/);
  assert.match(migration, /INSERT INTO public\.vendor_bills/);
  assert.match(migration, /pg_advisory_xact_lock\(73492009\)/);
  assert.match(migration, /clock_timestamp\(\) AT TIME ZONE 'America\/Chicago'/);
  assert.match(
    cancel,
    /FROM purchase_orders WHERE id = p_po_id FOR UPDATE;/,
  );
  assert.match(
    cancel,
    /FROM vendor_bills\n\s+WHERE purchase_order_id = p_po_id/,
  );
}

function installSchema() {
  runSql(`
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY,
  status text NOT NULL
);
CREATE TABLE public.vendor_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  status text NOT NULL DEFAULT 'unpaid',
  deleted_at timestamptz
);

CREATE OR REPLACE FUNCTION public.proof_create_vendor_bill(
  p_po_id uuid,
  p_pause_seconds numeric DEFAULT 0
)
RETURNS uuid LANGUAGE plpgsql AS $proof$
DECLARE
  v_status text;
  v_bill uuid;
BEGIN
  SELECT status INTO v_status
  FROM public.purchase_orders
  WHERE id = p_po_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND'; END IF;
  IF v_status NOT IN ('submitted', 'partially_received', 'fully_received') THEN
    RAISE EXCEPTION 'PO_NOT_BILLABLE: %', v_status;
  END IF;
  PERFORM pg_sleep(p_pause_seconds);
  INSERT INTO public.vendor_bills (purchase_order_id)
  VALUES (p_po_id) RETURNING id INTO v_bill;
  RETURN v_bill;
END;
$proof$;

CREATE OR REPLACE FUNCTION public.proof_cancel_purchase_order(
  p_po_id uuid,
  p_pause_seconds numeric DEFAULT 0
)
RETURNS void LANGUAGE plpgsql AS $proof$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
  FROM public.purchase_orders
  WHERE id = p_po_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND'; END IF;
  PERFORM pg_sleep(p_pause_seconds);
  IF EXISTS (
    SELECT 1 FROM public.vendor_bills
    WHERE purchase_order_id = p_po_id
      AND status <> 'voided'
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PO_HAS_ACTIVE_BILLS';
  END IF;
  UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = p_po_id;
END;
$proof$;

CREATE TABLE public.proof_po_items (
  id integer PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  product_id integer NOT NULL,
  quantity_ordered numeric NOT NULL
);
CREATE TABLE public.proof_on_order (
  product_id integer PRIMARY KEY,
  quantity_on_order numeric NOT NULL
);

CREATE OR REPLACE FUNCTION public.proof_recompute_on_order(p_product_ids integer[])
RETURNS void LANGUAGE plpgsql AS $proof$
DECLARE
  v_product_id integer;
  v_expected numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  FOR v_product_id IN
    SELECT DISTINCT product_id FROM unnest(p_product_ids) product_id ORDER BY product_id
  LOOP
    SELECT COALESCE(SUM(i.quantity_ordered), 0)
    INTO v_expected
    FROM public.proof_po_items i
    JOIN public.purchase_orders po ON po.id = i.purchase_order_id
    WHERE i.product_id = v_product_id AND po.status = 'submitted';
    UPDATE public.proof_on_order
    SET quantity_on_order = v_expected
    WHERE product_id = v_product_id;
  END LOOP;
END;
$proof$;

CREATE OR REPLACE FUNCTION public.proof_recompute_item_trigger()
RETURNS trigger LANGUAGE plpgsql AS $proof$
BEGIN
  PERFORM public.proof_recompute_on_order(ARRAY[OLD.product_id, NEW.product_id]);
  RETURN NEW;
END;
$proof$;
CREATE TRIGGER proof_recompute_item
AFTER UPDATE OF quantity_ordered ON public.proof_po_items
FOR EACH ROW EXECUTE FUNCTION public.proof_recompute_item_trigger();

CREATE OR REPLACE FUNCTION public.proof_recompute_status_trigger()
RETURNS trigger LANGUAGE plpgsql AS $proof$
DECLARE v_ids integer[];
BEGIN
  SELECT ARRAY_AGG(DISTINCT product_id ORDER BY product_id) INTO v_ids
  FROM public.proof_po_items WHERE purchase_order_id = NEW.id;
  PERFORM public.proof_recompute_on_order(v_ids);
  RETURN NEW;
END;
$proof$;
CREATE TRIGGER proof_recompute_status
AFTER UPDATE OF status ON public.purchase_orders
FOR EACH ROW EXECUTE FUNCTION public.proof_recompute_status_trigger();
`);
}

async function proveCreateWins() {
  const po = '00000000-0000-0000-0000-000000000901';
  runSql(`INSERT INTO purchase_orders VALUES ('${po}', 'submitted');`);
  const creator = startSqlWithMarker(`
BEGIN;
SELECT status FROM purchase_orders WHERE id='${po}' FOR UPDATE;
SELECT 'CREATE_LOCKED';
SELECT pg_sleep(2);
INSERT INTO vendor_bills (purchase_order_id) VALUES ('${po}');
COMMIT;
`, 'CREATE_LOCKED');
  await creator.ready;
  const canceller = startSqlWithMarker(`
SELECT 'CANCEL_STARTED';
SELECT proof_cancel_purchase_order('${po}', 0);
`, 'CANCEL_STARTED');
  const [createResult, cancelResult] = await Promise.all([
    creator.completion,
    canceller.completion,
  ]);
  assert.equal(createResult.code, 0, createResult.stderr);
  assert.notEqual(cancelResult.code, 0, 'cancel unexpectedly beat committed bill');
  assert.match(cancelResult.stderr, /PO_HAS_ACTIVE_BILLS/);
  assert.equal(scalar(`SELECT status FROM purchase_orders WHERE id='${po}';`), 'submitted');
  assert.equal(scalar(`SELECT count(*) FROM vendor_bills WHERE purchase_order_id='${po}';`), '1');
}

async function proveCancelWins() {
  const po = '00000000-0000-0000-0000-000000000902';
  runSql(`INSERT INTO purchase_orders VALUES ('${po}', 'submitted');`);
  const canceller = startSqlWithMarker(`
BEGIN;
SELECT status FROM purchase_orders WHERE id='${po}' FOR UPDATE;
SELECT 'CANCEL_LOCKED';
SELECT pg_sleep(2);
UPDATE purchase_orders SET status='cancelled' WHERE id='${po}';
COMMIT;
`, 'CANCEL_LOCKED');
  await canceller.ready;
  const creator = startSqlWithMarker(`
SELECT 'CREATE_STARTED';
SELECT proof_create_vendor_bill('${po}', 0);
`, 'CREATE_STARTED');
  const [cancelResult, createResult] = await Promise.all([
    canceller.completion,
    creator.completion,
  ]);
  assert.equal(cancelResult.code, 0, cancelResult.stderr);
  assert.notEqual(createResult.code, 0, 'bill unexpectedly attached after cancel');
  assert.match(createResult.stderr, /PO_NOT_BILLABLE: cancelled/);
  assert.equal(scalar(`SELECT status FROM purchase_orders WHERE id='${po}';`), 'cancelled');
  assert.equal(scalar(`SELECT count(*) FROM vendor_bills WHERE purchase_order_id='${po}';`), '0');
}

async function proveSameProductDoesNotLoseUpdate() {
  const po1 = '00000000-0000-0000-0000-000000000911';
  const po2 = '00000000-0000-0000-0000-000000000912';
  runSql(`
INSERT INTO purchase_orders VALUES ('${po1}', 'draft'), ('${po2}', 'draft');
INSERT INTO proof_po_items VALUES (911, '${po1}', 1, 10), (912, '${po2}', 1, 20);
INSERT INTO proof_on_order VALUES (1, 0);
`);
  const blocker = startSqlWithMarker(`
BEGIN;
SELECT pg_advisory_xact_lock(73492009);
SELECT 'RECOMPUTE_BLOCKED';
SELECT pg_sleep(2);
COMMIT;
`, 'RECOMPUTE_BLOCKED');
  await blocker.ready;
  const first = startSqlWithMarker(`
SELECT 'FIRST_STARTED';
UPDATE purchase_orders SET status='submitted' WHERE id='${po1}';
`, 'FIRST_STARTED');
  const second = startSqlWithMarker(`
SELECT 'SECOND_STARTED';
UPDATE purchase_orders SET status='submitted' WHERE id='${po2}';
`, 'SECOND_STARTED');
  const results = await Promise.all([
    blocker.completion,
    first.completion,
    second.completion,
  ]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(scalar('SELECT quantity_on_order FROM proof_on_order WHERE product_id=1;'), '30');
}

async function proveOppositeProductOrderDoesNotDeadlock() {
  const po1 = '00000000-0000-0000-0000-000000000921';
  const po2 = '00000000-0000-0000-0000-000000000922';
  runSql(`
INSERT INTO purchase_orders VALUES ('${po1}', 'submitted'), ('${po2}', 'submitted');
INSERT INTO proof_po_items VALUES
  (9211, '${po1}', 21, 10), (9212, '${po1}', 22, 10),
  (9221, '${po2}', 21, 10), (9222, '${po2}', 22, 10);
INSERT INTO proof_on_order VALUES (21, 20), (22, 20);
`);
  const first = startSqlWithMarker(`
BEGIN;
UPDATE proof_po_items SET quantity_ordered=11 WHERE id=9211;
SELECT 'FIRST_PRODUCT_LOCKED';
SELECT pg_sleep(2);
UPDATE proof_po_items SET quantity_ordered=11 WHERE id=9212;
COMMIT;
`, 'FIRST_PRODUCT_LOCKED');
  await first.ready;
  const second = startSqlWithMarker(`
SELECT 'SECOND_OPPOSITE_STARTED';
BEGIN;
UPDATE proof_po_items SET quantity_ordered=11 WHERE id=9222;
UPDATE proof_po_items SET quantity_ordered=11 WHERE id=9221;
COMMIT;
`, 'SECOND_OPPOSITE_STARTED');
  const results = await Promise.all([first.completion, second.completion]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(scalar('SELECT quantity_on_order FROM proof_on_order WHERE product_id=21;'), '22');
  assert.equal(scalar('SELECT quantity_on_order FROM proof_on_order WHERE product_id=22;'), '22');
}

try {
  assertCheckedInMarkers();
  prepareContainer();
  installSchema();
  await proveCreateWins();
  await proveCancelWins();
  await proveSameProductDoesNotLoseUpdate();
  await proveOppositeProductOrderDoesNotDeadlock();
  console.log('SECTION9_PO_AP_CONCURRENCY_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    dockerSync(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
