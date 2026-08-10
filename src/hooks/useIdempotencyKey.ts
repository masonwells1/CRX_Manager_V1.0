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
 * payment id, a job id). One key is retained PER target, so a retry after an
 * uncertain response replays the SAME key and the server can hand back the
 * original outcome, while switching rows still mints a fresh key. Callers that
 * instead call `resetKey()` when the user picks a row throw the retained key
 * away and turn every retry into a brand-new request the server then refuses.
 *
 * Per-target really means per-target: the keys live in a Map, not one slot, so
 * acting on row A, then row B, then row A again replays A's original key rather
 * than minting a third one. A single slot looks identical in the A-then-A and
 * A-then-B cases and only diverges on the return trip, which is exactly the
 * moment an admin is retrying something they are unsure about. The Map holds one
 * short string per row touched since mount and is discarded with the component.
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
  const keysRef = useRef(new Map<string, string>());
  const scope = JSON.stringify([operation, userId, target]);

  const getKey = useCallback((): string => {
    let key = keysRef.current.get(scope);
    if (!key) {
      key = generateIdempotencyKey(operation, userId);
      keysRef.current.set(scope, key);
    }
    return key;
  }, [operation, scope, userId]);

  // Retires only the CURRENT scope's key. Clearing the whole Map would drop the
  // retained keys of every other row the admin has an unresolved retry on.
  const resetKey = useCallback((): void => {
    keysRef.current.delete(scope);
  }, [scope]);

  return { getKey, resetKey };
}
