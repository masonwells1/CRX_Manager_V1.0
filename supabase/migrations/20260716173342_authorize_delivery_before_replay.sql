-- Prevent cached complete_delivery results from being returned before the
-- caller's current active role and delivery assignment are authorized.
--
-- Keep the proven implementation intact behind a non-callable internal name,
-- and expose a narrow authorization wrapper under the public RPC name. The
-- wrapper deliberately authorizes before the implementation can inspect the
-- idempotency cache.

DO $guard$
BEGIN
  IF to_regprocedure(
    'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Expected complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)';
  END IF;

  IF to_regprocedure(
    'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Internal complete_delivery implementation already exists';
  END IF;
END
$guard$;

ALTER FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
RENAME TO _complete_delivery_authorized_impl;

REVOKE EXECUTE ON FUNCTION public._complete_delivery_authorized_impl(
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
  v_actor uuid;
  v_actor_role text;
  v_delivery record;
BEGIN
  v_actor := auth.uid();
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

  RETURN public._complete_delivery_authorized_impl(
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

REVOKE EXECUTE ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
TO authenticated, service_role;

COMMENT ON FUNCTION public._complete_delivery_authorized_impl(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
) IS 'Internal delivery completion implementation. Direct execution is revoked; use public.complete_delivery so authorization runs before replay lookup.';

COMMENT ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
) IS 'Completes a delivery after authorizing the active caller before any idempotent replay is returned.';
