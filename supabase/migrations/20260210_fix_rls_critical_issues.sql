-- =============================================================
-- Migration: Fix Critical RLS Policies (C1-C5)
-- Date: 2026-02-10
-- Purpose: Allow sales_rep role to create orders, deliveries,
--          inventory transactions, and notifications.
--          Allow all authenticated users to read profiles.
-- =============================================================

-- -------------------------------------------------------
-- C1. Orders INSERT - allow sales reps to create orders
-- -------------------------------------------------------
DROP POLICY IF EXISTS "orders_insert" ON orders;
CREATE POLICY "orders_insert" ON orders
  FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

-- -------------------------------------------------------
-- C1 (cont). Order Items INSERT - allow sales reps
-- -------------------------------------------------------
DROP POLICY IF EXISTS "oitems_insert" ON order_items;
CREATE POLICY "oitems_insert" ON order_items
  FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

-- -------------------------------------------------------
-- C2. Deliveries INSERT - allow sales reps (own records)
-- -------------------------------------------------------
DROP POLICY IF EXISTS "del_insert" ON deliveries;
CREATE POLICY "del_insert" ON deliveries
  FOR INSERT
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND created_by = (select auth.uid()))
  );

-- -------------------------------------------------------
-- C2 (cont). Delivery Items INSERT - allow sales reps
-- -------------------------------------------------------
DROP POLICY IF EXISTS "del_items_insert" ON delivery_items;
CREATE POLICY "del_items_insert" ON delivery_items
  FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

-- -------------------------------------------------------
-- C3. Inventory Transactions INSERT - allow sales reps
-- -------------------------------------------------------
DROP POLICY IF EXISTS "inv_tx_insert" ON inventory_transactions;
CREATE POLICY "inv_tx_insert" ON inventory_transactions
  FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

-- -------------------------------------------------------
-- C4. Profiles SELECT - allow all authenticated users
-- (Profile names are not sensitive in a CRM context)
-- -------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select" ON profiles;
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT
  USING (true);

-- -------------------------------------------------------
-- C5. Notifications INSERT - allow any authenticated user
-- to create notifications for any user (needed for
-- notifyAdmins() and cross-user notification patterns)
-- The SELECT policy already restricts reading to own only.
-- -------------------------------------------------------
DROP POLICY IF EXISTS "notif_insert" ON notifications;
CREATE POLICY "notif_insert" ON notifications
  FOR INSERT
  WITH CHECK (true);
