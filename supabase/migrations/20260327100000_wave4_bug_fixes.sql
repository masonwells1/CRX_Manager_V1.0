-- ============================================================================
-- WAVE 4 BUG FIXES
-- ============================================================================
-- Fixes critical and high-priority bugs found in Wave 4 audit:
--
-- CRITICAL:
--   C1: void_payment — sets balance_cents (GENERATED ALWAYS) directly → remove
--   C2: void_payment — RETURNING gives NEW value (0) not old; SELECT before UPDATE
--   C7: void_payment — SECURITY DEFINER with no admin role check
--   C8: edit_prepay_credit — SECURITY DEFINER with no admin role check
--   C9: delete_prepay_credit — SECURITY DEFINER with no admin role check
--   C10: batch_void_invoices — SECURITY DEFINER; reads role but never gates on it
--
-- HIGH:
--   H1: void_payment — missing check_period_open()
--   H2: record_invoice_payment — missing check_period_open()
--   H4: record_invoice_payment — no p_idempotency_key param; frontend sends key
--       but old overload silently discards it via PostgREST overload mismatch
-- ============================================================================


-- ============================================================================
-- 1. VOID PAYMENT — full replacement
--    Fixes: C1 (GENERATED column), C2 (RETURNING bug), C7 (role check), H1 (period)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_payment(
  p_allocation_set_id uuid,
  p_reason            text,
  p_performed_by      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_set             record;
  v_alloc           record;
  v_actor           uuid;
  v_actor_role      text;
  v_reversed_cents  bigint := 0;
  v_invoice_count   int    := 0;
  v_prepay_reversed bigint := 0;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- C7: Enforce admin-only access
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to void payments';
  END IF;

  -- H1: Reject if current accounting period is closed
  PERFORM check_period_open(now()::date);

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
    -- C1 FIX: Do NOT set balance_cents — it is a GENERATED ALWAYS column that
    -- auto-recomputes as (total - paid - prepay - write_off).  Only update
    -- paid_amount_cents and let the generated expression do the rest.
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) = 0
            AND status = 'paid' THEN 'posted'
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) < total_amount_cents
            AND status = 'paid' THEN 'posted'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;

    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  -- C2 FIX: SELECT the old balance BEFORE zeroing it.
  -- The original code used RETURNING balance_cents which gives the NEW value (0)
  -- after SET balance_cents = 0 — so the customer aggregate was never decremented.
  SELECT balance_cents INTO v_prepay_reversed
  FROM prepay_credits
  WHERE source_type      = 'overpayment'
    AND source_reference = p_allocation_set_id::text
    AND balance_cents    > 0
  FOR UPDATE;

  IF v_prepay_reversed IS NOT NULL AND v_prepay_reversed > 0 THEN
    UPDATE prepay_credits
    SET balance_cents = 0,
        notes         = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']',
        updated_at    = now()
    WHERE source_type      = 'overpayment'
      AND source_reference = p_allocation_set_id::text;

    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0)
    WHERE id = v_set.customer_id;
  END IF;

  -- Mark allocation set as voided
  UPDATE allocation_sets
  SET is_active = false,
      notes     = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']',
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
      'total_payment_cents',   v_set.total_payment_cents,
      'total_allocated_cents', v_set.total_allocated_cents,
      'payment_method',        v_set.payment_method,
      'check_number',          v_set.check_number,
      'customer_id',           v_set.customer_id
    ),
    jsonb_build_object(
      'reason',                p_reason,
      'invoices_reversed',     v_invoice_count,
      'prepay_reversed_cents', COALESCE(v_prepay_reversed, 0)
    ),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  RETURN jsonb_build_object(
    'success',               true,
    'allocation_set_id',     p_allocation_set_id,
    'reversed_cents',        v_reversed_cents,
    'invoices_affected',     v_invoice_count,
    'prepay_reversed_cents', COALESCE(v_prepay_reversed, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_payment(uuid, text, uuid) TO authenticated;


-- ============================================================================
-- 2. RECORD INVOICE PAYMENT — full replacement
--    Fixes: H2 (check_period_open), H4 (idempotency key param)
--    Note: must DROP old 5-param overload before replacing; new signature adds
--    p_idempotency_key as 6th param.
-- ============================================================================

-- Drop the old 5-param overload so PostgREST resolves to the new 6-param version
DROP FUNCTION IF EXISTS public.record_invoice_payment(uuid, bigint, text, text, text);

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id        uuid,
  p_amount_cents      bigint,
  p_payment_method    text,
  p_reference_number  text    DEFAULT NULL,
  p_notes             text    DEFAULT NULL,
  p_idempotency_key   text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv            record;
  v_pay_id         uuid;
  v_cached_result  jsonb;
BEGIN
  -- H4: Return cached result if this is a retry with the same key
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := public.check_idempotency(p_idempotency_key, 'record_invoice_payment');
    IF v_cached_result IS NOT NULL THEN
      RETURN (v_cached_result->>'payment_id')::uuid;
    END IF;
  END IF;

  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status != 'posted' THEN
    RAISE EXCEPTION 'Can only record payments on posted invoices (current status: %)', v_inv.status;
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- H2: Reject if current accounting period is closed
  PERFORM public.check_period_open(now()::date);

  -- balance_cents is a GENERATED ALWAYS column: total - paid - prepay - writeoff
  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Payment ($%) exceeds invoice balance ($%)',
      (p_amount_cents / 100.0)::numeric(12,2),
      (v_inv.balance_cents  / 100.0)::numeric(12,2);
  END IF;

  -- payments.amount is stored as numeric dollars (not cents)
  INSERT INTO public.payments (
    order_id, customer_id, amount, payment_method,
    reference_number, notes, recorded_by
  ) VALUES (
    v_inv.order_id,
    v_inv.customer_id,
    (p_amount_cents / 100.0)::numeric(12,2),
    p_payment_method,
    p_reference_number,
    p_notes,
    auth.uid()
  ) RETURNING id INTO v_pay_id;

  -- balance_cents auto-updates (generated column) when paid_amount_cents changes
  UPDATE public.invoices SET
    paid_amount_cents = paid_amount_cents + p_amount_cents,
    status = CASE
      WHEN (total_amount_cents - (paid_amount_cents + p_amount_cents)
            - prepay_applied_cents - write_off_cents) <= 0
      THEN 'paid'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_recorded', 'payment', v_pay_id,
    (SELECT role FROM public.profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_id',     p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents',   p_amount_cents,
      'method',         p_payment_method,
      'reference',      p_reference_number
    ),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
  );

  -- H4: Save result for idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'record_invoice_payment',
      jsonb_build_object('payment_id', v_pay_id)
    );
  END IF;

  RETURN v_pay_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text, text) TO authenticated;


