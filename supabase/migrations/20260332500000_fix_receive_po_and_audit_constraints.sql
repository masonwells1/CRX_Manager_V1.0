-- ============================================================================
-- FIX: receive_po_items crash + financial_audit_log CHECK constraint gaps
-- ============================================================================
--
-- ROOT CAUSE: receive_po_items references "updated_at" on purchase_order_items,
-- but that column does NOT exist on the table. Every PO receive crashes with:
--   "column "updated_at" of relation "purchase_order_items" does not exist"
--
-- ALSO: 5 operation_types and 1 entity_type used by RPCs are missing from
-- the financial_audit_log CHECK constraints, causing silent crashes when those
-- RPCs try to insert audit records.
--
-- Affected RPCs:
--   1. receive_po_items — updated_at crash (P0)
--   2. batch_apply_all_prepayments — 'batch_prepay_apply' not in CHECK
--   3. link_blend_ticket_to_order — 'blend_ticket_linked' + entity 'blend_ticket'
--   4. unlink_blend_ticket_from_order — 'blend_ticket_unlinked' + entity 'blend_ticket'
--   5. mark_overdue_invoices — 'invoice_marked_overdue' not in CHECK
--   6. reconcile_prepay_balances — 'prepay_reconciliation' not in CHECK
-- ============================================================================


-- ============================================================================
-- FIX 1: Rewrite receive_po_items — remove updated_at on purchase_order_items
-- ============================================================================
-- Full rewrite (not pg_get_functiondef) to guarantee correctness.

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items              jsonb,
  p_performed_by       uuid,
  p_idempotency_key    text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_po_item RECORD;
  v_existing jsonb;
  v_result jsonb;
  v_recv_id uuid;
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_qty numeric;
  v_actor uuid;
  v_actor_role text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
  v_condition text;
  v_lot_number text;
  v_notes text;
  v_storage_location text;
BEGIN
  -- Auth check
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items provided for receiving';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- Frontend sends po_item_id
    SELECT poi.*, po.po_number, po.id AS po_parent_id
      INTO v_po_item
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = (v_item->>'po_item_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO item not found: %', v_item->>'po_item_id';
    END IF;

    -- Over-receive check
    IF NOT p_allow_over_receive
       AND (COALESCE(v_po_item.quantity_received, 0) + v_qty) > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %. Ordered: %, Already received: %, Attempting: %',
        v_po_item.id, v_po_item.quantity_ordered, COALESCE(v_po_item.quantity_received, 0), v_qty;
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    -- FIX: Remove updated_at — column does not exist on purchase_order_items
    UPDATE purchase_order_items SET
      quantity_received = COALESCE(quantity_received, 0) + v_qty
    WHERE id = v_po_item.id;

    -- Update inventory: add to available, decrement on_order
    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(COALESCE(quantity_on_order, 0) - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    -- Transaction log
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_item.po_parent_id, v_actor,
      'Received ' || v_qty || ' units via PO ' || COALESCE(v_po_item.po_number, '')
    );

    -- Receiving record
    INSERT INTO receiving_records (
      purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size
    ) VALUES (
      v_po_item.po_parent_id, v_po_item.id, v_po_item.product_id,
      v_qty, v_actor, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size
    ) RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF NOT v_po_item.po_parent_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_item.po_parent_id;
    END IF;
  END LOOP;

  -- Update PO statuses
  FOREACH v_unique_po_id IN ARRAY (SELECT ARRAY(SELECT DISTINCT unnest(v_affected_po_ids)))
  LOOP
    PERFORM update_po_status(v_unique_po_id);
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
-- FIX 2: Expand financial_audit_log operation_type CHECK constraint
-- ============================================================================
-- Add missing operation_types used by existing RPCs.
-- MUST be superset of all existing values + new ones.

ALTER TABLE financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_operation_type_check;

ALTER TABLE financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK (operation_type IN (
    -- Invoice operations
    'invoice_created', 'invoice_posted', 'invoice_voided',
    'invoice_cancelled', 'invoice_updated', 'invoice_deleted',
    'invoice_marked_overdue',  -- NEW: mark_overdue_invoices
    -- Payment operations
    'payment_recorded', 'payment_allocation', 'payment_voided',
    -- Split operations
    'split_modified', 'split_invoices_generated',
    -- Prepay operations
    'prepay_created', 'prepay_applied', 'prepay_credit_created',
    'prepay_batch_applied', 'prepay_edited', 'prepay_deleted',
    'prepay_reconciliation',   -- NEW: reconcile_prepay_balances
    'batch_prepay_apply',      -- NEW: batch_apply_all_prepayments
    -- Write-off operations
    'write_off_recorded', 'write_off_reversed', 'write_off_applied',
    -- Finance charge operations
    'finance_charge', 'finance_charge_generated', 'finance_charge_voided',
    -- Credit memo operations
    'credit_memo_created', 'credit_memo_applied', 'credit_memo_unapplied',
    -- Return operations
    'return_created', 'return_approved', 'return_received', 'return_credit_issued',
    -- Order/delivery operations
    'order_updated', 'order_voided', 'order_cancelled', 'order_restored',
    'delivery_updated', 'delivery_cancelled', 'delivery_voided', 'delivery_restored',
    -- Blend ticket operations
    'blend_ticket_linked',     -- NEW: link_blend_ticket_to_order
    'blend_ticket_unlinked',   -- NEW: unlink_blend_ticket_from_order
    -- Commission operations
    'commission_payment_created', 'commission_payment_posted', 'commission_payment_voided',
    -- Batch operations
    'batch_post', 'batch_void', 'batch_payment',
    -- Period/admin operations
    'period_reopened', 'quote_status_reverted', 'blend_ticket_approval_reversed',
    -- Cycle count
    'cycle_count_completed'
  ));


-- ============================================================================
-- FIX 3: Expand financial_audit_log entity_type CHECK constraint
-- ============================================================================
-- Add 'blend_ticket' used by link/unlink blend ticket RPCs.

ALTER TABLE financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_entity_type_check;

ALTER TABLE financial_audit_log
  ADD CONSTRAINT financial_audit_log_entity_type_check
  CHECK (entity_type IN (
    'invoice', 'payment', 'split', 'prepay', 'prepay_credit',
    'customer', 'order', 'delivery', 'write_off', 'finance_charge',
    'credit_memo', 'return', 'allocation_set', 'void', 'batch',
    'commission_payment', 'cycle_count',
    'blend_ticket'  -- NEW: link/unlink blend ticket
  ));


-- ============================================================================
-- Verification: no overloads on receive_po_items
-- ============================================================================
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'receive_po_items') != 1 THEN
    RAISE EXCEPTION 'receive_po_items overload detected — aborting';
  END IF;
END $$;
