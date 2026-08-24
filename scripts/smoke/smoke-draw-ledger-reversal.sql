-- ============================================================================
-- Rolled-back smoke test for 20260610190000_draw_ledger_reversal_on_void_cancel
-- ----------------------------------------------------------------------------
-- RUN: after applying the migration, execute this whole file as ONE statement
-- (e.g. a single Supabase MCP execute_sql call — the DO block is one
-- transaction).
-- PASS: the run errors with 'SMOKE_PASS_ROLLBACK' (every fixture and write is
--       rolled back). ANY other error = FAIL.
--
-- Auth: impersonates an active admin via set_config('request.jwt.claims', ...)
-- so auth.uid() / is_admin() resolve normally inside the SECURITY DEFINER RPCs.
--
-- Guard adaptations (from the LIVE bodies, read 2026-06-10):
-- * void_order requires order status = 'fulfilled' (INVALID_ORDER_STATUS
--   otherwise) — fixtures flip the draw order confirmed→fulfilled first,
--   which the live order-status enforcer allows directly (confirmed →
--   {partially_fulfilled, fulfilled, cancelled}). No delivery rows are needed
--   by either RPC, so no scenario had to be dropped as impossible.
-- * cancel_order refuses 'fulfilled' and no-ops on 'cancelled' — it is tested
--   against a 'confirmed' draw order.
-- * cancel_order runs `SET LOCAL app.admin_override = 'true'` and never
--   resets it; the smoke explicitly resets the GUC after each cancel/convert
--   call so later trigger-behavior assertions stay honest.
--
-- Scenarios:
--   S1  partial draw 200/500 → void the draw order → ledger back to 0,
--       quote stays 'sent' → draw 200 again succeeds (balance restored)
--   S4  cancel a partial draw order → ledger back to 0, the booking's REAL
--       planned hold (built by create_planned_holds, decremented hold→prebooked
--       by the draws) is REBUILT to booked−drawn (Net Free restored — Codex
--       2026-06-13 finding 1 fix, migration 20260613150100), already-cancelled
--       re-cancel does not double-decrement
--   S2  draw 200 + final 300 → quote 'accepted' → void the FINAL draw order
--       → ledger decremented to 200, quote reopened to 'sent',
--       'booking_reopened' activity row written → re-draw 300 works and the
--       quote re-accepts → double-void raises INVALID_ORDER_STATUS
--   S3  whole-conversion order voided → ledger NOT decremented, quote stays
--       'accepted' (booking stays closed — historical semantic)
-- ============================================================================

CREATE OR REPLACE FUNCTION pg_temp.convert_quote_to_order_smoke(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_result jsonb;
BEGIN
  IF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint,text)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.convert_quote_to_order($1, $2, $3, $4, NULL)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  ELSIF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.convert_quote_to_order($1, $2, $3, $4)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  RETURN public.convert_quote_to_order(
    p_quote_id,
    p_performed_by,
    p_idempotency_key
  );
END;
$helper$;

DO $$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_product uuid;
  v_q1 uuid;
  v_q2 uuid;
  v_sec uuid;
  v_res jsonb;
  v_o1 uuid;
  v_o2 uuid;
  v_o3a uuid;
  v_o3b uuid;
  v_oc uuid;
  v_hold_qty_before numeric;
  v_hold_qty_after numeric;
  v_drawn numeric;
  v_status text;
  v_n int;
