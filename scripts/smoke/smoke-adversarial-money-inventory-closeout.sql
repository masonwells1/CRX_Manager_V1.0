-- Post-apply rollback-only proof for migrations 20260716213000,
-- 20260716224000, 20260716233000, 20260717010000, 20260717015439,
-- 20260717032000, 20260717045420, 20260717063445, 20260717070900,
-- 20260717081856, and 20260717085512.
-- Exercises the exact adversarial findings without retaining business rows.
DO $smoke$
DECLARE
  v_admin uuid;
  v_sales uuid;
  v_owned_customer uuid;
  v_other_customer uuid;
  v_other_invoice uuid;
  v_product uuid;
  v_product_name text;
  v_unit_size text;
  v_po uuid;
  v_po_item uuid;
  v_vendor uuid;
  v_rounding_po uuid;
  v_rounding_bill uuid;
  v_open_date date;
  v_vendor_name text;
  v_first jsonb;
  v_replay jsonb;
  v_edit_items jsonb;
  v_total_cents bigint;
  v_line_cents bigint;
  v_count bigint;
  v_err text;
  v_source text;
  v_outer_source text;
  v_identity_source text;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_intent text;
  v_vendor_reference text;
  v_other_invoice_key text;
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
  SELECT id, product_name, unit_size
    INTO v_product, v_product_name, v_unit_size
    FROM public.products
   WHERE is_active = true
   ORDER BY created_at
   LIMIT 1;
  IF v_admin IS NULL OR v_sales IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin, sales rep, and product required';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Owned Adversarial Customer ' || v_suffix, v_sales)
  RETURNING id INTO v_owned_customer;
  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Other Adversarial Customer ' || v_suffix, NULL)
  RETURNING id INTO v_other_customer;

  v_other_invoice_key := 'smk-invoice-other-' || v_suffix;
  v_other_invoice := public.save_invoice(
    jsonb_build_object(
      'customer_id', v_other_customer,
      'invoice_type', 'misc_charge',
      'status', 'draft',
      'invoice_date', CURRENT_DATE
    ),
    '[]'::jsonb,
    v_other_invoice_key
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );

  -- A key cached for another customer cannot be replayed with an assigned
  -- decoy customer to obtain that invoice ID.
  BEGIN
    PERFORM public.save_invoice(
      jsonb_build_object(
        'customer_id', v_owned_customer,
        'invoice_type', 'misc_charge',
        'status', 'draft',
        'salesman_id', v_sales,
        'invoice_date', CURRENT_DATE
      ),
      '[]'::jsonb,
      v_other_invoice_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: decoy payload replay returned another customer invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'IDEMPOTENCY_PAYLOAD_CONFLICT' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong decoy replay error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.post_invoice(
      v_other_invoice,
      'smk-post-other-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales rep posted another customer invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'CUSTOMER_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong post scope error: %', v_err;
    END IF;
  END;

  -- Missing product IDs may not contribute to a header while being silently
  -- excluded from stored lines.
  BEGIN
    PERFORM public.save_purchase_order(
      NULL,
      jsonb_build_object(
        'po_number', 'SMK-MISSING-' || v_suffix,
        'vendor', '[SMOKE] Missing Product',
        'status', 'draft'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'quantity_ordered', 4,
          'unit_cost_cents', 250
        )
      ),
      v_sales,
      'smk-po-missing-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: missing-product line was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'PO_ITEM_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong missing-product error: %', v_err;
    END IF;
  END;

  v_vendor_reference := 'SMK-INV-' || v_suffix;
  v_intent := 'bulk-po-document:' || encode(
    extensions.digest(
      convert_to(
        translate(
          '[SMOKE] Élan Bulk Intent Vendor',
          'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          'abcdefghijklmnopqrstuvwxyz'
        ) || chr(31) || translate(
          v_vendor_reference,
          'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          'abcdefghijklmnopqrstuvwxyz'
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  -- Direct RPC callers cannot create a global claim without vendor identity.
  BEGIN
    PERFORM public.save_purchase_order(
      NULL,
      jsonb_build_object(
        'vendor', '   ',
        'status', 'draft',
        'bulk_import_vendor_reference', v_vendor_reference,
        'bulk_import_invoice_date', CURRENT_DATE::text,
        'bulk_import_intent_key', v_intent || '-missing-vendor'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'product_name', v_product_name,
          'quantity_ordered', 1,
          'unit_cost_cents', 333,
          'unit_size', v_unit_size
        )
      ),
      v_sales,
      'smk-po-bulk-missing-vendor-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: vendorless bulk claim was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'BULK_PO_VENDOR_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong vendorless claim error: %', v_err;
    END IF;
  END;

  -- The public RPC boundary must reject OCR/integration values that contain
  -- only invisible whitespace, even when a caller bypasses the browser.
  BEGIN
    PERFORM public.save_purchase_order(
      NULL,
      jsonb_build_object(
        'vendor', chr(160) || chr(9),
        'status', 'draft',
        'bulk_import_vendor_reference', v_vendor_reference,
        'bulk_import_invoice_date', CURRENT_DATE::text,
        'bulk_import_intent_key', v_intent || '-invisible-vendor'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'product_name', v_product_name,
          'quantity_ordered', 1,
          'unit_cost_cents', 333,
          'unit_size', v_unit_size
        )
      ),
      v_sales,
      'smk-po-bulk-invisible-vendor-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: invisible-only bulk vendor was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'BULK_PO_VENDOR_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong invisible-vendor error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.save_purchase_order(
      NULL,
      jsonb_build_object(
        'vendor', '[SMOKE] Élan Bulk Intent Vendor',
        'status', 'draft',
        'bulk_import_vendor_reference', chr(160) || chr(9),
        'bulk_import_invoice_date', CURRENT_DATE::text,
        'bulk_import_intent_key', v_intent || '-invisible-reference'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'product_name', v_product_name,
          'quantity_ordered', 1,
          'unit_cost_cents', 333,
          'unit_size', v_unit_size
        )
      ),
      v_sales,
      'smk-po-bulk-invisible-reference-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: invisible-only bulk vendor reference was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'BULK_PO_VENDOR_REFERENCE_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong invisible-reference error: %', v_err;
    END IF;
  END;

  v_first := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-BULK-A-' || v_suffix,
      'vendor', chr(160) || '[SMOKE] Élan Bulk Intent Vendor' || chr(9),
      'status', 'draft',
      'bulk_import_vendor_reference', chr(9) || v_vendor_reference || chr(160),
      'bulk_import_invoice_date', CURRENT_DATE::text,
      'bulk_import_intent_key', v_intent
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
        'unit_cost_cents', 333,
        'unit_size', v_unit_size
      )
    ),
    v_sales,
    'smk-po-bulk-first-' || v_suffix
  );
  v_po := (v_first->>'po_id')::uuid;

  SELECT vendor
    INTO v_vendor_name
    FROM public.purchase_orders
   WHERE id = v_po;
  IF v_vendor_name IS DISTINCT FROM '[SMOKE] Élan Bulk Intent Vendor' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: padded bulk identity was not stored canonically: %',
      v_vendor_name;
  END IF;

  -- The exact same request key represents a lost-response retry. It must
  -- replay the original saved result, not be reclassified as a duplicate.
  v_replay := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-BULK-A-' || v_suffix,
      'vendor', '[SMOKE] Élan Bulk Intent Vendor',
      'status', 'draft',
      'bulk_import_vendor_reference', v_vendor_reference,
      'bulk_import_invoice_date', CURRENT_DATE::text,
      'bulk_import_intent_key', v_intent
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
        'unit_cost_cents', 333,
        'unit_size', v_unit_size
      )
    ),
    v_sales,
    'smk-po-bulk-first-' || v_suffix
  );
  IF v_replay->>'status' IS DISTINCT FROM 'saved'
     OR (v_replay->>'po_id')::uuid IS DISTINCT FROM v_po
     OR v_replay->>'po_number' IS DISTINCT FROM v_first->>'po_number' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-key bulk replay changed result first=% replay=%',
      v_first, v_replay;
  END IF;

  -- A different generic request key with the unpadded form must resolve the
  -- same durable document claim created from the padded direct-RPC payload.
  v_replay := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-BULK-WS-' || v_suffix,
      'vendor', '[SMOKE] Élan Bulk Intent Vendor',
      'status', 'draft',
      'bulk_import_vendor_reference', v_vendor_reference,
      'bulk_import_invoice_date', CURRENT_DATE::text,
      'bulk_import_intent_key', v_intent
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
        'unit_cost_cents', 333,
        'unit_size', v_unit_size
      )
    ),
    v_sales,
    'smk-po-bulk-whitespace-' || v_suffix
  );
  IF (v_replay->>'po_id')::uuid IS DISTINCT FROM v_po
     OR v_replay->>'status' <> 'already_imported'
     OR v_replay->>'po_number' IS DISTINCT FROM v_first->>'po_number' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: padded and unpadded bulk identities diverged first=% replay=%',
      v_first, v_replay;
  END IF;

  -- Another authorized employee can carry a different generic idempotency key
  -- and PO number; the global business-intent claim still returns the first PO.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_replay := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-BULK-B-' || v_suffix,
      'vendor', '[SMOKE] Élan Bulk Intent Vendor',
      'status', 'draft',
      'bulk_import_vendor_reference', v_vendor_reference,
      'bulk_import_invoice_date', CURRENT_DATE::text,
      'bulk_import_intent_key', v_intent
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
        'unit_cost_cents', 333,
        'unit_size', v_unit_size
      )
    ),
    v_admin,
    'smk-po-bulk-second-' || v_suffix
  );
  IF (v_replay->>'po_id')::uuid IS DISTINCT FROM v_po
     OR v_replay->>'status' <> 'already_imported'
     OR v_replay->>'po_number' IS DISTINCT FROM v_first->>'po_number' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: persistent bulk intent returned first=% replay=%',
      v_first, v_replay;
  END IF;

  -- Reusing a global claim key for another vendor/reference is an identity
  -- mismatch, never evidence that the second document was already imported.
  BEGIN
    PERFORM public.save_purchase_order(
      NULL,
      jsonb_build_object(
        'vendor', '[SMOKE] Different Vendor',
        'status', 'draft',
        'bulk_import_vendor_reference', v_vendor_reference,
        'bulk_import_invoice_date', CURRENT_DATE::text,
        'bulk_import_intent_key', v_intent
      ),
      jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'product_name', v_product_name,
          'quantity_ordered', 10.125,
          'unit_cost_cents', 333,
          'unit_size', v_unit_size
        )
      ),
      v_admin,
      'smk-po-bulk-vendor-conflict-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: cross-vendor bulk claim was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'BULK_PO_INTENT_IDENTITY_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-vendor claim error: %', v_err;
    END IF;
  END;

  -- The stable document identity remains claimed when reviewed date/line
  -- content changes. The separate fingerprint surfaces that disagreement and
  -- cannot create a second PO.
  BEGIN
    PERFORM public.save_purchase_order(
      NULL,
      jsonb_build_object(
        'vendor', '[SMOKE] Élan Bulk Intent Vendor',
        'status', 'draft',
        'bulk_import_vendor_reference', v_vendor_reference,
        'bulk_import_invoice_date', CURRENT_DATE::text,
        'bulk_import_intent_key', v_intent
      ),
      jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'product_name', v_product_name,
          'quantity_ordered', 11.125,
          'unit_cost_cents', 333,
          'unit_size', v_unit_size
        )
      ),
      v_admin,
      'smk-po-bulk-content-conflict-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed bulk document content was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'BULK_PO_DOCUMENT_CONTENT_CONFLICT' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong content-conflict error: %', v_err;
    END IF;
  END;

  SELECT count(*) INTO v_count
    FROM public.purchase_order_import_intents
   WHERE intent_key = v_intent
     AND content_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one persistent import claim, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.purchase_orders
   WHERE id = v_po;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one PO for two import attempts, got %', v_count;
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );

  SELECT id INTO v_po_item
    FROM public.purchase_order_items
   WHERE purchase_order_id = v_po;
  SELECT total_cost_cents INTO v_total_cents
    FROM public.purchase_orders
   WHERE id = v_po;
  SELECT unit_cost_cents INTO v_line_cents
    FROM public.purchase_order_items
   WHERE id = v_po_item;
  IF v_total_cents IS DISTINCT FROM 3372::bigint
     OR v_line_cents IS DISTINCT FROM 333::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: initial PO cents header=% line=%',
      v_total_cents, v_line_cents;
  END IF;

  v_edit_items := jsonb_build_array(
    jsonb_build_object(
      'id', v_po_item,
      'product_id', v_product,
      'product_name', v_product_name,
      'quantity_ordered', 11,
      'unit_size', v_unit_size
    )
  );
  PERFORM public.save_purchase_order(
    v_po,
    jsonb_build_object('vendor', '[SMOKE] Élan Bulk Intent Vendor', 'status', 'draft'),
    v_edit_items,
    v_sales,
    'smk-po-omit-cost-edit-' || v_suffix
  );
  SELECT total_cost_cents INTO v_total_cents
    FROM public.purchase_orders
   WHERE id = v_po;
  SELECT unit_cost_cents INTO v_line_cents
    FROM public.purchase_order_items
   WHERE id = v_po_item;
  IF v_total_cents IS DISTINCT FROM 3663::bigint
     OR v_line_cents IS DISTINCT FROM 333::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: omitted-cost edit header=% line=%',
      v_total_cents, v_line_cents;
  END IF;

  BEGIN
    PERFORM public.save_purchase_order(
      v_po,
      jsonb_build_object('vendor', '[SMOKE] Duplicate Item', 'status', 'draft'),
      v_edit_items || v_edit_items,
      v_sales,
      'smk-po-duplicate-item-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: duplicate existing line ID was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'PO_ITEM_ID_DUPLICATE' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong duplicate-line error: %', v_err;
    END IF;
  END;

  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public._save_purchase_order_atomic_number_impl(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  IF strpos(v_source, 'FOR UPDATE') = 0
     OR strpos(v_source, 'jsonb_agg') = 0
     OR strpos(v_source, 'FOR UPDATE') > strpos(v_source, 'jsonb_agg') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: PO lock does not precede omitted-cost hydration';
  END IF;

  SELECT prosrc INTO v_outer_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_identity_source
    FROM pg_proc
   WHERE oid = 'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  IF strpos(v_outer_source, '_save_purchase_order_ascii_identity_impl') = 0
     OR strpos(v_outer_source, 'BULK_PO_VENDOR_REQUIRED') = 0
     OR strpos(v_identity_source, 'public.next_po_number()') = 0
     OR strpos(v_identity_source, '_save_purchase_order_atomic_number_impl') = 0
     OR strpos(v_identity_source, 'public.next_po_number()')
        > strpos(v_identity_source, '_save_purchase_order_atomic_number_impl') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: PO number is not allocated inside the outer save transaction';
  END IF;

  -- Two half-cent extensions round to one cent apiece. The authoritative PO
  -- header is therefore two cents, and an exactly matching vendor bill must
  -- not emit the old aggregate-rounding false warning.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  v_vendor_name := '[SMOKE] Rounded Vendor ' || v_suffix;
  INSERT INTO public.vendors (name)
  VALUES (v_vendor_name)
  RETURNING id INTO v_vendor;

  v_replay := public.save_purchase_order(
    NULL,
    jsonb_build_object('vendor', v_vendor_name, 'status', 'draft'),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 0.5,
        'unit_cost_cents', 1,
        'unit_size', v_unit_size
      ),
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 0.5,
        'unit_cost_cents', 1,
        'unit_size', v_unit_size
      )
    ),
    v_admin,
    'smk-po-rounded-' || v_suffix
  );
  v_rounding_po := (v_replay->>'po_id')::uuid;
  IF NULLIF(v_replay->>'po_number', '') IS NULL
     OR (SELECT total_cost_cents FROM public.purchase_orders WHERE id = v_rounding_po) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: atomic PO number or rounded two-line header missing: %', v_replay;
  END IF;

  SELECT gs::date INTO v_open_date
    FROM generate_series(
      (now() AT TIME ZONE 'America/Chicago')::date,
      (now() AT TIME ZONE 'America/Chicago')::date - 365,
      interval '-1 day'
    ) AS gs
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.accounting_periods ap
      WHERE gs::date BETWEEN ap.period_start AND ap.period_end
        AND ap.status = 'closed'
   )
   ORDER BY gs DESC
   LIMIT 1;
  IF v_open_date IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: open vendor-bill date required';
  END IF;

  v_rounding_bill := public.create_vendor_bill(
    p_vendor_id := v_vendor,
    p_purchase_order_id := v_rounding_po,
    p_bill_number := 'SMK-BILL-' || v_suffix,
    p_bill_date := v_open_date,
    p_subtotal_cents := 2,
    p_idempotency_key := 'smk-bill-rounded-' || v_suffix
  );
  SELECT count(*) INTO v_count
    FROM public.notifications
   WHERE related_entity_type = 'purchase_order'
     AND related_entity_id = v_rounding_po
     AND notification_type = 'vendor_bill_drift';
  IF v_rounding_bill IS NULL OR v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: matching rounded vendor bill produced drift warning bill=% warnings=%',
      v_rounding_bill, v_count;
  END IF;

  -- The import claim must not make the admin-only delete workflow fail with an
  -- opaque FK error; deleting the PO deliberately removes its claim as well.
  PERFORM public.delete_purchase_order(
    v_po,
    v_admin,
    'smk-delete-imported-po-' || v_suffix
  );
  SELECT count(*) INTO v_count
    FROM public.purchase_order_import_intents
   WHERE intent_key = v_intent;
  IF v_count <> 0 OR EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = v_po) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: imported PO delete left PO or intent claim';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.idempotency_keys
   WHERE operation = 'save_purchase_order'
     AND NULLIF(result->>'po_id', '') = v_po::text;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: imported PO delete left % stale save replay(s)', v_count;
  END IF;

  -- The unchanged document and the original deterministic retry key must now
  -- create a fresh PO instead of replaying the deleted id or trusting a stale
  -- browser marker. This is the real delete -> re-import business path.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );
  v_replay := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'vendor', '[SMOKE] Élan Bulk Intent Vendor',
      'status', 'draft',
      'bulk_import_vendor_reference', v_vendor_reference,
      'bulk_import_invoice_date', CURRENT_DATE::text,
      'bulk_import_intent_key', v_intent
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
        'unit_cost_cents', 333,
        'unit_size', v_unit_size
      )
    ),
    v_sales,
    'smk-po-bulk-first-' || v_suffix
  );
  IF (v_replay->>'po_id')::uuid = v_po
     OR v_replay->>'status' IS DISTINCT FROM 'saved'
     OR NULLIF(v_replay->>'po_number', '') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: deleted document did not re-import as a fresh PO: %', v_replay;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.purchase_order_import_intents
   WHERE intent_key = v_intent
     AND purchase_order_id = (v_replay->>'po_id')::uuid
     AND content_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-imported document did not receive one fresh durable claim';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
