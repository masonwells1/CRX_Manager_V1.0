-- Roadmap #6(b-B) — auto-apply booking prepay on post — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- POST-APPLY rolled-back: at G5 apply 20260613230000 + 240000 + 250000, THEN run
-- this. It posts a booking-draw invoice (with an earmarked credit) via post_invoice
-- and asserts the trigger AUTO-applied the prepay; then posts a NORMAL invoice and
-- asserts posting is unaffected + no prepay touched. RAISEs to roll back. Admin JWT.
--   P1  booking-draw + earmarked $100 credit: post_invoice(inv) -> trigger fires ->
--       prepay auto-applied (inv paid, prepay_applied 10000, balance 0); credit
--       balance 0; customer cache delta 0; 1 prepay_applications row.
--   P2  normal (non-booking) draft invoice: post_invoice(inv2) -> status 'posted',
--       0 prepay_applications, posting unaffected.
--
-- "A prepay error never blocks posting" is guaranteed structurally by the trigger
-- fn's BEGIN/EXCEPTION WHEN OTHERS wrapper (reviewed), not asserted here (hard to
-- force a deterministic apply error in a rolled-back probe).
-- REQUIRES the current accounting period OPEN (post_invoice + apply_prepay_to_invoice
-- both call check_period_open). NOTE (2026-06-13): build-loop MCP is READ-ONLY →
-- not run live here; verified by rls + drift reviewers (codex=PENDING pre-G5 batch).

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  q uuid; o uuid; inv uuid; pc uuid;
  o2 uuid; inv2 uuid;
  v_cache0 bigint; v_cache bigint;
  v_pc_bal bigint; v_inv_status text; v_inv_pp bigint; v_app_ct int;
  v_inv2_status text; v_app2_ct int;
  out text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT prepay_balance_cents INTO v_cache0 FROM customers WHERE id = v_cust;

  -- P1 fixture: booking + draw order + DRAFT invoice + earmarked credit
  INSERT INTO quotes (quote_number, customer_id, created_by, status, tier)
    VALUES ('SMOKE-BKG-6BB', v_cust, v_admin, 'sent', 1) RETURNING id INTO q;
  INSERT INTO orders (order_number, customer_id, status, quote_id, booking_draw)
    VALUES ('SMOKE-ORD-6BB', v_cust, 'confirmed', q, true) RETURNING id INTO o;
  INSERT INTO invoices (customer_id, order_id, status, invoice_type, total_amount_cents)
    VALUES (v_cust, o, 'draft', 'chemical_sale', 10000) RETURNING id INTO inv;
  INSERT INTO prepay_credits (customer_id, quote_id, season, original_amount_cents, balance_cents)
    VALUES (v_cust, q, current_season(), 10000, 10000) RETURNING id INTO pc;
  UPDATE customers SET prepay_balance_cents = prepay_balance_cents + 10000 WHERE id = v_cust;

  PERFORM post_invoice(inv, NULL);  -- fires trg_apply_booking_prepay_on_post

  SELECT status, prepay_applied_cents INTO v_inv_status, v_inv_pp FROM invoices WHERE id = inv;
  SELECT balance_cents INTO v_pc_bal FROM prepay_credits WHERE id = pc;
  SELECT prepay_balance_cents INTO v_cache FROM customers WHERE id = v_cust;
  SELECT count(*) INTO v_app_ct FROM prepay_applications WHERE invoice_id = inv;
  out := out || format('P1 auto-on-post: inv(status=%s pp=%s) credit_bal=%s cache_delta=%s apps=%s -> %s | ',
    v_inv_status, v_inv_pp, v_pc_bal, (v_cache - v_cache0), v_app_ct,
    CASE WHEN v_inv_status IN ('posted','paid') AND v_inv_pp = 10000
          AND v_pc_bal = 0 AND (v_cache - v_cache0) = 0 AND v_app_ct = 1
         THEN 'PASS' ELSE 'FAIL' END);

  -- P2 fixture: normal (non-booking) order + DRAFT invoice, no earmarked credit
  INSERT INTO orders (order_number, customer_id, status)
    VALUES ('SMOKE-ORD-6BB-N', v_cust, 'confirmed') RETURNING id INTO o2;
  INSERT INTO invoices (customer_id, order_id, status, invoice_type, total_amount_cents)
    VALUES (v_cust, o2, 'draft', 'chemical_sale', 5000) RETURNING id INTO inv2;

  PERFORM post_invoice(inv2, NULL);

  SELECT status INTO v_inv2_status FROM invoices WHERE id = inv2;
  SELECT count(*) INTO v_app2_ct FROM prepay_applications WHERE invoice_id = inv2;
  out := out || format('P2 normal-post: inv2(status=%s) apps=%s -> %s',
    v_inv2_status, v_app2_ct,
    CASE WHEN v_inv2_status = 'posted' AND v_app2_ct = 0 THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
