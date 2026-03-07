-- ============================================================
-- Accounts Payable + RUP Sales Reporting
-- ============================================================
-- Two features in one migration:
--   1. AP: vendors, vendor_bills, vendor_payments tables + RPCs
--   2. RUP: rup_sales_records table + auto-generation from invoices
-- ============================================================

-- ────────────────────────────────────────────────
-- 1. VENDORS TABLE
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  contact_name text,
  phone text,
  email text,
  address text,
  default_payment_terms text DEFAULT 'Net 30',
  default_payment_terms_days integer DEFAULT 30,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

-- Admin + sales_rep can view vendors; admin can manage
CREATE POLICY "vendors_select" ON vendors FOR SELECT TO authenticated
  USING (deleted_at IS NULL);
CREATE POLICY "vendors_insert" ON vendors FOR INSERT TO authenticated
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales_rep'));
CREATE POLICY "vendors_update" ON vendors FOR UPDATE TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales_rep'));

-- Backfill vendors from existing product + PO data
INSERT INTO vendors (name)
SELECT DISTINCT vendor_name
FROM (
  SELECT TRIM(vendor) AS vendor_name FROM products WHERE vendor IS NOT NULL AND TRIM(vendor) <> ''
  UNION
  SELECT TRIM(vendor) AS vendor_name FROM purchase_orders WHERE vendor IS NOT NULL AND TRIM(vendor) <> ''
) src
WHERE vendor_name IS NOT NULL
ON CONFLICT (name) DO NOTHING;

-- ────────────────────────────────────────────────
-- 2. VENDOR BILLS TABLE
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES vendors(id),
  purchase_order_id uuid REFERENCES purchase_orders(id),
  bill_number text NOT NULL,
  bill_date date NOT NULL,
  due_date date NOT NULL,
  payment_terms text,
  subtotal_cents bigint NOT NULL,
  adjustment_cents bigint DEFAULT 0,
  total_cents bigint NOT NULL,
  paid_cents bigint DEFAULT 0,
  balance_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'unpaid'
    CHECK (status IN ('unpaid', 'partially_paid', 'paid', 'voided')),
  notes text,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_vendor_bills_vendor ON vendor_bills(vendor_id);
CREATE INDEX idx_vendor_bills_status ON vendor_bills(status);
CREATE INDEX idx_vendor_bills_due_date ON vendor_bills(due_date);
CREATE INDEX idx_vendor_bills_po ON vendor_bills(purchase_order_id);

ALTER TABLE vendor_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendor_bills_select" ON vendor_bills FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin')
  );
CREATE POLICY "vendor_bills_insert" ON vendor_bills FOR INSERT TO authenticated
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin'));
CREATE POLICY "vendor_bills_update" ON vendor_bills FOR UPDATE TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin'));

-- ────────────────────────────────────────────────
-- 3. VENDOR PAYMENTS TABLE
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_bill_id uuid NOT NULL REFERENCES vendor_bills(id),
  payment_date date NOT NULL,
  amount_cents bigint NOT NULL,
  payment_method text,
  reference_number text,
  notes text,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_vendor_payments_bill ON vendor_payments(vendor_bill_id);

ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendor_payments_select" ON vendor_payments FOR SELECT TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin'));
CREATE POLICY "vendor_payments_insert" ON vendor_payments FOR INSERT TO authenticated
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin'));

-- ────────────────────────────────────────────────
-- 4. AP RPCs
-- ────────────────────────────────────────────────

