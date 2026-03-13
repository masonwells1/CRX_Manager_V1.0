-- ============================================================================
-- Pre-Launch Critical Fixes
--
-- This migration fixes all bugs found during the pre-go-live audit.
-- Timestamp intentionally after 20260329100000 to override all prior versions.
--
-- Fixes:
--   1. complete_delivery: inventory inflation — prebooked deliveries never deducted physical stock
--   2. receive_po_items: missing auth/role check + restore p_skip_cost_update DEFAULT true
--   3. void_invoice: wrong column name (amount_cents vs applied_amount_cents),
--      queries deleted rows, missing auth + period check
--   4. create_direct_order: missing commission creation
--   5. calculate_prices_from_margin: SECURITY DEFINER without SET search_path
--   6. receive_return: LATERAL subquery missing location filter
--   7. create_commission_payment: season calc uses >= 7 instead of >= 10
-- ============================================================================


-- ============================================================================
-- FIX 1: complete_delivery — inventory inflation bug
--
-- BUG: Prebooked deliveries only deducted the non-prebooked portion from
-- quantity_available, so physical stock never decreased for prebooked items.
-- FIX: Always deduct FULL delivery quantity from quantity_available.
-- ============================================================================

-- We only patch the inventory-deduction loop portion via a full function replace.
-- The function signature and all other logic remain identical to wave4.

CREATE OR REPLACE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_net_free numeric;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can complete deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  IF v_delivery.status = 'completed' THEN RAISE EXCEPTION 'Delivery already completed'; END IF;
  IF v_delivery.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot complete a cancelled delivery'; END IF;

  -- Phase 1: Validate inventory availability
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

    v_net_free := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);

    IF NOT FOUND OR v_net_free < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net free (% on-hand, % prebooked)',
        v_item.product_name, v_qty_to_deliver,
        GREATEST(v_net_free, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  -- Phase 2: Update delivery status
  UPDATE deliveries SET
    status = 'completed', completed_at = now(), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  -- Phase 3: Process each item
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
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END || '. Signed by: ' || p_signed_by
    );

    -- *** FIX: Deduct FULL delivery qty from available, reduce prebooked separately ***
    -- quantity_available tracks physical stock on hand.
    -- quantity_prebooked is a sub-count WITHIN available that's committed to orders.
    -- When we deliver, physical stock decreases by the full amount delivered.
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,         -- FIXED: was only deducting non-prebooked portion
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,  -- Release prebooked commitment
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- Phase 4: Handle partial deliveries → create remainders
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

  -- Phase 5: Update order fulfillment status
  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- Phase 6: Auto-adjust linked draft invoices for partial deliveries
  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = ROUND(di.quantity_delivered * ii.unit_price_cents)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id
        AND ii.invoice_id = v_linked_invoice.id
        AND ii.product_id = di.product_id;

      UPDATE invoices SET
        total_amount_cents = (
          SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id
        ),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- FIX 2: receive_po_items — restore auth check + p_skip_cost_update DEFAULT true
