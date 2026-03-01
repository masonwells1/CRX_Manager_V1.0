-- ============================================================================
-- CRITICAL PRE-LAUNCH FIXES
-- Phase 1 of unified audit remediation plan
-- Addresses: C1 (prepay batch wrong overload), C2 (tote regression),
--            C3 (status transition enforcement)
-- ============================================================================

-- ============================================================================
-- C1: Fix batch_apply_prepayments() calling wrong overload
--
-- Problem: batch_apply_prepayments() calls the 4-parameter overload of
-- apply_prepay_to_invoice() which writes to invoices.balance_cents — a
-- GENERATED ALWAYS column. PostgreSQL silently ignores the write, so customer
-- prepay balance drops but invoice balance stays the same. Money vanishes.
--
-- Fix: Drop the 4-param overload, rewrite batch to call the correct 3-param
-- version that updates invoices.prepay_applied_cents (the component column).
-- ============================================================================

-- Drop the broken 4-parameter overload
DROP FUNCTION IF EXISTS public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid);

-- Rewrite batch_apply_prepayments to call the correct 3-parameter version
CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(
  p_allocations jsonb,  -- [{prepay_credit_id, invoice_id, amount_cents}]
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alloc jsonb;
  v_result_ids uuid[] := ARRAY[]::uuid[];
  v_result_id uuid;
  v_total_applied bigint := 0;
  v_count integer := 0;
BEGIN
  -- Enforce accounting period
  PERFORM check_period_open(CURRENT_DATE);

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    -- Call the correct 3-parameter overload that updates prepay_applied_cents
    v_result_id := apply_prepay_to_invoice(
      (v_alloc->>'prepay_credit_id')::uuid,
      (v_alloc->>'invoice_id')::uuid,
      (v_alloc->>'amount_cents')::bigint
    );
    v_result_ids := array_append(v_result_ids, v_result_id);
    v_total_applied := v_total_applied + (v_alloc->>'amount_cents')::bigint;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'applied_count', v_count,
    'total_applied_cents', v_total_applied,
    'application_ids', to_jsonb(v_result_ids)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION batch_apply_prepayments(jsonb, uuid) TO authenticated;

-- ============================================================================
-- C2: Re-apply tote_number to create_quick_delivery()
--
-- Problem: Migration 20260315200000 (emergency fixes) overwrote the
-- tote-threaded version from 20260301100001. Quick deliveries don't carry
-- tote_number to delivery_items or invoice_items.
--
-- Fix: CREATE OR REPLACE with tote_number included in both INSERTs.
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
  v_inv record;
  v_total_cents bigint := 0;
  v_total_cost_cents bigint := 0;
  v_item_price_cents bigint;
  v_item_qty numeric;
  v_sort integer := 0;
  v_customer record;
  v_split jsonb;
  v_split_entry jsonb;
  v_order_profit numeric;
  v_split_total numeric;
  v_net_available numeric;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  SELECT * INTO v_customer
  FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- Pre-check inventory availability before creating anything
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_product.id AND location = 'Main Warehouse'
    FOR UPDATE;

    -- Subtract prebooked from available for net free check
    v_net_available := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);

    IF NOT FOUND OR v_net_available < v_item_qty THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net available (% on hand, % prebooked)',
        v_product.product_name,
        v_item_qty,
        GREATEST(v_net_available, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  -- Commission split from customer settings
  v_split := v_customer.default_commission_split;

  -- Validate commission splits sum to 100%
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
    INTO v_split_total
    FROM jsonb_array_elements(v_split->'splits') elem;

    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %.2f%%). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  -- Step 1: Create Order
  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();

  INSERT INTO orders (
    id, order_number, customer_id, status,
    order_date, notes, total_price, total_cost, total_profit, total_margin_pct,
    commission_split
  ) VALUES (
    v_order_id, v_order_number, p_customer_id, 'confirmed',
    CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0,
    v_customer.default_commission_split
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

  -- Step 3: Create Invoice (draft)
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

  -- Step 4: Process items with tote_number threading (C2 fix)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;
    v_item_price_cents := (v_item->>'price_cents')::bigint;

    IF v_item_price_cents IS NULL THEN
      v_item_price_cents := CASE COALESCE(v_customer.assigned_tier, 1)
        WHEN 1 THEN COALESCE(v_product.tier1_price * 100, 0)::bigint
        WHEN 2 THEN COALESCE(v_product.tier2_price * 100, v_product.tier1_price * 100, 0)::bigint
        WHEN 3 THEN COALESCE(v_product.tier3_price * 100, v_product.tier1_price * 100, 0)::bigint
        ELSE COALESCE(v_product.tier1_price * 100, 0)::bigint
      END;
    END IF;

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

    -- C2 FIX: Include tote_number in delivery_items INSERT
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size, tote_number
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id, v_item_qty,
      COALESCE(v_item->>'unit_size', v_product.unit_size),
      v_item->>'tote_number'
    );

    -- C2 FIX: Include tote_number in invoice_items INSERT
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size, sort_order, tote_number
    ) VALUES (
      v_invoice_id, v_order_item_id, v_product.id, v_product.product_name,
      v_item_qty, v_item_price_cents, v_item_price_cents * v_item_qty::bigint,
      COALESCE(v_product.current_cost * 100, 0)::bigint,
      COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort,
      v_item->>'tote_number'
    );

    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty::bigint);
    v_total_cost_cents := v_total_cost_cents + (COALESCE(v_product.current_cost * 100, 0)::bigint * v_item_qty::bigint);
  END LOOP;

  -- Step 5: Update totals
  v_order_profit := ((v_total_cents - v_total_cost_cents) / 100.0)::numeric;

  UPDATE orders SET
    total_price = (v_total_cents / 100.0)::numeric,
    total_cost = (v_total_cost_cents / 100.0)::numeric,
    total_profit = v_order_profit,
    total_margin_pct = CASE WHEN v_total_cents > 0
      THEN ((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100)
      ELSE 0 END
  WHERE id = v_order_id;

  UPDATE invoices SET
    total_amount_cents = v_total_cents,
    total_cost_cents = v_total_cost_cents
  WHERE id = v_invoice_id;

  -- Generate commissions
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    FOR v_split_entry IN SELECT * FROM jsonb_array_elements(v_split->'splits')
    LOOP
      INSERT INTO commissions (
        order_id, customer_id, recipient,
        split_percentage, commission_amount, order_profit,
        order_date, status
      ) VALUES (
        v_order_id, p_customer_id,
        COALESCE(v_split_entry->>'recipient', v_split_entry->>'name', 'Unknown'),
        (v_split_entry->>'percentage')::numeric,
        v_order_profit * ((v_split_entry->>'percentage')::numeric / 100.0),
        v_order_profit,
        CURRENT_DATE,
        'pending'
      );
    END LOOP;
  END IF;

  -- Activity log
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
-- C3: Status transition enforcement triggers with admin override
--
-- Problem: Direct .update({ status: 'completed' }) calls bypass RPC business
-- logic. A CHECK constraint validates status VALUES but not TRANSITIONS.
--
-- Fix: Add BEFORE UPDATE triggers for each lifecycle table that validate
-- old -> new status transitions. RPCs call SET LOCAL app.admin_override = 'true'
-- before status changes; direct client calls don't have this set.
-- ============================================================================

-- Helper: Check if admin override is set (RPCs set this before status changes)
CREATE OR REPLACE FUNCTION _is_admin_override()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.admin_override', true) = 'true';
$$;

-- ─── Orders ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  -- Valid transitions
  IF (OLD.status = 'confirmed' AND NEW.status IN ('partially_fulfilled', 'fulfilled', 'cancelled'))
  OR (OLD.status = 'partially_fulfilled' AND NEW.status IN ('fulfilled', 'cancelled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid order status transition: % → %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS enforce_order_status_transition ON orders;
CREATE TRIGGER enforce_order_status_transition
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION _enforce_order_status_transition();

-- ─── Deliveries ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _enforce_delivery_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'cancelled'))
  OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'cancelled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid delivery status transition: % → %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS enforce_delivery_status_transition ON deliveries;
CREATE TRIGGER enforce_delivery_status_transition
  BEFORE UPDATE OF status ON deliveries
  FOR EACH ROW EXECUTE FUNCTION _enforce_delivery_status_transition();

-- ─── Invoices ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _enforce_invoice_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('unposted', 'posted', 'cancelled'))
  OR (OLD.status = 'unposted' AND NEW.status IN ('posted', 'cancelled'))
  OR (OLD.status = 'posted' AND NEW.status = 'voided')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid invoice status transition: % → %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS enforce_invoice_status_transition ON invoices;
