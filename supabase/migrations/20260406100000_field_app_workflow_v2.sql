-- Field Application Workflow V2: multi-customer jobs, auto-figuring invoices
-- Tables: field_app_locations, field_app_location_shares
-- RPCs: derive_customer_shares_from_fields, save_field_app_invoice

-- 1. Allow jobs without a single customer (multi-customer field apps)
ALTER TABLE jobs ALTER COLUMN customer_id DROP NOT NULL;

-- 2. Field App Locations — links a field to either an invoice or a job
CREATE TABLE field_app_locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid REFERENCES invoices(id) ON DELETE CASCADE,
  job_id          uuid REFERENCES jobs(id) ON DELETE CASCADE,
  field_id        uuid NOT NULL REFERENCES fields(id),
  map_number      integer,
  total_acres     numeric(12,2),
  planted_acres   numeric(12,2),
  applied_acres   numeric(12,2),
  crop_type       text,
  wind_direction  text,
  sort_order      integer DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fal_requires_parent CHECK (invoice_id IS NOT NULL OR job_id IS NOT NULL)
);
CREATE INDEX idx_field_app_locations_invoice ON field_app_locations(invoice_id);
CREATE INDEX idx_field_app_locations_job     ON field_app_locations(job_id);
CREATE INDEX idx_field_app_locations_field   ON field_app_locations(field_id);

ALTER TABLE field_app_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "field_app_locations_select" ON field_app_locations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "field_app_locations_insert" ON field_app_locations
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "field_app_locations_update" ON field_app_locations
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "field_app_locations_delete" ON field_app_locations
  FOR DELETE TO authenticated USING (true);

