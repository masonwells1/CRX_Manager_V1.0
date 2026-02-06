/*
  # Crop RX Solutions - Complete Database Schema

  1. New Tables (25 total)
    - `profiles` - User accounts linked to Supabase Auth
    - `products` - Product master (598+ items, 3 tier pricing)
    - `cost_history` - 2-year cost change log per product
    - `customers` - Grower/farm CRM records
    - `customer_addresses` - Multiple delivery addresses per customer
    - `quotes` - Quote headers with status tracking
    - `quote_sections` - Program groups within quotes
    - `quote_items` - Individual product line items on quotes
    - `quote_versions` - Frozen snapshots of sent quotes
    - `orders` - Confirmed orders from accepted quotes
    - `order_items` - Order line items with fulfillment tracking
    - `inventory` - Stock levels per product per warehouse
    - `inventory_transactions` - Complete audit trail of stock movements
    - `purchase_orders` - Orders to suppliers
    - `purchase_order_items` - Line items on supplier POs
    - `deliveries` - Scheduled customer deliveries
    - `delivery_items` - Products on each delivery
    - `commissions` - Earned commissions per order per recipient
    - `ingredient_map` - Brand to generic product lookup
    - `unit_conversions` - Unit conversion factors
    - `team_notes` - Shared notes, to-dos, announcements
    - `team_note_comments` - Comments on shared notes
    - `activity_feed` - Auto-generated action log
    - `notifications` - Push notifications per user
    - `app_settings` - Global app configuration

  2. Security
    - RLS enabled on all tables
    - Role-based policies for admin, sales_rep, driver

  3. Indexes on FK columns, status fields, date fields

  4. Seed Data
    - Unit conversions (Gal, Qt, Pt, Oz, Lb, Dry oz, Ea)
    - Default app settings
*/

-- ==========================================
-- TABLES (created in FK dependency order)
-- ==========================================

-- profiles
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'sales_rep' CHECK (role IN ('admin', 'sales_rep', 'driver')),
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- products
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name text NOT NULL,
  sku text,
  category text,
  vendor text,
  manufacturer text,
  container_size numeric,
  unit_size text,
  current_cost numeric,
  cost_updated_date timestamptz,
  tier1_price numeric,
  tier1_margin numeric,
  tier2_price numeric,
  tier2_margin numeric,
  tier3_price numeric,
  tier3_margin numeric,
  tier1_price_per_acre numeric,
  tier2_price_per_acre numeric,
  tier3_price_per_acre numeric,
  suggested_rate text,
  rate_per_acre numeric,
  rate_unit text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- cost_history
CREATE TABLE IF NOT EXISTS cost_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  changed_by uuid NOT NULL REFERENCES profiles(id),
  old_cost numeric,
  new_cost numeric,
  old_tier1_price numeric,
  new_tier1_price numeric,
  old_tier2_price numeric,
  new_tier2_price numeric,
  old_tier3_price numeric,
  new_tier3_price numeric,
  change_note text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- customers
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_name text NOT NULL,
  contact_name text,
  phone text,
  email text,
  billing_address text,
  assigned_tier integer NOT NULL DEFAULT 1 CHECK (assigned_tier IN (1, 2, 3)),
  assigned_sales_rep uuid REFERENCES profiles(id),
  total_acres numeric,
  corn_acres numeric,
  soybean_acres numeric,
  other_acres numeric,
  payment_terms text,
  default_commission_split jsonb,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- customer_addresses
CREATE TABLE IF NOT EXISTS customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  address_line text,
  city text,
  state text,
  zip text,
  delivery_notes text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- quotes
CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  created_by uuid NOT NULL REFERENCES profiles(id),
  tier integer NOT NULL DEFAULT 1 CHECK (tier IN (1, 2, 3)),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'revised', 'accepted', 'declined', 'expired')),
  commission_split jsonb,
  total_price numeric NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  total_profit numeric NOT NULL DEFAULT 0,
  total_margin_pct numeric NOT NULL DEFAULT 0,
  valid_days integer NOT NULL DEFAULT 15,
  expires_at date,
  header_notes text,
  footer_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- quote_sections
