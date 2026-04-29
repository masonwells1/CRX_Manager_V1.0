-- =============================================================================
-- Migration: 20260429140635_field_app_workflow_phase1.sql
-- Phase 1 of the Field Application Workflow rewrite.
--
-- See: docs/audits/2026-04-28-phase1-final-plan.md (and v2 in chat)
--
-- Bundles fixes for codex audit items: #1, #2, #3, #9, #11, #13, M1, M2, M3.
--
-- Scope:
--   1. Schema:    field_app_locations.invoice_group_id, invoices.application_service_id
--   2. Helper:    derive_customer_shares_from_fields  (per-field detail + fallback)
--   3. Rewrite:   save_field_app_invoice              (grouped split + Mode A/B + locks)
--   4. Rewrite:   create_invoice_from_blend_ticket    (grouped split + acres fallback)
--   5. New:       post_invoice_group                  (atomic group post)
--   6. New:       preview_field_app_invoice_split     (read-only preview)
--   7. Verification: exactly-one-overload check on all 5 named functions
--
-- Pricing modes:
--   Mode A (grower-share):  field_billing_defaults.price_override_cents IS NOT NULL
--                           -> ONE $/ac line + chemical $0 informational lines, NO service fee
--   Mode B (line-item):     standard tier/quoted/manual pricing per chemical + service fee
--
-- Keys:
--   - AR remains keyed by invoices.customer_id (canonical: get_customer_summary)
--   - invoice_shares populated for PDF/statement compat (one 100% row per child invoice)
--   - field_app_location_shares carries TRUE per-customer split for audit
--
-- Pre-flight (run BEFORE applying this migration; expect exactly 1 overload each):
--   SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('derive_customer_shares_from_fields',
--                     'save_field_app_invoice',
--                     'create_invoice_from_blend_ticket',
--                     'post_invoice_group',
--                     'preview_field_app_invoice_split');
-- =============================================================================


-- =============================================================================
-- 1. SCHEMA ADDITIONS
-- =============================================================================

ALTER TABLE field_app_locations
  ADD COLUMN IF NOT EXISTS invoice_group_id uuid;

CREATE INDEX IF NOT EXISTS idx_field_app_locations_group
  ON field_app_locations(invoice_group_id) WHERE invoice_group_id IS NOT NULL;

ALTER TABLE field_app_locations DROP CONSTRAINT IF EXISTS fal_requires_parent;
ALTER TABLE field_app_locations
  ADD CONSTRAINT fal_requires_parent CHECK (
    invoice_id IS NOT NULL OR job_id IS NOT NULL OR invoice_group_id IS NOT NULL
  );

COMMENT ON COLUMN field_app_locations.invoice_group_id
  IS 'For multi-customer field app invoices, locations live at the group level. invoice_id stays NULL in that case. Single-customer invoices keep invoice_id.';


ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS application_service_id uuid REFERENCES application_services(id);

CREATE INDEX IF NOT EXISTS idx_invoices_app_service
  ON invoices(application_service_id) WHERE application_service_id IS NOT NULL;

COMMENT ON COLUMN invoices.application_service_id
  IS 'Application service (Hagie Y-Drop, airplane, etc.) used for this field application. Drives per-acre fee calculation. NULL when no service fee applies.';


-- =============================================================================
-- 2. HELPER: derive_customer_shares_from_fields
-- Returns per-field per-customer detail. Falls back to fields.customer_id at
-- 100% when a field has no field_billing_defaults rows.
-- =============================================================================

DROP FUNCTION IF EXISTS public.derive_customer_shares_from_fields(uuid[], jsonb);

