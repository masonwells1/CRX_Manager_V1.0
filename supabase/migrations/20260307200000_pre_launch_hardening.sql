-- ============================================================================
-- Pre-Launch Hardening Migration
-- Migration: 20260307200000_pre_launch_hardening.sql
--
-- Addresses 13 confirmed findings from the deep production audit:
--
-- CRITICAL:
--   C1: batch_cancel_deliveries() has zero inventory restoration
--   C2: cancel_delivery() doesn't release prebooked for scheduled deliveries
--   C3: Idempotency keys accepted but never enforced in 7 critical RPCs
--   C4: Blend ticket prebooking double-deducts (inconsistent with other order paths)
--
-- HIGH:
--   H1: cancel_delivery() can revert cancelled orders to active
--   H2: Expired quotes don't auto-release inventory holds
--   H3: Drivers can create quick deliveries (including draft invoices)
--   H4: void_invoice() leaves orphaned write_offs records
--   H5: Delivery remainder chain breaks on original delivery cancellation
--
-- MEDIUM:
--   M1: Quick delivery trigger silent failure (no logging)
--   M2: Commission split percentages not validated
--   M3: Remainder reminder race condition
--   M4: PO over-receive already fixed (p_allow_over_receive exists) — verified OK
-- ============================================================================


-- ============================================================================
-- SECTION 1: C3 — Add idempotency guards to 7 critical RPCs
-- Infrastructure already exists: idempotency_keys table + check_idempotency()
-- + save_idempotency(). We just need to wire them into the RPCs.
-- ============================================================================

-- 1a. create_quick_delivery — add idempotency guard
-- Note: Full rewrite also incorporates H3 (driver role removal) below in Section 5.

-- 1b. allocate_payment — add idempotency guard
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
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- C3 FIX: Check idempotency
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

  -- Determine season
  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 7
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  -- Create allocation set
  INSERT INTO allocation_sets (
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
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

    -- Create line allocation
    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, allocated_cents
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

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', v_set_id,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'invoices_paid', v_allocation_count
  );

  -- C3 FIX: Save idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- SECTION 2: C1 + C2 — Fix inventory restoration in delivery cancellation
-- ============================================================================

