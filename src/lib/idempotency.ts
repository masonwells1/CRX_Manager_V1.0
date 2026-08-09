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

/**
 * Why a retained idempotency key was refused by the intent-binding guard.
 * 'intent' — the key already committed a DIFFERENT request than this one.
 * 'actor'  — the key was first used by a different signed-in user.
 *
 * Either way the database performed no work for the current request, so the
 * caller may safely reset its key and let the next attempt start fresh.
 */
export type IdempotencyBindingRejection = 'intent' | 'actor';

export function getIdempotencyBindingRejection(
  error: unknown,
): IdempotencyBindingRejection | null {
  if (!error || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  if (message === 'IDEMPOTENCY_INTENT_MISMATCH') return 'intent';
  if (message === 'IDEMPOTENCY_ACTOR_MISMATCH') return 'actor';
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
