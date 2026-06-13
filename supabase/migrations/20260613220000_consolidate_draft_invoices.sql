-- Roadmap #4 (sell-side) — order billing cockpit — (b) consolidate_draft_invoices
-- ============================================================================
-- FILE-ONLY (NOT applied — apply at G5). Agvance-pattern: merge an order's
-- multiple DRAFT per-delivery invoices into ONE draft so the order is billed on a
-- single invoice. Draft-only — never touches posted/paid invoices, the accounting
-- period, or financial_audit_log (drafts carry no posted financial impact).
--
-- Mechanics: lock the order's draft invoices (post_invoice_group pattern), keep
-- the OLDEST (by invoice_number) as the survivor, move every other draft's
-- invoice_items onto it, recompute the survivor's total_amount_cents from its
-- merged items, then cancel the now-empty source drafts (draft→cancelled is
-- allowed by _enforce_invoice_status_transition — no override needed). The
-- survivor keeps its delivery_id (intentional: it stays a valid invoice; we
-- don't null it, which would risk the delivery→invoice linkage / re-invoicing).
-- Idempotent (≥2 drafts required; 0/1 → no-op success), strict-actor, audited.
--
-- SECDEF + search_path; admin/sales_rep gate; tokens already in RpcErrorCodes
-- (AUTH_REQUIRED/ACTOR_MISMATCH/INSUFFICIENT_ROLE/ORDER_NOT_FOUND). ACL mirrors
-- create_invoice_from_order (authenticated + service_role; no anon). Reviewed:
-- rls + drift (codex=PENDING → pre-G5 batch). Smoke:
-- docs/roadmap/smoke/04b-consolidate-draft-invoices.sql.

CREATE OR REPLACE FUNCTION public.consolidate_draft_invoices(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor      uuid;
  v_cached     jsonb;
  v_order      record;
  v_source_ids uuid[];
  v_others     uuid[];
  v_survivor   uuid;
  v_total      bigint;
  v_merged     int;
  v_result     jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'consolidate_draft_invoices');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  -- Lock the order's draft invoices, then collect (oldest first — created_at then
  -- invoice_number, so the survivor is deterministic regardless of number format).
  PERFORM 1 FROM invoices WHERE order_id = p_order_id AND status = 'draft' FOR UPDATE;
  SELECT array_agg(id ORDER BY created_at, invoice_number) INTO v_source_ids
    FROM invoices WHERE order_id = p_order_id AND status = 'draft';

  IF v_source_ids IS NULL OR array_length(v_source_ids, 1) < 2 THEN
    -- 0 or 1 draft — nothing to merge. Idempotent no-op.
    v_result := jsonb_build_object('success', true, 'consolidated', false,
      'reason', 'fewer than 2 draft invoices', 'order_number', v_order.order_number);
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'consolidate_draft_invoices', v_result);
    END IF;
    RETURN v_result;
  END IF;

  v_survivor := v_source_ids[1];
  v_others   := v_source_ids[2:array_length(v_source_ids, 1)];
  v_merged   := array_length(v_others, 1);

  -- Move every other draft's items onto the survivor.
  UPDATE invoice_items SET invoice_id = v_survivor
   WHERE invoice_id = ANY(v_others);

  -- Recompute the survivor total from its now-merged items.
  SELECT COALESCE(sum(extended_cents), 0) INTO v_total
    FROM invoice_items WHERE invoice_id = v_survivor;
  UPDATE invoices SET total_amount_cents = v_total, updated_at = now()
   WHERE id = v_survivor;

  -- Cancel the now-empty source drafts (draft→cancelled allowed by the enforcer;
  -- never posted, so period + financial_audit_log are untouched).
  UPDATE invoices SET status = 'cancelled', updated_at = now()
   WHERE id = ANY(v_others);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoices_consolidated',
    'Consolidated ' || (v_merged + 1) || ' draft invoice(s) into one for order ' || v_order.order_number,
    v_actor, 'invoice', v_survivor, v_order.customer_id);

  v_result := jsonb_build_object(
    'success', true, 'consolidated', true,
    'surviving_invoice_id', v_survivor, 'merged_count', v_merged,
    'total_cents', v_total, 'order_number', v_order.order_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'consolidate_draft_invoices', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- ACL mirrors create_invoice_from_order (authenticated + service_role; no anon/PUBLIC).
-- caller-analysis: consolidate_draft_invoices :: new RPC; authenticated admin/sales_rep gated in-body (INSUFFICIENT_ROLE) + strict-actor; draft-only merge, no posted-money/period impact; ACL mirrors create_invoice_from_order; UI caller (OrderDetail billing panel) lands in #4 slice c
REVOKE EXECUTE ON FUNCTION public.consolidate_draft_invoices(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.consolidate_draft_invoices(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.consolidate_draft_invoices(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidate_draft_invoices(uuid, uuid, text) TO service_role;
