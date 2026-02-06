/*
  # Fix Security and Performance Issues

  1. Missing FK Indexes
    - Add indexes on all foreign key columns that were missing coverage
    - Tables affected: activity_feed, app_settings, commissions, cost_history,
      deliveries, delivery_items, ingredient_map, inventory_transactions,
      order_items, purchase_order_items, purchase_orders, quote_versions,
      team_note_comments, team_notes

  2. RLS Auth Performance
    - Replace all bare `auth.uid()` calls in RLS policies with `(select auth.uid())`
    - This prevents re-evaluation per row and uses the query planner's init plan optimization
    - Affected policies across: profiles, customers, customer_addresses, quotes,
      quote_sections, quote_items, quote_versions, deliveries, delivery_items,
      commissions, team_notes, team_note_comments, activity_feed, notifications

  3. Consolidate Multiple Permissive Policies
    - Merge separate admin/rep/driver SELECT policies into single policies using OR conditions
    - Prevents unintended broad access from multiple permissive policies ORing together
    - Affected tables: customers, customer_addresses, quotes, quote_sections,
      quote_items, quote_versions, orders, order_items, inventory, inventory_transactions,
      deliveries, delivery_items, commissions, purchase_orders, purchase_order_items

  4. Fix Function Search Paths
    - Set explicit search_path on is_admin(), is_sales_rep(), is_driver() functions
    - Prevents search_path manipulation attacks

  5. Fix Unrestricted notif_insert Policy
    - Replace always-true WITH CHECK with proper user_id ownership check

  6. Important Notes
    - All changes are backwards-compatible
    - No data is modified or deleted
    - All policies are dropped and recreated (not altered) for safety
*/

