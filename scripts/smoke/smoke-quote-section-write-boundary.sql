-- CONTAINER-ONLY rollback smoke for 20260814063000.
-- Proves authenticated traffic cannot write or truncate quote_sections while
-- the existing RLS-backed SELECT path still renders an owned quote section.

DO $smoke$
DECLARE
  v_suffix text := substr(md5(gen_random_uuid()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_customer uuid;
  v_quote uuid;
  v_section uuid;
  v_before integer;
  v_visible integer;
  v_role name;
  v_priv text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name, 'service_role'::name]
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']
    LOOP
      IF has_table_privilege(v_role, 'public.quote_sections', v_priv) THEN
        RAISE EXCEPTION 'SMOKE_PREREQ: % still holds % on public.quote_sections', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    v_admin,
    'quote-section-boundary-' || v_suffix || '@example.invalid',
    '{"full_name":"[SMOKE] Quote Section Admin","role":"admin"}'::jsonb,
    now(), now()
  );
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (
    v_admin,
    'quote-section-boundary-' || v_suffix || '@example.invalid',
    '[SMOKE] Quote Section Admin', 'admin', true
  ) ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        is_active = true;
  INSERT INTO public.customers (farm_name)
  VALUES ('[SMOKE] Quote Section Farm ' || v_suffix)
  RETURNING id INTO v_customer;
  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  ) VALUES (
    'SMK-QSEC-' || v_suffix, v_customer, v_admin, 'sent', '{"splits":[]}'::jsonb
  ) RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, 'Original', 0)
  RETURNING id INTO v_section;

  SELECT count(*) INTO v_before FROM public.quote_sections;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SET LOCAL ROLE authenticated;

  BEGIN
    INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
    VALUES (v_quote, 'Forged', 1);
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated INSERT was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected INSERT 42501, got % (%)', SQLERRM, SQLSTATE;
  END;

  BEGIN
    UPDATE public.quote_sections SET section_name = 'Rewritten' WHERE id = v_section;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated UPDATE was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected UPDATE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;

  BEGIN
    DELETE FROM public.quote_sections WHERE id = v_section;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated DELETE was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected DELETE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;

  BEGIN
    TRUNCATE public.quote_sections CASCADE;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated TRUNCATE was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected TRUNCATE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;

  SELECT count(*) INTO v_visible
  FROM public.quote_sections
  WHERE id = v_section AND section_name = 'Original';
  IF v_visible <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated SELECT no longer renders the owned quote section';
  END IF;
  RESET ROLE;

  IF (SELECT count(*) FROM public.quote_sections) < v_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote_sections row count fell during denial checks';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
