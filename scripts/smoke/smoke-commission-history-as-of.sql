-- Real-path rollback proof for 20260903150100_ledger_backed_commission_history.
-- Every fixture is [E2E]-tagged and the terminal exception rolls back all rows.

DO $smoke$
DECLARE
  v_admin uuid := 'c011ec70-0000-4000-8000-000000000001';
  v_admin_two uuid := 'c011ec70-0000-4000-8000-000000000002';
  v_customer uuid;
  v_order uuid;
  v_commission uuid;
  v_cancel_order uuid;
  v_cancel_commission uuid;
  v_payment uuid;
  v_today date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_before date := (transaction_timestamp() AT TIME ZONE 'America/Chicago')::date - 1;
  v_suffix text := substr(md5(random()::text), 1, 10);
  v_balance record;
  v_detail_count bigint;
  v_detail_amount numeric;
  v_failed boolean;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    v_admin,
    'e2e-commission-history-' || v_suffix || '@example.invalid',
    jsonb_build_object('full_name', '[E2E] Commission History Admin', 'role', 'admin'),
    now(), now()
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (
    v_admin,
    'e2e-commission-history-' || v_suffix || '@example.invalid',
    '[E2E] Commission History Admin', 'admin', true
  ) ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name, role = 'admin', is_active = true;

  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    v_admin_two,
    'e2e-commission-history-two-' || v_suffix || '@example.invalid',
    jsonb_build_object('full_name', '[E2E] Commission History Admin Two', 'role', 'admin'),
    now(), now()
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (
    v_admin_two,
    'e2e-commission-history-two-' || v_suffix || '@example.invalid',
    '[E2E] Commission History Admin Two', 'admin', true
  ) ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name, role = 'admin', is_active = true;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[E2E] Commission History Farm ' || v_suffix, v_admin)
  RETURNING id INTO v_customer;

  INSERT INTO public.orders (
    order_number, customer_id, salesman_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-COMM-HIST-' || v_suffix, v_customer, v_admin,
    v_today - 3, 'confirmed', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES (
    v_order, v_customer, '[E2E] Commission History Admin', v_admin,
    100, 100.00, 100.00, v_today - 3, 'pending'
  ) RETURNING id INTO v_commission;

  IF NOT EXISTS (
    SELECT 1 FROM public.commission_earned_state_ledger
     WHERE commission_id = v_commission AND event_kind = 'inserted'
       AND recipient_id = v_admin
       AND recipient_name = '[E2E] Commission History Admin'
       AND source_number = 'E2E-COMM-HIST-' || v_suffix
       AND customer_name = '[E2E] Commission History Farm ' || v_suffix
       AND amount_cents = 10000 AND is_earned
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: commission insert did not append the exact earned-state snapshot';
  END IF;

  -- Owner-only rollback fixture: model this row's reviewed opening restatement
  -- one day earlier, while the real insert event remains effective today.
  INSERT INTO public.commission_earned_state_ledger (
    commission_id, event_kind, effective_at, recorded_by,
    recipient_id, recipient_group_key, recipient_name,
    source_type, source_number, customer_name, order_date,
    amount_cents, is_earned
  )
  SELECT
    s.commission_id, 'baseline',
    (v_before::timestamp AT TIME ZONE 'America/Chicago'), NULL::uuid,
    s.recipient_id, s.recipient_group_key, s.recipient_name,
    s.source_type, s.source_number, s.customer_name, s.order_date,
    s.amount_cents, s.is_earned
  FROM public.commission_earned_state_ledger s
  WHERE s.commission_id = v_commission AND s.event_kind = 'inserted';

  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_before)
   WHERE recipient_id = v_admin;
  IF v_balance.total_earned IS DISTINCT FROM 100.00::numeric
     OR v_balance.total_paid IS DISTINCT FROM 0.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM 100.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: controlled opening baseline is wrong: %', row_to_json(v_balance);
  END IF;

  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_today)
   WHERE recipient_id = v_admin;
  IF v_balance.total_earned IS DISTINCT FROM 100.00::numeric
     OR v_balance.total_paid IS DISTINCT FROM 0.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM 100.00::numeric
     OR v_balance.pending_count IS DISTINCT FROM 1::bigint
     OR v_balance.paid_count IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: opening current balance is wrong: %', row_to_json(v_balance);
  END IF;

  v_payment := public.create_commission_payment(
    ARRAY[v_commission], 'check', 'E2E-COMM-HIST-' || v_suffix,
    v_today, '[E2E] historical commission report proof', v_admin,
    'e2e-commission-history-create-' || v_suffix
  );
  IF (SELECT count(*) FROM public.commission_payment_items
       WHERE commission_payment_id = v_payment
         AND commission_id = v_commission
         AND amount = 100.00::numeric) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create did not snapshot exactly one $100.00 payment item';
  END IF;

  PERFORM public.post_commission_payment(
    v_payment, v_admin, 'e2e-commission-history-post-' || v_suffix
  );

  -- Prove the real RPC result before any other fixture mutation (Claude M3).
  IF NOT EXISTS (
    SELECT 1 FROM public.commission_payments
     WHERE id = v_payment AND status = 'posted'
       AND posted_at IS NOT NULL AND posted_by = v_admin
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: post RPC did not stamp status, posted_at, and posted_by';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.commission_settlement_events
     WHERE commission_payment_id = v_payment
       AND commission_id = v_commission AND event_kind = 'posted'
       AND recipient_id = v_admin AND amount_cents = 10000
       AND source_number = 'E2E-COMM-HIST-' || v_suffix
       AND customer_name = '[E2E] Commission History Farm ' || v_suffix
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: post RPC did not append the exact settlement event';
  END IF;

  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_today)
   WHERE recipient_id = v_admin;
  IF v_balance.total_earned IS DISTINCT FROM 100.00::numeric
     OR v_balance.total_paid IS DISTINCT FROM 100.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM 0.00::numeric
     OR v_balance.pending_count IS DISTINCT FROM 0::bigint
     OR v_balance.paid_count IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: posted current balance is wrong: %', row_to_json(v_balance);
  END IF;

  SELECT count(*), COALESCE(sum(settled_amount), 0)
    INTO v_detail_count, v_detail_amount
    FROM public.get_commission_payment_detail_report(v_today)
   WHERE payment_id = v_payment AND commission_id = v_commission;
  IF v_detail_count <> 1 OR v_detail_amount IS DISTINCT FROM 100.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: payment detail expected one $100.00 line, got count=% amount=%',
      v_detail_count, v_detail_amount;
  END IF;

  UPDATE public.profiles
     SET full_name = '[E2E] Renamed Commission History Admin'
   WHERE id = v_admin;
  UPDATE public.customers
     SET farm_name = '[E2E] Renamed Commission History Farm ' || v_suffix
   WHERE id = v_customer;
  IF EXISTS (
    SELECT 1 FROM public.get_commission_payment_detail_report(v_today)
     WHERE payment_id = v_payment
       AND (recipient_name <> '[E2E] Commission History Admin'
         OR source_number <> 'E2E-COMM-HIST-' || v_suffix
         OR customer_name <> '[E2E] Commission History Farm ' || v_suffix)
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: mutable names rewrote settlement history';
  END IF;

  -- Paid cash must remain visible even when the current earning is excluded.
  UPDATE public.commissions SET deleted_at = transaction_timestamp()
   WHERE id = v_commission;
  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_today)
   WHERE recipient_id = v_admin;
  IF v_balance.total_earned IS DISTINCT FROM 0.00::numeric
     OR v_balance.total_paid IS DISTINCT FROM 100.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM -100.00::numeric
     OR v_balance.pending_count IS DISTINCT FROM 0::bigint
     OR v_balance.paid_count IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: paid-only negative balance was hidden: %', row_to_json(v_balance);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.get_commission_payment_detail_report(v_today)
     WHERE payment_id = v_payment AND commission_id = v_commission
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: soft deletion erased immutable payment detail';
  END IF;
  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_before)
   WHERE recipient_id = v_admin;
  IF v_balance.total_earned IS DISTINCT FROM 100.00::numeric
     OR v_balance.total_paid IS DISTINCT FROM 0.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM 100.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: later soft deletion rewrote the earlier cutoff: %', row_to_json(v_balance);
  END IF;

  v_failed := false;
  BEGIN
    DELETE FROM public.commissions WHERE id = v_commission;
  EXCEPTION WHEN foreign_key_violation THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'SMOKE_FAIL: commission hard delete bypassed history RESTRICT FKs';
  END IF;

  UPDATE public.commissions SET deleted_at = NULL WHERE id = v_commission;
  PERFORM public.void_commission_payment(
    v_payment, '[E2E] prove signed void event', v_admin,
    'e2e-commission-history-void-' || v_suffix
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.commission_payments
     WHERE id = v_payment AND status = 'voided'
       AND voided_at IS NOT NULL AND voided_by = v_admin
  ) OR NOT EXISTS (
    SELECT 1 FROM public.commission_settlement_events
     WHERE commission_payment_id = v_payment
       AND commission_id = v_commission AND event_kind = 'voided'
       AND amount_cents = -10000
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void RPC did not append the exact reversal event';
  END IF;

  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_today)
   WHERE recipient_id = v_admin;
  IF v_balance.total_earned IS DISTINCT FROM 100.00::numeric
     OR v_balance.total_paid IS DISTINCT FROM 0.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM 100.00::numeric
     OR v_balance.pending_count IS DISTINCT FROM 1::bigint
     OR v_balance.paid_count IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: signed void did not restore current balance: %', row_to_json(v_balance);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.get_commission_payment_detail_report(v_today)
     WHERE payment_id = v_payment
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fully reversed payment remained in detail';
  END IF;

  UPDATE public.commissions
     SET commission_amount = 125.00,
         recipient_user_id = v_admin_two,
         recipient = '[E2E] Commission History Admin Two'
   WHERE id = v_commission;
  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_before)
   WHERE recipient_id = v_admin;
  IF v_balance.total_earned IS DISTINCT FROM 100.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM 100.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: later amount/recipient edit rewrote the earlier cutoff: %', row_to_json(v_balance);
  END IF;
  SELECT * INTO v_balance
    FROM public.get_commission_balance_report(v_today)
   WHERE recipient_id = v_admin_two;
  IF v_balance.total_earned IS DISTINCT FROM 125.00::numeric
     OR v_balance.total_paid IS DISTINCT FROM 0.00::numeric
     OR v_balance.outstanding_balance IS DISTINCT FROM 125.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: current amount/recipient revision was not selected: %', row_to_json(v_balance);
  END IF;

  INSERT INTO public.orders (
    order_number, customer_id, salesman_id, order_date, status, booking_draw
  ) VALUES (
    'E2E-COMM-CANCEL-' || v_suffix, v_customer, v_admin,
    v_today - 3, 'confirmed', false
  ) RETURNING id INTO v_cancel_order;
  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES (
    v_cancel_order, v_customer, '[E2E] Commission History Admin', v_admin,
    100, 12.34, 12.34, v_today - 3, 'pending'
  ) RETURNING id INTO v_cancel_commission;
  UPDATE public.commissions
     SET status = 'cancelled', commission_amount = 0
   WHERE id = v_cancel_commission;
  IF NOT EXISTS (
    SELECT 1 FROM public.commissions
     WHERE id = v_cancel_commission AND cancelled_at IS NOT NULL
       AND cancelled_amount_cents = 1234 AND commission_amount = 0
  ) OR NOT EXISTS (
    SELECT 1 FROM public.commission_earned_state_ledger
     WHERE commission_id = v_cancel_commission AND event_kind = 'cancelled'
       AND NOT is_earned AND amount_cents = 0
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cancellation history did not preserve both liability states';
  END IF;

  v_failed := false;
  BEGIN
    UPDATE public.commission_earned_state_ledger
       SET amount_cents = amount_cents + 1
     WHERE commission_id = v_commission;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'COMMISSION_HISTORY_LEDGER_IMMUTABLE:%' THEN v_failed := true; ELSE RAISE; END IF;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'SMOKE_FAIL: earned-state ledger accepted UPDATE'; END IF;

  v_failed := false;
  BEGIN
    TRUNCATE public.commission_settlement_events;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'COMMISSION_HISTORY_LEDGER_IMMUTABLE:%' THEN v_failed := true; ELSE RAISE; END IF;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'SMOKE_FAIL: settlement ledger accepted TRUNCATE'; END IF;

  v_failed := false;
  BEGIN
    PERFORM 1 FROM public.get_commission_balance_report(DATE '2026-03-08');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%COMMISSION_HISTORY_BEFORE_LEDGER_START%2026-03-09%' THEN v_failed := true; ELSE RAISE; END IF;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'SMOKE_FAIL: pre-ledger cutoff did not refuse with the boundary date'; END IF;

  v_failed := false;
  BEGIN
    PERFORM 1 FROM public.get_commission_payment_detail_report(v_today + 1);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%COMMISSION_HISTORY_FUTURE_DATE_UNAVAILABLE%' || v_today::text || '%' THEN v_failed := true; ELSE RAISE; END IF;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'SMOKE_FAIL: future cutoff did not refuse with today''s boundary'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: COMMISSION_HISTORY_AS_OF';
END
$smoke$;
