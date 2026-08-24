-- Post-apply rollback-only regression proof for B2 (Live Foundation Gauntlet
-- 2026-07-18): a quote stranded at 'accepted' after its whole-conversion order
-- was cancelled must be rescuable via revert_quote_status, and genuinely
-- re-convertible afterwards.
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX revert_quote_status this chain raises
-- SMOKE_FAIL — the revert is refused ("an order has already been created") so
-- the stranded quote can never be reopened. Against the FIXED function the
-- revert succeeds, the draw ledger is released, and a re-convert produces a NEW
-- order, so the chain reaches SMOKE_PASS_ROLLBACK.
--
-- One DO block, terminal exception → nothing commits.
CREATE OR REPLACE FUNCTION pg_temp.convert_quote_to_order_smoke(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_result jsonb;
BEGIN
  -- Signature-newest-first. The below-cost approval work (20260812115237)
  -- widened this wrapper to (uuid,uuid,text,bigint,text) with
  -- p_below_cost_reason last, and every argument after the first carries a
  -- DEFAULT. That matters: the three-argument fallback at the bottom still
  -- RESOLVES against the widened function, silently defaulting
  -- p_expected_row_version to NULL, which the row-version guard rejects as
  -- QUOTE_STALE_WRITE long before the logic this chain exists to prove.
  -- Probing the widest signature first keeps the row version actually sent.
  IF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint,text)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.convert_quote_to_order($1, $2, $3, $4, NULL::text)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  IF to_regprocedure('public.convert_quote_to_order(uuid,uuid,text,bigint)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.convert_quote_to_order($1, $2, $3, $4)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  RETURN public.convert_quote_to_order(
    p_quote_id,
    p_performed_by,
    p_idempotency_key
  );
END;
$helper$;

DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_quote    uuid;
  v_sec      uuid;
  v_res      jsonb;
  v_order1   uuid;
  v_order2   uuid;
  v_delivery uuid;
  v_invoice  uuid;
  v_commission uuid;
  v_commission_payment uuid;
  v_status   text;
  v_drawn    numeric;
  v_err      text;
  v_replay   jsonb;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

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

  -- ---- whole conversion -> order created, quote 'accepted', draws = 300 ----
  SELECT pg_temp.convert_quote_to_order_smoke(
    v_quote,
    v_admin,
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_quote)
  ) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: convert returned %, expected created', v_res;
  END IF;
  v_order1 := (v_res->>'order_id')::uuid;

  -- Create a posted invoice while the order is still active. The terminal-order
  -- trigger correctly forbids manufacturing a new active invoice after cancel,
  -- while cancel_order deliberately preserves an existing posted invoice.
  INSERT INTO public.invoices (
    invoice_number, order_id, customer_id, invoice_type, status, created_by
  ) VALUES (
    'E2E-B2-I-' || v_suffix, v_order1, v_customer, 'chemical_sale', 'draft', v_admin
  ) RETURNING id INTO v_invoice;
  UPDATE public.invoices
     SET status = 'posted', posted_by = v_admin, posted_at = now()
   WHERE id = v_invoice;

  -- ---- cancel the order (whole conversion: booking_draw = false) ----
  SELECT public.cancel_order(
    v_order1, v_admin, 'smoke-revert-escape-cancel-' || v_suffix
  ) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: cancel returned %, expected cancelled', v_res;
  END IF;

  -- ---- stranded pre-condition: quote still 'accepted', draws still 300 ----
  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: quote after cancel = %, expected accepted (whole-conversion stays closed)', v_status;
  END IF;
  SELECT COALESCE(quantity_drawn, 0) INTO v_drawn
  FROM public.quote_product_draws
  WHERE quote_id = v_quote AND product_id = v_product;
  IF COALESCE(v_drawn, 0) <> 300 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: draw ledger after cancel = %, expected 300 before reopen', v_drawn;
  END IF;

  -- ===== NEGATIVE REGRESSIONS: durable order history must block reopen =====
  UPDATE public.order_items
     SET quantity_delivered = 1
   WHERE order_id = v_order1;
  BEGIN
    PERFORM public.revert_quote_status(v_quote, 'must reject delivered quantity', v_admin,
      'e2e-b2-delivered-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: quote reopened despite delivered order quantity';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_HAS_ORDER_HISTORY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: delivered-quantity guard raised unexpected error: %', v_err;
    END IF;
  END;
  UPDATE public.order_items
     SET quantity_delivered = 0
   WHERE order_id = v_order1;

  BEGIN
    INSERT INTO public.deliveries (
      delivery_number, order_id, customer_id, scheduled_date, status, created_by
    ) VALUES (
      'E2E-B2-D-' || v_suffix, v_order1, v_customer, CURRENT_DATE,
      'scheduled', v_admin
    ) RETURNING id INTO v_delivery;
    UPDATE public.deliveries
       SET status = 'in_progress'
     WHERE id = v_delivery;
    UPDATE public.deliveries
       SET status = 'completed', completed_at = now(), signed_by = 'B2 smoke signer'
     WHERE id = v_delivery;
    BEGIN
      PERFORM public.revert_quote_status(v_quote, 'must reject completed delivery', v_admin,
        'e2e-b2-completed-' || v_suffix);
      RAISE EXCEPTION 'SMOKE_FAIL: quote reopened despite completed delivery history';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'QUOTE_REOPEN_HAS_ORDER_HISTORY:%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: completed-delivery guard raised unexpected error: %', v_err;
      END IF;
    END;
    -- Roll back this completed-delivery fixture without deleting immutable history.
    RAISE EXCEPTION 'B2_COMPLETED_FIXTURE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err IS DISTINCT FROM 'B2_COMPLETED_FIXTURE_ROLLBACK' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.revert_quote_status(v_quote, 'must reject active invoice', v_admin,
      'e2e-b2-invoice-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: quote reopened despite active invoice history';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_HAS_ORDER_HISTORY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: active-invoice guard raised unexpected error: %', v_err;
    END IF;
  END;
  PERFORM public.void_invoice(
    v_invoice,
    'B2 smoke: terminalize active-invoice regression fixture',
    'e2e-b2-void-invoice-' || v_suffix
  );

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status, paid_date
  ) VALUES (
    v_order1, v_customer, 'B2 paid history', v_admin, 100,
    1, 1, CURRENT_DATE, 'paid', CURRENT_DATE
  ) RETURNING id INTO v_commission;
  BEGIN
    PERFORM public.revert_quote_status(v_quote, 'must reject paid commission', v_admin,
      'e2e-b2-paid-commission-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: quote reopened despite paid commission history';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_HAS_ORDER_HISTORY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: paid-commission guard raised unexpected error: %', v_err;
    END IF;
  END;
  DELETE FROM public.commissions WHERE id = v_commission;

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES (
    v_order1, v_customer, 'B2 batched history', v_admin, 100,
    1, 1, CURRENT_DATE, 'pending'
  ) RETURNING id INTO v_commission;
  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status, created_by
  ) VALUES (
    'E2E-B2-CP-' || v_suffix, v_admin, 1, 'unposted', v_admin
  ) RETURNING id INTO v_commission_payment;
  INSERT INTO public.commission_payment_items (
    commission_payment_id, commission_id, amount
  ) VALUES (v_commission_payment, v_commission, 1);
  BEGIN
    PERFORM public.revert_quote_status(v_quote, 'must reject batched commission', v_admin,
      'e2e-b2-batched-commission-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: quote reopened despite active commission batch';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_HAS_ORDER_HISTORY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: batched-commission guard raised unexpected error: %', v_err;
    END IF;
  END;
  DELETE FROM public.commission_payment_items
   WHERE commission_payment_id = v_commission_payment;
  DELETE FROM public.commission_payments WHERE id = v_commission_payment;
  DELETE FROM public.commissions WHERE id = v_commission;

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

  -- Exact same-request replay must return the saved public response, while the
  -- same key with a different normalized/full reason must fail closed before
  -- looking at the quote's now-sent status.
  SELECT public.revert_quote_status(
    v_quote,
    'B2 smoke: un-strand',
    v_admin,
    'e2e-b2-revert-' || v_suffix
  ) INTO v_replay;
  IF v_replay IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: exact idempotent replay changed response: first=%, replay=%',
      v_res, v_replay;
  END IF;

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote,
      'B2 smoke: DIFFERENT reason',
      v_admin,
      'e2e-b2-revert-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reused revert key replayed despite different request arguments';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_REQUEST_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: mismatched revert replay raised unexpected error: %', v_err;
    END IF;
  END;

  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote after revert = %, expected sent', v_status;
  END IF;
  SELECT COALESCE(quantity_drawn, 0) INTO v_drawn
  FROM public.quote_product_draws WHERE quote_id = v_quote AND product_id = v_product;
  IF COALESCE(v_drawn, 0) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw ledger after revert = %, expected 0 (released)', v_drawn;
  END IF;

  -- ---- proof it is genuinely re-convertible: a NEW order is created ----
  SELECT pg_temp.convert_quote_to_order_smoke(
    v_quote,
    v_admin,
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_quote)
  ) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert returned %, expected created (still stranded)', v_res;
  END IF;
  v_order2 := (v_res->>'order_id')::uuid;
  IF v_order2 IS NULL OR v_order2 = v_order1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert did not create a new order (got %, cancelled was %)', v_order2, v_order1;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
