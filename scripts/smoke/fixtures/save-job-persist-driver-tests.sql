-- Behaviour proof for 20260903150000 (F06: job_chemicals.driver persisted by save_job).
-- Runs against the throwaway container built by scripts/smoke/prove-save-job-persist-driver.mjs,
-- AFTER save-job-chem-unit-tests.sql (T1-T66) has passed against the same v3 body. Every DO
-- block either RAISEs NOTICE with a PASS line or RAISEs EXCEPTION, so psql -v ON_ERROR_STOP=1
-- fails the run.
--
-- D1/D2 store the two calculator values. D3/D4 store NULL for an absent or blank driver, which
-- is what every pre-F06 caller sends. D5 is the refusal and proves it is raised before any
-- write. D6 is the table CHECK, the second line of defence for writers that bypass the RPC.
-- D7 proves the driver is part of the idempotency intent. D8 proves the driver never changes
-- the derived money.

-- D1: driver 'rate' is stored on the row.
DO $$
DECLARE r jsonb; d text;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":"rate"}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT jc.driver INTO d FROM job_chemicals jc WHERE jc.job_id = (r->>'job_id')::uuid;
  IF d = 'rate' THEN RAISE NOTICE 'D1 PASS  driver ''rate'' is stored on job_chemicals';
  ELSE RAISE EXCEPTION 'D1 FAIL  expected stored driver ''rate'', got %', COALESCE(d, '<NULL>'); END IF;
END $$;

-- D2: driver 'qty' is stored on the row (the hand-typed-total history).
DO $$
DECLARE r jsonb; d text;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":"qty"}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT jc.driver INTO d FROM job_chemicals jc WHERE jc.job_id = (r->>'job_id')::uuid;
  IF d = 'qty' THEN RAISE NOTICE 'D2 PASS  driver ''qty'' is stored on job_chemicals';
  ELSE RAISE EXCEPTION 'D2 FAIL  expected stored driver ''qty'', got %', COALESCE(d, '<NULL>'); END IF;
END $$;

-- D3: a payload with NO driver key (every pre-F06 caller) stores NULL and still saves.
DO $$
DECLARE r jsonb; d text; n integer;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT jc.driver, count(*) OVER () INTO d, n FROM job_chemicals jc WHERE jc.job_id = (r->>'job_id')::uuid;
  IF n = 1 AND d IS NULL THEN RAISE NOTICE 'D3 PASS  an absent driver saves and is stored as NULL (unknown)';
  ELSE RAISE EXCEPTION 'D3 FAIL  rows=% driver=%', n, COALESCE(d, '<NULL>'); END IF;
END $$;

-- D4: an EMPTY-STRING driver folds to NULL rather than being refused or stored as ''.
DO $$
DECLARE r jsonb; d text; n integer;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":""}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT jc.driver, count(*) OVER () INTO d, n FROM job_chemicals jc WHERE jc.job_id = (r->>'job_id')::uuid;
  IF n = 1 AND d IS NULL THEN RAISE NOTICE 'D4 PASS  a blank driver folds to NULL';
  ELSE RAISE EXCEPTION 'D4 FAIL  rows=% driver=%', n, COALESCE(d, '<NULL>'); END IF;
END $$;

-- D5: any other value is REFUSED as CHEM_DRIVER_INVALID, naming the product, before any
-- write -- the job count is unchanged and no chemical row exists for it.
DO $$
DECLARE ok boolean := false; msg text; jobs_before integer; jobs_after integer; chem_before integer; chem_after integer;
BEGIN
  SELECT count(*) INTO jobs_before FROM jobs;
  SELECT count(*) INTO chem_before FROM job_chemicals;
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":"total"}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  SELECT count(*) INTO jobs_after FROM jobs;
  SELECT count(*) INTO chem_after FROM job_chemicals;
  IF ok AND msg LIKE 'CHEM_DRIVER_INVALID: Acuron - 2.5 Gal carries a calculator driver of "total"%'
     AND jobs_after = jobs_before AND chem_after = chem_before THEN
    RAISE NOTICE 'D5 PASS  an unknown driver is refused before any write: %', msg;
  ELSE RAISE EXCEPTION 'D5 FAIL  (refused=% msg=% jobs %->% chem %->%)', ok, msg, jobs_before, jobs_after, chem_before, chem_after; END IF;
END $$;

-- D6: the table CHECK is the second line of defence for writers that bypass save_job.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, driver)
    VALUES ((SELECT id FROM jobs LIMIT 1), 'aaaaaaaa-0000-0000-0000-000000000002', 1, 'pt', 1, 'pt/ac', 'foo');
  EXCEPTION WHEN check_violation THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE '%job_chemicals_driver_chk%' THEN RAISE NOTICE 'D6 PASS  a direct INSERT with a bad driver trips job_chemicals_driver_chk';
  ELSE RAISE EXCEPTION 'D6 FAIL  (refused=% msg=%)', ok, msg; END IF;
END $$;

-- D7: the driver is part of the idempotency INTENT. A keyed retry that changes ONLY the
-- driver is a different request and is refused (IDEMPOTENCY_INTENT_MISMATCH), not silently
-- replayed -- an identical retry still replays to the same job.
DO $$
DECLARE r1 jsonb; r2 jsonb; ok boolean := false; msg text;
BEGIN
  r1 := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":"rate"}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, 'f06-driver-key-1');
  r2 := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":"rate"}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, 'f06-driver-key-1');
  IF (r1->>'job_id') IS DISTINCT FROM (r2->>'job_id') THEN
    RAISE EXCEPTION 'D7 FAIL  an identical keyed retry did not replay to the same job (% vs %)', r1->>'job_id', r2->>'job_id';
  END IF;
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":"qty"}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, 'f06-driver-key-1');
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
    RAISE NOTICE 'D7 PASS  same key, changed driver -> IDEMPOTENCY_INTENT_MISMATCH; identical retry replayed';
  ELSE RAISE EXCEPTION 'D7 FAIL  (refused=% msg=%)', ok, msg; END IF;
END $$;

-- D8: the driver changes NO money. The same line saved with 'rate', 'qty' and no driver
-- derives identical totals, and the stored quantity/rate are what the caller sent.
DO $$
DECLARE r jsonb; totals text[] := '{}'; t text; d text; q numeric; rt numeric;
BEGIN
  FOREACH d IN ARRAY ARRAY['rate', 'qty', ''] LOOP
    r := save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-09-03","total_acres":100}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":100}]'::jsonb,
      ('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":150,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800,"driver":"' || d || '"}]')::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
    SELECT j.total_cost_cents::text || '/' || j.total_price_cents::text INTO t FROM jobs j WHERE j.id = (r->>'job_id')::uuid;
    totals := totals || t;
    SELECT jc.quantity, jc.rate_per_acre INTO q, rt FROM job_chemicals jc WHERE jc.job_id = (r->>'job_id')::uuid;
    IF q <> 150 OR rt <> 1.5 THEN RAISE EXCEPTION 'D8 FAIL  driver % changed the stored line (qty=% rate=%)', d, q, rt; END IF;
  END LOOP;
  IF totals[1] = '450000/570000' AND totals[2] = totals[1] AND totals[3] = totals[1] THEN
    RAISE NOTICE 'D8 PASS  the driver changes no money: totals % for rate / qty / none', totals[1];
  ELSE RAISE EXCEPTION 'D8 FAIL  totals differ by driver: %', totals; END IF;
END $$;
