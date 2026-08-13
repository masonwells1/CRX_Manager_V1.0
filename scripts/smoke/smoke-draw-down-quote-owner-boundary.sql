-- CONTAINER-ONLY rollback smoke for 20260813161614.
--
-- Proves the callable five-argument draw_down_quote wrapper cannot expose a
-- cached result or mutate business rows for another sales rep's quote or for a
-- soft-deleted quote. Positive controls prove an owning sales rep and an admin
-- pass the new boundary and reach the pre-existing EMPTY_DRAW validation.

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
  WHERE quote_id IN (v_owned_quote, v_foreign_quote, v_deleted_quote);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authorization probes created % order(s)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.quote_product_draws
  WHERE quote_id IN (v_owned_quote, v_foreign_quote, v_deleted_quote);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authorization probes created % draw-ledger row(s)', v_count;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
