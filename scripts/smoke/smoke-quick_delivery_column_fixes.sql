-- ============================================================================
-- SMOKE TEST (rolled back by design): create_quick_delivery column fixes
-- ----------------------------------------------------------------------------
-- Verifies scripts/.staging-migrations/quick_delivery_column_fixes.sql
-- (baseline live prosrc md5 142ed469a659043f346b8f038219b715). The live
-- function was dead on arrival (B-a 23502 deliveries.created_by, then B-b/B-c
-- 42703 phantom columns, then B-d trigger double-prebook), so the "existing
-- happy path" IS the previously-broken path — this chain exercises every
-- fixed statement:
--   A  happy path: fixture customer + product + inventory -> one call ->
--      order (confirmed, totals tie out in bigint cents -> numeric dollars) +
--      delivery (scheduled, created_by = admin actor — B-a) + order_items
--      (total_units_needed / quantity_remaining carry the qty; sort_order
--      kept — B-b) + delivery_items (no sort_order; item-level unit_size
--      override wins — B-c) + draft invoice + invoice_items + EXACTLY ONE
--      prebook increment and ONE 'prebooked' transaction, ZERO legacy
--      'booked' rows (B-d) + 2 financial_audit_log rows + idempotency row.
--   B  idempotency replay: same key -> byte-identical cached jsonb, zero new
--      rows, prebook unchanged.
--   C  p_skip_invoice branch: no invoice/invoice_items; 2 items -> sort_order
--      1,2 on order_items; per-item delivery_items fall back to product
--      unit_size; prebook += sum(qty).
--   D  guard branches still fire: AUTH_REQUIRED (no sub claim),
--      ACTOR_MISMATCH (forged p_performed_by), Insufficient inventory
--      (net-free check, FOR UPDATE row).
--   E  credit-limit warning branch (previously unreachable): limit 1 cent ->
--      result credit_warning = true + activity_feed 'credit_limit_warning'
--      row + one 'credit_warning' notification per active admin.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success it raises
-- 'SMOKE_PASS_ROLLBACK' — so nothing here ever commits.
--
-- Calling context: create_quick_delivery is authenticated-executable SECDEF
-- and gates on auth.uid() (active admin/sales_rep/driver). We simulate the
-- authenticated context with transaction-local request.jwt.claims whose sub
-- is a REAL active admin profile id selected at runtime (no profile id is
-- hardcoded; the block fails loudly if no active admin exists).
--
-- Catalog dry-validation (42703 discipline) — every reference below was
-- checked against the live catalog 2026-06-10, and INDEPENDENTLY RE-VALIDATED
-- 2026-06-11 (bulk existence query: 121/121 table.column refs present, 0
-- missing; trigger-interaction claims re-read from live prosrc:
-- validate_product_units no-ops without product_form/inventory_unit/
-- container_unit; calculate_prices_from_margin leaves explicit tier prices
-- untouched when tier*_margin are NULL; _snapshot_order_item_cost yields
-- ROUND(7.25*100) = 725; _insert_commissions_for_order returns 0 on NULL
-- split; check_idempotency/save_idempotency are operation-scoped; active
-- admin profiles exist live so the runtime sub-claim lookup cannot fail):
--   profiles(id, role, is_active, created_at);
--   customers(id, farm_name, assigned_tier [NOT NULL DEFAULT 1],
--     credit_limit_cents [DEFAULT 0], is_active [DEFAULT true],
--     default_commission_split);
--   products(id, product_name [NOT NULL], unit_size, tier1_price,
--     tier2_price, tier3_price, current_cost, is_active [DEFAULT true]);
--   inventory(product_id, location, quantity_available, quantity_prebooked,
--     quantity_on_order, unit_size, updated_at);
--   orders(id, order_number, customer_id, status [CHECK incl. confirmed],
--     order_date, notes, total_price, total_cost, total_profit,
--     total_margin_pct, commission_split);
--   order_items(id, order_id, product_id, total_units_needed, price_per_unit,
--     quantity_delivered, quantity_remaining, total_price, sort_order,
--     cost_at_time_cents [filled by _snapshot_order_item_cost],
--     product_name [NOT NULL DEFAULT ''], cost_per_unit [NOT NULL DEFAULT 0]);
--   deliveries(id, delivery_number, order_id, customer_id, assigned_driver,
--     scheduled_date, status [CHECK incl. scheduled], delivery_notes,
--     is_quick_delivery, created_by [NOT NULL — the B-a fix]);
--   delivery_items(id, delivery_id, order_item_id, product_id, quantity,
--     quantity_delivered, unit_size — NO sort_order, the B-c fix);
--   invoices(id, invoice_number, invoice_type [CHECK incl. chemical_sale],
--     order_id, customer_id, status [CHECK incl. draft], total_amount_cents,
--     paid_amount_cents, prepay_applied_cents, invoice_date,
--     is_quick_delivery, created_by, total_cost_cents,
--     balance_cents [GENERATED — read-only, feeds the credit check]);
--   invoice_items(invoice_id, order_item_id, product_id, description,
--     quantity, unit_price_cents, extended_cents, cost_cents, sort_order);
--   inventory_transactions(product_id, transaction_type [CHECK incl.
--     prebooked + booked], quantity, order_id, delivery_id, performed_by,
--     notes);
--   financial_audit_log(operation_type [CHECK incl. order_created/
--     delivery_created], entity_type [CHECK incl. order/delivery], entity_id,
--     actor_role, new_values, total_impact_cents, description);
--   activity_feed(event_type, description, performed_by,
--     related_entity_type, related_entity_id, customer_id);
--   notifications(user_id, title, message, notification_type,
--     related_entity_type, related_entity_id);
--   idempotency_keys(idempotency_key, operation, result);
--   commissions(order_id, customer_id) [count-only assert; NULL split -> 0
--     rows per _insert_commissions_for_order's early RETURN 0];
--   functions: create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,
--     boolean), check_idempotency(text,text)/save_idempotency(text,text,
--     jsonb) (internal), safe_cents_qty(bigint,numeric),
--     generate_order_number(), next_delivery_number(),
--     next_invoice_number(text), _insert_commissions_for_order(uuid,uuid,
--     numeric,jsonb,date), auth.uid();
--   triggers exercised: enforce_delivery_items_parent_lock (INSERT on
--     'scheduled' parent — allowed), _snapshot_order_item_cost,
--     trg_recalc_order_totals (overwritten by the body's final totals
--     UPDATE), trg_invoice_draft_insert (insert is 'draft' — allowed),
--     guard_completed_delivery_signature (no-op, not completed);
--     trg_prebook_quick_delivery must be GONE (DELTA-4) — asserted via the
--     zero-'booked'-rows and exact-prebook-delta checks.
-- ============================================================================

