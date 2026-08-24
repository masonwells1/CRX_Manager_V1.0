-- Behaviour proof for 20260820120000 (chemical-unit invariant + derived money totals).
-- Runs against the throwaway container built by
-- scripts/smoke/prove-save-job-chem-unit-invariant.mjs. Every DO block either RAISEs
-- NOTICE with a PASS line or RAISEs EXCEPTION, so psql -v ON_ERROR_STOP=1 fails the run.
--
-- T2, T3 and T28 replay the shapes of the real job_chemicals rows in production (read
-- read-only 2026-08-24, after JOB-2026-0002 was corrected) and assert the DERIVED totals
-- reproduce what those jobs actually store. Between them they now cover ALL FOUR live
-- rows, so every live row is proved to save with the correct money rather than merely
-- asserted to. T1 replays what JOB-2026-0002 looked like BEFORE that correction and pins
-- the refusal; no live row is in that shape today.
-- T4/T7/T9/T11-T13/T17 are the refusals.
-- T5/T10/T14-T16/T18/T19 are shapes that must still save. T6 is the stale-tab case.
-- T8 proves a refusal leaves nothing behind.

-- T1: the live JOB-2026-0002 shape -- rate 'pt/ac', unit NULL, and both a cost and a
-- price. This WAS the live shape of JOB-2026-0002 and the reason for the pre-apply data
-- obligation. **That row was corrected on 2026-08-24** (unit set to 'Pt' with Mason's
-- explicit OK, in a separate session; re-verified read-only here: the obligation count is
-- now ZERO and no live row is in this shape). The test is deliberately KEPT anyway, and
-- promoted from "this is the live row" to "this is the shape the rule exists to refuse" --
-- deleting it because production happens to be clean today would retire the only executable
-- statement of the policy, and the next hand-built call or legacy import can recreate the
-- shape at any time. T28 covers the CORRECTED live row.
--
-- It used to assert that this shape SAVES. It no longer does: a blank unit proves nothing
-- while transfer_job_to_invoice bills the line anyway, so as of Mason's 2026-08-23
-- decision the line is REFUSED. Note the totals it used to assert (219930 / 278578) were
-- reproduced exactly by the derivation before the refusal was added, so the arithmetic is
-- not what changed here; the policy is. T28 now asserts those same two totals against the
-- CORRECTED row, which is the stronger claim: the money was always right, only the label
-- was missing.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":73.31,"total_cost_cents":219930,"total_price_cents":278578}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333331","acres_to_treat":73.31}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","quantity":73.31,"unit":null,"rate_per_acre":1,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_UNSPECIFIED%' THEN RAISE NOTICE 'T1 PASS  a blank-unit billing line is refused (the former JOB-2026-0002 shape): %', msg;
  ELSE RAISE EXCEPTION 'T1 FAIL  (refused=% msg=%)  -- the live blank-unit billing row was ACCEPTED', ok, msg; END IF;
END $$;

-- T2: live JOB-2026-0004 / 0003 shape. Units equal -> no hazard.
DO $$
DECLARE r jsonb; c bigint; p bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":39.09,"total_cost_cents":187632,"total_price_cents":206395}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333332","acres_to_treat":39.09}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":3752.64,"unit":"oz","rate_per_acre":96,"rate_unit":"oz","cost_per_unit_cents":50,"price_per_unit_cents":55}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents, total_price_cents INTO c, p FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 187632 AND p = 206395 THEN RAISE NOTICE 'T2 PASS  saved; derived cost=% price=% (live stores 187632 / 206395)', c, p;
  ELSE RAISE EXCEPTION 'T2 FAIL  cost=% price=%', c, p; END IF;
END $$;

-- T3: live JOB-2026-0001 shape. rate_unit is the junk string '32' and unit is 'Gal', but
-- quantity is 0 so nothing is billed and nothing is claimed. Must still SAVE.
DO $$
DECLARE r jsonb; c bigint; p bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":178.31,"total_cost_cents":0,"total_price_cents":0}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333333","acres_to_treat":178.31}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity":0,"unit":"Gal","rate_per_acre":5,"rate_unit":"32","cost_per_unit_cents":4503,"price_per_unit_cents":0}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents, total_price_cents INTO c, p FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 0 AND p = 0 THEN RAISE NOTICE 'T3 PASS  saved; derived cost=% price=% (live stores 0 / 0)', c, p;
  ELSE RAISE EXCEPTION 'T3 FAIL  cost=% price=%', c, p; END IF;
END $$;

-- T4: THE 16x BUG. Dry product, rate in oz/ac, price quoted per lb, quantity in ounces.
-- 16 oz/ac x 10 ac = 160 oz = 10 lb; billing 160 lb is 16x too much. Must REFUSE.
-- Also asserts the remedy text names BOTH numbers to re-enter: telling the operator to
-- change only the unit converts this into a 16x UNDER-bill that silences the guard.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333334","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":160,"unit":"lb","rate_per_acre":16,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF NOT ok OR msg NOT LIKE 'CHEM_UNIT_MISMATCH%' THEN
    RAISE EXCEPTION 'T4 FAIL  (refused=% msg=%)', ok, msg;
  END IF;
  IF msg NOT LIKE '%re-enter the cost and price%' THEN
    RAISE EXCEPTION 'T4 FAIL  remedy text does not tell the operator to re-enter cost and price: %', msg;
  END IF;
  RAISE NOTICE 'T4 PASS  refused: %', msg;
END $$;

-- T5: same product and units, but the quantity IS the correctly carried 10 lb. Must SAVE.
DO $$
DECLARE r jsonb; c bigint; p bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333335","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":10,"unit":"lb","rate_per_acre":16,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents, total_price_cents INTO c, p FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 1000 AND p = 2000 THEN RAISE NOTICE 'T5 PASS  saved a legitimate unit conversion; cost=% price=%', c, p;
  ELSE RAISE EXCEPTION 'T5 FAIL  cost=% price=%', c, p; END IF;
END $$;

-- T6: THE STALE TAB. Same lines as T2, but the caller claims the totals are 1 cent.
DO $$
DECLARE r jsonb; c bigint; p bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":39.09,"total_cost_cents":1,"total_price_cents":1}'::jsonb,
    '[{"field_id":"33333333-3333-3333-3333-333333333336","acres_to_treat":39.09}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":3752.64,"unit":"oz","rate_per_acre":96,"rate_unit":"oz","cost_per_unit_cents":50,"price_per_unit_cents":55}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents, total_price_cents INTO c, p FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 187632 AND p = 206395 THEN RAISE NOTICE 'T6 PASS  caller claimed 1/1, database stored cost=% price=%', c, p;
  ELSE RAISE EXCEPTION 'T6 FAIL  cost=% price=%', c, p; END IF;
END $$;

-- T7: a rate measured per hundredweight, SLASH form.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333337","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":10,"unit":"lb","rate_per_acre":16,"rate_unit":"oz/cwt","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN RAISE NOTICE 'T7 PASS  refused: %', msg;
  ELSE RAISE EXCEPTION 'T7 FAIL  (refused=% msg=%)', ok, msg; END IF;
