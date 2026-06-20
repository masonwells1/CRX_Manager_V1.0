-- Overnight bug-hunt MED: money:preview_finance_charges:overdue-set-divergence
--
-- BUG: preview_finance_charges and generate_finance_charges select DIFFERENT overdue
-- row sets, so the finance-charge amount an admin APPROVES in the preview can differ
-- from what generate actually bills a shown customer.
--   * preview used status = 'posted' only  -> DROPS invoices the daily mark_overdue
--     cron has flipped to 'overdue' (the MOST overdue ones); generate uses
--     status IN ('posted','overdue').
--   * preview applied grace POST-HOC (max_days_overdue > grace_days on the aggregate)
--     against a flat `due_date < as_of`; generate bakes grace into the PER-INVOICE
--     due_date predicate `due_date < (as_of - grace days)`.
--
-- FIX: align preview's base set to EXACTLY match generate's (generate is the billing
-- source of truth, so only preview changes): status IN ('posted','overdue'), and the
-- same grace-aware per-invoice due_date predicate (join customers inside the aggregate
-- to read each customer's grace_days), and drop the now-redundant post-hoc grace filter.
-- After this, preview shows exactly what generate will bill for the same as_of_date.
--
-- (Ideal future hardening, NOT done here to keep the change minimal/reviewable: extract
-- the overdue base set into one STABLE helper both functions call + a parity test
-- asserting preview total == generate total. The two predicates MUST be kept in sync.)
--
-- Only preview_finance_charges changes; reproduced verbatim from the live definition
-- (read 2026-06-20) with ONLY the base-set predicate aligned — verified by a rolled-back
-- line-level diff. Latent on live data (0 posted/overdue invoices, 0 finance_charges).

CREATE OR REPLACE FUNCTION public.preview_finance_charges(p_as_of_date date)
 RETURNS TABLE(customer_id uuid, customer_name text, account_number text, overdue_balance_cents bigint, charge_rate numeric, grace_days integer, days_overdue integer, charge_amount_cents bigint, finance_charge_enabled boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_min_balance bigint;
BEGIN
  PERFORM require_admin();
  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  RETURN QUERY
  SELECT
    c.id AS customer_id,
    c.farm_name::text AS customer_name,
    c.account_number::text AS account_number,
    agg.overdue_balance_cents,
    c.finance_charge_rate AS charge_rate,
    COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
    agg.max_days_overdue AS days_overdue,
    ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint AS charge_amount_cents,
    COALESCE(c.finance_charge_enabled, true) AS finance_charge_enabled
  FROM public.customers c
  INNER JOIN (
    -- Base overdue set — MUST mirror generate_finance_charges exactly so the previewed
    -- amount equals the billed amount: status IN ('posted','overdue') + grace-aware
    -- per-invoice due_date predicate (grace read per-customer via the cc join).
    SELECT
      i.customer_id,
      COALESCE(sum(i.balance_cents), 0)::bigint AS overdue_balance_cents,
      max((p_as_of_date - i.due_date))::integer AS max_days_overdue
    FROM public.invoices i
    JOIN public.customers cc ON cc.id = i.customer_id
    WHERE i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_type != 'misc_charge'
      AND i.due_date IS NOT NULL
      AND i.due_date < (p_as_of_date - (COALESCE(cc.finance_charge_grace_days, 0) || ' days')::interval)
    GROUP BY i.customer_id
  ) agg ON agg.customer_id = c.id
  WHERE c.finance_charge_rate > 0
    AND c.is_active = true
    AND COALESCE(c.finance_charge_enabled, true) = true
    AND agg.overdue_balance_cents >= v_min_balance
    AND ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint > 0
  ORDER BY c.farm_name;
END;
$function$;