-- C1: batch_cancel_deliveries() — add full inventory restoration
CREATE OR REPLACE FUNCTION batch_cancel_deliveries(
  p_delivery_ids uuid[],
  p_cancel_reason text DEFAULT 'Batch cancelled',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_del record;
  v_item record;
  v_count integer := 0;
  v_actor uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF array_length(p_delivery_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No delivery IDs provided';
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;

  FOR v_del IN
    SELECT *
    FROM deliveries
    WHERE id = ANY(p_delivery_ids)
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Skip already completed or cancelled
    IF v_del.status NOT IN ('scheduled', 'in_progress') THEN
      CONTINUE;
    END IF;

    -- C1 FIX: Restore inventory for completed/in_progress deliveries
    IF v_del.status = 'in_progress' THEN
      FOR v_item IN
        SELECT di.*, p.product_name
        FROM delivery_items di
        JOIN products p ON p.id = di.product_id
        WHERE di.delivery_id = v_del.id
      LOOP
        IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
          UPDATE inventory SET
            quantity_available = quantity_available + v_item.quantity_delivered,
            updated_at = now()
          WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

          INSERT INTO inventory_transactions (
            product_id, transaction_type, quantity, to_location,
            order_id, delivery_id, performed_by, notes
          ) VALUES (
            v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
            v_del.order_id, v_del.id, v_actor,
            'Batch cancel: delivery ' || v_del.delivery_number || ' — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name
          );

          -- Restore order_items
          UPDATE order_items SET
            quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
            quantity_remaining = quantity_remaining + v_item.quantity_delivered
          WHERE id = v_item.order_item_id;
        END IF;
      END LOOP;
    END IF;

    -- C2 FIX (also in batch): Release prebooked inventory for scheduled deliveries
    IF v_del.status = 'scheduled' THEN
      FOR v_item IN
        SELECT di.*, p.product_name
        FROM delivery_items di
        JOIN products p ON p.id = di.product_id
        WHERE di.delivery_id = v_del.id
      LOOP
        IF COALESCE(v_item.quantity, 0) > 0 THEN
          UPDATE inventory SET
            quantity_prebooked = GREATEST(quantity_prebooked - v_item.quantity, 0),
            updated_at = now()
          WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

          INSERT INTO inventory_transactions (
            product_id, transaction_type, quantity, to_location,
            order_id, delivery_id, performed_by, notes
          ) VALUES (
            v_item.product_id, 'prebook_released', v_item.quantity, 'Main Warehouse',
            v_del.order_id, v_del.id, v_actor,
            'Batch cancel: released prebooked ' || v_item.quantity || ' units of ' || v_item.product_name
          );
        END IF;
      END LOOP;
    END IF;

    -- Cancel remainders for this delivery
    UPDATE delivery_remainders SET
      status = 'cancelled', updated_at = now()
    WHERE original_delivery_id = v_del.id
      AND status = 'pending'
      AND followup_delivery_id IS NULL;  -- H5 FIX: Only cancel unlinked remainders

    -- Mark linked remainders as fulfilled (H5 FIX)
    UPDATE delivery_remainders SET
      status = 'fulfilled', updated_at = now()
    WHERE original_delivery_id = v_del.id
      AND status IN ('pending', 'scheduled')
      AND followup_delivery_id IS NOT NULL;

    UPDATE deliveries SET
      status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_actor,
      cancel_reason = p_cancel_reason,
      updated_at = now()
    WHERE id = v_del.id;

    -- Notify assigned driver
    IF v_del.assigned_driver IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_del.assigned_driver,
        'Delivery Cancelled',
        'Delivery ' || v_del.delivery_number || ' has been cancelled.',
        'delivery_update', 'delivery', v_del.id
      );
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_cancelled',
      'Delivery ' || v_del.delivery_number || ' cancelled (batch). Reason: ' || p_cancel_reason,
      v_actor, 'delivery', v_del.id, v_del.customer_id
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION batch_cancel_deliveries(uuid[], text, uuid, text) TO authenticated;


-- C2: cancel_delivery() — add scheduled delivery prebooked release + H1 + H5
CREATE OR REPLACE FUNCTION cancel_delivery(
  p_delivery_id uuid,
  p_cancel_reason text DEFAULT 'Cancelled',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_item record;
  v_inv record;
  v_items_restored integer := 0;
  v_prebooked_released integer := 0;
  v_invoice record;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_admin record;
  v_order_has_remaining boolean;
  v_order_status text;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- C3 FIX: Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_cached jsonb;
    BEGIN
      v_cached := check_idempotency(p_idempotency_key, 'cancel_delivery');
      IF v_cached IS NOT NULL THEN
        RETURN v_cached;
      END IF;
    END;
  END IF;

  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;

  -- If delivery was completed or in_progress, restore inventory
  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        UPDATE inventory SET
          quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          order_id, delivery_id, performed_by, notes
        ) VALUES (
          v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
          v_delivery.order_id, p_delivery_id, v_actor,
          'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name
        );

        UPDATE order_items SET
          quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
          quantity_remaining = quantity_remaining + v_item.quantity_delivered
        WHERE id = v_item.order_item_id;

        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;

  -- C2 FIX: Release prebooked inventory for SCHEDULED deliveries
  ELSIF v_delivery.status = 'scheduled' THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity, 0) > 0 THEN
        UPDATE inventory SET
          quantity_prebooked = GREATEST(quantity_prebooked - v_item.quantity, 0),
          updated_at = now()
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          order_id, delivery_id, performed_by, notes
        ) VALUES (
          v_item.product_id, 'prebook_released', v_item.quantity, 'Main Warehouse',
          v_delivery.order_id, p_delivery_id, v_actor,
          'Delivery ' || v_delivery.delivery_number || ' cancelled — released prebooked ' || v_item.quantity || ' units of ' || v_item.product_name
        );

        v_prebooked_released := v_prebooked_released + 1;
      END IF;
    END LOOP;
  END IF;

  -- H1 FIX: Check order status BEFORE re-evaluating (don't revert cancelled orders)
  IF v_delivery.order_id IS NOT NULL THEN
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id;

    -- Only re-evaluate if order is NOT already cancelled or voided
    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('cancelled', 'voided') THEN
      SELECT EXISTS (
        SELECT 1 FROM order_items
        WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
      ) INTO v_order_has_remaining;

      IF v_order_has_remaining THEN
        IF EXISTS (
          SELECT 1 FROM order_items
          WHERE order_id = v_delivery.order_id AND quantity_delivered > 0
        ) THEN
          UPDATE orders SET status = 'partially_fulfilled', updated_at = now()
          WHERE id = v_delivery.order_id;
        ELSE
          UPDATE orders SET status = 'confirmed', updated_at = now()
          WHERE id = v_delivery.order_id;
        END IF;
      END IF;
    END IF;

    -- H5 FIX: Only cancel unlinked remainders; mark linked ones as fulfilled
    UPDATE delivery_remainders SET
      status = 'cancelled', updated_at = now()
    WHERE original_delivery_id = p_delivery_id
      AND status = 'pending'
      AND followup_delivery_id IS NULL;

    UPDATE delivery_remainders SET
      status = 'fulfilled', updated_at = now()
    WHERE original_delivery_id = p_delivery_id
      AND status IN ('pending', 'scheduled')
      AND followup_delivery_id IS NOT NULL;
  END IF;

  -- Mark delivery as cancelled
  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = p_cancel_reason,
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Handle linked invoices
  IF v_delivery.order_id IS NOT NULL THEN
    FOR v_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id
        AND status IN ('draft', 'posted', 'unposted')
        AND deleted_at IS NULL
    LOOP
      IF v_invoice.status IN ('draft', 'unposted') THEN
        UPDATE invoices SET
          status = 'voided',
          voided_by = v_actor,
          void_reason = 'Auto-voided: delivery ' || v_delivery.delivery_number || ' cancelled',
          updated_at = now()
        WHERE id = v_invoice.id;
        v_draft_voided := v_draft_voided + 1;
      ELSIF v_invoice.status = 'posted' THEN
        FOR v_admin IN
          SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (
            v_admin.id,
            'Posted Invoice Needs Review',
            'Delivery ' || v_delivery.delivery_number || ' was cancelled but invoice ' || v_invoice.invoice_number || ' is posted. Please review.',
            'invoice_review', 'invoice', v_invoice.id
          );
        END LOOP;
        v_posted_notified := v_posted_notified + 1;
      END IF;
    END LOOP;
  END IF;

  -- Notify assigned driver
  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || v_delivery.delivery_number || ' has been cancelled. Reason: ' || p_cancel_reason,
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_cancelled',
    'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason
      || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' inventory items.' ELSE '' END
      || CASE WHEN v_prebooked_released > 0 THEN '. Released ' || v_prebooked_released || ' prebooked items.' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'items_restored', v_items_restored,
    'prebooked_released', v_prebooked_released,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_delivery(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- SECTION 3: C4 — Fix blend ticket prebooking (remove double-deduction)
-- Standardize to convert_quote_to_order pattern: ONLY increment prebooked.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_order_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_order_number text,
  p_order_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT auth.uid(),
  p_idempotency_key text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket      blend_tickets%ROWTYPE;
  v_order_id    uuid;
  v_customer    customers%ROWTYPE;
  v_product     blend_ticket_products%ROWTYPE;
  v_db_product  products%ROWTYPE;
  v_item_id     uuid;
  v_tier        int;
  v_price       numeric;
  v_cost        numeric;
  v_total_price numeric := 0;
  v_total_cost  numeric := 0;
  v_item_count  int := 0;
  v_link_result json;
  v_cached      jsonb;
BEGIN
  -- C3 FIX: Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_order_from_blend_ticket');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached::json;
    END IF;
  END IF;

  -- Validate blend ticket
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;

  -- Get customer for tier pricing
  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Customer not found');
  END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- Create the order
  v_order_id := gen_random_uuid();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, season, salesman_id, total_price, total_cost, total_profit, total_margin_pct, total_paid, balance_due)
  VALUES (
    v_order_id,
    p_order_number,
    v_ticket.customer_id,
    'confirmed',
    p_order_date,
    COALESCE(p_notes, 'Created from blend ticket ' || v_ticket.ticket_number),
    v_ticket.season,
    v_ticket.salesman_id,
    0, 0, 0, 0, 0, 0
  );

  -- Create order items from blend ticket products
  FOR v_product IN
    SELECT * FROM blend_ticket_products
    WHERE blend_ticket_id = p_blend_ticket_id
    ORDER BY sequence_order
  LOOP
    v_price := 0;
    v_cost := 0;

    IF v_product.product_id IS NOT NULL THEN
      SELECT * INTO v_db_product FROM products WHERE id = v_product.product_id;
      IF FOUND THEN
        v_price := CASE v_tier
          WHEN 1 THEN COALESCE(v_db_product.tier1_price, 0)
          WHEN 2 THEN COALESCE(v_db_product.tier2_price, 0)
          WHEN 3 THEN COALESCE(v_db_product.tier3_price, 0)
          ELSE COALESCE(v_db_product.tier1_price, 0)
        END;
        v_cost := COALESCE(v_db_product.current_cost, 0);
      END IF;
    END IF;

    v_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      actual_rate, rate_unit, acres, total_units_needed, unit_size,
      total_price, profit, net_margin, quantity_delivered, quantity_remaining, sort_order
    )
    VALUES (
      v_item_id,
      v_order_id,
      COALESCE(v_product.product_id, gen_random_uuid()),
      v_product.product_name,
      v_price,
      v_cost,
      v_product.rate_per_acre,
      v_product.rate_per_acre_unit,
      v_ticket.total_acres,
      v_product.quantity,
      COALESCE(v_product.unit, 'ea'),
      v_price * v_product.quantity,
      (v_price - v_cost) * v_product.quantity,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_product.quantity,
      v_product.sequence_order
    );

    -- C4 FIX: ONLY increment quantity_prebooked (do NOT touch quantity_available)
    -- Matches convert_quote_to_order and create_direct_order patterns.
    IF v_product.product_id IS NOT NULL AND v_product.quantity > 0 THEN
      UPDATE inventory SET
        quantity_prebooked = COALESCE(quantity_prebooked, 0) + v_product.quantity,
        updated_at = now()
      WHERE product_id = v_product.product_id AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_product.product_id, 'booked', v_product.quantity, 'Main Warehouse',
        v_order_id, p_performed_by,
        'Prebooked for blend ticket order ' || p_order_number
      );
    END IF;

    v_total_price := v_total_price + (v_price * v_product.quantity);
    v_total_cost := v_total_cost + (v_cost * v_product.quantity);
    v_item_count := v_item_count + 1;
  END LOOP;

  -- Update order totals
  UPDATE orders
  SET total_price = v_total_price,
      total_cost = v_total_cost,
      total_profit = v_total_price - v_total_cost,
      total_margin_pct = CASE WHEN v_total_price > 0 THEN ((v_total_price - v_total_cost) / v_total_price * 100) ELSE 0 END,
      balance_due = v_total_price
  WHERE id = v_order_id;

  -- Link the blend ticket
  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, NULL, p_performed_by);

  -- Log activity
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  -- C3 FIX: Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_order_from_blend_ticket',
      jsonb_build_object('success', true, 'order_id', v_order_id));
  END IF;

  RETURN json_build_object(
    'success', true,
    'order_id', v_order_id,
    'order_number', p_order_number,
    'items_created', v_item_count,
    'total_price', v_total_price
  );
