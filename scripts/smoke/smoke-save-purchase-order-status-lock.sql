-- Post-apply rollback-only proof for the purchase-order lifecycle correction.
-- Uses a real active product as an unchanged FK target; every created PO,
-- item, activity, and idempotency row is rolled back by the terminal exception.
DO $smoke$
DECLARE
  v_sales uuid;
  v_nonoffice uuid;
  v_product uuid;
  v_product_name text;
  v_unit_size text;
  v_unit_cost numeric;
  v_po uuid;
  v_item uuid;
  v_result jsonb;
  v_replay jsonb;
  v_items jsonb;
  v_edit_items jsonb;
  v_status text;
  v_vendor text;
  v_total_cost numeric;
  v_total_cost_cents bigint;
  v_saved_unit_cost numeric;
  v_saved_unit_cost_cents bigint;
  v_count bigint;
  v_err text;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_invalid_number text;
  v_po_number text;
  v_denied_number text;
BEGIN
  SELECT id INTO v_sales
  FROM profiles
  WHERE role = 'sales_rep' AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  SELECT id INTO v_nonoffice
  FROM profiles
  WHERE role IN ('driver', 'applicator') AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  SELECT id, product_name, unit_size, COALESCE(current_cost, 0)
    INTO v_product, v_product_name, v_unit_size, v_unit_cost
  FROM products
  WHERE is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_sales IS NULL OR v_nonoffice IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active sales rep, non-office user, and product required';
  END IF;

  v_invalid_number := 'SMK-PO-INVALID-' || v_suffix;
  v_po_number := 'SMK-PO-STATUS-' || v_suffix;
  v_denied_number := 'SMK-PO-DENIED-' || v_suffix;
  v_items := jsonb_build_array(jsonb_build_object(
    'product_id', v_product,
    'product_name', v_product_name,
    'quantity_ordered', 10.125,
    'unit_cost', 3.33,
    'unit_cost_cents', 333,
    'unit_size', v_unit_size,
    'quantity_received', 0
  ));

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );

  -- Ordinary save may never create directly in a lifecycle state.
  BEGIN
    PERFORM save_purchase_order(
      NULL,
      jsonb_build_object(
        'po_number', v_invalid_number,
        'vendor', '[SMOKE] Invalid Initial Status',
        'status', 'submitted',
        'submitted_date', CURRENT_DATE
      ),
      v_items,
      v_sales,
      'smk-po-invalid-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: save created a submitted purchase order';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVALID_INITIAL_PO_STATUS:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong initial-status error: %', v_err;
    END IF;
  END;

  SELECT count(*) INTO v_count
  FROM purchase_orders
  WHERE po_number = v_invalid_number;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected initial status left % PO rows', v_count;
  END IF;

  -- Fractional-cent legacy payloads are rejected before any row is written.
  BEGIN
    PERFORM save_purchase_order(
      NULL,
      jsonb_build_object(
        'po_number', v_invalid_number || '-FRACTION',
        'vendor', '[SMOKE] Fractional Cent',
        'status', 'draft'
      ),
      jsonb_build_array(jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 1,
        'unit_cost', 3.331,
        'unit_size', v_unit_size
      )),
      v_sales,
      NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: fractional-cent PO unit cost was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'PO_UNIT_COST_FRACTIONAL_CENT:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong fractional-cent error: %', v_err;
    END IF;
  END;

  -- Positive path: save one draft and prove exact idempotent replay.
  v_result := save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', v_po_number,
      'vendor', '[SMOKE] Draft Vendor',
      'status', 'draft',
      'submitted_date', NULL,
      'expected_delivery_date', CURRENT_DATE + 7,
      'notes', 'status-lock smoke'
    ),
    v_items,
    v_sales,
    'smk-po-create-' || v_suffix
  );
  v_po := (v_result->>'po_id')::uuid;
  IF v_po IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draft save returned no po_id: %', v_result;
  END IF;

  v_replay := save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', v_po_number,
      'vendor', '[SMOKE] Draft Vendor',
      'status', 'draft'
    ),
    v_items,
    v_sales,
    'smk-po-create-' || v_suffix
  );
  IF (v_replay->>'po_id')::uuid IS DISTINCT FROM v_po THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draft replay changed PO from % to %', v_po, v_replay;
  END IF;

  SELECT status, vendor INTO v_status, v_vendor
  FROM purchase_orders
  WHERE id = v_po;
  SELECT id INTO v_item
  FROM purchase_order_items
  WHERE purchase_order_id = v_po;
  SELECT total_cost, total_cost_cents
    INTO v_total_cost, v_total_cost_cents
  FROM purchase_orders
  WHERE id = v_po;
  SELECT unit_cost, unit_cost_cents
    INTO v_saved_unit_cost, v_saved_unit_cost_cents
  FROM purchase_order_items
  WHERE id = v_item;
  SELECT count(*) INTO v_count
  FROM activity_feed
  WHERE related_entity_type = 'purchase_order'
    AND related_entity_id = v_po
    AND event_type = 'po_created';
  IF v_status <> 'draft' OR v_vendor <> '[SMOKE] Draft Vendor'
     OR v_item IS NULL OR v_count <> 1
     OR v_total_cost IS DISTINCT FROM 33.72::numeric
     OR v_total_cost_cents IS DISTINCT FROM 3372::bigint
     OR v_saved_unit_cost IS DISTINCT FROM 3.33::numeric
     OR v_saved_unit_cost_cents IS DISTINCT FROM 333::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draft/replay state status=% vendor=% item=% events=% total=% cents=% unit=% unit_cents=%',
      v_status, v_vendor, v_item, v_count, v_total_cost, v_total_cost_cents,
      v_saved_unit_cost, v_saved_unit_cost_cents;
  END IF;

  v_edit_items := jsonb_build_array(jsonb_build_object(
    'id', v_item,
    'product_id', v_product,
    'product_name', v_product_name,
    'quantity_ordered', 10.125,
    'unit_cost', 3.33,
    'unit_cost_cents', 333,
    'unit_size', v_unit_size,
    'quantity_received', 0
  ));
  PERFORM save_purchase_order(
    v_po,
    jsonb_build_object(
      'vendor', '[SMOKE] Edited Draft Vendor',
      'status', 'draft',
      'notes', 'legal draft edit'
    ),
    v_edit_items,
    v_sales,
    'smk-po-edit-' || v_suffix
  );
  SELECT status, vendor INTO v_status, v_vendor
  FROM purchase_orders WHERE id = v_po;
  IF v_status <> 'draft' OR v_vendor <> '[SMOKE] Edited Draft Vendor' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legal draft edit produced status=% vendor=%', v_status, v_vendor;
  END IF;

  -- An existing-line edit may omit the unchanged cost. The wrapper must feed
  -- the stored integer-cent value into every downstream calculation so neither
  -- the line nor the header silently resets to zero.
  v_edit_items := jsonb_build_array(jsonb_build_object(
    'id', v_item,
    'product_id', v_product,
    'product_name', v_product_name,
    'quantity_ordered', 10.125,
    'unit_size', v_unit_size,
    'quantity_received', 0
  ));
  PERFORM save_purchase_order(
    v_po,
    jsonb_build_object(
      'vendor', '[SMOKE] Cost-Preserving Draft Vendor',
      'status', 'draft'
    ),
    v_edit_items,
    v_sales,
    'smk-po-omit-cost-' || v_suffix
  );
  SELECT total_cost, total_cost_cents
    INTO v_total_cost, v_total_cost_cents
  FROM purchase_orders
  WHERE id = v_po;
  SELECT unit_cost, unit_cost_cents
    INTO v_saved_unit_cost, v_saved_unit_cost_cents
  FROM purchase_order_items
  WHERE id = v_item;
  IF v_total_cost IS DISTINCT FROM 33.72::numeric
     OR v_total_cost_cents IS DISTINCT FROM 3372::bigint
     OR v_saved_unit_cost IS DISTINCT FROM 3.33::numeric
     OR v_saved_unit_cost_cents IS DISTINCT FROM 333::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: omitted cost changed money header=% cents=% line=% line_cents=%',
      v_total_cost, v_total_cost_cents, v_saved_unit_cost, v_saved_unit_cost_cents;
  END IF;

  -- Status transitions are owned by dedicated lifecycle RPCs.
  BEGIN
    PERFORM save_purchase_order(
      v_po,
      jsonb_build_object('vendor', v_vendor, 'status', 'submitted'),
      v_edit_items,
      v_sales,
      'smk-po-bypass-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: ordinary save submitted a draft PO';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'PO_STATUS_RPC_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edit-status error: %', v_err;
    END IF;
  END;
  SELECT status INTO v_status FROM purchase_orders WHERE id = v_po;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected edit changed status to %', v_status;
  END IF;

  v_result := submit_purchase_order(
    v_po,
    v_sales,
    'smk-po-submit-' || v_suffix
  );
  v_replay := submit_purchase_order(
    v_po,
    v_sales,
    'smk-po-submit-' || v_suffix
  );
  SELECT status INTO v_status FROM purchase_orders WHERE id = v_po;
  SELECT count(*) INTO v_count
  FROM activity_feed
  WHERE related_entity_type = 'purchase_order'
    AND related_entity_id = v_po
    AND event_type = 'po_submitted';
  IF v_status <> 'submitted'
     OR (v_result->>'po_id')::uuid IS DISTINCT FROM v_po
     OR v_replay IS DISTINCT FROM v_result
     OR v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: dedicated submit/replay state status=% first=% replay=% events=%',
      v_status, v_result, v_replay, v_count;
  END IF;

  BEGIN
    PERFORM save_purchase_order(
      v_po,
      jsonb_build_object('vendor', v_vendor, 'status', 'draft'),
      v_edit_items,
      v_sales,
      'smk-po-downgrade-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: ordinary save downgraded a submitted PO';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'PO_STATUS_RPC_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong downgrade error: %', v_err;
    END IF;
  END;
  SELECT status INTO v_status FROM purchase_orders WHERE id = v_po;
  IF v_status <> 'submitted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected downgrade changed status to %', v_status;
  END IF;

  -- Active field users remain outside the office PO-management boundary.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_nonoffice, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM save_purchase_order(
      NULL,
      jsonb_build_object(
        'po_number', v_denied_number,
        'vendor', '[SMOKE] Denied User',
        'status', 'draft'
      ),
      v_items,
      v_nonoffice,
      'smk-po-denied-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: non-office user saved a purchase order';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'Only admins or sales reps can manage purchase orders%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong non-office error: %', v_err;
    END IF;
  END;
  SELECT count(*) INTO v_count
  FROM purchase_orders
  WHERE po_number = v_denied_number;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: denied non-office save left % PO rows', v_count;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
