-- Keep commission payout dates on the same America/Chicago business calendar
-- used by the historical report cutoff. A browser in another timezone can be
-- on tomorrow while Chicago is still on today; accepting that generated date
-- makes a just-posted settlement disappear from an as-of-today report.

SET LOCAL lock_timeout = '10s';
LOCK TABLE public.commission_payments IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_owner text;
  v_rls boolean;
  v_force_rls boolean;
  v_payment_date_shape integer;
  v_function_total integer;
  v_function_exact integer;
  v_trigger_total integer;
  v_trigger_exact integer;
BEGIN
  SELECT pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity
    INTO v_owner, v_rls, v_force_rls
    FROM pg_class c
   WHERE c.oid = to_regclass('public.commission_payments')
     AND c.relkind = 'r';

  IF NOT FOUND OR v_owner <> 'postgres' OR NOT v_rls OR v_force_rls THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_BUSINESS_DATE_PREFLIGHT: commission_payments ownership/RLS drift';
  END IF;

  SELECT count(*)
    INTO v_payment_date_shape
    FROM pg_attribute a
   WHERE a.attrelid = 'public.commission_payments'::regclass
     AND a.attname = 'payment_date'
     AND a.atttypid = 'date'::regtype
     AND a.attnotnull
     AND NOT a.attisdropped;

  IF v_payment_date_shape <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_BUSINESS_DATE_PREFLIGHT: payment_date column drift';
  END IF;

  SELECT count(*), count(*) FILTER (
         WHERE l.lanname = 'plpgsql'
             AND pg_get_function_identity_arguments(p.oid) = ''
             AND p.prorettype = 'trigger'::regtype
             AND NOT p.prosecdef
             AND p.provolatile = 'v'
             AND p.proparallel = 'u'
             AND NOT p.proisstrict
             AND NOT p.proleakproof
             AND NOT p.proretset
             AND p.procost = 100
             AND pg_get_userbyid(p.proowner) = 'postgres'
             AND p.proconfig = ARRAY['search_path=public, pg_temp']
             AND p.proacl::text = '{postgres=X/postgres}'
             AND md5(p.prosrc) = '6d7942b3ae76f627f1d7870c8755f82f'
         )
    INTO v_function_total, v_function_exact
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname = 'enforce_commission_payment_business_date';

  SELECT count(*), count(*) FILTER (
           WHERE NOT t.tgisinternal
             AND t.tgenabled = 'O'
             AND t.tgtype = 23
             AND t.tgattr::text = a.attnum::text
             AND t.tgfoid = to_regprocedure('public.enforce_commission_payment_business_date()')
             AND t.tgqual IS NULL
             AND t.tgnargs = 0
             AND octet_length(t.tgargs) = 0
         )
    INTO v_trigger_total, v_trigger_exact
    FROM pg_trigger t
    JOIN pg_attribute a
      ON a.attrelid = t.tgrelid
     AND a.attname = 'payment_date'
   WHERE t.tgrelid = 'public.commission_payments'::regclass
     AND t.tgname = 'trg_commission_payment_business_date_guard';

  IF NOT (
    (v_function_total = 0 AND v_trigger_total = 0)
    OR
    (v_function_total = 1 AND v_function_exact = 1
      AND v_trigger_total = 1 AND v_trigger_exact = 1)
  ) THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_BUSINESS_DATE_PREFLIGHT: existing function or trigger drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commission_payments p
     WHERE p.payment_date > timezone('America/Chicago', statement_timestamp())::date
  ) THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_DATE_AFTER_BUSINESS_TODAY: existing future-dated commission payment requires review';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.enforce_commission_payment_business_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_business_today date := timezone('America/Chicago', statement_timestamp())::date;
BEGIN
  IF NEW.payment_date > v_business_today THEN
    RAISE EXCEPTION USING
      ERRCODE = '22007',
      MESSAGE = format(
        'COMMISSION_PAYMENT_DATE_AFTER_BUSINESS_TODAY: payment_date %s exceeds Chicago business date %s',
        NEW.payment_date,
        v_business_today
      );
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.enforce_commission_payment_business_date() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_commission_payment_business_date()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_commission_payment_business_date()
  TO postgres;

DROP TRIGGER IF EXISTS trg_commission_payment_business_date_guard
  ON public.commission_payments;
CREATE TRIGGER trg_commission_payment_business_date_guard
  BEFORE INSERT OR UPDATE OF payment_date ON public.commission_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_commission_payment_business_date();

DO $postflight$
DECLARE
  v_function_count integer;
  v_trigger_count integer;
BEGIN
  SELECT count(*)
    INTO v_function_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.proname = 'enforce_commission_payment_business_date'
     AND pg_get_function_identity_arguments(p.oid) = ''
     AND l.lanname = 'plpgsql'
     AND p.prorettype = 'trigger'::regtype
     AND NOT p.prosecdef
     AND p.provolatile = 'v'
     AND p.proparallel = 'u'
     AND NOT p.proisstrict
     AND NOT p.proleakproof
     AND NOT p.proretset
     AND p.procost = 100
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proconfig = ARRAY['search_path=public, pg_temp']
     AND p.proacl::text = '{postgres=X/postgres}'
     AND md5(p.prosrc) = '6d7942b3ae76f627f1d7870c8755f82f';

  IF v_function_count <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_BUSINESS_DATE_POSTFLIGHT: trigger function catalog drift';
  END IF;

  SELECT count(*)
    INTO v_trigger_count
    FROM pg_trigger t
    JOIN pg_attribute a
      ON a.attrelid = t.tgrelid
     AND a.attname = 'payment_date'
   WHERE t.tgrelid = 'public.commission_payments'::regclass
     AND t.tgname = 'trg_commission_payment_business_date_guard'
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND t.tgtype = 23
     AND t.tgattr::text = a.attnum::text
     AND t.tgfoid = 'public.enforce_commission_payment_business_date()'::regprocedure
     AND t.tgqual IS NULL
     AND t.tgnargs = 0
     AND octet_length(t.tgargs) = 0;

  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_BUSINESS_DATE_POSTFLIGHT: trigger attachment drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.commission_payments p
     WHERE p.payment_date > timezone('America/Chicago', statement_timestamp())::date
  ) THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_BUSINESS_DATE_POSTFLIGHT: future-dated payment survived';
  END IF;
END;
$postflight$;
