-- Keep earned revenue and invoice-basis COGS recognized after an invoice is
-- aged overdue or paid. This is intentionally report-only: it writes no
-- business rows and does not alter AR's open-balance definition.

-- Freeze return-credit issuance while the authoritative credit-header
-- assertion and report replacements run in the same migration transaction.
LOCK TABLE public.returns IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_pnl regprocedure := to_regprocedure('public.get_bottom_line_pnl(date,date)');
  v_monthly regprocedure := to_regprocedure('public.get_monthly_summary(date,date)');
  v_year_end regprocedure := to_regprocedure('public.get_customer_year_end_summary(uuid,integer)');
  v_require_role regprocedure := to_regprocedure('public.require_admin_or_sales_rep()');
  v_is_admin regprocedure := to_regprocedure('public.is_admin()');
  v_batch_year_end regprocedure := to_regprocedure('public.get_batch_year_end_summaries(uuid[],integer)');
  v_src text;
BEGIN
  IF v_pnl IS NULL OR v_monthly IS NULL OR v_year_end IS NULL
     OR v_require_role IS NULL OR v_is_admin IS NULL OR v_batch_year_end IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_bottom_line_pnl') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_monthly_summary') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_customer_year_end_summary') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'require_admin_or_sales_rep') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'is_admin') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'get_batch_year_end_summaries') <> 1 THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_SIGNATURE';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_pnl;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> '7624af5d26e6b9cbf9a8e5e6b0f030fe5cc164bf5b6994214db94d5438e3fcd4'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_pnl AND NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_pnl, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('authenticated', v_pnl, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_pnl, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_PNL_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_monthly;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> '69f71c7709f145fb280433418d9476112d35d178e3d12051f7e68bab618ba077'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_monthly AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_monthly, 'EXECUTE')
     OR has_function_privilege('authenticated', v_monthly, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_monthly, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_MONTHLY_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_year_end;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> '34d92979d8d5dbc6f3eff7ebc3daaec4833baeac8917044c89c0af16e00624e7'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_year_end AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_year_end, 'EXECUTE')
     OR has_function_privilege('authenticated', v_year_end, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_year_end, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_YEAR_END_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_require_role;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> '4d4515042f0b2fab834ad22ba79f877c9cc444e920402593bfc5947f5ff382f4'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_require_role AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_require_role, 'EXECUTE')
     OR has_function_privilege('authenticated', v_require_role, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_require_role, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_ROLE_HELPER_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_is_admin;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> 'ad1432467c3739bd581b42729a2b7bc7d0ff19a60736481881d5ae1ddebbab05'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_is_admin AND p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_is_admin, 'EXECUTE')
     OR has_function_privilege('authenticated', v_is_admin, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_is_admin, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_ADMIN_HELPER_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_batch_year_end;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> 'fae61d495af1f6bb0ab690d6cb9d6d111a3a6e387e0c047f9f8c0d568bd49680'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_batch_year_end AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_batch_year_end, 'EXECUTE')
     OR has_function_privilege('authenticated', v_batch_year_end, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_batch_year_end, 'EXECUTE') IS NOT TRUE
     OR position('public.get_customer_year_end_summary(v_cid, p_season)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_BATCH_WRAPPER_DRIFT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.returns r
    JOIN public.invoices i ON i.id = r.credit_invoice_id
    WHERE i.status IN ('posted', 'overdue', 'paid')
      AND i.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_EXISTING_RETURN_CREDIT';
  END IF;
END;
$preflight$;

-- Deliberately preserve the live SECURITY INVOKER ACL, including anon EXECUTE:
-- this migration changes recognized-status accounting only and must not change
-- the existing report access posture. Postflight pins that grant explicitly.
CREATE OR REPLACE FUNCTION public.get_bottom_line_pnl(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (line_item text, amount numeric, pct_of_revenue numeric)
LANGUAGE plpgsql STABLE
SET search_path = public
AS $function$
DECLARE
  v_revenue numeric := 0;
  v_cogs numeric := 0;
  v_gross_profit numeric := 0;
  v_commissions numeric := 0;
  v_net_profit numeric := 0;
BEGIN
  SELECT
    COALESCE(SUM(i.total_amount_cents), 0) / 100.0,
    COALESCE(SUM(CASE
      WHEN i.invoice_type = 'credit_memo'
       AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = i.id)
        THEN i.total_cost_cents
      ELSE (SELECT COALESCE(SUM(ROUND(ii.cost_cents * ii.quantity)::bigint), 0)
            FROM public.invoice_items ii WHERE ii.invoice_id = i.id)
    END), 0) / 100.0
  INTO v_revenue, v_cogs
  FROM public.invoices i
  WHERE i.status IN ('posted', 'overdue', 'paid')
    AND i.invoice_date >= p_start_date
    AND i.invoice_date <= p_end_date
    AND i.deleted_at IS NULL;

  v_gross_profit := v_revenue - v_cogs;
  SELECT COALESCE(SUM(commission_amount), 0) INTO v_commissions
  FROM public.commissions
  WHERE order_date >= p_start_date AND order_date <= p_end_date;
  v_net_profit := v_gross_profit - v_commissions;

  RETURN QUERY VALUES
    ('Revenue'::text, v_revenue, 100.0::numeric),
    ('Cost of Goods Sold', v_cogs, CASE WHEN v_revenue > 0 THEN ROUND(v_cogs / v_revenue * 100, 1) ELSE 0 END),
    ('Gross Profit', v_gross_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_gross_profit / v_revenue * 100, 1) ELSE 0 END),
    ('Commissions', v_commissions, CASE WHEN v_revenue > 0 THEN ROUND(v_commissions / v_revenue * 100, 1) ELSE 0 END),
    ('Net Profit', v_net_profit, CASE WHEN v_revenue > 0 THEN ROUND(v_net_profit / v_revenue * 100, 1) ELSE 0 END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_monthly_summary(
  p_period_start date,
  p_period_end date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM require_admin();
  SELECT jsonb_build_object(
    'period_start', p_period_start,
    'period_end', p_period_end,
    'invoices', jsonb_build_object(
      'posted_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL),
      'total_amount_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL), 0),
      'total_cost_cents', COALESCE((SELECT sum(CASE
        WHEN inv.invoice_type = 'credit_memo'
         AND EXISTS (SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = inv.id)
          THEN inv.total_cost_cents
        ELSE (SELECT COALESCE(sum(ROUND(ii.cost_cents * ii.quantity)::bigint), 0)
              FROM public.invoice_items ii WHERE ii.invoice_id = inv.id)
      END) FROM public.invoices inv WHERE inv.invoice_date BETWEEN p_period_start AND p_period_end AND inv.status IN ('posted', 'overdue', 'paid') AND inv.deleted_at IS NULL), 0),
      'draft_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status IN ('draft', 'unposted') AND deleted_at IS NULL),
      'voided_count', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN p_period_start AND p_period_end AND status = 'voided' AND deleted_at IS NULL)
    ),
    'payments', jsonb_build_object('count', (SELECT count(*) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 'total_cents', COALESCE((SELECT sum((amount * 100)::bigint) FROM public.payments WHERE payment_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 0)),
    'orders', jsonb_build_object('count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 'total_cents', COALESCE((SELECT sum((total_price * 100)::bigint) FROM public.orders WHERE order_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')), 0)),
    'deliveries', jsonb_build_object('count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND deleted_at IS NULL), 'completed_count', (SELECT count(*) FROM public.deliveries WHERE scheduled_date BETWEEN p_period_start AND p_period_end AND status = 'completed' AND deleted_at IS NULL)),
    'applications', jsonb_build_object('count', (SELECT count(*) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 'total_acres', COALESCE((SELECT sum(total_acres) FROM public.application_records WHERE application_date BETWEEN p_period_start AND p_period_end), 0)),
    'commissions', jsonb_build_object('earned_cents', COALESCE((SELECT sum((commission_amount * 100)::bigint) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end), 0), 'paid_count', (SELECT count(*) FROM public.commissions WHERE order_date BETWEEN p_period_start AND p_period_end AND status = 'paid')),
    'ar_balance_cents', COALESCE((SELECT sum(balance_cents) FROM public.invoices WHERE status IN ('posted', 'overdue') AND balance_cents > 0 AND deleted_at IS NULL), 0)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

-- A sale remains recognized after collection or aging.  Credit memos use the
-- same recognized status set, so unused product returned in this season nets
-- both the invoice-basis financial totals and the customer-facing usage rows.
CREATE OR REPLACE FUNCTION public.get_customer_year_end_summary(
  p_customer_id uuid,
  p_season integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cust record;
  v_season_start date;
  v_season_end date;
  v_financial jsonb;
  v_product_usage jsonb;
  v_acreage jsonb;
  v_invoices jsonb;
  v_shares jsonb;
  v_prior_season jsonb;
BEGIN
  PERFORM public.require_admin_or_sales_rep();
  IF NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1
       FROM public.customers c
       WHERE c.id = p_customer_id
         AND c.assigned_sales_rep = auth.uid()
     ) THEN
    RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
  END IF;

  SELECT * INTO v_cust FROM public.customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;
  v_season_start := public.season_start_date(p_season);
  v_season_end := public.season_end_date(p_season);

  SELECT jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
    'prepay_applied_cents', COALESCE(SUM(prepay_applied_cents), 0),
    'outstanding_balance_cents', COALESCE(SUM(balance_cents), 0),
    'invoice_count', COUNT(*)
  ) INTO v_financial
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.category, t.product_name), '[]'::jsonb)
  INTO v_product_usage
  FROM (
    SELECT COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(p.product_name, ii.description) AS product_name,
      p.epa_registration, SUM(ii.quantity) AS total_quantity,
      MAX(ii.unit_size) AS unit_size,
      CASE WHEN SUM(COALESCE(ii.acres, 0)) > 0 THEN ROUND(AVG(ii.rate_per_acre)::numeric, 2) ELSE NULL END AS avg_rate_per_acre,
      MAX(ii.rate_unit) AS rate_unit, SUM(COALESCE(ii.acres, 0)) AS total_acres_treated,
      SUM(ii.extended_cents) AS total_cost_cents,
      SUM(COALESCE(ii.total_applied, 0)) AS total_applied,
      MAX(ii.total_applied_unit) AS total_applied_unit,
      SUM(COALESCE(ii.total_applied_gl_lb, 0)) AS total_applied_gl_lb,
      MAX(ii.gl_lb_unit) AS gl_lb_unit, ii.is_application_fee
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    LEFT JOIN public.products p ON p.id = ii.product_id
    WHERE i.customer_id = p_customer_id AND i.season = p_season
      AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL
    GROUP BY COALESCE(p.category, 'Uncategorized'), COALESCE(p.product_name, ii.description),
      p.epa_registration, ii.is_application_fee
  ) t;

  SELECT jsonb_build_object(
    'total_acres', COALESCE(SUM(i.total_acres), 0),
    'by_crop', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('crop_type', sub.crop_type, 'acres', sub.total_acres) ORDER BY sub.total_acres DESC)
      FROM (
        SELECT COALESCE(crop_type, 'Unknown') AS crop_type, SUM(total_acres) AS total_acres
        FROM public.invoices
        WHERE customer_id = p_customer_id AND season = p_season AND invoice_type = 'field_application'
          AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL AND total_acres IS NOT NULL
        GROUP BY COALESCE(crop_type, 'Unknown')
      ) sub
    ), '[]'::jsonb)
  ) INTO v_acreage
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season AND i.invoice_type = 'field_application'
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'invoice_date', i.invoice_date, 'invoice_type', i.invoice_type,
    'field_names', i.field_names, 'total_acres', i.total_acres, 'crop_type', i.crop_type,
    'total_amount_cents', i.total_amount_cents, 'balance_cents', i.balance_cents, 'status', i.status
  ) ORDER BY i.invoice_date, i.created_at), '[]'::jsonb)
  INTO v_invoices
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'field_names', i.field_names,
    'share_customer_name', s.customer_name, 'split_percentage', s.split_percentage,
    'acres', s.acres, 'amount_cents', s.amount_cents,
    'price_per_acre_cents', s.price_per_acre_cents, 'pricing_note', s.pricing_note
  ) ORDER BY i.invoice_date, s.sort_order), '[]'::jsonb)
  INTO v_shares
  FROM public.invoice_shares s JOIN public.invoices i ON i.id = s.invoice_id
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT CASE WHEN COUNT(*) > 0 THEN jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0), 'invoice_count', COUNT(*),
    'total_acres', COALESCE((
      SELECT SUM(total_acres) FROM public.invoices
      WHERE customer_id = p_customer_id AND season = p_season - 1 AND invoice_type = 'field_application'
        AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL
    ), 0)
  ) ELSE NULL END INTO v_prior_season
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season - 1
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', v_cust.id, 'farm_name', v_cust.farm_name,
      'contact_name', v_cust.contact_name, 'account_number', v_cust.account_number,
      'email', v_cust.email, 'phone', v_cust.phone, 'billing_address', v_cust.billing_address,
      'city', v_cust.city, 'state', v_cust.state, 'zip', v_cust.zip,
      'assigned_tier', v_cust.assigned_tier, 'payment_terms', v_cust.payment_terms),
    'season', p_season, 'season_start', v_season_start, 'season_end', v_season_end,
    'financial', v_financial, 'product_usage', v_product_usage, 'acreage', v_acreage,
    'invoices', v_invoices, 'shares', v_shares, 'prior_season', v_prior_season
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_year_end_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_year_end_summary(uuid, integer) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_pnl regprocedure := to_regprocedure('public.get_bottom_line_pnl(date,date)');
  v_monthly regprocedure := to_regprocedure('public.get_monthly_summary(date,date)');
  v_year_end regprocedure := to_regprocedure('public.get_customer_year_end_summary(uuid,integer)');
  v_batch_year_end regprocedure := to_regprocedure('public.get_batch_year_end_summaries(uuid[],integer)');
  v_expected jsonb := jsonb_build_object(
    'get_bottom_line_pnl', '307c94d4e8de83c91b0b7ca680d529c6834e56ef5bc5b10c5c6d054fc1a265d2',
    'get_monthly_summary', 'c90c10378f5fc2feb8c41554f0fbc85280f55ca3b637e7b24654055e3dfe8330',
    'get_customer_year_end_summary', '983e802e334a70cb2a627447b8760d3830a690dab789d26e161a7f590efe1bfe'
  );
  v_src text;
