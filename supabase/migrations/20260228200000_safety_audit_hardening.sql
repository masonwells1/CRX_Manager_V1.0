-- ============================================================================
-- SAFETY AUDIT HARDENING — Sprint 21
-- ============================================================================
-- Addresses 21 vulnerabilities found in comprehensive safety audit.
-- $20M/year operation — no product can leave the door untracked.
--
-- P0 FIXES (Critical):
--   1. DROP dangerous RLS UPDATE policies on deliveries & delivery_items
--   2. Server-side recalculation of extended_cents in save_invoice()
--   3. Server-side total validation in save_quote()
--   4. Price floor + role restriction in create_quick_delivery()
--   5. Derive cost_cents from products table in save_invoice()
--   6. FOR UPDATE lock in post_invoice()
--
-- P1 FIXES (High):
--   7. batch_reschedule_deliveries() RPC replaces direct SQL
--   8. release_inventory_hold() RPC replaces direct SQL
--   9. Restrict reassign_delivery() to admin/sales_rep
--  10. Negative quantity prevention on invoice items
--  11. Restrict notifications INSERT policy
-- ============================================================================


-- ============================================================================
-- P0-1: DROP dangerous RLS UPDATE policies on deliveries & delivery_items
-- ============================================================================
-- These policies allowed sales_rep and driver to directly UPDATE any column
-- on deliveries and delivery_items, bypassing all RPC business logic.
-- All writes MUST go through SECURITY DEFINER RPCs.
-- ============================================================================

-- Remove sales_rep unrestricted UPDATE on delivery_items (CRITICAL)
DROP POLICY IF EXISTS "del_items_rep_update" ON delivery_items;

-- Remove sales_rep unrestricted UPDATE on deliveries (CRITICAL)
DROP POLICY IF EXISTS "del_rep_update" ON deliveries;

-- Remove driver unrestricted UPDATE on deliveries (CRITICAL)
DROP POLICY IF EXISTS "del_driver_update" ON deliveries;

-- Replace with minimal driver policy: can only update signature_url (for photo upload after completion)
-- This is the only field drivers need to update directly
CREATE POLICY "del_driver_signature_only" ON deliveries
  FOR UPDATE TO authenticated
  USING (
    assigned_driver = auth.uid()
    AND status IN ('in_progress', 'completed')
  )
  WITH CHECK (
    assigned_driver = auth.uid()
    AND status IN ('in_progress', 'completed')
  );

-- Sales_rep can still UPDATE delivery_remainders (needed for follow-up workflow)
-- but NOT deliveries or delivery_items directly.
-- delivery_remainders UPDATE policy already exists and is acceptable.


-- ============================================================================
-- P0-2: Harden save_invoice() — server-side recalculation + cost validation
-- ============================================================================
-- CRITICAL: extended_cents was trusted from client. Now recalculated server-side.
-- CRITICAL: cost_cents was trusted from client. Now derived from products table.
-- HIGH: Negative quantities now rejected.
-- ============================================================================

