-- ============================================================================
-- Option B credit visibility (Mason's decision 2026-07-11): open (unapplied)
-- credit-memo balances NEVER auto-net into AR — instead every AR report
-- surfaces them as a separate "credit on file" figure so an operator applies
-- the credit explicitly and nobody duns / finance-charges a net-zero account.
--
-- Open credit per customer = -SUM(balance_cents) over posted credit_memo
-- invoices with balance_cents < 0 (a credit memo's GENERATED balance starts at
-- -total and rises to 0 as credit_applied_cents grows).
--
-- Four report functions change:
--   1. get_ar_reminder_candidates — body-only re-emit (byte-identical to live
--      + ONE inserted scalar subquery adding open_credit_cents to the payload).
--   2. get_ar_aging               — DROP/CREATE: new open_credit_cents column.
--   3. preview_finance_charges    — DROP/CREATE: new open_credit_cents column
--      (the interest MATH is unchanged; the modal can now warn the operator).
--   4. get_customer_balance_listing — DROP/CREATE: stops silently netting
--      credit memos into outstanding_balance (the one view that did); credit
--      moves to its own open_credit column; credit-only customers now listed.
-- No table/data changes. All figures new columns only — no existing column's
-- meaning changes except listing's outstanding_balance, which now excludes
-- credit memos (Option B: owed = real invoices until credit is applied).
--
-- caller-analysis: get_ar_aging :: all 4 UI callsites (ARaging.tsx:98,
--   AccountsReceivable.tsx:42, CustomerDetail.tsx:284,
--   CustomerContextCard.tsx:44) call via supabase.rpc as the authenticated
--   role; EXECUTE is re-GRANTed to authenticated + service_role in this same
--   migration immediately after the CREATE. Only PUBLIC/anon lose the
--   post-CREATE default grant (matching the prior live ACL, which had no
--   anon/PUBLIC entry). No caller affected.
-- caller-analysis: preview_finance_charges :: sole UI callsite
--   (FinanceChargePreviewModal.tsx:50) calls as authenticated; EXECUTE
--   re-GRANTed to authenticated + service_role in this same migration.
--   Only PUBLIC/anon dropped (matches prior live ACL). No caller affected.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. get_ar_reminder_candidates (dunning): add open_credit_cents per customer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ar_reminder_candidates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
  _role  text;
  v_setting_raw text;
  v_num numeric;
  v_threshold int;
BEGIN
  _role := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'user_role',
    (SELECT role FROM public.profiles WHERE id = auth.uid())
  );
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  -- Configurable threshold (Settings > app_settings.ar_reminder_days). Robust: take the LEADING
  -- integer part (so '30', '30.0', ' 45 ' all read as 30/30/45 — NOT digit-stripping, which would
  -- turn '30.0'->300 or '1e2'->12), default 30 on blank/garbage/missing, clamp 1..3650 so a bad
  -- value can never break the report.
  SELECT setting_value INTO v_setting_raw FROM app_settings WHERE setting_key = 'ar_reminder_days';
  v_num := (regexp_match(COALESCE(v_setting_raw, ''), '^\s*(\d+)'))[1]::numeric;
  v_threshold := CASE WHEN v_num IS NULL THEN 30 ELSE LEAST(GREATEST(v_num, 1), 3650)::int END;

  SELECT COALESCE(jsonb_agg(row_to_json(cust_agg)::jsonb), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      c.prepay_balance_cents,
      (SELECT COALESCE(-SUM(ci.balance_cents), 0)::bigint
         FROM invoices ci
        WHERE ci.customer_id = c.id
          AND ci.invoice_type = 'credit_memo'
          AND ci.status = 'posted'
          AND ci.balance_cents < 0
          AND ci.deleted_at IS NULL) AS open_credit_cents,
      MAX(EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int) AS max_days_past_due,
      COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0) / 100.0 AS total_balance,
      jsonb_agg(jsonb_build_object(
        'invoice_id', i.id,
        'invoice_number', i.invoice_number,
        'invoice_date', i.invoice_date,
        'balance_cents', i.balance_cents,
        'days_past_due', EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int
      ) ORDER BY i.invoice_date) AS invoices
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int > v_threshold
      AND c.email IS NOT NULL
      AND c.email <> ''
    GROUP BY c.id, c.farm_name, c.email, c.prepay_balance_cents
    ORDER BY max_days_past_due DESC
  ) cust_agg;

  RETURN result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. get_ar_aging: new open_credit_cents column (return-type change => DROP)
-- ---------------------------------------------------------------------------
DROP FUNCTION public.get_ar_aging(date);

