-- Terminal delivery history must remain inside its original accounting period
-- even when legacy voided rows have no completed_at value and therefore use
-- scheduled_date as their effective business date.
--
-- The prior guard watched status/completed_at only. A scheduled_date-only
-- UPDATE did not fire the trigger, so a legacy terminal row could cross a
-- closed-period boundary. Watch all three effective-date inputs and check both
-- the stored and requested dates whenever any of them changes.

CREATE OR REPLACE FUNCTION public.enforce_delivery_accounting_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_old_effective_date date;
  v_new_effective_date date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'completed' THEN
      v_new_effective_date := COALESCE(
        (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
        (now() AT TIME ZONE 'America/Chicago')::date
      );
      PERFORM public.check_period_open(v_new_effective_date);
    ELSIF NEW.status = 'voided' THEN
      v_new_effective_date := COALESCE(
        (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
        NEW.scheduled_date,
        (now() AT TIME ZONE 'America/Chicago')::date
      );
      PERFORM public.check_period_open(v_new_effective_date);
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'voided')
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
       OR OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
     ) THEN
    v_old_effective_date := COALESCE(
      (OLD.completed_at AT TIME ZONE 'America/Chicago')::date,
      OLD.scheduled_date,
      (now() AT TIME ZONE 'America/Chicago')::date
    );
    PERFORM public.check_period_open(v_old_effective_date);
  END IF;

  IF NEW.status = 'completed'
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
       OR OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
     ) THEN
    v_new_effective_date := COALESCE(
      (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
      NEW.scheduled_date,
      (now() AT TIME ZONE 'America/Chicago')::date
    );
    PERFORM public.check_period_open(v_new_effective_date);
  ELSIF NEW.status = 'voided'
        AND (
          OLD.status IS DISTINCT FROM NEW.status
          OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
          OR OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
        ) THEN
    v_new_effective_date := COALESCE(
      (NEW.completed_at AT TIME ZONE 'America/Chicago')::date,
      (OLD.completed_at AT TIME ZONE 'America/Chicago')::date,
      NEW.scheduled_date,
      (now() AT TIME ZONE 'America/Chicago')::date
    );
    PERFORM public.check_period_open(v_new_effective_date);
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_delivery_accounting_period() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_delivery_accounting_period()
  FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_delivery_accounting_period ON public.deliveries;
CREATE TRIGGER trg_enforce_delivery_accounting_period
  BEFORE INSERT OR UPDATE OF status, completed_at, scheduled_date ON public.deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_delivery_accounting_period();

DO $verify$
DECLARE
  v_trigger_count integer;
  v_trigger_definition text;
  v_config text[];
  v_body text;
  v_security_definer boolean;
BEGIN
  SELECT count(*), max(pg_get_triggerdef(oid))
    INTO v_trigger_count, v_trigger_definition
    FROM pg_trigger
   WHERE tgrelid = 'public.deliveries'::regclass
     AND tgname = 'trg_enforce_delivery_accounting_period'
     AND NOT tgisinternal
     AND tgenabled = 'O';

  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_DRIFT: expected one enabled trigger, found %',
      v_trigger_count;
  END IF;

  IF v_trigger_definition NOT LIKE '%UPDATE OF status, completed_at, scheduled_date%' THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_COLUMNS_DRIFT: %', v_trigger_definition;
  END IF;

  SELECT proconfig, prosrc, prosecdef
    INTO v_config, v_body, v_security_definer
    FROM pg_proc
   WHERE oid = 'public.enforce_delivery_accounting_period()'::regprocedure;

  IF v_config IS NULL
     OR NOT (v_config @> ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_SEARCH_PATH_DRIFT: %', v_config;
  END IF;

  IF NOT COALESCE(v_security_definer, false) THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_SECURITY_DRIFT';
  END IF;

  IF position('v_old_effective_date' IN v_body) = 0
     OR position('v_new_effective_date' IN v_body) = 0
     OR position('OLD.status IN (''completed'', ''voided'')' IN v_body) = 0
     OR position('OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date' IN v_body) = 0 THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_BODY_DRIFT';
  END IF;

  IF has_function_privilege('anon', 'public.enforce_delivery_accounting_period()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_delivery_accounting_period()', 'EXECUTE') THEN
    RAISE EXCEPTION 'DELIVERY_PERIOD_TRIGGER_GRANT_DRIFT';
  END IF;
END;
$verify$;