DO $$
DECLARE
  v_admin uuid;
  v_admin_count int;
  v_customer uuid;
  v_prod uuid;
  v_sfx text := substr(gen_random_uuid()::text, 1, 8);
  v_key_a text;
  v_key_c text;
  v_key_e text;
  v_res_a jsonb;
  v_res_a2 jsonb;
  v_res_c jsonb;
  v_res_e jsonb;
  v_order_a uuid;
  v_delivery_a uuid;
  v_invoice_a uuid;
  v_order_c uuid;
  v_delivery_c uuid;
  v_ord RECORD;
  v_oi RECORD;
  v_del RECORD;
  v_di RECORD;
  v_inv RECORD;
  v_ii RECORD;
  v_n int;
  v_prebooked numeric;
BEGIN
  v_key_a := '[SMOKE] qdfix-a-' || v_sfx;
  v_key_c := '[SMOKE] qdfix-c-' || v_sfx;
  v_key_e := '[SMOKE] qdfix-e-' || v_sfx;

  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin profile';
  END IF;
  SELECT count(*) INTO v_admin_count FROM profiles WHERE role = 'admin' AND is_active = true;

  -- ------------------------------------------------- D1: AUTH_REQUIRED guard
  -- Deterministic no-sub claims BEFORE the real authenticated context.
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM create_quick_delivery(
      p_customer_id => gen_random_uuid(),
      p_items => jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'quantity', 1)));
    RAISE EXCEPTION 'FAIL: expected AUTH_REQUIRED without a sub claim';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%AUTH_REQUIRED%' THEN RAISE; END IF;
  END;

  -- Authenticated context: the fn gates on auth.uid()
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ---------------------------------------------------------------- fixtures
  INSERT INTO customers (farm_name, assigned_tier, credit_limit_cents)
  VALUES ('[SMOKE] Quick Farm ' || v_sfx, 1, 0)
  RETURNING id INTO v_customer;

  -- tier1 12.50 -> 1250c; cost 7.25 -> 725c
  INSERT INTO products (product_name, unit_size, tier1_price, tier2_price, tier3_price, current_cost)
  VALUES ('[SMOKE] QD Herbicide ' || v_sfx, 'GL', 12.50, 11.00, 10.00, 7.25)
  RETURNING id INTO v_prod;

  INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_prod, 'Main Warehouse', 100, 0, 0);

  -- ------------------------------------------------ D2: ACTOR_MISMATCH guard
  BEGIN
    PERFORM create_quick_delivery(
      p_customer_id => v_customer,
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
      p_performed_by => gen_random_uuid());
    RAISE EXCEPTION 'FAIL: expected ACTOR_MISMATCH for forged p_performed_by';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%ACTOR_MISMATCH%' THEN RAISE; END IF;
  END;

  -- --------------------------------------- D3: insufficient-inventory guard
  BEGIN
    PERFORM create_quick_delivery(
      p_customer_id => v_customer,
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1000)));
    RAISE EXCEPTION 'FAIL: expected Insufficient inventory for qty 1000 of 100';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Insufficient inventory%' THEN RAISE; END IF;
  END;

  -- ===================================================== A: happy path chain
  -- 4 GL @ tier1 1250c = 5000c; cost 4 x 725c = 2900c.
  v_res_a := create_quick_delivery(
    p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'quantity', 4, 'unit_size', 'TOTE')),
    p_driver_id => NULL,
    p_scheduled_date => CURRENT_DATE + 1,
    p_delivery_notes => '[SMOKE] quick delivery ' || v_sfx,
    p_performed_by => v_admin,
    p_idempotency_key => v_key_a,
    p_skip_invoice => false);

  v_order_a := (v_res_a->>'order_id')::uuid;
  v_delivery_a := (v_res_a->>'delivery_id')::uuid;
  v_invoice_a := (v_res_a->>'invoice_id')::uuid;
  IF v_order_a IS NULL OR v_delivery_a IS NULL OR v_invoice_a IS NULL
     OR v_res_a->>'order_number' IS NULL OR v_res_a->>'delivery_number' IS NULL
     OR v_res_a->>'invoice_number' IS NULL THEN
    RAISE EXCEPTION 'FAIL A: missing ids/numbers in result: %', v_res_a;
  END IF;
  IF (v_res_a->>'total_cents')::bigint <> 5000 OR (v_res_a->>'credit_warning')::boolean THEN
    RAISE EXCEPTION 'FAIL A: total_cents/credit_warning wrong: %', v_res_a;
  END IF;

  -- order head
  SELECT * INTO v_ord FROM orders WHERE id = v_order_a;
  IF NOT FOUND OR v_ord.status <> 'confirmed' OR v_ord.notes <> 'Quick delivery'
     OR v_ord.order_date <> CURRENT_DATE
     OR v_ord.total_price <> 50.00 OR v_ord.total_cost <> 29.00
     OR v_ord.total_profit <> 21.00 OR v_ord.total_margin_pct <> 42.00
     OR v_ord.commission_split IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL A: order head wrong: %', to_jsonb(v_ord);
  END IF;

  -- order_items (B-b: total_units_needed carries the qty; no phantom columns)
  SELECT count(*) INTO v_n FROM order_items WHERE order_id = v_order_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL A: order_items count = %, expected 1', v_n; END IF;
  SELECT * INTO v_oi FROM order_items WHERE order_id = v_order_a;
  IF v_oi.total_units_needed <> 4 OR v_oi.quantity_remaining <> 4
     OR v_oi.quantity_delivered <> 0 OR v_oi.sort_order <> 1
     OR v_oi.price_per_unit <> 12.50 OR v_oi.total_price <> 50.00
     OR v_oi.cost_at_time_cents <> 725 THEN
    RAISE EXCEPTION 'FAIL A: order_items row wrong: %', to_jsonb(v_oi);
  END IF;

  -- delivery head (B-a: created_by now set to the actor)
  SELECT * INTO v_del FROM deliveries WHERE id = v_delivery_a;
  IF NOT FOUND OR v_del.status <> 'scheduled' OR v_del.is_quick_delivery IS NOT TRUE
     OR v_del.created_by <> v_admin OR v_del.assigned_driver IS NOT NULL
     OR v_del.scheduled_date <> CURRENT_DATE + 1
     OR v_del.delivery_notes <> '[SMOKE] quick delivery ' || v_sfx THEN
    RAISE EXCEPTION 'FAIL A: delivery head wrong: %', to_jsonb(v_del);
  END IF;

  -- delivery_items (B-c: no sort_order; item-level unit_size override wins)
  SELECT count(*) INTO v_n FROM delivery_items WHERE delivery_id = v_delivery_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL A: delivery_items count = %, expected 1', v_n; END IF;
  SELECT * INTO v_di FROM delivery_items WHERE delivery_id = v_delivery_a;
  IF v_di.quantity <> 4 OR COALESCE(v_di.quantity_delivered, 0) <> 0
     OR v_di.unit_size <> 'TOTE' OR v_di.order_item_id <> v_oi.id
     OR v_di.product_id <> v_prod THEN
    RAISE EXCEPTION 'FAIL A: delivery_items row wrong: %', to_jsonb(v_di);
  END IF;

  -- invoice + items
  SELECT * INTO v_inv FROM invoices WHERE id = v_invoice_a;
  IF NOT FOUND OR v_inv.status <> 'draft' OR v_inv.invoice_type <> 'chemical_sale'
     OR v_inv.order_id <> v_order_a OR v_inv.customer_id <> v_customer
     OR v_inv.total_amount_cents <> 5000 OR v_inv.total_cost_cents <> 2900
     OR v_inv.paid_amount_cents <> 0 OR v_inv.prepay_applied_cents <> 0
     OR v_inv.is_quick_delivery IS NOT TRUE OR v_inv.created_by <> v_admin THEN
    RAISE EXCEPTION 'FAIL A: invoice head wrong: %', to_jsonb(v_inv);
  END IF;
  SELECT count(*) INTO v_n FROM invoice_items WHERE invoice_id = v_invoice_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL A: invoice_items count = %, expected 1', v_n; END IF;
  SELECT * INTO v_ii FROM invoice_items WHERE invoice_id = v_invoice_a;
  IF v_ii.quantity <> 4 OR v_ii.unit_price_cents <> 1250 OR v_ii.extended_cents <> 5000
     OR v_ii.cost_cents <> 725 OR v_ii.sort_order <> 1
     OR v_ii.order_item_id <> v_oi.id
     OR v_ii.description <> '[SMOKE] QD Herbicide ' || v_sfx THEN
    RAISE EXCEPTION 'FAIL A: invoice_items row wrong: %', to_jsonb(v_ii);
  END IF;

  -- B-d: EXACTLY ONE prebook increment (the legacy trigger would make it 8)
  SELECT quantity_prebooked INTO v_prebooked
  FROM inventory WHERE product_id = v_prod AND location = 'Main Warehouse';
  IF v_prebooked <> 4 THEN
    RAISE EXCEPTION 'FAIL A: quantity_prebooked = % (expected exactly 4 — double-prebook?)', v_prebooked;
  END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE delivery_id = v_delivery_a AND transaction_type = 'prebooked' AND quantity = 4;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL A: prebooked txn count = %, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE delivery_id = v_delivery_a AND transaction_type = 'booked';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAIL A: % legacy ''booked'' txn rows — trg_prebook_quick_delivery still attached', v_n;
  END IF;

  -- audit trail + idempotency persistence + no commissions for NULL split
  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'order_created' AND entity_type = 'order'
    AND entity_id = v_order_a AND total_impact_cents = 5000;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL A: order_created audit rows = %, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'delivery_created' AND entity_type = 'delivery' AND entity_id = v_delivery_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL A: delivery_created audit rows = %, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM idempotency_keys
  WHERE idempotency_key = v_key_a AND operation = 'create_quick_delivery' AND result IS NOT NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL A: idempotency_keys rows = %, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM commissions WHERE order_id = v_order_a AND customer_id = v_customer;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL A: commissions = % for NULL split, expected 0', v_n; END IF;

  -- ================================================== B: idempotency replay
  v_res_a2 := create_quick_delivery(
    p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'quantity', 4, 'unit_size', 'TOTE')),
    p_scheduled_date => CURRENT_DATE + 1,
    p_delivery_notes => '[SMOKE] quick delivery ' || v_sfx,
    p_performed_by => v_admin,
    p_idempotency_key => v_key_a,
    p_skip_invoice => false);
  IF v_res_a2 <> v_res_a THEN
    RAISE EXCEPTION 'FAIL B: replay returned different jsonb: % vs %', v_res_a2, v_res_a;
  END IF;
  SELECT count(*) INTO v_n FROM orders WHERE customer_id = v_customer;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL B: replay created a new order (count %)', v_n; END IF;
  SELECT quantity_prebooked INTO v_prebooked
  FROM inventory WHERE product_id = v_prod AND location = 'Main Warehouse';
  IF v_prebooked <> 4 THEN
    RAISE EXCEPTION 'FAIL B: replay moved quantity_prebooked to %', v_prebooked;
  END IF;

  -- ================================================ C: p_skip_invoice branch
  -- Two items (3 + 2 GL), no unit_size on items -> product unit_size 'GL'.
  v_res_c := create_quick_delivery(
    p_customer_id => v_customer,
    p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_prod, 'quantity', 3),
      jsonb_build_object('product_id', v_prod, 'quantity', 2)),
    p_performed_by => v_admin,
    p_idempotency_key => v_key_c,
    p_skip_invoice => true);

  v_order_c := (v_res_c->>'order_id')::uuid;
  v_delivery_c := (v_res_c->>'delivery_id')::uuid;
  IF v_order_c IS NULL OR v_delivery_c IS NULL THEN
    RAISE EXCEPTION 'FAIL C: missing ids in result: %', v_res_c;
  END IF;
  IF (v_res_c->>'invoice_id') IS NOT NULL OR (v_res_c->>'invoice_number') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL C: skip_invoice returned an invoice: %', v_res_c;
  END IF;
  IF (v_res_c->>'total_cents')::bigint <> 6250 THEN
    RAISE EXCEPTION 'FAIL C: total_cents = %, expected 6250', v_res_c->>'total_cents';
  END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE order_id = v_order_c;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL C: % invoices for skip_invoice order', v_n; END IF;
  SELECT count(*) INTO v_n FROM order_items WHERE order_id = v_order_c;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL C: order_items count = %, expected 2', v_n; END IF;
  SELECT count(*) INTO v_n FROM order_items
  WHERE order_id = v_order_c AND sort_order IN (1, 2);
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL C: order_items sort_order rows = %, expected 1 and 2', v_n; END IF;
  SELECT count(*) INTO v_n FROM delivery_items WHERE delivery_id = v_delivery_c AND unit_size = 'GL';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL C: delivery_items GL-fallback count = %, expected 2', v_n; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deliveries
    WHERE id = v_delivery_c AND created_by = v_admin AND status = 'scheduled'
  ) THEN
    RAISE EXCEPTION 'FAIL C: delivery C missing created_by = actor (B-a fix)';
  END IF;
  SELECT quantity_prebooked INTO v_prebooked
  FROM inventory WHERE product_id = v_prod AND location = 'Main Warehouse';
  IF v_prebooked <> 9 THEN
    RAISE EXCEPTION 'FAIL C: quantity_prebooked = %, expected 9 (4 + 5)', v_prebooked;
  END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE delivery_id = v_delivery_c AND transaction_type = 'prebooked';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL C: prebooked txns = %, expected 2 (one per item)', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE delivery_id = v_delivery_c AND transaction_type = 'booked';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL C: legacy booked txns = %, expected 0', v_n; END IF;

  -- ========================================= E: credit-limit warning branch
  -- AR so far: invoice A draft balance 5000c. Limit 1c -> any new delivery
  -- projects over the limit -> warn (delivery still proceeds).
  UPDATE customers SET credit_limit_cents = 1 WHERE id = v_customer;
  v_res_e := create_quick_delivery(
    p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    p_performed_by => v_admin,
    p_idempotency_key => v_key_e,
    p_skip_invoice => true);
  IF NOT (v_res_e->>'credit_warning')::boolean THEN
    RAISE EXCEPTION 'FAIL E: credit_warning not raised: %', v_res_e;
  END IF;
  SELECT count(*) INTO v_n FROM activity_feed
  WHERE event_type = 'credit_limit_warning' AND related_entity_type = 'customer'
    AND related_entity_id = v_customer AND performed_by = v_admin;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL E: credit_limit_warning feed rows = %, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM notifications
  WHERE notification_type = 'credit_warning' AND related_entity_type = 'customer'
    AND related_entity_id = v_customer;
  IF v_n <> v_admin_count THEN
    RAISE EXCEPTION 'FAIL E: credit_warning notifications = %, expected % (one per active admin)', v_n, v_admin_count;
  END IF;
  SELECT quantity_prebooked INTO v_prebooked
  FROM inventory WHERE product_id = v_prod AND location = 'Main Warehouse';
  IF v_prebooked <> 10 THEN
    RAISE EXCEPTION 'FAIL E: quantity_prebooked = %, expected 10', v_prebooked;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
