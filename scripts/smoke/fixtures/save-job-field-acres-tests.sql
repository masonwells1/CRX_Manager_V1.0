-- Focused behaviour proof for 20260904185900_refuse_null_job_field_acres.sql.
-- Runs only in the throwaway PostgreSQL harness. A1/A2 prove absence and JSON null
-- refuse atomically with no committed residue from those cases; A3 intentionally leaves its
-- successful row only inside the disposable container while proving the NEW direct-RPC
-- non-null empty-string handling stores numeric zero as a NEW direct-RPC behavior; A4 keeps
-- the inherited nonblank non-finite refusal load-bearing.

-- Disposable-session auth context for the fixed prover admin seeded by both harnesses.
-- Session scope is deliberate because this fixture is a sequence of independent DO blocks.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}',
  false
);
SELECT set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

-- A1: a missing acres_to_treat key is not an intentional blank.
DO $$
DECLARE ok boolean := false; msg text; jb integer; ja integer; fb integer; fa integer; cb integer; ca integer;
BEGIN
  SELECT count(*) INTO jb FROM jobs;
  SELECT count(*) INTO fb FROM job_fields;
  SELECT count(*) INTO cb FROM job_chemicals;
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-04"}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333331"}]'::jsonb,
      '[]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  SELECT count(*) INTO ja FROM jobs;
  SELECT count(*) INTO fa FROM job_fields;
  SELECT count(*) INTO ca FROM job_chemicals;
  IF ok AND msg LIKE 'JOB_ACRES_NOT_FINITE:%missing the acreage key%'
     AND jb = ja AND fb = fa AND cb = ca THEN
    RAISE NOTICE 'A1 PASS  missing acreage key refused atomically with no committed fixture residue';
  ELSE
    RAISE EXCEPTION 'A1 FAIL  refused=% msg=% jobs %->% fields %->% chemicals %->%', ok, msg, jb, ja, fb, fa, cb, ca;
  END IF;
END $$;

-- A2: explicit JSON null is also malformed, and refusal is atomic.
DO $$
DECLARE ok boolean := false; msg text; jb integer; ja integer; fb integer; fa integer; cb integer; ca integer;
BEGIN
  SELECT count(*) INTO jb FROM jobs;
  SELECT count(*) INTO fb FROM job_fields;
  SELECT count(*) INTO cb FROM job_chemicals;
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-04"}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333332","acres_to_treat":null}]'::jsonb,
      '[]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  SELECT count(*) INTO ja FROM jobs;
  SELECT count(*) INTO fa FROM job_fields;
  SELECT count(*) INTO ca FROM job_chemicals;
  IF ok AND msg LIKE 'JOB_ACRES_NOT_FINITE:%JSON null%'
     AND jb = ja AND fb = fa AND cb = ca THEN
    RAISE NOTICE 'A2 PASS  JSON-null acreage refused atomically with no committed fixture residue';
  ELSE
    RAISE EXCEPTION 'A2 FAIL  refused=% msg=% jobs %->% fields %->% chemicals %->%', ok, msg, jb, ja, fb, fa, cb, ca;
  END IF;
END $$;

-- A3: a non-null empty string is newly accepted and normalized at the stored boundary.
DO $$
DECLARE r jsonb; stored numeric; header numeric;
BEGIN
  BEGIN
    r := save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-04"}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333333","acres_to_treat":""}]'::jsonb,
      '[]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'A3 FAIL  intentional blank did not save: %', SQLERRM;
  END;
  SELECT jf.acres_to_treat INTO stored FROM job_fields jf WHERE jf.job_id = (r->>'job_id')::uuid;
  SELECT j.total_acres INTO header FROM jobs j WHERE j.id = (r->>'job_id')::uuid;
  IF stored = 0 AND header = 0 THEN
    RAISE NOTICE 'A3 PASS  intentional blank stored as 0 and derived header acres is 0';
  ELSE
    RAISE EXCEPTION 'A3 FAIL  stored acres=% header acres=%', stored, header;
  END IF;
END $$;

-- A4: jsonb renders PostgreSQL numeric Infinity as the JSON string "Infinity";
-- save_job casts that text back to numeric Infinity, which remains refused atomically.
DO $$
DECLARE ok boolean := false; msg text; jb integer; ja integer; fb integer; fa integer; cb integer; ca integer;
BEGIN
  SELECT count(*) INTO jb FROM jobs;
  SELECT count(*) INTO fb FROM job_fields;
  SELECT count(*) INTO cb FROM job_chemicals;
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-04"}'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'field_id', '33333333-3333-3333-3333-333333333334'::uuid,
        'acres_to_treat', 'Infinity'::numeric
      )),
      '[]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  SELECT count(*) INTO ja FROM jobs;
  SELECT count(*) INTO fa FROM job_fields;
  SELECT count(*) INTO ca FROM job_chemicals;
  IF ok AND msg LIKE 'JOB_ACRES_NOT_FINITE:%negative or not a number%'
     AND jb = ja AND fb = fa AND cb = ca THEN
    RAISE NOTICE 'A4 PASS  numeric Infinity acreage refused atomically with no committed fixture residue';
  ELSE
    RAISE EXCEPTION 'A4 FAIL  refused=% msg=% jobs %->% fields %->% chemicals %->%', ok, msg, jb, ja, fb, fa, cb, ca;
  END IF;
END $$;
