-- ============================================================================
-- Codex remediation-batch review (2026-06-10) — MED: raw receiving deletes
-- left the PO header stale.
--
-- _receiving_records_before_delete (attached 20260610132136) reduced
-- purchase_order_items.quantity_received but never recalculated
-- purchase_orders.status — a raw delete against a fully_received PO left the
-- header incorrectly 'fully_received' (and unable to receive again), where
-- the reverse_receiving_record RPC path recalculates it.
--
-- Fix: append the SAME status CASE the RPC uses (submitted /
-- fully_received / partially_received), guarded on OLD.purchase_order_id.
-- Body otherwise verbatim from the live definition (read via the catalog
-- 2026-06-10). purchase_orders HAS updated_at (set, as in the RPC);
-- receiving_records does NOT (never set — no-updated_at list).
--
-- Reviewer round (compliance MED + rls M2, both this batch): the recalc must
-- NOT touch a cancelled PO — (a) cancelled is terminal in the documented
-- lifecycle, and (b) on the trigger path (no app.admin_override) the
-- cancelled→active write would be rejected by _enforce_po_status_transition
-- and abort the whole delete. `AND status <> 'cancelled'` added to the WHERE
-- — and, for parity, the SAME guard is folded into reverse_receiving_record
-- below (its body is otherwise verbatim from the applied 20260610131048,
-- which md5-matches live).
-- ============================================================================

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

  IF OLD.purchase_order_id IS NOT NULL THEN
    UPDATE purchase_orders
    SET status = CASE
      WHEN (
        SELECT bool_and(quantity_received = 0)
        FROM purchase_order_items
        WHERE purchase_order_id = OLD.purchase_order_id
      ) THEN 'submitted'
      WHEN (
        SELECT bool_and(quantity_received >= quantity_ordered)
        FROM purchase_order_items
        WHERE purchase_order_id = OLD.purchase_order_id
      ) THEN 'fully_received'
      ELSE 'partially_received'
    END,
    updated_at = now()
    WHERE id = OLD.purchase_order_id
      AND status <> 'cancelled';
  END IF;

  RETURN OLD;
END;
$function$;

-- Parity: the RPC path gets the same cancelled-PO guard (body verbatim from
-- the applied 20260610131048 otherwise).
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
  WHERE id = v_rec.purchase_order_id
    AND status <> 'cancelled';

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

-- Verification: trigger fn updated and still attached
DO $$
DECLARE v_src text; v_attached int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = '_receiving_records_before_delete';
  IF v_src NOT ILIKE '%purchase_orders%' THEN
    RAISE EXCEPTION 'PO header status recalc missing from trigger fn';
  END IF;
  SELECT count(*) INTO v_attached FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'receiving_records' AND t.tgname = 'trg_receiving_records_before_delete';
  IF v_attached <> 1 THEN
    RAISE EXCEPTION 'trg_receiving_records_before_delete attachment count = %, expected 1', v_attached;
  END IF;
END $$;
