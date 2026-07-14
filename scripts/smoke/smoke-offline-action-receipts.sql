-- =============================================================================
-- SMOKE TEST (rolled back by design): permanent offline action receipts
-- -----------------------------------------------------------------------------
-- Proves the Stage 1B-1A receipt chain through the REAL RPCs and the current
-- canonical complete_delivery / complete_job implementations:
--
--   stage -> immutable replay -> process -> durable success lookup -> replay
--
-- It also proves action/idempotency reuse rejection, owner binding, office-only
-- cross-user status reads, missing-target and unauthorized-action retention,
-- deterministic conflict classification, future-clock rejection, RPC-only
-- table writes, sanitized status output, and the expected grants. The terminal
-- SMOKE_PASS_ROLLBACK exception rolls back every fixture and business mutation.
-- =============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_field_user uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product uuid;
  v_field uuid;
  v_order uuid;
  v_order_item uuid;
  v_delivery uuid;
  v_delivery_item uuid;
  v_job uuid;
  v_conflict_job uuid;
  v_delivery_action uuid := gen_random_uuid();
  v_job_action uuid := gen_random_uuid();
  v_conflict_action uuid := gen_random_uuid();
  v_missing_action uuid := gen_random_uuid();
  v_unauthorized_action uuid := gen_random_uuid();
  v_clock_skew_action uuid := gen_random_uuid();
  v_client_time timestamptz := clock_timestamp() - interval '5 minutes';
  v_delivery_key text := '[SMOKE] offline-delivery-' || v_suffix;
  v_job_key text := '[SMOKE] offline-job-' || v_suffix;
  v_conflict_key text := '[SMOKE] offline-conflict-' || v_suffix;
  v_missing_key text := '[SMOKE] offline-missing-' || v_suffix;
  v_unauthorized_key text := '[SMOKE] offline-unauthorized-' || v_suffix;
  v_clock_skew_key text := '[SMOKE] offline-clock-skew-' || v_suffix;
  v_payload jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_status jsonb;
  v_count integer;
