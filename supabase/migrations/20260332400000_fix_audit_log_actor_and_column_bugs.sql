-- ============================================================================
-- FIX: financial_audit_log actor_user_id + wrong column names across 24 RPCs
-- ============================================================================
--
-- CATEGORY 1: cancel_delivery — admin_override ordering bug
--   SET LOCAL app.admin_override = 'true' is AFTER the order status updates,
--   but reverse transitions (fulfilled → confirmed) need it BEFORE.
--
-- CATEGORY 2: mark_overdue_invoices — wrong column names + NULL actor
--   Uses event_type/performed_by/metadata instead of
--   operation_type/actor_user_id/new_values. Also passes NULL for actor
--   which violates NOT NULL on actor_user_id.
--
-- CATEGORY 3: link_blend_ticket_to_order / unlink_blend_ticket_from_order
--   Same wrong column names as mark_overdue_invoices.
--
-- CATEGORY 4: 20 other functions omit actor_user_id from INSERT
--   They rely on DEFAULT auth.uid() which works from PostgREST but fails
--   from pg_cron or direct SQL. A BEFORE INSERT trigger provides a safety net.
-- ============================================================================


-- ============================================================================
-- CATEGORY 4 FIX: Safety-net trigger for actor_user_id
-- ============================================================================
-- Instead of rewriting 20 functions, add a BEFORE INSERT trigger that
-- fills in actor_user_id when it would otherwise be NULL.
-- Order of operations: DEFAULT applied → BEFORE trigger → constraints checked.

CREATE OR REPLACE FUNCTION _fill_audit_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.actor_user_id IS NULL THEN
    -- Try auth.uid() first (works in PostgREST context)
    NEW.actor_user_id := auth.uid();
  END IF;
  IF NEW.actor_user_id IS NULL THEN
    -- Fallback: system/admin user for pg_cron or direct SQL calls
    NEW.actor_user_id := '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_audit_actor ON financial_audit_log;
CREATE TRIGGER trg_fill_audit_actor
  BEFORE INSERT ON financial_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION _fill_audit_actor();


-- ============================================================================
-- CATEGORY 1 FIX: cancel_delivery — move admin_override BEFORE order updates
-- ============================================================================

DROP FUNCTION IF EXISTS cancel_delivery(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION cancel_delivery(
  p_delivery_id     uuid,
  p_cancel_reason   text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_item record;
  v_items_restored integer := 0;
  v_prebooked_reincremented integer := 0;
  v_invoice record;
  v_draft_cancelled integer := 0;
  v_posted_notified integer := 0;
  v_admin record;
  v_order_has_remaining boolean;
  v_order_status text;
BEGIN
  -- Auth enforcement
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND auth.uid() IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

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

  -- *** FIX: Enable admin override BEFORE any status transitions ***
  PERFORM set_config('app.admin_override', 'true', true);

  -- Completed or in_progress: restore any delivered quantity
  -- back to available AND re-increment prebooked (items are
  -- going back to "pending on order" status)
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
          quantity_prebooked = quantity_prebooked + v_item.quantity_delivered,
          updated_at = now()
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          order_id, delivery_id, performed_by, notes
        ) VALUES (
          v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
          v_delivery.order_id, p_delivery_id, v_actor,
          'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name || ' (available + prebooked)'
        );

        UPDATE order_items SET
          quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
          quantity_remaining = quantity_remaining + v_item.quantity_delivered
        WHERE id = v_item.order_item_id;

        v_items_restored := v_items_restored + 1;
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

  -- admin_override already set above (before order status updates)

  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = p_cancel_reason,
    updated_at = now()
  WHERE id = p_delivery_id;

  IF v_delivery.order_id IS NOT NULL THEN
    FOR v_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id
        AND status IN ('draft', 'posted', 'unposted')
        AND deleted_at IS NULL
    LOOP
      IF v_invoice.status IN ('draft', 'unposted') THEN
        UPDATE invoices SET
          status = 'cancelled',
          voided_by = v_actor,
          void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' cancelled',
          updated_at = now()
        WHERE id = v_invoice.id;
        v_draft_cancelled := v_draft_cancelled + 1;
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

  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || v_delivery.delivery_number || ' has been cancelled. Reason: ' || p_cancel_reason,
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_cancelled',
    'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason
      || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' inventory items (available + prebooked).' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- Reset admin override
  PERFORM set_config('app.admin_override', 'false', true);

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'items_restored', v_items_restored,
    'prebooked_reincremented', v_prebooked_reincremented,
    'draft_invoices_cancelled', v_draft_cancelled,
    'posted_invoices_flagged', v_posted_notified
  );
END;
$$;


-- ============================================================================
-- CATEGORY 2 FIX: mark_overdue_invoices — correct columns + system actor
-- ============================================================================

DROP FUNCTION IF EXISTS mark_overdue_invoices();

CREATE OR REPLACE FUNCTION mark_overdue_invoices()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice  record;
  v_count    integer := 0;
