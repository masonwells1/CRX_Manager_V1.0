import { useRef, useCallback } from 'react';
import { generateIdempotencyKey } from '../lib/idempotency';

/**
 * Provides a stable idempotency key for a single mutation intent.
 *
 * The key is generated lazily on the first call to `getKey()` and remains
 * stable across retries. This is critical for safe retry behavior: if a
 * network error occurs after the server committed, retrying with the same key
 * lets the server return the original result instead of duplicating the work.
 *
 * Call `getKey()` in your action handler. Call `resetKey()` after a confirmed
 * success, or after an authoritative reload of an EXISTING record has settled
 * what the outstanding attempt did.
 *
 * A payload conflict does NOT authorize retirement. The key is a receipt, not
 * just a retry token: `IDEMPOTENCY_PAYLOAD_CONFLICT` rejects the CHANGED payload
 * while the ORIGINAL one still redeems the server's cached result. On a create,
 * that cached result carries the id of a row that may already have committed,
 * and it is the only deterministic way to learn the create's outcome — so
 * retiring the key there can manufacture a duplicate record. Retain it instead;
 * the cost is one unearned conflict dialog, which a reload clears.
 *
 * Pass `intentScope` when one mounted action can target different records or
 * payloads. One key is retained per scope without embedding the payload in the
 * generated key. Switching scopes mints a fresh key, while returning to a scope
 * with an unresolved outcome reuses its original key. This preserves both
 * customer-assignment intent rotation and commission-payout A → B → A replay.
 *
 * @example
 * const { getKey, resetKey } = useIdempotencyKey('complete_delivery', profile.id);
 *
 * async function handleComplete() {
 *   const key = getKey();
 *   await supabase.rpc('complete_delivery', { p_idempotency_key: key, ... });
 *   resetKey(); // confirmed success only
 * }
 */
export function useIdempotencyKey(operation: string, userId: string, intentScope = '') {
  const keysRef = useRef(new Map<string, string>());
  const scopedKey = useCallback(
    (scopeValue: string) => JSON.stringify([operation, userId, scopeValue]),
    [operation, userId],
  );
  const scope = scopedKey(intentScope);

  const getKey = useCallback((): string => {
    let key = keysRef.current.get(scope);
    if (!key) {
      key = generateIdempotencyKey(operation, userId);
      keysRef.current.set(scope, key);
    }
    return key;
  }, [operation, scope, userId]);

  // Retire only the current intent. Other unresolved scopes keep their replay
  // keys in case the user returns to them before this component unmounts.
  const resetKey = useCallback((): void => {
    keysRef.current.delete(scope);
  }, [scope]);

  // Some intents (for example a free-text cancellation reason) are available
  // only at submit time. Keep the same per-scope map semantics without making
  // the caller wait for a render before it can safely obtain the exact key.
  const getKeyFor = useCallback((scopeValue: string): string => {
    const dynamicScope = scopedKey(scopeValue);
    let key = keysRef.current.get(dynamicScope);
    if (!key) {
      key = generateIdempotencyKey(operation, userId);
      keysRef.current.set(dynamicScope, key);
    }
    return key;
  }, [operation, scopedKey, userId]);

  const resetKeyFor = useCallback((scopeValue: string): void => {
    keysRef.current.delete(scopedKey(scopeValue));
  }, [scopedKey]);

  return { getKey, resetKey, getKeyFor, resetKeyFor };
}
