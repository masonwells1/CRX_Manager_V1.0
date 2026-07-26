-- Section 1 number-generator / save_field security regression smoke.
-- Run only after migration 20260725234503 is applied. It checks exact grants,
-- one overload and search_path for every hardened function; no-auth and
-- wrong-role denial plus allowed-role execution for each number generator; and
-- save_field's no-partial-write, nullable actor, truthful actor, and replay
-- behavior. It always rolls back.

DO $smoke$
DECLARE
  v_admin uuid;
  v_other uuid;
  v_allowed uuid;
  v_denied uuid;
  v_target record;
  v_fn_oid oid;
  v_number text;
  v_err text;
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
      ('next_application_record_number', ARRAY['admin','sales_rep','applicator']::text[]),
      ('next_commission_payment_number', ARRAY['admin']::text[]),
      ('next_cycle_count_number', ARRAY['admin']::text[]),
      ('next_delivery_number', ARRAY['admin','sales_rep','driver']::text[]),
      ('next_job_number', ARRAY['admin','sales_rep','applicator']::text[]),
      ('next_po_number', ARRAY['admin','sales_rep']::text[])
    ) AS expected(fn, allowed_roles)
  LOOP
    v_fn_oid := format('public.%I()', v_target.fn)::regprocedure;
    IF (SELECT count(*) FROM pg_proc p WHERE p.oid = v_fn_oid) <> 1 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % does not have exactly one overload', v_target.fn;
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

    SELECT id INTO v_allowed FROM profiles
    WHERE is_active = true AND role = ANY(v_target.allowed_roles)
    ORDER BY created_at LIMIT 1;
    SELECT id INTO v_denied FROM profiles
    WHERE is_active = true AND NOT (role = ANY(v_target.allowed_roles))
    ORDER BY created_at LIMIT 1;
    IF v_allowed IS NULL OR v_denied IS NULL THEN
      RAISE EXCEPTION 'SMOKE_SETUP: % needs active allowed and denied roles', v_target.fn;
    END IF;

    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_denied, 'role', 'authenticated')::text, true);
    BEGIN
      EXECUTE format('SELECT public.%I()', v_target.fn) INTO v_number;
      RAISE EXCEPTION 'SMOKE_FAIL: % allowed wrong role', v_target.fn;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % wrong role expected INSUFFICIENT_ROLE, got %', v_target.fn, SQLERRM;
      END IF;
    END;

    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_allowed, 'role', 'authenticated')::text, true);
    EXECUTE format('SELECT public.%I()', v_target.fn) INTO v_number;
    IF v_number IS NULL OR btrim(v_number) = '' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % allowed role returned no number', v_target.fn;
    END IF;
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

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
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
