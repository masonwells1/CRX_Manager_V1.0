-- ============================================================================
-- smoke-create-direct-order-po.sql
-- Chain for migration 20260614142939_create_direct_order_customer_po_param.
--
-- THE FIX UNDER TEST: create_direct_order gained p_customer_po_number and now
-- sets orders.customer_po_number inside the SECURITY DEFINER RPC. Before, the
-- frontend set the PO via a post-create supabase.from('orders').update(), which
-- the admin-only orders_update RLS (USING/CHECK = is_admin()) DENIED for a
-- sales_rep -> the UI falsely reported failure and dropped the PO. So the
-- positive probe runs as a REAL active sales_rep and asserts the PO persists.
--
-- Covers: create_direct_order (full create chain: order + order_items +
-- inventory prebook + activity_feed; commissions no-op on NULL split) plus the
-- 4-probe auth set (no-auth, anon collapses to no-auth for a SECDEF reading
-- auth.uid(), wrong-role, forged-actor), empty-PO normalization, and an
-- idempotency replay.
--
-- House rules: single DO block = one transaction; synthetic [SMOKE] fixtures;
-- auth simulated via transaction-local request.jwt.claims set at TOP LEVEL
-- (never inside a probe sub-block — local GUCs roll back with subtransactions);
-- expected-failure probes wrapped in BEGIN..EXCEPTION matching the error token;
-- ALWAYS terminates in RAISE 'SMOKE_PASS_ROLLBACK' so nothing ever commits.
-- ============================================================================
DO $$
DECLARE
  v_sfx        text := substr(md5(gen_random_uuid()::text), 1, 8);
  v_admin      uuid;
  v_sales      uuid;
  v_driver     uuid;
  v_cust       uuid;
  v_prod       uuid;
  v_items      jsonb;
  v_result     jsonb;
  v_order_id   uuid;
  v_order_id2  uuid;
  v_po         text;
  v_status     text;
  v_items_cnt  int;
  v_prebooked  numeric;
  v_order_cnt  int;
  v_key        text := 'smoke-cdo-' || v_sfx;
  v_want_po    text;
