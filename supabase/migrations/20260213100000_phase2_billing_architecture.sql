-- ============================================================
-- Phase 2: Billing Architecture
-- Creates invoice system, allocation sets, billing splits,
-- prepay credits, financial audit log, and core RPCs
-- ============================================================

-- ===========================================
-- 0. Generic updated_at trigger function
-- ===========================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================
-- 1. Invoice Number Sequence
-- ===========================================
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- Helper: generate next invoice number (INV-YYYY-NNNN)
CREATE OR REPLACE FUNCTION next_invoice_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_year text := extract(year from now())::text;
  v_seq  int  := nextval('invoice_number_seq');
BEGIN
  RETURN 'INV-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END;
$$;

-- ===========================================
-- 2. Invoices Table
-- ===========================================
CREATE TABLE IF NOT EXISTS invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number      text NOT NULL UNIQUE DEFAULT next_invoice_number(),
  order_id            uuid REFERENCES orders(id),
  blend_ticket_id     uuid REFERENCES blend_tickets(id),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  invoice_type        text NOT NULL DEFAULT 'chemical_sale'
                        CHECK (invoice_type IN ('chemical_sale', 'field_application', 'misc_charge')),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'unposted', 'posted', 'voided', 'cancelled')),
  season              integer NOT NULL DEFAULT current_season(),
  salesman_id         uuid REFERENCES profiles(id),
  created_by          uuid NOT NULL DEFAULT auth.uid(),

  -- Financial (stored in cents for precision)
  total_amount_cents  bigint NOT NULL DEFAULT 0,
  paid_amount_cents   bigint NOT NULL DEFAULT 0,
  prepay_applied_cents bigint NOT NULL DEFAULT 0,
  balance_cents       bigint GENERATED ALWAYS AS (total_amount_cents - paid_amount_cents - prepay_applied_cents) STORED,

  -- Posting workflow
  posted_by           uuid REFERENCES auth.users(id),
  posted_at           timestamptz,
  voided_by           uuid REFERENCES auth.users(id),
  voided_at           timestamptz,
  void_reason         text,

  -- Metadata
  invoice_date        date NOT NULL DEFAULT CURRENT_DATE,
  due_date            date,
  purchase_order_ref  text,
  header_notes        text,
  footer_notes        text,
  parent_invoice_id   uuid REFERENCES invoices(id),

  -- Soft delete
  deleted_at          timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ===========================================
-- 3. Invoice Items Table
-- ===========================================
CREATE TABLE IF NOT EXISTS invoice_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_item_id       uuid REFERENCES order_items(id),
  product_id          uuid REFERENCES products(id),
  description         text NOT NULL DEFAULT '',
  quantity            numeric(12,4) NOT NULL DEFAULT 0,
  unit_price_cents    bigint NOT NULL DEFAULT 0,
  extended_cents      bigint NOT NULL DEFAULT 0,
  cost_cents          bigint NOT NULL DEFAULT 0,
  sort_order          integer NOT NULL DEFAULT 0,
  rate_per_acre       numeric(12,4),
  acres               numeric(12,2),
  unit_size           text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ===========================================
-- 4. Allocation Sets (versioned split history)
-- ===========================================
CREATE TABLE IF NOT EXISTS allocation_sets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type         text NOT NULL CHECK (entity_type IN ('order', 'invoice')),
  entity_id           uuid NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  created_by          uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, version)
);

-- ===========================================
-- 5. Order Line Allocations (splits on order items)
-- ===========================================
CREATE TABLE IF NOT EXISTS order_line_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_set_id     uuid NOT NULL REFERENCES allocation_sets(id) ON DELETE CASCADE,
  order_item_id         uuid NOT NULL REFERENCES order_items(id),
  bill_to_customer_id   uuid NOT NULL REFERENCES customers(id),
  split_percentage      numeric(9,6) NOT NULL CHECK (split_percentage > 0 AND split_percentage <= 100),
  amount_cents          bigint NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ===========================================