-- Create a vendor bill (manual or from PO)
CREATE OR REPLACE FUNCTION create_vendor_bill(
  p_vendor_id uuid,
  p_purchase_order_id uuid DEFAULT NULL,
  p_bill_number text DEFAULT '',
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_payment_terms text DEFAULT NULL,
  p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_bill_id uuid;
  v_terms_days integer;
  v_terms text;
BEGIN
  -- Get vendor default terms if not provided
  IF p_payment_terms IS NULL THEN
    SELECT default_payment_terms, default_payment_terms_days
    INTO v_terms, v_terms_days
    FROM vendors WHERE id = p_vendor_id;
  ELSE
    v_terms := p_payment_terms;
    v_terms_days := CASE
      WHEN p_payment_terms ILIKE '%90%' THEN 90
      WHEN p_payment_terms ILIKE '%60%' THEN 60
      WHEN p_payment_terms ILIKE '%45%' THEN 45
      WHEN p_payment_terms ILIKE '%30%' THEN 30
      WHEN p_payment_terms ILIKE '%15%' THEN 15
      WHEN p_payment_terms ILIKE '%10%' THEN 10
      ELSE 30
    END;
  END IF;

  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  INSERT INTO vendor_bills (
    vendor_id, purchase_order_id, bill_number, bill_date,
    due_date, payment_terms, subtotal_cents, adjustment_cents,
    total_cents, paid_cents, balance_cents, status, notes, created_by
  ) VALUES (
    p_vendor_id,
    p_purchase_order_id,
    p_bill_number,
    p_bill_date,
    COALESCE(p_due_date, p_bill_date + (COALESCE(v_terms_days, 30) || ' days')::interval),
    v_terms,
    p_subtotal_cents,
    COALESCE(p_adjustment_cents, 0),
    v_total,
    0,
    v_total,
    'unpaid',
    p_notes,
    COALESCE(p_created_by, auth.uid())
  ) RETURNING id INTO v_bill_id;

  RETURN v_bill_id;
END;
$$;

-- Record a payment against a vendor bill
CREATE OR REPLACE FUNCTION record_vendor_payment(
  p_vendor_bill_id uuid,
  p_amount_cents bigint,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment_id uuid;
  v_current_balance bigint;
  v_new_paid bigint;
  v_new_balance bigint;
  v_new_status text;
  v_total bigint;
BEGIN
  -- Lock the bill row
  SELECT balance_cents, paid_cents, total_cents
  INTO v_current_balance, v_new_paid, v_total
  FROM vendor_bills
  WHERE id = p_vendor_bill_id
  FOR UPDATE;

  IF v_current_balance IS NULL THEN
    RAISE EXCEPTION 'Vendor bill not found';
  END IF;

  IF p_amount_cents > v_current_balance THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance (%)', p_amount_cents, v_current_balance;
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Insert payment
  INSERT INTO vendor_payments (
    vendor_bill_id, payment_date, amount_cents,
    payment_method, reference_number, notes, created_by
  ) VALUES (
    p_vendor_bill_id, p_payment_date, p_amount_cents,
    p_payment_method, p_reference_number, p_notes,
    COALESCE(p_created_by, auth.uid())
  ) RETURNING id INTO v_payment_id;

  -- Update bill
  v_new_paid := v_new_paid + p_amount_cents;
  v_new_balance := v_total - v_new_paid;
  v_new_status := CASE
    WHEN v_new_balance <= 0 THEN 'paid'
    WHEN v_new_paid > 0 THEN 'partially_paid'
    ELSE 'unpaid'
  END;

  UPDATE vendor_bills
  SET paid_cents = v_new_paid,
      balance_cents = v_new_balance,
      status = v_new_status,
      updated_at = now()
  WHERE id = p_vendor_bill_id;

  RETURN v_payment_id;
END;
$$;

-- Void a vendor bill
CREATE OR REPLACE FUNCTION void_vendor_bill(
  p_vendor_bill_id uuid,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE vendor_bills
  SET status = 'voided',
      notes = COALESCE(notes || E'\n', '') || 'VOIDED: ' || COALESCE(p_reason, 'No reason provided'),
      updated_at = now()
  WHERE id = p_vendor_bill_id
    AND status <> 'voided';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found or already voided';
  END IF;
END;
$$;

-- AP Aging report
CREATE OR REPLACE FUNCTION get_ap_aging(p_as_of_date date DEFAULT CURRENT_DATE)
RETURNS TABLE(
  vendor_id uuid,
  vendor_name text,
  current_cents bigint,
  days_31_60_cents bigint,
  days_61_90_cents bigint,
  over_90_cents bigint,
  total_cents bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id AS vendor_id,
    v.name AS vendor_name,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) <= 30 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS current_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 31 AND 60 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_31_60_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 61 AND 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_61_90_cents,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) > 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS over_90_cents,
    COALESCE(SUM(vb.balance_cents), 0)::bigint AS total_cents
  FROM vendors v
  LEFT JOIN vendor_bills vb ON vb.vendor_id = v.id
    AND vb.status IN ('unpaid', 'partially_paid')
    AND vb.deleted_at IS NULL
  WHERE v.deleted_at IS NULL
  GROUP BY v.id, v.name
  HAVING COALESCE(SUM(vb.balance_cents), 0) > 0
  ORDER BY COALESCE(SUM(vb.balance_cents), 0) DESC;
END;
$$;

-- AP Dashboard Summary
CREATE OR REPLACE FUNCTION get_ap_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_owed_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') THEN balance_cents ELSE 0 END), 0),
    'overdue_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN balance_cents ELSE 0 END), 0),
    'overdue_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN 1 END),
    'due_this_week_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN balance_cents ELSE 0 END), 0),
    'due_this_week_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN 1 END),
    'due_this_month_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 THEN balance_cents ELSE 0 END), 0),
    'total_bills', COUNT(*),
    'unpaid_bills', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') THEN 1 END),
    'paid_this_month_cents', COALESCE((
      SELECT SUM(vp.amount_cents)
      FROM vendor_payments vp
      JOIN vendor_bills vb2 ON vb2.id = vp.vendor_bill_id
      WHERE vp.payment_date >= date_trunc('month', CURRENT_DATE)
    ), 0)
  )
  INTO v_result
  FROM vendor_bills
  WHERE deleted_at IS NULL AND status <> 'voided';

  RETURN v_result;
END;
$$;


-- ────────────────────────────────────────────────
-- 5. RUP SALES RECORDS TABLE
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rup_sales_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid REFERENCES invoices(id),
  order_id uuid REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  product_id uuid NOT NULL REFERENCES products(id),

  -- Sale details
  sale_date date NOT NULL,
  product_name text NOT NULL,
  epa_registration text,
  quantity numeric NOT NULL,
  unit text NOT NULL,
  unit_price_cents bigint,
  total_cents bigint,

  -- Buyer certification
  buyer_name text NOT NULL,
  buyer_certification_number text,
  buyer_certification_type text,
  buyer_certification_expiry date,

  -- Compliance
  signal_word text,
  compliance_status text DEFAULT 'compliant'
    CHECK (compliance_status IN ('compliant', 'warning', 'non_compliant')),
  compliance_notes text,

  season integer,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES profiles(id)
);

