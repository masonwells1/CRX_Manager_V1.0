-- Read-only field profitability report for posted field-application invoices.
CREATE OR REPLACE FUNCTION public.get_field_profitability(
  p_season text DEFAULT NULL
)
RETURNS TABLE (
  field_id uuid,
  field_name text,
  customer_id uuid,
  customer_name text,
  season text,
  total_acres_applied numeric,
  revenue_cents bigint,
  cost_cents bigint,
  margin_cents bigint,
  margin_per_acre_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;

  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  RETURN QUERY
  WITH eligible_invoices AS (
    SELECT
      i.id AS invoice_id,
      i.invoice_group_id,
      i.season::text AS invoice_season,
      i.total_amount_cents AS invoice_revenue_cents,
      COALESCE(item_cost.total_cost_cents, 0)::bigint AS invoice_cost_cents
    FROM public.invoices i
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          SUM(
            ROUND(
              COALESCE(ii.cost_cents, 0)::numeric
              * COALESCE(ii.quantity, 0)
            )::bigint
          ),
          0
        )::bigint AS total_cost_cents
      FROM public.invoice_items ii
      WHERE ii.invoice_id = i.id
    ) item_cost ON true
    WHERE i.invoice_type = 'field_application'
      AND i.status IN ('posted', 'overdue', 'paid')
      AND i.deleted_at IS NULL
      AND (p_season IS NULL OR i.season::text = p_season)
  ),
  invoice_location_totals AS (
    SELECT
      ei.invoice_id,
      ei.invoice_season,
      ei.invoice_revenue_cents,
      ei.invoice_cost_cents,
      fal.id AS location_id,
      fal.field_id,
      COALESCE(fal.applied_acres, 0) AS applied_acres,
      SUM(COALESCE(fal.applied_acres, 0)) OVER (
        PARTITION BY ei.invoice_id
      ) AS invoice_applied_acres,
      COUNT(*) OVER (
        PARTITION BY ei.invoice_id
      ) AS invoice_location_count
    FROM eligible_invoices ei
    JOIN public.field_app_locations fal
      ON (
        ei.invoice_group_id IS NULL
        AND fal.invoice_id = ei.invoice_id
      ) OR (
        ei.invoice_group_id IS NOT NULL
        AND fal.invoice_group_id = ei.invoice_group_id
      )
    WHERE COALESCE(fal.applied_acres, 0) >= 0
  ),
  invoice_location_weights AS (
    SELECT
      ilt.invoice_id,
      ilt.invoice_season,
      ilt.invoice_revenue_cents,
      ilt.invoice_cost_cents,
      ilt.location_id,
      ilt.field_id,
      ilt.applied_acres,
      -- Current writers require positive acres. If legacy rows total zero acres,
      -- equal weights preserve every invoice cent while the per-acre result is 0.
      CASE
        WHEN ilt.invoice_applied_acres > 0 THEN ilt.applied_acres
        ELSE 1::numeric
      END AS allocation_weight,
      CASE
        WHEN ilt.invoice_applied_acres > 0 THEN ilt.invoice_applied_acres
        ELSE ilt.invoice_location_count::numeric
      END AS allocation_weight_total
    FROM invoice_location_totals ilt
  ),
  allocation_floors AS (
    SELECT
      ilw.*,
      FLOOR(
        ilw.invoice_revenue_cents::numeric
        * ilw.allocation_weight
        / ilw.allocation_weight_total
      )::bigint AS revenue_floor_cents,
      (
        ilw.invoice_revenue_cents::numeric
        * ilw.allocation_weight
        / ilw.allocation_weight_total
      ) - FLOOR(
        ilw.invoice_revenue_cents::numeric
        * ilw.allocation_weight
        / ilw.allocation_weight_total
      ) AS revenue_remainder,
      FLOOR(
        ilw.invoice_cost_cents::numeric
        * ilw.allocation_weight
        / ilw.allocation_weight_total
      )::bigint AS cost_floor_cents,
      (
        ilw.invoice_cost_cents::numeric
        * ilw.allocation_weight
        / ilw.allocation_weight_total
      ) - FLOOR(
        ilw.invoice_cost_cents::numeric
        * ilw.allocation_weight
        / ilw.allocation_weight_total
      ) AS cost_remainder
    FROM invoice_location_weights ilw
  ),
  allocation_ranked AS (
    SELECT
      af.*,
      ROW_NUMBER() OVER (
        PARTITION BY af.invoice_id
        ORDER BY af.revenue_remainder DESC, af.field_id, af.location_id
      ) AS revenue_remainder_rank,
      ROW_NUMBER() OVER (
        PARTITION BY af.invoice_id
        ORDER BY af.cost_remainder DESC, af.field_id, af.location_id
      ) AS cost_remainder_rank,
      SUM(af.revenue_floor_cents) OVER (
        PARTITION BY af.invoice_id
      ) AS revenue_floor_total_cents,
      SUM(af.cost_floor_cents) OVER (
        PARTITION BY af.invoice_id
      ) AS cost_floor_total_cents
    FROM allocation_floors af
  ),
  allocated_money AS (
    SELECT
      ar.field_id,
      ar.invoice_season,
      ar.revenue_floor_cents
        + CASE
            WHEN ar.revenue_remainder_rank
              <= ar.invoice_revenue_cents - ar.revenue_floor_total_cents
            THEN 1
            ELSE 0
          END AS revenue_cents,
      ar.cost_floor_cents
        + CASE
            WHEN ar.cost_remainder_rank
              <= ar.invoice_cost_cents - ar.cost_floor_total_cents
            THEN 1
            ELSE 0
          END AS cost_cents
    FROM allocation_ranked ar
  ),
  money_by_field AS (
    SELECT
      am.field_id,
      am.invoice_season,
      SUM(am.revenue_cents)::bigint AS revenue_cents,
      SUM(am.cost_cents)::bigint AS cost_cents
    FROM allocated_money am
    GROUP BY am.field_id, am.invoice_season
  ),
  eligible_application_scopes AS (
    SELECT DISTINCT
      CASE
        WHEN ei.invoice_group_id IS NULL THEN 'invoice'
        ELSE 'group'
      END AS scope_type,
      COALESCE(ei.invoice_group_id, ei.invoice_id) AS scope_id,
      ei.invoice_season
    FROM eligible_invoices ei
  ),
  acres_by_scope_field AS (
    SELECT
      eas.scope_type,
      eas.scope_id,
      eas.invoice_season,
      fal.field_id,
      SUM(COALESCE(fal.applied_acres, 0)) AS applied_acres
    FROM eligible_application_scopes eas
    JOIN public.field_app_locations fal
      ON (
        eas.scope_type = 'invoice'
        AND fal.invoice_id = eas.scope_id
      ) OR (
        eas.scope_type = 'group'
        AND fal.invoice_group_id = eas.scope_id
      )
    WHERE COALESCE(fal.applied_acres, 0) >= 0
    GROUP BY
      eas.scope_type,
      eas.scope_id,
      eas.invoice_season,
      fal.field_id
  ),
  acres_by_field AS (
    SELECT
      absf.field_id,
      absf.invoice_season,
      SUM(absf.applied_acres) AS total_acres_applied
    FROM acres_by_scope_field absf
    GROUP BY absf.field_id, absf.invoice_season
  ),
  unassigned_invoices AS (
    SELECT
      ei.invoice_id,
      i.customer_id,
      c.farm_name AS customer_name,
      ei.invoice_season,
      ei.invoice_revenue_cents,
      ei.invoice_cost_cents
    FROM eligible_invoices ei
    JOIN public.invoices i
      ON i.id = ei.invoice_id
    LEFT JOIN public.customers c
      ON c.id = i.customer_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.field_app_locations fal
      WHERE (
        (
          ei.invoice_group_id IS NULL
          AND fal.invoice_id = ei.invoice_id
        ) OR (
          ei.invoice_group_id IS NOT NULL
          AND fal.invoice_group_id = ei.invoice_group_id
        )
      )
      AND COALESCE(fal.applied_acres, 0) >= 0
    )
  )
  SELECT
    f.id AS field_id,
    f.field_name,
    c.id AS customer_id,
    c.farm_name AS customer_name,
    mbf.invoice_season AS season,
    abf.total_acres_applied,
    mbf.revenue_cents,
    mbf.cost_cents,
    (mbf.revenue_cents - mbf.cost_cents)::bigint AS margin_cents,
    CASE
      WHEN abf.total_acres_applied = 0 THEN 0::bigint
      ELSE TRUNC(
        (mbf.revenue_cents - mbf.cost_cents)::numeric
        / abf.total_acres_applied
      )::bigint
    END AS margin_per_acre_cents
  FROM money_by_field mbf
  JOIN acres_by_field abf
    ON abf.field_id = mbf.field_id
   AND abf.invoice_season = mbf.invoice_season
  JOIN public.fields f
    ON f.id = mbf.field_id
  JOIN public.customers c
    ON c.id = f.customer_id
  UNION ALL
  SELECT
    NULL::uuid AS field_id,
    '(unassigned field)'::text AS field_name,
    ui.customer_id,
    ui.customer_name,
    ui.invoice_season AS season,
    0::numeric AS total_acres_applied,
    SUM(ui.invoice_revenue_cents)::bigint AS revenue_cents,
    SUM(ui.invoice_cost_cents)::bigint AS cost_cents,
    (SUM(ui.invoice_revenue_cents) - SUM(ui.invoice_cost_cents))::bigint AS margin_cents,
    0::bigint AS margin_per_acre_cents
  FROM unassigned_invoices ui
  GROUP BY ui.customer_id, ui.customer_name, ui.invoice_season
  ORDER BY 4, 2, 5;
END;
$$;

REVOKE ALL ON FUNCTION public.get_field_profitability(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_field_profitability(text) TO authenticated, service_role;
