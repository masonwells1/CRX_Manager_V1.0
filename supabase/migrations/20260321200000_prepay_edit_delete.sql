-- ============================================================================
-- PREPAY CREDIT EDIT & DELETE RPCs
-- ============================================================================
-- Adds ability to edit or zero-out prepay credit entries.
-- Both operations update the customer aggregate and log to audit.
-- ============================================================================

-- 1. Expand operation_type CHECK to include prepay_edited and prepay_deleted
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
    'order_updated', 'delivery_updated',
    'batch_post', 'batch_void', 'batch_payment',
    'commission_payment_created', 'commission_payment_posted',
    'cycle_count_completed'
  ]));


-- 2. Edit prepay credit RPC
CREATE OR REPLACE FUNCTION public.edit_prepay_credit(
  p_credit_id        uuid,
  p_new_balance_cents bigint    DEFAULT NULL,
  p_reference_number  text      DEFAULT NULL,
  p_bucket_label      text      DEFAULT NULL,
  p_notes             text      DEFAULT NULL,
  p_performed_by      uuid      DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit       record;
  v_old_balance  bigint;
  v_delta        bigint;
  v_actor        uuid;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

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
    balance_cents    = COALESCE(p_new_balance_cents, balance_cents),
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
      'balance_cents', v_old_balance,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents', COALESCE(p_new_balance_cents, v_old_balance),
      'reference_number', COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label', COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  RETURN jsonb_build_object(
    'success', true,
    'credit_id', p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid) TO authenticated;


-- 3. Delete (zero-out) prepay credit RPC
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
      notes = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at = now()
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
      'balance_cents', v_old_balance,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object('balance_cents', 0, 'reason', p_reason),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  RETURN jsonb_build_object(
    'success', true,
    'credit_id', p_credit_id,
    'deleted_balance_cents', v_old_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_prepay_credit(uuid, text, uuid) TO authenticated;
