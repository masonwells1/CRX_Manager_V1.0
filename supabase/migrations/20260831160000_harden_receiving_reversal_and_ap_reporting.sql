-- STATUS: PARKED - NOT APPLIED
-- Gauntlet Section 9: receiving reversal safety and accurate AP calendar reporting.
--
-- This migration is intentionally post-high-water and additive. It binds each
-- reversal receipt to the authenticated actor and exact record/reason intent,
-- blocks reversal after an active PO-linked bill exists or after the accounting
-- period closes, proves that one inventory row was decremented, and snapshots
-- the deleted receipt/photo evidence in the immutable financial audit log.

-- Freeze receipt writes across the catalog cutover. A pre-migration receipt
-- cannot be safely rebound because its record/reason intent is unknowable.
LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;
DO $section9_reversal_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.idempotency_keys
    WHERE operation = 'reverse_receiving_record'
      AND (expires_at IS NULL OR expires_at >= transaction_timestamp())
      AND (request_actor_id IS NULL OR request_fingerprint IS NULL)
  ) THEN
    RAISE EXCEPTION 'SECTION9_INTENT_CUTOVER_BLOCKED: unexpired unbound reverse_receiving_record receipt exists';
  END IF;
END;
$section9_reversal_cutover$;

ALTER TABLE public.financial_audit_log
  DROP CONSTRAINT financial_audit_log_entity_type_check;
ALTER TABLE public.financial_audit_log
  ADD CONSTRAINT financial_audit_log_entity_type_check CHECK (entity_type = ANY (ARRAY[
    'invoice','payment','split','prepay','prepay_credit','customer','order','delivery',
    'write_off','finance_charge','credit_memo','return','allocation_set','void','batch',
    'commission_payment','cycle_count','blend_ticket','vendor_bill','vendor_payment',
    'purchase_order','accounting_period','quote','receiving_record'
  ]::text[]));

ALTER TABLE public.financial_audit_log
  DROP CONSTRAINT financial_audit_log_operation_type_check;
ALTER TABLE public.financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check CHECK (operation_type = ANY (ARRAY[
    'invoice_created','invoice_posted','invoice_unposted','invoice_voided','invoice_cancelled',
    'invoice_updated','invoice_deleted','invoice_marked_overdue','payment_recorded',
    'payment_allocation','payment_voided','payment_allocated','split_modified',
    'split_invoices_generated','prepay_created','prepay_applied','prepay_credit_created',
    'prepay_batch_applied','prepay_edited','prepay_deleted','prepay_reconciliation',
    'batch_prepay_apply','write_off_recorded','write_off_reversed','write_off_applied',
    'finance_charge','finance_charge_generated','finance_charge_voided','credit_memo_created',
    'credit_memo_applied','credit_memo_unapplied','return_created','return_approved',
    'return_received','return_credit_issued','order_created','order_updated','order_voided',
    'order_cancelled','order_restored','delivery_created','delivery_updated',
    'delivery_cancelled','delivery_voided','delivery_restored','quote_converted',
    'blend_ticket_linked','blend_ticket_unlinked','commission_payment_created',
    'commission_payment_posted','commission_payment_voided','batch_post','batch_void',
    'batch_payment','period_reopened','quote_status_reverted','blend_ticket_approval_reversed',
    'cycle_count_completed','vendor_bill_created','vendor_bill_voided','vendor_bill_updated',
    'vendor_payment_recorded','vendor_payment_voided','rup_sales_voided','receiving_reversed'
  ]::text[]));

