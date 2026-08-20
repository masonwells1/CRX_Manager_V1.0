#!/usr/bin/env node
/**
 * Disposable proof for 20260819232000. No DB URL is read and no Supabase
 * connection is possible: PostgreSQL 17 runs in a unique --network none
 * container with tmpfs storage and is force-removed in finally.
 *
 * The migration is applied verbatim. Its preserved draw implementation is a
 * faithful effect-recording stand-in because this migration renames that body
 * without editing it; the checked-in full-schema rollback smoke owns the
 * tier-price/cost/profit/inventory assertions. This prover owns the new wrapper:
 * SQL parsing, pre/postflight, auth and live-quote order, canonical intent,
 * receipt binding, key-race serialization, ACLs, and exact replay behavior.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTAINER = `crx-draw-intent-proof-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260819232000_bind_draw_down_receipts_to_intent.sql',
);
const SHARED_HELPER_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260811130000_bind_commission_payout_idempotency_to_intent.sql',
);
const TIER_SPLIT_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260816120000_draw_down_split_order_lines_by_price_tier.sql',
);
const ALLOCATED_CENTS_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260817120000_carry_allocated_line_cents_through_lifecycle.sql',
);

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const ACTOR_ADMIN = '33333333-3333-3333-3333-333333333333';
const ACTOR_INACTIVE = '44444444-4444-4444-4444-444444444444';
const ACTOR_MISSING = '55555555-5555-5555-5555-555555555555';
const QUOTE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const QUOTE_B = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
const QUOTE_DELETED = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3';
const PRODUCT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
    killSignal: 'SIGTERM',
  });
  if (result.error) {
    if (!allowFailure) throw result.error;
    return {
      ...result,
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? String(result.error.message ?? result.error),
    };
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql, { db = 'postgres', allowFailure = false, tuples = false } = {}) {
  const args = [
    'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db,
    '-X', '-q', '-v', 'ON_ERROR_STOP=1',
  ];
  if (tuples) args.push('-t', '-A');
  return docker(args, { input: sql, allowFailure });
}

function value(sql, db = 'postgres') {
  return psql(sql, { db, tuples: true }).stdout.trim();
}

function concurrentCall(sql, db = 'postgres') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db,
        '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
      ],
      { cwd: ROOT },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function extractSharedHelper() {
  const source = readFileSync(SHARED_HELPER_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.check_idempotency_intent(');
  const endMarker = '-- ---------------------------------------------------------------------------\n-- Identity-check helper';
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'could not extract the real shared intent helper');
  return source.slice(start, end);
}

function extractFunctionStatement(source, name) {
  const starts = [
    `CREATE OR REPLACE FUNCTION public.${name}(`,
    `CREATE FUNCTION public.${name}(`,
  ].map((marker) => source.indexOf(marker)).filter((index) => index >= 0);
  const start = Math.min(...starts);
  const bodyStart = source.indexOf('AS $function$', start);
  const endMarker = '\n$function$;';
  const end = source.indexOf(endMarker, bodyStart);
  assert.ok(Number.isFinite(start) && start >= 0 && bodyStart > start && end > bodyStart,
    `could not extract ${name}`);
  return source.slice(start, end + endMarker.length);
}

function extractReviewedPrerequisites() {
  const tierSplit = readFileSync(TIER_SPLIT_PATH, 'utf8');
  const allocatedCents = readFileSync(ALLOCATED_CENTS_PATH, 'utf8');
  return [
    extractFunctionStatement(tierSplit, '_draw_down_quote_below_cost_impl_20260810'),
    extractFunctionStatement(allocatedCents, '_allocated_cumulative_cents'),
    extractFunctionStatement(allocatedCents, '_allocated_delivery_cents'),
    extractFunctionStatement(allocatedCents, '_complete_delivery_authorized_impl'),
    extractFunctionStatement(allocatedCents, '_create_invoice_for_unbilled_delivery_impl_20260718'),
    extractFunctionStatement(allocatedCents, '_close_undelivered_order_remainder_20260718'),
  ].join('\n\n');
}

const FIXTURE = `
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$roles$;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  is_active boolean NOT NULL
);
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.idempotency_keys (
  idempotency_key text PRIMARY KEY,
  operation text NOT NULL,
  result jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  request_fingerprint text,
  request_actor_id uuid
);
CREATE TABLE public.proof_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  draws jsonb NOT NULL
);

INSERT INTO public.profiles(id, role, is_active) VALUES
  ('${ACTOR_A}', 'sales_rep', true),
  ('${ACTOR_B}', 'sales_rep', true),
  ('${ACTOR_ADMIN}', 'admin', true),
  ('${ACTOR_INACTIVE}', 'sales_rep', false);
INSERT INTO public.quotes(id, created_by, deleted_at) VALUES
  ('${QUOTE_A}', '${ACTOR_B}', NULL),
  ('${QUOTE_B}', '${ACTOR_B}', NULL),
  ('${QUOTE_DELETED}', '${ACTOR_B}', now());

CREATE FUNCTION public.check_idempotency(p_key text, p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE v_result jsonb;
BEGIN
  IF p_key IS NULL THEN RETURN NULL; END IF;
  SELECT result INTO v_result
  FROM public.idempotency_keys
  WHERE idempotency_key = p_key AND operation = p_operation AND expires_at > now();
  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.idempotency_keys(idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$function$;

CREATE FUNCTION public._begin_below_cost_money_write(p_operation text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN RETURN; END; $function$;

CREATE FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_result jsonb;
BEGIN
  PERFORM 1 FROM public.quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'draw_down_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  INSERT INTO public.proof_effects(quote_id, actor_id, draws)
  VALUES (p_quote_id, v_actor, p_draws)
  RETURNING id INTO v_order_id;
  IF current_setting('crx.proof_delay', true) = 'on' THEN
    PERFORM pg_sleep(1);
  END IF;
  v_result := jsonb_build_object('success', true, 'order_id', v_order_id);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'draw_down_quote', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)
  TO postgres;

CREATE FUNCTION public.draw_down_quote(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(20260816, 1) THEN
    RAISE EXCEPTION 'DRAW_DOWN_CUTOVER_IN_PROGRESS';
  END IF;
  PERFORM public._begin_below_cost_money_write('draw_down_quote');
  RETURN public._draw_down_quote_below_cost_impl_20260810(
    p_quote_id, p_draws, p_performed_by, p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)
  TO authenticated, service_role;
`;

function callSql({
  actor = ACTOR_A,
  performedBy = actor,
  quote = QUOTE_A,
  quantity = '1',
  key,
  delay = false,
}) {
  const performedBySql = performedBy === null ? 'NULL' : `'${performedBy}'::uuid`;
  return `
SELECT set_config('request.jwt.claim.sub', '${actor}', false);
SELECT set_config('crx.proof_delay', '${delay ? 'on' : 'off'}', false);
SELECT 'RESULT=' || public.draw_down_quote(
  '${quote}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', ${quantity})),
  ${performedBySql},
  '${key}',
  NULL
)::text;
`;
}

function resultId(run) {
  return /RESULT=.*"order_id": "([0-9a-f-]{36})"/.exec(run.stdout)?.[1];
}

function bootstrap(db, migration) {
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  psql(extractReviewedPrerequisites(), { db });
  psql(migration, { db });
  const standIn = extractFunctionStatement(
    FIXTURE,
    '_draw_down_quote_below_cost_impl_20260810',
  ).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  psql(standIn, { db });
}

function proveAuthorization(db) {
  const admin = psql(`BEGIN;${callSql({ actor: ACTOR_ADMIN, key: 'draw-admin' })}ROLLBACK;`, {
    db,
    tuples: true,
  });
  assert.ok(resultId(admin), 'active admin could not draw a colleague booking');

  const authMissing = psql(`
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', 1)),
  NULL,
  'draw-no-auth',
  NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(authMissing.status, 0, 'missing auth was accepted');
  assert.match(authMissing.stderr, /AUTH_REQUIRED/);

  const actorMismatch = psql(callSql({
    actor: ACTOR_A,
    performedBy: ACTOR_B,
    key: 'draw-actor-param-mismatch',
  }), { db, allowFailure: true, tuples: true });
  assert.notEqual(actorMismatch.status, 0, 'mismatched p_performed_by was accepted');
  assert.match(actorMismatch.stderr, /ACTOR_MISMATCH/);

  for (const [actor, label] of [
    [ACTOR_INACTIVE, 'inactive profile'],
    [ACTOR_MISSING, 'missing profile'],
  ]) {
    const refused = psql(callSql({ actor, key: `draw-${label.replace(' ', '-')}` }), {
      db,
      allowFailure: true,
      tuples: true,
    });
    assert.notEqual(refused.status, 0, `${label} was accepted`);
    assert.match(refused.stderr, /INSUFFICIENT_ROLE/);
  }
}

function proveSequential(db) {
  const keyless = psql(`BEGIN;
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT 'RESULT=' || public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', 1)),
  '${ACTOR_A}'::uuid,
  NULL,
  NULL
)::text;
ROLLBACK;`, { db, tuples: true });
  assert.ok(resultId(keyless), 'valid keyless request did not reach the preserved implementation');

  const keylessEmpty = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid, '[]'::jsonb, '${ACTOR_A}'::uuid, NULL, NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(keylessEmpty.status, 0, 'empty keyless request bypassed the outer guard');
  assert.match(keylessEmpty.stderr, /EMPTY_DRAW/);

  const keylessNonFinite = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT}'::uuid, 'quantity', 'NaN')),
  '${ACTOR_A}'::uuid,
  NULL,
  NULL
);`, { db, allowFailure: true, tuples: true });
  assert.notEqual(keylessNonFinite.status, 0, 'non-finite keyless request bypassed the outer guard');
  assert.match(keylessNonFinite.stderr, /BOOKING_QUANTITY_INVALID/);

  const first = psql(callSql({ key: 'draw-sequential' }), { db, tuples: true });
  const replay = psql(`
SELECT set_config('request.jwt.claim.sub', '${ACTOR_A}', false);
SELECT 'RESULT=' || public.draw_down_quote(
  '${QUOTE_A}'::uuid,
  jsonb_build_array(jsonb_build_object('quantity', 1.00, 'product_id', '${PRODUCT}'::uuid)),
  '${ACTOR_A}'::uuid,
  'draw-sequential',
  'retry metadata is not mutation identity'
)::text;`, { db, tuples: true });
  assert.equal(resultId(replay), resultId(first), 'numeric-equivalent exact replay changed order id');

  const changed = psql(callSql({ quantity: '2', key: 'draw-sequential' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(changed.status, 0, 'changed draw quantity replayed stale success');
  assert.match(changed.stderr, /IDEMPOTENCY_INTENT_MISMATCH/);

  const actor = psql(callSql({ actor: ACTOR_B, key: 'draw-sequential' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(actor.status, 0, 'different actor replayed stale success');
  assert.match(actor.stderr, /IDEMPOTENCY_ACTOR_MISMATCH/);

  const deleted = psql(callSql({ actor: ACTOR_B, quote: QUOTE_DELETED, key: 'draw-deleted' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(deleted.status, 0, 'soft-deleted quote reached replay/work');
  assert.match(deleted.stderr, /Quote not found/);

  const nonFinite = psql(callSql({ quantity: "'NaN'", key: 'draw-non-finite' }), {
    db,
    allowFailure: true,
    tuples: true,
  });
  assert.notEqual(nonFinite.status, 0, 'non-finite draw quantity was accepted');
  assert.match(nonFinite.stderr, /BOOKING_QUANTITY_INVALID/);

  assert.equal(value('SELECT count(*) FROM public.proof_effects;', db), '1');
  assert.equal(
    value("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='draw-sequential' AND request_actor_id IS NOT NULL AND request_fingerprint IS NOT NULL;", db),
    '1',
  );
  assert.equal(
    value("SELECT has_function_privilege('authenticated', 'public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)', 'EXECUTE');", db),
    'f',
  );
  assert.equal(
    value("SELECT has_function_privilege('authenticated', 'public.draw_down_quote(uuid,jsonb,uuid,text,text)', 'EXECUTE');", db),
    't',
  );
  assert.equal(
    value("SELECT has_function_privilege('service_role', 'public.draw_down_quote(uuid,jsonb,uuid,text,text)', 'EXECUTE');", db),
    'f',
  );
}

async function proveConcurrency(db) {
  const different = await Promise.all([
    concurrentCall(callSql({ quote: QUOTE_A, key: 'draw-race-different', delay: true }), db),
    concurrentCall(callSql({ quote: QUOTE_B, key: 'draw-race-different', delay: true }), db),
  ]);
  assert.equal(different.filter((run) => run.status === 0).length, 1);
  const loser = different.find((run) => run.status !== 0);
  assert.match(loser?.stderr ?? '', /IDEMPOTENCY_INTENT_MISMATCH/);
  assert.equal(
    value(`SELECT count(*) FROM public.proof_effects WHERE quote_id IN ('${QUOTE_A}', '${QUOTE_B}') AND id <> (SELECT (result->>'order_id')::uuid FROM public.idempotency_keys WHERE idempotency_key='draw-sequential');`, db),
    '1',
    'different-intent same-key race performed more than once',
  );

  const same = await Promise.all([
    concurrentCall(callSql({ quote: QUOTE_A, key: 'draw-race-same', delay: true }), db),
    concurrentCall(callSql({ quote: QUOTE_A, key: 'draw-race-same', delay: true }), db),
  ]);
  for (const run of same) assert.equal(run.status, 0, run.stderr);
  assert.ok(resultId(same[0]) && resultId(same[1]));
  assert.equal(resultId(same[0]), resultId(same[1]));
  assert.equal(
    value("SELECT count(*) FROM public.proof_effects WHERE id = (SELECT (result->>'order_id')::uuid FROM public.idempotency_keys WHERE idempotency_key='draw-race-same');", db),
    '1',
  );
}

function proveMutation(migration) {
  psql('CREATE DATABASE draw_intent_mutant;');
  const broken = migration.replace(
    "'draws', v_canonical_draws",
    "'draws', '[]'::jsonb /* 'draws', v_canonical_draws */",
  );
  assert.notEqual(broken, migration, 'fingerprint mutation was not planted');
  bootstrap('draw_intent_mutant', broken);
  const first = psql(callSql({ key: 'draw-mutant' }), {
    db: 'draw_intent_mutant',
    tuples: true,
  });
  const stale = psql(callSql({ quantity: '2', key: 'draw-mutant' }), {
    db: 'draw_intent_mutant',
    tuples: true,
  });
  assert.equal(
    resultId(stale),
    resultId(first),
    'broken fingerprint did not reproduce stale-success replay',
  );
  console.log('MUTATION_DETECTED: removing draw quantities from identity replays stale success');
}

