#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 two-session proof for the final gauntlet
 * serialization boundaries. It exercises both winning orders for:
 *   - receiving reversal vs. PO-linked bill creation;
 *   - receiving reversal vs. accounting-period close;
 *   - receiving reversal vs. supplier-cost application;
 *   - vendor-bill creation vs. supplier-cost application;
 *   - cycle-count completion vs. item insertion;
 *   - cycle-count completion vs. attempted item re-parenting.
 *
 * The disposable functions contain only the reviewed locking/status slice.
 * Source assertions bind that slice to the checked-in forward migration.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-gauntlet-write-boundary-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const PASSWORD = 'gauntlet-disposable-only';
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260831235900_serialize_gauntlet_write_boundaries.sql',
);
const BILL_MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260831161000_require_cumulative_po_bill_confirmation.sql',
);
const CUTOVER_MIGRATIONS = [
  {
    file: path.join(ROOT, 'supabase', 'migrations', '20260831160000_harden_receiving_reversal_and_ap_reporting.sql'),
    tag: 'section9_reversal_cutover',
    operations: ['reverse_receiving_record'],
    error: /SECTION9_INTENT_CUTOVER_BLOCKED/,
  },
  {
    file: BILL_MIGRATION,
    tag: 'section9_bill_create_cutover',
    operations: ['create_vendor_bill'],
    error: /SECTION9_INTENT_CUTOVER_BLOCKED/,
  },
  {
    file: path.join(ROOT, 'supabase', 'migrations', '20260831212415_guard_cycle_count_completion_revision.sql'),
    tag: 'cycle_count_intent_cutover',
    operations: ['update_cycle_count_item', 'complete_cycle_count'],
    error: /CYCLE_COUNT_INTENT_CUTOVER_BLOCKED/,
  },
  {
    file: path.join(ROOT, 'supabase', 'migrations', '20260831233000_bind_section9_replays_to_intent.sql'),
    tag: 'section9_intent_cutover',
    operations: [
      'receive_po_items',
      'update_vendor_bill',
      'record_vendor_payment',
      'void_vendor_bill',
      'notify_damaged_receiving',
    ],
    error: /SECTION9_INTENT_CUTOVER_BLOCKED/,
  },
];

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
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

function sql(statement, { allowFailure = false } = {}) {
  return docker(psqlArgs(), { input: statement, allowFailure });
}

function scalar(statement) {
  return sql(statement).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
}

function session(statement, marker) {
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
  child.stdin.end(statement);
  const done = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (!readySettled) {
        readySettled = true;
        readyReject(error);
      }
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
  return { ready, done };
}

function expectFailure(result, pattern, label) {
  assert.notEqual(result.code, 0, `${label} unexpectedly committed`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern, `${label} failed for the wrong reason`);
}

function cutoverGuard({ file, tag }) {
  const migration = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const endToken = `$${tag}$;`;
  const doStart = migration.indexOf(`DO $${tag}$`);
  const lockStart = migration.lastIndexOf(
    'LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;',
    doStart,
  );
  const end = migration.indexOf(endToken, doStart);
  assert.ok(lockStart >= 0 && doStart > lockStart && end > doStart, `${tag} guard missing`);
  return `BEGIN;\n${migration.slice(lockStart, end + endToken.length)}\nROLLBACK;`;
}

