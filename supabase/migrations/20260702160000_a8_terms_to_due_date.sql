-- ============================================================================
-- PARKED DRAFT — NOT APPLIED. Structure Wave-2 · A8 (terms -> due-date).
-- Ships via the DRAFT/APPLY protocol: Mason moves + applies with a per-migration OK.
-- Owner policy (Mason 2026-07-02, Packet 4): default Net 30; age from due_date;
-- derive due_date at POST time, FORWARD-ONLY (never backfill already-posted invoices).
--
-- WHAT:
--   (1) NEW helper parse_payment_terms_days(text) -> int. Parses the FIRST integer out
--       of the editable free-text customers.payment_terms; NULL/blank/no-number -> 30;
--       clamps pathological values (<1 or >365) back to 30. IMMUTABLE, not SECDEF
--       (pure pg_catalog regexp, no table access), so no search_path needed.
--   (2) post_invoice: on post, set due_date = invoice_date + parsed-terms, but ONLY when
--       due_date IS NULL (COALESCE) — so a field-app invoice that already carries +30 at
--       creation is untouched, and because it runs at post time no already-posted invoice
--       is ever backfilled. This is the actual gap: chemical-sale invoices previously got
--       NO due_date at all, so the whole late-AR machine (mark_overdue / finance charges /
--       Office Cockpit overdue tile) protected nothing.
--
-- WHY option (a) — parse the existing free-text, add NO numeric column:
--   customers.payment_terms is ALREADY editable free-text; the live values are only
--   {null x145, '' x5, 'net_30' x2, 'Net 30' x1} — every non-blank one parses to 30.
--   Adding a parallel numeric payment_terms_days column (option b) is exactly the desync
--   Codex flagged 3x in the Phase-1 A8 attempt (editable text vs the due-date driver drift
--   apart unless the setter ships too). Single source of truth = no desync.
--
-- transfer_job_to_invoice (field-app creator) INTENTIONALLY NOT TOUCHED here: it already
--   sets due_date = CURRENT_DATE + 30 days at creation, which EQUALS parse_payment_terms_days
--   for 100% of current customers (all Net 30) — zero desync today. Re-emitting that
--   ~200-line, DELTA-heavy, money-critical function to change a value identical today is
--   poor risk/reward. FOLLOW-UP (do when the first non-30-terms customer appears): swap its
--   hardcoded +30 for parse_payment_terms_days(customer.payment_terms) so field-app and
--   chemical invoices use one policy. Tracked in the Wave-2 ledger.
--
-- CREDIT MEMOS: post_invoice would also set due_date on a credit_memo whose due_date is NULL.
--   Harmless — mark_overdue only flags rows with balance_cents > 0, and credit memos net
--   negative/zero, so they are never marked overdue regardless of due_date.
--
-- SCOPE: 1 new helper fn + 1 CREATE OR REPLACE of post_invoice (re-emitted verbatim from the
--   live 20260702 definition, only the 3 marked A8 lines added). ONE overload of each.
--   post_invoice keeps its auth gate / idempotency scope / search_path / audit + activity rows.
--
-- SMOKE (2026-07-02, live BEGIN;...ROLLBACK; — NOTHING persisted, verified helper_leaked=false
--   & post_invoice_changed_live=false after): helper_cases=PASS (NULL/''/net_30/Net 30->30,
--   Net 45->45, Net 60->60, 'net 3000'->30 clamp, 'Due on receipt'->30); plpgsql_check_errors=0
--   on BOTH parse_payment_terms_days + post_invoice; due_date_math=PASS (2026-07-02 +Net30=08-01,
--   +Net45=08-16). post_invoice not functionally posted in-smoke (auth.uid() NULL under MCP) —
--   covered by CREATE-time body validation + plpgsql_check.
--   RE-SMOKE after Codex R1 (numeric cast): overflow_fixed=PASS ('Net 9999999999' + a 40-digit
--   value both -> 30, no raise); all_cases=PASS (Net 365->365, Net 366->30).
--   RE-SMOKE after Codex R2 (invoice-override terms): plpgsql_check_errors=0 on post_invoice
--   with COALESCE(NULLIF(btrim(invoices.payment_terms),''), customers.payment_terms).
-- CODEX: R1 — P2 helper cast overflow. FIXED (numeric cast, clamp, narrow to int).
--   R2 — P2 invoice-level terms ignored: post_invoice read only customers.payment_terms, but
--   invoices.payment_terms is the documented per-invoice override that the PDF prints. FIXED:
--   COALESCE(NULLIF(btrim(v_inv.payment_terms),''), c.payment_terms) so the invoice override wins.
--   (R2 also flagged a 4th aging producer, get_ar_reminder_candidates — fixed in 161000.)
--   R3 (2026-07-02): CLEAN — "no actionable correctness issues; surgical; auth/idempotency preserved."
-- ============================================================================