BEGIN
  -- ---------------------------------------------------------------- actors
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;

  SELECT id INTO v_field_user
  FROM public.profiles
  WHERE id <> v_admin
    AND role IN ('driver', 'applicator')
    AND is_active = true
  ORDER BY created_at
  LIMIT 1;
  IF v_field_user IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active driver/applicator profile found';
  END IF;

  -- ----------------------------------------------------------- P1 no auth
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.stage_offline_action(
      gen_random_uuid(), 'complete_job', gen_random_uuid(), 1,
      v_client_time, '{}'::jsonb, '[SMOKE] no-auth-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: no-auth stage was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no-auth stage expected AUTH_REQUIRED, got %', SQLERRM;
    END IF;
  END;

  -- ---------------------------------------------- P2 direct table write deny
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.offline_action_receipts (
      client_action_id, actor_id, operation, entity_id, schema_version,
      client_created_at, request_payload, idempotency_key
    ) VALUES (
      gen_random_uuid(), v_admin, 'complete_job', gen_random_uuid(), 1,
      v_client_time, '{}'::jsonb, '[SMOKE] direct-write-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct table insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    RAISE EXCEPTION 'SMOKE_FAIL: direct-write probe failed for the wrong reason: %', SQLERRM;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- -------------------------------------------------------------- fixtures
  INSERT INTO public.customers (farm_name)
  VALUES ('[SMOKE] Offline Receipt Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO public.products (
    product_name, unit_size, current_cost, epa_registration, product_form
  ) VALUES (
    '[SMOKE] Offline Receipt Product ' || v_suffix,
    'GL', 6, '[SMOKE]-EPA-' || v_suffix, 'liquid'
  ) RETURNING id INTO v_product;

  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked, unit_size
  ) VALUES (v_product, 'Main Warehouse', 100, 2, 'GL');

  INSERT INTO public.orders (
    order_number, customer_id, status, booking_draw
  ) VALUES (
    '[SMOKE] OFF-' || v_suffix, v_customer, 'confirmed', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[SMOKE] offline line', 10, 6,
    2, 20, 8, 40, 0, 2
  ) RETURNING id INTO v_order_item;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, created_by
  ) VALUES (
    '[SMOKE] DEL-' || v_suffix, v_order, v_customer, NULL,
    CURRENT_DATE, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_delivery, v_order_item, v_product, 2, 0, 'GL')
  RETURNING id INTO v_delivery_item;

  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[SMOKE] Offline Field ' || v_suffix, 'soybeans', 20)
  RETURNING id INTO v_field;

  INSERT INTO public.jobs (
    job_number, customer_id, status, job_date, season,
    total_acres, total_price_cents, total_cost_cents, created_by
  ) VALUES (
    '[SMOKE] JOB-' || v_suffix, v_customer, 'scheduled', CURRENT_DATE,
    extract(year FROM CURRENT_DATE)::integer, 20, 20000, 12000, v_admin
  ) RETURNING id INTO v_job;

  INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order)
  VALUES (v_job, v_field, 20, 1);

  INSERT INTO public.job_chemicals (
    job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
    cost_per_unit_cents, price_per_unit_cents, sort_order
  ) VALUES (v_job, v_product, 1, 'GL', 0.05, 'GL', 12000, 20000, 1);

  v_result := public.start_job(
    v_job, v_admin, '[SMOKE] offline-start-' || v_suffix
  );
  IF v_result->>'status' IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: start_job fixture failed: %', v_result;
  END IF;

  -- ======================================================= delivery chain
  v_payload := jsonb_build_object(
    'signed_by', 'Smoke Receiver',
    'quantities', jsonb_build_object(v_delivery_item::text, '2'),
    'issue_type', 'none',
    'completed_at', to_jsonb(clock_timestamp() - interval '1 minute')
  );

  v_result := public.stage_offline_action(
    v_clock_skew_action, 'complete_delivery', v_delivery, 1,
    v_client_time,
    jsonb_set(
      v_payload,
      '{completed_at}',
      to_jsonb(clock_timestamp() + interval '10 minutes')
    ),
    v_clock_skew_key,
    (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
  );
  IF v_result->>'status' IS DISTINCT FROM 'needs_review'
     OR v_result->>'failure_code' IS DISTINCT FROM 'PAYLOAD_INVALID' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: future completed_at was not retained for office review: %', v_result;
  END IF;

  v_result := public.stage_offline_action(
    v_delivery_action, 'complete_delivery', v_delivery, 1,
    v_client_time, v_payload, v_delivery_key,
    (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery stage did not return received: %', v_result;
  END IF;

  -- Equivalent numeric JSON must canonicalize to the same immutable receipt.
  v_replay := public.stage_offline_action(
    v_delivery_action, 'complete_delivery', v_delivery, 1,
    v_client_time,
    jsonb_set(v_payload, ARRAY['quantities', v_delivery_item::text], '2'::jsonb),
    v_delivery_key,
    (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: equivalent delivery stage replay changed: % vs %', v_replay, v_result;
  END IF;

  BEGIN
    PERFORM public.stage_offline_action(
      v_delivery_action, 'complete_delivery', v_delivery, 1,
      v_client_time, jsonb_set(v_payload, '{signed_by}', '"Different"'::jsonb),
      v_delivery_key,
      (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
    );
    RAISE EXCEPTION 'SMOKE_FAIL: action UUID reuse with changed payload was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'OFFLINE_ACTION_ID_REUSE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected OFFLINE_ACTION_ID_REUSE, got %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.stage_offline_action(
      gen_random_uuid(), 'complete_delivery', v_delivery, 1,
      v_client_time, v_payload, v_delivery_key,
      (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
    );
    RAISE EXCEPTION 'SMOKE_FAIL: idempotency-key reuse across action UUIDs was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REUSE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected IDEMPOTENCY_KEY_REUSE, got %', SQLERRM;
    END IF;
  END;

  -- A different field user cannot process an admin-owned receipt.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_field_user, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.process_offline_action(v_delivery_action, v_delivery_key);
    RAISE EXCEPTION 'SMOKE_FAIL: cross-actor delivery process was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH, got %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.get_offline_action_status(v_delivery_action);
    RAISE EXCEPTION 'SMOKE_FAIL: non-office cross-user status read was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'NOT_AUTHORIZED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected NOT_AUTHORIZED, got %', SQLERRM;
    END IF;
  END;

  v_result := public.stage_offline_action(
    v_unauthorized_action, 'complete_delivery', v_delivery, 1,
    v_client_time, v_payload, v_unauthorized_key
  );
  IF v_result->>'status' IS DISTINCT FROM 'needs_review'
     OR v_result->>'failure_code' IS DISTINCT FROM 'NOT_AUTHORIZED' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unauthorized action was not retained safely: %', v_result;
  END IF;
  v_status := public.get_offline_action_status(v_unauthorized_action);
  IF v_status->>'actor_id' IS DISTINCT FROM v_field_user::text
     OR v_status->>'failure_code' IS DISTINCT FROM 'NOT_AUTHORIZED' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unauthorized receipt owner status failed: %', v_status;
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_result := public.process_offline_action(v_delivery_action, v_delivery_key);
  IF v_result->>'status' IS DISTINCT FROM 'succeeded'
     OR v_result->'result'->>'delivery_id' IS DISTINCT FROM v_delivery::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery process failed: %', v_result;
  END IF;
  IF (v_result->>'attempt_count')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery attempt_count is not 1: %', v_result;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE delivery_id = v_delivery AND transaction_type = 'delivered';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery process wrote % delivered ledger rows, expected 1', v_count;
  END IF;

  v_replay := public.process_offline_action(v_delivery_action, v_delivery_key);
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: succeeded delivery process replay changed: % vs %', v_replay, v_result;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.inventory_transactions
  WHERE delivery_id = v_delivery AND transaction_type = 'delivered';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery replay duplicated the ledger (% rows)', v_count;
  END IF;

  v_status := public.get_offline_action_status(v_delivery_action);
  IF v_status->>'status' IS DISTINCT FROM 'succeeded'
     OR v_status ? 'request_payload'
     OR v_status ? 'idempotency_key' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: status result is wrong or leaks private fields: %', v_status;
  END IF;

  -- ============================================================ job chain
  v_payload := jsonb_build_object(
    'actual_start_time', to_jsonb(clock_timestamp() - interval '2 hours'),
    'actual_end_time', to_jsonb(clock_timestamp() - interval '5 minutes'),
    'wind_speed', 8.5,
    'wind_direction', 'NW',
    'temperature', 72,
    'humidity', 50,
    'actual_gallons_applied', 20,
    'notes', '[SMOKE] offline receipt job',
    'field_acres', jsonb_build_array(
      jsonb_build_object('field_id', v_field, 'acres_applied', 20)
    )
  );

  v_result := public.stage_offline_action(
    v_job_action, 'complete_job', v_job, 1,
    v_client_time, v_payload, v_job_key,
    (SELECT j.updated_at FROM public.jobs j WHERE j.id = v_job)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: job stage did not return received: %', v_result;
  END IF;

  v_result := public.process_offline_action(v_job_action, v_job_key);
  IF v_result->>'status' IS DISTINCT FROM 'succeeded'
     OR v_result->'result'->>'job_id' IS DISTINCT FROM v_job::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: job process failed: %', v_result;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.application_records
  WHERE source_type = 'job' AND source_id = v_job;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: job process wrote % application records, expected 1', v_count;
  END IF;

  v_replay := public.process_offline_action(v_job_action, v_job_key);
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: succeeded job process replay changed: % vs %', v_replay, v_result;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.application_records
  WHERE source_type = 'job' AND source_id = v_job;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: job replay duplicated application records (% rows)', v_count;
  END IF;

  -- ========================================== deterministic conflict branch
  INSERT INTO public.jobs (
    job_number, customer_id, status, job_date, season,
    total_acres, total_price_cents, total_cost_cents, created_by
  ) VALUES (
    '[SMOKE] CONFLICT-' || v_suffix, v_customer, 'scheduled', CURRENT_DATE,
    extract(year FROM CURRENT_DATE)::integer, 1, 0, 0, v_admin
  ) RETURNING id INTO v_conflict_job;

  v_result := public.stage_offline_action(
    v_conflict_action, 'complete_job', v_conflict_job, 1,
    v_client_time, '{}'::jsonb, v_conflict_key,
    (SELECT j.updated_at FROM public.jobs j WHERE j.id = v_conflict_job)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: conflict receipt did not stage as received: %', v_result;
  END IF;

  v_result := public.process_offline_action(v_conflict_action, v_conflict_key);
  IF v_result->>'status' IS DISTINCT FROM 'needs_review'
     OR v_result->>'failure_code' IS DISTINCT FROM 'TARGET_STATE_CONFLICT' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: state conflict was not sanitized correctly: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.application_records
    WHERE source_type = 'job' AND source_id = v_conflict_job
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: failed conflict process leaked an application record';
  END IF;
  BEGIN
    PERFORM public.process_offline_action(v_conflict_action, v_conflict_key);
    RAISE EXCEPTION 'SMOKE_FAIL: owner re-processed a needs_review receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'OFFLINE_ACTION_NEEDS_REVIEW%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: needs_review replay expected OFFLINE_ACTION_NEEDS_REVIEW, got %', SQLERRM;
    END IF;
  END;

  -- ============================================ missing target is retained
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_field_user, 'role', 'authenticated')::text,
    true
  );
  v_result := public.stage_offline_action(
    v_missing_action, 'complete_job', gen_random_uuid(), 1,
    v_client_time, '{}'::jsonb, v_missing_key
  );
  IF v_result->>'status' IS DISTINCT FROM 'needs_review'
     OR v_result->>'failure_code' IS DISTINCT FROM 'TARGET_NOT_FOUND' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: missing target was not retained for review: %', v_result;
  END IF;
  v_status := public.get_offline_action_status(v_missing_action);
  IF v_status->>'actor_id' IS DISTINCT FROM v_field_user::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: receipt owner cannot read own missing-target status: %', v_status;
  END IF;

  -- Active office users can inspect another actor's sanitized review status.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_status := public.get_offline_action_status(v_missing_action);
  IF v_status->>'status' IS DISTINCT FROM 'needs_review'
     OR v_status ? 'request_payload'
     OR v_status ? 'idempotency_key' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: office status read failed or leaked private fields: %', v_status;
  END IF;
  BEGIN
    PERFORM public.process_offline_action(v_missing_action, v_missing_key);
    RAISE EXCEPTION 'SMOKE_FAIL: office user processed another actor''s receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: cross-actor office process expected ACTOR_MISMATCH, got %', SQLERRM;
    END IF;
  END;

  -- ----------------------------------------------------- validation/grants
  BEGIN
    PERFORM public.stage_offline_action(
      gen_random_uuid(), 'complete_job', v_job, 1, v_client_time,
      '{"unexpected":true}'::jsonb, '[SMOKE] invalid-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: unsupported payload field was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PAYLOAD_INVALID%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: invalid payload expected PAYLOAD_INVALID, got %', SQLERRM;
    END IF;
  END;

  IF has_table_privilege('authenticated', 'public.offline_action_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.offline_action_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.offline_action_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.offline_action_receipts', 'DELETE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated has direct receipt table privileges';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.stage_offline_action(uuid,text,uuid,integer,timestamptz,jsonb,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege('anon', 'public.process_offline_action(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_offline_action_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can execute an offline receipt RPC';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.stage_offline_action(uuid,text,uuid,integer,timestamptz,jsonb,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege('authenticated', 'public.process_offline_action(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_offline_action_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated cannot execute every offline receipt RPC';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
