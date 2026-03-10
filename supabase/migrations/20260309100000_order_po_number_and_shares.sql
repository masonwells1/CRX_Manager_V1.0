-- Migration: Add customer PO# to orders + order_shares table for bill splitting
-- Date: 2026-03-09
-- Bugs: #5 (Customer PO#), #3 (Order Bill Splits)

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Add customer_po_number column to orders
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_po_number text;

COMMENT ON COLUMN orders.customer_po_number IS 'Customer-provided purchase order number for cross-referencing';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Create order_shares table (bill splitting between customers)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_shares (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES customers(id),
  customer_name       text NOT NULL,
  split_percentage    numeric(9,6) NOT NULL CHECK (split_percentage > 0 AND split_percentage <= 100),
  amount_cents        bigint NOT NULL,
  is_primary          boolean DEFAULT false,
  sort_order          integer DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_shares_order ON order_shares(order_id);
CREATE INDEX IF NOT EXISTS idx_order_shares_customer ON order_shares(customer_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. RLS policies for order_shares
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE order_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "order_shares_select" ON order_shares;
CREATE POLICY "order_shares_select" ON order_shares
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = order_shares.order_id
        AND o.deleted_at IS NULL
        AND (
          public.is_admin()
          OR o.salesman_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "order_shares_insert" ON order_shares;
CREATE POLICY "order_shares_insert" ON order_shares
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS "order_shares_update" ON order_shares;
CREATE POLICY "order_shares_update" ON order_shares
  FOR UPDATE TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());

DROP POLICY IF EXISTS "order_shares_delete" ON order_shares;
CREATE POLICY "order_shares_delete" ON order_shares
  FOR DELETE TO authenticated
  USING (public.is_admin() OR public.is_sales_rep());