--
-- BUG: Migration 20260329 dropped the role check from wave4 and reset
-- p_skip_cost_update default from true back to false.
-- FIX: Add role check, restore DEFAULT true.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.receive_po_items(
  p_purchase_order_id uuid,
  p_items jsonb,
  p_received_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_skip_cost_update boolean DEFAULT true   -- FIXED: was false, must be true per business rule
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_po_item RECORD;
  v_po RECORD;
  v_existing jsonb;
  v_result jsonb;
  v_recv_id uuid;
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_qty_received numeric;
  v_actor uuid;
  v_actor_role text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
  v_product RECORD;
  v_current_qty numeric;
  v_new_cost numeric;
BEGIN
  v_actor := COALESCE(p_received_by, auth.uid());

  -- FIXED: Restore auth/role check (was present in wave4, lost in 20260329)
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items provided for receiving';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT poi.*, po.po_number, po.id AS purchase_order_id
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'purchase_order_item_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO item not found: %', v_item->>'purchase_order_item_id';
    END IF;

    SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_item.purchase_order_id;

    v_qty_received := (v_item->>'quantity_received')::numeric;
    IF v_qty_received IS NULL OR v_qty_received <= 0 THEN
      CONTINUE;
    END IF;

    -- Over-receive validation
    IF (COALESCE(v_po_item.quantity_received, 0) + v_qty_received) > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %. Ordered: %, Already received: %, Attempting: %',
        v_po_item.id, v_po_item.quantity_ordered, COALESCE(v_po_item.quantity_received, 0), v_qty_received;
    END IF;

    INSERT INTO receiving_records (
      purchase_order_id, purchase_order_item_id,
      product_id, quantity_received, unit_cost,
      condition, lot_number, notes, received_by
    ) VALUES (
      v_po_item.purchase_order_id, v_po_item.id,
      v_po_item.product_id, v_qty_received, v_po_item.unit_cost,
      COALESCE(v_item->>'condition', 'good'),
      v_item->>'lot_number',
      v_item->>'notes',
      v_actor
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty_received,
      updated_at        = now()
    WHERE id = v_po_item.id;

    -- Add to available AND decrement on_order
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty_received,
      quantity_on_order  = GREATEST(COALESCE(quantity_on_order, 0) - v_qty_received, 0),
      updated_at         = now()
    WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order)
      VALUES (v_po_item.product_id, 'Main Warehouse', v_qty_received, 0);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      reference_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty_received,
      v_po_item.purchase_order_id, v_actor,
      'Received from PO: ' || COALESCE(v_po.po_number, v_po_item.purchase_order_id::text)
    );

    -- Weighted average cost update (only when explicitly enabled)
    IF NOT p_skip_cost_update AND v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF FOUND THEN
        SELECT COALESCE(quantity_available, 0) - v_qty_received
          INTO v_current_qty
          FROM inventory
         WHERE product_id = v_po_item.product_id AND location = 'Main Warehouse';

        v_current_qty := GREATEST(COALESCE(v_current_qty, 0), 0);

        IF (v_current_qty + v_qty_received) > 0 THEN
          v_new_cost := ROUND(
            (v_current_qty * COALESCE(v_product.current_cost, v_po_item.unit_cost) +
             v_qty_received * v_po_item.unit_cost)
            / (v_current_qty + v_qty_received),
            4
          );
        ELSE
          v_new_cost := v_po_item.unit_cost;
        END IF;

        IF v_new_cost IS DISTINCT FROM v_product.current_cost THEN
          INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_note)
          VALUES (
            v_po_item.product_id, v_actor,
            v_product.current_cost, v_new_cost,
            'Weighted avg cost update from PO receiving'
          );

          UPDATE products SET
            current_cost      = v_new_cost,
            cost_updated_date = now()
          WHERE id = v_po_item.product_id;
        END IF;
      END IF;
    END IF;

    v_affected_po_ids := array_append(v_affected_po_ids, v_po_item.purchase_order_id);
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    PERFORM update_po_status(v_unique_po_id);
  END LOOP;

  v_result := jsonb_build_object(
    'status',                'received',
    'receiving_record_ids',  v_receiving_record_ids
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_po_items(uuid, jsonb, uuid, text, boolean) TO authenticated;


-- ============================================================================
-- FIX 3: void_invoice — three bugs + missing guards
--
-- BUG A: Used pa.amount_cents but column is actually applied_amount_cents
-- BUG B: Deleted invoice_line_allocations THEN queried them → always zero rows
-- BUG C: No auth/role check (any authenticated user could void)
-- BUG D: No check_period_open() guard
-- FIX: Correct column name, collect allocation_set_ids BEFORE deleting,
--      add admin-only check, add period check.
-- ============================================================================

CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inv record;
  v_alloc record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_prepay_app record;
  v_actor_role text;
  v_allocation_set_ids uuid[];
BEGIN
  -- FIXED: Add auth/role check — only admins can void invoices
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Only admin users can void invoices';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status = 'voided' THEN
    RAISE EXCEPTION 'Invoice already voided';
  END IF;

  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot void a cancelled invoice';
  END IF;

  -- FIXED: Add period check — cannot void into a closed period
  IF v_inv.status = 'posted' THEN
    PERFORM check_period_open(v_inv.invoice_date);
  END IF;

  -- FIXED BUG B: Collect allocation_set_ids BEFORE deleting the rows
  SELECT ARRAY(
    SELECT DISTINCT allocation_set_id
    FROM invoice_line_allocations
    WHERE invoice_id = p_invoice_id
    AND allocation_set_id IS NOT NULL
  ) INTO v_allocation_set_ids;

  -- Reverse payment allocations
  FOR v_alloc IN
    SELECT ila.id, ila.allocated_cents, ila.allocation_set_id
    FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
  LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.allocated_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  -- Update allocation_sets using pre-collected IDs
  IF v_total_allocations_reversed > 0 AND array_length(v_allocation_set_ids, 1) > 0 THEN
    UPDATE allocation_sets SET
      total_allocated_cents = (
        SELECT COALESCE(SUM(allocated_cents), 0)
        FROM invoice_line_allocations
        WHERE allocation_set_id = allocation_sets.id
      ),
      updated_at = now()
    WHERE id = ANY(v_allocation_set_ids);
  END IF;

  -- Restore prepay credits
  -- FIXED BUG A: Column is applied_amount_cents, not amount_cents
  FOR v_prepay_app IN
    SELECT pa.id, pa.applied_amount_cents, pa.prepay_credit_id
    FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id
  LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.applied_amount_cents;

    UPDATE prepay_credits SET
      balance_cents = balance_cents + v_prepay_app.applied_amount_cents,
      updated_at = now()
    WHERE id = v_prepay_app.prepay_credit_id;

    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now()
    WHERE id = v_inv.customer_id;
  END IF;

  -- Void the invoice — zero all component columns so generated balance_cents = 0
  UPDATE invoices SET
    status = 'voided',
    voided_by = auth.uid(),
    voided_at = now(),
    void_reason = p_void_reason,
    total_amount_cents = 0,
    paid_amount_cents = 0,
    prepay_applied_cents = 0,
    write_off_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_voided', 'invoice', p_invoice_id,
    v_actor_role,
    jsonb_build_object(
      'status', v_inv.status,
      'total_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'write_off_cents', v_inv.write_off_cents
    ),
    jsonb_build_object(
      'status', 'voided',
      'void_reason', p_void_reason,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored
    ),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END
  );

  -- Activity log
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );

  -- Notify admin about reversals
  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id,
      'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.',
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p
    WHERE p.role = 'admin' AND p.is_active = true;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION void_invoice(uuid, text, text) TO authenticated;


