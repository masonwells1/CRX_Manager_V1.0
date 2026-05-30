-- P1-A (review 2026-05-29): harden reverse_write_off against actor forgery.
--
-- APPLIED LIVE 2026-05-30 as version 20260530020412 (from branch
-- fix/review-2026-05-29, cherry-picked to main). File renamed to the applied
-- version stamp per the B7 rule so tooling never re-applies it.
--
-- Bug: reverse_write_off is SECURITY DEFINER and derived the actor as
--   v_actor := COALESCE(p_performed_by, auth.uid());
-- then checked that (forgeable) UUID for the admin role. A non-admin
-- authenticated caller could pass a known admin's UUID as p_performed_by and
-- reverse a write-off (re-inflating an invoice's AR balance / flipping status),
-- with the financial_audit_log + activity_feed rows attributed to the spoofed
-- admin. This is the same actor-forgery anti-pattern fixed across the financial
-- RPC suite on 2026-05-26; reverse_write_off was the one mutating-financial RPC
-- left out of that sweep (verified live 2026-05-29: uses_forgeable_coalesce=true,
-- has_strict_actor_guard=false). anon EXECUTE is already revoked, so exploitation
-- requires a valid authenticated JWT (insider) — hence P1, not P0.
--
-- Fix: derive the actor strictly from auth.uid(); treat p_performed_by as
-- advisory (must match or be NULL); harden the admin check with is_active = true
-- (matches the create_prepay_check_splits Codex P1 hardening — a deactivated
-- admin with a still-valid JWT must not pass). Function body is otherwise
-- reproduced verbatim from the live definition; ONLY the auth block changed.

CREATE OR REPLACE FUNCTION public.reverse_write_off(
  p_write_off_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor          uuid;
  v_wo             record;
  v_existing       jsonb;
  v_new_balance    bigint;
  v_old_status     text;
  v_due_date       date;
  v_new_status     text;
  v_status_changed boolean;
  v_result         jsonb;
BEGIN
  -- Strict-actor: derive from JWT, never trust a client-supplied UUID.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF (SELECT role FROM profiles WHERE id = v_actor AND is_active = true) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a write-off';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_write_off';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_wo
    FROM write_offs
   WHERE id = p_write_off_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Write-off not found: %', p_write_off_id;
  END IF;

  IF v_wo.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Write-off has already been reversed';
  END IF;

  SELECT status, due_date INTO v_old_status, v_due_date
    FROM invoices
   WHERE id = v_wo.invoice_id
   FOR UPDATE;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Invoice not found for write-off %: %', p_write_off_id, v_wo.invoice_id;
  END IF;

  UPDATE invoices
     SET write_off_cents = GREATEST(COALESCE(write_off_cents, 0) - v_wo.amount_cents, 0),
         updated_at      = now()
   WHERE id = v_wo.invoice_id;

  SELECT balance_cents INTO v_new_balance
    FROM invoices
   WHERE id = v_wo.invoice_id;

  IF v_old_status = 'paid' AND v_new_balance > 0 THEN
    IF v_due_date IS NOT NULL AND v_due_date < CURRENT_DATE THEN
      v_new_status := 'overdue';
    ELSE
      v_new_status := 'posted';
    END IF;
    UPDATE invoices
       SET status     = v_new_status,
           updated_at = now()
     WHERE id = v_wo.invoice_id;
    v_status_changed := true;
  ELSE
    v_new_status := v_old_status;
    v_status_changed := false;
  END IF;

  UPDATE write_offs
     SET reversed_at     = now(),
         reversed_by     = v_actor,
         reversed_reason = p_reason
   WHERE id = p_write_off_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'write_off_reversed', 'write_off', p_write_off_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'amount_cents',   v_wo.amount_cents,
      'reversed_at',    null,
      'invoice_status', v_old_status
    ),
    jsonb_build_object(
      'reversed_at',       now(),
      'reverse_reason',    p_reason,
      'invoice_status',    v_new_status,
      'new_balance_cents', v_new_balance
    ),
    v_wo.amount_cents,
    'Write-off of ' || (v_wo.amount_cents::numeric / 100)::text ||
      ' reversed on invoice ' || v_wo.invoice_id::text || ': ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'write_off_reversed',
    'Write-off of $' || (v_wo.amount_cents::numeric / 100)::text || ' reversed: ' || p_reason,
    v_actor, 'invoice', v_wo.invoice_id, v_wo.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'write_off_id',      p_write_off_id,
    'amount_cents',      v_wo.amount_cents,
    'invoice_id',        v_wo.invoice_id,
    'new_balance_cents', v_new_balance,
    'status_changed',    v_status_changed,
    'new_status',        v_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reverse_write_off', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;
