-- Rollback-only proof for the public money/lifecycle idempotency boundary.
-- Missing and blank keys must fail before any implementation can inspect or
-- mutate business rows. A valid finance-charge key must reach the preserved
-- implementation and replay its exact no-customer result. Actor-bearing public
-- wrappers must also reject an authenticated caller who supplies another actor.

DO $smoke$
DECLARE
  v_admin uuid;
  v_result jsonb;
  v_replay jsonb;
  v_key text := 'smoke-required-idem-' || gen_random_uuid()::text;
  v_batch_key text := 'smoke-required-batch-' || gen_random_uuid()::text;
  v_missing_invoice uuid := gen_random_uuid();
  v_message text;
  v_cached jsonb;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY id
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  BEGIN
    PERFORM public.create_invoice_from_order(gen_random_uuid(), NULL, 'chemical_sale', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_from_order accepted a NULL key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_order' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.batch_post_invoices(ARRAY[v_missing_invoice], NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: batch_post_invoices accepted a NULL key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.batch_post_invoices(ARRAY[v_missing_invoice], E'\t\n ');
    RAISE EXCEPTION 'SMOKE_FAIL: batch_post_invoices accepted an all-whitespace key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices' THEN RAISE; END IF;
  END;

  v_result := public.batch_post_invoices(ARRAY[v_missing_invoice], v_batch_key);
  IF (v_result->>'count')::int <> 0
     OR jsonb_array_length(v_result->'failed') <> 1
     OR (v_result->'failed'->0->>'error') LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch child call did not receive its derived key: %', v_result;
  END IF;
  v_replay := public.batch_post_invoices(ARRAY[v_missing_invoice], v_batch_key);
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch valid-key replay changed its response';
  END IF;
  IF (SELECT count(*) FROM public.idempotency_keys
       WHERE idempotency_key = v_batch_key AND operation = 'batch_post_invoices') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch replay key was not claimed exactly once';
  END IF;
  BEGIN
    PERFORM public.batch_post_invoices(ARRAY[gen_random_uuid()], v_batch_key);
    RAISE EXCEPTION 'SMOKE_FAIL: batch key accepted a changed invoice array';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'IDEMPOTENCY_REQUEST_MISMATCH:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.create_invoice_from_order(gen_random_uuid(), NULL, 'chemical_sale', '   ');
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_from_order accepted a blank key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_order' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.create_invoice_for_unbilled_delivery(gen_random_uuid(), v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_for_unbilled_delivery accepted a NULL key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_for_unbilled_delivery' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.create_invoice_for_unbilled_delivery(gen_random_uuid(), v_admin, E'\t ');
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_for_unbilled_delivery accepted a blank key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_for_unbilled_delivery' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.post_invoice(gen_random_uuid(), NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice accepted a NULL key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: post_invoice' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.post_invoice(gen_random_uuid(), E'\n');
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice accepted a blank key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: post_invoice' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.cancel_order(gen_random_uuid(), v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_order accepted a NULL key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: cancel_order' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.cancel_order(gen_random_uuid(), v_admin, '');
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_order accepted a blank key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: cancel_order' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.generate_finance_charges(current_date, v_admin, ARRAY[]::uuid[], NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: generate_finance_charges accepted a NULL key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: generate_finance_charges' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.generate_finance_charges(current_date, v_admin, ARRAY[]::uuid[], '   ');
    RAISE EXCEPTION 'SMOKE_FAIL: generate_finance_charges accepted a blank key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: generate_finance_charges' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.create_invoice_for_unbilled_delivery(
      gen_random_uuid(), gen_random_uuid(), v_key || '-actor-delivery'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_for_unbilled_delivery accepted a forged actor';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'ACTOR_MISMATCH' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.cancel_order(
      gen_random_uuid(), gen_random_uuid(), v_key || '-actor-cancel'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_order accepted a forged actor';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'ACTOR_MISMATCH' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.generate_finance_charges(
      current_date, gen_random_uuid(), ARRAY[]::uuid[], v_key || '-actor-finance'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: generate_finance_charges accepted a forged actor';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'ACTOR_MISMATCH' THEN RAISE; END IF;
  END;

  v_result := public.generate_finance_charges(
    current_date, v_admin, ARRAY[]::uuid[], v_key
  );
  v_replay := public.generate_finance_charges(
    current_date, v_admin, ARRAY[]::uuid[], v_key
  );
  IF v_result IS DISTINCT FROM v_replay THEN
    RAISE EXCEPTION 'SMOKE_FAIL: valid required key did not replay exactly';
  END IF;
  IF (SELECT count(*) FROM public.idempotency_keys
       WHERE idempotency_key = v_key AND operation = 'generate_finance_charges') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: finance-charge replay key was not claimed exactly once';
  END IF;
  SELECT result INTO v_cached FROM public.idempotency_keys
   WHERE idempotency_key = v_key AND operation = 'generate_finance_charges';
  IF v_cached->>'_contract' IS DISTINCT FROM 'generate_finance_charges_v2'
     OR v_cached->'request'->>'actor_id' IS DISTINCT FROM v_admin::text
     OR v_cached->'response' IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: finance-charge replay cache does not match returned result';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