function provePrerequisiteBodyGuard(migration) {
  psql('CREATE DATABASE draw_prerequisite_mutant;');
  const db = 'draw_prerequisite_mutant';
  psql(FIXTURE, { db });
  psql(extractSharedHelper(), { db });
  const reviewed = extractReviewedPrerequisites();
  psql(reviewed, { db });
  const mutated = extractFunctionStatement(
    readFileSync(TIER_SPLIT_PATH, 'utf8'),
    '_draw_down_quote_below_cost_impl_20260810',
  ).replace('-- TIERSPLIT<<<', '-- MUTATED TIERSPLIT<<<');
  psql(mutated, { db });
  const blocked = psql(migration, { db, allowFailure: true });
  assert.notEqual(blocked.status, 0, 'drifted pricing body passed the prerequisite hash gate');
  assert.match(blocked.stderr, /reviewed pricing\/lifecycle prerequisite body drifted/);
  console.log('MUTATION_DETECTED: drifted tier-split body is refused before wrapping');
}

async function main() {
  for (const file of [MIGRATION_PATH, SHARED_HELPER_PATH, TIER_SPLIT_PATH, ALLOCATED_CENTS_PATH]) {
    assert.ok(existsSync(file), `missing checked-in proof input: ${file}`);
  }
  const migration = readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(migration, /check_idempotency_intent/);
  assert.match(migration, /request_fingerprint = v_fingerprint/);

  try {
    docker([
      'run', '--rm', '-d', '--name', CONTAINER, '--network', 'none',
      '--tmpfs', '/var/lib/postgresql/data:rw',
      '-e', 'POSTGRES_PASSWORD=proof-only',
      'postgres:17',
    ]);
    let readyStreak = 0;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const ready = docker(
        ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
        { allowFailure: true },
      );
      readyStreak = ready.status === 0 ? readyStreak + 1 : 0;
      if (readyStreak >= 3) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      if (attempt === 149) throw new Error('PostgreSQL container did not become ready');
    }

    bootstrap('postgres', migration);
    proveAuthorization('postgres');
    proveSequential('postgres');
    await proveConcurrency('postgres');
    proveMutation(migration);
    provePrerequisiteBodyGuard(migration);

    console.log('DRAW_DOWN_INTENT_BINDING_PROOF_OK');
    console.log('  migration applied verbatim with preflight/postflight');
    console.log('  admin/rep allow, missing/inactive/auth/actor refusals: PASS');
    console.log('  keyed/keyless input guards plus valid keyless delegation: PASS');
    console.log('  exact replay, changed/non-finite quantity, changed receipt actor, deleted quote: PASS');
    console.log('  different-intent and same-intent concurrent key races: PASS');
    console.log('  exact pricing/lifecycle prerequisite hashes and drift mutation: PASS');
    console.log('  network: none; storage: tmpfs; live Supabase: untouched');
  } finally {
    docker(['rm', '-f', CONTAINER], { allowFailure: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
