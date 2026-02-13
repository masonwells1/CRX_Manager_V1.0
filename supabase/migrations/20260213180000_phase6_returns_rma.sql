-- Phase 6: Returns / RMA System
-- Tracks product returns from customers, generates credits,
-- and restocks inventory as products are received back.

-- ============================================================
-- 1. Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS returns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number    text NOT NULL,
  order_id         uuid REFERENCES orders(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  status           text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'received', 'credited', 'rejected', 'cancelled')),

  -- Tracking
  reason           text NOT NULL DEFAULT 'defective'
    CHECK (reason IN ('defective', 'damaged', 'wrong_product', 'overstock', 'expired', 'other')),
  reason_notes     text,
  requested_by     uuid NOT NULL REFERENCES auth.users(id) DEFAULT auth.uid(),
  approved_by      uuid REFERENCES auth.users(id),
  received_by      uuid REFERENCES auth.users(id),

  -- Financial
  total_credit_cents  bigint NOT NULL DEFAULT 0,     -- total credit amount
  credit_invoice_id   uuid REFERENCES invoices(id),  -- linked credit memo

  -- Dates
  requested_at     timestamptz NOT NULL DEFAULT now(),
  approved_at      timestamptz,
  received_at      timestamptz,
  credited_at      timestamptz,

  -- Metadata
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE IF NOT EXISTS return_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id        uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id    uuid REFERENCES order_items(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  product_name     text NOT NULL DEFAULT '',
  quantity         numeric(10,2) NOT NULL DEFAULT 0,
  unit             text NOT NULL DEFAULT 'ea',
  unit_price_cents bigint NOT NULL DEFAULT 0,        -- price per unit for credit calc
  extended_cents   bigint NOT NULL DEFAULT 0,        -- quantity * unit_price_cents
  condition        text NOT NULL DEFAULT 'unopened'
    CHECK (condition IN ('unopened', 'opened', 'damaged', 'expired')),
  restock          boolean NOT NULL DEFAULT true,    -- whether to add back to inventory
  restocked        boolean NOT NULL DEFAULT false,   -- has been restocked
  sort_order       integer NOT NULL DEFAULT 0,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_returns_customer ON returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_returns_order ON returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_requested_by ON returns(requested_by);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_return_items_product ON return_items(product_id);

-- Updated_at trigger
CREATE TRIGGER set_returns_updated_at
  BEFORE UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- 2. RLS Policies
-- ============================================================

ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_items ENABLE ROW LEVEL SECURITY;

-- returns: all authenticated can read, admin/sales_rep can write
DROP POLICY IF EXISTS returns_select ON returns;
CREATE POLICY returns_select ON returns
  FOR SELECT USING (true);

DROP POLICY IF EXISTS returns_insert ON returns;
CREATE POLICY returns_insert ON returns
  FOR INSERT WITH CHECK (
    is_admin() OR is_sales_rep()
  );

DROP POLICY IF EXISTS returns_update ON returns;
CREATE POLICY returns_update ON returns
  FOR UPDATE USING (
    is_admin() OR requested_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS returns_delete ON returns;
CREATE POLICY returns_delete ON returns
  FOR DELETE USING (is_admin());

-- return_items: follows parent access
DROP POLICY IF EXISTS return_items_select ON return_items;
CREATE POLICY return_items_select ON return_items
  FOR SELECT USING (true);

DROP POLICY IF EXISTS return_items_insert ON return_items;
CREATE POLICY return_items_insert ON return_items
  FOR INSERT WITH CHECK (
    is_admin() OR is_sales_rep()
  );

DROP POLICY IF EXISTS return_items_update ON return_items;
CREATE POLICY return_items_update ON return_items
  FOR UPDATE USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM returns r
      WHERE r.id = return_items.return_id
        AND r.requested_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS return_items_delete ON return_items;
CREATE POLICY return_items_delete ON return_items
  FOR DELETE USING (is_admin());


-- ============================================================
-- 3. RPCs
-- ============================================================

-- Approve a return: updates status, records approver
CREATE OR REPLACE FUNCTION approve_return(
  p_return_id uuid,
  p_approved_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE returns
  SET status = 'approved',
      approved_by = p_approved_by,
      approved_at = now(),
      updated_at = now()
  WHERE id = p_return_id
    AND status = 'requested';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in requested status';
  END IF;
END;
$$;

-- Receive return: updates status, restocks inventory for eligible items
CREATE OR REPLACE FUNCTION receive_return(
  p_return_id uuid,
  p_received_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item RECORD;
  v_return_number text;
BEGIN
  -- Get return info
  SELECT return_number INTO v_return_number
  FROM returns WHERE id = p_return_id AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in approved status';
  END IF;

  -- Process each item that should be restocked
  FOR v_item IN
    SELECT ri.*, i.id AS inv_id, i.location
    FROM return_items ri
    LEFT JOIN inventory i ON i.product_id = ri.product_id
    WHERE ri.return_id = p_return_id
      AND ri.restock = true
      AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    -- Add back to inventory
    IF v_item.inv_id IS NOT NULL THEN
      UPDATE inventory
      SET quantity_available = quantity_available + v_item.quantity,
          updated_at = now()
      WHERE id = v_item.inv_id;

      -- Audit trail
      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'returned', v_item.quantity,
        v_item.location, p_received_by,
        'Return ' || v_return_number || ': ' || v_item.product_name ||
        ' (' || v_item.condition || ')'
      );
    END IF;

    -- Mark as restocked
    UPDATE return_items
    SET restocked = true
    WHERE id = v_item.id;
  END LOOP;

  -- Update return status
  UPDATE returns
  SET status = 'received',
      received_by = p_received_by,
      received_at = now(),
      updated_at = now()
  WHERE id = p_return_id;
END;
$$;

-- Issue credit for a return: calculates total, creates credit entry
CREATE OR REPLACE FUNCTION issue_return_credit(
  p_return_id uuid,
  p_actor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total bigint;
BEGIN
  -- Calculate total credit from items
  SELECT COALESCE(SUM(extended_cents), 0) INTO v_total
  FROM return_items
  WHERE return_id = p_return_id;

  -- Update return with credit amount and status
  UPDATE returns
  SET status = 'credited',
      total_credit_cents = v_total,
      credited_at = now(),
      updated_at = now()
  WHERE id = p_return_id
    AND status = 'received';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in received status';
  END IF;

  -- Log in financial audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    p_actor_id, -v_total,
    'Credit issued for return ' || (SELECT return_number FROM returns WHERE id = p_return_id)
  );
END;
$$;