CREATE TABLE IF NOT EXISTS quote_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  section_name text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  section_notes text
);

-- quote_items
CREATE TABLE IF NOT EXISTS quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES quote_sections(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  sort_order integer NOT NULL DEFAULT 0,
  notes text,
  price_per_unit numeric NOT NULL DEFAULT 0,
  current_cost numeric NOT NULL DEFAULT 0,
  suggested_rate text,
  actual_rate numeric,
  rate_unit text,
  oz_per_acre numeric,
  price_per_acre numeric,
  acres numeric,
  total_units_needed numeric,
  unit_size text,
  profit numeric NOT NULL DEFAULT 0,
  total_price numeric NOT NULL DEFAULT 0,
  net_margin numeric NOT NULL DEFAULT 0
);

-- quote_versions
CREATE TABLE IF NOT EXISTS quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  version_number integer NOT NULL DEFAULT 1,
  sent_by uuid NOT NULL REFERENCES profiles(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_method text DEFAULT 'email',
  snapshot_data jsonb NOT NULL,
  pdf_url text,
  notes text
);

-- orders
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  quote_id uuid REFERENCES quotes(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled')),
  commission_split jsonb,
  total_price numeric NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  total_profit numeric NOT NULL DEFAULT 0,
  total_margin_pct numeric NOT NULL DEFAULT 0,
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- order_items
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quote_item_id uuid REFERENCES quote_items(id),
  section_name text,
  product_name text NOT NULL DEFAULT '',
  price_per_unit numeric NOT NULL DEFAULT 0,
  cost_per_unit numeric NOT NULL DEFAULT 0,
  actual_rate numeric,
  rate_unit text,
  acres numeric,
  total_units_needed numeric NOT NULL DEFAULT 0,
  unit_size text,
  total_price numeric NOT NULL DEFAULT 0,
  profit numeric NOT NULL DEFAULT 0,
  net_margin numeric NOT NULL DEFAULT 0,
  quantity_delivered numeric NOT NULL DEFAULT 0,
  quantity_remaining numeric NOT NULL DEFAULT 0
);

-- inventory
CREATE TABLE IF NOT EXISTS inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  location text NOT NULL DEFAULT 'Main Warehouse',
  quantity_available numeric NOT NULL DEFAULT 0,
  quantity_prebooked numeric NOT NULL DEFAULT 0,
  quantity_on_order numeric NOT NULL DEFAULT 0,
  unit_size text,
  last_counted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- inventory_transactions
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  transaction_type text NOT NULL CHECK (transaction_type IN ('received', 'booked', 'delivered', 'returned', 'adjusted', 'transferred')),
  quantity numeric NOT NULL DEFAULT 0,
  from_location text,
  to_location text,
  order_id uuid REFERENCES orders(id),
  purchase_order_id uuid,
  delivery_id uuid,
  performed_by uuid NOT NULL REFERENCES profiles(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- purchase_orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number text NOT NULL UNIQUE,
  vendor text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'partially_received', 'fully_received', 'cancelled')),
  submitted_date date,
  expected_delivery_date date,
  total_cost numeric NOT NULL DEFAULT 0,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- purchase_order_items
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity_ordered numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  quantity_received numeric NOT NULL DEFAULT 0,
  unit_size text,
  notes text
);

-- deliveries
CREATE TABLE IF NOT EXISTS deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_number text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  delivery_address_id uuid REFERENCES customer_addresses(id),
  assigned_driver uuid REFERENCES profiles(id),
  scheduled_date date NOT NULL DEFAULT CURRENT_DATE,
  scheduled_time text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  delivery_notes text,
  completed_at timestamptz,
  signature_url text,
  signed_by text,
  receipt_pdf_url text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- delivery_items
