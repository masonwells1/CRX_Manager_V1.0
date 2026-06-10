-- ============================================================================
-- Fix A5 (MED, 2026-06-10 partial-draw consumer sweep): rollover_quote_to_season
-- must roll over only the UNDRAWN remainder of a partially-drawn booking.
-- ----------------------------------------------------------------------------
-- Since 20260610145253_partial_quote_draw_down, a quote with rows in
-- quote_product_draws (quantity_drawn > 0) is a season booking whose drawn
-- portion is ALREADY on orders. The live rollover copies every item's full
-- acres/rates to the next season, so rolling over a 500-booked/200-drawn
-- booking would re-book all 500 next season — double-booking the 200 that
-- were already ordered and delivered.
--
-- Base body reproduced VERBATIM from live (pre-apply prosrc md5
-- c53cf8e2bdcb45c739a0e4493716d03a, byte-exact-verified against the catalog
-- 2026-06-10). NOTE: the live body is the 20260609195843 strict-actor version
-- but with the disk file's inline comments stripped — the LIVE text (not the
-- disk text) is the verbatim base here. Changes, exhaustively:
--
--   (1) `FOR UPDATE` appended to the source-quote SELECT. draw_down_quote
--       serializes on the quotes row lock; without it a concurrent draw could
--       land between this function's ledger reads and its item copies, making
--       the rolled remainder stale (over-rolling the just-drawn quantity).
--   (2) Inserted block A (after the quote fetch), GATED to OPEN bookings only
--       (v_old_quote.status IN ('sent','revised') — the same statuses
--       draw_down_quote draws against; see STATUS SCOPING below): detect
--       draws; if the open booking has draws and NO product has an undrawn
--       remainder (booked - drawn <= 0 for every product), RAISE
--       'BOOKING_FULLY_DRAWN: ...'. Raising (vs a no-op return) is deliberate:
--       QuoteBuilder.handleRollover navigates to result.quote_id on ANY
--       non-error return, so a {'status':'no_op'} would navigate to
--       /quotes/undefined; an exception surfaces as a failure toast. Matches
--       the existing BOOKING_* token family (BOOKING_CLOSED / _OVERDRAWN /
--       _PARTIALLY_DRAWN) and this function's raise-on-error convention.
--   (3) Inserted block B (per item) + a draws-path variant of the item
--       INSERT: FIFO remainder math, documented below.
--   (4) Success return gains 'remainder_rollover' (boolean). Existing callers
--       read only quote_id/quote_number/season — additive, non-breaking.
--
-- STATUS SCOPING (the legacy-renewal regression this gate avoids):
-- Remainder mode applies ONLY to OPEN bookings — v_old_quote.status IN
-- ('sent','revised'), exactly the statuses draw_down_quote will draw against
-- (anything else is BOOKING_CLOSED there). For a quote in ANY other status
-- (accepted / declined / expired / cancelled — including every legacy
-- conversion whose ledger reads fully drawn via the 20260610145253 §2 and
-- 20260610184551 backfills), this function behaves
-- EXACTLY as live today: full-quantity copy, byte-identical. "Renew last
-- season's completed program" is rollover's PRIMARY use case; an unscoped
-- draft would have raised BOOKING_FULLY_DRAWN on every legacy
-- accepted+fully-drawn booking and silently shrunk renewals of accepted
-- partially-drawn bookings — breaking renewals outright. With the gate,
-- BOOKING_FULLY_DRAWN can only fire for an open sent/revised booking whose
-- every product has remainder <= 0 — a state draw_down_quote cannot produce
-- (it flips the quote to 'accepted' on full drain), kept purely as a
-- corrupt-ledger guard.
--
-- ITEM-LEVEL MATH (the load-bearing design decision):
-- Draws are PER-PRODUCT; a product may span multiple quote_items. The drawn
-- quantity is allocated to items FIFO in deterministic display order
-- (section.sort_order, section.id, item.sort_order, item.id) — the same
-- consume-from-the-front convention draw_down_quote uses for inventory_holds.
-- For an item whose product has draws:
--     new_qty = LEAST(item_qty, GREATEST(cum_before + item_qty - drawn, 0))
-- where cum_before = sum of item_qty over earlier items of the same product.
-- This is EXACT (sum of new_qty over a product's items == booked - drawn,
-- no rounding drift — rejected proration because remainder/booked factors
-- like 2/3 leave numeric residue), needs no temp state, and is independent of
-- loop iteration order. Fully-consumed lines (new_qty <= 0, including
-- zero-quantity lines of a drawn product) are SKIPPED. Acres are prorated
-- within the reduced item and rounded to 2 decimals — the exact precedent of
-- draw_down_quote's acre proration.
--
-- WHAT IS COPIED, scoped tightly to the bug:
-- * Quote NOT open (status NOT IN ('sent','revised') — accepted/declined/
--   expired/cancelled/draft): byte-identical behavior to live REGARDLESS of
--   the ledger — full-quantity copy, items WITHOUT total_units_needed (NULL).
--   This is the legacy-renewal path and it must never enter remainder mode.
-- * Open quote, no draws (the common open path, incl. every rollover of a
--   quote with an empty ledger): byte-identical behavior to
--   live — items copied WITHOUT total_units_needed (NULL; QuoteBuilder
--   rematerializes quantities from acres x rate on edit).
-- * Open quote with draws, item's product UNDRAWN: the verbatim live copy
--   (tun stays NULL), untouched.
-- * Open quote with draws, item's product DRAWN: the new quote item carries
--   the EXPLICIT remainder in total_units_needed (so the remainder is
--   authoritative, e.g. 500 booked / 200 drawn -> 300) AND prorated acres
--   (so a QuoteBuilder recalc from acres x rate reproduces ~the remainder
--   instead of silently restoring the full quantity).
--
-- Grants: live proacl {postgres,authenticated,service_role} (strict-actor
-- gate is the in-body control). CREATE OR REPLACE preserves the ACL; the
-- self-verification block asserts it.
--
-- Frontend follow-up (NOT in this migration — frontend owned elsewhere):
-- register 'BOOKING_FULLY_DRAWN' in RpcErrorCodes (src/lib/db.ts) and handle
-- it in QuoteBuilder.handleRollover for a friendlier toast.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section RECORD;
  v_new_section_id uuid;
  v_item RECORD;
  v_tier_price numeric;
  v_current_cost numeric;
  -- A5 additions
  v_has_draws boolean := false;
  v_total_remainder numeric;
  v_drawn numeric;
  v_cum_before numeric;
  v_item_tun numeric;
  v_new_tun numeric;
  v_new_acres numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'rollover_quote_to_season', to_jsonb(p_quote_id));
  END IF;

  -- A5 change (1): FOR UPDATE serializes against draw_down_quote (which locks
  -- the same quotes row) so the draws ledger is stable for the copy below.
  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  -- A5 inserted block A: draw-awareness, GATED to OPEN bookings only
  -- (status IN ('sent','revised') — the same statuses draw_down_quote draws
  -- against). A partially-drawn OPEN booking rolls over only its undrawn
  -- remainder; an open booking with no remainder anywhere has nothing to
  -- roll. Any OTHER status (accepted/declined/expired/cancelled, incl. every
  -- backfilled legacy fully-drawn conversion) skips this block entirely:
  -- v_has_draws stays false and the copy below is the verbatim live
  -- full-quantity copy — "renew last season's completed program" unchanged.
  IF v_old_quote.status IN ('sent', 'revised') THEN
    SELECT EXISTS (
      SELECT 1 FROM quote_product_draws
      WHERE quote_id = p_quote_id AND quantity_drawn > 0
    ) INTO v_has_draws;
    IF v_has_draws THEN
      SELECT COALESCE(SUM(GREATEST(b.booked - COALESCE(d.quantity_drawn, 0), 0)), 0)
      INTO v_total_remainder
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = p_quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = p_quote_id AND d.product_id = b.product_id;
      IF v_total_remainder <= 0 THEN
        RAISE EXCEPTION 'BOOKING_FULLY_DRAWN: quote % has no undrawn balance to roll over — every booked quantity is already on orders', v_old_quote.quote_number;
      END IF;
    END IF;
  END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status, is_planned,
    commission_split, valid_days, header_notes, footer_notes, season, salesman_id
  ) VALUES (
    v_new_quote_number, v_old_quote.customer_id, v_actor, v_old_quote.tier,
    'draft', v_old_quote.is_planned, v_old_quote.commission_split,
    v_old_quote.valid_days, v_old_quote.header_notes, v_old_quote.footer_notes,
    p_new_season, v_old_quote.salesman_id
  ) RETURNING id INTO v_new_quote_id;

  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_new_quote_id, v_section.section_name, v_section.sort_order,
      v_section.section_notes, v_section.section_header_notes)
    RETURNING id INTO v_new_section_id;

    FOR v_item IN
      SELECT * FROM quote_items WHERE section_id = v_section.id ORDER BY sort_order
    LOOP
      -- A5 inserted block B: FIFO remainder math. Reachable only when block A
      -- found draws — i.e. the booking is OPEN (sent/revised) AND has draws —
      -- and only reduces items whose product is drawn; everything else,
      -- including EVERY item of a non-open quote, copies as live.
      v_drawn := 0;
      v_new_tun := NULL;
      v_new_acres := NULL;
      IF v_has_draws THEN
        SELECT quantity_drawn INTO v_drawn
        FROM quote_product_draws
        WHERE quote_id = p_quote_id AND product_id = v_item.product_id;
        v_drawn := COALESCE(v_drawn, 0);
        IF v_drawn > 0 THEN
          v_item_tun := COALESCE(v_item.total_units_needed, 0);
          -- Booked quantity on items EARLIER than this one in deterministic
          -- display order; the drawn quantity consumes items from the front.
          SELECT COALESCE(SUM(COALESCE(qi2.total_units_needed, 0)), 0) INTO v_cum_before
          FROM quote_items qi2
          JOIN quote_sections qs2 ON qs2.id = qi2.section_id
          WHERE qi2.quote_id = p_quote_id
            AND qi2.product_id = v_item.product_id
            AND (qs2.sort_order, qs2.id, qi2.sort_order, qi2.id)
              < (v_section.sort_order, v_section.id, v_item.sort_order, v_item.id);
          v_new_tun := LEAST(v_item_tun, GREATEST(v_cum_before + v_item_tun - v_drawn, 0));
          IF v_new_tun <= 0 THEN
            CONTINUE;  -- line fully consumed by draws: nothing to roll over
          END IF;
          IF v_new_tun = v_item_tun THEN
            v_new_acres := v_item.acres;  -- untouched line: copy acres exactly
          ELSIF v_item.acres IS NOT NULL AND v_item_tun > 0 THEN
            v_new_acres := ROUND(v_item.acres * v_new_tun / v_item_tun, 2);
          ELSE
            v_new_acres := v_item.acres;
          END IF;
        END IF;
      END IF;

      SELECT CASE v_old_quote.tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        WHEN 3 THEN COALESCE(p.tier3_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier1_price, 0)
      END, p.current_cost
      INTO v_tier_price, v_current_cost
      FROM products p WHERE p.id = v_item.product_id;

      IF v_has_draws AND v_drawn > 0 THEN
        -- Drawn product: carry the explicit undrawn remainder + prorated acres.
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit, total_units_needed
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_new_acres,
          v_item.calc_mode, v_item.price_unit, v_new_tun
        );
      ELSE
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_item.acres,
          v_item.calc_mode, v_item.price_unit
        );
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'created',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number,
    'season', p_new_season,
    'remainder_rollover', v_has_draws
  );
