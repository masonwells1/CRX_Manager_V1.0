-- sql-safety: exempt-registry
--   Justification: references prepay_credits.quote_id (added by 20260613230000,
--   file-only this session so not yet in .claude/schema-registry.json). orders.booking_draw
--   is live (20260610190000). No other off-registry columns referenced.
--
-- Roadmap #6(b) — Prepay-backed bookings: earmark + auto-apply engine (FILE-ONLY)
-- ============================================================================
-- WHAT: two NEW, ADDITIVE SECDEF RPCs (no rewrite of any existing money RPC):
--   (1) set_prepay_credit_booking(credit, quote, performed_by, idem) — earmark
--       (or un-earmark, quote=NULL) a prepay credit to a booking. Admin-only;
--       validates same-customer; sets prepay_credits.quote_id; audited; idempotent.
--   (2) apply_booking_prepay(invoice, performed_by, idem) — auto-apply a booking's
--       earmarked prepay to one of its draw invoices, FIFO, via Mechanism A
--       (the proven apply_prepay_to_invoice atom — so it inherits BOTH fin-prepay
--       identities AND void_invoice reversibility for free). admin/sales_rep.
--
-- WHY this shape (grounded in the 2026-06-13 prepay-subsystem map):
--   * Mechanism A only: apply_booking_prepay loops apply_prepay_to_invoice (writes
--     prepay_applications, decrements the specific credit + customer cache, bumps
--     invoices.prepay_applied_cents, reversible by void_invoice). It NEVER uses the
--     ledger-less Mechanism B (apply_remaining_prepayments), which can't target a
--     booking credit and isn't reversible.
--   * Reuse, don't reimplement: all money math + the two cached-balance identities
--     are maintained by apply_prepay_to_invoice + the _recompute_prepay_credit_balance
--     trigger. This RPC only SELECTs which credits and how much, then delegates.
--   * Idempotency: outer check AFTER the FOR UPDATE invoice lock (TOCTOU lesson,
--     20260610181726); nested apply_prepay_to_invoice gets NULL keys (the outer
--     guard covers replay — the post_invoice_group(...,NULL) loop precedent).
--   * Earmark via a dedicated tiny RPC (NOT by adding a param to the existing
--     create/edit prepay RPCs) — avoids a verbatim rewrite + overload churn on
--     live money functions. quote_id is matched as a real FK, never source_reference
--     text (the void_payment guaranteed-miss bug class).
--   * The "fully automatic at post time" wiring (post_invoice → apply_booking_prepay)
--     is a separate, isolated verbatim slice (#6b-B); this slice ships the engine.
--
-- SAFETY: no financial_audit_log / CHECK change (entity_type prepay/prepay_credit +
--   operation_type prepay_edited/prepay_batch_applied already legal). No GENERATED
--   column written. financial_audit_log columns verified live (actor_user_id /
--   actor_role / new_values / total_impact_cents / description). FILE-ONLY — do NOT
--   apply this session.
-- ============================================================================

-- 1) Earmark a prepay credit to a booking (the quote). Admin-only.
CREATE OR REPLACE FUNCTION public.set_prepay_credit_booking(
  p_credit_id uuid,
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_role text;
  v_active boolean;
  v_credit record;
  v_quote record;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role, is_active INTO v_role, v_active FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role <> 'admin' OR v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  SELECT id, customer_id, balance_cents INTO v_credit
    FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PREPAY_CREDIT_NOT_FOUND';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'set_prepay_credit_booking');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_quote_id IS NOT NULL THEN
    SELECT id, customer_id, status, deleted_at INTO v_quote FROM quotes WHERE id = p_quote_id;
    IF NOT FOUND OR v_quote.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'BOOKING_NOT_FOUND';
    END IF;
    IF v_quote.customer_id IS DISTINCT FROM v_credit.customer_id THEN
      RAISE EXCEPTION 'PREPAY_BOOKING_CUSTOMER_MISMATCH';
    END IF;
    -- Codex P2: only an OPEN booking (sent/revised) can be earmarked. A closed
    -- quote (draft/accepted/declined/expired/cancelled) can never produce a draw
    -- invoice, so earmarking to it would strand the credit's auto-application.
    IF v_quote.status NOT IN ('sent', 'revised') THEN
      RAISE EXCEPTION 'BOOKING_CLOSED';
    END IF;
  END IF;

  -- quote_id-only update: prepay_credits has no immutability guard and the
  -- balance recompute trigger fires on prepay_applications (not here), so this
  -- does not touch balance_cents. updated_at is maintained by the BEFORE UPDATE
  -- trigger (prepay_credits HAS updated_at).
  UPDATE prepay_credits SET quote_id = p_quote_id WHERE id = p_credit_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, description)
  VALUES ('prepay_edited', 'prepay_credit', p_credit_id, v_actor, v_role,
          jsonb_build_object('action', 'set_booking', 'quote_id', p_quote_id),
          CASE WHEN p_quote_id IS NULL THEN 'Un-earmarked prepay credit from booking'
               ELSE 'Earmarked prepay credit to booking' END);

  v_result := jsonb_build_object('success', true, 'credit_id', p_credit_id, 'quote_id', p_quote_id);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'set_prepay_credit_booking', v_result);
  END IF;
  RETURN v_result;
END;
$$;

