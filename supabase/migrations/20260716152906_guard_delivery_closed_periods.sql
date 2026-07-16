-- Closed accounting periods are immutable across every delivery write path.
--
-- The existing complete_delivery/void_delivery implementations detect a
-- closed period, but only warn before continuing. That permits inventory,
-- order lifecycle, and draft-invoice changes dated into a frozen month.
-- Enforce the invariant at the delivery row boundary so RPCs, offline replay,
-- and any future writer all fail atomically before the status transition can
-- commit. An exception from this BEFORE trigger rolls back the entire caller.

CREATE OR REPLACE FUNCTION public.enforce_delivery_accounting_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_effective_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'completed' THEN
      v_effective_date := COALESCE(
        (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
        (now() AT TIME ZONE 'America/Chicago')::date
      );
      PERFORM public.check_period_open(v_effective_date);
    ELSIF NEW.status = 'voided' THEN
      v_effective_date := COALESCE(
        (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
        NEW.scheduled_date,
        (now() AT TIME ZONE 'America/Chicago')::date
      );
      PERFORM public.check_period_open(v_effective_date);
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.status = 'completed'
     AND (
       OLD.status IS DISTINCT FROM 'completed'
       OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
     ) THEN
    v_effective_date := COALESCE(
      (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
      (now() AT TIME ZONE 'America/Chicago')::date
    );
    PERFORM public.check_period_open(v_effective_date);
  ELSIF NEW.status = 'voided'
        AND (
          OLD.status IS DISTINCT FROM 'voided'
          OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
        ) THEN
    v_effective_date := COALESCE(
      (OLD.completed_at AT TIME ZONE 'America/Chicago')::date,
      (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
      NEW.scheduled_date,
      (now() AT TIME ZONE 'America/Chicago')::date
    );
    PERFORM public.check_period_open(v_effective_date);
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_delivery_accounting_period() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_delivery_accounting_period()
  FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_delivery_accounting_period ON public.deliveries;
CREATE TRIGGER trg_enforce_delivery_accounting_period
  BEFORE INSERT OR UPDATE OF status, completed_at ON public.deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_delivery_accounting_period();

DO $verify$
DECLARE
  v_trigger_count integer;
  v_config text[];
BEGIN
  SELECT count(*)
    INTO v_trigger_count
    FROM pg_trigger
   WHERE tgrelid = 'public.deliveries'::regclass
     AND tgname = 'trg_enforce_delivery_accounting_period'
     AND NOT tgisinternal
     AND tgenabled = 'O';

  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_DRIFT: expected one enabled trigger, found %',
      v_trigger_count;
  END IF;

  SELECT proconfig
    INTO v_config
    FROM pg_proc
   WHERE oid = 'public.enforce_delivery_accounting_period()'::regprocedure;

  IF v_config IS NULL
     OR NOT (v_config @> ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_SEARCH_PATH_DRIFT: %', v_config;
  END IF;

  IF has_function_privilege('anon', 'public.enforce_delivery_accounting_period()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_delivery_accounting_period()', 'EXECUTE') THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_GRANT_DRIFT';
  END IF;
END;
$verify$;
