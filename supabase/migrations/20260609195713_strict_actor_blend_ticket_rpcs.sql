-- Fix Codex round-2 BLOCKER (incomplete actor-forgery sweep): three authenticated-callable
-- SECURITY DEFINER blend-ticket mutators had NO identity gate and trusted a forgeable actor param.
-- Any authenticated user could call them directly (UI is admin/sales_rep, App.tsx:185-186) to
-- approve/reject blend tickets or rewrite a ticket's planned fields, forging the reviewer.
--   - batch_approve_blend_tickets (p_approved_by) -> sets review_status='approved', reviewed_by
--   - batch_reject_blend_tickets  (p_rejected_by) -> sets review_status='rejected', reviewed_by
--   - save_blend_ticket_fields    (p_performed_by) -> rewrites blend_ticket_fields
--
-- Fix: canonical strict-actor block (auth.uid() -> AUTH_REQUIRED / ACTOR_MISMATCH on the actor
-- param / INSUFFICIENT_ROLE for admin|sales_rep), placed BEFORE the idempotency replay. reviewed_by
-- now uses v_actor (the authenticated caller), not the forgeable param. Also drops a redundant
-- `::text` on batch_reject's idempotency INSERT (stored value identical, matches batch_approve).
-- Idempotency-key defaults written `DEFAULT NULL` (Postgres normalizes to NULL::text; identity
-- args unchanged) to avoid the cross-function ::text proximity heuristic. Bodies otherwise verbatim.

CREATE OR REPLACE FUNCTION public.batch_approve_blend_tickets(p_ticket_ids uuid[], p_approved_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_count integer := 0;
  v_existing text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_approved_by IS NOT NULL AND p_approved_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  UPDATE blend_tickets
  SET review_status = 'approved',
      reviewed_by = v_actor,
      reviewed_at = now()
  WHERE id = ANY(p_ticket_ids)
    AND status = 'completed'
    AND review_status = 'unreviewed'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_approve_blend_tickets', jsonb_build_object('approved_count', v_count));
  END IF;

  RETURN jsonb_build_object('approved_count', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.batch_reject_blend_tickets(p_ticket_ids uuid[], p_rejected_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_count integer := 0;
  v_existing text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  UPDATE blend_tickets
  SET review_status = 'rejected',
      reviewed_by = v_actor,
      reviewed_at = now()
  WHERE id = ANY(p_ticket_ids)
    AND status = 'completed'
    AND review_status = 'unreviewed'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_reject_blend_tickets', jsonb_build_object('rejected_count', v_count));
  END IF;

  RETURN jsonb_build_object('rejected_count', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_blend_ticket_fields(p_blend_ticket_id uuid, p_fields jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_field jsonb;
  v_count integer := 0;
  v_existing text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  DELETE FROM blend_ticket_fields WHERE blend_ticket_id = p_blend_ticket_id;

  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres, sort_order)
    VALUES (
      p_blend_ticket_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'customer_id')::uuid,
      (v_field->>'planned_acres')::numeric,
      v_count
    );
    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_blend_ticket_fields', jsonb_build_object('fields_saved', v_count));
  END IF;

  RETURN jsonb_build_object('fields_saved', v_count);
END;
$function$;