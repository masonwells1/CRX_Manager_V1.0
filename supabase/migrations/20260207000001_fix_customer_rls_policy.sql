-- Fix: Sales reps could see ALL customers.
-- This restricts them to only see customers assigned to them.

DROP POLICY IF EXISTS "customers_select" ON customers;

CREATE POLICY "customers_select" ON customers FOR SELECT TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND assigned_sales_rep = (select auth.uid()))
    OR (is_driver() AND EXISTS (
      SELECT 1 FROM deliveries
      WHERE deliveries.customer_id = customers.id
      AND deliveries.assigned_driver = (select auth.uid())
    ))
  );