-- ==========================================
-- 1. ADD MISSING FK INDEXES
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_activity_feed_customer_id ON activity_feed(customer_id);
CREATE INDEX IF NOT EXISTS idx_activity_feed_performed_by ON activity_feed(performed_by);
CREATE INDEX IF NOT EXISTS idx_app_settings_updated_by ON app_settings(updated_by);
CREATE INDEX IF NOT EXISTS idx_commissions_customer_id ON commissions(customer_id);
CREATE INDEX IF NOT EXISTS idx_cost_history_changed_by ON cost_history(changed_by);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_by ON deliveries(created_by);
CREATE INDEX IF NOT EXISTS idx_deliveries_address ON deliveries(delivery_address_id);
CREATE INDEX IF NOT EXISTS idx_delivery_items_order_item ON delivery_items(order_item_id);
CREATE INDEX IF NOT EXISTS idx_delivery_items_product ON delivery_items(product_id);
CREATE INDEX IF NOT EXISTS idx_ingredient_map_generic ON ingredient_map(generic_product_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_order ON inventory_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_performed_by ON inventory_transactions(performed_by);
CREATE INDEX IF NOT EXISTS idx_order_items_quote_item ON order_items(quote_item_id);
CREATE INDEX IF NOT EXISTS idx_po_items_product ON purchase_order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_po_created_by ON purchase_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_qversions_sent_by ON quote_versions(sent_by);
CREATE INDEX IF NOT EXISTS idx_tcomments_created_by ON team_note_comments(created_by);
CREATE INDEX IF NOT EXISTS idx_tnotes_completed_by ON team_notes(completed_by);
CREATE INDEX IF NOT EXISTS idx_tnotes_created_by ON team_notes(created_by);

-- ==========================================
-- 2. FIX HELPER FUNCTIONS (search_path)
-- ==========================================

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public;

CREATE OR REPLACE FUNCTION is_sales_rep()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'sales_rep'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public;

CREATE OR REPLACE FUNCTION is_driver()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'driver'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public;

-- ==========================================
-- 3. DROP ALL EXISTING POLICIES
-- ==========================================

-- profiles
DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;

-- products (no auth.uid() direct usage, but consolidating for consistency)
DROP POLICY IF EXISTS "products_select" ON products;
DROP POLICY IF EXISTS "products_insert" ON products;
DROP POLICY IF EXISTS "products_update" ON products;
DROP POLICY IF EXISTS "products_delete" ON products;

-- cost_history
DROP POLICY IF EXISTS "cost_history_select" ON cost_history;
DROP POLICY IF EXISTS "cost_history_insert" ON cost_history;

-- customers
DROP POLICY IF EXISTS "customers_admin_all" ON customers;
DROP POLICY IF EXISTS "customers_rep_select" ON customers;
DROP POLICY IF EXISTS "customers_driver_select" ON customers;
DROP POLICY IF EXISTS "customers_admin_insert" ON customers;
DROP POLICY IF EXISTS "customers_rep_insert" ON customers;
DROP POLICY IF EXISTS "customers_admin_update" ON customers;
DROP POLICY IF EXISTS "customers_rep_update" ON customers;
DROP POLICY IF EXISTS "customers_admin_delete" ON customers;

-- customer_addresses
DROP POLICY IF EXISTS "addresses_select" ON customer_addresses;
DROP POLICY IF EXISTS "addresses_admin_all" ON customer_addresses;
DROP POLICY IF EXISTS "addresses_admin_update" ON customer_addresses;
DROP POLICY IF EXISTS "addresses_admin_delete" ON customer_addresses;
DROP POLICY IF EXISTS "addresses_rep_insert" ON customer_addresses;
DROP POLICY IF EXISTS "addresses_rep_update" ON customer_addresses;

-- quotes
DROP POLICY IF EXISTS "quotes_admin_all" ON quotes;
DROP POLICY IF EXISTS "quotes_rep_select" ON quotes;
DROP POLICY IF EXISTS "quotes_admin_insert" ON quotes;
DROP POLICY IF EXISTS "quotes_rep_insert" ON quotes;
DROP POLICY IF EXISTS "quotes_admin_update" ON quotes;
DROP POLICY IF EXISTS "quotes_rep_update" ON quotes;
DROP POLICY IF EXISTS "quotes_admin_delete" ON quotes;

-- quote_sections
DROP POLICY IF EXISTS "qsections_select" ON quote_sections;
DROP POLICY IF EXISTS "qsections_admin_insert" ON quote_sections;
DROP POLICY IF EXISTS "qsections_admin_update" ON quote_sections;
DROP POLICY IF EXISTS "qsections_admin_delete" ON quote_sections;
DROP POLICY IF EXISTS "qsections_rep_insert" ON quote_sections;
DROP POLICY IF EXISTS "qsections_rep_update" ON quote_sections;
DROP POLICY IF EXISTS "qsections_rep_delete" ON quote_sections;

-- quote_items
DROP POLICY IF EXISTS "qitems_select" ON quote_items;
DROP POLICY IF EXISTS "qitems_admin_insert" ON quote_items;
DROP POLICY IF EXISTS "qitems_admin_update" ON quote_items;
DROP POLICY IF EXISTS "qitems_admin_delete" ON quote_items;
DROP POLICY IF EXISTS "qitems_rep_insert" ON quote_items;
DROP POLICY IF EXISTS "qitems_rep_update" ON quote_items;
DROP POLICY IF EXISTS "qitems_rep_delete" ON quote_items;

-- quote_versions
DROP POLICY IF EXISTS "qversions_select" ON quote_versions;
DROP POLICY IF EXISTS "qversions_admin_insert" ON quote_versions;
DROP POLICY IF EXISTS "qversions_rep_insert" ON quote_versions;

-- orders
DROP POLICY IF EXISTS "orders_admin_select" ON orders;
DROP POLICY IF EXISTS "orders_rep_select" ON orders;
DROP POLICY IF EXISTS "orders_admin_insert" ON orders;
DROP POLICY IF EXISTS "orders_admin_update" ON orders;
DROP POLICY IF EXISTS "orders_admin_delete" ON orders;

-- order_items
DROP POLICY IF EXISTS "oitems_admin_select" ON order_items;
DROP POLICY IF EXISTS "oitems_rep_select" ON order_items;
DROP POLICY IF EXISTS "oitems_admin_insert" ON order_items;
DROP POLICY IF EXISTS "oitems_admin_update" ON order_items;
DROP POLICY IF EXISTS "oitems_admin_delete" ON order_items;

-- inventory
DROP POLICY IF EXISTS "inventory_admin_all" ON inventory;
DROP POLICY IF EXISTS "inventory_rep_select" ON inventory;
DROP POLICY IF EXISTS "inventory_driver_select" ON inventory;
DROP POLICY IF EXISTS "inventory_admin_insert" ON inventory;
DROP POLICY IF EXISTS "inventory_admin_update" ON inventory;
DROP POLICY IF EXISTS "inventory_admin_delete" ON inventory;

-- inventory_transactions
DROP POLICY IF EXISTS "inv_tx_admin_select" ON inventory_transactions;
DROP POLICY IF EXISTS "inv_tx_rep_select" ON inventory_transactions;
DROP POLICY IF EXISTS "inv_tx_admin_insert" ON inventory_transactions;

-- purchase_orders
DROP POLICY IF EXISTS "po_admin_select" ON purchase_orders;
DROP POLICY IF EXISTS "po_admin_insert" ON purchase_orders;
DROP POLICY IF EXISTS "po_admin_update" ON purchase_orders;
DROP POLICY IF EXISTS "po_admin_delete" ON purchase_orders;

-- purchase_order_items
DROP POLICY IF EXISTS "po_items_admin_select" ON purchase_order_items;
DROP POLICY IF EXISTS "po_items_admin_insert" ON purchase_order_items;
DROP POLICY IF EXISTS "po_items_admin_update" ON purchase_order_items;
DROP POLICY IF EXISTS "po_items_admin_delete" ON purchase_order_items;

-- deliveries
DROP POLICY IF EXISTS "del_admin_select" ON deliveries;
DROP POLICY IF EXISTS "del_rep_select" ON deliveries;
DROP POLICY IF EXISTS "del_driver_select" ON deliveries;
DROP POLICY IF EXISTS "del_admin_insert" ON deliveries;
DROP POLICY IF EXISTS "del_admin_update" ON deliveries;
DROP POLICY IF EXISTS "del_driver_update" ON deliveries;
DROP POLICY IF EXISTS "del_admin_delete" ON deliveries;

-- delivery_items
DROP POLICY IF EXISTS "del_items_admin_select" ON delivery_items;
DROP POLICY IF EXISTS "del_items_rep_select" ON delivery_items;
DROP POLICY IF EXISTS "del_items_driver_select" ON delivery_items;
DROP POLICY IF EXISTS "del_items_admin_insert" ON delivery_items;
DROP POLICY IF EXISTS "del_items_admin_update" ON delivery_items;
DROP POLICY IF EXISTS "del_items_admin_delete" ON delivery_items;

-- commissions
DROP POLICY IF EXISTS "comm_admin_select" ON commissions;
DROP POLICY IF EXISTS "comm_rep_select" ON commissions;
DROP POLICY IF EXISTS "comm_admin_insert" ON commissions;
DROP POLICY IF EXISTS "comm_admin_update" ON commissions;

-- ingredient_map
DROP POLICY IF EXISTS "ingmap_select" ON ingredient_map;
DROP POLICY IF EXISTS "ingmap_admin_insert" ON ingredient_map;
DROP POLICY IF EXISTS "ingmap_admin_update" ON ingredient_map;
DROP POLICY IF EXISTS "ingmap_admin_delete" ON ingredient_map;

-- unit_conversions
DROP POLICY IF EXISTS "units_select" ON unit_conversions;
DROP POLICY IF EXISTS "units_admin_insert" ON unit_conversions;
DROP POLICY IF EXISTS "units_admin_update" ON unit_conversions;

-- team_notes
DROP POLICY IF EXISTS "tnotes_select" ON team_notes;
DROP POLICY IF EXISTS "tnotes_insert" ON team_notes;
DROP POLICY IF EXISTS "tnotes_update" ON team_notes;
DROP POLICY IF EXISTS "tnotes_delete" ON team_notes;

-- team_note_comments
DROP POLICY IF EXISTS "tcomments_select" ON team_note_comments;
DROP POLICY IF EXISTS "tcomments_insert" ON team_note_comments;

-- activity_feed
DROP POLICY IF EXISTS "activity_select" ON activity_feed;
DROP POLICY IF EXISTS "activity_insert" ON activity_feed;

-- notifications
DROP POLICY IF EXISTS "notif_select" ON notifications;
DROP POLICY IF EXISTS "notif_update" ON notifications;
DROP POLICY IF EXISTS "notif_insert" ON notifications;

-- app_settings
DROP POLICY IF EXISTS "settings_select" ON app_settings;
DROP POLICY IF EXISTS "settings_admin_insert" ON app_settings;
DROP POLICY IF EXISTS "settings_admin_update" ON app_settings;

-- ==========================================
-- 4. RECREATE ALL POLICIES
--    - Using (select auth.uid()) everywhere
--    - Consolidated into single policies per action
-- ==========================================

-- PROFILES
CREATE POLICY "profiles_select" ON profiles FOR SELECT TO authenticated
  USING ((select auth.uid()) = id OR is_admin());

CREATE POLICY "profiles_insert" ON profiles FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = id OR is_admin());

