-- Post-apply rollback-only regression proof for H5 (Live Foundation Gauntlet
-- 2026-07-18): create_invoice_for_unbilled_delivery must REFUSE to backfill a
-- single invoice for an order that still needs split billing (a mono-invoice
-- would mis-attribute all the AR to one payer).
--
-- FAIL-FIRST CONTRACT: against the PRE-FIX function the backfill of a completed
-- delivery on a needs_split_billing order SUCCEEDS (one mono invoice) -> this
-- chain raises SMOKE_FAIL. Against the FIXED function it raises
-- ORDER_NEEDS_SPLIT_BILLING, so the chain reaches SMOKE_PASS_ROLLBACK.
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
  v_err      text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
  WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

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

  -- Flag the order as split-billing (unresolved).
  UPDATE public.orders SET needs_split_billing = true, updated_at = now() WHERE id = v_order;

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

  -- ===== FAIL-FIRST: backfill must be refused for a split-billing order =====
  BEGIN
    SELECT public.create_invoice_for_unbilled_delivery(v_delivery, v_admin, 'e2e-h5-' || v_suffix)
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

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
