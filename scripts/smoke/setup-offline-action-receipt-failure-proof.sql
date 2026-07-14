-- Disposable-database fixtures for the multi-session offline receipt proof.
-- This file intentionally persists fixtures and a test-only delay trigger in
-- the newly created disposable database. It must never run against production.

DO $guard$
BEGIN
  IF current_database() !~ '^crx_offline_receipts_failure_proof_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'PROOF_SAFETY: refusing non-disposable database %', current_database();
  END IF;
END;
$guard$;

CREATE TABLE public.offline_receipt_failure_proof_control (
  label text PRIMARY KEY,
  actor_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  idempotency_key text NOT NULL
);

CREATE FUNCTION public._offline_receipt_proof_delay()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.status = 'received'
     AND NEW.status = 'succeeded'
     AND current_setting('crx.proof_delay', true) = 'on' THEN
    PERFORM pg_sleep(6);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._offline_receipt_proof_delay()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.offline_receipt_failure_proof_control
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_offline_receipt_proof_delay
BEFORE UPDATE ON public.offline_action_receipts
FOR EACH ROW
EXECUTE FUNCTION public._offline_receipt_proof_delay();

CREATE FUNCTION public._offline_receipt_proof_stage_delay()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF current_setting('crx.proof_stage_delay', true) = 'on'
     AND NEW.idempotency_key LIKE '[PROOF] rate-race-%' THEN
    PERFORM pg_sleep(6);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._offline_receipt_proof_stage_delay()
  FROM PUBLIC, anon, authenticated;

-- PostgreSQL runs same-event triggers alphabetically. The production
-- `...insert_guard` trigger therefore acquires the actor advisory lock before
-- this proof-only delay trigger sleeps, making the second stage call block on
-- the real production lock.
CREATE TRIGGER trg_offline_receipt_proof_stage_delay
BEFORE INSERT ON public.offline_action_receipts
FOR EACH ROW
EXECUTE FUNCTION public._offline_receipt_proof_stage_delay();

DO $setup$
DECLARE
  v_admin uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product uuid;
  v_field uuid;
  v_order uuid;
  v_order_item uuid;
  v_delivery uuid;
  v_delivery_item uuid;
  v_job uuid;
  v_action uuid;
  v_key text;
  v_payload jsonb;
  v_result jsonb;
