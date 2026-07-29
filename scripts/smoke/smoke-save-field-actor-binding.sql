-- Rollback-only save_field actor-binding smoke.
-- Run after migration 20260729222311. It proves no-auth and forged actors are
-- rejected with the expected contract errors and leave no field rows, NULL
-- compatibility remains safe, replay is idempotent, attribution is truthful,
-- and the function contract is exact. Guard ordering is pinned separately by
-- the migration body fingerprint predicate.

DO $smoke$
DECLARE
  v_admin uuid;
  v_other uuid;
  v_customer uuid;
  v_field uuid;
  v_replay uuid;
  v_fn_oid oid;
  v_payload jsonb;
  v_count integer;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin
  FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  SELECT id INTO v_other
  FROM profiles
  WHERE id <> v_admin AND is_active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_admin IS NULL OR v_other IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin plus second active profile required';
  END IF;

  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] save_field actor farm ' || v_suffix)
  RETURNING id INTO v_customer;

  v_payload := jsonb_build_object(
    'customer_id', v_customer,
    'field_name', '[SMOKE] save_field actor field ' || v_suffix,
    'total_acres', 1,
    'state', 'IL',
    'is_active', true
  );

  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.save_field(
      NULL, v_payload, '[]'::jsonb, NULL, 'smk-field-noauth-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: save_field allowed no-auth caller';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no-auth expected AUTH_REQUIRED, got %', SQLERRM;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.save_field(
      NULL, v_payload, '[]'::jsonb, v_other, 'smk-field-forge-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: save_field accepted forged actor';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: forged actor expected ACTOR_MISMATCH, got %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count
  FROM fields
  WHERE field_name = v_payload->>'field_name';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected save_field wrote % field(s)', v_count;
  END IF;

  v_field := public.save_field(
    NULL, v_payload, '[]'::jsonb, NULL, 'smk-field-ok-' || v_suffix
  );
  v_replay := public.save_field(
    NULL, v_payload, '[]'::jsonb, NULL, 'smk-field-ok-' || v_suffix
  );

  IF v_field IS NULL OR v_replay IS DISTINCT FROM v_field THEN
    RAISE EXCEPTION 'SMOKE_FAIL: nullable-actor replay changed result';
  END IF;

  SELECT count(*) INTO v_count FROM fields WHERE id = v_field;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one saved field, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM activity_feed
  WHERE related_entity_type = 'field'
    AND related_entity_id = v_field
    AND event_type = 'field_saved'
    AND performed_by = v_admin;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected one truthful field activity by %, got %',
      v_admin, v_count;
  END IF;

  IF (
    SELECT count(*)
    FROM pg_proc p
    WHERE p.proname = 'save_field'
      AND p.pronamespace = 'public'::regnamespace
  ) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field overload count is wrong';
  END IF;

  v_fn_oid := 'public.save_field(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = v_fn_oid
      AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=public, pg_temp']
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field grant/security/search_path contract is wrong';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
