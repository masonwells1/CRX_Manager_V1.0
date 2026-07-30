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
  v_receipt uuid;
  v_result jsonb;
  v_items jsonb;
  v_baseline numeric;
  v_actual numeric;
  v_secondary_before numeric;
  v_secondary_after numeric;
  v_status text;
  v_old_date date := CURRENT_DATE - 400;
  v_closed_period uuid;
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

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

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
    p_bill_date := CURRENT_DATE,
    p_subtotal_cents := 100,
    p_idempotency_key := 'smk-s9-bill-create-' || v_suffix
  );

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

  -- Simulate a legacy unpaid bill whose original period is now closed. The
  -- update must reject before moving its date or changing its money.
  UPDATE public.vendor_bills
  SET bill_date = v_old_date,
      due_date = v_old_date + 30
  WHERE id = v_bill;
  INSERT INTO public.accounting_periods (
    period_start,
    period_end,
    status,
    closed_by,
    closed_at,
    notes
  ) VALUES (
    date_trunc('month', v_old_date)::date,
    (date_trunc('month', v_old_date) + interval '1 month - 1 day')::date,
    'closed',
    v_admin,
    now(),
    '[SMOKE] Section 9 old bill period'
  ) RETURNING id INTO v_closed_period;

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
    IF v_err NOT LIKE '%closed%' AND v_err NOT LIKE '%CLOSED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong closed-old-period error: %', v_err;
    END IF;
  END;
  IF (SELECT bill_date FROM public.vendor_bills WHERE id = v_bill)
       IS DISTINCT FROM v_old_date
     OR (SELECT total_cents FROM public.vendor_bills WHERE id = v_bill)
       IS DISTINCT FROM 100::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected closed-period edit leaked a change';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
