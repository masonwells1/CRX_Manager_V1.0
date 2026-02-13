-- ============================================================
-- Phase 1: Farm/Field Data Foundation
-- Enables PostGIS, creates fields + field_billing_defaults tables,
-- adds parent_customer_id to customers, adds season/salesman_id/
-- deleted_at columns to financial tables.
-- ============================================================

-- 1. Enable PostGIS extension (geospatial support for field boundaries)
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

-- 2. Create fields table
CREATE TABLE IF NOT EXISTS fields (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field_name    text NOT NULL,
  legal_description text,          -- e.g. "NW 1/4 Sec 12 T34N R2E"
  county        text,
  state         text DEFAULT 'IL',
  total_acres   numeric(10,2),
  fsa_farm_number text,            -- USDA FSA farm number
  fsa_tract_number text,           -- USDA FSA tract number
  fsa_field_number text,           -- USDA FSA field number
  crop_type     text,              -- e.g. corn, soybean, wheat
  soil_type     text,
  irrigation    boolean DEFAULT false,
  centroid      geography(POINT, 4326),      -- GPS center point (nullable for now)
  boundary      geography(POLYGON, 4326),    -- Field boundary polygon (nullable for now)
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Indexes on fields
CREATE INDEX IF NOT EXISTS idx_fields_customer ON fields(customer_id);
CREATE INDEX IF NOT EXISTS idx_fields_county ON fields(county);
CREATE INDEX IF NOT EXISTS idx_fields_crop ON fields(crop_type);
CREATE INDEX IF NOT EXISTS idx_fields_active ON fields(is_active) WHERE is_active = true;

-- 3. Create field_billing_defaults table
-- Stores default billing split percentages per field per customer
CREATE TABLE IF NOT EXISTS field_billing_defaults (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id      uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  split_pct     numeric(9,6) NOT NULL CHECK (split_pct > 0 AND split_pct <= 100),
  is_primary    boolean NOT NULL DEFAULT false,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(field_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_fbd_field ON field_billing_defaults(field_id);
CREATE INDEX IF NOT EXISTS idx_fbd_customer ON field_billing_defaults(customer_id);

-- 4. Add parent_customer_id to customers (for customer hierarchy / farm groups)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'parent_customer_id'
  ) THEN
    ALTER TABLE customers ADD COLUMN parent_customer_id uuid REFERENCES customers(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customers_parent ON customers(parent_customer_id)
  WHERE parent_customer_id IS NOT NULL;

-- 5. Add season column to financial tables
-- Season = crop year (e.g. 2026 = July 1 2025 through June 30 2026)
DO $$
BEGIN
  -- orders
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'season'
  ) THEN
    ALTER TABLE orders ADD COLUMN season integer;
  END IF;

  -- quotes
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quotes' AND column_name = 'season'
  ) THEN
    ALTER TABLE quotes ADD COLUMN season integer;
  END IF;

  -- deliveries
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deliveries' AND column_name = 'season'
  ) THEN
    ALTER TABLE deliveries ADD COLUMN season integer;
  END IF;

  -- blend_tickets
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blend_tickets' AND column_name = 'season'
  ) THEN
    ALTER TABLE blend_tickets ADD COLUMN season integer;
  END IF;

  -- payments
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'season'
  ) THEN
    ALTER TABLE payments ADD COLUMN season integer;
  END IF;

  -- commissions
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'commissions' AND column_name = 'season'
  ) THEN
    ALTER TABLE commissions ADD COLUMN season integer;
  END IF;
END $$;

-- 6. Add salesman_id (FK to profiles) to financial tables
DO $$
BEGIN
  -- orders
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'salesman_id'
  ) THEN
    ALTER TABLE orders ADD COLUMN salesman_id uuid REFERENCES profiles(id);
  END IF;

  -- quotes
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quotes' AND column_name = 'salesman_id'
  ) THEN
    ALTER TABLE quotes ADD COLUMN salesman_id uuid REFERENCES profiles(id);
  END IF;
END $$;