CREATE TABLE IF NOT EXISTS delivery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity numeric NOT NULL DEFAULT 0,
  unit_size text,
  notes text
);

-- commissions
CREATE TABLE IF NOT EXISTS commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  recipient text NOT NULL DEFAULT '',
  split_percentage numeric NOT NULL DEFAULT 0,
  commission_amount numeric NOT NULL DEFAULT 0,
  order_profit numeric NOT NULL DEFAULT 0,
  order_date date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ingredient_map
CREATE TABLE IF NOT EXISTS ingredient_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branded_ingredient text NOT NULL DEFAULT '',
  generic_product_id uuid REFERENCES products(id),
  generic_has_bulk boolean NOT NULL DEFAULT false,
  fallback_branded_product text,
  notes text
);

-- unit_conversions
CREATE TABLE IF NOT EXISTS unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit text NOT NULL UNIQUE,
  factor_oz numeric NOT NULL DEFAULT 0,
  notes text
);

-- team_notes
CREATE TABLE IF NOT EXISTS team_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT '',
  content text,
  note_type text NOT NULL DEFAULT 'note' CHECK (note_type IN ('note', 'todo', 'announcement')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  is_completed boolean NOT NULL DEFAULT false,
  completed_by uuid REFERENCES profiles(id),
  completed_at timestamptz,
  due_date date,
  created_by uuid NOT NULL REFERENCES profiles(id),
  assigned_to uuid REFERENCES profiles(id),
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- team_note_comments
CREATE TABLE IF NOT EXISTS team_note_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES team_notes(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- activity_feed
CREATE TABLE IF NOT EXISTS activity_feed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  performed_by uuid NOT NULL REFERENCES profiles(id),
  related_entity_type text,
  related_entity_id uuid,
  customer_id uuid REFERENCES customers(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id),
  title text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  notification_type text NOT NULL DEFAULT '',
  is_read boolean NOT NULL DEFAULT false,
  related_entity_type text,
  related_entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- app_settings
CREATE TABLE IF NOT EXISTS app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text NOT NULL UNIQUE,
  setting_value text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ==========================================
-- RLS POLICIES
-- ==========================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_note_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Helper: check if current user is admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: check if current user is sales_rep
CREATE OR REPLACE FUNCTION is_sales_rep()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales_rep'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: check if current user is driver
CREATE OR REPLACE FUNCTION is_driver()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'driver'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- PROFILES policies
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT TO authenticated
  USING (auth.uid() = id OR is_admin());
CREATE POLICY "profiles_insert" ON profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id OR is_admin());
CREATE POLICY "profiles_update" ON profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id OR is_admin())
  WITH CHECK (auth.uid() = id OR is_admin());

-- PRODUCTS policies
CREATE POLICY "products_select" ON products FOR SELECT TO authenticated USING (true);
CREATE POLICY "products_insert" ON products FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "products_update" ON products FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "products_delete" ON products FOR DELETE TO authenticated USING (is_admin());

-- COST_HISTORY policies
CREATE POLICY "cost_history_select" ON cost_history FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "cost_history_insert" ON cost_history FOR INSERT TO authenticated WITH CHECK (is_admin());

-- CUSTOMERS policies
CREATE POLICY "customers_admin_all" ON customers FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "customers_rep_select" ON customers FOR SELECT TO authenticated
  USING (is_sales_rep());
CREATE POLICY "customers_driver_select" ON customers FOR SELECT TO authenticated
  USING (is_driver() AND EXISTS (
    SELECT 1 FROM deliveries WHERE deliveries.customer_id = customers.id AND deliveries.assigned_driver = auth.uid()
  ));
CREATE POLICY "customers_admin_insert" ON customers FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "customers_rep_insert" ON customers FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep() AND assigned_sales_rep = auth.uid());
CREATE POLICY "customers_admin_update" ON customers FOR UPDATE TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "customers_rep_update" ON customers FOR UPDATE TO authenticated
  USING (is_sales_rep() AND assigned_sales_rep = auth.uid())
  WITH CHECK (is_sales_rep() AND assigned_sales_rep = auth.uid());
