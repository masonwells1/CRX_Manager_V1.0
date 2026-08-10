import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getIdempotencyBindingRejection } from './idempotency';

/**
 * Source guard for the Section 07 gauntlet HIGH finding: the commission payout
 * RPCs keyed their idempotency receipts on [operation, user] only, so a
 * retained browser key could replay a DIFFERENT payout's cached success.
 * 20260810130500 binds each receipt to the acting user and a hash of the exact
 * request. These assertions keep both halves — the SQL wrappers and their
 * page-level callers — from silently losing that binding.
 *
 * Behaviour is proved separately, against a real Postgres, by
 * scripts/smoke/prove-commission-payout-intent-binding.mjs. This file only
 * guards the structure those runtime proofs depend on.
 */
const MIGRATION_PATH =
  'supabase/migrations/20260810130500_bind_commission_payout_idempotency_to_intent.sql';

const migration = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
const page = readFileSync('src/pages/CommissionPayments.tsx', 'utf8').replace(/\r\n/g, '\n');
const reports = readFileSync('src/pages/Reports.tsx', 'utf8').replace(/\r\n/g, '\n');

const PAYOUT_RPCS = [
  {
    name: 'create_commission_payment',
    signature: 'uuid[], text, text, date, text, uuid, text',
    impl: '_create_commission_payment_intent_impl_20260809',
    // Every field the admin can edit has to be inside the hash. A field left out
    // is a field an edited retry can change while still replaying the old
    // receipt — which is the exact bug this migration exists to close.
    fingerprintFields: [
      'actor_id', 'commission_ids', 'payment_method', 'reference', 'payment_date', 'notes',
    ],
    // Values normalized once in DECLARE, then shared by the hash and the call.
    normalized: ['v_payment_method', 'v_reference', 'v_notes'],
  },
  {
    name: 'post_commission_payment',
    signature: 'uuid, uuid, text',
    impl: '_post_commission_payment_intent_impl_20260809',
    fingerprintFields: ['actor_id', 'payment_id'],
    normalized: [],
  },
  {
    name: 'void_commission_payment',
    signature: 'uuid, text, uuid, text',
    impl: '_void_commission_payment_intent_impl_20260809',
    fingerprintFields: ['actor_id', 'payment_id', 'reason'],
    normalized: ['v_reason'],
  },
] as const;

