-- ============================================================================
-- SMOKE TEST (rolled back by design): rollover_quote_to_season remainder-only
-- ----------------------------------------------------------------------------
-- Verifies 20260610190300_rollover_remainder_only.sql (remainder mode gated
-- to OPEN bookings: v_old_quote.status IN ('sent','revised')):
--   1. OPEN booking (status='sent'), 500 booked / 200 drawn (split across TWO
--      items, 300 + 200, to exercise the FIFO item math) rolls over to a
--      new-season quote carrying exactly the 300-unit remainder: item 1
--      reduced 300 -> 100 (acres prorated 30 -> 10.00), item 2 untouched at
--      200 (acres 40 unchanged); remainder_rollover=true.
--   2. Regression control (legacy renewal): an ACCEPTED fully-drawn booking
--      (500 booked / 500 drawn, then sent -> accepted — the exact end state
--      draw_down_quote leaves on full drain) rolls over as the VERBATIM LIVE
--      full-quantity copy: NO BOOKING_FULLY_DRAWN, all items copied, acres
--      exactly the originals (30/40 — the full program, not the 0 remainder),
--      total_units_needed NULL on every copy (live never writes tun on
--      rollover; QuoteBuilder rematerializes the FULL quantity from
--      acres x rate), remainder_rollover=false.
--   3. Corrupt-ledger guard: an OPEN booking (status='sent') whose ledger
--      reads fully drawn (500/500 — unreachable via draw_down_quote, which
--      flips the quote to 'accepted' on full drain; forced via direct ledger
--      INSERT as the DO-block owner) raises BOOKING_FULLY_DRAWN (clear
--      error, no new quote).
--   4. No-draws control: rolls over exactly as live did — item copied,
--      total_units_needed left NULL.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success it raises
-- 'SMOKE_PASS_ROLLBACK' — so nothing here ever commits.
--
-- Calling context: rollover_quote_to_season is authenticated-executable with
-- an in-body strict-actor gate (auth.uid() must equal p_performed_by and be
-- an active admin/sales_rep). We simulate the authenticated context with
-- transaction-local request.jwt.claims whose sub is a REAL active admin
-- profile id, so the profiles role check passes without synthetic profiles.
-- ============================================================================