CREATE OR REPLACE FUNCTION derive_customer_shares_from_fields(
  p_field_ids         uuid[],
  p_applied_acres_map jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH field_data AS (
    SELECT
      f.id           AS field_id,
      f.field_name,
      f.customer_id  AS field_owner_id,
      f.total_acres,
      f.crop_type,
      COALESCE(
        (p_applied_acres_map ->> f.id::text)::numeric,
        f.total_acres
      ) AS applied_acres
    FROM fields f
    WHERE f.id = ANY(p_field_ids)
  ),
  billing_split AS (
    SELECT
      fd.field_id, fd.field_name, fd.applied_acres, fd.total_acres,
      fbd.customer_id, c.farm_name AS customer_name, c.assigned_tier AS tier,
      fbd.split_pct, fbd.is_primary,
      fbd.price_override_cents, fbd.pricing_note,
      false AS used_fallback
    FROM field_data fd
    JOIN field_billing_defaults fbd ON fbd.field_id = fd.field_id
    JOIN customers c               ON c.id        = fbd.customer_id
  ),
  billing_fallback AS (
    SELECT
      fd.field_id, fd.field_name, fd.applied_acres, fd.total_acres,
      fd.field_owner_id AS customer_id, c.farm_name AS customer_name, c.assigned_tier AS tier,
      100.0 AS split_pct, true AS is_primary,
      NULL::bigint AS price_override_cents, NULL::text AS pricing_note,
      true AS used_fallback
    FROM field_data fd
    JOIN customers c ON c.id = fd.field_owner_id
    WHERE NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = fd.field_id)
  ),
  combined AS (
    SELECT * FROM billing_split UNION ALL SELECT * FROM billing_fallback
  ),
  agg AS (
    SELECT
      cb.customer_id, cb.customer_name,
      bool_or(cb.is_primary) AS is_primary,
      ROUND(SUM(cb.applied_acres * cb.split_pct / 100.0), 2) AS total_share_acres,
      CASE WHEN SUM(SUM(cb.applied_acres * cb.split_pct / 100.0)) OVER () > 0
        THEN ROUND(SUM(cb.applied_acres * cb.split_pct / 100.0)
                   / SUM(SUM(cb.applied_acres * cb.split_pct / 100.0)) OVER () * 100, 4)
        ELSE 0
      END AS overall_split_pct,
      MAX(cb.tier) AS tier,
      bool_or(cb.price_override_cents IS NOT NULL) AS has_override
    FROM combined cb
    GROUP BY cb.customer_id, cb.customer_name
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(
      jsonb_build_object(
        'field_id', cb.field_id, 'field_name', cb.field_name,
        'customer_id', cb.customer_id, 'customer_name', cb.customer_name,
        'is_primary', cb.is_primary, 'split_pct', cb.split_pct,
        'share_acres', ROUND(cb.applied_acres * cb.split_pct / 100.0, 2),
        'price_override_cents', cb.price_override_cents,
        'pricing_note', cb.pricing_note,
        'tier', cb.tier,
        'field_total_acres', cb.total_acres,
        'field_applied_acres', cb.applied_acres,
        'used_fallback', cb.used_fallback
      ) ORDER BY cb.is_primary DESC, cb.customer_name, cb.field_name
    ) FILTER (WHERE cb.field_id IS NOT NULL), '[]'::jsonb),
    'customers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_id', a.customer_id, 'customer_name', a.customer_name,
        'is_primary', a.is_primary,
        'total_share_acres', a.total_share_acres,
        'overall_split_pct', a.overall_split_pct,
        'tier', a.tier, 'has_override', a.has_override
      ) ORDER BY a.is_primary DESC, a.total_share_acres DESC) FROM agg a
    ), '[]'::jsonb),
    'total_applied_acres', (SELECT COALESCE(SUM(fd.applied_acres), 0) FROM field_data fd),
    'field_count', array_length(p_field_ids, 1),
    'fallback_used_field_ids', COALESCE((
      SELECT jsonb_agg(DISTINCT bf.field_id) FROM billing_fallback bf
    ), '[]'::jsonb)
  ) INTO v_result
  FROM combined cb;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION derive_customer_shares_from_fields(uuid[], jsonb) TO authenticated;


