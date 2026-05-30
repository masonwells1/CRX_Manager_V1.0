-- idempotency-body-check: exempt
-- (all 7 functions here are read-only reports; get_ap_dashboard_summary carries a vestigial
--  unused p_idempotency_key param — no mutation, so no idempotency_keys usage is correct.)
--
-- 20260529220000_gate_admin_only_financial_report_rpcs.sql
--
-- Defense-in-depth (follow-up to 20260529214355 anon-revoke; workflow review + Codex 2026-05-29).
--
-- WHAT / WHY:
--   The 2026-05-29 REVOKE closed the *public* (anon) path on 37 SECDEF report RPCs, but those
--   functions are still EXECUTE-able by any *authenticated* role (admin / sales_rep / driver /
--   applicator) because Postgres only has the single `authenticated` role — app roles live in
--   profiles.role and can only be enforced inside the function body. A logged-in non-admin could
--   therefore still call these directly (e.g. via the JS console with their own session) and read
--   data their UI never shows them.
--
--   This migration adds an internal `PERFORM require_admin();` guard to the 7 report RPCs that are
--   reached ONLY from admin-only pages (verified caller map 2026-05-29: AP aging/dashboard,
--   month-end P&L, AR statement/transaction-review, season comparison, finance-charge preview).
--   require_admin() does `SELECT role ... WHERE id=auth.uid() AND is_active; IF v_role IS NULL OR
--   v_role <> 'admin' THEN RAISE` — so it rejects anon (NULL), service/cron (NULL), and any
--   non-admin authenticated user, while admins are unaffected.
--
-- SCOPE / SAFETY (verified pre-write against live + code):
--   • Only these 7 — all confirmed reachable ONLY from admin-only routes in src/App.tsx.
--   • NOT touched: the 14 admin+sales report RPCs (sales reps legitimately see that data;
--     documented as a follow-up), the all-roles dashboard/teamboard/command-palette functions,
--     the driver/applicator-reachable get_notes_for_entity, and the internal billing helpers —
--     gating any of those would 403 a legitimate caller (the B10 incident class).
--   • Verified NO pg_cron job and NO Edge Function calls any of these 7 (both would run with
--     auth.uid()=NULL and be rejected by the guard). require_admin() RAISEs for NULL — confirmed.
--   • Each body is byte-faithful to its live definition; the ONLY change is inserting
--     `PERFORM require_admin();` as the first statement after BEGIN. Single overload each.
--
-- Post-apply behavioral verification (run by the applier): each fn must RAISE 'Permission denied'
--   when called as anon/non-admin, and still return for an admin context.

