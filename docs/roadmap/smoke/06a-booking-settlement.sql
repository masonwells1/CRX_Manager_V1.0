-- Roadmap #6(a) — prepay_credits.quote_id link + get_booking_settlement — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- POST-APPLY rolled-back: at G5 apply 20260613230000, THEN run this; it builds a
-- booking (sent quote, 2 quote_items same product, a partial draw, an earmarked
-- prepay credit), calls get_booking_settlement, asserts the booked/drawn/
-- remaining (qty + cents) + prepay earmarked/applied/remaining, then RAISEs to
-- roll back (zero footprint). Runs as an admin via the JWT claim.
--   P1  weighted-avg booked: 2 lines (40*100 + 60*100) -> booked_qty=200,
--       wavg=50, booked_cents=1,000,000; draw=50 -> drawn_cents=250,000,
--       remaining_qty=150 -> remaining_cents=750,000; prepay credit original
--       10,000 / balance 6,000 -> earmarked=10,000, remaining=6,000, applied=4,000.
--   P2  unknown quote uuid -> found=false.
--   P3  driver JWT -> INSUFFICIENT_ROLE (read RPC self-gates).
--
-- NOTE on the prepay credit: balance_cents (6,000) is set < original (10,000)
-- directly to exercise the applied = earmarked − remaining derivation. This is a
-- transient, ROLLED-BACK synthetic state; the fin-prepay-balance sweep runs over
-- COMMITTED data only, so it is never tripped. (#6b will produce this state for
-- real via apply_prepay_to_invoice through the prepay_applications ledger.)
--
-- NOTE (2026-06-13): build-loop Supabase MCP is READ-ONLY → not run live here;
-- verified by rls + drift + types reviewers (codex=PENDING per the pre-G5 batch).

DO $$
DECLARE
  v_admin  uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_driver uuid := (SELECT id FROM profiles WHERE role='driver' AND is_active=true LIMIT 1);
  v_cust   uuid := (SELECT id FROM customers LIMIT 1);
  v_prod   uuid := (SELECT id FROM products LIMIT 1);
  q uuid; sec uuid; r jsonb; line0 jsonb; out text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO quotes (quote_number, customer_id, created_by, status, tier)
    VALUES ('SMOKE-BKG-6A', v_cust, v_admin, 'sent', 1) RETURNING id INTO q;
  INSERT INTO quote_sections (quote_id, section_name) VALUES (q, 'S1') RETURNING id INTO sec;
  INSERT INTO quote_items (quote_id, section_id, product_id, price_per_unit, total_units_needed)
    VALUES (q, sec, v_prod, 40, 100);
  INSERT INTO quote_items (quote_id, section_id, product_id, price_per_unit, total_units_needed)
    VALUES (q, sec, v_prod, 60, 100);
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (q, v_prod, 50);
  INSERT INTO prepay_credits (customer_id, quote_id, season, original_amount_cents, balance_cents)
    VALUES (v_cust, q, current_season(), 10000, 6000);

  -- P1: full settlement
  r := get_booking_settlement(q);
  line0 := r->'lines'->0;
  out := out || format(
    'P1 settlement: found=%s booked=%s drawn=%s remaining=%s pp_earmark=%s pp_applied=%s pp_remain=%s line(booked_qty=%s drawn_qty=%s remain_qty=%s price=%s) -> %s | ',
    r->>'found', r->>'booked_cents', r->>'drawn_cents', r->>'remaining_cents',
    r->>'prepay_earmarked_cents', r->>'prepay_applied_cents', r->>'prepay_remaining_cents',
    line0->>'booked_qty', line0->>'drawn_qty', line0->>'remaining_qty', line0->>'locked_price',
    CASE WHEN (r->>'found')='true'
          AND (r->>'booked_cents')::bigint = 1000000
          AND (r->>'drawn_cents')::bigint = 250000
          AND (r->>'remaining_cents')::bigint = 750000
          AND (r->>'prepay_earmarked_cents')::bigint = 10000
          AND (r->>'prepay_applied_cents')::bigint = 4000
          AND (r->>'prepay_remaining_cents')::bigint = 6000
          AND (line0->>'booked_qty')::numeric = 200
          AND (line0->>'drawn_qty')::numeric = 50
          AND (line0->>'remaining_qty')::numeric = 150
          AND (line0->>'locked_price')::numeric = 50
         THEN 'PASS' ELSE 'FAIL' END);

  -- P2: unknown booking
  r := get_booking_settlement(gen_random_uuid());
  out := out || format('P2 not-found: found=%s -> %s | ',
    r->>'found', CASE WHEN (r->>'found')='false' THEN 'PASS' ELSE 'FAIL' END);

  -- P3: driver is denied (read RPC self-gates)
  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
    BEGIN
      r := get_booking_settlement(q);
      out := out || 'P3 driver-denied: NO RAISE -> FAIL';
    EXCEPTION WHEN OTHERS THEN
      out := out || format('P3 driver-denied: %s -> %s',
        SQLERRM, CASE WHEN SQLERRM LIKE '%INSUFFICIENT_ROLE%' THEN 'PASS' ELSE 'FAIL' END);
    END;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  ELSE
    out := out || 'P3 driver-denied: SKIPPED (no active driver profile)';
  END IF;

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
