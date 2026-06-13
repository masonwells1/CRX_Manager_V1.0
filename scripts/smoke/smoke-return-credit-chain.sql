-- ============================================================================
-- SMOKE TEST (rolled back by design): the CANONICAL return->credit chain
-- ----------------------------------------------------------------------------
-- THE CHAIN (the exact one B1 was falsely declared "fixed" without, 2026-06-09):
--   create return (direct insert - no create-RPC exists; the UI inserts
--   returns + return_items directly)
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
  v_product_id   uuid;
  v_inventory_id uuid;
  v_order_id     uuid;
  v_return_id    uuid;
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

  -- The return itself: no create-RPC exists; mirror the UI's direct insert.
  -- status defaults 'requested'; 'overstock' is in returns_reason_check;
  -- requested_by FKs auth.users (a real profile id satisfies it).
  INSERT INTO returns (return_number, order_id, customer_id, reason, requested_by)
  VALUES ('SMK-RCC-RET-' || v_suffix, v_order_id, v_customer_id, 'overstock', v_admin)
  RETURNING id INTO v_return_id;

  -- Two restockable lines: 10 @ $10.00 + 5 @ $10.00 = $150.00 credit
  INSERT INTO return_items (return_id, product_id, product_name, quantity,
    unit, unit_price_cents, extended_cents, condition, restock, sort_order)
  VALUES
    (v_return_id, v_product_id, '[SMOKE] RCC Herbicide ' || v_suffix, 10, 'gal', 1000, 10000, 'unopened', true, 0),
    (v_return_id, v_product_id, '[SMOKE] RCC Herbicide ' || v_suffix, 5,  'gal', 1000, 5000,  'unopened', true, 1);

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
  SELECT count(*) INTO v_n FROM return_items
  WHERE return_id = v_return_id AND restocked = false;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % return_items still flagged restocked=false after receive', v_n;
  END IF;

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
  -- Full chain passed - force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
