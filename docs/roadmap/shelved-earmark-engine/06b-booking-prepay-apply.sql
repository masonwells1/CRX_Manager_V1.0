-- Roadmap #6(b) — set_prepay_credit_booking + apply_booking_prepay — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- POST-APPLY rolled-back: at G5 apply 20260613230000 THEN 20260613240000, THEN
-- run this. It builds a booking-draw order + a posted $100 invoice + an UN-earmarked
-- $100 prepay credit, earmarks it, auto-applies it, asserts BOTH fin-prepay
-- identities, then voids the invoice and asserts the credit + customer cache are
-- fully restored. RAISEs at the end to roll back (zero footprint). Runs as admin.
--   P1  set_prepay_credit_booking(credit, quote) -> credit.quote_id = quote.
--   P2  apply_booking_prepay(invoice) -> applied 10000c/1; invoice paid (balance 0,
--       prepay_applied 10000); credit balance 0; customer cache back to baseline.
--   P3  identity check: customers.prepay_balance_cents delta == 0 (added 10k, applied 10k);
--       a prepay_applications row exists for the invoice.
--   P4  re-apply on the now-paid invoice -> no_op (reason invoice_not_postable).
--   P5  void_invoice -> credit balance restored to 10000; customer cache = baseline+10000;
--       prepay_applications for the invoice = 0 rows; invoice voided.
--
-- Delta-based vs a captured baseline so it works against any existing customer
-- state. The transient prepay credit + cache bump are ROLLED BACK; fin-prepay
-- sweeps run over committed data only, so they are never tripped.
-- REQUIRES the current accounting period OPEN (apply_prepay_to_invoice calls
-- check_period_open(CURRENT_DATE)); if closed, P2 errors — re-run in an open period.
--
-- NOTE (2026-06-13): build-loop Supabase MCP is READ-ONLY → not run live here;
-- verified by rls + drift + compliance reviewers (codex=PENDING per pre-G5 batch).

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  q uuid; o uuid; inv uuid; pc uuid;
  v_cache0 bigint; v_cache bigint;
  r jsonb; out text := '';
  v_pc_bal bigint; v_inv_status text; v_inv_bal bigint; v_inv_pp bigint; v_app_ct int; v_pc_quote uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT prepay_balance_cents INTO v_cache0 FROM customers WHERE id = v_cust;

  -- Booking + draw order + posted $100 invoice
  INSERT INTO quotes (quote_number, customer_id, created_by, status, tier)
    VALUES ('SMOKE-BKG-6B', v_cust, v_admin, 'sent', 1) RETURNING id INTO q;
  INSERT INTO orders (order_number, customer_id, status, quote_id, booking_draw)
    VALUES ('SMOKE-ORD-6B', v_cust, 'confirmed', q, true) RETURNING id INTO o;
  INSERT INTO invoices (customer_id, order_id, status, invoice_type, total_amount_cents)
    VALUES (v_cust, o, 'posted', 'chemical_sale', 10000) RETURNING id INTO inv;

  -- UN-earmarked prepay credit + keep the customer cache identity consistent
  INSERT INTO prepay_credits (customer_id, season, original_amount_cents, balance_cents)
    VALUES (v_cust, current_season(), 10000, 10000) RETURNING id INTO pc;
  UPDATE customers SET prepay_balance_cents = prepay_balance_cents + 10000 WHERE id = v_cust;

  -- P1: earmark
  r := set_prepay_credit_booking(pc, q, v_admin, NULL);
  SELECT quote_id INTO v_pc_quote FROM prepay_credits WHERE id = pc;
  out := out || format('P1 earmark: success=%s quote_set=%s -> %s | ',
    r->>'success', (v_pc_quote = q),
    CASE WHEN (r->>'success')='true' AND v_pc_quote = q THEN 'PASS' ELSE 'FAIL' END);

  -- P2: auto-apply booking prepay
  r := apply_booking_prepay(inv, v_admin, NULL);
  SELECT balance_cents INTO v_pc_bal FROM prepay_credits WHERE id = pc;
  SELECT status, balance_cents, prepay_applied_cents INTO v_inv_status, v_inv_bal, v_inv_pp FROM invoices WHERE id = inv;
  SELECT prepay_balance_cents INTO v_cache FROM customers WHERE id = v_cust;
  out := out || format('P2 apply: applied=%s/%s inv(status=%s bal=%s pp=%s) credit_bal=%s cache_delta=%s -> %s | ',
    r->>'applied_cents', r->>'applied_count', v_inv_status, v_inv_bal, v_inv_pp, v_pc_bal, (v_cache - v_cache0),
    CASE WHEN (r->>'applied_cents')::bigint=10000 AND (r->>'applied_count')::int=1
          AND v_inv_status='paid' AND v_inv_bal=0 AND v_inv_pp=10000
          AND v_pc_bal=0 AND (v_cache - v_cache0)=0
         THEN 'PASS' ELSE 'FAIL' END);

  -- P3: ledger identity
  SELECT count(*) INTO v_app_ct FROM prepay_applications WHERE invoice_id = inv;
  out := out || format('P3 ledger: applications=%s -> %s | ',
    v_app_ct, CASE WHEN v_app_ct=1 THEN 'PASS' ELSE 'FAIL' END);

  -- P4: re-apply is a no-op (invoice now paid)
  r := apply_booking_prepay(inv, v_admin, NULL);
  out := out || format('P4 reapply-noop: no_op=%s reason=%s -> %s | ',
    r->>'no_op', r->>'reason',
    CASE WHEN (r->>'no_op')='true' THEN 'PASS' ELSE 'FAIL' END);

  -- P5: void restores prepay
  PERFORM void_invoice(inv, 'smoke 6b', NULL);
  SELECT balance_cents INTO v_pc_bal FROM prepay_credits WHERE id = pc;
  SELECT prepay_balance_cents INTO v_cache FROM customers WHERE id = v_cust;
  SELECT count(*) INTO v_app_ct FROM prepay_applications WHERE invoice_id = inv;
  SELECT status INTO v_inv_status FROM invoices WHERE id = inv;
  out := out || format('P5 void-restore: credit_bal=%s cache_delta=%s applications=%s inv=%s -> %s',
    v_pc_bal, (v_cache - v_cache0), v_app_ct, v_inv_status,
    CASE WHEN v_pc_bal=10000 AND (v_cache - v_cache0)=10000 AND v_app_ct=0 AND v_inv_status='voided'
         THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