-- =============================================================================
-- 3. REWRITE: save_field_app_invoice
-- Creates one invoice per customer (grouped via invoice_group_id when 2+),
-- branches per customer to Mode A (grower-share) or Mode B (line items),
-- enforces posted-invoice edit lock across the whole group.
--
-- Returns: { invoice_ids: [uuid,...], invoice_group_id: uuid|null }
-- =============================================================================

DROP FUNCTION IF EXISTS public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION save_field_app_invoice(
  p_invoice_id             uuid,
  p_invoice                jsonb,
  p_locations              jsonb,
  p_chemicals              jsonb,
  p_performed_by           uuid,
  p_application_service_id uuid DEFAULT NULL,
  p_idempotency_key        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing            jsonb;
  v_existing_group_id   uuid;
  v_existing_status     text;
  v_locked_count        int;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_total_applied_acres numeric := 0;
  v_loc                 jsonb;
  v_chem                jsonb;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_fee_rate            bigint;
  v_loc_id              uuid;
  v_share_row           jsonb;
  v_share_pct           numeric;
  v_share_acres         numeric;
  v_field_id            uuid;
  v_field_applied_acres numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
BEGIN
  -- ── 0. Idempotency cache replay ─────────────────────────────────────────
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- ── 1. Posted-status guard (covers WHOLE GROUP if editing) ──────────────
  IF p_invoice_id IS NOT NULL THEN
    SELECT status, invoice_group_id INTO v_existing_status, v_existing_group_id
      FROM invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
    END IF;
    SELECT COUNT(*) INTO v_locked_count
      FROM invoices
     WHERE (id = p_invoice_id OR invoice_group_id = v_existing_group_id)
       AND v_existing_group_id IS NOT NULL
       AND status NOT IN ('draft', 'unposted');
    IF v_locked_count > 0 OR v_existing_status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot edit field app invoice — % invoice(s) in this group are posted/voided. Use void/reissue.', GREATEST(v_locked_count, 1);
    END IF;

    -- Wipe-and-rebuild approach for edits
    IF v_existing_group_id IS NOT NULL THEN
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_group_id = v_existing_group_id
      );
      DELETE FROM field_app_locations WHERE invoice_group_id = v_existing_group_id;
      DELETE FROM invoice_items   WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id);
      DELETE FROM invoice_shares  WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id);
    ELSE
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_id = p_invoice_id
      );
      DELETE FROM field_app_locations WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
    END IF;
  END IF;

  -- ── 2. Build field_ids array and applied_acres map from p_locations ────
  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_total_applied_acres := v_total_applied_acres + COALESCE((v_loc->>'applied_acres')::numeric, (v_loc->>'total_acres')::numeric, 0);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id',
      COALESCE((v_loc->>'applied_acres')::numeric, (v_loc->>'total_acres')::numeric, 0)
    );
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one field is required';
  END IF;

  -- ── 3. Derive per-field per-customer shares ─────────────────────────────
  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from selected fields';
  END IF;

  -- ── 4. Application service lookup (one fee config for the whole invoice) ──
  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  -- ── 5. Group ID: only when 2+ customers ────────────────────────────────
  IF v_customer_count > 1 THEN
    v_invoice_group_id := COALESCE(v_existing_group_id, gen_random_uuid());
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  -- ── 6. PER-CUSTOMER LOOP ────────────────────────────────────────────────
  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;

    -- 6a. Find or create the child invoice for this customer
    v_invoice_id := NULL;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM invoices
       WHERE invoice_group_id = v_existing_group_id AND customer_id = v_customer_id LIMIT 1;
    ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
      v_invoice_id := p_invoice_id;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_invoice_number := next_invoice_number();
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id,
        season
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
        (p_invoice->>'salesman_id')::uuid,
        p_invoice->>'header_notes',
        p_performed_by,
        0, 0,
        v_invoice_group_id,
        p_application_service_id,
        current_season()
      ) RETURNING id INTO v_invoice_id;
    ELSE
      UPDATE invoices SET
        invoice_date            = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id             = COALESCE((p_invoice->>'salesman_id')::uuid, salesman_id),
        header_notes            = COALESCE(p_invoice->>'header_notes', header_notes),
        application_service_id  = p_application_service_id,
        invoice_group_id        = v_invoice_group_id,
        total_amount_cents      = 0,
        total_cost_cents        = 0,
        updated_at              = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    -- 6b. MODE A: per-field grower-share lines (only fields where THIS customer has override)
    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_field_id            := (v_share_row->>'field_id')::uuid;
      v_field_applied_acres := (v_share_row->>'field_applied_acres')::numeric;
      v_share_pct           := (v_share_row->>'split_pct')::numeric;
      v_share_acres         := (v_share_row->>'share_acres')::numeric;
      v_field_override      := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note  := v_share_row->>'pricing_note';

      v_grower_share_amount := ROUND(v_field_override * v_share_acres)::bigint;

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );

      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    -- 6c. Chemical lines: Mode A ($0 informational) and Mode B (priced)
    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      DECLARE
        v_chem_qty_a   numeric := 0;
        v_chem_qty_b   numeric := 0;
        v_rate         numeric;
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

        FOR v_share_row IN
          SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
          WHERE (value ->> 'customer_id')::uuid = v_customer_id
        LOOP
          v_share_acres := (v_share_row->>'share_acres')::numeric;
          IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
            v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
          ELSE
            v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
          END IF;
        END LOOP;

        IF v_chem_qty_a > 0 THEN
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            is_application_fee, price_source
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            (v_chem->>'description') || ' — included in grower share',
            ROUND(v_chem_qty_a, 4),
            v_chem->>'unit_size',
            0, 0, 0,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            false,
            'manual'
          );
        END IF;

        IF v_chem_qty_b > 0 THEN
          v_unit_price   := NULL;
          v_quoted_price := NULL;
          v_price_source := NULL;

          IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
             AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
            v_unit_price   := (v_chem->>'unit_price_cents')::bigint;
            v_price_source := 'manual';
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT qi.price_per_unit INTO v_qi_price
              FROM quote_items qi
              JOIN quote_sections qs ON qs.id = qi.section_id
             WHERE qi.product_id = (v_chem->>'product_id')::uuid
               AND qs.field_id   = ANY(v_field_ids)
             ORDER BY qi.id LIMIT 1;
            IF v_qi_price IS NOT NULL THEN
              v_unit_price   := ROUND(v_qi_price * 100)::bigint;
              v_quoted_price := v_unit_price;
              v_price_source := 'quoted';
            END IF;
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
            END INTO v_unit_price
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
            v_price_source := 'tier';
          END IF;

          v_unit_price := COALESCE(v_unit_price, 0);
          v_unit_cost  := COALESCE((v_chem->>'cost_cents')::bigint, 0);
          v_extended   := ROUND(v_unit_price * v_chem_qty_b)::bigint;

          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            quoted_price_cents, is_application_fee, price_source
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            v_chem->>'description',
            ROUND(v_chem_qty_b, 4),
            v_chem->>'unit_size',
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source
          );

          v_invoice_total := v_invoice_total + v_extended;
          v_invoice_cost  := v_invoice_cost + ROUND(v_unit_cost * v_chem_qty_b)::bigint;
        END IF;
      END;
    END LOOP;

    -- 6d. Application service fee (Mode B only)
    IF p_application_service_id IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season                 = current_season()
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
        INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := ROUND(v_fee_rate * v_fee_acres)::bigint;
        v_fee_cost     := ROUND(v_app_service.cost_per_acre_cents * v_fee_acres)::bigint;
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    -- 6e. invoice totals + invoice_shares (PDF/statement compat)
    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost,
      updated_at         = now()
    WHERE id = v_invoice_id;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'price_override_cents')::bigint
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'pricing_note')
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END
    );
  END LOOP;

  -- ── 7. Insert ONE set of field_app_locations keyed by group OR invoice ──
  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO field_app_locations (
      invoice_id, invoice_group_id,
      field_id, map_number, total_acres, planted_acres,
      applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      CASE WHEN v_invoice_group_id IS NULL THEN v_invoice_ids[1] ELSE NULL END,
      v_invoice_group_id,
      (v_loc->>'field_id')::uuid,
      (v_loc->>'map_number')::int,
      (v_loc->>'total_acres')::numeric,
      (v_loc->>'planted_acres')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type',
      v_loc->>'wind_direction',
      COALESCE((v_loc->>'sort_order')::int, 0)
    ) RETURNING id INTO v_loc_id;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'field_id')::uuid = (v_loc->>'field_id')::uuid
    LOOP
      INSERT INTO field_app_location_shares (
        location_id, customer_id, split_pct, acres, amount_cents
      ) VALUES (
        v_loc_id,
        (v_share_row->>'customer_id')::uuid,
        (v_share_row->>'split_pct')::numeric,
        (v_share_row->>'share_acres')::numeric,
        0
      );
    END LOOP;
  END LOOP;

  -- ── 8. Activity feed + idempotency cache ────────────────────────────────
  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN p_invoice_id IS NULL THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    'Field app invoice ' ||
      CASE WHEN v_invoice_group_id IS NOT NULL
           THEN '(group of ' || v_customer_count || ') '
           ELSE '' END ||
      'saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_app_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) TO authenticated;


