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
 * what happened. Editing is not one of them. `refuseOnce()` enforces exactly that
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
  // Edited scopes the operator has already been warned about and chose to send
  // anyway. Acknowledging ONE edit must not disarm the guard for every later
  // one: an earlier version cleared the unresolved scope on the first refusal,
  // so a second, different edit went straight through with no warning at all.
  const acknowledgedRef = useRef<Set<string>>(new Set());
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
    acknowledgedRef.current.clear();
    setUnresolvedScope(null);
  }, []);

  /**
   * Refuse an EDITED submission while an earlier attempt is unresolved, once per
   * distinct edit. A faithful retry — the same scope — is never refused: that is
   * the safe move, and it replays the receipt instead of repeating the work.
   *
   * Warning once per edit rather than forever is deliberate. This state is
   * component-level, so a permanent freeze would also block every unrelated hold or
   * adjustment the operator began afterwards, leaving a page refresh as the only way
   * out. One refusal turns a silent double-apply into a decision the operator
   * actually made, matching the over-allocation warning already on this page: click
   * again to proceed anyway.
   *
   * PER EDIT, not once in total. The freeze stays armed after an acknowledgement,
   * and only the exact payload that was acknowledged passes. Clearing the freeze on
   * the first refusal — an earlier version of this hook — meant acknowledging one
   * edit silently disarmed the guard, so a THIRD, different payload executed with no
   * warning while the original attempt was still unresolved. The freeze is lifted
   * only by `clear()`: a confirmed success, a definitive refusal, or a reload that
   * settled what the outstanding attempt actually did.
   */
  const refuseOnce = useCallback((scope: string): boolean => {
    if (scopeRef.current === null || scopeRef.current === scope) return false;
    if (acknowledgedRef.current.has(scope)) return false;
    acknowledgedRef.current.add(scope);
    return true;
  }, []);

  return { unresolvedScope, isFrozen: unresolvedScope !== null, mark, markIfUncertain, clear, refuseOnce };
}

/** Shown when an edited payload is refused because an earlier attempt is unresolved. */
export const UNRESOLVED_INTENT_MESSAGE =
  'The previous attempt never confirmed, so it may already have been applied. Refresh to check before changing anything — or click again with the original values to safely retry it.';