CREATE POLICY "customers_admin_delete" ON customers FOR DELETE TO authenticated USING (is_admin());

-- CUSTOMER_ADDRESSES policies
CREATE POLICY "addresses_select" ON customer_addresses FOR SELECT TO authenticated USING (true);
CREATE POLICY "addresses_admin_all" ON customer_addresses FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "addresses_admin_update" ON customer_addresses FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "addresses_admin_delete" ON customer_addresses FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "addresses_rep_insert" ON customer_addresses FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep() AND EXISTS (
    SELECT 1 FROM customers c WHERE c.id = customer_addresses.customer_id AND c.assigned_sales_rep = auth.uid()
  ));
CREATE POLICY "addresses_rep_update" ON customer_addresses FOR UPDATE TO authenticated
  USING (is_sales_rep() AND EXISTS (
    SELECT 1 FROM customers c WHERE c.id = customer_addresses.customer_id AND c.assigned_sales_rep = auth.uid()
  ))
  WITH CHECK (is_sales_rep() AND EXISTS (
    SELECT 1 FROM customers c WHERE c.id = customer_addresses.customer_id AND c.assigned_sales_rep = auth.uid()
  ));

-- QUOTES policies
CREATE POLICY "quotes_admin_all" ON quotes FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "quotes_rep_select" ON quotes FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "quotes_admin_insert" ON quotes FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "quotes_rep_insert" ON quotes FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep() AND created_by = auth.uid());
CREATE POLICY "quotes_admin_update" ON quotes FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "quotes_rep_update" ON quotes FOR UPDATE TO authenticated
  USING (is_sales_rep() AND created_by = auth.uid())
  WITH CHECK (is_sales_rep() AND created_by = auth.uid());
CREATE POLICY "quotes_admin_delete" ON quotes FOR DELETE TO authenticated USING (is_admin());

-- QUOTE_SECTIONS policies
CREATE POLICY "qsections_select" ON quote_sections FOR SELECT TO authenticated USING (true);
CREATE POLICY "qsections_admin_insert" ON quote_sections FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "qsections_admin_update" ON quote_sections FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "qsections_admin_delete" ON quote_sections FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "qsections_rep_insert" ON quote_sections FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = auth.uid()));
CREATE POLICY "qsections_rep_update" ON quote_sections FOR UPDATE TO authenticated
  USING (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = auth.uid()))
  WITH CHECK (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = auth.uid()));
CREATE POLICY "qsections_rep_delete" ON quote_sections FOR DELETE TO authenticated
  USING (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_sections.quote_id AND q.created_by = auth.uid()));

-- QUOTE_ITEMS policies
CREATE POLICY "qitems_select" ON quote_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "qitems_admin_insert" ON quote_items FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "qitems_admin_update" ON quote_items FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "qitems_admin_delete" ON quote_items FOR DELETE TO authenticated USING (is_admin());
CREATE POLICY "qitems_rep_insert" ON quote_items FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = auth.uid()));
CREATE POLICY "qitems_rep_update" ON quote_items FOR UPDATE TO authenticated
  USING (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = auth.uid()))
  WITH CHECK (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = auth.uid()));
CREATE POLICY "qitems_rep_delete" ON quote_items FOR DELETE TO authenticated
  USING (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_items.quote_id AND q.created_by = auth.uid()));

-- QUOTE_VERSIONS policies
CREATE POLICY "qversions_select" ON quote_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY "qversions_admin_insert" ON quote_versions FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "qversions_rep_insert" ON quote_versions FOR INSERT TO authenticated
  WITH CHECK (is_sales_rep() AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_versions.quote_id AND q.created_by = auth.uid()));

