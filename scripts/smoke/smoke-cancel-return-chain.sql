-- ============================================================================
-- SMOKE TEST (rolled back by design): cancel_return lifecycle guard
-- ----------------------------------------------------------------------------
-- THE CHAIN:
--   create_return -> approve_return -> receive_return -> failed active delete
--   probes -> failed NULL/forged actor cancel probes -> cancel_return ->
--   idempotent replay.
--
-- PASS contract: execute this whole file as ONE statement. It must terminate
-- with error text containing SMOKE_PASS_ROLLBACK. Any other error is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer_id uuid;
  v_product_id uuid;
  v_inventory_id uuid;
  v_order_id uuid;
  v_order_item_id uuid;
  v_return_id uuid;
  v_res jsonb;
  v_res_replay jsonb;
  v_qty numeric;
  v_n int;
  v_status text;
  v_by uuid;
  v_reason text;
  v_ts timestamptz;
BEGIN
  SELECT id INTO v_admin
    FROM profiles
   WHERE role = 'admin'
     AND is_active = true
   ORDER BY created_at
   LIMIT 1;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Cancel Return Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;

  INSERT INTO products (product_name)
  VALUES ('[SMOKE] Cancel Return Product ' || v_suffix)
  RETURNING id INTO v_product_id;

  INSERT INTO inventory (product_id, location, quantity_available)
  VALUES (v_product_id, 'Main Warehouse', 100)
  RETURNING id INTO v_inventory_id;

  INSERT INTO orders (order_number, customer_id, salesman_id)
  VALUES ('SMK-CANCEL-RETURN-' || v_suffix, v_customer_id, v_admin)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, total_units_needed,
    unit_size, total_price, quantity_delivered, quantity_remaining
  ) VALUES (
    v_order_id, v_product_id, '[SMOKE] Cancel Return Product ' || v_suffix,
    10, 7, 'gal', 70, 7, 0
  )
  RETURNING id INTO v_order_item_id;

  v_res := create_return(
    jsonb_build_object(
      'customer_id', v_customer_id,
      'order_id', v_order_id,
      'reason', 'overstock'
    ),
    jsonb_build_array(jsonb_build_object(
      'order_item_id', v_order_item_id,
      'quantity', 7,
      'condition', 'unopened',
      'restock', true
    )),
    'smk-cancel-return-' || v_suffix || '-create'
  );
  v_return_id := (v_res->>'return_id')::uuid;
  IF v_return_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_return returned %', v_res;
  END IF;

  v_res := approve_return(v_return_id, v_admin, 'smk-cancel-return-' || v_suffix || '-approve');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approve_return returned %', v_res;
  END IF;

  v_res := receive_return(v_return_id, v_admin, 'smk-cancel-return-' || v_suffix || '-receive');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'received'
     OR COALESCE((v_res->>'restocked_count')::int, -1) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: receive_return returned %', v_res;
  END IF;

  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory_id;
  IF v_qty IS DISTINCT FROM 107 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory after receive = %, expected 107', v_qty;
  END IF;

  BEGIN
    UPDATE returns SET deleted_at = now() WHERE id = v_return_id;
    RAISE EXCEPTION 'SMOKE_FAIL: active return was soft-deleted directly';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_DELETE_STATUS_LOCKED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected active soft-delete rejection, got %', v_reason;
    END IF;
  END;

  BEGIN
    DELETE FROM returns WHERE id = v_return_id;
    RAISE EXCEPTION 'SMOKE_FAIL: active return was hard-deleted directly';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_DELETE_STATUS_LOCKED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected active hard-delete rejection, got %', v_reason;
    END IF;
  END;

  BEGIN
    PERFORM cancel_return(v_return_id, 'bad null actor', NULL::uuid,
      'smk-cancel-return-' || v_suffix || '-null-actor');
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_return accepted NULL actor';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected NULL actor mismatch, got %', v_reason;
    END IF;
  END;

  BEGIN
    PERFORM cancel_return(v_return_id, 'bad forged actor', gen_random_uuid(),
      'smk-cancel-return-' || v_suffix || '-forged-actor');
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_return accepted forged actor';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected forged actor mismatch, got %', v_reason;
    END IF;
  END;

  SELECT status INTO v_status FROM returns WHERE id = v_return_id;
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory_id;
  IF v_status <> 'received' OR v_qty IS DISTINCT FROM 107 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: failed probes mutated status=% inventory=%', v_status, v_qty;
  END IF;

  v_res := cancel_return(v_return_id, 'customer cancelled return after receipt', v_admin,
    'smk-cancel-return-' || v_suffix || '-cancel');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'cancelled'
     OR COALESCE((v_res->>'was_received')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'reversed_count')::int, -1) <> 1
     OR COALESCE((v_res->>'reversed_quantity')::bigint, -1) <> 7
     OR COALESCE((v_res->>'skipped_count')::int, -1) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_return returned %', v_res;
  END IF;

  SELECT status, cancelled_by, cancellation_reason, cancelled_at
    INTO v_status, v_by, v_reason, v_ts
    FROM returns
   WHERE id = v_return_id;
  IF v_status <> 'cancelled'
     OR v_by IS DISTINCT FROM v_admin
     OR v_reason IS DISTINCT FROM 'customer cancelled return after receipt'
     OR v_ts IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return after cancel status=%, by=%, reason=%, at=%',
      v_status, v_by, v_reason, v_ts;
  END IF;

  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory_id;
  IF v_qty IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory after cancel = %, expected 100', v_qty;
  END IF;

  SELECT count(*) INTO v_n
    FROM return_items
   WHERE return_id = v_return_id
     AND restocked = false;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 return_item reset to restocked=false, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM inventory_transactions
   WHERE product_id = v_product_id
     AND transaction_type = 'returned'
     AND quantity < 0
     AND performed_by IS NOT DISTINCT FROM v_admin
     AND notes LIKE 'Cancel of return%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 actor-stamped reversal transaction, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM activity_feed
   WHERE event_type = 'return_cancelled'
     AND related_entity_type = 'return'
     AND related_entity_id = v_return_id
     AND performed_by IS NOT DISTINCT FROM v_admin;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 actor-stamped return_cancelled activity row, found %', v_n;
  END IF;

  v_res_replay := cancel_return(v_return_id, 'customer cancelled return after receipt', v_admin,
    'smk-cancel-return-' || v_suffix || '-cancel');
  IF v_res_replay IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay changed result from % to %', v_res, v_res_replay;
  END IF;

  SELECT count(*) INTO v_n
    FROM inventory_transactions
   WHERE product_id = v_product_id
     AND transaction_type = 'returned'
     AND quantity < 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay created duplicate reversal transactions: %', v_n;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
