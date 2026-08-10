-- ============================================================================
-- ROLLED-BACK smoke test for commission_payment_for_update_fix
-- (create_commission_payment: 0A000 FOR UPDATE + DISTINCT fix)
-- ----------------------------------------------------------------------------
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture row created here is rolled back — nothing persists (the
-- only side effect is an advisory xact lock + payment numbers computed by
-- next_commission_payment_number, both transaction-scoped). ANY other
-- exception text = a real failure.
--
-- Auth: create_commission_payment derives the actor from auth.uid(), which
-- reads request.jwt.claims — injected below via set_config(..., true) using a
-- real active admin profile id (live as of 2026-06-10:
-- 0b03fc35-49b5-454c-b7ca-eb56b20e8a5e; looked up dynamically so the smoke
-- survives personnel changes). Direct fixture INSERTs bypass RLS because we
-- run as the table owner; the RPC under test still enforces its own
-- auth/strict-actor/is_admin gates.
--
-- Scenarios:
--   (a) happy path: 2 [SMOKE] pending commissions (123.45 + 76.55 dollars,
--       same recipient) -> create_commission_payment -> batch created with
--       status='unposted', total_amount=200.00, 2 items with matching
--       amounts, season=compute_season(today), audit row with
--       total_impact_cents=20000. Before the fix this call crashed 0A000.
--   (b) double-pay guard: same commission ids again -> must raise
--       'already in an existing (non-voided) payment' (proves the
--       relocated lock did not orphan the duplicate-payment check).
--   (c) idempotency replay: 3rd [SMOKE] commission paid with a key, replayed
--       with the same key -> same payment id back, exactly 1 payment item.
--   (d) concurrent-shape sanity (static, via prosrc): the FOR UPDATE lock
--       sits ABOVE both the already-in-payment check and the recipient read,
--       so the locking covers every commission row the body reads; no
--       SELECT DISTINCT remains; exactly 1 overload. (True 2-session
--       concurrency is not testable inside one DO block; the loser-blocks-
--       then-sees-winner behaviour follows from lock-before-check under
--       READ COMMITTED, which (d) pins structurally and (b) pins
--       sequentially.)
--
-- Dry-validated references (live catalog, 2026-06-10 — the 42703 discipline):
--   profiles(id, role, is_active, created_at, full_name)
--   customers(id, farm_name NOT NULL)
--   orders(id, order_number NOT NULL UNIQUE, customer_id NOT NULL,
--          status default 'confirmed' — no insert triggers)
--   commissions(id, order_id NN, customer_id NN, recipient NN default '',
--          split_percentage NN, commission_amount NN numeric dollars >= 0,
--          order_profit NN, status CHECK in (pending|paid|cancelled),
--          recipient_user_id FK profiles — no triggers, no unique on
--          anything but pkey)
--   commission_payments(id, payment_number NN UNIQUE, recipient_id NN,
--          total_amount numeric dollars, status CHECK in
--          (unposted|posted|voided), payment_method, reference_number,
--          payment_date NN default, notes, season, created_by)
--   commission_payment_items(id, commission_payment_id NN, commission_id NN,
--          amount NN — NO unique index on commission_id)
--   financial_audit_log(operation_type CHECK incl.
--          'commission_payment_created', entity_type CHECK incl.
--          'commission_payment', entity_id NN, actor_user_id NN default
--          auth.uid() + trg_fill_audit_actor BEFORE INSERT,
--          total_impact_cents bigint, description)
--   idempotency_keys(idempotency_key, operation, result) [via helpers]
--   accounting_periods(status, period_start, period_end)
--          [via check_period_open; 0 closed periods cover CURRENT_DATE live]
--   pg_proc(proname, pronamespace, prosrc)
--   functions: public.create_commission_payment(uuid[],text,text,date,text,
--          uuid,text) [1 overload], check_idempotency(text,text),
--          save_idempotency(text,text,jsonb), check_period_open(date),
--          compute_season(date), next_commission_payment_number(),
--          is_admin(), auth.uid()
-- ============================================================================

