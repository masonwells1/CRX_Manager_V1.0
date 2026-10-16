-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261016140000_bind_stock_replay_receipts_batch2.
--
-- Rule under test: a stored idempotency receipt is replayed only to the person who wrote it, and
-- only for the exact same request. A retry that reuses a key for a different record or payload,
-- or from a different person, is refused (IDEMPOTENCY_INTENT_MISMATCH /
-- IDEMPOTENCY_ACTOR_MISMATCH) and changes nothing; an exact retry still returns the original
-- answer and is never done twice; a call with no key is refused (IDEMPOTENCY_KEY_REQUIRED),
-- for all thirteen; revert_quote_status's own planned-holds rebuild (it calls the private body)
-- still runs.
--
-- Covers the thirteen wrapped stock RPCs: release_inventory_hold, retire_inventory_item,
-- reconcile_negative_inventory, manual_inventory_add, create_order_from_blend_ticket,
-- create_direct_order, create_rush_order, close_quote_as_applied, close_quote_as_short,
-- create_application_record_from_blend_ticket (receipt operation 'create_app_record_from_bt'),
-- batch_cancel_deliveries, reverse_completed_cycle_count, create_planned_holds. Also: the four
-- no-receipt no-op answers come back unbound and unrefused and leave no receipt; the same delivery
-- set in another order is the same batch_cancel_deliveries request; an unbound legacy receipt for
-- each of the thirteen operations is refused, never replayed; the commit-time guard refuses an
-- unbound receipt for each of the thirteen operations (forced with SET CONSTRAINTS ... IMMEDIATE;
-- the container prover checks the real COMMIT). Before the migration, step 1 fails first
-- (release_inventory_hold hands hold A's receipt back as success for hold B).
--
-- HOW TO RUN: CONTAINER ONLY, through scripts/smoke/prove-stock-replay-binding-batch2-real-schema.mjs;
-- never through run-smoke.mjs or execute_sql against the live database, because it draws two
-- customer-visible order numbers that a rollback does not return (below). It ALWAYS ends with
-- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
--
-- Auth: auth.uid() reads request.jwt.claims, set with set_config(..., true) to two REAL active
-- admin profiles found at run time (SMOKE_SETUP if fewer than two exist; several of the thirteen
-- are admin-only, so the second person is an admin too). Fixture INSERTs run as the table owner;
-- the RPCs under test enforce their own role checks.
--
-- Non-transactional side effects (a rollback does not return sequence values):
--   * public.order_number_seq advances by exactly 2: create_direct_order and create_rush_order
--     draw their order number inside the body (generate_order_number) and take no explicit number.
--     Each first call draws one; every refused call is refused before the body and every exact
--     retry replays before the draw, so no other call draws one. On live this leaves a gap of two
--     ORD- numbers; prefer the container prover
--     (scripts/smoke/prove-stock-replay-binding-batch2-real-schema.mjs), which checks that
--     order_number_seq moved by exactly 2 and that no other document-number sequence moved.
--   * Nothing else: customers carry explicit account numbers, orders from blend tickets carry
--     explicit [SMOKE] order numbers, quotes / deliveries / cycle counts / blend tickets / the
--     setup order are inserted with explicit [SMOKE] numbers, and application-record numbers are
--     MAX+1 under a lock (next_application_record_number), not a sequence.
-- Fixture limits: product pricing is governed, so the [SMOKE] products are pricing-free shells, and
-- the blend-ticket orders and the direct order borrow ONE real priced active product WITHOUT
-- changing it (the below-cost wall needs a positive cost on an order line; the container prover
-- seeds one); its prebook and stock writes roll back. The quotes carry no lines, so
-- create_planned_holds rebuilds zero holds (its "work" is visible only as its own answer).
-- Precondition: today is not inside a CLOSED accounting period (SMOKE_SETUP otherwise).
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_admin_b uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_pfx text;
  v_key text;
  v_ops text[] := ARRAY['release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory',
                        'manual_inventory_add', 'create_order_from_blend_ticket', 'create_direct_order',
                        'create_rush_order', 'close_quote_as_applied', 'close_quote_as_short',
                        'create_app_record_from_bt', 'batch_cancel_deliveries',
                        'reverse_completed_cycle_count', 'create_planned_holds'];
  v_op text;
  v_cust_a uuid;
  v_cust_b uuid;
  v_p_hold uuid;
  v_p_r1 uuid;
  v_p_r2 uuid;
  v_p_c1 uuid;
  v_p_c2 uuid;
  v_p_m1 uuid;
  v_p_m2 uuid;
  v_p_priced uuid;
  v_priced_name text;
  v_priced_unit text;
  v_priced_price numeric;
  v_p_shell uuid;
  v_p_cc1 uuid;
  v_p_cc2 uuid;
  v_hold_a uuid;
  v_hold_b uuid;
  v_inv_r1 uuid;
  v_inv_r2 uuid;
  v_inv_c1 uuid;
  v_inv_c2 uuid;
  v_inv_cc1 uuid;
  v_inv_cc2 uuid;
  v_t1 uuid;
  v_t2 uuid;
  v_t3 uuid;
  v_t4 uuid;
  v_q1 uuid;
  v_q2 uuid;
  v_q3 uuid;
  v_q4 uuid;
  v_q5 uuid;
  v_q6 uuid;
  v_q7 uuid;
  v_setup_order uuid;
  v_d1 uuid;
  v_d2 uuid;
  v_d3 uuid;
  v_cc1 uuid;
  v_cc2 uuid;
  v_order_no text;
  v_items jsonb;
  v_rush_items jsonb;
  v_res jsonb;
  v_res2 jsonb;
  v_json json;
  v_json2 json;
  v_ids uuid[];
  v_ids2 uuid[];
  v_n int;
  v_qty numeric;
  v_status text;
  v_sql text;
  v_err text;
BEGIN
  -- --------------------------------------------------------------------------------------------
  -- 0. Preconditions, two real admins, fixtures.
  -- --------------------------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: today falls in a CLOSED accounting period';
  END IF;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_admin_b FROM public.profiles
   WHERE role = 'admin' AND is_active = true AND id IS DISTINCT FROM v_admin ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_admin_b IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active admin profiles are required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_pfx := 'smk-srb-' || v_suffix || '-';

  -- Explicit account numbers: the column default draws customer_account_number_seq.
  INSERT INTO public.customers (farm_name, account_number, is_active, assigned_tier)
  VALUES ('[SMOKE] Stock Replay Farm A ' || v_suffix, '[SMOKE]-SRB-A-' || v_suffix, true, 1)
  RETURNING id INTO v_cust_a;
  INSERT INTO public.customers (farm_name, account_number, is_active, assigned_tier)
  VALUES ('[SMOKE] Stock Replay Farm B ' || v_suffix, '[SMOKE]-SRB-B-' || v_suffix, true, 1)
  RETURNING id INTO v_cust_b;

  -- Pricing-free shell products (catalog pricing is governed and never set here).
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB hold ' || v_suffix, 'gal', true) RETURNING id INTO v_p_hold;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB retire 1 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_r1;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB retire 2 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_r2;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB reconcile 1 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_c1;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB reconcile 2 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_c2;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB add 1 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_m1;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB add 2 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_m2;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB shell ' || v_suffix, 'gal', true) RETURNING id INTO v_p_shell;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB count 1 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_cc1;
  INSERT INTO public.products (product_name, unit_size, is_active) VALUES ('[SMOKE] SRB count 2 ' || v_suffix, 'gal', true) RETURNING id INTO v_p_cc2;

  -- An order line for a catalog product needs a governed positive cost (the below-cost wall), and
  -- product pricing cannot be set here, so borrow one real priced product WITHOUT changing it, for
  -- the blend-ticket orders and the direct order (their prebooks roll back with everything else).
  SELECT p.id, p.product_name, COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size), p.tier1_price
    INTO v_p_priced, v_priced_name, v_priced_unit, v_priced_price
    FROM public.products p
   WHERE p.is_active IS TRUE
     AND p.current_cost > 0 AND p.current_cost = round(p.current_cost, 2)
     AND p.tier1_price >= p.current_cost AND p.tier1_price = round(p.tier1_price, 2)
     AND COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size) IS NOT NULL
   ORDER BY p.current_cost, p.id
   LIMIT 1;
  IF v_p_priced IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active product with a positive whole-cent cost, a whole-cent tier-1 price at or above it, and a unit';
  END IF;

  -- Two manual holds. A non-NULL source_id keeps them outside create_inventory_hold's insert
  -- barrier (that barrier is for that RPC's own receipt-bound standalone holds).
  INSERT INTO public.inventory_holds (product_id, customer_id, quantity, hold_type, source_id, notes, created_by)
  VALUES (v_p_hold, v_cust_a, 5, 'manual', v_cust_a, '[SMOKE] hold A', v_admin) RETURNING id INTO v_hold_a;
  INSERT INTO public.inventory_holds (product_id, customer_id, quantity, hold_type, source_id, notes, created_by)
  VALUES (v_p_hold, v_cust_a, 7, 'manual', v_cust_a, '[SMOKE] hold B', v_admin) RETURNING id INTO v_hold_b;

  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p_r1, 'Main Warehouse', 5, 0, 0) RETURNING id INTO v_inv_r1;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p_r2, 'Main Warehouse', 6, 0, 0) RETURNING id INTO v_inv_r2;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p_c1, 'Main Warehouse', -3, 0, 0) RETURNING id INTO v_inv_c1;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p_c2, 'Main Warehouse', -4, 0, 0) RETURNING id INTO v_inv_c2;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p_cc1, 'Main Warehouse', 100, 0, 0) RETURNING id INTO v_inv_cc1;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_p_cc2, 'Main Warehouse', 100, 0, 0) RETURNING id INTO v_inv_cc2;

  -- Four completed + approved + unbilled blend tickets: 1-2 for orders (one 2-unit line of the
  -- borrowed priced product), 3-4 for application records (one 2-gallon line of a shell product).
  INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, salesman_id, status, review_status,
                                    payment_status, order_link_status, total_acres, season, source, ticket_date)
  VALUES ('[SMOKE]-SRB-T1-' || v_suffix, v_admin, v_cust_a, v_admin, 'completed', 'approved', 'unbilled', 'unlinked', 1, '2026', 'manual', CURRENT_DATE)
  RETURNING id INTO v_t1;
  INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, salesman_id, status, review_status,
                                    payment_status, order_link_status, total_acres, season, source, ticket_date)
  VALUES ('[SMOKE]-SRB-T2-' || v_suffix, v_admin, v_cust_a, v_admin, 'completed', 'approved', 'unbilled', 'unlinked', 1, '2026', 'manual', CURRENT_DATE)
  RETURNING id INTO v_t2;
  INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, salesman_id, status, review_status,
                                    payment_status, order_link_status, total_acres, season, source, ticket_date)
  VALUES ('[SMOKE]-SRB-T3-' || v_suffix, v_admin, v_cust_a, v_admin, 'completed', 'approved', 'unbilled', 'unlinked', 1, '2026', 'manual', CURRENT_DATE)
  RETURNING id INTO v_t3;
  INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, salesman_id, status, review_status,
                                    payment_status, order_link_status, total_acres, season, source, ticket_date)
  VALUES ('[SMOKE]-SRB-T4-' || v_suffix, v_admin, v_cust_a, v_admin, 'completed', 'approved', 'unbilled', 'unlinked', 1, '2026', 'manual', CURRENT_DATE)
  RETURNING id INTO v_t4;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, sequence_order)
  SELECT t, v_p_priced, v_priced_name, 2, v_priced_unit, 0 FROM unnest(ARRAY[v_t1, v_t2]) AS t;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, sequence_order)
  SELECT t, v_p_shell, '[SMOKE] SRB shell ' || v_suffix, 2, 'gal', 0 FROM unnest(ARRAY[v_t3, v_t4]) AS t;

  -- Six open quotes (explicit [SMOKE] numbers, no lines): 1-2 planned for close-as-applied,
  -- 3-4 for close-as-short, 5-6 planned for planned holds.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE]-SRB-Q1-' || v_suffix, v_cust_a, v_admin, 'sent', true, '{"splits": []}'::jsonb) RETURNING id INTO v_q1;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE]-SRB-Q2-' || v_suffix, v_cust_a, v_admin, 'sent', true, '{"splits": []}'::jsonb) RETURNING id INTO v_q2;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE]-SRB-Q3-' || v_suffix, v_cust_a, v_admin, 'sent', false, '{"splits": []}'::jsonb) RETURNING id INTO v_q3;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE]-SRB-Q4-' || v_suffix, v_cust_a, v_admin, 'sent', false, '{"splits": []}'::jsonb) RETURNING id INTO v_q4;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE]-SRB-Q5-' || v_suffix, v_cust_a, v_admin, 'sent', true, '{"splits": []}'::jsonb) RETURNING id INTO v_q5;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE]-SRB-Q6-' || v_suffix, v_cust_a, v_admin, 'sent', true, '{"splits": []}'::jsonb) RETURNING id INTO v_q6;
  -- A declined planned quote: revert_quote_status reopens it and rebuilds its holds keylessly.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE]-SRB-Q7-' || v_suffix, v_cust_a, v_admin, 'declined', true, '{"splits": []}'::jsonb) RETURNING id INTO v_q7;

  -- One confirmed order (explicit number, no lines) carrying three scheduled deliveries.
  INSERT INTO public.orders (order_number, customer_id, status, order_date)
  VALUES ('[SMOKE]-SRB-O-' || v_suffix, v_cust_a, 'confirmed', CURRENT_DATE) RETURNING id INTO v_setup_order;
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('[SMOKE]-SRB-D1-' || v_suffix, v_setup_order, v_cust_a, CURRENT_DATE, 'scheduled', v_admin) RETURNING id INTO v_d1;
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('[SMOKE]-SRB-D2-' || v_suffix, v_setup_order, v_cust_a, CURRENT_DATE, 'scheduled', v_admin) RETURNING id INTO v_d2;
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('[SMOKE]-SRB-D3-' || v_suffix, v_setup_order, v_cust_a, CURRENT_DATE, 'scheduled', v_admin) RETURNING id INTO v_d3;

  -- Two cycle counts (explicit numbers), each counting +12 on its own product, completed through
  -- the real RPC so they are reversible.
  INSERT INTO public.cycle_counts (count_number, warehouse, initiated_by)
  VALUES ('[SMOKE]-SRB-CC1-' || v_suffix, 'Main Warehouse', v_admin) RETURNING id INTO v_cc1;
  INSERT INTO public.cycle_counts (count_number, warehouse, initiated_by)
  VALUES ('[SMOKE]-SRB-CC2-' || v_suffix, 'Main Warehouse', v_admin) RETURNING id INTO v_cc2;
  INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty, counted_qty,
                                        variance, variance_pct, is_counted, counted_by, counted_at)
  VALUES (v_cc1, v_p_cc1, v_inv_cc1, 100, 112, 12, 12, true, v_admin, now()),
         (v_cc2, v_p_cc2, v_inv_cc2, 100, 112, 12, 12, true, v_admin, now());
  PERFORM public.complete_cycle_count(v_cc1, v_admin, 'smk-srb-setup-' || v_suffix || '-cc1',
                                      (SELECT item_revision FROM public.cycle_counts WHERE id = v_cc1));
  PERFORM public.complete_cycle_count(v_cc2, v_admin, 'smk-srb-setup-' || v_suffix || '-cc2',
                                      (SELECT item_revision FROM public.cycle_counts WHERE id = v_cc2));
  IF (SELECT count(*) FROM public.cycle_counts WHERE id IN (v_cc1, v_cc2) AND status = 'completed') <> 2
     OR (SELECT quantity_available FROM public.inventory WHERE id = v_inv_cc2) <> 112 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the two cycle counts did not complete';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 1. release_inventory_hold: a key reused for a DIFFERENT hold is refused; hold B stays active.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'release-hold';
  v_res := public.release_inventory_hold(v_hold_a, v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'released' OR (v_res->>'hold_id')::uuid IS DISTINCT FROM v_hold_a THEN
    RAISE EXCEPTION 'SMOKE_FAIL: release_inventory_hold on hold A did not release it: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.release_inventory_hold(v_hold_b, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: release_inventory_hold handed hold A''s receipt back as success for hold B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong release_inventory_hold refusal: %', SQLERRM;
    END IF;
  END;
  IF NOT (SELECT is_active FROM public.inventory_holds WHERE id = v_hold_b) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: hold B was released by a refused call';
  END IF;
  -- The exact retry replays the stored answer (not the already_released no-op).
  BEGIN
    v_res2 := public.release_inventory_hold(v_hold_a, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact release_inventory_hold retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact release_inventory_hold retry did not replay: % vs %', v_res2, v_res;
  END IF;
  IF (SELECT count(*) FROM public.activity_feed WHERE event_type = 'inventory_hold_released' AND related_entity_id = v_hold_a) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: hold A was released twice';
  END IF;
  -- No-op: an already-released hold under a NEW key answers already_released, unrefused, with no receipt.
  BEGIN
    v_res2 := public.release_inventory_hold(v_hold_a, v_admin, v_pfx || 'noop-release');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already_released no-op was refused: %', SQLERRM;
  END;
  IF v_res2->>'status' IS DISTINCT FROM 'already_released' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an already-released hold did not answer already_released: %', v_res2;
  END IF;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_pfx || 'noop-release') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already_released no-op left a receipt';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 2. retire_inventory_item: a key reused for a DIFFERENT inventory row is refused; row 2 stays.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'retire';
  v_res := public.retire_inventory_item(v_inv_r1, v_admin, v_key);
  IF (v_res->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retire_inventory_item on row 1 did not succeed: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.retire_inventory_item(v_inv_r2, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: retire_inventory_item replayed row 1''s receipt as success for row 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong retire_inventory_item refusal: %', SQLERRM;
    END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.inventory WHERE id = v_inv_r2) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory row 2 was retired by a refused call';
  END IF;
  BEGIN
    v_res2 := public.retire_inventory_item(v_inv_r1, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact retire_inventory_item retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact retire_inventory_item retry did not replay: % vs %', v_res2, v_res;
  END IF;
  IF (SELECT count(*) FROM public.inventory_transactions WHERE product_id = v_p_r1) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: row 1 was retired twice';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 3. reconcile_negative_inventory: a key reused for a DIFFERENT row is refused; row 2 unchanged.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'reconcile';
  v_res := public.reconcile_negative_inventory(v_inv_c1, 0, '[SMOKE] reconcile', v_admin, v_key);
  BEGIN
    v_res2 := public.reconcile_negative_inventory(v_inv_c2, 0, '[SMOKE] reconcile', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: reconcile_negative_inventory replayed row 1''s receipt as success for row 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reconcile_negative_inventory refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT quantity_available FROM public.inventory WHERE id = v_inv_c2) <> -4 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: row 2 was reconciled by a refused call';
  END IF;
  -- A changed quantity on the same row is a different request too.
  BEGIN
    v_res2 := public.reconcile_negative_inventory(v_inv_c1, 9, '[SMOKE] reconcile', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: reconcile_negative_inventory replayed a receipt for a changed quantity: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reconcile_negative_inventory changed-quantity refusal: %', SQLERRM;
    END IF;
  END;
  BEGIN
    v_res2 := public.reconcile_negative_inventory(v_inv_c1, 0, '[SMOKE] reconcile', v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact reconcile_negative_inventory retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.inventory_transactions WHERE product_id = v_p_c1) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact reconcile_negative_inventory retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 4. manual_inventory_add: a key reused for a DIFFERENT product is refused; product 2 gets nothing.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'manual-add';
  v_res := public.manual_inventory_add(v_p_m1, 'Main Warehouse', 10, 'gal', v_admin, '[SMOKE] add', NULL, v_key, NULL, NULL);
  BEGIN
    v_res2 := public.manual_inventory_add(v_p_m2, 'Main Warehouse', 10, 'gal', v_admin, '[SMOKE] add', NULL, v_key, NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: manual_inventory_add replayed product 1''s receipt as success for product 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong manual_inventory_add refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.inventory WHERE product_id = v_p_m2) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: product 2 got an inventory row from a refused call';
  END IF;
  BEGIN
    v_res2 := public.manual_inventory_add(v_p_m1, 'Main Warehouse', 10, 'gal', v_admin, '[SMOKE] add', NULL, v_key, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact manual_inventory_add retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.inventory WHERE product_id = v_p_m1) <> 1
     OR (SELECT count(*) FROM public.inventory_transactions WHERE product_id = v_p_m1) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact manual_inventory_add retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 5. create_order_from_blend_ticket: the same key and order number for a DIFFERENT ticket is
  --    refused; ticket 2 stays unlinked. A missing ticket answers success:false with no receipt.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'order-from-bt';
  v_order_no := '[SMOKE]-SRB-BTO-' || v_suffix;
  v_json := public.create_order_from_blend_ticket(v_t1, v_order_no, CURRENT_DATE, NULL, v_admin, v_key);
  IF (v_json::jsonb->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_order_from_blend_ticket on ticket 1 did not succeed: %', v_json;
  END IF;
  BEGIN
    v_json2 := public.create_order_from_blend_ticket(v_t2, v_order_no, CURRENT_DATE, NULL, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: create_order_from_blend_ticket replayed ticket 1''s order as success for ticket 2: %', v_json2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong create_order_from_blend_ticket refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT order_link_status FROM public.blend_tickets WHERE id = v_t2) IS DISTINCT FROM 'unlinked' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ticket 2 was linked by a refused call';
  END IF;
  BEGIN
    v_json2 := public.create_order_from_blend_ticket(v_t1, v_order_no, CURRENT_DATE, NULL, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_order_from_blend_ticket retry was refused: %', SQLERRM;
  END;
  IF v_json2::jsonb IS DISTINCT FROM v_json::jsonb
     OR (SELECT count(*) FROM public.orders WHERE order_number = v_order_no) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_order_from_blend_ticket retry did not replay: % vs %', v_json2, v_json;
  END IF;
  BEGIN
    v_json2 := public.create_order_from_blend_ticket(gen_random_uuid(), '[SMOKE]-SRB-BTO-MISSING-' || v_suffix,
                                                     CURRENT_DATE, NULL, v_admin, v_pfx || 'noop-order-from-bt');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the success:false no-op was refused: %', SQLERRM;
  END;
  IF (v_json2::jsonb->'success') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a missing blend ticket did not answer success:false: %', v_json2;
  END IF;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_pfx || 'noop-order-from-bt') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the success:false no-op left a receipt';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 6. create_direct_order: the same key for a DIFFERENT customer is refused; customer B gets no order.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'direct-order';
  v_items := jsonb_build_array(jsonb_build_object('product_id', v_p_priced, 'product_name', v_priced_name,
                                                  'quantity', 2, 'price_per_unit', v_priced_price, 'unit_cost', 0,
                                                  'unit_size', v_priced_unit));
  v_res := public.create_direct_order(v_cust_a, CURRENT_DATE, '[SMOKE] SRB direct', NULL, v_items, v_admin, v_key, NULL);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_direct_order for customer A did not create: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.create_direct_order(v_cust_b, CURRENT_DATE, '[SMOKE] SRB direct', NULL, v_items, v_admin, v_key, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: create_direct_order replayed customer A''s order as success for customer B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong create_direct_order refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.orders WHERE customer_id = v_cust_b) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer B got an order from a refused create_direct_order';
  END IF;
  BEGIN
    v_res2 := public.create_direct_order(v_cust_a, CURRENT_DATE, '[SMOKE] SRB direct', NULL, v_items, v_admin, v_key, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_direct_order retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.orders WHERE customer_id = v_cust_a AND order_name = '[SMOKE] SRB direct') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_direct_order retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 7. create_rush_order: the same key for a DIFFERENT customer is refused; customer B gets no order.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'rush-order';
  v_rush_items := jsonb_build_array(jsonb_build_object('product_id', v_p_shell, 'qty', 1));
  v_res := public.create_rush_order(v_cust_a, v_rush_items, '[SMOKE] SRB rush', NULL, v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_rush_order for customer A did not create: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.create_rush_order(v_cust_b, v_rush_items, '[SMOKE] SRB rush', NULL, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: create_rush_order replayed customer A''s order as success for customer B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong create_rush_order refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.orders WHERE customer_id = v_cust_b) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer B got an order from a refused create_rush_order';
  END IF;
  BEGIN
    v_res2 := public.create_rush_order(v_cust_a, v_rush_items, '[SMOKE] SRB rush', NULL, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_rush_order retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.orders WHERE customer_id = v_cust_a AND notes = '[SMOKE] SRB rush') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_rush_order retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 8. close_quote_as_applied: the same key for a DIFFERENT quote is refused; quote 2 stays open.
  --    An already-closed quote under a new key answers already_closed with no receipt.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'close-applied';
  v_res := public.close_quote_as_applied(v_q1, v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'closed_by_application' OR (v_res->'already_closed') IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: close_quote_as_applied on quote 1 did not close it: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.close_quote_as_applied(v_q2, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: close_quote_as_applied replayed quote 1''s close as success for quote 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong close_quote_as_applied refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.quotes WHERE id = v_q2) IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote 2 was closed by a refused call';
  END IF;
  BEGIN
    v_res2 := public.close_quote_as_applied(v_q1, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact close_quote_as_applied retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.activity_feed WHERE event_type = 'quote_closed_by_application' AND related_entity_id = v_q1) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact close_quote_as_applied retry did not replay: % vs %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.close_quote_as_applied(v_q1, v_admin, v_pfx || 'noop-close-applied');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already_closed no-op (applied) was refused: %', SQLERRM;
  END;
  IF (v_res2->'already_closed') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an already-closed quote did not answer already_closed (applied): %', v_res2;
  END IF;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_pfx || 'noop-close-applied') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already_closed no-op (applied) left a receipt';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 9. close_quote_as_short: the same, for quotes 3 and 4.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'close-short';
  v_res := public.close_quote_as_short(v_q3, v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'closed_short' OR (v_res->'already_closed') IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: close_quote_as_short on quote 3 did not close it: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.close_quote_as_short(v_q4, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: close_quote_as_short replayed quote 3''s close as success for quote 4: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong close_quote_as_short refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.quotes WHERE id = v_q4) IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote 4 was closed by a refused call';
  END IF;
  BEGIN
    v_res2 := public.close_quote_as_short(v_q3, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact close_quote_as_short retry was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.activity_feed WHERE event_type = 'quote_closed_short' AND related_entity_id = v_q3) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact close_quote_as_short retry did not replay: % vs %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.close_quote_as_short(v_q3, v_admin, v_pfx || 'noop-close-short');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already_closed no-op (short) was refused: %', SQLERRM;
  END;
  IF (v_res2->'already_closed') IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an already-closed quote did not answer already_closed (short): %', v_res2;
  END IF;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_pfx || 'noop-close-short') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already_closed no-op (short) left a receipt';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 10. create_application_record_from_blend_ticket: the same key for a DIFFERENT ticket is
  --     refused; ticket 4 gets no record. Its receipt operation is create_app_record_from_bt.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'app-record';
  v_ids := public.create_application_record_from_blend_ticket(v_t3, v_admin, v_key);
  IF coalesce(array_length(v_ids, 1), 0) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_application_record_from_blend_ticket on ticket 3 returned %', v_ids;
  END IF;
  BEGIN
    v_ids2 := public.create_application_record_from_blend_ticket(v_t4, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: create_application_record_from_blend_ticket replayed ticket 3''s records as success for ticket 4: %', v_ids2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong create_application_record_from_blend_ticket refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.application_records WHERE source_type = 'blend_ticket' AND source_id = v_t4) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ticket 4 got an application record from a refused call';
  END IF;
  BEGIN
    v_ids2 := public.create_application_record_from_blend_ticket(v_t3, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_application_record_from_blend_ticket retry was refused: %', SQLERRM;
  END;
  IF v_ids2 IS DISTINCT FROM v_ids
     OR (SELECT count(*) FROM public.application_records WHERE source_type = 'blend_ticket' AND source_id = v_t3) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_application_record_from_blend_ticket retry did not replay: % vs %', v_ids2, v_ids;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_key AND operation = 'create_app_record_from_bt') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the application-record receipt is not stored under create_app_record_from_bt';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 11. batch_cancel_deliveries: a DIFFERENT delivery set is refused (delivery 3 stays scheduled);
  --     the same set in another order replays.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'batch-cancel';
  v_n := public.batch_cancel_deliveries(ARRAY[v_d2, v_d1], '[SMOKE] batch cancel', v_admin, v_key);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch_cancel_deliveries cancelled % deliveries, expected 2', v_n;
  END IF;
  BEGIN
    v_n := public.batch_cancel_deliveries(ARRAY[v_d3], '[SMOKE] batch cancel', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: batch_cancel_deliveries replayed batch 1''s count as success for delivery 3: %', v_n;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong batch_cancel_deliveries refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.deliveries WHERE id = v_d3) IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 3 was cancelled by a refused batch';
  END IF;
  BEGIN
    v_n := public.batch_cancel_deliveries(ARRAY[v_d1, v_d2], '[SMOKE] batch cancel', v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact batch_cancel_deliveries retry (same set, other order) was refused: %', SQLERRM;
  END;
  IF v_n <> 2
     OR (SELECT count(*) FROM public.activity_feed WHERE event_type = 'delivery_cancelled' AND related_entity_id IN (v_d1, v_d2)) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact batch_cancel_deliveries retry (same set, other order) did not replay: %', v_n;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 12. reverse_completed_cycle_count: the same key for a DIFFERENT count is refused; count 2
  --     stays completed.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'reverse-count';
  PERFORM public.reverse_completed_cycle_count(v_cc1, v_admin, v_key);
  IF (SELECT status FROM public.cycle_counts WHERE id = v_cc1) IS DISTINCT FROM 'cancelled'
     OR (SELECT quantity_available FROM public.inventory WHERE id = v_inv_cc1) <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: reverse_completed_cycle_count did not reverse count 1';
  END IF;
  BEGIN
    PERFORM public.reverse_completed_cycle_count(v_cc2, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: reverse_completed_cycle_count replayed count 1''s reversal as success for count 2';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reverse_completed_cycle_count refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.cycle_counts WHERE id = v_cc2) IS DISTINCT FROM 'completed'
     OR (SELECT quantity_available FROM public.inventory WHERE id = v_inv_cc2) <> 112 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: count 2 was reversed by a refused call';
  END IF;
  -- The exact retry replays (a second reversal would raise "Only completed cycle counts").
  BEGIN
    PERFORM public.reverse_completed_cycle_count(v_cc1, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact reverse_completed_cycle_count retry was refused: %', SQLERRM;
  END;
  IF (SELECT quantity_available FROM public.inventory WHERE id = v_inv_cc1) <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact reverse_completed_cycle_count retry changed stock';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 13. create_planned_holds: the same key for a DIFFERENT quote is refused; the exact retry gets
  --     the body's own duplicate answer; a keyless call is refused, while revert_quote_status's
  --     own rebuild of a reopened planned quote (it calls the private body) runs and writes no
  --     create_planned_holds receipt.
  -- --------------------------------------------------------------------------------------------
  v_key := v_pfx || 'planned-holds';
  v_res := public.create_planned_holds(v_q5, v_admin, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_planned_holds for quote 5 did not run: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.create_planned_holds(v_q6, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: create_planned_holds replayed quote 5''s receipt for quote 6: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong create_planned_holds refusal: %', SQLERRM;
    END IF;
  END;
  BEGIN
    v_res2 := public.create_planned_holds(v_q5, v_admin, v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_planned_holds retry was refused: %', SQLERRM;
  END;
  IF v_res2->>'status' IS DISTINCT FROM 'duplicate' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_planned_holds retry did not replay: %', v_res2;
  END IF;
  SELECT count(*) INTO v_n FROM public.idempotency_keys WHERE operation = 'create_planned_holds';
  BEGIN
    v_res2 := public.create_planned_holds(v_q6, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a keyless create_planned_holds ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless create_planned_holds refusal: %', SQLERRM;
    END IF;
  END;
  -- revert_quote_status itself requires a key now (recreated by this migration).
  BEGIN
    v_res2 := public.revert_quote_status(v_q7, '[SMOKE] keyless revert', v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a keyless revert_quote_status ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless revert_quote_status refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.quotes WHERE id = v_q7) IS DISTINCT FROM 'declined' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused keyless revert_quote_status changed the quote';
  END IF;
  BEGIN
    v_res2 := public.revert_quote_status(v_q7, '[SMOKE] reopen a declined planned quote', v_admin, v_pfx || 'revert-q7');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: revert_quote_status (its planned-holds rebuild through the private body) was refused: %', SQLERRM;
  END;
  IF (SELECT status FROM public.quotes WHERE id = v_q7) IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: revert_quote_status did not reopen the declined quote: %', v_res2;
  END IF;
  IF (SELECT count(*) FROM public.idempotency_keys WHERE operation = 'create_planned_holds') <> v_n THEN
    RAISE EXCEPTION 'SMOKE_FAIL: revert_quote_status''s planned-holds rebuild wrote a create_planned_holds receipt';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 14. A second admin presenting the first admin's key for the identical request is refused,
  --     for every one of the thirteen.
  -- --------------------------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  FOREACH v_sql IN ARRAY ARRAY[
    format('SELECT public.release_inventory_hold(%L::uuid, NULL, %L)', v_hold_a, v_pfx || 'release-hold'),
    format('SELECT public.retire_inventory_item(%L::uuid, NULL, %L)', v_inv_r1, v_pfx || 'retire'),
    format('SELECT public.reconcile_negative_inventory(%L::uuid, 0, %L, NULL, %L)', v_inv_c1, '[SMOKE] reconcile', v_pfx || 'reconcile'),
    format('SELECT public.manual_inventory_add(%L::uuid, %L, 10, %L, NULL, %L, NULL, %L, NULL, NULL)',
           v_p_m1, 'Main Warehouse', 'gal', '[SMOKE] add', v_pfx || 'manual-add'),
    format('SELECT public.create_order_from_blend_ticket(%L::uuid, %L, CURRENT_DATE, NULL, %L::uuid, %L)',
           v_t1, v_order_no, v_admin_b, v_pfx || 'order-from-bt'),
    format('SELECT public.create_direct_order(%L::uuid, CURRENT_DATE, %L, NULL, %L::jsonb, NULL, %L, NULL)',
           v_cust_a, '[SMOKE] SRB direct', v_items, v_pfx || 'direct-order'),
    format('SELECT public.create_rush_order(%L::uuid, %L::jsonb, %L, NULL, NULL, %L)',
           v_cust_a, v_rush_items, '[SMOKE] SRB rush', v_pfx || 'rush-order'),
    format('SELECT public.close_quote_as_applied(%L::uuid, NULL, %L)', v_q1, v_pfx || 'close-applied'),
    format('SELECT public.close_quote_as_short(%L::uuid, NULL, %L)', v_q3, v_pfx || 'close-short'),
    format('SELECT public.create_application_record_from_blend_ticket(%L::uuid, %L::uuid, %L)', v_t3, v_admin_b, v_pfx || 'app-record'),
    format('SELECT public.batch_cancel_deliveries(ARRAY[%L::uuid, %L::uuid], %L, NULL, %L)', v_d1, v_d2, '[SMOKE] batch cancel', v_pfx || 'batch-cancel'),
    format('SELECT public.reverse_completed_cycle_count(%L::uuid, NULL, %L)', v_cc1, v_pfx || 'reverse-count'),
    format('SELECT public.create_planned_holds(%L::uuid, NULL, %L)', v_q5, v_pfx || 'planned-holds')
  ] LOOP
    BEGIN
      EXECUTE v_sql;
      RAISE EXCEPTION 'SMOKE_FAIL: a second admin replayed the first admin''s key: %', v_sql;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-admin refusal for %: %', v_sql, SQLERRM;
      END IF;
    END;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------------------------------------
  -- 15. A keyless call is refused before any work by twelve of the thirteen (create_planned_holds
  --     was step 13), each aimed at a record nothing has touched yet.
  -- --------------------------------------------------------------------------------------------
  FOREACH v_sql IN ARRAY ARRAY[
    format('SELECT public.release_inventory_hold(%L::uuid, %L::uuid, NULL)', v_hold_b, v_admin),
    format('SELECT public.retire_inventory_item(%L::uuid, %L::uuid, NULL)', v_inv_r2, v_admin),
    format('SELECT public.reconcile_negative_inventory(%L::uuid, 0, %L, %L::uuid, NULL)', v_inv_c2, '[SMOKE] keyless', v_admin),
    format('SELECT public.manual_inventory_add(%L::uuid, %L, 10, %L, %L::uuid, NULL, NULL, NULL, NULL, NULL)',
           v_p_m2, 'Main Warehouse', 'gal', v_admin),
    format('SELECT public.create_order_from_blend_ticket(%L::uuid, %L, CURRENT_DATE, NULL, %L::uuid, NULL)',
           v_t2, '[SMOKE]-SRB-BTO-KEYLESS-' || v_suffix, v_admin),
    format('SELECT public.create_direct_order(%L::uuid, CURRENT_DATE, NULL, NULL, %L::jsonb, %L::uuid, NULL, NULL)',
           v_cust_b, v_items, v_admin),
    format('SELECT public.create_rush_order(%L::uuid, %L::jsonb, NULL, NULL, %L::uuid, NULL)', v_cust_b, v_rush_items, v_admin),
    format('SELECT public.close_quote_as_applied(%L::uuid, %L::uuid, NULL)', v_q2, v_admin),
    format('SELECT public.close_quote_as_short(%L::uuid, %L::uuid, NULL)', v_q4, v_admin),
    format('SELECT public.create_application_record_from_blend_ticket(%L::uuid, %L::uuid, NULL)', v_t4, v_admin),
    format('SELECT public.batch_cancel_deliveries(ARRAY[%L::uuid], %L, %L::uuid, NULL)', v_d3, '[SMOKE] keyless', v_admin),
    format('SELECT public.reverse_completed_cycle_count(%L::uuid, %L::uuid, NULL)', v_cc2, v_admin)
  ] LOOP
    BEGIN
      EXECUTE v_sql;
      RAISE EXCEPTION 'SMOKE_FAIL: a keyless call ran: %', v_sql;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless refusal for %: %', v_sql, SQLERRM;
      END IF;
    END;
  END LOOP;
  IF NOT (SELECT is_active FROM public.inventory_holds WHERE id = v_hold_b)
     OR (SELECT status FROM public.quotes WHERE id = v_q2) IS DISTINCT FROM 'sent'
     OR (SELECT status FROM public.deliveries WHERE id = v_d3) IS DISTINCT FROM 'scheduled'
     OR (SELECT status FROM public.cycle_counts WHERE id = v_cc2) IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused keyless call changed its record';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 16. Every receipt written above is bound to the admin and carries a SHA-256 fingerprint: one
  --     per operation, thirteen in all.
  -- --------------------------------------------------------------------------------------------
  SELECT count(*), count(DISTINCT operation) INTO v_n, v_qty FROM public.idempotency_keys
   WHERE idempotency_key LIKE v_pfx || '%'
     AND operation = ANY (v_ops)
     AND request_actor_id = v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_n <> 13 OR v_qty <> 13 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % receipts over % operations are bound to the admin with a fingerprint (expected 13 over 13)', v_n, v_qty;
  END IF;
  -- Among the thirteen operations (revert_quote_status binds its own receipt inside its result).
  IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key LIKE v_pfx || '%'
              AND operation = ANY (v_ops)
              AND (request_actor_id IS NULL OR request_fingerprint IS NULL)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an unbound receipt was left behind';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 17. An unbound legacy receipt for each of the thirteen operations is refused, never replayed.
  -- --------------------------------------------------------------------------------------------
  FOREACH v_op IN ARRAY v_ops LOOP
    v_key := v_pfx || 'legacy-' || v_op;
    v_sql := CASE v_op
      WHEN 'release_inventory_hold' THEN format('SELECT public.release_inventory_hold(%L::uuid, NULL, %L)', v_hold_b, v_key)
      WHEN 'retire_inventory_item' THEN format('SELECT public.retire_inventory_item(%L::uuid, NULL, %L)', v_inv_r2, v_key)
      WHEN 'reconcile_negative_inventory' THEN format('SELECT public.reconcile_negative_inventory(%L::uuid, 0, %L, NULL, %L)', v_inv_c2, '[SMOKE] legacy', v_key)
      WHEN 'manual_inventory_add' THEN format('SELECT public.manual_inventory_add(%L::uuid, %L, 1, NULL, NULL, NULL, NULL, %L, NULL, NULL)', v_p_m2, 'Main Warehouse', v_key)
      WHEN 'create_order_from_blend_ticket' THEN format('SELECT public.create_order_from_blend_ticket(%L::uuid, %L, CURRENT_DATE, NULL, %L::uuid, %L)', v_t2, '[SMOKE]-SRB-BTO-LEGACY-' || v_suffix, v_admin, v_key)
      WHEN 'create_direct_order' THEN format('SELECT public.create_direct_order(%L::uuid, CURRENT_DATE, NULL, NULL, %L::jsonb, NULL, %L, NULL)', v_cust_b, v_items, v_key)
      WHEN 'create_rush_order' THEN format('SELECT public.create_rush_order(%L::uuid, %L::jsonb, NULL, NULL, NULL, %L)', v_cust_b, v_rush_items, v_key)
      WHEN 'close_quote_as_applied' THEN format('SELECT public.close_quote_as_applied(%L::uuid, NULL, %L)', v_q2, v_key)
      WHEN 'close_quote_as_short' THEN format('SELECT public.close_quote_as_short(%L::uuid, NULL, %L)', v_q4, v_key)
      WHEN 'create_app_record_from_bt' THEN format('SELECT public.create_application_record_from_blend_ticket(%L::uuid, %L::uuid, %L)', v_t4, v_admin, v_key)
      WHEN 'batch_cancel_deliveries' THEN format('SELECT public.batch_cancel_deliveries(ARRAY[%L::uuid], %L, NULL, %L)', v_d3, '[SMOKE] legacy', v_key)
      WHEN 'reverse_completed_cycle_count' THEN format('SELECT public.reverse_completed_cycle_count(%L::uuid, NULL, %L)', v_cc2, v_key)
      WHEN 'create_planned_holds' THEN format('SELECT public.create_planned_holds(%L::uuid, NULL, %L)', v_q6, v_key)
    END;
    BEGIN
      -- The shape each old body stored (an object, an id array, a quote id string).
      INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
      VALUES (v_key, v_op, CASE v_op WHEN 'create_app_record_from_bt' THEN to_jsonb(ARRAY[gen_random_uuid()])
                                     WHEN 'create_planned_holds' THEN to_jsonb(v_q6)
                                     ELSE jsonb_build_object('success', true, 'count', 1) END);
      EXECUTE v_sql;
      RAISE EXCEPTION 'SMOKE_FAIL: an unbound legacy % receipt was replayed', v_op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong legacy-receipt refusal for %: %', v_op, SQLERRM;
      END IF;
    END;
  END LOOP;

  -- --------------------------------------------------------------------------------------------
  -- 18. The commit-time guard refuses an unbound receipt for each of the thirteen operations
  --     (the guard is forced to run now; the container prover checks a real COMMIT).
  -- --------------------------------------------------------------------------------------------
  FOREACH v_op IN ARRAY v_ops LOOP
    BEGIN
      INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
      VALUES (v_pfx || 'guard-' || v_op, v_op, '{}'::jsonb);
      SET CONSTRAINTS public.require_bound_replay_receipt_20261015 IMMEDIATE;
      RAISE EXCEPTION 'SMOKE_FAIL: the commit-time guard accepted an unbound % receipt', v_op;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'REPLAY_RECEIPT_UNBOUND%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong commit-time guard refusal for %: %', v_op, SQLERRM;
      END IF;
    END;
  END LOOP;
  SET CONSTRAINTS public.require_bound_replay_receipt_20261015 DEFERRED;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
