-- Per-Line-Item Split Billing — Phase 2: one server-side calculator/resolver.
--
-- Spec: docs/plans/per-line-item-split-billing-spec-2026-07-17.md §4, §5, §6.3-6.4.
-- Depends on: 20260718120000_per_line_split_billing_phase1_schema.sql.
--
-- This migration is intentionally preview-only. It creates the single private plan
-- calculator that Phase 3's locked save writer will consume, and routes the existing
-- preview RPC through that calculator only while feature_per_line_split_billing is ON.
-- The flag remains OFF in this migration, so the current save and preview behavior is
-- unchanged. The locked save_field_app_invoice wrapper is not replaced here.
--
-- Pinned rounding policy v1:
--   1. All arithmetic is PostgreSQL numeric/bigint; never float.
--   2. Money rounds half-away-from-zero with round(numeric).
--   3. Money rounds exactly once at the final figure.
--   4. Largest remainder floors ABS(value), awards residual by
--      (fractional_remainder DESC, customer_id ASC), then reapplies the sign.
--   5. Quantity, acre, micro-percent, and cent passes use the same customer tie-break.
--   6. Even vectors use largest remainder (three-way = 33333334/33333333/33333333).
--   7. price x micro-percent intermediates stay numeric.

BEGIN;

CREATE OR REPLACE FUNCTION public._calculate_per_line_split_billing_plan(
  p_job_id uuid,
  p_locations jsonb,
  p_chemicals jsonb,
  p_application_service_id uuid DEFAULT NULL::uuid,
  p_invoice_id uuid DEFAULT NULL::uuid,
  p_line_overrides jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $calculator$
DECLARE
  v_actor uuid := auth.uid();
  v_effective_job_id uuid := p_job_id;
  v_invoice_job_id uuid;
  v_invoice_group_id uuid;
  v_feature_enabled boolean;
  v_loc jsonb;
  v_chem jsonb;
  v_flat jsonb;
  v_override jsonb;
  v_price_override jsonb;
  v_line_key text;
  v_line_kind text;
  v_split_reason text;
  v_vector_mode text;
  v_rate numeric;
  v_source_qty_raw numeric;
  v_source_qty numeric(12,4);
  v_source_acres_raw numeric;
  v_source_acres numeric(12,4);
  v_inventory_unit text;
  v_product_form text;
  v_rate_unit text;
  v_source_amount bigint;
  v_sort_order integer;
  v_customer_count integer;
  v_line_count integer;
  v_field_count integer;
  v_vector_count integer;
  v_vector_sum bigint;
  v_bad_count integer;
  v_app_service record;
  v_result jsonb;
BEGIN
  -- The private function is owner-only, but still binds its reads to the real caller.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can calculate per-line billing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(bool_or(setting_value = 'true'), false)
    INTO v_feature_enabled
    FROM public.app_settings
   WHERE setting_key = 'feature_per_line_split_billing';
  IF NOT v_feature_enabled THEN
    RAISE EXCEPTION 'PER_LINE_SPLIT_BILLING_DISABLED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF p_locations IS NULL OR jsonb_typeof(p_locations) <> 'array'
     OR jsonb_array_length(p_locations) = 0 THEN
    RAISE EXCEPTION 'PER_LINE_LOCATIONS_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_chemicals IS NULL OR jsonb_typeof(p_chemicals) <> 'array' THEN
    RAISE EXCEPTION 'PER_LINE_CHEMICALS_MUST_BE_ARRAY' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_line_overrides IS NULL OR jsonb_typeof(p_line_overrides) <> 'object' THEN
    RAISE EXCEPTION 'PER_LINE_OVERRIDES_MUST_BE_OBJECT' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_line_overrides ? 'lines'
     AND jsonb_typeof(p_line_overrides->'lines') <> 'array' THEN
    RAISE EXCEPTION 'PER_LINE_OVERRIDE_LINES_MUST_BE_ARRAY' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_line_overrides ? 'flat_fees'
     AND jsonb_typeof(p_line_overrides->'flat_fees') <> 'array' THEN
    RAISE EXCEPTION 'PER_LINE_FLAT_FEES_MUST_BE_ARRAY' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Temp relations keep one function readable without creating reusable math helpers.
  -- They are connection-local, transaction-scoped, and never touch production rows.
  CREATE TEMP TABLE IF NOT EXISTS _plsb_fields (
    field_id uuid PRIMARY KEY,
    field_name text NOT NULL,
    applied_acres numeric NOT NULL,
    total_acres numeric
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _plsb_field_vectors (
    field_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    customer_name text NOT NULL,
    tier integer NOT NULL,
    is_primary boolean NOT NULL,
    vector_source text NOT NULL,
    source_split_pct numeric NOT NULL,
    split_micro_pct integer,
    allocated_acres numeric(12,4),
    PRIMARY KEY (field_id, customer_id)
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _plsb_customers (
    customer_id uuid PRIMARY KEY,
    customer_name text NOT NULL,
    tier integer NOT NULL,
    is_primary boolean NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _plsb_lines (
    line_key text PRIMARY KEY,
    line_kind text NOT NULL,
    price_basis text,
    product_id uuid,
    application_service_id uuid,
    description text NOT NULL,
    source_pricing_quantity numeric,
    source_quantity numeric(12,4),
    source_acres numeric(12,4),
    source_unit_price_cents bigint,
    source_amount_cents bigint,
    sort_order integer NOT NULL,
    source_input jsonb NOT NULL,
    vector_hash text,
    calculation_hash text
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _plsb_shares (
    line_key text NOT NULL,
    customer_id uuid NOT NULL,
    split_mode text NOT NULL DEFAULT 'field_default',
    split_micro_pct integer,
    allocated_quantity numeric(12,4),
    allocated_acres numeric(12,4),
    base_unit_price_cents bigint,
    base_price_source text,
    price_mode text NOT NULL DEFAULT 'default',
    unit_price_cents bigint,
    amount_cents bigint,
    split_override_reason text,
    price_override_reason text,
    PRIMARY KEY (line_key, customer_id)
  ) ON COMMIT DROP;

  TRUNCATE pg_temp._plsb_fields;
  TRUNCATE pg_temp._plsb_field_vectors;
  TRUNCATE pg_temp._plsb_customers;
  TRUNCATE pg_temp._plsb_lines;
  TRUNCATE pg_temp._plsb_shares;

  IF p_invoice_id IS NOT NULL THEN
    SELECT i.job_id, i.invoice_group_id
      INTO v_invoice_job_id, v_invoice_group_id
      FROM public.invoices i
     WHERE i.id = p_invoice_id
       AND i.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', p_invoice_id USING ERRCODE = 'no_data_found';
    END IF;
    IF p_job_id IS NOT NULL AND v_invoice_job_id IS NOT NULL
       AND p_job_id IS DISTINCT FROM v_invoice_job_id THEN
      RAISE EXCEPTION 'PER_LINE_JOB_CONTEXT_MISMATCH' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_effective_job_id := COALESCE(p_job_id, v_invoice_job_id);
  END IF;

  IF v_effective_job_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = v_effective_job_id) THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: %', v_effective_job_id USING ERRCODE = 'no_data_found';
  END IF;

  -- One source location per field; applied acres must be positive and finite numeric.
  FOR v_loc IN SELECT value FROM jsonb_array_elements(p_locations)
  LOOP
    IF v_loc->>'field_id' IS NULL OR v_loc->>'applied_acres' IS NULL THEN
      RAISE EXCEPTION 'PER_LINE_LOCATION_FIELD_AND_ACRES_REQUIRED'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO pg_temp._plsb_fields (field_id, field_name, applied_acres, total_acres)
    SELECT
      f.id,
      f.field_name,
      (v_loc->>'applied_acres')::numeric,
      f.total_acres
    FROM public.fields f
    WHERE f.id = (v_loc->>'field_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FIELD_NOT_FOUND: %', v_loc->>'field_id' USING ERRCODE = 'no_data_found';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_field_count FROM pg_temp._plsb_fields;
  IF v_field_count <> jsonb_array_length(p_locations) THEN
    RAISE EXCEPTION 'PER_LINE_DUPLICATE_FIELD' USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_temp._plsb_fields WHERE applied_acres <= 0) THEN
    RAISE EXCEPTION 'ZERO_APPLIED_ACRES: every selected field needs applied acres greater than zero'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Mode A is incompatible with product-vs-service line splitting. Reject the
  -- complete feature before any durable write, even if a job snapshot exists.
  IF EXISTS (
    SELECT 1
    FROM public.field_billing_defaults fbd
    JOIN pg_temp._plsb_fields f ON f.field_id = fbd.field_id
    WHERE fbd.price_override_cents IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PER_LINE_MODE_A_UNSUPPORTED'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- Ownership precedence is resolved per field: job snapshot -> field default -> owner fallback.
  INSERT INTO pg_temp._plsb_field_vectors (
    field_id, customer_id, customer_name, tier, is_primary, vector_source, source_split_pct
  )
  SELECT f.field_id, jfs.customer_id, c.farm_name, c.assigned_tier,
         jfs.is_primary, 'job_snapshot', jfs.split_pct
  FROM pg_temp._plsb_fields f
  JOIN public.job_field_shares jfs
    ON jfs.job_id = v_effective_job_id AND jfs.field_id = f.field_id
  JOIN public.customers c ON c.id = jfs.customer_id
  WHERE v_effective_job_id IS NOT NULL;

  INSERT INTO pg_temp._plsb_field_vectors (
    field_id, customer_id, customer_name, tier, is_primary, vector_source, source_split_pct
  )
  SELECT f.field_id, fbd.customer_id, c.farm_name, c.assigned_tier,
         fbd.is_primary, 'field_default', fbd.split_pct
  FROM pg_temp._plsb_fields f
  JOIN public.field_billing_defaults fbd ON fbd.field_id = f.field_id
  JOIN public.customers c ON c.id = fbd.customer_id
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_temp._plsb_field_vectors x WHERE x.field_id = f.field_id
  );

  INSERT INTO pg_temp._plsb_field_vectors (
    field_id, customer_id, customer_name, tier, is_primary, vector_source, source_split_pct
  )
  SELECT f.field_id, fld.customer_id, c.farm_name, c.assigned_tier,
         true, 'field_owner_fallback', 100::numeric
  FROM pg_temp._plsb_fields f
  JOIN public.fields fld ON fld.id = f.field_id
  JOIN public.customers c ON c.id = fld.customer_id
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_temp._plsb_field_vectors x WHERE x.field_id = f.field_id
  );

  IF EXISTS (
    SELECT 1
    FROM pg_temp._plsb_fields f
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp._plsb_field_vectors v WHERE v.field_id = f.field_id)
  ) THEN
    RAISE EXCEPTION 'PER_LINE_FIELD_HAS_NO_BILLING_OWNER' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_temp._plsb_field_vectors
    WHERE source_split_pct <= 0 OR source_split_pct > 100
  ) THEN
    RAISE EXCEPTION 'PER_LINE_SOURCE_SPLIT_OUT_OF_RANGE' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT field_id FROM pg_temp._plsb_field_vectors
    GROUP BY field_id HAVING sum(source_split_pct) <> 100::numeric
  ) THEN
    RAISE EXCEPTION 'PER_LINE_SOURCE_VECTOR_NOT_100PCT' USING ERRCODE = 'check_violation';
  END IF;

  -- Convert source percentages into exact micro-percent using largest remainder.
  WITH ideals AS (
    SELECT v.field_id, v.customer_id,
           (v.source_split_pct * 1000000::numeric) AS ideal
    FROM pg_temp._plsb_field_vectors v
  ), bases AS (
    SELECT field_id, customer_id, floor(ideal)::bigint AS base,
           ideal - floor(ideal) AS frac
    FROM ideals
  ), ranked AS (
    SELECT field_id, customer_id, base,
           row_number() OVER (PARTITION BY field_id ORDER BY frac DESC, customer_id ASC) AS rn,
           100000000 - sum(base) OVER (PARTITION BY field_id) AS residual
    FROM bases
  )
  UPDATE pg_temp._plsb_field_vectors v
     SET split_micro_pct = (r.base + CASE WHEN r.rn <= r.residual THEN 1 ELSE 0 END)::integer
    FROM ranked r
   WHERE r.field_id = v.field_id AND r.customer_id = v.customer_id;

  -- Allocate each field's acres at 4dp. Floor ABS, award residual by customer UUID, reapply sign.
  WITH ideals AS (
    SELECT v.field_id, v.customer_id,
           round(abs(f.applied_acres) * 10000)::bigint AS total_ticks,
           CASE WHEN f.applied_acres < 0 THEN -1 ELSE 1 END AS sign_value,
           (round(abs(f.applied_acres) * 10000)::numeric * v.split_micro_pct::numeric)
             / 100000000::numeric AS ideal
    FROM pg_temp._plsb_field_vectors v
    JOIN pg_temp._plsb_fields f ON f.field_id = v.field_id
  ), bases AS (
    SELECT field_id, customer_id, total_ticks, sign_value,
           floor(ideal)::bigint AS base, ideal - floor(ideal) AS frac
    FROM ideals
  ), ranked AS (
    SELECT field_id, customer_id, sign_value, base,
           row_number() OVER (PARTITION BY field_id ORDER BY frac DESC, customer_id ASC) AS rn,
           total_ticks - sum(base) OVER (PARTITION BY field_id) AS residual
    FROM bases
  )
  UPDATE pg_temp._plsb_field_vectors v
     SET allocated_acres = (
       r.sign_value * (r.base + CASE WHEN r.rn <= r.residual THEN 1 ELSE 0 END)
     )::numeric / 10000::numeric
    FROM ranked r
   WHERE r.field_id = v.field_id AND r.customer_id = v.customer_id;

  INSERT INTO pg_temp._plsb_customers (customer_id, customer_name, tier, is_primary)
  SELECT customer_id, max(customer_name), max(tier), bool_or(is_primary)
  FROM pg_temp._plsb_field_vectors
  GROUP BY customer_id;
  SELECT count(*) INTO v_customer_count FROM pg_temp._plsb_customers;
  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'PER_LINE_NO_BILLING_CUSTOMERS' USING ERRCODE = 'check_violation';
  END IF;

  -- A previously deleted member cannot silently disappear from a new exact vector.
  IF v_invoice_group_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.invoices deleted_member
    JOIN pg_temp._plsb_customers c ON c.customer_id = deleted_member.customer_id
    WHERE deleted_member.invoice_group_id = v_invoice_group_id
      AND deleted_member.deleted_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.invoices live_member
        WHERE live_member.invoice_group_id = v_invoice_group_id
          AND live_member.customer_id = deleted_member.customer_id
          AND live_member.deleted_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'PER_LINE_DELETED_MEMBER_REQUIRES_REALLOCATION'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service
    FROM public.application_services
    WHERE id = p_application_service_id AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'APPLICATION_SERVICE_NOT_FOUND_OR_INACTIVE: %', p_application_service_id
        USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  -- Build logical chemical lines. Keep the converted quantity at full numeric precision for
  -- the one final money multiply; separately round it to the final 4dp storage precision for
  -- deterministic quantity allocation. Rounding the quantity before money can change a bill by 1c.
  FOR v_chem IN
    SELECT value FROM jsonb_array_elements(p_chemicals)
  LOOP
    v_sort_order := COALESCE((v_chem->>'sort_order')::integer, 0);
    v_line_key := COALESCE(NULLIF(v_chem->>'line_key', ''), 'chemical:' || v_sort_order::text);
    v_rate := NULLIF(v_chem->>'rate_per_acre', '')::numeric;
    v_rate_unit := COALESCE(NULLIF(v_chem->>'rate_unit', ''), NULLIF(v_chem->>'unit_size', ''));

    IF (v_chem->>'product_id') IS NOT NULL THEN
      SELECT p.inventory_unit, p.product_form::text
        INTO v_inventory_unit, v_product_form
        FROM public.products p
       WHERE p.id = (v_chem->>'product_id')::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', v_chem->>'product_id' USING ERRCODE = 'no_data_found';
      END IF;
    ELSE
      v_inventory_unit := v_rate_unit;
      v_product_form := NULL;
    END IF;

    IF v_rate IS NOT NULL THEN
      SELECT v_rate * sum(applied_acres) INTO v_source_qty_raw FROM pg_temp._plsb_fields;
    ELSE
      v_source_qty_raw := NULLIF(v_chem->>'quantity', '')::numeric;
    END IF;
    IF v_source_qty_raw IS NULL THEN
      RAISE EXCEPTION 'PER_LINE_CHEMICAL_QUANTITY_REQUIRED: %', v_line_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_source_qty_raw := public.field_app_priced_quantity(
      v_source_qty_raw,
      v_rate_unit,
      COALESCE(v_inventory_unit, v_rate_unit),
      v_product_form
    );
    IF v_source_qty_raw IS NULL THEN
      RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: %', v_line_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_source_qty := round(v_source_qty_raw, 4);
    SELECT round(sum(applied_acres), 4) INTO v_source_acres FROM pg_temp._plsb_fields;

    INSERT INTO pg_temp._plsb_lines (
      line_key, line_kind, product_id, description, source_pricing_quantity,
      source_quantity, source_acres, sort_order, source_input
    ) VALUES (
      v_line_key, 'chemical', (v_chem->>'product_id')::uuid,
      COALESCE(NULLIF(v_chem->>'description', ''), 'Chemical'),
      v_source_qty_raw, v_source_qty, v_source_acres, v_sort_order, v_chem
    );
  END LOOP;

  IF p_application_service_id IS NOT NULL THEN
    SELECT sum(applied_acres) INTO v_source_acres_raw FROM pg_temp._plsb_fields;
    v_source_acres := round(v_source_acres_raw, 4);
    INSERT INTO pg_temp._plsb_lines (
      line_key, line_kind, application_service_id, description,
      source_pricing_quantity, source_quantity, source_acres, sort_order, source_input
    ) VALUES (
      'service:' || p_application_service_id::text,
      'service', p_application_service_id, v_app_service.name,
      v_source_acres_raw, v_source_acres, v_source_acres, 1000000,
      jsonb_build_object('application_service_id', p_application_service_id)
    );
  END IF;

  -- Generic flat fees are accepted for the server contract; fuel surcharge is deliberately
  -- not inferred. The settled feature has no automatic fuel-surcharge line.
  FOR v_flat IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_line_overrides->'flat_fees', '[]'::jsonb))
  LOOP
    v_sort_order := COALESCE((v_flat->>'sort_order')::integer, 2000000);
    v_line_key := COALESCE(NULLIF(v_flat->>'line_key', ''), 'flat_fee:' || v_sort_order::text);
    IF v_flat->>'source_amount_cents' IS NULL THEN
      RAISE EXCEPTION 'PER_LINE_FLAT_FEE_AMOUNT_REQUIRED: %', v_line_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_source_amount := (v_flat->>'source_amount_cents')::bigint;
    INSERT INTO pg_temp._plsb_lines (
      line_key, line_kind, price_basis, description, source_amount_cents,
      sort_order, source_input
    ) VALUES (
      v_line_key, 'flat_fee', 'flat_fee',
      COALESCE(NULLIF(v_flat->>'description', ''), 'Flat fee'),
      v_source_amount, v_sort_order, v_flat
    );
  END LOOP;

  SELECT count(*) INTO v_line_count FROM pg_temp._plsb_lines;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'PER_LINE_AT_LEAST_ONE_LINE_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Override keys must be unique and must name a real server-created logical line.
  IF EXISTS (
    SELECT value->>'line_key'
    FROM jsonb_array_elements(COALESCE(p_line_overrides->'lines', '[]'::jsonb))
    GROUP BY value->>'line_key'
    HAVING value->>'line_key' IS NULL OR count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PER_LINE_DUPLICATE_OR_MISSING_OVERRIDE_KEY' USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_line_overrides->'lines', '[]'::jsonb)) o
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp._plsb_lines l WHERE l.line_key = o->>'line_key')
  ) THEN
    RAISE EXCEPTION 'PER_LINE_UNKNOWN_OVERRIDE_KEY' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Default vector per logical line: aggregate the field-resolved acres, then normalize
  -- to exact micro-percent with largest remainder and customer_id tie-break.
  INSERT INTO pg_temp._plsb_shares (line_key, customer_id, split_mode, split_micro_pct)
  WITH weights AS (
    SELECT l.line_key, c.customer_id,
           COALESCE(sum(v.allocated_acres), 0)::numeric AS weight,
           sum(COALESCE(sum(v.allocated_acres), 0)) OVER (PARTITION BY l.line_key) AS total_weight
    FROM pg_temp._plsb_lines l
    CROSS JOIN pg_temp._plsb_customers c
    LEFT JOIN pg_temp._plsb_field_vectors v ON v.customer_id = c.customer_id
    GROUP BY l.line_key, c.customer_id
  ), ideals AS (
    SELECT line_key, customer_id,
           CASE WHEN total_weight = 0
                THEN 100000000::numeric / v_customer_count::numeric
                ELSE weight * 100000000::numeric / total_weight END AS ideal
    FROM weights
  ), bases AS (
    SELECT line_key, customer_id, floor(ideal)::bigint AS base,
           ideal - floor(ideal) AS frac
    FROM ideals
  ), ranked AS (
    SELECT line_key, customer_id, base,
           row_number() OVER (PARTITION BY line_key ORDER BY frac DESC, customer_id ASC) AS rn,
           100000000 - sum(base) OVER (PARTITION BY line_key) AS residual
    FROM bases
  )
  SELECT line_key, customer_id, 'field_default',
         (base + CASE WHEN rn <= residual THEN 1 ELSE 0 END)::integer
  FROM ranked;

  -- Apply complete custom/even vectors and partial per-person price overrides.
  FOR v_override IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_line_overrides->'lines', '[]'::jsonb))
  LOOP
    v_line_key := v_override->>'line_key';
    v_vector_mode := COALESCE(NULLIF(v_override->>'vector_mode', ''), 'explicit');

    IF COALESCE(v_override->>'split_mode', 'field_default') = 'custom'
       OR v_override ? 'vector' OR v_vector_mode = 'even' THEN
      v_split_reason := NULLIF(btrim(v_override->>'split_override_reason'), '');
      IF v_split_reason IS NULL THEN
        RAISE EXCEPTION 'PER_LINE_CUSTOM_SPLIT_REASON_REQUIRED: %', v_line_key
          USING ERRCODE = 'check_violation';
      END IF;

      IF v_vector_mode = 'even' THEN
        WITH ideals AS (
          SELECT c.customer_id, 100000000::numeric / v_customer_count::numeric AS ideal
          FROM pg_temp._plsb_customers c
        ), bases AS (
          SELECT customer_id, floor(ideal)::bigint AS base, ideal - floor(ideal) AS frac
          FROM ideals
        ), ranked AS (
          SELECT customer_id, base,
                 row_number() OVER (ORDER BY frac DESC, customer_id ASC) AS rn,
                 100000000 - sum(base) OVER () AS residual
          FROM bases
        )
        UPDATE pg_temp._plsb_shares s
           SET split_mode = 'custom',
               split_micro_pct = (r.base + CASE WHEN r.rn <= r.residual THEN 1 ELSE 0 END)::integer,
               split_override_reason = v_split_reason
          FROM ranked r
         WHERE s.line_key = v_line_key AND s.customer_id = r.customer_id;
      ELSE
        IF v_override->'vector' IS NULL OR jsonb_typeof(v_override->'vector') <> 'array' THEN
          RAISE EXCEPTION 'PER_LINE_CUSTOM_VECTOR_REQUIRED: %', v_line_key
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_override->'vector') entry
          WHERE entry->>'customer_id' IS NULL
             OR entry->>'split_micro_pct' IS NULL
             OR NOT pg_input_is_valid(entry->>'customer_id', 'uuid')
             OR NOT pg_input_is_valid(entry->>'split_micro_pct', 'bigint')
             OR (entry->>'split_micro_pct')::bigint < 0
             OR (entry->>'split_micro_pct')::bigint > 100000000
        ) THEN
          RAISE EXCEPTION 'PER_LINE_CUSTOM_VECTOR_CUSTOMER_SET_MISMATCH: %', v_line_key
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT count(*), COALESCE(sum((entry->>'split_micro_pct')::bigint), 0)
          INTO v_vector_count, v_vector_sum
          FROM jsonb_array_elements(v_override->'vector') entry;
        IF v_vector_count <> v_customer_count OR v_vector_sum <> 100000000 THEN
          RAISE EXCEPTION 'PER_LINE_CUSTOM_VECTOR_INCOMPLETE: %', v_line_key
            USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (
          SELECT entry->>'customer_id'
          FROM jsonb_array_elements(v_override->'vector') entry
          GROUP BY entry->>'customer_id'
          HAVING count(*) <> 1
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_override->'vector') entry
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_temp._plsb_customers c
            WHERE c.customer_id = (entry->>'customer_id')::uuid
          )
        ) OR EXISTS (
          SELECT 1 FROM pg_temp._plsb_customers c
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_override->'vector') entry
            WHERE (entry->>'customer_id')::uuid = c.customer_id
          )
        ) THEN
          RAISE EXCEPTION 'PER_LINE_CUSTOM_VECTOR_CUSTOMER_SET_MISMATCH: %', v_line_key
            USING ERRCODE = 'check_violation';
        END IF;

        UPDATE pg_temp._plsb_shares s
           SET split_mode = 'custom',
               split_micro_pct = (entry->>'split_micro_pct')::integer,
               split_override_reason = v_split_reason
          FROM jsonb_array_elements(v_override->'vector') entry
         WHERE s.line_key = v_line_key
           AND s.customer_id = (entry->>'customer_id')::uuid;
      END IF;
    END IF;

    IF v_override ? 'price_overrides' THEN
      IF jsonb_typeof(v_override->'price_overrides') <> 'array' THEN
        RAISE EXCEPTION 'PER_LINE_PRICE_OVERRIDES_MUST_BE_ARRAY: %', v_line_key
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF (SELECT line_kind FROM pg_temp._plsb_lines WHERE line_key = v_line_key) = 'flat_fee'
         AND jsonb_array_length(v_override->'price_overrides') > 0 THEN
        RAISE EXCEPTION 'PER_LINE_FLAT_FEE_PRICE_OVERRIDE_UNSUPPORTED: %', v_line_key
          USING ERRCODE = 'feature_not_supported';
      END IF;
      IF EXISTS (
        SELECT entry->>'customer_id'
        FROM jsonb_array_elements(v_override->'price_overrides') entry
        GROUP BY entry->>'customer_id'
        HAVING entry->>'customer_id' IS NULL OR count(*) > 1
      ) THEN
        RAISE EXCEPTION 'PER_LINE_DUPLICATE_PRICE_OVERRIDE: %', v_line_key
          USING ERRCODE = 'unique_violation';
      END IF;
    END IF;
  END LOOP;

  -- Resolve base prices. Precedence remains global manual -> quote -> customer tier;
  -- application service uses customer_application_rates -> service default.
  UPDATE pg_temp._plsb_shares s
     SET base_unit_price_cents = CASE
           WHEN COALESCE((l.source_input->>'manual_override')::boolean, false)
                AND l.source_input->>'unit_price_cents' IS NOT NULL
             THEN (l.source_input->>'unit_price_cents')::bigint
           WHEN quote_price.price_cents IS NOT NULL THEN quote_price.price_cents
           ELSE tier_price.price_cents
         END,
         base_price_source = CASE
           WHEN COALESCE((l.source_input->>'manual_override')::boolean, false)
                AND l.source_input->>'unit_price_cents' IS NOT NULL THEN 'global_manual'
           WHEN quote_price.price_cents IS NOT NULL THEN 'quote'
           ELSE 'tier'
         END
    FROM pg_temp._plsb_lines l
    JOIN pg_temp._plsb_customers c ON true
    LEFT JOIN LATERAL (
      SELECT round(qi.price_per_unit * 100)::bigint AS price_cents
      FROM public.quote_items qi
      JOIN public.quote_sections qs ON qs.id = qi.section_id
      WHERE qi.product_id = l.product_id
        AND qs.field_id IN (SELECT field_id FROM pg_temp._plsb_fields)
      ORDER BY qi.id
      LIMIT 1
    ) quote_price ON true
    LEFT JOIN LATERAL (
      SELECT CASE c.tier
        WHEN 1 THEN COALESCE(round(p.tier1_price * 100), 0)::bigint
        WHEN 2 THEN COALESCE(round(p.tier2_price * 100), round(p.tier1_price * 100), 0)::bigint
        WHEN 3 THEN COALESCE(round(p.tier3_price * 100), round(p.tier1_price * 100), 0)::bigint
        ELSE COALESCE(round(p.tier1_price * 100), 0)::bigint
      END AS price_cents
      FROM public.products p WHERE p.id = l.product_id
    ) tier_price ON true
   WHERE s.line_key = l.line_key
     AND c.customer_id = s.customer_id
     AND l.line_kind = 'chemical';

  UPDATE pg_temp._plsb_shares s
     SET base_unit_price_cents = COALESCE((
           SELECT car.rate_per_acre_cents
           FROM public.customer_application_rates car
           WHERE car.customer_id = s.customer_id
             AND car.application_service_id = l.application_service_id
             AND car.season = public.current_season()
           LIMIT 1
         ), svc.default_rate_per_acre_cents),
         base_price_source = CASE WHEN EXISTS (
           SELECT 1
           FROM public.customer_application_rates car
           WHERE car.customer_id = s.customer_id
             AND car.application_service_id = l.application_service_id
             AND car.season = public.current_season()
         ) THEN 'customer_application_rates' ELSE 'application_service_default' END
    FROM pg_temp._plsb_lines l
    JOIN public.application_services svc ON svc.id = l.application_service_id
   WHERE s.line_key = l.line_key AND l.line_kind = 'service';

  UPDATE pg_temp._plsb_shares s
     SET base_unit_price_cents = l.source_amount_cents,
         base_price_source = 'flat_fee'
    FROM pg_temp._plsb_lines l
   WHERE s.line_key = l.line_key AND l.line_kind = 'flat_fee';

  UPDATE pg_temp._plsb_shares
     SET base_unit_price_cents = COALESCE(base_unit_price_cents, 0),
         base_price_source = COALESCE(base_price_source, 'unpriced'),
         unit_price_cents = COALESCE(base_unit_price_cents, 0);

  FOR v_override IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_line_overrides->'lines', '[]'::jsonb))
  LOOP
    v_line_key := v_override->>'line_key';
    FOR v_price_override IN
      SELECT value FROM jsonb_array_elements(COALESCE(v_override->'price_overrides', '[]'::jsonb))
    LOOP
      IF v_price_override->>'customer_id' IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM pg_temp._plsb_customers
           WHERE customer_id = (v_price_override->>'customer_id')::uuid
         ) THEN
        RAISE EXCEPTION 'PER_LINE_PRICE_OVERRIDE_CUSTOMER_SET_MISMATCH: %', v_line_key
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_price_override->>'unit_price_cents' IS NULL
         OR (v_price_override->>'unit_price_cents')::bigint < 0
         OR NULLIF(btrim(v_price_override->>'reason'), '') IS NULL THEN
        RAISE EXCEPTION 'PER_LINE_PRICE_OVERRIDE_PRICE_AND_REASON_REQUIRED: %', v_line_key
          USING ERRCODE = 'check_violation';
      END IF;
      UPDATE pg_temp._plsb_shares
         SET price_mode = 'override',
             unit_price_cents = (v_price_override->>'unit_price_cents')::bigint,
             price_override_reason = btrim(v_price_override->>'reason')
       WHERE line_key = v_line_key
         AND customer_id = (v_price_override->>'customer_id')::uuid;
    END LOOP;
  END LOOP;

  -- Classify each line after effective per-person prices are known.
  UPDATE pg_temp._plsb_lines l
     SET price_basis = CASE
       WHEN l.line_kind = 'flat_fee' THEN 'flat_fee'
       WHEN (SELECT count(DISTINCT s.unit_price_cents)
             FROM pg_temp._plsb_shares s WHERE s.line_key = l.line_key) = 1
         THEN 'same_price'
       ELSE 'per_person_price'
     END;

  UPDATE pg_temp._plsb_lines l
     SET source_unit_price_cents = CASE WHEN l.price_basis = 'same_price'
       THEN (SELECT min(s.unit_price_cents) FROM pg_temp._plsb_shares s WHERE s.line_key = l.line_key)
       ELSE NULL END,
         source_amount_cents = CASE
           WHEN l.line_kind = 'flat_fee' THEN l.source_amount_cents
           WHEN l.price_basis <> 'same_price' THEN NULL
           ELSE round(
             (SELECT min(s.unit_price_cents) FROM pg_temp._plsb_shares s WHERE s.line_key = l.line_key)::numeric
             * l.source_pricing_quantity
           )::bigint
         END;

  -- Quantity pass at 0.0001 units.
  WITH ideals AS (
    SELECT s.line_key, s.customer_id,
           round(abs(l.source_quantity) * 10000)::bigint AS total_ticks,
           CASE WHEN l.source_quantity < 0 THEN -1 ELSE 1 END AS sign_value,
           (round(abs(l.source_quantity) * 10000)::numeric * s.split_micro_pct::numeric)
             / 100000000::numeric AS ideal
    FROM pg_temp._plsb_shares s
    JOIN pg_temp._plsb_lines l ON l.line_key = s.line_key
    WHERE l.source_quantity IS NOT NULL
  ), bases AS (
    SELECT line_key, customer_id, total_ticks, sign_value,
           floor(ideal)::bigint AS base, ideal - floor(ideal) AS frac
    FROM ideals
  ), ranked AS (
    SELECT line_key, customer_id, sign_value, base,
           row_number() OVER (PARTITION BY line_key ORDER BY frac DESC, customer_id ASC) AS rn,
           total_ticks - sum(base) OVER (PARTITION BY line_key) AS residual
    FROM bases
  )
  UPDATE pg_temp._plsb_shares s
     SET allocated_quantity = (
       r.sign_value * (r.base + CASE WHEN r.rn <= r.residual THEN 1 ELSE 0 END)
     )::numeric / 10000::numeric
    FROM ranked r
   WHERE r.line_key = s.line_key AND r.customer_id = s.customer_id;

  -- Acre pass at 0.0001 acres, using the identical ordering.
  WITH ideals AS (
    SELECT s.line_key, s.customer_id,
           round(abs(l.source_acres) * 10000)::bigint AS total_ticks,
           CASE WHEN l.source_acres < 0 THEN -1 ELSE 1 END AS sign_value,
           (round(abs(l.source_acres) * 10000)::numeric * s.split_micro_pct::numeric)
             / 100000000::numeric AS ideal
    FROM pg_temp._plsb_shares s
    JOIN pg_temp._plsb_lines l ON l.line_key = s.line_key
    WHERE l.source_acres IS NOT NULL
  ), bases AS (
    SELECT line_key, customer_id, total_ticks, sign_value,
           floor(ideal)::bigint AS base, ideal - floor(ideal) AS frac
    FROM ideals
  ), ranked AS (
    SELECT line_key, customer_id, sign_value, base,
           row_number() OVER (PARTITION BY line_key ORDER BY frac DESC, customer_id ASC) AS rn,
           total_ticks - sum(base) OVER (PARTITION BY line_key) AS residual
    FROM bases
  )
  UPDATE pg_temp._plsb_shares s
     SET allocated_acres = (
       r.sign_value * (r.base + CASE WHEN r.rn <= r.residual THEN 1 ELSE 0 END)
     )::numeric / 10000::numeric
    FROM ranked r
   WHERE r.line_key = s.line_key AND r.customer_id = s.customer_id;

  -- Same-price chemical/service and flat-fee cents pass: allocate the canonical
  -- signed source cents by largest remainder. Negative totals mirror positives.
  WITH ideals AS (
    SELECT s.line_key, s.customer_id,
           abs(l.source_amount_cents) AS total_cents,
           CASE WHEN l.source_amount_cents < 0 THEN -1 ELSE 1 END AS sign_value,
           (abs(l.source_amount_cents)::numeric * s.split_micro_pct::numeric)
             / 100000000::numeric AS ideal
    FROM pg_temp._plsb_shares s
    JOIN pg_temp._plsb_lines l ON l.line_key = s.line_key
    WHERE l.source_amount_cents IS NOT NULL
  ), bases AS (
    SELECT line_key, customer_id, total_cents, sign_value,
           floor(ideal)::bigint AS base, ideal - floor(ideal) AS frac
    FROM ideals
  ), ranked AS (
    SELECT line_key, customer_id, sign_value, base,
           row_number() OVER (PARTITION BY line_key ORDER BY frac DESC, customer_id ASC) AS rn,
           total_cents - sum(base) OVER (PARTITION BY line_key) AS residual
    FROM bases
  )
  UPDATE pg_temp._plsb_shares s
     SET amount_cents = r.sign_value * (
       r.base + CASE WHEN r.rn <= r.residual THEN 1 ELSE 0 END
     )
    FROM ranked r
   WHERE r.line_key = s.line_key AND r.customer_id = s.customer_id;

  -- Different per-person prices have no parent total. Each person's final money
  -- figure rounds once from their residual-adjusted stored quantity/acres.
  UPDATE pg_temp._plsb_shares s
     SET amount_cents = round(
       s.unit_price_cents::numeric
       * CASE WHEN l.line_kind = 'service' THEN s.allocated_acres ELSE s.allocated_quantity END
     )::bigint
    FROM pg_temp._plsb_lines l
   WHERE s.line_key = l.line_key AND l.price_basis = 'per_person_price';

  -- Hashes are server-computed from a canonical customer_id-ordered representation.
  WITH hash_inputs AS (
    SELECT
      l.line_key,
      encode(extensions.digest(
        string_agg(s.customer_id::text || ':' || s.split_micro_pct::text,
                   '|' ORDER BY s.customer_id), 'sha256'
      ), 'hex') AS vector_hash,
      encode(extensions.digest(
        l.line_key || '|' || l.line_kind || '|' || l.price_basis || '|'
        || COALESCE(l.source_pricing_quantity::text, '') || '|'
        || COALESCE(l.source_quantity::text, '') || '|'
        || COALESCE(l.source_acres::text, '') || '|'
        || COALESCE(l.source_unit_price_cents::text, '') || '|'
        || COALESCE(l.source_amount_cents::text, '') || '|'
        || string_agg(
             s.customer_id::text || ':' || s.split_micro_pct::text || ':'
             || COALESCE(s.allocated_quantity::text, '') || ':'
             || COALESCE(s.allocated_acres::text, '') || ':'
             || s.unit_price_cents::text || ':' || s.amount_cents::text,
             '|' ORDER BY s.customer_id
           ), 'sha256'
      ), 'hex') AS calculation_hash
    FROM pg_temp._plsb_lines l
    JOIN pg_temp._plsb_shares s ON s.line_key = l.line_key
    GROUP BY
      l.line_key,
      l.line_kind,
      l.price_basis,
      l.source_pricing_quantity,
      l.source_quantity,
      l.source_acres,
      l.source_unit_price_cents,
      l.source_amount_cents
  )
  UPDATE pg_temp._plsb_lines l
     SET vector_hash = hashes.vector_hash,
         calculation_hash = hashes.calculation_hash
    FROM hash_inputs hashes
   WHERE hashes.line_key = l.line_key;

  -- Output is the Phase 3 writer contract plus the current preview-compatible shape.
  SELECT jsonb_build_object(
    'rounding_policy_version', 1,
    'job_id', v_effective_job_id,
    'billing_lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_key', l.line_key,
        'line_kind', l.line_kind,
        'price_basis', l.price_basis,
        'product_id', l.product_id,
        'application_service_id', l.application_service_id,
        'description', l.description,
        'source_quantity', l.source_quantity,
        'source_acres', l.source_acres,
        'source_unit_price_cents', l.source_unit_price_cents,
        'source_amount_cents', l.source_amount_cents,
        'sort_order', l.sort_order,
        'source_input', l.source_input,
        'vector_hash', l.vector_hash,
        'calculation_hash', l.calculation_hash,
        'shares', (
          SELECT jsonb_agg(jsonb_build_object(
            'customer_id', s.customer_id,
            'split_mode', s.split_mode,
            'split_micro_pct', s.split_micro_pct,
            'allocated_quantity', s.allocated_quantity,
            'allocated_acres', s.allocated_acres,
            'base_unit_price_cents', s.base_unit_price_cents,
            'base_price_source', s.base_price_source,
            'price_mode', s.price_mode,
            'unit_price_cents', s.unit_price_cents,
            'amount_cents', s.amount_cents,
            'split_override_reason', s.split_override_reason,
            'price_override_reason', s.price_override_reason,
            'calculation_hash', l.calculation_hash,
            'vector_hash', l.vector_hash
          ) ORDER BY s.customer_id)
          FROM pg_temp._plsb_shares s WHERE s.line_key = l.line_key
        )
      ) ORDER BY l.sort_order, l.line_key)
      FROM pg_temp._plsb_lines l
    ), '[]'::jsonb),
    'per_customer', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_id', c.customer_id,
        'customer_name', c.customer_name,
        'is_primary', c.is_primary,
        'tier', c.tier,
        'total_cents', COALESCE((SELECT sum(s.amount_cents) FROM pg_temp._plsb_shares s WHERE s.customer_id = c.customer_id), 0),
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'line_key', l.line_key,
            'kind', CASE WHEN l.line_kind = 'service' THEN 'service_fee' ELSE l.line_kind END,
            'description', l.description,
            'quantity', CASE WHEN l.line_kind = 'service' THEN s.allocated_acres
                             WHEN l.line_kind = 'flat_fee' THEN 1
                             ELSE s.allocated_quantity END,
            'unit_price_cents', s.unit_price_cents,
            'extended_cents', s.amount_cents,
            'split_micro_pct', s.split_micro_pct,
            'base_price_source', s.base_price_source,
            'price_mode', s.price_mode,
            'calculation_hash', l.calculation_hash,
            'vector_hash', l.vector_hash
          ) ORDER BY l.sort_order, l.line_key)
          FROM pg_temp._plsb_lines l
          JOIN pg_temp._plsb_shares s ON s.line_key = l.line_key
          WHERE s.customer_id = c.customer_id
        ), '[]'::jsonb)
      ) ORDER BY c.customer_id)
      FROM pg_temp._plsb_customers c
    ), '[]'::jsonb),
    'grand_total_cents', COALESCE((SELECT sum(amount_cents) FROM pg_temp._plsb_shares), 0),
    'customer_count', v_customer_count,
    'calculation_hash', encode(extensions.digest(COALESCE((
      SELECT string_agg(calculation_hash, '|' ORDER BY sort_order, line_key)
      FROM pg_temp._plsb_lines
    ), ''), 'sha256'), 'hex'),
    'shares_detail', jsonb_build_object(
      'rows', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'field_id', v.field_id,
          'field_name', f.field_name,
          'customer_id', v.customer_id,
          'customer_name', v.customer_name,
          'is_primary', v.is_primary,
          'split_pct', v.split_micro_pct::numeric / 1000000::numeric,
          'share_acres', v.allocated_acres,
          'price_override_cents', NULL,
          'pricing_note', NULL,
          'tier', v.tier,
          'field_total_acres', f.total_acres,
          'field_applied_acres', f.applied_acres,
          'used_fallback', v.vector_source = 'field_owner_fallback',
          'vector_source', v.vector_source
        ) ORDER BY v.customer_id, v.field_id)
        FROM pg_temp._plsb_field_vectors v
        JOIN pg_temp._plsb_fields f ON f.field_id = v.field_id
      ), '[]'::jsonb),
      'customers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'customer_id', c.customer_id,
          'customer_name', c.customer_name,
          'is_primary', c.is_primary,
          'total_share_acres', COALESCE((SELECT sum(v.allocated_acres) FROM pg_temp._plsb_field_vectors v WHERE v.customer_id = c.customer_id), 0),
          'overall_split_pct', round(
            COALESCE((SELECT sum(v.allocated_acres) FROM pg_temp._plsb_field_vectors v WHERE v.customer_id = c.customer_id), 0)
            / (SELECT sum(applied_acres) FROM pg_temp._plsb_fields) * 100, 4
          ),
          'tier', c.tier,
          'has_override', false
        ) ORDER BY c.customer_id)
        FROM pg_temp._plsb_customers c
      ), '[]'::jsonb),
      'total_applied_acres', (SELECT sum(applied_acres) FROM pg_temp._plsb_fields),
      'field_count', v_field_count,
      'fallback_used_field_ids', COALESCE((
        SELECT jsonb_agg(DISTINCT field_id ORDER BY field_id)
        FROM pg_temp._plsb_field_vectors WHERE vector_source = 'field_owner_fallback'
      ), '[]'::jsonb)
    )
  ) INTO v_result;

  -- Assert the calculator's own output before it can reach preview or Phase 3.
  IF EXISTS (
    SELECT line_key FROM pg_temp._plsb_shares
    GROUP BY line_key HAVING sum(split_micro_pct) <> 100000000
  ) THEN
    RAISE EXCEPTION 'PER_LINE_INTERNAL_VECTOR_ASSERTION_FAILED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT l.line_key
    FROM pg_temp._plsb_lines l
    JOIN pg_temp._plsb_shares s ON s.line_key = l.line_key
    GROUP BY l.line_key, l.source_quantity
    HAVING l.source_quantity IS NOT NULL AND sum(s.allocated_quantity) <> l.source_quantity
  ) THEN
    RAISE EXCEPTION 'PER_LINE_INTERNAL_QUANTITY_ASSERTION_FAILED' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT l.line_key
    FROM pg_temp._plsb_lines l
    JOIN pg_temp._plsb_shares s ON s.line_key = l.line_key
    WHERE l.source_amount_cents IS NOT NULL
    GROUP BY l.line_key, l.source_amount_cents
    HAVING sum(s.amount_cents) <> l.source_amount_cents
  ) THEN
    RAISE EXCEPTION 'PER_LINE_INTERNAL_CENTS_ASSERTION_FAILED' USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_result;