-- =============================================================================
-- 4. REWRITE: create_invoice_from_blend_ticket
-- Same grouped-split + Mode A/B logic. Acres from blend_ticket_fields with
-- actual_acres → planned_acres → fields.total_acres → 0 fallback chain.
-- Return type changes from uuid → jsonb to match save_field_app_invoice.
-- =============================================================================

DROP FUNCTION IF EXISTS public.create_invoice_from_blend_ticket(uuid, uuid, text);

CREATE OR REPLACE FUNCTION create_invoice_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_created_by      uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing            jsonb;
  v_ticket              record;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_btf                 record;
  v_field_acres         numeric;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_fee_rate            bigint;
  v_btp                 record;
  v_share_row           jsonb;
  v_share_acres         numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_quote_section_id    uuid;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_chem_qty_a          numeric;
  v_chem_qty_b          numeric;
  v_rate                numeric;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved (status: %)', v_ticket.review_status;
  END IF;
  IF v_ticket.payment_status = 'billed' THEN
    RAISE EXCEPTION 'Blend ticket already billed';
  END IF;

  FOR v_btf IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS field_acres
      FROM blend_ticket_fields btf
      JOIN fields f ON f.id = btf.field_id
     WHERE btf.blend_ticket_id = p_blend_ticket_id
  LOOP
    v_field_ids := array_append(v_field_ids, v_btf.field_id);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_btf.field_id::text, v_btf.field_acres);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    IF v_ticket.field_id IS NOT NULL THEN
      v_field_ids := ARRAY[v_ticket.field_id];
      SELECT COALESCE(v_ticket.total_acres, f.total_acres, 0) INTO v_field_acres
        FROM fields f WHERE f.id = v_ticket.field_id;
      v_applied_acres_map := jsonb_build_object(v_ticket.field_id::text, v_field_acres);
    ELSE
      RAISE EXCEPTION 'Blend ticket has no fields';
    END IF;
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from blend ticket fields';
  END IF;

  IF v_ticket.application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = v_ticket.application_service_id;
  END IF;

  v_quote_section_id := NULL;
  IF v_ticket.job_id IS NOT NULL THEN
    SELECT j.quote_section_id INTO v_quote_section_id FROM jobs j WHERE j.id = v_ticket.job_id;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := gen_random_uuid();
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_number := next_invoice_number();

    INSERT INTO invoices (
      blend_ticket_id, customer_id, invoice_type, status, season,
      invoice_number, salesman_id, created_by,
      total_amount_cents, total_cost_cents,
      invoice_date, invoice_group_id, application_service_id
    ) VALUES (
      p_blend_ticket_id, v_customer_id, 'field_application', 'draft',
      COALESCE(v_ticket.season, current_season()),
      v_invoice_number, v_ticket.salesman_id, p_created_by,
      0, 0,
      CURRENT_DATE, v_invoice_group_id, v_ticket.application_service_id
    ) RETURNING id INTO v_invoice_id;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    -- Mode A: grower-share lines
    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres        := (v_share_row->>'share_acres')::numeric;
      v_field_override     := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note := v_share_row->>'pricing_note';
      v_grower_share_amount := ROUND(v_field_override * v_share_acres)::bigint;

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );
      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    -- Chemical lines
    FOR v_btp IN
      SELECT btp.*, p.tier1_price, p.tier2_price, p.tier3_price,
             p.product_name AS full_product_name, p.unit_cost AS product_cost
        FROM blend_ticket_products btp
        LEFT JOIN products p ON p.id = btp.product_id
       WHERE btp.blend_ticket_id = p_blend_ticket_id
       ORDER BY btp.sequence_order
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE(v_btp.rate_per_acre, 0);

      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value ->> 'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      IF v_chem_qty_a > 0 THEN
        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name) || ' — included in grower share',
          ROUND(v_chem_qty_a, 4), v_btp.unit_size,
          0, 0, 0,
          v_btp.sequence_order, v_rate, v_btp.rate_unit,
          false, 'manual'
        );
      END IF;

      IF v_chem_qty_b > 0 THEN
        v_unit_price   := NULL;
        v_quoted_price := NULL;
        v_price_source := NULL;

        IF v_btp.unit_price_cents IS NOT NULL THEN
          v_unit_price   := v_btp.unit_price_cents;
          v_price_source := 'manual';
        ELSIF v_quote_section_id IS NOT NULL AND v_btp.product_id IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
           WHERE qi.section_id = v_quote_section_id
             AND qi.product_id = v_btp.product_id
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN
            v_unit_price   := ROUND(v_qi_price * 100)::bigint;
            v_quoted_price := v_unit_price;
            v_price_source := 'quoted';
          END IF;
        END IF;

        IF v_unit_price IS NULL THEN
          IF v_btp.product_id IS NOT NULL THEN
            v_unit_price := CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(v_btp.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(v_btp.tier2_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(v_btp.tier3_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(v_btp.tier1_price * 100), 0)
            END;
          ELSE
            v_unit_price := 0;
          END IF;
          IF v_price_source IS NULL THEN v_price_source := 'tier'; END IF;
        END IF;

        v_unit_cost := COALESCE(v_btp.unit_cost_cents,
                                ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint, 0);
        v_extended := ROUND(v_unit_price * v_chem_qty_b)::bigint;

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          quoted_price_cents, is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name),
          ROUND(v_chem_qty_b, 4), v_btp.unit_size,
          v_unit_price, v_extended, v_unit_cost,
          v_btp.sequence_order, v_rate, v_btp.rate_unit,
          v_quoted_price, false, v_price_source
        );
        v_invoice_total := v_invoice_total + v_extended;
        v_invoice_cost  := v_invoice_cost + ROUND(v_unit_cost * v_chem_qty_b)::bigint;
      END IF;
    END LOOP;

    -- Application service fee (Mode B only)
    IF v_ticket.application_service_id IS NOT NULL AND v_app_service IS NOT NULL AND v_app_service.is_active THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = v_ticket.application_service_id
         AND car.season                 = COALESCE(v_ticket.season, current_season())
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := ROUND(v_fee_rate * v_fee_acres)::bigint;
        v_fee_cost     := ROUND(v_app_service.cost_per_acre_cents * v_fee_acres)::bigint;
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost
    WHERE id = v_invoice_id;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'price_override_cents')::bigint
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'pricing_note')
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END
    );
  END LOOP;

  UPDATE blend_tickets SET payment_status = 'billed' WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
          'Invoice(s) created from blend ticket ' || v_ticket.ticket_number ||
            CASE WHEN v_invoice_group_id IS NOT NULL
                 THEN ' (group of ' || v_customer_count || ')' ELSE '' END,
          p_created_by, 'invoice', v_invoice_ids[1], v_ticket.customer_id);

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_invoice_from_blend_ticket', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION create_invoice_from_blend_ticket(uuid, uuid, text) TO authenticated;


