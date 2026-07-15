#!/usr/bin/env node
/**
 * Disposable two-session proof for gauntlet idempotency serialization and
 * blend-ticket/link product lock ordering.
 *
 * Safety properties:
 * - creates a uniquely named Docker container with the crx-gauntlet-idem-proof-
 *   prefix;
 * - uses --network none and a tmpfs data directory, so it cannot connect to a
 *   linked/live Supabase database and leaves no database volume behind;
 * - loads the check_idempotency + inline-trigger section verbatim from the
 *   checked-in migration; and
 * - removes the container in finally on both PASS and FAIL.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-gauntlet-idem-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const PASSWORD = 'gauntlet-disposable-only';
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260714230000_gauntlet_core_guards.sql',
);
const BLEND_MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260714230100_blend_ticket_access_and_atomicity.sql',
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
  const readyTimeout = setTimeout(() => {
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
      clearTimeout(readyTimeout);
      readyResolve();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(readyTimeout);
      if (!readySettled) readyReject(error);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(readyTimeout);
      if (!readySettled) {
        readySettled = true;
        readyReject(new Error(`SQL process exited before marker ${marker}: ${stderr || stdout}`));
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { ready, completion };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function scalar(sql) {
  const output = runSql(sql).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (output === undefined) fail('scalar query returned no value', sql);
  return output;
}

function migrationIdempotencySection() {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.check_idempotency');
  const end = sql.indexOf('CREATE OR REPLACE FUNCTION public.receive_po_items');
  if (start < 0 || end <= start) fail('could not isolate idempotency migration section');
  const section = sql.slice(start, end);
  for (const marker of [
    "hashtextextended('crx:idempotency:' || p_key, 0)",
    'CREATE TRIGGER guard_idempotency_key_insert',
    'IDEMPOTENCY_CONCURRENT_REPLAY_RETRY',
  ]) {
    if (!section.includes(marker)) fail(`migration section lost marker: ${marker}`);
  }
  return section;
}

function migrationBlendLockSection() {
  const sql = readFileSync(BLEND_MIGRATION, 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.enforce_linked_blend_ticket_header_lock');
  const end = sql.indexOf('-- Storage must enforce', start);
  if (start < 0 || end <= start) fail('could not isolate blend-ticket lock migration section');
  const section = sql.slice(start, end);
  for (const marker of [
    'CREATE TRIGGER trg_linked_blend_ticket_header_lock',
    'CREATE TRIGGER trg_linked_blend_ticket_product_lock',
    'ARRAY[OLD.blend_ticket_id, NEW.blend_ticket_id]',
    'ORDER BY id',
    'FOR UPDATE;',
    'BLEND_TICKET_LINKED_CONTENT_LOCKED',
  ]) {
    if (!section.includes(marker)) fail(`blend lock migration section lost marker: ${marker}`);
  }
  return section;
}

function migrationOcrCommitSection() {
  const sql = readFileSync(BLEND_MIGRATION, 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.commit_blend_ticket_ocr_result');
  const end = sql.indexOf('REVOKE EXECUTE ON FUNCTION public.commit_blend_ticket_ocr_result', start);
  if (start < 0 || end <= start) fail('could not isolate OCR commit migration section');
  const section = sql.slice(start, end);
  for (const marker of [
    'OCR_COMMIT_LEASE_LOST',
    'OCR_COMMIT_LIFECYCLE_CHANGED',
    'deleted_at IS NULL',
    'FOR UPDATE;',
  ]) {
    if (!section.includes(marker)) fail(`OCR commit migration section lost marker: ${marker}`);
  }
  return section;
}

function prepareContainer() {
  assertSafeContainerName();
  const existing = dockerSync(
    ['container', 'inspect', CONTAINER],
    { allowFailure: true },
  );
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
      // The official image briefly starts a temporary server while initializing,
      // then stops it before the final server starts. Wait through that socket
      // gap and require readiness again so setup never races the restart.
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

function installProofSchema() {
  const migrationSection = migrationIdempotencySection();
  const blendLockSection = migrationBlendLockSection();
  const ocrCommitSection = migrationOcrCommitSection();
  runSql(`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.idempotency_keys (
  idempotency_key text PRIMARY KEY,
  operation text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE TABLE public.gauntlet_business_effects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proof_path text NOT NULL,
  effect_label text NOT NULL
);

CREATE TABLE public.blend_tickets (
  id uuid PRIMARY KEY,
  order_link_status text NOT NULL DEFAULT 'unlinked',
  status text NOT NULL DEFAULT 'completed',
  review_status text NOT NULL DEFAULT 'approved',
  payment_status text NOT NULL DEFAULT 'unbilled',
  deleted_at timestamptz,
  customer_id uuid,
  season integer,
  salesman_id uuid,
  ticket_date date,
  ticket_time text,
  job_id uuid,
  field_id uuid,
  field_names text,
  applicator_id uuid,
  applicator_name text,
  vehicle_id uuid,
  vehicle_info text,
  application_service_id uuid,
  total_acres numeric,
  application_rate text,
  total_volume numeric,
  total_volume_unit text,
  notes text
  ,raw_ocr_text text
  ,ocr_confidence_score numeric
  ,signature_detected boolean DEFAULT false
  ,driver_name text
  ,tank_number text
  ,mixer_name text
  ,invoice_number text
  ,job_number text
  ,updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.blend_ticket_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid NOT NULL REFERENCES public.blend_tickets(id),
  product_id uuid,
  product_name text NOT NULL DEFAULT '',
  quantity numeric NOT NULL,
  unit text,
  lot_number text,
  sequence_order integer,
  confidence_score numeric,
  manually_corrected boolean DEFAULT false
);

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY,
  blend_ticket_id uuid,
  status text,
  deleted_at timestamptz
);

CREATE TABLE public.application_records (
  id uuid PRIMARY KEY,
  source_type text,
  source_id uuid
);

CREATE TABLE public.ocr_processing_queue (
  id uuid PRIMARY KEY,
  blend_ticket_id uuid,
  status text,
  lease_token uuid,
  lease_heartbeat_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.blend_ticket_to_order_items (
  id uuid PRIMARY KEY,
  blend_ticket_id uuid NOT NULL
);

CREATE TABLE public.blend_ticket_fields (
  id uuid PRIMARY KEY,
  blend_ticket_id uuid NOT NULL
);

${migrationSection}

CREATE OR REPLACE FUNCTION public.save_idempotency(
  p_key text, p_operation text, p_result jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $proof$
BEGIN
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result);
END;
$proof$;

${blendLockSection}

${ocrCommitSection}

CREATE OR REPLACE FUNCTION public.gauntlet_helper_writer(
  p_key text,
  p_label text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $proof$
DECLARE
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_existing := public.check_idempotency(p_key, 'gauntlet_helper_writer');
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  INSERT INTO public.gauntlet_business_effects(proof_path, effect_label)
  VALUES ('helper', p_label);
  PERFORM pg_sleep(1);
  v_result := jsonb_build_object('winner', p_label);
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_key, 'gauntlet_helper_writer', v_result);
  RETURN v_result;
END;
$proof$;

CREATE OR REPLACE FUNCTION public.gauntlet_legacy_inline_writer(
  p_key text,
  p_label text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $proof$
DECLARE
  v_result jsonb := jsonb_build_object('winner', p_label);
BEGIN
  -- This intentionally models the old pattern: business work happens first,
  -- then the inline ledger INSERT uses ON CONFLICT DO NOTHING.
  INSERT INTO public.gauntlet_business_effects(proof_path, effect_label)
  VALUES ('legacy', p_label);
  PERFORM pg_sleep(1);
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_key, 'gauntlet_legacy_inline_writer', v_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN v_result;
END;
$proof$;
`);
}

async function proveHelperRace() {
  const key = 'helper-race-key';
  const first = startSql(`SELECT public.gauntlet_helper_writer('${key}', 'A')::text;`);
  await delay(30);
  const second = startSql(`SELECT public.gauntlet_helper_writer('${key}', 'B')::text;`);
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.equal(result.code, 0, `helper caller failed: ${result.stderr || result.stdout}`);
  }
  const returned = results.map((result) => result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(returned[0], returned[1], 'serialized helper callers did not replay the exact winner result');
  assert.equal(Number(scalar("SELECT count(*) FROM public.gauntlet_business_effects WHERE proof_path='helper';")), 1);
  assert.equal(Number(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='${key}';`)), 1);
  return { returned: returned[0], effects: 1, ledger_rows: 1 };
}

async function proveLegacyRace() {
  const key = 'legacy-race-key';
  const first = startSql(`SELECT public.gauntlet_legacy_inline_writer('${key}', 'A')::text;`);
  const second = startSql(`SELECT public.gauntlet_legacy_inline_writer('${key}', 'B')::text;`);
  const results = await Promise.all([first, second]);
  const successes = results.filter((result) => result.code === 0);
  const failures = results.filter((result) => result.code !== 0);
  assert.equal(successes.length, 1, `legacy race expected one winner: ${JSON.stringify(results)}`);
  assert.equal(failures.length, 1, `legacy race expected one loser: ${JSON.stringify(results)}`);
  assert.match(
    `${failures[0].stdout}\n${failures[0].stderr}`,
    /IDEMPOTENCY_CONCURRENT_REPLAY_RETRY/,
    'legacy loser did not receive the trigger retry error',
  );
  assert.equal(Number(scalar("SELECT count(*) FROM public.gauntlet_business_effects WHERE proof_path='legacy';")), 1);
  assert.equal(Number(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='${key}';`)), 1);
  return { winner: successes[0].stdout.trim(), loser_error: 'IDEMPOTENCY_CONCURRENT_REPLAY_RETRY', effects: 1, ledger_rows: 1 };
}

const TICKET_ID = '10000000-0000-4000-8000-000000000001';
const TICKET_ID_2 = '10000000-0000-4000-8000-000000000002';
const PRODUCT_ID = '20000000-0000-4000-8000-000000000001';

function resetBlendFixture() {
  runSql(`
DELETE FROM public.blend_ticket_to_order_items;
UPDATE public.blend_tickets SET order_link_status = 'unlinked';
DELETE FROM public.blend_ticket_products;
DELETE FROM public.blend_tickets;
INSERT INTO public.blend_tickets (
  id, order_link_status, customer_id, season, salesman_id, total_acres
) VALUES
(
  '${TICKET_ID}', 'unlinked',
  '30000000-0000-4000-8000-000000000001', 2026,
  '40000000-0000-4000-8000-000000000001', 1
),
(
  '${TICKET_ID_2}', 'unlinked',
  '30000000-0000-4000-8000-000000000001', 2026,
  '40000000-0000-4000-8000-000000000001', 1
);
INSERT INTO public.blend_ticket_products (id, blend_ticket_id, quantity)
VALUES ('${PRODUCT_ID}', '${TICKET_ID}', 1);
INSERT INTO public.blend_ticket_to_order_items (id, blend_ticket_id) VALUES
  ('50000000-0000-4000-8000-000000000001', '${TICKET_ID}'),
  ('50000000-0000-4000-8000-000000000002', '${TICKET_ID_2}');
`);
}

async function proveBlendLockOrdering() {
  resetBlendFixture();

  // Link commits first while holding the parent row. The product trigger must
  // wait, re-read linked, and reject rather than mutate stale unlinked content.
  const linkFirst = startSqlWithMarker(`
BEGIN;
UPDATE public.blend_tickets
   SET order_link_status = 'linked'
 WHERE id = '${TICKET_ID}';
SELECT 'LINK_LOCK_ACQUIRED';
SELECT pg_sleep(1);
COMMIT;
`, 'LINK_LOCK_ACQUIRED');
  await linkFirst.ready;
  const blockedProduct = startSql(`
UPDATE public.blend_ticket_products SET quantity = 2 WHERE id = '${PRODUCT_ID}';
`);
  const [linkResult, productResult] = await Promise.all([
    linkFirst.completion,
    blockedProduct,
  ]);
  assert.equal(linkResult.code, 0, `link-first session failed: ${linkResult.stderr || linkResult.stdout}`);
  assert.notEqual(productResult.code, 0, 'product mutation unexpectedly succeeded after concurrent link');
  assert.match(
    `${productResult.stdout}\n${productResult.stderr}`,
    /BLEND_TICKET_LINKED_CONTENT_LOCKED/,
    'blocked product mutation returned the wrong error',
  );
  assert.equal(
    scalar(`SELECT order_link_status || ':' || quantity FROM public.blend_tickets bt JOIN public.blend_ticket_products btp ON btp.blend_ticket_id=bt.id WHERE bt.id='${TICKET_ID}';`),
    'linked:1',
  );

  const headerResult = runSql(
    `UPDATE public.blend_tickets SET total_acres=2 WHERE id='${TICKET_ID}';`,
    { allowFailure: true },
  );
  assert.notEqual(headerResult.status, 0, 'linked header mutation unexpectedly succeeded');
  assert.match(
    `${headerResult.stdout}\n${headerResult.stderr}`,
    /BLEND_TICKET_LINKED_CONTENT_LOCKED/,
    'linked header mutation returned the wrong error',
  );

  const linkedReparent = runSql(
    `UPDATE public.blend_ticket_products SET blend_ticket_id='${TICKET_ID_2}' WHERE id='${PRODUCT_ID}';`,
    { allowFailure: true },
  );
  assert.notEqual(linkedReparent.status, 0, 'product escaped a linked source through UPDATE reparenting');
  assert.match(
    `${linkedReparent.stdout}\n${linkedReparent.stderr}`,
    /BLEND_TICKET_LINKED_CONTENT_LOCKED/,
    'linked-source reparent returned the wrong error',
  );
  assert.equal(scalar(`SELECT blend_ticket_id FROM public.blend_ticket_products WHERE id='${PRODUCT_ID}';`), TICKET_ID);

  resetBlendFixture();

  // A reparent UPDATE must lock and check both OLD and NEW parents. If the
  // target links first, the waiting reparent must reject after re-reading it.
  const targetLinkFirst = startSqlWithMarker(`
BEGIN;
UPDATE public.blend_tickets
   SET order_link_status = 'linked'
 WHERE id = '${TICKET_ID_2}';
SELECT 'TARGET_LINK_LOCK_ACQUIRED';
SELECT pg_sleep(1);
COMMIT;
`, 'TARGET_LINK_LOCK_ACQUIRED');
  await targetLinkFirst.ready;
  const blockedReparent = startSql(`
UPDATE public.blend_ticket_products
   SET blend_ticket_id = '${TICKET_ID_2}'
 WHERE id = '${PRODUCT_ID}';
`);
  const [targetLinkResult, reparentResult] = await Promise.all([
    targetLinkFirst.completion,
    blockedReparent,
  ]);
  assert.equal(targetLinkResult.code, 0, `target-link session failed: ${targetLinkResult.stderr || targetLinkResult.stdout}`);
  assert.notEqual(reparentResult.code, 0, 'reparent unexpectedly entered a concurrently linked target');
  assert.match(
    `${reparentResult.stdout}\n${reparentResult.stderr}`,
    /BLEND_TICKET_LINKED_CONTENT_LOCKED/,
    'concurrent target reparent returned the wrong error',
  );
  assert.equal(scalar(`SELECT blend_ticket_id FROM public.blend_ticket_products WHERE id='${PRODUCT_ID}';`), TICKET_ID);

  resetBlendFixture();

  // Product mutation commits first while its trigger holds the parent row.
  // The link waits and then serializes after that completed unlinked edit.
  const productFirst = startSqlWithMarker(`
BEGIN;
UPDATE public.blend_ticket_products SET quantity = 2 WHERE id = '${PRODUCT_ID}';
SELECT 'PRODUCT_LOCK_ACQUIRED';
SELECT pg_sleep(1);
COMMIT;
`, 'PRODUCT_LOCK_ACQUIRED');
  await productFirst.ready;
  const blockedLink = startSql(`
UPDATE public.blend_tickets SET order_link_status = 'linked' WHERE id = '${TICKET_ID}';
`);
  const [productFirstResult, linkSecondResult] = await Promise.all([
    productFirst.completion,
    blockedLink,
  ]);
  assert.equal(productFirstResult.code, 0, `product-first session failed: ${productFirstResult.stderr || productFirstResult.stdout}`);
  assert.equal(linkSecondResult.code, 0, `link-second session failed: ${linkSecondResult.stderr || linkSecondResult.stdout}`);
  assert.equal(
    scalar(`SELECT order_link_status || ':' || quantity FROM public.blend_tickets bt JOIN public.blend_ticket_products btp ON btp.blend_ticket_id=bt.id WHERE bt.id='${TICKET_ID}';`),
    'linked:2',
  );

  return {
    link_first: 'product rejected after waiting; final linked:1',
    product_first: 'link serialized after product; final linked:2',
    linked_header: 'mutation rejected',
    reparent: 'linked source and concurrently linked target both rejected',
  };
}

const OCR_TICKET_ID = '60000000-0000-4000-8000-000000000001';
const OCR_QUEUE_ID = '70000000-0000-4000-8000-000000000001';
const OCR_LEASE_ID = '80000000-0000-4000-8000-000000000001';
const OCR_NEW_LEASE_ID = '80000000-0000-4000-8000-000000000002';

function resetOcrFixture() {
  runSql(`
DELETE FROM public.blend_ticket_to_order_items;
UPDATE public.blend_tickets SET order_link_status='unlinked';
DELETE FROM public.blend_ticket_products;
DELETE FROM public.ocr_processing_queue;
DELETE FROM public.invoices;
DELETE FROM public.application_records;
DELETE FROM public.blend_tickets;
DELETE FROM public.idempotency_keys WHERE operation='commit_blend_ticket_ocr_result';
INSERT INTO public.blend_tickets (
  id, status, review_status, order_link_status, payment_status,
  customer_id, total_acres
) VALUES (
  '${OCR_TICKET_ID}', 'processing', 'unreviewed', 'unlinked', 'unbilled',
  '30000000-0000-4000-8000-000000000001', 1
);
INSERT INTO public.ocr_processing_queue (
  id, blend_ticket_id, status, lease_token, lease_heartbeat_at
) VALUES (
  '${OCR_QUEUE_ID}', '${OCR_TICKET_ID}', 'processing', '${OCR_LEASE_ID}', now()
);
INSERT INTO public.blend_ticket_to_order_items (id, blend_ticket_id)
VALUES ('90000000-0000-4000-8000-000000000001', '${OCR_TICKET_ID}');
`);
}

function ocrCommitSql(key) {
  return `SELECT public.commit_blend_ticket_ocr_result(
    '${OCR_TICKET_ID}', '${OCR_QUEUE_ID}', '${OCR_LEASE_ID}',
    '{"status":"completed","ocr_confidence_score":88,"raw_ocr_text":"race"}'::jsonb,
    '[]'::jsonb, '${key}'
  )::text;`;
}

async function proveOcrLifecycleRaces() {
  resetOcrFixture();

  const approvalFirst = startSqlWithMarker(`
BEGIN;
UPDATE public.blend_tickets SET review_status='approved' WHERE id='${OCR_TICKET_ID}';
SELECT 'APPROVAL_LOCK_ACQUIRED';
SELECT pg_sleep(1);
COMMIT;
`, 'APPROVAL_LOCK_ACQUIRED');
  await approvalFirst.ready;
  const approvalCommit = startSql(ocrCommitSql('ocr-approval-race'));
  const [approvalResult, approvalCommitResult] = await Promise.all([
    approvalFirst.completion,
    approvalCommit,
  ]);
  assert.equal(approvalResult.code, 0, `approval session failed: ${approvalResult.stderr || approvalResult.stdout}`);
  assert.notEqual(approvalCommitResult.code, 0, 'OCR commit beat a completed approval race');
  assert.match(`${approvalCommitResult.stdout}\n${approvalCommitResult.stderr}`, /OCR_COMMIT_LIFECYCLE_CHANGED/);
  assert.equal(scalar(`SELECT status FROM public.ocr_processing_queue WHERE id='${OCR_QUEUE_ID}';`), 'processing');
  assert.equal(Number(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='ocr-approval-race';")), 0);

  resetOcrFixture();

  const linkFirst = startSqlWithMarker(`
BEGIN;
UPDATE public.blend_tickets
   SET status='completed', review_status='approved', order_link_status='linked'
 WHERE id='${OCR_TICKET_ID}';
SELECT 'OCR_LINK_LOCK_ACQUIRED';
SELECT pg_sleep(1);
COMMIT;
`, 'OCR_LINK_LOCK_ACQUIRED');
  await linkFirst.ready;
  const linkCommit = startSql(ocrCommitSql('ocr-link-race'));
  const [linkResult, linkCommitResult] = await Promise.all([
    linkFirst.completion,
    linkCommit,
  ]);
  assert.equal(linkResult.code, 0, `OCR link session failed: ${linkResult.stderr || linkResult.stdout}`);
  assert.notEqual(linkCommitResult.code, 0, 'OCR commit beat a completed link race');
  assert.match(`${linkCommitResult.stdout}\n${linkCommitResult.stderr}`, /OCR_COMMIT_LIFECYCLE_CHANGED/);
  assert.equal(scalar(`SELECT status FROM public.ocr_processing_queue WHERE id='${OCR_QUEUE_ID}';`), 'processing');
  assert.equal(Number(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='ocr-link-race';")), 0);

  resetOcrFixture();

  const leaseFirst = startSqlWithMarker(`
BEGIN;
UPDATE public.ocr_processing_queue
   SET lease_token='${OCR_NEW_LEASE_ID}'
 WHERE id='${OCR_QUEUE_ID}';
SELECT 'LEASE_LOCK_ACQUIRED';
SELECT pg_sleep(1);
COMMIT;
`, 'LEASE_LOCK_ACQUIRED');
  await leaseFirst.ready;
  const leaseCommit = startSql(ocrCommitSql('ocr-lease-race'));
  const [leaseResult, leaseCommitResult] = await Promise.all([
    leaseFirst.completion,
    leaseCommit,
  ]);
  assert.equal(leaseResult.code, 0, `lease session failed: ${leaseResult.stderr || leaseResult.stdout}`);
  assert.notEqual(leaseCommitResult.code, 0, 'OCR commit accepted a lost concurrent lease');
  assert.match(`${leaseCommitResult.stdout}\n${leaseCommitResult.stderr}`, /OCR_COMMIT_LEASE_LOST/);
  assert.equal(scalar(`SELECT status || ':' || lease_token FROM public.ocr_processing_queue WHERE id='${OCR_QUEUE_ID}';`), `processing:${OCR_NEW_LEASE_ID}`);
  assert.equal(Number(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='ocr-lease-race';")), 0);

  return {
    approval_first: 'commit rejected and rolled back',
    link_first: 'commit rejected and rolled back',
    lease_change_first: 'commit rejected and rolled back',
  };
}

async function main() {
  try {
    console.log(`[proof] creating network-isolated disposable container ${CONTAINER}`);
    prepareContainer();
    installProofSchema();
    const helper = await proveHelperRace();
    const legacy = await proveLegacyRace();
    const blend_locks = await proveBlendLockOrdering();
    const ocr_races = await proveOcrLifecycleRaces();
    console.log(JSON.stringify({ container: CONTAINER, helper, legacy, blend_locks, ocr_races }, null, 2));
    console.log('PASS: gauntlet idempotency, blend-lock, and OCR lifecycle concurrency proof');
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
