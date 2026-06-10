-- ============================================================================
-- H3 (2026-06-10 foundation ultra review, Codex-concurred HIGH):
-- reverse_receiving_record + _receiving_records_before_delete clamped the
-- inventory decrement at 0 (GREATEST(quantity_available - X, 0)) while the
-- ledger row unconditionally logged the FULL negative X — any reversal
-- exceeding current on-hand silently desynced the append-only ledger from the
-- snapshot (proven: 1,325 units swallowed on Black Strap Molasses Tote,
-- 2026-03-23).
--
-- Fix: subtract the full amount and ALLOW the row to go negative, so
-- ledger == applied change always holds. Deliberately NOT a block: this is a
-- *reversal* — the goods already moved; a negative snapshot is honest and is
-- surfaced by the existing negative-inventory reconciliation path. (Blocking
-- belongs on forward deductions, not reversals.)
--
-- The GREATEST clamps on purchase_order_items.quantity_received are CORRECT
-- and retained (PO received-quantity legitimately floors at 0; not
-- ledger-tracked).
--
-- Both bodies reproduced verbatim from the live definitions (read via the
-- catalog on 2026-06-10); the ONLY change in each is the single inventory
-- UPDATE line losing its GREATEST(..., 0) wrapper.
-- idempotency-body-check: exempt
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reverse_receiving_record(p_record_id uuid, p_reason text DEFAULT 'Manually reversed'::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec    record;
  v_actor  uuid;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'record_id', p_record_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_rec
  FROM receiving_records
  WHERE id = p_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving record not found: %', p_record_id;
  END IF;

  PERFORM set_config('app.reversal_rpc_active', 'true', true);
  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE inventory
  SET quantity_available = quantity_available - v_rec.quantity_received,
      updated_at         = now()
  WHERE product_id = v_rec.product_id
    AND location   = v_rec.storage_location;

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

  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - v_rec.quantity_received, 0)
  WHERE id = v_rec.po_item_id;

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
  WHERE id = v_rec.purchase_order_id;

  DELETE FROM receiving_photos WHERE receiving_record_id = p_record_id;
  DELETE FROM receiving_records WHERE id = p_record_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'reverse_receiving_record', to_jsonb(p_record_id));
  END IF;

  RETURN jsonb_build_object(
    'success',             true,
    'record_id',           p_record_id,
    'product_id',          v_rec.product_id,
    'quantity_reversed',   v_rec.quantity_received,
    'storage_location',    v_rec.storage_location
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._receiving_records_before_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_setting('app.reversal_rpc_active', true) = 'true' THEN
    RETURN OLD;
  END IF;

  UPDATE inventory
  SET quantity_available = quantity_available - OLD.quantity_received,
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

  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - OLD.quantity_received, 0)
  WHERE id = OLD.po_item_id;

  RETURN OLD;
END;
$function$;

-- Verification: clamp gone from both, present nowhere else; single overload
DO $$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND prosrc ILIKE '%greatest(quantity_available%';
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'quantity_available clamp still present in % function(s)', v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'reverse_receiving_record';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'reverse_receiving_record overload count = %, expected 1', v_cnt;
  END IF;
END $$;