CREATE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(customer_id uuid, farm_name text, current_amount numeric, days_30 numeric, days_60 numeric, days_90 numeric, over_90 numeric, total_outstanding numeric, prepay_balance_cents bigint, open_credit_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'Admin access required for AR aging report';
  END IF;
  RETURN QUERY
  SELECT c.id AS customer_id, c.farm_name,
    COALESCE(SUM(CASE WHEN age_days <= 29 THEN balance END), 0) AS current_amount,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 30 AND 59 THEN balance END), 0) AS days_30,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 60 AND 89 THEN balance END), 0) AS days_60,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 90 AND 119 THEN balance END), 0) AS days_90,
    COALESCE(SUM(CASE WHEN age_days >= 120 THEN balance END), 0) AS over_90,
    COALESCE(SUM(balance), 0) AS total_outstanding,
    c.prepay_balance_cents,
    COALESCE(cm.credit_cents, 0)::bigint AS open_credit_cents
  FROM customers c
  INNER JOIN (
    SELECT i.customer_id, (i.balance_cents::numeric / 100) AS balance, (p_as_of_date - COALESCE(i.due_date, i.invoice_date)::date) AS age_days
    FROM invoices i WHERE i.status IN ('posted', 'overdue') AND i.balance_cents > 0 AND i.deleted_at IS NULL
  ) ar ON ar.customer_id = c.id
  LEFT JOIN (
    SELECT ci.customer_id, -SUM(ci.balance_cents) AS credit_cents
    FROM invoices ci
    WHERE ci.invoice_type = 'credit_memo' AND ci.status = 'posted'
      AND ci.balance_cents < 0 AND ci.deleted_at IS NULL
    GROUP BY ci.customer_id
  ) cm ON cm.customer_id = c.id
  GROUP BY c.id, c.farm_name, c.prepay_balance_cents, cm.credit_cents
  HAVING SUM(balance) > 0 ORDER BY SUM(balance) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ar_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_aging(date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. preview_finance_charges: new open_credit_cents column (=> DROP/CREATE).
--    Charge math untouched; the preview modal shows the credit so the operator
--    applies it before charging interest.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.preview_finance_charges(date);

CREATE FUNCTION public.preview_finance_charges(p_as_of_date date)
 RETURNS TABLE(customer_id uuid, customer_name text, account_number text, overdue_balance_cents bigint, charge_rate numeric, grace_days integer, days_overdue integer, charge_amount_cents bigint, finance_charge_enabled boolean, open_credit_cents bigint)
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
  ORDER BY c.farm_name;
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_finance_charges(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_finance_charges(date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. get_customer_balance_listing: stop netting credit memos into outstanding;
--    expose open_credit separately; list credit-only customers too.
--    SECURITY INVOKER (caller RLS applies) — default EXECUTE grant preserved,
--    matching the prior live grant state (PUBLIC/anon had EXECUTE; RLS gates).
--    No REVOKE here, so no caller-analysis needed: access is unchanged.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.get_customer_balance_listing(date);

CREATE FUNCTION public.get_customer_balance_listing(p_as_of_date date)
 RETURNS TABLE(customer_id uuid, farm_name text, total_invoiced numeric, total_paid numeric, prepay_applied numeric, outstanding_balance numeric, open_credit numeric, invoice_count bigint, oldest_unpaid_date date)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    c.id, c.farm_name,
    ROUND(COALESCE(SUM(i.total_amount_cents), 0) / 100.0, 2),
    ROUND(COALESCE(SUM(i.paid_amount_cents), 0) / 100.0, 2),
    ROUND(COALESCE(SUM(i.prepay_applied_cents), 0) / 100.0, 2),
    ROUND(COALESCE(SUM(i.balance_cents), 0) / 100.0, 2),
    ROUND(COALESCE(cm.credit_cents, 0) / 100.0, 2),
    COUNT(i.id),
    MIN(CASE WHEN i.balance_cents > 0 THEN i.invoice_date::date END)
  FROM public.customers c
  LEFT JOIN public.invoices i ON i.customer_id = c.id
    AND i.status IN ('posted', 'unposted')
    AND i.invoice_type <> 'credit_memo'
    AND i.deleted_at IS NULL
    AND i.invoice_date <= p_as_of_date
  LEFT JOIN (
    SELECT ci.customer_id, -SUM(ci.balance_cents) AS credit_cents
    FROM public.invoices ci
    WHERE ci.invoice_type = 'credit_memo' AND ci.status = 'posted'
      AND ci.balance_cents < 0 AND ci.deleted_at IS NULL
      AND ci.invoice_date <= p_as_of_date
    GROUP BY ci.customer_id
  ) cm ON cm.customer_id = c.id
  GROUP BY c.id, c.farm_name, cm.credit_cents
  HAVING COALESCE(SUM(i.balance_cents), 0) != 0 OR COALESCE(cm.credit_cents, 0) != 0
  ORDER BY COALESCE(SUM(i.balance_cents), 0) DESC;
$function$;

-- ---------------------------------------------------------------------------
-- Post-emit verification: single overload each; new column present in the
-- result signature (or, for the jsonb fn, in the body).
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_fn text;
  v_count int;
  v_ok boolean;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['get_ar_aging','preview_finance_charges','get_customer_balance_listing','get_ar_reminder_candidates'] LOOP
    SELECT count(*) INTO v_count FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = v_fn;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'ar-credit-visibility verification: expected 1 overload of %, found %', v_fn, v_count;
    END IF;
  END LOOP;

  SELECT bool_and(pg_get_function_result(oid) ILIKE '%open_credit%') INTO v_ok
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('get_ar_aging','preview_finance_charges','get_customer_balance_listing');
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'ar-credit-visibility verification: open_credit column missing from a result signature';
  END IF;

  SELECT prosrc LIKE '%open_credit_cents%' INTO v_ok
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_ar_reminder_candidates';
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'ar-credit-visibility verification: reminder payload missing open_credit_cents';
  END IF;
END;
$verify$;