-- 7. Add deleted_at (soft delete) to financial tables
DO $$
BEGIN
  -- orders
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN deleted_at timestamptz;
  END IF;

  -- quotes
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'quotes' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE quotes ADD COLUMN deleted_at timestamptz;
  END IF;

  -- deliveries
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deliveries' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE deliveries ADD COLUMN deleted_at timestamptz;
  END IF;

  -- blend_tickets
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'blend_tickets' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE blend_tickets ADD COLUMN deleted_at timestamptz;
  END IF;

  -- payments
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE payments ADD COLUMN deleted_at timestamptz;
  END IF;

  -- commissions
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'commissions' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE commissions ADD COLUMN deleted_at timestamptz;
  END IF;
END $$;

-- 8. Backfill season on existing orders based on order_date
-- Season logic: if month >= 7, season = year + 1; else season = year
UPDATE orders
SET season = CASE
  WHEN EXTRACT(MONTH FROM order_date) >= 7 THEN EXTRACT(YEAR FROM order_date)::int + 1
  ELSE EXTRACT(YEAR FROM order_date)::int
END
WHERE season IS NULL AND order_date IS NOT NULL;

-- Backfill season on existing quotes based on created_at
UPDATE quotes
SET season = CASE
  WHEN EXTRACT(MONTH FROM created_at) >= 7 THEN EXTRACT(YEAR FROM created_at)::int + 1
  ELSE EXTRACT(YEAR FROM created_at)::int
END
WHERE season IS NULL;

-- Backfill season on existing deliveries based on scheduled_date
UPDATE deliveries
SET season = CASE
  WHEN EXTRACT(MONTH FROM scheduled_date) >= 7 THEN EXTRACT(YEAR FROM scheduled_date)::int + 1
  ELSE EXTRACT(YEAR FROM scheduled_date)::int
END
WHERE season IS NULL AND scheduled_date IS NOT NULL;

-- 9. RLS policies for fields
ALTER TABLE fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fields_select ON fields;
CREATE POLICY fields_select ON fields FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS fields_insert ON fields;
CREATE POLICY fields_insert ON fields FOR INSERT TO authenticated
  WITH CHECK (
    is_admin() OR is_sales_rep()
  );

DROP POLICY IF EXISTS fields_update ON fields;
CREATE POLICY fields_update ON fields FOR UPDATE TO authenticated
  USING (
    is_admin() OR is_sales_rep()
  );

DROP POLICY IF EXISTS fields_delete ON fields;
CREATE POLICY fields_delete ON fields FOR DELETE TO authenticated
  USING (is_admin());

-- 10. RLS policies for field_billing_defaults
ALTER TABLE field_billing_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fbd_select ON field_billing_defaults;
CREATE POLICY fbd_select ON field_billing_defaults FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS fbd_insert ON field_billing_defaults;
CREATE POLICY fbd_insert ON field_billing_defaults FOR INSERT TO authenticated
  WITH CHECK (
    is_admin() OR is_sales_rep()
  );

DROP POLICY IF EXISTS fbd_update ON field_billing_defaults;
CREATE POLICY fbd_update ON field_billing_defaults FOR UPDATE TO authenticated
  USING (
    is_admin() OR is_sales_rep()
  );

DROP POLICY IF EXISTS fbd_delete ON field_billing_defaults;
CREATE POLICY fbd_delete ON field_billing_defaults FOR DELETE TO authenticated
  USING (
    is_admin() OR is_sales_rep()
  );