BEGIN
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'PROOF_SETUP: no active admin profile found';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.customers (farm_name)
  VALUES ('[PROOF] Offline Receipt Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO public.products (
    product_name, unit_size, current_cost, epa_registration, product_form
  ) VALUES (
    '[PROOF] Offline Receipt Product ' || v_suffix,
    'GL', 6, '[PROOF]-EPA-' || v_suffix, 'liquid'
  ) RETURNING id INTO v_product;

  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked, unit_size
  ) VALUES (v_product, 'Main Warehouse', 100, 6, 'GL');

  -- ------------------------------------------------ concurrency delivery
  INSERT INTO public.orders (
    order_number, customer_id, status, booking_draw
  ) VALUES (
    '[PROOF] CONC-ORDER-' || v_suffix, v_customer, 'confirmed', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[PROOF] concurrency delivery line', 10, 6,
    2, 20, 8, 40, 0, 2
  ) RETURNING id INTO v_order_item;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, created_by
  ) VALUES (
    '[PROOF] CONC-DEL-' || v_suffix, v_order, v_customer, NULL,
    CURRENT_DATE, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_delivery, v_order_item, v_product, 2, 0, 'GL')
  RETURNING id INTO v_delivery_item;

  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  v_action := gen_random_uuid();
  v_key := '[PROOF] concurrency-delivery-' || v_suffix;
  v_payload := jsonb_build_object(
    'signed_by', 'Concurrency Receiver',
    'quantities', jsonb_build_object(v_delivery_item::text, 2),
    'issue_type', 'none',
    'completed_at', to_jsonb(clock_timestamp() - interval '1 minute')
  );
  v_result := public.stage_offline_action(
    v_action, 'complete_delivery', v_delivery, 1,
    clock_timestamp() - interval '5 minutes', v_payload, v_key,
    (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'PROOF_SETUP: concurrency delivery did not stage: %', v_result;
  END IF;
  INSERT INTO public.offline_receipt_failure_proof_control
  VALUES ('concurrency_delivery', v_admin, v_delivery, v_action, v_key);

  -- ----------------------------------------- target-edit race delivery
  INSERT INTO public.orders (
    order_number, customer_id, status, booking_draw
  ) VALUES (
    '[PROOF] TARGET-RACE-ORDER-' || v_suffix, v_customer, 'confirmed', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[PROOF] target race delivery line', 10, 6,
    2, 20, 8, 40, 0, 2
  ) RETURNING id INTO v_order_item;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, created_by
  ) VALUES (
    '[PROOF] TARGET-RACE-DEL-' || v_suffix, v_order, v_customer, NULL,
    CURRENT_DATE, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_delivery, v_order_item, v_product, 2, 0, 'GL')
  RETURNING id INTO v_delivery_item;

  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  v_action := gen_random_uuid();
  v_key := '[PROOF] target-race-delivery-' || v_suffix;
  v_payload := jsonb_build_object(
    'signed_by', 'Target Race Receiver',
    'quantities', jsonb_build_object(v_delivery_item::text, 2),
    'issue_type', 'none',
    'completed_at', to_jsonb(clock_timestamp() - interval '1 minute')
  );
  v_result := public.stage_offline_action(
    v_action, 'complete_delivery', v_delivery, 1,
    clock_timestamp() - interval '5 minutes', v_payload, v_key,
    (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'PROOF_SETUP: target-race delivery did not stage: %', v_result;
  END IF;
  INSERT INTO public.offline_receipt_failure_proof_control
  VALUES ('target_race_delivery', v_admin, v_delivery, v_action, v_key);

  -- ------------------------------------------------ interruption delivery
  INSERT INTO public.orders (
    order_number, customer_id, status, booking_draw
  ) VALUES (
    '[PROOF] INT-ORDER-' || v_suffix, v_customer, 'confirmed', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[PROOF] interrupted delivery line', 10, 6,
    2, 20, 8, 40, 0, 2
  ) RETURNING id INTO v_order_item;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, created_by
  ) VALUES (
    '[PROOF] INT-DEL-' || v_suffix, v_order, v_customer, NULL,
    CURRENT_DATE, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_delivery, v_order_item, v_product, 2, 0, 'GL')
  RETURNING id INTO v_delivery_item;

  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  v_action := gen_random_uuid();
  v_key := '[PROOF] interrupted-delivery-' || v_suffix;
  v_payload := jsonb_build_object(
    'signed_by', 'Interrupted Receiver',
    'quantities', jsonb_build_object(v_delivery_item::text, 2),
    'issue_type', 'none',
    'completed_at', to_jsonb(clock_timestamp() - interval '1 minute')
  );
  v_result := public.stage_offline_action(
    v_action, 'complete_delivery', v_delivery, 1,
    clock_timestamp() - interval '5 minutes', v_payload, v_key,
    (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'PROOF_SETUP: interrupted delivery did not stage: %', v_result;
  END IF;
  INSERT INTO public.offline_receipt_failure_proof_control
  VALUES ('interrupted_delivery', v_admin, v_delivery, v_action, v_key);

  -- ------------------------------------------ lost response after commit
  INSERT INTO public.orders (
    order_number, customer_id, status, booking_draw
  ) VALUES (
    '[PROOF] LOST-ORDER-' || v_suffix, v_customer, 'confirmed', false
  ) RETURNING id INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_order, v_product, '[PROOF] lost response delivery line', 10, 6,
    2, 20, 8, 40, 0, 2
  ) RETURNING id INTO v_order_item;

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver,
    scheduled_date, status, created_by
  ) VALUES (
    '[PROOF] LOST-DEL-' || v_suffix, v_order, v_customer, NULL,
    CURRENT_DATE, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery;

  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity,
    quantity_delivered, unit_size
  ) VALUES (v_delivery, v_order_item, v_product, 2, 0, 'GL')
  RETURNING id INTO v_delivery_item;

  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  v_action := gen_random_uuid();
  v_key := '[PROOF] lost-response-delivery-' || v_suffix;
  v_payload := jsonb_build_object(
    'signed_by', 'Lost Response Receiver',
    'quantities', jsonb_build_object(v_delivery_item::text, 2),
    'issue_type', 'none',
    'completed_at', to_jsonb(clock_timestamp() - interval '1 minute')
  );
  v_result := public.stage_offline_action(
    v_action, 'complete_delivery', v_delivery, 1,
    clock_timestamp() - interval '5 minutes', v_payload, v_key,
    (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_delivery)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'PROOF_SETUP: lost-response delivery did not stage: %', v_result;
  END IF;
  INSERT INTO public.offline_receipt_failure_proof_control
  VALUES ('lost_response_delivery', v_admin, v_delivery, v_action, v_key);

  -- ------------------------------------------------------- concurrency job
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[PROOF] Offline Field ' || v_suffix, 'soybeans', 20)
  RETURNING id INTO v_field;

  INSERT INTO public.jobs (
    job_number, customer_id, status, job_date, season,
    total_acres, total_price_cents, total_cost_cents, created_by
  ) VALUES (
    '[PROOF] CONC-JOB-' || v_suffix, v_customer, 'scheduled', CURRENT_DATE,
    extract(year FROM CURRENT_DATE)::integer, 20, 20000, 12000, v_admin
  ) RETURNING id INTO v_job;

  INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order)
  VALUES (v_job, v_field, 20, 1);

  INSERT INTO public.job_chemicals (
    job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
    cost_per_unit_cents, price_per_unit_cents, sort_order
  ) VALUES (v_job, v_product, 1, 'GL', 0.05, 'GL', 12000, 20000, 1);

  v_result := public.start_job(
    v_job, v_admin, '[PROOF] concurrency-job-start-' || v_suffix
  );
  IF v_result->>'status' IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'PROOF_SETUP: concurrency job did not start: %', v_result;
  END IF;

  v_action := gen_random_uuid();
  v_key := '[PROOF] concurrency-job-' || v_suffix;
  v_payload := jsonb_build_object(
    'actual_start_time', to_jsonb(clock_timestamp() - interval '2 hours'),
    'actual_end_time', to_jsonb(clock_timestamp() - interval '5 minutes'),
    'wind_speed', 8.5,
    'wind_direction', 'NW',
    'temperature', 72,
    'humidity', 50,
    'actual_gallons_applied', 20,
    'notes', '[PROOF] concurrent offline job',
    'field_acres', jsonb_build_array(
      jsonb_build_object('field_id', v_field, 'acres_applied', 20)
    )
  );
  v_result := public.stage_offline_action(
    v_action, 'complete_job', v_job, 1,
    clock_timestamp() - interval '5 minutes', v_payload, v_key,
    (SELECT j.updated_at FROM public.jobs j WHERE j.id = v_job)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'PROOF_SETUP: concurrency job did not stage: %', v_result;
  END IF;
  INSERT INTO public.offline_receipt_failure_proof_control
  VALUES ('concurrency_job', v_admin, v_job, v_action, v_key);

  -- ---------------------------------------------- target-edit race job
  INSERT INTO public.jobs (
    job_number, customer_id, status, job_date, season,
    total_acres, total_price_cents, total_cost_cents, created_by
  ) VALUES (
    '[PROOF] TARGET-RACE-JOB-' || v_suffix, v_customer, 'scheduled', CURRENT_DATE,
    extract(year FROM CURRENT_DATE)::integer, 1, 0, 0, v_admin
  ) RETURNING id INTO v_job;

  UPDATE public.jobs SET status = 'in_progress' WHERE id = v_job;

  v_action := gen_random_uuid();
  v_key := '[PROOF] target-race-job-' || v_suffix;
  v_payload := '{}'::jsonb;
  v_result := public.stage_offline_action(
    v_action, 'complete_job', v_job, 1,
    clock_timestamp() - interval '5 minutes', v_payload, v_key,
    (SELECT j.updated_at FROM public.jobs j WHERE j.id = v_job)
  );
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'PROOF_SETUP: target-race job did not stage: %', v_result;
  END IF;
  INSERT INTO public.offline_receipt_failure_proof_control
  VALUES ('target_race_job', v_admin, v_job, v_action, v_key);

  -- Build 500 old needs-review rows, prove that even a valid new `received`
  -- action is refused, then remove the synthetic backlog before other proofs.
  INSERT INTO public.offline_action_receipts (
    client_action_id, actor_id, operation, entity_id, schema_version,
    client_created_at, request_payload, idempotency_key,
    status, failure_code, failure_summary, needs_review_at,
    received_at, created_at, updated_at
  )
  SELECT
    gen_random_uuid(), v_admin, 'complete_job', gen_random_uuid(), 1,
    clock_timestamp() - interval '2 days', '{}'::jsonb,
    '[PROOF] backlog-' || v_suffix || '-' || g::text,
    'needs_review', 'TARGET_NOT_FOUND',
    'The referenced delivery or job no longer exists.',
    clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '2 days'
  FROM generate_series(1, 500) g;

  BEGIN
    PERFORM public.stage_offline_action(
      gen_random_uuid(), 'complete_job', v_job, 1,
      clock_timestamp() - interval '5 minutes', v_payload,
      '[PROOF] backlog-blocked-' || v_suffix,
      (SELECT j.updated_at FROM public.jobs j WHERE j.id = v_job)
    );
    RAISE EXCEPTION 'PROOF_SETUP: backlog guard allowed a new received action';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM IS DISTINCT FROM
       'OFFLINE_STAGE_RATE_LIMIT: unresolved offline review backlog reached 500 actions' THEN
      RAISE;
    END IF;
  END;

  DELETE FROM public.offline_action_receipts
  WHERE idempotency_key LIKE '[PROOF] backlog-' || v_suffix || '-%';

  -- Leave this actor at 249 recent receipts (six business fixtures + 243
  -- synthetic rows). The JS harness races two new actions for the final slot.
  INSERT INTO public.offline_action_receipts (
    client_action_id, actor_id, operation, entity_id, schema_version,
    client_created_at, request_payload, idempotency_key,
    status, failure_code, failure_summary, needs_review_at
  )
  SELECT
    gen_random_uuid(), v_admin, 'complete_job', gen_random_uuid(), 1,
    clock_timestamp() - interval '5 minutes', '{}'::jsonb,
    '[PROOF] rate-seed-' || v_suffix || '-' || g::text,
    'needs_review', 'TARGET_NOT_FOUND',
    'The referenced delivery or job no longer exists.', clock_timestamp()
  FROM generate_series(1, 243) g;

  INSERT INTO public.offline_receipt_failure_proof_control
  VALUES
    ('rate_race_a', v_admin, gen_random_uuid(), gen_random_uuid(), '[PROOF] rate-race-a-' || v_suffix),
    ('rate_race_b', v_admin, gen_random_uuid(), gen_random_uuid(), '[PROOF] rate-race-b-' || v_suffix);
END;
$setup$;
