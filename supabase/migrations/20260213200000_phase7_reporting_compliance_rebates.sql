-- Phase 7: Reporting, Compliance, & Rebates
-- AR aging, applicator license tracking, RUP compliance,
-- manufacturer rebate programs, and season comparison support.

-- ============================================================
-- 1. Product Compliance Fields
-- ============================================================

-- Add RUP (Restricted Use Pesticide) flag to products
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_rup boolean NOT NULL DEFAULT false;

-- Signal number for restricted use products
ALTER TABLE products ADD COLUMN IF NOT EXISTS signal_word text
  CHECK (signal_word IS NULL OR signal_word IN ('Danger', 'Warning', 'Caution'));


-- ============================================================
-- 2. Applicator Licenses Table
-- ============================================================

CREATE TABLE IF NOT EXISTS applicator_licenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customers(id),
  license_number    text NOT NULL,
  license_type      text NOT NULL DEFAULT 'private'
    CHECK (license_type IN ('private', 'commercial', 'public')),
  holder_name       text NOT NULL,
  state             text NOT NULL DEFAULT 'IL',
  issued_date       date,
  expiry_date       date NOT NULL,
  certification_categories text[],  -- e.g. {'General Standards', 'Field Crop'}
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applicator_licenses_customer ON applicator_licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_applicator_licenses_expiry ON applicator_licenses(expiry_date);
CREATE INDEX IF NOT EXISTS idx_applicator_licenses_active ON applicator_licenses(is_active);

-- Updated_at trigger
CREATE TRIGGER set_applicator_licenses_updated_at
  BEFORE UPDATE ON applicator_licenses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE applicator_licenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS applicator_licenses_select ON applicator_licenses;
CREATE POLICY applicator_licenses_select ON applicator_licenses
  FOR SELECT USING (true);

DROP POLICY IF EXISTS applicator_licenses_insert ON applicator_licenses;
CREATE POLICY applicator_licenses_insert ON applicator_licenses
  FOR INSERT WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS applicator_licenses_update ON applicator_licenses;
CREATE POLICY applicator_licenses_update ON applicator_licenses
  FOR UPDATE USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS applicator_licenses_delete ON applicator_licenses;
CREATE POLICY applicator_licenses_delete ON applicator_licenses
  FOR DELETE USING (is_admin());


-- ============================================================
-- 3. Manufacturer Rebate Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS rebate_programs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_name      text NOT NULL,
  manufacturer      text NOT NULL,
  season            integer NOT NULL,
  product_id        uuid REFERENCES products(id),       -- specific product, or NULL = all from manufacturer
  rebate_type       text NOT NULL DEFAULT 'per_unit'
    CHECK (rebate_type IN ('per_unit', 'percentage', 'volume_tier', 'flat')),
  rebate_amount     numeric(10,2) NOT NULL DEFAULT 0,    -- per unit or flat amount
  rebate_pct        numeric(6,2),                        -- for percentage type
  min_volume        numeric(10,2),                       -- minimum volume to qualify
  max_volume        numeric(10,2),                       -- max volume cap
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  status            text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'closed')),
  notes             text,
  created_by        uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rebate_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id        uuid NOT NULL REFERENCES rebate_programs(id),
  order_id          uuid REFERENCES orders(id),
  customer_id       uuid REFERENCES customers(id),
  product_id        uuid REFERENCES products(id),
  claim_number      text NOT NULL,
  quantity           numeric(10,2) NOT NULL DEFAULT 0,
  claim_amount_cents bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'approved', 'paid', 'rejected')),
  submitted_date    date,
  approved_date     date,
  paid_date         date,
  paid_amount_cents bigint,
  manufacturer_ref  text,                                -- manufacturer's reference/check #
  notes             text,
  created_by        uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rebate_programs_manufacturer ON rebate_programs(manufacturer);
CREATE INDEX IF NOT EXISTS idx_rebate_programs_season ON rebate_programs(season);
CREATE INDEX IF NOT EXISTS idx_rebate_programs_product ON rebate_programs(product_id);
CREATE INDEX IF NOT EXISTS idx_rebate_programs_status ON rebate_programs(status);
CREATE INDEX IF NOT EXISTS idx_rebate_claims_program ON rebate_claims(program_id);
CREATE INDEX IF NOT EXISTS idx_rebate_claims_order ON rebate_claims(order_id);
CREATE INDEX IF NOT EXISTS idx_rebate_claims_status ON rebate_claims(status);

