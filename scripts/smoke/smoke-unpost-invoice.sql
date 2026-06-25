-- ============================================================================
-- SMOKE TEST (rolled back by design): unpost_invoice (#28 unpost leg)
-- migration 20260625130000_unpost_invoice.sql.
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260625130000. Proves the inverse of post_invoice:
--
--   ROUND-TRIP   draft field invoice -> post_invoice -> posted; unpost_invoice ->
--                unposted, posted_by/posted_at cleared, money fields untouched, an
--                'invoice_unposted' append-only audit row added (post audit row kept).
--   IDEMPOTENCY  unpost_invoice twice with the SAME key mutates once (second call
--                returns the saved result, NO second audit row).
--   ACTOR        forged p_performed_by -> ACTOR_MISMATCH, writes nothing.
--   MONEY GUARD  a posted invoice WITH an allocated payment (+ paid_amount_cents) ->
--                REFUSED, invoice stays posted, no money lost, no audit row.
--   STATUS GUARD a draft (never-posted) invoice -> REFUSED ('nothing to unpost').
--   PERIOD GUARD a posted invoice whose month is in a CLOSED accounting period ->
--                REFUSED (closed-period error), invoice stays posted.
--   OVERDUE      an 'overdue' invoice CAN be unposted (superset of posted).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8);
  v_cust uuid; v_res jsonb; v_invR RECORD; v_n int; v_forged uuid := gen_random_uuid();
  v_inv uuid;            -- round-trip invoice
  v_inv_money uuid;      -- money-guard invoice
  v_inv_draft uuid;      -- status-guard invoice
  v_inv_period uuid;     -- period-guard invoice
  v_inv_overdue uuid;    -- overdue invoice
  v_aset uuid;
  v_audit_post int; v_audit_unpost int; v_paid bigint; v_prepay bigint;
  v_period_month date := date_trunc('month', (CURRENT_DATE - INTERVAL '2 months'))::date;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin'; END IF;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] UNPOST '||v_sfx) RETURNING id INTO v_cust;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- ── ROUND-TRIP: post a draft field invoice, then unpost it ────────────────
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] UP-RT-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, 320000, v_admin)
    RETURNING id INTO v_inv;

  PERFORM post_invoice(v_inv, '[SMOKE] up-post-'||v_sfx);
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  IF v_invR.status<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: post_invoice did not post (%)', v_invR.status; END IF;
  IF v_invR.posted_by IS NULL OR v_invR.posted_at IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: posted_by/at not stamped'; END IF;
  SELECT count(*) INTO v_audit_post FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_posted';
  IF v_audit_post<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 1 invoice_posted audit row, got %', v_audit_post; END IF;

  -- Forged actor must be rejected BEFORE any real unpost (no mutation).
  BEGIN
    PERFORM unpost_invoice(v_inv, v_forged, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF;
  END;
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv;
  IF v_invR.status<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: forged call changed status'; END IF;

  -- Capture money before unpost.
  SELECT total_amount_cents, paid_amount_cents, prepay_applied_cents INTO v_invR.total_amount_cents, v_paid, v_prepay FROM invoices WHERE id=v_inv;

  -- The real unpost (idempotency key X).
  v_res := unpost_invoice(v_inv, v_admin, '[SMOKE] up-unpost-'||v_sfx);
  IF (v_res->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: unpost did not succeed'; END IF;
  IF (v_res->>'previous_status')<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong previous_status'; END IF;
  SELECT * INTO v_invR FROM invoices WHERE id=v_inv;
  IF v_invR.status<>'unposted' THEN RAISE EXCEPTION 'SMOKE_FAIL: not returned to unposted (%)', v_invR.status; END IF;
  IF v_invR.posted_by IS NOT NULL OR v_invR.posted_at IS NOT NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: posted_by/at not cleared'; END IF;
  -- No money lost: total/paid/prepay unchanged by the unpost.
  IF v_invR.total_amount_cents<>320000 THEN RAISE EXCEPTION 'SMOKE_FAIL: total changed on unpost (%)', v_invR.total_amount_cents; END IF;
  IF COALESCE(v_invR.paid_amount_cents,0)<>COALESCE(v_paid,0) THEN RAISE EXCEPTION 'SMOKE_FAIL: paid changed on unpost'; END IF;
  IF COALESCE(v_invR.prepay_applied_cents,0)<>COALESCE(v_prepay,0) THEN RAISE EXCEPTION 'SMOKE_FAIL: prepay changed on unpost'; END IF;
  -- Append-only audit: the post row is preserved AND exactly one unpost row added.
  SELECT count(*) INTO v_audit_post FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_posted';
  IF v_audit_post<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: post audit row mutated (%)', v_audit_post; END IF;
  SELECT count(*) INTO v_audit_unpost FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_unposted';
  IF v_audit_unpost<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 1 invoice_unposted audit row, got %', v_audit_unpost; END IF;

  -- ── IDEMPOTENCY: same key -> saved result, no 2nd audit row ────────────────
  v_res := unpost_invoice(v_inv, v_admin, '[SMOKE] up-unpost-'||v_sfx);
  IF (v_res->>'status')<>'unposted' THEN RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay wrong result'; END IF;
  SELECT count(*) INTO v_audit_unpost FROM financial_audit_log WHERE entity_id=v_inv AND operation_type='invoice_unposted';
  IF v_audit_unpost<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay wrote a 2nd audit row (%)', v_audit_unpost; END IF;

  -- Re-post works: the unposted invoice can post again (round-trip is reusable).
  PERFORM post_invoice(v_inv, '[SMOKE] up-repost-'||v_sfx);
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv;
  IF v_invR.status<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: re-post after unpost failed (%)', v_invR.status; END IF;

  -- ── MONEY GUARD: posted invoice WITH an allocated payment -> REFUSED ───────
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] UP-MONEY-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, 100000, v_admin)
    RETURNING id INTO v_inv_money;
  PERFORM post_invoice(v_inv_money, '[SMOKE] up-money-post-'||v_sfx);
  -- Attach money: an allocation row + a non-zero paid_amount_cents header (override the
  -- generated balance via admin_override is NOT needed — paid_amount_cents is a plain col).
  INSERT INTO allocation_sets (entity_type, entity_id, version, is_active, customer_id, total_payment_cents, total_allocated_cents)
    VALUES ('payment', gen_random_uuid(), 1, true, v_cust, 100000, 100000) RETURNING id INTO v_aset;
  INSERT INTO invoice_line_allocations (allocation_set_id, bill_to_customer_id, split_percentage, amount_cents, invoice_id)
    VALUES (v_aset, v_cust, 100, 100000, v_inv_money);
  UPDATE invoices SET paid_amount_cents = 100000 WHERE id=v_inv_money;
  BEGIN
    PERFORM unpost_invoice(v_inv_money, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: unposted an invoice with money applied';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%payments, prepay, or write-offs%' THEN RAISE EXCEPTION 'SMOKE_FAIL: money-guard wrong error: %', SQLERRM; END IF;
  END;
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv_money;
  IF v_invR.status<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: money-guard mutated status (%)', v_invR.status; END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log WHERE entity_id=v_inv_money AND operation_type='invoice_unposted';
  IF v_n<>0 THEN RAISE EXCEPTION 'SMOKE_FAIL: money-guard wrote an audit row (%)', v_n; END IF;
  -- The allocated money is intact (nothing lost).
  SELECT amount_cents INTO v_paid FROM invoice_line_allocations WHERE invoice_id=v_inv_money;
  IF v_paid<>100000 THEN RAISE EXCEPTION 'SMOKE_FAIL: allocation amount changed (%)', v_paid; END IF;

  -- ── STATUS GUARD: a draft (never-posted) invoice -> REFUSED ───────────────
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] UP-DRAFT-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, 50000, v_admin)
    RETURNING id INTO v_inv_draft;
  BEGIN
    PERFORM unpost_invoice(v_inv_draft, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: unposted a draft invoice';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%nothing to unpost%' THEN RAISE EXCEPTION 'SMOKE_FAIL: status-guard wrong error: %', SQLERRM; END IF;
  END;

  -- ── PERIOD GUARD: posted invoice in a CLOSED period -> REFUSED ────────────
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] UP-PERIOD-'||v_sfx, v_cust, 'field_application', 'draft', v_period_month + 5, 70000, v_admin)
    RETURNING id INTO v_inv_period;
  PERFORM post_invoice(v_inv_period, '[SMOKE] up-period-post-'||v_sfx);  -- period still open here
  -- Now close that month.
  INSERT INTO accounting_periods (period_start, period_end, status, closed_by, closed_at)
    VALUES (v_period_month, (v_period_month + INTERVAL '1 month - 1 day')::date, 'closed', v_admin, now());
  BEGIN
    PERFORM unpost_invoice(v_inv_period, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: unposted in a closed period';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%closed accounting period%' THEN RAISE EXCEPTION 'SMOKE_FAIL: period-guard wrong error: %', SQLERRM; END IF;
  END;
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv_period;
  IF v_invR.status<>'posted' THEN RAISE EXCEPTION 'SMOKE_FAIL: period-guard mutated status (%)', v_invR.status; END IF;

  -- ── OVERDUE: an overdue invoice CAN be unposted (superset of posted) ──────
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('[SMOKE] UP-OVERDUE-'||v_sfx, v_cust, 'field_application', 'draft', CURRENT_DATE, 40000, v_admin)
    RETURNING id INTO v_inv_overdue;
  PERFORM post_invoice(v_inv_overdue, '[SMOKE] up-od-post-'||v_sfx);
  -- posted -> overdue is an allowed transition; flip it directly (admin override not needed for overdue).
  PERFORM set_config('app.admin_override','true',true);
  UPDATE invoices SET status='overdue' WHERE id=v_inv_overdue;
  PERFORM set_config('app.admin_override','false',true);
  v_res := unpost_invoice(v_inv_overdue, v_admin, '[SMOKE] up-od-unpost-'||v_sfx);
  IF (v_res->>'previous_status')<>'overdue' THEN RAISE EXCEPTION 'SMOKE_FAIL: overdue previous_status wrong'; END IF;
  SELECT status INTO v_invR.status FROM invoices WHERE id=v_inv_overdue;
  IF v_invR.status<>'unposted' THEN RAISE EXCEPTION 'SMOKE_FAIL: overdue not unposted (%)', v_invR.status; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
