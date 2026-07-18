-- Post-apply rollback-only regression proof for B2 (Live Foundation Gauntlet
-- 2026-07-18): a quote stranded at 'accepted' after its whole-conversion order
-- was cancelled must be rescuable via revert_quote_status, and genuinely
-- re-convertible afterwards.
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX retry lookup this chain replays the
-- seeded expired result and raises SMOKE_FAIL. Against the FIXED function the
-- expired result is removed, the revert succeeds, a sequential replay is exact
-- and side-effect-free, cross-quote key reuse is rejected, unsafe cancelled
-- orders cannot be reopened, the draw ledger is released, a re-convert produces
-- a NEW order, and the historical cancelled order cannot then be restored.
--
-- One DO block, terminal exception → nothing commits.
DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_quote    uuid;
  v_quote2   uuid;
  v_quote_delivered uuid;
  v_quote_completed uuid;
  v_quote_invoice uuid;
  v_quote_commission uuid;
  v_sec      uuid;
  v_risk_sec uuid;
  v_res      jsonb;
  v_order1   uuid;
  v_order2   uuid;
  v_order_delivered uuid;
  v_order_completed uuid;
  v_order_invoice uuid;
  v_order_commission uuid;
  v_invoice  uuid;
  v_status   text;
  v_drawn    numeric;
  v_replay   jsonb;
  v_audit_before bigint;
  v_audit_after bigint;
  v_err      text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- [E2E] marker keeps the live-testdata guard satisfied; terminal rollback removes it.
  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] B2 Farm ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name)
  VALUES ('[E2E] B2 Herbicide ' || v_suffix) RETURNING id INTO v_product;

  -- Whole booking (not planned): one product, 300 units.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-Q-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote, 'Main') RETURNING id INTO v_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote, v_sec, v_product, 10, 6, 300, 'gal');

  -- Separate terminal target for the same-operation argument-binding check.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-Q2-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote2;
  UPDATE public.quotes SET status = 'declined' WHERE id = v_quote2;

  -- ---- whole conversion -> order created, quote 'accepted', draws = 300 ----
  SELECT public.convert_quote_to_order(v_quote) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: convert returned %, expected created', v_res;
  END IF;
  v_order1 := (v_res->>'order_id')::uuid;

  -- ---- cancel the order (whole conversion: booking_draw = false) ----
  SELECT public.cancel_order(v_order1, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: cancel returned %, expected cancelled', v_res;
  END IF;

  -- ---- stranded pre-condition: quote still 'accepted', draws still 300 ----
  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: quote after cancel = %, expected accepted (whole-conversion stays closed)', v_status;
  END IF;

  SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_drawn
  FROM public.quote_product_draws
  WHERE quote_id = v_quote AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: draw ledger after cancel = %, expected 300 before revert', v_drawn;
  END IF;

  -- The legacy restore path changed only the status and rebuilt none of the
  -- inventory/hold/commission/invoice effects of cancellation. It is retired
  -- even before the quote is reopened, and must not mutate the order.
  BEGIN
    PERFORM public.restore_cancelled_order(
      v_order1, 'must be retired', v_admin, 'e2e-b2-restore-retired-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: retired restore_cancelled_order still executed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: retired restore returned wrong error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.orders WHERE id = v_order1) IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retired restore changed the original order';
  END IF;
  IF has_function_privilege('anon', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retired restore_cancelled_order still has an execution grant';
  END IF;

  -- ===== FAIL-CLOSED 1: delivered quantity survives cancellation =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QD-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_delivered;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_delivered, 'Delivered risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_delivered, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_delivered) INTO v_res;
  v_order_delivered := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_delivered IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: delivered-risk conversion failed: %', v_res;
  END IF;
  UPDATE public.order_items
     SET quantity_delivered = 1,
         quantity_remaining = GREATEST(total_units_needed - 1, 0)
   WHERE order_id = v_order_delivered;
  SELECT public.cancel_order(v_order_delivered, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_delivered, 'must reject delivered history', v_admin,
      'e2e-b2-delivered-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with delivered inventory';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_DELIVERED_ACTIVITY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: delivered-history guard returned wrong error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.quotes WHERE id = v_quote_delivered) IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected delivered-history reopen still changed quote status';
  END IF;

  -- ===== FAIL-CLOSED 1b: completed delivery survives even if item totals drift =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QX-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_completed;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_completed, 'Completed delivery risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_completed, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_completed) INTO v_res;
  v_order_completed := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_completed IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: completed-delivery conversion failed: %', v_res;
  END IF;
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, status, completed_at, signed_by, created_by
  ) VALUES (
    'E2E-B2-DEL-' || v_suffix, v_order_completed, v_customer,
    'completed', now(), '[E2E] B2 completed-delivery proof', v_admin
  );
  SELECT public.cancel_order(v_order_completed, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_completed, 'must reject completed delivery', v_admin,
      'e2e-b2-completed-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with a completed delivery';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_DELIVERED_ACTIVITY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: completed-delivery guard returned wrong error: %', v_err;
    END IF;
  END;

  -- ===== FAIL-CLOSED 2: a posted invoice survives cancellation =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QI-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_invoice;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_invoice, 'Invoice risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_invoice, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_invoice) INTO v_res;
  v_order_invoice := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_invoice IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: invoice-risk conversion failed: %', v_res;
  END IF;
  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type, status,
    total_amount_cents, invoice_date, due_date, created_by
  ) VALUES (
    'E2E-B2-INV-' || v_suffix, v_customer, v_order_invoice,
    'chemical_sale', 'draft', 1000, current_date, current_date + 30, v_admin
  ) RETURNING id INTO v_invoice;
  UPDATE public.invoices SET status = 'posted' WHERE id = v_invoice;
  SELECT public.cancel_order(v_order_invoice, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_invoice, 'must reject posted invoice', v_admin,
      'e2e-b2-invoice-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with a posted invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_POSTED_INVOICE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: posted-invoice guard returned wrong error: %', v_err;
    END IF;
  END;

  -- ===== FAIL-CLOSED 3: a paid commission survives cancellation =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QC-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_commission;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_commission, 'Commission risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_commission, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_commission) INTO v_res;
  v_order_commission := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_commission IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: commission-risk conversion failed: %', v_res;
  END IF;
  INSERT INTO public.commissions (
    order_id, customer_id, recipient, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES (
    v_order_commission, v_customer, '[E2E] paid commission', 100,
    1, 1, current_date, 'paid'
  );
  SELECT public.cancel_order(v_order_commission, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_commission, 'must reject paid commission', v_admin,
      'e2e-b2-commission-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with a paid commission';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_PAID_COMMISSION:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: paid-commission guard returned wrong error: %', v_err;
    END IF;
  END;

  IF (SELECT status FROM public.quotes WHERE id = v_quote_completed) IS DISTINCT FROM 'accepted'
     OR (SELECT status FROM public.quotes WHERE id = v_quote_invoice) IS DISTINCT FROM 'accepted'
     OR (SELECT status FROM public.quotes WHERE id = v_quote_commission) IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected financial reopen changed a quote status';
  END IF;

  -- Seed an expired cache entry. The shared helper must delete it under the
  -- advisory lock instead of replaying stale output.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES (
    'e2e-b2-revert-' || v_suffix,
    'revert_quote_status',
    jsonb_build_object('success', true, 'new_status', 'stale-expired-result'),
    now() - interval '1 minute'
  );

  -- ===== FAIL-FIRST: revert must rescue the stranded quote =====
  BEGIN
    SELECT public.revert_quote_status(v_quote, 'B2 smoke: un-strand', v_admin, 'e2e-b2-revert-' || v_suffix)
    INTO v_res;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    -- PRE-FIX path: revert refuses because *an order exists* -> quote stays stranded.
    RAISE EXCEPTION 'SMOKE_FAIL: stranded quote could not be reverted (B2 live): %', v_err;
  END;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'new_status' IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: revert returned %, expected new_status=sent', v_res;
  END IF;

  SELECT count(*) INTO v_audit_before
  FROM public.financial_audit_log
  WHERE operation_type = 'quote_status_reverted' AND entity_id = v_quote;

  SELECT public.revert_quote_status(v_quote, 'B2 smoke: un-strand', v_admin, 'e2e-b2-revert-' || v_suffix)
  INTO v_replay;
  IF v_replay IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-key replay changed result: first=%, replay=%', v_res, v_replay;
  END IF;

  SELECT count(*) INTO v_audit_after
  FROM public.financial_audit_log
  WHERE operation_type = 'quote_status_reverted' AND entity_id = v_quote;
  IF v_audit_before <> 1 OR v_audit_after <> v_audit_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-key replay duplicated audit effects (before=%, after=%)', v_audit_before, v_audit_after;
  END IF;

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote2,
      'B2 smoke: un-strand',
      v_admin,
      'e2e-b2-revert-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: same key replayed quote A result for quote B';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: cross-target same-key reuse produced wrong error: %', v_err;
    END IF;
  END;

  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote2;
  IF v_status IS DISTINCT FROM 'declined' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cross-target retry changed quote B to %', v_status;
  END IF;

  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote after revert = %, expected sent', v_status;
  END IF;
  SELECT COALESCE(quantity_drawn, 0) INTO v_drawn
  FROM public.quote_product_draws WHERE quote_id = v_quote AND product_id = v_product;
  IF COALESCE(v_drawn, 0) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw ledger after revert = %, expected 0 (released)', v_drawn;
  END IF;

  -- Retirement also holds while the quote is reopened but before a replacement
  -- is created—the exact race window called out by the adversarial review.
  BEGIN
    PERFORM public.restore_cancelled_order(
      v_order1, 'must remain retired after reopen', v_admin,
      'e2e-b2-restore-reopened-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: restored historical order while quote was reopened';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: reopened-state restore guard returned wrong error: %', v_err;
    END IF;
  END;

  -- ---- proof it is genuinely re-convertible: a NEW order is created ----
  SELECT public.convert_quote_to_order(v_quote) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert returned %, expected created (still stranded)', v_res;
  END IF;
  v_order2 := (v_res->>'order_id')::uuid;
  IF v_order2 IS NULL OR v_order2 = v_order1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert did not create a new order (got %, cancelled was %)', v_order2, v_order1;
  END IF;

  -- The quote is accepted again but now points at a replacement order. The old
  -- cancelled order must never be restorable beside it.
  BEGIN
    PERFORM public.restore_cancelled_order(
      v_order1,
      'must reject historical order after replacement',
      v_admin,
      'e2e-b2-restore-old-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: restored the historical order beside its replacement';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: replacement-order restore guard returned wrong error: %', v_err;
    END IF;
  END;

  IF (SELECT status FROM public.orders WHERE id = v_order1) IS DISTINCT FROM 'cancelled'
     OR (SELECT status FROM public.orders WHERE id = v_order2) IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected historical restore changed an order status';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