END $$;

-- T9: the SPELLED-OUT denominator, and the unit deliberately carries the SAME text so the
-- two normalise equal. This is the exact escape Codex found (P1, 2026-08-23): with a
-- slash-only rule the units compare equal, the row is accepted, and its quantity has
-- already been derived as rate x acres against a denominator that is not acres.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333339","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":10,"unit":"lb per cwt","rate_per_acre":16,"rate_unit":"lb per cwt","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN RAISE NOTICE 'T9 PASS  refused the spelled-out form: %', msg;
  ELSE RAISE EXCEPTION 'T9 FAIL  (refused=% msg=%)  -- a per-cwt rate whose unit matches was ACCEPTED', ok, msg; END IF;
END $$;

-- T10: a genuine per-acre rate in the spelled-out form must still SAVE. The T9 rule must
-- not swallow 'gal per acre'.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"3333333a-3333-3333-3333-333333333330","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal per acre","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 2000 THEN RAISE NOTICE 'T10 PASS  a real per-acre rate in words still saves; cost=%', c;
  ELSE RAISE EXCEPTION 'T10 FAIL  cost=%', c; END IF;
END $$;

-- T11: a NaN ACREAGE must not buy a mismatched line a free pass. This is the bypass Codex
-- found (P1, round 3): PostgreSQL orders numeric NaN above every value, so `v_acres > 0`
-- was TRUE for NaN, the carried quantity came back NaN, and the tolerance test then
-- compared NaN <= NaN -- TRUE, because NaN equals itself -- so the row was ACCEPTED.
-- The units here plainly disagree (an ounce rate against pound-priced stock).
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"3333333b-3333-3333-3333-333333333331","acres_to_treat":"NaN"}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":10,"unit":"lb","rate_per_acre":16,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_MISMATCH%' THEN RAISE NOTICE 'T11 PASS  NaN acreage no longer waves a mismatch through: %', msg;
  ELSE RAISE EXCEPTION 'T11 FAIL  (refused=% msg=%)  -- a NaN acreage ACCEPTED a mismatched line', ok, msg; END IF;
END $$;

-- T12: a NEGATIVE quantity is refused outright, even though the units here AGREE. Without
-- this the line skips the invariant entirely and still reaches safe_cents_qty, producing
-- negative total_cost_cents / total_price_cents.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"3333333b-3333-3333-3333-333333333332","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":-5,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_QUANTITY_NOT_FINITE%' THEN RAISE NOTICE 'T12 PASS  refused a negative quantity: %', msg;
  ELSE RAISE EXCEPTION 'T12 FAIL  (refused=% msg=%)  -- a negative quantity reached the money totals', ok, msg; END IF;
END $$;

-- T13: the HYPHENATED denominator, unit again carrying the same text so the two normalise
-- equal. Same escape shape as T9, one separator away.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"3333333b-3333-3333-3333-333333333333","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":10,"unit":"lb-per-cwt","rate_per_acre":16,"rate_unit":"lb-per-cwt","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN RAISE NOTICE 'T13 PASS  refused the hyphenated form: %', msg;
  ELSE RAISE EXCEPTION 'T13 FAIL  (refused=% msg=%)  -- a per-cwt rate written with hyphens was ACCEPTED', ok, msg; END IF;
END $$;

-- T14: the PLURAL per-acre spelling must still save. The T13 rule must not swallow
-- 'gal per acres', which the slash form has always accepted.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"3333333b-3333-3333-3333-333333333334","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal per acres","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 2000 THEN RAISE NOTICE 'T14 PASS  the plural per-acre spelling still saves; cost=%', c;
  ELSE RAISE EXCEPTION 'T14 FAIL  cost=%', c; END IF;
END $$;

-- T15 / T16: the ABBREVIATED per-acre spellings must save. The slash form has always
-- accepted 'ac' and 'a'; the word form originally took only 'acre'/'acres', so 'gal per ac'
-- -- an entirely ordinary way to write a per-acre rate -- was refused as a non-acre
-- denominator. That is a false refusal, and a refusal blocks the whole job rather than the
-- one line, so it is the more damaging direction of the two.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"3333333c-3333-3333-3333-333333333335","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal per ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 2000 THEN RAISE NOTICE 'T15 PASS  the abbreviated word spelling still saves; cost=%', c;
  ELSE RAISE EXCEPTION 'T15 FAIL  cost=%', c; END IF;
END $$;

DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"3333333c-3333-3333-3333-333333333336","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal-per-acre","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 2000 THEN RAISE NOTICE 'T16 PASS  the hyphenated per-acre spelling still saves; cost=%', c;
  ELSE RAISE EXCEPTION 'T16 FAIL  cost=%', c; END IF;
END $$;

-- T17: a BLANK unit on a line that BILLS is refused. This is the shape one live row was
-- sitting in: a pt/ac rate, no stock Unit, and both a cost and a price. It proves nothing,
-- so it used to be skipped -- while transfer_job_to_invoice billed it anyway.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"3333333d-3333-3333-3333-333333333337","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":15,"unit":"","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":1250,"price_per_unit_cents":1800}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_UNSPECIFIED%' THEN RAISE NOTICE 'T17 PASS  refused a billing line with a blank unit: %', msg;
  ELSE RAISE EXCEPTION 'T17 FAIL  (refused=% msg=%)  -- a blank-unit line that bills was ACCEPTED', ok, msg; END IF;
END $$;

-- T18: a blank unit that bills NOTHING still saves. A line that cannot bill cannot bill
-- wrongly, so refusing it would be pure friction.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"3333333d-3333-3333-3333-333333333338","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":15,"unit":"","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":0,"price_per_unit_cents":0}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_price_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 0 THEN RAISE NOTICE 'T18 PASS  a blank-unit line that bills nothing still saves; price=%', c;
  ELSE RAISE EXCEPTION 'T18 FAIL  price=%', c; END IF;
-- A handler so that losing the exemption reports as "T18 FAIL" rather than as a raw psql
-- error. Without it a mutant that deletes the exemption is detected only as "the suite went
-- red", which the mutation phases explicitly refuse to accept as a detection.
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T18 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T18 FAIL  the save was refused, so the zero-cost/zero-price exemption is gone: %', SQLERRM;
END $$;

-- T19: a CUSTOMER-SUPPLIED line with a blank unit still saves. It contributes 0 to both
-- totals by construction, so it cannot carry a wrong number either.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"3333333d-3333-3333-3333-333333333339","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":15,"unit":"","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":1250,"price_per_unit_cents":1800,"customer_supplied":true}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_price_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 0 THEN RAISE NOTICE 'T19 PASS  a customer-supplied blank-unit line still saves and bills 0; price=%', c;
  ELSE RAISE EXCEPTION 'T19 FAIL  price=%', c; END IF;
