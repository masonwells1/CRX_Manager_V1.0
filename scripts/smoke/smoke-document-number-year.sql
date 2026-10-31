-- Rolled-back smoke chain: quote, order and rebate-claim numbers use the
-- Chicago business year and keep every sequence digit.
--
-- Covers generate_quote_number, generate_order_number and create_rebate_claim
-- after 20261029160300_document_numbers_chicago_year.sql.
--
-- Proves:
--   * an active admin, as the app's authenticated role, gets Q-<year>-#### and
--     ORD-<year>-#### for the Chicago year, each one past the last number;
--   * a signed-in driver takes neither number (NUMBER_ROLE_REQUIRED);
--   * create_rebate_claim writes one pending claim with the Chicago year, signed
--     by the caller, and a keyed replay returns it without taking a new number;
--   * a five-digit counter value stays whole instead of being cut to four;
--   * no caller -> AUTH_REQUIRED; driver -> FORBIDDEN; bad input is refused and
--     takes no number.
--
-- The year boundary itself needs a moved clock, so it stays with
-- scripts/smoke/prove-number-generators-year-chicago.mjs. There is no claim
-- reversal RPC, so that leg does not exist.
--
-- Benign side effect that survives rollback: one quote and one order sequence
-- value each (a skipped number, as with any abandoned quote).
--
-- Always ends by raising SMOKE_PASS_ROLLBACK: nothing is ever committed.

DO $smoke$
DECLARE
  v_admin   uuid;
  v_driver  uuid;
  v_program uuid;
  v_year    int := EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int;
  v_key     text := 'smoke-doc-number-' || gen_random_uuid()::text;
  v_first   bigint; -- lowest value nextval can return; an unused sequence has not moved past last_value
  v_number  text;
  v_res     jsonb;
  v_res2    jsonb;
  v_next    int;
  v_claim_seq int; -- at least five digits, and never below a number already issued
  v_count   int;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active LIMIT 1;
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'driver' AND is_active LIMIT 1;
  IF v_admin IS NULL OR v_driver IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active admin and driver (admin %, driver %)', v_admin, v_driver;
  END IF;

  INSERT INTO public.rebate_programs (program_name, manufacturer, season, start_date, end_date)
  VALUES ('[SMOKE] document number ' || left(v_key, 24), '[SMOKE]', v_year,
          make_date(v_year, 1, 1), make_date(v_year, 12, 31))
  RETURNING id INTO v_program;

  -- Quote and order numbers, through the app's role.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SELECT last_value + is_called::int INTO v_first FROM public.quote_number_seq;
  SET LOCAL ROLE authenticated;
  v_number := public.generate_quote_number();
  RESET ROLE;
  IF v_number !~ ('^Q-' || v_year || '-[0-9]{4,}$')
     OR split_part(v_number, '-', 3)::bigint < v_first THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote number % (year %, sequence next %)', v_number, v_year, v_first;
  END IF;

  SELECT last_value + is_called::int INTO v_first FROM public.order_number_seq;
  SET LOCAL ROLE authenticated;
  v_number := public.generate_order_number();
  RESET ROLE;
  IF v_number !~ ('^ORD-' || v_year || '-[0-9]{4,}$')
     OR split_part(v_number, '-', 3)::bigint < v_first THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order number % (year %, sequence next %)', v_number, v_year, v_first;
  END IF;

  -- Rebate claim, its keyed replay, and a five-digit sequence.
  SELECT greatest(10000, max(next_value)) INTO v_claim_seq
    FROM public.rebate_claim_counters WHERE year = v_year;
  INSERT INTO public.rebate_claim_counters (year, next_value) VALUES (v_year, v_claim_seq)
  ON CONFLICT (year) DO UPDATE SET next_value = v_claim_seq;
  v_res := public.create_rebate_claim(v_program, 2, 1500, p_idempotency_key => v_key);
  IF v_res->>'claim_number' IS DISTINCT FROM format('RC-%s-%s', v_year, v_claim_seq) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rebate claim number %', v_res;
  END IF;
  SELECT count(*) INTO v_count FROM public.rebate_claims
   WHERE id = (v_res->>'claim_id')::uuid AND status = 'pending' AND created_by = v_admin
     AND claim_amount_cents = 1500 AND claim_number = v_res->>'claim_number';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: stored rebate claim did not match %', v_res;
  END IF;

  v_res2 := public.create_rebate_claim(v_program, 2, 1500, p_idempotency_key => v_key);
  SELECT next_value INTO v_next FROM public.rebate_claim_counters WHERE year = v_year;
  IF v_res2->>'claim_id' IS DISTINCT FROM v_res->>'claim_id' OR v_next <> v_claim_seq + 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay % against % left counter at %', v_res2, v_res, v_next;
  END IF;

  BEGIN
    PERFORM public.create_rebate_claim(v_program, 0, 1500);
    RAISE EXCEPTION 'SMOKE_FAIL: zero quantity was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'QUANTITY_INVALID%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.create_rebate_claim(v_program, 2, 0);
    RAISE EXCEPTION 'SMOKE_FAIL: zero claim amount was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CLAIM_AMOUNT_INVALID%' THEN RAISE; END IF;
  END;

  -- A driver takes no number of any kind.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_number := public.generate_quote_number();
    RAISE EXCEPTION 'SMOKE_FAIL: driver took quote number %', v_number;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'NUMBER_ROLE_REQUIRED%' THEN RAISE; END IF;
  END;
  BEGIN
    v_number := public.generate_order_number();
    RAISE EXCEPTION 'SMOKE_FAIL: driver took order number %', v_number;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'NUMBER_ROLE_REQUIRED%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  BEGIN
    PERFORM public.create_rebate_claim(v_program, 2, 1500);
    RAISE EXCEPTION 'SMOKE_FAIL: driver created a rebate claim';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'FORBIDDEN%' THEN RAISE; END IF;
  END;

  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.create_rebate_claim(v_program, 2, 1500);
    RAISE EXCEPTION 'SMOKE_FAIL: anonymous caller created a rebate claim';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE; END IF;
  END;

  SELECT next_value INTO v_next FROM public.rebate_claim_counters WHERE year = v_year;
  IF v_next <> v_claim_seq + 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: refused calls moved the counter to %', v_next;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