-- 6. Invoice Line Allocations (splits on invoice items)
-- ===========================================
CREATE TABLE IF NOT EXISTS invoice_line_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_set_id     uuid NOT NULL REFERENCES allocation_sets(id) ON DELETE CASCADE,
  invoice_item_id       uuid NOT NULL REFERENCES invoice_items(id),
  bill_to_customer_id   uuid NOT NULL REFERENCES customers(id),
  split_percentage      numeric(9,6) NOT NULL CHECK (split_percentage > 0 AND split_percentage <= 100),
  amount_cents          bigint NOT NULL,
  split_invoice_id      uuid REFERENCES invoices(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ===========================================
-- 7. Prepay Credits
-- ===========================================
CREATE TABLE IF NOT EXISTS prepay_credits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  season              integer NOT NULL DEFAULT current_season(),
  original_amount_cents bigint NOT NULL,
  balance_cents       bigint NOT NULL,
  payment_method      text,
  reference_number    text,
  notes               text,
  created_by          uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ===========================================
-- 8. Prepay Applications (immutable ledger)
-- ===========================================
CREATE TABLE IF NOT EXISTS prepay_applications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prepay_credit_id      uuid NOT NULL REFERENCES prepay_credits(id),
  invoice_id            uuid NOT NULL REFERENCES invoices(id),
  applied_amount_cents  bigint NOT NULL CHECK (applied_amount_cents > 0),
  applied_by            uuid REFERENCES auth.users(id) DEFAULT auth.uid(),
  applied_at            timestamptz NOT NULL DEFAULT now()
  -- Immutable: no UPDATE or DELETE allowed via RLS
);

-- ===========================================
-- 9. Financial Audit Log (immutable)
-- ===========================================
CREATE TABLE IF NOT EXISTS financial_audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type      text NOT NULL
                        CHECK (operation_type IN (
                          'invoice_created', 'invoice_posted', 'invoice_voided',
                          'invoice_cancelled', 'payment_recorded', 'split_modified',
                          'prepay_created', 'prepay_applied', 'split_invoices_generated'
                        )),
  entity_type         text NOT NULL CHECK (entity_type IN ('invoice', 'payment', 'split', 'prepay')),
  entity_id           uuid NOT NULL,
  actor_user_id       uuid NOT NULL DEFAULT auth.uid(),
  actor_role          text,
  old_values          jsonb,
  new_values          jsonb,
  total_impact_cents  bigint,
  description         text,
  created_at          timestamptz NOT NULL DEFAULT now()
  -- NEVER UPDATE OR DELETE
);