END;
$calculator$;

REVOKE ALL ON FUNCTION public._calculate_per_line_split_billing_plan(uuid, jsonb, jsonb, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._calculate_per_line_split_billing_plan(uuid, jsonb, jsonb, uuid, uuid, jsonb)
  TO service_role;

COMMENT ON FUNCTION public._calculate_per_line_split_billing_plan(uuid, jsonb, jsonb, uuid, uuid, jsonb) IS
  'Private rounding-policy-v1 resolver/calculator for per-line field-app billing. Resolves job snapshot -> field default -> field owner, prices manual -> quote -> tier/service rate, expands complete vectors, and allocates signed 4dp quantities/acres and bigint cents by deterministic largest remainder. Phase 3 consumes this exact plan.';

-- Preserve the current preview implementation byte-for-byte behind a private name.
-- The feature-OFF branch calls it directly, so the baseline engine cannot drift here.
DO $rename_legacy$
BEGIN
  IF to_regprocedure('public._preview_field_app_invoice_split_legacy_20260718(jsonb,jsonb,uuid,uuid)') IS NULL THEN
    IF to_regprocedure('public.preview_field_app_invoice_split(jsonb,jsonb,uuid,uuid)') IS NULL THEN
      RAISE EXCEPTION 'Expected one four-argument preview_field_app_invoice_split before Phase 2';
    END IF;
    ALTER FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid)
      RENAME TO _preview_field_app_invoice_split_legacy_20260718;
  END IF;
