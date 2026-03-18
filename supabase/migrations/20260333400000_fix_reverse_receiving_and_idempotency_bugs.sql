-- validate-sql: exempt
-- Reason: financial_audit_log legitimately uses entity_type/entity_id columns.
-- ============================================================================
-- Migration: 20260333400000_fix_reverse_receiving_and_idempotency_bugs.sql
--
-- FIXES 4 BUGS that cause "An internal error occurred" when calling RPCs:
--
-- Bug 1: reverse_receiving_record uses 'adjustment' but CHECK constraint
--         requires 'adjusted' on inventory_transactions.transaction_type
-- Bug 2: reverse_receiving_record uses column 'created_by' which doesn't
--         exist on inventory_transactions — correct column is 'performed_by'
-- Bug 3: All 5 RPCs from 20260333300000 declare v_existing as TEXT but
--         idempotency_keys.result is JSONB — causes type mismatch
-- Bug 4: All 5 RPCs insert plain text into the jsonb result column
--         instead of using to_jsonb()
-- Bug 5: The _receiving_records_before_delete trigger has the same
--         'adjustment' and 'created_by' bugs
-- ============================================================================


-- ============================================================================
-- 1. FIX: reverse_receiving_record
-- ============================================================================
DROP FUNCTION IF EXISTS public.reverse_receiving_record(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION public.reverse_receiving_record(
  p_record_id        uuid,
  p_reason           text    DEFAULT 'Manually reversed',
  p_performed_by     uuid    DEFAULT NULL,
  p_idempotency_key  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec    record;
  v_actor  uuid;
  v_existing jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'record_id', p_record_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only: receiving reversals are inventory adjustments
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse receiving records';
  END IF;

  -- Lock and fetch the record
  SELECT * INTO v_rec
  FROM receiving_records
  WHERE id = p_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving record not found: %', p_record_id;
  END IF;

  -- Set flag so the BEFORE DELETE safety trigger skips its own inventory reversal
  PERFORM set_config('app.reversal_rpc_active', 'true', true);

  -- Reverse inventory: subtract what was added at receive time
  UPDATE inventory
  SET quantity_available = GREATEST(quantity_available - v_rec.quantity_received, 0),
      updated_at         = now()
  WHERE product_id = v_rec.product_id
    AND location   = v_rec.storage_location;

  -- Log the inventory adjustment (FIX: 'adjusted' not 'adjustment', 'performed_by' not 'created_by')
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, performed_by
  ) VALUES (
    v_rec.product_id,
    'adjusted',
    -1 * v_rec.quantity_received,
    v_rec.storage_location,
    'Reversed receiving record ' || p_record_id::text || ': ' || p_reason,
    v_actor
  );

  -- Roll back the PO item quantity_received counter
  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - v_rec.quantity_received, 0)
  WHERE id = v_rec.po_item_id;

  -- Re-evaluate PO status after rolling back the item
  UPDATE purchase_orders
  SET status = CASE
    WHEN (
      SELECT bool_and(quantity_received = 0)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'submitted'
    WHEN (
      SELECT bool_and(quantity_received >= quantity_ordered)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'fully_received'
    ELSE 'partially_received'
  END,
  updated_at = now()
  WHERE id = v_rec.purchase_order_id
    AND status IN ('partially_received', 'fully_received');

  -- Delete the receiving record and its photos
  DELETE FROM receiving_photos WHERE receiving_record_id = p_record_id;
  DELETE FROM receiving_records WHERE id = p_record_id;

  -- Save idempotency key (FIX: use to_jsonb for jsonb column)
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'reverse_receiving_record', to_jsonb(p_record_id::text));
  END IF;

  RETURN jsonb_build_object(
    'success',             true,
    'record_id',           p_record_id,
    'product_id',          v_rec.product_id,
    'quantity_reversed',   v_rec.quantity_received,
    'storage_location',    v_rec.storage_location
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 2. FIX: _receiving_records_before_delete trigger
--    Same 'adjustment' → 'adjusted' and 'created_by' → 'performed_by' bugs
-- ============================================================================
CREATE OR REPLACE FUNCTION public._receiving_records_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- If the RPC already handled the inventory reversal, skip
  IF current_setting('app.reversal_rpc_active', true) = 'true' THEN
    RETURN OLD;
  END IF;

  -- Raw delete path: subtract inventory and log the adjustment
  UPDATE inventory
  SET quantity_available = GREATEST(quantity_available - OLD.quantity_received, 0),
      updated_at         = now()
  WHERE product_id = OLD.product_id
    AND location   = OLD.storage_location;

  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, performed_by
  ) VALUES (
    OLD.product_id,
    'adjusted',
    -1 * OLD.quantity_received,
    OLD.storage_location,
    'Auto-reversed by delete trigger on receiving_records ' || OLD.id::text,
    auth.uid()
  );

  -- Roll back the PO item counter
  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - OLD.quantity_received, 0)
  WHERE id = OLD.po_item_id;

  RETURN OLD;