-- ===========================================
-- 10. Indexes
-- ===========================================
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_season ON invoices(season);
CREATE INDEX IF NOT EXISTS idx_invoices_posted_at ON invoices(posted_at);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date ON invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_parent_invoice_id ON invoices(parent_invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_product_id ON invoice_items(product_id);

CREATE INDEX IF NOT EXISTS idx_allocation_sets_entity ON allocation_sets(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_order_line_alloc_set ON order_line_allocations(allocation_set_id);
CREATE INDEX IF NOT EXISTS idx_order_line_alloc_item ON order_line_allocations(order_item_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_alloc_set ON invoice_line_allocations(allocation_set_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_alloc_item ON invoice_line_allocations(invoice_item_id);

CREATE INDEX IF NOT EXISTS idx_prepay_credits_customer ON prepay_credits(customer_id);
CREATE INDEX IF NOT EXISTS idx_prepay_credits_season ON prepay_credits(season);
CREATE INDEX IF NOT EXISTS idx_prepay_applications_credit ON prepay_applications(prepay_credit_id);
CREATE INDEX IF NOT EXISTS idx_prepay_applications_invoice ON prepay_applications(invoice_id);

CREATE INDEX IF NOT EXISTS idx_financial_audit_entity ON financial_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_financial_audit_created ON financial_audit_log(created_at);

-- ===========================================
-- 11. Updated_at Triggers
-- ===========================================
CREATE OR REPLACE TRIGGER set_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER set_invoice_items_updated_at
  BEFORE UPDATE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER set_prepay_credits_updated_at
  BEFORE UPDATE ON prepay_credits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ===========================================
-- 12. RLS Policies
-- ===========================================
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prepay_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE prepay_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_audit_log ENABLE ROW LEVEL SECURITY;

-- Invoices: Admin full; Sales rep read own/created
DROP POLICY IF EXISTS invoices_select ON invoices;
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (
    is_admin()
    OR created_by = (SELECT auth.uid())
    OR salesman_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS invoices_insert ON invoices;
CREATE POLICY invoices_insert ON invoices FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS invoices_update ON invoices;
CREATE POLICY invoices_update ON invoices FOR UPDATE
  USING (is_admin());

DROP POLICY IF EXISTS invoices_delete ON invoices;
CREATE POLICY invoices_delete ON invoices FOR DELETE
  USING (is_admin());

-- Invoice items: follow parent invoice access
DROP POLICY IF EXISTS invoice_items_select ON invoice_items;
CREATE POLICY invoice_items_select ON invoice_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invoices
      WHERE invoices.id = invoice_items.invoice_id
      AND (is_admin() OR invoices.created_by = (SELECT auth.uid()) OR invoices.salesman_id = (SELECT auth.uid()))
    )
  );

DROP POLICY IF EXISTS invoice_items_insert ON invoice_items;
CREATE POLICY invoice_items_insert ON invoice_items FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS invoice_items_update ON invoice_items;
CREATE POLICY invoice_items_update ON invoice_items FOR UPDATE
  USING (is_admin());

DROP POLICY IF EXISTS invoice_items_delete ON invoice_items;
CREATE POLICY invoice_items_delete ON invoice_items FOR DELETE
  USING (is_admin());

-- Allocation sets: Admin + Sales rep
DROP POLICY IF EXISTS allocation_sets_select ON allocation_sets;
CREATE POLICY allocation_sets_select ON allocation_sets FOR SELECT
  USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS allocation_sets_insert ON allocation_sets;
CREATE POLICY allocation_sets_insert ON allocation_sets FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS allocation_sets_update ON allocation_sets;
CREATE POLICY allocation_sets_update ON allocation_sets FOR UPDATE
  USING (is_admin());

-- Order line allocations
DROP POLICY IF EXISTS order_line_alloc_select ON order_line_allocations;
CREATE POLICY order_line_alloc_select ON order_line_allocations FOR SELECT
  USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS order_line_alloc_insert ON order_line_allocations;
CREATE POLICY order_line_alloc_insert ON order_line_allocations FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

-- Invoice line allocations
DROP POLICY IF EXISTS invoice_line_alloc_select ON invoice_line_allocations;
CREATE POLICY invoice_line_alloc_select ON invoice_line_allocations FOR SELECT
  USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS invoice_line_alloc_insert ON invoice_line_allocations;
CREATE POLICY invoice_line_alloc_insert ON invoice_line_allocations FOR INSERT
  WITH CHECK (is_admin() OR is_sales_rep());

-- Prepay credits: Admin full; Sales rep read
DROP POLICY IF EXISTS prepay_credits_select ON prepay_credits;
CREATE POLICY prepay_credits_select ON prepay_credits FOR SELECT
  USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS prepay_credits_insert ON prepay_credits;
CREATE POLICY prepay_credits_insert ON prepay_credits FOR INSERT
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS prepay_credits_update ON prepay_credits;
CREATE POLICY prepay_credits_update ON prepay_credits FOR UPDATE
  USING (is_admin());

-- Prepay applications: Admin full; Sales rep read only; immutable (no update/delete)
DROP POLICY IF EXISTS prepay_applications_select ON prepay_applications;
CREATE POLICY prepay_applications_select ON prepay_applications FOR SELECT
  USING (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS prepay_applications_insert ON prepay_applications;
CREATE POLICY prepay_applications_insert ON prepay_applications FOR INSERT
  WITH CHECK (is_admin());

-- Financial audit log: Admin read + insert only; no update/delete ever
DROP POLICY IF EXISTS financial_audit_select ON financial_audit_log;
CREATE POLICY financial_audit_select ON financial_audit_log FOR SELECT
  USING (is_admin());

DROP POLICY IF EXISTS financial_audit_insert ON financial_audit_log;
CREATE POLICY financial_audit_insert ON financial_audit_log FOR INSERT
  WITH CHECK (true);  -- Allow all authenticated (RPCs need to log)

-- ===========================================
-- 13. Core RPCs
-- ===========================================

-- 13a. Largest-Remainder Rounding for billing splits
-- Input: total cents + array of percentages
-- Output: array of cents amounts that sum exactly to total
CREATE OR REPLACE FUNCTION calculate_billing_splits(
  p_total_cents    bigint,
  p_percentages    numeric[]
)
RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_count       int := array_length(p_percentages, 1);
  v_raw         numeric[];
  v_floored     bigint[];
  v_remainders  numeric[];
  v_floor_sum   bigint := 0;
  v_remainder   bigint;
  v_result      bigint[];
  v_idx         int;
  v_max_rem     numeric;
  v_max_idx     int;
  v_used        boolean[];
  i             int;
  j             int;
BEGIN
  IF v_count IS NULL OR v_count = 0 THEN
    RAISE EXCEPTION 'At least one split percentage required';
  END IF;

  -- Step 1: Calculate raw amounts and floor them
  v_raw := ARRAY[]::numeric[];
  v_floored := ARRAY[]::bigint[];
  v_remainders := ARRAY[]::numeric[];

  FOR i IN 1..v_count LOOP
    v_raw := array_append(v_raw, (p_total_cents * p_percentages[i] / 100.0));
    v_floored := array_append(v_floored, floor(v_raw[i])::bigint);
    v_remainders := array_append(v_remainders, v_raw[i] - floor(v_raw[i]));
    v_floor_sum := v_floor_sum + v_floored[i];
  END LOOP;

  -- Step 2: Distribute remainder pennies
  v_remainder := p_total_cents - v_floor_sum;
  v_result := v_floored;
  v_used := ARRAY[]::boolean[];
  FOR i IN 1..v_count LOOP
    v_used := array_append(v_used, false);
  END LOOP;

  FOR j IN 1..v_remainder LOOP
    v_max_rem := -1;
    v_max_idx := 1;
    FOR i IN 1..v_count LOOP
      IF NOT v_used[i] AND v_remainders[i] > v_max_rem THEN
        v_max_rem := v_remainders[i];
        v_max_idx := i;
      END IF;
    END LOOP;
    v_result[v_max_idx] := v_result[v_max_idx] + 1;
    v_used[v_max_idx] := true;
  END LOOP;

  RETURN v_result;
END;
$$;

-- 13b. Create invoice from order
CREATE OR REPLACE FUNCTION create_invoice_from_order(
  p_order_id     uuid,
  p_salesman_id  uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order       record;
  v_invoice_id  uuid;
  v_item        record;
  v_total_cents bigint := 0;
BEGIN
  -- Get order
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  -- Create invoice
  INSERT INTO invoices (
    order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_order_id, v_order.customer_id, p_invoice_type, 'draft',
    COALESCE(v_order.season, (SELECT current_season())),
    COALESCE(p_salesman_id, v_order.salesman_id),
    (SELECT auth.uid()), 0, CURRENT_DATE
  )
  RETURNING id INTO v_invoice_id;

  -- Copy order items to invoice items
  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size
    ) VALUES (
      v_invoice_id, v_item.id, v_item.product_id,
      COALESCE(v_item.product_name, ''),
      v_item.total_units_needed,
      round(v_item.price_per_unit * 100)::bigint,
      round(v_item.total_price * 100)::bigint,
      round(v_item.cost_per_unit * 100)::bigint,
      COALESCE(v_item.sort_order, 0),
      v_item.actual_rate,
      v_item.acres,
      v_item.unit_size
    );
    v_total_cents := v_total_cents + round(v_item.total_price * 100)::bigint;
  END LOOP;

  -- Update invoice total
  UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object(
      'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'order_number', v_order.order_number,
      'customer_id', v_order.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Invoice created from order ' || v_order.order_number
  );

  -- Activity feed
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
    'Invoice created from order ' || v_order.order_number,
    (SELECT auth.uid()), 'invoice', v_invoice_id, v_order.customer_id
  );

  RETURN v_invoice_id;
END;
$$;

-- 13c. Post invoice (unposted → posted)
CREATE OR REPLACE FUNCTION post_invoice(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inv record;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status;
  END IF;

  UPDATE invoices SET
    status = 'posted',
    posted_by = (SELECT auth.uid()),
    posted_at = now(),
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_posted', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object('status', v_inv.status),
    jsonb_build_object('status', 'posted', 'posted_at', now()::text),
    v_inv.total_amount_cents,
    'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2)
  );

  -- Activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted',
    'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2),
    (SELECT auth.uid()), 'invoice', p_invoice_id, v_inv.customer_id
  );
END;
$$;

-- 13d. Batch post invoices
CREATE OR REPLACE FUNCTION batch_post_invoices(p_invoice_ids uuid[])
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id      uuid;
  v_count   int := 0;
  v_total   bigint := 0;
BEGIN
  FOREACH v_id IN ARRAY p_invoice_ids LOOP
    PERFORM post_invoice(v_id);
    v_count := v_count + 1;
    v_total := v_total + (SELECT total_amount_cents FROM invoices WHERE id = v_id);
  END LOOP;

  -- Batch audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_posted', 'invoice', p_invoice_ids[1],
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object('batch_count', v_count, 'invoice_ids', to_jsonb(p_invoice_ids)),
    v_total,
    'Batch posted ' || v_count || ' invoices totaling $' || (v_total / 100.0)::numeric(12,2)
  );

  RETURN v_count;
END;
$$;

-- 13e. Void invoice
CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id  uuid,
  p_void_reason text DEFAULT 'Voided by admin'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inv record;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status = 'voided' THEN
    RAISE EXCEPTION 'Invoice already voided';
  END IF;

  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot void a cancelled invoice';
  END IF;

  UPDATE invoices SET
    status = 'voided',
    voided_by = (SELECT auth.uid()),
    voided_at = now(),
    void_reason = p_void_reason,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_voided', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
    jsonb_build_object('status', 'voided', 'void_reason', p_void_reason),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason
  );

  -- Activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
    (SELECT auth.uid()), 'invoice', p_invoice_id, v_inv.customer_id
  );
