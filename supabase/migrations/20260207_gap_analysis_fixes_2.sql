-- =========================================================
-- CRX Manager Gap Analysis Fixes — Migration #2
-- Run this AFTER 20260207_gap_analysis_fixes.sql
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- =========================================================

-- ─── Ensure orders table has order_date column for charts ───
-- (it should already exist but let's be safe)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'order_date') THEN
    ALTER TABLE orders ADD COLUMN order_date date DEFAULT CURRENT_DATE;
  END IF;
END $$;

-- ─── Ensure payments table has proper RLS ───────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'payments' AND policyname = 'payments_select'
  ) THEN
    ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY payments_select ON payments FOR SELECT USING (true);
    CREATE POLICY payments_insert ON payments FOR INSERT WITH CHECK (true);
    CREATE POLICY payments_update ON payments FOR UPDATE USING (true);
  END IF;
END $$;

-- ─── Add reorder_point to inventory if not already present ──
-- (should exist from migration #1 but safe to check)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory' AND column_name = 'reorder_point') THEN
    ALTER TABLE inventory ADD COLUMN reorder_point integer DEFAULT 0;
    ALTER TABLE inventory ADD COLUMN min_stock_level integer DEFAULT 0;
  END IF;
END $$;

-- ─── Index for faster payment lookups ───────────────────────
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC);

-- ─── Index for faster inventory low-stock queries ───────────
CREATE INDEX IF NOT EXISTS idx_inventory_reorder ON inventory(reorder_point) WHERE reorder_point > 0;

-- ─── Ensure cost_history has tier price columns ─────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cost_history' AND column_name = 'old_tier1_price') THEN
    ALTER TABLE cost_history ADD COLUMN old_tier1_price numeric(12,2);
    ALTER TABLE cost_history ADD COLUMN new_tier1_price numeric(12,2);
    ALTER TABLE cost_history ADD COLUMN old_tier2_price numeric(12,2);
    ALTER TABLE cost_history ADD COLUMN new_tier2_price numeric(12,2);
    ALTER TABLE cost_history ADD COLUMN old_tier3_price numeric(12,2);
    ALTER TABLE cost_history ADD COLUMN new_tier3_price numeric(12,2);
  END IF;
END $$;

SELECT 'Migration #2 complete ✅' AS result;
