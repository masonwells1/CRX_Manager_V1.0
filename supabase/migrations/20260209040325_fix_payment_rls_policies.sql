-- =========================================================
-- Fix: Ensure payments table has correct (strict) RLS policies
--
-- Problem: Two migrations created potentially conflicting
-- policies. This migration drops ALL existing payment policies
-- and recreates only the strict versions.
-- =========================================================

-- Drop any existing payment policies (both quoted and unquoted variants)
DROP POLICY IF EXISTS "payments_select" ON payments;
DROP POLICY IF EXISTS "payments_insert" ON payments;
DROP POLICY IF EXISTS "payments_update" ON payments;
DROP POLICY IF EXISTS "payments_delete" ON payments;
DROP POLICY IF EXISTS payments_select ON payments;
DROP POLICY IF EXISTS payments_insert ON payments;
DROP POLICY IF EXISTS payments_update ON payments;
DROP POLICY IF EXISTS payments_delete ON payments;

-- Ensure RLS is enabled
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Recreate the correct strict policies
-- Admins and sales reps can view payments
CREATE POLICY "payments_select" ON payments 
  FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

-- Admins and sales reps can create payments
CREATE POLICY "payments_insert" ON payments 
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

-- Only admins can update payments
CREATE POLICY "payments_update" ON payments 
  FOR UPDATE TO authenticated
  USING (is_admin());

-- Only admins can delete payments
CREATE POLICY "payments_delete" ON payments 
  FOR DELETE TO authenticated
  USING (is_admin());

SELECT 'Payment RLS policies fixed ✅' AS result;