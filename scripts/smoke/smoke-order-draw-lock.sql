-- ============================================================================
-- ROLLED-BACK smoke test for 20260611120000_update_order_items_draw_order_lock
-- ----------------------------------------------------------------------------
-- Verifies the draw-order lock guard in update_order_items (Codex round-2
-- HIGH): a draw-created order (booking_draw = true) cannot have its items
-- edited — the order is a materialized slice of quote_product_draws and any
-- edit would desync order vs booking ledger (draw 200, edit to 300, ledger
-- still says 200 -> the same 100 could be drawn again).
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres after the migration under test is
-- applied. Once the pending 20260819232000 cutover is also present, the draw
-- wrapper is authenticated-only and service_role cannot execute it. The block
-- ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, order, ledger row and audit row created here is rolled
-- back — nothing persists. Any other exception text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims — injected below via set_config(..., is_local => true)
-- using a real active admin profile id. Direct fixture INSERTs bypass RLS
-- because we run as the table owner; the RPCs under test still enforce their
-- own auth/role gates.
--
-- Scenarios:
--   (a) booking 500, draw 200 -> edit the draw order's item 200 -> 300:
--       must raise BOOKING_DRAW_ORDER_LOCKED; order + ledger unchanged
--   (b) same draw order, payload adds a NEW item: must raise
--       BOOKING_DRAW_ORDER_LOCKED before any mutation
--   (c) ledger integrity after the blocks: drawing the remaining 300 still
--       succeeds and closes the booking (accepted, drawn = 500, 2 orders)
--   (d) control: a WHOLE-CONVERSION order (booking_draw = false, via
--       convert_quote_to_order) edits freely — reduce 300 -> 250 succeeds
--       (pre-existing behavior for non-draw orders, unchanged)
--   (e) active-actor guard (rls-review L2): a separate INACTIVE admin session
--       (profiles.is_active = false in the rollback-only fixture) is rejected with
--       INSUFFICIENT_ROLE — the verbatim role gate alone would have passed it
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
  -- Signature-newest-first. The below-cost approval work (20260812115237)
  -- widened this wrapper to (uuid,uuid,text,bigint,text) with
  -- p_below_cost_reason last, and every argument after the first carries a
  -- DEFAULT. That matters: the three-argument fallback at the bottom still
  -- RESOLVES against the widened function, silently defaulting
  -- p_expected_row_version to NULL, which the row-version guard rejects as
  -- QUOTE_STALE_WRITE long before the logic this chain exists to prove.
  -- Probing the widest signature first keeps the row version actually sent.
  IF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint,text)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.convert_quote_to_order($1, $2, $3, $4, NULL::text)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  IF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint)') IS NOT NULL THEN
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