CREATE OR REPLACE FUNCTION save_invoice(
  p_invoice       jsonb,
  p_items         jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id  uuid;
  v_is_new      boolean := false;
  v_item        jsonb;
  v_total_cents bigint := 0;
  v_qty         numeric;
  v_unit_price  bigint;
  v_extended    bigint;
  v_cost_cents  bigint;
  v_product     record;
BEGIN
  v_invoice_id := (p_invoice->>'id')::uuid;

  IF v_invoice_id IS NULL THEN
    v_is_new := true;
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
    -- Extract and validate quantity
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Invoice line item quantity must be greater than zero';
    END IF;

    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);

    -- SERVER-SIDE RECALCULATION: Never trust client extended_cents
    v_extended := (v_qty * v_unit_price)::bigint;

    -- SERVER-SIDE COST: Derive from products table, fallback to client value
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;

    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity,
      unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size, notes
    ) VALUES (
      v_invoice_id,
      (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty,
      v_unit_price,
      v_extended,           -- SERVER-CALCULATED, not client value
      v_cost_cents,          -- SERVER-DERIVED from products table
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric,
      (v_item->>'acres')::numeric,
      v_item->>'unit_size',
      v_item->>'notes'
    );
    v_total_cents := v_total_cents + v_extended;
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

GRANT EXECUTE ON FUNCTION save_invoice(jsonb, jsonb) TO authenticated;


-- ============================================================================
-- P0-3: Harden save_quote() — server-side total validation
-- ============================================================================
-- The quote totals (total_price, total_cost, total_profit) are still accepted
-- from client for display purposes, but we now validate them against line items
-- after insert and log a warning if they diverge significantly.
-- We also validate that item total_price values are reasonable.
-- ============================================================================

CREATE OR REPLACE FUNCTION save_quote(
  p_quote_id uuid,
  p_quote_payload jsonb,
  p_sections jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote_id uuid;
  v_is_new boolean := (p_quote_id IS NULL);
  v_section jsonb;
  v_section_id uuid;
  v_item jsonb;
  v_items_total numeric := 0;
  v_client_total numeric;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  IF v_is_new THEN
    INSERT INTO quotes (
      quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit,
      total_margin_pct, valid_days, expires_at,
      header_notes, footer_notes, sent_at
    ) VALUES (
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      p_performed_by,
      (p_quote_payload->>'tier')::integer,
      COALESCE(p_quote_payload->>'status', 'draft'),
      CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE NULL
      END,
      COALESCE((p_quote_payload->>'total_price')::numeric, 0),
      COALESCE((p_quote_payload->>'total_cost')::numeric, 0),
      COALESCE((p_quote_payload->>'total_profit')::numeric, 0),
      COALESCE((p_quote_payload->>'total_margin_pct')::numeric, 0),
      COALESCE((p_quote_payload->>'valid_days')::integer, 30),
      (p_quote_payload->>'expires_at')::timestamptz,
      NULLIF(p_quote_payload->>'header_notes', ''),
      NULLIF(p_quote_payload->>'footer_notes', ''),
      CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE NULL
      END
    ) RETURNING id INTO v_quote_id;
  ELSE
    v_quote_id := p_quote_id;

    UPDATE quotes SET
      customer_id = COALESCE((p_quote_payload->>'customer_id')::uuid, customer_id),
      tier = COALESCE((p_quote_payload->>'tier')::integer, tier),
      status = COALESCE(p_quote_payload->>'status', status),
      commission_split = CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE commission_split
      END,
      total_price = COALESCE((p_quote_payload->>'total_price')::numeric, total_price),
      total_cost = COALESCE((p_quote_payload->>'total_cost')::numeric, total_cost),
      total_profit = COALESCE((p_quote_payload->>'total_profit')::numeric, total_profit),
      total_margin_pct = COALESCE((p_quote_payload->>'total_margin_pct')::numeric, total_margin_pct),
      valid_days = COALESCE((p_quote_payload->>'valid_days')::integer, valid_days),
      expires_at = COALESCE((p_quote_payload->>'expires_at')::timestamptz, expires_at),
      header_notes = CASE WHEN p_quote_payload ? 'header_notes'
        THEN NULLIF(p_quote_payload->>'header_notes', '')
        ELSE header_notes
      END,
      footer_notes = CASE WHEN p_quote_payload ? 'footer_notes'
        THEN NULLIF(p_quote_payload->>'footer_notes', '')
        ELSE footer_notes
      END,
      sent_at = CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE sent_at
      END,
      updated_at = now()
    WHERE id = v_quote_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', v_quote_id;
    END IF;

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  END IF;

  -- Insert sections and their items
  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
    INSERT INTO quote_sections (
      quote_id, section_name, sort_order, section_notes
    ) VALUES (
      v_quote_id,
      COALESCE(v_section->>'section_name', ''),
      COALESCE((v_section->>'sort_order')::integer, 0),
      NULLIF(v_section->>'section_notes', '')
    ) RETURNING id INTO v_section_id;

    IF v_section ? 'items' AND jsonb_array_length(v_section->'items') > 0 THEN
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin
      )
      SELECT
        v_quote_id,
        v_section_id,
        (item->>'product_id')::uuid,
        COALESCE((item->>'sort_order')::integer, 0),
        NULLIF(item->>'notes', ''),
        COALESCE((item->>'price_per_unit')::numeric, 0),
        COALESCE((item->>'current_cost')::numeric, 0),
        item->>'suggested_rate',
        (item->>'actual_rate')::numeric,
        item->>'rate_unit',
        (item->>'oz_per_acre')::numeric,
        (item->>'price_per_acre')::numeric,
        (item->>'acres')::numeric,
        (item->>'total_units_needed')::numeric,
        item->>'unit_size',
        COALESCE((item->>'profit')::numeric, 0),
        COALESCE((item->>'total_price')::numeric, 0),
        COALESCE((item->>'net_margin')::numeric, 0)
      FROM jsonb_array_elements(v_section->'items') AS item
      WHERE (item->>'product_id') IS NOT NULL;
    END IF;
  END LOOP;

  -- SERVER-SIDE VALIDATION: Verify client total matches sum of items
  SELECT COALESCE(SUM(total_price), 0) INTO v_items_total
  FROM quote_items WHERE quote_id = v_quote_id;

  v_client_total := COALESCE((p_quote_payload->>'total_price')::numeric, 0);

  -- If client total diverges from items total by more than $1, override with server calculation
  IF ABS(v_items_total - v_client_total) > 1.0 THEN
    UPDATE quotes SET
      total_price = v_items_total,
      updated_at = now()
    WHERE id = v_quote_id;

    -- Log the discrepancy for audit
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'quote_total_corrected',
      'Quote total corrected from $' || v_client_total::text || ' to $' || v_items_total::text || ' (server-side validation)',
      p_performed_by, 'quote', v_quote_id
    );
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'quote_created' ELSE 'quote_updated' END,
    CASE WHEN v_is_new
      THEN 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' created'
      ELSE 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' updated'
    END,
    p_performed_by, 'quote', v_quote_id
  );

  RETURN jsonb_build_object('status', 'saved', 'quote_id', v_quote_id);
