-- Full-gauntlet remediation functional proof.
-- Run as postgres/service_role after the three 20260714230xxx migrations are
-- present. Every fixture and business write is inside this DO block, whose
-- terminal SMOKE_PASS_ROLLBACK exception aborts the transaction.

DO $smoke$
DECLARE
  v_admin uuid;
  v_sales uuid;
  v_sales2 uuid;
  v_applicator uuid;
  v_customer uuid;
  v_customer2 uuid;
  v_field uuid;
  v_product uuid;
  v_product_name text;
  v_inventory_unit text;
  v_product2 uuid;
  v_product2_name text;
  v_inventory_unit2 text;
  v_commission uuid;
  v_commission_amount numeric;
  v_payment uuid := gen_random_uuid();
  v_po uuid := gen_random_uuid();
  v_po_item_over uuid := gen_random_uuid();
  v_po_item_open uuid := gen_random_uuid();
  v_po_item_admin uuid := gen_random_uuid();
  v_po_item_inactive uuid := gen_random_uuid();
  v_po_item_numeric uuid := gen_random_uuid();
  v_ticket uuid := gen_random_uuid();
  v_bad_ticket uuid := gen_random_uuid();
  v_numeric_ticket uuid := gen_random_uuid();
  v_ocr_ticket uuid := gen_random_uuid();
  v_storage_ticket uuid := gen_random_uuid();
  v_empty_ticket uuid := gen_random_uuid();
  v_billed_ticket uuid := gen_random_uuid();
  v_partial_ticket uuid := gen_random_uuid();
  v_mapping_ticket uuid := gen_random_uuid();
  v_duplicate_ticket uuid := gen_random_uuid();
  v_inventory_ticket uuid := gen_random_uuid();
  v_wrong_customer_ticket uuid := gen_random_uuid();
  v_storage_object uuid := gen_random_uuid();
  v_storage_sales_object uuid := gen_random_uuid();
  v_storage_legacy_applicator_object uuid := gen_random_uuid();
  v_new_save_product_id uuid := gen_random_uuid();
  v_ocr_queue_id uuid;
  v_ocr_lease uuid := gen_random_uuid();
  v_key_prefix text := 'gauntlet-' || gen_random_uuid()::text;
  v_location text := '[E2E] gauntlet ' || gen_random_uuid()::text;
  v_result jsonb;
  v_replay jsonb;
  v_order_id uuid;
  v_order_item_id uuid;
  v_inventory_order_id uuid;
  v_invoice_id uuid;
  v_blend_product_id uuid;
  v_blend_product_id2 uuid;
  v_billed_blend_product_id uuid;
  v_linked_blend_product_id uuid;
  v_count integer;
  v_side_effect_count integer;
  v_status text;
  v_notes text;
  v_quantity numeric;
  v_updated_at timestamptz;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  SELECT id INTO v_sales
    FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  SELECT id INTO v_applicator
    FROM public.profiles
   WHERE role = 'applicator' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  -- The rollback-only Storage cross-user probe temporarily promotes this
  -- second real account after all applicator-denial probes have completed.
  v_sales2 := v_applicator;
  SELECT id INTO v_customer
    FROM public.customers
   WHERE is_active = true
     AND EXISTS (SELECT 1 FROM public.fields f WHERE f.customer_id = customers.id)
   ORDER BY created_at
   LIMIT 1;
  SELECT id INTO v_customer2
    FROM public.customers
   WHERE is_active = true
     AND id <> v_customer
   ORDER BY created_at
   LIMIT 1;
  SELECT id INTO v_field
    FROM public.fields
   WHERE customer_id = v_customer
   ORDER BY created_at
   LIMIT 1;
  SELECT id, product_name, inventory_unit
    INTO v_product, v_product_name, v_inventory_unit
    FROM public.products
   WHERE is_active = true
     AND NULLIF(btrim(inventory_unit), '') IS NOT NULL
     AND public.field_app_priced_quantity(
           1,
           public.normalize_rate_unit(inventory_unit),
           public.normalize_rate_unit(inventory_unit),
           product_form
         ) IS NOT NULL
   ORDER BY created_at
   LIMIT 1;
  SELECT id, product_name, inventory_unit
    INTO v_product2, v_product2_name, v_inventory_unit2
    FROM public.products
   WHERE is_active = true
     AND id <> v_product
     AND NULLIF(btrim(inventory_unit), '') IS NOT NULL
     AND public.field_app_priced_quantity(
           1,
           public.normalize_rate_unit(inventory_unit),
           public.normalize_rate_unit(inventory_unit),
           product_form
         ) IS NOT NULL
   ORDER BY created_at
   LIMIT 1;
  SELECT c.id, c.commission_amount INTO v_commission, v_commission_amount
    FROM public.commissions c
   WHERE c.status = 'pending'
     AND c.deleted_at IS NULL
     AND c.commission_amount > 0
     AND NOT EXISTS (
       SELECT 1 FROM public.commission_payment_items cpi
        WHERE cpi.commission_id = c.id
     )
   ORDER BY c.created_at
   LIMIT 1;

  IF v_admin IS NULL OR v_sales IS NULL OR v_sales2 IS NULL OR v_applicator IS NULL
     OR v_customer IS NULL OR v_customer2 IS NULL OR v_field IS NULL
     OR v_product IS NULL OR v_product2 IS NULL OR v_commission IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(setup): required active role/customer/product/unbatched commission fixture missing';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- Central key-only replay protection: same-operation replay succeeds through
  -- check_idempotency, cross-operation reuse fails, a direct duplicate insert
  -- raises so its caller transaction cannot commit duplicate business effects,
  -- and an expired key can be reused.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (v_key_prefix || '-same', 'smoke_same', '{"ok":true}'::jsonb);

  IF public.check_idempotency(v_key_prefix || '-same', 'smoke_same')
       IS DISTINCT FROM '{"ok":true}'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): same-operation replay did not return cached result';
  END IF;

  BEGIN
    PERFORM public.check_idempotency(v_key_prefix || '-same', 'smoke_other');
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): cross-operation key reuse was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(idempotency)%' THEN RAISE; END IF;
    IF position('IDEMPOTENCY_CROSS_OP_KEY_REUSE' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(idempotency): wrong cross-operation error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
    VALUES (v_key_prefix || '-same', 'smoke_same', '{"duplicate":true}'::jsonb)
    ON CONFLICT (idempotency_key) DO NOTHING;
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): duplicate inline key insert was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(idempotency)%' THEN RAISE; END IF;
    IF position('IDEMPOTENCY_CONCURRENT_REPLAY_RETRY' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(idempotency): wrong duplicate-inline error: %', SQLERRM;
    END IF;
  END;

  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, expires_at
  ) VALUES (
    v_key_prefix || '-expired', 'old_operation', '{"old":true}'::jsonb,
    now() - interval '1 minute'
  );
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, expires_at
  ) VALUES (
    v_key_prefix || '-unrelated-expired', 'unrelated_old_operation', '{"old":true}'::jsonb,
    now() - interval '1 minute'
  );
  IF public.check_idempotency(v_key_prefix || '-expired', 'new_operation') IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): targeted expired key returned a stale result';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.idempotency_keys
     WHERE idempotency_key = v_key_prefix || '-unrelated-expired'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): checking one key deleted an unrelated expired key';
  END IF;
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (v_key_prefix || '-expired', 'new_operation', '{"new":true}'::jsonb);
  SELECT count(*) INTO v_count
    FROM public.idempotency_keys
   WHERE idempotency_key = v_key_prefix || '-expired'
     AND operation = 'new_operation';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): expired key was not replaced exactly once';
  END IF;

  -- Empty and header/item-mismatched commission batches must remain unposted.
  INSERT INTO public.commission_payments (
    id, payment_number, recipient_id, total_amount, status,
    payment_date, created_by, notes
  ) VALUES (
    v_payment, '[E2E]-GAUNTLET-' || left(v_payment::text, 8), v_admin,
    v_commission_amount + 1, 'unposted', current_date, v_admin,
    '[E2E] rollback-only gauntlet'
  );

  BEGIN
    PERFORM public.post_commission_payment(
      v_payment, v_admin, v_key_prefix || '-commission-empty'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(commission): empty batch posted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(commission)%' THEN RAISE; END IF;
    IF position('COMMISSION_PAYMENT_EMPTY' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(commission): wrong empty-batch error: %', SQLERRM;
    END IF;
  END;

  INSERT INTO public.commission_payment_items (
    commission_payment_id, commission_id, amount
  ) VALUES (v_payment, v_commission, v_commission_amount);

  BEGIN
    PERFORM public.post_commission_payment(
      v_payment, v_admin, v_key_prefix || '-commission-mismatch'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(commission): mismatched batch posted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(commission)%' THEN RAISE; END IF;
    IF position('COMMISSION_PAYMENT_TOTAL_MISMATCH' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(commission): wrong mismatch error: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.commission_payments WHERE id = v_payment;
  IF v_status <> 'unposted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(commission): rejected batch changed status to %', v_status;
  END IF;

  -- The full re-emitted money path must still post a valid, reconciling batch.
  -- Prove the payment/commission/audit effects and exact replay, not only the
  -- two new rejection branches above.
  UPDATE public.commission_payments
     SET total_amount = v_commission_amount
   WHERE id = v_payment;

  v_result := public.post_commission_payment(
    v_payment, v_admin, v_key_prefix || '-commission-valid'
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'commissions_paid')::integer, 0) <> 1
     OR (v_result->>'payment_id')::uuid IS DISTINCT FROM v_payment THEN
    RAISE EXCEPTION 'SMOKE_FAIL(commission): valid batch returned wrong result: %', v_result;
  END IF;

  v_replay := public.post_commission_payment(
    v_payment, v_admin, v_key_prefix || '-commission-valid'
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL(commission): valid batch replay changed result';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.commission_payments cp
     WHERE cp.id = v_payment
       AND cp.status = 'posted'
       AND cp.posted_by = v_admin
       AND cp.posted_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.commissions c
     WHERE c.id = v_commission
       AND c.status = 'paid'
       AND c.paid_date = current_date
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(commission): valid post did not update payment and commission state';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.financial_audit_log fal
   WHERE fal.operation_type = 'commission_payment_posted'
     AND fal.entity_type = 'commission_payment'
     AND fal.entity_id = v_payment
     AND fal.actor_user_id = v_admin
     AND fal.total_impact_cents = (v_commission_amount * 100)::bigint;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(commission): valid post/replay emitted % matching audit rows', v_count;
  END IF;

  -- A large receipt on one PO line cannot hide another open line. Sales may
  -- receive normally but only an admin with a dedicated reason may overreceive.
  INSERT INTO public.purchase_orders (
    id, po_number, vendor, status, submitted_date, total_cost, created_by, notes
  ) VALUES (
    v_po, '[E2E]-GAUNTLET-' || left(v_po::text, 8), '[E2E] vendor',
    'submitted', current_date, 0, v_admin, '[E2E] rollback-only gauntlet'
  );
  INSERT INTO public.purchase_order_items (
    id, purchase_order_id, product_id, quantity_ordered, unit_cost,
    quantity_received, unit_size, product_name
  ) VALUES
    (v_po_item_over, v_po, v_product, 10, 0, 20, v_inventory_unit, v_product_name),
    (v_po_item_open, v_po, v_product, 10, 0, 0, v_inventory_unit, v_product_name),
    (v_po_item_admin, v_po, v_product, 1, 0, 0, v_inventory_unit, v_product_name),
    (v_po_item_inactive, v_po, v_product, 1, 0, 0, v_inventory_unit, v_product_name),
    (v_po_item_numeric, v_po, v_product, 1, 0, 0, v_inventory_unit, v_product_name);

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );

  BEGIN
    PERFORM public.check_idempotency('', 'smoke_blank_key');
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): blank key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(idempotency)%' THEN RAISE; END IF;
    IF position('IDEMPOTENCY_KEY_REQUIRED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(idempotency): wrong blank-key error: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM public.check_idempotency(v_key_prefix || '-blank-operation', '');
    RAISE EXCEPTION 'SMOKE_FAIL(idempotency): blank operation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(idempotency)%' THEN RAISE; END IF;
    IF position('IDEMPOTENCY_OPERATION_REQUIRED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(idempotency): wrong blank-operation error: %', SQLERRM;
    END IF;
  END;

  PERFORM public.receive_po_items(
    jsonb_build_array(jsonb_build_object(
      'po_item_id', v_po_item_open,
      'quantity', 1,
      'storage_location', v_location
    )),
    v_sales,
    v_key_prefix || '-receive-normal',
    false
  );
  SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
  IF v_status <> 'partially_received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): open line was hidden by aggregate overreceipt; status=%', v_status;
  END IF;

  -- An inactive sales profile must not retain receiving authority. The local
  -- exception subtransaction restores the profile to active automatically.
  BEGIN
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text,
      true
    );
    UPDATE public.profiles SET is_active = false WHERE id = v_sales;
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_sales, 'role', 'authenticated')::text,
      true
    );
    PERFORM public.receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item_inactive,
        'quantity', 1,
        'storage_location', v_location
      )),
      v_sales,
      v_key_prefix || '-receive-inactive-sales',
      false
    );
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): inactive sales user received inventory';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(receiving)%' THEN RAISE; END IF;
    IF position('Only admin or sales_rep can receive PO items' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(receiving): wrong inactive-sales error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
     WHERE id = v_po_item_inactive AND quantity_received <> 0
  ) OR EXISTS (
    SELECT 1 FROM public.receiving_records WHERE po_item_id = v_po_item_inactive
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): inactive-sales rejection leaked receiving effects';
  END IF;

  BEGIN
    PERFORM public.receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item_numeric,
        'quantity', 'NaN',
        'storage_location', v_location
      )),
      v_sales,
      v_key_prefix || '-receive-nan',
      false
    );
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): NaN receiving quantity succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(receiving)%' THEN RAISE; END IF;
    IF position('Receiving quantity must be finite' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(receiving): wrong NaN error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
     WHERE id = v_po_item_numeric AND quantity_received <> 0
  ) OR EXISTS (
    SELECT 1 FROM public.receiving_records WHERE po_item_id = v_po_item_numeric
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): NaN rejection leaked receiving effects';
  END IF;

  BEGIN
    PERFORM public.receive_po_items(
      jsonb_build_array(
        jsonb_build_object(
          'po_item_id', v_po_item_inactive,
          'quantity', 1,
          'storage_location', v_location
        ),
        jsonb_build_object(
          'po_item_id', v_po_item_numeric,
          'quantity', 0,
          'storage_location', v_location
        )
      ),
      v_sales,
      v_key_prefix || '-receive-mixed-nonpositive',
      false
    );
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): mixed payload silently skipped zero quantity';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(receiving)%' THEN RAISE; END IF;
    IF position('RECEIVING_QUANTITY_MUST_BE_POSITIVE' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(receiving): wrong nonpositive error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
     WHERE id IN (v_po_item_inactive, v_po_item_numeric)
       AND quantity_received <> 0
  ) OR EXISTS (
    SELECT 1 FROM public.receiving_records
     WHERE po_item_id IN (v_po_item_inactive, v_po_item_numeric)
  ) OR EXISTS (
    SELECT 1 FROM public.idempotency_keys
     WHERE idempotency_key = v_key_prefix || '-receive-mixed-nonpositive'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): nonpositive rejection leaked receiving effects';
  END IF;

  BEGIN
    PERFORM public.receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item_admin,
        'quantity', 2,
        'over_receive_reason', 'rollback-only sales rejection',
        'storage_location', v_location
      )),
      v_sales,
      v_key_prefix || '-receive-sales-over',
      true
    );
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): sales user overreceived';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(receiving)%' THEN RAISE; END IF;
    IF position('OVER_RECEIVE_ADMIN_REQUIRED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(receiving): wrong sales overreceive error: %', SQLERRM;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item_admin,
        'quantity', 2,
        'over_receive_reason', 'NULL override must fail closed',
        'storage_location', v_location
      )),
      v_admin,
      v_key_prefix || '-receive-admin-null-override',
      NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): NULL overreceive override succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(receiving)%' THEN RAISE; END IF;
    IF position('Cannot receive more than ordered' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(receiving): wrong NULL-override error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_items
     WHERE id = v_po_item_admin AND quantity_received <> 0
  ) OR EXISTS (
    SELECT 1 FROM public.receiving_records WHERE po_item_id = v_po_item_admin
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): NULL-override rejection leaked receiving effects';
  END IF;

  BEGIN
    PERFORM public.receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item_admin,
        'quantity', 2,
        'storage_location', v_location
      )),
      v_admin,
      v_key_prefix || '-receive-admin-no-reason',
      true
    );
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): admin overreceive without reason succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(receiving)%' THEN RAISE; END IF;
    IF position('OVER_RECEIVE_REASON_REQUIRED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(receiving): wrong missing-reason error: %', SQLERRM;
    END IF;
  END;

  PERFORM public.receive_po_items(
    jsonb_build_array(jsonb_build_object(
      'po_item_id', v_po_item_admin,
      'quantity', 2,
      'over_receive_reason', 'damaged package replacement',
      'storage_location', v_location
    )),
    v_admin,
    v_key_prefix || '-receive-admin-with-reason',
    true
  );
  SELECT notes INTO v_notes
    FROM public.receiving_records
   WHERE po_item_id = v_po_item_admin
   ORDER BY created_at DESC
   LIMIT 1;
  IF position('OVER-RECEIVE: damaged package replacement' IN COALESCE(v_notes, '')) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): dedicated overreceive reason was not audited';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.inventory_transactions
     WHERE purchase_order_id = v_po
       AND product_id = v_product
       AND transaction_type = 'received'
       AND position('OVER-RECEIVE: damaged package replacement' IN COALESCE(notes, '')) > 0
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(receiving): overreceive reason missing from inventory transaction';
  END IF;

  -- Atomic creation rejects invalid image metadata without an orphan, then a
  -- valid manual ticket replays exactly once. Order creation is blocked until
  -- review, then succeeds atomically with a complete matched product.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.create_blend_ticket(
      v_bad_ticket, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
      false, NULL, v_key_prefix || '-ticket-no-auth'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): no-auth ticket creation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-auth)%' THEN RAISE; END IF;
    IF position('AUTH_REQUIRED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): wrong no-auth error: %', SQLERRM;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.create_blend_ticket(
      v_bad_ticket, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
      false, NULL, v_key_prefix || '-ticket-anon'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): anon ticket creation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-auth)%' THEN RAISE; END IF;
    IF position('AUTH_REQUIRED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): wrong anon error: %', SQLERRM;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_applicator, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.create_blend_ticket(
      v_bad_ticket, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
      false, v_applicator, v_key_prefix || '-ticket-wrong-role'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): applicator ticket creation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-auth)%' THEN RAISE; END IF;
    IF position('INSUFFICIENT_ROLE' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): wrong applicator error: %', SQLERRM;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.create_blend_ticket(
      v_bad_ticket, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
      false, v_sales, v_key_prefix || '-ticket-forged-actor'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): forged actor ticket creation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-auth)%' THEN RAISE; END IF;
    IF position('ACTOR_MISMATCH' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-auth): wrong forged-actor error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.create_blend_ticket(
      v_numeric_ticket,
      jsonb_build_object(
        'customer_id', v_customer,
        'ticket_date', current_date,
        'total_acres', 'NaN'
      ),
      '[]'::jsonb,
      '[]'::jsonb,
      false,
      v_admin,
      v_key_prefix || '-ticket-nan'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend): NaN ticket total succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_NUMERIC_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong NaN ticket error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.blend_tickets WHERE id = v_numeric_ticket) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): NaN ticket rejection left an orphan';
  END IF;

  BEGIN
    PERFORM public.create_blend_ticket(
      v_bad_ticket,
      jsonb_build_object('ticket_date', current_date),
      '[]'::jsonb,
      '[]'::jsonb,
      true,
      v_admin,
      v_key_prefix || '-ticket-ocr-empty'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend): zero-image OCR request succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_IMAGE_COUNT_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong zero-image OCR error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.create_blend_ticket(
      v_bad_ticket,
      jsonb_build_object('ticket_date', current_date),
      '[]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'storage_path', v_bad_ticket::text || '/1.jpg',
        'file_size', 10485761,
        'mime_type', 'image/jpeg',
        'upload_order', 1
      )),
      true,
      v_admin,
      v_key_prefix || '-ticket-invalid'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend): oversized OCR image metadata succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_IMAGE_METADATA_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong invalid-image error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.blend_tickets WHERE id = v_bad_ticket) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): rejected OCR request left an orphan ticket';
  END IF;

  BEGIN
    PERFORM public.create_blend_ticket(
      v_bad_ticket,
      jsonb_build_object('ticket_date', current_date),
      (
        SELECT jsonb_agg(jsonb_build_object(
          'id', gen_random_uuid(),
          'product_name', 'bounded line ' || line_number,
          'quantity', 1
        ))
          FROM generate_series(1, 201) AS lines(line_number)
      ),
      '[]'::jsonb,
      false,
      v_admin,
      v_key_prefix || '-ticket-too-many-products'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend): ticket with 201 products succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_PRODUCT_COUNT_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong product-cap error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.blend_tickets WHERE id = v_bad_ticket) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): product-cap rejection left an orphan ticket';
  END IF;

  v_result := public.create_blend_ticket(
    v_ocr_ticket,
    jsonb_build_object('ticket_date', current_date),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'storage_path', v_ocr_ticket::text || '/1.jpg',
      'file_size', 1,
      'mime_type', 'image/jpeg',
      'upload_order', 1
    )),
    true,
    v_admin,
    v_key_prefix || '-ticket-ocr-valid'
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.ocr_processing_queue q
        WHERE q.blend_ticket_id = v_ocr_ticket
          AND q.status = 'pending'
          AND q.lease_token IS NULL
          AND q.lease_heartbeat_at IS NULL
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): valid OCR create did not produce an unleased pending queue row';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ocr_processing_queue'
       AND column_name = 'lease_token' AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ocr_processing_queue'
       AND column_name = 'lease_heartbeat_at' AND udt_name = 'timestamptz'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): OCR lease columns are missing or have the wrong type';
  END IF;
  UPDATE public.blend_tickets SET status = 'processing' WHERE id = v_ocr_ticket;
  SELECT updated_at INTO v_updated_at FROM public.blend_tickets WHERE id = v_ocr_ticket;
  BEGIN
    PERFORM public.save_blend_ticket(
      v_ocr_ticket,
      jsonb_build_object('_expected_updated_at', v_updated_at, 'notes', 'queued stale form'),
      '[]'::jsonb, v_admin, v_key_prefix || '-ticket-save-processing'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(save): processing OCR ticket accepted form save';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(save)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_OCR_PROCESSING' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(save): wrong processing-save error: %', SQLERRM;
    END IF;
  END;

  -- The worker's final database boundary is atomic: it owns the current lease,
  -- preserves already-entered header/manual-product truth, replaces only old
  -- OCR products, completes the queue, and replays from the idempotency ledger.
  SELECT id INTO v_ocr_queue_id
    FROM public.ocr_processing_queue
   WHERE blend_ticket_id = v_ocr_ticket;
  UPDATE public.blend_tickets
     SET driver_name = 'KEEP DRIVER', notes = 'KEEP NOTES', total_acres = 5,
         tank_number = NULL,
         manually_corrected_fields = ARRAY['tank_number']::text[]
   WHERE id = v_ocr_ticket;
  INSERT INTO public.blend_ticket_products (
    blend_ticket_id, product_id, product_name, quantity, unit,
    sequence_order, confidence_score, manually_corrected
  ) VALUES
    (v_ocr_ticket, v_product, 'MANUAL KEEP', 7, v_inventory_unit, 90, 100, true),
    (v_ocr_ticket, v_product, 'OLD OCR REPLACE', 8, v_inventory_unit, 91, 50, false);
  UPDATE public.ocr_processing_queue
     SET status = 'processing', started_at = now(), lease_token = v_ocr_lease,
         lease_heartbeat_at = now()
   WHERE id = v_ocr_queue_id;
  SELECT updated_at INTO v_updated_at FROM public.blend_tickets WHERE id = v_ocr_ticket;

  BEGIN
    PERFORM public.commit_blend_ticket_ocr_result(
      v_ocr_ticket, v_ocr_queue_id, gen_random_uuid(),
      jsonb_build_object('status', 'completed', 'ocr_confidence_score', 88),
      '[]'::jsonb, v_key_prefix || '-ocr-wrong-lease'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong lease committed OCR output';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(ocr)%' THEN RAISE; END IF;
    IF position('OCR_COMMIT_LEASE_LOST' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong lease error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.ocr_processing_queue WHERE id = v_ocr_queue_id) <> 'processing'
     OR (SELECT count(*) FROM public.blend_ticket_products WHERE blend_ticket_id = v_ocr_ticket) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong-lease rejection leaked ticket/product/queue effects';
  END IF;

  BEGIN
    PERFORM public.commit_blend_ticket_ocr_result(
      v_ocr_ticket, v_ocr_queue_id, v_ocr_lease,
      jsonb_build_object('status', 'completed', 'ocr_confidence_score', 88),
      '{}'::jsonb, v_key_prefix || '-ocr-invalid-payload'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): invalid product payload committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(ocr)%' THEN RAISE; END IF;
    IF position('OCR_COMMIT_PAYLOAD_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong invalid-payload error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.ocr_processing_queue WHERE id = v_ocr_queue_id) <> 'processing'
     OR (SELECT count(*) FROM public.blend_ticket_products WHERE blend_ticket_id = v_ocr_ticket) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): invalid-payload rejection leaked effects';
  END IF;

  BEGIN
    UPDATE public.blend_tickets SET review_status = 'approved' WHERE id = v_ocr_ticket;
    PERFORM public.commit_blend_ticket_ocr_result(
      v_ocr_ticket, v_ocr_queue_id, v_ocr_lease,
      jsonb_build_object('status', 'completed', 'ocr_confidence_score', 88),
      '[]'::jsonb, v_key_prefix || '-ocr-lifecycle-changed'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): approved ticket accepted stale OCR output';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(ocr)%' THEN RAISE; END IF;
    IF position('OCR_COMMIT_LIFECYCLE_CHANGED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong lifecycle-change error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT review_status FROM public.blend_tickets WHERE id = v_ocr_ticket) <> 'unreviewed'
     OR (SELECT status FROM public.ocr_processing_queue WHERE id = v_ocr_queue_id) <> 'processing' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): lifecycle rejection did not roll back atomically';
  END IF;

  UPDATE public.products SET is_active = false WHERE id = v_product2;
  BEGIN
    PERFORM public.commit_blend_ticket_ocr_result(
      v_ocr_ticket, v_ocr_queue_id, v_ocr_lease,
      jsonb_build_object('status', 'completed', 'ocr_confidence_score', 88),
      jsonb_build_array(jsonb_build_object(
        'product_id', v_product2,
        'product_name', 'INACTIVE OCR PRODUCT',
        'quantity', 2,
        'unit', v_inventory_unit2,
        'sequence_order', 1,
        'confidence_score', 77
      )),
      v_key_prefix || '-ocr-inactive-product'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): inactive product match committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(ocr)%' THEN RAISE; END IF;
    IF position('OCR_COMMIT_PRODUCT_MATCH_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong inactive-product error: %', SQLERRM;
    END IF;
  END;
  UPDATE public.products SET is_active = true WHERE id = v_product2;
  IF (SELECT status FROM public.ocr_processing_queue WHERE id = v_ocr_queue_id) <> 'processing'
     OR (SELECT count(*) FROM public.blend_ticket_products WHERE blend_ticket_id = v_ocr_ticket) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): inactive-product rejection leaked effects';
  END IF;

  v_result := public.commit_blend_ticket_ocr_result(
    v_ocr_ticket, v_ocr_queue_id, v_ocr_lease,
    jsonb_build_object(
      'status', 'completed',
      'ocr_confidence_score', 88,
      'raw_ocr_text', '[E2E] parsed',
      'driver_name', 'OCR OVERWRITE',
      'notes', 'OCR OVERWRITE',
      'total_acres', 99,
      'tank_number', 'OCR TANK'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product2,
      'product_name', 'NEW OCR PRODUCT',
      'quantity', 2,
      'unit', v_inventory_unit2,
      'sequence_order', 1,
      'confidence_score', 77
    )),
    v_key_prefix || '-ocr-commit-valid'
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.blend_tickets
        WHERE id = v_ocr_ticket AND status = 'completed'
          AND driver_name = 'KEEP DRIVER' AND notes = 'KEEP NOTES'
          AND total_acres = 5 AND tank_number IS NULL
          AND raw_ocr_text = '[E2E] parsed' AND ocr_confidence_score = 88
     ) OR NOT EXISTS (
       SELECT 1 FROM public.ocr_processing_queue
        WHERE id = v_ocr_queue_id AND status = 'completed'
          AND completed_at IS NOT NULL
          AND lease_token IS NULL AND lease_heartbeat_at IS NULL
     ) OR (SELECT count(*) FROM public.blend_ticket_products
            WHERE blend_ticket_id = v_ocr_ticket
              AND manually_corrected = true AND product_name = 'MANUAL KEEP') <> 1
     OR (SELECT count(*) FROM public.blend_ticket_products
            WHERE blend_ticket_id = v_ocr_ticket
              AND manually_corrected = false AND product_name = 'NEW OCR PRODUCT'
              AND quantity = 2) <> 1
     OR EXISTS (
       SELECT 1 FROM public.blend_ticket_products
        WHERE blend_ticket_id = v_ocr_ticket AND product_name = 'OLD OCR REPLACE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): valid atomic commit produced wrong ticket/product/queue state: %', v_result;
  END IF;
  BEGIN
    PERFORM public.save_blend_ticket(
      v_ocr_ticket,
      jsonb_build_object('_expected_updated_at', '2000-01-01T00:00:00Z', 'notes', 'stale after OCR'),
      '[]'::jsonb, v_admin, v_key_prefix || '-ticket-save-stale-after-ocr'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(save): pre-OCR form version overwrote committed OCR';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(save)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_STALE_EDIT' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(save): wrong post-OCR stale error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT notes FROM public.blend_tickets WHERE id = v_ocr_ticket) <> 'KEEP NOTES'
     OR NOT EXISTS (
       SELECT 1 FROM public.blend_ticket_products
        WHERE blend_ticket_id = v_ocr_ticket AND product_name = 'NEW OCR PRODUCT'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(save): stale post-OCR save changed committed OCR state';
  END IF;

  v_replay := public.commit_blend_ticket_ocr_result(
    v_ocr_ticket, v_ocr_queue_id, gen_random_uuid(),
    '{}'::jsonb, '{}'::jsonb,
    v_key_prefix || '-ocr-commit-valid'
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): idempotent OCR replay changed result';
  END IF;

  BEGIN
    PERFORM public.commit_blend_ticket_ocr_result(
      v_ocr_ticket, v_ocr_queue_id, v_ocr_lease,
      jsonb_build_object('status', 'completed', 'ocr_confidence_score', 90),
      '[]'::jsonb, v_key_prefix || '-ocr-stale-completed-lease'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): completed stale lease committed again';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(ocr)%' THEN RAISE; END IF;
    IF position('OCR_COMMIT_LEASE_LOST' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong stale-completed lease error: %', SQLERRM;
    END IF;
  END;

  PERFORM public.create_blend_ticket(
    v_bad_ticket,
    jsonb_build_object('ticket_date', current_date),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'storage_path', v_bad_ticket::text || '/1.jpg',
      'file_size', 1, 'mime_type', 'image/jpeg', 'upload_order', 1
    )),
    true, v_admin, v_key_prefix || '-ticket-delete-ocr'
  );
  SELECT id INTO v_ocr_queue_id FROM public.ocr_processing_queue
   WHERE blend_ticket_id = v_bad_ticket;
  BEGIN
    UPDATE public.blend_tickets SET deleted_at = now() WHERE id = v_bad_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(delete): pending OCR ticket was soft-deleted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(delete)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_DELETE_LIFECYCLE_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(delete): wrong pending-OCR delete error: %', SQLERRM;
    END IF;
  END;
  UPDATE public.ocr_processing_queue SET status = 'completed' WHERE id = v_ocr_queue_id;
  UPDATE public.blend_tickets SET deleted_at = now() WHERE id = v_bad_ticket;
  UPDATE public.ocr_processing_queue
     SET status = 'processing', lease_token = v_ocr_lease,
         lease_heartbeat_at = now()
   WHERE id = v_ocr_queue_id;
  BEGIN
    PERFORM public.commit_blend_ticket_ocr_result(
      v_bad_ticket, v_ocr_queue_id, v_ocr_lease,
      jsonb_build_object('status', 'completed', 'ocr_confidence_score', 90),
      '[]'::jsonb, v_key_prefix || '-ocr-deleted-ticket'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): soft-deleted ticket accepted OCR commit';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(ocr)%' THEN RAISE; END IF;
    IF position('OCR_COMMIT_TICKET_NOT_FOUND' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(ocr): wrong deleted-ticket OCR error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT status FROM public.ocr_processing_queue WHERE id = v_ocr_queue_id) <> 'processing'
     OR (SELECT deleted_at FROM public.blend_tickets WHERE id = v_bad_ticket) IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(ocr): deleted-ticket rejection leaked queue/ticket effects';
  END IF;

  v_result := public.create_blend_ticket(
    v_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'total_acres', 10,
      'notes', '[E2E] rollback-only gauntlet'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', NULL,
      'product_name', v_product_name,
      'quantity', 1,
      'unit', v_inventory_unit,
      'rate_per_acre', 0.1,
      'rate_per_acre_unit', v_inventory_unit || '/ac',
      'sequence_order', 1
    )),
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-create'
  );
  v_replay := public.create_blend_ticket(
    v_ticket,
    '{}'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-create'
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): create replay did not return the cached result';
  END IF;
  SELECT count(*) INTO v_count FROM public.blend_tickets WHERE id = v_ticket;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): atomic create produced % ticket rows', v_count;
  END IF;

  SELECT id INTO v_blend_product_id
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_ticket
   ORDER BY sequence_order, id
   LIMIT 1;
  SELECT updated_at INTO v_updated_at FROM public.blend_tickets WHERE id = v_ticket;
  v_result := public.save_blend_ticket(
    v_ticket,
    jsonb_build_object(
      '_expected_updated_at', v_updated_at,
      'notes', '[E2E] versioned save'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id', v_blend_product_id,
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity', 1,
        'unit', v_inventory_unit,
        'rate_per_acre', 0.1,
        'rate_per_acre_unit', v_inventory_unit || '/ac'
      ),
      jsonb_build_object(
        'id', v_new_save_product_id,
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity', 0.25,
        'unit', v_inventory_unit,
        'rate_per_acre', 0.025,
        'rate_per_acre_unit', v_inventory_unit || '/ac',
        'lot_number', '[E2E] local add'
      )
    ),
    v_admin,
    v_key_prefix || '-ticket-save-versioned'
  );
  v_replay := public.save_blend_ticket(
    v_ticket,
    jsonb_build_object('_expected_updated_at', '2000-01-01T00:00:00Z', 'notes', 'stale replay'),
    '[]'::jsonb,
    v_admin,
    v_key_prefix || '-ticket-save-versioned'
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR v_replay IS DISTINCT FROM v_result
     OR (SELECT notes FROM public.blend_tickets WHERE id = v_ticket) <> '[E2E] versioned save'
     OR NOT EXISTS (
       SELECT 1 FROM public.blend_ticket_products
        WHERE id = v_new_save_product_id
          AND blend_ticket_id = v_ticket
          AND sequence_order = 2
          AND lot_number = '[E2E] local add'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(save): versioned save/replay failed';
  END IF;
  SELECT updated_at INTO v_updated_at FROM public.blend_tickets WHERE id = v_ticket;
  SELECT id INTO v_blend_product_id
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_ticket
   ORDER BY sequence_order, id
   LIMIT 1;
  UPDATE public.blend_ticket_products
     SET lot_number = '[E2E] concurrent product correction'
   WHERE id = v_blend_product_id;
  IF (SELECT updated_at FROM public.blend_tickets WHERE id = v_ticket) = v_updated_at THEN
    RAISE EXCEPTION 'SMOKE_FAIL(save): product mutation did not advance parent version';
  END IF;
  BEGIN
    PERFORM public.save_blend_ticket(
      v_ticket,
      jsonb_build_object(
        '_expected_updated_at', v_updated_at,
        'notes', 'stale after product correction'
      ),
      jsonb_build_array(jsonb_build_object(
        'id', v_blend_product_id,
        'lot_number', '[E2E] stale product lot'
      )),
      v_admin,
      v_key_prefix || '-ticket-save-stale-product'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(save): stale product snapshot was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(save)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_STALE_EDIT' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(save): wrong stale-product error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT lot_number FROM public.blend_ticket_products WHERE id = v_blend_product_id)
       <> '[E2E] concurrent product correction' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(save): stale save overwrote concurrent product correction';
  END IF;
  SELECT updated_at INTO v_updated_at FROM public.blend_tickets WHERE id = v_ticket;
  v_result := public.save_blend_ticket(
    v_ticket,
    jsonb_build_object(
      '_expected_updated_at', v_updated_at,
      'notes', '[E2E] local remove committed'
    ),
    jsonb_build_array(jsonb_build_object(
      'id', v_blend_product_id,
      'product_id', NULL,
      'product_name', v_product_name,
      'quantity', 1,
      'unit', v_inventory_unit,
      'lot_number', '[E2E] concurrent product correction',
      'rate_per_acre', 0.1,
      'rate_per_acre_unit', v_inventory_unit || '/ac'
    )),
    v_admin,
    v_key_prefix || '-ticket-save-remove-product'
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR EXISTS (
       SELECT 1 FROM public.blend_ticket_products WHERE id = v_new_save_product_id
     ) OR (SELECT count(*) FROM public.blend_ticket_products WHERE blend_ticket_id = v_ticket) <> 1
     OR (SELECT product_id FROM public.blend_ticket_products WHERE id = v_blend_product_id) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(save): versioned product removal did not commit exactly';
  END IF;
  SELECT updated_at INTO v_updated_at FROM public.blend_tickets WHERE id = v_ticket;
  v_result := public.save_blend_ticket(
    v_ticket,
    jsonb_build_object('_expected_updated_at', v_updated_at),
    jsonb_build_array(jsonb_build_object(
      'id', v_blend_product_id,
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity', 1,
      'unit', v_inventory_unit,
      'lot_number', '[E2E] concurrent product correction',
      'rate_per_acre', 0.1,
      'rate_per_acre_unit', v_inventory_unit || '/ac'
    )),
    v_admin,
    v_key_prefix || '-ticket-save-restore-product-link'
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR (SELECT product_id FROM public.blend_ticket_products WHERE id = v_blend_product_id)
          IS DISTINCT FROM v_product THEN
    RAISE EXCEPTION 'SMOKE_FAIL(save): product link restore after explicit-null proof failed';
  END IF;
  BEGIN
    PERFORM public.save_blend_ticket(
      v_ticket, jsonb_build_object('notes', 'missing version'),
      '[]'::jsonb, v_admin, v_key_prefix || '-ticket-save-missing-version'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(save): missing expected version was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(save)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_EXPECTED_VERSION_REQUIRED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(save): wrong missing-version error: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM public.save_blend_ticket(
      v_ticket,
      jsonb_build_object('_expected_updated_at', '2000-01-01T00:00:00Z', 'notes', 'stale edit'),
      '[]'::jsonb, v_admin, v_key_prefix || '-ticket-save-stale'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(save): stale expected version was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(save)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_STALE_EDIT' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(save): wrong stale-version error: %', SQLERRM;
    END IF;
  END;

  -- Approved-but-empty tickets must not create even an empty order.
  PERFORM public.create_blend_ticket(
    v_empty_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'notes', '[E2E] approved empty lifecycle guard'
    ),
    '[]'::jsonb,
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-empty'
  );
  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_empty_ticket;
  v_result := public.create_order_from_blend_ticket(
    v_empty_ticket,
    '[E2E]-GAUNTLET-EMPTY-' || left(v_empty_ticket::text, 8),
    current_date,
    '[E2E] must reject an empty ticket',
    v_admin,
    v_key_prefix || '-order-empty'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, true) IS NOT FALSE
     OR position('no products' IN lower(COALESCE(v_result->>'error', ''))) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): approved empty ticket was not blocked: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.orders
     WHERE order_number = '[E2E]-GAUNTLET-EMPTY-' || left(v_empty_ticket::text, 8)
  ) OR EXISTS (
    SELECT 1 FROM public.blend_ticket_to_order_items
     WHERE blend_ticket_id = v_empty_ticket
  ) OR EXISTS (
    SELECT 1 FROM public.activity_feed
     WHERE related_entity_id = v_empty_ticket
       AND event_type IN ('blend_ticket_linked_to_order', 'order_created_from_blend_ticket')
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): empty-ticket rejection leaked order/link/activity effects';
  END IF;

  -- Billing cannot be forged on an unlinked ticket at either the RPC or the
  -- direct-table boundary.
  PERFORM public.create_blend_ticket(
    v_billed_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'total_acres', 1,
      'notes', '[E2E] billed lifecycle guard'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity', 1,
      'unit', v_inventory_unit,
      'rate_per_acre', 1,
      'rate_per_acre_unit', v_inventory_unit || '/ac',
      'sequence_order', 1
    )),
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-billed'
  );
  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_billed_ticket;
  BEGIN
    UPDATE public.blend_tickets SET deleted_at = now() WHERE id = v_billed_ticket;
    PERFORM public.create_invoice_from_blend_ticket(
      v_billed_ticket,
      v_admin,
      v_key_prefix || '-invoice-deleted-ticket'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend): soft-deleted ticket created an invoice';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend)%' THEN RAISE; END IF;
    IF position('Blend ticket not found' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong deleted-ticket invoice error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT deleted_at FROM public.blend_tickets WHERE id = v_billed_ticket) IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_billed_ticket)
     OR EXISTS (
       SELECT 1 FROM public.idempotency_keys
        WHERE idempotency_key = v_key_prefix || '-invoice-deleted-ticket'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): deleted-ticket invoice rejection leaked effects';
  END IF;
  v_result := public.update_blend_ticket_billing_status(
    v_billed_ticket,
    'billed',
    v_admin,
    v_key_prefix || '-billing-unlinked-rpc'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, true) IS NOT FALSE
     OR position('linked order or active invoice' IN lower(COALESCE(v_result->>'error', ''))) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): RPC billed an unlinked ticket: %', v_result;
  END IF;
  BEGIN
    UPDATE public.blend_tickets SET payment_status = 'billed' WHERE id = v_billed_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(blend): direct update billed an unlinked ticket';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_BILLING_REQUIRES_PROVENANCE' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong unlinked billing error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT payment_status FROM public.blend_tickets WHERE id = v_billed_ticket) <> 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): rejected unlinked billing changed payment state';
  END IF;
  INSERT INTO public.invoices (
    blend_ticket_id, customer_id, status, created_by
  ) VALUES (
    v_billed_ticket, v_customer, 'draft', v_admin
  ) RETURNING id INTO v_invoice_id;
  UPDATE public.blend_tickets SET payment_status = 'billed' WHERE id = v_billed_ticket;
  IF (SELECT payment_status FROM public.blend_tickets WHERE id = v_billed_ticket) <> 'billed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): active direct invoice did not establish valid billing provenance';
  END IF;
  UPDATE public.invoices SET status = 'posted' WHERE id = v_invoice_id;
  UPDATE public.invoices SET status = 'voided' WHERE id = v_invoice_id;
  IF (SELECT payment_status FROM public.blend_tickets WHERE id = v_billed_ticket) <> 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): voided direct invoice did not reset payment state';
  END IF;

  -- Prove the downstream triggers see an admin-owned invoice that invoice RLS
  -- deliberately hides from a different sales rep. This is the direct-invoice
  -- path: billed but unlinked, so only invoice provenance can lock products.
  INSERT INTO public.blend_ticket_fields (
    blend_ticket_id, field_id, customer_id, planned_acres, notes
  ) VALUES (
    v_billed_ticket, v_field, v_customer, 1, '[E2E] hidden invoice RLS guard'
  );
  INSERT INTO public.invoices (
    blend_ticket_id, customer_id, status, created_by
  ) VALUES (
    v_billed_ticket, v_customer, 'draft', v_admin
  ) RETURNING id INTO v_invoice_id;

  -- An active direct invoice is downstream provenance even while the ticket's
  -- cached payment status is still unbilled. Both order paths must reject
  -- under the locked ticket before creating any order, link, inventory,
  -- activity, audit, or idempotency effect.
  SELECT
      (SELECT count(*) FROM public.invoices WHERE blend_ticket_id = v_billed_ticket)
    + (SELECT count(*)
         FROM public.commissions c
         JOIN public.invoices i ON i.id = c.invoice_id
        WHERE i.blend_ticket_id = v_billed_ticket)
    + (SELECT count(*)
         FROM public.idempotency_keys
        WHERE idempotency_key = v_key_prefix || '-invoice-active-invoice')
    + (SELECT count(*)
         FROM public.activity_feed
        WHERE event_type = 'invoice_created'
          AND description LIKE '%blend ticket ' || (
            SELECT ticket_number FROM public.blend_tickets WHERE id = v_billed_ticket
          ) || '%')
    + (SELECT count(*)
         FROM public.financial_audit_log fal
         JOIN public.invoices i ON i.id = fal.entity_id
        WHERE fal.entity_type = 'invoice'
          AND i.blend_ticket_id = v_billed_ticket)
    INTO v_side_effect_count;

  BEGIN
    PERFORM public.link_blend_ticket_to_order(
      v_billed_ticket,
      gen_random_uuid(),
      NULL,
      v_admin,
      v_key_prefix || '-link-active-invoice'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): active-invoice link succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_ACTIVE_INVOICE_ORDER_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong active-invoice link error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.create_order_from_blend_ticket(
      v_billed_ticket,
      '[E2E]-GAUNTLET-ACTIVE-INVOICE-' || left(v_billed_ticket::text, 8),
      current_date,
      '[E2E] active invoice must block order creation',
      v_admin,
      v_key_prefix || '-order-active-invoice'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): active-invoice order creation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_ACTIVE_INVOICE_ORDER_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong active-invoice create-order error: %', SQLERRM;
    END IF;
  END;

  IF EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items
        WHERE blend_ticket_id = v_billed_ticket
     ) OR EXISTS (
       SELECT 1 FROM public.orders
        WHERE order_number = '[E2E]-GAUNTLET-ACTIVE-INVOICE-' || left(v_billed_ticket::text, 8)
     ) OR EXISTS (
       SELECT 1 FROM public.inventory_transactions
        WHERE notes = 'Prebooked for blend ticket order [E2E]-GAUNTLET-ACTIVE-INVOICE-' || left(v_billed_ticket::text, 8)
     ) OR EXISTS (
       SELECT 1 FROM public.activity_feed
        WHERE (related_entity_id = v_billed_ticket AND event_type = 'blend_ticket_linked_to_order')
           OR description LIKE '%[E2E]-GAUNTLET-ACTIVE-INVOICE-' || left(v_billed_ticket::text, 8) || '%'
     ) OR EXISTS (
       SELECT 1 FROM public.financial_audit_log
        WHERE entity_type = 'blend_ticket'
          AND entity_id = v_billed_ticket
          AND operation_type = 'blend_ticket_linked'
     ) OR EXISTS (
       SELECT 1 FROM public.idempotency_keys
        WHERE idempotency_key IN (
          v_key_prefix || '-link-active-invoice',
          v_key_prefix || '-order-active-invoice'
        )
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): active-invoice order rejection leaked side effects';
  END IF;

  BEGIN
    PERFORM public.create_invoice_from_blend_ticket(
      v_billed_ticket,
      v_admin,
      v_key_prefix || '-invoice-active-invoice'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): stale-unbilled active invoice was duplicated';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_ACTIVE_INVOICE_EXISTS' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong stale active-invoice error: %', SQLERRM;
    END IF;
  END;
  SELECT
      (SELECT count(*) FROM public.invoices WHERE blend_ticket_id = v_billed_ticket)
    + (SELECT count(*)
         FROM public.commissions c
         JOIN public.invoices i ON i.id = c.invoice_id
        WHERE i.blend_ticket_id = v_billed_ticket)
    + (SELECT count(*)
         FROM public.idempotency_keys
        WHERE idempotency_key = v_key_prefix || '-invoice-active-invoice')
    + (SELECT count(*)
         FROM public.activity_feed
        WHERE event_type = 'invoice_created'
          AND description LIKE '%blend ticket ' || (
            SELECT ticket_number FROM public.blend_tickets WHERE id = v_billed_ticket
          ) || '%')
    + (SELECT count(*)
         FROM public.financial_audit_log fal
         JOIN public.invoices i ON i.id = fal.entity_id
        WHERE fal.entity_type = 'invoice'
          AND i.blend_ticket_id = v_billed_ticket)
    INTO v_count;
  IF v_count <> v_side_effect_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): stale active-invoice rejection leaked invoice side effects';
  END IF;

  UPDATE public.blend_tickets
     SET payment_status = 'billed'
   WHERE id = v_billed_ticket;
  IF NOT EXISTS (
    SELECT 1 FROM public.blend_tickets
     WHERE id = v_billed_ticket
       AND payment_status = 'billed'
       AND order_link_status = 'unlinked'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): direct-invoice fixture is not billed and unlinked';
  END IF;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('role', 'authenticated', true);
  IF EXISTS (SELECT 1 FROM public.invoices WHERE id = v_invoice_id) THEN
    RESET role;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): sales fixture unexpectedly saw admin-owned invoice';
  END IF;
  SELECT driver_name INTO v_notes
    FROM public.blend_tickets
   WHERE id = v_billed_ticket;
  BEGIN
    UPDATE public.blend_tickets
       SET driver_name = '[E2E] forged driver through hidden invoice'
     WHERE id = v_billed_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): hidden-invoice header bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RESET role; RAISE; END IF;
    IF position('BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED' IN SQLERRM) = 0 THEN
      RESET role;
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong hidden-invoice header error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT driver_name FROM public.blend_tickets WHERE id = v_billed_ticket)
       IS DISTINCT FROM v_notes THEN
    RESET role;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): rejected hidden-invoice header mutation changed driver';
  END IF;
  SELECT id, quantity INTO v_billed_blend_product_id, v_quantity
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_billed_ticket
   ORDER BY sequence_order, id
   LIMIT 1;
  BEGIN
    UPDATE public.blend_ticket_products
       SET quantity = quantity + 1
     WHERE id = v_billed_blend_product_id;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): hidden-invoice product bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RESET role; RAISE; END IF;
    IF position('BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED' IN SQLERRM) = 0
       AND position('BLEND_TICKET_INVOICE_LOCKED' IN SQLERRM) = 0 THEN
      RESET role;
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong hidden-invoice product error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT quantity FROM public.blend_ticket_products WHERE id = v_billed_blend_product_id)
       IS DISTINCT FROM v_quantity THEN
    RESET role;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): rejected hidden-invoice product mutation changed quantity';
  END IF;
  BEGIN
    UPDATE public.blend_ticket_fields
       SET notes = '[E2E] forged field through hidden invoice'
     WHERE blend_ticket_id = v_billed_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): hidden-invoice field bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RESET role; RAISE; END IF;
    IF position('BLEND_TICKET_DOWNSTREAM_FIELDS_LOCKED' IN SQLERRM) = 0
       AND position('BLEND_TICKET_INVOICE_LOCKED' IN SQLERRM) = 0 THEN
      RESET role;
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong hidden-invoice field error: %', SQLERRM;
    END IF;
  END;
  RESET role;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  UPDATE public.invoices SET status = 'posted' WHERE id = v_invoice_id;
  UPDATE public.invoices SET status = 'voided' WHERE id = v_invoice_id;

  v_result := public.create_order_from_blend_ticket(
    v_ticket,
    '[E2E]-GAUNTLET-BLOCKED-' || left(v_ticket::text, 8),
    current_date,
    '[E2E] must be blocked before review',
    v_admin,
    v_key_prefix || '-order-blocked'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, true) IS NOT FALSE
     OR position('completed and approved' IN COALESCE(v_result->>'error', '')) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): unreviewed ticket was not blocked: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.orders
     WHERE order_number = '[E2E]-GAUNTLET-BLOCKED-' || left(v_ticket::text, 8)
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): blocked lifecycle call created an order';
  END IF;

  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_ticket;
  v_result := public.create_order_from_blend_ticket(
    v_ticket,
    '[E2E]-GAUNTLET-' || left(v_ticket::text, 8),
    current_date,
    '[E2E] rollback-only gauntlet',
    v_admin,
    v_key_prefix || '-order-create'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): approved ticket did not create order: %', v_result;
  END IF;
  v_order_id := (v_result->>'order_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.blend_ticket_to_order_items
     WHERE blend_ticket_id = v_ticket AND order_id = v_order_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.blend_tickets
     WHERE id = v_ticket AND order_link_status = 'linked'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): order effect was not atomically linked';
  END IF;
  v_replay := public.create_order_from_blend_ticket(
    v_ticket,
    '[E2E]-IGNORED-REPLAY-' || left(v_ticket::text, 8),
    current_date,
    NULL,
    v_admin,
    v_key_prefix || '-order-create'
  )::jsonb;
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): order replay did not return the cached result';
  END IF;

  -- The linked sales-order path and direct blend-ticket invoice path are
  -- mutually exclusive. The invoice RPC must reject before invoice numbering,
  -- commissions, activity, audit, or idempotency effects.
  BEGIN
    PERFORM public.create_invoice_from_blend_ticket(
      v_ticket,
      v_admin,
      v_key_prefix || '-invoice-linked-order'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend): linked ticket created a direct invoice';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_LINKED_ORDER_INVOICE_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong linked-ticket invoice error: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (
       SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_ticket
     ) OR EXISTS (
       SELECT 1 FROM public.commissions c
       JOIN public.invoices i ON i.id = c.invoice_id
        WHERE i.blend_ticket_id = v_ticket
     ) OR EXISTS (
       SELECT 1 FROM public.idempotency_keys
        WHERE idempotency_key = v_key_prefix || '-invoice-linked-order'
     ) OR EXISTS (
       SELECT 1 FROM public.activity_feed
        WHERE event_type = 'invoice_created'
          AND description LIKE '%blend ticket ' || (
            SELECT ticket_number FROM public.blend_tickets WHERE id = v_ticket
          ) || '%'
     ) OR EXISTS (
       SELECT 1 FROM public.financial_audit_log fal
       JOIN public.invoices i ON i.id = fal.entity_id
        WHERE fal.entity_type = 'invoice'
          AND i.blend_ticket_id = v_ticket
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): linked-ticket invoice rejection leaked side effects';
  END IF;

  -- Once linked, direct table writes cannot silently diverge the ticket from
  -- its order. Prove both a numeric field from the original narrow guard and
  -- an independently editable text field, plus the product database trigger.
  SELECT total_acres INTO v_quantity FROM public.blend_tickets WHERE id = v_ticket;
  BEGIN
    UPDATE public.blend_tickets SET total_acres = total_acres + 1 WHERE id = v_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): linked header mutation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_LINKED_CONTENT_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong linked-header error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT total_acres FROM public.blend_tickets WHERE id = v_ticket)
       IS DISTINCT FROM v_quantity THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): rejected header mutation changed total acres';
  END IF;

  SELECT notes INTO v_status FROM public.blend_tickets WHERE id = v_ticket;
  BEGIN
    UPDATE public.blend_tickets SET notes = '[E2E] forbidden linked note edit' WHERE id = v_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): linked text-content mutation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_LINKED_CONTENT_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong linked text-content error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT notes FROM public.blend_tickets WHERE id = v_ticket)
       IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): rejected text-content mutation changed notes';
  END IF;

  SELECT id, quantity INTO v_linked_blend_product_id, v_quantity
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_ticket
   ORDER BY sequence_order
   LIMIT 1;
  BEGIN
    UPDATE public.blend_ticket_products
     SET quantity = quantity + 1
     WHERE id = v_linked_blend_product_id;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): linked product mutation succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_LINKED_CONTENT_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong linked-product error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT quantity FROM public.blend_ticket_products WHERE id = v_linked_blend_product_id)
       IS DISTINCT FROM v_quantity THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): rejected product mutation changed quantity';
  END IF;

  BEGIN
    UPDATE public.blend_tickets SET order_link_status = 'unlinked' WHERE id = v_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): direct linked-to-unlinked flag bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_LINK_STATE_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong direct-unlink bypass error: %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE public.blend_tickets SET review_status = 'unreviewed' WHERE id = v_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): linked ticket was directly unapproved';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_SETTLED_LIFECYCLE_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong linked lifecycle error: %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE public.blend_tickets SET deleted_at = now() WHERE id = v_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): linked ticket was soft-deleted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_SETTLED_LIFECYCLE_INVALID' IN SQLERRM) = 0
       AND position('BLEND_TICKET_DELETE_LIFECYCLE_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong linked delete error: %', SQLERRM;
    END IF;
  END;

  SELECT id INTO v_order_item_id
    FROM public.order_items
   WHERE order_id = v_order_id
     AND product_id = v_product
   ORDER BY sort_order
   LIMIT 1;
  IF v_order_item_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): created order has no mapped product item';
  END IF;

  -- A two-product ticket cannot be partially mapped to a one-product order.
  PERFORM public.create_blend_ticket(
    v_partial_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'total_acres', 1,
      'notes', '[E2E] partial mapping guard'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity', 1,
        'unit', v_inventory_unit,
        'rate_per_acre', 1,
        'rate_per_acre_unit', v_inventory_unit || '/ac',
        'sequence_order', 1
      ),
      jsonb_build_object(
        'product_id', v_product2,
        'product_name', v_product2_name,
        'quantity', 1,
        'unit', v_inventory_unit2,
        'rate_per_acre', 1,
        'rate_per_acre_unit', v_inventory_unit2 || '/ac',
        'sequence_order', 2
      )
    ),
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-partial'
  );
  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_partial_ticket;
  BEGIN
    INSERT INTO public.blend_ticket_products (
      blend_ticket_id, product_id, product_name, quantity, unit,
      sequence_order, confidence_score
    ) VALUES (
      v_partial_ticket, v_product, '[E2E] nonfinite bypass', 'NaN'::numeric,
      v_inventory_unit, 99, 100
    );
    RAISE EXCEPTION 'SMOKE_FAIL(blend): direct NaN product insert bypassed the constraint';
  EXCEPTION WHEN check_violation THEN
    IF position('blend_ticket_products_finite_numbers' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong direct NaN constraint error: %', SQLERRM;
    END IF;
  END;
  SELECT id INTO v_blend_product_id
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_partial_ticket AND product_id = v_product
   ORDER BY sequence_order
   LIMIT 1;
  v_result := public.link_blend_ticket_to_order(
    v_partial_ticket,
    v_order_id,
    jsonb_build_array(jsonb_build_object(
      'blend_product_id', v_blend_product_id,
      'order_item_id', v_order_item_id,
      'quantity_applied', 1
    )),
    v_admin,
    v_key_prefix || '-link-partial'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, true) IS NOT FALSE
     OR (
       position('mapping' IN lower(COALESCE(v_result->>'error', ''))) = 0
       AND position('each blend line' IN lower(COALESCE(v_result->>'error', ''))) = 0
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): partial product mapping was not blocked: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.blend_ticket_to_order_items
     WHERE blend_ticket_id = v_partial_ticket
  ) OR EXISTS (
    SELECT 1 FROM public.blend_tickets
     WHERE id = v_partial_ticket AND order_link_status <> 'unlinked'
  ) OR EXISTS (
    SELECT 1 FROM public.financial_audit_log
     WHERE entity_type = 'blend_ticket' AND entity_id = v_partial_ticket
       AND operation_type = 'blend_ticket_linked'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): partial-mapping rejection leaked link/status/audit effects';
  END IF;

  BEGIN
    UPDATE public.blend_tickets SET order_link_status = 'linked' WHERE id = v_partial_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): direct unlinked-to-linked flag bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_LINK_STATE_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong direct-link bypass error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    UPDATE public.blend_ticket_products
       SET blend_ticket_id = v_partial_ticket
     WHERE id = v_linked_blend_product_id;
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): linked product was reparented to an unlinked ticket';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(blend-lock)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_LINKED_CONTENT_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): wrong linked-product reparent error: %', SQLERRM;
    END IF;
  END;
  IF (SELECT blend_ticket_id FROM public.blend_ticket_products
       WHERE id = v_linked_blend_product_id) IS DISTINCT FROM v_ticket THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend-lock): rejected reparent changed the product parent';
  END IF;

  -- Explicit mappings are keyed by the exact blend-product row and must sum to
  -- that row's finite quantity. Duplicate blend lines may deliberately share
  -- one matching order item without collapsing either source line.
  PERFORM public.create_blend_ticket(
    v_mapping_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'total_acres', 1,
      'notes', '[E2E] exact mapping guard'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity', 1,
      'unit', v_inventory_unit,
      'rate_per_acre', 1,
      'rate_per_acre_unit', v_inventory_unit || '/ac',
      'sequence_order', 1
    )),
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-mapping'
  );
  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_mapping_ticket;
  SELECT id INTO v_blend_product_id
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_mapping_ticket;

  v_result := public.link_blend_ticket_to_order(
    v_mapping_ticket,
    v_order_id,
    jsonb_build_array(jsonb_build_object(
      'blend_product_id', v_blend_product_id,
      'order_item_id', v_order_item_id,
      'quantity_applied', 0.5
    )),
    v_admin,
    v_key_prefix || '-link-wrong-sum'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, true) IS NOT FALSE
     OR position('sum to the exact finite blend quantity' IN COALESCE(v_result->>'error', '')) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): wrong mapping sum was not blocked: %', v_result;
  END IF;

  v_result := public.link_blend_ticket_to_order(
    v_mapping_ticket,
    v_order_id,
    jsonb_build_array(jsonb_build_object(
      'blend_product_id', v_blend_product_id,
      'order_item_id', v_order_item_id,
      'quantity_applied', 'Infinity'
    )),
    v_admin,
    v_key_prefix || '-link-infinite'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, true) IS NOT FALSE
     OR position('exact finite blend quantity' IN COALESCE(v_result->>'error', '')) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): infinite mapping quantity was not blocked: %', v_result;
  END IF;

  v_result := public.link_blend_ticket_to_order(
    v_mapping_ticket,
    v_order_id,
    jsonb_build_array(jsonb_build_object(
      'blend_product_id', v_blend_product_id,
      'order_item_id', v_order_item_id,
      'quantity_applied', 1
    )),
    v_admin,
    v_key_prefix || '-link-exact'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items
        WHERE blend_ticket_id = v_mapping_ticket
          AND blend_ticket_product_id = v_blend_product_id
          AND order_item_id = v_order_item_id
          AND quantity_applied = 1
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): exact line mapping did not link atomically: %', v_result;
  END IF;

  PERFORM public.create_blend_ticket(
    v_duplicate_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'total_acres', 1,
      'notes', '[E2E] duplicate order-line mapping guard'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product, 'product_name', v_product_name,
        'quantity', 0.4, 'unit', v_inventory_unit,
        'rate_per_acre', 0.4,
        'rate_per_acre_unit', v_inventory_unit || '/ac',
        'sequence_order', 1
      ),
      jsonb_build_object(
        'product_id', v_product, 'product_name', v_product_name,
        'quantity', 0.6, 'unit', v_inventory_unit,
        'rate_per_acre', 0.6,
        'rate_per_acre_unit', v_inventory_unit || '/ac',
        'sequence_order', 2
      )
    ),
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-duplicate-line'
  );
  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_duplicate_ticket;
  SELECT id INTO v_blend_product_id
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_duplicate_ticket AND sequence_order = 1;
  SELECT id INTO v_blend_product_id2
    FROM public.blend_ticket_products
   WHERE blend_ticket_id = v_duplicate_ticket AND sequence_order = 2;
  v_result := public.link_blend_ticket_to_order(
    v_duplicate_ticket,
    v_order_id,
    jsonb_build_array(
      jsonb_build_object(
        'blend_product_id', v_blend_product_id,
        'order_item_id', v_order_item_id,
        'quantity_applied', 0.4
      ),
      jsonb_build_object(
        'blend_product_id', v_blend_product_id2,
        'order_item_id', v_order_item_id,
        'quantity_applied', 0.6
      )
    ),
    v_admin,
    v_key_prefix || '-link-duplicate-line'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR (SELECT count(*) FROM public.blend_ticket_to_order_items
          WHERE blend_ticket_id = v_duplicate_ticket
            AND order_item_id = v_order_item_id) <> 2
     OR (SELECT count(DISTINCT blend_ticket_product_id)
           FROM public.blend_ticket_to_order_items
          WHERE blend_ticket_id = v_duplicate_ticket
            AND order_item_id = v_order_item_id) <> 2
     OR EXISTS (
       SELECT 1
         FROM public.blend_ticket_products btp
        WHERE btp.blend_ticket_id = v_duplicate_ticket
          AND COALESCE((
            SELECT sum(link.quantity_applied)
              FROM public.blend_ticket_to_order_items link
             WHERE link.blend_ticket_product_id = btp.id
          ), 0) IS DISTINCT FROM btp.quantity
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): duplicate order-line mappings collapsed exact source lines: %', v_result;
  END IF;

  -- create_order_from_blend_ticket must create a missing Main Warehouse row,
  -- not silently skip prebooking when inventory has not been initialized.
  PERFORM public.create_blend_ticket(
    v_inventory_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'total_acres', 1,
      'notes', '[E2E] missing inventory upsert guard'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product2,
      'product_name', v_product2_name,
      'quantity', 1,
      'unit', v_inventory_unit2,
      'rate_per_acre', 1,
      'rate_per_acre_unit', v_inventory_unit2 || '/ac',
      'sequence_order', 1
    )),
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-inventory-upsert'
  );
  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_inventory_ticket;
  DELETE FROM public.inventory
   WHERE product_id = v_product2 AND location = 'Main Warehouse';
  IF EXISTS (
    SELECT 1 FROM public.inventory
     WHERE product_id = v_product2 AND location = 'Main Warehouse'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(inventory): could not establish missing-row fixture';
  END IF;
  v_result := public.create_order_from_blend_ticket(
    v_inventory_ticket,
    '[E2E]-GAUNTLET-INVENTORY-' || left(v_inventory_ticket::text, 8),
    current_date,
    '[E2E] missing inventory row must upsert',
    v_admin,
    v_key_prefix || '-order-inventory-upsert'
  )::jsonb;
  v_inventory_order_id := (v_result->>'order_id')::uuid;
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.inventory
        WHERE product_id = v_product2
          AND location = 'Main Warehouse'
          AND quantity_prebooked > 0
     ) OR NOT EXISTS (
       SELECT 1 FROM public.inventory_transactions
        WHERE order_id = v_inventory_order_id
          AND product_id = v_product2
          AND transaction_type = 'booked'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(inventory): missing row was not upserted with booked effects: %', v_result;
  END IF;

  -- A fully valid ticket still cannot link across customer boundaries.
  PERFORM public.create_blend_ticket(
    v_wrong_customer_ticket,
    jsonb_build_object(
      'customer_id', v_customer2,
      'ticket_date', current_date,
      'total_acres', 1,
      'notes', '[E2E] wrong-customer link guard'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity', 1,
      'unit', v_inventory_unit,
      'rate_per_acre', 1,
      'rate_per_acre_unit', v_inventory_unit || '/ac',
      'sequence_order', 1
    )),
    '[]'::jsonb,
    false,
    v_admin,
    v_key_prefix || '-ticket-wrong-customer'
  );
  UPDATE public.blend_tickets
     SET review_status = 'approved', reviewed_by = v_admin, reviewed_at = now()
   WHERE id = v_wrong_customer_ticket;
  v_result := public.link_blend_ticket_to_order(
    v_wrong_customer_ticket,
    v_order_id,
    NULL,
    v_admin,
    v_key_prefix || '-link-wrong-customer'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, true) IS NOT FALSE
     OR position('customer mismatch' IN lower(COALESCE(v_result->>'error', ''))) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): cross-customer link was not blocked: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.blend_ticket_to_order_items
     WHERE blend_ticket_id = v_wrong_customer_ticket
  ) OR EXISTS (
    SELECT 1 FROM public.blend_tickets
     WHERE id = v_wrong_customer_ticket AND order_link_status <> 'unlinked'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): customer-mismatch rejection leaked link/status effects';
  END IF;

  SELECT count(*) INTO v_side_effect_count
    FROM public.activity_feed
   WHERE related_entity_type = 'blend_ticket'
     AND related_entity_id = v_wrong_customer_ticket
     AND event_type = 'blend_ticket_status_changed';
  v_result := public.update_blend_ticket_billing_status(
    v_wrong_customer_ticket,
    NULL,
    v_admin,
    v_key_prefix || '-billing-status-noop'
  )::jsonb;
  v_replay := public.update_blend_ticket_billing_status(
    v_wrong_customer_ticket,
    'billed',
    v_admin,
    v_key_prefix || '-billing-status-noop'
  )::jsonb;
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): no-op billing-status replay changed its result';
  END IF;
  SELECT payment_status INTO v_status
    FROM public.blend_tickets
   WHERE id = v_wrong_customer_ticket;
  IF v_status <> 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): no-op billing replay mutated status to %', v_status;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.activity_feed
   WHERE related_entity_type = 'blend_ticket'
     AND related_entity_id = v_wrong_customer_ticket
     AND event_type = 'blend_ticket_status_changed';
  IF v_count <> v_side_effect_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): no-op billing emitted a misleading status activity';
  END IF;
  SELECT count(*) INTO v_count
    FROM public.idempotency_keys
   WHERE idempotency_key = v_key_prefix || '-billing-status-noop'
     AND operation = 'update_blend_ticket_billing_status';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): no-op billing idempotency was not saved exactly once';
  END IF;

  v_result := public.update_blend_ticket_billing_status(
    v_ticket,
    'billed',
    v_admin,
    v_key_prefix || '-billing-status'
  )::jsonb;
  v_replay := public.update_blend_ticket_billing_status(
    v_ticket,
    'unbilled',
    v_admin,
    v_key_prefix || '-billing-status'
  )::jsonb;
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): billing-status replay changed its result';
  END IF;
  SELECT payment_status INTO v_status
    FROM public.blend_tickets
   WHERE id = v_ticket;
  IF v_status <> 'billed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): billing replay mutated status to %', v_status;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.activity_feed
   WHERE related_entity_type = 'blend_ticket'
     AND related_entity_id = v_ticket
     AND event_type = 'blend_ticket_status_changed';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(blend): billing replay emitted % status activities', v_count;
  END IF;
  BEGIN
    UPDATE public.blend_tickets SET status = 'needs_review' WHERE id = v_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(billing): billed ticket raw status bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(billing)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_SETTLED_LIFECYCLE_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(billing): wrong billed lifecycle error: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.unlink_blend_ticket_from_order(
      v_ticket, v_admin, v_key_prefix || '-unlink-billed'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(unlink): billed ticket unlinked';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(unlink)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_UNLINK_BILLING_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(unlink): wrong billed unlink error: %', SQLERRM;
    END IF;
  END;

  INSERT INTO public.invoices (
    blend_ticket_id, customer_id, status, created_by
  ) VALUES (
    v_ticket, v_customer, 'draft', v_admin
  ) RETURNING id INTO v_invoice_id;
  BEGIN
    UPDATE public.blend_tickets SET payment_status = 'unbilled' WHERE id = v_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(billing): active invoice allowed direct unbill';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(billing)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_ACTIVE_INVOICE_BILLING_LOCK' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(billing): wrong active-invoice unbill error: %', SQLERRM;
    END IF;
  END;

  -- Invoice cancellation is a terminal state and its trigger may safely reset
  -- the linked ticket to unbilled. The hardened unlink then accepts it.
  UPDATE public.invoices SET status = 'cancelled' WHERE id = v_invoice_id;
  IF (SELECT payment_status FROM public.blend_tickets WHERE id = v_ticket) <> 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(billing): cancelled invoice did not reset ticket to unbilled';
  END IF;
  v_result := public.unlink_blend_ticket_from_order(
    v_ticket, v_admin, v_key_prefix || '-unlink-cancelled-invoice'
  )::jsonb;
  v_replay := public.unlink_blend_ticket_from_order(
    v_ticket, v_admin, v_key_prefix || '-unlink-cancelled-invoice'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR v_replay IS DISTINCT FROM v_result
     OR EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items WHERE blend_ticket_id = v_ticket
     ) OR (SELECT order_link_status FROM public.blend_tickets WHERE id = v_ticket) <> 'unlinked' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(unlink): cancelled-invoice unlink/replay failed: %', v_result;
  END IF;

  -- An active invoice blocks an otherwise-unbilled link. Once voided, it is
  -- the other exact terminal state and unlink is valid.
  INSERT INTO public.invoices (
    blend_ticket_id, customer_id, status, created_by
  ) VALUES (
    v_mapping_ticket, v_customer, 'draft', v_admin
  ) RETURNING id INTO v_invoice_id;
  BEGIN
    PERFORM public.unlink_blend_ticket_from_order(
      v_mapping_ticket, v_admin, v_key_prefix || '-unlink-active-invoice'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(unlink): active-invoice ticket unlinked';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(unlink)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_UNLINK_INVOICE_EXISTS' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(unlink): wrong active-invoice unlink error: %', SQLERRM;
    END IF;
  END;
  UPDATE public.invoices SET status = 'posted' WHERE id = v_invoice_id;
  UPDATE public.invoices SET status = 'voided' WHERE id = v_invoice_id;
  v_result := public.unlink_blend_ticket_from_order(
    v_mapping_ticket, v_admin, v_key_prefix || '-unlink-voided-invoice'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR (SELECT order_link_status FROM public.blend_tickets WHERE id = v_mapping_ticket) <> 'unlinked' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(unlink): voided-invoice unlink failed: %', v_result;
  END IF;

  INSERT INTO public.blend_ticket_fields (
    blend_ticket_id, field_id, customer_id, planned_acres, notes
  ) VALUES (
    v_duplicate_ticket, v_field, v_customer, 1, '[E2E] downstream field lock'
  );
  INSERT INTO public.application_records (
    record_number, source_type, source_id, customer_id,
    application_date, product_data, created_by
  ) VALUES (
    '[E2E]-APP-' || left(v_duplicate_ticket::text, 8),
    'blend_ticket', v_duplicate_ticket, v_customer,
    current_date, '[]'::jsonb, v_admin
  );
  BEGIN
    PERFORM public.unlink_blend_ticket_from_order(
      v_duplicate_ticket, v_admin, v_key_prefix || '-unlink-application'
    );
    RAISE EXCEPTION 'SMOKE_FAIL(unlink): application-record ticket unlinked';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(unlink)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_UNLINK_APPLICATION_EXISTS' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(unlink): wrong application unlink error: %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE public.blend_tickets SET status = 'needs_review' WHERE id = v_duplicate_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): applied ticket status bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_SETTLED_LIFECYCLE_INVALID' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong settled status error: %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE public.blend_tickets
       SET season = COALESCE(season, EXTRACT(YEAR FROM current_date)::integer) + 1,
           salesman_id = v_sales,
           notes = '[E2E] forged after downstream snapshot'
     WHERE id = v_duplicate_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): applied ticket header content bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong downstream header error: %', SQLERRM;
    END IF;
  END;
  BEGIN
    UPDATE public.blend_ticket_fields
       SET notes = 'forged after application'
     WHERE blend_ticket_id = v_duplicate_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): applied ticket field bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_DOWNSTREAM_FIELDS_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong downstream field error: %', SQLERRM;
    END IF;
  END;
  -- Remove only the rollback fixture's link rows so the product trigger is
  -- proven against the application record itself, not merely linked status.
  DELETE FROM public.blend_ticket_to_order_items WHERE blend_ticket_id = v_duplicate_ticket;
  UPDATE public.blend_tickets SET order_link_status = 'unlinked' WHERE id = v_duplicate_ticket;
  BEGIN
    UPDATE public.blend_ticket_products
       SET quantity = quantity + 1
     WHERE blend_ticket_id = v_duplicate_ticket;
    RAISE EXCEPTION 'SMOKE_FAIL(downstream): applied ticket product bypass succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(downstream)%' THEN RAISE; END IF;
    IF position('BLEND_TICKET_DOWNSTREAM_CONTENT_LOCKED' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL(downstream): wrong downstream product error: %', SQLERRM;
    END IF;
  END;

  v_result := public.unlink_blend_ticket_from_order(
    v_inventory_ticket, v_admin, v_key_prefix || '-unlink-valid-unbilled'
  )::jsonb;
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR (SELECT order_link_status FROM public.blend_tickets WHERE id = v_inventory_ticket) <> 'unlinked'
     OR EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items WHERE blend_ticket_id = v_inventory_ticket
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(unlink): valid unbilled unlink failed: %', v_result;
  END IF;

  -- Sensitive inventory reporting excludes applicators but remains available
  -- to office roles. Function and policy grants stay closed to anon.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_applicator, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.get_inventory_position();
    RAISE EXCEPTION 'SMOKE_FAIL(inventory): applicator read sensitive inventory position';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(inventory)%' THEN RAISE; END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM public.get_inventory_position();

  -- Catalog proof is command-based, not policy-name based: table policy names
  -- may evolve, but these exact direct-write boundaries must not broaden.
  IF (SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'blend_tickets')
       IS DISTINCT FROM '{SELECT,UPDATE}'
     OR (SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'blend_ticket_products')
       IS DISTINCT FROM '{ALL}'
     OR (SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'blend_ticket_images')
       IS DISTINCT FROM '{SELECT}'
     OR (SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'ocr_processing_queue')
       IS DISTINCT FROM '{SELECT}'
     OR (SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'blend_ticket_fields')
       IS DISTINCT FROM '{ALL}'
     OR (SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'blend_ticket_to_order_items')
       IS DISTINCT FROM '{SELECT}' THEN
    RAISE EXCEPTION 'SMOKE_FAIL(rls): blend table policy command set broadened or narrowed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN (
         'blend_tickets', 'blend_ticket_products', 'blend_ticket_images',
         'ocr_processing_queue', 'blend_ticket_fields',
         'blend_ticket_to_order_items'
       )
       AND roles::text <> '{authenticated}'
  ) OR EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN (
         'blend_tickets', 'blend_ticket_products', 'blend_ticket_images',
         'ocr_processing_queue', 'blend_ticket_fields',
         'blend_ticket_to_order_items'
       )
       AND (
         position('is_admin()' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
         OR position('is_sales_rep()' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
       )
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(rls): blend table policy role/office predicates are not restrictive';
  END IF;

  IF (SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies
       WHERE schemaname = 'storage'
         AND tablename = 'objects'
         AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%blend-ticket-images%')
       IS DISTINCT FROM '{DELETE,INSERT,SELECT,UPDATE}'
     OR EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage'
          AND tablename = 'objects'
          AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%blend-ticket-images%'
          AND roles::text <> '{authenticated}'
     ) OR EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%blend-ticket-images%'
          AND cmd IN ('INSERT', 'SELECT')
          AND (
            position('is_admin()' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
            OR position('is_sales_rep()' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
          )
     ) OR EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%blend-ticket-images%'
          AND cmd IN ('UPDATE', 'DELETE')
          AND (
            position('is_admin()' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
            OR position('is_sales_rep()' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
            OR position('owner_id' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
            OR position('uploaded_by' IN COALESCE(qual, '') || COALESCE(with_check, '')) = 0
          )
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(storage): bucket policy commands/roles/office predicates are not restrictive';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets b
     WHERE b.id = 'blend-ticket-images'
       AND b.file_size_limit = 10485760
       AND cardinality(b.allowed_mime_types) = 3
       AND b.allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(storage): bucket MIME/10 MiB contract is missing';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );
  PERFORM public.create_blend_ticket(
    v_storage_ticket,
    jsonb_build_object(
      'customer_id', v_customer,
      'ticket_date', current_date,
      'notes', '[E2E] storage uploader policy fixture'
    ),
    '[]'::jsonb, '[]'::jsonb, false, v_sales,
    v_key_prefix || '-ticket-storage-uploader'
  );
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- Real RLS probes. Insert only metadata rows; no Storage bytes are created,
  -- and the terminal exception rolls the rows back with every other fixture.
  INSERT INTO storage.objects (
    id, bucket_id, name, owner, owner_id, metadata
  ) VALUES (
    v_storage_object,
    'blend-ticket-images',
    v_storage_ticket::text || '/1.jpg',
    v_admin,
    v_admin::text,
    '{"mimetype":"image/jpeg","size":1}'::jsonb
  );
  INSERT INTO storage.objects (
    id, bucket_id, name, owner, owner_id, metadata
  ) VALUES (
    v_storage_legacy_applicator_object,
    'blend-ticket-images',
    'legacy/' || v_key_prefix || '/applicator-owned.jpg',
    v_applicator,
    v_applicator::text,
    '{"mimetype":"image/jpeg","size":1}'::jsonb
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_applicator, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_count FROM public.blend_tickets WHERE id = v_partial_ticket;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): applicator read blend ticket'; END IF;
  UPDATE public.blend_tickets SET notes = notes WHERE id = v_partial_ticket;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): applicator updated blend ticket'; END IF;
  SELECT count(*) INTO v_count FROM storage.objects WHERE id = v_storage_object;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): applicator read office object'; END IF;
  UPDATE storage.objects SET metadata = metadata
   WHERE id = v_storage_legacy_applicator_object;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): legacy applicator owner updated office object'; END IF;
  BEGIN
    INSERT INTO storage.objects (id, bucket_id, name, owner, owner_id, metadata)
    VALUES (
      gen_random_uuid(), 'blend-ticket-images',
      'smoke/' || v_key_prefix || '/applicator-denied.jpg',
      v_applicator, v_applicator::text,
      '{"mimetype":"image/jpeg","size":1}'::jsonb
    );
    RAISE EXCEPTION 'SMOKE_FAIL(storage): applicator inserted office object';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(storage)%' THEN RESET role; RAISE; END IF;
    IF SQLERRM NOT LIKE '%row-level security%' THEN
      RESET role;
      RAISE EXCEPTION 'SMOKE_FAIL(storage): wrong applicator insert error: %', SQLERRM;
    END IF;
  END;
  RESET role;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = v_sales2;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_count FROM public.blend_tickets WHERE id = v_partial_ticket;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): sales could not read blend ticket'; END IF;
  UPDATE public.blend_tickets SET notes = notes WHERE id = v_partial_ticket;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): sales could not update blend ticket'; END IF;
  BEGIN
    INSERT INTO public.application_records (
      record_number, source_type, source_id, customer_id,
      application_date, product_data, created_by
    ) VALUES (
      '[E2E]-FORGED-' || left(gen_random_uuid()::text, 8),
      'blend_ticket', v_partial_ticket, v_customer,
      current_date, '[]'::jsonb, v_sales
    );
    RAISE EXCEPTION 'SMOKE_FAIL(rls): sales directly inserted legal application snapshot';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(rls)%' THEN RESET role; RAISE; END IF;
    IF SQLERRM NOT LIKE '%row-level security%' AND SQLERRM NOT LIKE '%permission denied%' THEN
      RESET role;
      RAISE EXCEPTION 'SMOKE_FAIL(rls): wrong application INSERT denial: %', SQLERRM;
    END IF;
  END;
  UPDATE public.application_records SET notes = notes
   WHERE source_type = 'blend_ticket' AND source_id = v_duplicate_ticket;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): sales directly updated legal application snapshot'; END IF;
  DELETE FROM public.blend_tickets WHERE id = v_wrong_customer_ticket;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): sales deleted blend ticket'; END IF;
  SELECT count(*) INTO v_count FROM storage.objects WHERE id = v_storage_object;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): sales could not read office object'; END IF;
  UPDATE storage.objects SET metadata = metadata WHERE id = v_storage_object;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): sales could not update office object'; END IF;
  INSERT INTO storage.objects (id, bucket_id, name, owner, owner_id, metadata)
  VALUES (
    v_storage_sales_object, 'blend-ticket-images',
    'smoke/' || v_key_prefix || '/sales-write-proof.jpg',
    v_sales, v_sales::text,
    '{"mimetype":"image/jpeg","size":1}'::jsonb
  );
  SELECT count(*) INTO v_count FROM storage.objects WHERE id = v_storage_sales_object;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): sales could not insert office object'; END IF;
  UPDATE storage.objects SET metadata = metadata WHERE id = v_storage_sales_object;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): object owner could not update object'; END IF;
  -- A permitted DELETE reaches Storage's protect_delete trigger in direct SQL;
  -- an RLS-denied delete below affects zero rows and never reaches that trigger.
  BEGIN
    DELETE FROM storage.objects WHERE id = v_storage_object;
    RAISE EXCEPTION 'SMOKE_FAIL(storage): uploader direct delete unexpectedly bypassed Storage API guard';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(storage)%' THEN RESET role; RAISE; END IF;
    IF SQLERRM LIKE '%row-level security%' OR SQLERRM LIKE '%permission denied%' THEN
      RESET role;
      RAISE EXCEPTION 'SMOKE_FAIL(storage): ticket uploader did not satisfy DELETE policy: %', SQLERRM;
    END IF;
  END;
  BEGIN
    DELETE FROM storage.objects WHERE id = v_storage_sales_object;
    RAISE EXCEPTION 'SMOKE_FAIL(storage): owner direct delete unexpectedly bypassed Storage API guard';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL(storage)%' THEN RESET role; RAISE; END IF;
    IF SQLERRM LIKE '%row-level security%' OR SQLERRM LIKE '%permission denied%' THEN
      RESET role;
      RAISE EXCEPTION 'SMOKE_FAIL(storage): object owner did not satisfy DELETE policy: %', SQLERRM;
    END IF;
  END;
  RESET role;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales2, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('role', 'authenticated', true);
  UPDATE storage.objects SET metadata = metadata
   WHERE id IN (v_storage_object, v_storage_sales_object);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): cross-sales user updated another user''s object'; END IF;
  -- storage.protect_delete is a direct-SQL guard that fires even when a DELETE
  -- would affect no rows. Cross-user DELETE denial is therefore proven by the
  -- exact DELETE catalog predicate above; the identical UPDATE identity
  -- boundary is exercised here with a zero-row result.
  RESET role;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO v_count FROM public.blend_tickets WHERE id = v_partial_ticket;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): admin could not read blend ticket'; END IF;
  SELECT count(*) INTO v_count FROM storage.objects WHERE id = v_storage_object;
  IF v_count <> 1 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(storage): admin could not read office object'; END IF;
  DELETE FROM public.blend_tickets WHERE id = v_wrong_customer_ticket;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RESET role; RAISE EXCEPTION 'SMOKE_FAIL(rls): admin hard-deleted blend ticket'; END IF;
  RESET role;

  IF has_function_privilege(
       'anon',
       'public.create_blend_ticket(uuid,jsonb,jsonb,jsonb,boolean,uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public.post_commission_payment(uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(grants): anon retained a changed mutator EXECUTE grant';
  END IF;
  IF NOT has_function_privilege(
       'authenticated',
       'public.create_application_record_from_blend_ticket(uuid,uuid,text)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'authenticated',
       'public.reverse_application_record(uuid,text)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.commit_blend_ticket_ocr_result(uuid,uuid,uuid,jsonb,jsonb,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(grants): canonical application/OCR RPC grants are wrong';
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
            'enforce_linked_blend_ticket_header_lock',
            'enforce_blend_ticket_fields_downstream_lock',
            'touch_blend_ticket_product_parent_version'
          )
          AND p.prosecdef
        GROUP BY n.nspname
       HAVING count(*) = 3
     ) OR has_function_privilege(
       'authenticated',
       'public.enforce_linked_blend_ticket_header_lock()',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.enforce_blend_ticket_fields_downstream_lock()',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public.enforce_linked_blend_ticket_header_lock()',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public.enforce_blend_ticket_fields_downstream_lock()',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public.enforce_linked_blend_ticket_header_lock()',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public.enforce_blend_ticket_fields_downstream_lock()',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.touch_blend_ticket_product_parent_version()',
       'EXECUTE'
     ) OR has_function_privilege(
       'anon',
       'public.touch_blend_ticket_product_parent_version()',
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public.touch_blend_ticket_product_parent_version()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(grants): downstream trigger definer/grant contract is wrong';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
