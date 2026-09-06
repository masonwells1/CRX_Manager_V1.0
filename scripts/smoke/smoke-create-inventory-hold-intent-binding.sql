-- Rolled-back smoke chain: create_inventory_hold is serialized on its
-- idempotency key and its receipt is bound to the signed-in actor and the
-- exact hold request.
--
-- Covers create_inventory_hold after
-- 20260905210000_bind_create_inventory_hold_receipt_to_intent.sql.
--
-- CONTAINER ONLY: plants [SMOKE] auth.users / profiles / customer / product /
-- inventory rows itself, which the live-data guard correctly refuses. Run via
-- scripts/smoke/prove-create-inventory-hold-intent-binding-real-schema.mjs.
--
-- Proves:
--   * a keyed hold creates ONE inventory_holds row and ONE receipt carrying
--     request_actor_id and request_fingerprint;
--   * the same key with an identical request (5 vs 5.0 quantity) replays the
--     same hold_id and inserts nothing;
--   * the same key with a changed quantity or notes is refused with
--     IDEMPOTENCY_INTENT_MISMATCH carrying the committed hold in DETAIL, and
--     inserts nothing;
--   * another actor cannot consume the receipt (IDEMPOTENCY_ACTOR_MISMATCH);
--   * a NULL or blank key is refused with IDEMPOTENCY_KEY_REQUIRED before any
--     work (the live body used to do the work unreceipted);
--   * a missing profile and a deactivated profile both get INSUFFICIENT_ROLE
--     (the live body's `v_role NOT IN` let a missing profile through);
--   * unauthenticated → AUTH_REQUIRED; forged p_performed_by → ACTOR_MISMATCH;
--   * a pre-migration receipt (both binding columns NULL) fails closed;
--   * cross-operation key reuse still raises;
--   * a refused stock check (INSUFFICIENT_HOLD_INVENTORY) and a non-admin force
--     (FORCE_REQUIRES_ADMIN) are unchanged and leave no hold AND no receipt;
--   * an admin force with a reason still works and is receipted;
--   * the renamed body is not executable by anon/authenticated/service_role.
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin     uuid := '5a000000-0000-4000-8000-00000000000a';
  v_rep       uuid := '5a000000-0000-4000-8000-00000000000b';
  v_inactive  uuid := '5a000000-0000-4000-8000-00000000000c';
  v_ghost     uuid := '5a000000-0000-4000-8000-00000000000d'; -- no profile row
  v_customer  uuid := '5a000000-0000-4000-8000-0000000000c1';
  v_product   uuid := '5a000000-0000-4000-8000-0000000000f1';
  v_impl_sig  text := 'public._create_inventory_hold_intent_impl_20260905(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)';
  v_res       jsonb;
  v_res2      jsonb;
  v_hold_id   uuid;
  v_count     integer;
  v_bound     uuid;
  v_fp        text;
  v_detail    text;
  v_role      text;
BEGIN
  ----------------------------------------------------------------------------
  -- Fixtures (rolled back with everything else)
  ----------------------------------------------------------------------------
  -- handle_new_user creates each profile from the signup metadata (role,
  -- full_name, is_active default true). The ghost gets NO auth.users row and
  -- therefore no profile: auth.uid() only needs the JWT claim.
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin,    'smoke-hold-admin@example.invalid',    '{"full_name":"[SMOKE] Hold Admin","role":"admin"}'::jsonb),
    (v_rep,      'smoke-hold-rep@example.invalid',      '{"full_name":"[SMOKE] Hold Rep","role":"sales_rep"}'::jsonb),
    (v_inactive, 'smoke-hold-inactive@example.invalid', '{"full_name":"[SMOKE] Hold Inactive","role":"admin"}'::jsonb)
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO v_count FROM public.profiles
   WHERE (id = v_admin AND role = 'admin' AND is_active)
      OR (id = v_rep AND role = 'sales_rep' AND is_active)
      OR (id = v_inactive AND role = 'admin' AND is_active);
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: signup trigger did not create the three fixture profiles (found %)', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_ghost) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ghost fixture unexpectedly has a profile row';
  END IF;
  -- Deactivating a profile is admin-only (trg_guard_profile_role_lock), so do
  -- it as the fixture admin.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.profiles SET is_active = false WHERE id = v_inactive;

  INSERT INTO public.customers (id, farm_name) VALUES (v_customer, '[SMOKE] Hold Farm')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.products (id, product_name, sku, is_active)
  VALUES (v_product, '[SMOKE] Hold Product', 'SMOKE-HOLD-1', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
  VALUES (v_product, 'Main Warehouse', 100, 10, 0);

  ----------------------------------------------------------------------------
  -- 1. Keyed hold: one row, one bound receipt
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  v_res := public.create_inventory_hold(
    v_product, v_customer, 5, 'manual', DATE '2026-12-31', 'first hold',
    v_admin, false, NULL, 'smoke-hold-key-1'
  );
  v_hold_id := (v_res ->> 'hold_id')::uuid;
  IF v_hold_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create returned no hold_id: %', v_res;
  END IF;
  IF (v_res ->> 'todays_free_before')::numeric <> 90 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: todays_free_before % (expected 90 = 100 - 10 - 0)', v_res ->> 'todays_free_before';
  END IF;

  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 hold, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE id = v_hold_id AND created_by = v_admin AND is_active;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: hold % not stamped created_by actor', v_hold_id;
  END IF;

  SELECT request_actor_id, request_fingerprint INTO v_bound, v_fp
    FROM public.idempotency_keys
   WHERE idempotency_key = 'smoke-hold-key-1' AND operation = 'create_inventory_hold';
  IF v_bound IS DISTINCT FROM v_admin OR v_fp IS NULL OR length(v_fp) <> 64 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: receipt not bound (actor=%, fingerprint=%)', v_bound, v_fp;
  END IF;

  ----------------------------------------------------------------------------
  -- 2. Identical request replays the same hold (5.0 = 5), inserts nothing
  ----------------------------------------------------------------------------
  v_res2 := public.create_inventory_hold(
    v_product, v_customer, 5.0, 'manual', DATE '2026-12-31', 'first hold',
    v_admin, false, NULL, 'smoke-hold-key-1'
  );
  IF (v_res2 ->> 'hold_id')::uuid IS DISTINCT FROM v_hold_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay returned % instead of %', v_res2 ->> 'hold_id', v_hold_id;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay inserted a second hold (% rows)', v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 3. Changed quantity on the retained key: refused, DETAIL carries the hold
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 6, 'manual', DATE '2026-12-31', 'first hold',
      v_admin, false, NULL, 'smoke-hold-key-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed quantity was accepted on the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF (v_detail::jsonb -> 'result' ->> 'hold_id')::uuid IS DISTINCT FROM v_hold_id
       OR v_detail::jsonb ->> 'operation' <> 'create_inventory_hold' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: mismatch DETAIL did not carry the committed hold: %', v_detail;
    END IF;
  END;

  -- Changed notes on the retained key.
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 5, 'manual', DATE '2026-12-31', 'edited notes',
      v_admin, false, NULL, 'smoke-hold-key-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed notes were accepted on the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  -- Changed expiry on the retained key.
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 5, 'manual', DATE '2027-01-31', 'first hold',
      v_admin, false, NULL, 'smoke-hold-key-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed expiry was accepted on the retained key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused retry inserted a hold (% rows)', v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 4. Another actor cannot consume the receipt
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 5, 'manual', DATE '2026-12-31', 'first hold',
      v_rep, false, NULL, 'smoke-hold-key-1'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a second actor consumed the first actor''s receipt';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_ACTOR_MISMATCH%' THEN RAISE; END IF;
  END;

  ----------------------------------------------------------------------------
  -- 5. NULL / blank key refused before any work
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, v_rep, false, NULL, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: NULL key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, v_rep, false, NULL, E'  \t '
    );
    RAISE EXCEPTION 'SMOKE_FAIL: blank key was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a keyless call inserted a hold (% rows)', v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 6. Role gate is NULL-safe and active-only
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ghost)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_ghost::text, true);
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, v_ghost, false, NULL, 'smoke-hold-key-ghost'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a caller with NO profile row created a hold';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INSUFFICIENT_ROLE%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_inactive)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_inactive::text, true);
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, v_inactive, false, NULL, 'smoke-hold-key-inactive'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a deactivated admin created a hold';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INSUFFICIENT_ROLE%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.idempotency_keys
   WHERE idempotency_key IN ('smoke-hold-key-ghost', 'smoke-hold-key-inactive');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused caller left % receipt(s) behind', v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 7. Unauthenticated and forged actor
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, NULL, false, NULL, 'smoke-hold-key-anon'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: unauthenticated call created a hold';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%AUTH_REQUIRED%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, v_admin, false, NULL, 'smoke-hold-key-forged'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: forged p_performed_by was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%ACTOR_MISMATCH%' THEN RAISE; END IF;
  END;

  ----------------------------------------------------------------------------
  -- 8. Pre-migration receipt (no binding) fails closed; cross-op key reuse
  ----------------------------------------------------------------------------
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES ('smoke-hold-key-legacy', 'create_inventory_hold',
          jsonb_build_object('hold_id', gen_random_uuid(), 'todays_free_before', 90, 'forced', false),
          now() + interval '1 hour');
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, v_rep, false, NULL, 'smoke-hold-key-legacy'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a pre-migration receipt was replayed or re-executed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE; END IF;
  END;

  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES ('smoke-hold-key-xop', 'adjust_inventory', '{"ok":true}'::jsonb, now() + interval '1 hour');
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1, 'manual', NULL, NULL, v_rep, false, NULL, 'smoke-hold-key-xop'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a key owned by another operation was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%IDEMPOTENCY_CROSS_OP_KEY_REUSE%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused key inserted a hold (% rows)', v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 9. Business guards unchanged, and a refusal leaves NO receipt
  ----------------------------------------------------------------------------
  -- sales_rep, 1000 units against 85 free: refused, nothing written.
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1000, 'manual', NULL, NULL, v_rep, false, NULL, 'smoke-hold-key-toomuch'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: negative-going hold was accepted without force';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INSUFFICIENT_HOLD_INVENTORY%' THEN RAISE; END IF;
  END;
  -- sales_rep with force: refused.
  BEGIN
    PERFORM public.create_inventory_hold(
      v_product, v_customer, 1000, 'manual', NULL, NULL, v_rep, true, 'rep override', 'smoke-hold-key-repforce'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: sales_rep force was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%FORCE_REQUIRES_ADMIN%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_count FROM public.idempotency_keys
   WHERE idempotency_key IN ('smoke-hold-key-toomuch', 'smoke-hold-key-repforce');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused hold left % receipt(s) behind', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused hold inserted a row (% rows)', v_count;
  END IF;

  -- admin force with a reason: works, receipted, marked forced.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_res := public.create_inventory_hold(
    v_product, v_customer, 1000, 'manual', NULL, 'override', v_admin, true, 'customer prepaid', 'smoke-hold-key-force'
  );
  IF (v_res ->> 'forced')::boolean IS DISTINCT FROM true OR (v_res ->> 'hold_id') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: admin force did not create a forced hold: %', v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 2 holds after admin force, found %', v_count;
  END IF;
  SELECT request_actor_id INTO v_bound FROM public.idempotency_keys
   WHERE idempotency_key = 'smoke-hold-key-force' AND operation = 'create_inventory_hold';
  IF v_bound IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'SMOKE_FAIL: forced hold receipt not bound to the admin (actor=%)', v_bound;
  END IF;
  -- The forced replay also comes back identical.
  v_res2 := public.create_inventory_hold(
    v_product, v_customer, 1000, 'manual', NULL, 'override', v_admin, true, 'customer prepaid', 'smoke-hold-key-force'
  );
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: forced replay differed: % vs %', v_res2, v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.inventory_holds WHERE product_id = v_product;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: forced replay inserted a hold (% rows)', v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 10. The renamed body is reachable only through the wrapper
  ----------------------------------------------------------------------------
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_impl_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % can execute the unserialized impl', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can execute create_inventory_hold';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated lost EXECUTE on create_inventory_hold';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
