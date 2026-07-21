-- ============================================================================
-- SMOKE TEST (rolled back by design): the CANONICAL return->credit chain
-- ----------------------------------------------------------------------------
-- THE CHAIN (the exact one B1 was falsely declared "fixed" without, 2026-06-09):
--   authenticated direct returns INSERT -> 42501 (table path closed)
--   create_return (server derives product, quantity ceiling, and price from
--                  delivered order lines; caller price is ignored)
--     -> authenticated direct return_items UPDATE -> 42501 (lines RPC-owned)
--     -> approve_return        (requested -> approved)
--     -> receive_return        (approved -> received; restock + inventory txn)
--     -> issue_return_credit   (received -> credited; posted credit_memo
--                               invoice, credited_by stamped, 2 audit rows)
--     -> idempotent REPLAY of issue_return_credit (same key: cached result,
--                               NO second credit memo)
--     -> get_customer_statement (the credit appears EXACTLY ONCE - the B2
--                               double-count class)
--     -> unapply_credit_memo   (credit memo voided; return back to received;
--                               total_credit_cents back to 0 NOT NULL - the
--                               B1 null-write class; credited_by/at cleared)
--     -> statement count back to ZERO
--     -> RE-ISSUE with a new key (received -> credited again works; statement
--                               back to exactly one credit)
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1 / run-smoke.mjs) as postgres/service_role. The DO
-- block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK', so every
-- fixture, invoice, ledger and audit row created here is rolled back -
-- nothing persists. ANY other error text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims - injected via set_config(..., is_local => true) using a
-- REAL active admin profile id (3 exist live as of 2026-06-10). Direct
-- fixture INSERTs bypass RLS because we run as the table owner; the RPCs
-- under test still enforce their own auth/role gates.
--
-- Live-state preconditions (checked up front, raise SMOKE_SETUP if unmet):
--   * at least one active admin profile;
--   * CURRENT_DATE not inside a CLOSED accounting period
--     (issue_return_credit calls check_period_open(CURRENT_DATE)).
--
-- Known benign side effect: next_invoice_number('credit_memo') consumes
-- cm_invoice_number_seq values (sequences are non-transactional). Gaps in
-- CM numbering are harmless and expected; next_invoice_number self-heals
-- via its MAX()+setval reconciliation.
--
-- Every table/column/function referenced below was dry-validated against the
-- LIVE catalog on 2026-06-10 (pg_get_functiondef + information_schema +
-- pg_constraint + pg_trigger); see scripts/smoke/README.md for the discipline.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin        uuid;
  v_suffix       text := substr(md5(random()::text), 1, 8);
  v_customer_id  uuid;
  v_other_customer_id uuid;
  v_product_id   uuid;
  v_inventory_id uuid;
  v_order_id     uuid;
  v_delivery_id  uuid;
  v_order_item_1 uuid;
  v_order_item_2 uuid;
  v_return_id    uuid;
  v_legacy_return_id uuid;
  v_future_unlinked_return_id uuid;
  v_credit_id    uuid;
  v_credit_id2   uuid;
  v_credit_num   text;
  v_credit_num2  text;
  v_res          jsonb;
  v_res2         jsonb;
  v_qty          numeric;
  v_n            int;
  v_credit_rows  int;
  v_total_rows   int;
  v_stmt_sum     bigint;
  v_status       text;
  v_cents        bigint;
  v_uuid         uuid;
  v_by           uuid;
  v_ts           timestamptz;
  v_reason       text;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Preconditions + auth as a real active admin
  -- --------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: CURRENT_DATE falls in a CLOSED accounting period - issue_return_credit cannot run today';
  END IF;

  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- 1. Synthetic fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Return Credit Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Wrong Return Credit Farm ' || v_suffix)
  RETURNING id INTO v_other_customer_id;

  INSERT INTO products (product_name)
  VALUES ('[SMOKE] RCC Herbicide ' || v_suffix)
  RETURNING id INTO v_product_id;

  -- Inventory row at 'Main Warehouse' so receive_return exercises the real
  -- restock branch (it LEFT JOINs inventory on that exact location and only
  -- WARNs/skips when missing - we want the branch that writes).
  INSERT INTO inventory (product_id, location, quantity_available)
  VALUES (v_product_id, 'Main Warehouse', 100)
  RETURNING id INTO v_inventory_id;

  -- Minimal order so issue_return_credit exercises its salesman_id lookup
  -- branch and the credit memo carries order_id (orders.status defaults to
  -- 'confirmed'; only order_number + customer_id are required).
  INSERT INTO orders (order_number, customer_id, salesman_id)
  VALUES ('SMK-RCC-' || v_suffix, v_customer_id, v_admin)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, total_units_needed,
    unit_size, total_price, quantity_delivered, quantity_remaining
  ) VALUES (
    v_order_id, v_product_id, '[SMOKE] RCC Herbicide ' || v_suffix,
    10, 10, 'gal', 100, 10, 0
  ) RETURNING id INTO v_order_item_1;
  INSERT INTO order_items (
    order_id, product_id, product_name, price_per_unit, total_units_needed,
    unit_size, total_price, quantity_delivered, quantity_remaining
  ) VALUES (
    v_order_id, v_product_id, '[SMOKE] RCC Herbicide ' || v_suffix,
    10, 5, 'gal', 50, 5, 0
  ) RETURNING id INTO v_order_item_2;

  -- Keep the order's delivered totals backed by exact completed-delivery
  -- history so the governed cancel path reaches the received-return guard.
  INSERT INTO deliveries (
    delivery_number, order_id, customer_id, scheduled_date, status, created_by
  ) VALUES (
    'SMK-RCC-D-' || v_suffix, v_order_id, v_customer_id,
    current_date, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery_id;
  INSERT INTO delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES
    (v_delivery_id, v_order_item_1, v_product_id, 10, 10, 'gal'),
    (v_delivery_id, v_order_item_2, v_product_id, 5, 5, 'gal');
  UPDATE deliveries SET status = 'in_progress' WHERE id = v_delivery_id;
  UPDATE deliveries
     SET status = 'completed', completed_at = now(), signed_by = '[SMOKE] RCC Receiver'
   WHERE id = v_delivery_id;

  -- The migration closes both layers: there is no INSERT/FOR ALL RLS policy,
  -- and authenticated has no inherited direct INSERT table privilege.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.returns'::regclass
      AND polcmd IN ('a', '*')
  ) OR has_table_privilege('authenticated', 'public.returns', 'INSERT')
     OR has_table_privilege('anon', 'public.returns', 'INSERT') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: public.returns direct INSERT catalog boundary is open';
  END IF;
  IF NOT has_function_privilege(
    'authenticated', 'public.create_return(jsonb,jsonb,text)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated lost canonical create_return EXECUTE';
  END IF;

  -- A real active admin JWT still cannot bypass create_return with PostgREST's
  -- authenticated database role. Keep the role switch outside the denial block
  -- so a runner that cannot assume `authenticated` fails instead of passing for
  -- the wrong reason.
  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    INSERT INTO public.returns (
      return_number, customer_id, order_id, reason, requested_by, status
    ) VALUES (
      'SMK-DIRECT-' || v_suffix, v_customer_id, v_order_id,
      'overstock', v_admin, 'requested'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct return header INSERT was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected direct returns INSERT 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  -- A void already restores delivered inventory. The return path must reject
  -- that order or receiving the return could restore the same stock twice.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'voided' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  BEGIN
    PERFORM create_return(
      jsonb_build_object(
        'customer_id', v_customer_id, 'order_id', v_order_id,
        'reason', 'overstock'
      ),
      jsonb_build_array(jsonb_build_object(
        'order_item_id', v_order_item_1, 'quantity', 1,
        'condition', 'unopened', 'restock', true
      )),
      'smk-rcc-' || v_suffix || '-voided-create'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: return was created from a voided order';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_ORDER_INACTIVE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected inactive-order create rejection, got %', v_reason;
    END IF;
  END;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'confirmed' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- Caller-supplied product/price fields are deliberately false. The RPC must
  -- ignore them and derive two restockable lines worth $150 from the order.
  v_res := create_return(
    jsonb_build_object(
      'customer_id', v_customer_id, 'order_id', v_order_id,
      'reason', 'overstock'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'order_item_id', v_order_item_1, 'product_id', gen_random_uuid(),
        'quantity', 10, 'unit_price_cents', 1,
        'condition', 'unopened', 'restock', true, 'sort_order', 0
      ),
      jsonb_build_object(
        'order_item_id', v_order_item_2, 'product_id', gen_random_uuid(),
        'quantity', 5, 'unit_price_cents', 1,
        'condition', 'unopened', 'restock', true, 'sort_order', 1
      )
    ),
    'smk-rcc-' || v_suffix || '-create'
  );
  v_return_id := (v_res->>'return_id')::uuid;
  IF v_return_id IS NULL OR COALESCE((v_res->>'item_count')::int, 0) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_return returned %', v_res;
  END IF;
  SELECT count(*) INTO v_n
  FROM return_items
  WHERE return_id = v_return_id
    AND product_id = v_product_id
    AND unit_price_cents = 1000
    AND extended_cents IN (10000, 5000)
    AND order_item_id IN (v_order_item_1, v_order_item_2);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_return did not preserve authoritative order-line source (rows=%)', v_n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.return_items'::regclass
      AND polcmd IN ('a', 'w', 'd', '*')
  ) OR has_table_privilege('authenticated', 'public.return_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.return_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.return_items', 'DELETE')
     OR has_table_privilege('anon', 'public.return_items', 'INSERT')
     OR has_table_privilege('anon', 'public.return_items', 'UPDATE')
     OR has_table_privilege('anon', 'public.return_items', 'DELETE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: public.return_items direct mutation catalog boundary is open';
  END IF;

  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    UPDATE public.return_items
       SET notes = 'direct authenticated bypass'
     WHERE return_id = v_return_id;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct return_items UPDATE was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected direct return_items UPDATE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  BEGIN
    UPDATE returns SET customer_id = v_other_customer_id WHERE id = v_return_id;
    RAISE EXCEPTION 'SMOKE_FAIL: return customer source was mutable';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_IMMUTABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected immutable return-source rejection, got %', v_reason;
    END IF;
  END;
  SELECT customer_id INTO v_uuid FROM returns WHERE id = v_return_id;
  IF v_uuid IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected customer retarget changed return source to %', v_uuid;
  END IF;

  -- --------------------------------------------------------------------
  -- 2. approve_return: requested -> approved
  -- --------------------------------------------------------------------
  v_res := approve_return(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-approve');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: approve_return returned %', v_res;
  END IF;
  SELECT status INTO v_status FROM returns WHERE id = v_return_id;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return status after approve = %, expected approved', v_status;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'partially_fulfilled' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- --------------------------------------------------------------------
  -- 3. receive_return: approved -> received; restock 15 units
  -- --------------------------------------------------------------------
  v_res := receive_return(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-receive');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'received'
     OR COALESCE((v_res->>'restocked_count')::int, -1) <> 2
     OR COALESCE((v_res->>'skipped_count')::int, -1) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: receive_return returned % (expected received, 2 restocked, 0 skipped)', v_res;
  END IF;

  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory_id;
  IF v_qty IS DISTINCT FROM 115 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory after restock = %, expected 115 (100 + 10 + 5)', v_qty;
  END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE product_id = v_product_id AND transaction_type = 'returned';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 2 ''returned'' inventory_transactions, found %', v_n;
  END IF;
  SELECT received_by INTO v_by FROM returns WHERE id = v_return_id;
  IF v_by IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL: received return actor = %, expected %', v_by, v_admin;
  END IF;
  SELECT count(*) INTO v_n FROM inventory_transactions
  WHERE product_id = v_product_id
    AND transaction_type = 'returned'
    AND performed_by IS DISTINCT FROM v_admin;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % returned inventory transaction(s) lost actor attribution', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM return_items
  WHERE return_id = v_return_id AND restocked = false;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % return_items still flagged restocked=false after receive', v_n;
  END IF;

  -- Terminal order paths must refuse every received return, even if line flags
  -- say non-restockable/not-restocked. Otherwise void restores delivered stock
  -- or cancel strands the return without a valid credit source.
  UPDATE return_items
     SET restock = false, restocked = false
   WHERE return_id = v_return_id;
  BEGIN
    PERFORM void_order(
      v_order_id, v_admin, 'smoke restocked-return guard',
      'smk-rcc-' || v_suffix || '-void-after-receive'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: order with a received non-restock return was voided';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'ORDER_HAS_RECEIVED_RETURN%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected received-return void rejection, got %', v_reason;
    END IF;
  END;
  BEGIN
    PERFORM cancel_order(
      v_order_id, v_admin, 'smk-rcc-' || v_suffix || '-cancel-after-receive'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: order with a received non-restock return was cancelled';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'ORDER_HAS_RECEIVED_RETURN%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected received-return cancel rejection, got %', v_reason;
    END IF;
  END;
  UPDATE return_items
     SET restock = true, restocked = true
   WHERE return_id = v_return_id;
  UPDATE orders SET status = 'fulfilled' WHERE id = v_order_id;
  SELECT quantity_available INTO v_qty FROM inventory WHERE id = v_inventory_id;
  IF v_qty IS DISTINCT FROM 115 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected order void changed inventory to %, expected 115', v_qty;
  END IF;

  -- A return may be received before its source order is later voided. Credit
  -- issuance must re-check the order and refuse that now-invalid money path.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'voided' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  BEGIN
    PERFORM issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-voided-credit');
    RAISE EXCEPTION 'SMOKE_FAIL: return credit was issued after source order void';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_ORDER_INACTIVE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected inactive-order credit rejection, got %', v_reason;
    END IF;
  END;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET status = 'fulfilled' WHERE id = v_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- A legacy/service-role price mutation must be caught before the credit RPC
  -- delegates to the historical implementation that sums extended_cents.
  UPDATE return_items
     SET unit_price_cents = 1, extended_cents = 10
   WHERE return_id = v_return_id AND order_item_id = v_order_item_1;
  BEGIN
    PERFORM issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-tampered');
    RAISE EXCEPTION 'SMOKE_FAIL: tampered return price was credited';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_NOT_VERIFIED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected RETURN_SOURCE_NOT_VERIFIED, got %', v_reason;
    END IF;
  END;
  UPDATE return_items
     SET unit_price_cents = 1000, extended_cents = 10000
   WHERE return_id = v_return_id AND order_item_id = v_order_item_1;

  -- --------------------------------------------------------------------
  -- 4. issue_return_credit: received -> credited; posted credit_memo
  -- --------------------------------------------------------------------
  v_res := issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-issue');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'credit_amount_cents')::bigint, 0) <> 15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: issue_return_credit returned % (expected success, 15000 cents)', v_res;
  END IF;
  v_credit_id  := (v_res->>'credit_invoice_id')::uuid;
  v_credit_num := v_res->>'credit_invoice_number';

  -- the credit memo invoice: posted, negative total, carries order + salesman
  SELECT status, total_amount_cents, balance_cents, order_id, salesman_id
  INTO v_status, v_cents, v_stmt_sum, v_uuid, v_by
  FROM invoices WHERE id = v_credit_id AND invoice_type = 'credit_memo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit memo invoice % not found / wrong type', v_credit_id;
  END IF;
  IF v_status <> 'posted' OR v_cents <> -15000 OR v_stmt_sum <> -15000
     OR v_uuid IS DISTINCT FROM v_order_id OR v_by IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit memo wrong: status=%, total=%, balance=%, order=%, salesman=%',
      v_status, v_cents, v_stmt_sum, v_uuid, v_by;
  END IF;

  -- the return: credited, amount + linkage + credited_by stamped (the
  -- missing-credited_by-column class that broke B1 end-to-end)
  SELECT status, total_credit_cents, credit_invoice_id, credited_by, credited_at
  INTO v_status, v_cents, v_uuid, v_by, v_ts
  FROM returns WHERE id = v_return_id;
  IF v_status <> 'credited' OR v_cents <> 15000 OR v_uuid IS DISTINCT FROM v_credit_id
     OR v_by IS DISTINCT FROM v_admin OR v_ts IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return after issue: status=%, credit_cents=%, invoice=%, credited_by=%, credited_at=%',
      v_status, v_cents, v_uuid, v_by, v_ts;
  END IF;

  -- both financial_audit_log rows landed
  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'credit_memo_created' AND entity_type = 'credit_memo' AND entity_id = v_credit_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit_memo_created audit rows = % (expected 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'return_credit_issued' AND entity_type = 'return' AND entity_id = v_return_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return_credit_issued audit rows = % (expected 1)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. Idempotent REPLAY: same key returns the cache, no second memo
  -- --------------------------------------------------------------------
  v_res2 := issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-issue');
  IF (v_res2->>'credit_invoice_id')::uuid IS DISTINCT FROM v_credit_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay returned a DIFFERENT credit memo: % vs %',
      v_res2->>'credit_invoice_id', v_credit_id;
  END IF;
  SELECT count(*) INTO v_n FROM invoices
  WHERE customer_id = v_customer_id AND invoice_type = 'credit_memo';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay created a duplicate credit memo (count = %)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 6. Statement: the credit appears EXACTLY ONCE (the B2 double-count class)
  --    Synthetic customer => the credit memo is the ONLY statement row, so
  --    total row count and running balance also pin the single-count.
  -- --------------------------------------------------------------------
  SELECT count(*) FILTER (WHERE transaction_type = 'credit' AND reference_number = v_credit_num),
         count(*),
         COALESCE(SUM(amount_cents), 0)
  INTO v_credit_rows, v_total_rows, v_stmt_sum
  FROM get_customer_statement(v_customer_id, (CURRENT_DATE - 7)::date, CURRENT_DATE);
  IF v_credit_rows <> 1 OR v_total_rows <> 1 OR v_stmt_sum <> -15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after issue: credit_rows=%, total_rows=%, sum=% (expected 1/1/-15000 - credit must appear EXACTLY once)',
      v_credit_rows, v_total_rows, v_stmt_sum;
  END IF;

  -- --------------------------------------------------------------------
  -- 7. unapply_credit_memo: void the memo, revert the return to received
  -- --------------------------------------------------------------------
  v_res := unapply_credit_memo(v_credit_id, '[SMOKE] chain unapply', v_admin,
                               'smk-rcc-' || v_suffix || '-unapply');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'return_reverted')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unapply_credit_memo returned %', v_res;
  END IF;

  SELECT status, voided_by, void_reason INTO v_status, v_by, v_reason
  FROM invoices WHERE id = v_credit_id;
  IF v_status <> 'voided' OR v_by IS DISTINCT FROM v_admin OR v_reason IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: memo after unapply: status=%, voided_by=%, reason=%', v_status, v_by, v_reason;
  END IF;

  -- the B1 regression surface: total_credit_cents must be 0 (NOT NULL col),
  -- linkage + credited_by/at cleared, status legally back to received
  SELECT status, total_credit_cents, credit_invoice_id, credited_by, credited_at
  INTO v_status, v_cents, v_uuid, v_by, v_ts
  FROM returns WHERE id = v_return_id;
  IF v_status <> 'received' OR v_cents IS DISTINCT FROM 0 OR v_uuid IS NOT NULL
     OR v_by IS NOT NULL OR v_ts IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: return after unapply: status=%, credit_cents=%, invoice=%, credited_by=%, credited_at=%',
      v_status, v_cents, v_uuid, v_by, v_ts;
  END IF;

  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'credit_memo_unapplied' AND entity_type = 'invoice' AND entity_id = v_credit_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit_memo_unapplied audit rows = % (expected 1)', v_n;
  END IF;

  -- statement count back to ZERO (voided memos must drop out)
  SELECT count(*) INTO v_total_rows
  FROM get_customer_statement(v_customer_id, (CURRENT_DATE - 7)::date, CURRENT_DATE);
  IF v_total_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after unapply still has % row(s) - voided credit memo is leaking into AR', v_total_rows;
  END IF;

  -- --------------------------------------------------------------------
  -- 8. RE-ISSUE after unapply (received -> credited again must be legal);
  --    statement back to exactly one credit
  -- --------------------------------------------------------------------
  v_res := issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-reissue');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-issue after unapply failed: %', v_res;
  END IF;
  v_credit_id2  := (v_res->>'credit_invoice_id')::uuid;
  v_credit_num2 := v_res->>'credit_invoice_number';
  IF v_credit_id2 IS NOT DISTINCT FROM v_credit_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-issue reused the voided credit memo id %', v_credit_id;
  END IF;

  SELECT count(*) FILTER (WHERE transaction_type = 'credit' AND reference_number = v_credit_num2),
         count(*),
         COALESCE(SUM(amount_cents), 0)
  INTO v_credit_rows, v_total_rows, v_stmt_sum
  FROM get_customer_statement(v_customer_id, (CURRENT_DATE - 7)::date, CURRENT_DATE);
  IF v_credit_rows <> 1 OR v_total_rows <> 1 OR v_stmt_sum <> -15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after re-issue: credit_rows=%, total_rows=%, sum=% (expected 1/1/-15000)',
      v_credit_rows, v_total_rows, v_stmt_sum;
  END IF;

  -- --------------------------------------------------------------------
  -- 9. One-time legacy compatibility is pinned to the exact production RMA
  --    and immutable line values. Any other source-free row -- even one
  --    backdated before the hardening boundary -- must remain blocked.
  -- --------------------------------------------------------------------
  v_legacy_return_id := '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM returns
    WHERE id = v_legacy_return_id AND status = 'approved' AND order_id IS NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: exact legacy RMA is not in the expected approved state';
  END IF;

  v_res := receive_return(
    v_legacy_return_id, v_admin, 'smk-rcc-' || v_suffix || '-legacy-receive'
  );
  IF v_res->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legacy receive returned %', v_res;
  END IF;
  v_res := issue_return_credit(
    v_legacy_return_id, v_admin, 'smk-rcc-' || v_suffix || '-legacy-credit'
  );
  IF COALESCE((v_res->>'credit_amount_cents')::bigint, 0) <> 113955 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legacy credit returned % (expected 113955 cents)', v_res;
  END IF;

  PERFORM set_config('app.return_rpc', 'true', true);
  INSERT INTO returns (
    return_number, customer_id, order_id, reason, requested_by, status,
    approved_by, approved_at, created_at
  ) VALUES (
    'SMK-FORGED-LEGACY-' || v_suffix, v_customer_id, NULL, 'overstock', v_admin,
    'approved', v_admin, now(), timestamptz '2026-04-30 20:48:18+00'
  ) RETURNING id INTO v_future_unlinked_return_id;
  INSERT INTO return_items (
    return_id, order_item_id, product_id, product_name, quantity, unit,
    unit_price_cents, extended_cents, condition, restock
  ) VALUES (
    v_future_unlinked_return_id, NULL, v_product_id, '[SMOKE] forbidden source-free line',
    1, 'gal', 7597, 7597, 'unopened', true
  );
  BEGIN
    PERFORM receive_return(
      v_future_unlinked_return_id, v_admin, 'smk-rcc-' || v_suffix || '-forged-legacy-unlinked'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: new source-free return was received';
  EXCEPTION WHEN OTHERS THEN
    v_reason := SQLERRM;
    IF v_reason LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_reason NOT LIKE 'RETURN_SOURCE_NOT_VERIFIED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected source-free receive rejection, got %', v_reason;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- Full chain passed - force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
