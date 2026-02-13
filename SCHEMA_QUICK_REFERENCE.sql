-- ==========================================
-- QUICK REFERENCE: Crop RX Solutions Schema
-- ==========================================
-- This is a consolidated view of the complete schema
-- For full migrations, see: supabase/migrations/
-- ==========================================

-- ==========================================
-- TABLE STRUCTURE (40+ tables)
-- ==========================================

-- Authentication & Users
CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'sales_rep' CHECK (role IN ('admin', 'sales_rep', 'driver')),
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Product Catalog
CREATE TABLE products (
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
  epa_registration text,
  is_rup boolean NOT NULL DEFAULT false,
  signal_word text CHECK (signal_word IS NULL OR signal_word IN ('Danger', 'Warning', 'Caution')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cost_history (
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

-- Customer Management
CREATE TABLE customers (
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

CREATE TABLE customer_addresses (
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

-- Quote Management
CREATE TABLE quotes (
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

CREATE TABLE quote_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  section_name text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  section_notes text
);

CREATE TABLE quote_items (
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

CREATE TABLE quote_versions (
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

-- Order Management
CREATE TABLE orders (
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

CREATE TABLE order_items (
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

-- Inventory
CREATE TABLE inventory (
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

CREATE TABLE inventory_transactions (
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

-- Procurement
CREATE TABLE purchase_orders (
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

CREATE TABLE purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity_ordered numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  quantity_received numeric NOT NULL DEFAULT 0,
  unit_size text,
  notes text
);

-- Delivery Management
CREATE TABLE deliveries (
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

CREATE TABLE delivery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity numeric NOT NULL DEFAULT 0,
  unit_size text,
  notes text
);

-- Financial
CREATE TABLE commissions (
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

-- Reference Data
CREATE TABLE ingredient_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branded_ingredient text NOT NULL DEFAULT '',
  generic_product_id uuid REFERENCES products(id),
  generic_has_bulk boolean NOT NULL DEFAULT false,
  fallback_branded_product text,
  notes text
);

CREATE TABLE unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit text NOT NULL UNIQUE,
  factor_oz numeric NOT NULL DEFAULT 0,
  notes text
);

-- Team Collaboration
CREATE TABLE team_notes (
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

CREATE TABLE team_note_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES team_notes(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Activity & Notifications
CREATE TABLE activity_feed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  performed_by uuid NOT NULL REFERENCES profiles(id),
  related_entity_type text,
  related_entity_id uuid,
  customer_id uuid REFERENCES customers(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
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

-- Configuration
CREATE TABLE app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text NOT NULL UNIQUE,
  setting_value text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ==========================================
-- PHASE 4A-7 TABLES
-- ==========================================

-- Payments
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  amount numeric NOT NULL DEFAULT 0,
  payment_method text,
  reference_number text,
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Farm Fields
CREATE TABLE fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  county text,
  acres numeric,
  fsa_farm_number text,
  fsa_tract_number text,
  fsa_field_number text,
  crop_type text,
  soil_type text,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE field_billing_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  split_pct numeric NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Invoicing
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'void')),
  subtotal_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  balance_cents bigint NOT NULL DEFAULT 0,
  due_date date,
  notes text,
  posted_at timestamptz,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES order_items(id),
  product_id uuid NOT NULL REFERENCES products(id),
  description text,
  quantity numeric NOT NULL DEFAULT 0,
  unit_price_cents bigint NOT NULL DEFAULT 0,
  line_total_cents bigint NOT NULL DEFAULT 0
);

CREATE TABLE allocation_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

CREATE TABLE order_line_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES allocation_sets(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  allocated_cents bigint NOT NULL DEFAULT 0
);

CREATE TABLE invoice_line_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES allocation_sets(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES invoice_items(id),
  allocated_cents bigint NOT NULL DEFAULT 0
);

CREATE TABLE prepay_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  source_payment_id uuid NOT NULL REFERENCES payments(id),
  original_amount_cents bigint NOT NULL DEFAULT 0,
  remaining_cents bigint NOT NULL DEFAULT 0,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prepay_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id uuid NOT NULL REFERENCES prepay_credits(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  applied_cents bigint NOT NULL DEFAULT 0,
  applied_by uuid NOT NULL REFERENCES profiles(id),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE financial_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  old_data jsonb,
  new_data jsonb,
  performed_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Blend Recipes
CREATE TABLE blend_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_name text NOT NULL,
  recipe_number text NOT NULL UNIQUE,
  category text,
  total_cost numeric NOT NULL DEFAULT 0,
  total_weight numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blend_recipe_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES blend_recipes(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity numeric NOT NULL DEFAULT 0,
  unit text,
  sort_order integer NOT NULL DEFAULT 0,
  notes text
);

CREATE TABLE blend_ticket_to_order_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES blend_tickets(id),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Warehouses & Cycle Counts
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_name text NOT NULL,
  code text NOT NULL UNIQUE,
  address text,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cycle_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_number text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  counted_by uuid NOT NULL REFERENCES profiles(id),
  completed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cycle_count_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_count_id uuid NOT NULL REFERENCES cycle_counts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  expected_qty numeric NOT NULL DEFAULT 0,
  counted_qty numeric,
  variance numeric,
  variance_pct numeric,
  resolved boolean NOT NULL DEFAULT false,
  notes text
);

-- Returns / RMA
CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'received', 'credited', 'rejected')),
  return_type text NOT NULL DEFAULT 'credit' CHECK (return_type IN ('refund', 'credit', 'exchange')),
  reason_category text CHECK (reason_category IN ('damaged', 'wrong_product', 'quality', 'overshipment', 'other')),
  requested_by uuid NOT NULL REFERENCES profiles(id),
  approved_by uuid REFERENCES profiles(id),
  credit_amount numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id uuid REFERENCES order_items(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity numeric NOT NULL DEFAULT 0,
  unit_price numeric NOT NULL DEFAULT 0,
  restocked boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  notes text
);

-- Compliance
CREATE TABLE applicator_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  license_number text NOT NULL,
  license_type text NOT NULL CHECK (license_type IN ('private', 'commercial', 'public')),
  holder_name text NOT NULL,
  state text,
  issued_date date,
  expiry_date date NOT NULL,
  certification_categories text[],
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rebates
CREATE TABLE rebate_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_name text NOT NULL,
  manufacturer text NOT NULL,
  season text,
  product_id uuid REFERENCES products(id),
  rebate_type text NOT NULL CHECK (rebate_type IN ('per_unit', 'percentage', 'volume_tier', 'flat')),
  rebate_amount numeric NOT NULL DEFAULT 0,
  rebate_pct numeric,
  min_volume numeric,
  max_volume numeric,
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'closed')),
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rebate_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES rebate_programs(id),
  order_id uuid REFERENCES orders(id),
  customer_id uuid REFERENCES customers(id),
  product_id uuid REFERENCES products(id),
  claim_number text NOT NULL UNIQUE,
  quantity numeric NOT NULL DEFAULT 0,
  claim_amount_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'approved', 'paid', 'rejected')),
  submitted_date date,
  approved_date date,
  paid_date date,
  paid_amount_cents bigint,
  manufacturer_ref text,
  notes text,
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ==========================================
-- RLS HELPER FUNCTIONS
-- ==========================================

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION is_sales_rep()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'sales_rep'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION is_driver()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'driver'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- ==========================================
-- AUTO-PROFILE CREATION TRIGGER
-- ==========================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'sales_rep')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ==========================================
-- RPC FUNCTIONS (Phase 7)
-- ==========================================

-- AR Aging Buckets
-- get_ar_aging(p_as_of_date date) -> RETURNS TABLE(customer_id, farm_name, current_amount, days_30, days_60, days_90, over_90, total_outstanding)
-- Aggregates outstanding balances from posted invoices and uninvoiced orders

-- Customer Statement
-- get_customer_statement(p_customer_id uuid, p_start_date date, p_end_date date) -> RETURNS TABLE(transaction_date, transaction_type, reference_number, description, amount_cents, running_balance)
-- Chronological transaction history with running balance window function

-- Season Comparison
-- get_season_comparison(p_season_a integer, p_season_b integer) -> RETURNS TABLE(metric, season_a_val, season_b_val, change_pct)
-- Year-over-year comparison (Revenue, Profit, Orders, Active Customers)
-- Season = July 1 of (year-1) to June 30 of year

-- All three are SECURITY DEFINER STABLE

-- ==========================================
-- SAMPLE RLS POLICIES (Consolidated Pattern)
-- ==========================================

-- Example: profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select" ON profiles FOR SELECT TO authenticated
  USING ((select auth.uid()) = id OR is_admin());

CREATE POLICY "profiles_insert" ON profiles FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = id OR is_admin());

CREATE POLICY "profiles_update" ON profiles FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id OR is_admin())
  WITH CHECK ((select auth.uid()) = id OR is_admin());

-- Example: customers (consolidated: admin OR rep OR driver)
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

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

-- Note: All other tables follow similar patterns
-- See full migrations for complete policy definitions

-- ==========================================
-- KEY INDEXES
-- ==========================================

-- Foreign key indexes
CREATE INDEX idx_customers_rep ON customers(assigned_sales_rep);
CREATE INDEX idx_quotes_customer ON quotes(customer_id);
CREATE INDEX idx_quotes_created_by ON quotes(created_by);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_deliveries_driver ON deliveries(assigned_driver);

-- Status indexes
CREATE INDEX idx_quotes_status ON quotes(status);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_deliveries_status ON deliveries(status);

-- Date indexes
CREATE INDEX idx_deliveries_date ON deliveries(scheduled_date);
CREATE INDEX idx_activity_created ON activity_feed(created_at DESC);

-- Note: See full migrations for complete index definitions