-- A handler so that LOSING the exemption reports as "T19 FAIL" rather than as a raw psql
-- error. Without it a mutant that deletes the exemption is detected only as "the suite went
-- red", which the mutation phases explicitly refuse to accept as a detection.
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T19 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T19 FAIL  the save was refused, so the customer-supplied exemption is gone: %', SQLERRM;
END $$;

-- T20 CARRIES THE ACREAGE IT WAS ALWAYS ABOUT (corrected in round 17). It previously sent
-- acres_to_treat = 10 against a 1.5 pt/ac rate, which describes a line where 15 pt WAS
-- expected and none was recorded -- the underbilling shape T46 now refuses, frozen into a
-- test as correct. The scenario this test exists for is a product picked BEFORE any acreage
-- is entered, and there acres is 0, so the expected quantity is 0 too and the line is simply
-- right. Setting the acreage to 0 makes the test describe its own scenario. The gate caught
-- this; it is the second time in this file that a test had been written around a defect and
-- would have defended it against the next reviewer.
--
-- T20: a blank unit with a PRICE but quantity 0 must still SAVE. It bills
-- safe_cents_qty(price, 0) = 0, so by the stated rule -- a line that cannot bill cannot
-- bill wrongly -- it is exempt. The zero-quantity skip sat BELOW the blank-unit refusal
-- when the refusal was first written, so this shape was refused, and refusing it blocks the
-- whole job. It is reachable from the ordinary UI: reconcileChemAutofillUnits leaves `unit`
-- blank on its fallback path while the tier price is already filled in, so a product picked
-- before any acreage is entered lands exactly here. Found by the security review of the
-- commit that introduced the refusal.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"3333333e-3333-3333-3333-333333333340","acres_to_treat":0}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":0,"unit":"","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":1250,"price_per_unit_cents":1800}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_price_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 0 THEN RAISE NOTICE 'T20 PASS  a zero-quantity blank-unit line still saves and bills 0; price=%', c;
  ELSE RAISE EXCEPTION 'T20 FAIL  price=%', c; END IF;
-- A handler so that losing the skip reports as "T20 FAIL" rather than as a raw psql error.
-- Without it a mutant that moves the zero-quantity skip back below the blank-unit refusal is
-- detected only as "the suite went red", which the mutation phases refuse to accept.
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T20 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T20 FAIL  the save was refused, so the zero-quantity skip no longer runs before the blank-unit refusal: %', SQLERRM;
END $$;

-- T21: the OTHER half of the refusal -- a blank RATE unit while the stock Unit is filled.
-- Every earlier blank-unit test blanked only `unit`, so this branch and its distinct error
-- wording had never executed once.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"3333333e-3333-3333-3333-333333333341","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":15,"unit":"gal","rate_per_acre":1.5,"rate_unit":"","cost_per_unit_cents":1250,"price_per_unit_cents":1800}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_UNSPECIFIED%' AND msg LIKE '%its rate unit is blank%'
    THEN RAISE NOTICE 'T21 PASS  refused a blank RATE unit, with the right wording: %', msg;
  ELSE RAISE EXCEPTION 'T21 FAIL  (refused=% msg=%)', ok, msg; END IF;
END $$;

-- T22: both sides blank -- the third arm of the message, also never previously executed.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"3333333e-3333-3333-3333-333333333342","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":15,"unit":"","rate_per_acre":1.5,"rate_unit":"","cost_per_unit_cents":1250,"price_per_unit_cents":1800}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE '%neither its rate unit nor its Unit is filled in%'
    THEN RAISE NOTICE 'T22 PASS  refused with the both-blank wording: %', msg;
  ELSE RAISE EXCEPTION 'T22 FAIL  (refused=% msg=%)', ok, msg; END IF;
END $$;

-- T23: blank unit with a COST but NO price. This is the case that actually distinguishes
-- the rule as built from the "refuse only when there is a price" softening that was
-- considered and rejected: cost feeds total_cost_cents and therefore margin, not just the
-- customer bill. Every other blank-unit test carries either both or neither, so nothing
-- was holding the cost half of the claim up.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"3333333e-3333-3333-3333-333333333343","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":15,"unit":"","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":1250,"price_per_unit_cents":0}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_UNSPECIFIED%' THEN RAISE NOTICE 'T23 PASS  a cost with no price is still refused: %', msg;
  ELSE RAISE EXCEPTION 'T23 FAIL  (refused=% msg=%)  -- the cost side of the rule is not enforced', ok, msg; END IF;
END $$;

-- T24: a STACKED denominator in the slash form. Found by Codex (BLOCKER, 2026-08-24) against
-- the round-7 commits. The old rule asked whether the rate unit ENDS in a per-acre suffix and
-- stopped there, so `oz/cwt/ac` satisfied it -- and the base derivation then took everything
-- before the FIRST slash, silently discarding `cwt`. The line therefore normalised to plain
-- `oz`, compared EQUAL to a stock unit of `oz`, and saved: a per-hundredweight rate billed as
-- though it were per-acre. `unit` deliberately carries the matching text, so if the
-- denominator rule does not fire there is nothing else left to catch it.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333337","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":10,"unit":"oz","rate_per_acre":16,"rate_unit":"oz/cwt/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN RAISE NOTICE 'T24 PASS  a stacked slash denominator is refused: %', msg;
  ELSE RAISE EXCEPTION 'T24 FAIL  (refused=% msg=%)  -- oz/cwt/ac bypassed the denominator rule and billed per-acre', ok, msg; END IF;
END $$;

-- T25: the same bypass one spelling away -- a stacked denominator in the WORD form. The
-- trailing ` per acre` satisfied the old rule and the stripper removed exactly that suffix,
-- leaving `oz per cwt` to be compared against a stock unit carrying the same text. Asserting
-- the SPECIFIC message matters here: a refusal with the wrong error name would mean the row
-- was caught by the blank-unit rule downstream by luck, not by the denominator rule.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333333-3333-3333-3333-333333333337","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":10,"unit":"oz per cwt","rate_per_acre":16,"rate_unit":"oz per cwt per acre","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN RAISE NOTICE 'T25 PASS  a stacked word denominator is refused: %', msg;
  ELSE RAISE EXCEPTION 'T25 FAIL  (refused=% msg=%)  -- "oz per cwt per acre" bypassed the denominator rule', ok, msg; END IF;
END $$;

-- T26: CROSS-OPERATION idempotency key reuse must be REFUSED, not silently ignored.
-- Found by the exact-SHA proof gate (2026-08-24). The old body looked the key up with
-- `AND operation = 'save_job'`, so a key already spent by a DIFFERENT operation was
-- invisible: the job was created, the receipt INSERT was swallowed by
-- ON CONFLICT (idempotency_key) DO NOTHING -- the uniqueness is on the KEY ALONE, both
-- here and on live -- and the NEXT retry with that key found nothing again and created a
-- SECOND job. A duplicate job is a duplicate bill. check_idempotency raises instead.
-- The row count is asserted too: refusing but still writing would be no better.
DO $$
DECLARE ok boolean := false; msg text; n_before int; n_after int;
BEGIN
  INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES ('K-CROSS-OP', 'post_invoice', '{"success":true}'::jsonb, now() + interval '24 hours');
  SELECT count(*) INTO n_before FROM jobs;
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333341-3333-3333-3333-333333333343","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, 'K-CROSS-OP');
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  SELECT count(*) INTO n_after FROM jobs;
  IF ok AND msg LIKE 'IDEMPOTENCY_CROSS_OP_KEY_REUSE%' AND n_after = n_before THEN
    RAISE NOTICE 'T26 PASS  a key spent by another operation is refused and wrote nothing: %', msg;
  ELSE
    RAISE EXCEPTION 'T26 FAIL  (refused=% msg=% jobs %->%)  -- save_job is not routing through check_idempotency', ok, msg, n_before, n_after;
  END IF;
