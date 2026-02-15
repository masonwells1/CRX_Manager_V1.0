-- ─── Sprint 17: Year-End Customer Summary ───────────────────────────────
--
-- New RPC:
--   get_customer_year_end_summary(p_customer_id uuid, p_season integer) → jsonb
--
-- Returns a comprehensive JSONB summary of a customer's season activity:
--   financial totals, product usage by category, acreage, invoice history,
--   grower shares, and prior-season comparison.

CREATE OR REPLACE FUNCTION public.get_customer_year_end_summary(
  p_customer_id uuid,
  p_season      integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cust            record;
  v_season_start    date;
  v_season_end      date;
  v_financial       jsonb;
  v_product_usage   jsonb;
  v_acreage         jsonb;
  v_invoices        jsonb;
  v_shares          jsonb;
  v_prior_season    jsonb;
BEGIN
  -- ── Customer info ──
  SELECT * INTO v_cust FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  -- Season dates: July 1 (season-1) through June 30 (season)
  v_season_start := make_date(p_season - 1, 7, 1);
  v_season_end   := make_date(p_season, 6, 30);

  -- ── Financial summary ──
  SELECT jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
    'prepay_applied_cents', COALESCE(SUM(prepay_applied_cents), 0),
    'outstanding_balance_cents', COALESCE(SUM(balance_cents), 0),
    'invoice_count', COUNT(*)
  )
  INTO v_financial
  FROM invoices
  WHERE customer_id = p_customer_id
    AND season = p_season
    AND status IN ('posted', 'voided')
    AND deleted_at IS NULL;

  -- ── Product usage by category ──
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.category, t.product_name), '[]'::jsonb)
  INTO v_product_usage
  FROM (
    SELECT
      COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(p.product_name, ii.description) AS product_name,
      p.epa_registration,
      SUM(ii.quantity) AS total_quantity,
      MAX(ii.unit_size) AS unit_size,
      CASE WHEN SUM(COALESCE(ii.acres, 0)) > 0
        THEN ROUND(AVG(ii.rate_per_acre)::numeric, 2)
        ELSE NULL
      END AS avg_rate_per_acre,
      MAX(ii.rate_unit) AS rate_unit,
      SUM(COALESCE(ii.acres, 0)) AS total_acres_treated,
      SUM(ii.extended_cents) AS total_cost_cents,
      SUM(COALESCE(ii.total_applied, 0)) AS total_applied,
      MAX(ii.total_applied_unit) AS total_applied_unit,
      SUM(COALESCE(ii.total_applied_gl_lb, 0)) AS total_applied_gl_lb,
      MAX(ii.gl_lb_unit) AS gl_lb_unit,
      ii.is_application_fee
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    LEFT JOIN products p ON p.id = ii.product_id
    WHERE i.customer_id = p_customer_id
      AND i.season = p_season
      AND i.status = 'posted'
      AND i.deleted_at IS NULL
    GROUP BY COALESCE(p.category, 'Uncategorized'),
             COALESCE(p.product_name, ii.description),
             p.epa_registration,
             ii.is_application_fee
  ) t;

  -- ── Acreage summary ──
  SELECT jsonb_build_object(
    'total_acres', COALESCE(SUM(i.total_acres), 0),
    'by_crop', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'crop_type', sub.crop_type,
        'acres', sub.total_acres
      ) ORDER BY sub.total_acres DESC)
      FROM (
        SELECT COALESCE(crop_type, 'Unknown') AS crop_type,
               SUM(total_acres) AS total_acres
        FROM invoices
        WHERE customer_id = p_customer_id
          AND season = p_season
          AND invoice_type = 'field_application'
          AND status = 'posted'
          AND deleted_at IS NULL
          AND total_acres IS NOT NULL
        GROUP BY COALESCE(crop_type, 'Unknown')
      ) sub
    ), '[]'::jsonb)
  )
  INTO v_acreage
  FROM invoices i
  WHERE i.customer_id = p_customer_id
    AND i.season = p_season
    AND i.invoice_type = 'field_application'
    AND i.status = 'posted'
    AND i.deleted_at IS NULL;

  -- ── Invoice history ──
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number,
    'invoice_date', i.invoice_date,
    'invoice_type', i.invoice_type,
    'field_names', i.field_names,
    'total_acres', i.total_acres,
    'crop_type', i.crop_type,
    'total_amount_cents', i.total_amount_cents,
    'balance_cents', i.balance_cents,
    'status', i.status
  ) ORDER BY i.invoice_date, i.created_at), '[]'::jsonb)
  INTO v_invoices
  FROM invoices i
  WHERE i.customer_id = p_customer_id
    AND i.season = p_season
    AND i.status IN ('posted', 'voided')
    AND i.deleted_at IS NULL;

  -- ── Grower shares (only this customer's share info) ──
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number,
    'field_names', i.field_names,
    'share_customer_name', s.customer_name,
    'split_percentage', s.split_percentage,
    'acres', s.acres,
    'amount_cents', s.amount_cents,
    'price_per_acre_cents', s.price_per_acre_cents,
    'pricing_note', s.pricing_note
  ) ORDER BY i.invoice_date, s.sort_order), '[]'::jsonb)
  INTO v_shares
  FROM invoice_shares s
  JOIN invoices i ON i.id = s.invoice_id
  WHERE i.customer_id = p_customer_id
    AND i.season = p_season
    AND i.status = 'posted'
    AND i.deleted_at IS NULL;

  -- ── Prior season comparison ──
  SELECT CASE
    WHEN COUNT(*) > 0 THEN
      jsonb_build_object(
        'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
        'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
        'invoice_count', COUNT(*),
        'total_acres', COALESCE((
          SELECT SUM(total_acres)
          FROM invoices
          WHERE customer_id = p_customer_id
            AND season = p_season - 1
            AND invoice_type = 'field_application'
            AND status IN ('posted', 'voided')
            AND deleted_at IS NULL
        ), 0)
      )
    ELSE NULL
  END
  INTO v_prior_season
  FROM invoices
  WHERE customer_id = p_customer_id
    AND season = p_season - 1
    AND status IN ('posted', 'voided')
    AND deleted_at IS NULL;

  -- ── Build and return ──
  RETURN jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_cust.id,
      'farm_name', v_cust.farm_name,
      'contact_name', v_cust.contact_name,
      'account_number', v_cust.account_number,
      'email', v_cust.email,
      'phone', v_cust.phone,
      'billing_address', v_cust.billing_address,
      'city', v_cust.city,
      'state', v_cust.state,
      'zip', v_cust.zip,
      'assigned_tier', v_cust.assigned_tier,
      'payment_terms', v_cust.payment_terms
    ),
    'season', p_season,
    'season_start', v_season_start,
    'season_end', v_season_end,
    'financial', v_financial,
    'product_usage', v_product_usage,
    'acreage', v_acreage,
    'invoices', v_invoices,
    'shares', v_shares,
    'prior_season', v_prior_season
  );
END;
$$;