CREATE OR REPLACE FUNCTION public.get_ap_aging(p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(vendor_id uuid, vendor_name text, current_amount bigint, days_31_60 bigint, days_61_90 bigint, over_90 bigint, total_outstanding bigint, bill_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin();
  RETURN QUERY
  SELECT v.id AS vendor_id, v.name AS vendor_name,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) <= 30 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS current_amount,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 31 AND 60 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_31_60,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 61 AND 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_61_90,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) > 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS over_90,
    COALESCE(SUM(vb.balance_cents), 0)::bigint AS total_outstanding,
    COUNT(vb.id)::integer AS bill_count
  FROM vendors v
  LEFT JOIN vendor_bills vb ON vb.vendor_id = v.id
    AND vb.status IN ('unpaid', 'partially_paid')
    AND vb.deleted_at IS NULL
  WHERE v.deleted_at IS NULL
  GROUP BY v.id, v.name
  HAVING COALESCE(SUM(vb.balance_cents), 0) > 0
  ORDER BY COALESCE(SUM(vb.balance_cents), 0) DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_ap_dashboard_summary(p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM require_admin();
  SELECT jsonb_build_object(
    'total_owed_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') THEN balance_cents ELSE 0 END), 0),
    'overdue_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN balance_cents ELSE 0 END), 0),
    'overdue_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN 1 END),
    'due_this_week_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN balance_cents ELSE 0 END), 0),
    'due_this_week_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN 1 END),
    'due_this_month_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 THEN balance_cents ELSE 0 END), 0),
    'total_bills', COUNT(*),
    'unpaid_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') THEN 1 END),
    'paid_this_month_cents', COALESCE((
      SELECT SUM(vp.amount_cents)
      FROM vendor_payments vp
      JOIN vendor_bills vb2 ON vb2.id = vp.vendor_bill_id
      WHERE vp.payment_date >= date_trunc('month', CURRENT_DATE)
    ), 0)
  )
  INTO v_result
  FROM vendor_bills
  WHERE deleted_at IS NULL AND status <> 'voided';

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_transaction_review(p_customer_id uuid, p_start_date date, p_end_date date)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, debit_cents bigint, credit_cents bigint, running_balance_cents bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin();
  RETURN QUERY
  WITH all_transactions AS (
    SELECT i.invoice_date AS tx_date,
           'Invoice' AS tx_type,
           i.invoice_number AS ref_num,
           CASE i.invoice_type
             WHEN 'chemical_sale' THEN 'Chemical Sale'
             WHEN 'field_application' THEN 'Field Application'
             WHEN 'misc_charge' THEN 'Misc Charge'
             ELSE COALESCE(i.invoice_type, 'Invoice')
           END AS descr,
           i.total_amount_cents AS debit,
           0::bigint AS credit
      FROM public.invoices i
     WHERE i.customer_id = p_customer_id
       AND i.status IN ('posted', 'paid', 'overdue')
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT als.payment_date AS tx_date,
           'Payment' AS tx_type,
           COALESCE(als.reference_number, als.check_number, 'PMT-' || LEFT(als.id::text, 8)) AS ref_num,
           COALESCE(als.payment_method, 'Payment') ||
             CASE WHEN als.check_number IS NOT NULL THEN ' #' || als.check_number ELSE '' END ||
             COALESCE(' — ' || als.notes, '') AS descr,
           0::bigint AS debit,
           ila.amount_cents AS credit
      FROM public.allocation_sets als
      JOIN public.invoice_line_allocations ila ON ila.allocation_set_id = als.id
     WHERE als.customer_id = p_customer_id
       AND als.payment_date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT pa.applied_at::date AS tx_date,
           'Prepay Applied' AS tx_type,
           'PP-' || LEFT(pa.id::text, 8) AS ref_num,
           'Prepay credit applied' AS descr,
           0::bigint AS debit,
           pa.applied_amount_cents AS credit
      FROM public.prepay_applications pa
      JOIN public.invoices i ON i.id = pa.invoice_id
     WHERE i.customer_id = p_customer_id
       AND i.deleted_at IS NULL
       AND pa.applied_at::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT w.created_at::date AS tx_date,
           'Write-Off' AS tx_type,
           'WO-' || LEFT(w.id::text, 8) AS ref_num,
           COALESCE(w.reason, 'Write-off') AS descr,
           0::bigint AS debit,
           w.amount_cents AS credit
      FROM public.write_offs w
     WHERE w.customer_id = p_customer_id
       AND w.created_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT t.tx_date AS transaction_date,
         t.tx_type AS transaction_type,
         t.ref_num AS reference_number,
         t.descr AS description,
         t.debit AS debit_cents,
         t.credit AS credit_cents,
         (SUM(t.debit - t.credit) OVER (ORDER BY t.tx_date, t.tx_type, t.ref_num))::bigint AS running_balance_cents
    FROM all_transactions t
   ORDER BY t.tx_date, t.tx_type, t.ref_num;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_detailed_statement_data(p_customer_id uuid, p_as_of_date date, p_mode text DEFAULT 'summary'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer RECORD;
  v_aging jsonb;
  v_balance bigint := 0;
  v_inv RECORD;
  v_items jsonb;
  v_shares jsonb;
  v_finance_cents bigint;
  v_txn_list jsonb := '[]'::jsonb;
  v_days_aged integer;
  v_description text;
  v_grower_names text[];
BEGIN
  PERFORM require_admin();
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  FOR v_inv IN
    SELECT i.*
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_date <= p_as_of_date
    ORDER BY i.invoice_date, i.invoice_number
  LOOP
    v_balance := v_balance + v_inv.balance_cents;
    v_days_aged := p_as_of_date - v_inv.invoice_date;

    IF v_inv.invoice_type = 'field_application' AND v_inv.crop_type IS NOT NULL THEN
      v_description := COALESCE(v_inv.crop_type, '')
        || ' - ' || COALESCE(v_inv.total_acres::text, '')
        || ' - ' || COALESCE(array_to_string(v_inv.field_names, ', '), '');
    ELSIF v_inv.invoice_type = 'chemical_sale' THEN
      v_description := 'Chemical Sale: ' || COALESCE(v_inv.header_notes, '');
    ELSE
      v_description := COALESCE(v_inv.header_notes, v_inv.invoice_type);
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'split_percentage', s.split_percentage,
          'acres', s.acres,
          'amount_cents', s.amount_cents,
          'is_primary', s.is_primary,
          'price_per_acre_cents', CASE
            WHEN s.customer_id = p_customer_id THEN s.price_per_acre_cents
            ELSE NULL
          END,
          'pricing_note', CASE
            WHEN s.customer_id = p_customer_id THEN s.pricing_note
            ELSE NULL
          END
        ) ORDER BY s.sort_order
      ),
      '[]'::jsonb
    )
    INTO v_shares
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    SELECT array_agg(s.customer_name ORDER BY s.sort_order)
    INTO v_grower_names
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    v_items := '[]'::jsonb;
    IF p_mode = 'detailed' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'product_name', ii.description,
            'epa_registration', ii.epa_registration,
            'rate_per_acre', ii.rate_per_acre,
            'rate_unit', ii.rate_unit,
            'total_applied', ii.total_applied,
            'total_applied_unit', ii.total_applied_unit,
            'total_applied_gl_lb', ii.total_applied_gl_lb,
            'gl_lb_unit', ii.gl_lb_unit,
            'unit_price_cents', ii.unit_price_cents,
            'total_cost_cents', ii.extended_cents,
            'is_application_fee', COALESCE(ii.is_application_fee, false),
            'quantity', ii.quantity,
            'unit_size', ii.unit_size,
            'product_form', ii.product_form
          ) ORDER BY ii.sort_order
        ),
        '[]'::jsonb
      )
      INTO v_items
      FROM invoice_items ii
      WHERE ii.invoice_id = v_inv.id;
    END IF;

    SELECT COALESCE(sum(fc.amount_cents), 0)
    INTO v_finance_cents
    FROM finance_charges fc
    WHERE fc.invoice_id = v_inv.id;

    v_txn_list := v_txn_list || jsonb_build_object(
      'invoice_number', v_inv.invoice_number,
      'invoice_date', v_inv.invoice_date,
      'due_date', v_inv.due_date,
      'invoice_type', v_inv.invoice_type,
      'status', v_inv.status,
      'days_aged', v_days_aged,
      'description', v_description,
      'crop_type', v_inv.crop_type,
      'field_names', v_inv.field_names,
      'total_acres', v_inv.total_acres,
      'grower_names', v_grower_names,
      'total_amount_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'balance_cents', v_inv.balance_cents,
      'items', v_items,
      'shares', v_shares,
      'finance_charge_cents', v_finance_cents,
      'net_due_cents', v_inv.balance_cents + v_finance_cents,
      'price_per_acre', CASE
        WHEN v_inv.total_acres > 0 THEN
          round(v_inv.total_amount_cents / 100.0 / v_inv.total_acres, 2)
        ELSE NULL
      END
    );
  END LOOP;

  -- Fixed aging buckets: non-overlapping, includes overdue status
  SELECT jsonb_build_object(
    'current_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date <= 30 THEN i.balance_cents ELSE 0 END), 0),
    'days_30_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 31 AND 60 THEN i.balance_cents ELSE 0 END), 0),
    'days_60_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 61 AND 90 THEN i.balance_cents ELSE 0 END), 0),
    'days_90_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 91 AND 120 THEN i.balance_cents ELSE 0 END), 0),
    'over_120_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date > 120 THEN i.balance_cents ELSE 0 END), 0)
  )
  INTO v_aging
  FROM invoices i
  WHERE i.customer_id = p_customer_id
    AND i.status IN ('posted', 'overdue')
    AND i.balance_cents > 0
    AND i.deleted_at IS NULL
    AND i.invoice_date <= p_as_of_date;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_customer.id,
      'farm_name', v_customer.farm_name,
      'contact_name', v_customer.contact_name,
      'account_number', v_customer.account_number,
      'email', v_customer.email,
      'phone', v_customer.phone,
      'billing_address', v_customer.billing_address,
      'city', v_customer.city,
      'state', v_customer.state,
      'zip', v_customer.zip,
      'payment_terms', v_customer.payment_terms
    ),
    'transactions', v_txn_list,
    'aging', v_aging,
    'outstanding_balance_cents', v_balance,
    'as_of_date', p_as_of_date,
    'mode', p_mode
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_monthly_summary(p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM require_admin();
  SELECT jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue') AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((
        SELECT sum(ii.cost_cents * ii.quantity)
        FROM public.invoice_items ii
        JOIN public.invoices inv ON inv.id = ii.invoice_id
        WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end
          AND inv.status IN ('posted', 'overdue')
          AND inv.deleted_at IS NULL
      ), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft','unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    'payments', jsonb_build_object(
      'count', (SELECT count(*) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL),
      'total_cents', COALESCE((SELECT sum((amount * 100)::bigint) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 0)
    ),
    'orders', jsonb_build_object(
      'count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')),
      'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)
    ),
    'deliveries', jsonb_build_object(
      'count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL),
      'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)
    ),
    'applications', jsonb_build_object(
      'count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end),
      'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)
    ),
    'commissions', jsonb_build_object(
      'earned_cents', COALESCE((SELECT sum((commission_amount * 100)::bigint) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end), 0),
      'paid_count', (SELECT count(*) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end AND status = 'paid')
    ),
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status IN ('posted', 'overdue') AND balance_cents > 0 AND deleted_at IS NULL), 0)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_season_comparison(p_season_a integer, p_season_b integer)
 RETURNS TABLE(metric text, season_a_val numeric, season_b_val numeric, change_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a_start date;
  v_a_end date;
  v_b_start date;
  v_b_end date;
  v_a_revenue numeric;
  v_b_revenue numeric;
  v_a_profit numeric;
  v_b_profit numeric;
  v_a_orders int;
  v_b_orders int;
  v_a_customers int;
  v_b_customers int;
BEGIN
  PERFORM require_admin();
  v_a_start := season_start_date(p_season_a);
  v_a_end   := season_end_date(p_season_a);
  v_b_start := season_start_date(p_season_b);
  v_b_end   := season_end_date(p_season_b);

  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_a_revenue, v_a_profit, v_a_orders, v_a_customers
  FROM orders
  WHERE order_date BETWEEN v_a_start AND v_a_end
    AND status <> 'cancelled';

  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_b_revenue, v_b_profit, v_b_orders, v_b_customers
  FROM orders
  WHERE order_date BETWEEN v_b_start AND v_b_end
    AND status <> 'cancelled';

  RETURN QUERY VALUES
    ('Revenue'::text, v_a_revenue, v_b_revenue,
      CASE WHEN v_b_revenue > 0 THEN ROUND((v_a_revenue - v_b_revenue) / v_b_revenue * 100, 1) ELSE NULL END),
    ('Profit'::text, v_a_profit, v_b_profit,
      CASE WHEN v_b_profit > 0 THEN ROUND((v_a_profit - v_b_profit) / v_b_profit * 100, 1) ELSE NULL END),
    ('Orders'::text, v_a_orders::numeric, v_b_orders::numeric,
      CASE WHEN v_b_orders > 0 THEN ROUND((v_a_orders - v_b_orders)::numeric / v_b_orders * 100, 1) ELSE NULL END),
    ('Active Customers'::text, v_a_customers::numeric, v_b_customers::numeric,
      CASE WHEN v_b_customers > 0 THEN ROUND((v_a_customers - v_b_customers)::numeric / v_b_customers * 100, 1) ELSE NULL END);
END;
$function$;

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
    SELECT
      i.customer_id,
      COALESCE(sum(i.balance_cents), 0)::bigint AS overdue_balance_cents,
      max((p_as_of_date - i.due_date))::integer AS max_days_overdue
    FROM public.invoices i
    WHERE i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_type != 'misc_charge'
      AND i.due_date IS NOT NULL
      AND i.due_date < p_as_of_date
    GROUP BY i.customer_id
  ) agg ON agg.customer_id = c.id
  WHERE c.finance_charge_rate > 0
    AND c.is_active = true
    AND COALESCE(c.finance_charge_enabled, true) = true
    AND agg.overdue_balance_cents >= v_min_balance
    AND agg.max_days_overdue > COALESCE(c.finance_charge_grace_days, 0)
    AND ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint > 0
  ORDER BY c.farm_name;
END;
$function$;
