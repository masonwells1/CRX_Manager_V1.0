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
  '20260810170000_bind_commission_payout_idempotency_to_intent.sql',
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
TRUNCATE public.proof_effects, public.commission_payments, public.commission_payment_items,
         public.idempotency_keys, public.race_gate;
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
    "RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_commission_payment",
    "RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_commission_payment",
    "RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_commission_payment",
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
    'a NULL idempotency key was accepted by create',
    'a NULL idempotency key was accepted by post',
    'a NULL idempotency key was accepted by void',
    'the refused NULL-key create still paid out',
    'the refused NULL-key post still posted',
    'the refused NULL-key void still voided',
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

-- The migration's rename guard refuses to rename a public function that does not
-- look like the payout body it means to wrap, and one of the two markers it
-- requires is a touch of commission_payment_items. The live bodies all touch it;
-- the reduced bodies below must too, or this proof would exercise a wrapper
-- installed over something the real migration would have refused.
CREATE TABLE public.commission_payment_items (
  id bigserial PRIMARY KEY, payment_id uuid NOT NULL, commission_id uuid NOT NULL
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
  INSERT INTO public.commission_payment_items (payment_id, commission_id)
  SELECT DISTINCT v_payment_id, id FROM unnest(p_commission_ids) AS t(id);
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
    'payment_number', v_payment.payment_number,
    'commissions_paid', (
      SELECT count(*) FROM public.commission_payment_items WHERE payment_id = p_payment_id
    )
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
    'commissions_reset', (
      SELECT count(*) FROM public.commission_payment_items WHERE payment_id = p_payment_id
    ),
    'commissions_cancelled_dead_order', 0
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

/**
 * The rename step decides, from source text alone, whether the function it is
 * about to move into the private implementation slot really is the payout body.
 * Scanning text for markers is exactly the kind of check that reads fine and
 * does nothing, so prove it by handing it two bodies that LOOK right and must
 * still be refused. Each runs in its own transaction that never commits: the
 * expected failure aborts it, and the real migration below still starts from an
 * untouched baseline.
 */
/**
 * The lexer that reduces a candidate body to code, exercised directly.
 *
 * The migration drops _crx_payout_code_only_20260809 when it finishes, so this
 * lifts the CREATE statement straight out of the migration file and runs it in
 * a throwaway transaction. Direct calls are the only way to reach the
 * "unterminated X" refusals: a body Postgres itself could not parse never
 * reaches pg_proc, so those branches are unreachable through a real rename.
 * They are the fail-closed floor under every marker check, and an untested
 * guard is decoration.
 */
function proveCodeOnlyLexer() {
  const migration = readFileSync(MIGRATION, 'utf8');
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public._crx_payout_code_only_20260809');
  assert.notEqual(start, -1, 'the identity-check lexer is missing from the migration');
  const end = migration.indexOf('$code_only$;', start);
  assert.notEqual(end, -1, 'the identity-check lexer is not closed with $code_only$;');
  const create = migration.slice(start, end + '$code_only$;'.length);

  // Every case runs in its own transaction so a raise cannot poison the next.
  const call = (input, { allowFailure = false } = {}) => psql(
    `BEGIN;\n${create}\n`
    + `SELECT public._crx_payout_code_only_20260809($crx_in$${input}$crx_in$, 'the body');\n`
    + 'ROLLBACK;\n',
    { allowFailure },
  );

  // KEPT — these are code and must survive, or the guard would refuse the real
  // implementations and the migration could never apply at all.
  for (const [label, input, needle] of [
    ['a plain call', 'BEGIN PERFORM check_idempotency( x ); END;', 'check_idempotency('],
    ['a table reference', 'INSERT INTO commission_payment_items VALUES (1);', 'commission_payment_items'],
    ['a $1 parameter reference', 'SELECT f($1) FROM commission_payment_items;', '$1'],
    // The round-9 widening of the tag rule stops at digits and whitespace. Two
    // positional parameters on one line are the case it must NOT swallow: read
    // as a tag, everything between them would be blanked and the real
    // implementation would be refused.
    ['two positional parameters', 'SELECT f($1, $2) FROM commission_payment_items;', 'commission_payment_items'],
  ]) {
    const out = call(input);
    assert.ok(
      out.stdout.includes(needle),
      `the lexer ate ${label}, which would refuse the real implementation:\n${out.stdout}`,
    );
  }

  // BLANKED — each is a construct whose contents Postgres never executes. If
  // any survives, a body that only MENTIONS the markers gets renamed.
  for (const [label, input] of [
    ['a single-quoted literal', "RAISE NOTICE 'commission_payment_items';"],
    ['a dollar-quoted literal', 'RAISE NOTICE $msg$commission_payment_items$msg$;'],
    ['an empty-tag dollar-quoted literal', 'RAISE NOTICE $$commission_payment_items$$;'],
    // Round-9 finding: a dollar-quote tag is IDENTIFIER characters, and Postgres
    // identifiers are not ASCII-only. An [A-Za-z_] tag rule read this as CODE.
    ['a dollar-quoted literal with a non-ASCII tag', 'RAISE NOTICE $café$commission_payment_items$café$;'],
    // Round-10 finding: the tag was sought inside a fixed 256-character window,
    // so a legal longer tag was not recognised and the literal read as CODE.
    ['a dollar-quoted literal with a 260-character tag',
      `RAISE NOTICE $${'t'.repeat(260)}$commission_payment_items$${'t'.repeat(260)}$;`],
    ['an E-string with an escaped quote', "RAISE NOTICE E'commission_payment_items \\' still inside';"],
    ['a literal holding a -- comment opener', "RAISE NOTICE 'commission_payment_items -- x';"],
    ['a literal holding a */ comment closer', "RAISE NOTICE 'commission_payment_items */ x';"],
    ['a doubled quote inside a literal', "RAISE NOTICE 'commission_payment_items '' x';"],
    ['a line comment', '-- commission_payment_items'],
    ['a nested block comment', '/* outer /* inner */ commission_payment_items */'],
    ['a quoted identifier', 'SELECT 1 FROM "commission_payment_items";'],
  ]) {
    const out = call(input);
    assert.ok(
      !out.stdout.includes('commission_payment_items'),
      `the lexer left the marker readable inside ${label}:\n${out.stdout}`,
    );
  }

  // REFUSED — anything the lexer cannot terminate is a hard stop, never a pass.
  for (const [label, input, expected] of [
    ['an unterminated block comment', 'x /* y', /unterminated block comment/],
    ['an unterminated string literal', "x 'y", /unterminated string literal/],
    ['an unterminated dollar-quoted string', 'x $t$ y', /unterminated dollar-quoted string/],
    ['an unterminated quoted identifier', 'x "y', /unterminated quoted identifier/],
    ['a block comment closed only once', '/* a /* b */', /unterminated block comment/],
  ]) {
    const out = call(input, { allowFailure: true });
    const text = `${out.stdout || ''}\n${out.stderr || ''}`;
    assert.notEqual(out.status, 0, `the lexer accepted ${label}:\n${text}`);
    assert.match(text, expected, `wrong refusal for ${label}:\n${text}`);
  }
}

function proveIdentityGuard() {
  const migration = readFileSync(MIGRATION, 'utf8');
  const SIGNATURE = 'public.create_commission_payment(uuid[], text, text, date, text, uuid, text)';
  // Each decoy is a body Postgres accepts and that a human would read as "this
  // is not the payout implementation", carrying both markers in a place that
  // never executes. One per way a regex strip used to be defeated.
  const REFUSED = /does not look like the payout implementation/;
  const DECOYS = [
    ['markers that exist only inside a string literal',
      "BEGIN\n  RAISE NOTICE 'check_idempotency( commission_payment_items';\n  RETURN NULL;\nEND;",
      REFUSED],
    // Postgres block comments NEST. Everything here is commented out, but a
    // non-greedy /\*.*?\*/ strip stops at the inner '*/' and leaves the markers
    // looking like live code — the one direction in which a strip can
    // FABRICATE a marker rather than remove one.
    ['markers that survive only as nested-comment residue',
      'BEGIN\n  /* outer /* inner */ check_idempotency( commission_payment_items */\n  RETURN NULL;\nEND;',
      REFUSED],
    // A '...' regex cannot see a dollar-quoted literal at all.
    ['markers inside a dollar-quoted diagnostic',
      'BEGIN\n  RAISE NOTICE $msg$check_idempotency( commission_payment_items$msg$;\n  RETURN NULL;\nEND;',
      REFUSED],
    // Stripping comments BEFORE literals deletes this literal's closing quote,
    // after which no '...' regex can match the now-unterminated remainder and
    // both markers survive into the LIKE.
    ['markers in a literal whose closing quote a -- strip would eat',
      "BEGIN\n  RAISE NOTICE 'check_idempotency( commission_payment_items -- diagnostic';\n  RETURN NULL;\nEND;",
      REFUSED],
    // Backslash-escaped quotes break naive quote pairing, so the literal looks
    // like it ends early and its tail reads as code.
    ['markers in an E-string with an escaped quote',
      "BEGIN\n  RAISE NOTICE E'a \\' check_idempotency( commission_payment_items';\n  RETURN NULL;\nEND;",
      REFUSED],
    // A '*/' inside a literal is not a comment terminator, but a comment-first
    // strip treats it as one.
    ['markers in a literal holding a comment terminator',
      "BEGIN\n  RAISE NOTICE 'x /* y'; RAISE NOTICE 'check_idempotency( commission_payment_items */';\n  RETURN NULL;\nEND;",
      REFUSED],
    // Legal identifiers, so this body parses — but it calls nothing.
    ['markers that are only quoted identifiers',
      'BEGIN\n  PERFORM 1 FROM "commission_payment_items" WHERE "check_idempotency(" IS NULL;\n  RETURN NULL;\nEND;',
      REFUSED],
    // Round-9 finding: the markers were matched as bare SUBSTRINGS, so a body
    // that calls a DIFFERENT function and writes a DIFFERENT table satisfied
    // both while doing neither. Now anchored on identifier boundaries.
    ['markers that are only the tails of longer identifiers',
      'BEGIN\n  PERFORM fakecheck_idempotency(1);\n  INSERT INTO archived_commission_payment_items VALUES (1);\n  RETURN NULL;\nEND;',
      REFUSED],
    // Round-9 finding: the lexer treats backslash as an escape only inside
    // E'…', which holds only while standard_conforming_strings is on. A body
    // that turns it off is unreadable rather than safe, so it is refused before
    // the markers are even looked at — note this body carries REAL markers.
    ['a body that turns off standard_conforming_strings',
      'BEGIN\n  PERFORM check_idempotency(1);\n  INSERT INTO commission_payment_items VALUES (1);\n  RETURN NULL;\nEND;',
      /sets standard_conforming_strings off/,
      'SET standard_conforming_strings TO off\n'],
    // Round-10 finding: the boundary was '[^A-Za-z0-9_$]', but Postgres allows
    // letters with diacriticals in unquoted identifiers — so the 'é' READ AS a
    // boundary and these two entirely different names satisfied both markers.
    // The boundary is now a whitelist of ASCII characters that may legally abut
    // a call, so any letter, ASCII or not, fails closed.
    // Every marker here is abutted by 'é' on the side the old blacklist would
    // have accepted, so the old rule passed this body on BOTH predicates. An
    // ASCII tail on one side only would not have proven it: the table marker
    // still has to fail on its LEADING character, or a blacklist that keeps
    // rejecting '_commission_payment_items' would look like a working guard.
    ['markers that are only parts of longer non-ASCII identifiers',
      'BEGIN\n  PERFORM fakeécheck_idempotency(1);\n  INSERT INTO écommission_payment_itemsé VALUES (1);\n  RETURN NULL;\nEND;',
      REFUSED],
    // Round-10 finding: the dollar-tag reader searched a fixed 256-character
    // window. Postgres puts no length limit on a tag, so a longer one was not
    // recognised, the '$' was emitted as ordinary code, and the whole literal
    // — markers included — was read as executable SQL.
    ['markers inside a dollar-quoted literal with a 260-character tag',
      `BEGIN\n  RAISE NOTICE $${'t'.repeat(260)}$check_idempotency( commission_payment_items$${'t'.repeat(260)}$;\n  RETURN NULL;\nEND;`,
      REFUSED],
    // Round-10 finding: prosrc is language-dependent. For a SQL-standard
    // BEGIN ATOMIC body it is not the source, and for a C function it is a
    // symbol name; parsing any of those as PL/pgSQL is meaningless. Refused on
    // the language, before the markers are looked at.
    ['a body that is not plpgsql at all',
      'SELECT NULL::uuid',
      /is not a plpgsql function with a readable source/,
      '',
      'sql'],
  ];

  for (const [label, body, expected, extraConfig = '', lang = 'plpgsql'] of DECOYS) {
    const run = psql(
      `BEGIN;\nDROP FUNCTION ${SIGNATURE};\n`
      + 'CREATE FUNCTION public.create_commission_payment(\n'
      + '  p_commission_ids uuid[], p_payment_method text, p_reference text,\n'
      + '  p_payment_date date, p_notes text,\n'
      + '  p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text\n'
      + `) RETURNS uuid LANGUAGE ${lang} SECURITY DEFINER SET search_path TO public, pg_temp\n`
      + extraConfig
      + `AS $decoy$\n${body}\n$decoy$;\n`
      + `${migration}\nROLLBACK;\n`,
      { allowFailure: true },
    );
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    assert.notEqual(run.status, 0, `the rename adopted a body with ${label}:\n${output}`);
    assert.match(output, expected, `wrong refusal for ${label}:\n${output}`);
  }

  // Every decoy must be gone, or the migration applied next would be wrapping a
  // fake body and every assertion after it would be meaningless. (That the
  // guard is not simply refusing everything is proven by the next step: the
  // genuine baseline body goes through it and the migration applies clean.)
  assert.equal(
    psqlValue(`SELECT to_regprocedure('${SIGNATURE}') IS NOT NULL;`), 't',
    'the decoy transactions did not roll back',
  );
}

/**
 * The replay path — round-9 HIGH.
 *
 * The rename is skipped when the private implementation already exists, and
 * that skip used to carry the identity check away with it. So a re-run over a
 * partially-applied migration, or over ANY function that happened to occupy the
 * implementation name, wrapped a body this file had never validated: the
 * wrapper would then bind a receipt, call the impostor, and report a successful
 * payout for whatever it did. The name is not evidence.
 *
 * Proved in both directions — a wrong body under the implementation name is
 * refused, and a genuine second application still succeeds.
 */
function proveReplayIdentityGuard() {
  const migration = readFileSync(MIGRATION, 'utf8');
  const IMPL = '_create_commission_payment_intent_impl_20260809';
  const HEADER =
    '  p_commission_ids uuid[], p_payment_method text, p_reference text,\n'
    + '  p_payment_date date, p_notes text,\n'
    + '  p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text\n'
    + ') RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp\n';
  // Markers inside a literal: this body would fail the marker check too, so the
  // assertion below proves it is refused EARLIER, on the state itself.
  const DECOY_BODY =
    "AS $decoy$\nBEGIN\n  RAISE NOTICE 'check_idempotency( commission_payment_items';\n  RETURN NULL;\nEND;\n$decoy$;\n";

  // A. Round-10 finding. The implementation name is occupied while the PUBLIC
  //    function is still the unwrapped original — a state this migration cannot
  //    have produced, because its own rename would have taken that function
  //    away. Refused on the state, without ever reaching the marker check.
  const planted = psql(
    `BEGIN;\nCREATE FUNCTION public.${IMPL}(\n${HEADER}${DECOY_BODY}${migration}\nROLLBACK;\n`,
    { allowFailure: true },
  );
  const plantedOut = `${planted.stdout || ''}\n${planted.stderr || ''}`;
  assert.notEqual(planted.status, 0, `the migration wrapped an unvalidated implementation:\n${plantedOut}`);
  assert.match(
    plantedOut,
    new RegExp(`public\\.${IMPL} already exists while public\\.create_commission_payment`),
    `wrong refusal on the replay path:\n${plantedOut}`,
  );
  assert.equal(
    psqlValue(`SELECT to_regprocedure('public.${IMPL}(uuid[], text, text, date, text, uuid, text)') IS NULL;`),
    't',
    'the replay decoy transaction did not roll back',
  );

  // B. The state check passing is not the whole guard. Apply the migration for
  //    real, so the public function IS the wrapper and the replay state is
  //    legitimate, then swap the implementation underneath it. The marker check
  //    has to catch that on its own — otherwise "already applied" would be a
  //    standing invitation to replace the body a completed apply left behind.
  const swapped = psql(
    `BEGIN;\n${migration}\n`
    + `CREATE OR REPLACE FUNCTION public.${IMPL}(\n${HEADER}${DECOY_BODY}`
    + `${migration}\nROLLBACK;\n`,
    { allowFailure: true },
  );
  const swappedOut = `${swapped.stdout || ''}\n${swapped.stderr || ''}`;
  assert.notEqual(swapped.status, 0, `a swapped implementation was re-adopted unchecked:\n${swappedOut}`);
  assert.match(
    swappedOut,
    new RegExp(`public\\.${IMPL} does not look like the payout implementation`),
    `wrong refusal for a swapped implementation:\n${swappedOut}`,
  );
  assert.equal(
    psqlValue(`SELECT to_regprocedure('public.${IMPL}(uuid[], text, text, date, text, uuid, text)') IS NULL;`),
    't',
    'the swapped-implementation transaction did not roll back',
  );
}

try {
  assertInputs();
  startContainer();
  installBaseline();
  proveCodeOnlyLexer();
  proveIdentityGuard();
  proveReplayIdentityGuard();
  psql(readFileSync(MIGRATION, 'utf8'));

  // Re-runnability. The identity check the replay path now performs must accept
  // the implementation this migration itself installed, or the migration would
  // pass once and then refuse to run again — which is how a half-applied
  // deployment gets stuck with no way forward.
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
