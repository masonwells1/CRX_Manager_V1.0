-- idempotency-body-check: exempt (uses check_idempotency/save_idempotency helpers)
-- Fix (P1, Codex review of PR #67): cancel_return is granted to `authenticated` but had
-- NO in-function auth/role gate — it trusted caller-supplied p_performed_by. Before
-- 20260608154151 added the admin_override bracket, the return status trigger incidentally
-- blocked received -> cancelled; that override removed the only thing stopping a non-admin
-- (driver/applicator) from calling rpc('cancel_return') directly on a received return to
-- reverse inventory and cancel it. (The requested/approved -> cancelled paths were already
-- ungated pre-existing.) The UI only exposes this to admin/sales_rep (App.tsx:189).
--
-- Fix: add the canonical strict-actor + role gate (verbatim pattern from approve_return /
-- receive_return / issue_return_credit), placed at the very top BEFORE the idempotency
-- check so cached results never leak to unauthorized callers. Role set = ('admin',
-- 'sales_rep') to match the Returns page + the sibling return RPCs. Body otherwise
-- identical to the live 20260608154151 definition (override bracket retained).

CREATE OR REPLACE FUNCTION public.cancel_return(p_return_id uuid, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_return         record;
  v_item           record;
  v_cached         jsonb;
  v_result         jsonb;
  v_reversed_ids   uuid[] := ARRAY[]::uuid[];
  v_skipped_ids    uuid[] := ARRAY[]::uuid[];
  v_reversed_qty   bigint := 0;
  v_reversed_count int    := 0;
  v_skipped_count  int    := 0;
  v_was_received   boolean;
  v_actor          uuid;
BEGIN
  -- Codex P1: strict-actor + role gate (canonical pattern from approve_return /
  -- issue_return_credit). MUST run before the idempotency check so a cached result
  -- can never leak to an unauthorized caller.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'cancel_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to cancel a return';
  END IF;

  SELECT id, return_number, status, customer_id INTO v_return
  FROM returns WHERE id = p_return_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found: %', p_return_id;
  END IF;

  IF v_return.status NOT IN ('requested', 'approved', 'received') THEN
    RAISE EXCEPTION 'Cannot cancel return in status "%" - only requested/approved/received returns can be cancelled', v_return.status;
  END IF;

  v_was_received := (v_return.status = 'received');

  IF v_was_received THEN
    FOR v_item IN
      SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
             inv.id AS inv_id, inv.location AS inv_location
      FROM return_items ri
      LEFT JOIN LATERAL (
        SELECT id, location FROM inventory
        WHERE product_id = ri.product_id AND location = 'Main Warehouse'
        LIMIT 1
      ) inv ON true
      WHERE ri.return_id = p_return_id AND ri.restocked = true
      ORDER BY ri.sort_order
    LOOP
      IF v_item.inv_id IS NOT NULL THEN
        UPDATE inventory SET quantity_available = quantity_available - v_item.quantity, updated_at = now() WHERE id = v_item.inv_id;
        INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
        VALUES (v_item.product_id, 'returned', -v_item.quantity, v_item.inv_location, p_performed_by,
                'Cancel of return ' || v_return.return_number || ': ' || v_item.product_name ||
                ' (' || v_item.condition || ') - restock reversed: ' || p_reason);
        v_reversed_ids := array_append(v_reversed_ids, v_item.item_id);
        v_reversed_qty := v_reversed_qty + v_item.quantity;
        v_reversed_count := v_reversed_count + 1;
      ELSE
        RAISE WARNING 'Cancel of return %: item % (product %) was restocked but inventory row no longer exists - skipping reversal, restocked flag will still be cleared.',
          v_return.return_number, v_item.item_id, v_item.product_id;
        v_skipped_ids := array_append(v_skipped_ids, v_item.item_id);
        v_skipped_count := v_skipped_count + 1;
      END IF;
    END LOOP;
  END IF;

  -- Scoped admin-override: the trigger forbids received -> cancelled by default
  -- (blocking direct tampering that would skip the restock reversal above). This
  -- vetted, now role-gated RPC has already done the reversal, so allow the transition
  -- for just this UPDATE, then immediately clear the override.
  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE returns SET status='cancelled', cancelled_at=now(), cancelled_by=p_performed_by,
                     cancellation_reason=p_reason, updated_at=now() WHERE id=p_return_id;

  PERFORM set_config('app.admin_override', 'false', true);

  IF array_length(v_reversed_ids, 1) > 0 OR array_length(v_skipped_ids, 1) > 0 THEN
    UPDATE return_items SET restocked = false WHERE id = ANY(v_reversed_ids || v_skipped_ids);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_cancelled',
          'Return ' || v_return.return_number || ' cancelled' ||
          CASE WHEN v_was_received
               THEN ' - ' || v_reversed_count || ' item(s) un-restocked' ||
                    CASE WHEN v_skipped_count > 0
                         THEN ' (' || v_skipped_count || ' skipped: inventory row missing - admin must reconcile)'
                         ELSE '' END
               ELSE '' END ||
          ': ' || p_reason,
          p_performed_by, 'return', p_return_id, v_return.customer_id);

  v_result := jsonb_build_object('success', true, 'return_id', p_return_id, 'return_number', v_return.return_number,
                                  'status', 'cancelled', 'was_received', v_was_received,
                                  'reversed_count', v_reversed_count, 'reversed_quantity', v_reversed_qty,
                                  'skipped_count', v_skipped_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_return', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