DO $$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_product uuid;
  v_quote uuid;
  v_section uuid;
  v_result jsonb;
  v_new_quote uuid;
  v_sum numeric;
  v_n int;
  v_tun1 numeric;
  v_tun2 numeric;
  v_acres1 numeric;
  v_acres2 numeric;
  v_caught boolean := false;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
  SELECT id INTO v_customer FROM customers LIMIT 1;
  SELECT id INTO v_product FROM products LIMIT 1;
  IF v_admin IS NULL OR v_customer IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP_FAILED: need at least one active admin profile, one customer, and one product';
  END IF;

  -- Simulate the authenticated calling context (transaction-local claims)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ==========================================================================
  -- Scenario 1: OPEN booking (status='sent') — 500 booked (items 300 + 200)
  -- / 200 drawn -> remainder 300 rolls over
  -- ==========================================================================
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split, season)
  VALUES ('SMOKE-A5-PART-' || substr(gen_random_uuid()::text, 1, 8), v_customer, v_admin,
          'sent', '{"splits": []}'::jsonb, 2026)
  RETURNING id INTO v_quote;

  INSERT INTO quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Smoke Section', 1)
  RETURNING id INTO v_section;

  -- Two items of the SAME product: FIFO must consume item 1 first.
  INSERT INTO quote_items (quote_id, section_id, product_id, sort_order,
    price_per_unit, current_cost, acres, total_units_needed)
  VALUES (v_quote, v_section, v_product, 1, 10, 6, 30, 300),
         (v_quote, v_section, v_product, 2, 10, 6, 40, 200);

  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES (v_quote, v_product, 200);

  v_result := public.rollover_quote_to_season(v_quote, 2027, v_admin, NULL);
  IF v_result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: partial rollover returned status % (expected created)', v_result->>'status';
  END IF;
  IF (v_result->>'remainder_rollover')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: partial rollover did not flag remainder_rollover=true (%)', v_result;
  END IF;
  v_new_quote := (v_result->>'quote_id')::uuid;

  SELECT count(*), COALESCE(SUM(total_units_needed), 0)
  INTO v_n, v_sum
  FROM quote_items WHERE quote_id = v_new_quote AND product_id = v_product;
  IF v_n <> 2 OR v_sum <> 300 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 2 items summing 300 on the new-season quote, got % items summing %', v_n, v_sum;
  END IF;

  SELECT total_units_needed, acres INTO v_tun1, v_acres1
  FROM quote_items WHERE quote_id = v_new_quote AND sort_order = 1;
  SELECT total_units_needed, acres INTO v_tun2, v_acres2
  FROM quote_items WHERE quote_id = v_new_quote AND sort_order = 2;
  IF v_tun1 <> 100 OR v_tun2 <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: FIFO item math wrong — item1=% (expected 100), item2=% (expected 200)', v_tun1, v_tun2;
  END IF;
  IF v_acres1 <> 10 OR v_acres2 <> 40 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: acre proration wrong — item1 acres=% (expected 10.00), item2 acres=% (expected 40)', v_acres1, v_acres2;
  END IF;

  -- ==========================================================================
  -- Scenario 2 (regression control — legacy renewal): ACCEPTED fully-drawn
  -- booking -> the VERBATIM LIVE full-quantity copy. This is the normal end
  -- state draw_down_quote leaves behind (ledger fully drawn, quote flipped
  -- sent -> accepted on the final draw) and rollover's PRIMARY use case:
  -- "renew last season's completed program". Remainder mode must NOT engage:
  -- no BOOKING_FULLY_DRAWN, no item reduction, remainder_rollover=false.
  -- ==========================================================================
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split, season)
  VALUES ('SMOKE-A5-ACC-' || substr(gen_random_uuid()::text, 1, 8), v_customer, v_admin,
          'sent', '{"splits": []}'::jsonb, 2026)
  RETURNING id INTO v_quote;

  INSERT INTO quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Smoke Section', 1)
  RETURNING id INTO v_section;

  -- Same two-item shape as Scenario 1 so an incorrectly-engaged remainder
  -- mode would visibly drop/shrink lines here.
  INSERT INTO quote_items (quote_id, section_id, product_id, sort_order,
    price_per_unit, current_cost, acres, total_units_needed)
  VALUES (v_quote, v_section, v_product, 1, 10, 6, 30, 300),
         (v_quote, v_section, v_product, 2, 10, 6, 40, 200);

  -- Draw the booking to completion: full 500 on the ledger, then the
  -- sent -> accepted flip draw_down_quote performs on full drain (an
  -- enforcer-allowed transition).
  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES (v_quote, v_product, 500);
  UPDATE quotes SET status = 'accepted' WHERE id = v_quote;

  v_result := public.rollover_quote_to_season(v_quote, 2027, v_admin, NULL);
  IF v_result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: accepted fully-drawn rollover returned status % (expected created — remainder mode must not engage on closed bookings)', v_result->>'status';
  END IF;
  IF COALESCE((v_result->>'remainder_rollover')::boolean, false) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: accepted fully-drawn rollover flagged remainder_rollover (%) — must be the plain live copy', v_result;
  END IF;
  v_new_quote := (v_result->>'quote_id')::uuid;

  SELECT count(*) INTO v_n FROM quote_items WHERE quote_id = v_new_quote AND product_id = v_product;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: accepted fully-drawn rollover copied % items (expected ALL 2 — full-quantity copy)', v_n;
  END IF;
  -- Byte-identical to live: the live full copy NEVER writes
  -- total_units_needed (QuoteBuilder rematerializes the FULL quantity from
  -- acres x rate), so "per-product totals equal the original booked
  -- quantities" is asserted the way live expresses it — every copied item has
  -- tun NULL and carries the ORIGINAL, un-prorated acres (30/40 = the full
  -- 500-unit program, not the 0-unit remainder).
  IF EXISTS (SELECT 1 FROM quote_items WHERE quote_id = v_new_quote AND total_units_needed IS NOT NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: accepted fully-drawn rollover wrote total_units_needed — not the verbatim live full copy';
  END IF;
  SELECT acres INTO v_acres1 FROM quote_items WHERE quote_id = v_new_quote AND sort_order = 1;
  SELECT acres INTO v_acres2 FROM quote_items WHERE quote_id = v_new_quote AND sort_order = 2;
  IF v_acres1 <> 30 OR v_acres2 <> 40 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: accepted fully-drawn rollover changed acres — item1=% (expected 30), item2=% (expected 40)', v_acres1, v_acres2;
  END IF;

  -- ==========================================================================
  -- Scenario 3 (corrupt-ledger guard): OPEN booking (status='sent') whose
  -- ledger reads fully drawn (500/500) -> BOOKING_FULLY_DRAWN.
  -- draw_down_quote cannot produce this state (it flips the quote to
  -- 'accepted' on full drain), so we force it via direct ledger INSERT as the
  -- DO-block owner (postgres, bypasses RLS). The open-booking remainder gate
  -- must refuse to mint an empty next-season quote.
  -- ==========================================================================
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split, season)
  VALUES ('SMOKE-A5-FULL-' || substr(gen_random_uuid()::text, 1, 8), v_customer, v_admin,
          'sent', '{"splits": []}'::jsonb, 2026)
  RETURNING id INTO v_quote;

  INSERT INTO quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Smoke Section', 1)
  RETURNING id INTO v_section;

  INSERT INTO quote_items (quote_id, section_id, product_id, sort_order,
    price_per_unit, current_cost, acres, total_units_needed)
  VALUES (v_quote, v_section, v_product, 1, 10, 6, 100, 500);

  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  VALUES (v_quote, v_product, 500);

  BEGIN
    v_result := public.rollover_quote_to_season(v_quote, 2027, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: open corrupt fully-drawn rollover did not raise (returned %)', v_result;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'BOOKING_FULLY_DRAWN%' THEN
        v_caught := true;
      ELSE
        RAISE;  -- includes the SMOKE_FAIL above and any unexpected error
      END IF;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'SMOKE_FAIL: BOOKING_FULLY_DRAWN was not raised for an OPEN fully-drawn booking';
  END IF;

  -- ==========================================================================
  -- Scenario 4 (no-draws control): open quote, empty ledger -> live behavior
  -- preserved exactly (item copied, total_units_needed stays NULL on the copy)
  -- ==========================================================================
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split, season)
  VALUES ('SMOKE-A5-CLEAN-' || substr(gen_random_uuid()::text, 1, 8), v_customer, v_admin,
          'sent', '{"splits": []}'::jsonb, 2026)
  RETURNING id INTO v_quote;

  INSERT INTO quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Smoke Section', 1)
  RETURNING id INTO v_section;

  INSERT INTO quote_items (quote_id, section_id, product_id, sort_order,
    price_per_unit, current_cost, acres, total_units_needed)
  VALUES (v_quote, v_section, v_product, 1, 10, 6, 100, 500);

  v_result := public.rollover_quote_to_season(v_quote, 2027, v_admin, NULL);
  IF v_result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no-draws rollover returned status % (expected created)', v_result->>'status';
  END IF;
  IF (v_result->>'remainder_rollover')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no-draws rollover flagged remainder_rollover (%)', v_result;
  END IF;
  v_new_quote := (v_result->>'quote_id')::uuid;

  SELECT count(*) INTO v_n FROM quote_items WHERE quote_id = v_new_quote;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no-draws rollover copied % items (expected 1)', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM quote_items WHERE quote_id = v_new_quote AND total_units_needed IS NOT NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no-draws rollover set total_units_needed — live behavior was NOT preserved';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