BEGIN
  -- ── precondition: migrations applied ─────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'booking_draw'
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: orders.booking_draw missing — apply 20260610190000 first';
  END IF;
  -- S4 now exercises the real planned-hold rebuild on a draw cancel: it needs
  -- the _sync_planned_holds helper (20260613150000) AND the cancel_order fix
  -- (20260613150100) that calls it for booking_draw orders.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = '_sync_planned_holds' AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: _sync_planned_holds missing — apply 20260613150000 first';
  END IF;
  -- The public function is now a required-key wrapper. The proven hold rebuild
  -- remains in the preserved mature implementation reached by that wrapper;
  -- the behavioral S4 assertions below prove the chain is still connected.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE proname = '_cancel_order_impl_20260714'
       AND pronamespace = 'public'::regnamespace
       AND prosrc LIKE '%PERFORM _sync_planned_holds(v_order.quote_id, v_actor)%'
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: cancel_order does not rebuild holds on draw cancel — apply 20260613150100 first';
  END IF;

  -- ── auth: impersonate an active admin ────────────────────────────────────
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- ── fixtures ─────────────────────────────────────────────────────────────
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Draw Ledger Reversal Farm') RETURNING id INTO v_customer;

  INSERT INTO products (product_name)
  VALUES ('[SMOKE] DLR Herbicide') RETURNING id INTO v_product;

  v_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product),
      'pricing_mode', 'margin_driven',
      'new_cost', '6.00',
      'tier1_margin_percent', '20',
      'tier2_margin_percent', '25',
      'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke draw-ledger fixture setup'
    )),
    v_admin, 'smk-dlr-price-preview-' || v_product::text
  );
  PERFORM apply_product_pricing_change_set(
    (v_res->>'change_set_id')::uuid,
    v_res->>'request_fingerprint',
    v_admin,
    'smk-dlr-price-apply-' || v_product::text
  );

  -- Q1: the season booking — 500 units of one product. is_planned = true so the
  -- real planned holds can be built/rebuilt by create_planned_holds /
  -- _sync_planned_holds (S4 asserts the rebuild on draw cancel).
  INSERT INTO quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('SMK-DLR-Q1', v_customer, v_admin, 'sent', true, '{"splits": []}'::jsonb)
  RETURNING id INTO v_q1;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_q1, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q1, v_sec, v_product, 10, 6, 500, 'gal');

  -- REAL planned hold backing the booking (built by the production RPC, not a
  -- synthetic row). 500 units held while drawn = 0. The draws below move the
  -- hold → prebooked (FIFO inside draw_down_quote); S4 proves a draw cancel
  -- rebuilds the hold to booked − drawn.
  PERFORM create_planned_holds(v_q1, v_admin);

  -- ══ S1: partial draw 200/500 → VOID the draw order ═══════════════════════
  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 200)),
    v_admin, 'smk-dlr-s1-first-' || v_q1::text)
  INTO v_res;
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'S1: draw failed: %', v_res;
  END IF;
  IF COALESCE((v_res->>'fully_drawn')::boolean, true) THEN
    RAISE EXCEPTION 'S1: 200/500 draw reported fully_drawn';
  END IF;
  v_o1 := (v_res->>'order_id')::uuid;

  IF NOT EXISTS (SELECT 1 FROM orders WHERE id = v_o1 AND booking_draw) THEN
    RAISE EXCEPTION 'S1: draw order is not marked booking_draw = true';
  END IF;

  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q1 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'S1: ledger after draw = %, expected 200', v_drawn;
  END IF;

  -- void_order requires 'fulfilled' (live guard); confirmed→fulfilled is
  -- enforcer-legal, no override needed.
  UPDATE orders SET status = 'fulfilled', updated_at = now() WHERE id = v_o1;
  SELECT void_order(v_o1, v_admin, 'smoke S1: void partial draw') INTO v_res;
  IF v_res->>'status' IS DISTINCT FROM 'voided' THEN
    RAISE EXCEPTION 'S1: void_order returned %, expected voided', v_res;
  END IF;

  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q1 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'S1: ledger after void = %, expected 0 (clamped decrement)', v_drawn;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q1;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'S1: quote status after void = %, expected sent (was never accepted)', v_status;
  END IF;

  -- balance restored: drawing 200 again must succeed
  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 200)),
    v_admin, 'smk-dlr-s1-redraw-' || v_q1::text)
  INTO v_res;
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'S1: re-draw after void failed: %', v_res;
  END IF;
  v_o2 := (v_res->>'order_id')::uuid;
  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q1 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'S1: ledger after re-draw = %, expected 200', v_drawn;
  END IF;

  -- ══ S4: CANCEL a partial draw order — ledger restored, holds REBUILT ═════
  -- Before the cancel the booking is drawn 200/500 (v_o2 active). The governed
  -- void path has already rebuilt the hold after v_o1, so the active hold is
  -- 300 (500 booked minus the one active 200-unit draw). The later cancel must
  -- rebuild it again after reversing v_o2, returning the hold to all 500 units.
  SELECT COALESCE(SUM(quantity), 0) INTO v_hold_qty_before
  FROM inventory_holds
  WHERE source_id = v_q1 AND product_id = v_product AND is_active = true;
  IF v_hold_qty_before IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'S4: pre-cancel active hold = %, expected 300 (500 booked − 200 active draw after the prior void rebuilt holds)', v_hold_qty_before;
  END IF;

  SELECT cancel_order(v_o2, v_admin, 'smoke-draw-cancel-' || v_o2::text) INTO v_res;
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'S4: cancel_order returned %', v_res;
  END IF;
  -- cancel_order leaves app.admin_override = 'true' (SET LOCAL, never reset);
  -- reset it so later assertions exercise the real triggers.
  PERFORM set_config('app.admin_override', 'false', true);

  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q1 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'S4: ledger after cancel = %, expected 0', v_drawn;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q1;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'S4: quote status after cancel = %, expected sent', v_status;
  END IF;

  -- THE FIX: the open booking's planned hold is REBUILT to booked − drawn.
  -- With the draw reversed (drawn = 0) the hold returns to the full 500 — the
  -- 200 that leaked out of the reservation under the old skip is reserved again
  -- (Net Free restored). The hold row id changed (helper DELETE + re-INSERT),
  -- so the assertion sums the active holds for the quote rather than tracking
  -- one row.
  SELECT COALESCE(SUM(quantity), 0) INTO v_hold_qty_after
  FROM inventory_holds
  WHERE source_id = v_q1 AND product_id = v_product AND is_active = true;
  IF v_hold_qty_after IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'S4: hold after draw cancel = %, expected 500 (rebuilt to booked − drawn; bug left it at the stale %)',
      v_hold_qty_after, v_hold_qty_before;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM inventory_holds
    WHERE source_id = v_q1 AND product_id = v_product AND is_active = true
  ) THEN
    RAISE EXCEPTION 'S4: no active hold after draw cancel — rebuild produced nothing';
  END IF;

  -- A new-key re-cancel returns the governed terminal status but remains a
  -- no-op: no double decrement and no hold change.
  SELECT cancel_order(v_o2, v_admin, 'smoke-draw-recancel-' || v_o2::text) INTO v_res;
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'S4: re-cancel returned %, expected governed cancelled status', v_res;
  END IF;
  PERFORM set_config('app.admin_override', 'false', true);
  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q1 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'S4: ledger changed on already_cancelled re-cancel (= %)', v_drawn;
  END IF;
  SELECT COALESCE(SUM(quantity), 0) INTO v_hold_qty_after
  FROM inventory_holds
  WHERE source_id = v_q1 AND product_id = v_product AND is_active = true;
  IF v_hold_qty_after IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'S4: hold changed on already_cancelled re-cancel (= %, expected 500)', v_hold_qty_after;
  END IF;

  -- ══ S2: full draw (200 + final 300) → VOID the final draw → reopen ═══════
  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 200)),
    v_admin, 'smk-dlr-s2-first-' || v_q1::text)
  INTO v_res;
  v_o3a := (v_res->>'order_id')::uuid;
  IF COALESCE((v_res->>'fully_drawn')::boolean, true) THEN
    RAISE EXCEPTION 'S2: first 200 draw reported fully_drawn';
  END IF;

  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 300)),
    v_admin, 'smk-dlr-s2-final-' || v_q1::text)
  INTO v_res;
  v_o3b := (v_res->>'order_id')::uuid;
  IF COALESCE((v_res->>'fully_drawn')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'S2: final 300 draw did not report fully_drawn';
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q1;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'S2: quote after final draw = %, expected accepted', v_status;
  END IF;

  -- void the FINAL draw order
  UPDATE orders SET status = 'fulfilled', updated_at = now() WHERE id = v_o3b;
  SELECT void_order(v_o3b, v_admin, 'smoke S2: void final draw') INTO v_res;
  IF v_res->>'status' IS DISTINCT FROM 'voided' THEN
    RAISE EXCEPTION 'S2: void_order returned %', v_res;
  END IF;

  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q1 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'S2: ledger after voiding final draw = %, expected 200', v_drawn;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q1;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'S2: quote not reopened — status = %, expected sent', v_status;
  END IF;
  SELECT count(*) INTO v_n FROM activity_feed
  WHERE event_type = 'booking_reopened'
    AND related_entity_type = 'quote' AND related_entity_id = v_q1;
  IF v_n < 1 THEN
    RAISE EXCEPTION 'S2: no booking_reopened activity_feed row for the quote';
  END IF;

  -- re-draw the restored 300 → booking fully drawn again, quote re-accepts
  -- (passes enforce_quote_accepted_fully_drawn because the ledger is full)
  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 300)),
    v_admin, 'smk-dlr-s2-redraw-' || v_q1::text)
  INTO v_res;
  IF COALESCE((v_res->>'fully_drawn')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'S2: re-draw of restored 300 did not close the booking: %', v_res;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q1;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'S2: quote after re-draw = %, expected accepted', v_status;
  END IF;

  -- double-void guard: voiding the already-voided order must raise
  BEGIN
    PERFORM void_order(v_o3b, v_admin, 'smoke S2: double void must fail');
    RAISE EXCEPTION 'S2: double-void did not raise';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INVALID_ORDER_STATUS%' THEN RAISE; END IF;
  END;

  -- ══ S3: WHOLE-CONVERSION order voided → booking stays closed ═════════════
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('SMK-DLR-Q2', v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_q2;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_q2, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q2, v_sec, v_product, 10, 6, 300, 'gal');

  SELECT pg_temp.convert_quote_to_order_smoke(
    v_q2,
    v_admin,
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q2)
  ) INTO v_res;
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'S3: convert returned %, expected created', v_res;
  END IF;
  v_oc := (v_res->>'order_id')::uuid;
  -- convert_quote_to_order also leaves app.admin_override = 'true'
  PERFORM set_config('app.admin_override', 'false', true);

  IF EXISTS (SELECT 1 FROM orders WHERE id = v_oc AND booking_draw) THEN
    RAISE EXCEPTION 'S3: whole-conversion order is wrongly marked booking_draw';
  END IF;
  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q2 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'S3: conversion ledger = %, expected 300 (fully drawn)', v_drawn;
  END IF;

  UPDATE orders SET status = 'fulfilled', updated_at = now() WHERE id = v_oc;
  SELECT void_order(v_oc, v_admin, 'smoke S3: void whole conversion') INTO v_res;
  IF v_res->>'status' IS DISTINCT FROM 'voided' THEN
    RAISE EXCEPTION 'S3: void_order returned %', v_res;
  END IF;

  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q2 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'S3: ledger was decremented for a whole-conversion void (= %, expected 300)', v_drawn;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q2;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'S3: whole-conversion quote reopened (status = %) — booking must stay closed', v_status;
  END IF;

  -- ── all scenarios passed: roll everything back ───────────────────────────
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