-- 2) Auto-apply a booking's earmarked prepay to one of its draw invoices (FIFO,
--    Mechanism A). admin/sales_rep. No-op (not an error) when the invoice isn't a
--    booking-draw invoice, isn't postable, or has no balance.
CREATE OR REPLACE FUNCTION public.apply_booking_prepay(
  p_invoice_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_role text;
  v_active boolean;
  v_inv record;
  v_quote_id uuid;
  v_existing jsonb;
  v_credit record;
  v_apply bigint;
  v_inv_balance bigint;
  v_total_applied bigint := 0;
  v_count int := 0;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role, is_active INTO v_role, v_active FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') OR v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Lock the invoice; resolve the booking via its order. FOR UPDATE before the
  -- idempotency check (TOCTOU).
  SELECT i.id, i.status, i.balance_cents, i.customer_id, o.quote_id, o.booking_draw
    INTO v_inv
    FROM invoices i
    LEFT JOIN orders o ON o.id = i.order_id
    WHERE i.id = p_invoice_id
    FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_booking_prepay');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_quote_id := v_inv.quote_id;

  IF v_inv.booking_draw IS NOT TRUE
     OR v_quote_id IS NULL
     OR v_inv.status NOT IN ('posted', 'overdue')
     OR v_inv.balance_cents <= 0 THEN
    v_result := jsonb_build_object(
      'success', true, 'no_op', true, 'applied_count', 0, 'applied_cents', 0,
      'reason', CASE
        WHEN v_inv.booking_draw IS NOT TRUE OR v_quote_id IS NULL THEN 'not_a_booking_draw_invoice'
        WHEN v_inv.status NOT IN ('posted', 'overdue') THEN 'invoice_not_postable'
        ELSE 'no_balance' END);
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'apply_booking_prepay', v_result);
    END IF;
    RETURN v_result;
  END IF;

  -- v_inv_balance is a loop optimization for choosing LEAST(...), NOT the safety
  -- boundary: apply_prepay_to_invoice re-reads invoices.balance_cents under its own
  -- FOR UPDATE every call and rejects amount > balance, so over-apply is impossible
  -- even if this local counter drifted.
  v_inv_balance := v_inv.balance_cents;

  -- FIFO over the booking's earmarked credits with a positive balance. Each
  -- application goes through apply_prepay_to_invoice (Mechanism A): it re-locks
  -- the credit + invoice, re-validates (posted/overdue, period open, amount <=
  -- both balances), writes the prepay_applications ledger row (trigger recomputes
  -- the credit balance), decrements the customer cache, bumps prepay_applied_cents,
  -- and flips the invoice to paid when covered. Nested idempotency key = NULL; the
  -- outer guard covers replay.
  FOR v_credit IN
    SELECT id, balance_cents
      FROM prepay_credits
      WHERE quote_id = v_quote_id
        AND customer_id = v_inv.customer_id
        AND balance_cents > 0
      ORDER BY created_at ASC, id ASC
  LOOP
    EXIT WHEN v_inv_balance <= 0;
    v_apply := LEAST(v_credit.balance_cents, v_inv_balance);
    IF v_apply <= 0 THEN CONTINUE; END IF;
    PERFORM apply_prepay_to_invoice(v_credit.id, p_invoice_id, v_apply, v_actor, NULL);
    v_total_applied := v_total_applied + v_apply;
    v_inv_balance := v_inv_balance - v_apply;
    v_count := v_count + 1;
  END LOOP;

  IF v_total_applied > 0 THEN
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, new_values, total_impact_cents, description)
    VALUES ('prepay_batch_applied', 'prepay', p_invoice_id, v_actor, v_role,
            jsonb_build_object('quote_id', v_quote_id, 'applied_count', v_count, 'source', 'booking_prepay'),
            v_total_applied, 'Applied booking prepay to draw invoice');
  END IF;

  v_result := jsonb_build_object(
    'success', true, 'applied_count', v_count, 'applied_cents', v_total_applied, 'quote_id', v_quote_id);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'apply_booking_prepay', v_result);
  END IF;
  RETURN v_result;
END;
$$;

-- caller-analysis: set_prepay_credit_booking :: NEW admin-only RPC; UI caller deferred to #6(c) (PrepaymentManager / settlement panel, authenticated); no cron/Edge caller; self-gates auth.uid()+admin; REVOKE PUBLIC/anon, GRANT authenticated/service_role.
-- caller-analysis: apply_booking_prepay :: NEW admin/sales_rep RPC; callers deferred — UI (#6c settlement panel) + the post_invoice auto-apply seam (#6b-B); no cron/Edge caller yet; self-gates auth.uid()+admin/sales_rep; REVOKE PUBLIC/anon, GRANT authenticated/service_role.
REVOKE EXECUTE ON FUNCTION public.set_prepay_credit_booking(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_prepay_credit_booking(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_prepay_credit_booking(uuid, uuid, uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.apply_booking_prepay(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.apply_booking_prepay(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_booking_prepay(uuid, uuid, text) TO authenticated, service_role;

-- Self-verification.
DO $$
DECLARE
  v_n1 int;
  v_n2 int;
BEGIN
  SELECT count(*) INTO v_n1 FROM pg_proc
    WHERE proname = 'set_prepay_credit_booking' AND pronamespace = 'public'::regnamespace;
  IF v_n1 <> 1 THEN
    RAISE EXCEPTION 'EXPECTED exactly 1 set_prepay_credit_booking overload, found %', v_n1;
  END IF;
  SELECT count(*) INTO v_n2 FROM pg_proc
    WHERE proname = 'apply_booking_prepay' AND pronamespace = 'public'::regnamespace;
  IF v_n2 <> 1 THEN
    RAISE EXCEPTION 'EXPECTED exactly 1 apply_booking_prepay overload, found %', v_n2;
  END IF;
END $$;
