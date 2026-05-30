-- idempotency-body-check: exempt
--   (approve_return + receive_return use the canonical check_idempotency()/
--    save_idempotency() helper indirection, not inline idempotency_keys SQL.
--    Both reproduced verbatim from live; the ONLY change is the added guard block.)
-- ============================================================================
-- P2-E · approve_return / receive_return: strict-actor + role gate
-- ============================================================================
-- Problem (review 2026-05-28 §5 P2-E):
--   approve_return and receive_return are SECURITY DEFINER but had NO actor or
--   role check — they relied solely on RLS and recorded the caller-supplied
--   p_approved_by / p_received_by verbatim. Any authenticated role (driver,
--   applicator, …) could call them directly via PostgREST, and the actor param
--   was forgeable (record someone else as approver/receiver).
--
-- Fix:
--   Insert the canonical guard block that the sibling issue_return_credit
--   already uses, at the TOP of each function (BEFORE the idempotency check, so
--   a cached result is never returned to an unauthorized caller):
--     v_actor := auth.uid();  AUTH_REQUIRED if null
--     ACTOR_MISMATCH if p_*_by provided and distinct from auth.uid()
--     INSUFFICIENT_ROLE unless profiles.role IN ('admin','sales_rep') AND is_active
--
--   Everything else is reproduced VERBATIM from the live definitions. The
--   recorded actor (approved_by / received_by / activity performed_by) is left
--   as the existing param — the new ACTOR_MISMATCH check guarantees it equals
--   auth.uid() when non-null, so it is no longer forgeable.
--
-- Single overload each (verified live). Both SECURITY DEFINER with
-- search_path = public, pg_temp (unchanged).
-- ============================================================================

-- ─── approve_return ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_return(p_return_id uuid, p_approved_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_return  record;
  v_cached  jsonb;
  v_result  jsonb;
  v_actor   uuid;
BEGIN
  -- P2-E: strict-actor + role gate (canonical pattern from issue_return_credit).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_approved_by IS NOT NULL AND p_approved_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'approve_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT id, return_number, status, customer_id INTO v_return
  FROM returns WHERE id = p_return_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;
  IF v_return.status != 'requested' THEN
    RAISE EXCEPTION 'Only requested returns can be approved (current status: %)', v_return.status;
  END IF;

  UPDATE returns SET status='approved', approved_by=p_approved_by, approved_at=now(), updated_at=now() WHERE id=p_return_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_approved', 'Return ' || v_return.return_number || ' approved', p_approved_by, 'return', p_return_id, v_return.customer_id);

  v_result := jsonb_build_object('success', true, 'return_id', p_return_id, 'return_number', v_return.return_number, 'status', 'approved');

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'approve_return', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ─── receive_return ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.receive_return(p_return_id uuid, p_received_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_return record; v_item record; v_cached jsonb; v_result jsonb;
  v_restocked_ids uuid[] := ARRAY[]::uuid[];
  v_restocked_qty bigint := 0; v_restocked_count int := 0; v_skipped_count int := 0;
  v_actor uuid;
BEGIN
  -- P2-E: strict-actor + role gate (canonical pattern from issue_return_credit).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_received_by IS NOT NULL AND p_received_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'receive_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT id, return_number, status, customer_id INTO v_return
  FROM returns WHERE id = p_return_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;
  IF v_return.status != 'approved' THEN
    RAISE EXCEPTION 'Only approved returns can be received (current status: %)', v_return.status;
  END IF;

  FOR v_item IN
    SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
           inv.id AS inv_id, inv.location AS inv_location
    FROM return_items ri
    LEFT JOIN LATERAL (SELECT id, location FROM inventory WHERE product_id = ri.product_id AND location = 'Main Warehouse' LIMIT 1) inv ON true
    WHERE ri.return_id = p_return_id AND ri.restock = true AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    IF v_item.inv_id IS NOT NULL THEN
      UPDATE inventory SET quantity_available = quantity_available + v_item.quantity, updated_at = now() WHERE id = v_item.inv_id;
      INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
      VALUES (v_item.product_id, 'returned', v_item.quantity, v_item.inv_location, p_received_by,
              'Return ' || v_return.return_number || ': ' || v_item.product_name || ' (' || v_item.condition || ')');
      v_restocked_ids := array_append(v_restocked_ids, v_item.item_id);
      v_restocked_qty := v_restocked_qty + v_item.quantity;
      v_restocked_count := v_restocked_count + 1;
    ELSE
      RAISE WARNING 'No inventory row for product % in return % - item NOT restocked.', v_item.product_id, v_return.return_number;
      v_skipped_count := v_skipped_count + 1;
    END IF;
  END LOOP;

  UPDATE returns SET status='received', received_by=p_received_by, received_at=now(), updated_at=now() WHERE id=p_return_id;

  IF array_length(v_restocked_ids, 1) > 0 THEN
    UPDATE return_items SET restocked = true WHERE id = ANY(v_restocked_ids);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_received',
          'Return ' || v_return.return_number || ' received - ' || v_restocked_count || ' item(s) restocked' ||
          CASE WHEN v_skipped_count > 0 THEN ' (' || v_skipped_count || ' skipped: no inventory row)' ELSE '' END,
          p_received_by, 'return', p_return_id, v_return.customer_id);

  v_result := jsonb_build_object('success', true, 'return_id', p_return_id, 'return_number', v_return.return_number,
                                  'status', 'received', 'restocked_count', v_restocked_count,
                                  'restocked_quantity', v_restocked_qty, 'skipped_count', v_skipped_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_return', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