END $$;

-- T27: the ordinary same-key replay must still work -- return the SAME job and create no
-- second one. This is the behaviour the fix must NOT break: it is the whole reason the
-- idempotency key exists (the create-path double-submit). Without this test, routing
-- through check_idempotency could regress every retry into a duplicate and stay green.
DO $$
DECLARE r1 jsonb; r2 jsonb; n_before int; n_after int;
BEGIN
  SELECT count(*) INTO n_before FROM jobs;
  r1 := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333342-3333-3333-3333-333333333344","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, 'K-REPLAY');
  r2 := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333342-3333-3333-3333-333333333344","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, 'K-REPLAY');
  SELECT count(*) INTO n_after FROM jobs;
  IF (r1->>'job_id') = (r2->>'job_id') AND n_after = n_before + 1 THEN
    RAISE NOTICE 'T27 PASS  a same-key replay returned the same job and created no second one (jobs %->%)', n_before, n_after;
  ELSE
    RAISE EXCEPTION 'T27 FAIL  job_id % vs %, jobs %->%  -- the replay path is broken', r1->>'job_id', r2->>'job_id', n_before, n_after;
  END IF;
-- A handler, for the same reason T20 has one. If the receipt stops being bound to an actor
-- and a fingerprint, check_idempotency_intent's fail-closed bridge clause turns the ordinary
-- retry into a hard IDEMPOTENCY_INTENT_MISMATCH instead of a duplicate job. That is still the
-- replay path breaking, and it must report as "T27 FAIL" rather than as a raw psql error the
-- mutation phase cannot attribute to any test.
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T27 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T27 FAIL  the same-key replay was refused outright, so an ordinary retry no longer returns the original job: %', SQLERRM;
END $$;

-- T28: the CORRECTED live JOB-2026-0002 row, read read-only 2026-08-24 -- rate 'pt/ac',
-- unit 'Pt', quantity 73.31, 3000c cost and 3800c price. Its Unit was filled in on
-- 2026-08-24 with Mason's explicit OK (a separate session made the one-row change), which
-- retired the pre-apply data obligation: the obligation count now returns ZERO.
--
-- Two things are asserted, and the second is the point. First, the row SAVES: 'pt/ac'
-- normalises to 'pt' and 'Pt' lowercases to 'pt', so the units-are-equal skip fires and
-- no proof is needed. Second, the DERIVED totals are 219930 / 278578, reproducing what
-- that job actually stores to the cent -- the same two numbers T1 used to assert before
-- the refusal existed. That is the real claim: correcting the label did not move the
-- money, because the per-unit amounts were already quoted per pint.
--
-- Written because the correction made T1 stop covering any live row. A migration whose
-- live-shape tests no longer match live is exactly the "proved something that is not
-- production" trap, and the fix is to add the new shape rather than to reword a comment.
DO $$
DECLARE r jsonb; c bigint; p bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":73.31,"total_cost_cents":219930,"total_price_cents":278578}'::jsonb,
    '[{"field_id":"33333343-3333-3333-3333-333333333345","acres_to_treat":73.31}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","quantity":73.31,"unit":"Pt","rate_per_acre":1,"rate_unit":"pt/ac","cost_per_unit_cents":3000,"price_per_unit_cents":3800}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_cost_cents, total_price_cents INTO c, p FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 219930 AND p = 278578 THEN
    RAISE NOTICE 'T28 PASS  the corrected live row saves; derived cost=% price=% (live stores 219930 / 278578)', c, p;
  ELSE
    RAISE EXCEPTION 'T28 FAIL  cost=% price=% (expected 219930 / 278578)  -- the derivation no longer reproduces the live totals', c, p;
  END IF;
END $$;

-- T29: a receipt belonging to a DIFFERENT ACTOR must not be replayed to this caller.
-- Seeded directly, because the harness authenticates as a single fixed uuid. The row is
-- fully bound -- both binding columns populated -- so this exercises the actor check
-- itself and not the unbound-receipt deployment bridge.
DO $$
DECLARE ok boolean := false; msg text; n_before int; n_after int;
BEGIN
  INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at,
                                request_fingerprint, request_actor_id)
  VALUES ('K-OTHER-ACTOR', 'save_job', '{"success":true,"job_id":"99999999-9999-9999-9999-999999999999"}'::jsonb,
          now() + interval '24 hours', 'deadbeef', '22222222-0000-0000-0000-00000000dead');
  SELECT count(*) INTO n_before FROM jobs;
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333344-3333-3333-3333-333333333346","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, 'K-OTHER-ACTOR');
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  SELECT count(*) INTO n_after FROM jobs;
  IF ok AND msg LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' AND n_after = n_before THEN
    RAISE NOTICE 'T29 PASS  another actor''s receipt is refused and wrote nothing: %', msg;
  ELSE
    RAISE EXCEPTION 'T29 FAIL  (refused=% msg=% jobs %->%)  -- the receipt is not bound to the actor', ok, msg, n_before, n_after;
  END IF;
END $$;

-- T30: A -> B -> A. The exact defect the gate described: reuse a COMPLETED key for a
-- CHANGED payload. Before intent binding the second call returned the first call's
-- success and silently saved nothing -- the operator is told "saved" while the edited
-- quantity went nowhere. It must now be REFUSED, and the third leg proves the refusal did
-- not corrupt the receipt: replaying the ORIGINAL payload still returns the original job.
DO $$
DECLARE r1 jsonb; r3 jsonb; ok boolean := false; msg text; n_after_a int; n_after_b int;
BEGIN
  r1 := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333345-3333-3333-3333-333333333347","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, 'K-INTENT');
  SELECT count(*) INTO n_after_a FROM jobs;

  -- Same key, CHANGED quantity (20 -> 40). Must not replay, must not save.
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":20}'::jsonb,
      '[{"field_id":"33333345-3333-3333-3333-333333333347","acres_to_treat":20}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":40,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, 'K-INTENT');
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  SELECT count(*) INTO n_after_b FROM jobs;

  IF NOT ok OR msg NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
    RAISE EXCEPTION 'T30 FAIL  a changed payload on a spent key was not refused (refused=% msg=%)  -- the operator would be told "saved" while the edit went nowhere', ok, msg;
  END IF;
  IF n_after_b <> n_after_a THEN
    RAISE EXCEPTION 'T30 FAIL  the refused changed-payload call still wrote a job (%->%)', n_after_a, n_after_b;
  END IF;

  -- Third leg: the ORIGINAL payload must still replay cleanly to the same job.
  r3 := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333345-3333-3333-3333-333333333347","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":20,"unit":"gal","rate_per_acre":2,"rate_unit":"gal/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, 'K-INTENT');
  IF (r3->>'job_id') IS DISTINCT FROM (r1->>'job_id') THEN
    RAISE EXCEPTION 'T30 FAIL  replaying the ORIGINAL payload no longer returns the original job (% vs %)', r1->>'job_id', r3->>'job_id';
  END IF;
  IF (SELECT count(*) FROM jobs) <> n_after_a THEN
    RAISE EXCEPTION 'T30 FAIL  the original-payload replay created a second job';
  END IF;

  RAISE NOTICE 'T30 PASS  a changed payload on a spent key is refused (%), and the original payload still replays to the same job', msg;