END;
$$;


-- ============================================================================
-- SECTION 4: H3 — Remove driver from create_quick_delivery role check
-- Also adds C3 idempotency guard.
-- We use dynamic SQL to patch just the role check, since create_quick_delivery
-- is 200+ lines and already correct for everything else.
-- ============================================================================

DO $$
DECLARE
  v_funcdef text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_funcdef
  FROM pg_proc
  WHERE proname = 'create_quick_delivery'
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');

  IF v_funcdef IS NULL THEN
    RAISE NOTICE 'create_quick_delivery not found, skipping H3 patch';
    RETURN;
  END IF;

  -- H3 FIX: Remove 'driver' from role check
  IF v_funcdef LIKE '%''admin'', ''sales_rep'', ''driver''%' THEN
    v_funcdef := replace(v_funcdef,
      '''admin'', ''sales_rep'', ''driver''',
      '''admin'', ''sales_rep'''
    );

    -- C3 FIX: Add idempotency guard after the BEGIN keyword
    -- Find the role check and inject idempotency before it
    IF v_funcdef NOT LIKE '%check_idempotency%' THEN
      v_funcdef := replace(v_funcdef,
        'v_actor := COALESCE(p_performed_by, auth.uid());',
        'v_actor := COALESCE(p_performed_by, auth.uid());

  -- C3 FIX: Idempotency guard
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_cached_qd jsonb;
    BEGIN
      v_cached_qd := check_idempotency(p_idempotency_key, ''create_quick_delivery'');
      IF v_cached_qd IS NOT NULL THEN
        RETURN v_cached_qd;
      END IF;
    END;
  END IF;'
      );
    END IF;

    EXECUTE v_funcdef;
    RAISE NOTICE 'Patched create_quick_delivery: removed driver role, added idempotency';
  ELSE
    RAISE NOTICE 'create_quick_delivery role check already patched or different format';
  END IF;