function assertCheckedInMarkers() {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const poItem = migration.indexOf('FROM public.purchase_order_items poi');
  const po = migration.indexOf('FROM public.purchase_orders po');
  const month = migration.indexOf(
    'public._lock_accounting_months(ARRAY[v_receiving_date], false)',
    po,
  );
  const period = migration.indexOf('public.check_period_open(v_receiving_date)', month);
  const implementation = migration.indexOf(
    'public._section9_reverse_receiving_record_serialized',
    period,
  );
  assert.ok(poItem >= 0 && po > poItem && month > po && period > month && implementation > period);
  assert.match(
    migration.slice(poItem, po),
    /FOR UPDATE;/,
    'receiving wrapper does not lock the PO item before the PO',
  );
  assert.match(
    migration.slice(po, month),
    /FOR UPDATE;/,
    'receiving wrapper does not lock the PO before the month',
  );
  assert.match(
    migration,
    /CREATE TRIGGER trg_bump_cycle_count_item_revision\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.cycle_count_items/,
  );
  const triggerStart = migration.indexOf(
    'CREATE OR REPLACE FUNCTION public.bump_cycle_count_item_revision',
  );
  const triggerEnd = migration.indexOf(
    'REVOKE ALL ON FUNCTION public.bump_cycle_count_item_revision',
    triggerStart,
  );
  const triggerBody = migration.slice(triggerStart, triggerEnd);
  assert.ok(triggerBody.indexOf('FOR UPDATE;') < triggerBody.indexOf('SET item_revision = item_revision + 1'));
  assert.match(triggerBody, /CYCLE_COUNT_NOT_IN_PROGRESS/);
  assert.match(triggerBody, /CYCLE_COUNT_ITEM_REPARENT_FORBIDDEN/);

  const billMigration = readFileSync(BILL_MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const vendor = billMigration.indexOf('FROM public.vendors v');
  const billPo = billMigration.indexOf('FROM public.purchase_orders po', vendor);
  assert.ok(vendor >= 0 && billPo > vendor, 'bill wrapper does not preserve vendor -> PO order');
  assert.match(
    billMigration.slice(vendor, billPo),
    /FOR UPDATE;/,
    'bill wrapper does not lock the vendor before the PO',
  );
}

function prepareContainer() {
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
    '--env', `POSTGRES_PASSWORD=${PASSWORD}`,
    IMAGE,
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (docker(
      ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    ).status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  fail('disposable PostgreSQL container did not become ready');
}

function installSchema() {
  sql(`
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;

CREATE TABLE public.vendors (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY,
  total_cost_cents bigint NOT NULL DEFAULT 10000
);
CREATE TABLE public.purchase_order_items (
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id)
);
CREATE TABLE public.receiving_records (
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  po_item_id uuid NOT NULL REFERENCES public.purchase_order_items(id),
  received_at timestamptz NOT NULL
);
CREATE TABLE public.vendor_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  status text NOT NULL DEFAULT 'unpaid',
  deleted_at timestamptz,
  total_cents bigint NOT NULL DEFAULT 10000
);
CREATE TABLE public.activity_feed (
  event_type text,
  description text,
  performed_by uuid,
  related_entity_type text,
  related_entity_id uuid
);
CREATE TABLE public.accounting_periods (
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL
);
CREATE TABLE public.idempotency_keys (
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  result jsonb,
  request_actor_id uuid,
  request_fingerprint text,
  expires_at timestamptz DEFAULT now() + interval '24 hours',
  PRIMARY KEY (idempotency_key, operation)
);

CREATE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.check_idempotency_intent(text, text, uuid, text)
RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;

CREATE FUNCTION public.create_vendor_bill(
  p_vendor_id uuid,
  p_purchase_order_id uuid DEFAULT NULL,
  p_bill_number text DEFAULT '',
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_payment_terms text DEFAULT NULL,
  p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql AS $function$
DECLARE v_bill_id uuid;
BEGIN
  PERFORM 1 FROM public.vendors
   WHERE id = p_vendor_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VENDOR_NOT_FOUND'; END IF;
  IF p_purchase_order_id IS NOT NULL THEN
    PERFORM 1 FROM public.purchase_orders
     WHERE id = p_purchase_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PO_NOT_FOUND'; END IF;
  END IF;
  INSERT INTO public.vendor_bills(vendor_id, purchase_order_id, total_cents)
  VALUES (p_vendor_id, p_purchase_order_id, p_subtotal_cents + COALESCE(p_adjustment_cents, 0))
  RETURNING id INTO v_bill_id;
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_idempotency_key, 'create_vendor_bill', jsonb_build_object('bill_id', v_bill_id));
  RETURN v_bill_id;
END;
$function$;

CREATE FUNCTION public._lock_accounting_months(p_dates date[], p_exclusive boolean)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE v_month_key integer;
BEGIN
  FOR v_month_key IN
    SELECT DISTINCT (EXTRACT(YEAR FROM d)::integer * 12) + EXTRACT(MONTH FROM d)::integer - 1
    FROM unnest(p_dates) dates(d) WHERE d IS NOT NULL ORDER BY 1
  LOOP
    IF p_exclusive THEN
      PERFORM pg_advisory_xact_lock(73492010, v_month_key);
    ELSE
      PERFORM pg_advisory_xact_lock_shared(73492010, v_month_key);
    END IF;
  END LOOP;
END;
$function$;

CREATE FUNCTION public.check_period_open(p_date date)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.accounting_periods
    WHERE status = 'closed' AND p_date BETWEEN period_start AND period_end
  ) THEN RAISE EXCEPTION 'CLOSED_PERIOD'; END IF;
END;
$function$;

CREATE FUNCTION public._section9_reverse_receiving_record_serialized(
  p_record_id uuid,
  p_reason text DEFAULT 'Manually reversed',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE v_po uuid; v_date date; v_result jsonb;
BEGIN
  SELECT purchase_order_id, (received_at AT TIME ZONE 'America/Chicago')::date
    INTO v_po, v_date
    FROM public.receiving_records
   WHERE id = p_record_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECEIPT_NOT_FOUND'; END IF;
  PERFORM public.check_period_open(v_date);
  IF EXISTS (
    SELECT 1 FROM public.vendor_bills
    WHERE purchase_order_id = v_po AND deleted_at IS NULL AND status <> 'voided'
  ) THEN RAISE EXCEPTION 'ACTIVE_VENDOR_BILL'; END IF;
  DELETE FROM public.receiving_records WHERE id = p_record_id;
  v_result := jsonb_build_object('success', true, 'record_id', p_record_id);
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_idempotency_key, 'reverse_receiving_record', v_result);
  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.reverse_receiving_record(
  uuid, text DEFAULT 'Manually reversed', uuid DEFAULT NULL, text DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

CREATE TABLE public.cycle_counts (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'in_progress',
  item_revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE public.cycle_count_items (
  id uuid PRIMARY KEY,
  cycle_count_id uuid NOT NULL REFERENCES public.cycle_counts(id)
);

CREATE FUNCTION public.bump_cycle_count_item_revision()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RETURN COALESCE(NEW, OLD);
END;
$function$;
CREATE TRIGGER trg_bump_cycle_count_item_revision
AFTER INSERT OR UPDATE OR DELETE ON public.cycle_count_items
FOR EACH ROW EXECUTE FUNCTION public.bump_cycle_count_item_revision();

CREATE FUNCTION public.complete_cycle_count(uuid, uuid DEFAULT NULL, text DEFAULT NULL, bigint DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ SELECT $$;

CREATE FUNCTION public.proof_complete_cycle_count(p_count_id uuid, p_expected_revision bigint)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE v_revision bigint; v_status text;
BEGIN
  PERFORM 1 FROM public.cycle_count_items
   WHERE cycle_count_id = p_count_id ORDER BY id FOR UPDATE;
  SELECT item_revision, status INTO v_revision, v_status
    FROM public.cycle_counts WHERE id = p_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF v_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_NOT_IN_PROGRESS';
  END IF;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION';
  END IF;
  UPDATE public.cycle_counts SET status = 'completed' WHERE id = p_count_id;
END;
$function$;
`);
  // The governed CRX apply path supplies one outer transaction per migration.
  // Mirror that contract here so table locks last across the whole file without
  // putting a dangerous runner-committing COMMIT inside the migration itself.
  sql(`BEGIN;\n${readFileSync(BILL_MIGRATION, 'utf8')}\nCOMMIT;`);
  sql(`BEGIN;\n${readFileSync(MIGRATION, 'utf8')}\nCOMMIT;`);
}

function proveIntentCutoverGuards() {
  const actor = '11111111-1111-1111-1111-111111111111';
  for (const guardSpec of CUTOVER_MIGRATIONS) {
    const guard = cutoverGuard(guardSpec);
    for (const operation of guardSpec.operations) {
      const result = operation === 'complete_cycle_count' ? '{}' : '{}';
      sql(`
TRUNCATE public.idempotency_keys;
INSERT INTO public.idempotency_keys (
  idempotency_key, operation, result, expires_at,
  request_actor_id, request_fingerprint
) VALUES ('legacy-${operation}', '${operation}', '${result}'::jsonb, now() + interval '1 hour', NULL, NULL);
`);
      const blocked = sql(guard, { allowFailure: true });
      expectFailure(blocked, guardSpec.error, `${operation} legacy-receipt cutover`);
    }

    const representative = guardSpec.operations[0];
    sql(`
TRUNCATE public.idempotency_keys;
INSERT INTO public.idempotency_keys (
  idempotency_key, operation, result, expires_at,
  request_actor_id, request_fingerprint
) VALUES ('expired-${representative}', '${representative}', '{}'::jsonb, now() - interval '1 second', NULL, NULL);
`);
    assert.equal(sql(guard).status, 0, `${representative} expired receipt blocked cutover`);

    sql(`
TRUNCATE public.idempotency_keys;
INSERT INTO public.idempotency_keys (
  idempotency_key, operation, result, expires_at,
  request_actor_id, request_fingerprint
) VALUES (
  'bound-${representative}', '${representative}',
  ${representative === 'complete_cycle_count'
    ? `'${JSON.stringify({ _cycle_count_id: actor, _actor_id: actor, _expected_item_revision: null })}'::jsonb`
    : "'{}'::jsonb"},
  now() + interval '1 hour', '${actor}', 'bound-fingerprint'
);
`);
    assert.equal(sql(guard).status, 0, `${representative} bound receipt blocked cutover`);
  }
  sql('TRUNCATE public.idempotency_keys;');
}

function seedReceiving(po, poItem, receipt, vendor) {
  sql(`
INSERT INTO public.vendors(id, name) VALUES ('${vendor}', 'Proof Vendor');
INSERT INTO public.purchase_orders(id) VALUES ('${po}');
INSERT INTO public.purchase_order_items(id, purchase_order_id) VALUES ('${poItem}', '${po}');
INSERT INTO public.receiving_records(id, purchase_order_id, po_item_id, received_at)
VALUES ('${receipt}', '${po}', '${poItem}', '2025-01-15 12:00:00-06');
`);
}

async function proveBillFirstBlocksReversal() {
  const po = '00000000-0000-0000-0000-000000000101';
  const poItem = '00000000-0000-0000-0000-000000000111';
  const receipt = '00000000-0000-0000-0000-000000000201';
  const vendor = '00000000-0000-0000-0000-000000000301';
  seedReceiving(po, poItem, receipt, vendor);
  const writer = session(`
BEGIN;
SELECT public.create_vendor_bill(
  '${vendor}', '${po}', 'BILL-101', DATE '2025-01-15', DATE '2025-02-14',
  'Net 30', 10000, 0, NULL, 'bill-first-${po}', false, NULL
);
SELECT 'BILL_LOCKS_HELD';
SELECT pg_sleep(2);
COMMIT;
`, 'BILL_LOCKS_HELD');
  await writer.ready;
  const reversal = session(`
SELECT 'REVERSAL_STARTED';
SELECT public.reverse_receiving_record('${receipt}', 'proof', '11111111-1111-1111-1111-111111111111', 'bill-first-${receipt}');
`, 'REVERSAL_STARTED');
  const [writerResult, reversalResult] = await Promise.all([writer.done, reversal.done]);
  assert.equal(writerResult.code, 0, writerResult.stderr);
  expectFailure(reversalResult, /ACTIVE_VENDOR_BILL/, 'bill-first reversal');
  assert.equal(scalar(`SELECT count(*) FROM public.receiving_records WHERE id='${receipt}'`), '1');
}

async function proveReversalFirstSerializesBill() {
  const po = '00000000-0000-0000-0000-000000000102';
  const poItem = '00000000-0000-0000-0000-000000000112';
  const receipt = '00000000-0000-0000-0000-000000000202';
  const vendor = '00000000-0000-0000-0000-000000000302';
  seedReceiving(po, poItem, receipt, vendor);
  const reversal = session(`
BEGIN;
SELECT id FROM public.purchase_order_items WHERE id='${poItem}' FOR UPDATE;
SELECT id FROM public.purchase_orders WHERE id='${po}' FOR UPDATE;
SELECT public._lock_accounting_months(ARRAY[DATE '2025-01-15'], false);
SELECT 'REVERSAL_BOUNDARIES_LOCKED';
SELECT pg_sleep(2);
SELECT public.reverse_receiving_record('${receipt}', 'proof', '11111111-1111-1111-1111-111111111111', 'reversal-first-bill-${receipt}');
COMMIT;
`, 'REVERSAL_BOUNDARIES_LOCKED');
  await reversal.ready;
  const writer = session(`
SELECT 'BILL_STARTED';
SELECT public.create_vendor_bill(
  '${vendor}', '${po}', 'BILL-102', DATE '2025-01-15', DATE '2025-02-14',
  'Net 30', 10000, 0, NULL, 'reversal-first-${po}', false, NULL
);
`, 'BILL_STARTED');
  const [reversalResult, writerResult] = await Promise.all([reversal.done, writer.done]);
  assert.equal(reversalResult.code, 0, reversalResult.stderr);
  assert.equal(writerResult.code, 0, writerResult.stderr);
  assert.equal(scalar(`SELECT count(*) FROM public.receiving_records WHERE id='${receipt}'`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_bills WHERE purchase_order_id='${po}'`), '1');
}

async function proveCloseFirstBlocksReversal() {
  const po = '00000000-0000-0000-0000-000000000103';
  const poItem = '00000000-0000-0000-0000-000000000113';
  const receipt = '00000000-0000-0000-0000-000000000203';
  const vendor = '00000000-0000-0000-0000-000000000303';
  seedReceiving(po, poItem, receipt, vendor);
  const closer = session(`
BEGIN;
SELECT public._lock_accounting_months(ARRAY[DATE '2025-01-01'], true);
SELECT 'CLOSE_MONTH_LOCKED';
SELECT pg_sleep(2);
INSERT INTO public.accounting_periods(period_start, period_end, status)
VALUES ('2025-01-01', '2025-01-31', 'closed');
COMMIT;
`, 'CLOSE_MONTH_LOCKED');
  await closer.ready;
  const reversal = session(`
SELECT 'CLOSE_FIRST_REVERSAL_STARTED';
SELECT public.reverse_receiving_record('${receipt}', 'proof', '11111111-1111-1111-1111-111111111111', 'close-first-${receipt}');
`, 'CLOSE_FIRST_REVERSAL_STARTED');
  const [closeResult, reversalResult] = await Promise.all([closer.done, reversal.done]);
  assert.equal(closeResult.code, 0, closeResult.stderr);
  expectFailure(reversalResult, /CLOSED_PERIOD/, 'close-first reversal');
  assert.equal(scalar(`SELECT count(*) FROM public.receiving_records WHERE id='${receipt}'`), '1');
  sql(`DELETE FROM public.accounting_periods WHERE period_start='2025-01-01';`);
}

async function proveReversalFirstSerializesClose() {
  const po = '00000000-0000-0000-0000-000000000104';
  const poItem = '00000000-0000-0000-0000-000000000114';
  const receipt = '00000000-0000-0000-0000-000000000204';
  const vendor = '00000000-0000-0000-0000-000000000304';
  seedReceiving(po, poItem, receipt, vendor);
  const reversal = session(`
BEGIN;
SELECT id FROM public.purchase_order_items WHERE id='${poItem}' FOR UPDATE;
SELECT id FROM public.purchase_orders WHERE id='${po}' FOR UPDATE;
SELECT public._lock_accounting_months(ARRAY[DATE '2025-01-15'], false);
SELECT 'REVERSAL_MONTH_LOCKED';
SELECT pg_sleep(2);
SELECT public.reverse_receiving_record('${receipt}', 'proof', '11111111-1111-1111-1111-111111111111', 'reversal-first-close-${receipt}');
COMMIT;
`, 'REVERSAL_MONTH_LOCKED');
  await reversal.ready;
  const closer = session(`
SELECT 'CLOSE_STARTED';
BEGIN;
SELECT public._lock_accounting_months(ARRAY[DATE '2025-01-01'], true);
INSERT INTO public.accounting_periods(period_start, period_end, status)
VALUES ('2025-01-01', '2025-01-31', 'closed');
COMMIT;
`, 'CLOSE_STARTED');
  const [reversalResult, closeResult] = await Promise.all([reversal.done, closer.done]);
  assert.equal(reversalResult.code, 0, reversalResult.stderr);
  assert.equal(closeResult.code, 0, closeResult.stderr);
  assert.equal(scalar(`SELECT count(*) FROM public.receiving_records WHERE id='${receipt}'`), '0');
  sql(`DELETE FROM public.accounting_periods WHERE period_start='2025-01-01';`);
}

async function proveCostBasisFirstSerializesReversal() {
  const po = '00000000-0000-0000-0000-000000000105';
  const poItem = '00000000-0000-0000-0000-000000000115';
  const receipt = '00000000-0000-0000-0000-000000000205';
  const vendor = '00000000-0000-0000-0000-000000000305';
  seedReceiving(po, poItem, receipt, vendor);

  const costBasis = session(`
BEGIN;
SELECT id FROM public.vendors WHERE id='${vendor}' FOR UPDATE;
SELECT id FROM public.purchase_order_items WHERE id='${poItem}' FOR UPDATE;
SELECT 'COST_BASIS_ITEM_LOCKED';
SELECT pg_sleep(2);
SELECT id FROM public.purchase_orders WHERE id='${po}' FOR UPDATE;
COMMIT;
`, 'COST_BASIS_ITEM_LOCKED');
  await costBasis.ready;
  const reversal = session(`
SELECT 'COST_FIRST_REVERSAL_STARTED';
SELECT public.reverse_receiving_record(
  '${receipt}', 'proof', '11111111-1111-1111-1111-111111111111', 'cost-first-${receipt}'
);
`, 'COST_FIRST_REVERSAL_STARTED');

  const [costResult, reversalResult] = await Promise.all([costBasis.done, reversal.done]);
  assert.equal(costResult.code, 0, costResult.stderr);
  assert.equal(reversalResult.code, 0, reversalResult.stderr);
  assert.equal(scalar(`SELECT count(*) FROM public.receiving_records WHERE id='${receipt}'`), '0');
}

async function proveReversalFirstSerializesCostBasis() {
  const po = '00000000-0000-0000-0000-000000000106';
  const poItem = '00000000-0000-0000-0000-000000000116';
  const receipt = '00000000-0000-0000-0000-000000000206';
  const vendor = '00000000-0000-0000-0000-000000000306';
  seedReceiving(po, poItem, receipt, vendor);

  const reversal = session(`
BEGIN;
SELECT id FROM public.receiving_records WHERE id='${receipt}' FOR UPDATE;
SELECT id FROM public.purchase_order_items WHERE id='${poItem}' FOR UPDATE;
SELECT 'REVERSAL_ITEM_LOCKED';
SELECT pg_sleep(2);
SELECT public.reverse_receiving_record(
  '${receipt}', 'proof', '11111111-1111-1111-1111-111111111111', 'reversal-first-cost-${receipt}'
);
COMMIT;
`, 'REVERSAL_ITEM_LOCKED');
  await reversal.ready;
  const costBasis = session(`
BEGIN;
SELECT 'REVERSAL_FIRST_COST_STARTED';
SELECT id FROM public.vendors WHERE id='${vendor}' FOR UPDATE;
SELECT id FROM public.purchase_order_items WHERE id='${poItem}' FOR UPDATE;
SELECT id FROM public.purchase_orders WHERE id='${po}' FOR UPDATE;
COMMIT;
`, 'REVERSAL_FIRST_COST_STARTED');

  const [reversalResult, costResult] = await Promise.all([reversal.done, costBasis.done]);
  assert.equal(reversalResult.code, 0, reversalResult.stderr);
  assert.equal(costResult.code, 0, costResult.stderr);
  assert.equal(scalar(`SELECT count(*) FROM public.receiving_records WHERE id='${receipt}'`), '0');
}

async function proveCostBasisFirstSerializesBill() {
  const po = '00000000-0000-0000-0000-000000000107';
  const poItem = '00000000-0000-0000-0000-000000000117';
  const receipt = '00000000-0000-0000-0000-000000000207';
  const vendor = '00000000-0000-0000-0000-000000000307';
  seedReceiving(po, poItem, receipt, vendor);

  const costBasis = session(`
BEGIN;
SELECT id FROM public.vendors WHERE id='${vendor}' FOR UPDATE;
SELECT 'COST_BASIS_VENDOR_LOCKED';
SELECT pg_sleep(2);
SELECT id FROM public.purchase_order_items WHERE id='${poItem}' FOR UPDATE;
SELECT id FROM public.purchase_orders WHERE id='${po}' FOR UPDATE;
COMMIT;
`, 'COST_BASIS_VENDOR_LOCKED');
  await costBasis.ready;
  const bill = session(`
SELECT 'COST_FIRST_BILL_STARTED';
SELECT public.create_vendor_bill(
  '${vendor}', '${po}', 'BILL-107', DATE '2025-01-15', DATE '2025-02-14',
  'Net 30', 10000, 0, NULL, 'cost-first-bill-${po}', false, NULL
);
`, 'COST_FIRST_BILL_STARTED');

  const [costResult, billResult] = await Promise.all([costBasis.done, bill.done]);
  assert.equal(costResult.code, 0, costResult.stderr);
  assert.equal(billResult.code, 0, billResult.stderr);
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_bills WHERE purchase_order_id='${po}'`), '1');
}

async function proveBillFirstSerializesCostBasis() {
  const po = '00000000-0000-0000-0000-000000000108';
  const poItem = '00000000-0000-0000-0000-000000000118';
  const receipt = '00000000-0000-0000-0000-000000000208';
  const vendor = '00000000-0000-0000-0000-000000000308';
  seedReceiving(po, poItem, receipt, vendor);

  const bill = session(`
BEGIN;
SELECT public.create_vendor_bill(
  '${vendor}', '${po}', 'BILL-108', DATE '2025-01-15', DATE '2025-02-14',
  'Net 30', 10000, 0, NULL, 'bill-first-cost-${po}', false, NULL
);
SELECT 'BILL_VENDOR_PO_LOCKED';
SELECT pg_sleep(2);
COMMIT;
`, 'BILL_VENDOR_PO_LOCKED');
  await bill.ready;
  const costBasis = session(`
BEGIN;
SELECT 'BILL_FIRST_COST_STARTED';
SELECT id FROM public.vendors WHERE id='${vendor}' FOR UPDATE;
SELECT id FROM public.purchase_order_items WHERE id='${poItem}' FOR UPDATE;
SELECT id FROM public.purchase_orders WHERE id='${po}' FOR UPDATE;
COMMIT;
`, 'BILL_FIRST_COST_STARTED');

  const [billResult, costResult] = await Promise.all([bill.done, costBasis.done]);
  assert.equal(billResult.code, 0, billResult.stderr);
  assert.equal(costResult.code, 0, costResult.stderr);
  assert.equal(scalar(`SELECT count(*) FROM public.vendor_bills WHERE purchase_order_id='${po}'`), '1');
}

async function proveInsertFirstMakesCompletionStale() {
  const count = '00000000-0000-0000-0000-000000000401';
  const item = '00000000-0000-0000-0000-000000000501';
  sql(`INSERT INTO public.cycle_counts(id) VALUES ('${count}');`);
  const insertion = session(`
BEGIN;
INSERT INTO public.cycle_count_items(id, cycle_count_id) VALUES ('${item}', '${count}');
SELECT 'ITEM_PARENT_LOCKED';
SELECT pg_sleep(2);
COMMIT;
`, 'ITEM_PARENT_LOCKED');
  await insertion.ready;
  const completion = session(`
SELECT 'STALE_COMPLETION_STARTED';
SELECT public.proof_complete_cycle_count('${count}', 0);
`, 'STALE_COMPLETION_STARTED');
  const [insertResult, completionResult] = await Promise.all([insertion.done, completion.done]);
  assert.equal(insertResult.code, 0, insertResult.stderr);
  expectFailure(completionResult, /CYCLE_COUNT_STALE_REVISION/, 'insert-first completion');
  assert.equal(scalar(`SELECT status FROM public.cycle_counts WHERE id='${count}'`), 'in_progress');
  assert.equal(scalar(`SELECT item_revision FROM public.cycle_counts WHERE id='${count}'`), '1');
}

async function proveCompletionFirstRejectsLateInsert() {
  const count = '00000000-0000-0000-0000-000000000402';
  const item = '00000000-0000-0000-0000-000000000502';
  sql(`INSERT INTO public.cycle_counts(id) VALUES ('${count}');`);
  const completion = session(`
BEGIN;
SELECT id FROM public.cycle_counts WHERE id='${count}' FOR UPDATE;
SELECT 'COMPLETION_PARENT_LOCKED';
SELECT pg_sleep(2);
SELECT public.proof_complete_cycle_count('${count}', 0);
COMMIT;
`, 'COMPLETION_PARENT_LOCKED');
  await completion.ready;
  const insertion = session(`
SELECT 'LATE_INSERT_STARTED';
INSERT INTO public.cycle_count_items(id, cycle_count_id) VALUES ('${item}', '${count}');
`, 'LATE_INSERT_STARTED');
  const [completionResult, insertResult] = await Promise.all([completion.done, insertion.done]);
  assert.equal(completionResult.code, 0, completionResult.stderr);
  expectFailure(insertResult, /CYCLE_COUNT_NOT_IN_PROGRESS/, 'completion-first late insert');
  assert.equal(scalar(`SELECT status FROM public.cycle_counts WHERE id='${count}'`), 'completed');
  assert.equal(scalar(`SELECT count(*) FROM public.cycle_count_items WHERE id='${item}'`), '0');
}

async function proveCompletionCannotMissReparentedItem() {
  const sourceCount = '00000000-0000-0000-0000-000000000403';
  const destinationCount = '00000000-0000-0000-0000-000000000404';
  const item = '00000000-0000-0000-0000-000000000503';
  sql(`
INSERT INTO public.cycle_counts(id) VALUES ('${sourceCount}'), ('${destinationCount}');
INSERT INTO public.cycle_count_items(id, cycle_count_id) VALUES ('${item}', '${sourceCount}');
`);

  const completion = session(`
BEGIN;
SELECT id FROM public.cycle_counts WHERE id='${sourceCount}' FOR UPDATE;
SELECT 'REPARENT_COMPLETION_LOCKED';
SELECT pg_sleep(2);
SELECT public.proof_complete_cycle_count('${sourceCount}', 1);
COMMIT;
`, 'REPARENT_COMPLETION_LOCKED');
  await completion.ready;
  const reparent = session(`
SELECT 'REPARENT_STARTED';
UPDATE public.cycle_count_items
   SET cycle_count_id='${destinationCount}'
 WHERE id='${item}';
`, 'REPARENT_STARTED');
  const [completionResult, reparentResult] = await Promise.all([completion.done, reparent.done]);
  assert.equal(completionResult.code, 0, completionResult.stderr);
  expectFailure(
    reparentResult,
    /CYCLE_COUNT_ITEM_REPARENT_FORBIDDEN/,
    'completion-first item reparent',
  );
  assert.equal(scalar(`SELECT status FROM public.cycle_counts WHERE id='${sourceCount}'`), 'completed');
  assert.equal(
    scalar(`SELECT cycle_count_id FROM public.cycle_count_items WHERE id='${item}'`),
    sourceCount,
  );
  assert.equal(scalar(`SELECT item_revision FROM public.cycle_counts WHERE id='${destinationCount}'`), '0');
}

try {
  assertCheckedInMarkers();
  prepareContainer();
  installSchema();
  proveIntentCutoverGuards();
  await proveBillFirstBlocksReversal();
  await proveReversalFirstSerializesBill();
  await proveCloseFirstBlocksReversal();
  await proveReversalFirstSerializesClose();
  await proveCostBasisFirstSerializesReversal();
  await proveReversalFirstSerializesCostBasis();
  await proveCostBasisFirstSerializesBill();
  await proveBillFirstSerializesCostBasis();
  await proveInsertFirstMakesCompletionStale();
  await proveCompletionFirstRejectsLateInsert();
  await proveCompletionCannotMissReparentedItem();
  console.log('GAUNTLET_WRITE_BOUNDARY_CONCURRENCY_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