-- =============================================================================
-- 5. NEW: post_invoice_group
-- Atomically posts every invoice in a group. Period-checks each, validates
-- each is in draft/unposted, then loops post_invoice. Any failure rolls back
-- the entire transaction (PostgreSQL gives us this by default).
-- =============================================================================

CREATE OR REPLACE FUNCTION post_invoice_group(
  p_invoice_group_id uuid,
  p_performed_by     uuid,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing       jsonb;
  v_inv            record;
  v_posted_ids     uuid[] := '{}';
  v_total_cents    bigint := 0;
  v_member_count   int := 0;
  v_result         jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_group_id IS NULL THEN
    RAISE EXCEPTION 'invoice_group_id is required';
  END IF;

  PERFORM 1 FROM invoices WHERE invoice_group_id = p_invoice_group_id FOR UPDATE;

  SELECT COUNT(*) INTO v_member_count FROM invoices WHERE invoice_group_id = p_invoice_group_id;
  IF v_member_count = 0 THEN
    RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id;
  END IF;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id
  LOOP
    IF v_inv.status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot post group — invoice % has status %', v_inv.invoice_number, v_inv.status;
    END IF;
    PERFORM check_period_open(v_inv.invoice_date);
  END LOOP;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id ORDER BY invoice_number
  LOOP
    PERFORM post_invoice(v_inv.id, NULL);
    v_posted_ids := array_append(v_posted_ids, v_inv.id);
    v_total_cents := v_total_cents + v_inv.total_amount_cents;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('invoice_group_posted',
          'Posted ' || v_member_count || ' invoice(s) in group — total $' ||
            (v_total_cents / 100.0)::numeric(12,2),
          p_performed_by, 'invoice', v_posted_ids[1]);

  v_result := jsonb_build_object(
    'posted_invoice_ids', to_jsonb(v_posted_ids),
    'invoice_group_id',   p_invoice_group_id,
    'total_posted_cents', v_total_cents,
    'member_count',       v_member_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'post_invoice_group', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION post_invoice_group(uuid, uuid, text) TO authenticated;


-- =============================================================================
-- 6. NEW: preview_field_app_invoice_split
-- Read-only preview that returns the same per-customer breakdown as save_*
-- without writing anything.
-- =============================================================================

CREATE OR REPLACE FUNCTION preview_field_app_invoice_split(
  p_locations              jsonb,
  p_chemicals              jsonb,
  p_application_service_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_field_ids         uuid[];
  v_applied_acres_map jsonb := '{}'::jsonb;
  v_loc               jsonb;
  v_shares            jsonb;
  v_customers         jsonb;
  v_customer          jsonb;
  v_customer_id       uuid;
  v_customer_tier     int;
  v_app_service       record;
  v_per_customer      jsonb := '[]'::jsonb;
  v_customer_lines    jsonb;
  v_grand_total       bigint := 0;
  v_chem              jsonb;
  v_share_row         jsonb;
  v_chem_qty_a        numeric;
  v_chem_qty_b        numeric;
  v_share_acres       numeric;
  v_field_override    bigint;
  v_unit_price        bigint;
  v_qi_price          numeric;
  v_extended          bigint;
  v_fee_rate          bigint;
  v_fee_acres         numeric;
  v_fee_extended      bigint;
  v_customer_total    bigint;
  v_rate              numeric;
BEGIN
  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id',
      COALESCE((v_loc->>'applied_acres')::numeric, (v_loc->>'total_acres')::numeric, 0)
    );
  END LOOP;

  IF v_field_ids IS NULL THEN
    RETURN jsonb_build_object('per_customer', '[]'::jsonb, 'grand_total_cents', 0, 'customer_count', 0);
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id    := (v_customer->>'customer_id')::uuid;
    v_customer_tier  := COALESCE((v_customer->>'tier')::int, 1);
    v_customer_total := 0;
    v_customer_lines := '[]'::jsonb;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'customer_id')::uuid = v_customer_id
        AND (value->>'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres    := (v_share_row->>'share_acres')::numeric;
      v_field_override := (v_share_row->>'price_override_cents')::bigint;
      v_extended := ROUND(v_field_override * v_share_acres)::bigint;
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'grower_share',
        'description', (v_share_row->>'field_name') || ' grower share @ $' ||
                       (v_field_override / 100.0)::numeric(12,2) || '/ac',
        'quantity', v_share_acres,
        'unit_price_cents', v_field_override,
        'extended_cents', v_extended
      );
      v_customer_total := v_customer_total + v_extended;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);
      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value->>'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      IF v_chem_qty_b > 0 THEN
        v_unit_price := NULL;
        IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
           AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
          v_unit_price := (v_chem->>'unit_price_cents')::bigint;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
            JOIN quote_sections qs ON qs.id = qi.section_id
           WHERE qi.product_id = (v_chem->>'product_id')::uuid
             AND qs.field_id   = ANY(v_field_ids)
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN v_unit_price := ROUND(v_qi_price * 100)::bigint; END IF;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT CASE v_customer_tier
            WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
            WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
            WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
            ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
          END INTO v_unit_price FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_unit_price := COALESCE(v_unit_price, 0);
        v_extended := ROUND(v_unit_price * v_chem_qty_b)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'chemical', 'description', v_chem->>'description',
          'quantity', ROUND(v_chem_qty_b, 4),
          'unit_price_cents', v_unit_price, 'extended_cents', v_extended
        );
        v_customer_total := v_customer_total + v_extended;
      END IF;
    END LOOP;

    IF p_application_service_id IS NOT NULL AND v_app_service IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season = current_season() LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;
      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;
      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := ROUND(v_fee_rate * v_fee_acres)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'service_fee', 'description', v_app_service.name,
          'quantity', v_fee_acres, 'unit_price_cents', v_fee_rate,
          'extended_cents', v_fee_extended
        );
        v_customer_total := v_customer_total + v_fee_extended;
      END IF;
    END IF;

    v_per_customer := v_per_customer || jsonb_build_object(
      'customer_id',   v_customer_id,
      'customer_name', v_customer->>'customer_name',
      'is_primary',    COALESCE((v_customer->>'is_primary')::boolean, false),
      'tier',          v_customer_tier,
      'total_cents',   v_customer_total,
      'lines',         v_customer_lines
    );
    v_grand_total := v_grand_total + v_customer_total;
  END LOOP;

  RETURN jsonb_build_object(
    'per_customer',      v_per_customer,
    'grand_total_cents', v_grand_total,
    'customer_count',    jsonb_array_length(v_customers),
    'shares_detail',     v_shares
  );
END;
$$;

GRANT EXECUTE ON FUNCTION preview_field_app_invoice_split(jsonb, jsonb, uuid) TO authenticated;


-- =============================================================================
-- 7. VERIFICATION: every function in scope has exactly ONE overload
-- (per CLAUDE.md migration safety rules)
-- =============================================================================

DO $$
DECLARE
  func_name      text;
  overload_count int;
  func_names     text[] := ARRAY[
    'derive_customer_shares_from_fields',
    'save_field_app_invoice',
    'create_invoice_from_blend_ticket',
    'post_invoice_group',
    'preview_field_app_invoice_split'
  ];
BEGIN
  FOREACH func_name IN ARRAY func_names LOOP
    SELECT count(*) INTO overload_count
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = 'public' AND p.proname = func_name;
    IF overload_count != 1 THEN
      RAISE EXCEPTION 'VERIFICATION FAILED: % has % overloads (expected 1)',
        func_name, overload_count;
    END IF;
  END LOOP;
  RAISE NOTICE 'All Phase 1 functions verified: 1 overload each';
END $$;