END;
$$;

-- 13f. Record payment against invoice
CREATE OR REPLACE FUNCTION record_invoice_payment(
  p_invoice_id      uuid,
  p_amount_cents    bigint,
  p_payment_method  text,
  p_reference_number text DEFAULT NULL,
  p_notes           text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inv         record;
  v_payment_id  uuid;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status != 'posted' THEN
    RAISE EXCEPTION 'Can only record payments on posted invoices (current status: %)', v_inv.status;
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Payment ($%) exceeds invoice balance ($%)',
      (p_amount_cents / 100.0)::numeric(12,2),
      (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- Insert payment record into existing payments table (converting cents → dollars for compatibility)
  INSERT INTO payments (
    order_id, amount, payment_method, payment_date, reference_number,
    notes, recorded_by
  ) VALUES (
    v_inv.order_id,
    (p_amount_cents / 100.0)::numeric(12,2),
    p_payment_method,
    CURRENT_DATE,
    p_reference_number,
    COALESCE(p_notes, '') || ' [Invoice: ' || v_inv.invoice_number || ']',
    (SELECT auth.uid())
  )
  RETURNING id INTO v_payment_id;

  -- Update invoice paid amount
  UPDATE invoices SET
    paid_amount_cents = paid_amount_cents + p_amount_cents,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Also update order balance if linked
  IF v_inv.order_id IS NOT NULL THEN
    UPDATE orders SET
      total_paid = total_paid + (p_amount_cents / 100.0)::numeric(12,2),
      balance_due = balance_due - (p_amount_cents / 100.0)::numeric(12,2),
      updated_at = now()
    WHERE id = v_inv.order_id;
  END IF;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_recorded', 'payment', v_payment_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'method', p_payment_method,
      'reference', p_reference_number
    ),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
  );

  RETURN v_payment_id;
