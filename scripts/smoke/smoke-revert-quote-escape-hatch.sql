-- Post-apply rollback-only regression proof for B2 (Live Foundation Gauntlet
-- 2026-07-18): a quote stranded at 'accepted' after its whole-conversion order
-- was cancelled must be rescuable via revert_quote_status, and genuinely
-- re-convertible afterwards.
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX retry lookup this chain replays the
-- seeded expired result and raises SMOKE_FAIL. Against the FIXED function the
-- expired result is removed, the revert succeeds, a sequential replay is exact
-- and side-effect-free, cross-quote key reuse is rejected, unsafe cancelled
-- orders cannot be reopened (including with a surviving legacy draft), every
-- invoice writer rejects the cancelled historical order, the draw ledger is
-- released, a re-convert produces a NEW order, and the historical cancelled
-- order cannot then be restored.
--
-- One DO block, terminal exception → nothing commits.
DO $smoke$
DECLARE
  v_admin    uuid;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_field    uuid;
  v_quote    uuid;
  v_quote2   uuid;
  v_quote_delivered uuid;
  v_quote_completed uuid;
  v_quote_invoice uuid;
  v_quote_void uuid;
  v_quote_draft uuid;
  v_quote_commission uuid;
  v_sec      uuid;
  v_risk_sec uuid;
  v_res      jsonb;
  v_order1   uuid;
  v_order2   uuid;
  v_order_delivered uuid;
  v_order_completed uuid;
  v_order_invoice uuid;
  v_order_void uuid;
  v_order_draft uuid;
  v_order_commission uuid;
  v_order_item_completed uuid;
  v_order_item_draft uuid;
  v_delivery_completed uuid;
  v_invoice  uuid;
  v_invoice_draft uuid;
  v_invoice_cancelled uuid;
  v_invoice_void uuid;
  v_status   text;
  v_drawn    numeric;
  v_replay   jsonb;
  v_audit_before bigint;
  v_audit_after bigint;
  v_err      text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- [E2E] marker keeps the live-testdata guard satisfied; terminal rollback removes it.
  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] B2 Farm ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name)
  VALUES ('[E2E] B2 Herbicide ' || v_suffix) RETURNING id INTO v_product;

  -- Whole booking (not planned): one product, 300 units.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-Q-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote, 'Main') RETURNING id INTO v_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote, v_sec, v_product, 10, 6, 300, 'gal');

  -- Separate terminal target for the same-operation argument-binding check.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-Q2-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote2;
  UPDATE public.quotes SET status = 'declined' WHERE id = v_quote2;

  -- ---- whole conversion -> order created, quote 'accepted', draws = 300 ----
  SELECT public.convert_quote_to_order(v_quote) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: convert returned %, expected created', v_res;
  END IF;
  v_order1 := (v_res->>'order_id')::uuid;

  -- ---- cancel the order (whole conversion: booking_draw = false) ----
  SELECT public.cancel_order(v_order1, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: cancel returned %, expected cancelled', v_res;
  END IF;

  -- ---- stranded pre-condition: quote still 'accepted', draws still 300 ----
  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: quote after cancel = %, expected accepted (whole-conversion stays closed)', v_status;
  END IF;

  SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_drawn
  FROM public.quote_product_draws
  WHERE quote_id = v_quote AND product_id = v_product;
  IF v_drawn IS DISTINCT FROM 300 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: draw ledger after cancel = %, expected 300 before revert', v_drawn;
  END IF;

  -- The legacy restore path changed only the status and rebuilt none of the
  -- inventory/hold/commission/invoice effects of cancellation. It is retired
  -- even before the quote is reopened, and must not mutate the order.
  BEGIN
    PERFORM public.restore_cancelled_order(
      v_order1, 'must be retired', v_admin, 'e2e-b2-restore-retired-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: retired restore_cancelled_order still executed';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: retired restore returned wrong error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.orders WHERE id = v_order1) IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retired restore changed the original order';
  END IF;
  IF has_function_privilege('anon', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.restore_cancelled_order(uuid, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retired restore_cancelled_order still has an execution grant';
  END IF;

  -- ===== FAIL-CLOSED 1: delivered quantity survives cancellation =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QD-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_delivered;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_delivered, 'Delivered risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_delivered, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_delivered) INTO v_res;
  v_order_delivered := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_delivered IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: delivered-risk conversion failed: %', v_res;
  END IF;
  UPDATE public.order_items
     SET quantity_delivered = 1,
         quantity_remaining = GREATEST(total_units_needed - 1, 0)
   WHERE order_id = v_order_delivered;
  SELECT public.cancel_order(v_order_delivered, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_delivered, 'must reject delivered history', v_admin,
      'e2e-b2-delivered-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with delivered inventory';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_DELIVERED_ACTIVITY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: delivered-history guard returned wrong error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.quotes WHERE id = v_quote_delivered) IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected delivered-history reopen still changed quote status';
  END IF;

  -- ===== FAIL-CLOSED 1b: completed delivery survives even if item totals drift =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QX-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_completed;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_completed, 'Completed delivery risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_completed, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_completed) INTO v_res;
  v_order_completed := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_completed IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: completed-delivery conversion failed: %', v_res;
  END IF;
  SELECT id INTO v_order_item_completed
  FROM public.order_items WHERE order_id = v_order_completed ORDER BY id LIMIT 1;
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, status, completed_at, signed_by, created_by
  ) VALUES (
    'E2E-B2-DEL-' || v_suffix, v_order_completed, v_customer,
    'completed', now(), '[E2E] B2 completed-delivery proof', v_admin
  ) RETURNING id INTO v_delivery_completed;
  INSERT INTO public.delivery_items (
    delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
  ) VALUES (
    v_delivery_completed, v_order_item_completed, v_product, 1, 1, 'gal'
  );
  SELECT public.cancel_order(v_order_completed, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_completed, 'must reject completed delivery', v_admin,
      'e2e-b2-completed-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with a completed delivery';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_DELIVERED_ACTIVITY:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: completed-delivery guard returned wrong error: %', v_err;
    END IF;
  END;

  -- A real completed delivery ID is not sufficient provenance for direct table
  -- insertion; only the audited recovery RPC can mint this exception.
  BEGIN
    INSERT INTO public.invoices (
      invoice_number, customer_id, order_id, delivery_id, invoice_type, status,
      total_amount_cents, invoice_date, due_date, created_by
    ) VALUES (
      'E2E-B2-ORPHAN-' || v_suffix, v_customer, NULL,
      v_delivery_completed, 'chemical_sale', 'draft', 999999,
      current_date, current_date + 30, v_admin
    );
    RAISE EXCEPTION 'SMOKE_FAIL: delivery-linked invoice bypassed with NULL order_id';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_DELIVERY_ORDER_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: delivery/order lineage guard returned wrong error: %', v_err;
    END IF;
  END;

  BEGIN
    INSERT INTO public.invoices (
      invoice_number, customer_id, order_id, delivery_id, invoice_type, status,
      total_amount_cents, invoice_date, due_date, created_by
    ) VALUES (
      'E2E-B2-SPOOF-' || v_suffix, v_customer, v_order_completed,
      v_delivery_completed, 'chemical_sale', 'draft', 999999,
      current_date, current_date + 30, v_admin
    );
    RAISE EXCEPTION 'SMOKE_FAIL: direct header insert spoofed completed-delivery provenance';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'CANCELLED_DELIVERY_INVOICE_WRITER_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: completed-delivery provenance guard returned wrong error: %', v_err;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims', '{}'::text, true);
  BEGIN
    INSERT INTO public.invoices (
      invoice_number, customer_id, order_id, delivery_id, invoice_type, status,
      total_amount_cents, invoice_date, due_date, created_by
    ) VALUES (
      'E2E-B2-NOSUB-' || v_suffix, v_customer, v_order_completed,
      v_delivery_completed, 'chemical_sale', 'draft', 999999,
      current_date, current_date + 30, v_admin
    );
    RAISE EXCEPTION 'SMOKE_FAIL: no-sub caller passed the recovery capability check';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'CANCELLED_DELIVERY_INVOICE_WRITER_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no-sub capability guard returned wrong error: %', v_err;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- Billing already-delivered product remains legitimate even after the
  -- undelivered remainder was cancelled. The central trigger's sole cancelled-
  -- order exception must preserve this audited recovery RPC.
  SELECT public.create_invoice_for_unbilled_delivery(
    v_delivery_completed, v_admin, 'e2e-b2-delivery-backfill-' || v_suffix
  ) INTO v_res;
  IF v_res->>'success' IS DISTINCT FROM 'true'
     OR (v_res->>'total_cents')::bigint IS DISTINCT FROM 1000
     OR NOT EXISTS (
       SELECT 1 FROM public.invoices i
       JOIN public.invoice_items ii ON ii.invoice_id = i.id
       WHERE i.id = (v_res->>'invoice_id')::uuid
         AND i.delivery_id = v_delivery_completed
         AND i.order_id = v_order_completed
         AND i.customer_id = v_customer
         AND i.status = 'draft'
         AND ii.quantity = 1
         AND ii.extended_cents = 1000
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: completed-delivery billing exception was blocked or mis-billed: %', v_res;
  END IF;

  BEGIN
    UPDATE public.invoices SET total_amount_cents = 999999
    WHERE id = (v_res->>'invoice_id')::uuid;
    RAISE EXCEPTION 'SMOKE_FAIL: recovery invoice header money remained directly editable';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'TERMINAL_ORDER_INVOICE_PRINCIPAL_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: recovery-header money guard returned wrong error: %', v_err;
    END IF;
  END;

  BEGIN
    UPDATE public.invoices SET status = 'posted'
    WHERE id = (v_res->>'invoice_id')::uuid;
    RAISE EXCEPTION 'SMOKE_FAIL: recovery invoice bypassed the public posting engine';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'CANCELLED_DELIVERY_INVOICE_HEADER_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: direct-post guard returned wrong error: %', v_err;
    END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.invoices
    WHERE id = (v_res->>'invoice_id')::uuid
      AND status = 'draft'
      AND total_amount_cents = 1000
      AND total_cost_cents = 600
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected recovery-header mutation changed invoice state';
  END IF;

  BEGIN
    UPDATE public.invoice_items SET quantity = 2
    WHERE invoice_id = (v_res->>'invoice_id')::uuid;
    RAISE EXCEPTION 'SMOKE_FAIL: completed-delivery recovery item remained directly editable';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'CANCELLED_DELIVERY_INVOICE_ITEMS_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: recovery-item guard returned wrong error: %', v_err;
    END IF;
  END;

  PERFORM public.post_invoice(
    (v_res->>'invoice_id')::uuid, 'e2e-b2-delivery-post-' || v_suffix
  );
  PERFORM set_config('app.admin_override', 'false', true);
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices i
    JOIN public.invoice_items ii ON ii.invoice_id = i.id
    WHERE i.id = (v_res->>'invoice_id')::uuid
      AND i.status = 'posted'
      AND i.total_amount_cents = 1000
      AND i.total_cost_cents = 600
      AND ii.quantity = 1
      AND ii.extended_cents = 1000
  ) OR (
    SELECT count(*) FROM public.financial_audit_log
    WHERE operation_type = 'invoice_posted'
      AND entity_id = (v_res->>'invoice_id')::uuid
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE idempotency_key = 'e2e-b2-delivery-post-' || v_suffix
      AND operation = 'post_invoice'
      AND (result->>'invoice_id')::uuid = (v_res->>'invoice_id')::uuid
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: completed-delivery recovery invoice did not post exactly';
  END IF;

  -- Manual review must still be able to void a posted recovery invoice after
  -- its source order was cancelled.
  PERFORM public.void_invoice(
    (v_res->>'invoice_id')::uuid,
    '[E2E] cancelled-order recovery void proof',
    'e2e-b2-delivery-void-' || v_suffix
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices
     WHERE id = (v_res->>'invoice_id')::uuid
       AND status = 'voided'
       AND total_amount_cents = 0
       AND paid_amount_cents = 0
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: public void_invoice could not close the posted cancelled-order recovery invoice';
  END IF;

  -- ===== FAIL-CLOSED 2: a posted invoice survives cancellation =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QI-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_invoice;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_invoice, 'Invoice risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_invoice, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_invoice) INTO v_res;
  v_order_invoice := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_invoice IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: invoice-risk conversion failed: %', v_res;
  END IF;
  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type, status,
    total_amount_cents, invoice_date, due_date, created_by
  ) VALUES (
    'E2E-B2-INV-' || v_suffix, v_customer, v_order_invoice,
    'chemical_sale', 'draft', 1000, current_date, current_date + 30, v_admin
  ) RETURNING id INTO v_invoice;
  BEGIN
    UPDATE public.invoices SET order_id = NULL WHERE id = v_invoice;
    RAISE EXCEPTION 'SMOKE_FAIL: order-linked invoice was detached from its source';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_SOURCE_LINEAGE_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: invoice-lineage guard returned wrong error: %', v_err;
    END IF;
  END;
  IF (SELECT order_id FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM v_order_invoice THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected invoice detachment changed source lineage';
  END IF;
  UPDATE public.invoices SET status = 'posted' WHERE id = v_invoice;
  SELECT public.cancel_order(v_order_invoice, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  UPDATE public.invoices SET due_date = due_date + 1 WHERE id = v_invoice;
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices
     WHERE id = v_invoice AND status = 'posted' AND due_date = current_date + 31
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: safe accounting update on a posted cancelled-order invoice was blocked';
  END IF;

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_invoice, 'must reject posted invoice', v_admin,
      'e2e-b2-invoice-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with a posted invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_ACTIVE_INVOICE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: posted-invoice guard returned wrong error: %', v_err;
    END IF;
  END;

  -- ===== LIFECYCLE REGRESSION: void_order still cancels its linked draft =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QV-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_void;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_void, 'Void lifecycle') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_void, v_risk_sec, v_product, 10, 6, 2, 'gal');
  SELECT public.convert_quote_to_order(v_quote_void) INTO v_res;
  v_order_void := (v_res->>'order_id')::uuid;
  SELECT public.create_invoice_from_order(
    v_order_void, v_admin, 'chemical_sale', 'e2e-b2-pre-void-draft-' || v_suffix
  ) INTO v_invoice_void;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.orders SET status = 'fulfilled' WHERE id = v_order_void;
  PERFORM set_config('app.admin_override', 'false', true);
  SELECT public.void_order(
    v_order_void, v_admin, '[E2E] draft cleanup lifecycle proof',
    'e2e-b2-void-order-' || v_suffix
  ) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF NOT EXISTS (
    SELECT 1 FROM public.orders o
    JOIN public.invoices i ON i.order_id = o.id
    WHERE o.id = v_order_void
      AND o.status = 'voided'
      AND i.id = v_invoice_void
      AND i.status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_order could not cancel its linked draft invoice';
  END IF;

  -- ===== FAIL-CLOSED 2b: all writers reject late drafts; legacy draft blocks reopen =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QL-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_draft;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_draft, 'Late draft risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_draft, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_draft) INTO v_res;
  v_order_draft := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_draft IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: late-draft conversion failed: %', v_res;
  END IF;
  SELECT id INTO v_order_item_draft
  FROM public.order_items WHERE order_id = v_order_draft ORDER BY id LIMIT 1;
  -- Keep this writer-backdoor fixture independent of quote-total trigger drift:
  -- the allocated split engine only reaches its direct INSERT for a positive,
  -- fully priced customer subtotal.
  UPDATE public.order_items
     SET price_per_unit = 10,
         cost_per_unit = 6,
         total_price = 100,
         pricing_pending = false
   WHERE id = v_order_item_draft;
  INSERT INTO public.fields (customer_id, field_name, total_acres)
  VALUES (v_customer, '[E2E] B2 split field ' || v_suffix, 10)
  RETURNING id INTO v_field;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_order_item_draft, v_field, 10);
  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type, status,
    total_amount_cents, total_cost_cents, invoice_date, due_date, created_by
  ) VALUES (
    'E2E-B2-CANCEL-' || v_suffix, v_customer, v_order_draft,
    'chemical_sale', 'draft', 1000, 600, current_date, current_date + 30, v_admin
  ) RETURNING id INTO v_invoice_cancelled;
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices
     WHERE id = v_invoice_cancelled
       AND status IN ('draft', 'unposted')
       AND total_amount_cents > 0
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: nonzero draft invoice required before cancel_order proof';
  END IF;
  SELECT public.cancel_order(v_order_draft, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices
     WHERE id = v_invoice_cancelled
       AND status = 'cancelled'
       AND total_amount_cents = 0
       AND paid_amount_cents = 0
       AND prepay_applied_cents = 0
       AND write_off_cents = 0
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_order did not close and zero its nonzero draft invoice';
  END IF;

  BEGIN
    PERFORM public.create_invoice_from_order(
      v_order_draft, v_admin, 'chemical_sale', 'e2e-b2-late-draft-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: mono invoice creator accepted a cancelled order';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: mono late-draft guard returned wrong error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.create_split_invoices_from_order(
      v_order_draft, v_admin, 'chemical_sale', 'e2e-b2-late-split-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: split invoice creator accepted a cancelled order';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'CANCELLED_DELIVERY_INVOICE_WRITER_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: split late-draft guard returned wrong error: %', v_err;
    END IF;
  END;

  BEGIN
    PERFORM public.save_invoice(
      jsonb_build_object(
        'order_id', v_order_draft,
        'customer_id', v_customer,
        'invoice_type', 'chemical_sale',
        'status', 'draft',
        'invoice_date', current_date
      ),
      '[]'::jsonb,
      'e2e-b2-late-save-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: save_invoice accepted a cancelled order';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'CANCELLED_DELIVERY_INVOICE_WRITER_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: save_invoice late-draft guard returned wrong error: %', v_err;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.invoices
    WHERE order_id = v_order_draft AND status NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected late writer left an active invoice';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys
    WHERE idempotency_key IN (
      'e2e-b2-late-draft-' || v_suffix,
      'e2e-b2-late-split-' || v_suffix,
      'e2e-b2-late-save-' || v_suffix
    )
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected late writer left idempotency residue';
  END IF;

  -- Simulate a draft created by the pre-fix writer. The trigger is temporarily
  -- disabled only inside this rollback-only transaction to seed legacy state;
  -- the reopen RPC must still fail closed against that visible row.
  ALTER TABLE public.invoices DISABLE TRIGGER trg_guard_invoice_terminal_order;
  INSERT INTO public.invoices (
    invoice_number, customer_id, order_id, invoice_type, status,
    total_amount_cents, invoice_date, due_date, created_by
  ) VALUES (
    'E2E-B2-LATE-' || v_suffix, v_customer, v_order_draft,
    'chemical_sale', 'draft', 1000, current_date, current_date + 30, v_admin
  ) RETURNING id INTO v_invoice_draft;
  ALTER TABLE public.invoices ENABLE TRIGGER trg_guard_invoice_terminal_order;

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_draft, 'must reject late draft invoice', v_admin,
      'e2e-b2-draft-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with a late draft invoice';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_ACTIVE_INVOICE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: late-draft guard returned wrong error: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM public.invoices WHERE id = v_invoice_draft) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected reopen changed the late draft invoice';
  END IF;

  -- ===== FAIL-CLOSED 3: a paid commission survives cancellation =====
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('E2E-B2-QC-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote_commission;
  INSERT INTO public.quote_sections (quote_id, section_name)
  VALUES (v_quote_commission, 'Commission risk') RETURNING id INTO v_risk_sec;
  INSERT INTO public.quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote_commission, v_risk_sec, v_product, 10, 6, 10, 'gal');
  SELECT public.convert_quote_to_order(v_quote_commission) INTO v_res;
  v_order_commission := (v_res->>'order_id')::uuid;
  IF v_res->>'status' IS DISTINCT FROM 'created' OR v_order_commission IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: commission-risk conversion failed: %', v_res;
  END IF;
  INSERT INTO public.commissions (
    order_id, customer_id, recipient, split_percentage,
    commission_amount, order_profit, order_date, status
  ) VALUES (
    v_order_commission, v_customer, '[E2E] paid commission', 100,
    1, 1, current_date, 'paid'
  );
  SELECT public.cancel_order(v_order_commission, v_admin) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote_commission, 'must reject paid commission', v_admin,
      'e2e-b2-commission-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: reopened a cancelled order with a paid commission';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_REOPEN_PAID_COMMISSION:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: paid-commission guard returned wrong error: %', v_err;
    END IF;
  END;

  IF (SELECT status FROM public.quotes WHERE id = v_quote_completed) IS DISTINCT FROM 'accepted'
     OR (SELECT status FROM public.quotes WHERE id = v_quote_invoice) IS DISTINCT FROM 'accepted'
     OR (SELECT status FROM public.quotes WHERE id = v_quote_draft) IS DISTINCT FROM 'accepted'
     OR (SELECT status FROM public.quotes WHERE id = v_quote_commission) IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected financial reopen changed a quote status';
  END IF;

  -- Seed an expired cache entry. The shared helper must delete it under the
  -- advisory lock instead of replaying stale output.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES (
    'e2e-b2-revert-' || v_suffix,
    'revert_quote_status',
    jsonb_build_object('success', true, 'new_status', 'stale-expired-result'),
    now() - interval '1 minute'
  );

  -- ===== FAIL-FIRST: revert must rescue the stranded quote =====
  BEGIN
    SELECT public.revert_quote_status(v_quote, 'B2 smoke: un-strand', v_admin, 'e2e-b2-revert-' || v_suffix)
    INTO v_res;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    -- PRE-FIX path: revert refuses because *an order exists* -> quote stays stranded.
    RAISE EXCEPTION 'SMOKE_FAIL: stranded quote could not be reverted (B2 live): %', v_err;
  END;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'new_status' IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: revert returned %, expected new_status=sent', v_res;
  END IF;

  -- Reopening the quote must not reopen its historical order as an invoice
  -- source. Prove the writer is still blocked after the successful rescue.
  BEGIN
    PERFORM public.create_invoice_from_order(
      v_order1, v_admin, 'chemical_sale', 'e2e-b2-post-reopen-invoice-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: invoice creator accepted the old order after quote reopen';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: post-reopen invoice guard returned wrong error: %', v_err;
    END IF;
  END;

  SELECT count(*) INTO v_audit_before
  FROM public.financial_audit_log
  WHERE operation_type = 'quote_status_reverted' AND entity_id = v_quote;

  SELECT public.revert_quote_status(v_quote, 'B2 smoke: un-strand', v_admin, 'e2e-b2-revert-' || v_suffix)
  INTO v_replay;
  IF v_replay IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-key replay changed result: first=%, replay=%', v_res, v_replay;
  END IF;

  SELECT count(*) INTO v_audit_after
  FROM public.financial_audit_log
  WHERE operation_type = 'quote_status_reverted' AND entity_id = v_quote;
  IF v_audit_before <> 1 OR v_audit_after <> v_audit_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: same-key replay duplicated audit effects (before=%, after=%)', v_audit_before, v_audit_after;
  END IF;

  BEGIN
    PERFORM public.revert_quote_status(
      v_quote2,
      'B2 smoke: un-strand',
      v_admin,
      'e2e-b2-revert-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: same key replayed quote A result for quote B';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: cross-target same-key reuse produced wrong error: %', v_err;
    END IF;
  END;

  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote2;
  IF v_status IS DISTINCT FROM 'declined' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cross-target retry changed quote B to %', v_status;
  END IF;

  SELECT status INTO v_status FROM public.quotes WHERE id = v_quote;
  IF v_status <> 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote after revert = %, expected sent', v_status;
  END IF;
  SELECT COALESCE(quantity_drawn, 0) INTO v_drawn
  FROM public.quote_product_draws WHERE quote_id = v_quote AND product_id = v_product;
  IF COALESCE(v_drawn, 0) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: draw ledger after revert = %, expected 0 (released)', v_drawn;
  END IF;

  -- Retirement also holds while the quote is reopened but before a replacement
  -- is created—the exact race window called out by the adversarial review.
  BEGIN
    PERFORM public.restore_cancelled_order(
      v_order1, 'must remain retired after reopen', v_admin,
      'e2e-b2-restore-reopened-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: restored historical order while quote was reopened';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: reopened-state restore guard returned wrong error: %', v_err;
    END IF;
  END;

  -- ---- proof it is genuinely re-convertible: a NEW order is created ----
  SELECT public.convert_quote_to_order(v_quote) INTO v_res;
  PERFORM set_config('app.admin_override', 'false', true);
  IF v_res->>'status' IS DISTINCT FROM 'created' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert returned %, expected created (still stranded)', v_res;
  END IF;
  v_order2 := (v_res->>'order_id')::uuid;
  IF v_order2 IS NULL OR v_order2 = v_order1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: re-convert did not create a new order (got %, cancelled was %)', v_order2, v_order1;
  END IF;

  -- The quote is accepted again but now points at a replacement order. The old
  -- cancelled order must never be restorable beside it.
  BEGIN
    PERFORM public.restore_cancelled_order(
      v_order1,
      'must reject historical order after replacement',
      v_admin,
      'e2e-b2-restore-old-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: restored the historical order beside its replacement';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'RESTORE_CANCELLED_ORDER_RETIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: replacement-order restore guard returned wrong error: %', v_err;
    END IF;
  END;

  IF (SELECT status FROM public.orders WHERE id = v_order1) IS DISTINCT FROM 'cancelled'
     OR (SELECT status FROM public.orders WHERE id = v_order2) IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected historical restore changed an order status';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
