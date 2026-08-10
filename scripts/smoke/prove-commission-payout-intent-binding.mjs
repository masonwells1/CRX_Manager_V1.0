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
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * Concurrent sibling of psql(): starts a real second backend so two sessions can
 * race on the same idempotency key. spawnSync cannot express that — the whole
 * point is that both connections are open at once.
 */
function psqlConcurrent(sql, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
       '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
      { cwd: ROOT },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (!quiet && status !== 0 && !stderr) reject(new Error('psql died with no output'));
      else resolve({ status, stdout, stderr });
    });
    child.stdin.end(sql);
  });
}

/** Single scalar, unaligned and untitled, so the caller compares a bare value. */
function psqlValue(sql) {
  return docker(
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
     '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: sql },
  ).stdout.trim();
}

const ACTOR_A = '11111111-1111-1111-1111-111111111111';

function concurrentCreate(commissionId, key) {
  // set_config is SESSION-scoped (is_local = false) on purpose: each statement
  // below autocommits, so a transaction-local setting would be gone by the time
  // the payout call runs.
  //
  // The race_gate barrier is what makes this a real race. Without it the two
  // "docker exec" processes start whole tenths of a second apart, so the first
  // session commits before the second one connects and the race never happens —
  // which is exactly how an earlier version of this test stayed green after the
  // advisory lock was deleted. Each session announces itself, then blocks until
  // BOTH have announced, so neither can call the payout function until the other
  // is connected and ready. crx.race_delay then holds the winner inside the
  // window between the receipt check and the receipt write.
  return `
SELECT set_config('request.jwt.claims', '{"sub":"${ACTOR_A}"}', false);
SELECT set_config('crx.race_delay', 'on', false);
INSERT INTO public.race_gate(session_tag) VALUES ('${commissionId}:${key}');
DO $gate$
BEGIN
  FOR i IN 1..1000 LOOP
    EXIT WHEN (SELECT count(*) FROM public.race_gate) >= 2;
    PERFORM pg_sleep(0.01);
  END LOOP;
  IF (SELECT count(*) FROM public.race_gate) < 2 THEN
    RAISE EXCEPTION 'RACE_BARRIER_TIMEOUT: the second session never arrived';
  END IF;
END
$gate$;
SELECT 'PAYMENT_ID=' || public.create_commission_payment(
  ARRAY['${commissionId}'::uuid], 'check', 'REF-CONC', DATE '2026-08-09',
  'concurrent', '${ACTOR_A}', '${key}'
);
`;
}

const RESET_CONCURRENCY_FIXTURE = `
CREATE TABLE IF NOT EXISTS public.race_gate (session_tag text);
TRUNCATE public.proof_effects, public.commission_payments, public.idempotency_keys,
         public.race_gate;
`;

/**
 * Only the ids the payout function actually returned. A bare UUID scan would
 * also match the actor uuid that `SELECT set_config('request.jwt.claims', ...)`
 * echoes on the FIRST line of stdout — and since both sessions use the same
 * actor, comparing those would make the identical-intent assertion below pass no
 * matter what the payout returned.
 */
function createdIds(run) {
  return [...run.stdout.matchAll(
    /PAYMENT_ID=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g,
  )].map((m) => m[1]);
}

/**
 * Two live backends hit the same retained key at the same moment. The advisory
 * lock inside check_idempotency_intent is the only thing serializing them, so
 * this is what proves there is no window where both sessions see "no receipt"
 * and both pay out.
 */
async function proveConcurrency() {
  // Different intents, same key: exactly one payout, and the loser is refused
  // rather than silently handed the winner's receipt.
  psql(RESET_CONCURRENCY_FIXTURE);
  const different = await Promise.all([
    psqlConcurrent(concurrentCreate('aaaaaaaa-0000-0000-0000-000000000001', 'key-race'), { quiet: true }),
    psqlConcurrent(concurrentCreate('aaaaaaaa-0000-0000-0000-000000000002', 'key-race'), { quiet: true }),
  ]);
  const winners = different.filter((r) => r.status === 0);
  const losers = different.filter((r) => r.status !== 0);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);
  assert.match(
    losers[0].stderr,
    /IDEMPOTENCY_INTENT_MISMATCH/,
    `losing session was not refused on intent:\n${losers[0].stderr}`,
  );
  assert.equal(
    psqlValue("SELECT count(*) FROM public.proof_effects WHERE operation = 'create_commission_payment';"),
    '1',
    'concurrent different-intent race did not pay out exactly once',
  );

  // Identical intents, same key: both callers succeed, both are told about the
  // SAME payment, and the payout happened once.
  psql(RESET_CONCURRENCY_FIXTURE);
  const same = await Promise.all([
    psqlConcurrent(concurrentCreate('aaaaaaaa-0000-0000-0000-000000000001', 'key-race-same'), { quiet: true }),
    psqlConcurrent(concurrentCreate('aaaaaaaa-0000-0000-0000-000000000001', 'key-race-same'), { quiet: true }),
  ]);
  for (const run of same) {
    assert.equal(run.status, 0, `identical-intent session failed:\n${run.stderr}`);
  }
  const [idA] = createdIds(same[0]);
  const [idB] = createdIds(same[1]);
  assert.ok(idA && idB, 'concurrent identical-intent sessions did not both return a payment id');
  assert.equal(idA, idB, 'concurrent identical-intent sessions returned different payments');
  assert.equal(
    psqlValue("SELECT count(*) FROM public.proof_effects WHERE operation = 'create_commission_payment';"),
    '1',
    'concurrent identical-intent race did not pay out exactly once',
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
    'changed reference was accepted',
    'changed payment date was accepted',
    'a second actor consumed the receipt',
    'legacy unbound receipt was replayed',
    'legacy unbound post receipt was replayed',
    'legacy unbound void receipt was replayed',
    'a different payment was posted under the retained key',
    'a changed void reason was accepted',
    'a NULL stored result was replayed as success',
    'a JSON null stored result was replayed as success',
    'a whitespace-only idempotency key was accepted',
    'cross-op message lost its detail',
    'forged p_performed_by was accepted on the post replay path',
    'forged p_performed_by was accepted on the void replay path',
    'NULL-key post wrote a receipt',
    'NULL-key void wrote a receipt',
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
  -- Off unless a concurrency session turns it on. It does not create a race
  -- window; it widens the one that already exists between the receipt check and
  -- the receipt write, so the two-backend proof is deterministic instead of
  -- depending on how fast two "docker exec" processes happen to start.
  IF current_setting('crx.race_delay', true) = 'on' THEN
    PERFORM pg_sleep(0.4);
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

  // Runs after the rollback smoke: this one COMMITS inside the disposable
  // container, because two backends cannot see each other's uncommitted work.
  await proveConcurrency();

  console.log('COMMISSION_PAYOUT_INTENT_BINDING_PROOF_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
