-- Overnight bug-hunt: blend-ticket payment_status state-machine guards
--
-- A multi-customer blend ticket fans out into MULTIPLE invoices that all carry the
-- same blend_ticket_id (create_invoice_from_blend_ticket loops one invoice per
-- field-owning customer when v_customer_count>1). blend_tickets.payment_status is
-- the single re-bill gate ('billed' blocks a second create). Two ways it breaks:
--
--   HIGH (over-reset): sync_blend_ticket_payment_status resets the WHOLE ticket to
--   'unbilled' the moment ANY one of its invoices is voided/cancelled, with no check
--   for surviving siblings -> voiding one customer's invoice re-opens the ticket and
--   the next create_invoice_from_blend_ticket DOUBLE-BILLS every customer on it.
--
--   MED (orphan): delete_invoices soft-deletes (sets deleted_at only); the reset
--   trigger fires on status change, NOT on deleted_at, so soft-deleting a draft blend
--   invoice strands the ticket at 'billed' forever (un-rebillable).
--
--   LOW (forgeable actor): update_blend_ticket_billing_status writes the raw caller-
--   supplied p_performed_by into activity_feed without binding auth.uid()/rejecting a
--   mismatch — the one blend RPC the a3ba49c actor-hardening missed.
--
-- FIX: only reset the ticket to 'unbilled' when NO live (non-voided/cancelled,
-- non-deleted) sibling invoice remains — applied in BOTH the void/cancel trigger and
-- the soft-delete path; and bind the actor in update_blend_ticket_billing_status.
--
-- Bodies reproduced verbatim from the live definitions (read 2026-06-20) with ONLY
-- the guard changes added — verified by a rolled-back line-level diff. Latent on live
-- data (0 blend tickets / 0 blend invoices live).
--
-- NOTE: the related LOW create_invoice_from_blend_ticket:prepaid-rebill-gap (widen the
-- re-bill guard from 'billed' to 'only-from-unbilled') is built in a separate migration
-- because that function is ~16KB and warrants its own focused, reviewable change.

-- =====================================================================
-- 1. sync_blend_ticket_payment_status — HIGH over-reset guard
-- =====================================================================
CREATE OR REPLACE FUNCTION public.sync_blend_ticket_payment_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.blend_ticket_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('voided', 'cancelled') AND OLD.status NOT IN ('voided', 'cancelled') THEN
    -- Over-reset guard (overnight bug-hunt HIGH, 20260620): only reset the ticket to
    -- 'unbilled' when NO live sibling invoice remains. A multi-customer blend ticket has
    -- multiple invoices sharing this blend_ticket_id; without this guard, voiding one
    -- customer's invoice re-opens the whole ticket and the next create_invoice_from_
    -- blend_ticket double-bills every customer. NEW is already voided/cancelled here, so
    -- it is excluded by the status filter below.
    UPDATE blend_tickets SET payment_status = 'unbilled', updated_at = now()
    WHERE id = NEW.blend_ticket_id AND payment_status = 'billed'
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.blend_ticket_id = NEW.blend_ticket_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND i.deleted_at IS NULL
      );
  END IF;
  RETURN NEW;
END;
$function$;

-- =====================================================================
-- 2. delete_invoices — MED orphan reset on soft-delete
-- =====================================================================
CREATE OR REPLACE FUNCTION public.delete_invoices(p_invoice_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv        record;
  v_count      integer := 0;
  v_actor      uuid;
  v_actor_role text;
  v_existing   jsonb;
BEGIN
  PERFORM require_admin();  -- admin-only: matches invoices_update/invoices_delete RLS (is_admin())
  PERFORM check_rate_limit(auth.uid(), 'delete_invoices', 5, 60);
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_invoices');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'deleted_count')::integer; END IF;
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  FOR v_inv IN
    SELECT id, status, invoice_number, total_amount_cents, blend_ticket_id
    FROM invoices
    WHERE id = ANY(p_invoice_ids) AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Only draft / unposted / voided invoices are soft-deletable (matches the UI gates).
    IF v_inv.status NOT IN ('draft', 'unposted', 'voided') THEN CONTINUE; END IF;

    UPDATE invoices SET deleted_at = now() WHERE id = v_inv.id;

    -- Blend-ticket orphan guard (overnight bug-hunt MED, 20260620): a soft-delete sets
    -- deleted_at only, which does NOT fire the status-change reset trigger, so a deleted
    -- draft blend invoice would strand the ticket at 'billed' forever (un-rebillable).
    -- When this was the last live invoice for the ticket, reset it (same predicate the
    -- over-reset trigger uses; v_inv was just soft-deleted so it is excluded below).
    IF v_inv.blend_ticket_id IS NOT NULL THEN
      UPDATE blend_tickets SET payment_status = 'unbilled', updated_at = now()
      WHERE id = v_inv.blend_ticket_id AND payment_status = 'billed'
        AND NOT EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.blend_ticket_id = v_inv.blend_ticket_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND i.deleted_at IS NULL
        );
    END IF;

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      old_values, new_values, total_impact_cents, description
    ) VALUES (
      'invoice_deleted', 'invoice', v_inv.id, v_actor_role,
      jsonb_build_object(
        'status', v_inv.status,
        'invoice_number', v_inv.invoice_number,
        'total_amount_cents', v_inv.total_amount_cents
      ),
      jsonb_build_object('deleted_at', now()),
      0,
      'Soft-deleted invoice ' || v_inv.invoice_number || ' (status ' || v_inv.status || ')'
    );

    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_invoices', jsonb_build_object('deleted_count', v_count));
  END IF;

  RETURN v_count;
END;
$function$;

-- =====================================================================
-- 3. update_blend_ticket_billing_status — LOW forgeable-actor bind
-- =====================================================================
CREATE OR REPLACE FUNCTION public.update_blend_ticket_billing_status(p_blend_ticket_id uuid, p_payment_status text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid())
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ticket blend_tickets%ROWTYPE;
  v_actor uuid;
BEGIN
  -- Strict-actor guard (overnight bug-hunt, 20260620): bind the actor to auth.uid() and
  -- reject a forged p_performed_by — mirrors link/unlink_blend_ticket_to_order. The raw
  -- caller-supplied p_performed_by must never be written as the actor of a status change.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();
  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;

  IF p_payment_status = 'billed' AND v_ticket.order_link_status = 'unlinked' THEN
    RETURN json_build_object('success', false, 'error', 'Cannot set payment status to billed when ticket is not linked to an order');
  END IF;

  IF p_payment_status IS NOT NULL THEN
    UPDATE blend_tickets SET payment_status = p_payment_status, updated_at = now() WHERE id = p_blend_ticket_id;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'blend_ticket_status_changed',
    'Blend ticket ' || v_ticket.ticket_number || ' payment status changed to ' || COALESCE(p_payment_status, 'unchanged'),
    v_actor, 'blend_ticket', p_blend_ticket_id
  );

  RETURN json_build_object('success', true);
END;
$function$;