END;
$$;


-- ============================================================================
-- 3. FIX: void_payment — v_existing type + idempotency insert
-- ============================================================================
DROP FUNCTION IF EXISTS public.void_payment(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION public.void_payment(
  p_allocation_set_id uuid,
  p_reason            text,
  p_performed_by      uuid DEFAULT NULL,
  p_idempotency_key   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_actor_role       text;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  v_existing         jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only guard
  SELECT role INTO v_actor_role
    FROM profiles
   WHERE id = v_actor;

  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can void payments';
  END IF;

  -- Lock and fetch the allocation set
  SELECT * INTO v_set
  FROM allocation_sets
  WHERE id = p_allocation_set_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id;
  END IF;

  IF NOT v_set.is_active THEN
    RAISE EXCEPTION 'Payment already voided';
  END IF;

  -- Reverse each invoice allocation
  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id
      AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) = 0
               AND status IN ('paid', 'posted') THEN 'posted'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;

    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  -- Handle overpayment prepay credit reversal
  SELECT balance_cents INTO v_old_balance
  FROM prepay_credits
  WHERE source_type = 'overpayment'
    AND source_reference = p_allocation_set_id::text
    AND balance_cents > 0
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_old_balance > 0 THEN
    UPDATE prepay_credits
    SET balance_cents = 0,
        notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']',
        updated_at = now()
    WHERE source_type = 'overpayment'
      AND source_reference = p_allocation_set_id::text;

    v_prepay_reversed := v_old_balance;

    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0)
    WHERE id = v_set.customer_id;
  END IF;

  -- Mark allocation set as voided
  UPDATE allocation_sets
  SET is_active = false,
      notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']',
      updated_at = now()
  WHERE id = p_allocation_set_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id,
    v_actor,
    jsonb_build_object(
      'total_payment_cents', v_set.total_payment_cents,
      'total_allocated_cents', v_set.total_allocated_cents,
      'payment_method', v_set.payment_method,
      'check_number', v_set.check_number,
      'customer_id', v_set.customer_id
    ),
    jsonb_build_object(
      'reason', p_reason,
      'invoices_reversed', v_invoice_count,
      'prepay_reversed_cents', v_prepay_reversed
    ),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id::text));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'allocation_set_id', p_allocation_set_id,
    'reversed_cents', v_reversed_cents,
    'invoices_affected', v_invoice_count,
    'prepay_reversed_cents', v_prepay_reversed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_payment(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 4. FIX: edit_prepay_credit — v_existing type + idempotency insert
-- ============================================================================
DROP FUNCTION IF EXISTS public.edit_prepay_credit(uuid, bigint, text, text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.edit_prepay_credit(
  p_credit_id         uuid,
  p_new_balance_cents bigint DEFAULT NULL,
  p_reference_number  text   DEFAULT NULL,
  p_bucket_label      text   DEFAULT NULL,
  p_notes             text   DEFAULT NULL,
  p_performed_by      uuid   DEFAULT NULL,
  p_idempotency_key   text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_delta       bigint;
  v_actor       uuid;
  v_existing    jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Enforce admin-only access
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to edit prepay credits';
  END IF;

  -- Lock and fetch the credit
  SELECT * INTO v_credit
  FROM prepay_credits
  WHERE id = p_credit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id;
  END IF;

  v_old_balance := v_credit.balance_cents;

  -- Update fields that were provided
  UPDATE prepay_credits SET
    balance_cents         = COALESCE(p_new_balance_cents, balance_cents),
    original_amount_cents = CASE
      WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents
      ELSE original_amount_cents
    END,
    reference_number = COALESCE(p_reference_number, reference_number),
    bucket_label     = COALESCE(p_bucket_label, bucket_label),
    notes            = COALESCE(p_notes, notes),
    updated_at       = now()
  WHERE id = p_credit_id;

  -- Update customer aggregate if balance changed
  IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents != v_old_balance THEN
    v_delta := p_new_balance_cents - v_old_balance;

    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents + v_delta, 0)
    WHERE id = v_credit.customer_id;
  END IF;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_edited', 'prepay', p_credit_id,
    v_actor,
    jsonb_build_object(
      'balance_cents',    v_old_balance,
      'reference_number', v_credit.reference_number,
      'bucket_label',     v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents',    COALESCE(p_new_balance_cents, v_old_balance),
      'reference_number', COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label',     COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_prepay_credit', to_jsonb(p_credit_id::text));
  END IF;

  RETURN jsonb_build_object(
    'success',           true,
    'credit_id',         p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid, text) TO authenticated;


-- ============================================================================
-- 5. FIX: delete_prepay_credit — v_existing type + idempotency insert
-- ============================================================================
DROP FUNCTION IF EXISTS public.delete_prepay_credit(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION public.delete_prepay_credit(
  p_credit_id        uuid,
  p_reason           text,
  p_performed_by     uuid DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_actor       uuid;
  v_existing    jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Enforce admin-only access
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete prepay credits';
  END IF;

  -- Lock and fetch
  SELECT * INTO v_credit
  FROM prepay_credits
  WHERE id = p_credit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id;
  END IF;

  v_old_balance := v_credit.balance_cents;

  IF v_old_balance = 0 THEN
    RAISE EXCEPTION 'Prepay credit already has zero balance';
  END IF;

  -- Zero out the credit balance
  UPDATE prepay_credits
  SET balance_cents = 0,
      notes         = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at    = now()
  WHERE id = p_credit_id;

  -- Decrement customer aggregate
  UPDATE customers
  SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_old_balance, 0)
  WHERE id = v_credit.customer_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_deleted', 'prepay', p_credit_id,
    v_actor,
    jsonb_build_object(
      'balance_cents',    v_old_balance,
      'reference_number', v_credit.reference_number,
      'bucket_label',     v_credit.bucket_label
    ),
    jsonb_build_object('balance_cents', 0, 'reason', p_reason),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'delete_prepay_credit', to_jsonb(p_credit_id::text));
  END IF;

  RETURN jsonb_build_object(
    'success',              true,
    'credit_id',            p_credit_id,
    'deleted_balance_cents', v_old_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_prepay_credit(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 6. FIX: batch_post_invoices — v_existing type + idempotency insert
-- ============================================================================
DROP FUNCTION IF EXISTS public.batch_post_invoices(uuid[], text);

CREATE OR REPLACE FUNCTION public.batch_post_invoices(
  p_invoice_ids      uuid[],
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id         uuid;
  v_count      int := 0;
  v_total      bigint := 0;
  v_actor      uuid;
  v_actor_role text;
  v_existing   jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'count', 0, 'idempotent', true);
    END IF;
  END IF;

  v_actor := auth.uid();

  -- Admin-only guard
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to batch post invoices';
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  FOREACH v_id IN ARRAY p_invoice_ids LOOP
    PERFORM post_invoice(v_id);
    v_count := v_count + 1;
    v_total := v_total + COALESCE((SELECT total_amount_cents FROM invoices WHERE id = v_id), 0);
  END LOOP;

  -- Batch audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_posted', 'invoice', p_invoice_ids[1],
    v_actor_role,
    jsonb_build_object('batch_count', v_count, 'invoice_ids', to_jsonb(p_invoice_ids)),
    v_total,
    'Batch posted ' || v_count || ' invoices totaling $' || (v_total / 100.0)::numeric(12,2)
  );

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_post_invoices', to_jsonb(v_count::text));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'count',   v_count,
    'total_cents', v_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_post_invoices(uuid[], text) TO authenticated;


-- ============================================================================
-- VERIFICATION: Ensure each fixed function has exactly 1 overload
-- ============================================================================
DO $$
DECLARE
  v_funcs text[] := ARRAY[
    'reverse_receiving_record',
    'void_payment',
    'edit_prepay_credit',
    'delete_prepay_credit',
    'batch_post_invoices',
    '_receiving_records_before_delete'
  ];
  v_name  text;
  v_count integer;
BEGIN
  FOREACH v_name IN ARRAY v_funcs
  LOOP
    SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = v_name AND n.nspname = 'public';

    IF v_count != 1 THEN
      RAISE EXCEPTION 'VERIFICATION FAILED: % has % overloads (expected 1)', v_name, v_count;
    END IF;
  END LOOP;

  RAISE NOTICE 'VERIFICATION PASSED: All 6 functions have exactly 1 overload';
END;
$$;