CREATE TRIGGER enforce_invoice_status_transition
  BEFORE UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION _enforce_invoice_status_transition();

-- ─── Quotes ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _enforce_quote_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled'))
  OR (OLD.status = 'sent' AND NEW.status IN ('revised', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'revised' AND NEW.status IN ('sent', 'accepted', 'declined', 'expired', 'cancelled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS enforce_quote_status_transition ON quotes;
CREATE TRIGGER enforce_quote_status_transition
  BEFORE UPDATE OF status ON quotes
  FOR EACH ROW EXECUTE FUNCTION _enforce_quote_status_transition();

-- ─── Jobs ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _enforce_job_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  -- Any status → cancelled is always allowed
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  IF (OLD.status = 'scheduled' AND NEW.status = 'in_progress')
  OR (OLD.status = 'in_progress' AND NEW.status = 'completed')
  OR (OLD.status = 'completed' AND NEW.status = 'invoiced')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid job status transition: % → %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS enforce_job_status_transition ON jobs;
CREATE TRIGGER enforce_job_status_transition
  BEFORE UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION _enforce_job_status_transition();

-- ─── Purchase Orders ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _enforce_po_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
  OR (OLD.status = 'submitted' AND NEW.status IN ('partially_received', 'fully_received', 'cancelled'))
  OR (OLD.status = 'partially_received' AND NEW.status IN ('fully_received', 'cancelled'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid purchase order status transition: % → %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS enforce_po_status_transition ON purchase_orders;
CREATE TRIGGER enforce_po_status_transition
  BEFORE UPDATE OF status ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION _enforce_po_status_transition();

-- ─── Returns ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _enforce_return_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected'))
  OR (OLD.status = 'approved' AND NEW.status = 'received')
  OR (OLD.status = 'received' AND NEW.status = 'credited')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid return status transition: % → %', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS enforce_return_status_transition ON returns;
CREATE TRIGGER enforce_return_status_transition
  BEFORE UPDATE OF status ON returns
  FOR EACH ROW EXECUTE FUNCTION _enforce_return_status_transition();

-- ============================================================================
-- Update existing RPCs that change status to use admin override
-- This ensures RPCs can still change status while direct client calls are blocked
-- ============================================================================

-- Helper to set admin override within a transaction
-- RPCs should call: SET LOCAL app.admin_override = 'true';
-- before any status UPDATE. This is already done via SET LOCAL in individual RPCs.
-- No additional changes needed here — the triggers check current_setting.
-- RPCs that change status already operate within a transaction, so they just
-- need SET LOCAL added to their body.

-- NOTE: The existing RPCs (confirm_delivery, complete_delivery, post_invoice,
-- void_invoice, cancel_order, cancel_delivery, etc.) should have
--   SET LOCAL app.admin_override = 'true';
-- added before their status UPDATE statements. This is done in Phase 2 as
-- part of the RPC updates, since those RPCs are being modified anyway.
-- For now, the admin override check via _is_admin_override() will return false
-- for direct client calls (which is the desired behavior), and RPCs that
-- already handle their own status logic will need the SET LOCAL added.
--
-- IMPORTANT: We add SET LOCAL to the critical RPCs here to avoid breakage:

-- confirm_delivery needs override
CREATE OR REPLACE FUNCTION confirm_delivery(p_delivery_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
BEGIN
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status != 'scheduled' THEN
    RAISE EXCEPTION 'Delivery must be scheduled to confirm (current: %)', v_delivery.status;
  END IF;

  SET LOCAL app.admin_override = 'true';
  UPDATE deliveries SET status = 'in_progress', updated_at = now() WHERE id = p_delivery_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_confirmed', 'Delivery ' || v_delivery.delivery_number || ' confirmed (in progress)', auth.uid(), 'delivery', p_delivery_id, v_delivery.customer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_delivery(uuid) TO authenticated;

-- cancel_order needs override (it also cancels deliveries)
-- We add SET LOCAL before the status updates
CREATE OR REPLACE FUNCTION cancel_order(p_order_id uuid, p_reason text DEFAULT 'Cancelled')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_del record;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.status IN ('fulfilled', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot cancel order with status: %', v_order.status;
  END IF;

  SET LOCAL app.admin_override = 'true';

  -- Cancel all non-completed deliveries
  FOR v_del IN SELECT * FROM deliveries WHERE order_id = p_order_id AND status NOT IN ('completed', 'cancelled') FOR UPDATE
  LOOP
    UPDATE deliveries SET status = 'cancelled', updated_at = now() WHERE id = v_del.id;
  END LOOP;

  -- Cancel draft/unposted invoices
  UPDATE invoices SET status = 'cancelled', updated_at = now()
  WHERE order_id = p_order_id AND status IN ('draft', 'unposted');

  UPDATE orders SET status = 'cancelled', notes = COALESCE(notes, '') || ' | Cancelled: ' || p_reason, updated_at = now()
  WHERE id = p_order_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('order_cancelled', 'Order ' || v_order.order_number || ' cancelled: ' || p_reason, auth.uid(), 'order', p_order_id, v_order.customer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, text) TO authenticated;

-- cancel_delivery needs override
CREATE OR REPLACE FUNCTION cancel_delivery(p_delivery_id uuid, p_reason text DEFAULT 'Cancelled')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_item record;
BEGIN
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot cancel a completed delivery';
  END IF;
  IF v_delivery.status = 'cancelled' THEN
    RETURN; -- already cancelled, idempotent
  END IF;

  SET LOCAL app.admin_override = 'true';

  -- If delivery was in_progress, restore prebooked inventory
  IF v_delivery.status = 'in_progress' THEN
    FOR v_item IN
      SELECT di.*, oi.product_id as oi_product_id
      FROM delivery_items di
      JOIN order_items oi ON oi.id = di.order_item_id
      WHERE di.delivery_id = p_delivery_id
    LOOP
      UPDATE inventory
      SET quantity_prebooked = GREATEST(quantity_prebooked - v_item.quantity, 0),
          updated_at = now()
      WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    END LOOP;
  END IF;

  UPDATE deliveries SET
    status = 'cancelled',
    delivery_notes = COALESCE(delivery_notes, '') || ' | Cancelled: ' || p_reason,
    updated_at = now()
  WHERE id = p_delivery_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled: ' || p_reason, auth.uid(), 'delivery', p_delivery_id, v_delivery.customer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_delivery(uuid, text) TO authenticated;