END;
$$;

-- 13g. Apply prepay credit to invoice
CREATE OR REPLACE FUNCTION apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id       uuid,
  p_amount_cents     bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_credit    record;
  v_inv       record;
  v_app_id    uuid;
BEGIN
  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_prepay_credit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Application amount must be positive';
  END IF;

  IF p_amount_cents > v_credit.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds prepay balance ($%)', (v_credit.balance_cents / 100.0)::numeric(12,2);
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance ($%)', (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- Create application record (immutable)
  INSERT INTO prepay_applications (prepay_credit_id, invoice_id, applied_amount_cents)
  VALUES (p_prepay_credit_id, p_invoice_id, p_amount_cents)
  RETURNING id INTO v_app_id;

  -- Update prepay balance
  UPDATE prepay_credits SET
    balance_cents = balance_cents - p_amount_cents,
    updated_at = now()
  WHERE id = p_prepay_credit_id;

  -- Update invoice prepay applied
  UPDATE invoices SET
    prepay_applied_cents = prepay_applied_cents + p_amount_cents,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_applied', 'prepay', v_app_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object(
      'prepay_credit_id', p_prepay_credit_id,
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'remaining_credit', v_credit.balance_cents - p_amount_cents
    ),
    p_amount_cents,
    'Applied $' || (p_amount_cents / 100.0)::numeric(12,2) || ' prepay to ' || v_inv.invoice_number
  );

  RETURN v_app_id;
