-- Live Foundation Gauntlet Section 1 (2026-06-17) HIGH: link_blend_ticket_to_order and
-- unlink_blend_ticket_from_order are authenticated-callable SECURITY DEFINER mutators that
-- trusted a forgeable p_performed_by actor id. They wrote that caller-supplied id into
-- blend_ticket_to_order_items.created_by, activity_feed.performed_by, and
-- financial_audit_log.actor_user_id (and derived actor_role from it). An admin or sales_rep
-- could call these directly and attribute the link/unlink to another employee, making the
-- blend-ticket order-link audit trail unreliable.
--
-- Fix: the canonical strict-actor block already used by the sibling blend-ticket RPCs in
-- 20260609195713_strict_actor_blend_ticket_rpcs.sql -- bind v_actor := auth.uid(), reject
-- missing auth (AUTH_REQUIRED) and a mismatched p_performed_by (ACTOR_MISMATCH), placed BEFORE
-- the idempotency replay -- then stamp created_by / performed_by / actor_user_id / actor_role
-- from v_actor instead of p_performed_by. Signatures, return shapes, idempotency operation
-- strings, and all business logic are otherwise verbatim from the current live bodies.
-- The UI already passes the current profile id (BlendTicketDetail.tsx), so the legitimate path
-- is unchanged; only a forged actor id is now rejected.

CREATE OR REPLACE FUNCTION public.link_blend_ticket_to_order(p_blend_ticket_id uuid, p_order_id uuid, p_item_mappings jsonb DEFAULT NULL::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_actor uuid; v_ticket blend_tickets%ROWTYPE; v_order orders%ROWTYPE; v_mapping jsonb; v_count int := 0; v_result json; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'link_blend_ticket_to_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing::json; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Blend ticket not found'); END IF;
  IF v_ticket.order_link_status = 'linked' THEN RETURN json_build_object('success', false, 'error', 'Already linked'); END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Order not found'); END IF;
  IF v_ticket.customer_id IS NOT NULL AND v_ticket.customer_id != v_order.customer_id THEN
    RETURN json_build_object('success', false, 'error', 'Customer mismatch');
  END IF;

  IF p_item_mappings IS NOT NULL AND jsonb_array_length(p_item_mappings) > 0 THEN
    FOR v_mapping IN SELECT * FROM jsonb_array_elements(p_item_mappings) LOOP
      INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
      VALUES (p_blend_ticket_id, (v_mapping->>'order_item_id')::uuid, p_order_id, COALESCE((v_mapping->>'quantity_applied')::numeric, 0), v_actor)
      ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;
      v_count := v_count + 1;
    END LOOP;
  ELSE
    INSERT INTO blend_ticket_to_order_items (blend_ticket_id, order_item_id, order_id, quantity_applied, created_by)
    SELECT p_blend_ticket_id, oi.id, p_order_id, btp.quantity, v_actor
    FROM blend_ticket_products btp
    JOIN order_items oi ON oi.product_id = btp.product_id AND oi.order_id = p_order_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL
    ON CONFLICT (blend_ticket_id, order_item_id) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  UPDATE blend_tickets SET order_link_status = 'linked', updated_at = now() WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('blend_ticket_linked_to_order', 'Blend ticket ' || v_ticket.ticket_number || ' linked to order ' || v_order.order_number, v_actor, 'blend_ticket', p_blend_ticket_id);

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, description)
  VALUES ('blend_ticket_linked', 'blend_ticket', p_blend_ticket_id, v_actor, (SELECT role FROM profiles WHERE id = v_actor), jsonb_build_object('order_id', p_order_id, 'items_linked', v_count), 'Linked blend ticket ' || v_ticket.ticket_number || ' to order ' || v_order.order_number);

  v_result := json_build_object('success', true, 'items_linked', v_count, 'order_id', p_order_id, 'order_number', v_order.order_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'link_blend_ticket_to_order', v_result::jsonb);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlink_blend_ticket_from_order(p_blend_ticket_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_actor uuid; v_ticket blend_tickets%ROWTYPE; v_order_id uuid; v_order_num text; v_deleted int; v_result json; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'unlink_blend_ticket_from_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing::json; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Blend ticket not found'); END IF;
  IF v_ticket.order_link_status != 'linked' THEN RETURN json_build_object('success', false, 'error', 'Not linked'); END IF;

  SELECT DISTINCT bto.order_id, o.order_number INTO v_order_id, v_order_num
  FROM blend_ticket_to_order_items bto JOIN orders o ON o.id = bto.order_id
  WHERE bto.blend_ticket_id = p_blend_ticket_id LIMIT 1;

  DELETE FROM blend_ticket_to_order_items WHERE blend_ticket_id = p_blend_ticket_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE blend_tickets SET order_link_status = 'unlinked', updated_at = now() WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('blend_ticket_unlinked_from_order', 'Blend ticket ' || v_ticket.ticket_number || ' unlinked from order ' || COALESCE(v_order_num, 'unknown'), v_actor, 'blend_ticket', p_blend_ticket_id);

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, description)
  VALUES ('blend_ticket_unlinked', 'blend_ticket', p_blend_ticket_id, v_actor, (SELECT role FROM profiles WHERE id = v_actor), jsonb_build_object('order_id', v_order_id, 'items_removed', v_deleted), 'Unlinked blend ticket ' || v_ticket.ticket_number || ' from order ' || COALESCE(v_order_num, 'unknown'));

  v_result := json_build_object('success', true, 'items_removed', v_deleted, 'order_id', v_order_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'unlink_blend_ticket_from_order', v_result::jsonb);
  END IF;

  RETURN v_result;
END;
$function$;
