-- CONTAINER-ONLY rollback smoke for 20260813161614.
--
-- Proves the callable five-argument draw_down_quote wrapper cannot expose a
-- cached result or mutate business rows for another sales rep's quote or for a
-- soft-deleted quote. Positive controls prove an owning sales rep and an admin
-- pass the new boundary and reach the pre-existing EMPTY_DRAW validation. A
-- money-path probe proves two lines for one product at different cent prices
-- fail closed before an order or draw-ledger row can survive.

DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_rep_a uuid := gen_random_uuid();
  v_rep_b uuid := gen_random_uuid();
  v_customer uuid;
  v_owned_quote uuid;
  v_foreign_quote uuid;
  v_deleted_quote uuid;
  v_ambiguous_quote uuid;
  v_ambiguous_section uuid;
  v_product uuid;
  v_count integer;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (
      v_admin, 'draw-owner-admin-' || v_suffix || '@example.invalid',
      '{"full_name":"[SMOKE] Draw Admin","role":"admin"}'::jsonb, now(), now()
    ),
    (
      v_rep_a, 'draw-owner-rep-a-' || v_suffix || '@example.invalid',
      '{"full_name":"[SMOKE] Draw Rep A","role":"sales_rep"}'::jsonb, now(), now()
    ),
    (
      v_rep_b, 'draw-owner-rep-b-' || v_suffix || '@example.invalid',
      '{"full_name":"[SMOKE] Draw Rep B","role":"sales_rep"}'::jsonb, now(), now()
    );

  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES
    (v_admin, 'draw-owner-admin-' || v_suffix || '@example.invalid', '[SMOKE] Draw Admin', 'admin', true),
    (v_rep_a, 'draw-owner-rep-a-' || v_suffix || '@example.invalid', '[SMOKE] Draw Rep A', 'sales_rep', true),
    (v_rep_b, 'draw-owner-rep-b-' || v_suffix || '@example.invalid', '[SMOKE] Draw Rep B', 'sales_rep', true)
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        is_active = true;

  INSERT INTO public.customers (farm_name)
  VALUES ('[SMOKE] Draw Owner Farm ' || v_suffix)
  RETURNING id INTO v_customer;

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  ) VALUES (
    'SMK-DRAW-OWN-' || v_suffix, v_customer, v_rep_a, 'sent', '{"splits":[]}'::jsonb
  ) RETURNING id INTO v_owned_quote;

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  ) VALUES (
    'SMK-DRAW-FOR-' || v_suffix, v_customer, v_rep_b, 'sent', '{"splits":[]}'::jsonb
  ) RETURNING id INTO v_foreign_quote;

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split, deleted_at
  ) VALUES (
    'SMK-DRAW-DEL-' || v_suffix, v_customer, v_rep_a, 'revised', '{"splits":[]}'::jsonb, now()
  ) RETURNING id INTO v_deleted_quote;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_rep_a, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_rep_a::text, true);

  -- P1: an active sales rep cannot draw another active rep's quote.
  BEGIN
    PERFORM public.draw_down_quote(
      v_foreign_quote, '[]'::jsonb, v_rep_a, 'smk-foreign-' || v_suffix, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: foreign sales-rep quote draw was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'NOT_QUOTE_OWNER%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected NOT_QUOTE_OWNER, got: %', SQLERRM;
    END IF;
  END;

  -- P5: a product-level partial draw cannot silently blend distinct booked
  -- cent prices. The correct future design needs explicit cent cohorts or an
  -- immutable allocation ledger; until then this ambiguity must fail closed.
  -- Product creation is a pricing-free shell after the supplier-pricing
  -- cutover. The historical quote rows below carry their own immutable cost
  -- snapshots, so this fixture does not bypass the governed product-pricing
  -- write path merely to construct an old booking.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[SMOKE] Draw cohort product ' || v_suffix, 'gal')
  RETURNING id INTO v_product;

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  ) VALUES (
    'SMK-DRAW-COH-' || v_suffix, v_customer, v_rep_a, 'sent', '{"splits":[]}'::jsonb
  ) RETURNING id INTO v_ambiguous_quote;

  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_ambiguous_quote, 'Ambiguous money cohorts', 0)
  RETURNING id INTO v_ambiguous_section;

  -- Simulate two already-booked historical cohorts without asking the current
  -- catalog (the shell Product intentionally has no pricing). Bracket only the
  -- fixture insert; the draw itself runs with every production trigger enabled.
  ALTER TABLE public.quote_items DISABLE TRIGGER trg_snapshot_quote_item_cost;
  ALTER TABLE public.quote_items DISABLE TRIGGER zz_crx_below_cost_quote_items;
  INSERT INTO public.quote_items (
    quote_id, section_id, product_id, sort_order, price_per_unit,
    current_cost, total_units_needed, total_price, profit, net_margin, unit_size,
    cost_at_quote_cents
  ) VALUES
    (v_ambiguous_quote, v_ambiguous_section, v_product, 0, 10.00,
     5, 1, 10.00, 5.00, 50.00, 'gal', 500),
    (v_ambiguous_quote, v_ambiguous_section, v_product, 1, 10.01,
     5, 1, 10.01, 5.01, 50.05, 'gal', 500);
  ALTER TABLE public.quote_items ENABLE TRIGGER trg_snapshot_quote_item_cost;
  ALTER TABLE public.quote_items ENABLE TRIGGER zz_crx_below_cost_quote_items;

  BEGIN
    PERFORM public.draw_down_quote(
      v_ambiguous_quote,
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      v_rep_a, 'smk-cohort-' || v_suffix, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: ambiguous same-product price cohorts were blended';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AMBIGUOUS_BOOKING_MONEY_COHORTS:%' THEN
      RAISE EXCEPTION
        'SMOKE_FAIL: expected AMBIGUOUS_BOOKING_MONEY_COHORTS, got: %', SQLERRM;
    END IF;
  END;

  -- P2: a soft-deleted sent/revised quote is hidden even from its owner.
  BEGIN
    PERFORM public.draw_down_quote(
      v_deleted_quote, '[]'::jsonb, v_rep_a, 'smk-deleted-' || v_suffix, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: deleted quote draw was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'Quote not found%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected Quote not found, got: %', SQLERRM;
    END IF;
  END;

  -- P3: an owning sales rep passes the new boundary and reaches EMPTY_DRAW.
  BEGIN
    PERFORM public.draw_down_quote(
      v_owned_quote, '[]'::jsonb, v_rep_a, 'smk-owner-' || v_suffix, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: empty owner draw unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'EMPTY_DRAW%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: owner did not reach EMPTY_DRAW, got: %', SQLERRM;
    END IF;
  END;

  -- P4: an active admin may draw another rep's active quote.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.draw_down_quote(
      v_foreign_quote, '[]'::jsonb, v_admin, 'smk-admin-' || v_suffix, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: empty admin draw unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'EMPTY_DRAW%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: admin did not reach EMPTY_DRAW, got: %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count
  FROM public.orders
  WHERE quote_id IN (
    v_owned_quote, v_foreign_quote, v_deleted_quote, v_ambiguous_quote
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: boundary probes created % order(s)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.quote_product_draws
  WHERE quote_id IN (
    v_owned_quote, v_foreign_quote, v_deleted_quote, v_ambiguous_quote
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: boundary probes created % draw-ledger row(s)', v_count;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
