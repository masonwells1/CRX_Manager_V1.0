import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source guard for the Section 07 gauntlet HIGH finding: the commission payout
 * RPCs keyed their idempotency receipts on [operation, user] only, so a
 * retained browser key could replay a DIFFERENT payout's cached success.
 * 20260810130500 binds each receipt to the acting user and a hash of the exact
 * request. These assertions keep both halves — the SQL wrappers and their
 * page-level callers — from silently losing that binding.
 */
const MIGRATION_PATH =
  'supabase/migrations/20260810130500_bind_commission_payout_idempotency_to_intent.sql';

const migration = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
const page = readFileSync('src/pages/CommissionPayments.tsx', 'utf8').replace(/\r\n/g, '\n');

const PAYOUT_RPCS = [
  {
    name: 'create_commission_payment',
    signature: 'uuid[], text, text, date, text, uuid, text',
    impl: '_create_commission_payment_intent_impl_20260809',
  },
  {
    name: 'post_commission_payment',
    signature: 'uuid, uuid, text',
    impl: '_post_commission_payment_intent_impl_20260809',
  },
  {
    name: 'void_commission_payment',
    signature: 'uuid, text, uuid, text',
    impl: '_void_commission_payment_intent_impl_20260809',
  },
] as const;

function wrapperBody(name: string): string {
  const start = migration.indexOf(`CREATE FUNCTION public.${name}(`);
  expect(start, `${name} wrapper is missing`).toBeGreaterThan(-1);
  const end = migration.indexOf('$function$;', start);
  expect(end, `${name} wrapper is unterminated`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('commission payout intent-binding migration', () => {
  it('gates cached receipts on both the actor and the exact request', () => {
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.check_idempotency_intent(');
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start, migration.indexOf('$function$;', start));

    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain('v_existing.request_actor_id IS DISTINCT FROM p_actor');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH'");
    expect(body).toContain('v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE'");
    expect(body).toContain('SET search_path = public, pg_temp');

    // Receipts written before this migration carry neither binding column and
    // their original intent is unknowable, so they must fail closed rather than
    // replay as the current request.
    const legacyBridge = body.indexOf('v_existing.request_actor_id IS NULL');
    const actorGate = body.indexOf('v_existing.request_actor_id IS DISTINCT FROM p_actor');
    expect(legacyBridge).toBeGreaterThan(-1);
    expect(legacyBridge).toBeLessThan(actorGate);
    expect(body.slice(legacyBridge, actorGate)).toContain(
      'AND v_existing.request_fingerprint IS NULL',
    );
  });

  it.each(PAYOUT_RPCS)('$name fingerprints its own request before touching a receipt', (rpc) => {
    const body = wrapperBody(rpc.name);

    expect(body).toContain('extensions.digest(');
    expect(body).toContain("'sha256'");
    expect(body).toContain("'actor_id', v_actor");
    expect(body).toContain(
      `public.check_idempotency_intent(\n    p_idempotency_key, '${rpc.name}', v_actor, v_fingerprint\n  )`,
    );
    // The fingerprint has to be computed from THIS call's arguments before the
    // receipt lookup, otherwise the lookup has nothing to compare against.
    expect(body.indexOf('v_fingerprint := encode(')).toBeLessThan(
      body.indexOf('check_idempotency_intent('),
    );
  });

  it.each(PAYOUT_RPCS)('$name replays the committed receipt instead of re-running the payout', (rpc) => {
    const body = wrapperBody(rpc.name);
    const replayStart = body.indexOf('IF v_replay IS NOT NULL THEN');
    expect(replayStart).toBeGreaterThan(-1);
    const replayBlock = body.slice(replayStart, body.indexOf('END IF;\n\n', replayStart));

    // Delegating on replay would re-enter the implementation's operation-only
    // check_idempotency, which reads a NULL stored result as "never happened"
    // and would pay out a second time.
    expect(replayBlock).not.toContain(`public.${rpc.impl}(`);
    expect(replayBlock).toContain("jsonb_typeof(v_replay -> 'result') = 'null'");
    expect(replayBlock).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'");
  });

  it.each(PAYOUT_RPCS)('$name stamps the binding columns after doing real work', (rpc) => {
    const body = wrapperBody(rpc.name);
    const update = body.indexOf('UPDATE public.idempotency_keys');
    expect(update).toBeGreaterThan(body.indexOf(`public.${rpc.impl}(`));
    const updateBlock = body.slice(update);
    expect(updateBlock).toContain('SET request_fingerprint = v_fingerprint');
    expect(updateBlock).toContain('request_actor_id = v_actor');
    expect(updateBlock).toContain(`AND operation = '${rpc.name}'`);
    expect(updateBlock).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'");
  });

  it.each(PAYOUT_RPCS)('$name keeps its renamed implementation out of the browser', (rpc) => {
    expect(migration).toContain(
      `ALTER FUNCTION public.${rpc.name}(${rpc.signature})\n  RENAME TO ${rpc.impl}`,
    );
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${rpc.impl}(${rpc.signature})`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${rpc.name}(${rpc.signature})`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc.name}(${rpc.signature})`);
  });

  it('verifies overload uniqueness and grants in the same transaction', () => {
    const verify = migration.slice(migration.indexOf('DO $verify$'));
    expect(verify).toContain('overload count = % (expected 1)');
    expect(verify).toContain('anonymous execution must remain revoked');
    expect(verify).toContain('authenticated execution grant missing');
    expect(verify).toContain('internal payout implementations must not be browser-executable');
  });
});

describe('commission payout intent-binding callers', () => {
  it('imports the shared refusal classifier rather than matching raw codes', () => {
    expect(page).toContain(
      "import { getIdempotencyBindingRejection } from '../lib/idempotency';",
    );
  });

  it.each([
    ['create_commission_payment', 'createPaymentIdem'],
    ['post_commission_payment', 'postPaymentIdem'],
    ['void_commission_payment', 'voidPaymentIdem'],
  ])('%s handles a refused key and retires it', (rpcName, idemHandle) => {
    const call = page.indexOf(`supabase.rpc('${rpcName}'`);
    expect(call, `${rpcName} caller is missing`).toBeGreaterThan(-1);
    const nextCatch = page.indexOf('} catch (err: unknown) {', call);
    expect(nextCatch).toBeGreaterThan(call);
    const catchBlock = page.slice(nextCatch, page.indexOf('\n  };', nextCatch));

    expect(catchBlock).toContain('getIdempotencyBindingRejection(err)');
    expect(catchBlock).toContain(`${idemHandle}.resetKey();`);
    expect(catchBlock).toContain("toast('warning'");
    expect(catchBlock).toContain('fetchPayments();');
    // The admin must never be shown the raw database code.
    expect(catchBlock).not.toContain('IDEMPOTENCY_INTENT_MISMATCH');
    expect(catchBlock).not.toContain('IDEMPOTENCY_ACTOR_MISMATCH');
    // Unrelated failures must still reach Sentry and the error toast.
    expect(catchBlock).toContain(`context: '${rpcName}'`);
    expect(catchBlock).toContain("toast('error'");
  });
});
