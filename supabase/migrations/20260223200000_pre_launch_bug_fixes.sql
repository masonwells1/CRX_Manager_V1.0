-- Pre-Launch Bug Fix Migration (Session 13)
-- Applied directly to Supabase via MCP; this file is the local record.
--
-- Fixes applied:
--
-- 1. batch_void_invoices: Now delegates to void_invoice() for each invoice,
--    ensuring payment allocations, prepay applications, write-offs, and
--    order totals are all properly reversed (was previously skipping all of these).
--
-- 2. next_cycle_count_number(): New advisory-lock-based sequential number
--    generator for cycle counts (replaces Date.now() collision-prone approach).
--
-- 3. receive_return: Fixed silent restock skip when product has no inventory row.
--    Now creates an inventory row at 'Main Warehouse' instead of silently
--    marking items as restocked=true without actually restocking.
--
-- 4. INV-2026-0005 data repair: Zeroed orphaned paid_amount_cents on voided invoice.
--
-- 5. allocate_payment double-count fix (from session 12, recorded here):
--    Removed manual UPDATE orders from both allocate_payment overloads
--    that duplicated the trg_payment_update_order trigger effect.

-- ============================================================
-- 1. batch_void_invoices: delegate to void_invoice per invoice
-- ============================================================
CREATE OR REPLACE FUNCTION batch_void_invoices(
  p_invoice_ids uuid[],
  p_void_reason text,
  p_performed_by uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv       record;
  v_count     integer := 0;
  v_actor     uuid;
  v_actor_role text;
BEGIN
  PERFORM require_admin_or_sales_rep();
  PERFORM check_rate_limit(auth.uid(), 'batch_void_invoices', 5, 60);
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  FOR v_inv IN
    SELECT id, status FROM invoices
    WHERE id = ANY(p_invoice_ids) AND deleted_at IS NULL
    ORDER BY id FOR UPDATE
  LOOP
    IF v_inv.status <> 'posted' THEN CONTINUE; END IF;

    -- void_invoice handles: allocation reversal, prepay restore, write-off reversal,
    -- total zeroing, order balance update, audit log, activity feed, admin notifications
    PERFORM void_invoice(v_inv.id, p_void_reason);

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'batch_void', 'invoice', p_invoice_ids[1], v_actor_role,
    jsonb_build_object('invoice_count', array_length(p_invoice_ids, 1)),
    jsonb_build_object('voided_count', v_count, 'void_reason', p_void_reason),
    0, 'Batch voided ' || v_count || ' invoice(s) — ' || p_void_reason
  );

  RETURN v_count;
END;
$$;

-- ============================================================
-- 2. next_cycle_count_number: advisory-lock sequential generator
-- ============================================================
CREATE OR REPLACE FUNCTION next_cycle_count_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text;
  v_max_num integer;
  v_next_num integer;
BEGIN
  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::text;

  PERFORM pg_advisory_xact_lock(8675309);

  SELECT COALESCE(MAX(
    CASE
      WHEN count_number ~ ('^CC-' || v_year || '-\d+$')
      THEN (regexp_replace(count_number, '^CC-' || v_year || '-', ''))::integer
      ELSE 0
    END
  ), 0) INTO v_max_num
  FROM cycle_counts
  WHERE count_number LIKE 'CC-' || v_year || '-%';

  v_next_num := v_max_num + 1;

  RETURN 'CC-' || v_year || '-' || LPAD(v_next_num::text, 5, '0');
END;
$$;

-- ============================================================
-- 3. receive_return: create inventory row when missing
-- ============================================================
CREATE OR REPLACE FUNCTION receive_return(
  p_return_id uuid,
  p_received_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_return record;
  v_total_restocked numeric := 0;
  v_inv_id uuid;
BEGIN
  PERFORM require_admin_or_sales_rep();

  SELECT * INTO v_return
  FROM returns WHERE id = p_return_id AND status = 'approved'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in approved status';
  END IF;

  FOR v_item IN
    SELECT ri.*, i.id AS inv_id, i.location
    FROM return_items ri
    LEFT JOIN inventory i ON i.product_id = ri.product_id
    WHERE ri.return_id = p_return_id
      AND ri.restock = true
      AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    v_inv_id := v_item.inv_id;

    IF v_inv_id IS NULL THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_hand, updated_at)
      VALUES (v_item.product_id, 'Main Warehouse', 0, 0, now())
      RETURNING id INTO v_inv_id;
    END IF;

    UPDATE inventory
    SET quantity_available = quantity_available + v_item.quantity, updated_at = now()
    WHERE id = v_inv_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      to_location, performed_by, notes
    ) VALUES (
      v_item.product_id, 'returned', v_item.quantity,
      COALESCE(v_item.location, 'Main Warehouse'), p_received_by,
      'Return ' || v_return.return_number || ': ' || v_item.product_name || ' (' || v_item.condition || ')'
    );
    v_total_restocked := v_total_restocked + v_item.quantity;

    UPDATE return_items SET restocked = true WHERE id = v_item.id;
  END LOOP;

  UPDATE returns
  SET status = 'received', received_by = p_received_by, received_at = now(), updated_at = now()
  WHERE id = p_return_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'return_received', 'return', p_return_id,
    p_received_by, 0,
    'Return ' || v_return.return_number || ' received. ' || v_total_restocked || ' units restocked.'
  );
END;
$$;
