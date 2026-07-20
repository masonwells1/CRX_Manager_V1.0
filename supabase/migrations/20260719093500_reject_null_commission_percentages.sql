-- Commission percentages are money-routing inputs. The shared validator's
-- three-valued comparisons previously let a missing or JSON null percentage
-- pass because NULL is neither <= 0 nor > 100 and NULL also bypassed the total.

LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_validator_hash text;
  v_bad_count integer;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_validator_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
     'public.validate_commission_split_json(jsonb)'
   );

  IF v_validator_hash IS DISTINCT FROM 'e9c13053f1146525612c4cee82de5092' THEN
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_BASELINE_DRIFT: %', v_validator_hash;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.quotes'::regclass
       AND t.tgname = 'trg_validate_quote_commission_split'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'QUOTE_COMMISSION_TRIGGER_BASELINE_DRIFT';
  END IF;

  SELECT count(*)
    INTO v_bad_count
    FROM public.quotes q
   WHERE q.deleted_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
             THEN q.commission_split->'splits'
             ELSE '[]'::jsonb
           END
         ) split
        WHERE NOT (split ? 'percentage')
           OR split->'percentage' = 'null'::jsonb
           OR NULLIF(btrim(split->>'percentage'), '') IS NULL
     );

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION 'COMMISSION_PERCENTAGE_RECONCILIATION_REQUIRED: %', v_bad_count;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.validate_commission_split_json(p_split jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_split jsonb;
  v_recipient text;
  v_seen text[] := ARRAY[]::text[];
  v_percentage numeric;
  v_total numeric := 0;
BEGIN
  IF p_split IS NULL OR p_split = 'null'::jsonb THEN
    RETURN;
  END IF;

  IF jsonb_typeof(p_split) <> 'object'
     OR NOT (p_split ? 'splits')
     OR jsonb_typeof(p_split->'splits') <> 'array' THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: expected object with splits array';
  END IF;

  IF jsonb_array_length(p_split->'splits') = 0 THEN
    RETURN;
  END IF;

  FOR v_split IN SELECT value FROM jsonb_array_elements(p_split->'splits')
  LOOP
    v_recipient := NULLIF(btrim(v_split->>'recipient'), '');
    IF v_recipient IS NULL THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient is required';
    END IF;

    IF lower(v_recipient) = ANY(v_seen) THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: duplicate recipient %', v_recipient;
    END IF;
    v_seen := array_append(v_seen, lower(v_recipient));

    BEGIN
      v_percentage := (v_split->>'percentage')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: invalid percentage for %', v_recipient;
    END;

    IF v_percentage IS NULL OR v_percentage <= 0 OR v_percentage > 100 THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentage out of range for %', v_recipient;
    END IF;

    v_total := v_total + v_percentage;
  END LOOP;

  IF abs(v_total - 100) > 0.01 THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentages total %.2f, expected 100.00', v_total;
  END IF;
END;
$function$;

DO $postflight$
DECLARE
  v_quote record;
  v_source text;
BEGIN
  SELECT p.prosrc
    INTO v_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
     'public.validate_commission_split_json(jsonb)'
   );

  IF v_source NOT LIKE
       '%IF v_percentage IS NULL OR v_percentage <= 0 OR v_percentage > 100 THEN%'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid = to_regprocedure(
          'public.validate_commission_split_json(jsonb)'
        )
          AND p.provolatile = 'i'
          AND NOT p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public, pg_temp']
     ) THEN
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_DRIFT';
  END IF;

  FOR v_quote IN
    SELECT q.id, q.quote_number, q.commission_split
      FROM public.quotes q
     WHERE q.deleted_at IS NULL
     ORDER BY q.id
  LOOP
    BEGIN
      PERFORM public.validate_commission_split_json(v_quote.commission_split);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'QUOTE_COMMISSION_POSTFLIGHT_INVALID: quote=% number=% error=%',
        v_quote.id, v_quote.quote_number, SQLERRM;
    END;
  END LOOP;

  BEGIN
    PERFORM public.validate_commission_split_json(
      '{"splits":[{"recipient":"Postflight Missing"}]}'::jsonb
    );
    RAISE EXCEPTION 'COMMISSION_NULL_PERCENTAGE_POSTFLIGHT_FAILED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'COMMISSION_NULL_PERCENTAGE_POSTFLIGHT_FAILED' THEN
      RAISE;
    END IF;
    IF SQLERRM NOT LIKE
         'COMMISSION_SPLIT_INVALID: percentage out of range for Postflight Missing%' THEN
      RAISE EXCEPTION 'COMMISSION_NULL_PERCENTAGE_POSTFLIGHT_WRONG_ERROR: %', SQLERRM;
    END IF;
  END;
END;
$postflight$;
