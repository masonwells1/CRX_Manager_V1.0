-- Rolled-back functional chain for complete/reverse cycle-count wrappers.
DO $smoke$
DECLARE
  v_admin uuid;
  v_product uuid;
  v_inventory uuid;
  v_count uuid;
  v_item_revision bigint;
  v_qty numeric;
  v_status text;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  INSERT INTO products (product_name)
  VALUES ('[SMOKE] Cycle Guard ' || v_suffix) RETURNING id INTO v_product;
  INSERT INTO inventory (product_id, location, quantity_available)
  VALUES (v_product, 'Main Warehouse', 100) RETURNING id INTO v_inventory;
  INSERT INTO cycle_counts (count_number, warehouse, initiated_by)
  VALUES ('SMK-CC-' || v_suffix, 'Main Warehouse', v_admin) RETURNING id INTO v_count;
  INSERT INTO cycle_count_items (
    cycle_count_id, product_id, inventory_id, expected_qty, counted_qty,
    variance, variance_pct, is_counted, counted_by, counted_at
  ) VALUES (v_count, v_product, v_inventory, 100, 112, 12, 12, true, v_admin, now());

  SELECT item_revision INTO v_item_revision
  FROM cycle_counts
  WHERE id = v_count;

  PERFORM complete_cycle_count(
    v_count,
    v_admin,
    'smk-cc-complete-' || v_suffix,
    v_item_revision
  );
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory;
  SELECT status INTO v_status FROM cycle_counts WHERE id = v_count;
  IF v_qty <> 112 OR v_status <> 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: complete produced qty/status %/%', v_qty, v_status;
  END IF;
  PERFORM complete_cycle_count(
    v_count,
    v_admin,
    'smk-cc-complete-' || v_suffix,
    v_item_revision
  );
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory;
  IF v_qty <> 112 THEN RAISE EXCEPTION 'SMOKE_FAIL: complete replay changed qty to %', v_qty; END IF;

  PERFORM reverse_completed_cycle_count(v_count, v_admin, 'smk-cc-reverse-' || v_suffix);
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory;
  SELECT status INTO v_status FROM cycle_counts WHERE id = v_count;
  IF v_qty <> 100 OR v_status <> 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reverse produced qty/status %/%', v_qty, v_status;
  END IF;
  PERFORM reverse_completed_cycle_count(v_count, v_admin, 'smk-cc-reverse-' || v_suffix);
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory;
  IF v_qty <> 100 THEN RAISE EXCEPTION 'SMOKE_FAIL: reverse replay changed qty to %', v_qty; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.complete_cycle_count(uuid,uuid,text,bigint)'::regprocedure
      AND prosrc LIKE '%FOR UPDATE OF i%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.reverse_completed_cycle_count(uuid,uuid,text)'::regprocedure
      AND prosrc LIKE '%FOR UPDATE OF i%'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory row-lock guards missing';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