END;
$$;

-- 13h. Save invoice (create or update with items)
CREATE OR REPLACE FUNCTION save_invoice(
  p_invoice       jsonb,
  p_items         jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice_id  uuid;
  v_is_new      boolean := false;
  v_item        jsonb;
  v_total_cents bigint := 0;
BEGIN
  v_invoice_id := (p_invoice->>'id')::uuid;

  IF v_invoice_id IS NULL THEN
    v_is_new := true;
    -- Insert new invoice
    INSERT INTO invoices (
      customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
      total_amount_cents, created_by
    ) VALUES (
      (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0,
      (SELECT auth.uid())
    )
    RETURNING id INTO v_invoice_id;
  ELSE
    -- Update existing (only if draft/unposted)
    UPDATE invoices SET
      customer_id = COALESCE((p_invoice->>'customer_id')::uuid, customer_id),
      invoice_type = COALESCE(p_invoice->>'invoice_type', invoice_type),
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = (p_invoice->>'due_date')::date,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  -- Delete existing items and re-insert
  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity,
      unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size, notes
    ) VALUES (
      v_invoice_id,
      (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      COALESCE((v_item->>'quantity')::numeric, 0),
      COALESCE((v_item->>'unit_price_cents')::bigint, 0),
      COALESCE((v_item->>'extended_cents')::bigint, 0),
      COALESCE((v_item->>'cost_cents')::bigint, 0),
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric,
      (v_item->>'acres')::numeric,
      v_item->>'unit_size',
      v_item->>'notes'
    );
    v_total_cents := v_total_cents + COALESCE((v_item->>'extended_cents')::bigint, 0);
  END LOOP;

  -- Update total
  UPDATE invoices SET total_amount_cents = v_total_cents, updated_at = now()
  WHERE id = v_invoice_id;

  -- Activity log for new invoices
  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      (SELECT auth.uid()), 'invoice', v_invoice_id,
      (p_invoice->>'customer_id')::uuid
    );
  END IF;

  RETURN v_invoice_id;
END;
$$;

-- 13i. Update allocation set (new version)
CREATE OR REPLACE FUNCTION update_allocation_set(
  p_entity_type   text,
  p_entity_id     uuid,
  p_splits        jsonb,   -- array of { item_id, customer_id, percentage }
  p_reason_note   text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_version int;
  v_set_id      uuid;
  v_split       jsonb;
  v_item_totals jsonb;
  v_item_cents  bigint;
  v_pcts        numeric[];
  v_amounts     bigint[];
  v_customers   uuid[];
  v_current_item uuid;
  v_idx         int;
BEGIN
  -- Deactivate old sets
  UPDATE allocation_sets SET is_active = false
  WHERE entity_type = p_entity_type AND entity_id = p_entity_id AND is_active;

  -- Get next version
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_new_version
  FROM allocation_sets
  WHERE entity_type = p_entity_type AND entity_id = p_entity_id;

  -- Create new set
  INSERT INTO allocation_sets (entity_type, entity_id, version, is_active, notes)
  VALUES (p_entity_type, p_entity_id, v_new_version, true, p_reason_note)
  RETURNING id INTO v_set_id;

  -- Process splits grouped by item_id
  -- p_splits is: [{ item_id, customer_id, percentage, amount_cents }]
  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits) LOOP
    IF p_entity_type = 'order' THEN
      INSERT INTO order_line_allocations (
        allocation_set_id, order_item_id, bill_to_customer_id,
        split_percentage, amount_cents
      ) VALUES (
        v_set_id,
        (v_split->>'item_id')::uuid,
        (v_split->>'customer_id')::uuid,
        (v_split->>'percentage')::numeric,
        (v_split->>'amount_cents')::bigint
      );
    ELSE
      INSERT INTO invoice_line_allocations (
        allocation_set_id, invoice_item_id, bill_to_customer_id,
        split_percentage, amount_cents
      ) VALUES (
        v_set_id,
        (v_split->>'item_id')::uuid,
        (v_split->>'customer_id')::uuid,
        (v_split->>'percentage')::numeric,
        (v_split->>'amount_cents')::bigint
      );
    END IF;
  END LOOP;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, description
  ) VALUES (
    'split_modified', 'split', v_set_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object('version', v_new_version, 'splits', p_splits),
    'Split version ' || v_new_version || ' created for ' || p_entity_type || ' ' || p_entity_id ||
    CASE WHEN p_reason_note IS NOT NULL THEN ' — ' || p_reason_note ELSE '' END
  );

  RETURN v_set_id;
