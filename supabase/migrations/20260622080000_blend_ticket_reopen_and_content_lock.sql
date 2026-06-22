-- 20260622080000_blend_ticket_reopen_and_content_lock.sql
--
-- OVERNIGHT BUG HUNT Run 2 cycle 2, finding #8 (MEDIUM verifier / HIGH Codex; lifecycle/segregation).
-- dedupeKey: lifecycle:reverse_blend_ticket_approval:billed-ticket-reopen-and-edit
--
-- WHAT WAS WRONG
-- reverse_blend_ticket_approval only blocked reversal when application_records existed — it did
-- NOT check payment_status / linked invoices. But create_invoice_from_blend_ticket writes NO
-- application_records (it sets payment_status='billed' + creates the invoice). So: approve -> bill
-- (payment_status='billed', draft invoice) -> reverse_blend_ticket_approval SUCCEEDED (review_status
-- back to 'unreviewed') while payment_status stayed 'billed'; then save_blend_ticket /
-- save_blend_ticket_fields (no review/payment gate) could freely mutate the BILLED ticket's products,
-- quantities, rates, customer — so the ticket-of-record diverged from the invoice already issued.
--
-- THE FIX (two layers)
-- (a) reverse_blend_ticket_approval: also block reversal when the ticket has a non-voided/
--     non-deleted invoice (you must void the invoice first). This breaks the chain at the reopen step.
--     Body reproduced verbatim from the live definition + ONE added guard (marked OVERNIGHT FIX).
-- (b) Content lock (defense-in-depth, covers EVERY edit path — save_blend_ticket,
--     save_blend_ticket_fields, raw): a BEFORE INSERT/UPDATE/DELETE trigger on blend_ticket_products.
--     Implemented as a trigger (not a save_blend_ticket rewrite) to avoid reproducing those large
--     RPCs and to cover all paths. It locks a line whenever the parent ticket has an ACTIVE LINKED
--     INVOICE — the SAME predicate as guard (a): EXISTS an invoice with that blend_ticket_id whose
--     status NOT IN ('voided','cancelled') and deleted_at IS NULL. Keying off the live invoice (NOT
--     payment_status) is what the pre-apply review converged on:
--       * locks 'billed' AND invoice-backed 'prepaid' tickets (both have a live invoice whose lines
--         must not change) — closes the gap where a direct blend_ticket_products edit on a prepaid
--         ticket would bypass a payment_status='billed'-only check (Codex);
--       * leaves 'no_charge' (comped, NO invoice) and 'unbilled' editable — no over-reach (workflow);
--       * the unlock is accurate and always works: void the invoice -> no active invoice -> editable
--         (independent of whether trg_sync_blend_ticket_payment resets payment_status).
--     The check inspects BOTH parents: OLD on UPDATE/DELETE (can't remove or MOVE a line OUT of a
--     locked ticket — the reparent bypass Codex flagged) and NEW on INSERT/UPDATE (can't add or MOVE
--     a line INTO a locked ticket).
--
-- Latent today (0 blend tickets live). ROLLBACK: remove the added reverse guard; DROP TRIGGER
-- trg_blend_ticket_products_billed_lock + the function.

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

  -- OVERNIGHT FIX (finding #8): a billed ticket must NOT be reopened while it still has a live
  -- invoice — otherwise its already-invoiced contents could be edited and diverge from the issued
  -- invoice. The application_records guard below is vacuous for blend invoices (billing writes none),
  -- so gate on an active linked invoice too: void the invoice(s) first.
  IF EXISTS (
    SELECT 1 FROM invoices
    WHERE blend_ticket_id = p_ticket_id
      AND status NOT IN ('voided', 'cancelled')
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'CANNOT_REVERSE_APPROVAL_INVOICE_EXISTS: blend ticket % has an active invoice — void the invoice(s) first, then reverse the approval', v_ticket.ticket_number;
  END IF;

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

-- (b) Content lock: block edits to a settled (non-unbilled) ticket's line items from ANY path.
CREATE OR REPLACE FUNCTION public.enforce_blend_ticket_products_billed_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_locked boolean;
BEGIN
  -- OLD side (UPDATE/DELETE): block removing or MOVING a line OUT of a ticket that has a live invoice
  -- (also closes the reparent bypass — moving a row to an uninvoiced ticket no longer escapes).
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.blend_ticket_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM invoices
      WHERE blend_ticket_id = OLD.blend_ticket_id
        AND status NOT IN ('voided', 'cancelled')
        AND deleted_at IS NULL
    ) INTO v_locked;
    IF v_locked THEN
      RAISE EXCEPTION 'BLEND_TICKET_INVOICE_LOCKED: blend ticket % has an active invoice — void the invoice(s) before changing its line items', OLD.blend_ticket_id;
    END IF;
  END IF;
  -- NEW side (INSERT/UPDATE): block adding or MOVING a line INTO a ticket that has a live invoice.
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.blend_ticket_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM invoices
      WHERE blend_ticket_id = NEW.blend_ticket_id
        AND status NOT IN ('voided', 'cancelled')
        AND deleted_at IS NULL
    ) INTO v_locked;
    IF v_locked THEN
      RAISE EXCEPTION 'BLEND_TICKET_INVOICE_LOCKED: blend ticket % has an active invoice — void the invoice(s) before changing its line items', NEW.blend_ticket_id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_blend_ticket_products_billed_lock ON public.blend_ticket_products;
CREATE TRIGGER trg_blend_ticket_products_billed_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.blend_ticket_products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_blend_ticket_products_billed_lock();