-- ============================================================================
-- FIX 4: create_direct_order — missing commission creation
--
-- BUG: Direct orders (not from quotes) never created commission records.
-- Only convert_quote_to_order had commission logic.
-- FIX: Look up customer's commission_split and create commission records.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_direct_order(
  p_customer_id uuid,
  p_order_date date,
  p_order_name text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_order_id uuid;
  v_order_number text;
  v_item jsonb;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_customer record;
  v_cached_result jsonb;
  v_result jsonb;
  v_inv record;
  v_warnings text[] := '{}';
  v_qty numeric;
  v_net_position numeric;
BEGIN
  -- Derive actor from JWT
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'create_direct_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  v_order_number := generate_order_number();

  -- Check inventory (warn, don't block)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN CONTINUE; END IF;
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      v_warnings := array_append(v_warnings,
        COALESCE(v_item->>'product_name', 'Unknown product') ||
        ': need ' || v_qty || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_warnings := array_append(v_warnings,
          COALESCE(v_item->>'product_name', 'Unknown product') ||
          ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  -- Calculate totals
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_price := v_total_price
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'price_per_unit')::numeric, 0);
    v_total_cost := v_total_cost
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE
    WHEN v_total_price > 0 THEN (v_total_profit / v_total_price) * 100
    ELSE 0
  END;

  -- Create the order
  INSERT INTO orders (
    order_number, order_name, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, total_paid, balance_due, notes
  ) VALUES (
    v_order_number, NULLIF(TRIM(COALESCE(p_order_name, '')), ''),
    p_customer_id, 'confirmed',
    v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
    p_order_date, 0, v_total_price,
    NULLIF(TRIM(COALESCE(p_notes, '')), '')
  ) RETURNING id INTO v_order_id;

  -- Create order items and prebook inventory
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL OR COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      COALESCE((v_item->>'price_per_unit')::numeric, 0),
      COALESCE((v_item->>'unit_cost')::numeric, 0),
      (v_item->>'quantity')::numeric,
      v_item->>'unit_size',
      COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'price_per_unit')::numeric, 0),
      (COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
        * COALESCE((v_item->>'quantity')::numeric, 0),
      CASE WHEN COALESCE((v_item->>'price_per_unit')::numeric, 0) > 0
        THEN ((COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
              / (v_item->>'price_per_unit')::numeric) * 100
        ELSE 0
      END,
      0,
      (v_item->>'quantity')::numeric
    );

    -- Prebook inventory
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + (v_item->>'quantity')::numeric,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (
        (v_item->>'product_id')::uuid, 'Main Warehouse',
        0, (v_item->>'quantity')::numeric, 0,
        v_item->>'unit_size'
      );
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', (v_item->>'quantity')::numeric,
      'Main Warehouse', v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  -- FIXED: Create commission records for direct orders (was only in convert_quote_to_order)
  IF v_customer.commission_split IS NOT NULL AND v_customer.commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, p_customer_id,
      s->>'recipient',
      (s->>'percentage')::numeric,
      v_total_profit * ((s->>'percentage')::numeric / 100),
      v_total_profit,
      p_order_date,
      'pending'
    FROM jsonb_array_elements(v_customer.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Direct order ' || v_order_number || COALESCE(' (' || NULLIF(TRIM(COALESCE(p_order_name, '')), '') || ')', '') || ' created for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_warnings, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, p_customer_id
  );

  -- Return result WITH warnings
  v_result := jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_direct_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- FIX 5: calculate_prices_from_margin — missing SET search_path
--
-- BUG: SECURITY DEFINER trigger without search_path is a security risk.
-- ============================================================================

CREATE OR REPLACE FUNCTION calculate_prices_from_margin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.current_cost IS NOT NULL AND NEW.current_cost > 0 THEN
    -- Tier 1
    IF NEW.tier1_margin IS NOT NULL AND NEW.tier1_margin < 1 AND NEW.tier1_margin > 0 THEN
      NEW.tier1_price := ROUND(NEW.current_cost / (1 - NEW.tier1_margin), 2);
      NEW.tier1_gross_margin := ROUND(NEW.tier1_margin / (1 - NEW.tier1_margin), 4);
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier1_price_per_acre := ROUND((NEW.tier1_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier1_gross_margin := NULL;
    END IF;

    -- Tier 2
    IF NEW.tier2_margin IS NOT NULL AND NEW.tier2_margin < 1 AND NEW.tier2_margin > 0 THEN
      NEW.tier2_price := ROUND(NEW.current_cost / (1 - NEW.tier2_margin), 2);
      NEW.tier2_gross_margin := ROUND(NEW.tier2_margin / (1 - NEW.tier2_margin), 4);
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier2_price_per_acre := ROUND((NEW.tier2_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier2_gross_margin := NULL;
    END IF;

    -- Tier 3
    IF NEW.tier3_margin IS NOT NULL AND NEW.tier3_margin < 1 AND NEW.tier3_margin > 0 THEN
      NEW.tier3_price := ROUND(NEW.current_cost / (1 - NEW.tier3_margin), 2);
      NEW.tier3_gross_margin := ROUND(NEW.tier3_margin / (1 - NEW.tier3_margin), 4);
      IF NEW.rate_per_acre IS NOT NULL AND NEW.container_size IS NOT NULL AND NEW.container_size > 0 THEN
        NEW.tier3_price_per_acre := ROUND((NEW.tier3_price * NEW.rate_per_acre) / NEW.container_size, 2);
      END IF;
    ELSE
      NEW.tier3_gross_margin := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================================
-- FIX 6: receive_return — LATERAL subquery missing location filter
--
-- BUG: LIMIT 1 without WHERE location = 'Main Warehouse' could pick
-- a random warehouse's inventory row.
-- FIX: Add location filter to the LATERAL subquery.
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_return(
  p_return_id uuid,
  p_received_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item RECORD;
  v_return_number text;
BEGIN
  SELECT return_number INTO v_return_number
  FROM returns WHERE id = p_return_id AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in approved status';
  END IF;

  FOR v_item IN
    SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
           inv.id AS inv_id, inv.location AS inv_location
    FROM return_items ri
    LEFT JOIN LATERAL (
      SELECT id, location FROM inventory
      WHERE product_id = ri.product_id AND location = 'Main Warehouse'  -- FIXED: added location filter
      LIMIT 1
    ) inv ON true
    WHERE ri.return_id = p_return_id
      AND ri.restock = true
      AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    IF v_item.inv_id IS NOT NULL THEN
      UPDATE inventory
      SET quantity_available = quantity_available + v_item.quantity,
          updated_at = now()
      WHERE id = v_item.inv_id;

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'returned', v_item.quantity,
        v_item.inv_location, p_received_by,
        'Return ' || v_return_number || ': ' || v_item.product_name ||
        ' (' || v_item.condition || ')'
      );

      UPDATE return_items SET restocked = true WHERE id = v_item.item_id;
    ELSE
      RAISE WARNING 'No inventory row found for product % in return %. Item NOT restocked.',
        v_item.product_id, v_return_number;
    END IF;
  END LOOP;

  UPDATE returns
  SET status = 'received',
      received_by = p_received_by,
      received_at = now(),
      updated_at = now()
  WHERE id = p_return_id;
END;
$$;


-- ============================================================================
-- FIX 7: create_commission_payment — season calc uses >= 7 instead of >= 10
--
-- BUG: Season is Oct 1 - Sep 30, so month >= 10 is the cutoff.
-- Code had >= 7 (July), misattributing Q3 payments to the wrong season.
-- ============================================================================

-- We only need to patch the season calculation line. Full function rewrite
-- to ensure we override the wave4 version.

CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids uuid[],
  p_payment_method text DEFAULT 'check',
  p_reference text DEFAULT NULL,
  p_payment_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total numeric := 0;
  v_recipient_id uuid;
  v_payment_id uuid;
  v_payment_num text;
  v_commission record;
  v_season integer;
  v_payment_dt date;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Only admin can create commission payments';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_payment_dt := COALESCE(p_payment_date, current_date);

  IF p_commission_ids IS NULL OR array_length(p_commission_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No commission IDs provided';
  END IF;

  -- Verify all commissions belong to same recipient
  SELECT recipient INTO v_recipient_id
  FROM public.commissions WHERE id = p_commission_ids[1] AND status != 'paid';
  IF NOT FOUND THEN RAISE EXCEPTION 'Commission not found or already paid'; END IF;

  IF (SELECT count(DISTINCT c.recipient)
      FROM public.commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  SELECT sum(c.commission_amount) INTO v_total
  FROM public.commissions c
  WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid';

  -- FIXED: Season uses Oct 1 - Sep 30 (month >= 10, not >= 7)
  v_season := CASE
    WHEN extract(month FROM v_payment_dt) >= 10
    THEN extract(year FROM v_payment_dt)::integer + 1
    ELSE extract(year FROM v_payment_dt)::integer
  END;

  v_payment_num := public.next_commission_payment_number();

  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, v_actor
  ) RETURNING id INTO v_payment_id;

  FOR v_commission IN
    SELECT c.id, c.commission_amount
    FROM public.commissions c
    WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid'
  LOOP
    INSERT INTO public.commission_payment_items (
      payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );

    UPDATE public.commissions SET
      status = 'paid',
      paid_date = v_payment_dt,
      updated_at = now()
    WHERE id = v_commission.id;
  END LOOP;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, description
  ) VALUES (
    'commission_payment', 'commission_payment', v_payment_id,
    v_actor_role,
    jsonb_build_object(
      'payment_number', v_payment_num,
      'total', v_total,
      'commission_count', array_length(p_commission_ids, 1),
      'season', v_season
    ),
    'Commission payment ' || v_payment_num || ' for $' || v_total::text ||
      ' (' || array_length(p_commission_ids, 1)::text || ' commissions, season ' || v_season || ')'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_commission_payment',
      jsonb_build_object('payment_id', v_payment_id, 'payment_number', v_payment_num));
  END IF;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'payment_number', v_payment_num,
    'total', v_total,
    'season', v_season
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) TO authenticated;
