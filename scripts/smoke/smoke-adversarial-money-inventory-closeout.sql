-- Post-apply rollback-only proof for migrations 20260716213000,
-- 20260716224000, 20260716233000, 20260717010000, 20260717015439,
-- 20260717032000, 20260717045420, 20260717063445, 20260717070900,
-- 20260717081856, 20260717085512, 20260717092749, 20260717101619, and
-- 20260717110016 and 20260717112906.
-- Updated 2026-10-22 for 20261021140000 (purchase cost admin-only): the bulk
-- imports send no cost and the admin prices the line with
-- set_purchase_order_item_costs.
-- Updated 2026-10-22 for 20261022100000 (the bulk-import fingerprint leaves out
-- cost): an admin importing the rep's document WITH cost gets already_imported,
-- and a changed quantity or invoice date with cost still conflicts.
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
  v_serialized_source text;
  v_identity_source text;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_intent text;
  v_vendor_reference text;
  v_other_invoice_key text;
  v_versioned boolean := to_regprocedure('public.post_invoice(uuid,text,text)') IS NOT NULL;  -- 20261022022000 applied
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
    -- Since the save_invoice receipts were bound to their actor (20260802/20260810), another
    -- caller's key is refused as IDEMPOTENCY_ACTOR_MISMATCH before any customer comparison;
    -- either refusal keeps the other invoice id hidden.
    IF v_err NOT IN ('IDEMPOTENCY_PAYLOAD_CONFLICT', 'IDEMPOTENCY_ACTOR_MISMATCH') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong decoy replay error: %', v_err;
    END IF;
  END;

  BEGIN
    -- Since 20261022022000 the own-name check runs before the version check, so any version works
    -- here. An older container proof replays only up to its own candidate, so call the signature
    -- the database has.
    IF v_versioned THEN
      PERFORM public.post_invoice(v_other_invoice, 'v1:smoke', 'smk-post-other-' || v_suffix);
    ELSE
      PERFORM public.post_invoice(v_other_invoice, 'smk-post-other-' || v_suffix);
    END IF;
    RAISE EXCEPTION 'SMOKE_FAIL: sales rep posted an invoice not under their own name';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    -- Since 20261013220000 reps post for any customer, but only invoices under their own name.
    IF v_err <> 'INVOICE_SCOPE_DENIED' THEN
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
        normalize(
          lower(normalize('[SMOKE] Élan Bulk Intent Vendor', NFKC)),
          NFKC
        ) || chr(31) || normalize(
          lower(normalize(v_vendor_reference, NFKC)),
          NFKC
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
      'bulk_import_intent_key', 'browser-value-is-not-authoritative'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
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
      'bulk_import_intent_key', 'browser-value-is-not-authoritative'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
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
      'bulk_import_intent_key', 'browser-value-is-not-authoritative'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
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
      'bulk_import_intent_key', 'browser-value-is-not-authoritative'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
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

  -- Since 20261022100000 the content fingerprint leaves out cost: the admin's
  -- import of the rep's document WITH cost (as BulkPOImport sends it) is the
  -- same document, not a conflict, and it leaves the rep's line cost alone.
  SELECT unit_cost_cents INTO v_line_cents
    FROM public.purchase_order_items
   WHERE purchase_order_id = v_po;
  v_replay := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-BULK-COST-' || v_suffix,
      'vendor', '[SMOKE] Élan Bulk Intent Vendor',
      'status', 'draft',
      'bulk_import_vendor_reference', v_vendor_reference,
      'bulk_import_invoice_date', CURRENT_DATE::text,
      'bulk_import_intent_key', 'browser-value-is-not-authoritative'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
        'unit_size', v_unit_size,
        'unit_cost', 3.33,
        'unit_cost_cents', 333
      )
    ),
    v_admin,
    'smk-po-bulk-admin-cost-' || v_suffix
  );
  IF (v_replay->>'po_id')::uuid IS DISTINCT FROM v_po
     OR v_replay->>'status' IS DISTINCT FROM 'already_imported'
     OR v_replay->>'po_number' IS DISTINCT FROM v_first->>'po_number' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: admin import with cost after the rep import returned first=% replay=%',
      v_first, v_replay;
  END IF;
  IF (SELECT unit_cost_cents FROM public.purchase_order_items WHERE purchase_order_id = v_po)
     IS DISTINCT FROM v_line_cents THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the already_imported admin import changed the rep line cost';
  END IF;

  -- Unicode and ASCII capitalization changes from OCR/manual review must still
  -- hit the same durable vendor-document claim. A deliberately bogus legacy
  -- browser digest proves PostgreSQL, not the browser, owns the durable key.
  v_replay := public.save_purchase_order(
    NULL,
    jsonb_build_object(
      'po_number', 'SMK-BULK-CASE-' || v_suffix,
      'vendor', '[smoke] éLAN bulk intent vendor',
      'status', 'draft',
      'bulk_import_vendor_reference', lower(v_vendor_reference),
      'bulk_import_invoice_date', CURRENT_DATE::text,
      'bulk_import_intent_key', 'browser-value-is-not-authoritative'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
        'unit_size', v_unit_size
      )
    ),
    v_admin,
    'smk-po-bulk-unicode-case-' || v_suffix
  );
  IF (v_replay->>'po_id')::uuid IS DISTINCT FROM v_po
     OR v_replay->>'status' <> 'already_imported'
     OR v_replay->>'po_number' IS DISTINCT FROM v_first->>'po_number' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: Unicode case variant created a second PO first=% replay=%',
      v_first, v_replay;
  END IF;

  -- A caller cannot make another vendor alias the first vendor's claim by
  -- supplying its browser digest. The server derives a distinct claim and PO.
  v_replay := public.save_purchase_order(
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
        'unit_size', v_unit_size
      )
    ),
    v_admin,
    'smk-po-bulk-vendor-separation-' || v_suffix
  );
  IF v_replay->>'status' IS DISTINCT FROM 'saved'
     OR (v_replay->>'po_id')::uuid = v_po
     OR NOT EXISTS (
       SELECT 1
         FROM public.purchase_order_import_intents
        WHERE purchase_order_id = (v_replay->>'po_id')::uuid
          AND intent_key <> v_intent
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: server did not separate cross-vendor claim: %', v_replay;
  END IF;

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
        'bulk_import_intent_key', 'browser-value-is-not-authoritative'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'product_name', v_product_name,
          'quantity_ordered', 11.125,
          'unit_size', v_unit_size,
          'unit_cost', 3.33,
          'unit_cost_cents', 333
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

  -- A changed vendor invoice date is a real content change too, cost or not.
  BEGIN
    PERFORM public.save_purchase_order(
      NULL,
      jsonb_build_object(
        'vendor', '[SMOKE] Élan Bulk Intent Vendor',
        'status', 'draft',
        'bulk_import_vendor_reference', v_vendor_reference,
        'bulk_import_invoice_date', (CURRENT_DATE - 1)::text,
        'bulk_import_intent_key', 'browser-value-is-not-authoritative'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'product_id', v_product,
          'product_name', v_product_name,
          'quantity_ordered', 10.125,
          'unit_size', v_unit_size,
          'unit_cost', 3.33,
          'unit_cost_cents', 333
        )
      ),
      v_admin,
      'smk-po-bulk-date-conflict-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed bulk document date was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'BULK_PO_DOCUMENT_CONTENT_CONFLICT' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong date-conflict error: %', v_err;
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

  -- Prove the first logical import's commit-time trigger before this combined
  -- rollback harness deliberately deletes that PO later. Restore deferred mode
  -- so the delete -> re-import scenario behaves like a separate real request.
  SET LOCAL ROLE authenticated;
  SET CONSTRAINTS require_bulk_po_content_fingerprint IMMEDIATE;
  SET CONSTRAINTS require_bulk_po_content_fingerprint DEFERRED;
  RESET ROLE;

  -- Purchase cost is admin-only since 20261021140000: a rep's import stores the catalog cost and
  -- the admin sets the real cost afterwards. The bulk imports above therefore send no cost, so a
  -- rep's and an admin's import of one document fingerprint the same. The admin is still current.
  SELECT id INTO v_po_item
    FROM public.purchase_order_items
   WHERE purchase_order_id = v_po;
  PERFORM public.set_purchase_order_item_costs(
    v_po,
    jsonb_build_array(jsonb_build_object('id', v_po_item, 'unit_cost_cents', 333)),
    '[SMOKE] admin prices the rep import',
    v_admin,
    'smk-po-set-cost-' || v_suffix
  );

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales, 'role', 'authenticated')::text,
    true
  );

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

  -- Live layering since 20260726190515 (section 9 PO/AP remediation):
  -- save_purchase_order takes the PO advisory lock and delegates to
  -- _section9_save_purchase_order_serialized, which owns the bulk vendor
  -- checks and delegates to the ASCII-identity impl, which allocates the PO
  -- number before calling the atomic-number impl.
  SELECT prosrc INTO v_outer_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_serialized_source
    FROM pg_proc
   WHERE oid = 'public._section9_save_purchase_order_serialized(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_identity_source
    FROM pg_proc
   WHERE oid = 'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  IF strpos(v_outer_source, 'pg_advisory_xact_lock') = 0
     OR strpos(v_outer_source, '_section9_save_purchase_order_serialized') = 0
     OR strpos(v_outer_source, 'pg_advisory_xact_lock')
        > strpos(v_outer_source, '_section9_save_purchase_order_serialized')
     OR strpos(v_serialized_source, '_save_purchase_order_ascii_identity_impl') = 0
     OR strpos(v_serialized_source, 'BULK_PO_VENDOR_REQUIRED') = 0
     OR strpos(v_identity_source, 'normalize(v_requested_vendor, NFKC)') = 0
     OR strpos(v_identity_source, 'normalize(v_vendor_reference, NFKC)') = 0
     OR strpos(v_identity_source, 'translate(') > 0
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

  -- create_vendor_bill bills only a submitted or received PO (PO_NOT_BILLABLE
  -- since 20260726190515), and an ordinary save cannot change status, so
  -- submit it through its lifecycle RPC first, as the app does.
  PERFORM public.submit_purchase_order(
    v_rounding_po,
    v_admin,
    'smk-po-rounded-submit-' || v_suffix
  );

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
      'bulk_import_intent_key', 'browser-value-is-not-authoritative'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product,
        'product_name', v_product_name,
        'quantity_ordered', 10.125,
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

  -- The public writer's SECURITY DEFINER frame has ended. Force the normally
  -- commit-time trigger while the caller role is authenticated; this proves
  -- the trigger function has its own controlled access to the deny-all-RLS
  -- intent table. A final exception still rolls every disposable row back.
  SET LOCAL ROLE authenticated;
  SET CONSTRAINTS require_bulk_po_content_fingerprint IMMEDIATE;
  IF current_user IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: deferred trigger proof did not run as authenticated';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
