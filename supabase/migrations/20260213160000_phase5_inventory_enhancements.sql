-- Phase 5: Inventory Enhancements
-- Adds warehouse management, cycle counting, and improved receiving workflow.

-- ============================================================
-- 1. Warehouses Table
-- ============================================================

CREATE TABLE IF NOT EXISTS warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  code        text,                   -- short code e.g. "MW", "S1"
  address     text,
  city        text,
  state       text DEFAULT 'IL',
  is_active   boolean NOT NULL DEFAULT true,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed default warehouse from existing data
INSERT INTO warehouses (name, code, is_active, is_default)
VALUES ('Main Warehouse', 'MW', true, true)
ON CONFLICT (name) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_warehouses_active ON warehouses(is_active);

-- RLS
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warehouses_select ON warehouses;
CREATE POLICY warehouses_select ON warehouses
  FOR SELECT USING (true);

DROP POLICY IF EXISTS warehouses_insert ON warehouses;
CREATE POLICY warehouses_insert ON warehouses
  FOR INSERT WITH CHECK (is_admin());

DROP POLICY IF EXISTS warehouses_update ON warehouses;
CREATE POLICY warehouses_update ON warehouses
  FOR UPDATE USING (is_admin());

DROP POLICY IF EXISTS warehouses_delete ON warehouses;
CREATE POLICY warehouses_delete ON warehouses
  FOR DELETE USING (is_admin());


-- ============================================================
-- 2. Cycle Counts Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS cycle_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_number  text NOT NULL,
  warehouse     text NOT NULL DEFAULT 'Main Warehouse',
  status        text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  initiated_by  uuid NOT NULL REFERENCES auth.users(id) DEFAULT auth.uid(),
  completed_by  uuid REFERENCES auth.users(id),
  notes         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cycle_count_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_count_id   uuid NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id),
  inventory_id     uuid REFERENCES inventory(id),
  expected_qty     numeric(10,2) NOT NULL DEFAULT 0,
  counted_qty      numeric(10,2),
  variance         numeric(10,2),          -- counted - expected
  variance_pct     numeric(8,2),           -- variance / expected * 100
  is_counted       boolean NOT NULL DEFAULT false,
  counted_by       uuid REFERENCES auth.users(id),
  counted_at       timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cycle_counts_status ON cycle_counts(status);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_warehouse ON cycle_counts(warehouse);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_initiated_by ON cycle_counts(initiated_by);
CREATE INDEX IF NOT EXISTS idx_cycle_count_items_count ON cycle_count_items(cycle_count_id);
CREATE INDEX IF NOT EXISTS idx_cycle_count_items_product ON cycle_count_items(product_id);

-- RLS
ALTER TABLE cycle_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycle_count_items ENABLE ROW LEVEL SECURITY;

-- cycle_counts: all authenticated can read, admin can write
DROP POLICY IF EXISTS cycle_counts_select ON cycle_counts;
CREATE POLICY cycle_counts_select ON cycle_counts
  FOR SELECT USING (true);

DROP POLICY IF EXISTS cycle_counts_insert ON cycle_counts;
CREATE POLICY cycle_counts_insert ON cycle_counts
  FOR INSERT WITH CHECK (is_admin());

DROP POLICY IF EXISTS cycle_counts_update ON cycle_counts;
CREATE POLICY cycle_counts_update ON cycle_counts
  FOR UPDATE USING (is_admin());

DROP POLICY IF EXISTS cycle_counts_delete ON cycle_counts;
CREATE POLICY cycle_counts_delete ON cycle_counts
  FOR DELETE USING (is_admin());

-- cycle_count_items: follows parent access
DROP POLICY IF EXISTS cycle_count_items_select ON cycle_count_items;
CREATE POLICY cycle_count_items_select ON cycle_count_items
  FOR SELECT USING (true);

DROP POLICY IF EXISTS cycle_count_items_insert ON cycle_count_items;
CREATE POLICY cycle_count_items_insert ON cycle_count_items
  FOR INSERT WITH CHECK (is_admin());

DROP POLICY IF EXISTS cycle_count_items_update ON cycle_count_items;
CREATE POLICY cycle_count_items_update ON cycle_count_items
  FOR UPDATE USING (is_admin());

DROP POLICY IF EXISTS cycle_count_items_delete ON cycle_count_items;
CREATE POLICY cycle_count_items_delete ON cycle_count_items
  FOR DELETE USING (is_admin());


-- ============================================================
-- 3. RPC: Complete Cycle Count
-- ============================================================
-- Finalizes a cycle count: updates inventory quantities and creates
-- adjustment transactions for any variance found.

CREATE OR REPLACE FUNCTION complete_cycle_count(
  p_cycle_count_id uuid,
  p_completed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item RECORD;
  v_count_number text;
BEGIN
  -- Get the count number for notes
  SELECT count_number INTO v_count_number
  FROM cycle_counts WHERE id = p_cycle_count_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle count not found';
  END IF;

  -- Process each counted item that has a variance
  FOR v_item IN
    SELECT cci.*, i.quantity_available, i.location
    FROM cycle_count_items cci
    LEFT JOIN inventory i ON i.id = cci.inventory_id
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.variance IS NOT NULL
      AND cci.variance <> 0
  LOOP
    -- Update inventory quantity
    IF v_item.inventory_id IS NOT NULL THEN
      UPDATE inventory
      SET quantity_available = quantity_available + v_item.variance,
          last_counted_at = now(),
          updated_at = now()
      WHERE id = v_item.inventory_id;

      -- Create audit trail transaction
      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'adjusted', v_item.variance,
        v_item.location, p_completed_by,
        'Cycle count ' || v_count_number || ': adjusted from ' ||
        v_item.expected_qty || ' to ' || v_item.counted_qty
      );
    END IF;
  END LOOP;

  -- Also update last_counted_at for items with zero variance
  UPDATE inventory
  SET last_counted_at = now(), updated_at = now()
  WHERE id IN (
    SELECT cci.inventory_id FROM cycle_count_items cci
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.inventory_id IS NOT NULL
  );

  -- Mark cycle count as completed
  UPDATE cycle_counts
  SET status = 'completed',
      completed_by = p_completed_by,
      completed_at = now()
  WHERE id = p_cycle_count_id;
END;
$$;
