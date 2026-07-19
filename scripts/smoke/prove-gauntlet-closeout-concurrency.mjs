#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 two-session proof for the final gauntlet
 * closeout races:
 *   1. OIFA writer vs canonical split creator, in both winning orders.
 *   2. cancel_order's order->quote locks vs revert_quote_status's
 *      quote->order NOWAIT retry, in both winning orders.
 *
 * This script never connects to Supabase. It builds only the lock-bearing
 * relational slice in a disposable --network none Docker container, asserts
 * the checked-in migration still carries the exact reviewed markers, and
 * removes the container in finally.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-gauntlet-closeout-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const PASSWORD = 'gauntlet-closeout-disposable-only';
const SPLIT_MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260719044912_trust_only_post_revoke_split_provenance.sql',
);
const REVERT_MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260719044958_revert_quote_status_deadlock_retry.sql',
);

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
  return runSql(sql).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
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
        readyReject(new Error(`SQL exited before marker ${marker}: ${stderr || stdout}`));
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { ready, completion };
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
      // The official image briefly exposes its bootstrap server before the
      // final server restart. Wait through that handoff and require readiness
      // a second time so schema install never races the socket gap.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
      const stable = dockerSync(
        ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
        { allowFailure: true },
      );
      if (stable.status === 0) return;
    }
  }
  fail('disposable PostgreSQL container did not become ready within 30 seconds');
}