CREATE OR REPLACE FUNCTION public._section9_reverse_receiving_record_serialized(
  p_record_id uuid,
  p_reason text DEFAULT 'Manually reversed',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_rec public.receiving_records%ROWTYPE;
  v_actor uuid;
  v_actor_role text;
  v_existing jsonb;
  v_result jsonb;
  v_photos jsonb;
  v_inventory_rows integer;
  v_po_item_rows integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'reverse_receiving_record');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_rec
  FROM public.receiving_records
  WHERE id = p_record_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receiving record not found: %', p_record_id; END IF;

  PERFORM public.check_period_open(
    (v_rec.received_at AT TIME ZONE 'America/Chicago')::date
  );

  IF EXISTS (
    SELECT 1
    FROM public.vendor_bills vb
    WHERE vb.purchase_order_id = v_rec.purchase_order_id
      AND vb.deleted_at IS NULL
      AND vb.status <> 'voided'
  ) THEN
    RAISE EXCEPTION
      'RECEIVING_REVERSAL_BLOCKED_BY_VENDOR_BILL: void the active PO-linked vendor bill before reversing receipt %',
      p_record_id;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(rp) ORDER BY rp.sort_order, rp.uploaded_at), '[]'::jsonb)
  INTO v_photos
  FROM public.receiving_photos rp
  WHERE rp.receiving_record_id = p_record_id;

  PERFORM set_config('app.reversal_rpc_active', 'true', true);
  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE public.inventory
  SET quantity_available = quantity_available - v_rec.quantity_received,
      updated_at = now()
  WHERE product_id = v_rec.product_id
    AND location = v_rec.storage_location;
  GET DIAGNOSTICS v_inventory_rows = ROW_COUNT;
  IF v_inventory_rows <> 1 THEN
    RAISE EXCEPTION
      'RECEIVING_REVERSAL_INVENTORY_MISMATCH: expected one inventory row, updated %',
      v_inventory_rows;
  END IF;

  INSERT INTO public.inventory_transactions (
    product_id, transaction_type, quantity, to_location, notes, performed_by
  ) VALUES (
    v_rec.product_id,
    'adjusted',
    -1 * v_rec.quantity_received,
    v_rec.storage_location,
    'Reversed receiving record ' || p_record_id::text || ': ' || btrim(p_reason),
    v_actor
  );

  UPDATE public.purchase_order_items
  SET quantity_received = GREATEST(quantity_received - v_rec.quantity_received, 0)
  WHERE id = v_rec.po_item_id;
  GET DIAGNOSTICS v_po_item_rows = ROW_COUNT;
  IF v_po_item_rows <> 1 THEN
    RAISE EXCEPTION
      'RECEIVING_REVERSAL_PO_ITEM_MISMATCH: expected one PO item, updated %',
      v_po_item_rows;
  END IF;

  UPDATE public.purchase_orders
  SET status = CASE
      WHEN (
        SELECT bool_and(quantity_received = 0)
        FROM public.purchase_order_items
        WHERE purchase_order_id = v_rec.purchase_order_id
      ) THEN 'submitted'
      WHEN (
        SELECT bool_and(quantity_received >= quantity_ordered)
        FROM public.purchase_order_items
        WHERE purchase_order_id = v_rec.purchase_order_id
      ) THEN 'fully_received'
      ELSE 'partially_received'
    END,
    updated_at = now()
  WHERE id = v_rec.purchase_order_id
    AND status <> 'cancelled';

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'receiving_reversed',
    'receiving_record',
    p_record_id,
    v_actor,
    v_actor_role,
    jsonb_build_object('receiving_record', to_jsonb(v_rec), 'photos', v_photos),
    jsonb_build_object('reason', btrim(p_reason)),
    'Receiving record reversed; deleted source and photo metadata preserved in old_values'
  );

  DELETE FROM public.receiving_photos WHERE receiving_record_id = p_record_id;
  DELETE FROM public.receiving_records WHERE id = p_record_id;

  v_result := jsonb_build_object(
    'success', true,
    'record_id', p_record_id,
    'product_id', v_rec.product_id,
    'quantity_reversed', v_rec.quantity_received,
    'storage_location', v_rec.storage_location
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key, 'reverse_receiving_record', v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._section9_reverse_receiving_record_serialized(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reverse_receiving_record(
  p_record_id uuid,
  p_reason text DEFAULT 'Manually reversed',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_reason text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REQUIRED: reverse_receiving_record requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'record_id', p_record_id,
        'reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'reverse_receiving_record', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._section9_reverse_receiving_record_serialized(
    p_record_id, v_reason, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
  SET request_fingerprint = v_fingerprint,
      request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key
    AND operation = 'reverse_receiving_record';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text)
  TO authenticated, service_role;

-- Browser users may delete an individual governed photo under RLS, but may not
-- bypass row policies by truncating the entire evidence table.
REVOKE TRUNCATE ON TABLE public.receiving_photos FROM authenticated;

DROP FUNCTION public.get_ap_aging(date);
CREATE FUNCTION public.get_ap_aging(
  p_as_of_date date DEFAULT ((clock_timestamp() AT TIME ZONE 'America/Chicago')::date)
)
RETURNS TABLE(
  vendor_id uuid,
  vendor_name text,
  current_amount bigint,
  days_1_30 bigint,
  days_31_60 bigint,
  days_61_90 bigint,
  over_90 bigint,
  total_outstanding bigint,
  bill_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.require_admin();
  IF p_as_of_date IS DISTINCT FROM ((clock_timestamp() AT TIME ZONE 'America/Chicago')::date) THEN
    RAISE EXCEPTION
      'HISTORICAL_AP_UNAVAILABLE: exact AP history is unavailable before durable bill-state history exists';
  END IF;

  RETURN QUERY
  SELECT
    v.id,
    v.name,
    COALESCE(SUM(CASE WHEN vb.due_date >= p_as_of_date THEN vb.balance_cents ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.due_date) BETWEEN 1 AND 30 THEN vb.balance_cents ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.due_date) BETWEEN 31 AND 60 THEN vb.balance_cents ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.due_date) BETWEEN 61 AND 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.due_date) > 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint,
    COALESCE(SUM(vb.balance_cents), 0)::bigint,
    COUNT(vb.id)::integer
  FROM public.vendors v
  LEFT JOIN public.vendor_bills vb
    ON vb.vendor_id = v.id
   AND vb.status IN ('unpaid', 'partially_paid')
   AND vb.deleted_at IS NULL
   AND vb.bill_date <= p_as_of_date
  WHERE v.deleted_at IS NULL
  GROUP BY v.id, v.name
  HAVING COALESCE(SUM(vb.balance_cents), 0) > 0
  ORDER BY COALESCE(SUM(vb.balance_cents), 0) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ap_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ap_aging(date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ap_dashboard_summary(
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
  v_today date := (clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_month_end date;
BEGIN
  PERFORM public.require_admin();
  v_month_end := (date_trunc('month', v_today)::date + INTERVAL '1 month - 1 day')::date;

  SELECT jsonb_build_object(
    'total_owed_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid','partially_paid') THEN balance_cents ELSE 0 END), 0),
    'overdue_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid','partially_paid') AND due_date < v_today THEN balance_cents ELSE 0 END), 0),
    'overdue_count', COUNT(CASE WHEN status IN ('unpaid','partially_paid') AND due_date < v_today THEN 1 END),
    'due_this_week_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid','partially_paid') AND due_date BETWEEN v_today AND v_today + 7 THEN balance_cents ELSE 0 END), 0),
    'due_this_week_count', COUNT(CASE WHEN status IN ('unpaid','partially_paid') AND due_date BETWEEN v_today AND v_today + 7 THEN 1 END),
    'due_this_month_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid','partially_paid') AND due_date BETWEEN v_today AND v_month_end THEN balance_cents ELSE 0 END), 0),
    'total_bills', COUNT(*),
    'unpaid_count', COUNT(CASE WHEN status IN ('unpaid','partially_paid') THEN 1 END),
    'paid_this_month_cents', COALESCE((
      SELECT SUM(vp.amount_cents)
      FROM public.vendor_payments vp
      JOIN public.vendor_bills vb2 ON vb2.id = vp.vendor_bill_id
      WHERE vp.payment_date BETWEEN date_trunc('month', v_today)::date AND v_month_end
        AND vp.voided_at IS NULL
        AND vb2.deleted_at IS NULL
        AND vb2.status <> 'voided'
    ), 0)
  ) INTO v_result
  FROM public.vendor_bills
  WHERE deleted_at IS NULL AND status <> 'voided';

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_ap_dashboard_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ap_dashboard_summary(text) TO authenticated, service_role;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'reverse_receiving_record';
  IF v_count <> 1 THEN RAISE EXCEPTION 'reverse_receiving_record overload count = %', v_count; END IF;

  IF has_function_privilege('anon', 'public.reverse_receiving_record(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anonymous reversal execution must remain revoked';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.reverse_receiving_record(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated reversal execution grant missing';
  END IF;
  IF has_function_privilege('authenticated', 'public._section9_reverse_receiving_record_serialized(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'unguarded reversal implementation is browser-executable';
  END IF;
  IF has_table_privilege('authenticated', 'public.receiving_photos', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated receiving_photos TRUNCATE grant remains';
  END IF;
END;
$verify$;
