-- =============================================================================
-- Phase 1: Emergency RPC Fixes — 9 Broken RPCs
-- Business Logic Audit Findings #1-9
--
-- These RPCs crash at runtime due to wrong column names, missing columns,
-- or broken business logic that silently produces incorrect results.
-- =============================================================================

-- =============================================================================
-- SECTION 1: Schema fixes — add missing columns to existing tables
-- =============================================================================

-- 1a: allocation_sets — add payment-tracking columns
-- The allocate_payment() function inserts these columns but they don't exist.
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS total_payment_cents bigint;
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS total_allocated_cents bigint DEFAULT 0;
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS reference_number text;
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS check_number text;
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS payment_date date;
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS season integer;
ALTER TABLE allocation_sets ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 1b: invoice_line_allocations — support whole-invoice payment allocations
-- The table was designed for split-billing (per invoice item). Payments allocate
-- to whole invoices, so we need invoice_id and nullable invoice_item_id.
ALTER TABLE invoice_line_allocations ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id);
ALTER TABLE invoice_line_allocations ALTER COLUMN invoice_item_id DROP NOT NULL;
-- Ensure at least one target is specified
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ila_target_check'
  ) THEN
    ALTER TABLE invoice_line_allocations
      ADD CONSTRAINT ila_target_check
      CHECK (invoice_item_id IS NOT NULL OR invoice_id IS NOT NULL);
  END IF;
END $$;

-- 1c: prepay_credits — add source tracking for overpayment provenance
ALTER TABLE prepay_credits ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE prepay_credits ADD COLUMN IF NOT EXISTS source_reference text;


-- =============================================================================
-- SECTION 2: Fix allocate_payment() — Finding #1 (P0 CRITICAL)
-- Problem: INSERT into allocation_sets/invoice_line_allocations/prepay_credits
-- references columns that don't exist. Function crashes on every call.
-- Fix: Use correct column names now that schema is updated above.
-- =============================================================================

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

  -- Determine season (July 1 = start of new season)
  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 7
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  -- Create allocation set (FIX: use correct column names)
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

    -- FIX: Use correct column names (invoice_id + amount_cents, not allocated_cents)
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

    v_sum_allocated := v_sum_allocated + v_alloc_cents;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  -- Update allocation set total (FIX: columns now exist)
  UPDATE allocation_sets SET
    total_allocated_cents = v_sum_allocated,
    updated_at = now()
  WHERE id = v_set_id;

  -- Handle overpayment → prepay credit
  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    -- FIX: Use correct column names (source_type, source_reference now exist)
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

  -- Save idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION allocate_payment(uuid, bigint, text, text, text, date, text, jsonb, uuid, text) TO authenticated;