function wrapperBody(name: string): string {
  // CREATE OR REPLACE, not CREATE: the migration has to be re-runnable, so the
  // wrappers replace themselves rather than aborting on a second application.
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} wrapper is missing`).toBeGreaterThan(-1);
  const end = migration.indexOf('$function$;', start);
  expect(end, `${name} wrapper is unterminated`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

/** The jsonb_build_object that feeds the SHA-256 digest, and nothing else. */
function fingerprintBlock(body: string): string {
  const start = body.indexOf('v_fingerprint := encode(');
  expect(start, 'wrapper never computes a fingerprint').toBeGreaterThan(-1);
  const end = body.indexOf("'hex'", start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

/** The branch taken when the caller sent no idempotency key at all. */
function noKeyBranch(body: string): string {
  const start = body.indexOf('IF p_idempotency_key IS NULL THEN');
  expect(start, 'wrapper has no un-keyed delegation branch').toBeGreaterThan(-1);
  return body.slice(start, body.indexOf('END IF;', start));
}

describe('commission payout intent-binding migration', () => {
  it('gates cached receipts on both the actor and the exact request', () => {
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.check_idempotency_intent(');
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start, migration.indexOf('$function$;', start));

    // The lock is the only thing serializing two sessions that hit the same key
    // at the same instant; without it both can read "no receipt" and both pay.
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain("hashtextextended('crx:idempotency:' || p_key, 0)");
    expect(body).toContain('v_existing.request_actor_id IS DISTINCT FROM p_actor');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH'");
    expect(body).toContain('v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(body).toContain('SET search_path = public, pg_temp');

    // The wrapper reaches this check before the implementation's own
    // check_idempotency does, so the caller must still see the SAME formatted
    // text as before — a bare code here would be a silent error-surface change.
    expect(body).toContain(
      "'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',\n      p_key, v_existing.operation, p_operation",
    );

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

    // A blank key is a caller bug, not a missing key: check_idempotency raises
    // here, and losing that parity would let '   ' silently skip idempotency.
    expect(body).toContain("IF btrim(p_key) = '' THEN");
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'");
  });

  it.each(PAYOUT_RPCS)('$name fingerprints its own request before touching a receipt', (rpc) => {
    const body = wrapperBody(rpc.name);

    expect(body).toContain('extensions.digest(');
    expect(body).toContain("'sha256'");
    expect(body).toContain(
      `public.check_idempotency_intent(\n    p_idempotency_key, '${rpc.name}', v_actor, v_fingerprint\n  )`,
    );
    // The fingerprint has to be computed from THIS call's arguments before the
    // receipt lookup, otherwise the lookup has nothing to compare against.
    expect(body.indexOf('v_fingerprint := encode(')).toBeLessThan(
      body.indexOf('check_idempotency_intent('),
    );

    // Exact field set, not a spot-check: an extra field is as wrong as a missing
    // one, because it makes retries that SHOULD replay look like new requests.
    const hashed = [...fingerprintBlock(body).matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]);
    expect(hashed).toEqual([...rpc.fingerprintFields]);
  });

  it.each(PAYOUT_RPCS)('$name hashes and stores the identical normalized values', (rpc) => {
    if (rpc.normalized.length === 0) return;
    const body = wrapperBody(rpc.name);
    const hash = fingerprintBlock(body);
    // The implementation call that does the real work is the LAST one — the
    // first is the un-keyed delegation branch above it.
    const call = body.slice(body.lastIndexOf(`public.${rpc.impl}(`));

    for (const local of rpc.normalized) {
      // Normalize once, use twice. Hashing a trimmed value while persisting the
      // raw one would let ' REF-1 ' replay REF-1's receipt while claiming to
      // have stored different metadata.
      expect(hash, `${rpc.name} hashes a value it did not normalize`).toContain(local);
      expect(call, `${rpc.name} persists a value it did not hash`).toContain(local);
    }
    // The un-keyed path must normalize too, or the same input would be stored
    // differently depending on whether a retry key was present.
    for (const local of rpc.normalized) {
      expect(noKeyBranch(body)).toContain(local);
    }
  });

  it.each(PAYOUT_RPCS)('$name still delegates when no idempotency key was sent', (rpc) => {
    const branch = noKeyBranch(wrapperBody(rpc.name));
    expect(branch).toContain(`RETURN public.${rpc.impl}(`);
    // NULL, not the key: passing a key here would write a receipt the wrapper
    // never binds, recreating the unbound-receipt hole on the un-keyed path.
    expect(branch).toContain('NULL\n    );');
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
    expect(update).toBeGreaterThan(-1);
    // lastIndexOf, not indexOf: the FIRST mention of the implementation is the
    // un-keyed delegation near the top of the wrapper, so comparing against it
    // would pass even if the binding UPDATE ran before the real payout call.
    expect(update).toBeGreaterThan(body.lastIndexOf(`public.${rpc.impl}(`));
    const updateBlock = body.slice(update);
    expect(updateBlock).toContain('SET request_fingerprint = v_fingerprint');
    expect(updateBlock).toContain('request_actor_id = v_actor');
    expect(updateBlock).toContain(`AND operation = '${rpc.name}'`);
    expect(updateBlock).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'");
  });

  it.each(PAYOUT_RPCS)('$name renames its implementation re-runnably', (rpc) => {
    // A bare ALTER ... RENAME aborts on a second run because the target name
    // already exists, which would strand any recovery that replays this file.
    expect(migration).toContain(
      `IF to_regprocedure('public.${rpc.impl}(${rpc.signature})') IS NULL THEN`,
    );
    // …and refuse to install a wrapper over nothing if the original is absent.
    expect(migration).toContain(
      `IF to_regprocedure('public.${rpc.name}(${rpc.signature})') IS NULL THEN`,
    );
    expect(migration).toContain(
      `    ALTER FUNCTION public.${rpc.name}(${rpc.signature})\n      RENAME TO ${rpc.impl};`,
    );
  });

  it.each(PAYOUT_RPCS)('$name keeps its renamed implementation out of the browser', (rpc) => {
    expect(migration).toContain(
      `REVOKE ALL ON FUNCTION public.${rpc.impl}(${rpc.signature})\n  FROM PUBLIC, anon, authenticated, service_role;`,
    );
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${rpc.name}(${rpc.signature})`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc.name}(${rpc.signature})`);
  });

  it('verifies overload uniqueness and the full deny matrix in the same transaction', () => {
    const verify = migration.slice(migration.indexOf('DO $verify$'));
    expect(verify).toContain('overload count = % (expected 1)');
    expect(verify).toContain('anonymous execution must remain revoked');
    expect(verify).toContain('authenticated execution grant missing');
    expect(verify).toContain('internal payout implementations must not be browser-executable');

    // Checking anon+authenticated only would let a service_role grant put the
    // unguarded implementation back on a PostgREST-reachable surface.
    expect(verify).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    for (const rpc of PAYOUT_RPCS) {
      // has_function_privilege targets are written without spaces in the block.
      expect(verify).toContain(`'public.${rpc.impl}(${rpc.signature.replace(/ /g, '')})'`);
    }
    expect(verify).toContain("'public.check_idempotency_intent(text,text,uuid,text)'");
  });

  it('leaves no idempotency error code unaccounted for in the UI', () => {
    // Codes the UI deliberately does NOT treat as "retire the key". Each one has
    // to stay deliberate: a new code added to the migration without a decision
    // here would reach the admin as a raw database string.
    const INTENTIONALLY_UNCLASSIFIED = new Set([
      // The key belongs to a different operation — resetting it would mask a
      // caller bug rather than help the admin.
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE',
      // These three are wrapper-programming errors, not admin-recoverable
      // states; the browser never sends a blank key or a missing fingerprint.
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_OPERATION_REQUIRED',
      'IDEMPOTENCY_FINGERPRINT_REQUIRED',
    ]);

    const raised = new Set(
      [...migration.matchAll(/RAISE EXCEPTION\s+'(IDEMPOTENCY_[A-Z_]+)/g)].map((m) => m[1]),
    );
    expect(raised.size).toBeGreaterThan(0);

    for (const code of raised) {
      const classified = getIdempotencyBindingRejection({ message: code }) !== null;
      expect(
        classified || INTENTIONALLY_UNCLASSIFIED.has(code),
        `${code} is raised by the migration but neither classified by `
          + 'getIdempotencyBindingRejection nor listed as intentionally unclassified',
      ).toBe(true);
    }
  });
});

describe('commission payout intent-binding callers', () => {
  it('imports the shared refusal classifier rather than matching raw codes', () => {
    expect(page).toContain(
      "import { getIdempotencyBindingRejection } from '../lib/idempotency';",
    );
  });

  it.each([
    ['create_commission_payment', 'createPaymentIdem', 'nothing was created'],
    ['post_commission_payment', 'postPaymentIdem', 'nothing was posted'],
    ['void_commission_payment', 'voidPaymentIdem', 'nothing was voided'],
  ])('%s handles a refused key and retires it', (rpcName, idemHandle, nothingHappened) => {
    const call = page.indexOf(`supabase.rpc('${rpcName}'`);
    expect(call, `${rpcName} caller is missing`).toBeGreaterThan(-1);
    const nextCatch = page.indexOf('} catch (err: unknown) {', call);
    expect(nextCatch).toBeGreaterThan(call);
    const catchBlock = page.slice(nextCatch, page.indexOf('\n  };', nextCatch));

    expect(catchBlock).toContain('getIdempotencyBindingRejection(err)');
    expect(catchBlock).toContain(`${idemHandle}.resetKey();`);
    expect(catchBlock).toContain("toast('warning'");
    // Awaited AND ordered: the toast tells the admin to check the list below it,
    // so the refresh has to have finished before that claim is true. Asserting
    // only that `await fetchPayments()` appears would still pass if the refresh
    // were moved below the toast, which is the bug this guards.
    const refreshAt = catchBlock.indexOf('await fetchPayments();');
    expect(refreshAt, 'refusal branch does not await a refresh').toBeGreaterThan(-1);
    const warnAt = catchBlock.indexOf("toast('warning'");
    expect(
      refreshAt,
      'the refusal toast points the admin at the list, so the refresh must finish first',
    ).toBeLessThan(warnAt);
    // All three refusal kinds must reach the admin with their OWN wording. The
    // unusable-receipt case is the one that would otherwise trap them in a dead
    // retry, and telling them "another user owns this" instead would be false.
    // Whitespace-collapsed so re-indentation does not break it, but the branch
    // ORDER is asserted: widening the actor test to also swallow 'receipt' would
    // leave the receipt message present in the file yet permanently unreachable.
    expect(catchBlock.replace(/\s+/g, ' ')).toContain(
      "toast('warning', rejection === 'actor'"
      + ` ? 'That retry belongs to another user, so ${nothingHappened}. Reload the page and try again.'`
      + " : rejection === 'receipt'"
      + ` ? 'The database could not confirm the outcome of the earlier attempt, so ${nothingHappened} now.`,
    );
    // The admin must never be shown the raw database code.
    expect(catchBlock).not.toContain('IDEMPOTENCY_INTENT_MISMATCH');
    expect(catchBlock).not.toContain('IDEMPOTENCY_ACTOR_MISMATCH');
    // Unrelated failures must still reach Sentry and the error toast.
    expect(catchBlock).toContain(`context: '${rpcName}'`);
    expect(catchBlock).toContain("toast('error'");
  });

  it('never claims the retry belonged to a different request', () => {
    // A pre-migration receipt proves only that the key is spent, not that the
    // earlier request DIFFERED. Wording that asserts a difference would be a
    // statement the database cannot back up.
    expect(page).not.toContain('a different payment');
    // A 'receipt' refusal covers BOTH an unreadable stored result and no stored
    // result at all, so the wording must not assert the retry did anything —
    // only that its outcome cannot be confirmed.
    expect(page).not.toContain('what this retry already did');
    expect(page).toContain('already used by an earlier commission payment');
    expect(page).toContain('already used by an earlier posting');
    expect(page).toContain('already used by an earlier void');
  });
});

