import { useRef, useCallback } from 'react';
import { generateIdempotencyKey } from '../lib/idempotency';

/**
 * React hook for retry-safe idempotency keys.
 *
 * Generates a key once per action intent and persists it in a ref so that
 * if the user retries (network timeout, error), the SAME key is sent again.
 * The server deduplicates on the key, preventing duplicate mutations.
 *
 * Call `getKey()` in your action handler — it returns the current key
 * (generating one on first call). Call `resetKey()` only after a
 * confirmed success to prepare for the next distinct action.
 *
 * Pass `target` when one page fires the same operation at different rows (a
 * payment id, a job id). The key is retained per target, so a retry after an
 * uncertain response replays the SAME key and the server can hand back the
 * original outcome, while switching rows still mints a fresh key. Callers that
 * instead call `resetKey()` when the user picks a row throw the retained key
 * away and turn every retry into a brand-new request the server then refuses.
 *
 * @example
 * const { getKey, resetKey } = useIdempotencyKey('complete_delivery', profile.id);
 *
 * async function handleComplete() {
 *   const key = getKey();
 *   await supabase.rpc('complete_delivery', { p_idempotency_key: key, ... });
 *   resetKey(); // call on success — next click is a new action
 *   // on error (caught upstream), key stays the same for retry
 * }
 */
export function useIdempotencyKey(operation: string, userId: string, target = '') {
  const keyRef = useRef<{ scope: string; key: string } | null>(null);
  const scope = JSON.stringify([operation, userId, target]);

  const getKey = useCallback((): string => {
    if (!keyRef.current || keyRef.current.scope !== scope) {
      keyRef.current = {
        scope,
        key: generateIdempotencyKey(operation, userId),
      };
    }
    return keyRef.current.key;
  }, [operation, scope, userId]);

  const resetKey = useCallback((): void => {
    keyRef.current = null;
  }, []);

  return { getKey, resetKey };
}