END;
$$;

-- 13j. Create prepay credit
CREATE OR REPLACE FUNCTION create_prepay_credit(
  p_customer_id      uuid,
  p_amount_cents     bigint,
  p_payment_method   text DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes            text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_credit_id uuid;
BEGIN
  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Prepay amount must be positive';
  END IF;

  INSERT INTO prepay_credits (
    customer_id, original_amount_cents, balance_cents,
    payment_method, reference_number, notes
  ) VALUES (
    p_customer_id, p_amount_cents, p_amount_cents,
    p_payment_method, p_reference_number, p_notes
  )
  RETURNING id INTO v_credit_id;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_created', 'prepay', v_credit_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object(
      'customer_id', p_customer_id,
      'amount_cents', p_amount_cents
    ),
    p_amount_cents,
    'Prepay credit of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' created'
  );

  -- Activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('prepay_created',
    'Prepay credit of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' created',
    (SELECT auth.uid()), 'prepay', v_credit_id, p_customer_id
  );

  RETURN v_credit_id;
END;
$$;

-- ===========================================
-- 14. Add sort_order to order_items if missing
-- ===========================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_items' AND column_name = 'sort_order'
  ) THEN
    ALTER TABLE order_items ADD COLUMN sort_order integer DEFAULT 0;
  END IF;
END;
$$;

-- ===========================================
-- Done!
-- ===========================================
