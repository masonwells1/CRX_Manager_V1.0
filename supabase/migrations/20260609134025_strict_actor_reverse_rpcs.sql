-- Fix H1 part B + M2 + M3 + M5 (foundation audit 2026-06-09).
--
-- Three SECURITY DEFINER, authenticated-executable "reverse/revert" RPCs:
--   * revert_quote_status, unapply_credit_memo, reverse_blend_ticket_approval
-- (1) HIGH actor-forgery: all three authorized off COALESCE(p_performed_by, auth.uid())
--     and checked the role of the forgeable v_actor -> privilege escalation. Replaced with
--     the canonical strict-actor block (auth.uid() / AUTH_REQUIRED / ACTOR_MISMATCH /
--     INSUFFICIENT_ROLE admin), placed before the idempotency check.
-- (2) M2/M3: revert_quote_status writes quotes status->'sent' and unapply_credit_memo writes
--     returns status 'credited'->'received' — both enforcer-forbidden reverse transitions that
--     would crash without an app.admin_override bracket. Bracketed each enforcer-forbidden
--     write (matching the restore_* RPCs). The invoices posted->voided write in
--     unapply_credit_memo is an ALLOWED transition and needs no bracket.
-- (3) M5: reverse_blend_ticket_approval previously flipped review_status only, orphaning any
--     application_records + inventory deduction created from the approved ticket. Added a guard
--     to RAISE if application records exist (reverse those first).
--
-- Signatures unchanged (verified live: one overload each). Bodies verbatim from live except the
-- changes above. All three use direct idempotency_keys (idempotency_key/operation/result).
-- Reversible.

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revert_quote_status(p_quote_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_quote    record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to revert quote status';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'revert_quote_status';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_quote
    FROM quotes
   WHERE id = p_quote_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'accepted') THEN
    RAISE EXCEPTION 'Cannot revert quote in status "%" — only declined, expired, cancelled, or accepted quotes can be reverted', v_quote.status;
  END IF;

  IF v_quote.status = 'accepted' THEN
    IF EXISTS (SELECT 1 FROM orders WHERE quote_id = p_quote_id) THEN
      RAISE EXCEPTION 'Cannot revert accepted quote % — an order has already been created from it', v_quote.quote_number;
    END IF;
  END IF;

  -- declined/expired/cancelled -> sent are enforcer-forbidden; bracket with admin_override.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'quote_status_reverted', 'quote', p_quote_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_quote.status),
    jsonb_build_object('status', 'sent'),
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quote_status_reverted',
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || p_reason,
    v_actor, 'quote', p_quote_id, v_quote.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'quote_id',      p_quote_id,
    'quote_number',  v_quote.quote_number,
    'old_status',    v_quote.status,
    'new_status',    'sent'
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'revert_quote_status', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unapply_credit_memo(p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_invoice  record;
  v_return   record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to unapply a credit memo';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'unapply_credit_memo';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_invoice
    FROM invoices
   WHERE id = p_credit_memo_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_credit_memo_id;
  END IF;

  IF v_invoice.invoice_type != 'credit_memo' THEN
    RAISE EXCEPTION 'Invoice % is not a credit memo (type: %)', v_invoice.invoice_number, v_invoice.invoice_type;
  END IF;

  IF v_invoice.status != 'posted' THEN
    RAISE EXCEPTION 'Only posted credit memos can be unapplied (current status: %)', v_invoice.status;
  END IF;

  SELECT * INTO v_return
    FROM returns
   WHERE credit_invoice_id = p_credit_memo_id
   FOR UPDATE;

  -- posted -> voided is an allowed invoice transition; no override needed.
  UPDATE invoices SET
    status      = 'voided',
    voided_by   = v_actor,
    voided_at   = now(),
    void_reason = p_reason,
    updated_at  = now()
  WHERE id = p_credit_memo_id;

  IF v_return.id IS NOT NULL THEN
    -- credited -> received is an enforcer-forbidden reverse transition; bracket with admin_override.
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET
      status             = 'received',
      credit_invoice_id  = NULL,
      total_credit_cents = NULL,
      credited_at        = NULL,
      credited_by        = NULL,
      updated_at         = now()
    WHERE id = v_return.id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'credit_memo_unapplied', 'invoice', p_credit_memo_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'posted', 'total_amount_cents', v_invoice.total_amount_cents),
    jsonb_build_object(
      'status', 'voided',
      'return_reverted', CASE WHEN v_return.id IS NOT NULL THEN v_return.return_number ELSE NULL END
    ),
    -v_invoice.total_amount_cents,
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'credit_memo_unapplied',
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason,
    v_actor, 'invoice', p_credit_memo_id, v_invoice.customer_id
  );

  v_result := jsonb_build_object(
    'success',         true,
    'credit_memo_id',  p_credit_memo_id,
    'invoice_number',  v_invoice.invoice_number,
    'return_id',       v_return.id,
    'return_reverted', v_return.id IS NOT NULL
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'unapply_credit_memo', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_blend_ticket_approval(p_ticket_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_ticket   record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a blend ticket approval';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_blend_ticket_approval';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_ticket
    FROM blend_tickets
   WHERE id = p_ticket_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_ticket_id;
  END IF;

  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Only approved blend tickets can have their approval reversed (current review_status: %)', v_ticket.review_status;
  END IF;

  -- M5: do NOT silently orphan downstream records. If application records (and their
  -- inventory deductions) were already created from this approved ticket, the approval
  -- cannot be cleanly reversed — those must be reversed first.
  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_ticket_id
  ) THEN
    RAISE EXCEPTION 'CANNOT_REVERSE_APPROVAL_RECORDS_EXIST: application records exist for blend ticket % — reverse those (and their inventory) first', v_ticket.ticket_number;
  END IF;

  UPDATE blend_tickets SET
    review_status = 'unreviewed',
    reviewed_by   = NULL,
    reviewed_at   = NULL,
    updated_at    = now()
  WHERE id = p_ticket_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'blend_ticket_approval_reversed', 'blend_ticket', p_ticket_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('review_status', 'approved', 'reviewed_by', v_ticket.reviewed_by, 'reviewed_at', v_ticket.reviewed_at),
    jsonb_build_object('review_status', 'unreviewed'),
    'Blend ticket ' || v_ticket.ticket_number || ' approval reversed: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'blend_ticket_approval_reversed',
    'Blend ticket ' || v_ticket.ticket_number || ' approval reversed: ' || p_reason,
    v_actor, 'blend_ticket', p_ticket_id, v_ticket.customer_id
  );

  v_result := jsonb_build_object(
    'success',        true,
    'ticket_id',      p_ticket_id,
    'ticket_number',  v_ticket.ticket_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reverse_blend_ticket_approval', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;
