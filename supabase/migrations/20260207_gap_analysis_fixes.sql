-- ==========================================
-- CRX Manager Gap Analysis Fixes
-- Migration: 20260207
-- ==========================================

-- ==========================================
-- 1. PAYMENTS TABLE (Gap #2 - Payment/AR Tracking)
-- ==========================================
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric NOT NULL DEFAULT 0,
  payment_method text NOT NULL DEFAULT 'check' CHECK (payment_method IN ('check', 'ach', 'cash', 'credit_card', 'other')),
  reference_number text,
  notes text,
  recorded_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_select" ON payments FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY "payments_insert" ON payments FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

CREATE POLICY "payments_update" ON payments FOR UPDATE TO authenticated
  USING (is_admin());

CREATE POLICY "payments_delete" ON payments FOR DELETE TO authenticated
  USING (is_admin());

CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_customer ON payments(customer_id);
CREATE INDEX idx_payments_date ON payments(payment_date);

-- ==========================================
-- 2. ADD paid_date AND paid_note TO COMMISSIONS (Gap #9)
-- ==========================================
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS paid_date date;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS paid_note text;

-- ==========================================
-- 3. ADD reorder_point AND min_stock_level TO INVENTORY (Gap #10)
-- ==========================================
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS reorder_point numeric NOT NULL DEFAULT 0;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS min_stock_level numeric NOT NULL DEFAULT 0;

-- ==========================================
-- 4. ADD total_paid AND balance_due TO ORDERS (Gap #2)
-- ==========================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_paid numeric NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance_due numeric NOT NULL DEFAULT 0;

-- ==========================================
-- 5. INDEXES FOR PERFORMANCE
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions(status);
CREATE INDEX IF NOT EXISTS idx_commissions_recipient ON commissions(recipient);
CREATE INDEX IF NOT EXISTS idx_inventory_reorder ON inventory(reorder_point) WHERE reorder_point > 0;