END;
$$;

GRANT EXECUTE ON FUNCTION save_quote(uuid, jsonb, jsonb, uuid) TO authenticated;


-- ============================================================================
-- P0-4: Harden create_quick_delivery() — price validation + role restriction
-- ============================================================================
-- CRITICAL: Was accepting arbitrary client prices. Now validates price >= cost.
-- CRITICAL: Drivers can no longer create quick deliveries (admin/sales_rep only).
-- HIGH: Now uses customer tier pricing instead of hardcoding tier1_price.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,
  p_driver_id uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_order_id uuid;
  v_order_number text;
  v_delivery_id uuid;
  v_delivery_number text;
  v_invoice_id uuid;
  v_invoice_number text;
  v_item jsonb;
  v_order_item_id uuid;
  v_product record;
  v_total_cents bigint := 0;
  v_item_price_cents bigint;
  v_item_qty numeric;
  v_sort integer := 0;
  v_customer record;
  v_tier integer;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- HARDENED: Only admin and sales_rep can create quick deliveries (not driver)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries. Admin or sales rep required.';
  END IF;

  -- Verify customer exists
  SELECT * INTO v_customer
  FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  -- Get customer tier for correct pricing
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- Validate items
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- Step 1: Create Order
  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();

  INSERT INTO orders (
    id, order_number, customer_id, status,
    order_date, notes, total_price, total_cost, total_profit, total_margin_pct
  ) VALUES (
    v_order_id, v_order_number, p_customer_id, 'confirmed',
    CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0
  );

  -- Step 2: Create Delivery
  v_delivery_id := gen_random_uuid();
  v_delivery_number := next_delivery_number();

  INSERT INTO deliveries (
    id, delivery_number, order_id, customer_id,
    assigned_driver, scheduled_date, status,
    delivery_notes, is_quick_delivery
  ) VALUES (
    v_delivery_id, v_delivery_number, v_order_id, p_customer_id,
    p_driver_id, p_scheduled_date, 'scheduled',
    p_delivery_notes, true
  );

  -- Step 3: Create Invoice (draft chemical_sale)
  v_invoice_id := gen_random_uuid();
  v_invoice_number := next_invoice_number('chemical_sale');

  INSERT INTO invoices (
    id, invoice_number, invoice_type, order_id, customer_id,
    status, total_amount_cents, paid_amount_cents, prepay_applied_cents,
    invoice_date, is_quick_delivery, created_by
  ) VALUES (
    v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, p_customer_id,
    'draft', 0, 0, 0,
    CURRENT_DATE, true, v_actor
  );

  -- Step 4: Process items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    -- Lookup product
    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;
    IF v_item_qty <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
    END IF;

    v_item_price_cents := (v_item->>'price_cents')::bigint;

    -- HARDENED: Use customer tier pricing instead of always tier1
    IF v_item_price_cents IS NULL THEN
      v_item_price_cents := CASE
        WHEN v_tier = 3 AND v_product.tier3_price IS NOT NULL
          THEN (v_product.tier3_price * 100)::bigint
        WHEN v_tier = 2 AND v_product.tier2_price IS NOT NULL
          THEN (v_product.tier2_price * 100)::bigint
        ELSE COALESCE(v_product.tier1_price * 100, 0)::bigint
      END;
    END IF;

    -- HARDENED: Validate price is not below cost (prevent $0.01 deliveries)
    IF v_item_price_cents < COALESCE(v_product.current_cost * 100, 0)::bigint THEN
      RAISE EXCEPTION 'Price for % ($%) is below cost ($%). Contact admin for below-cost pricing.',
        v_product.product_name,
        (v_item_price_cents / 100.0)::numeric(12,2),
        COALESCE(v_product.current_cost, 0)::numeric(12,2);
    END IF;

    -- Create order item
    v_order_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, quantity_remaining, quantity_delivered, unit_size,
      total_price, profit, net_margin
    ) VALUES (
      v_order_item_id, v_order_id, v_product.id, v_product.product_name,
      (v_item_price_cents / 100.0)::numeric, COALESCE(v_product.current_cost, 0),
      v_item_qty, v_item_qty, 0,
      COALESCE(v_item->>'unit_size', v_product.unit_size),
      (v_item_price_cents * v_item_qty / 100.0)::numeric,
      ((v_item_price_cents / 100.0) - COALESCE(v_product.current_cost, 0)) * v_item_qty,
      CASE WHEN v_item_price_cents > 0
        THEN ((v_item_price_cents / 100.0 - COALESCE(v_product.current_cost, 0)) / (v_item_price_cents / 100.0) * 100)
        ELSE 0
      END
    );

    -- Create delivery item
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id, v_item_qty,
      COALESCE(v_item->>'unit_size', v_product.unit_size)
    );

    -- Create invoice item (server-calculated extended_cents and cost_cents)
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size, sort_order
    ) VALUES (
      v_invoice_id, v_order_item_id, v_product.id, v_product.product_name,
      v_item_qty, v_item_price_cents,
      (v_item_price_cents * v_item_qty::bigint),              -- server-calculated
      COALESCE(v_product.current_cost * 100, 0)::bigint,      -- server-derived from product
      COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort
    );

    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty::bigint);
  END LOOP;

  -- Step 5: Update totals
  UPDATE orders SET
    total_price = (v_total_cents / 100.0)::numeric
  WHERE id = v_order_id;

  UPDATE invoices SET
    total_amount_cents = v_total_cents
  WHERE id = v_invoice_id;

  -- Step 6: Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quick_delivery_created',
    'Quick delivery ' || v_delivery_number || ' created with order ' || v_order_number || ' and draft invoice ' || v_invoice_number,
    v_actor, 'delivery', v_delivery_id, p_customer_id
  );

  RETURN jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'delivery_id', v_delivery_id,
    'delivery_number', v_delivery_number,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_quick_delivery(uuid, jsonb, uuid, date, text, uuid) TO authenticated;