-- ORDERS policies
CREATE POLICY "orders_admin_select" ON orders FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "orders_rep_select" ON orders FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "orders_admin_insert" ON orders FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "orders_admin_update" ON orders FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "orders_admin_delete" ON orders FOR DELETE TO authenticated USING (is_admin());

-- ORDER_ITEMS policies
CREATE POLICY "oitems_admin_select" ON order_items FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "oitems_rep_select" ON order_items FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "oitems_admin_insert" ON order_items FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "oitems_admin_update" ON order_items FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "oitems_admin_delete" ON order_items FOR DELETE TO authenticated USING (is_admin());

-- INVENTORY policies
CREATE POLICY "inventory_admin_all" ON inventory FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "inventory_rep_select" ON inventory FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "inventory_driver_select" ON inventory FOR SELECT TO authenticated USING (is_driver());
CREATE POLICY "inventory_admin_insert" ON inventory FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "inventory_admin_update" ON inventory FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "inventory_admin_delete" ON inventory FOR DELETE TO authenticated USING (is_admin());

-- INVENTORY_TRANSACTIONS policies
CREATE POLICY "inv_tx_admin_select" ON inventory_transactions FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "inv_tx_rep_select" ON inventory_transactions FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "inv_tx_admin_insert" ON inventory_transactions FOR INSERT TO authenticated WITH CHECK (is_admin());

-- PURCHASE_ORDERS policies
CREATE POLICY "po_admin_select" ON purchase_orders FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "po_admin_insert" ON purchase_orders FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "po_admin_update" ON purchase_orders FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "po_admin_delete" ON purchase_orders FOR DELETE TO authenticated USING (is_admin());

-- PURCHASE_ORDER_ITEMS policies
CREATE POLICY "po_items_admin_select" ON purchase_order_items FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "po_items_admin_insert" ON purchase_order_items FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "po_items_admin_update" ON purchase_order_items FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "po_items_admin_delete" ON purchase_order_items FOR DELETE TO authenticated USING (is_admin());

-- DELIVERIES policies
CREATE POLICY "del_admin_select" ON deliveries FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "del_rep_select" ON deliveries FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "del_driver_select" ON deliveries FOR SELECT TO authenticated USING (assigned_driver = auth.uid());
CREATE POLICY "del_admin_insert" ON deliveries FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "del_admin_update" ON deliveries FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "del_driver_update" ON deliveries FOR UPDATE TO authenticated
  USING (assigned_driver = auth.uid()) WITH CHECK (assigned_driver = auth.uid());
CREATE POLICY "del_admin_delete" ON deliveries FOR DELETE TO authenticated USING (is_admin());

-- DELIVERY_ITEMS policies
CREATE POLICY "del_items_admin_select" ON delivery_items FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "del_items_rep_select" ON delivery_items FOR SELECT TO authenticated USING (is_sales_rep());
CREATE POLICY "del_items_driver_select" ON delivery_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = delivery_items.delivery_id AND d.assigned_driver = auth.uid()));
CREATE POLICY "del_items_admin_insert" ON delivery_items FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "del_items_admin_update" ON delivery_items FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "del_items_admin_delete" ON delivery_items FOR DELETE TO authenticated USING (is_admin());

-- COMMISSIONS policies
CREATE POLICY "comm_admin_select" ON commissions FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY "comm_rep_select" ON commissions FOR SELECT TO authenticated
  USING (is_sales_rep() AND EXISTS (
    SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND commissions.recipient = p.full_name
  ));
CREATE POLICY "comm_admin_insert" ON commissions FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "comm_admin_update" ON commissions FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- INGREDIENT_MAP policies
CREATE POLICY "ingmap_select" ON ingredient_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "ingmap_admin_insert" ON ingredient_map FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "ingmap_admin_update" ON ingredient_map FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "ingmap_admin_delete" ON ingredient_map FOR DELETE TO authenticated USING (is_admin());

