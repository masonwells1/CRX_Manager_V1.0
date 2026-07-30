-- ============================================================================
-- ROLLED-BACK smoke test for 20260611132115_planned_holds_drawn_sync
-- ----------------------------------------------------------------------------
-- Verifies authoritative server-side planned-hold synchronization (Codex r2
-- handoff §3): active holds for an OPEN planned quote always equal
-- GREATEST(booked − drawn, 0) per product after EVERY quote-saving workflow —
-- create_planned_holds, save_quote (Draft save / Revise / Mark Presented all
-- flow through it), and restore_quote_version — with each product's drawn
-- total consuming the EARLIEST items first so per-item expires_at
-- (needed_by + 14 days) follows the still-reserved tail.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, hold, order and ledger row created here is rolled back —
-- nothing persists. Any other exception text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims — injected below via set_config(..., is_local => true)
-- using a real active admin profile id. Direct fixture DML bypasses RLS
-- because we run as the table owner; the RPCs under test still enforce their
-- own auth/role gates.
--
-- Scenarios:
--   (a) planned quote (PA 300 early + PA 200 late + PB 100), create_planned_
--       holds -> 3 holds, PA 500 / PB 100, early item expires needed_by+14d
--   (b) draw 250 of PA -> existing FIFO hold decrement leaves PA 250
--   (c) create_planned_holds AGAIN (the reported bug: previously re-reserved
--       the full 500) -> PA 250 (50 @ early expiry + 200 @ late expiry),
--       PB 100 — booked − drawn with FIFO expiry
--   (d) save_quote rebooks PA to 400 (Revise/Present path; previously synced
--       nothing) -> PA holds 150 (= 400 − 250), PB 100
--   (e) snapshot at the 400 state, rebook to 450 via save (holds 200), then
--       restore_quote_version back -> holds rebuilt to 150
--   (f) is_planned switched off + save -> 0 active holds (server-side
--       release; the frontend's direct release becomes redundant)
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid; v_cust uuid; v_pa uuid; v_pb uuid; v_q uuid;
  v_s1 uuid; v_s2 uuid; v_res jsonb; v_ver uuid; v_quote_version bigint;
  v_pa_total numeric; v_pb_total numeric; v_cnt int;
  v_e1 date; v_e2 date;
  v_payload jsonb; v_sections jsonb;
  sfx text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] PHS Farm ' || sfx) RETURNING id INTO v_cust;
  -- Hold quantities do not need a pricing mutation; use pricing-free shells
  -- so this focused hold proof respects the governed product-pricing path.
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] PHS A ' || sfx, 'gal') RETURNING id INTO v_pa;
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] PHS B ' || sfx, 'gal') RETURNING id INTO v_pb;

  INSERT INTO quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE] PHS-' || sfx, v_cust, v_admin, 'sent', true, '{"splits": []}'::jsonb) RETURNING id INTO v_q;
  INSERT INTO quote_sections (quote_id, section_name, sort_order, needed_by_date) VALUES (v_q, 'Early', 0, DATE '2026-07-01') RETURNING id INTO v_s1;
  INSERT INTO quote_sections (quote_id, section_name, sort_order, needed_by_date) VALUES (v_q, 'Late', 1, DATE '2026-08-01') RETURNING id INTO v_s2;
  INSERT INTO quote_items (quote_id, section_id, product_id, price_per_unit, current_cost, total_units_needed, unit_size, sort_order, calc_mode)
  VALUES (v_q, v_s1, v_pa, 10, 6, 300, 'gal', 0, 'units_direct'),
         (v_q, v_s2, v_pa, 10, 6, 200, 'gal', 0, 'units_direct'),
         (v_q, v_s1, v_pb, 8, 4, 100, 'gal', 1, 'units_direct');

  -- (a) create_planned_holds: full reservation, per-item expiry
  v_res := create_planned_holds(v_q, v_admin, NULL);
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0),
         COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pb), 0), count(*)
  INTO v_pa_total, v_pb_total, v_cnt
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 500 OR v_pb_total <> 100 OR v_cnt <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) holds pa=% pb=% cnt=%', v_pa_total, v_pb_total, v_cnt;
  END IF;
  SELECT expires_at::date INTO v_e1 FROM inventory_holds WHERE source_id = v_q AND product_id = v_pa AND quantity = 300;
  IF v_e1 IS DISTINCT FROM DATE '2026-07-15' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) early-item expiry = %, expected 2026-07-15', v_e1;
  END IF;

  -- (b) draw 250: existing FIFO decrement keeps invariant between saves
  v_res := draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 250)), v_admin, NULL);
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0) INTO v_pa_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 250 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) after draw 250, pa holds = %, expected 250', v_pa_total;
  END IF;

  -- (c) create_planned_holds AGAIN: the reported bug would re-reserve 500
  v_res := create_planned_holds(v_q, v_admin, NULL);
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0),
         COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pb), 0), count(*)
  INTO v_pa_total, v_pb_total, v_cnt
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 250 OR v_pb_total <> 100 OR v_cnt <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) rebuild pa=% pb=% cnt=% (expected 250/100/3)', v_pa_total, v_pb_total, v_cnt;
  END IF;
  SELECT expires_at::date INTO v_e1 FROM inventory_holds WHERE source_id = v_q AND product_id = v_pa AND quantity = 50;
  SELECT expires_at::date INTO v_e2 FROM inventory_holds WHERE source_id = v_q AND product_id = v_pa AND quantity = 200;
  IF v_e1 IS DISTINCT FROM DATE '2026-07-15' OR v_e2 IS DISTINCT FROM DATE '2026-08-15' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) FIFO expiry wrong: 50@%, 200@%', v_e1, v_e2;
  END IF;

  -- (d) save_quote (Revise/Present path): rebooks PA to 400 -> holds 150
  v_payload := jsonb_build_object('quote_number', '[SMOKE] PHS-' || sfx, 'customer_id', v_cust, 'status', 'sent', 'tier', 1);
  v_sections := jsonb_build_array(
    jsonb_build_object('section_name', 'Early', 'sort_order', 0, 'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'calc_mode', 'units_direct', 'total_units_needed', 200, 'price_per_unit', 10, 'current_cost', 6, 'sort_order', 0),
      jsonb_build_object('product_id', v_pb, 'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_per_unit', 8, 'current_cost', 4, 'sort_order', 1))),
    jsonb_build_object('section_name', 'Late', 'sort_order', 1, 'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'calc_mode', 'units_direct', 'total_units_needed', 200, 'price_per_unit', 10, 'current_cost', 6, 'sort_order', 0))));
  SELECT row_version INTO v_quote_version FROM quotes WHERE id = v_q;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_quote_version);
  v_res := save_quote(v_q, v_payload, v_sections, v_admin, NULL);
  IF v_res->>'status' IS DISTINCT FROM 'saved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) save_quote returned %', v_res;
  END IF;
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0),
         COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pb), 0)
  INTO v_pa_total, v_pb_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 150 OR v_pb_total <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) after save holds pa=% pb=% (expected 150/100)', v_pa_total, v_pb_total;
  END IF;

  -- (e) restore_quote_version: holds rebuilt to restored booked − drawn
  PERFORM create_quote_version(v_q, v_admin, 'presented', NULL);
  SELECT id INTO v_ver FROM quote_versions WHERE quote_id = v_q ORDER BY version_number DESC LIMIT 1;
  v_sections := jsonb_set(v_sections, '{1,items,0,total_units_needed}', to_jsonb(250));
  SELECT row_version INTO v_quote_version FROM quotes WHERE id = v_q;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_quote_version);
  v_res := save_quote(v_q, v_payload, v_sections, v_admin, NULL);
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0) INTO v_pa_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e-pre) after rebook 450 holds pa=% (expected 200)', v_pa_total;
  END IF;
  v_res := restore_quote_version(v_q, v_ver, v_admin, NULL);
  IF v_res->>'status' IS DISTINCT FROM 'restored' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) restore returned %', v_res;
  END IF;
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0) INTO v_pa_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 150 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) after restore holds pa=% (expected 150)', v_pa_total;
  END IF;

  -- (f) plan switched off: save_quote releases everything transactionally.
  UPDATE quotes SET is_planned = false WHERE id = v_q;
  SELECT row_version INTO v_quote_version FROM quotes WHERE id = v_q;
  v_payload := v_payload || jsonb_build_object('status', 'revised', 'row_version_expected', v_quote_version);
  v_res := save_quote(v_q, v_payload, v_sections, v_admin, NULL);
  SELECT count(*) INTO v_cnt FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (f) unplanned quote still has % active holds', v_cnt;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
