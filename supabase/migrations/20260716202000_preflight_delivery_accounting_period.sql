-- Reject a closed delivery business date before the legacy completion body can
-- write warning rows that the accounting-period trigger will inevitably roll
-- back. Exact committed replays remain available, but authorization still runs
-- before replay lookup and new work checks the period before any side effects.

DO $guard$
BEGIN
  IF to_regprocedure(
    'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Expected complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)';
  END IF;

  IF to_regprocedure(
    'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Delivery period-preflight implementation already exists';
  END IF;
END
$guard$;

ALTER FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
RENAME TO _complete_delivery_period_preflight_impl;

REVOKE ALL ON FUNCTION public._complete_delivery_period_preflight_impl(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamptz DEFAULT NULL::timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_delivery record;
  v_existing jsonb;
  v_effective_completion_date date;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, assigned_driver
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- Preserve committed replay even if the historical business date has since
  -- moved into a closed period. No mutation occurs on this branch.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'complete_delivery'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  PERFORM public.check_period_open(v_effective_completion_date);

  RETURN public._complete_delivery_period_preflight_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
TO authenticated, service_role;

COMMENT ON FUNCTION public._complete_delivery_period_preflight_impl(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
) IS 'Internal delivery completion wrapper. Direct execution is revoked; use public.complete_delivery so period rejection happens before legacy warning work.';
COMMENT ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
) IS 'Completes a delivery after active authorization, replay lookup, and side-effect-free accounting-period preflight.';

DO $verify$
DECLARE
  v_config text[];
BEGIN
  SELECT proconfig
    INTO v_config
    FROM pg_proc
   WHERE oid = 'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)'::regprocedure;

  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'complete_delivery must keep fixed public, pg_temp search_path';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Delivery period-preflight helper grants are too broad';
  END IF;
END
$verify$;