END;
$function$;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'rollover_quote_to_season' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'rollover_quote_to_season overload count = %, expected 1', v_count;
  END IF;

  -- Draw-awareness must be present in the deployed body
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'rollover_quote_to_season' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%quote_product_draws%' OR v_src NOT LIKE '%BOOKING_FULLY_DRAWN%' THEN
    RAISE EXCEPTION 'rollover_quote_to_season is missing the draw-awareness blocks';
  END IF;
  -- Remainder mode MUST be gated to open bookings (legacy-renewal regression
  -- guard): the exact predicate must appear in the deployed body.
  IF v_src NOT LIKE '%v_old_quote.status IN (''sent'', ''revised'')%' THEN
    RAISE EXCEPTION 'rollover_quote_to_season remainder mode is not gated to open (sent/revised) bookings';
  END IF;
  IF v_src NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'rollover_quote_to_season is missing the source-quote row lock';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'rollover_quote_to_season' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'rollover_quote_to_season must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL preserved: authenticated keeps EXECUTE (strict-actor gate is in-body),
  -- anon must not have it, service_role must.
  IF NOT has_function_privilege('authenticated', 'public.rollover_quote_to_season(uuid,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollover_quote_to_season: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.rollover_quote_to_season(uuid,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollover_quote_to_season: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.rollover_quote_to_season(uuid,integer,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollover_quote_to_season: service_role lost EXECUTE';
  END IF;
END $$;