/**
 * Reports has its OWN quick-pay path into create_commission_payment, and it is
 * the harder one: a single click loops once per recipient, so it cannot use the
 * shared useIdempotencyKey hook (one key would collide with itself across
 * recipients). It keeps a Map of retained keys instead, and these assertions
 * pin the three properties that make that safe.
 */
describe('Reports quick-pay idempotency scope', () => {
  const markPaid = (() => {
    const start = reports.indexOf('const handleMarkPaid = async () => {');
    expect(start, 'handleMarkPaid is missing from Reports').toBeGreaterThan(-1);
    const end = reports.indexOf('\n  };', start);
    expect(end).toBeGreaterThan(start);
    return reports.slice(start, end);
  })();

  it('does not derive the key from the commission ids alone', () => {
    // The original bug: `reports-commission-pay-${ids.join('-')}` is a pure
    // function of the selection, so the SAME key returns after a void reopens
    // those commissions — replaying the voided payment's receipt and reporting
    // success for a batch that was never created.
    expect(reports).not.toContain('reports-commission-pay-');
    expect(markPaid).toContain("generateIdempotencyKey('create_commission_payment'");
  });

  it('scopes the retained key to actor, date and the sorted selection', () => {
    // The scope has to match what the server fingerprints. If it were narrower
    // than the fingerprint, a changed field would reuse the key and the server
    // would hard-refuse a retry the admin cannot escape.
    expect(markPaid).toContain('const scope = `${profile!.id}|${today}|${[...new Set(ids)].sort().join(\'-\')}`');
    expect(markPaid).toContain('markPaidKeys.current.get(scope)');
    expect(markPaid).toContain('markPaidKeys.current.set(scope, key)');
  });

  it('retires only the recipient that succeeded, and every key on a refusal', () => {
    // Per-recipient retirement: clearing the whole Map on success would hand the
    // next recipient in the SAME click a fresh key mid-loop.
    expect(markPaid).toContain('markPaidKeys.current.delete(scope);');
    const succeeded = markPaid.indexOf('markPaidKeys.current.delete(scope);');
    const cleared = markPaid.indexOf('markPaidKeys.current.clear();');
    expect(cleared, 'a binding refusal must clear every retained key').toBeGreaterThan(-1);
    expect(succeeded).toBeLessThan(cleared);
    expect(markPaid).toContain('getIdempotencyBindingRejection(err)');
  });

  it('refreshes before the refusal toast and never overstates what was skipped', () => {
    const refreshAt = markPaid.indexOf('await fetchCommissions();');
    expect(refreshAt, 'the refusal branch does not await a refresh').toBeGreaterThan(-1);
    expect(refreshAt).toBeLessThan(markPaid.indexOf("toast('warning'"));
    // One click makes one call per recipient. Recipients processed before the
    // refusal really were paid, so the message must be conditional on how many
    // actually landed — a flat "no payment batch was created" invites a
    // duplicate batch.
    expect(markPaid.replace(/\s+/g, ' ')).toContain("toast('warning', totalBatched > 0");
    expect(markPaid).toContain('were already added to a payment batch before it stopped');
  });
});
