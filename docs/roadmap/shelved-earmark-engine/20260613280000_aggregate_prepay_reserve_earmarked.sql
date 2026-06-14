-- sql-safety: exempt-registry
--   Justification: references prepay_credits.quote_id (added by 20260613230000,
--   file-only this session, not yet in .claude/schema-registry.json). No other
--   off-registry columns referenced.
--
-- Roadmap #6 hardening / Codex round-5 P1 — booking prepay double-spend guard (FILE-ONLY)
-- ============================================================================
-- WHAT: CREATE OR REPLACE apply_remaining_prepayments = live body VERBATIM + one
--   added reservation step: the aggregate path now EXCLUDES prepay credits that are
--   earmarked to a booking (prepay_credits.quote_id IS NOT NULL) from the amount it
--   is allowed to spend.
--
-- WHY (the double-spend Codex round 5 found): apply_remaining_prepayments (and
--   batch_apply_all_prepayments, which just loops it) is Mechanism B — it consumes
--   customers.prepay_balance_cents (the aggregate) and bumps invoices.prepay_applied_cents
--   directly; it NEVER writes prepay_applications and NEVER reduces an individual
--   prepay_credits.balance_cents. apply_booking_prepay (#6b) is Mechanism A — it
--   applies a booking's earmarked credits via apply_prepay_to_invoice, which keys
--   off prepay_credits.balance_cents (the ledger). So if an admin runs the aggregate
--   path BEFORE a booking's draw invoice posts, the aggregate would spend the
--   earmarked credit's cash here, and the booking auto-apply would later spend the
--   SAME credit again (its ledger balance still reads full) — one prepayment paying
--   two invoices. Reserving earmarked credits from the aggregate keeps those funds
--   claimable ONLY by apply_booking_prepay (Mechanism A), eliminating the overlap.
--
-- FIDELITY: the body below is byte-for-byte the current live definition (introspected
--   2026-06-13 via the management API) except for the clearly-marked reservation block
--   inserted right after v_available is read under the customers FOR UPDATE lock. No
--   signature/overload/grant change (CREATE OR REPLACE preserves the existing ACL).
--   batch_apply_all_prepayments needs NO change — it delegates here. FILE-ONLY —
--   do NOT apply this session (apply at G5).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_remaining_prepayments(p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor         uuid;
  v_available     bigint;
  v_invoice       record;
  v_apply         bigint;
  v_applied_total bigint := 0;
  v_count         integer := 0;
  v_cached        jsonb;
  v_result        jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'apply_remaining_prepayments');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  SELECT COALESCE(c.prepay_balance_cents, 0)
    INTO v_available
    FROM customers c
   WHERE c.id = p_customer_id
   FOR UPDATE;

  -- >>> Codex round-5 P1 (booking double-spend guard) — the ONLY change vs live.
  -- Reserve credits earmarked to a booking: this aggregate path must not spend
  -- funds that apply_booking_prepay (Mechanism A, the prepay_credits ledger) will
  -- claim for the booking's draw invoices. Without this, the same earmarked cash
  -- would pay an aggregate invoice here AND a booking invoice later.
  v_available := v_available - COALESCE((
    SELECT SUM(balance_cents) FROM prepay_credits
     WHERE customer_id = p_customer_id
       AND quote_id IS NOT NULL
       AND balance_cents > 0
  ), 0);
  IF v_available < 0 THEN v_available := 0; END IF;
  -- <<< end Codex round-5 P1 change.

  IF v_available IS NULL OR v_available <= 0 THEN
    v_result := jsonb_build_object(
      'applied_count', 0,
      'applied_cents', 0,
      'remaining_prepay_cents', 0,
      'message', 'No prepay balance available'
    );
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'apply_remaining_prepayments', v_result);
    END IF;
    RETURN v_result;
  END IF;

  FOR v_invoice IN
    SELECT id, invoice_number, invoice_date, balance_cents
      FROM invoices
     WHERE customer_id = p_customer_id
       AND status = 'posted'
       AND balance_cents > 0
       AND deleted_at IS NULL
     ORDER BY invoice_date ASC, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_available <= 0;

    PERFORM check_period_open(v_invoice.invoice_date);

    v_apply := LEAST(v_available, v_invoice.balance_cents);

    UPDATE invoices
       SET prepay_applied_cents = COALESCE(prepay_applied_cents, 0) + v_apply,
           updated_at = now()
     WHERE id = v_invoice.id;

    v_available     := v_available - v_apply;
    v_applied_total := v_applied_total + v_apply;
    v_count         := v_count + 1;
  END LOOP;

  UPDATE customers
     SET prepay_balance_cents = GREATEST(0, COALESCE(prepay_balance_cents, 0) - v_applied_total),
         updated_at = now()
   WHERE id = p_customer_id;

  IF v_applied_total > 0 THEN
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id,
      actor_user_id, total_impact_cents, description
    ) VALUES (
      'prepay_batch_applied', 'prepay', p_customer_id,
      v_actor, v_applied_total,
      'Batch applied $' || (v_applied_total / 100.0)::numeric(12,2) ||
      ' prepay across ' || v_count || ' invoice(s) for customer ' ||
      (SELECT farm_name FROM customers WHERE id = p_customer_id)
    );
  END IF;

  v_result := jsonb_build_object(
    'applied_count', v_count,
    'applied_cents', v_applied_total,
    'remaining_prepay_cents', v_available
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'apply_remaining_prepayments', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Self-verification: exactly one overload; still SECDEF.
DO $$
DECLARE v_n int; v_secdef boolean;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
    WHERE proname = 'apply_remaining_prepayments' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN RAISE EXCEPTION 'EXPECTED exactly 1 apply_remaining_prepayments overload, found %', v_n; END IF;
  SELECT p.prosecdef INTO v_secdef FROM pg_proc p
    WHERE p.proname = 'apply_remaining_prepayments' AND p.pronamespace = 'public'::regnamespace;
  IF v_secdef IS NOT TRUE THEN RAISE EXCEPTION 'apply_remaining_prepayments must remain SECURITY DEFINER'; END IF;
END $$;