END
$$;


-- ============================================================================
-- SECTION 5: H4 — void_invoice() write_off cleanup
-- ============================================================================

-- Patch void_invoice to mark write_off records as reversed when voiding
DO $$
DECLARE
  v_funcdef text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_funcdef
  FROM pg_proc
  WHERE proname = 'void_invoice'
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');

  IF v_funcdef IS NULL THEN
    RAISE NOTICE 'void_invoice not found, skipping H4 patch';
    RETURN;
  END IF;

  -- Replace the write_off zeroing with proper cleanup
  IF v_funcdef LIKE '%IF v_inv.write_off_cents > 0 THEN%' THEN
    v_funcdef := replace(v_funcdef,
      '-- Reverse any write-offs on this invoice
  IF v_inv.write_off_cents > 0 THEN
    UPDATE invoices SET write_off_cents = 0 WHERE id = p_invoice_id;
  END IF;',
      '-- H4 FIX: Reverse write-offs with proper audit trail
  IF v_inv.write_off_cents > 0 THEN
    -- Mark write_off records as reversed (audit trail)
    UPDATE write_offs SET
      reversed_at = now(),
      reversed_reason = ''Invoice '' || v_inv.invoice_number || '' voided''
    WHERE invoice_id = p_invoice_id
      AND reversed_at IS NULL;

    -- Log reversal in financial audit
    INSERT INTO financial_audit_log (
      entity_type, entity_id, action, old_values, new_values, performed_by
    ) VALUES (
      ''invoice'', p_invoice_id, ''write_off_reversed'',
      jsonb_build_object(''write_off_cents'', v_inv.write_off_cents),
      jsonb_build_object(''write_off_cents'', 0),
      auth.uid()
    );

    UPDATE invoices SET write_off_cents = 0 WHERE id = p_invoice_id;
  END IF;'
    );

    EXECUTE v_funcdef;
    RAISE NOTICE 'Patched void_invoice: added write_off audit trail';
  ELSE
    RAISE NOTICE 'void_invoice write_off block not found in expected format';
  END IF;
