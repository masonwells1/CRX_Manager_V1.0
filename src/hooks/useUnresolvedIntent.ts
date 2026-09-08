import { useCallback, useRef, useState } from 'react';
import { isDefinitiveRpcRejection } from '../lib/idempotency';

/**
 * Freezes an editable form whose last attempt has an UNKNOWN outcome.
 *
 * useIdempotencyKey retains one key per intent scope, and several call sites
 * build that scope from the payload so that changed content mints a fresh key.
 * That is correct while the previous attempt's fate is known. It is dangerous
 * when it is not: if an RPC commits and the response is lost, the modal stays
 * open and editable, and editing a quantity is enough to mint a NEW key. The
 * RPCs behind these forms (`adjust_inventory`, `create_inventory_hold`,
 * `save_blend_recipe`) replay on the KEY ALONE and bind no payload, so the
 * server sees an unrelated request and applies the work a SECOND time —
 * double-counting stock, double-reserving a hold, or duplicating a record.
 *
 * The safe rule is: while an attempt is unresolved, the only two legal moves
 * are retrying it UNCHANGED (which replays the receipt) or reloading to learn
 * what happened. Editing is not one of them. `refuseEdited()` enforces exactly that
 * and nothing wider — the identical payload is always allowed straight through.
 *
 * Verified read-only against the live catalog on 2026-09-08: none of the three
 * functions calls check_idempotency_intent, none stores a request_fingerprint, and
 * none raises IDEMPOTENCY_PAYLOAD_CONFLICT. They really do replay on the key alone.
 *
 * An error is treated as unresolved unless it is a positively identified
 * server-side refusal. That includes the idempotency binding rejections: those
 * prove the CURRENT request did nothing, but they are raised precisely because
 * an EARLIER request under that key did commit something, which is the outcome
 * this guard exists to protect.
 */
export function useUnresolvedIntent() {
  const scopeRef = useRef<string | null>(null);
  // Mirrors the ref so a frozen form can render its own banner. The ref is what
  // the guard reads: it is set synchronously, and two clicks can land inside one
  // render window.
  const [unresolvedScope, setUnresolvedScope] = useState<string | null>(null);

  const mark = useCallback((scope: string): void => {
    scopeRef.current = scope;
    setUnresolvedScope(scope);
  }, []);

  /** Record the outcome of a failed attempt: uncertain ones freeze the payload. */
  const markIfUncertain = useCallback((scope: string, error: unknown): void => {
    if (isDefinitiveRpcRejection(error)) return;
    scopeRef.current = scope;
    setUnresolvedScope(scope);
  }, []);

  /**
   * Clear the freeze. Call ONLY after a confirmed success, a definitive refusal,
   * or an authoritative reload that settled what the outstanding attempt did.
   */
  const clear = useCallback((): void => {
    scopeRef.current = null;
    setUnresolvedScope(null);
  }, []);

  /**
   * Refuse an EDITED submission for as long as the earlier attempt is unresolved.
   * A faithful retry -- the same scope -- is never refused: replaying the identical
   * request redeems the receipt instead of repeating the work, and is the only safe
   * way forward that does not require a reload.
   *
   * There is deliberately NO acknowledgement escape. Two earlier versions had one and
   * both were wrong in the same direction:
   *   1. Clearing the freeze on the first refusal disarmed the guard entirely, so a
   *      third, different payload executed with no warning at all.
   *   2. Warning once per distinct edit still let the SECOND click on any edited
   *      payload through -- which mints a fresh key and re-applies work that may
   *      already have committed. `gpt-5.6-sol` and the Codex bot both called that a
   *      real double-apply path, independently, and they were right: these RPCs bind
   *      no payload server-side, so the client is the only thing standing between a
   *      lost response and a second stock adjustment, hold or duplicate record.
   *
   * The cost is that an operator with an unresolved attempt must reload before making
   * a DIFFERENT change on that screen. That is the correct instruction anyway: while
   * an attempt is unresolved nobody knows whether it applied, and a reload is what
   * answers that. `clear()` lifts the freeze on a confirmed success, a definitive
   * refusal, or a reload that settled the outstanding attempt.
   */
  const refuseEdited = useCallback((scope: string): boolean => {
    if (scopeRef.current === null || scopeRef.current === scope) return false;
    return true;
  }, []);

  return { unresolvedScope, isFrozen: unresolvedScope !== null, mark, markIfUncertain, clear, refuseEdited };
}

/** Shown when an edited payload is refused because an earlier attempt is unresolved. */
export const UNRESOLVED_INTENT_MESSAGE =
  'The previous attempt never confirmed, so it may already have been applied. Refresh the page to check what happened — or put the original values back and submit again, which safely retries the same request instead of repeating it.';
