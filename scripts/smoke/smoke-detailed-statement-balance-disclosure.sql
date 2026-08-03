-- Rolled-back full-chain proof for 20260803131507_fix_statement_balance_disclosure.
--
-- PRE-APPLY: execute the candidate migration text followed by this DO block in
-- one Supabase MCP execute_sql call. The terminal exception rolls back the
-- CREATE OR REPLACEs and every synthetic fixture.
-- POST-APPLY: this DO block runs directly through run-smoke.mjs.
--
-- Proves an overdue-only customer is included in the month-end batch, a linked
-- finance charge remains visible but is not added twice, and unapplied credit
-- memos are disclosed separately from gross positive invoices.

DO $smoke$
DECLARE
  v_admin uuid;
  v_non_admin uuid;
  v_customer uuid;
  v_void_customer uuid;
  v_overdue_customer uuid;
  v_overdue_invoice uuid;
  v_charge_invoice uuid;
  v_repost_invoice uuid;
  v_credit_invoice uuid;
  v_pre_as_of_target_invoice uuid;
  v_future_target_invoice uuid;
  v_void_invoice uuid;
  v_suffix text := substr(md5(random()::text), 1, 10);
  v_detail jsonb;
  v_batch jsonb;
  v_charge_txn jsonb;
  v_batch_matches integer;