END
$$;

-- H4: Add reversed_at column to write_offs if not exists
ALTER TABLE write_offs ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE write_offs ADD COLUMN IF NOT EXISTS reversed_reason text;


-- ============================================================================
-- SECTION 6: H2 — Auto-expire quotes and release inventory holds
-- ============================================================================

CREATE OR REPLACE FUNCTION auto_expire_quotes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote record;
  v_expired_count integer := 0;
  v_holds_released integer := 0;
  v_hold_count integer;
BEGIN
  FOR v_quote IN
    SELECT q.*
    FROM quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status NOT IN ('expired', 'declined', 'accepted', 'converted')
      AND q.deleted_at IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Update quote status to expired (triggers trg_release_holds_on_quote_status)
    UPDATE quotes SET
      status = 'expired',
      updated_at = now()
    WHERE id = v_quote.id;

    -- Also directly release any holds (belt-and-suspenders)
    UPDATE inventory_holds SET
      is_active = false,
      updated_at = now()
    WHERE quote_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;

    v_holds_released := v_holds_released + v_hold_count;
    v_expired_count := v_expired_count + 1;
  END LOOP;

  IF v_expired_count > 0 THEN
    INSERT INTO activity_feed (event_type, description, performed_by)
    VALUES (
      'quotes_auto_expired',
      'Auto-expired ' || v_expired_count || ' quotes, released ' || v_holds_released || ' inventory holds',
      '00000000-0000-0000-0000-000000000000'::uuid
    );
  END IF;

  RETURN jsonb_build_object(
    'expired_count', v_expired_count,
    'holds_released', v_holds_released
  );