-- Updated_at triggers
CREATE TRIGGER set_rebate_programs_updated_at
  BEFORE UPDATE ON rebate_programs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_rebate_claims_updated_at
  BEFORE UPDATE ON rebate_claims
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE rebate_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rebate_claims ENABLE ROW LEVEL SECURITY;

-- rebate_programs: all read, admin write
DROP POLICY IF EXISTS rebate_programs_select ON rebate_programs;
CREATE POLICY rebate_programs_select ON rebate_programs
  FOR SELECT USING (true);

DROP POLICY IF EXISTS rebate_programs_insert ON rebate_programs;
CREATE POLICY rebate_programs_insert ON rebate_programs
  FOR INSERT WITH CHECK (is_admin());

DROP POLICY IF EXISTS rebate_programs_update ON rebate_programs;
CREATE POLICY rebate_programs_update ON rebate_programs
  FOR UPDATE USING (is_admin());

DROP POLICY IF EXISTS rebate_programs_delete ON rebate_programs;
CREATE POLICY rebate_programs_delete ON rebate_programs
  FOR DELETE USING (is_admin());

-- rebate_claims: admin/sales can read and write
DROP POLICY IF EXISTS rebate_claims_select ON rebate_claims;
CREATE POLICY rebate_claims_select ON rebate_claims
  FOR SELECT USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS rebate_claims_insert ON rebate_claims;
CREATE POLICY rebate_claims_insert ON rebate_claims
  FOR INSERT WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS rebate_claims_update ON rebate_claims;
CREATE POLICY rebate_claims_update ON rebate_claims
  FOR UPDATE USING (is_admin());

DROP POLICY IF EXISTS rebate_claims_delete ON rebate_claims;
CREATE POLICY rebate_claims_delete ON rebate_claims
  FOR DELETE USING (is_admin());


-- ============================================================
-- 4. AR Aging RPC
-- ============================================================
-- Returns aging buckets for all customers with open balances.
-- Calculates days outstanding from invoice_date or order_date.

CREATE OR REPLACE FUNCTION get_ar_aging(
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  customer_id      uuid,
  farm_name        text,
  current_amount   numeric,
  days_30          numeric,
  days_60          numeric,
  days_90          numeric,
  over_90          numeric,
  total_outstanding numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id AS customer_id,
    c.farm_name,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 0 AND 29 THEN balance END), 0) AS current_amount,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 30 AND 59 THEN balance END), 0) AS days_30,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 60 AND 89 THEN balance END), 0) AS days_60,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 90 AND 119 THEN balance END), 0) AS days_90,
    COALESCE(SUM(CASE WHEN age_days >= 120 THEN balance END), 0) AS over_90,
    COALESCE(SUM(balance), 0) AS total_outstanding
  FROM customers c
  INNER JOIN (
    -- Use invoices if available, fall back to orders
    SELECT
      i.customer_id,
      (i.balance_cents::numeric / 100) AS balance,
      (p_as_of_date - i.invoice_date::date) AS age_days
    FROM invoices i
    WHERE i.status = 'posted'
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
    UNION ALL
    -- Orders not yet invoiced but with balance due
    SELECT
      o.customer_id,
      o.balance_due::numeric AS balance,
      (p_as_of_date - o.order_date::date) AS age_days
    FROM orders o
    WHERE o.balance_due > 0
      AND o.status NOT IN ('cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM invoices inv
        WHERE inv.order_id = o.id
          AND inv.status = 'posted'
          AND inv.deleted_at IS NULL
      )
  ) ar ON ar.customer_id = c.id
  GROUP BY c.id, c.farm_name
  HAVING SUM(balance) > 0
  ORDER BY SUM(balance) DESC;
END;
$$;


-- ============================================================
-- 5. Customer Statement RPC
-- ============================================================
-- Returns all transactions for a customer in date order
-- (invoices, payments, credits) for statement generation.

