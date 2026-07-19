-- Post-apply rollback-only regression proof for H5 (Live Foundation Gauntlet
-- 2026-07-18): create_invoice_for_unbilled_delivery must REFUSE to backfill a
-- single invoice for an order that still needs split billing (a mono-invoice
-- would mis-attribute all the AR to one payer).
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX function the backfill of a completed
-- delivery on a field-allocated order whose transient queue flag has already
-- cleared SUCCEEDS (one mono invoice) -> this chain raises SMOKE_FAIL. Against
-- the FIXED function each independent predicate (queue flag and durable field
-- allocation) raises ORDER_NEEDS_SPLIT_BILLING, so the chain reaches
-- SMOKE_PASS_ROLLBACK. It also proves both serialized writer outcomes: an
-- existing invoice refuses a later allocation, and an existing allocation
-- refuses a later mono-invoice post. The final provenance chain inserts a
-- matching forged field-acre audit row: the old guard trusts it and posts,
-- while the fixed guard trusts only the private canonical-RPC claim.
--
-- One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_quote    uuid;
  v_sec      uuid;
  v_res      jsonb;
  v_order    uuid;
  v_oitem    uuid;
  v_delivery uuid;
  v_field    uuid;
  v_invoice  uuid;
  v_fake_group uuid := gen_random_uuid();
  v_split_ids uuid[];
  v_split_group uuid;
  v_saved_id uuid;
  v_saved_items jsonb;
  v_err      text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- Provenance cannot be forged through a direct Data API table insert. The
  -- governed SECURITY DEFINER creator still writes as owner.
  IF has_table_privilege('anon', 'public.financial_audit_log', 'INSERT')
     OR has_table_privilege('authenticated', 'public.financial_audit_log', 'INSERT')
     OR has_table_privilege('service_role', 'public.financial_audit_log', 'INSERT') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: financial audit provenance remains directly forgeable';
  END IF;

  IF to_regclass('public.split_invoice_provenance') IS NOT NULL THEN
    IF has_table_privilege('anon', 'public.split_invoice_provenance', 'SELECT')
       OR has_table_privilege('authenticated', 'public.split_invoice_provenance', 'SELECT')
       OR has_table_privilege('service_role', 'public.split_invoice_provenance', 'SELECT')
       OR has_table_privilege('authenticated', 'public.split_invoice_provenance', 'INSERT')
       OR has_table_privilege('service_role', 'public.split_invoice_provenance', 'INSERT') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: private split provenance is exposed to a Data API role';
    END IF;
    IF has_table_privilege('anon', 'public.invoices', 'INSERT')
       OR has_table_privilege('authenticated', 'public.invoices', 'INSERT')
       OR has_table_privilege('service_role', 'public.invoices', 'INSERT')
       OR has_table_privilege('anon', 'public.invoices', 'DELETE')
       OR has_table_privilege('authenticated', 'public.invoices', 'DELETE')
       OR has_table_privilege('service_role', 'public.invoices', 'DELETE')
       OR has_table_privilege('authenticated', 'public.invoices', 'TRUNCATE')
       OR has_table_privilege('service_role', 'public.invoices', 'TRUNCATE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: direct invoice identity creation/deletion remains granted';
    END IF;
  END IF;

  -- [E2E] marker satisfies the live-testdata guard; terminal rollback removes it.
  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] H5 Farm ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name)
  VALUES ('[E2E] H5 Herbicide ' || v_suffix) RETURNING id INTO v_product;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-H5-Q-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote, 'Main') RETURNING id INTO v_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote, v_sec, v_product, 10, 6, 100, 'gal');

  -- Known-good order + order_items via the production RPC.
  SELECT public.convert_quote_to_order(v_quote) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  v_order := (v_res->>'order_id')::uuid;
  SELECT id INTO v_oitem FROM public.order_items WHERE order_id = v_order LIMIT 1;

  -- Field fixture used by the second, durable-allocation predicate below.
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] H5 Field ' || v_suffix, 'corn', 100)
  RETURNING id INTO v_field;

  -- Build the delivery while 'scheduled' (delivery_items are locked once the
  -- delivery leaves 'scheduled'), then transition it to 'completed'. signed_by
  -- is required by guard_completed_delivery_signature; app.admin_override
  -- brackets the direct status write.
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('E2E-H5-DEL-' || v_suffix, v_order, v_customer, CURRENT_DATE, 'scheduled', v_admin)
  RETURNING id INTO v_delivery;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery, v_oitem, v_product, 100, 100, 'gal');
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.deliveries SET status = 'completed', signed_by = 'E2E Signer' WHERE id = v_delivery;
  PERFORM set_config('app.admin_override', 'false', true);

  -- Predicate 1: the transient split-billing queue flag independently refuses
  -- mono backfill even before any durable allocation row exists.
  UPDATE public.orders SET needs_split_billing = true, updated_at = now() WHERE id = v_order;
  BEGIN
    SELECT public.create_invoice_for_unbilled_delivery(
      v_delivery, v_admin, 'e2e-h5-flag-' || v_suffix
    ) INTO v_res;
    RAISE EXCEPTION 'SMOKE_FAIL: backfill ignored needs_split_billing=true';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_NEEDS_SPLIT_BILLING:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: queue-flag predicate raised unexpected error: %', v_err;
    END IF;
  END;

  -- Predicate 2 / FAIL-FIRST: after the transient flag clears, the durable
  -- field allocation must still refuse a mono invoice.
  UPDATE public.orders SET needs_split_billing = false, updated_at = now() WHERE id = v_order;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_oitem, v_field, 100);
  BEGIN
    SELECT public.create_invoice_for_unbilled_delivery(
      v_delivery, v_admin, 'e2e-h5-allocation-' || v_suffix
    )
    INTO v_res;
    -- Reached only on the PRE-FIX function: a single mono invoice was created.
    RAISE EXCEPTION 'SMOKE_FAIL: backfill mono-billed a split-billing order (H5 live)';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_NEEDS_SPLIT_BILLING:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: backfill wrong error for split-billing order: %', v_err;
    END IF;
  END;

  -- No invoice was created for the delivery.
  IF EXISTS (SELECT 1 FROM public.invoices WHERE delivery_id = v_delivery AND status NOT IN ('voided','cancelled')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a mono invoice was created despite the refusal';
  END IF;

  -- Complementary writer-side fail-first: a mono draft that wins the order lock
  -- must make a later allocation insert fail closed. Under concurrency this is
  -- the backfill/post-first outcome after the OIFA trigger's parent-item lock
  -- wakes. The pre-fix trigger allowed this insert for a draft invoice.
  DELETE FROM public.order_item_field_allocations
   WHERE order_item_id = v_oitem AND field_id = v_field;
  INSERT INTO public.invoices (
    invoice_number, order_id, customer_id, delivery_id, invoice_type,
    status, total_amount_cents, created_by
  ) VALUES (
    'E2E-H5-MONO-' || v_suffix, v_order, v_customer, v_delivery,
    'chemical_sale', 'draft', 100000, v_admin
  ) RETURNING id INTO v_invoice;

  BEGIN
    INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
    VALUES (v_oitem, v_field, 100);
    RAISE EXCEPTION 'SMOKE_FAIL: allocation was added after an active mono draft existed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_ALLOCATION_INVOICE_CONFLICT:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: mono-draft writer guard raised unexpected error: %', v_err;
    END IF;
  END;

  -- Opposite serialized outcome: remove the active draft, let the durable
  -- allocation win, then prove a later mono invoice cannot be posted. The
  -- posting guard takes the same parent-item locks before reading OIFA.
  UPDATE public.invoices
     SET status = 'cancelled'
   WHERE id = v_invoice;

  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_oitem, v_field, 100);

  INSERT INTO public.invoices (
    invoice_number, order_id, customer_id, delivery_id, invoice_type,
    status, total_amount_cents, created_by
  ) VALUES (
    'E2E-H5-POST-' || v_suffix, v_order, v_customer, v_delivery,
    'chemical_sale', 'draft', 100000, v_admin
  ) RETURNING id INTO v_invoice;

  BEGIN
    UPDATE public.invoices
       SET status = 'posted', posted_by = v_admin, posted_at = now()
     WHERE id = v_invoice;
    RAISE EXCEPTION 'SMOKE_FAIL: mono invoice posted after split allocation existed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'MONO_INVOICE_SPLIT_BILLING_CONFLICT:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: allocation-first posting guard raised unexpected error: %', v_err;
    END IF;
  END;

  -- A random non-null group UUID is not governed split provenance. Go further
  -- than a missing-row check: insert the exact field-acre audit payload the old
  -- guard trusted. The fixed guard ignores audit history entirely and requires
  -- an immutable row in the private canonical-RPC provenance table.
  UPDATE public.invoices
     SET invoice_group_id = v_fake_group
   WHERE id = v_invoice;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id,
    actor_role,
    new_values,
    total_impact_cents,
    description
  ) VALUES (
    'invoice_created',
    'invoice',
    v_invoice,
    v_admin,
    'admin',
    jsonb_build_object(
      'group_id', v_fake_group,
      'split_basis', 'field_acre'
    ),
    100000,
    'E2E forged audit-only split provenance'
  );

  BEGIN
    SELECT public.post_invoice_group(
      v_fake_group, v_admin, 'e2e-h5-fake-group-' || v_suffix
    ) INTO v_res;
    RAISE EXCEPTION 'SMOKE_FAIL: forged audit row bypassed private split provenance';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'SPLIT_INVOICE_GROUP_PROVENANCE_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: fake-group guard raised unexpected error: %', v_err;
    END IF;
  END;

  -- Two-step bypass: even while still draft, the existing order link is
  -- immutable. Otherwise a caller could re-parent now and post in a later call.
  UPDATE public.invoices SET invoice_group_id = NULL WHERE id = v_invoice;
  BEGIN
    UPDATE public.invoices SET order_id = NULL WHERE id = v_invoice;
    RAISE EXCEPTION 'SMOKE_FAIL: draft invoice cleared order_id before posting';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: draft order-identity guard raised unexpected error: %', v_err;
    END IF;
  END;

  -- Clearing order_id in the posting UPDATE is independently blocked too.
  BEGIN
    UPDATE public.invoices
       SET status = 'posted', order_id = NULL,
           posted_by = v_admin, posted_at = now()
     WHERE id = v_invoice;
    RAISE EXCEPTION 'SMOKE_FAIL: posting bypassed the split guard by clearing order_id';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: order-identity guard raised unexpected error: %', v_err;
    END IF;
  END;

  -- Positive control: the canonical split engine writes field-acre audit
  -- provenance, so even a legitimate one-member group remains postable.
  UPDATE public.invoices SET status = 'cancelled' WHERE id = v_invoice;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.order_items
     SET quantity_delivered = total_units_needed,
         quantity_remaining = 0,
         total_price = price_per_unit * total_units_needed,
         profit = (price_per_unit - cost_per_unit) * total_units_needed,
         net_margin = CASE
           WHEN price_per_unit = 0 THEN 0
           ELSE (price_per_unit - cost_per_unit) / price_per_unit * 100
         END,
         pricing_pending = false
   WHERE id = v_oitem;
  PERFORM set_config('app.admin_override', 'false', true);

  SELECT public.create_split_invoices_from_order(
    v_order, v_admin, 'chemical_sale', 'e2e-h5-governed-split-' || v_suffix
  ) INTO v_split_ids;
  IF COALESCE(array_length(v_split_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: canonical split engine created no invoices';
  END IF;
  SELECT invoice_group_id INTO v_split_group
    FROM public.invoices WHERE id = v_split_ids[1];
  IF v_split_group IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: canonical field-acre split lacks group provenance';
  END IF;

  IF to_regclass('public.split_invoice_provenance') IS NOT NULL THEN
    IF (SELECT count(*) FROM public.split_invoice_provenance p
         WHERE p.invoice_id = ANY(v_split_ids))
       IS DISTINCT FROM array_length(v_split_ids, 1) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: canonical split members lack private provenance';
    END IF;

    BEGIN
      UPDATE public.invoices
         SET total_amount_cents = total_amount_cents + 1
       WHERE id = v_split_ids[1];
      RAISE EXCEPTION 'SMOKE_FAIL: governed split header content remained mutable';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'SPLIT_INVOICE_PROVENANCE_IMMUTABLE:%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: split header immutability raised unexpected error: %', v_err;
      END IF;
    END;

    BEGIN
      UPDATE public.invoice_items
         SET extended_cents = extended_cents + 1
       WHERE invoice_id = v_split_ids[1];
      RAISE EXCEPTION 'SMOKE_FAIL: governed split line content remained mutable';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'SPLIT_INVOICE_PROVENANCE_IMMUTABLE:%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: split line immutability raised unexpected error: %', v_err;
      END IF;
    END;

    BEGIN
      DELETE FROM public.invoices WHERE id = v_split_ids[1];
      RAISE EXCEPTION 'SMOKE_FAIL: governed split invoice identity was recyclable';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'SPLIT_INVOICE_PROVENANCE_IMMUTABLE:%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: split identity delete guard raised unexpected error: %', v_err;
      END IF;
    END;

    -- The real InvoiceDetail edit path remains usable because save_invoice owns
    -- a private transaction claim and refreshes the exact content provenance.
    SELECT jsonb_agg(jsonb_build_object(
             'product_id', ii.product_id,
             'description', ii.description,
             'quantity', ii.quantity,
             'unit_price_cents', ii.unit_price_cents,
             'extended_cents', ii.extended_cents,
             'cost_cents', ii.cost_cents,
             'sort_order', ii.sort_order,
             'rate_per_acre', ii.rate_per_acre,
             'acres', ii.acres,
             'unit_size', ii.unit_size,
             'notes', ii.notes,
             'rate_unit', ii.rate_unit,
             'is_application_fee', ii.is_application_fee,
             'total_applied', ii.total_applied,
             'total_applied_unit', ii.total_applied_unit,
             'total_applied_gl_lb', ii.total_applied_gl_lb,
             'gl_lb_unit', ii.gl_lb_unit,
             'epa_registration', ii.epa_registration,
             'product_form', ii.product_form,
             'price_source', ii.price_source,
             'quoted_price_cents', ii.quoted_price_cents
           ) ORDER BY ii.sort_order, ii.id)
      INTO v_saved_items
      FROM public.invoice_items ii
     WHERE ii.invoice_id = v_split_ids[1];

    v_saved_id := public.save_invoice(
      jsonb_build_object(
        'id', v_split_ids[1],
        'customer_id', (SELECT customer_id FROM public.invoices WHERE id = v_split_ids[1]),
        'invoice_type', (SELECT invoice_type FROM public.invoices WHERE id = v_split_ids[1]),
        'status', 'draft',
        'season', (SELECT season FROM public.invoices WHERE id = v_split_ids[1]),
        'salesman_id', (SELECT salesman_id FROM public.invoices WHERE id = v_split_ids[1]),
        'invoice_date', (SELECT invoice_date FROM public.invoices WHERE id = v_split_ids[1]),
        'header_notes', '[E2E] governed split draft edit ' || v_suffix
      ),
      COALESCE(v_saved_items, '[]'::jsonb),
      'e2e-h5-governed-save-' || v_suffix
    );
    IF v_saved_id IS DISTINCT FROM v_split_ids[1]
       OR (SELECT header_notes FROM public.invoices WHERE id = v_split_ids[1])
          IS DISTINCT FROM '[E2E] governed split draft edit ' || v_suffix
       OR NOT EXISTS (
         SELECT 1
           FROM public.split_invoice_provenance p
          WHERE p.invoice_id = v_split_ids[1]
            AND p.content_claim = public._split_invoice_content_claim(v_split_ids[1])
       ) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: governed save_invoice did not refresh exact split provenance';
    END IF;
  END IF;

  SELECT public.post_invoice_group(
    v_split_group, v_admin, 'e2e-h5-governed-post-' || v_suffix
  ) INTO v_res;
  IF EXISTS (
    SELECT 1 FROM public.invoices
     WHERE id = ANY(v_split_ids) AND status <> 'posted'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: governed split group did not post completely';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