END $$;

-- T31: THE BLOCKER the exact-SHA gpt-5.6-sol gate found on 2026-08-24. A DRY product with a
-- rate of 'fl oz/ac' against a stock Unit of 'oz'. normalize_rate_unit collapses BOTH to 'oz'
-- knowing nothing about the product, so the equality shortcut fired and the line billed with
-- nothing proven -- while field_app_priced_quantity, which the rest of the app bills through,
-- sizes 'fl oz' as NULL in its dry branch and refuses the pair outright. A guard that is more
-- lenient than the SQL doing the billing is not a guard. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333350-3333-3333-3333-333333333351","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"oz","rate_per_acre":10,"rate_unit":"fl oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T31 PASS  a dry product billed fl oz against oz is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T31 FAIL  refused=% msg=%  -- the fl-oz-on-dry alias still reaches the money', ok, msg;
  END IF;
END $$;

-- T32: the same hole one swap away -- rate in dry 'oz', stock Unit in 'fl oz'. The alias is
-- symmetric, so the refusal has to be too.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333352-3333-3333-3333-333333333353","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"fl oz","rate_per_acre":10,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T32 PASS  the reversed dry fl-oz pair is refused too: %', msg;
  ELSE
    RAISE EXCEPTION 'T32 FAIL  refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T33: THE FALSE-REFUSAL GUARD, and the reason the new rule is narrow. On a LIQUID product the
-- fl oz -> oz alias is exactly RIGHT: the live unit_conversions table records 'oz' as "alias for
-- fl oz", both liquid, both factor 1. This line must still SAVE. Refusing it would block the
-- whole job save, which is the round-7 defect three reviewers caught.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333354-3333-3333-3333-333333333355","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":100,"unit":"oz","rate_per_acre":10,"rate_unit":"fl oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_price_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 20000 THEN RAISE NOTICE 'T33 PASS  fl oz against oz on a LIQUID product still saves; price=%', c;
  ELSE RAISE EXCEPTION 'T33 FAIL  price=%', c; END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T33 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T33 FAIL  a LIQUID fl-oz/oz line was REFUSED, so the new dry rule is over-firing and blocks whole jobs: %', SQLERRM;
END $$;

-- T34: INVERTED in round 12, and the inversion is the point. This test used to require that a
-- DRY line quoted 'fl oz' on BOTH sides SAVE, on the reasoning that identical spellings are
-- self-consistent and field_app_priced_quantity passes them untouched. That reasoning was wrong
-- in the way that matters: self-consistent arithmetic on a unit the inventory and invoice sides
-- cannot convert is not a saving grace, and writing the exemption into a test froze the half-fix
-- in place. A dry product has no density here, so a fluid ounce cannot be carried into a weight
-- honestly on ANY side. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333356-3333-3333-3333-333333333357","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"fl oz","rate_per_acre":10,"rate_unit":"fl oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T34 PASS  a dry line quoted fl oz on BOTH sides is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T34 FAIL  refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T39: THE PERIOD SPELLING -- the escape the round-12 rule left open, returned by the gate as a
-- fresh P1 and the THIRD time this same fluid-ounce rule has been caught incomplete. Round 12
-- matched three literal strings ('fl oz', 'floz', 'fluid ounce'). 'fl. oz' is none of them.
--
-- Why that reaches the money rather than being refused somewhere else: normalize_rate_unit has no
-- CASE arm for the period form, so it falls through to ELSE base and hands the string BACK
-- unchanged. Both sides therefore normalise to the SAME unrecognised token 'fl. oz', the equality
-- shortcut fires, and the line is accepted with NOTHING proven -- then billed. This is exactly the
-- shape T34 refuses, wearing a period.
--
-- It is not an exotic spelling invented for a test: src/lib/blendMathValidator.ts documents in so
-- many words that periods are insignificant and "'fl. oz' is 'fl oz'". The client would treat this
-- line as fluid ounces; the server did not.
--
-- The fix canonicalises BOTH sides (whitespace and periods collapse to one space) before matching
-- the CONCEPT {fl|fluid} x {oz|ozs|ounce|ounces}, so the rule no longer depends on guessing every
-- spelling in advance. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333366-3333-3333-3333-333333333367","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"fl. oz","rate_per_acre":10,"rate_unit":"fl. oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T39 PASS  a dry line quoted "fl. oz" on BOTH sides is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T39 FAIL  the period spelling escaped the dry fluid-ounce rule and billed with nothing proven; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T40: THE ZERO-WIDTH SPELLING -- the escape the round-13 fix ITSELF left open, returned by
-- CodeRabbit as a P1 the same day. Round 13 folded periods and whitespace and stopped there,
-- so 'fl<U+200B>oz' walked through exactly as 'fl. oz' had one round earlier. That is the same
-- mistake twice running: fixing the single spelling a reviewer happened to name instead of
-- adopting the whole rule the repository already had.
--
-- src/lib/blendMathValidator.ts defines the complete LOSSLESS set -- case, zero-width
-- characters (U+200B/200C/200D/FEFF, deleted outright), any run of real whitespace including
-- the non-breaking space, and periods. The guard now mirrors that set. Measured against live
-- PostgreSQL 17.6, the round-13 expression missed five real forms: 'fl<ZWSP>oz',
-- 'fl<ZWNJ>oz', 'fl<ZWJ>oz', 'fl<BOM>oz' and 'fluid<ZWSP> ounce'.
--
-- Zero-width is DELETED rather than mapped to a space, which is the detail that matters:
-- these characters separate nothing, so 'fl<ZWSP>oz' must close up to 'floz'. The
-- non-breaking space is mapped to a space instead, because it DOES separate -- 'dry<NBSP>oz'
-- has to stay two words or a legitimate dry unit would start matching. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333368-3333-3333-3333-333333333369","acres_to_treat":10}]'::jsonb,
      ('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"fl'
        || chr(8203) || 'oz","rate_per_acre":10,"rate_unit":"fl'
        || chr(8203) || 'oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]')::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T40 PASS  a dry line quoted with a ZERO-WIDTH space inside the unit is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T40 FAIL  a zero-width character hid the fluid ounce from the dry rule and the line billed with nothing proven; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T41: THE COUNTERPART that must NOT move. A dry product quoted 'dry<NBSP>oz' -- a NON-breaking
