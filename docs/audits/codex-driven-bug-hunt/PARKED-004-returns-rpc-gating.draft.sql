-- PARKED-004 (codex-driven hunt cycle 2) — DRAFT, NOT APPLIED.
-- Close the returns direct-write bypass: a sales_rep can currently craft a direct
-- `UPDATE returns SET status='received'|'credited'` on their OWN return (RLS
-- returns_update allows requested_by = auth.uid(); the transition trigger only
-- validates the status GRAPH, not the CALLER), skipping the RPC side-effects:
--   * receive_return    -> inventory restock + inventory_transactions
--   * issue_return_credit-> credit-memo issuance (the customer's money-back)
-- Insider-only, own-returns-only, data-integrity (NOT theft: the money EVENT
-- — a credit_memo invoice — still cannot be forged; save_invoice/PARKED-002 blocks it).
--
-- Fix = the established admin_override pattern: status changes require a session
-- flag that ONLY the SECURITY DEFINER return RPCs set. Also adds the two missing
-- canonical RPCs (reject_return, create_return) so the UI stops writing the table
-- directly (Returns.tsx handleReject / handleCreate).
--
-- A COMPLETE migration MUST also add this one line before the status UPDATE in
-- each of the 4 existing transition RPCs (so they keep working under the gated trigger):
--     PERFORM set_config('app.return_rpc', 'true', true);
--   -> approve_return, receive_return, cancel_return, issue_return_credit
-- The migration-review subagent gate verifies this superset before apply.

-- 1) Gated transition trigger (adds the flag requirement; graph rules unchanged).
CREATE OR REPLACE FUNCTION public._enforce_return_status_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;
  -- NEW: a status change must originate from a return RPC (which sets the flag).
  IF current_setting('app.return_rpc', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'RETURN_STATUS_VIA_RPC_ONLY: return status changes must go through approve/receive/cancel/reject/issue_return_credit';
  END IF;
  IF (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
  OR (OLD.status = 'approved'  AND NEW.status IN ('received', 'cancelled'))
  OR (OLD.status = 'received'  AND NEW.status = 'credited')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invalid return status transition: % → %', OLD.status, NEW.status;
END;
$function$;

-- 2) reject_return — canonical RPC mirroring approve_return (actor + role + idem + flag).
CREATE OR REPLACE FUNCTION public.reject_return(p_return_id uuid, p_rejected_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_actor uuid := auth.uid(); v_return record; v_cached jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'reject_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;
  SELECT id, return_number, status, customer_id INTO v_return FROM returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;
  IF v_return.status <> 'requested' THEN
    RAISE EXCEPTION 'Only requested returns can be rejected (current status: %)', v_return.status;
  END IF;
  PERFORM set_config('app.return_rpc', 'true', true);
  UPDATE returns SET status = 'rejected', updated_at = now() WHERE id = p_return_id;
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_rejected', 'Return ' || v_return.return_number || ' rejected', v_actor, 'return', p_return_id, v_return.customer_id);
  v_result := jsonb_build_object('success', true, 'return_id', p_return_id, 'return_number', v_return.return_number, 'status', 'rejected');
  IF p_idempotency_key IS NOT NULL THEN PERFORM save_idempotency(p_idempotency_key, 'reject_return', v_result); END IF;
  RETURN v_result;
END;
$function$;

-- 3) create_return — atomic + idempotent creation (closes the two-insert race).
CREATE OR REPLACE FUNCTION public.create_return(p_return jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_actor uuid := auth.uid(); v_return_id uuid; v_return_number text; v_item jsonb; v_count int := 0; v_existing jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_return');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  IF (p_return->>'customer_id') IS NULL THEN RAISE EXCEPTION 'CUSTOMER_REQUIRED'; END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'ITEMS_REQUIRED'; END IF;

  v_return_number := next_return_number();
  INSERT INTO returns (return_number, customer_id, order_id, reason, reason_notes, notes, requested_by, status)
  VALUES (v_return_number, (p_return->>'customer_id')::uuid, (p_return->>'order_id')::uuid,
          p_return->>'reason', p_return->>'reason_notes', p_return->>'notes', v_actor, 'requested')
  RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN RAISE EXCEPTION 'PRODUCT_REQUIRED'; END IF;
    INSERT INTO return_items (return_id, product_id, product_name, quantity, unit, unit_price_cents, extended_cents, condition, restock, sort_order, notes)
    VALUES (v_return_id, (v_item->>'product_id')::uuid, v_item->>'product_name',
            COALESCE((v_item->>'quantity')::numeric, 0), v_item->>'unit',
            COALESCE((v_item->>'unit_price_cents')::bigint, 0),
            ROUND(COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'unit_price_cents')::bigint, 0))::bigint,
            v_item->>'condition', COALESCE((v_item->>'restock')::boolean, false),
            COALESCE((v_item->>'sort_order')::int, v_count), v_item->>'notes');
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_requested', 'Return ' || v_return_number || ' requested for ' || v_count || ' product(s)', v_actor, 'return', v_return_id, (p_return->>'customer_id')::uuid);

  v_existing := jsonb_build_object('success', true, 'return_id', v_return_id, 'return_number', v_return_number, 'item_count', v_count);
  IF p_idempotency_key IS NOT NULL THEN PERFORM save_idempotency(p_idempotency_key, 'create_return', v_existing); END IF;
  RETURN v_existing;
END;
$function$;

-- 4) (also required, not drafted here) add `PERFORM set_config('app.return_rpc','true',true);`
--    immediately before the status UPDATE in approve_return, receive_return,
--    cancel_return, issue_return_credit.
-- 5) Frontend (green, after migration applies): Returns.tsx handleCreate -> create_return,
--    handleReject -> reject_return (drop the direct .from('returns') insert/update).