-- 3. Field App Location Shares — per-location customer billing splits
CREATE TABLE field_app_location_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     uuid NOT NULL REFERENCES field_app_locations(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES customers(id),
  split_pct       numeric(9,6) NOT NULL CHECK (split_pct > 0 AND split_pct <= 100),
  acres           numeric(12,2),
  amount_cents    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_field_app_location_shares_loc  ON field_app_location_shares(location_id);
CREATE INDEX idx_field_app_location_shares_cust ON field_app_location_shares(customer_id);

ALTER TABLE field_app_location_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "field_app_location_shares_select" ON field_app_location_shares
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "field_app_location_shares_insert" ON field_app_location_shares
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "field_app_location_shares_update" ON field_app_location_shares
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "field_app_location_shares_delete" ON field_app_location_shares
  FOR DELETE TO authenticated USING (true);
-- 4. derive_customer_shares_from_fields
-- Aggregates field_billing_defaults across multiple fields to produce a
-- combined customer split summary.
CREATE OR REPLACE FUNCTION derive_customer_shares_from_fields(
  p_field_ids uuid[],
  p_applied_acres_map jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH field_data AS (
    SELECT
      f.id AS field_id,
      f.field_name,
      f.total_acres,
      f.crop_type,
      COALESCE(
        (p_applied_acres_map ->> f.id::text)::numeric,
        f.total_acres
      ) AS applied_acres
    FROM fields f
    WHERE f.id = ANY(p_field_ids)
  ),  billing AS (
    SELECT
      fbd.customer_id,
      c.farm_name AS customer_name,
      c.assigned_tier AS tier,
      fbd.split_pct,
      fbd.is_primary,
      fd.field_id,
      fd.field_name,
      fd.applied_acres,
      (fd.applied_acres * fbd.split_pct / 100.0) AS share_acres
    FROM field_data fd
    JOIN field_billing_defaults fbd ON fbd.field_id = fd.field_id
    JOIN customers c ON c.id = fbd.customer_id
  ),
  aggregated AS (
    SELECT
      b.customer_id,
      b.customer_name,
      bool_or(b.is_primary) AS is_primary,
      SUM(b.share_acres) AS total_acres,
      -- overall split % = this customer's total share acres / grand total applied acres
      CASE
        WHEN SUM(SUM(b.share_acres)) OVER () > 0
        THEN ROUND(SUM(b.share_acres) / SUM(SUM(b.share_acres)) OVER () * 100, 4)
        ELSE 0
      END AS split_pct
    FROM billing b
    GROUP BY b.customer_id, b.customer_name
  )  SELECT jsonb_build_object(
    'shares', COALESCE(jsonb_agg(
      jsonb_build_object(
        'customer_id', a.customer_id,
        'customer_name', a.customer_name,
        'is_primary', a.is_primary,
        'total_acres', ROUND(a.total_acres, 2),
        'split_pct', a.split_pct
      ) ORDER BY a.is_primary DESC, a.total_acres DESC
    ), '[]'::jsonb),
    'total_applied_acres', (SELECT COALESCE(SUM(fd.applied_acres), 0) FROM field_data fd),
    'field_count', array_length(p_field_ids, 1)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION derive_customer_shares_from_fields(uuid[], jsonb) TO authenticated;
-- 5. save_field_app_invoice
-- Creates or updates a field-application invoice, saving locations, chemicals,
-- and auto-deriving customer shares from field_billing_defaults.
--
-- Verified column references (2026-04-07):
--   invoices table:    invoice_date (NOT transaction_date), header_notes (NOT notes)
--   invoice_items:     description (NOT product_name), unit_size (NOT unit), cost_cents (NOT unit_cost_cents)
--   activity_feed:     event_type, description, performed_by, related_entity_type, related_entity_id
CREATE OR REPLACE FUNCTION save_field_app_invoice(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_locations jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_invoice_id uuid;
  v_is_new boolean := false;
  v_loc jsonb;
  v_loc_id uuid;
  v_chem jsonb;  v_field_ids uuid[];
  v_applied_acres_map jsonb := '{}'::jsonb;
  v_shares jsonb;
  v_share jsonb;
  v_total_applied_acres numeric := 0;
  v_invoice_total_cents bigint := 0;
  v_total_cost_cents bigint := 0;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Create or update the invoice
  IF p_invoice_id IS NULL THEN
    v_is_new := true;
    INSERT INTO invoices (
      invoice_number, customer_id, invoice_type, status,
      invoice_date, salesman_id, header_notes, created_by,
      total_amount_cents, total_cost_cents
    ) VALUES (
      p_invoice->>'invoice_number',
      (p_invoice->>'customer_id')::uuid,
      'field_application',
      'draft',      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'salesman_id')::uuid,
      p_invoice->>'header_notes',
      p_performed_by,
      0, 0
    ) RETURNING id INTO v_invoice_id;
  ELSE
    v_invoice_id := p_invoice_id;

    UPDATE invoices SET
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      salesman_id = COALESCE((p_invoice->>'salesman_id')::uuid, salesman_id),
      header_notes = COALESCE(p_invoice->>'header_notes', header_notes),
      updated_at = now()
    WHERE id = v_invoice_id;

    -- Clear old locations and chemicals for re-save
    DELETE FROM field_app_locations WHERE invoice_id = v_invoice_id;
    DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;
    DELETE FROM invoice_shares WHERE invoice_id = v_invoice_id;
  END IF;
  -- Save locations
  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO field_app_locations (
      invoice_id, field_id, map_number, total_acres, planted_acres,
      applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      v_invoice_id,
      (v_loc->>'field_id')::uuid,
      (v_loc->>'map_number')::integer,
      (v_loc->>'total_acres')::numeric,
      (v_loc->>'planted_acres')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type',
      v_loc->>'wind_direction',
      (v_loc->>'sort_order')::integer
    ) RETURNING id INTO v_loc_id;

    -- Track applied acres per field for share derivation
    v_total_applied_acres := v_total_applied_acres + COALESCE((v_loc->>'applied_acres')::numeric, 0);
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id', v_loc->>'applied_acres'
    );
  END LOOP;
  -- Save chemicals as invoice_items
  FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
  LOOP
    INSERT INTO invoice_items (
      invoice_id, product_id, description,
      quantity, unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, rate_unit
    ) VALUES (
      v_invoice_id,
      (v_chem->>'product_id')::uuid,
      v_chem->>'description',
      COALESCE((v_chem->>'quantity')::numeric, 0),
      v_chem->>'unit_size',
      COALESCE((v_chem->>'unit_price_cents')::bigint, 0),
      COALESCE((v_chem->>'extended_cents')::bigint, 0),
      COALESCE((v_chem->>'cost_cents')::bigint, 0),
      COALESCE((v_chem->>'sort_order')::integer, 0),
      (v_chem->>'rate_per_acre')::numeric,
      v_chem->>'rate_unit'
    );

    v_invoice_total_cents := v_invoice_total_cents + COALESCE((v_chem->>'extended_cents')::bigint, 0);
    v_total_cost_cents := v_total_cost_cents + (
      COALESCE((v_chem->>'cost_cents')::bigint, 0) * COALESCE((v_chem->>'quantity')::numeric, 0)
    )::bigint;
  END LOOP;
  -- Update invoice totals
  UPDATE invoices SET
    total_amount_cents = v_invoice_total_cents,
    total_cost_cents   = v_total_cost_cents,
    updated_at         = now()
  WHERE id = v_invoice_id;

  -- Derive customer shares from field billing defaults
  IF v_field_ids IS NOT NULL AND array_length(v_field_ids, 1) > 0 THEN
    v_shares := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);

    FOR v_share IN SELECT * FROM jsonb_array_elements(v_shares->'shares')
    LOOP
      INSERT INTO invoice_shares (
        invoice_id, customer_id, customer_name,
        split_percentage, acres, amount_cents,
        is_primary, sort_order
      ) VALUES (
        v_invoice_id,
        (v_share->>'customer_id')::uuid,
        v_share->>'customer_name',
        (v_share->>'split_pct')::numeric,
        (v_share->>'total_acres')::numeric,
        (v_invoice_total_cents * (v_share->>'split_pct')::numeric / 100.0)::bigint,
        COALESCE((v_share->>'is_primary')::boolean, false),
        0
      );
    END LOOP;
    -- Set invoice customer to primary share customer
    UPDATE invoices SET
      customer_id = COALESCE(
        (SELECT (s->>'customer_id')::uuid
         FROM jsonb_array_elements(v_shares->'shares') s
         WHERE (s->>'is_primary')::boolean = true
         LIMIT 1),
        customer_id
      )
    WHERE id = v_invoice_id;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    CASE WHEN v_is_new THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    CASE WHEN v_is_new THEN 'Created field application invoice' ELSE 'Updated field application invoice' END,
    p_performed_by,
    'invoice',
    v_invoice_id
  );
  -- Record idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_app_invoice',
            jsonb_build_object('invoice_id', v_invoice_id,
                               'total_applied_acres', v_total_applied_acres,
                               'invoice_total_cents', v_invoice_total_cents));
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_invoice_id,
    'total_applied_acres', v_total_applied_acres,
    'invoice_total_cents', v_invoice_total_cents
  );
END;
$$;

GRANT EXECUTE ON FUNCTION save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated;