-- space -- is an ordinary dry unit and must still SAVE. This is the reason the non-breaking
-- space is collapsed to a space rather than deleted: deleting it would close 'dry<NBSP>oz' up
-- into 'dryoz', and a rule that mangles legitimate units to catch illegitimate ones blocks the
-- WHOLE job save (performSave re-sends the entire grid). Widening is not free, and this test
-- is what keeps the widening honest.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333370-3333-3333-3333-333333333371","acres_to_treat":10}]'::jsonb,
    ('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"dry'
      || chr(160) || 'oz","rate_per_acre":10,"rate_unit":"dry'
      || chr(160) || 'oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]')::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_price_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 20000 THEN RAISE NOTICE 'T41 PASS  a dry line quoted "dry<NBSP>oz" on both sides still saves; price=%', c;
  ELSE RAISE EXCEPTION 'T41 FAIL  price=%', c; END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T41 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T41 FAIL  a legitimate dry unit carrying a non-breaking space was REFUSED, so the zero-width widening is over-firing and blocks whole jobs: %', SQLERRM;
END $$;

-- T42: THE MONEY HOLE THE EQUALITY SHORTCUT LEFT OPEN (HIGH, gpt-5.6-sol 2026-08-24). Matching
-- units proved both sides were counted in the same unit and NOTHING about how many. 10 acres at
-- 2 oz/ac is 20 oz; this line claims 200. Both sides are 'oz', so the old shortcut accepted it
-- and the derived totals stored 20,000 cents instead of 2,000 -- the caller setting the money
-- directly, on the one path this whole migration exists to close. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333372-3333-3333-3333-333333333373","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":200,"unit":"oz","rate_per_acre":2,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":100}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_QUANTITY_NOT_DERIVED%' THEN
    RAISE NOTICE 'T42 PASS  an inflated quantity is refused even though both units match: %', msg;
  ELSE
    RAISE EXCEPTION 'T42 FAIL  a caller-chosen quantity rode the equality shortcut straight into the money; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T43: THE LEADING DENOMINATOR (HIGH, same gate). Every 'per' pattern required whitespace or a
-- hyphen BEFORE the word, so a rate unit that STARTS with the denominator matched none of them,
-- survived normalisation unchanged, and -- with a stock unit carrying the same text -- reached
-- the equality shortcut and billed. Such a rate names no unit to count in at all. An earlier
-- round added this shape to the PRE-APPLY query but not to the runtime guard, which is the
-- half-fix pattern this file keeps repeating. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333374-3333-3333-3333-333333333375","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":100,"unit":"per cwt","rate_per_acre":10,"rate_unit":"per cwt","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN
    RAISE NOTICE 'T43 PASS  a rate unit that is only a leading denominator is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T43 FAIL  a leading "per" denominator escaped both the denominator and unspecified-unit guards; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T44: THE HYPHENATED FLUID OUNCE (HIGH, same gate). The fold handled whitespace, periods and
-- zero-width characters but not hyphens, so a dry line quoted 'fl-oz' on both sides normalised
-- equal and billed a volume as a weight. Third spelling escape in three rounds, which is why
-- the fold now covers the whole separator class rather than the characters named so far.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333376-3333-3333-3333-333333333377","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"fl-oz","rate_per_acre":10,"rate_unit":"fl-oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T44 PASS  a dry line quoted "fl-oz" on both sides is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T44 FAIL  the hyphenated spelling escaped the dry fluid-ounce rule; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T45: UNICODE SEPARATORS -- the fourth consecutive escape, and the one that ended the
-- enumerate-the-characters approach for good. Rounds 12-15 each added the separator that had
-- just been named and were each defeated by the next one along:
--   round 12  three literal spellings      -> beaten by 'fl. oz'        (period)
--   round 13  + periods and whitespace     -> beaten by 'fl<ZWSP>oz'    (zero-width)
--   round 14  + zero-width and NBSP        -> beaten by 'fl-oz'         (ASCII hyphen)
--   round 15  + ASCII hyphen               -> beaten by 'fl<U+2010>oz'  (Unicode hyphen)
-- U+2010 and U+2011 are hyphens, U+202F is a narrow no-break space, and Unicode has plenty
-- more. Enumeration cannot converge, because whoever sends the payload picks the character
-- and the list is always written afterwards.
--
-- The rule now deletes EVERYTHING that is not a letter or a digit and requires what remains
-- to BE the word. There is no separator left to smuggle in. This test pins the three
-- characters the gate named; it is the class that matters, not the three.
DO $$
DECLARE ok boolean; msg text; sep text; seps text[] := ARRAY[chr(8208), chr(8209), chr(8239)];
        labels text[] := ARRAY['U+2010 hyphen', 'U+2011 non-breaking hyphen', 'U+202F narrow no-break space'];
        i int;
