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
--   S4  cancel a partial draw order → ledger back to 0, the booking's
--       still-active hold SURVIVES (F7 skip), already-cancelled re-cancel
--       does not double-decrement
--   S2  draw 200 + final 300 → quote 'accepted' → void the FINAL draw order
--       → ledger decremented to 200, quote reopened to 'sent',
--       'booking_reopened' activity row written → re-draw 300 works and the
--       quote re-accepts → double-void raises INVALID_ORDER_STATUS
--   S3  whole-conversion order voided → ledger NOT decremented, quote stays
--       'accepted' (booking stays closed — historical semantic)
-- ============================================================================

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
  v_hold uuid;
  v_hold_qty_before numeric;
  v_hold_qty_after numeric;
  v_hold_active boolean;
  v_drawn numeric;
  v_status text;
  v_n int;
BEGIN
  -- ── precondition: migration applied ──────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'booking_draw'
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: orders.booking_draw missing — apply 20260610190000 first';
  END IF;

  -- ── auth: impersonate an active admin ────────────────────────────────────
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ── fixtures ─────────────────────────────────────────────────────────────
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Draw Ledger Reversal Farm') RETURNING id INTO v_customer;

  INSERT INTO products (product_name)
  VALUES ('[SMOKE] DLR Herbicide') RETURNING id INTO v_product;

  -- Q1: the season booking — 500 units of one product
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('SMK-DLR-Q1', v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_q1;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_q1, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q1, v_sec, v_product, 10, 6, 500, 'gal');

  -- Synthetic ACTIVE hold backing the booking (proves the F7 skip on cancel)
  INSERT INTO inventory_holds (product_id, customer_id, quantity, source_id, created_by, is_active)
  VALUES (v_product, v_customer, 500, v_q1, v_admin, true)
  RETURNING id INTO v_hold;

  -- ══ S1: partial draw 200/500 → VOID the draw order ═══════════════════════
  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 200)))
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
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 200)))
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

  -- ══ S4: CANCEL a partial draw order — ledger restored, holds survive ═════
  SELECT quantity INTO v_hold_qty_before FROM inventory_holds WHERE id = v_hold;

  SELECT cancel_order(v_o2, v_admin) INTO v_res;
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

  -- F7 skip: the open booking's still-active hold must SURVIVE the cancel
  SELECT quantity, is_active INTO v_hold_qty_after, v_hold_active
  FROM inventory_holds WHERE id = v_hold;
  IF NOT v_hold_active THEN
    RAISE EXCEPTION 'S4: cancelling a draw order deactivated the open booking''s hold (F7 skip failed)';
  END IF;
  IF v_hold_qty_after IS DISTINCT FROM v_hold_qty_before THEN
    RAISE EXCEPTION 'S4: hold quantity changed across cancel (% -> %)', v_hold_qty_before, v_hold_qty_after;
  END IF;

  -- already-cancelled re-cancel: no-op, no double decrement
  SELECT cancel_order(v_o2, v_admin) INTO v_res;
  IF v_res->>'status' IS DISTINCT FROM 'already_cancelled' THEN
    RAISE EXCEPTION 'S4: re-cancel returned %, expected already_cancelled', v_res;
  END IF;
  PERFORM set_config('app.admin_override', 'false', true);
  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q1 AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'S4: ledger changed on already_cancelled re-cancel (= %)', v_drawn;
  END IF;

  -- ══ S2: full draw (200 + final 300) → VOID the final draw → reopen ═══════
  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 200)))
  INTO v_res;
  v_o3a := (v_res->>'order_id')::uuid;
  IF COALESCE((v_res->>'fully_drawn')::boolean, true) THEN
    RAISE EXCEPTION 'S2: first 200 draw reported fully_drawn';
  END IF;

  SELECT draw_down_quote(v_q1,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 300)))
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
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 300)))
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

  SELECT convert_quote_to_order(v_q2) INTO v_res;
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