END;
$rename_legacy$;

REVOKE ALL ON FUNCTION public._preview_field_app_invoice_split_legacy_20260718(jsonb, jsonb, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._preview_field_app_invoice_split_legacy_20260718(jsonb, jsonb, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.preview_field_app_invoice_split(
  p_locations jsonb,
  p_chemicals jsonb,
  p_application_service_id uuid DEFAULT NULL::uuid,
  p_invoice_id uuid DEFAULT NULL::uuid,
  p_job_id uuid DEFAULT NULL::uuid,
  p_line_overrides jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $preview$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT COALESCE(bool_or(setting_value = 'true'), false)
    INTO v_enabled
    FROM public.app_settings
   WHERE setting_key = 'feature_per_line_split_billing';

  IF NOT v_enabled THEN
    RETURN public._preview_field_app_invoice_split_legacy_20260718(
      p_locations, p_chemicals, p_application_service_id, p_invoice_id
    );
  END IF;

  RETURN public._calculate_per_line_split_billing_plan(
    p_job_id,
    p_locations,
    p_chemicals,
    p_application_service_id,
    p_invoice_id,
    p_line_overrides
  );
END;
$preview$;

REVOKE ALL ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, uuid, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, uuid, jsonb) IS
  'Feature-gated field-app billing preview. OFF delegates unchanged to the legacy preview; ON calls the one private per-line calculator that Phase 3 save will consume.';

-- PostgREST cannot safely choose between overloads. Pin exactly one public preview
-- and exactly one private calculator signature.
DO $overload_guard$
DECLARE
  v_preview_count integer;
  v_calculator_count integer;
BEGIN
  SELECT count(*) INTO v_preview_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';
  SELECT count(*) INTO v_calculator_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_calculate_per_line_split_billing_plan';

  IF v_preview_count <> 1 OR v_calculator_count <> 1 THEN
    RAISE EXCEPTION 'Phase 2 overload guard failed: preview %, calculator %',
      v_preview_count, v_calculator_count;
  END IF;
END;
$overload_guard$;

COMMIT;