BEGIN
  FOR i IN 1 .. array_length(seps, 1) LOOP
    sep := seps[i];
    ok := false; msg := NULL;
    BEGIN
      PERFORM save_job(NULL,
        '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
        ('[{"field_id":"333333' || (78 + i)::text || '-3333-3333-3333-3333333333' || (78 + i)::text || '","acres_to_treat":10}]')::jsonb,
        ('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"fl'
          || sep || 'oz","rate_per_acre":10,"rate_unit":"fl'
          || sep || 'oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]')::jsonb,
        '11111111-1111-1111-1111-111111111111'::uuid, NULL);
    EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
    END;
    IF NOT (ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%') THEN
      RAISE EXCEPTION 'T45 FAIL  % hid the fluid ounce from the dry rule; refused=% msg=%', labels[i], ok, msg;
    END IF;
  END LOOP;
  RAISE NOTICE 'T45 PASS  all three Unicode separators (U+2010, U+2011, U+202F) are refused on a dry fluid-ounce line';
END $$;

-- T46: THE UNDERBILLING SHAPE (HIGH, gpt-5.6-sol 2026-08-24) -- the mirror image of T42. The
-- zero-quantity exit was UNCONDITIONAL, so a line with a real price, a real rate and real
-- acreage but quantity 0 saved and billed NOTHING, and the zero carried into the invoice.
-- 10 acres at 1.5 pt/ac is 15 pt; this line records none while still holding a price.
-- Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333382-3333-3333-3333-333333333383","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":0,"unit":"pt","rate_per_acre":1.5,"rate_unit":"pt/ac","cost_per_unit_cents":1250,"price_per_unit_cents":1800}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_QUANTITY_ZERO_BUT_EXPECTED%' THEN
    RAISE NOTICE 'T46 PASS  a priced line that recorded no quantity where 15 pt was expected is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T46 FAIL  a priced line billed the customer nothing for an applied product; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T47: THE EXEMPTION THAT KEEPS LIVE DATA SAVEABLE, and the reason the rule is conditioned on
-- PRICE rather than on "bills anything". This is live JOB-2026-0001's shape: quantity 0
-- against a positive rate over real acreage, carrying a COST but a price of 0. Nothing can be
-- under-charged, so by Mason's 2026-08-24 rule it is exempt and must still SAVE. Refusing it
-- would have made an existing live job unsaveable and turned the pre-apply count off zero.
-- The cost still misstates margin; that is a recorded, accepted residual, not an oversight.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":178.31}'::jsonb,
    '[{"field_id":"33333384-3333-3333-3333-333333333385","acres_to_treat":178.31}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":0,"unit":"gal","rate_per_acre":5,"rate_unit":"gal/ac","cost_per_unit_cents":4503,"price_per_unit_cents":0}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_price_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c = 0 THEN RAISE NOTICE 'T47 PASS  the live JOB-2026-0001 shape (quantity 0, cost, no price) still saves; price=%', c;
  ELSE RAISE EXCEPTION 'T47 FAIL  price=%', c; END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T47 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T47 FAIL  the zero-quantity rule over-fired and refused an existing live row shape: %', SQLERRM;
END $$;

-- T48: THE BYPASS ROUND 15 LEFT OPEN. Round 15 made the quantity provable when the units
-- matched, but only WHEN a rate and acreage existed to prove it against -- and a hand-built
-- call writes its own payload, so it could switch the whole check off by simply omitting the
-- rate and naming any quantity. A guard a caller can disable is not a guard. Priced, equal
-- units, positive quantity, no rate: must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333386-3333-3333-3333-333333333387","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":9999,"unit":"oz","rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":100}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_QUANTITY_UNVERIFIABLE%' THEN
    RAISE NOTICE 'T48 PASS  omitting the rate no longer switches the quantity check off: %', msg;
  ELSE
    RAISE EXCEPTION 'T48 FAIL  a priced line with no rate billed an unverifiable quantity; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T49: DENOMINATOR SEPARATORS (HIGH, gpt-5.6-sol 2026-08-24) -- the same enumeration defect
-- that beat the fluid-ounce rule four times, in the per-acre rule. It looked for `per`
-- bounded by whitespace or hyphens, so 'oz_per_cwt' and 'oz.per.cwt' matched nothing,
-- survived normalisation unchanged, and with a stock unit carrying the same text reached the
-- equality branch and billed a PER-HUNDREDWEIGHT rate as per-acre. Separators are now folded
-- before the denominator is classified, exactly as round 16 did for fluid ounces. Both
-- spellings must be REFUSED.
DO $$
DECLARE ok boolean; msg text; spelling text; spellings text[] := ARRAY['oz_per_cwt', 'oz.per.cwt'];
        i int;
BEGIN
  FOR i IN 1 .. array_length(spellings, 1) LOOP
    spelling := spellings[i];
    ok := false; msg := NULL;
    BEGIN
      PERFORM save_job(NULL,
        '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
        ('[{"field_id":"333333' || (88 + i)::text || '-3333-3333-3333-3333333333' || (88 + i)::text || '","acres_to_treat":10}]')::jsonb,
        ('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":100,"unit":"' || spelling
          || '","rate_per_acre":10,"rate_unit":"' || spelling
          || '","cost_per_unit_cents":100,"price_per_unit_cents":200}]')::jsonb,
        '11111111-1111-1111-1111-111111111111'::uuid, NULL);
    EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
    END;
    IF NOT (ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%') THEN
      RAISE EXCEPTION 'T49 FAIL  "%" hid a non-acre denominator and billed it as per-acre; refused=% msg=%', spelling, ok, msg;
    END IF;
  END LOOP;
  RAISE NOTICE 'T49 PASS  underscore and dot denominator spellings are refused as non-acre';
END $$;

-- T50: THE TOLERANCE WAS A PERCENTAGE (HIGH, same gate). The quantity check allowed
-- GREATEST(0.0001, |expected| * 1e-6) -- one part per million. Nothing bounds rate, acreage
-- or quantity, so that is not a small number: it is a percentage of whatever the caller
-- chose. 10,000 acres at 1,000/ac expects 10,000,000 units, and the old relative slack
-- accepted a discrepancy of 10 whole units -- billed at 100 cents each, real money waved
-- through by a rule whose stated purpose was rounding. The tolerance is now a FIXED 0.0001,
-- the storage precision and nothing else. A quantity 5 units short must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10000}'::jsonb,
      '[{"field_id":"33333392-3333-3333-3333-333333333393","acres_to_treat":10000}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":9999995,"unit":"oz","rate_per_acre":1000,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":100}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_QUANTITY_NOT_DERIVED%' THEN
    RAISE NOTICE 'T50 PASS  a 5-unit shortfall on a 10,000,000-unit line is refused; the tolerance no longer scales with the number it checks: %', msg;
  ELSE
    RAISE EXCEPTION 'T50 FAIL  a relative tolerance let a large discrepancy through; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T51: THE COUNTERPART -- a genuine 4-decimal rounding difference on that same large line
-- must still SAVE, or the tightened tolerance would refuse ordinary saves. 10,000 acres at
-- 1,000/ac is 10,000,000; a quantity differing by 0.0001 is the storage precision doing its
-- job, not a discrepancy.
DO $$
DECLARE r jsonb; c bigint;
BEGIN
  r := save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10000}'::jsonb,
    '[{"field_id":"33333394-3333-3333-3333-333333333395","acres_to_treat":10000}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":9999999.9999,"unit":"oz","rate_per_acre":1000,"rate_unit":"oz/ac","cost_per_unit_cents":0,"price_per_unit_cents":100}]'::jsonb,
    '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  SELECT total_price_cents INTO c FROM jobs WHERE id = (r->>'job_id')::uuid;
  IF c > 0 THEN RAISE NOTICE 'T51 PASS  a 0.0001 rounding difference on a 10,000,000-unit line still saves; price=%', c;
  ELSE RAISE EXCEPTION 'T51 FAIL  price=%', c; END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'T51 FAIL%' THEN RAISE; END IF;
  RAISE EXCEPTION 'T51 FAIL  the fixed tolerance is too tight and refused an ordinary rounding difference: %', SQLERRM;
END $$;

-- T52: THE PRICE SIDE WAS TESTED IN A DIFFERENT FORM FROM THE RATE SIDE (HIGH, gpt-5.6-sol
-- 2026-08-24). The rate side reached the fluid-ounce check already stripped of its
-- denominator (v_rate_base), but the stock side was passed in RAW -- so 'fl oz/ac' folded to
-- 'flozac' and missed the anchored pattern entirely. normalize_rate_unit then collapsed BOTH
-- sides to 'oz', the equality branch accepted the line, and authoritative money was derived
-- from a VOLUME price on a weight product. The asymmetry was the whole defect: two sides of
-- one comparison were being canonicalised differently.
--
-- 'fl oz/ac' still DENOTES fluid ounces; the denominator says per what, not what. Both sides
-- are now reduced to the unit they name before the concept test runs. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333396-3333-3333-3333-333333333397","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"fl oz/ac","rate_per_acre":10,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T52 PASS  a fluid-ounce STOCK unit carrying a denominator is refused on a dry product: %', msg;
  ELSE
    RAISE EXCEPTION 'T52 FAIL  a volume price unit reached the money on a dry product because only the rate side was stripped; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T53: THE AUDIT IDENTITY WAS NOT BOUND TO THE KEY (MEDIUM, same gate). p_performed_by is