BEGIN
  -- Find all posted invoices whose due_date has passed
  FOR v_invoice IN
    SELECT id, invoice_number, customer_id, due_date
    FROM invoices
    WHERE status = 'posted'
      AND due_date < CURRENT_DATE
      AND deleted_at IS NULL
    FOR UPDATE
  LOOP
    -- Transition to overdue
    UPDATE invoices
    SET status     = 'overdue',
        updated_at = now()
    WHERE id = v_invoice.id;

    -- Append-only audit trail (FIX: correct column names + explicit actor)
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_user_id, actor_role,
      new_values, description
    ) VALUES (
      'invoice_marked_overdue',
      'invoice',
      v_invoice.id,
      '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f',  -- system/admin actor for cron context
      'system',
      jsonb_build_object(
        'invoice_number', v_invoice.invoice_number,
        'customer_id',    v_invoice.customer_id,
        'due_date',       v_invoice.due_date,
        'marked_at',      now()
      ),
      'Invoice ' || v_invoice.invoice_number || ' auto-marked overdue (due ' || v_invoice.due_date || ')'
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'invoices_marked_overdue', v_count,
    'run_at', now()
  );
END;
$$;


-- ============================================================================
-- CATEGORY 3 FIX: link_blend_ticket_to_order — correct column names
-- ============================================================================

DROP FUNCTION IF EXISTS link_blend_ticket_to_order(uuid, uuid, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION link_blend_ticket_to_order(
  p_blend_ticket_id  uuid,
  p_order_id         uuid,
  p_item_mappings    jsonb DEFAULT NULL,
  p_performed_by     uuid DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ticket    blend_tickets%ROWTYPE;
  v_order     orders%ROWTYPE;
  v_mapping   jsonb;
  v_count     int := 0;
BEGIN
  PERFORM require_admin_or_sales_rep();
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Order not found');
  END IF;

  IF v_ticket.customer_id IS NOT NULL AND v_ticket.customer_id != v_order.customer_id THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket and order must belong to the same customer');
  END IF;

  IF p_item_mappings IS NOT NULL AND jsonb_array_length(p_item_mappings) > 0 THEN
    FOR v_mapping IN SELECT * FROM jsonb_array_elements(p_item_mappings)
    LOOP
      INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
      VALUES (
        p_blend_ticket_id,
        (v_mapping->>'order_item_id')::uuid,
        p_order_id,
        COALESCE((v_mapping->>'quantity_applied')::numeric, 0),
        p_performed_by
      )
      ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;
      v_count := v_count + 1;
    END LOOP;
  ELSE
    INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
    SELECT
      p_blend_ticket_id,
      oi.id,
      p_order_id,
      btp.quantity,
      p_performed_by
    FROM blend_ticket_products btp
    JOIN order_items oi ON oi.product_id = btp.product_id AND oi.order_id = p_order_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
    ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  UPDATE blend_tickets
  SET order_link_status = 'linked', updated_at = now()
  WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'blend_ticket_linked_to_order',
    'Blend ticket ' || v_ticket.ticket_number || ' linked to order ' || v_order.order_number,
    p_performed_by, 'blend_ticket', p_blend_ticket_id
  );

  -- FIX: correct column names (was event_type/performed_by/metadata)
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, description
  ) VALUES (
    'blend_ticket_linked', 'blend_ticket', p_blend_ticket_id,
    p_performed_by,
    (SELECT role FROM profiles WHERE id = p_performed_by),
    jsonb_build_object('order_id', p_order_id, 'items_linked', v_count),
    'Linked blend ticket ' || v_ticket.ticket_number || ' to order ' || v_order.order_number
  );

  RETURN json_build_object('success', true, 'items_linked', v_count, 'order_id', p_order_id, 'order_number', v_order.order_number);
END;
$$;


-- ============================================================================
-- CATEGORY 3 FIX: unlink_blend_ticket_from_order — correct column names
-- ============================================================================

DROP FUNCTION IF EXISTS unlink_blend_ticket_from_order(uuid, uuid, text);

CREATE OR REPLACE FUNCTION unlink_blend_ticket_from_order(
  p_blend_ticket_id  uuid,
  p_performed_by     uuid DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ticket    blend_tickets%ROWTYPE;
  v_order_id  uuid;
  v_order_num text;
  v_deleted   int;
BEGIN
  PERFORM require_admin_or_sales_rep();
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status != 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is not linked to any order');
  END IF;

  SELECT DISTINCT bto.order_id, o.order_number
  INTO v_order_id, v_order_num
  FROM blend_ticket_to_order_items bto
  JOIN orders o ON o.id = bto.order_id
  WHERE bto.blend_ticket_id = p_blend_ticket_id
  LIMIT 1;

  DELETE FROM blend_ticket_to_order_items WHERE blend_ticket_id = p_blend_ticket_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE blend_tickets
  SET order_link_status = 'unlinked', updated_at = now()
  WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'blend_ticket_unlinked_from_order',
    'Blend ticket ' || v_ticket.ticket_number || ' unlinked from order ' || COALESCE(v_order_num, 'unknown'),
    p_performed_by, 'blend_ticket', p_blend_ticket_id
  );

  -- FIX: correct column names (was event_type/performed_by/metadata)
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, description
  ) VALUES (
    'blend_ticket_unlinked', 'blend_ticket', p_blend_ticket_id,
    p_performed_by,
    (SELECT role FROM profiles WHERE id = p_performed_by),
    jsonb_build_object('order_id', v_order_id, 'items_removed', v_deleted),
    'Unlinked blend ticket ' || v_ticket.ticket_number || ' from order ' || COALESCE(v_order_num, 'unknown')
  );

  RETURN json_build_object('success', true, 'items_removed', v_deleted, 'order_id', v_order_id);
END;
$$;


-- ============================================================================
-- Verify no function overloads
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT proname FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('cancel_delivery', 'mark_overdue_invoices', 'link_blend_ticket_to_order', 'unlink_blend_ticket_from_order')
    GROUP BY proname
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Function overload detected — aborting';
  END IF;
END $$;