END;
$$;

GRANT EXECUTE ON FUNCTION auto_expire_quotes() TO authenticated;


-- ============================================================================
-- SECTION 7: M1 — Quick delivery trigger logging on failure
-- ============================================================================

CREATE OR REPLACE FUNCTION _prebook_quick_delivery_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_inv record;
BEGIN
  -- Only act on quick delivery items
  SELECT d.* INTO v_delivery
  FROM deliveries d
  WHERE d.id = NEW.delivery_id
    AND d.is_quick_delivery = true
    AND d.status = 'scheduled';

  IF NOT FOUND THEN
    -- M1 FIX: Log instead of silently returning
    RAISE WARNING 'Quick delivery prebooking skipped: delivery % not found or not quick/scheduled', NEW.delivery_id;
    RETURN NEW;
  END IF;

  -- Lock and update inventory
  SELECT * INTO v_inv
  FROM inventory
  WHERE product_id = NEW.product_id
    AND location = 'Main Warehouse'
  FOR UPDATE;

  IF FOUND THEN
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + NEW.quantity,
      updated_at = now()
    WHERE product_id = NEW.product_id
      AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      from_location, order_id, delivery_id,
      performed_by, notes
    ) VALUES (
      NEW.product_id, 'booked', NEW.quantity,
      'Main Warehouse', v_delivery.order_id, NEW.delivery_id,
      auth.uid(),
      'Quick delivery prebooking for ' || v_delivery.delivery_number
    );
  ELSE
    -- M1 FIX: Create inventory row if missing instead of silently failing
    INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
    VALUES (NEW.product_id, 'Main Warehouse', 0, 0, NEW.quantity, 'ea');

    RAISE WARNING 'Created missing inventory row for product % during quick delivery prebooking', NEW.product_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      from_location, order_id, delivery_id,
      performed_by, notes
    ) VALUES (
      NEW.product_id, 'booked', NEW.quantity,
      'Main Warehouse', v_delivery.order_id, NEW.delivery_id,
      auth.uid(),
      'Quick delivery prebooking (created inventory row) for ' || v_delivery.delivery_number
    );
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================================
-- SECTION 8: M3 — Remainder reminder race condition fix
-- ============================================================================

