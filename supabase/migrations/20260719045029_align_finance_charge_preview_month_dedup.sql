-- Codex gauntlet closeout: preview_finance_charges must show the exact customer
-- set that generate_finance_charges can charge. H2 made generation skip any
-- customer already charged in the calendar month; preview now mirrors that
-- exclusion instead of presenting an operator-selectable row that is silently
-- omitted during generation.

CREATE OR REPLACE FUNCTION public.preview_finance_charges(p_as_of_date date)
RETURNS TABLE(
  customer_id uuid,
  customer_name text,
  account_number text,
  overdue_balance_cents bigint,
  charge_rate numeric,
  grace_days integer,
  days_overdue integer,
  charge_amount_cents bigint,
  finance_charge_enabled boolean,
  open_credit_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_min_balance bigint;
BEGIN
  PERFORM require_admin();
  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'FINANCE_CHARGE_DATE_REQUIRED';
  END IF;
  IF p_as_of_date > (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'FUTURE_FINANCE_CHARGE_DATE: finance charges cannot be previewed for a future business date';
  END IF;
  -- Exact operator parity: generation rejects a closed accounting period before
  -- selecting any customer, so preview must reject the same date too.
  PERFORM public.check_period_open(p_as_of_date);

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
    COALESCE(c.finance_charge_enabled, true) AS finance_charge_enabled,
    COALESCE(cm.credit_cents, 0)::bigint AS open_credit_cents
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
  LEFT JOIN (
    SELECT ci.customer_id, -SUM(ci.balance_cents) AS credit_cents
    FROM public.invoices ci
    WHERE ci.invoice_type = 'credit_memo' AND ci.status = 'posted'
      AND ci.balance_cents < 0 AND ci.deleted_at IS NULL
    GROUP BY ci.customer_id
  ) cm ON cm.customer_id = c.id
  WHERE c.finance_charge_rate > 0
    AND c.is_active = true
    AND COALESCE(c.finance_charge_enabled, true) = true
    AND agg.overdue_balance_cents >= v_min_balance
    AND ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint > 0
    AND NOT EXISTS (
      SELECT 1
        FROM public.finance_charges fc
       WHERE fc.customer_id = c.id
         AND date_trunc('month', fc.period_end) = date_trunc('month', p_as_of_date)
    )
  ORDER BY c.farm_name;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.preview_finance_charges(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_finance_charges(date) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_source text;
BEGIN
  IF has_function_privilege('anon', 'public.preview_finance_charges(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_finance_charges(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'preview_finance_charges grants drifted from the reviewed contract';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = 'public.preview_finance_charges(date)'::regprocedure
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'preview_finance_charges security/volatility contract drifted';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.preview_finance_charges(date)'::regprocedure;
  IF v_source IS NULL
     OR strpos(v_source, 'check_period_open(p_as_of_date)') = 0
     OR strpos(v_source, 'date_trunc(''month'', fc.period_end)') = 0 THEN
    RAISE EXCEPTION 'preview_finance_charges closed-period/month-dedup parity markers are missing';
  END IF;
END;
$postflight$;