DO $smoke$
DECLARE
  v_admin       uuid;
  v_suffix      text := substr(md5(random()::text), 1, 8);
  v_customer_id uuid;
  v_order_id    uuid;
  v_c1          uuid;
  v_c2          uuid;
  v_c3          uuid;
  v_payment_id  uuid;
  v_p2          uuid;
  v_p2_replay   uuid;
  v_status      text;
  v_recipient   uuid;
  v_total       numeric;
  v_season      int;
  v_created_by  uuid;
  v_pay_date    date;
  v_pay_num     text;
  v_item_count  int;
  v_item_sum    numeric;
  v_n           int;
  v_src         text;
  v_err         text;
  v_idem_key    text;
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

  -- --------------------------------------------------------------------
  -- 1. Synthetic [SMOKE] fixtures (txn-local; all rolled back at the end).
  --    The admin profile doubles as the commission recipient so no synthetic
  --    profile row is needed (profiles carries FK + role-lock constraints).
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] CPFU Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;

  INSERT INTO orders (order_number, customer_id)
  VALUES ('[SMOKE]-CPFU-' || v_suffix, v_customer_id)
  RETURNING id INTO v_order_id;

  INSERT INTO commissions (order_id, customer_id, recipient, split_percentage,
                           commission_amount, order_profit, status, recipient_user_id)
  VALUES (v_order_id, v_customer_id, '[SMOKE] CPFU Recipient', 50,
          123.45, 246.90, 'pending', v_admin)
  RETURNING id INTO v_c1;

  INSERT INTO commissions (order_id, customer_id, recipient, split_percentage,
                           commission_amount, order_profit, status, recipient_user_id)
  VALUES (v_order_id, v_customer_id, '[SMOKE] CPFU Recipient', 50,
          76.55, 153.10, 'pending', v_admin)
  RETURNING id INTO v_c2;

  INSERT INTO commissions (order_id, customer_id, recipient, split_percentage,
                           commission_amount, order_profit, status, recipient_user_id)
  VALUES (v_order_id, v_customer_id, '[SMOKE] CPFU Recipient', 50,
          50.00, 100.00, 'pending', v_admin)
  RETURNING id INTO v_c3;

  -- --------------------------------------------------------------------
  -- 2. Scenario (a): happy path — this exact call raised SQLSTATE 0A000
  --    before the fix.
  -- --------------------------------------------------------------------
  -- A key is REQUIRED since 20260810170000; passing NULL now raises
  -- IDEMPOTENCY_KEY_REQUIRED before any work happens. Each scenario below uses
  -- its OWN key so that what rejects a call is the guard the scenario is about,
  -- never an accidental replay of a previous scenario's receipt.
  v_payment_id := create_commission_payment(
    ARRAY[v_c1, v_c2], 'check', '[SMOKE] ref ' || v_suffix,
    CURRENT_DATE, '[SMOKE] cpfu notes', v_admin, '[SMOKE]-cpfu-a-' || v_suffix);

  IF v_payment_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): create_commission_payment returned NULL';
  END IF;

  SELECT status, recipient_id, total_amount, season, created_by, payment_date, payment_number
    INTO v_status, v_recipient, v_total, v_season, v_created_by, v_pay_date, v_pay_num
    FROM commission_payments WHERE id = v_payment_id;

  IF v_status IS DISTINCT FROM 'unposted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): batch status = %, expected unposted', v_status;
  END IF;
  IF v_total IS DISTINCT FROM 200.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): total_amount = %, expected 200.00', v_total;
  END IF;
  IF v_recipient IS DISTINCT FROM v_admin OR v_created_by IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): recipient_id/created_by mismatch (% / %)', v_recipient, v_created_by;
  END IF;
  IF v_pay_date IS DISTINCT FROM CURRENT_DATE THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): payment_date = %, expected today', v_pay_date;
  END IF;
  IF v_season IS DISTINCT FROM compute_season(CURRENT_DATE) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): season = %, expected %', v_season, compute_season(CURRENT_DATE);
  END IF;
  IF v_pay_num IS NULL OR v_pay_num NOT LIKE 'CP-%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): payment_number = %, expected CP-...', v_pay_num;
  END IF;

  SELECT count(*), sum(amount) INTO v_item_count, v_item_sum
    FROM commission_payment_items WHERE commission_payment_id = v_payment_id;
  IF v_item_count <> 2 OR v_item_sum IS DISTINCT FROM 200.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): items count/sum = %/%, expected 2/200.00', v_item_count, v_item_sum;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commission_payment_items
                 WHERE commission_payment_id = v_payment_id
                   AND commission_id = v_c1 AND amount = 123.45)
     OR NOT EXISTS (SELECT 1 FROM commission_payment_items
                 WHERE commission_payment_id = v_payment_id
                   AND commission_id = v_c2 AND amount = 76.55) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): per-commission item amounts do not match fixtures';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM financial_audit_log
    WHERE operation_type = 'commission_payment_created'
      AND entity_type = 'commission_payment'
      AND entity_id = v_payment_id
      AND total_impact_cents = 20000
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(a): audit row missing or wrong total_impact_cents';
  END IF;

  -- --------------------------------------------------------------------
  -- 3. Scenario (b): paying the SAME commissions again must be rejected by
  --    the (now lock-covered) already-in-payment check.
  -- --------------------------------------------------------------------
  v_err := NULL;
  BEGIN
    PERFORM create_commission_payment(
      ARRAY[v_c1, v_c2], 'check', '[SMOKE] dup ' || v_suffix,
      CURRENT_DATE, '[SMOKE] dup attempt', v_admin, '[SMOKE]-cpfu-b-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  IF v_err IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): duplicate payment over the same commissions was allowed';
  ELSIF v_err NOT LIKE '%already in an existing (non-voided) payment%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(b): expected already-in-payment rejection, got: %', v_err;
  END IF;

  -- --------------------------------------------------------------------
  -- 4. Scenario (c): idempotency replay returns the same batch, no dup items.
  -- --------------------------------------------------------------------
  v_idem_key := '[SMOKE]-cpfu-' || v_suffix;
  v_p2 := create_commission_payment(
    ARRAY[v_c3], 'check', '[SMOKE] idem ' || v_suffix,
    CURRENT_DATE, '[SMOKE] idem', v_admin, v_idem_key);
  v_p2_replay := create_commission_payment(
    ARRAY[v_c3], 'check', '[SMOKE] idem ' || v_suffix,
    CURRENT_DATE, '[SMOKE] idem', v_admin, v_idem_key);
  IF v_p2 IS NULL OR v_p2 IS DISTINCT FROM v_p2_replay THEN
    RAISE EXCEPTION 'SMOKE_FAIL(c): idempotent replay returned % vs %', v_p2, v_p2_replay;
  END IF;
  SELECT count(*) INTO v_n FROM commission_payment_items WHERE commission_id = v_c3;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(c): % payment items for the keyed commission, expected 1', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. Scenario (d): concurrent-shape sanity — the lock covers the rows the
  --    body reads, and the 0A000 shape is gone.
  -- --------------------------------------------------------------------
  SELECT count(*) INTO v_n
    FROM pg_proc
   WHERE proname = 'create_commission_payment'
     AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(d): overload count = %, expected 1', v_n;
  END IF;

  SELECT prosrc INTO v_src
    FROM pg_proc
   WHERE proname = 'create_commission_payment'
     AND pronamespace = 'public'::regnamespace;

  IF position('SELECT DISTINCT' IN v_src) > 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(d): SELECT DISTINCT still present in body';
  END IF;
  IF position('FOR UPDATE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(d): FOR UPDATE lock missing from body';
  END IF;
  -- lock above the already-in-payment check (first commission_payment_items
  -- reference) AND above the recipient read (the cpfu-2 sentinel)
  IF position('FOR UPDATE' IN v_src) > position('commission_payment_items' IN v_src)
     OR position('FOR UPDATE' IN v_src) > position('[DELTA cpfu-2 BEGIN]' IN v_src) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(d): lock does not cover the commission rows read by the body';
  END IF;

  -- --------------------------------------------------------------------
  -- Done — roll EVERYTHING back.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