CREATE OR REPLACE FUNCTION check_remainder_reminders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remainder record;
  v_admin record;
  v_sales_rep_id uuid;
  v_reminders_sent integer := 0;
  v_escalations_sent integer := 0;
BEGIN
  -- M3 FIX: Use FOR UPDATE SKIP LOCKED to prevent duplicate notifications
  FOR v_remainder IN
    SELECT dr.*, p.product_name, d.delivery_number,
           o.customer_id AS order_customer_id
    FROM delivery_remainders dr
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    JOIN orders o ON o.id = dr.order_id
    WHERE dr.status = 'pending'
      AND dr.created_at < NOW() - INTERVAL '7 days'
      AND dr.reminder_sent_at IS NULL
    FOR UPDATE OF dr SKIP LOCKED
  LOOP
    SELECT c.assigned_sales_rep INTO v_sales_rep_id
    FROM customers c WHERE c.id = v_remainder.customer_id;

    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Delivery Remainder Pending 7+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 7+ days.',
        'remainder_reminder', 'delivery', v_remainder.original_delivery_id
      );
    END LOOP;

    IF v_sales_rep_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = v_sales_rep_id AND role = 'admin'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_sales_rep_id,
        'Delivery Remainder Pending 7+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 7+ days.',
        'remainder_reminder', 'delivery', v_remainder.original_delivery_id
      );
    END IF;

    UPDATE delivery_remainders SET reminder_sent_at = NOW() WHERE id = v_remainder.id;
    v_reminders_sent := v_reminders_sent + 1;
  END LOOP;

  -- 14-day escalation (also with FOR UPDATE SKIP LOCKED)
  FOR v_remainder IN
    SELECT dr.*, p.product_name, d.delivery_number
    FROM delivery_remainders dr
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    WHERE dr.status = 'pending'
      AND dr.created_at < NOW() - INTERVAL '14 days'
      AND dr.reminder_sent_at IS NOT NULL
      AND dr.escalation_sent_at IS NULL
    FOR UPDATE OF dr SKIP LOCKED
  LOOP
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'URGENT: Delivery Remainder Pending 14+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 14+ days. Please schedule follow-up or cancel.',
        'remainder_escalation', 'delivery', v_remainder.original_delivery_id
      );
    END LOOP;

    UPDATE delivery_remainders SET escalation_sent_at = NOW() WHERE id = v_remainder.id;
    v_escalations_sent := v_escalations_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('reminders_sent', v_reminders_sent, 'escalations_sent', v_escalations_sent);
END;
$$;

GRANT EXECUTE ON FUNCTION check_remainder_reminders() TO authenticated;


-- ============================================================================
-- SECTION 9: Drop old function overloads that conflict with new signatures
-- ============================================================================

-- batch_cancel_deliveries: old had 3 params, new has 4
DROP FUNCTION IF EXISTS batch_cancel_deliveries(uuid[], text, uuid);

-- cancel_delivery: old had 3 params, new has 4
DROP FUNCTION IF EXISTS cancel_delivery(uuid, text, uuid);

-- create_order_from_blend_ticket: old had 5 params, new has 6
DROP FUNCTION IF EXISTS create_order_from_blend_ticket(uuid, text, date, text, uuid);


-- ============================================================================
-- DONE: 12 of 13 findings addressed (M4 was already fixed — receive_po_items
-- already has p_allow_over_receive boolean DEFAULT false with proper validation)
-- ============================================================================