CREATE POLICY "profiles_update" ON profiles FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id OR is_admin())
  WITH CHECK ((select auth.uid()) = id OR is_admin());

-- PRODUCTS
CREATE POLICY "products_select" ON products FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "products_insert" ON products FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "products_update" ON products FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "products_delete" ON products FOR DELETE TO authenticated
  USING (is_admin());

-- COST_HISTORY
CREATE POLICY "cost_history_select" ON cost_history FOR SELECT TO authenticated
  USING (is_admin());

CREATE POLICY "cost_history_insert" ON cost_history FOR INSERT TO authenticated
  WITH CHECK (is_admin());

-- CUSTOMERS (consolidated: admin OR rep OR driver)
CREATE POLICY "customers_select" ON customers FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR (is_driver() AND EXISTS (
      SELECT 1 FROM deliveries
      WHERE deliveries.customer_id = customers.id
      AND deliveries.assigned_driver = (select auth.uid())
    ))
  );

CREATE POLICY "customers_insert" ON customers FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND assigned_sales_rep = (select auth.uid()))
  );

CREATE POLICY "customers_update" ON customers FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND assigned_sales_rep = (select auth.uid()))
  )
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND assigned_sales_rep = (select auth.uid()))
  );

CREATE POLICY "customers_delete" ON customers FOR DELETE TO authenticated
  USING (is_admin());

