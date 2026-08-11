-- Post-apply invariant for the forward-only pending commission snapshot repair.
--
-- The repair intentionally mirrors update_order_items: only order-channel rows
-- that are pending, not soft-deleted, and not frozen in a non-voided payout
-- batch are eligible. Job/application commissions use a different profit basis
-- and are excluded by c.job_id IS NULL.
--
-- This chain is read-only. Its terminal exception is still the house rollback
-- marker so run-smoke.mjs can certify the live post-apply state consistently.

DO $smoke$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*)
  INTO v_remaining
  FROM public.commissions c
  JOIN public.orders o ON o.id = c.order_id
  WHERE c.order_id IS NOT NULL
    AND c.job_id IS NULL
    AND c.status = 'pending'
    AND c.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.commission_payment_items cpi
      JOIN public.commission_payments cp
        ON cp.id = cpi.commission_payment_id
      WHERE cpi.commission_id = c.id
        AND cp.status <> 'voided'
    )
    AND (
      c.order_profit IS DISTINCT FROM ROUND(COALESCE(o.total_profit, 0), 2)
      OR c.commission_amount IS DISTINCT FROM
         public.compute_commission_amount(o.total_profit, c.split_percentage)
    );

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: % eligible pending order commission snapshot rows still disagree with the canonical order header.',
      v_remaining;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
