-- Behaviour proof for 20260820120000 (chemical-unit invariant + derived money totals).
-- Runs against the throwaway container built by
-- scripts/smoke/prove-save-job-chem-unit-invariant.mjs. Every DO block either RAISEs
-- NOTICE with a PASS line or RAISEs EXCEPTION, so psql -v ON_ERROR_STOP=1 fails the run.
--
-- T1-T3 replay the shapes of the real job_chemicals rows in production (read read-only
-- 2026-08-23). T2 and T3 assert the DERIVED totals reproduce what those jobs actually
-- store; T1 is the one live shape the migration now REFUSES, and it is the reason the
-- header carries a pre-apply data obligation. T4/T7/T9/T11-T13/T17 are the refusals.
-- T5/T10/T14-T16/T18/T19 are shapes that must still save. T6 is the stale-tab case.
-- T8 proves a refusal leaves nothing behind.

-- T1: the live JOB-2026-0002 shape -- rate 'pt/ac', unit NULL, and both a cost and a
-- price. This is THE row the pre-apply data obligation is about, and this test is what
-- makes that obligation concrete rather than a sentence in a header.
--
-- It used to assert that this shape SAVES. It no longer does: a blank unit proves nothing
-- while transfer_job_to_invoice bills the line anyway, so as of Mason's 2026-08-23
-- decision the line is REFUSED. Until that live row has its Unit filled in, applying this
-- migration makes that job unsaveable -- which is exactly why the obligation is to correct
-- the data FIRST. Note the totals it used to assert (219930 / 278578) were reproduced
-- exactly by the derivation before the refusal was added, so the arithmetic is not what
-- changed here; the policy is.
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
  IF ok AND msg LIKE 'CHEM_UNIT_UNSPECIFIED%' THEN RAISE NOTICE 'T1 PASS  the live blank-unit shape is now refused: %', msg;
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
    '[{"field_id":"3333333e-3333-3333-3333-333333333340","acres_to_treat":10}]'::jsonb,
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

-- T8: every refused save must have left NOTHING behind.
DO $$
DECLARE n_jobs int; n_chem int;
BEGIN
  SELECT count(*) INTO n_jobs FROM jobs;
  SELECT count(*) INTO n_chem FROM job_chemicals;
  IF n_jobs = 11 AND n_chem = 11 THEN RAISE NOTICE 'T8 PASS  11 jobs / 11 chemical rows -- the 11 refused saves wrote nothing';
  ELSE RAISE EXCEPTION 'T8 FAIL  jobs=% chem=% (expected 11/11)', n_jobs, n_chem; END IF;
END $$;