-- =============================================================================
-- SECTION 3: Fix cancel_delivery() — Finding #2 (P1 HIGH)
-- Problem: For in_progress deliveries, only checks quantity_delivered (which is 0
-- since delivery hasn't completed). Prebooked inventory is never released.
-- Fix: Release prebooked for BOTH scheduled AND in_progress cancellations.
-- =============================================================================

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

  -- Idempotency check
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

  -- FIX: Completed or in_progress: restore any delivered quantity back to available
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
  END IF;

  -- FIX: Scheduled OR in_progress: release prebooked inventory
  -- Previously only covered 'scheduled'. In-progress deliveries still have
  -- prebooked inventory that must be released when cancelled.
  IF v_delivery.status IN ('scheduled', 'in_progress') THEN
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

  -- Re-evaluate order status
  IF v_delivery.order_id IS NOT NULL THEN
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id;

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

    -- Handle remainders
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


-- =============================================================================
-- SECTION 4: Fix auto_expire_quotes() — Finding #3 (P1 HIGH)
-- Problem: WHERE quote_id = v_quote.id — column is source_id, not quote_id.
-- The belt-and-suspenders hold release silently matches 0 rows.
-- Fix: Use correct column name source_id.
-- =============================================================================

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

    -- Belt-and-suspenders: directly release any holds
    -- FIX: column is source_id, not quote_id
    UPDATE inventory_holds SET
      is_active = false,
      updated_at = now()
    WHERE source_id = v_quote.id AND is_active = true;
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


-- =============================================================================
-- SECTION 5: Fix cancel_order() — Finding #4 (P1 HIGH)
-- Problems:
--   a) WHERE order_id on inventory_holds — column is source_id
--   b) Uses 'adjusted' transaction_type (ambiguous) — should be specific
--   c) Does NOT cancel active deliveries for the cancelled order
-- Fix: Correct column name, specific transaction_type, cancel deliveries.
-- =============================================================================

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_item record;
  v_undelivered numeric;
  v_holds_released integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_deliveries_cancelled integer := 0;
  v_invoice record;
  v_admin record;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'already_cancelled');
  END IF;

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- FIX: Cancel active deliveries BEFORE releasing inventory
  -- (Direct UPDATE, not recursive cancel_delivery call, to avoid double prebook release)
  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = p_performed_by,
    cancel_reason = 'Parent order ' || v_order.order_number || ' cancelled',
    updated_at = now()
  WHERE order_id = p_order_id
    AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

  -- Notify drivers of cancelled deliveries
  IF v_deliveries_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT
      d.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || d.delivery_number || ' cancelled — order ' || v_order.order_number || ' was cancelled.',
      'delivery_update', 'delivery', d.id
    FROM deliveries d
    WHERE d.order_id = p_order_id
      AND d.status = 'cancelled'
      AND d.cancel_reason LIKE 'Parent order%'
      AND d.assigned_driver IS NOT NULL;
  END IF;

  -- Update order status
  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- Release prebooked inventory for undelivered items
  FOR v_item IN
    SELECT product_id, total_units_needed, quantity_delivered
    FROM order_items WHERE order_id = p_order_id
  LOOP
    v_undelivered := GREATEST(v_item.total_units_needed - COALESCE(v_item.quantity_delivered, 0), 0);
    IF v_undelivered <= 0 THEN CONTINUE; END IF;

    UPDATE inventory SET
      quantity_prebooked = GREATEST(quantity_prebooked - v_undelivered, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    -- FIX: Specific transaction_type instead of ambiguous 'adjusted'
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'cancelled_order_release', -v_undelivered, 'Main Warehouse',
      p_order_id, p_performed_by,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- FIX: Release inventory holds (source_id, not order_id)
  UPDATE inventory_holds SET is_active = false, updated_at = now()
  WHERE source_id = p_order_id AND is_active = true;
  GET DIAGNOSTICS v_holds_released = ROW_COUNT;

  -- Cancel pending commissions
  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- Check for paid commissions — don't touch them, just notify
  SELECT COUNT(*) INTO v_paid_commissions
  FROM commissions WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Cancelled Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was cancelled but has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
        'cancellation_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  -- Void draft invoices, notify about posted ones
  FOR v_invoice IN
    SELECT * FROM invoices
    WHERE order_id = p_order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      UPDATE invoices SET
        status = 'voided',
        voided_by = p_performed_by,
        voided_at = now(),
        void_reason = 'Order ' || v_order.order_number || ' cancelled',
        balance_cents = 0,
        updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_voided', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'voided', 'void_reason', 'Order cancelled'),
        -1 * v_invoice.total_amount_cents,
        'Auto-voided draft invoice ' || v_invoice.invoice_number || ' — order ' || v_order.order_number || ' cancelled'
      );

      v_draft_voided := v_draft_voided + 1;

    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (
          v_admin.id,
          'Manual Invoice Void Required',
          'Order ' || v_order.order_number || ' cancelled but has posted invoice ' || v_invoice.invoice_number || ' — manual void required.',
          'cancellation_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_cancelled',
    'Order ' || v_order.order_number || ' cancelled. ' ||
      v_deliveries_cancelled || ' delivery(s) cancelled, ' ||
      v_holds_released || ' hold(s) released, ' ||
      v_commissions_cancelled || ' commission(s) zeroed, ' ||
      v_draft_voided || ' draft invoice(s) voided.' ||
      CASE WHEN v_posted_notified > 0 THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.' ELSE '' END ||
      CASE WHEN v_paid_commissions > 0 THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.' ELSE '' END,
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'cancelled',
    'deliveries_cancelled', v_deliveries_cancelled,
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_notified', v_posted_notified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, uuid) TO authenticated;


-- =============================================================================
-- SECTION 6: Rewrite check_customer_credit_limit() — Finding #5 (P1 HIGH)
-- Problem: Reads orders.balance_due which is DEPRECATED and unmaintained.
-- Credit limit enforcement is completely broken.
-- Fix: Calculate outstanding AR from invoices.balance_cents (the single source of truth).
-- =============================================================================

CREATE OR REPLACE FUNCTION check_customer_credit_limit(
  p_customer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit_limit_cents bigint;
  v_farm_name text;
  v_outstanding_ar_cents bigint;
BEGIN
  -- Get customer info
  SELECT credit_limit_cents, farm_name
  INTO v_credit_limit_cents, v_farm_name
  FROM customers
  WHERE id = p_customer_id;

  IF v_credit_limit_cents IS NULL OR v_credit_limit_cents <= 0 THEN
    RETURN jsonb_build_object(
      'exceeded', false,
      'credit_limit', 0,
      'outstanding_ar', 0,
      'farm_name', COALESCE(v_farm_name, '')
    );
  END IF;

  -- FIX: Calculate outstanding AR from invoices (single source of truth)
  -- instead of deprecated orders.balance_due
  SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0)
  INTO v_outstanding_ar_cents
  FROM invoices
  WHERE customer_id = p_customer_id
    AND status IN ('posted', 'overdue')
    AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'exceeded', v_outstanding_ar_cents > v_credit_limit_cents,
    'credit_limit', v_credit_limit_cents / 100.0,
    'outstanding_ar', v_outstanding_ar_cents / 100.0,
    'available_credit', GREATEST(v_credit_limit_cents - v_outstanding_ar_cents, 0) / 100.0,
    'farm_name', COALESCE(v_farm_name, '')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_customer_credit_limit(uuid) TO authenticated;


-- =============================================================================
-- SECTION 7: Fix create_quick_delivery() — Findings #6, #7, #8
-- Problems:
--   #6: v_customer.commission_split — column is default_commission_split on customers
--   #7: jsonb_typeof(v_split) = 'array' — format is {splits:[...]}, not bare array
--   #8: Inventory pre-check doesn't subtract quantity_prebooked from available
-- Fix: Correct column name, correct JSON format check, subtract prebooked.
-- =============================================================================

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

    -- FIX #8: Subtract prebooked from available for net free check
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

  -- FIX #6: Use default_commission_split (correct column on customers table)
  v_split := v_customer.default_commission_split;

  -- FIX #7: Commission splits are stored as {splits: [{recipient, percentage}]}, not bare array
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
    v_customer.default_commission_split  -- FIX #6: correct column name
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

  -- Step 4: Process items (inventory already validated above)
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

    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id, v_item_qty,
      COALESCE(v_item->>'unit_size', v_product.unit_size)
    );

    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size, sort_order
    ) VALUES (
      v_invoice_id, v_order_item_id, v_product.id, v_product.product_name,
      v_item_qty, v_item_price_cents, v_item_price_cents * v_item_qty::bigint,
      COALESCE(v_product.current_cost * 100, 0)::bigint,
      COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort
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
    total_amount_cents = v_total_cents
  WHERE id = v_invoice_id;

  -- Generate commissions (FIX #7: correct JSON path through 'splits' key)
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
