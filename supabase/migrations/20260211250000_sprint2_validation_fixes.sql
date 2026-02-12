-- Sprint 2 Validation Fix: Restrict driver UPDATE on deliveries
-- ============================================================
--
-- PROBLEM: The "del_update" policy allows drivers to UPDATE any column on
--   their assigned deliveries. A driver could change customer_id, order_id,
--   scheduled_date, etc.
--
-- FIX: Remove drivers from the direct UPDATE policy. Drivers complete
--   deliveries exclusively through the `complete_delivery` RPC (SECURITY
--   DEFINER), which already validates the caller and only modifies
--   completion-related fields (status, signature_url, completed_at, etc.).
--
-- NOTE: Driver SELECT policies are NOT touched -- drivers still need to
--   read their assigned delivery data.

-- 1. Drop the existing update policy that includes drivers
DROP POLICY IF EXISTS "del_update" ON deliveries;

-- 2. Recreate the update policy for admin and sales_rep only
CREATE POLICY "del_update" ON deliveries FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
  )
  WITH CHECK (
    is_admin()
    OR is_sales_rep()
  );