CREATE INDEX idx_rup_sales_customer ON rup_sales_records(customer_id);
CREATE INDEX idx_rup_sales_product ON rup_sales_records(product_id);
CREATE INDEX idx_rup_sales_date ON rup_sales_records(sale_date);
CREATE INDEX idx_rup_sales_invoice ON rup_sales_records(invoice_id);
CREATE INDEX idx_rup_sales_status ON rup_sales_records(compliance_status);

ALTER TABLE rup_sales_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rup_sales_select" ON rup_sales_records FOR SELECT TO authenticated
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales_rep'));
CREATE POLICY "rup_sales_insert" ON rup_sales_records FOR INSERT TO authenticated
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin'));

-- ────────────────────────────────────────────────
-- 6. RUP SALES RECORD GENERATION RPC
-- ────────────────────────────────────────────────

-- Generate RUP sales records for a posted invoice
CREATE OR REPLACE FUNCTION generate_rup_sales_records(p_invoice_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_invoice record;
  v_item record;
  v_license record;
  v_compliance_status text;
  v_compliance_notes text;
  v_season integer;
BEGIN
  -- Get invoice details
  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.created_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id;

  IF v_invoice IS NULL THEN
    RETURN 0;
  END IF;

  -- Calculate season (Oct 1 - Sep 30)
  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_invoice.created_at) >= 10
    THEN EXTRACT(YEAR FROM v_invoice.created_at)::integer + 1
    ELSE EXTRACT(YEAR FROM v_invoice.created_at)::integer
  END;

  -- Process each RUP product on the invoice
  FOR v_item IN
    SELECT ii.id, ii.product_id, ii.product_name, ii.quantity, ii.unit,
           ii.unit_price_cents, ii.line_total_cents,
           p.epa_registration, p.signal_word
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND p.is_rup = true
  LOOP
    -- Find the customer's best applicator license
    SELECT al.license_number, al.license_type, al.expiry_date
    INTO v_license
    FROM applicator_licenses al
    WHERE al.customer_id = v_invoice.customer_id
      AND al.deleted_at IS NULL
    ORDER BY al.expiry_date DESC NULLS LAST
    LIMIT 1;

    -- Determine compliance status
    IF v_license IS NULL OR v_license.license_number IS NULL THEN
      v_compliance_status := 'non_compliant';
      v_compliance_notes := 'No applicator license on file for this customer';
    ELSIF v_license.expiry_date IS NOT NULL AND v_license.expiry_date < CURRENT_DATE THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;
    ELSE
      v_compliance_status := 'compliant';
      v_compliance_notes := NULL;
    END IF;

    -- Don't duplicate if record already exists for this invoice+product
    IF NOT EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id AND product_id = v_item.product_id
    ) THEN
      INSERT INTO rup_sales_records (
        invoice_id, order_id, customer_id, product_id,
        sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents,
        buyer_name, buyer_certification_number,
        buyer_certification_type, buyer_certification_expiry,
        signal_word, compliance_status, compliance_notes,
        season, created_by
      ) VALUES (
        p_invoice_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
        CURRENT_DATE, v_item.product_name, v_item.epa_registration, v_item.quantity, v_item.unit,
        v_item.unit_price_cents, v_item.line_total_cents,
        v_invoice.farm_name,
        v_license.license_number,
        v_license.license_type,
        v_license.expiry_date,
        v_item.signal_word, v_compliance_status, v_compliance_notes,
        v_season, auth.uid()
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- RUP Sales Register query
CREATE OR REPLACE FUNCTION get_rup_sales_register(
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_compliance_status text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  sale_date date,
  invoice_id uuid,
  customer_id uuid,
  buyer_name text,
  product_name text,
  epa_registration text,
  quantity numeric,
  unit text,
  unit_price_cents bigint,
  total_cents bigint,
  buyer_certification_number text,
  buyer_certification_type text,
  buyer_certification_expiry date,
  signal_word text,
  compliance_status text,
  compliance_notes text,
  season integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id, r.sale_date, r.invoice_id, r.customer_id,
    r.buyer_name, r.product_name, r.epa_registration,
    r.quantity, r.unit, r.unit_price_cents, r.total_cents,
    r.buyer_certification_number, r.buyer_certification_type,
    r.buyer_certification_expiry, r.signal_word,
    r.compliance_status, r.compliance_notes, r.season
  FROM rup_sales_records r
  WHERE (p_start_date IS NULL OR r.sale_date >= p_start_date)
    AND (p_end_date IS NULL OR r.sale_date <= p_end_date)
    AND (p_product_id IS NULL OR r.product_id = p_product_id)
    AND (p_customer_id IS NULL OR r.customer_id = p_customer_id)
    AND (p_compliance_status IS NULL OR r.compliance_status = p_compliance_status)
  ORDER BY r.sale_date DESC, r.buyer_name;
END;
$$;