-- written to jobs.created_by, and the actor check only refuses it when it is non-NULL AND
-- disagrees with the caller -- so flipping it between NULL and the authenticated actor passes
-- that check while changing what the row records. It was missing from the idempotency
-- fingerprint, so a retry on the same key with a changed p_performed_by REPLAYED the earlier
-- receipt and silently discarded the new audit identity. That is the identical silent-discard
-- shape round 9 fixed for the payload; it was missed here because this parameter is not part
-- of the payload. The second call must be REFUSED, not replayed.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  PERFORM save_job(NULL,
    '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
    '[{"field_id":"33333398-3333-3333-3333-333333333399","acres_to_treat":10}]'::jsonb,
    '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":100,"unit":"oz","rate_per_acre":10,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
    NULL, 'K-PERFORMED-BY');
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333398-3333-3333-3333-333333333399","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","quantity":100,"unit":"oz","rate_per_acre":10,"rate_unit":"oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, 'K-PERFORMED-BY');
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
    RAISE NOTICE 'T53 PASS  changing the recorded audit identity on a spent key is refused rather than silently replayed: %', msg;
  ELSE
    RAISE EXCEPTION 'T53 FAIL  a changed p_performed_by replayed the old receipt and discarded the new created_by; refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T37: THE BYPASS the round-11 half-fix left open, returned by the gate as a fresh HIGH. A DRY
-- product with rate 'fl oz/ac' against a stock Unit of 'lb'. These do NOT normalise equal, so the
-- equality shortcut -- the only thing round 10 guarded -- never runs. The line goes down the
-- CONVERSION path instead, and field_app_priced_quantity is called with the NORMALISED units, so
-- 'fl oz' has already become 'oz' before the converter sees it: handed the raw 'fl oz' its dry
-- branch sizes it NULL and refuses, handed 'oz' it sizes it 1 and converts 16:1 into pounds. A
-- VOLUME became a WEIGHT and the authoritative cost/price totals were derived from it. Must be
-- REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333362-3333-3333-3333-333333333363","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":6.25,"unit":"lb","rate_per_acre":10,"rate_unit":"fl oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T37 PASS  a dry fl-oz rate against a pound stock unit is refused before the 16:1 conversion: %', msg;
  ELSE
    RAISE EXCEPTION 'T37 FAIL  refused=% msg=%  -- a fluid ounce is still being converted into a weight', ok, msg;
  END IF;
END $$;

-- T38: the same conversion path against 'dry oz'. 'dry oz' does not normalise to 'oz' (it is not
-- in normalize_rate_unit's CASE, so it comes back as itself), so this pair also skips the
-- equality shortcut and reaches the converter, where the dry branch sizes BOTH sides 1 and the
-- fluid ounce passes through as though it were a dry ounce. Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333364-3333-3333-3333-333333333365","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000004","quantity":100,"unit":"dry oz","rate_per_acre":10,"rate_unit":"fl oz/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_UNIT_FORM_MISMATCH%' THEN
    RAISE NOTICE 'T38 PASS  a dry fl-oz rate against dry oz is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T38 FAIL  refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T35: the MIXED-format stacked denominator, and the BLOCKER the exact-SHA gpt-5.6-sol gate
-- found on 2026-08-24. 'oz per acre/ac' is oz per acre PER ACRE -- two denominators, one in each
-- spelling. The probe stripped BOTH (the slash pattern took '/ac', the word pattern then took
-- ' per acre'), so it came back a bare 'oz' with no denominator left to catch, normalised to 'oz',
-- matched a stock unit of 'oz' and BILLED. The round-8 subtractive rule only holds if exactly ONE
-- suffix comes off: "remove one, refuse what survives" is a different rule from "remove every
-- spelling, then look". Must be REFUSED.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333358-3333-3333-3333-333333333359","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity":100,"unit":"oz","rate_per_acre":10,"rate_unit":"oz per acre/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN
    RAISE NOTICE 'T35 PASS  the mixed-format stacked denominator is refused: %', msg;
  ELSE
    RAISE EXCEPTION 'T35 FAIL  refused=% msg=%  -- two per-acre suffixes are still being stripped, so a per-acre-squared rate bills', ok, msg;
  END IF;
END $$;

-- T36: the same hole one separator away -- the hyphenated word form stacked on the slash form.
DO $$
DECLARE ok boolean := false; msg text;
BEGIN
  BEGIN
    PERFORM save_job(NULL,
      '{"customer_id":"22222222-2222-2222-2222-222222222222","job_date":"2026-05-01","total_acres":10}'::jsonb,
      '[{"field_id":"33333360-3333-3333-3333-333333333361","acres_to_treat":10}]'::jsonb,
      '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000003","quantity":100,"unit":"oz","rate_per_acre":10,"rate_unit":"oz-per-acre/ac","cost_per_unit_cents":100,"price_per_unit_cents":200}]'::jsonb,
      '11111111-1111-1111-1111-111111111111'::uuid, NULL);
  EXCEPTION WHEN OTHERS THEN ok := true; msg := SQLERRM;
  END;
  IF ok AND msg LIKE 'CHEM_RATE_DENOMINATOR_NOT_ACRES%' THEN
    RAISE NOTICE 'T36 PASS  the hyphenated mixed-format stack is refused too: %', msg;
  ELSE
    RAISE EXCEPTION 'T36 FAIL  refused=% msg=%', ok, msg;
  END IF;
END $$;

-- T8: every refused save must have left NOTHING behind.
DO $$
DECLARE n_jobs int; n_chem int;
BEGIN
  SELECT count(*) INTO n_jobs FROM jobs;
  SELECT count(*) INTO n_chem FROM job_chemicals;
  IF n_jobs = 19 AND n_chem = 19 THEN RAISE NOTICE 'T8 PASS  19 jobs / 19 chemical rows -- every refused save wrote nothing; the T27 and T30 replays each added exactly one, and the false-refusal guards that MUST save are T33 (liquid fl oz/oz), T41 (dry oz carrying a non-breaking space) T47 (the live JOB-2026-0001 shape: quantity 0 with a cost but no price) and T51 (a genuine 0.0001 rounding difference on a 10,000,000-unit line, added in round 18). Every refusal test -- T34, T39, T40, T44, T45, T42, T43, T46, T48 -- writes nothing, which is why a round that adds refusals leaves this count alone and only a new SAVING test moves it';
  ELSE RAISE EXCEPTION 'T8 FAIL  jobs=% chem=% (expected 19/19)', n_jobs, n_chem; END IF;
END $$;
