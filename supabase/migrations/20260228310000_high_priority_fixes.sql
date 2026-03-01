-- ============================================================================
-- HIGH-PRIORITY PRE-LAUNCH FIXES
-- Phase 2 of unified audit remediation plan
-- Addresses: H1 (period check in allocate_payment),
--            H2 (audit log for allocate_payment),
--            H3 (FOR UPDATE in receive_po_items),
--            H4 (BEFORE DELETE guards on finalized records),
--            H5 (non-negative money CHECK constraints),
--            H6 (idempotency in complete_delivery)
-- Also fixes: Invoice status trigger gap (posted→paid, overdue transitions)
-- ============================================================================


-- ============================================================================
-- FIX 0: Expand invoice status transition trigger
--
-- The Phase 1 trigger only allows: draft→unposted/posted/cancelled,
-- unposted→posted/cancelled, posted→voided.
--
-- MISSING: posted→paid (when payment zeroes the balance),
--          posted→overdue (aging process), overdue→paid, overdue→voided.
-- Without these, allocate_payment() crashes when fully paying an invoice.
-- ============================================================================

CREATE OR REPLACE FUNCTION _enforce_invoice_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('unposted', 'posted', 'cancelled'))
  OR (OLD.status = 'unposted' AND NEW.status IN ('posted', 'cancelled'))
  OR (OLD.status = 'posted' AND NEW.status IN ('voided', 'paid', 'overdue'))
  OR (OLD.status = 'overdue' AND NEW.status IN ('paid', 'voided'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid invoice status transition: % → %', OLD.status, NEW.status;
END;
$$;


-- ============================================================================
-- H1 + H2: Rewrite allocate_payment() with period check + audit log
--
-- H1: Add check_period_open(p_payment_date) guard — prevents recording
--     payments in closed accounting periods.
-- H2: Insert into financial_audit_log with before/after invoice balances.
-- ============================================================================

CREATE OR REPLACE FUNCTION allocate_payment(
  p_customer_id uuid,
  p_total_cents bigint,
  p_payment_method text,
  p_reference_number text DEFAULT NULL,
  p_check_number text DEFAULT NULL,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_alloc jsonb;
  v_inv record;
  v_alloc_cents bigint;
  v_sum_allocated bigint := 0;
  v_set_id uuid;
  v_current_season integer;
  v_prepay_cents bigint;
  v_result jsonb;
  v_allocation_count integer := 0;
  v_old_balances jsonb := '[]'::jsonb;
  v_new_balances jsonb := '[]'::jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Verify caller
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to allocate payments';
  END IF;

  IF p_total_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- ═══ H1 FIX: Enforce accounting period ═══
  PERFORM check_period_open(p_payment_date);

  -- Determine season (Oct 1 = start of new season)
  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 10
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  -- Create allocation set
  INSERT INTO allocation_sets (
    entity_type, entity_id,
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
    'payment', p_customer_id,
    p_customer_id, p_total_cents, p_payment_method,
    p_reference_number, p_check_number, p_payment_date,
    p_notes, v_current_season, v_actor
  ) RETURNING id INTO v_set_id;

  -- Process allocations
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_cents := (v_alloc->>'amount_cents')::bigint;
    IF v_alloc_cents <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM invoices
    WHERE id = (v_alloc->>'invoice_id')::uuid
      AND customer_id = p_customer_id
      AND status IN ('posted', 'overdue')
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invoice % not found or not eligible for payment', (v_alloc->>'invoice_id');
    END IF;

    IF v_alloc_cents > v_inv.balance_cents THEN
      RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
        v_alloc_cents, v_inv.balance_cents, v_inv.invoice_number;
    END IF;

    -- ═══ H2 FIX: Capture before-state for audit log ═══
    v_old_balances := v_old_balances || jsonb_build_array(jsonb_build_object(
      'invoice_id', v_inv.id,
      'invoice_number', v_inv.invoice_number,
      'balance_before', v_inv.balance_cents,
      'paid_before', v_inv.paid_amount_cents
    ));

    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, amount_cents
    ) VALUES (
      v_set_id, v_inv.id, v_alloc_cents
    );

    -- Update invoice paid_amount_cents
    UPDATE invoices SET
      paid_amount_cents = paid_amount_cents + v_alloc_cents,
      status = CASE
        WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents) <= 0
        THEN 'paid'
        ELSE status
      END,
      updated_at = now()
    WHERE id = v_inv.id;

    -- ═══ H2 FIX: Capture after-state for audit log ═══
    v_new_balances := v_new_balances || jsonb_build_array(jsonb_build_object(
      'invoice_id', v_inv.id,
      'invoice_number', v_inv.invoice_number,
      'balance_after', v_inv.balance_cents - v_alloc_cents,
      'paid_after', v_inv.paid_amount_cents + v_alloc_cents
    ));

    v_sum_allocated := v_sum_allocated + v_alloc_cents;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  -- Update allocation set total
  UPDATE allocation_sets SET
    total_allocated_cents = v_sum_allocated,
    updated_at = now()
  WHERE id = v_set_id;

  -- Handle overpayment → prepay credit
  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      source_type, source_reference, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      'overpayment', 'From payment ' || COALESCE(p_reference_number, p_check_number, v_set_id::text),
      v_actor
    );

    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'payment_allocated',
    'Payment of $' || (p_total_cents / 100.0)::text || ' allocated (' || v_allocation_count || ' invoices)',
    v_actor, 'allocation_set', v_set_id, p_customer_id
  );

  -- ═══ H2 FIX: Financial audit log entry ═══
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, actor_role,
    old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'payment_allocation', 'payment', v_set_id,
    v_actor,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('invoices', v_old_balances),
    jsonb_build_object(
      'invoices', v_new_balances,
      'prepay_created_cents', COALESCE(v_prepay_cents, 0)
    ),
    p_total_cents,
    'Payment $' || (p_total_cents / 100.0)::numeric(12,2) ||
      ' via ' || p_payment_method ||
      ' allocated to ' || v_allocation_count || ' invoice(s)' ||
      CASE WHEN COALESCE(v_prepay_cents, 0) > 0
        THEN ' + $' || (v_prepay_cents / 100.0)::numeric(12,2) || ' to prepay'
        ELSE '' END
  );

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', v_set_id,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'invoices_paid', v_allocation_count
  );

  -- Save idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION allocate_payment(uuid, bigint, text, text, text, date, text, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- H3: Add FOR UPDATE lock to receive_po_items() on purchase_order_items
--
-- Problem: Concurrent receive_po_items calls can read the same
-- quantity_received, both add their qty, and cause a double-count.
-- Fix: Lock the row with FOR UPDATE before reading quantity_received.
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_po_item record;
  v_po record;
  v_qty numeric;
  v_product record;
  v_po_id uuid;
  v_all_received boolean;
  v_any_received boolean;
  v_new_status text;
  v_cached_result jsonb;
  v_result jsonb;
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_recv_id uuid;
  v_condition text;
  v_lot_number text;
  v_notes text;
  v_storage_location text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by
      AND role IN ('admin', 'sales_rep')
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins and sales reps can receive PO items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- ═══ H3 FIX: Lock the row to prevent concurrent double-count ═══
    SELECT * INTO v_po_item FROM purchase_order_items
    WHERE id = (v_item->>'po_item_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN CONTINUE; END IF;

    IF NOT p_allow_over_receive AND v_po_item.quantity_received + v_qty > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %', v_po_item.id;
    END IF;

    v_po_id := v_po_item.purchase_order_id;

    IF NOT v_po_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_id;
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    UPDATE purchase_order_items SET
      quantity_received = quantity_received + v_qty
    WHERE id = v_po_item.id;

    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(quantity_on_order - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_id, p_performed_by,
      'Received ' || v_qty || ' units via PO'
    );

    INSERT INTO receiving_records (
      purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size
    ) VALUES (
      v_po_id, v_po_item.id, v_po_item.product_id,
      v_qty, p_performed_by, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size
    )
    RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF v_product.current_cost IS DISTINCT FROM v_po_item.unit_cost THEN
        INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_note)
        VALUES (v_po_item.product_id, p_performed_by, v_product.current_cost, v_po_item.unit_cost,
                'Auto-updated from PO receiving');

        UPDATE products SET
          current_cost = v_po_item.unit_cost,
          cost_updated_date = now()
        WHERE id = v_po_item.product_id;
      END IF;
    END IF;
  END LOOP;

  -- Update PO statuses with admin override (triggers enforce transitions)
  SET LOCAL app.admin_override = 'true';

  FOREACH v_unique_po_id IN ARRAY v_affected_po_ids
  LOOP
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_unique_po_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT
      bool_and(quantity_received >= quantity_ordered),
      bool_or(quantity_received > 0)
    INTO v_all_received, v_any_received
    FROM purchase_order_items WHERE purchase_order_id = v_unique_po_id;

    v_new_status := CASE
      WHEN v_all_received THEN 'fully_received'
      WHEN v_any_received THEN 'partially_received'
      ELSE v_po.status
    END;

    IF v_new_status IS DISTINCT FROM v_po.status THEN
      UPDATE purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_unique_po_id;
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'po_received',
      'Items received on PO ' || v_po.po_number || ' — inventory updated',
      p_performed_by, 'purchase_order', v_unique_po_id
    );
  END LOOP;

  v_result := jsonb_build_object(
    'status', 'received',
    'receiving_record_ids', v_receiving_record_ids
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- H4: BEFORE DELETE triggers protecting finalized financial records
--
-- Problem: ON DELETE CASCADE can wipe order_items, invoice_items, and
-- delivery_items from finalized (posted/completed/fulfilled) parents.
-- Fix: Trigger on the PARENT table that blocks deletion when the record
-- is in a finalized state. Drafts and cancelled records can be deleted.
-- ============================================================================

-- ─── Orders: protect confirmed/partially_fulfilled/fulfilled ─────────────
CREATE OR REPLACE FUNCTION _guard_order_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF _is_admin_override() THEN RETURN OLD; END IF;

  IF OLD.status IN ('confirmed', 'partially_fulfilled', 'fulfilled') THEN
    RAISE EXCEPTION 'Cannot delete order in % status. Cancel it first.', OLD.status;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_order_delete ON orders;
CREATE TRIGGER guard_order_delete
  BEFORE DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION _guard_order_delete();

-- ─── Invoices: protect posted/paid/overdue/voided ────────────────────────
CREATE OR REPLACE FUNCTION _guard_invoice_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF _is_admin_override() THEN RETURN OLD; END IF;

  IF OLD.status IN ('posted', 'paid', 'overdue', 'voided') THEN
    RAISE EXCEPTION 'Cannot delete invoice in % status. Void it first.', OLD.status;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_invoice_delete ON invoices;
CREATE TRIGGER guard_invoice_delete
  BEFORE DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION _guard_invoice_delete();

-- ─── Deliveries: protect in_progress/completed ──────────────────────────
CREATE OR REPLACE FUNCTION _guard_delivery_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF _is_admin_override() THEN RETURN OLD; END IF;

  IF OLD.status IN ('in_progress', 'completed') THEN
    RAISE EXCEPTION 'Cannot delete delivery in % status. Cancel it first.', OLD.status;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_delivery_delete ON deliveries;
CREATE TRIGGER guard_delivery_delete
  BEFORE DELETE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION _guard_delivery_delete();

-- ─── Purchase Orders: protect submitted/partially_received/fully_received ─
CREATE OR REPLACE FUNCTION _guard_po_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF _is_admin_override() THEN RETURN OLD; END IF;

  IF OLD.status IN ('submitted', 'partially_received', 'fully_received') THEN
    RAISE EXCEPTION 'Cannot delete purchase order in % status. Cancel it first.', OLD.status;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_po_delete ON purchase_orders;
CREATE TRIGGER guard_po_delete
  BEFORE DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION _guard_po_delete();


-- ============================================================================
-- H5: Non-negative CHECK constraints on money columns
--
-- Prevents application bugs from creating negative balances that would
-- corrupt AR reports and customer statements.
-- ============================================================================

-- orders.total_price is numeric, not bigint
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_total_price_non_negative;
ALTER TABLE orders
  ADD CONSTRAINT orders_total_price_non_negative CHECK (total_price >= 0);

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_total_non_negative;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_total_non_negative CHECK (total_amount_cents >= 0);

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_paid_non_negative;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_paid_non_negative CHECK (paid_amount_cents >= 0);

ALTER TABLE prepay_credits
  DROP CONSTRAINT IF EXISTS prepay_balance_non_negative;
ALTER TABLE prepay_credits
  ADD CONSTRAINT prepay_balance_non_negative CHECK (balance_cents >= 0);


-- ============================================================================
-- H6: Wire up idempotency in complete_delivery()
--
-- The function already has p_idempotency_key param and a soft "already
-- completed" check, but it never uses the idempotency_keys infrastructure.
-- This handles the race window between status change and function completion.
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_all_delivered boolean;
  v_qty_to_deliver numeric;
  v_any_partial boolean := false;
  v_linked_invoice record;
  v_old_total bigint;
  v_new_total bigint;
  v_admin record;
  v_deduct_from_prebooked numeric;
  v_deduct_from_available numeric;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- ═══ H6 FIX: Idempotency check ═══
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;

  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;
  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be started before completing. Current status: %', v_delivery.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by AND is_active = true
      AND (role IN ('admin', 'sales_rep') OR (role = 'driver' AND p_performed_by = v_delivery.assigned_driver))
  ) THEN RAISE EXCEPTION 'Not authorized to complete this delivery'; END IF;

  -- PRE-CHECK INVENTORY (accounts for prebooked stock)
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;

    IF NOT FOUND OR (v_inv.quantity_available + v_inv.quantity_prebooked) < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available (% on-hand + % prebooked)',
        v_item.product_name, v_qty_to_deliver,
        COALESCE(v_inv.quantity_available, 0) + COALESCE(v_inv.quantity_prebooked, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  -- Set admin override for status transitions (delivery + order)
  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'completed', completed_at = now(), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, p_performed_by,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END || '. Signed by: ' || p_signed_by
    );

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));
    v_deduct_from_available := v_qty_to_deliver - v_deduct_from_prebooked;

    UPDATE inventory SET
      quantity_available = quantity_available - v_deduct_from_available,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- Mark pending remainders as fulfilled when order is fully delivered
  IF v_all_delivered AND v_delivery.order_id IS NOT NULL THEN
    UPDATE delivery_remainders SET
      status = 'fulfilled',
      updated_at = now()
    WHERE order_id = v_delivery.order_id
      AND status = 'pending';
  END IF;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
    LOOP
      IF v_linked_invoice.status = 'draft' THEN
        v_old_total := v_linked_invoice.total_amount_cents;
        UPDATE invoice_items ii SET
          quantity = oi.quantity_delivered,
          extended_cents = ii.unit_price_cents * oi.quantity_delivered::bigint
        FROM order_items oi
        WHERE ii.invoice_id = v_linked_invoice.id
          AND ii.order_item_id = oi.id
          AND oi.quantity_delivered < oi.total_units_needed;

        SELECT COALESCE(SUM(extended_cents), 0) INTO v_new_total
        FROM invoice_items WHERE invoice_id = v_linked_invoice.id;

        UPDATE invoices SET
          total_amount_cents = v_new_total,
          total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
          updated_at = now()
        WHERE id = v_linked_invoice.id;
      ELSE
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (v_admin.id, 'Partial Delivery — Posted Invoice Needs Review',
            'Delivery ' || v_delivery.delivery_number || ' completed with partial quantities. Invoice ' ||
              v_linked_invoice.invoice_number || ' may need adjustment.',
            'delivery_partial', 'invoice', v_linked_invoice.id);
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed.' ||
      CASE WHEN v_any_partial THEN ' Partial delivery — some items have remainders.' ELSE '' END ||
      ' Signed by: ' || p_signed_by,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'completed', 'delivery_id', p_delivery_id,
    'partial', v_any_partial, 'order_fully_delivered', v_all_delivered
  );

  -- ═══ H6 FIX: Save idempotency result ═══
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;
