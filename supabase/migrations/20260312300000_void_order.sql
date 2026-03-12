-- ============================================================================
-- VOID ORDER RPC
-- ============================================================================
-- Adds ability for admins to void a FULFILLED order.
-- This is distinct from cancel_order() which only handles pre-fulfillment.
--
-- What void_order() does:
--   1. Validates order exists and is fulfilled
--   2. Validates caller is admin
--   3. Sets order status to 'voided'
--   4. Restores quantity_available for all delivered items
--   5. Creates inventory_transactions records (restoration)
--   6. Auto-voids draft invoices, notifies admins about posted ones
--   7. Cancels pending commissions, flags paid commissions
--   8. Logs to financial_audit_log (order_voided)
--   9. Logs to activity_feed
--
-- Schema changes required:
--   - orders.status CHECK: add 'voided'
--   - financial_audit_log.operation_type CHECK: add 'order_voided'
-- ============================================================================


-- ============================================================================
-- STEP 1: Expand orders.status CHECK to include 'voided'
-- ============================================================================

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled', 'voided'));


-- ============================================================================
-- STEP 2: Expand financial_audit_log.operation_type CHECK to include 'order_voided'
-- ============================================================================

ALTER TABLE financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_operation_type_check;

ALTER TABLE financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK (operation_type = ANY (ARRAY[
    'invoice_created', 'invoice_posted', 'invoice_voided',
    'invoice_cancelled', 'invoice_updated', 'invoice_deleted',
    'payment_recorded', 'payment_allocation', 'payment_voided',
    'split_modified', 'split_invoices_generated',
    'prepay_created', 'prepay_applied', 'prepay_credit_created',
    'prepay_batch_applied', 'prepay_edited', 'prepay_deleted',
    'write_off_recorded', 'write_off_reversed', 'write_off_applied',
    'finance_charge', 'finance_charge_generated', 'finance_charge_voided',
    'credit_memo_created', 'credit_memo_applied',
    'return_created', 'return_approved', 'return_received', 'return_credit_issued',
    'order_updated', 'order_voided', 'order_cancelled',
    'delivery_updated', 'delivery_cancelled',
    'batch_post', 'batch_void', 'batch_payment',
    'commission_payment_created', 'commission_payment_posted',
    'cycle_count_completed'
  ]));


-- ============================================================================
-- STEP 3: Create void_order() RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.void_order(
  p_order_id     uuid,
  p_performed_by uuid,
  p_reason       text DEFAULT 'Voided by admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order               record;
  v_item                record;
  v_invoice             record;
  v_admin               record;
  v_inventory_restored  integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions    integer := 0;
  v_draft_voided        integer := 0;
  v_posted_notified     integer := 0;
BEGIN
  -- Lock and fetch order
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Only fulfilled orders can be voided
  IF v_order.status != 'fulfilled' THEN
    RAISE EXCEPTION 'void_order only applies to fulfilled orders. This order is %', v_order.status;
  END IF;

  -- Admin-only operation
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can void orders';
  END IF;

  -- -------------------------------------------------------------------------
  -- Set order status to voided
  -- -------------------------------------------------------------------------
  UPDATE public.orders
    SET status     = 'voided',
        updated_at = now()
  WHERE id = p_order_id;

  -- -------------------------------------------------------------------------
  -- Restore quantity_available for all delivered items
  -- For a fulfilled order, quantity_prebooked is already 0 (all delivered).
  -- We restore quantity_available to reflect returned/reversed inventory.
  -- -------------------------------------------------------------------------
  FOR v_item IN
    SELECT product_id, quantity_delivered
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(quantity_delivered, 0) > 0
  LOOP
    UPDATE public.inventory
      SET quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at         = now()
    WHERE product_id = v_item.product_id
      AND location   = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id,
      'adjusted',
      v_item.quantity_delivered,
      'Main Warehouse',
      p_order_id,
      p_performed_by,
      'Restored ' || v_item.quantity_delivered || ' units — order ' ||
        v_order.order_number || ' voided. Reason: ' || p_reason
    );

    v_inventory_restored := v_inventory_restored + 1;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- Cancel pending commissions (don't touch paid ones)
  -- -------------------------------------------------------------------------
  UPDATE public.commissions
    SET status            = 'cancelled',
        commission_amount = 0
  WHERE order_id = p_order_id
    AND status   = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- Count and flag paid commissions for admin review
  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions
  WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id, title, message,
        notification_type, related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Voided Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was voided but has ' ||
          v_paid_commissions || ' paid commission(s). Manual review required.',
        'void_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  -- -------------------------------------------------------------------------
  -- Void draft invoices, notify admins about posted ones
  -- -------------------------------------------------------------------------
  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id   = p_order_id
      AND deleted_at IS NULL
      AND status     IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      UPDATE public.invoices
        SET status              = 'voided',
            voided_by           = p_performed_by,
            voided_at           = now(),
            void_reason         = 'Order ' || v_order.order_number || ' voided. ' || p_reason,
            balance_cents       = 0,
            updated_at          = now()
      WHERE id = v_invoice.id;

      INSERT INTO public.financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_voided', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'voided', 'void_reason', 'Order voided'),
        -1 * v_invoice.total_amount_cents,
        'Auto-voided draft invoice ' || v_invoice.invoice_number ||
          ' — order ' || v_order.order_number || ' voided'
      );

      v_draft_voided := v_draft_voided + 1;

    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (
          user_id, title, message,
          notification_type, related_entity_type, related_entity_id
        ) VALUES (
          v_admin.id,
          'Voided Order — Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' was voided. Invoice ' ||
            v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'void_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- Audit log entry for the void operation itself
  -- -------------------------------------------------------------------------
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_voided', 'order', p_order_id, 'admin',
    jsonb_build_object('status', 'fulfilled', 'total_price', v_order.total_price),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -1 * ROUND(v_order.total_price * 100)::bigint,
    'Order ' || v_order.order_number || ' voided. Reason: ' || p_reason
  );

  -- -------------------------------------------------------------------------
  -- Activity feed
  -- -------------------------------------------------------------------------
  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_voided',
    'Order ' || v_order.order_number || ' voided. ' ||
      v_inventory_restored || ' product(s) inventory restored. ' ||
      v_commissions_cancelled || ' commission(s) cancelled. ' ||
      v_draft_voided || ' draft invoice(s) voided.' ||
      CASE WHEN v_posted_notified > 0
           THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.'
           ELSE '' END ||
      CASE WHEN v_paid_commissions > 0
           THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.'
           ELSE '' END ||
      ' Reason: ' || p_reason,
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object(
    'status',                    'voided',
    'order_number',              v_order.order_number,
    'inventory_products_restored', v_inventory_restored,
    'commissions_cancelled',     v_commissions_cancelled,
    'paid_commissions_flagged',  v_paid_commissions,
    'draft_invoices_voided',     v_draft_voided,
    'posted_invoices_flagged',   v_posted_notified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_order(uuid, uuid, text) TO authenticated;
