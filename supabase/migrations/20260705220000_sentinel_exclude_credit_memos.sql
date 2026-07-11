-- Sentinel fix — exclude credit memos from negative-balance alerts
-- ============================================================================
-- Codex re-review 2026-07-05 [P2]: credit memos are DELIBERATELY negative —
-- `issue_return_credit` creates invoice_type='credit_memo' with negative
-- totals, and the live CHECK invoices_balance_non_negative itself exempts
-- that type: CHECK ((invoice_type = 'credit_memo') OR (balance_cents >= 0)).
-- Without this filter the daily 06:45 sweep raises a negative_invoice_balance
-- alert for every valid open credit — alert fatigue that trains the owner to
-- ignore the sentinel.
--
-- This is a verbatim re-emit of the LIVE run_data_integrity_sweep() (its full
-- definition read from the live catalog 2026-07-05, applied v20260705215859,
-- and reproduced here explicitly line-by-line) with exactly ONE functional
-- change, marked -- CHANGED below: check (b) adds
-- AND inv.invoice_type <> 'credit_memo' (plus its comment updated to match).
-- No table/ACL/cron changes — those stand as applied by 20260705150000.
-- idempotency-body-check: exempt — cron-driven sweep, no client caller (see 20260705150000)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.run_data_integrity_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_negative_inventory integer := 0;
  v_negative_invoices  integer := 0;
  v_stale_holds        integer := 0;
  v_overdraws          integer := 0;
BEGIN
  -- admin-only when an authenticated user calls this; pg_cron / service_role
  -- (auth.uid() = NULL) bypass. Same pattern as check_unpriced_orders.
  IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- (a) NEW negative inventory: per-product net position across locations,
  --     skipping the pre-existing negatives in the baseline (H1).
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_inventory', 'products', neg.product_id,
         jsonb_build_object('net_quantity_available', neg.net_qty)
  FROM (
    SELECT product_id, SUM(quantity_available) AS net_qty
    FROM inventory
    GROUP BY product_id
    HAVING SUM(quantity_available) < 0
  ) neg
  WHERE NOT EXISTS (
    SELECT 1 FROM integrity_negative_baseline b WHERE b.product_id = neg.product_id
  )
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_inventory = ROW_COUNT;

  -- (b) Invoices with a negative balance. balance_cents is GENERATED ALWAYS
  --     ((total - paid - prepay_applied - write_off)) — SELECT-only here.
  --     Negative means we over-collected — anomalous EXCEPT for credit memos,
  --     which are legitimately negative (the live invoices_balance_non_negative
  --     CHECK exempts invoice_type='credit_memo' for exactly this reason).
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_invoice_balance', 'invoices', inv.id,
         jsonb_build_object(
           'invoice_number', inv.invoice_number,
           'status',         inv.status,
           'balance_cents',  inv.balance_cents)
  FROM invoices inv
  WHERE inv.balance_cents < 0
    AND inv.invoice_type <> 'credit_memo'  -- CHANGED (Codex 2026-07-05 P2): valid open credits are negative by design
    AND inv.deleted_at IS NULL
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_invoices = ROW_COUNT;

  -- (c) Active crop_program holds whose parent quote is terminal — those holds
  --     should have been released by the decline/expire/cancel/close paths;
  --     a survivor silently shrinks Net Free forever.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'stale_quote_hold', 'inventory_holds', h.id,
         jsonb_build_object(
           'quote_id',     q.id,
           'quote_status', q.status,
           'product_id',   h.product_id,
           'quantity',     h.quantity)
  FROM inventory_holds h
  JOIN quotes q ON q.id = h.source_id
  WHERE h.is_active = true
    AND h.hold_type = 'crop_program'
    AND q.status IN ('declined', 'expired', 'cancelled', 'closed_by_application')
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_stale_holds = ROW_COUNT;

  -- (d) Booking overdraw: drawn more than the booking cap. Cap = the same
  --     SUM(COALESCE(quote_items.total_units_needed, 0)) per (quote, product)
  --     that draw_down_quote's fully-drawn check uses (20260610145253).
  --     Also catches drawn > 0 rows whose quote_items lines were edited away
  --     (cap collapses to 0) — that IS drift worth flagging.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'booking_overdraw', 'quote_product_draws', d.id,
         jsonb_build_object(
           'quote_id',       d.quote_id,
           'product_id',     d.product_id,
           'quantity_drawn', d.quantity_drawn,
           'booking_cap',    cap.booked)
  FROM quote_product_draws d
  JOIN quotes q ON q.id = d.quote_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(COALESCE(qi.total_units_needed, 0)), 0) AS booked
    FROM quote_items qi
    WHERE qi.quote_id = d.quote_id AND qi.product_id = d.product_id
  ) cap
  WHERE q.deleted_at IS NULL
    AND d.quantity_drawn > cap.booked
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_overdraws = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'new_negative_inventory', v_negative_inventory,
    'new_negative_invoice_balance', v_negative_invoices,
    'new_stale_quote_holds', v_stale_holds,
    'new_booking_overdraws', v_overdraws
  );
END;
$function$;