-- (1) ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.parse_payment_terms_days(p_terms text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_match text;
  v_days  numeric;                   -- numeric (arbitrary precision), NOT integer: a pasted
                                     -- giant number ('Net 9999999999') would overflow an
                                     -- integer cast and RAISE before the clamp — Codex P2.
BEGIN
  -- first run of digits anywhere in the string: 'net_30' -> 30, 'Net 30' -> 30,
  -- 'Net 45' -> 45, '2/10 Net 30' -> 2 (rare; acceptable — no such live value)
  v_match := (regexp_match(COALESCE(p_terms, ''), '(\d+)'))[1];
  IF v_match IS NULL THEN
    RETURN 30;                       -- NULL / blank / no number -> default Net 30
  END IF;
  v_days := v_match::numeric;        -- numeric never overflows on an oversized digit run
  IF v_days < 1 OR v_days > 365 THEN
    RETURN 30;                       -- clamp a typo'd/pasted 'net 3000' etc. back to default
  END IF;
  RETURN v_days::integer;            -- safe: guaranteed 1..365
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.parse_payment_terms_days(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.parse_payment_terms_days(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.parse_payment_terms_days(text) TO authenticated, service_role;

-- (2) ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_invoice(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_inv record; v_order_status text; v_order_pricing text; v_existing jsonb; v_terms_days integer;  -- A8: v_terms_days added
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  PERFORM check_period_open(v_inv.invoice_date);
  IF v_inv.status NOT IN ('draft', 'unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
  -- PRICING_INCOMPLETE gate (sell-side #2): never post an invoice for a still-
  -- unpriced rush order. Cleared by price_order (v2). Dormant until v1b.
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.order_id IS NOT NULL THEN
    SELECT status, pricing_status INTO v_order_status, v_order_pricing FROM orders WHERE id = v_inv.order_id;
    IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot post invoice — linked order % is cancelled', v_inv.order_id; END IF;
    IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  END IF;

  -- A8: derive due_date from the payment terms; default Net 30 when blank/unparseable.
  -- The invoice-level override (invoices.payment_terms — the documented per-invoice terms that
  -- the PDF prints) WINS over the customer default; fall back to customers.payment_terms when
  -- the invoice override is blank. Applied only-when-NULL in the UPDATE below so a due_date set
  -- at creation (field-app +30) is preserved, and forward-only (runs at post time).
  SELECT parse_payment_terms_days(COALESCE(NULLIF(btrim(v_inv.payment_terms), ''), c.payment_terms))
    INTO v_terms_days
  FROM customers c WHERE c.id = v_inv.customer_id;

  SET LOCAL app.admin_override = 'true';
  UPDATE invoices SET status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now(),
    due_date = COALESCE(due_date, (v_inv.invoice_date + (v_terms_days || ' days')::interval)::date)  -- A8
    WHERE id = p_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_id, (SELECT role FROM profiles WHERE id = auth.uid()), jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'posted', 'posted_at', now()::text), v_inv.total_amount_cents, 'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2));
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted', 'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2), auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  PERFORM generate_rup_sales_records(p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_invoice', jsonb_build_object('success', true, 'invoice_id', p_invoice_id));
  END IF;
END;
$function$;