function assertMigrationMarkers() {
  const split = readFileSync(SPLIT_MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const revert = readFileSync(REVERT_MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  assert.match(split, /FROM public\.order_items oi\n\s+WHERE oi\.order_id = p_order_id\n\s+ORDER BY oi\.id\n\s+FOR UPDATE;/);
  assert.match(split, /split_invoice_creation_claims/);
  assert.match(split, /split_invoice_provenance/);
  assert.match(revert, /ORDER BY id\n\s+FOR UPDATE NOWAIT;/);
  assert.match(revert, /EXCEPTION WHEN lock_not_available/);
  assert.match(revert, /USING ERRCODE = '40001'/);
}

function installSchema() {
  runSql(`
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.quotes (
  id uuid PRIMARY KEY,
  status text NOT NULL
);
CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  quote_id uuid REFERENCES public.quotes(id),
  status text NOT NULL DEFAULT 'confirmed'
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id)
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL,
  order_id uuid REFERENCES public.orders(id),
  invoice_group_id uuid,
  status text NOT NULL DEFAULT 'draft',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.order_item_field_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES public.order_items(id)
);

CREATE OR REPLACE FUNCTION public.prevent_oifa_edit_after_post()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $proof$
DECLARE
  v_old_item_id uuid;
  v_new_item_id uuid;
  v_order_ids uuid[];
  v_blocking_inv text;
BEGIN
  IF TG_OP = 'INSERT' THEN v_new_item_id := NEW.order_item_id;
  ELSIF TG_OP = 'DELETE' THEN v_old_item_id := OLD.order_item_id;
  ELSE v_old_item_id := OLD.order_item_id; v_new_item_id := NEW.order_item_id;
  END IF;

  PERFORM 1
    FROM public.order_items oi
   WHERE oi.id = ANY(array_remove(ARRAY[v_old_item_id, v_new_item_id]::uuid[], NULL))
   ORDER BY oi.id
   FOR KEY SHARE;

  SELECT array_agg(DISTINCT oi.order_id ORDER BY oi.order_id)
    INTO v_order_ids
    FROM public.order_items oi
   WHERE oi.id = ANY(array_remove(ARRAY[v_old_item_id, v_new_item_id]::uuid[], NULL));

  SELECT i.invoice_number INTO v_blocking_inv
    FROM public.invoices i
   WHERE i.order_id = ANY(v_order_ids)
     AND i.deleted_at IS NULL
     AND i.status NOT IN ('voided', 'cancelled')
   ORDER BY i.created_at, i.id LIMIT 1;
  IF v_blocking_inv IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_ALLOCATION_INVOICE_CONFLICT: %', v_blocking_inv
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$proof$;

CREATE TRIGGER prevent_oifa_edit_after_post
BEFORE INSERT OR UPDATE OR DELETE ON public.order_item_field_allocations
FOR EACH ROW EXECUTE FUNCTION public.prevent_oifa_edit_after_post();

CREATE OR REPLACE FUNCTION public.proof_create_split(p_order_id uuid, p_pause boolean)
RETURNS text LANGUAGE plpgsql SET search_path = public, pg_temp
AS $proof$
DECLARE v_kind text;
BEGIN
  PERFORM 1 FROM public.orders WHERE id=p_order_id FOR UPDATE;
  PERFORM 1 FROM public.order_items oi
   WHERE oi.order_id=p_order_id ORDER BY oi.id FOR UPDATE;
  IF p_pause THEN PERFORM pg_sleep(1); END IF;
  IF EXISTS (
    SELECT 1 FROM public.order_item_field_allocations oifa
    JOIN public.order_items oi ON oi.id=oifa.order_item_id
    WHERE oi.order_id=p_order_id
  ) THEN
    v_kind := 'split';
    INSERT INTO public.invoices(invoice_number,order_id,invoice_group_id)
    VALUES ('SPLIT',p_order_id,gen_random_uuid());
  ELSE
    v_kind := 'mono';
    INSERT INTO public.invoices(invoice_number,order_id)
    VALUES ('MONO',p_order_id);
  END IF;
  RETURN v_kind;
END;
$proof$;

CREATE OR REPLACE FUNCTION public.proof_revert(p_quote_id uuid, p_pause boolean)
RETURNS text LANGUAGE plpgsql SET search_path = public, pg_temp
AS $proof$
BEGIN
  PERFORM 1 FROM public.quotes WHERE id=p_quote_id FOR UPDATE;
  IF p_pause THEN PERFORM pg_sleep(1); END IF;
  BEGIN
    PERFORM 1 FROM public.orders WHERE quote_id=p_quote_id ORDER BY id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'QUOTE_REOPEN_CONCURRENT_ORDER_CHANGE_RETRY'
      USING ERRCODE='40001';
  END;
  RETURN 'reverted';
END;
$proof$;

INSERT INTO public.quotes(id,status)
VALUES ('10000000-0000-4000-8000-000000000001','accepted');
INSERT INTO public.orders(id,quote_id)
VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
INSERT INTO public.order_items(id,order_id)
VALUES ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');
`);
}

function resetSplit() {
  runSql(`
DELETE FROM public.invoices;
DELETE FROM public.order_item_field_allocations;
`);
}

async function proveSplitInterleavings() {
  const orderId = '20000000-0000-4000-8000-000000000001';
  const itemId = '30000000-0000-4000-8000-000000000001';

  resetSplit();
  const writerFirst = startSqlWithMarker(`
BEGIN;
INSERT INTO public.order_item_field_allocations(order_item_id) VALUES ('${itemId}');
SELECT 'OIFA_LOCKED';
SELECT pg_sleep(1);
COMMIT;
`, 'OIFA_LOCKED');
  await writerFirst.ready;
  const creatorSecond = startSql(`SELECT public.proof_create_split('${orderId}',false);`);
  const [writerResult, creatorResult] = await Promise.all([
    writerFirst.completion,
    creatorSecond,
  ]);
  assert.equal(writerResult.code, 0, writerResult.stderr || writerResult.stdout);
  assert.equal(creatorResult.code, 0, creatorResult.stderr || creatorResult.stdout);
  assert.match(creatorResult.stdout, /split/);
  assert.equal(scalar('SELECT count(*) FROM public.order_item_field_allocations;'), '1');
  assert.equal(scalar("SELECT count(*) FROM public.invoices WHERE invoice_group_id IS NOT NULL;"), '1');

  resetSplit();
  const creatorFirst = startSql(`SELECT public.proof_create_split('${orderId}',true);`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const writerSecond = startSql(`
INSERT INTO public.order_item_field_allocations(order_item_id) VALUES ('${itemId}');
`);
  const [creatorFirstResult, writerSecondResult] = await Promise.all([
    creatorFirst,
    writerSecond,
  ]);
  assert.equal(creatorFirstResult.code, 0, creatorFirstResult.stderr || creatorFirstResult.stdout);
  assert.match(creatorFirstResult.stdout, /mono/);
  assert.notEqual(writerSecondResult.code, 0, 'OIFA writer unexpectedly committed after creator won');
  assert.match(
    `${writerSecondResult.stdout}\n${writerSecondResult.stderr}`,
    /ORDER_ALLOCATION_INVOICE_CONFLICT/,
  );
  assert.equal(scalar('SELECT count(*) FROM public.order_item_field_allocations;'), '0');
  assert.equal(scalar("SELECT count(*) FROM public.invoices WHERE invoice_group_id IS NULL;"), '1');

  return {
    oifa_first: 'creator waited, observed OIFA, and created split invoice',
    creator_first: 'writer waited, observed mono draft, and failed closed',
  };
}

async function proveQuoteInterleavings() {
  const quoteId = '10000000-0000-4000-8000-000000000001';
  const orderId = '20000000-0000-4000-8000-000000000001';

  const cancelFirst = startSqlWithMarker(`
BEGIN;
SELECT 1 FROM public.orders WHERE id='${orderId}' FOR UPDATE;
SELECT 'CANCEL_ORDER_LOCKED';
SELECT pg_sleep(1);
SELECT 1 FROM public.quotes WHERE id='${quoteId}' FOR UPDATE;
COMMIT;
`, 'CANCEL_ORDER_LOCKED');
  await cancelFirst.ready;
  const revertSecond = startSql(`SELECT public.proof_revert('${quoteId}',false);`);
  const [cancelFirstResult, revertSecondResult] = await Promise.all([
    cancelFirst.completion,
    revertSecond,
  ]);
  assert.equal(cancelFirstResult.code, 0, cancelFirstResult.stderr || cancelFirstResult.stdout);
  assert.notEqual(revertSecondResult.code, 0, 'revert unexpectedly waited into AB/BA cycle');
  assert.match(
    `${revertSecondResult.stdout}\n${revertSecondResult.stderr}`,
    /QUOTE_REOPEN_CONCURRENT_ORDER_CHANGE_RETRY/,
  );

  const revertFirst = startSql(`SELECT public.proof_revert('${quoteId}',true);`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelSecond = startSql(`
BEGIN;
SELECT 1 FROM public.orders WHERE id='${orderId}' FOR UPDATE;
SELECT 1 FROM public.quotes WHERE id='${quoteId}' FOR UPDATE;
COMMIT;
`);
  const [revertFirstResult, cancelSecondResult] = await Promise.all([
    revertFirst,
    cancelSecond,
  ]);
  assert.notEqual(revertFirstResult.code, 0, 'revert-first unexpectedly waited into AB/BA cycle');
  assert.match(
    `${revertFirstResult.stdout}\n${revertFirstResult.stderr}`,
    /QUOTE_REOPEN_CONCURRENT_ORDER_CHANGE_RETRY/,
  );
  assert.equal(cancelSecondResult.code, 0, cancelSecondResult.stderr || cancelSecondResult.stdout);

  return {
    cancel_first: 'revert failed retryably; cancel completed',
    revert_first: 'NOWAIT broke the cycle; cancel completed after quote release',
  };
}

async function main() {
  try {
    assertMigrationMarkers();
    console.log(`[proof] creating network-isolated disposable container ${CONTAINER}`);
    prepareContainer();
    installSchema();
    const split = await proveSplitInterleavings();
    const quote = await proveQuoteInterleavings();
    console.log(JSON.stringify({ container: CONTAINER, split, quote }, null, 2));
    console.log('PASS: gauntlet closeout OIFA/split and cancel/revert two-session proof');
  } finally {
    assertSafeContainerName();
    const removed = dockerSync(['rm', '--force', CONTAINER], { allowFailure: true });
    const absent = /No such container/i.test(`${removed.stdout}\n${removed.stderr}`);
    if (removed.status !== 0 && !absent) {
      console.error(`WARNING: failed to remove disposable container ${CONTAINER}`);
      process.exitCode = 1;
    } else if (removed.status === 0) {
      console.log(`[proof] removed disposable container ${CONTAINER}`);
    }
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