-- 11. Atomic save_field RPC (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION save_field(
  p_field_id uuid,
  p_field_payload jsonb,
  p_billing_defaults jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_field_id uuid;
  v_split record;
  v_total_pct numeric(9,6);
BEGIN
  -- Validate billing split percentages sum to 100 (if any provided)
  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    SELECT COALESCE(SUM((elem->>'split_pct')::numeric), 0) INTO v_total_pct
    FROM jsonb_array_elements(p_billing_defaults) AS elem;

    IF ABS(v_total_pct - 100) > 0.01 THEN
      RAISE EXCEPTION 'Billing splits must total 100%% (got %.2f%%)', v_total_pct;
    END IF;
  END IF;

  IF p_field_id IS NULL THEN
    -- INSERT new field
    INSERT INTO fields (
      customer_id, field_name, legal_description, county, state,
      total_acres, fsa_farm_number, fsa_tract_number, fsa_field_number,
      crop_type, soil_type, irrigation, notes, is_active
    )
    VALUES (
      (p_field_payload->>'customer_id')::uuid,
      p_field_payload->>'field_name',
      p_field_payload->>'legal_description',
      p_field_payload->>'county',
      COALESCE(p_field_payload->>'state', 'IL'),
      (p_field_payload->>'total_acres')::numeric,
      p_field_payload->>'fsa_farm_number',
      p_field_payload->>'fsa_tract_number',
      p_field_payload->>'fsa_field_number',
      p_field_payload->>'crop_type',
      p_field_payload->>'soil_type',
      COALESCE((p_field_payload->>'irrigation')::boolean, false),
      p_field_payload->>'notes',
      COALESCE((p_field_payload->>'is_active')::boolean, true)
    )
    RETURNING id INTO v_field_id;
  ELSE
    -- UPDATE existing field
    UPDATE fields SET
      customer_id = (p_field_payload->>'customer_id')::uuid,
      field_name = p_field_payload->>'field_name',
      legal_description = p_field_payload->>'legal_description',
      county = p_field_payload->>'county',
      state = COALESCE(p_field_payload->>'state', state),
      total_acres = (p_field_payload->>'total_acres')::numeric,
      fsa_farm_number = p_field_payload->>'fsa_farm_number',
      fsa_tract_number = p_field_payload->>'fsa_tract_number',
      fsa_field_number = p_field_payload->>'fsa_field_number',
      crop_type = p_field_payload->>'crop_type',
      soil_type = p_field_payload->>'soil_type',
      irrigation = COALESCE((p_field_payload->>'irrigation')::boolean, irrigation),
      notes = p_field_payload->>'notes',
      is_active = COALESCE((p_field_payload->>'is_active')::boolean, is_active),
      updated_at = now()
    WHERE id = p_field_id;

    v_field_id := p_field_id;
  END IF;

  -- Replace billing defaults (delete-then-insert pattern)
  DELETE FROM field_billing_defaults WHERE field_id = v_field_id;

  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary, notes)
    SELECT
      v_field_id,
      (elem->>'customer_id')::uuid,
      (elem->>'split_pct')::numeric,
      COALESCE((elem->>'is_primary')::boolean, false),
      elem->>'notes'
    FROM jsonb_array_elements(p_billing_defaults) AS elem;
  END IF;

  -- Log activity
  IF p_performed_by IS NOT NULL THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES (
      CASE WHEN p_field_id IS NULL THEN 'field_created' ELSE 'field_updated' END,
      CASE WHEN p_field_id IS NULL THEN 'Created field: ' ELSE 'Updated field: ' END || (p_field_payload->>'field_name'),
      p_performed_by,
      'field',
      v_field_id
    );
  END IF;

  RETURN v_field_id;
END;
$$;

-- 12. Updated_at trigger for fields
CREATE OR REPLACE FUNCTION update_fields_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_fields_updated_at ON fields;
CREATE TRIGGER set_fields_updated_at
  BEFORE UPDATE ON fields
  FOR EACH ROW EXECUTE FUNCTION update_fields_updated_at();

-- Updated_at trigger for field_billing_defaults
DROP TRIGGER IF EXISTS set_fbd_updated_at ON field_billing_defaults;
CREATE TRIGGER set_fbd_updated_at
  BEFORE UPDATE ON field_billing_defaults
  FOR EACH ROW EXECUTE FUNCTION update_fields_updated_at();

-- 13. Helper function to get current season
CREATE OR REPLACE FUNCTION current_season()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 7
    THEN EXTRACT(YEAR FROM CURRENT_DATE)::int + 1
    ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int
  END;
$$;