BEGIN
  IF v_pnl IS NULL OR v_monthly IS NULL OR v_year_end IS NULL OR v_batch_year_end IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'get_bottom_line_pnl') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'get_monthly_summary') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'get_customer_year_end_summary') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'get_batch_year_end_summaries') <> 1 THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_MISSING';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_pnl;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> (v_expected ->> 'get_bottom_line_pnl')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_pnl AND NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_pnl, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('authenticated', v_pnl, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_pnl, 'EXECUTE') IS NOT TRUE
     OR position('i.status IN (''posted'', ''overdue'', ''paid'')' IN v_src) = 0
     OR position('i.deleted_at IS NULL' IN v_src) = 0 THEN RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_PNL'; END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_monthly;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> (v_expected ->> 'get_monthly_summary')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_monthly AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_monthly, 'EXECUTE')
     OR has_function_privilege('authenticated', v_monthly, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_monthly, 'EXECUTE') IS NOT TRUE
     OR regexp_count(v_src, 'status IN \(''posted'', ''overdue'', ''paid''\)') <> 3
     OR position('status IN (''posted'', ''overdue'') AND balance_cents > 0' IN v_src) = 0 THEN RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_MONTHLY'; END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_year_end;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> (v_expected ->> 'get_customer_year_end_summary')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_year_end AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', v_year_end, 'EXECUTE')
     OR has_function_privilege('authenticated', v_year_end, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', v_year_end, 'EXECUTE') IS NOT TRUE
     OR position('status IN (''posted'', ''overdue'', ''paid'')' IN v_src) = 0
     OR position('PERFORM public.require_admin_or_sales_rep()' IN v_src) = 0
     OR position('c.assigned_sales_rep = auth.uid()' IN v_src) = 0
     OR position('CUSTOMER_SCOPE_DENIED' IN v_src) = 0 THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_YEAR_END';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_batch_year_end;
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> 'fae61d495af1f6bb0ab690d6cb9d6d111a3a6e387e0c047f9f8c0d568bd49680'
     OR position('public.get_customer_year_end_summary(v_cid, p_season)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_BATCH_WRAPPER';
  END IF;
END;
$postflight$;
