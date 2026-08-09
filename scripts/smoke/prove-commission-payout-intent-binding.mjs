#!/usr/bin/env node
/**
 * Disposable commission-payout intent-binding proof. It never reads a DB URL or
 * connects to Supabase: a unique PostgreSQL 17 container runs with no network
 * and tmpfs storage, and is force-removed in `finally`.
 *
 * The container is loaded with the live shapes this change depends on — the
 * real `idempotency_keys` table (including its nullable `result` column and its
 * UNIQUE(idempotency_key) constraint), the live `check_idempotency` /
 * `save_idempotency` bodies, and the three payout RPCs with their exact live
 * signatures, guard order, and idempotency contract. The migration under test
 * is then applied VERBATIM from disk.
 *
 * Scope note: the payout implementations installed here are faithful stand-ins,
 * not the full live money bodies. That is deliberate and sufficient — the
 * migration renames those bodies without editing a byte, so what is under test
 * is the new wrapper's actor/intent binding, not the payout logic itself.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-commission-payout-intent-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const MIGRATION = path.join(
  ROOT, 'supabase', 'migrations',
  '20260810130500_bind_commission_payout_idempotency_to_intent.sql',
);
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-commission-payout-intent-binding.sql');
const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
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
    'CREATE OR REPLACE FUNCTION public.check_idempotency_intent(',
    'ALTER FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text)',
    'ALTER FUNCTION public.post_commission_payment(uuid, uuid, text)',
    'ALTER FUNCTION public.void_commission_payment(uuid, text, uuid, text)',
    "RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH'",
    "RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'",
    "RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'",
    'extensions.digest(',
  ]) {
    assert.ok(migration.includes(marker), `migration marker missing: ${marker}`);
  }
  for (const marker of [
    PASS_TOKEN,
    'changed commission selection was accepted',
    'a second actor consumed the receipt',
    'legacy unbound receipt was replayed',
    'a different payment was posted under the retained key',
    'a changed void reason was accepted',
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('disposable PostgreSQL container did not become ready');
}

function installBaseline() {
  psql(`
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
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
  id uuid PRIMARY KEY, role text NOT NULL, is_active boolean NOT NULL
);

-- Live shape, including the nullable result column, UNIQUE(idempotency_key),
-- and the two binding columns added live by
-- 20260803010917_bind_idempotency_to_mutation_intent.sql.
CREATE TABLE public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  operation text NOT NULL,
  result jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '24 hours'),
  request_fingerprint text,
  request_actor_id uuid
);

CREATE TABLE public.commission_payments (
  id uuid PRIMARY KEY, payment_number text NOT NULL, status text NOT NULL
);

-- Every business effect the payout implementations perform is recorded here so
-- the smoke can prove "performed exactly once".
CREATE TABLE public.proof_effects (
  id bigserial PRIMARY KEY, operation text NOT NULL,
  entity_id uuid NOT NULL, actor_id uuid NOT NULL
);

CREATE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path TO public, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND is_active = true AND role = 'admin'
  )
$fn$;

-- Live check_idempotency body.
CREATE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RETURN NULL; END IF;
  IF btrim(p_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_key, 0));
  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_key AND expires_at < now();
  SELECT * INTO v_existing FROM public.idempotency_keys WHERE idempotency_key = p_key;
  IF FOUND AND v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing.operation, p_operation;
  END IF;
  IF FOUND THEN RETURN v_existing.result; END IF;
  RETURN NULL;
END;
$fn$;

-- Live save_idempotency body.
CREATE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_existing_op text;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;
  SELECT operation INTO v_existing_op FROM public.idempotency_keys
   WHERE idempotency_key = p_key AND operation <> p_operation LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing_op, p_operation;
  END IF;
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$fn$;

-- Payout implementations: exact live signatures, guard order, and idempotency
-- contract; business bodies reduced to a recorded effect (see file header).
CREATE FUNCTION public.create_commission_payment(
  p_commission_ids uuid[], p_payment_method text, p_reference text,
  p_payment_date date, p_notes text,
  p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_actor uuid; v_existing jsonb; v_payment_id uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create a commission payment';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN (v_existing #>> '{}')::uuid; END IF;
  END IF;
  IF array_length(p_commission_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No commissions selected';
  END IF;
  v_payment_id := gen_random_uuid();
  INSERT INTO public.commission_payments (id, payment_number, status)
  VALUES (v_payment_id, 'CP-' || left(v_payment_id::text, 8), 'unposted');
  INSERT INTO public.proof_effects (operation, entity_id, actor_id)
  VALUES ('create_commission_payment', v_payment_id, v_actor);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_commission_payment', to_jsonb(v_payment_id::text));
  END IF;
  RETURN v_payment_id;
END;
$fn$;

CREATE FUNCTION public.post_commission_payment(
  p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_actor uuid; v_existing jsonb; v_payment record; v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_payment FROM public.commission_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission payment not found'; END IF;
  UPDATE public.commission_payments SET status = 'posted' WHERE id = p_payment_id;
  INSERT INTO public.proof_effects (operation, entity_id, actor_id)
  VALUES ('post_commission_payment', p_payment_id, v_actor);
  v_result := jsonb_build_object(
    'success', true, 'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number, 'commissions_paid', 2
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_commission_payment', v_result);
  END IF;
  RETURN v_result;
END;
$fn$;

CREATE FUNCTION public.void_commission_payment(
  p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $fn$
DECLARE
  v_actor uuid; v_existing jsonb; v_payment record; v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_payment FROM public.commission_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMMISSION_PAYMENT_NOT_FOUND'; END IF;
  UPDATE public.commission_payments SET status = 'voided' WHERE id = p_payment_id;
  INSERT INTO public.proof_effects (operation, entity_id, actor_id)
  VALUES ('void_commission_payment', p_payment_id, v_actor);
  v_result := jsonb_build_object(
    'success', true, 'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'commissions_reset', 2, 'commissions_cancelled_dead_order', 0
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_commission_payment', v_result);
  END IF;
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.check_idempotency(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_idempotency(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_commission_payment(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_commission_payment(uuid, text, uuid, text) TO authenticated, service_role;

INSERT INTO public.profiles (id, role, is_active) VALUES
  ('11111111-1111-1111-1111-111111111111', 'admin', true),
  ('22222222-2222-2222-2222-222222222222', 'admin', true),
  ('33333333-3333-3333-3333-333333333333', 'sales_rep', true);
`);
}

try {
  assertInputs();
  startContainer();
  installBaseline();
  psql(readFileSync(MIGRATION, 'utf8'));

  const smoke = psql(readFileSync(SMOKE, 'utf8'), { allowFailure: true });
  const output = `${smoke.stdout || ''}\n${smoke.stderr || ''}`;
  assert.notEqual(smoke.status, 0, 'rollback smoke unexpectedly committed');
  assert.match(output, new RegExp(PASS_TOKEN), output);

  console.log('COMMISSION_PAYOUT_INTENT_BINDING_PROOF_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