BEGIN
  SELECT id
  INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile';
  END IF;

  SELECT id
  INTO v_non_admin
  FROM public.profiles
  WHERE role <> 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_non_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active non-admin profile';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- Keep this customer genuinely overdue-only. The batch assertion runs before
  -- any posted finance-charge fixture exists, so a selector regressing to
  -- `status = 'posted'` cannot pass accidentally.
  INSERT INTO public.customers (farm_name, account_number, is_active)
  VALUES ('[SMOKE] Overdue Statement ' || v_suffix, '[SMOKE]-OVERDUE-' || v_suffix, true)
  RETURNING id INTO v_overdue_customer;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    due_date, total_amount_cents, created_by
  )
  VALUES (
    '[SMOKE]-OVERDUE-' || v_suffix, v_overdue_customer, 'chemical_sale', 'draft',
    DATE '1900-01-01', DATE '1899-12-01', 10000, v_admin
  )
  RETURNING id INTO v_overdue_invoice;

  UPDATE public.invoices
  SET status = 'posted', posted_at = TIMESTAMPTZ '1899-12-01 12:00:00+00'
  WHERE id = v_overdue_invoice;
  UPDATE public.invoices SET status = 'overdue' WHERE id = v_overdue_invoice;

  v_batch := public.generate_batch_statements(
    DATE '1900-01-01',
    v_admin,
    'summary',
    'smoke-statement-overdue-' || v_suffix
  );

  SELECT count(*)
  INTO v_batch_matches
  FROM jsonb_array_elements(v_batch) AS statement
  WHERE statement->'customer'->>'id' = v_overdue_customer::text;

  IF v_batch_matches IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: overdue-only customer appears % times in batch (expected 1)',
      v_batch_matches;
  END IF;

  INSERT INTO public.customers (farm_name, account_number, is_active)
  VALUES ('[SMOKE] Statement ' || v_suffix, '[SMOKE]-' || v_suffix, true)
  RETURNING id INTO v_customer;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    due_date, total_amount_cents, created_by
  )
  VALUES (
    '[SMOKE]-FIN-' || v_suffix, v_customer, 'misc_charge', 'draft',
    DATE '1900-01-01', DATE '1900-01-01', 1500, v_admin
  )
  RETURNING id INTO v_charge_invoice;

  -- 1900-01-02 01:30 UTC is still 1900-01-01 in America/Chicago. A raw
  -- timestamptz::date cast would wrongly drop this invoice from the cutoff.
  UPDATE public.invoices
  SET status = 'posted', posted_at = TIMESTAMPTZ '1900-01-02 01:30:00+00'
  WHERE id = v_charge_invoice;

  INSERT INTO public.finance_charges (
    customer_id, invoice_id, amount_cents, charge_rate, base_amount_cents,
    period_start, period_end, created_by
  )
  VALUES (
    v_customer, v_charge_invoice, 1500, 1.5, 100000,
    DATE '1899-12-01', DATE '1900-01-01', v_admin
  );

  -- Re-posting overwrites the invoice header's posted_at. Preserve three
  -- lifecycle events around the cutoff so both detail and batch generation
  -- must select the first posting interval rather than today's header value.
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    due_date, posted_at, total_amount_cents, created_by
  )
  VALUES (
    '[SMOKE]-REPOST-' || v_suffix, v_customer, 'chemical_sale', 'posted',
    DATE '1899-12-01', DATE '1900-01-01', TIMESTAMPTZ '1900-02-01 18:00:00+00',
    3000, v_admin
  )
  RETURNING id INTO v_repost_invoice;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description, created_at
  )
  VALUES
    ('invoice_posted', 'invoice', v_repost_invoice, v_admin, 'admin',
      jsonb_build_object('status', 'draft'),
      jsonb_build_object('status', 'posted', 'posted_at', '1900-01-02 01:30:00+00'),
      3000, '[SMOKE] initial post', TIMESTAMPTZ '1900-01-02 01:30:00+00'),
    ('invoice_unposted', 'invoice', v_repost_invoice, v_admin, 'admin',
      jsonb_build_object('status', 'posted', 'posted_at', '1900-01-02 01:30:00+00'),
      jsonb_build_object('status', 'unposted', 'unposted_at', '1900-01-10 18:00:00+00'),
      -3000, '[SMOKE] later unpost', TIMESTAMPTZ '1900-01-10 18:00:00+00'),
    ('invoice_posted', 'invoice', v_repost_invoice, v_admin, 'admin',
      jsonb_build_object('status', 'unposted'),
      jsonb_build_object('status', 'posted', 'posted_at', '1900-02-01 18:00:00+00'),
      3000, '[SMOKE] repost', TIMESTAMPTZ '1900-02-01 18:00:00+00');

  IF NOT public.statement_invoice_was_posted_as_of(
       v_repost_invoice, TIMESTAMPTZ '1900-02-01 18:00:00+00', DATE '1900-01-01'
     )
     OR public.statement_invoice_was_posted_as_of(
       v_repost_invoice, TIMESTAMPTZ '1900-02-01 18:00:00+00', DATE '1900-01-15'
     )
     OR NOT public.statement_invoice_was_posted_as_of(
       v_repost_invoice, TIMESTAMPTZ '1900-02-01 18:00:00+00', DATE '1900-03-01'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: posting interval replay did not preserve post/unpost/repost boundaries';
  END IF;

  -- Reconstruct credit as of the statement date from the application ledger,
  -- rather than using its current generated balance. At the cutoff, the first
  -- application is still active; the second has not happened yet. Today only
  -- the second remains active, which makes this a regression test for both
  -- later applications and later reversals.
  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    posted_at, total_amount_cents, credit_applied_cents, created_by
  )
  VALUES (
    '[SMOKE]-CREDIT-' || v_suffix, v_customer, 'credit_memo', 'posted',
    DATE '1900-01-01', TIMESTAMPTZ '1900-02-01 18:00:00+00', -10000, 8000, v_admin
  )
  RETURNING id INTO v_credit_invoice;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description, created_at
  )
  VALUES
    ('invoice_posted', 'invoice', v_credit_invoice, v_admin, 'admin',
      jsonb_build_object('status', 'draft'),
      jsonb_build_object('status', 'posted', 'posted_at', '1900-01-02 01:30:00+00'),
      -10000, '[SMOKE] initial credit post', TIMESTAMPTZ '1900-01-02 01:30:00+00'),
    ('invoice_unposted', 'invoice', v_credit_invoice, v_admin, 'admin',
      jsonb_build_object('status', 'posted', 'posted_at', '1900-01-02 01:30:00+00'),
      jsonb_build_object('status', 'unposted', 'unposted_at', '1900-01-10 18:00:00+00'),
      10000, '[SMOKE] later credit unpost', TIMESTAMPTZ '1900-01-10 18:00:00+00'),
    ('invoice_posted', 'invoice', v_credit_invoice, v_admin, 'admin',
      jsonb_build_object('status', 'unposted'),
      jsonb_build_object('status', 'posted', 'posted_at', '1900-02-01 18:00:00+00'),
      -10000, '[SMOKE] credit repost', TIMESTAMPTZ '1900-02-01 18:00:00+00');

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    total_amount_cents, created_by
  )
  VALUES (
    '[SMOKE]-PRE-TARGET-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    DATE '1899-12-01', 2000, v_admin
  )
  RETURNING id INTO v_pre_as_of_target_invoice;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    total_amount_cents, created_by
  )
  VALUES (
    '[SMOKE]-FUTURE-TARGET-' || v_suffix, v_customer, 'chemical_sale', 'draft',
    DATE '1900-02-01', 8000, v_admin
  )
  RETURNING id INTO v_future_target_invoice;

  UPDATE public.invoices
  SET status = 'posted',
      posted_at = CASE
        WHEN id = v_pre_as_of_target_invoice THEN TIMESTAMPTZ '1899-12-01 08:00:00+00'
        WHEN id = v_future_target_invoice THEN TIMESTAMPTZ '1900-02-01 08:00:00+00'
      END
  WHERE id IN (v_pre_as_of_target_invoice, v_future_target_invoice);
  UPDATE public.invoices SET credit_applied_cents = CASE
    WHEN id = v_pre_as_of_target_invoice THEN 0
    WHEN id = v_future_target_invoice THEN 8000
  END
  WHERE id IN (v_pre_as_of_target_invoice, v_future_target_invoice);
  UPDATE public.invoices SET status = 'paid'
  WHERE id = v_future_target_invoice;

  INSERT INTO public.credit_memo_applications (
    credit_memo_id, target_invoice_id, amount_cents, applied_by, applied_at,
    reversed_at, reversed_by, reversal_reason
  )
  VALUES
    (v_credit_invoice, v_pre_as_of_target_invoice, 2000, v_admin,
      TIMESTAMPTZ '1900-01-02 01:30:00+00', TIMESTAMPTZ '1900-02-01 12:00:00+00',
      v_admin, 'smoke post-cutoff reversal'),
    (v_credit_invoice, v_future_target_invoice, 8000, v_admin,
      TIMESTAMPTZ '1900-02-01 12:00:00+00', NULL, NULL, NULL);

  -- Exercise the real status-only credit-memo unapply lifecycle. It preserves
  -- the face amount, reverses the still-active future application in the
  -- immutable ledger, and sets void metadata after the statement cutoff.
  PERFORM public.unapply_credit_memo(
    v_credit_invoice,
    'smoke post-cutoff unapply',
    v_admin,
    'smoke-statement-unapply-' || v_suffix
  );

  v_detail := public.get_detailed_statement_data(
    v_customer, DATE '1900-01-01', 'detailed'
  );

  IF (v_detail->>'outstanding_balance_cents')::bigint IS DISTINCT FROM 4500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: gross open invoices = % (expected 4500)',
      v_detail->>'outstanding_balance_cents';
  END IF;
  IF (v_detail->>'open_credit_cents')::bigint IS DISTINCT FROM 8000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: open credits = % (expected 8000)',
      v_detail->>'open_credit_cents';
  END IF;
  IF (v_detail->>'net_account_position_cents')::bigint IS DISTINCT FROM -3500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: net account position = % (expected -3500)',
      v_detail->>'net_account_position_cents';
  END IF;

  v_batch := public.generate_batch_statements(
    DATE '1900-01-01',
    v_admin,
    'summary',
    'smoke-statement-repost-batch-' || v_suffix
  );
  SELECT count(*)
  INTO v_batch_matches
  FROM jsonb_array_elements(v_batch) AS statement
  WHERE statement->'customer'->>'id' = v_customer::text;
  IF v_batch_matches IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: post/unpost/repost customer appears % times in batch (expected 1)',
      v_batch_matches;
  END IF;

  SELECT txn
  INTO v_charge_txn
  FROM jsonb_array_elements(v_detail->'transactions') AS txn
  WHERE txn->>'invoice_number' = '[SMOKE]-FIN-' || v_suffix;

  IF v_charge_txn IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: finance-charge invoice is missing from detailed statement';
  END IF;
  IF (v_charge_txn->>'balance_cents')::bigint IS DISTINCT FROM 1500
     OR (v_charge_txn->>'finance_charge_cents')::bigint IS DISTINCT FROM 1500
     OR (v_charge_txn->>'net_due_cents')::bigint IS DISTINCT FROM 1500 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: finance charge balance/metadata/net = %/%/% (expected 1500/1500/1500)',
      v_charge_txn->>'balance_cents',
      v_charge_txn->>'finance_charge_cents',
      v_charge_txn->>'net_due_cents';
  END IF;

  -- Exercise the real generic void lifecycle, which zeroes the mutable money
  -- columns. Historical statement generation must fail closed instead of
  -- guessing the pre-void amount from an incomplete snapshot.
  INSERT INTO public.customers (farm_name, account_number, is_active)
  VALUES ('[SMOKE] Generic Void ' || v_suffix, '[SMOKE]-VOID-' || v_suffix, true)
  RETURNING id INTO v_void_customer;

  INSERT INTO public.invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date,
    due_date, total_amount_cents, created_by
  )
  VALUES (
    '[SMOKE]-VOID-' || v_suffix, v_void_customer, 'misc_charge', 'draft',
    DATE '1900-01-01', DATE '1900-01-01', 2500, v_admin
  )
  RETURNING id INTO v_void_invoice;

  UPDATE public.invoices
  SET status = 'posted', posted_at = TIMESTAMPTZ '1900-01-02 01:30:00+00'
  WHERE id = v_void_invoice;

  PERFORM public.void_invoice(
    v_void_invoice,
    'smoke post-cutoff generic void',
    'smoke-statement-generic-void-' || v_suffix
  );

  BEGIN
    PERFORM public.get_detailed_statement_data(
      v_void_customer, DATE '1900-01-01', 'detailed'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: post-cutoff generic void produced a guessed detail statement';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: post-cutoff generic void detail raised unexpected error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.generate_batch_statements(
      DATE '1900-01-01',
      v_admin,
      'summary',
      'smoke-statement-generic-void-batch-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: post-cutoff generic void produced a guessed statement batch';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: post-cutoff generic void batch raised unexpected error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.generate_batch_statements(
      DATE '1900-01-01',
      gen_random_uuid(),
      'summary',
      'smoke-statement-forged-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: forged batch actor was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: forged batch actor raised unexpected error: %', SQLERRM;
    END IF;
  END;

  -- Prove authorization happens before the customer selector. This date has
  -- no qualifying invoices, so a late/downstream check would return [] and
  -- leak the empty/non-empty distinction instead of rejecting the caller.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_non_admin, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.generate_batch_statements(
      DATE '1800-01-01',
      v_non_admin,
      'summary',
      'smoke-statement-non-admin-empty-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: non-admin empty batch was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN
      RAISE;
    END IF;
    IF SQLERRM IS DISTINCT FROM 'Permission denied: requires admin role' THEN
      RAISE EXCEPTION
        'SMOKE_FAIL: non-admin batch raised unexpected error: %', SQLERRM;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
