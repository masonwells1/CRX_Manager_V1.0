-- REISSUED 2026-08-09 with a forward timestamp.
--
-- Originally written as 20260808150200_cancel_order_zeroes_quantity_remaining.sql, which
-- was merged to main but never applied. Live ledger row 20260809130108
-- (team_note_completion_rpc_and_assignment_notify) landed afterwards, putting
-- every 20260808* file BELOW the applied high-water mark, where
-- .claude/hooks/migration-ordering-lib.mjs correctly refuses it: an older
-- migration applied after a newer one is exactly the 2026-07-15 reversion that
-- guard exists to stop.
--
-- The executable SQL below is UNCHANGED from the reviewed original -- only the
-- filename timestamp and this header differ. The stale 20260808* file is deleted
-- in the same commit so a clean rebuild cannot apply the change twice (the same
-- remedy as docs/reference/migration-history.md row 808 -> live row 811).

-- Zero order_items.quantity_remaining when an order is fully cancelled.
--
-- idempotency-body-check: exempt
--   This is a delegating wrapper, and the check-without-save shape is
--   PRE-EXISTING and unchanged by this migration — it is reproduced verbatim
--   from the live definition of the same function. It reads the idempotency
--   cache to short-circuit a replay, then hands the mutation to
--   _cancel_order_impl_20260714; recording the key is owned by the functions
--   that bracket this one — _cancel_order_provenance_wrapper_20260719 and
--   _cancel_order_idem_impl_20260721 both call
--   _bind_completed_lifecycle_idempotency on the way out. Adding a
--   save_idempotency() call here would double-record the same key.
--
-- Owner decision (Mason, 2026-08-08, docs/manual/DECISION_LOG.md): cancelling
-- an order must not leave stock stranded. Current behavior is a bug.
--
-- SCOPE CORRECTION vs the 2026-08-08 audit (§3 M4) and the remediation
-- handoff. Both said full cancel "leaves quantity_remaining non-zero AND the
-- stock stays prebooked". Tracing the live chain shows only the first half is
-- true:
--
--   cancel_order
--     -> _cancel_order_idem_impl_20260721
--          partially_fulfilled -> _close_undelivered_order_remainder_20260718
--          otherwise           -> _cancel_order_provenance_wrapper_20260719
--                                   -> _cancel_order_split_provenance_impl_20260719
--                                        -> _cancel_order_impl_20260714
--
--   * The partially_fulfilled path ALREADY sets quantity_remaining = 0 and
--     releases prebooked stock with an inventory_transactions row. It needs no
--     change and is deliberately untouched here.
--   * _cancel_order_impl_20260714 ALREADY releases prebooked stock
--     (quantity_prebooked - undelivered, clamped at 0) and writes a 'released'
--     inventory_transactions row. Confirmed live: the one cancelled order
--     carrying a remainder (ORD-2026-0330) HAS its 'released' ledger row.
--   * What no path does on full cancel is zero order_items.quantity_remaining.
--     That is the entire real defect, and it is what this migration fixes.
--
-- The residual quantity_prebooked = 36 on that product is therefore NOT caused
-- by cancel_order and is NOT addressed here. It belongs to the March 2026
-- historical drift recorded as L2 in the audit. Fixing live inventory numbers
-- is a data change, not a code change, and needs its own owner decision.
--
-- Placement: the zeroing goes in _cancel_order_split_provenance_impl_20260719,
-- the narrow function every full cancel passes through, rather than inside the
-- 12KB _cancel_order_impl_20260714. It runs AFTER that impl returns and BEFORE
-- _cancel_order_idem_impl_20260721 clears app.admin_override, so the
-- transaction-local admin override that impl set is still in effect and the
-- order_items immutability guards are correctly bypassed.
--
-- Verified: order_items.quantity_remaining is a plain writable numeric column
-- (is_generated = NEVER), so this is a direct UPDATE, not a generated-column
-- write.
--
-- Forward-only.

CREATE OR REPLACE FUNCTION public._cancel_order_split_provenance_impl_20260719(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  PERFORM 1 FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.returns r
    WHERE r.order_id = p_order_id
      AND r.deleted_at IS NULL
      AND r.status IN ('received', 'credited')
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_RECEIVED_RETURN';
  END IF;

  v_result := public._cancel_order_impl_20260714(
    p_order_id, p_performed_by, p_idempotency_key
  );

  -- The cancelled order holds no remaining demand. _cancel_order_impl_20260714
  -- has already released the matching prebooked stock and written its ledger
  -- rows; this closes the order-side counter it leaves behind. Restricted to
  -- rows that are actually non-zero so the statement is a no-op on replay.
  UPDATE public.order_items
     SET quantity_remaining = 0
   WHERE order_id = p_order_id
     AND COALESCE(quantity_remaining, 0) <> 0;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public._cancel_order_split_provenance_impl_20260719(uuid, uuid, text) IS
  'Full-cancel path: guards returns provenance, delegates to '
  '_cancel_order_impl_20260714 (which releases prebooked stock and writes the '
  'inventory ledger), then zeroes order_items.quantity_remaining. The zeroing '
  'was added 2026-08-08 per Mason''s decision; see the 2026-08-08 foundation '
  'ultra review §3 M4.';