-- UNIT_CONVERSIONS policies
CREATE POLICY "units_select" ON unit_conversions FOR SELECT TO authenticated USING (true);
CREATE POLICY "units_admin_insert" ON unit_conversions FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "units_admin_update" ON unit_conversions FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- TEAM_NOTES policies
CREATE POLICY "tnotes_select" ON team_notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "tnotes_insert" ON team_notes FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "tnotes_update" ON team_notes FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR is_admin())
  WITH CHECK (created_by = auth.uid() OR is_admin());
CREATE POLICY "tnotes_delete" ON team_notes FOR DELETE TO authenticated USING (is_admin());

-- TEAM_NOTE_COMMENTS policies
CREATE POLICY "tcomments_select" ON team_note_comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "tcomments_insert" ON team_note_comments FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

-- ACTIVITY_FEED policies
CREATE POLICY "activity_select" ON activity_feed FOR SELECT TO authenticated USING (true);
CREATE POLICY "activity_insert" ON activity_feed FOR INSERT TO authenticated WITH CHECK (performed_by = auth.uid());

-- NOTIFICATIONS policies
CREATE POLICY "notif_select" ON notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "notif_update" ON notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "notif_insert" ON notifications FOR INSERT TO authenticated WITH CHECK (true);

-- APP_SETTINGS policies
CREATE POLICY "settings_select" ON app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "settings_admin_insert" ON app_settings FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "settings_admin_update" ON app_settings FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- ==========================================
-- INDEXES
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_cost_history_product ON cost_history(product_id);
CREATE INDEX IF NOT EXISTS idx_customers_rep ON customers(assigned_sales_rep);
CREATE INDEX IF NOT EXISTS idx_customers_tier ON customers(assigned_tier);
CREATE INDEX IF NOT EXISTS idx_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_created_by ON quotes(created_by);
CREATE INDEX IF NOT EXISTS idx_qsections_quote ON quote_sections(quote_id);
CREATE INDEX IF NOT EXISTS idx_qitems_quote ON quote_items(quote_id);
CREATE INDEX IF NOT EXISTS idx_qitems_section ON quote_items(section_id);
CREATE INDEX IF NOT EXISTS idx_qitems_product ON quote_items(product_id);
CREATE INDEX IF NOT EXISTS idx_qversions_quote ON quote_versions(quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_quote ON orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_oitems_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_oitems_product ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_location ON inventory(location);
CREATE INDEX IF NOT EXISTS idx_inv_tx_product ON inventory_transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_type ON inventory_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(order_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON deliveries(customer_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_driver ON deliveries(assigned_driver);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_del_items_delivery ON delivery_items(delivery_id);
CREATE INDEX IF NOT EXISTS idx_commissions_order ON commissions(order_id);
CREATE INDEX IF NOT EXISTS idx_commissions_recipient ON commissions(recipient);
CREATE INDEX IF NOT EXISTS idx_tnotes_type ON team_notes(note_type);
CREATE INDEX IF NOT EXISTS idx_tnotes_assigned ON team_notes(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tcomments_note ON team_note_comments(note_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_feed(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(is_read);

-- ==========================================
-- SEED DATA
-- ==========================================

INSERT INTO unit_conversions (unit, factor_oz, notes) VALUES
  ('Gal', 128, '1 gallon = 128 fluid ounces'),
  ('Qt', 32, '1 quart = 32 fluid ounces'),
  ('Pt', 16, '1 pint = 16 fluid ounces'),
  ('Oz', 1, '1 fluid ounce'),
  ('Lb', 16, '1 pound = 16 dry ounces'),
  ('Dry oz', 1, '1 dry ounce'),
  ('Ea', 1, 'Each / unit')
ON CONFLICT (unit) DO NOTHING;

INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('company_name', 'Crop RX Solutions'),
  ('company_phone', ''),
  ('company_email', ''),
  ('company_address', ''),
  ('default_quote_valid_days', '15'),
  ('default_tier', '1')
ON CONFLICT (setting_key) DO NOTHING;