CREATE OR REPLACE FUNCTION get_customer_statement(
  p_customer_id uuid,
  p_start_date date DEFAULT (CURRENT_DATE - INTERVAL '90 days')::date,
  p_end_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  transaction_date  date,
  transaction_type  text,
  reference_number  text,
  description       text,
  amount_cents      bigint,
  running_balance   bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH txns AS (
    -- Posted invoices
    SELECT
      i.invoice_date::date AS txn_date,
      'invoice' AS txn_type,
      i.invoice_number AS ref_num,
      'Invoice ' || i.invoice_number AS descr,
      i.total_amount_cents AS amt
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status = 'posted'
      AND i.deleted_at IS NULL
      AND i.invoice_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Payments on orders for this customer
    SELECT
      p.payment_date::date AS txn_date,
      'payment' AS txn_type,
      COALESCE(p.reference_number, '') AS ref_num,
      'Payment - ' || p.payment_method AS descr,
      -(p.amount * 100)::bigint AS amt  -- negative = reduces balance
    FROM payments p
    INNER JOIN orders o ON o.id = p.order_id
    WHERE o.customer_id = p_customer_id
      AND p.payment_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- Return credits
    SELECT
      r.credited_at::date AS txn_date,
      'credit' AS txn_type,
      r.return_number AS ref_num,
      'Return Credit - ' || r.return_number AS descr,
      -r.total_credit_cents AS amt  -- negative = reduces balance
    FROM returns r
    WHERE r.customer_id = p_customer_id
      AND r.status = 'credited'
      AND r.credited_at IS NOT NULL
      AND r.credited_at::date BETWEEN p_start_date AND p_end_date
      AND r.deleted_at IS NULL

    UNION ALL

    -- Prepay credits applied
    SELECT
      pa.applied_at::date AS txn_date,
      'prepay' AS txn_type,
      '' AS ref_num,
      'Prepay Applied' AS descr,
      -pa.applied_amount_cents AS amt
    FROM prepay_applications pa
    INNER JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id
      AND pa.applied_at::date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date AS transaction_date,
    t.txn_type AS transaction_type,
    t.ref_num AS reference_number,
    t.descr AS description,
    t.amt AS amount_cents,
    SUM(t.amt) OVER (ORDER BY t.txn_date, t.txn_type) AS running_balance
  FROM txns t
  ORDER BY t.txn_date, t.txn_type;
END;
$$;


-- ============================================================
-- 6. Season Comparison RPC
-- ============================================================
-- Returns revenue/profit/orders for two seasons side by side.

CREATE OR REPLACE FUNCTION get_season_comparison(
  p_season_a integer,  -- e.g. 2026
  p_season_b integer   -- e.g. 2025
)
RETURNS TABLE (
  metric        text,
  season_a_val  numeric,
  season_b_val  numeric,
  change_pct    numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_a_start date;
  v_a_end date;
  v_b_start date;
  v_b_end date;
  v_a_revenue numeric;
  v_b_revenue numeric;
  v_a_profit numeric;
  v_b_profit numeric;
  v_a_orders int;
  v_b_orders int;
  v_a_customers int;
  v_b_customers int;
BEGIN
  -- Season = July 1 of (year-1) to June 30 of year
  v_a_start := make_date(p_season_a - 1, 7, 1);
  v_a_end   := make_date(p_season_a, 6, 30);
  v_b_start := make_date(p_season_b - 1, 7, 1);
  v_b_end   := make_date(p_season_b, 6, 30);

  -- Season A
  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_a_revenue, v_a_profit, v_a_orders, v_a_customers
  FROM orders
  WHERE order_date BETWEEN v_a_start AND v_a_end
    AND status <> 'cancelled';

  -- Season B
  SELECT COALESCE(SUM(total_price), 0), COALESCE(SUM(total_profit), 0), COUNT(*), COUNT(DISTINCT customer_id)
  INTO v_b_revenue, v_b_profit, v_b_orders, v_b_customers
  FROM orders
  WHERE order_date BETWEEN v_b_start AND v_b_end
    AND status <> 'cancelled';

  RETURN QUERY VALUES
    ('Revenue'::text, v_a_revenue, v_b_revenue,
      CASE WHEN v_b_revenue > 0 THEN ROUND((v_a_revenue - v_b_revenue) / v_b_revenue * 100, 1) ELSE NULL END),
    ('Profit'::text, v_a_profit, v_b_profit,
      CASE WHEN v_b_profit > 0 THEN ROUND((v_a_profit - v_b_profit) / v_b_profit * 100, 1) ELSE NULL END),
    ('Orders'::text, v_a_orders::numeric, v_b_orders::numeric,
      CASE WHEN v_b_orders > 0 THEN ROUND((v_a_orders - v_b_orders)::numeric / v_b_orders * 100, 1) ELSE NULL END),
    ('Active Customers'::text, v_a_customers::numeric, v_b_customers::numeric,
      CASE WHEN v_b_customers > 0 THEN ROUND((v_a_customers - v_b_customers)::numeric / v_b_customers * 100, 1) ELSE NULL END);
END;
$$;