DO $smoke$
DECLARE
  v_admin uuid;
  v_inactive_admin uuid := gen_random_uuid();
  v_customer uuid;
  v_product uuid;
  v_product_2 uuid;
  v_cost numeric;
  v_q uuid;
  v_q2 uuid;
  v_sec uuid;
  v_res jsonb;
  v_err text;
  v_order_a uuid;
  v_item_a uuid;
  v_o2 uuid;
  v_item_2 uuid;
  v_qty numeric;
  v_drawn numeric;
  v_status text;
  v_orders int;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    v_inactive_admin,
    'draw-lock-inactive-' || v_suffix || '@example.invalid',
    '{"full_name":"[SMOKE] Inactive Draw Admin","role":"admin"}'::jsonb,
    now(),
    now()
  );
  -- handle_new_user may create an active profile; replace it with the inactive
  -- fixture without exercising the unrelated auth-ban UPDATE trigger.
  DELETE FROM profiles WHERE id = v_inactive_admin;
  INSERT INTO profiles (id, email, full_name, role, is_active)
  VALUES (
    v_inactive_admin,
    'draw-lock-inactive-' || v_suffix || '@example.invalid',
    '[SMOKE] Inactive Draw Admin',
    'admin',
    false
  );

  -- --------------------------------------------------------------------
  -- 1. Fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Draw Lock Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  SELECT id, current_cost INTO v_product, v_cost
  FROM products
  WHERE is_active IS TRUE
    AND current_cost IS NOT NULL
    AND current_cost > 0
    AND current_cost = round(current_cost, 2)
    AND current_cost <= 10
  ORDER BY current_cost, id
  LIMIT 1;
  IF v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active product with a positive whole-cent current_cost of 10.00 or less';
  END IF;

  -- --------------------------------------------------------------------
  -- 2. Open booking: 500 booked, draw 200 -> one draw order exists
  -- --------------------------------------------------------------------
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('[SMOKE] ODL-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_q;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_q, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q, v_sec, v_product, 10, v_cost, 500, 'gal');

  v_res := draw_down_quote(v_q,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 200)),
    v_admin, 'smk-odl-first-' || v_suffix);
  IF (v_res->>'fully_drawn')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw 200/500 reported fully_drawn: %', v_res;
  END IF;

  SELECT id INTO v_order_a FROM orders
  WHERE quote_id = v_q AND booking_draw = true;
  IF v_order_a IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no booking_draw order created by the draw';
  END IF;
  SELECT id, total_units_needed INTO v_item_a, v_qty
  FROM order_items WHERE order_id = v_order_a;
  IF v_qty IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw order item qty = %, expected 200', v_qty;
  END IF;

  -- --------------------------------------------------------------------
  -- (a) Edit the draw order's qty 200 -> 300: must be BLOCKED
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM update_order_items(v_order_a,
      jsonb_build_array(jsonb_build_object(
        'id', v_item_a, 'product_id', v_product,
        'price_per_unit', 10, 'total_units_needed', 300)),
      v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (a) editing a draw order was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BOOKING_DRAW_ORDER_LOCKED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (a) expected BOOKING_DRAW_ORDER_LOCKED, got: %', v_err;
    END IF;
  END;
  -- Sub-txn rollback must leave order + ledger untouched
  SELECT total_units_needed INTO v_qty FROM order_items WHERE id = v_item_a;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_q AND product_id = v_product;
  IF v_qty IS DISTINCT FROM 200 OR v_drawn IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) state corrupted after block: qty=%, drawn=%', v_qty, v_drawn;
  END IF;

  -- --------------------------------------------------------------------
  -- (b) Add a NEW item to the draw order: must be BLOCKED the same way
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM update_order_items(v_order_a,
      jsonb_build_array(
        jsonb_build_object('id', v_item_a, 'product_id', v_product,
          'price_per_unit', 10, 'total_units_needed', 200),
        jsonb_build_object('product_id', v_product, 'product_name', 'smoke add',
          'price_per_unit', 10, 'total_units_needed', 50)),
      v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (b) adding an item to a draw order was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BOOKING_DRAW_ORDER_LOCKED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (b) expected BOOKING_DRAW_ORDER_LOCKED, got: %', v_err;
    END IF;
  END;
  SELECT count(*) INTO v_orders FROM order_items WHERE order_id = v_order_a;
  IF v_orders <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) draw order item count = %, expected 1', v_orders;
  END IF;

  -- --------------------------------------------------------------------
  -- (c) Ledger intact: draw the remaining 300 -> booking closes correctly
  -- --------------------------------------------------------------------
  v_res := draw_down_quote(v_q,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 300)),
    v_admin, 'smk-odl-final-' || v_suffix);
  IF (v_res->>'fully_drawn')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) final draw not reported fully drawn: %', v_res;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_q AND product_id = v_product;
  SELECT count(*) INTO v_orders FROM orders WHERE quote_id = v_q;
  IF v_status <> 'accepted' OR v_drawn <> 500 OR v_orders <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) expected accepted/500/2 orders, got %/%/%',
      v_status, v_drawn, v_orders;
  END IF;

  -- --------------------------------------------------------------------
  -- (d) Control: WHOLE-CONVERSION order (booking_draw = false) edits freely
  -- --------------------------------------------------------------------
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('[SMOKE] ODL-CTRL-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_q2;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_q2, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q2, v_sec, v_product, 10, v_cost, 300, 'gal');

  SELECT pg_temp.convert_quote_to_order_smoke(
    v_q2,
    v_admin,
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q2)
  ) INTO v_res;
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) convert returned %, expected created', v_res;
  END IF;
  v_o2 := (v_res->>'order_id')::uuid;
  -- convert_quote_to_order leaves app.admin_override = 'true' (known quirk)
  PERFORM set_config('app.admin_override', 'false', true);

  IF EXISTS (SELECT 1 FROM orders WHERE id = v_o2 AND booking_draw) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) whole-conversion order is wrongly booking_draw';
  END IF;

  SELECT id INTO v_item_2 FROM order_items WHERE order_id = v_o2;
  PERFORM update_order_items(v_o2,
    jsonb_build_array(jsonb_build_object(
      'id', v_item_2, 'product_id', v_product,
      'price_per_unit', 10, 'total_units_needed', 250)),
    v_admin, NULL);
  SELECT total_units_needed INTO v_qty FROM order_items WHERE id = v_item_2;
  IF v_qty IS DISTINCT FROM 250 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) control edit blocked or wrong, qty=%', v_qty;
  END IF;

  -- (e) An item id from a different order must be rejected before the large
  -- implementation can mutate either order.
  BEGIN
    PERFORM update_order_items(v_o2,
      jsonb_build_array(jsonb_build_object(
        'id', v_item_a, 'product_id', v_product,
        'price_per_unit', 10, 'total_units_needed', 250)),
      v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (e) cross-order item id was allowed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_ITEM_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (e) expected ORDER_ITEM_MISMATCH, got: %', v_err;
    END IF;
  END;
  SELECT total_units_needed INTO v_qty FROM order_items WHERE id = v_item_2;
  IF v_qty IS DISTINCT FROM 250 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) control order changed despite rejection, qty=%', v_qty;
  END IF;

  -- (f) Adding a product with no inventory snapshot creates that row before
  -- prebooking, so the ledger and physical snapshot cannot diverge.
  -- This scenario needs a product with NO Main Warehouse inventory row. Making
  -- that a hard prerequisite tied the chain to data it does not control: once
  -- every cheap active product has a warehouse row, a perfectly healthy live
  -- database fails at SMOKE_SETUP. Deleting a live row to manufacture the
  -- precondition is worse — an all-zero inventory row still carries a real
  -- reorder point and minimum stock level. prove-draw-down-price-tier-real-schema.mjs
  -- seeds two inventory-free products, so (f) is proven on every container run;
  -- a live run exercises it when the catalog allows and says so loudly when it
  -- cannot. Never downgrade this to a silent skip.
  SELECT p.id INTO v_product_2
  FROM products p
  WHERE p.is_active IS TRUE
    AND p.current_cost IS NOT NULL
    AND p.current_cost > 0
    AND p.current_cost = round(p.current_cost, 2)
    AND p.current_cost <= 7
    AND p.id IS DISTINCT FROM v_product
    AND NOT EXISTS (
      SELECT 1 FROM inventory i
      WHERE i.product_id = p.id AND i.location = 'Main Warehouse'
    )
  ORDER BY p.current_cost, p.id
  LIMIT 1;
  IF v_product_2 IS NULL THEN
    RAISE NOTICE 'SMOKE_SCENARIO_SKIPPED: (f) no active product costing 7.00 or less lacks a Main Warehouse inventory row; the new-product snapshot path is covered by prove-draw-down-price-tier-real-schema.mjs, which seeds one';
  ELSE
    PERFORM update_order_items(v_o2,
      jsonb_build_array(
        jsonb_build_object(
          'id', v_item_2, 'product_id', v_product,
          'price_per_unit', 10, 'total_units_needed', 250),
        jsonb_build_object(
          'product_id', v_product_2, 'product_name', '[SMOKE] added item',
          'price_per_unit', 7, 'total_units_needed', 7, 'unit_size', 'gal')
      ), v_admin, NULL);
    SELECT quantity_prebooked INTO v_qty FROM inventory
    WHERE product_id = v_product_2 AND location = 'Main Warehouse';
    IF v_qty IS DISTINCT FROM 7 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (f) new product snapshot/prebook qty=%, expected 7', v_qty;
    END IF;
  END IF;

  -- --------------------------------------------------------------------
  -- (g) Inactive admin: must be rejected by the active-actor guard.
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_inactive_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_inactive_admin::text, true);
  BEGIN
    PERFORM update_order_items(v_o2,
      jsonb_build_array(jsonb_build_object(
        'id', v_item_2, 'product_id', v_product,
        'price_per_unit', 10, 'total_units_needed', 240)),
      v_inactive_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (g) deactivated admin was ALLOWED to edit';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INSUFFICIENT_ROLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (g) expected INSUFFICIENT_ROLE, got: %', v_err;
    END IF;
  END;
  SELECT total_units_needed INTO v_qty FROM order_items WHERE id = v_item_2;
  IF v_qty IS DISTINCT FROM 250 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (g) state changed despite rejection, qty=%', v_qty;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