-- ============================================================================
-- 3. EDIT PREPAY CREDIT — add admin role check
--    Fixes: C8 (SECURITY DEFINER with no role gate)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.edit_prepay_credit(
  p_credit_id         uuid,
  p_new_balance_cents bigint DEFAULT NULL,
  p_reference_number  text   DEFAULT NULL,
  p_bucket_label      text   DEFAULT NULL,
  p_notes             text   DEFAULT NULL,
  p_performed_by      uuid   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_delta       bigint;
  v_actor       uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- C8: Enforce admin-only access
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

  RETURN jsonb_build_object(
    'success',           true,
    'credit_id',         p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid) TO authenticated;


-- ============================================================================
-- 4. DELETE PREPAY CREDIT — add admin role check
--    Fixes: C9 (SECURITY DEFINER with no role gate)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_prepay_credit(
  p_credit_id    uuid,
  p_reason       text,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_actor       uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- C9: Enforce admin-only access
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

  RETURN jsonb_build_object(
    'success',              true,
    'credit_id',            p_credit_id,
    'deleted_balance_cents', v_old_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_prepay_credit(uuid, text, uuid) TO authenticated;


-- ============================================================================
-- 5. BATCH VOID INVOICES — add admin role check
--    Fixes: C10 (SECURITY DEFINER; fetches role but never enforces it)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.batch_void_invoices(
  p_invoice_ids  uuid[],
  p_void_reason  text DEFAULT 'Batch voided',
  p_performed_by uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv        record;
  v_id         uuid;
  v_count      integer := 0;
  v_actor      uuid;
  v_actor_role text;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  -- C10: Enforce admin-only access (was fetching role but never checking it)
  IF v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to batch void invoices';
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  -- Lock all target invoices to prevent concurrent modifications
  FOR v_inv IN
    SELECT *
    FROM invoices
    WHERE id = ANY(p_invoice_ids)
      AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Skip non-posted invoices (don't error, just skip)
    IF v_inv.status <> 'posted' THEN
      CONTINUE;
    END IF;

    -- Void the invoice
    UPDATE invoices SET
      status      = 'voided',
      voided_by   = v_actor,
      voided_at   = now(),
      void_reason = p_void_reason,
      updated_at  = now()
    WHERE id = v_inv.id;

    -- Audit log
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      old_values, new_values, total_impact_cents, description
    ) VALUES (
      'invoice_voided', 'invoice', v_inv.id,
      v_actor_role,
      jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
      jsonb_build_object('status', 'voided', 'void_reason', p_void_reason),
      -1 * COALESCE(v_inv.total_amount_cents, 0),
      'Batch voided invoice ' || COALESCE(v_inv.invoice_number, v_inv.id::text) || ': ' || p_void_reason
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_void_invoices(uuid[], text, uuid) TO authenticated;


-- ============================================================================
-- 6. REVERSE RECEIVING RECORD RPC
--    Fixes: C5 — bulk delete in ReceivingLog bypassed inventory reversal
--    Previously there was no safe way to delete a receiving record; the frontend
--    called .delete() directly, leaving ghost inventory.  This RPC reverts all
--    side-effects atomically before deleting the row.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_receiving_record(
  p_record_id    uuid,
  p_reason       text    DEFAULT 'Manually reversed',
  p_performed_by uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec    record;
  v_actor  uuid;
BEGIN
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

  -- Reverse inventory: subtract what was added at receive time
  UPDATE inventory
  SET quantity_available = GREATEST(quantity_available - v_rec.quantity_received, 0),
      updated_at         = now()
  WHERE product_id = v_rec.product_id
    AND location   = v_rec.storage_location;

  -- Log the inventory adjustment
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, created_by
  ) VALUES (
    v_rec.product_id,
    'adjustment',
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

  RETURN jsonb_build_object(
    'success',             true,
    'record_id',           p_record_id,
    'product_id',          v_rec.product_id,
    'quantity_reversed',   v_rec.quantity_received,
    'storage_location',    v_rec.storage_location
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_receiving_record(uuid, text, uuid) TO authenticated;
