-- Rollback-only full-chain proof for the five Section 9 HIGH remediations.
-- Uses real PO/AP RPCs and synthetic [SMOKE] rows; terminal exception rolls
-- back every fixture and mutation.
DO $smoke$
DECLARE
  v_admin uuid;
  v_product uuid;
  v_product_name text;
  v_unit_size text;
  v_vendor uuid;
  v_vendor_name text;
  v_po uuid;
  v_po_item uuid;
  v_billed_po uuid;
  v_bill uuid;
  v_payment uuid;
  v_void_bill_po uuid;
  v_void_bill uuid;
  v_period uuid;
  v_period_count integer;
  v_notification_count integer;
  v_notification_replay_count integer;
  v_receipt uuid;
  v_result jsonb;
  v_items jsonb;
  v_baseline numeric;
  v_actual numeric;
  v_secondary_before numeric;
  v_secondary_after numeric;
  v_status text;
  -- Fixed pre-history fixture: never select a rolling date that could collide
  -- with real accounting history as time passes.
  v_old_date date := DATE '1990-01-15';
  v_err text;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  SELECT id, product_name, unit_size
  INTO v_product, v_product_name, v_unit_size
  FROM public.products
  WHERE is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_admin IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin and product required';
  END IF;

  -- Keep the fixed pre-history month collision-safe. The rollback chain never
  -- closes an existing historical period or attempts a close that a real
  -- unposted invoice would reject.
  IF EXISTS (
    SELECT 1
    FROM public.accounting_periods ap
    WHERE ap.period_start <= (date_trunc('month', v_old_date) + interval '1 month - 1 day')::date
      AND ap.period_end >= date_trunc('month', v_old_date)::date
  ) OR EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.invoice_date BETWEEN date_trunc('month', v_old_date)::date
      AND (date_trunc('month', v_old_date) + interval '1 month - 1 day')::date
      AND i.status IN ('draft', 'unposted')
      AND i.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: fixed pre-history month % is occupied', v_old_date;
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  SELECT COALESCE(SUM(GREATEST(
    poi.quantity_ordered - COALESCE(poi.quantity_received, 0),
    0
  )), 0)
  INTO v_baseline
  FROM public.purchase_order_items poi
  JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
  WHERE poi.product_id = v_product
    AND po.status IN ('submitted', 'partially_received');

  SELECT COALESCE(quantity_available, 0)
  INTO v_secondary_before
  FROM public.inventory
  WHERE product_id = v_product
    AND location = 'Secondary Warehouse';
  v_secondary_before := COALESCE(v_secondary_before, 0);

  v_vendor_name := '[SMOKE] Section 9 Vendor ' || v_suffix;
  INSERT INTO public.vendors (name)
  VALUES (v_vendor_name)
  RETURNING id INTO v_vendor;

  v_items := jsonb_build_array(jsonb_build_object(
    'product_id', v_product,
    'product_name', v_product_name,
    'quantity_ordered', 10,
    'unit_cost_cents', 100,
    'unit_size', v_unit_size
  ));

  v_result := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-S9-PO-' || v_suffix,
      'vendor', v_vendor_name,
      'status', 'draft'
    ),
    v_items,
    v_admin,
    'smk-s9-po-create-' || v_suffix
  );
  v_po := (v_result->>'po_id')::uuid;
  SELECT id INTO v_po_item
  FROM public.purchase_order_items
  WHERE purchase_order_id = v_po;

  PERFORM public.submit_purchase_order(
    v_po,
    v_admin,
    'smk-s9-po-submit-' || v_suffix
  );

  SELECT quantity_on_order INTO v_actual
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_actual IS DISTINCT FROM v_baseline + 10 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: submit on-order expected %, got %',
      v_baseline + 10,
      v_actual;
  END IF;

  -- Submitted-line edits must recompute, not retain the submit-time delta.
  v_items := jsonb_build_array(jsonb_build_object(
    'id', v_po_item,
    'product_id', v_product,
    'product_name', v_product_name,
    'quantity_ordered', 12,
    'unit_cost_cents', 100,
    'unit_size', v_unit_size
  ));
  PERFORM public.save_purchase_order(
    v_po,
    jsonb_build_object('vendor', v_vendor_name, 'status', 'submitted'),
    v_items,
    v_admin,
    'smk-s9-po-edit-submitted-' || v_suffix
  );

  SELECT quantity_on_order INTO v_actual
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_actual IS DISTINCT FROM v_baseline + 12 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: submitted edit on-order expected %, got %',
      v_baseline + 12,
      v_actual;
  END IF;

  v_result := public.receive_po_items(
    jsonb_build_array(jsonb_build_object(
      'po_item_id', v_po_item,
      'quantity', 5,
      'storage_location', 'Secondary Warehouse',
      'condition', 'good'
    )),
    v_admin,
    'smk-s9-receive-alt-' || v_suffix,
    false
  );
  v_receipt := ((v_result->'receiving_record_ids')->>0)::uuid;

  -- HIGH 4 regression: the same retained key must never report this first
  -- receipt as success for a changed receiving batch. The wrapper compares the
  -- canonical jsonb request before delegating, so the second call performs no
  -- inventory or PO mutation.
  BEGIN
    PERFORM public.receive_po_items(
      jsonb_build_array(jsonb_build_object(
        'po_item_id', v_po_item,
        'quantity', 4,
        'storage_location', 'Secondary Warehouse',
        'condition', 'good'
      )),
      v_admin,
      'smk-s9-receive-alt-' || v_suffix,
      false
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed receive batch replayed a prior success';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong changed receive replay error: %', v_err;
    END IF;
  END;

  SELECT quantity_on_order INTO v_actual
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT quantity_available INTO v_secondary_after
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Secondary Warehouse';
  IF v_actual IS DISTINCT FROM v_baseline + 7
     OR v_secondary_after IS DISTINCT FROM v_secondary_before + 5 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: alternate receive on-order=% expected=% stock=% expected=%',
      v_actual,
      v_baseline + 7,
      v_secondary_after,
      v_secondary_before + 5;
  END IF;

  -- A received line is immutable. The supported partially-received edit is an
  -- unchanged received line plus a new/unreceived line; its remainder must be
  -- included immediately.
  v_items := jsonb_build_array(
    jsonb_build_object(
      'id', v_po_item,
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity_ordered', 12,
      'unit_cost_cents', 100,
      'unit_size', v_unit_size
    ),
    jsonb_build_object(
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity_ordered', 2,
      'unit_cost_cents', 100,
      'unit_size', v_unit_size
    )
  );
  PERFORM public.save_purchase_order(
    v_po,
    jsonb_build_object(
      'vendor', v_vendor_name,
      'status', 'partially_received'
    ),
    v_items,
    v_admin,
    'smk-s9-po-edit-partial-' || v_suffix
  );

  SELECT quantity_on_order INTO v_actual
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_actual IS DISTINCT FROM v_baseline + 9 THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: partial edit on-order expected %, got %',
      v_baseline + 9,
      v_actual;
  END IF;

  PERFORM public.reverse_receiving_record(
    v_receipt,
    'Section 9 rollback smoke',
    v_admin,
    'smk-s9-reverse-' || v_suffix
  );

  SELECT quantity_on_order INTO v_actual
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT quantity_available INTO v_secondary_after
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Secondary Warehouse';
  IF v_actual IS DISTINCT FROM v_baseline + 14
     OR v_secondary_after IS DISTINCT FROM v_secondary_before THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: reversal on-order=% expected=% stock=% expected=%',
      v_actual,
      v_baseline + 14,
      v_secondary_after,
      v_secondary_before;
  END IF;

  PERFORM public.cancel_purchase_order(
    v_po,
    'Section 9 rollback smoke',
    v_admin,
    'smk-s9-cancel-' || v_suffix
  );
  SELECT quantity_on_order INTO v_actual
  FROM public.inventory
  WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_actual IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION
      'SMOKE_FAIL: cancellation on-order expected %, got %',
      v_baseline,
      v_actual;
  END IF;

  BEGIN
    PERFORM public.create_vendor_bill(
      p_vendor_id := v_vendor,
      p_purchase_order_id := v_po,
      p_bill_number := 'SMK-S9-CANCELLED-' || v_suffix,
      p_bill_date := CURRENT_DATE,
      p_subtotal_cents := 1400,
      p_idempotency_key := 'smk-s9-cancelled-bill-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: active bill created on cancelled PO';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'PO_NOT_BILLABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cancelled-PO bill error: %', v_err;
    END IF;
  END;

  -- Create a second billable PO and prove bill-first blocks cancellation.
  v_result := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-S9-BILLED-' || v_suffix,
      'vendor', v_vendor_name,
      'status', 'draft'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity_ordered', 1,
      'unit_cost_cents', 100,
      'unit_size', v_unit_size
    )),
    v_admin,
    'smk-s9-billed-po-create-' || v_suffix
  );
  v_billed_po := (v_result->>'po_id')::uuid;
  PERFORM public.submit_purchase_order(
    v_billed_po,
    v_admin,
    'smk-s9-billed-po-submit-' || v_suffix
  );
  v_bill := public.create_vendor_bill(
    p_vendor_id := v_vendor,
    p_purchase_order_id := v_billed_po,
    p_bill_number := 'SMK-S9-BILL-' || v_suffix,
    p_bill_date := v_old_date,
    p_subtotal_cents := 100,
    p_idempotency_key := 'smk-s9-bill-create-' || v_suffix
  );

  -- NULL and empty payment terms have different implementation semantics.
  -- Reusing one key across those requests must fail before a second bill can
  -- be created or a prior success can be reported for the changed intent.
  PERFORM public.create_vendor_bill(
    p_vendor_id := v_vendor,
    p_bill_number := 'SMK-S9-NULL-TERMS-' || v_suffix,
    p_bill_date := CURRENT_DATE,
    p_payment_terms := NULL,
    p_subtotal_cents := 100,
    p_idempotency_key := 'smk-s9-null-terms-' || v_suffix
  );
  BEGIN
    PERFORM public.create_vendor_bill(
      p_vendor_id := v_vendor,
      p_bill_number := 'SMK-S9-NULL-TERMS-' || v_suffix,
      p_bill_date := CURRENT_DATE,
      p_payment_terms := '',
      p_subtotal_cents := 100,
      p_idempotency_key := 'smk-s9-null-terms-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: NULL and empty payment terms shared an intent fingerprint';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong NULL/empty terms replay error: %', v_err;
    END IF;
  END;

  -- The browser key is derived from public receipt IDs, so server-side actor
  -- and payload binding must reject a guessed key pre-seeded with other text.
  PERFORM public.notify_damaged_receiving(
    'SMK-S9-PO-' || v_suffix,
    'damaged payload A',
    v_po,
    'smk-s9-damaged-notify-' || v_suffix
  );
  SELECT count(*) INTO v_notification_count
  FROM public.notifications
  WHERE notification_type = 'po_damaged_received'
    AND related_entity_id = v_po
    AND message LIKE '%damaged payload A%';
  PERFORM public.notify_damaged_receiving(
    'SMK-S9-PO-' || v_suffix,
    'damaged payload A',
    v_po,
    'smk-s9-damaged-notify-' || v_suffix
  );
  SELECT count(*) INTO v_notification_replay_count
  FROM public.notifications
  WHERE notification_type = 'po_damaged_received'
    AND related_entity_id = v_po
    AND message LIKE '%damaged payload A%';
  IF v_notification_count IS DISTINCT FROM v_notification_replay_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: exact damaged notification replay duplicated alerts';
  END IF;
  BEGIN
    PERFORM public.notify_damaged_receiving(
      'SMK-S9-PO-' || v_suffix,
      'damaged payload B',
      v_po,
      'smk-s9-damaged-notify-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed damaged notification replayed a prior success';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong changed damaged notification replay error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.update_vendor_bill(
      v_bill, 100, 0, v_old_date, v_old_date - 1,
      'invalid date range', 'smk-s9-update-bad-date-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: update accepted due date before bill date';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'INVALID_DATE_RANGE: due_date cannot precede bill_date' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong update date-range error: %', v_err;
    END IF;
  END;

  -- HIGH 2 regression: a changed bill edit using the first request's retained
  -- key must fail before touching this bill. Keep the successful request's
  -- amounts/date so the later accounting-period proof continues to exercise
  -- the same historical fixture.
  PERFORM public.update_vendor_bill(
    v_bill, 100, 0, v_old_date, v_old_date + 30,
    'Section 9 intent-bound edit', 'smk-s9-intent-update-' || v_suffix
  );
  BEGIN
    PERFORM public.update_vendor_bill(
      v_bill, 100, 0, v_old_date, v_old_date + 30,
      'changed edit must not replay', 'smk-s9-intent-update-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed vendor-bill edit replayed a prior success';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong changed vendor-bill replay error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.cancel_purchase_order(
      v_billed_po,
      'must fail with active bill',
      v_admin,
      'smk-s9-billed-po-cancel-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: cancelled PO with active bill';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'PO_HAS_ACTIVE_BILLS:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong active-bill cancel error: %', v_err;
    END IF;
  END;
  SELECT status INTO v_status
  FROM public.purchase_orders
  WHERE id = v_billed_po;
  IF v_status <> 'submitted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: failed cancel changed billed PO to %', v_status;
  END IF;

  -- Browser roles must have no direct master-data write path.
  IF has_table_privilege('authenticated', 'public.vendors', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vendors', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.vendors', 'DELETE')
     OR has_table_privilege('authenticated', 'public.vendors', 'TRUNCATE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated retains vendor mutation grant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.vendors'::regclass
      AND polcmd IN ('a', 'w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: vendors retains a browser write policy';
  END IF;
  IF has_table_privilege('authenticated', 'public.accounting_periods', 'INSERT')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'DELETE')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'TRIGGER')
     OR has_table_privilege('authenticated', 'public.accounting_periods', 'MAINTAIN')
     OR NOT has_table_privilege('authenticated', 'public.accounting_periods', 'SELECT')
     OR has_table_privilege('anon', 'public.accounting_periods', 'SELECT')
     OR has_table_privilege('anon', 'public.accounting_periods', 'MAINTAIN') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated retains accounting-period mutation grant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.accounting_periods'::regclass
      AND polcmd IN ('a', 'w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: accounting_periods retains a browser write policy';
  END IF;

  -- Current aging is truthful; unsupported past/future dates fail closed.
  PERFORM * FROM public.get_ap_aging(
    (clock_timestamp() AT TIME ZONE 'America/Chicago')::date
  );
  BEGIN
    PERFORM * FROM public.get_ap_aging(
      (clock_timestamp() AT TIME ZONE 'America/Chicago')::date - 1
    );
    RAISE EXCEPTION 'SMOKE_FAIL: past AP date returned a misleading snapshot';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'HISTORICAL_AP_UNAVAILABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong past AP error: %', v_err;
    END IF;
  END;
  BEGIN
    PERFORM * FROM public.get_ap_aging(
      (clock_timestamp() AT TIME ZONE 'America/Chicago')::date + 1
    );
    RAISE EXCEPTION 'SMOKE_FAIL: future AP date returned a snapshot';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'HISTORICAL_AP_UNAVAILABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong future AP error: %', v_err;
    END IF;
  END;

  -- Create a real payment and a second no-payment bill in the same fixed month.
  -- After close, each AP reversal/mutation must fail before changing history.
  v_payment := public.record_vendor_payment(
    p_vendor_bill_id := v_bill,
    p_amount_cents := 25,
    p_payment_date := v_old_date,
    p_payment_method := 'check',
    p_reference_number := 'SMK-S9-PAY-' || v_suffix,
    p_notes := 'Section 9 AP period boundary',
    p_idempotency_key := 'smk-s9-payment-' || v_suffix
  );

  v_result := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-S9-VOID-BILL-' || v_suffix,
      'vendor', v_vendor_name,
      'status', 'draft'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity_ordered', 1,
      'unit_cost_cents', 100,
      'unit_size', v_unit_size
    )),
    v_admin,
    'smk-s9-void-bill-po-create-' || v_suffix
  );
  v_void_bill_po := (v_result->>'po_id')::uuid;
  PERFORM public.submit_purchase_order(
    v_void_bill_po,
    v_admin,
    'smk-s9-void-bill-po-submit-' || v_suffix
  );
  v_void_bill := public.create_vendor_bill(
    p_vendor_id := v_vendor,
    p_purchase_order_id := v_void_bill_po,
    p_bill_number := 'SMK-S9-VOID-BILL-' || v_suffix,
    p_bill_date := v_old_date,
    p_subtotal_cents := 100,
    p_idempotency_key := 'smk-s9-void-bill-create-' || v_suffix
  );

  -- Close through the real RPC. This makes the registered PO/AP chain cover
  -- the authoritative check_period_open refusals, not a hand-written closed row.
  PERFORM public.close_accounting_period(
    (date_trunc('month', v_old_date) + interval '1 month - 1 day')::date,
    v_admin,
    'smk-s9-close-old-period-' || v_suffix
  );

  BEGIN
    PERFORM public.update_vendor_bill(
      v_bill,
      200,
      0,
      CURRENT_DATE,
      CURRENT_DATE + 30,
      'must not rewrite closed history',
      'smk-s9-closed-update-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: rewrote bill out of closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong closed-old-period error: %', v_err;
    END IF;
  END;
  IF (SELECT bill_date FROM public.vendor_bills WHERE id = v_bill)
       IS DISTINCT FROM v_old_date
     OR (SELECT total_cents FROM public.vendor_bills WHERE id = v_bill)
       IS DISTINCT FROM 100::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected closed-period edit leaked a change';
  END IF;

  BEGIN
    PERFORM public.record_vendor_payment(
      p_vendor_bill_id := v_bill,
      p_amount_cents := 10,
      p_payment_date := v_old_date,
      p_payment_method := 'check',
      p_reference_number := 'SMK-S9-CLOSED-PAY-' || v_suffix,
      p_notes := 'must fail in closed payment month',
      p_idempotency_key := 'smk-s9-closed-payment-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: recorded vendor payment in closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong closed-payment error: %', v_err;
    END IF;
  END;
  IF (SELECT paid_cents FROM public.vendor_bills WHERE id = v_bill)
       IS DISTINCT FROM 25::bigint
     OR (SELECT count(*) FROM public.vendor_payments WHERE vendor_bill_id = v_bill)
       IS DISTINCT FROM 1::bigint
     OR EXISTS (
       SELECT 1 FROM public.idempotency_keys
       WHERE idempotency_key = 'smk-s9-closed-payment-' || v_suffix
         AND operation = 'record_vendor_payment'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected closed-period payment leaked a change';
  END IF;

  BEGIN
    PERFORM public.void_vendor_payment(
      v_payment,
      'must fail in original closed payment month',
      'smk-s9-closed-payment-void-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: voided vendor payment in closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong closed-payment-void error: %', v_err;
    END IF;
  END;
  IF (SELECT voided_at FROM public.vendor_payments WHERE id = v_payment) IS NOT NULL
     OR (SELECT paid_cents FROM public.vendor_bills WHERE id = v_bill)
       IS DISTINCT FROM 25::bigint
     OR EXISTS (
       SELECT 1 FROM public.idempotency_keys
       WHERE idempotency_key = 'smk-s9-closed-payment-void-' || v_suffix
         AND operation = 'void_vendor_payment'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected closed-period payment void leaked a change';
  END IF;

  BEGIN
    PERFORM public.void_vendor_bill(
      v_void_bill,
      'must fail in original closed bill month',
      'smk-s9-closed-bill-void-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: voided vendor bill in closed period';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Date % falls in closed accounting period%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong closed-bill-void error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.vendor_bills WHERE id = v_void_bill)
       IS DISTINCT FROM 'unpaid'
     OR EXISTS (
       SELECT 1 FROM public.idempotency_keys
       WHERE idempotency_key = 'smk-s9-closed-bill-void-' || v_suffix
         AND operation = 'void_vendor_bill'
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected closed-period bill void leaked a change';
  END IF;

  -- Soft-deleted bills are historical records, not payable/voidable targets.
  UPDATE public.vendor_bills SET deleted_at = now() WHERE id = v_void_bill;
  BEGIN
    PERFORM public.record_vendor_payment(
      v_void_bill, 1, v_old_date, 'check', 'SMK-S9-DELETED-PAY-' || v_suffix,
      'must reject soft-deleted bill', 'smk-s9-deleted-pay-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: paid a soft-deleted vendor bill';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BILL_NOT_FOUND:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong soft-deleted payment error: %', v_err;
    END IF;
  END;
  BEGIN
    PERFORM public.void_vendor_bill(
      v_void_bill, 'must reject soft-deleted bill', 'smk-s9-deleted-void-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: voided a soft-deleted vendor bill';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BILL_NOT_FOUND:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong soft-deleted void error: %', v_err;
    END IF;
  END;

  -- The authenticated browser role can still read the closed row but cannot
  -- bypass the RPC boundary to reopen it directly.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_period_count
    FROM public.accounting_periods
    WHERE period_start = date_trunc('month', v_old_date)::date;
    IF v_period_count <> 1 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: authenticated SELECT lost accounting-period row';
    END IF;
    BEGIN
      UPDATE public.accounting_periods
      SET status = 'open'
      WHERE period_start = date_trunc('month', v_old_date)::date;
      RAISE EXCEPTION 'SMOKE_FAIL: authenticated directly reopened accounting period';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    EXECUTE 'RESET ROLE';
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE EXCEPTION '%', v_err; END IF;
    RAISE EXCEPTION 'SMOKE_FAIL: direct period write proof failed unexpectedly: %', v_err;
  END;

  -- Revoking direct table access must not break the governed RPC boundary.
  SELECT id INTO v_period
  FROM public.accounting_periods
  WHERE period_start = date_trunc('month', v_old_date)::date;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.reopen_accounting_period(
      v_period,
      'Section 9 governed RPC access proof',
      v_admin,
      'smk-s9-rpc-reopen-' || v_suffix
    );
    PERFORM public.close_accounting_period(
      (date_trunc('month', v_old_date) + interval '1 month - 1 day')::date,
      v_admin,
      'smk-s9-rpc-reclose-' || v_suffix
    );
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    EXECUTE 'RESET ROLE';
    RAISE EXCEPTION 'SMOKE_FAIL: governed period RPC access failed: %', v_err;
  END;
  IF (SELECT status FROM public.accounting_periods WHERE id = v_period) <> 'closed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: governed reopen/reclose did not leave period closed';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
