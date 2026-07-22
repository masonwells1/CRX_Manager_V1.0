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
      i.customer_id,
      i.job_id,
      i.season::text AS invoice_season,
      i.total_amount_cents AS invoice_revenue_cents,
      COALESCE(i.total_cost_cents, 0)::bigint AS invoice_cost_cents
    FROM public.invoices i
    -- BILLED-CUSTOMER ATTRIBUTION EVIDENCE (verified live 2026-07-22): every
    -- current field_application writer bills exactly ONE customer per invoice
    -- row, so invoices.customer_id IS the billed customer and invoice_shares
    -- never needs to drive attribution here:
    --   * transfer_job_to_invoice multi-owner path creates one invoice PER
    --     member and writes literally "one invoice_shares row (100% of this
    --     member -> itself)" (live function body);
    --   * save_field_app_invoice / the per-line split writer create one child
    --     invoice per customer in a group;
    --   * live catalog: 0 field_application invoices carry an invoice_shares
    --     row whose customer differs from invoices.customer_id.
    -- A hypothetical legacy single-invoice-multi-customer-share shape has no
    -- writer and no live rows; if one ever appears its money reports under the
    -- invoice header customer (total cents still conserved).
    WHERE i.invoice_type = 'field_application'
      AND i.status IN ('posted', 'overdue', 'paid')
      AND i.deleted_at IS NULL
      AND (p_season IS NULL OR i.season::text = p_season)
      AND (
        public.is_admin()
        OR i.created_by = auth.uid()
        OR i.salesman_id = auth.uid()
      )
  ),
  grouped_location_shares AS (
    SELECT
      s.location_id,
      s.customer_id,
      SUM(GREATEST(COALESCE(s.acres, 0), 0)) AS share_acres
    FROM public.field_app_location_shares s
    GROUP BY s.location_id, s.customer_id
  ),
  invoice_location_basis AS (
    -- Ungrouped invoices retain their direct invoice -> location behavior.
    SELECT
      ei.invoice_id,
      ei.customer_id,
      ei.invoice_season,
      ei.invoice_revenue_cents,
      ei.invoice_cost_cents,
      fal.id AS location_id,
      fal.field_id,
      COALESCE(fal.applied_acres, 0) AS applied_acres
    FROM eligible_invoices ei
    JOIN public.field_app_locations fal
      ON fal.invoice_id = ei.invoice_id
    WHERE ei.invoice_group_id IS NULL
      AND COALESCE(fal.applied_acres, 0) >= 0

    UNION ALL

    -- A grouped child follows only its own customer's per-location shares.
    SELECT
      ei.invoice_id,
      ei.customer_id,
      ei.invoice_season,
      ei.invoice_revenue_cents,
      ei.invoice_cost_cents,
      fal.id AS location_id,
      fal.field_id,
      gls.share_acres AS applied_acres
    FROM eligible_invoices ei
    JOIN public.field_app_locations fal
      ON fal.invoice_group_id = ei.invoice_group_id
    JOIN grouped_location_shares gls
      ON gls.location_id = fal.id
     AND gls.customer_id = ei.customer_id
    WHERE ei.invoice_group_id IS NOT NULL

    UNION ALL

    -- Legacy grouped children with no share rows at all still allocate across
    -- the whole group's locations, so no invoice money can disappear.
    SELECT
      ei.invoice_id,
      ei.customer_id,
      ei.invoice_season,
      ei.invoice_revenue_cents,
      ei.invoice_cost_cents,
      fal.id AS location_id,
      fal.field_id,
      COALESCE(fal.applied_acres, 0) AS applied_acres
    FROM eligible_invoices ei
    JOIN public.field_app_locations fal
      ON fal.invoice_group_id = ei.invoice_group_id
    WHERE ei.invoice_group_id IS NOT NULL
      AND COALESCE(fal.applied_acres, 0) >= 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_app_locations share_fal
        JOIN grouped_location_shares share_gls
          ON share_gls.location_id = share_fal.id
         AND share_gls.customer_id = ei.customer_id
        WHERE share_fal.invoice_group_id = ei.invoice_group_id
      )
  ),
  invoice_location_totals AS (
    SELECT
      ilb.invoice_id,
      ilb.customer_id,
      ilb.invoice_season,
      ilb.invoice_revenue_cents,
      ilb.invoice_cost_cents,
      ilb.location_id,
      ilb.field_id,
      ilb.applied_acres,
      SUM(ilb.applied_acres) OVER (
        PARTITION BY ilb.invoice_id
      ) AS invoice_applied_acres,
      COUNT(*) OVER (
        PARTITION BY ilb.invoice_id
      ) AS invoice_location_count
    FROM invoice_location_basis ilb
  ),
  invoice_location_weights AS (
    SELECT
      ilt.invoice_id,
      ilt.customer_id,
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
      ar.customer_id,
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
      am.customer_id,
      am.invoice_season,
      SUM(am.revenue_cents)::bigint AS revenue_cents,
      SUM(am.cost_cents)::bigint AS cost_cents
    FROM allocated_money am
    GROUP BY am.field_id, am.customer_id, am.invoice_season
  ),
  eligible_ungrouped_invoices AS (
    SELECT DISTINCT
      ei.invoice_id,
      ei.customer_id,
      ei.invoice_season
    FROM eligible_invoices ei
    WHERE ei.invoice_group_id IS NULL
  ),
  eligible_group_customers AS (
    SELECT DISTINCT
      ei.invoice_group_id,
      ei.customer_id,
      ei.invoice_season
    FROM eligible_invoices ei
    WHERE ei.invoice_group_id IS NOT NULL
  ),
  eligible_groups AS (
    SELECT DISTINCT
      egc.invoice_group_id,
      egc.invoice_season
    FROM eligible_group_customers egc
  ),
  ungrouped_acres_by_scope_field AS (
    SELECT
      eui.customer_id,
      eui.invoice_season,
      fal.field_id,
      SUM(COALESCE(fal.applied_acres, 0)) AS applied_acres
    FROM eligible_ungrouped_invoices eui
    JOIN public.field_app_locations fal
      ON fal.invoice_id = eui.invoice_id
    WHERE COALESCE(fal.applied_acres, 0) >= 0
    GROUP BY eui.invoice_id, eui.customer_id, eui.invoice_season, fal.field_id
  ),
  grouped_share_acres_by_scope_field AS (
    -- Count each eligible child's customer share once per group. DISTINCT in
    -- eligible_group_customers prevents duplicate child rows from doubling acres.
    SELECT
      egc.customer_id,
      egc.invoice_season,
      fal.field_id,
      SUM(gls.share_acres) AS applied_acres
    FROM eligible_group_customers egc
    JOIN public.field_app_locations fal
      ON fal.invoice_group_id = egc.invoice_group_id
    JOIN grouped_location_shares gls
      ON gls.location_id = fal.id
     AND gls.customer_id = egc.customer_id
    GROUP BY egc.invoice_group_id, egc.customer_id, egc.invoice_season, fal.field_id
  ),
  no_location_share_group_children AS (
    -- Groups whose locations carry NO field_app_location_shares rows. This is
    -- the CURRENT per-line split writer's shape (group-level field_app_locations,
    -- per-child acres in invoice_shares.acres) as well as true legacy groups.
    SELECT
      ei.invoice_id,
      ei.invoice_group_id,
      ei.customer_id,
      ei.invoice_season
    FROM eligible_invoices ei
    WHERE ei.invoice_group_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.field_app_locations share_fal
        JOIN public.field_app_location_shares s
          ON s.location_id = share_fal.id
        WHERE share_fal.invoice_group_id = ei.invoice_group_id
      )
  ),
  group_location_acres AS (
    SELECT
      fal.invoice_group_id,
      fal.field_id,
      SUM(COALESCE(fal.applied_acres, 0)) AS field_acres,
      SUM(SUM(COALESCE(fal.applied_acres, 0))) OVER (
        PARTITION BY fal.invoice_group_id
      ) AS group_acres
    FROM public.field_app_locations fal
    WHERE fal.invoice_group_id IS NOT NULL
      AND COALESCE(fal.applied_acres, 0) >= 0
    GROUP BY fal.invoice_group_id, fal.field_id
  ),
  grouped_invoice_share_acres_by_scope_field AS (
    -- Current split writer: the child's own allocated acres live in
    -- invoice_shares.acres. Spread that child total across the group's fields
    -- proportionally by location acres (numeric, no cent constraint).
    SELECT
      nlc.customer_id,
      nlc.invoice_season,
      gla.field_id,
      SUM(
        child_acres.total_acres
        * CASE WHEN gla.group_acres > 0
               THEN gla.field_acres / gla.group_acres
               ELSE 0 END
      ) AS applied_acres
    FROM no_location_share_group_children nlc
    JOIN LATERAL (
      SELECT SUM(GREATEST(COALESCE(ish.acres, 0), 0)) AS total_acres
      FROM public.invoice_shares ish
      WHERE ish.invoice_id = nlc.invoice_id
    ) child_acres ON child_acres.total_acres IS NOT NULL AND child_acres.total_acres > 0
    JOIN group_location_acres gla
      ON gla.invoice_group_id = nlc.invoice_group_id
    GROUP BY nlc.invoice_group_id, nlc.customer_id, nlc.invoice_season, gla.field_id
  ),
  grouped_legacy_acres_by_scope_field AS (
    -- TRUE legacy only: no location shares AND no usable invoice_shares acres.
    -- The child's money was allocated over the whole group's locations, so
    -- attribute the whole-group acres to EACH such child customer.
    SELECT
      nlc.customer_id,
      nlc.invoice_season,
      fal.field_id,
      SUM(COALESCE(fal.applied_acres, 0)) AS applied_acres
    FROM no_location_share_group_children nlc
    JOIN public.field_app_locations fal
      ON fal.invoice_group_id = nlc.invoice_group_id
    WHERE COALESCE(fal.applied_acres, 0) >= 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.invoice_shares ish
        WHERE ish.invoice_id = nlc.invoice_id
          AND COALESCE(ish.acres, 0) > 0
      )
    GROUP BY nlc.invoice_group_id, nlc.customer_id, nlc.invoice_season, fal.field_id
  ),
  acres_by_scope_field AS (
    SELECT * FROM ungrouped_acres_by_scope_field
    UNION ALL
    SELECT * FROM grouped_share_acres_by_scope_field
    UNION ALL
    SELECT * FROM grouped_invoice_share_acres_by_scope_field
    UNION ALL
    SELECT * FROM grouped_legacy_acres_by_scope_field
  ),
  acres_by_field AS (
    SELECT
      absf.field_id,
      absf.customer_id,
      absf.invoice_season,
      SUM(absf.applied_acres) AS total_acres_applied
    FROM acres_by_scope_field absf
    GROUP BY absf.field_id, absf.customer_id, absf.invoice_season
  ),
  unassigned_invoices AS (
    -- Invoices with NO durable field attribution: no field_app_locations for
    -- the invoice or its group. This includes ALL transfer_job_to_invoice
    -- invoices - deliberately NOT spread over job_fields/field_billing_defaults
    -- because those are mutable current state (editable after posting);
    -- presenting a mutable spread as historical profitability was rejected in
    -- review. Their money reports exactly, per billed customer, with zero
    -- acres, until a durable per-field posting snapshot exists.
    SELECT
      ei.invoice_id,
      ei.customer_id AS header_customer_id,
      ei.invoice_season,
      ei.invoice_revenue_cents,
      ei.invoice_cost_cents
    FROM eligible_invoices ei
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
  ),
  unassigned_share_sums AS (
    -- Durable invoice_shares splits (e.g. a landlord/tenant share on a single
    -- invoice): revenue follows the stored share amounts exactly.
    SELECT
      ui.invoice_id,
      ish.customer_id,
      SUM(GREATEST(COALESCE(ish.amount_cents, 0), 0))::bigint AS share_cents
    FROM unassigned_invoices ui
    JOIN public.invoice_shares ish
      ON ish.invoice_id = ui.invoice_id
    GROUP BY ui.invoice_id, ish.customer_id
    HAVING SUM(GREATEST(COALESCE(ish.amount_cents, 0), 0)) > 0
  ),
  unassigned_units_raw AS (
    SELECT
      ui.invoice_id,
      uss.customer_id,
      ui.invoice_season,
      uss.share_cents AS revenue_cents
    FROM unassigned_invoices ui
    JOIN unassigned_share_sums uss
      ON uss.invoice_id = ui.invoice_id
    UNION ALL
    -- Residual (or the whole invoice when no usable shares) goes to the header
    -- customer, so every invoice's revenue lands exactly once to the cent.
    SELECT
      ui.invoice_id,
      ui.header_customer_id,
      ui.invoice_season,
      ui.invoice_revenue_cents
        - COALESCE((SELECT SUM(uss2.share_cents)
                      FROM unassigned_share_sums uss2
                     WHERE uss2.invoice_id = ui.invoice_id), 0) AS revenue_cents
    FROM unassigned_invoices ui
    WHERE ui.invoice_revenue_cents
        - COALESCE((SELECT SUM(uss2.share_cents)
                      FROM unassigned_share_sums uss2
                     WHERE uss2.invoice_id = ui.invoice_id), 0) <> 0
       OR NOT EXISTS (
        SELECT 1 FROM unassigned_share_sums uss3
        WHERE uss3.invoice_id = ui.invoice_id
      )
  ),
  unassigned_units AS (
    SELECT
      uur.invoice_id,
      uur.customer_id,
      uur.invoice_season,
      SUM(uur.revenue_cents)::bigint AS revenue_cents
    FROM unassigned_units_raw uur
    GROUP BY uur.invoice_id, uur.customer_id, uur.invoice_season
  ),
  unassigned_cost_alloc AS (
    -- Cost follows revenue proportionally with integer largest-remainder;
    -- single-unit invoices (all current writers) pass cost through exactly.
    SELECT
      uu.invoice_id,
      uu.customer_id,
      uu.invoice_season,
      uu.revenue_cents,
      ui.invoice_cost_cents,
      SUM(uu.revenue_cents) OVER (PARTITION BY uu.invoice_id) AS invoice_rev_total,
      COUNT(*) OVER (PARTITION BY uu.invoice_id) AS unit_count,
      ROW_NUMBER() OVER (
        PARTITION BY uu.invoice_id ORDER BY uu.revenue_cents DESC, uu.customer_id
      ) AS unit_rank
    FROM unassigned_units uu
    JOIN unassigned_invoices ui
      ON ui.invoice_id = uu.invoice_id
  ),
  unassigned_cost_floors AS (
    SELECT
      uca.*,
      CASE
        WHEN uca.invoice_rev_total > 0
          THEN FLOOR(uca.invoice_cost_cents::numeric * uca.revenue_cents / uca.invoice_rev_total)::bigint
        ELSE FLOOR(uca.invoice_cost_cents::numeric / uca.unit_count)::bigint
      END AS cost_floor_cents
    FROM unassigned_cost_alloc uca
  ),
  unassigned_final AS (
    SELECT
      ucf.customer_id,
      ucf.invoice_season,
      ucf.revenue_cents,
      (ucf.cost_floor_cents
        + CASE
            WHEN ucf.unit_rank
              <= ucf.invoice_cost_cents
                 - SUM(ucf.cost_floor_cents) OVER (PARTITION BY ucf.invoice_id)
            THEN 1 ELSE 0
          END)::bigint AS cost_cents
    FROM unassigned_cost_floors ucf
  )
  SELECT
    f.id AS field_id,
    f.field_name,
    c.id AS customer_id,
    c.farm_name AS customer_name,
    mbf.invoice_season AS season,
    COALESCE(abf.total_acres_applied, 0) AS total_acres_applied,
    mbf.revenue_cents,
    mbf.cost_cents,
    (mbf.revenue_cents - mbf.cost_cents)::bigint AS margin_cents,
    CASE
      WHEN COALESCE(abf.total_acres_applied, 0) = 0 THEN 0::bigint
      ELSE TRUNC(
        (mbf.revenue_cents - mbf.cost_cents)::numeric
        / abf.total_acres_applied
      )::bigint
    END AS margin_per_acre_cents
  FROM money_by_field mbf
  LEFT JOIN acres_by_field abf
    ON abf.field_id = mbf.field_id
   AND abf.customer_id = mbf.customer_id
   AND abf.invoice_season = mbf.invoice_season
  JOIN public.fields f
    ON f.id = mbf.field_id
  -- Attribution follows the BILLED customer (invoices.customer_id carried through
  -- the allocation), not the field owner — on shared fields each co-owner's
  -- invoiced money reports under that co-owner.
  JOIN public.customers c
    ON c.id = mbf.customer_id
  UNION ALL
  SELECT
    NULL::uuid AS field_id,
    '(unassigned field)'::text AS field_name,
    uf.customer_id,
    c2.farm_name AS customer_name,
    uf.invoice_season AS season,
    0::numeric AS total_acres_applied,
    SUM(uf.revenue_cents)::bigint AS revenue_cents,
    SUM(uf.cost_cents)::bigint AS cost_cents,
    (SUM(uf.revenue_cents) - SUM(uf.cost_cents))::bigint AS margin_cents,
    0::bigint AS margin_per_acre_cents
  FROM unassigned_final uf
  LEFT JOIN public.customers c2
    ON c2.id = uf.customer_id
  GROUP BY uf.customer_id, c2.farm_name, uf.invoice_season
  ORDER BY 4, 2, 5;
END;
$$;

REVOKE ALL ON FUNCTION public.get_field_profitability(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_field_profitability(text) TO authenticated, service_role;

-- Fail closed on overload drift: exactly ONE get_field_profitability may exist,
-- so a stale overload can never survive with unintended grants or cause
-- PostgREST ambiguity.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_field_profitability';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'OVERLOAD_DRIFT: expected exactly 1 get_field_profitability, found %', v_count;
  END IF;
END
$$;