-- CUSTOMER_ADDRESSES (consolidated)
CREATE POLICY "addresses_select" ON customer_addresses FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "addresses_insert" ON customer_addresses FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM customers c
      WHERE c.id = customer_addresses.customer_id
      AND c.assigned_sales_rep = (select auth.uid())
    ))
  );

CREATE POLICY "addresses_update" ON customer_addresses FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM customers c
      WHERE c.id = customer_addresses.customer_id
      AND c.assigned_sales_rep = (select auth.uid())
    ))
  )
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM customers c
      WHERE c.id = customer_addresses.customer_id
      AND c.assigned_sales_rep = (select auth.uid())
    ))
  );

CREATE POLICY "addresses_delete" ON customer_addresses FOR DELETE TO authenticated
  USING (is_admin());

-- QUOTES (consolidated)
CREATE POLICY "quotes_select" ON quotes FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY "quotes_insert" ON quotes FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND created_by = (select auth.uid()))
  );

CREATE POLICY "quotes_update" ON quotes FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND created_by = (select auth.uid()))
  )
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND created_by = (select auth.uid()))
  );

CREATE POLICY "quotes_delete" ON quotes FOR DELETE TO authenticated
  USING (is_admin());

-- QUOTE_SECTIONS (consolidated)
CREATE POLICY "qsections_select" ON quote_sections FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "qsections_insert" ON quote_sections FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = (select auth.uid())
    ))
  );

CREATE POLICY "qsections_update" ON quote_sections FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = (select auth.uid())
    ))
  )
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = (select auth.uid())
    ))
  );

CREATE POLICY "qsections_delete" ON quote_sections FOR DELETE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = (select auth.uid())
    ))
  );

-- QUOTE_ITEMS (consolidated)
CREATE POLICY "qitems_select" ON quote_items FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "qitems_insert" ON quote_items FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = (select auth.uid())
    ))
  );

CREATE POLICY "qitems_update" ON quote_items FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = (select auth.uid())
    ))
  )
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = (select auth.uid())
    ))
  );

CREATE POLICY "qitems_delete" ON quote_items FOR DELETE TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = (select auth.uid())
    ))
  );

-- QUOTE_VERSIONS (consolidated)
CREATE POLICY "qversions_select" ON quote_versions FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "qversions_insert" ON quote_versions FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM quotes q WHERE q.id = quote_versions.quote_id AND q.created_by = (select auth.uid())
    ))
  );

-- ORDERS (consolidated)
CREATE POLICY "orders_select" ON orders FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY "orders_insert" ON orders FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "orders_update" ON orders FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "orders_delete" ON orders FOR DELETE TO authenticated
  USING (is_admin());

-- ORDER_ITEMS (consolidated)
CREATE POLICY "oitems_select" ON order_items FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY "oitems_insert" ON order_items FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "oitems_update" ON order_items FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "oitems_delete" ON order_items FOR DELETE TO authenticated
  USING (is_admin());

-- INVENTORY (consolidated)
CREATE POLICY "inventory_select" ON inventory FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep() OR is_driver());

