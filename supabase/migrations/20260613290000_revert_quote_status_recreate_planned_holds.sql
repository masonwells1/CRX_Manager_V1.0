-- Roadmap #5 hardening / Codex round-9 P2 — atomic planned-quote reopen (FILE-ONLY)
-- ============================================================================
-- WHAT: CREATE OR REPLACE revert_quote_status = current live body VERBATIM + ONE
--   added guarded step: after the status flip to 'sent', if the quote is_planned,
--   PERFORM create_planned_holds(...) so its inventory holds are rebuilt in the SAME
--   transaction.
--
-- WHY (Codex round 9): a PLANNED quote's inventory holds are released when it goes
--   terminal (declined/expired/cancelled, or accepted). The #5 "Reopen" button routes
--   through revert_quote_status, which flips it back to 'sent' (drawable/convertible)
--   but did NOT recreate the holds — so the booking would reserve no inventory
--   (overselling risk). The round-8 fix did this from the client AFTER the revert
--   committed, which is non-atomic: if create_planned_holds failed or the network
--   dropped, the quote was left 'sent' with no holds (and the UI still showed success).
--   Doing it INSIDE this SECDEF RPC makes it atomic — if create_planned_holds raises,
--   the whole revert rolls back and the quote stays terminal. No sent-without-holds
--   state is possible. The client no longer recreates holds itself.
--
-- FIDELITY: the body below is byte-for-byte the current live definition (introspected
--   2026-06-14 via the management API) except the clearly-marked IF v_quote.is_planned
--   block. No signature/overload/grant change (CREATE OR REPLACE preserves the existing
--   ACL). create_planned_holds is an existing SECDEF RPC; called with p_performed_by =
--   v_actor (= auth.uid(), so no ACTOR_MISMATCH) and a NULL idempotency key (the outer
--   revert idempotency guard already covers replay — a replay returns the cached result
--   before reaching this code, so holds are never rebuilt twice). create_planned_holds
--   itself re-checks is_planned + admin/sales_rep role (revert already required admin),
--   and rebuilds GREATEST(booked − drawn, 0) per product via _sync_planned_holds.
--   FILE-ONLY — do NOT apply this session (apply at G5).
-- ============================================================================

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

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

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

-- Self-verification: exactly one overload; still SECDEF.
DO $$
DECLARE v_n int; v_secdef boolean;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
    WHERE proname = 'revert_quote_status' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN RAISE EXCEPTION 'EXPECTED exactly 1 revert_quote_status overload, found %', v_n; END IF;
  SELECT p.prosecdef INTO v_secdef FROM pg_proc p
    WHERE p.proname = 'revert_quote_status' AND p.pronamespace = 'public'::regnamespace;
  IF v_secdef IS NOT TRUE THEN RAISE EXCEPTION 'revert_quote_status must remain SECURITY DEFINER'; END IF;
END $$;
