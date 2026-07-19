-- H4 (Live Foundation Gauntlet 2026-07-18) — restore_cancelled_order left a
-- corrupt order.
--
-- The function flipped a cancelled order back to 'confirmed' but did NOT reverse
-- the cancel's side-effects: the cancel had released the inventory prebook and
-- holds, zeroed the pending commissions, and reversed the booking draws. A
-- "restored" order was therefore 'confirmed' with no inventory reservation and
-- no commission rows — a silently broken state that later fulfilment / payout
-- logic would mis-handle.
--
-- Safe fix (approved 2026-07-18): rather than attempt a fragile exact-inverse of
-- the whole cancel (re-reserve inventory, re-create commissions, re-apply draws,
-- un-cancel deliveries/invoices — each its own correctness risk), FORBID restore.
-- The function now raises a clear, actionable error; the correct recovery is to
-- create a new order, or re-convert / revert the source quote (the B2 escape
-- hatch), which builds a clean order with correct reservations and commissions.
--
-- Signature reproduced verbatim from the live catalog so this replaces in place
-- (no new overload). The body is reduced to the authorization gate plus the
-- refusal.

CREATE OR REPLACE FUNCTION public.restore_cancelled_order(p_order_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  -- Authorize the REAL caller (strict actor), then refuse — restore is disabled.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- H4 fix: restoring a cancelled order cannot safely reverse the cancel's
  -- side-effects (released inventory prebook/holds, zeroed commissions, reversed
  -- booking draws), so it is no longer permitted. Create a new order or
  -- re-convert / revert the source quote instead.
  RAISE EXCEPTION 'ORDER_RESTORE_NOT_SUPPORTED: a cancelled order cannot be safely restored — its released inventory reservations, commissions, and booking draws are not re-applied, which would leave a corrupt confirmed order. Create a new order, or re-convert/revert the source quote instead.';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.restore_cancelled_order(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_cancelled_order(uuid, text, uuid, text) TO authenticated, service_role;
