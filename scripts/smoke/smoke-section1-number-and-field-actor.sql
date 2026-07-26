-- Section 1 number-generator / save_field security regression smoke.
-- Run only after migration 20260725234503 is applied. It checks exact grants,
-- one overload and search_path; every advertised allowed role, active wrong
-- roles, and inactive otherwise-allowed actors for every number generator;
-- exact next-number output after valid current-format and safely ignored
-- malformed/out-of-scope fixtures; and save_field's no-partial-write,
-- nullable actor, truthful actor, and replay behavior. It always rolls back.
--
-- Preservation note: the source generator bodies are intentionally unchanged.
-- The commission fixture uses a malformed *other-year* value because its
-- captured current body filters by LIKE before casting; a same-year malformed
-- suffix is outside this security lane's preservation contract.

DO $smoke$
DECLARE
  v_admin uuid;
  v_other uuid;
  v_denied uuid;
  v_inactive uuid;
  v_allowed uuid;
  v_role text;
  v_target record;
  v_fn_oid oid;
  v_number text;
  v_expected text;
  v_seed_value text;
  v_malformed_value text;
  v_regex text;
  v_strip_regex text;
  v_current_max integer;
  v_seed integer;
  v_year text := extract(year FROM current_date)::text;
  v_restore_inactive boolean;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_field uuid;
  v_replay uuid;
  v_payload jsonb;
  v_n integer;
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  SELECT id INTO v_other FROM profiles
  WHERE id <> v_admin AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_other IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin plus second active profile required';
  END IF;

  FOR v_target IN
    SELECT * FROM (VALUES
      ('next_application_record_number', ARRAY['admin','sales_rep','applicator']::text[], 'application_records', 'record_number', 'APP', 4, true),
      ('next_commission_payment_number', ARRAY['admin']::text[], 'commission_payments', 'payment_number', 'CP', 4, true),
      ('next_cycle_count_number', ARRAY['admin']::text[], 'cycle_counts', 'count_number', 'CC', 5, true),
      ('next_delivery_number', ARRAY['admin','sales_rep','driver']::text[], 'deliveries', 'delivery_number', 'DEL', 5, false),
      ('next_job_number', ARRAY['admin','sales_rep','applicator']::text[], 'jobs', 'job_number', 'JOB', 4, true),
      ('next_po_number', ARRAY['admin','sales_rep']::text[], 'purchase_orders', 'po_number', 'PO', 4, true)
    ) AS expected(fn, allowed_roles, source_table, number_column, prefix, width, yearly)
  LOOP
    SELECT count(*) INTO v_n
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_target.fn;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % expected exactly one overload, got %', v_target.fn, v_n;
    END IF;
    SELECT p.oid INTO v_fn_oid
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_target.fn
      AND p.pronargs = 0
      AND pg_get_function_identity_arguments(p.oid) = '';
    IF v_fn_oid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % sole overload is not the expected zero-argument signature', v_target.fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = v_fn_oid
        AND p.proconfig = ARRAY['search_path=public, pg_temp']
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        )
    ) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % grant/search_path contract is wrong', v_target.fn;
    END IF;

    IF v_target.yearly THEN
      v_regex := '^' || v_target.prefix || '-' || v_year || '-\\d+$';
      v_strip_regex := '^' || v_target.prefix || '-' || v_year || '-';
    ELSE
      v_regex := '^' || v_target.prefix || '-\\d+$';
      v_strip_regex := '^' || v_target.prefix || '-';
    END IF;
    EXECUTE format(
      'SELECT COALESCE(MAX(CASE WHEN %1$I ~ $1 THEN regexp_replace(%1$I, $2, '''')::integer ELSE 0 END), 0) FROM public.%2$I',
      v_target.number_column, v_target.source_table
    ) USING v_regex, v_strip_regex INTO v_current_max;
    IF v_current_max > 2147483600 THEN
      RAISE EXCEPTION 'SMOKE_SETUP: % current sequence is too close to integer limit', v_target.fn;
    END IF;
    v_seed := v_current_max + 17;
    IF v_target.yearly THEN
      v_seed_value := v_target.prefix || '-' || v_year || '-' || lpad(v_seed::text, v_target.width, '0');
      v_expected := v_target.prefix || '-' || v_year || '-' || lpad((v_seed + 1)::text, v_target.width, '0');
      v_malformed_value := v_target.prefix || '-' || (v_year::integer - 1)::text || '-not-a-number-' || v_suffix;
    ELSE
      v_seed_value := v_target.prefix || '-' || lpad(v_seed::text, v_target.width, '0');
      v_expected := v_target.prefix || '-' || lpad((v_seed + 1)::text, v_target.width, '0');
      v_malformed_value := v_target.prefix || '-not-a-number-' || v_suffix;
    END IF;
    EXECUTE format('INSERT INTO public.%I (%I) VALUES ($1), ($2)', v_target.source_table, v_target.number_column)
      USING v_seed_value, v_malformed_value;

    PERFORM set_config('request.jwt.claims', '', true);
    BEGIN
      EXECUTE format('SELECT public.%I()', v_target.fn) INTO v_number;
      RAISE EXCEPTION 'SMOKE_FAIL: % allowed no-auth caller', v_target.fn;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % no-auth expected AUTH_REQUIRED, got %', v_target.fn, SQLERRM;
      END IF;
    END;

    SELECT id INTO v_denied FROM profiles
    WHERE is_active = true AND NOT (role = ANY(v_target.allowed_roles))
    ORDER BY created_at LIMIT 1;
    IF v_denied IS NULL THEN
      RAISE EXCEPTION 'SMOKE_SETUP: % needs an active denied role', v_target.fn;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_denied, 'role', 'authenticated')::text, true);
    BEGIN
      EXECUTE format('SELECT public.%I()', v_target.fn) INTO v_number;
      RAISE EXCEPTION 'SMOKE_FAIL: % allowed wrong role', v_target.fn;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % wrong role expected INSUFFICIENT_ROLE, got %', v_target.fn, SQLERRM;
      END IF;
    END;

    -- Prefer an existing inactive allowed actor. The rollback-safe fallback
    -- temporarily deactivates an allowed profile if the live fixture lacks one.
    v_restore_inactive := false;
    SELECT id INTO v_inactive FROM profiles
    WHERE is_active = false AND role = ANY(v_target.allowed_roles)
    ORDER BY created_at LIMIT 1;
    IF v_inactive IS NULL THEN
      SELECT id INTO v_inactive FROM profiles
      WHERE is_active = true AND role = ANY(v_target.allowed_roles)
      ORDER BY created_at LIMIT 1;
      IF v_inactive IS NULL THEN
        RAISE EXCEPTION 'SMOKE_SETUP: % needs an otherwise-allowed actor', v_target.fn;
      END IF;
      UPDATE profiles SET is_active = false WHERE id = v_inactive;
      v_restore_inactive := true;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_inactive, 'role', 'authenticated')::text, true);
    BEGIN
      EXECUTE format('SELECT public.%I()', v_target.fn) INTO v_number;
      RAISE EXCEPTION 'SMOKE_FAIL: % allowed inactive actor', v_target.fn;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % inactive actor expected INSUFFICIENT_ROLE, got %', v_target.fn, SQLERRM;
      END IF;
    END;
    IF v_restore_inactive THEN UPDATE profiles SET is_active = true WHERE id = v_inactive; END IF;

    FOREACH v_role IN ARRAY v_target.allowed_roles LOOP
      SELECT id INTO v_allowed FROM profiles
      WHERE is_active = true AND role = v_role
      ORDER BY created_at LIMIT 1;
      IF v_allowed IS NULL THEN
        RAISE EXCEPTION 'SMOKE_SETUP: % needs active allowed role %', v_target.fn, v_role;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_allowed, 'role', 'authenticated')::text, true);
      EXECUTE format('SELECT public.%I()', v_target.fn) INTO v_number;
      IF v_number IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % role % expected %, got % (malformed fixture was not ignored)',
          v_target.fn, v_role, v_expected, v_number;
      END IF;
    END LOOP;
  END LOOP;

  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Section1 actor farm ' || v_suffix)
  RETURNING id INTO v_customer;
  v_payload := jsonb_build_object(
    'customer_id', v_customer,
    'field_name', '[SMOKE] Section1 field ' || v_suffix,
    'total_acres', 1,
    'state', 'IL',
    'is_active', true
  );

  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.save_field(NULL, v_payload, '[]'::jsonb, NULL, 'smk-s1-noauth-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: save_field allowed no-auth caller';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: save_field no-auth expected AUTH_REQUIRED, got %', SQLERRM;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.save_field(NULL, v_payload, '[]'::jsonb, v_other, 'smk-s1-forge-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: save_field accepted forged actor';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: save_field forged actor expected ACTOR_MISMATCH, got %', SQLERRM;
    END IF;
  END;
  SELECT count(*) INTO v_n FROM fields WHERE field_name = v_payload->>'field_name';
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: rejected save_field wrote % field(s)', v_n; END IF;

  v_field := public.save_field(NULL, v_payload, '[]'::jsonb, NULL, 'smk-s1-ok-' || v_suffix);
  v_replay := public.save_field(NULL, v_payload, '[]'::jsonb, NULL, 'smk-s1-ok-' || v_suffix);
  IF v_field IS NULL OR v_replay IS DISTINCT FROM v_field THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field nullable-actor replay changed result';
  END IF;
  SELECT count(*) INTO v_n FROM fields WHERE id = v_field;
  IF v_n <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected one saved field, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM activity_feed
  WHERE related_entity_type = 'field' AND related_entity_id = v_field
    AND event_type = 'field_saved' AND performed_by = v_admin;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one truthful field activity by %, got %', v_admin, v_n;
  END IF;

  v_fn_oid := 'public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  IF (SELECT count(*) FROM pg_proc p WHERE p.proname = 'save_field' AND p.pronamespace = 'public'::regnamespace) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_fn_oid
         AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND has_function_privilege('service_role', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT EXISTS (
           SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         )
     ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field grant/search_path/overload contract is wrong';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
