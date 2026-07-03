-- ============================================================================
-- PARKED DRAFT — NOT APPLIED. Structure Wave-2 · A8-aging (AR aging-basis unification).
-- Ships via the DRAFT/APPLY protocol WITH 20260702160000 (A8 terms->due-date) as ONE
-- reviewed, together-applied batch — Mason applies both with a per-migration OK.
--
-- WHAT: switch the AR aging AGE BASIS from invoice_date to COALESCE(due_date, invoice_date)
--   in ALL aging producers, so every surface measures "how overdue" from the same date now
--   that A8 gives posted invoices a real due_date. THREE reporting producers, atomically here:
--     (1) get_ar_aging (AR aging report):  age = p_as_of - COALESCE(due_date, invoice_date);
--         AND fold not-yet-due (negative age) into Current: `age_days BETWEEN 0 AND 29`
--         -> `age_days <= 29`.
--     (2) get_detailed_statement_data (customer statement PDF): the 5 aging-bucket CASEs
--         switch to the same COALESCE basis. Its Current already uses `<= 30`, so not-yet-due
--         already lands in Current — only the basis changes.
--     (3) financial_dashboard_summary (admin exec dashboard tile): CTE #7 ar_aging switches
--         `EXTRACT(DAY FROM NOW() - i.invoice_date)` -> `... NOW() - COALESCE(i.due_date, i.invoice_date)`.
--         Its Current already uses `<= 30`; the coarse 4-bucket JSON shape read by the frontend
--         (current/days_31_60/days_61_90/days_90_plus) is intentionally left unchanged.
--   NOTE: a 4th, customer-facing producer — get_ar_reminder_candidates (dunning-reminder emails),
--   which also aged from invoice_date (Codex R2) — was moved to its OWN migration 20260702162000.
--   There it gains the same COALESCE(due_date, invoice_date) basis AND a configurable threshold
--   (Settings > "AR Reminder Threshold (days)", default 30; Mason 2026-07-03). Kept out of this file
--   to avoid double-defining one function across two parked migrations. Apply 162000 in this batch.
--
-- SCOPE NOTE (deliberate, documented): only the age BASIS is unified here — the material fix.
--   The pre-existing bucket-BOUNDARY label differences (get_ar_aging Current<=29 vs statement
--   Current<=30; the dashboard's coarser 4-bucket JSON shape read by the frontend) are NOT
--   renumbered — that is a frontend-coupled display change out of scope for a basis fix. The
--   per-line `days_aged` field on the statement stays on invoice_date basis (informational
--   "days since invoiced", never negative). Both are called out for a possible later pass.
--
-- FORWARD-SAFE: aging is a pure read over live invoices; COALESCE(due_date, invoice_date)
--   degrades to today's behavior for any invoice whose due_date is still NULL, so nothing
--   changes for pre-A8 invoices until A8 starts stamping due_date at post.
--
-- SCOPE: 2x CREATE OR REPLACE, re-emitted verbatim from the live defs with ONLY the marked
--   aging lines changed. Each is PROVEN surgical in the smoke (new pg-normalized def ==
--   old def with only the intended substrings replaced). One overload each; auth gates,
--   search_path, STABLE/SECDEF all preserved.
--
-- SMOKE (2026-07-02, live BEGIN;...ROLLBACK; — NOTHING persisted, verified ar_changed_live=false
--   & detailed_changed_live=false after): PROVED SURGICAL — for each fn, the new pg definition,
--   normalized (comments stripped + whitespace collapsed), equals the OLD live definition with
--   ONLY the intended aging substrings replaced (ar_surgical=PASS, detailed_surgical=PASS);
--   plpgsql_check_errors=0 on both. So nothing but the age basis (+ get_ar_aging Current<=29) changed.
--   The dashboard (financial_dashboard_summary, function 3 below) is proved the same way.
--   (The 4th producer get_ar_reminder_candidates was reviewed here in R2/R3, then moved to its own
--   migration 20260702162000 which adds the configurable threshold — re-proved there.)
-- CODEX: R1 clean on the 3 aging fns (surgical). R2 surfaced a 4th producer (get_ar_reminder_candidates)
--   aging from invoice_date -> premature/inflated reminders for non-Net-30 customers (now in 162000).
--   R3 (2026-07-02): CLEAN — "no actionable correctness issues; surgical; auth/idempotency preserved."
-- ============================================================================

-- (1) get_ar_aging --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(customer_id uuid, farm_name text, current_amount numeric, days_30 numeric, days_60 numeric, days_90 numeric, over_90 numeric, total_outstanding numeric)
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
    COALESCE(SUM(balance), 0) AS total_outstanding
  FROM customers c
  INNER JOIN (
    SELECT i.customer_id, (i.balance_cents::numeric / 100) AS balance, (p_as_of_date - COALESCE(i.due_date, i.invoice_date)::date) AS age_days
    FROM invoices i WHERE i.status IN ('posted', 'overdue') AND i.balance_cents > 0 AND i.deleted_at IS NULL
  ) ar ON ar.customer_id = c.id
  GROUP BY c.id, c.farm_name HAVING SUM(balance) > 0 ORDER BY SUM(balance) DESC;
END;
$function$;

-- (2) get_detailed_statement_data ----------------------------------------------
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
  -- A8-aging: basis switched invoice_date -> COALESCE(due_date, invoice_date); boundaries unchanged.
  SELECT jsonb_build_object(
    'current_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) <= 30 THEN i.balance_cents ELSE 0 END), 0),
    'days_30_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 31 AND 60 THEN i.balance_cents ELSE 0 END), 0),
    'days_60_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 61 AND 90 THEN i.balance_cents ELSE 0 END), 0),
    'days_90_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) BETWEEN 91 AND 120 THEN i.balance_cents ELSE 0 END), 0),
    'over_120_cents', COALESCE(sum(CASE WHEN p_as_of_date - COALESCE(i.due_date, i.invoice_date) > 120 THEN i.balance_cents ELSE 0 END), 0)
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

-- (3) financial_dashboard_summary ----------------------------------------------
-- Re-emitted verbatim from the live def; ONLY CTE #7 (ar_aging) age basis changed
-- (NOW() - i.invoice_date -> NOW() - COALESCE(i.due_date, i.invoice_date)). Proven surgical
-- in the smoke. The coarse 4-bucket JSON shape (frontend-read) is deliberately unchanged.
CREATE OR REPLACE FUNCTION public.financial_dashboard_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
  _role  text;
BEGIN
  _role := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'user_role',
    (SELECT role FROM public.profiles WHERE id = auth.uid())
  );
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  WITH
  -- 1. Order aggregates: revenue, profit, margin — FIX: filter deleted/cancelled
  order_agg AS (
    SELECT
      COALESCE(SUM(total_price), 0)  AS total_revenue,
      COALESCE(SUM(total_profit), 0) AS total_profit
    FROM orders
    WHERE deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')
  ),

  -- 2. Quote counts & pipeline value
  quote_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_count,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_count,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
      COALESCE(SUM(total_price) FILTER (WHERE status IN ('draft', 'sent')), 0) AS pipeline_value
    FROM quotes
  ),

  -- 3. Monthly revenue & profit — FIX: filter deleted/cancelled
  monthly AS (
    SELECT jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0)  AS revenue,
        COALESCE(SUM(total_profit), 0) AS profit
      FROM orders
      WHERE deleted_at IS NULL AND status NOT IN ('cancelled', 'draft')
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) m
  ),

  -- 4. Top 5 customers by revenue — FIX: filter deleted/cancelled
  top_cust AS (
    SELECT jsonb_agg(row_to_json(tc)::jsonb ORDER BY tc.total DESC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(o.total_price), 0) AS total
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL AND o.status NOT IN ('cancelled', 'draft')
      GROUP BY c.id, c.farm_name
      ORDER BY total DESC
      LIMIT 5
    ) tc
  ),

  -- 5. Open AR balance — FIX: include overdue
  ar AS (
    SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0) / 100.0 AS balance
    FROM invoices
    WHERE status IN ('posted', 'overdue')
      AND deleted_at IS NULL
  ),

  -- 6. Customers over credit limit — FIX: include overdue
  over_credit AS (
    SELECT COUNT(*) AS cnt
    FROM customers c
    WHERE c.credit_limit_cents IS NOT NULL
      AND c.credit_limit_cents > 0
      AND (
        SELECT COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0)
        FROM invoices i
        WHERE i.customer_id = c.id
          AND i.status IN ('posted', 'overdue')
          AND i.deleted_at IS NULL
      ) > c.credit_limit_cents
  ),

  -- 7. AR Aging buckets — FIX: include overdue; A8-aging: basis NOW()-invoice_date -> COALESCE(due_date, invoice_date)
  ar_aging AS (
    SELECT
      COALESCE(SUM(CASE WHEN age_days <= 30 THEN balance ELSE 0 END), 0) AS current_bucket,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN age_days BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN age_days > 90 THEN balance ELSE 0 END), 0) AS days_90_plus
    FROM (
      SELECT
        GREATEST(i.balance_cents, 0) / 100.0 AS balance,
        EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int AS age_days
      FROM invoices i
      WHERE i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
    ) aged
  ),

  -- 8. Total unallocated prepay balance
  prepay_bal AS (
    SELECT COALESCE(SUM(prepay_balance_cents), 0) / 100.0 AS total_unallocated
    FROM customers
    WHERE prepay_balance_cents > 0
  ),

  -- 9. Total unpaid commissions
  commission_owed AS (
    SELECT COALESCE(SUM(commission_amount), 0) AS total_owed
    FROM commissions
    WHERE status = 'pending'
      AND paid_date IS NULL
  ),

  -- 10. Current accounting period
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR(NOW(), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - NOW())::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day') - NOW())::int
      END AS days_remaining
    FROM accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  ),

  -- 11. Value of unreceived PO items
  po_unreceived AS (
    SELECT COALESCE(SUM(
      (poi.quantity_ordered - COALESCE(poi.quantity_received, 0)) * poi.unit_cost
    ), 0) AS value
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),

  -- 12. Floor inventory value
  floor_inv AS (
    SELECT
      COALESCE(SUM(inv.quantity_available * COALESCE(p.current_cost, 0)), 0) AS total_value,
      COALESCE(SUM(
        GREATEST(inv.quantity_available - inv.quantity_prebooked, 0) * COALESCE(p.current_cost, 0)
      ), 0) AS free_value
    FROM inventory inv
    JOIN products p ON p.id = inv.product_id
    WHERE inv.quantity_available > 0
  ),

  -- 13. Committed order value
  committed_orders AS (
    SELECT COALESCE(SUM(
      oi.quantity_remaining * oi.cost_per_unit
    ), 0) AS value
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),

  -- 14. Bottom 10 products by margin
  bottom_products AS (
    SELECT jsonb_agg(row_to_json(bp)::jsonb ORDER BY bp.margin_pct ASC) AS arr
    FROM (
      SELECT
        p.product_name,
        COALESCE(SUM(oi.total_units_needed * oi.price_per_unit), 0) AS total_revenue,
        COALESCE(SUM(oi.total_units_needed * oi.cost_per_unit), 0) AS total_cost,
        ROUND(
          CASE WHEN SUM(oi.total_units_needed * oi.price_per_unit) > 0
            THEN ((SUM(oi.total_units_needed * oi.price_per_unit) - SUM(oi.total_units_needed * oi.cost_per_unit))
                  / NULLIF(SUM(oi.total_units_needed * oi.price_per_unit), 0)) * 100
            ELSE 0
          END, 1
        ) AS margin_pct,
        COALESCE(SUM(oi.total_units_needed), 0) AS units_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'draft')
        AND compute_season(COALESCE(o.order_date, o.created_at::date)) = compute_season(CURRENT_DATE)
      GROUP BY p.id, p.product_name
      HAVING SUM(oi.total_units_needed * oi.price_per_unit) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bp
  ),

  -- 15. Bottom 10 customers by margin
  bottom_customers AS (
    SELECT jsonb_agg(row_to_json(bc)::jsonb ORDER BY bc.margin_pct ASC) AS arr
    FROM (
      SELECT
        c.farm_name,
        COALESCE(SUM(o.total_price), 0) AS total_revenue,
        COALESCE(SUM(o.total_cost), 0) AS total_cost,
        ROUND(
          CASE WHEN SUM(o.total_price) > 0
            THEN ((SUM(o.total_price) - SUM(o.total_cost))
                  / NULLIF(SUM(o.total_price), 0)) * 100
            ELSE 0
          END, 1
        ) AS margin_pct,
        COUNT(*)::int AS order_count
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'draft')
        AND compute_season(COALESCE(o.order_date, o.created_at::date)) = compute_season(CURRENT_DATE)
      GROUP BY c.id, c.farm_name
      HAVING SUM(o.total_price) > 0
      ORDER BY margin_pct ASC
      LIMIT 10
    ) bc
  ),

  -- 16. Monthly margin trend
  monthly_margin AS (
    SELECT jsonb_agg(row_to_json(mm)::jsonb ORDER BY mm.month) AS arr
    FROM (
      SELECT
        TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month,
        COALESCE(SUM(total_price), 0) AS revenue,
        COALESCE(SUM(total_cost), 0) AS cost,
        ROUND(
          CASE WHEN SUM(total_price) > 0
            THEN ((SUM(total_price) - SUM(total_cost))
                  / NULLIF(SUM(total_price), 0)) * 100
            ELSE 0
          END, 1
        ) AS margin_pct
      FROM orders
      WHERE deleted_at IS NULL
        AND status NOT IN ('cancelled', 'draft')
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    ) mm
  )

  SELECT jsonb_build_object(
    'total_revenue',              oa.total_revenue,
    'total_profit',               oa.total_profit,
    'overall_margin',             CASE WHEN oa.total_revenue > 0
                                    THEN ROUND((oa.total_profit / oa.total_revenue) * 100, 1)
                                    ELSE 0
                                  END,
    'quote_counts',               jsonb_build_object(
                                    'draft',    qa.draft_count,
                                    'sent',     qa.sent_count,
                                    'accepted', qa.accepted_count
                                  ),
    'quote_pipeline_value',       qa.pipeline_value,
    'monthly_revenue',            COALESCE(mr.arr, '[]'::jsonb),
    'top_customers',              COALESCE(tc.arr, '[]'::jsonb),
    'open_ar_balance',            ar_total.balance,
    'customers_over_credit_count', oc.cnt,
    'ar_aging_buckets',           jsonb_build_object(
                                    'current',      aa.current_bucket,
                                    'days_31_60',   aa.days_31_60,
                                    'days_61_90',   aa.days_61_90,
                                    'days_90_plus',  aa.days_90_plus
                                  ),
    'total_prepay_unallocated',   pb.total_unallocated,
    'total_commission_owed',      co.total_owed,
    'current_period',             jsonb_build_object(
                                    'name',           COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
                                    'status',         COALESCE(pi.status, 'open'),
                                    'days_remaining', COALESCE(pi.days_remaining, 0)
                                  ),
    'po_unreceived_value',        pour.value,
    'floor_inventory_value',      fi.total_value,
    'floor_free_value',           fi.free_value,
    'committed_order_value',      co2.value,
    'bottom_products_by_margin',  COALESCE(bpm.arr, '[]'::jsonb),
    'bottom_customers_by_margin', COALESCE(bcm.arr, '[]'::jsonb),
    'monthly_margin_trend',       COALESCE(mmt.arr, '[]'::jsonb)
  ) INTO result
  FROM order_agg      oa
  CROSS JOIN quote_agg       qa
  CROSS JOIN monthly         mr
  CROSS JOIN top_cust        tc
  CROSS JOIN ar              ar_total
  CROSS JOIN over_credit     oc
  CROSS JOIN ar_aging        aa
  CROSS JOIN prepay_bal      pb
  CROSS JOIN commission_owed co
  CROSS JOIN po_unreceived   pour
  CROSS JOIN floor_inv       fi
  CROSS JOIN committed_orders co2
  CROSS JOIN bottom_products  bpm
  CROSS JOIN bottom_customers bcm
  CROSS JOIN monthly_margin   mmt
  LEFT JOIN  period_info     pi ON true;

  RETURN result;
END;
$function$;