BEGIN
  -- ---- resolve real auth actors (referenced only as FK targets) ----
  SELECT id INTO v_admin  FROM profiles WHERE role = 'admin'     AND is_active LIMIT 1;
  SELECT id INTO v_sales  FROM profiles WHERE role = 'sales_rep' AND is_active LIMIT 1;
  SELECT id INTO v_driver FROM profiles WHERE role IN ('driver','applicator') AND is_active LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile'; END IF;
  IF v_sales IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active sales_rep profile (needed to prove the fix)'; END IF;

  -- ---- synthetic fixtures ----
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] CDO Cust ' || v_sfx) RETURNING id INTO v_cust;
  INSERT INTO products  (product_name) VALUES ('[SMOKE] CDO Prod ' || v_sfx) RETURNING id INTO v_prod;
  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
    VALUES (v_prod, 'Main Warehouse', 1000, 0, 0, '2.5 gal');

  v_items := jsonb_build_array(jsonb_build_object(
    'product_id', v_prod, 'product_name', '[SMOKE] CDO Prod ' || v_sfx,
    'quantity', 10, 'price_per_unit', 20, 'unit_cost', 10, 'unit_size', '2.5 gal'));
  v_want_po := '[SMOKE] PO-' || v_sfx;

  -- ===== PROBE 1: sales_rep creates a direct order WITH a PO (THE fix) =====
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  SELECT create_direct_order(
    p_customer_id        := v_cust,
    p_order_date         := CURRENT_DATE,
    p_order_name         := '[SMOKE] CDO ' || v_sfx,
    p_notes              := NULL,
    p_items              := v_items,
    p_performed_by       := v_sales,
    p_idempotency_key    := v_key,
    p_customer_po_number := v_want_po
  ) INTO v_result;

  v_order_id := (v_result->>'order_id')::uuid;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: sales_rep create_direct_order returned no order_id (%)', v_result;
  END IF;

  SELECT customer_po_number, status INTO v_po, v_status FROM orders WHERE id = v_order_id;
  IF v_po IS DISTINCT FROM v_want_po THEN
    RAISE EXCEPTION 'SMOKE_FAIL: PO not persisted by the SECDEF RPC for sales_rep (got %, want %)', v_po, v_want_po;
  END IF;
  IF v_status <> 'confirmed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order status is % (expected confirmed)', v_status;
  END IF;
  SELECT count(*) INTO v_items_cnt FROM order_items WHERE order_id = v_order_id;
  IF v_items_cnt <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 order_item, got %', v_items_cnt;
  END IF;
  SELECT quantity_prebooked INTO v_prebooked FROM inventory WHERE product_id = v_prod AND location = 'Main Warehouse';
  IF v_prebooked <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory prebooked is % (expected 10)', v_prebooked;
  END IF;

  -- ===== PROBE 2: idempotency replay (same key -> same order, no duplicate) =====
  SELECT create_direct_order(
    p_customer_id        := v_cust,
    p_order_date         := CURRENT_DATE,
    p_order_name         := '[SMOKE] CDO ' || v_sfx,
    p_notes              := NULL,
    p_items              := v_items,
    p_performed_by       := v_sales,
    p_idempotency_key    := v_key,
    p_customer_po_number := v_want_po
  ) INTO v_result;
  v_order_id2 := (v_result->>'order_id')::uuid;
  IF v_order_id2 IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotency replay returned a different order_id (% vs %)', v_order_id2, v_order_id;
  END IF;
  SELECT count(*) INTO v_order_cnt FROM orders WHERE customer_id = v_cust;
  IF v_order_cnt <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotency replay created a duplicate order (count=%)', v_order_cnt;
  END IF;

  -- ===== PROBE 3: empty/whitespace PO normalizes to NULL (NULLIF/TRIM) =====
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SELECT create_direct_order(
    p_customer_id        := v_cust,
    p_order_date         := CURRENT_DATE,
    p_items              := v_items,
    p_performed_by       := v_admin,
    p_idempotency_key    := 'smoke-cdo-empty-' || v_sfx,
    p_customer_po_number := '   '
  ) INTO v_result;
  SELECT customer_po_number INTO v_po FROM orders WHERE id = (v_result->>'order_id')::uuid;
  IF v_po IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: whitespace PO not normalized to NULL (got %)', v_po;
  END IF;

  -- ===== AUTH PROBE A: no auth (== anon key) -> Authentication required =====
  PERFORM set_config('request.jwt.claims', '{}', true);
  BEGIN
    PERFORM create_direct_order(p_customer_id := v_cust, p_order_date := CURRENT_DATE,
                                p_items := v_items, p_customer_po_number := 'x');
    RAISE EXCEPTION 'SMOKE_FAIL: no-auth call did not raise';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Authentication required%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no-auth expected Authentication required, got: %', SQLERRM;
    END IF;
  END;

  -- ===== AUTH PROBE B: wrong role (driver/applicator) -> INSUFFICIENT_ROLE =====
  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM create_direct_order(p_customer_id := v_cust, p_order_date := CURRENT_DATE,
                                  p_items := v_items, p_performed_by := v_driver, p_customer_po_number := 'x');
      RAISE EXCEPTION 'SMOKE_FAIL: driver call did not raise';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: driver expected INSUFFICIENT_ROLE, got: %', SQLERRM;
      END IF;
    END;
  END IF;

  -- ===== AUTH PROBE C: forged p_performed_by -> Actor mismatch =====
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM create_direct_order(p_customer_id := v_cust, p_order_date := CURRENT_DATE,
                                p_items := v_items, p_performed_by := v_admin, p_customer_po_number := 'x');
    RAISE EXCEPTION 'SMOKE_FAIL: forged-actor call did not raise';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Actor mismatch%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: forged-actor expected Actor mismatch, got: %', SQLERRM;
    END IF;
  END;

  -- All probes passed — roll everything back.
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