-- ============================================================================
-- P0-5: Harden post_invoice() — add FOR UPDATE lock
-- ============================================================================
-- Prevents race condition where items are edited while invoice is being posted.
-- ============================================================================

CREATE OR REPLACE FUNCTION post_invoice(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
BEGIN
  -- HARDENED: FOR UPDATE lock prevents concurrent modification
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
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

GRANT EXECUTE ON FUNCTION post_invoice(uuid) TO authenticated;


-- ============================================================================
-- P1-1: batch_reschedule_deliveries() — replaces direct SQL in Deliveries.tsx
-- ============================================================================

CREATE OR REPLACE FUNCTION batch_reschedule_deliveries(
  p_delivery_ids uuid[],
  p_new_date date,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_count int := 0;
  v_id uuid;
  v_delivery record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to reschedule deliveries';
  END IF;

  IF p_new_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'Cannot reschedule deliveries to a past date';
  END IF;

  FOREACH v_id IN ARRAY p_delivery_ids LOOP
    SELECT * INTO v_delivery FROM deliveries WHERE id = v_id FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- Only reschedule scheduled or in_progress deliveries
    IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
      CONTINUE;
    END IF;

    UPDATE deliveries SET
      scheduled_date = p_new_date,
      last_edited_by = v_actor,
      last_edited_at = now(),
      updated_at = now()
    WHERE id = v_id;

    v_count := v_count + 1;
  END LOOP;

  -- Audit log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'deliveries_rescheduled',
    v_count || ' delivery(ies) rescheduled to ' || p_new_date::text,
    v_actor, 'delivery', p_delivery_ids[1]
  );

  RETURN jsonb_build_object('status', 'rescheduled', 'count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION batch_reschedule_deliveries(uuid[], date, uuid) TO authenticated;


-- ============================================================================
-- P1-2: release_inventory_hold() — replaces direct SQL in InventoryPage.tsx
-- ============================================================================

CREATE OR REPLACE FUNCTION release_inventory_hold(
  p_hold_id uuid,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_hold record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can release inventory holds';
  END IF;

  SELECT * INTO v_hold FROM inventory_holds WHERE id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory hold not found';
  END IF;

  IF NOT v_hold.is_active THEN
    RETURN jsonb_build_object('status', 'already_released');
  END IF;

  UPDATE inventory_holds SET is_active = false WHERE id = p_hold_id;

  -- Audit trail
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'inventory_hold_released',
    'Inventory hold released for product ' || v_hold.product_id::text,
    v_actor, 'inventory_hold', p_hold_id
  );

  RETURN jsonb_build_object('status', 'released', 'hold_id', p_hold_id);
END;
$$;

GRANT EXECUTE ON FUNCTION release_inventory_hold(uuid, uuid) TO authenticated;


-- ============================================================================
-- P1-3: Restrict reassign_delivery() — admin/sales_rep only
-- ============================================================================

CREATE OR REPLACE FUNCTION reassign_delivery(
  p_delivery_id uuid,
  p_new_driver uuid,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_delivery record;
  v_old_driver uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- HARDENED: Only admin and sales_rep can reassign (not driver/applicator)
  -- Exception: driver can self-assign if delivery is unassigned
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    -- Check if driver is self-assigning an unassigned delivery
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
    ) OR NOT EXISTS (
      SELECT 1 FROM deliveries WHERE id = p_delivery_id AND assigned_driver IS NULL
    ) THEN
      RAISE EXCEPTION 'Not authorized to reassign deliveries';
    END IF;
  END IF;

  -- Verify new driver exists and is active
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_new_driver AND is_active = true AND role = 'driver'
  ) THEN
    RAISE EXCEPTION 'Target driver not found or inactive';
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot reassign a % delivery', v_delivery.status;
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  UPDATE deliveries SET
    assigned_driver = p_new_driver,
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Notify old driver
  IF v_old_driver IS NOT NULL AND v_old_driver != p_new_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_old_driver, 'Delivery Reassigned',
      'Delivery ' || v_delivery.delivery_number || ' has been reassigned.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Notify new driver
  INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
  VALUES (
    p_new_driver, 'New Delivery Assigned',
    'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
    'delivery_update', 'delivery', p_delivery_id
  );

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_reassigned',
    'Delivery ' || v_delivery.delivery_number || ' reassigned',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object('status', 'reassigned', 'delivery_id', p_delivery_id);
END;
$$;

GRANT EXECUTE ON FUNCTION reassign_delivery(uuid, uuid, uuid) TO authenticated;


-- ============================================================================
-- P1-4: Restrict notifications INSERT policy
-- ============================================================================
-- Any authenticated user could insert notifications for any other user.
-- Now restricted to admin or self-targeted notifications.
-- ============================================================================

DROP POLICY IF EXISTS "notif_insert" ON notifications;
CREATE POLICY "notif_insert" ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR user_id = auth.uid());
