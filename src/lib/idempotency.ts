/**
 * Idempotency key generator for critical operations.
 * Generates a unique key per action to prevent double-submissions.
 * Keys are sent to the database RPCs and checked before execution.
 *
 * Uses crypto.randomUUID() for cryptographically strong random IDs.
 */

/**
 * Generate a unique idempotency key for a critical operation.
 * Format: {operation}:{userId}:{uuid}
 *
 * Each call generates a NEW key — call this once when the user clicks
 * the button, then reuse the same key if retrying the same action.
 *
 * For retry-safe behavior in React components, use the useIdempotencyKey hook
 * which persists the key across retries and only resets on success.
 */
export function generateIdempotencyKey(operation: string, userId: string): string {
  const uuid = crypto.randomUUID();
  return `${operation}:${userId}:${uuid}`;
}

/**
 * Deterministic fingerprint of the payload a retained key was minted for.
 *
 * useIdempotencyKey retains one key per intent scope so a lost response can be
 * replayed safely. That is only correct while the scope still identifies the
 * SAME work: if a scope is built from position and name alone, a later action
 * carrying different content reuses the earlier key and replays the earlier
 * receipt. Appending this fingerprint to the scope makes changed content mint a
 * fresh key, while a true retry of unchanged content keeps replaying.
 *
 * FNV-1a is a local lookup hash, not a security boundary — the server's own
 * intent binding remains the authoritative duplicate check. This mirrors
 * pendingBulkPOIntentStorageKey in src/lib/bulkPOImportRetry.ts, which uses the
 * same hash for the same local-identity purpose.
 */
export function fingerprintIntentPayload(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(value) ?? 'undefined')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

type IdempotencyMismatchDetail = {
  operation?: string;
  result?: Record<string, unknown>;
};

export function isMissingIntentBindingColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== 'PGRST204' && candidate.code !== '42703') return false;
  return typeof candidate.message === 'string'
    && candidate.message.includes('request_fingerprint');
}

export type LegacyIntentSnapshot = { key: string; intent: string };

export function legacyIntentChanged(
  previous: LegacyIntentSnapshot | null,
  current: LegacyIntentSnapshot,
): boolean {
  return previous?.key === current.key && previous.intent !== current.intent;
}

// Class 08 (connection_exception, e.g. 08007 transaction_resolution_unknown)
// is deliberately excluded: the server may have committed before the link
// dropped, so a connection-class code can never be a definitive refusal.
const POSTGRES_SQLSTATE = /^(?:0[1-7]|0[9A-Z]|20|21|22|23|24|25|26|27|28|2B|2D|2F|34|38|39|3B|3D|3F|40|42|44|53|54|55|57|58|F0|HV|P0|XX)[0-9A-Z]{3}$/;
// Individually ambiguous codes inside otherwise-definitive classes: the
// statement/connection outcome is unknown, or the connection was torn down
// mid-statement.
const UNCERTAIN_SQLSTATE = new Set(['40003', '57P01', '57P02', '57P03']);
// PGRST0xx are connection/pool-level failures (server unreachable, pool
// exhausted, schema cache reload) that can occur after a statement already
// committed; only PGRST1xx+ (request/query/auth-shape refusals) are definitive.
const POSTGREST_ERROR_CODE = /^PGRST(?:[1-9]\d{2})$/;

/**
 * Returns true only for a positively identified PostgreSQL/PostgREST refusal.
 * Runtime/transport libraries frequently attach nonblank codes (ECONNRESET,
 * ETIMEDOUT, and similar) even when the server committed before the response
 * was lost. Those outcomes stay uncertain, so their original key is retained.
 * A corrupt/missing receipt is uncertain for the same reason: an earlier
 * mutation may have committed even though its replay receipt is unusable.
 */
export function isDefinitiveRpcRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (
    candidate.message === 'IDEMPOTENCY_INTENT_MISMATCH'
    || candidate.message === 'IDEMPOTENCY_RESULT_INVALID'
    || candidate.message === 'IDEMPOTENCY_RECEIPT_MISSING'
  ) return false;
  if (typeof candidate.code !== 'string') return false;
  const code = candidate.code.trim().toUpperCase();
  if (UNCERTAIN_SQLSTATE.has(code)) return false;
  return POSTGRES_SQLSTATE.test(code) || POSTGREST_ERROR_CODE.test(code);
}

/**
 * Why a retained idempotency key was refused by the intent-binding guard.
 * 'intent'  — the key already committed a request that this one cannot be
 *             proven identical to (a different request, or a pre-migration
 *             receipt that carries no intent to compare against).
 * 'actor'   — the key was first used by a different signed-in user.
 * 'receipt' — the key maps to a receipt the database cannot use: its stored
 *             result is missing or null, or the receipt vanished after the
 *             operation ran. The transaction rolled back, so nothing committed
 *             for THIS request, but an earlier one may have.
 *
 * In every case the database performed no work for the current request, and the
 * key can never succeed again — so the caller must reset it. Leaving a
 * 'receipt' key in place traps the operator in an unfixable retry loop.
 */
export type IdempotencyBindingRejection = 'intent' | 'actor' | 'receipt';

export function getIdempotencyBindingRejection(
  error: unknown,
): IdempotencyBindingRejection | null {
  if (!error || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  if (message === 'IDEMPOTENCY_INTENT_MISMATCH') return 'intent';
  if (message === 'IDEMPOTENCY_ACTOR_MISMATCH') return 'actor';
  if (
    message === 'IDEMPOTENCY_RESULT_INVALID'
    || message === 'IDEMPOTENCY_RECEIPT_MISSING'
  ) {
    return 'receipt';
  }
  return null;
}

/**
 * Extracts the committed receipt returned in an IDEMPOTENCY_INTENT_MISMATCH
 * error. PostgREST errors are plain objects, so do not use instanceof Error.
 */
export function getIdempotencyMismatchResult(
  error: unknown,
  expectedOperation: string,
): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null;

  const candidate = error as { message?: unknown; details?: unknown };
  if (
    typeof candidate.message !== 'string'
    || candidate.message !== 'IDEMPOTENCY_INTENT_MISMATCH'
    || typeof candidate.details !== 'string'
  ) {
    return null;
  }

  try {
    const detail = JSON.parse(candidate.details) as IdempotencyMismatchDetail;
    if (
      detail.operation !== expectedOperation
      || !detail.result
      || typeof detail.result !== 'object'
      || Array.isArray(detail.result)
    ) {
      return null;
    }
    return detail.result;
  } catch {
    return null;
  }
}
