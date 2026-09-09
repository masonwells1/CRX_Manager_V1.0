import { useCallback, useRef, useState } from 'react';
import { getIdempotencyBindingRejection, isDefinitiveRpcRejection } from '../lib/idempotency';

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
  // A SET of unresolved scopes, not one slot. Two operations on the same screen can
  // be outstanding at once: the in-flight guards on these pages are keyed per row, so
  // they stop a double-click on ONE row and nothing else. With a single slot the last
  // callback to finish won — a success on row B called clear() and silently lifted
  // row A's freeze, and an edited retry of A then minted a fresh key and re-applied
  // work that may already have committed. CodeRabbit found that on BlendRecipes.
  // Every unresolved scope now holds its own freeze until THAT scope is settled.
  const scopesRef = useRef<Set<string>>(new Set());
  // Mirrors the ref so a frozen form can render its own banner. The ref is what the
  // guard reads: it is updated synchronously, and two clicks can land inside one
  // render window.
  const [unresolvedScopes, setUnresolvedScopes] = useState<readonly string[]>([]);

  const publish = useCallback((): void => {
    setUnresolvedScopes([...scopesRef.current]);
  }, []);

  const mark = useCallback((scope: string): void => {
    scopesRef.current.add(scope);
    publish();
  }, [publish]);

  /** Record the outcome of a failed attempt: uncertain ones freeze the payload. */
  const markIfUncertain = useCallback((scope: string, error: unknown): void => {
    if (isDefinitiveRpcRejection(error)) {
      // A positive refusal SETTLES this scope, including one frozen earlier by an
      // ambiguous failure. A faithful retry carries the SAME key, so if the first
      // attempt had committed the server would have replayed its stored receipt
      // instead of evaluating the request again and refusing it on business grounds.
      // An error at all means no replay happened; a business refusal means the work
      // did not apply. The operator can edit and resend without reloading. Leaving
      // the scope frozen was safe but stranded the screen until a reload. (Codex P2.)
      //
      // Binding rejections are excluded deliberately, and `isDefinitiveRpcRejection`
      // does not exclude all of them: it filters IDEMPOTENCY_INTENT_MISMATCH,
      // _RESULT_INVALID and _RECEIPT_MISSING by message, but an ACTOR mismatch still
      // reads as a definitive P0001. That one is raised precisely BECAUSE an earlier
      // request under this key committed, so unfreezing on it would be the exact
      // mistake this guard exists to prevent. Check the binding classifier too.
      if (getIdempotencyBindingRejection(error) !== null) return;
      if (scopesRef.current.delete(scope)) publish();
      return;
    }
    scopesRef.current.add(scope);
    publish();
  }, [publish]);

  /**
   * Settle ONE outstanding attempt, named by its scope.
   *
   * The scope argument is required, and that is the guard rather than a formality:
   * a caller may only lift the freeze it is itself responsible for. The previous
   * signature took no argument and cleared everything, so a confirmed success on one
   * row lifted the freeze on a DIFFERENT row whose outcome was still unknown. Making
   * this parameter mandatory means the type-checker refuses any call site that cannot
   * say which attempt it just settled.
   *
   * Call ONLY after a confirmed success, a definitive refusal, or an authoritative
   * reload that settled what that outstanding attempt did.
   */
  const clear = useCallback((scope: string): void => {
    scopesRef.current.delete(scope);
    publish();
  }, [publish]);

  /**
   * Refuse an EDITED submission for as long as an earlier attempt is unresolved.
   * A faithful retry -- a scope that is itself unresolved -- is never refused:
   * replaying the identical request redeems the receipt instead of repeating the
   * work, and is the only safe way forward that does not require a reload.
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
   * answers that. `clear(scope)` lifts the freeze on a confirmed success, a definitive
   * refusal, or a reload that settled that attempt.
   */
  const refuseEdited = useCallback((scope: string): boolean => {
    if (scopesRef.current.size === 0) return false;
    return !scopesRef.current.has(scope);
  }, []);

  return {
    unresolvedScopes,
    isFrozen: unresolvedScopes.length > 0,
    mark,
    markIfUncertain,
    clear,
    refuseEdited,
  };
}

/** Shown when an edited payload is refused because an earlier attempt is unresolved. */
export const UNRESOLVED_INTENT_MESSAGE =
  'The previous attempt never confirmed, so it may already have been applied. Refresh the page to check what happened — or put the original values back and submit again, which safely retries the same request instead of repeating it.';
