-- B2 (Live Foundation Gauntlet 2026-07-18) — escape hatch for a quote stranded
-- at 'accepted' after its whole-conversion order was cancelled.
--
-- Background: convert_quote_to_order (whole path) parks the quote at 'accepted'
-- and writes quote_product_draws = fully drawn. Cancelling that order does NOT
-- reopen the quote (the cancel path's draw-reversal is gated on booking_draw,
-- which a whole conversion leaves false) — matching the deliberate "a converted
-- booking stays closed" semantic the void path also uses (smoke-draw-ledger-
-- reversal.sql S3). But there was then NO way out: revert_quote_status refused
-- because *an order exists*, and a re-convert returned the cancelled order
-- ('already_converted'). The quote was permanently dead-ended.
--
-- Safe fix (admin-driven, does NOT change default cancel/void behavior): let
-- revert_quote_status rescue such a quote.
--   1. The accepted-quote guard now blocks only when a NON-cancelled order
--      exists (a cancelled order no longer permanently locks the quote).
--   2. When reverting an accepted quote, release its draw ledger
--      (quote_product_draws -> 0) so the restored booking is genuinely
--      re-convertible; the cancel already released the prebook/holds, so this
--      only reconciles the booking accounting. Done BEFORE the planned-hold
--      rebuild so holds are computed against a clean (0-drawn) ledger.
--
-- Body reproduced verbatim from the live catalog; only the guard predicate and
-- the draw-release block were added.

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
    -- B2 fix: only an ACTIVE (non-cancelled) order locks the quote. A quote
    -- whose only order was cancelled is no longer permanently stranded.
    IF EXISTS (SELECT 1 FROM orders WHERE quote_id = p_quote_id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'Cannot revert accepted quote % — an active (non-cancelled) order exists from it', v_quote.quote_number;
    END IF;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- B2 fix: releasing an accepted quote means its draw ledger (written by the
  -- now-cancelled conversion/draw order) must be zeroed, or a re-convert would
  -- see it as fully drawn and return the cancelled order. The cancel already
  -- released the prebook and holds, so this only reconciles the booking
  -- accounting. Runs BEFORE the planned-hold rebuild below.
  IF v_quote.status = 'accepted' THEN
    UPDATE quote_product_draws
       SET quantity_drawn = 0, updated_at = now()
     WHERE quote_id = p_quote_id AND quantity_drawn <> 0;
  END IF;

  -- >>> Codex round-9 P2 (atomic planned-reopen holds) — the ONLY change vs live.
  -- A planned booking's holds were released when it went terminal; reopening to 'sent'
  -- must rebuild them or it reserves no inventory. Atomic in this txn: if this raises,
  -- the revert rolls back and the quote stays terminal (no sent-without-holds state).
  IF v_quote.is_planned THEN
    PERFORM create_planned_holds(p_quote_id, v_actor, NULL);
  END IF;
  -- <<< end Codex round-9 P2 change.

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