CREATE POLICY "inventory_insert" ON inventory FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "inventory_update" ON inventory FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "inventory_delete" ON inventory FOR DELETE TO authenticated
  USING (is_admin());

-- INVENTORY_TRANSACTIONS (consolidated)
CREATE POLICY "inv_tx_select" ON inventory_transactions FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY "inv_tx_insert" ON inventory_transactions FOR INSERT TO authenticated
  WITH CHECK (is_admin());

-- PURCHASE_ORDERS
CREATE POLICY "po_select" ON purchase_orders FOR SELECT TO authenticated
  USING (is_admin());

CREATE POLICY "po_insert" ON purchase_orders FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "po_update" ON purchase_orders FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "po_delete" ON purchase_orders FOR DELETE TO authenticated
  USING (is_admin());

-- PURCHASE_ORDER_ITEMS
CREATE POLICY "po_items_select" ON purchase_order_items FOR SELECT TO authenticated
  USING (is_admin());

CREATE POLICY "po_items_insert" ON purchase_order_items FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "po_items_update" ON purchase_order_items FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "po_items_delete" ON purchase_order_items FOR DELETE TO authenticated
  USING (is_admin());

-- DELIVERIES (consolidated)
CREATE POLICY "del_select" ON deliveries FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR assigned_driver = (select auth.uid())
  );

CREATE POLICY "del_insert" ON deliveries FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "del_update" ON deliveries FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR assigned_driver = (select auth.uid())
  )
  WITH CHECK (
    is_admin()
    OR assigned_driver = (select auth.uid())
  );

CREATE POLICY "del_delete" ON deliveries FOR DELETE TO authenticated
  USING (is_admin());

-- DELIVERY_ITEMS (consolidated)
CREATE POLICY "del_items_select" ON delivery_items FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR EXISTS (
      SELECT 1 FROM deliveries d
      WHERE d.id = delivery_items.delivery_id
      AND d.assigned_driver = (select auth.uid())
    )
  );

CREATE POLICY "del_items_insert" ON delivery_items FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "del_items_update" ON delivery_items FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "del_items_delete" ON delivery_items FOR DELETE TO authenticated
  USING (is_admin());

-- COMMISSIONS (consolidated)
CREATE POLICY "comm_select" ON commissions FOR SELECT TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = (select auth.uid()) AND commissions.recipient = p.full_name
    ))
  );

CREATE POLICY "comm_insert" ON commissions FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "comm_update" ON commissions FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- INGREDIENT_MAP
CREATE POLICY "ingmap_select" ON ingredient_map FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "ingmap_insert" ON ingredient_map FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "ingmap_update" ON ingredient_map FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "ingmap_delete" ON ingredient_map FOR DELETE TO authenticated
  USING (is_admin());

-- UNIT_CONVERSIONS
CREATE POLICY "units_select" ON unit_conversions FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "units_insert" ON unit_conversions FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "units_update" ON unit_conversions FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- TEAM_NOTES
CREATE POLICY "tnotes_select" ON team_notes FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "tnotes_insert" ON team_notes FOR INSERT TO authenticated
  WITH CHECK (created_by = (select auth.uid()));

CREATE POLICY "tnotes_update" ON team_notes FOR UPDATE TO authenticated
  USING (created_by = (select auth.uid()) OR is_admin())
  WITH CHECK (created_by = (select auth.uid()) OR is_admin());

CREATE POLICY "tnotes_delete" ON team_notes FOR DELETE TO authenticated
  USING (is_admin());

-- TEAM_NOTE_COMMENTS
CREATE POLICY "tcomments_select" ON team_note_comments FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "tcomments_insert" ON team_note_comments FOR INSERT TO authenticated
  WITH CHECK (created_by = (select auth.uid()));

-- ACTIVITY_FEED
CREATE POLICY "activity_select" ON activity_feed FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "activity_insert" ON activity_feed FOR INSERT TO authenticated
  WITH CHECK (performed_by = (select auth.uid()));

-- NOTIFICATIONS (fixed: no more always-true insert)
CREATE POLICY "notif_select" ON notifications FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

CREATE POLICY "notif_update" ON notifications FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY "notif_insert" ON notifications FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR user_id = (select auth.uid())
  );

-- APP_SETTINGS
CREATE POLICY "settings_select" ON app_settings FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "settings_insert" ON app_settings FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "settings_update" ON app_settings FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
