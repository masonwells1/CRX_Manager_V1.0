-- Fail-first rollback smoke for the quote commission-split guard. Before the
-- migration, the first blank-recipient INSERT succeeds and deliberately raises
-- SMOKE_FAIL. After the migration, invalid inserts/updates are rejected while
-- empty (no commission) and complete named splits remain valid.
DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_quote uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_error text;
BEGIN
  SELECT p.id
    INTO v_admin
    FROM public.profiles p
   WHERE p.role = 'admin'
     AND p.is_active = true
   ORDER BY p.created_at
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin required';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] Quote Commission Guard ' || v_suffix)
  RETURNING id INTO v_customer;

  BEGIN
    INSERT INTO public.quotes (
      quote_number, customer_id, created_by, status, commission_split
    ) VALUES (
      'E2E-QCS-BLANK-' || v_suffix,
      v_customer,
      v_admin,
      'draft',
      '{"splits":[{"recipient":"","percentage":100}]}'::jsonb
    );
    RAISE EXCEPTION 'SMOKE_FAIL: blank quote commission recipient was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'COMMISSION_SPLIT_INVALID: recipient is required%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: blank recipient raised unexpected error: %', v_error;
    END IF;
  END;

  BEGIN
    INSERT INTO public.quotes (
      quote_number, customer_id, created_by, status, commission_split
    ) VALUES (
      'E2E-QCS-MISSING-' || v_suffix,
      v_customer,
      v_admin,
      'draft',
      '{"splits":[{"recipient":"Missing Percent"}]}'::jsonb
    );
    RAISE EXCEPTION 'SMOKE_FAIL: missing quote commission percentage was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'COMMISSION_SPLIT_INVALID: percentage out of range for Missing Percent%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: missing percentage raised unexpected error: %', v_error;
    END IF;
  END;

  BEGIN
    INSERT INTO public.quotes (
      quote_number, customer_id, created_by, status, commission_split
    ) VALUES (
      'E2E-QCS-NULL-' || v_suffix,
      v_customer,
      v_admin,
      'draft',
      '{"splits":[{"recipient":"Null Percent","percentage":null}]}'::jsonb
    );
    RAISE EXCEPTION 'SMOKE_FAIL: null quote commission percentage was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'COMMISSION_SPLIT_INVALID: percentage out of range for Null Percent%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: null percentage raised unexpected error: %', v_error;
    END IF;
  END;

  INSERT INTO public.quotes (
    quote_number, customer_id, created_by, status, commission_split
  ) VALUES (
    'E2E-QCS-VALID-' || v_suffix,
    v_customer,
    v_admin,
    'draft',
    '{"splits":[]}'::jsonb
  ) RETURNING id INTO v_quote;

  UPDATE public.quotes
     SET commission_split =
           '{"splits":[{"recipient":"Mason Wells","percentage":100}]}'::jsonb
   WHERE id = v_quote;

  BEGIN
    UPDATE public.quotes
       SET commission_split =
             '{"splits":[{"recipient":"Mason Wells","percentage":50},{"recipient":" mason wells ","percentage":50}]}'::jsonb
     WHERE id = v_quote;
    RAISE EXCEPTION 'SMOKE_FAIL: duplicate quote commission recipient was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
    IF v_error LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_error NOT LIKE 'COMMISSION_SPLIT_INVALID: duplicate recipient%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: duplicate recipient raised unexpected error: %', v_error;
    END IF;
  END;

  IF (SELECT commission_split FROM public.quotes WHERE id = v_quote)
     IS DISTINCT FROM
       '{"splits":[{"recipient":"Mason Wells","percentage":100}]}'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected update changed the valid commission split';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
