-- ============================================================================
-- SMOKE TEST (rolled back by design): get_customer_statement blind-spot fix
-- (CHIP task_25d25699; migration customer_statement_blind_spots)
-- ----------------------------------------------------------------------------
-- THE CHAIN (real producers, not isolated probes — the smoke-specs HARD RULE):
--   fixture customer + order
--     -> invoice A (posted, $500.00, no payment yet)
--     -> invoice B (order-linked) PAID via record_invoice_payment $300.00
--                    (the LEGACY payments-table path; payment backdated d-3)
--     -> invoice C (NO order — the transfer_job_to_invoice shape) PAID via
--                    record_invoice_payment $50.00 -> a NULL-order_id
--                    payments row (blind spot 4; backdated d-1)
--     -> allocate_payment $250.00: $200.00 allocated to invoice A +
--                    $50.00 overpayment -> prepay credit (the ALLOCATION
--                    path, allocation_sets only — blind spot 1; dated d-2)
--     -> soft-deleted payments row $99.00 (deleted_at set — blind spot 3)
--     -> posted credit_memo invoice -$150.00 (single-count regression guard)
--     -> get_customer_statement must show EXACTLY 7 lines:
--           d-6  invoice A   +50000                       -> 50000
--           d-5  invoice B   +30000  (status='paid'!)     -> 80000   (blind spot 2)
--           d-4  invoice C    +5000  (status='paid'!)     -> 85000   (blind spot 2)
--           d-3  payment     -30000  (legacy path)        -> 55000
--           d-2  payment     -20000  (allocation path;    -> 35000
--                                     NOT -25000 — prepay remainder is NOT
--                                     pre-counted: DEDUP RULE)
--           d-1  payment      -5000  (NULL-order path)    -> 30000
--           d-0  credit      -15000  (exactly once)       -> 15000
--        soft-deleted payment ABSENT; 0 prepay lines; running balance never
--        negative; final running balance 15000
--     -> allocate_payment idempotent REPLAY (same key): cached result, still
--        7 lines / same sum (no double-count, no second allocation set)
--     -> invoice A posted -> overdue: its line MUST survive (blind spot 2)
--     -> auth probe: unknown-sub JWT -> 'Access denied%'
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1 / run-smoke.mjs) as postgres/service_role. The DO
-- block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK', so every
-- fixture row created here is rolled back — nothing persists. ANY other
-- error text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims — injected via set_config(..., is_local => true) using a
-- REAL active admin profile id (3 exist live as of 2026-06-10). Direct
-- fixture INSERTs bypass RLS because we run as the table owner; the RPCs
-- under test still enforce their own auth/role gates.
--
-- Live-state preconditions (checked up front, raise SMOKE_SETUP if unmet):
--   * at least one active admin profile;
--   * no CLOSED accounting period overlapping [CURRENT_DATE-7, CURRENT_DATE]
--     (record_invoice_payment gates on now()::date, allocate_payment on its
--     p_payment_date = d-2).
--
-- DRY-VALIDATION (the 42703 discipline): every reference below was validated
-- against the LIVE catalog 2026-06-10 (pg_get_functiondef + information_schema
-- + pg_constraint + pg_trigger). 126 refs total:
--  * 13 functions: get_customer_statement(uuid,date,date),
--    record_invoice_payment(uuid,bigint,text,text,text,text),
--    allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text),
--    void_payment, update_allocation_set, transfer_job_to_invoice (path
--    evidence), enforce_invoice_draft_on_insert (draft-only INSERT gate;
--    credit_memo exempt), _enforce_invoice_status_transition (draft->posted,
--    posted->paid, posted->overdue all legal), _is_admin_override,
--    check_period_open, check_idempotency, save_idempotency,
--    next_invoice_number (avoided — explicit [SMOKE] invoice numbers).
--  * 94 table.columns:
--    profiles(id, role, is_active, created_at);
--    accounting_periods(status, period_start, period_end);
--    customers(id, farm_name, prepay_balance_cents, updated_at);
--    orders(id, order_number, customer_id, status DEFAULT 'confirmed',
--           order_date DEFAULT CURRENT_DATE, deleted_at);
--    invoices(id, invoice_number UNIQUE, customer_id, order_id, invoice_type,
--           status DEFAULT 'draft', season DEFAULT current_season(),
--           created_by, total_amount_cents, paid_amount_cents,
--           prepay_applied_cents, write_off_cents, balance_cents GENERATED,
--           invoice_date, deleted_at, updated_at);
--    payments(id, order_id NULLABLE, customer_id NOT NULL, payment_date
--           DEFAULT CURRENT_DATE, amount numeric DOLLARS, payment_method,
--           reference_number, notes, recorded_by, deleted_at; NO updated_at);
--    allocation_sets(id, entity_type, entity_id, version, customer_id,
--           total_payment_cents, total_allocated_cents, payment_method,
--           reference_number, check_number, payment_date, season, notes,
--           is_active, created_by, created_at, updated_at);
--    invoice_line_allocations(allocation_set_id, invoice_id, amount_cents,
--           bill_to_customer_id, split_percentage);
--    prepay_credits(id, customer_id, season, original_amount_cents,
--           balance_cents, source_type, source_reference, created_by);
--    prepay_applications(prepay_credit_id, applied_amount_cents, applied_at);
--    activity_feed(event_type, description, performed_by,
--           related_entity_type, related_entity_id, customer_id — NO CHECKs);
--    financial_audit_log(operation_type, entity_type, entity_id, actor_role,
--           actor_user_id, new_values, old_values, total_impact_cents,
--           description);
--    idempotency_keys(idempotency_key, operation, result).
--  * 11 CHECK constraints (invoices_status_check incl. 'paid'/'overdue';
--    invoices_balance/total/paid non-negative w/ credit_memo exemptions;
--    chk_payment_amount > 0; payments_payment_method_check;
--    allocation_sets_entity_type_check; ila_target_check;
--    financial_audit_log entity_type incl. 'allocation_set'+'payment' and
--    operation_type incl. 'payment_allocated'+'payment_recorded';
--    prepay_balance_non_negative).
--  * 8 triggers on invoices/orders (draft-insert gate, status enforcers,
--    updated_at, sync_blend_ticket_payment [no-op: no blend_ticket_id],
--    delete guards, order status change).
--
-- Known benign side effect: none — explicit [SMOKE] invoice numbers avoid
-- consuming the INV/CM number sequences.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin        uuid;
  v_suffix       text := substr(md5(random()::text), 1, 8);
  v_customer_id  uuid;
  v_order_id     uuid;
  v_inv_a        uuid;
  v_inv_b        uuid;
  v_inv_c        uuid;
  v_pay_legacy   uuid;
  v_pay_noord    uuid;
  v_set_id       uuid;
  v_res          jsonb;
  v_res2         jsonb;
  v_d0           date := CURRENT_DATE;
  v_d1           date := CURRENT_DATE - 1;
  v_d2           date := CURRENT_DATE - 2;
  v_d3           date := CURRENT_DATE - 3;
  v_d4           date := CURRENT_DATE - 4;
  v_d5           date := CURRENT_DATE - 5;
  v_d6           date := CURRENT_DATE - 6;
  v_d7           date := CURRENT_DATE - 7;
  v_status       text;
  v_cents        bigint;
  v_uuid         uuid;
  v_bool         boolean;
  v_date         date;
  v_n            int;
  v_rows         int;
  v_sum          bigint;
  v_pay_rows     int;
  v_inv_rows     int;
  v_credit_rows  int;
  v_prepay_rows  int;
  v_25k_rows     int;
  v_del_rows     int;
  v_min_rb       bigint;
  v_last_rb      bigint;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Preconditions + auth as a real active admin
  -- --------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE status = 'closed' AND period_start <= v_d0 AND period_end >= v_d7
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: a CLOSED accounting period overlaps [%, %] — payment RPCs cannot run', v_d7, v_d0;
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
  -- 1. Fixtures: customer, order, three real invoices (draft -> posted)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] CSB Statement Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;

  INSERT INTO orders (order_number, customer_id)
  VALUES ('SMK-CSB-ORD-' || v_suffix, v_customer_id)
  RETURNING id INTO v_order_id;

  -- Invoice A: stays posted; later partially paid by the ALLOCATION path
  INSERT INTO invoices (invoice_number, customer_id, order_id, invoice_type,
                        total_amount_cents, invoice_date, created_by)
  VALUES ('SMK-CSB-A-' || v_suffix, v_customer_id, v_order_id, 'chemical_sale',
          50000, v_d6, v_admin)
  RETURNING id INTO v_inv_a;

  -- Invoice B: order-linked; will be PAID via the LEGACY path
  INSERT INTO invoices (invoice_number, customer_id, order_id, invoice_type,
                        total_amount_cents, invoice_date, created_by)
  VALUES ('SMK-CSB-B-' || v_suffix, v_customer_id, v_order_id, 'chemical_sale',
          30000, v_d5, v_admin)
  RETURNING id INTO v_inv_b;

  -- Invoice C: NO order (the transfer_job_to_invoice shape); will be PAID,
  -- producing a NULL-order_id payments row
  INSERT INTO invoices (invoice_number, customer_id, invoice_type,
                        total_amount_cents, invoice_date, created_by)
  VALUES ('SMK-CSB-C-' || v_suffix, v_customer_id, 'field_application',
          5000, v_d4, v_admin)
  RETURNING id INTO v_inv_c;

  -- draft -> posted (legal enforcer transition, one row at a time)
  UPDATE invoices SET status = 'posted' WHERE id = v_inv_a;
  UPDATE invoices SET status = 'posted' WHERE id = v_inv_b;
  UPDATE invoices SET status = 'posted' WHERE id = v_inv_c;

  -- --------------------------------------------------------------------
  -- 2. (a) LEGACY path: record_invoice_payment fully pays invoice B
  -- --------------------------------------------------------------------
  v_pay_legacy := record_invoice_payment(v_inv_b, 30000, 'check',
                    'SMK-CSB-LEGACY-' || v_suffix, '[SMOKE] legacy path',
                    'smk-csb-' || v_suffix || '-legacy');

  SELECT status, paid_amount_cents INTO v_status, v_cents FROM invoices WHERE id = v_inv_b;
  IF v_status <> 'paid' OR v_cents <> 30000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice B after legacy payment: status=%, paid=% (expected paid/30000)', v_status, v_cents;
  END IF;
  SELECT order_id INTO v_uuid FROM payments WHERE id = v_pay_legacy;
  IF v_uuid IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legacy payment order_id=% (expected the fixture order)', v_uuid;
  END IF;
  -- backdate for deterministic statement ordering (payments has NO updated_at)
  UPDATE payments SET payment_date = v_d3 WHERE id = v_pay_legacy;

  -- --------------------------------------------------------------------
  -- 3. (a2) NULL-order path: record_invoice_payment fully pays invoice C —
  --     payments.order_id IS NULL (blind spot 4)
  -- --------------------------------------------------------------------
  v_pay_noord := record_invoice_payment(v_inv_c, 5000, 'ach',
                   'SMK-CSB-NOORD-' || v_suffix, '[SMOKE] null-order path',
                   'smk-csb-' || v_suffix || '-noord');

  SELECT order_id INTO v_uuid FROM payments WHERE id = v_pay_noord;
  IF v_uuid IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: null-order payment unexpectedly has order_id=%', v_uuid;
  END IF;
  SELECT status INTO v_status FROM invoices WHERE id = v_inv_c;
  IF v_status <> 'paid' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice C after payment: status=% (expected paid)', v_status;
  END IF;
  UPDATE payments SET payment_date = v_d1 WHERE id = v_pay_noord;

  -- --------------------------------------------------------------------
  -- 4. (b) ALLOCATION path: allocate_payment $250.00 -> $200.00 to invoice A
  --     + $50.00 overpayment prepay credit. NO payments row is created.
  -- --------------------------------------------------------------------
  v_res := allocate_payment(
    v_customer_id, 25000, 'check',
    'SMK-CSB-ALLOC-' || v_suffix, 'SMK-CHK-' || v_suffix, v_d2,
    '[SMOKE] allocation path',
    jsonb_build_array(jsonb_build_object('invoice_id', v_inv_a, 'amount_cents', 20000)),
    v_admin, 'smk-csb-' || v_suffix || '-alloc');

  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'total_allocated_cents')::bigint, -1) <> 20000
     OR COALESCE((v_res->>'prepay_created_cents')::bigint, -1) <> 5000
     OR COALESCE((v_res->>'invoices_paid')::int, -1) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: allocate_payment returned % (expected success, 20000 allocated, 5000 prepay, 1 invoice)', v_res;
  END IF;
  v_set_id := (v_res->>'allocation_set_id')::uuid;

  SELECT is_active, customer_id, total_payment_cents, total_allocated_cents, payment_date
  INTO v_bool, v_uuid, v_cents, v_sum, v_date
  FROM allocation_sets WHERE id = v_set_id;
  IF v_bool IS NOT TRUE OR v_uuid IS DISTINCT FROM v_customer_id
     OR v_cents <> 25000 OR v_sum <> 20000 OR v_date <> v_d2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: allocation set wrong: active=%, customer=%, total=%, allocated=%, date=%',
      v_bool, v_uuid, v_cents, v_sum, v_date;
  END IF;
  SELECT status, paid_amount_cents INTO v_status, v_cents FROM invoices WHERE id = v_inv_a;
  IF v_status <> 'posted' OR v_cents <> 20000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice A after allocation: status=%, paid=% (expected posted/20000)', v_status, v_cents;
  END IF;
  SELECT count(*), COALESCE(SUM(balance_cents), 0) INTO v_n, v_cents
  FROM prepay_credits WHERE customer_id = v_customer_id AND source_type = 'overpayment';
  IF v_n <> 1 OR v_cents <> 5000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: overpayment prepay credit: count=%, balance=% (expected 1/5000)', v_n, v_cents;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. (d) soft-deleted payment — must be EXCLUDED (blind spot 3)
  -- --------------------------------------------------------------------
  INSERT INTO payments (order_id, customer_id, payment_date, amount,
                        payment_method, reference_number, recorded_by, deleted_at)
  VALUES (v_order_id, v_customer_id, v_d1, 99.00,
          'cash', 'SMK-CSB-DEL-' || v_suffix, v_admin, now());

  -- --------------------------------------------------------------------
  -- 6. Credit memo (posted on insert — draft-insert trigger exempts
  --    credit_memo): the existing single-count assertion
  -- --------------------------------------------------------------------
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status,
                        total_amount_cents, invoice_date, created_by)
  VALUES ('SMK-CSB-CM-' || v_suffix, v_customer_id, 'credit_memo', 'posted',
          -15000, v_d0, v_admin);

  -- --------------------------------------------------------------------
  -- 7. THE STATEMENT: 7 lines, each source exactly once, dedup pinned,
  --    deleted payment absent, balance never negative
  -- --------------------------------------------------------------------
  SELECT count(*),
         COALESCE(SUM(amount_cents), 0),
         count(*) FILTER (WHERE transaction_type = 'payment'),
         count(*) FILTER (WHERE transaction_type = 'invoice'),
         count(*) FILTER (WHERE transaction_type = 'credit'),
         count(*) FILTER (WHERE transaction_type = 'prepay'),
         count(*) FILTER (WHERE amount_cents = -25000),
         count(*) FILTER (WHERE reference_number = 'SMK-CSB-DEL-' || v_suffix),
         COALESCE(MIN(running_balance), -1)
  INTO v_rows, v_sum, v_pay_rows, v_inv_rows, v_credit_rows, v_prepay_rows,
       v_25k_rows, v_del_rows, v_min_rb
  FROM get_customer_statement(v_customer_id, v_d7, v_d0);

  IF v_rows <> 7 OR v_sum <> 15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement rows=%, sum=% (expected 7 rows summing 15000)', v_rows, v_sum;
  END IF;
  IF v_inv_rows <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice lines=% (expected 3 — the PAID invoices B and C must still appear)', v_inv_rows;
  END IF;
  IF v_pay_rows <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: payment lines=% (expected 3: legacy + allocation + null-order, each ONCE)', v_pay_rows;
  END IF;
  IF v_credit_rows <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit lines=% (expected exactly 1 — single-count regression)', v_credit_rows;
  END IF;
  IF v_prepay_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: prepay lines=% (expected 0 — unapplied overpayment must NOT appear)', v_prepay_rows;
  END IF;
  IF v_25k_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: found a -25000 line — allocation payment counted at total_payment_cents (prepay remainder double-count; DEDUP RULE violated)';
  END IF;
  IF v_del_rows <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: soft-deleted payment leaked into the statement';
  END IF;
  IF v_min_rb < 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: running balance went negative (min=%) — orphan-line class', v_min_rb;
  END IF;

  -- each payment line exactly once, with the right ref + amount
  SELECT count(*) INTO v_n FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  WHERE transaction_type = 'payment' AND amount_cents = -30000
    AND reference_number = 'SMK-CSB-LEGACY-' || v_suffix;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legacy payment line count=% (expected 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  WHERE transaction_type = 'payment' AND amount_cents = -20000
    AND reference_number = 'SMK-CSB-ALLOC-' || v_suffix;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: allocation payment line count=% (expected 1 at -20000)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  WHERE transaction_type = 'payment' AND amount_cents = -5000
    AND reference_number = 'SMK-CSB-NOORD-' || v_suffix;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: null-order payment line count=% (expected 1)', v_n;
  END IF;
  -- the PAID invoices' charge lines (blind spot 2) + the credit, by ref
  SELECT count(*) INTO v_n FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  WHERE transaction_type = 'invoice' AND reference_number = 'SMK-CSB-B-' || v_suffix AND amount_cents = 30000;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: PAID invoice B line count=% (expected 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  WHERE transaction_type = 'invoice' AND reference_number = 'SMK-CSB-C-' || v_suffix AND amount_cents = 5000;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: PAID invoice C line count=% (expected 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  WHERE transaction_type = 'credit' AND reference_number = 'SMK-CSB-CM-' || v_suffix AND amount_cents = -15000;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit memo line count=% (expected 1)', v_n;
  END IF;
  -- final running balance
  SELECT running_balance INTO v_last_rb
  FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  ORDER BY transaction_date DESC, transaction_type DESC LIMIT 1;
  IF v_last_rb <> 15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: final running balance=% (expected 15000)', v_last_rb;
  END IF;

  -- --------------------------------------------------------------------
  -- 8. Idempotent REPLAY of allocate_payment (same key): cached result,
  --    no second allocation set, statement unchanged
  -- --------------------------------------------------------------------
  v_res2 := allocate_payment(
    v_customer_id, 25000, 'check',
    'SMK-CSB-ALLOC-' || v_suffix, 'SMK-CHK-' || v_suffix, v_d2,
    '[SMOKE] allocation path',
    jsonb_build_array(jsonb_build_object('invoice_id', v_inv_a, 'amount_cents', 20000)),
    v_admin, 'smk-csb-' || v_suffix || '-alloc');
  IF (v_res2->>'allocation_set_id')::uuid IS DISTINCT FROM v_set_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay returned a DIFFERENT allocation set: % vs %',
      v_res2->>'allocation_set_id', v_set_id;
  END IF;
  SELECT count(*) INTO v_n FROM allocation_sets
  WHERE customer_id = v_customer_id AND entity_type = 'payment';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay created a duplicate allocation set (count=%)', v_n;
  END IF;
  SELECT count(*), COALESCE(SUM(amount_cents), 0) INTO v_rows, v_sum
  FROM get_customer_statement(v_customer_id, v_d7, v_d0);
  IF v_rows <> 7 OR v_sum <> 15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after replay: rows=%, sum=% (expected unchanged 7/15000)', v_rows, v_sum;
  END IF;

  -- --------------------------------------------------------------------
  -- 9. OVERDUE invoice survives on the statement (blind spot 2, other arm)
  -- --------------------------------------------------------------------
  UPDATE invoices SET status = 'overdue' WHERE id = v_inv_a;  -- posted->overdue: legal
  SELECT count(*), COALESCE(SUM(amount_cents), 0) INTO v_rows, v_sum
  FROM get_customer_statement(v_customer_id, v_d7, v_d0);
  IF v_rows <> 7 OR v_sum <> 15000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement after overdue flip: rows=%, sum=% (overdue invoice dropped?)', v_rows, v_sum;
  END IF;
  SELECT count(*) INTO v_n FROM get_customer_statement(v_customer_id, v_d7, v_d0)
  WHERE transaction_type = 'invoice' AND reference_number = 'SMK-CSB-A-' || v_suffix;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: OVERDUE invoice A line count=% (expected 1)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 10. Auth probe: unknown sub must be rejected by the in-body gate
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  v_bool := false;  -- did the gate fire?
  BEGIN
    PERFORM * FROM get_customer_statement(v_customer_id, v_d7, v_d0);
  EXCEPTION
    WHEN OTHERS THEN
      v_bool := true;
      IF SQLERRM NOT LIKE 'Access denied%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: expected Access denied for unknown actor, got: %', SQLERRM;
      END IF;
  END;
  IF NOT v_bool THEN
    RAISE EXCEPTION 'SMOKE_FAIL: statement callable with an unknown actor (role gate gone)';
  END IF;
  -- restore admin claims (tidiness; everything rolls back anyway)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- Full chain passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
