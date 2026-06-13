-- Roadmap #6(d) — get_open_booking_rollover — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- POST-APPLY rolled-back: at G5 apply 20260613230000 (+ siblings) THEN 260000,
-- THEN run this. Builds one open booking (2 lines same product = wavg, a partial
-- draw, an earmarked credit) and asserts get_open_booking_rollover returns that
-- booking's row with the right booked/drawn/remaining + prepay totals. Filters by
-- customer so it isolates from other live bookings. RAISEs to roll back. Admin JWT.
--   Lines: 40*100 + 60*100 -> booked_qty 200, wavg 50, booked_cents 1,000,000;
--   draw 50 -> drawn_cents 250,000, remaining_cents 750,000; credit original
--   10,000 / balance 6,000 -> earmarked 10,000, applied 4,000, remaining 6,000.
--   P1  the customer filter returns >=1 row and our booking's totals are exact.
--   P2  a bogus customer filter returns an empty bookings array.
--
-- (Synthetic credit balance<original is a transient, ROLLED-BACK state to exercise
-- the applied=earmarked-remaining derivation; fin-prepay sweeps run on committed
-- data only.) NOTE (2026-06-13): build-loop MCP READ-ONLY → not run live here;
-- verified by rls + drift + types reviewers (codex=PENDING pre-G5 batch).

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  v_prod  uuid := (SELECT id FROM products LIMIT 1);
  q uuid; sec uuid; r jsonb; v_row jsonb; out text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO quotes (quote_number, customer_id, created_by, status, tier, season)
    VALUES ('SMOKE-BKG-6D', v_cust, v_admin, 'sent', 1, current_season()) RETURNING id INTO q;
  INSERT INTO quote_sections (quote_id, section_name) VALUES (q, 'S1') RETURNING id INTO sec;
  INSERT INTO quote_items (quote_id, section_id, product_id, price_per_unit, total_units_needed)
    VALUES (q, sec, v_prod, 40, 100);
  INSERT INTO quote_items (quote_id, section_id, product_id, price_per_unit, total_units_needed)
    VALUES (q, sec, v_prod, 60, 100);
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn) VALUES (q, v_prod, 50);
  INSERT INTO prepay_credits (customer_id, quote_id, season, original_amount_cents, balance_cents)
    VALUES (v_cust, q, current_season(), 10000, 6000);

  -- P1: rollover for this customer; find our booking row
  r := get_open_booking_rollover(v_cust, NULL);
  SELECT b INTO v_row
    FROM jsonb_array_elements(r->'bookings') b
    WHERE (b->>'quote_id')::uuid = q;
  out := out || format('P1 rollover: success=%s found=%s booked=%s drawn=%s remaining=%s earmark=%s applied=%s remain_pp=%s -> %s | ',
    r->>'success', (v_row IS NOT NULL),
    v_row->>'booked_cents', v_row->>'drawn_cents', v_row->>'remaining_cents',
    v_row->>'prepay_earmarked_cents', v_row->>'prepay_applied_cents', v_row->>'prepay_remaining_cents',
    CASE WHEN (r->>'success')='true' AND v_row IS NOT NULL
          AND (v_row->>'booked_cents')::bigint = 1000000
          AND (v_row->>'drawn_cents')::bigint = 250000
          AND (v_row->>'remaining_cents')::bigint = 750000
          AND (v_row->>'prepay_earmarked_cents')::bigint = 10000
          AND (v_row->>'prepay_applied_cents')::bigint = 4000
          AND (v_row->>'prepay_remaining_cents')::bigint = 6000
         THEN 'PASS' ELSE 'FAIL' END);

  -- P2: bogus customer -> empty
  r := get_open_booking_rollover(gen_random_uuid(), NULL);
  out := out || format('P2 empty: count=%s -> %s',
    jsonb_array_length(r->'bookings'),
    CASE WHEN jsonb_array_length(r->'bookings') = 0 THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
