-- 20260701202000_returns_rpc_gating.sql
-- PARKED-004 (codex-driven hunt cycle 2). The returns_update RLS policy is
-- (is_admin() OR requested_by = auth.uid()), and the BEFORE UPDATE OF status trigger
-- only validated the status GRAPH, not the CALLER. So a sales_rep could craft a direct
-- `UPDATE returns SET status='received'|'credited'` on their OWN return, skipping the
-- RPC side-effects (receive_return's inventory restock, issue_return_credit's credit
-- memo). Insider-only, own-returns-only, DATA-INTEGRITY (not theft -- the credit_memo
-- invoice still cannot be forged; save_invoice/PARKED-002 blocks that).
--
-- Fix = the established admin_override pattern, mirrored with a return-specific flag:
--   (1) the transition trigger now requires EITHER _is_admin_override() OR the session
--       flag app.return_rpc='true' (which only the return RPCs set) -> a raw direct
--       status UPDATE is rejected with RETURN_STATUS_VIA_RPC_ONLY.
--   (2) two new canonical RPCs, reject_return + create_return, so the UI stops writing
--       the table directly (Returns.tsx handleReject / handleCreate).
--   (3) approve_return / receive_return / issue_return_credit re-emitted VERBATIM with
--       one added line: PERFORM set_config('app.return_rpc','true',true) before their
--       status UPDATE. cancel_return and unapply_credit_memo are UNCHANGED -- they
--       already wrap their UPDATE in app.admin_override, which the trigger still honors.
-- The trigger is BEFORE UPDATE OF status only, so direct INSERTs (create) never fired it
-- and are unaffected; soft-delete (SET deleted_at) does not target status so is unaffected.

-- ── 1) Gated transition trigger fn (graph rules unchanged; adds the flag requirement) ──
CREATE OR REPLACE FUNCTION public._enforce_return_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;
  -- PARKED-004: a status change must originate from a return RPC (which sets this flag)
  -- or an admin_override block. Closes the direct-UPDATE bypass.
  IF current_setting('app.return_rpc', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'RETURN_STATUS_VIA_RPC_ONLY: return status changes must go through the approve/receive/reject/cancel/issue_return_credit RPCs';
  END IF;

  IF (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
  OR (OLD.status = 'approved' AND NEW.status IN ('received', 'cancelled'))
  OR (OLD.status = 'received' AND NEW.status = 'credited')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid return status transition: % → %', OLD.status, NEW.status;
END;
$function$;

-- ── 2) reject_return — canonical RPC (mirrors approve_return: actor + role + idem + flag) ──
CREATE OR REPLACE FUNCTION public.reject_return(p_return_id uuid, p_rejected_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_return record;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
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

-- ── 3) create_return — atomic + idempotent creation (closes the two-insert race) ──
CREATE OR REPLACE FUNCTION public.create_return(p_return jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor         uuid := auth.uid();
  v_return_id     uuid;
  v_return_number text;
  v_item          jsonb;
  v_count         int := 0;
  v_existing      jsonb;
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
  IF (p_return->>'reason') IS NULL OR trim(p_return->>'reason') = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
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
            COALESCE(v_item->>'condition', 'unopened'), COALESCE((v_item->>'restock')::boolean, false),
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

-- ── 4) approve_return — VERBATIM live def + one line (PERFORM set_config app.return_rpc) ──
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

  PERFORM set_config('app.return_rpc', 'true', true);  -- PARKED-004
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

-- ── 5) receive_return — VERBATIM live def + one line (PERFORM set_config app.return_rpc) ──
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

  PERFORM set_config('app.return_rpc', 'true', true);  -- PARKED-004
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

-- ── 6) issue_return_credit — VERBATIM live def + one line (PERFORM set_config app.return_rpc) ──
CREATE OR REPLACE FUNCTION public.issue_return_credit(p_return_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_return record;
  v_total bigint;
  v_invoice_id uuid;
  v_invoice_num text;
  v_customer_id uuid;
  v_order_id uuid;
  v_return_number text;
  v_salesman_id uuid;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT r.id, r.status, r.customer_id, r.order_id, r.return_number
    INTO v_return
    FROM returns r
   WHERE r.id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND'; END IF;
  IF v_return.status <> 'received' THEN RAISE EXCEPTION 'INVALID_RETURN_STATUS: %', v_return.status; END IF;

  v_customer_id := v_return.customer_id;
  v_order_id := v_return.order_id;
  v_return_number := v_return.return_number;

  PERFORM check_period_open(CURRENT_DATE);

  SELECT COALESCE(SUM(ri.extended_cents), 0)
    INTO v_total
    FROM return_items ri
   WHERE ri.return_id = p_return_id;

  IF v_total <= 0 THEN RAISE EXCEPTION 'RETURN_CREDIT_EMPTY'; END IF;

  v_invoice_num := next_invoice_number('credit_memo');

  IF v_order_id IS NOT NULL THEN
    SELECT o.salesman_id INTO v_salesman_id
      FROM orders o
     WHERE o.id = v_order_id;
  END IF;

  INSERT INTO invoices (
    invoice_number, order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, paid_amount_cents,
    prepay_applied_cents, posted_by, posted_at, invoice_date, due_date,
    header_notes, parent_invoice_id
  ) VALUES (
    v_invoice_num, v_order_id, v_customer_id, 'credit_memo', 'posted', current_season(),
    v_salesman_id, v_actor, -v_total, 0, 0, v_actor, now(),
    CURRENT_DATE, CURRENT_DATE,
    'Credit memo for return ' || v_return_number, NULL
  )
  RETURNING id INTO v_invoice_id;

  PERFORM set_config('app.return_rpc', 'true', true);  -- PARKED-004
  UPDATE returns
     SET status = 'credited',
         total_credit_cents = v_total,
         credit_invoice_id = v_invoice_id,
         credited_at = now(),
         credited_by = v_actor,
         updated_at = now()
   WHERE id = p_return_id;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'credit_memo_created', 'credit_memo', v_invoice_id,
    v_actor, -v_total,
    'Credit memo ' || v_invoice_num || ' created for return ' || v_return_number,
    jsonb_build_object(
      'invoice_id', v_invoice_id,
      'invoice_number', v_invoice_num,
      'return_id', p_return_id,
      'return_number', v_return_number,
      'customer_id', v_customer_id,
      'credit_amount_cents', v_total
    )
  );

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    v_actor, -v_total,
    'Credit issued for return ' || v_return_number || ' -> invoice ' || v_invoice_num,
    jsonb_build_object(
      'credit_invoice_id', v_invoice_id,
      'credit_invoice_number', v_invoice_num,
      'credit_amount_cents', v_total,
      'customer_id', v_customer_id
    )
  );

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return_number,
    'credit_invoice_id', v_invoice_id,
    'credit_invoice_number', v_invoice_num,
    'credit_amount_cents', v_total,
    'customer_id', v_customer_id,
    'credited_at', now()
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'issue_return_credit', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
