-- Return internal application-service cost as text so PostgREST never converts
-- bigint cents through JavaScript's lossy number representation.
DROP FUNCTION public.admin_get_application_service_costs(uuid);

CREATE FUNCTION public.admin_get_application_service_costs(
  p_service_id uuid DEFAULT NULL
)
RETURNS TABLE (service_id uuid, cost_per_acre_cents text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: application service cost is admin-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.id, s.cost_per_acre_cents::text
  FROM application_services s
  WHERE p_service_id IS NULL OR s.id = p_service_id;
END;
$$;

ALTER FUNCTION public.admin_get_application_service_costs(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_get_application_service_costs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_application_service_costs(uuid) TO authenticated, service_role;

DO $verify$
DECLARE
  v_type oid;
  v_secdef boolean;
  v_pathpin boolean;
  v_body text;
  v_owner text;
BEGIN
  SELECT prorettype, prosecdef,
         EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=public, pg_temp'),
         prosrc,
         pg_get_userbyid(proowner)
    INTO v_type, v_secdef, v_pathpin, v_body, v_owner
  FROM pg_proc
  WHERE oid = 'public.admin_get_application_service_costs(uuid)'::regprocedure;

  IF v_type <> 'record'::regtype
     OR pg_get_function_result('public.admin_get_application_service_costs(uuid)'::regprocedure)
        <> 'TABLE(service_id uuid, cost_per_acre_cents text)' THEN
    RAISE EXCEPTION 'application-service cost getter must return exact text cents';
  END IF;
  IF NOT coalesce(v_secdef, false) OR NOT coalesce(v_pathpin, false) THEN
    RAISE EXCEPTION 'application-service cost getter lost SECURITY DEFINER or fixed search_path';
  END IF;
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'application-service cost getter owner must be postgres, found %', v_owner;
  END IF;
  IF v_body NOT LIKE '%NOT is_admin()%' OR v_body NOT LIKE '%cost_per_acre_cents::text%' THEN
    RAISE EXCEPTION 'application-service cost getter lost its admin gate or exact-text cast';
  END IF;
  IF has_function_privilege('anon', 'public.admin_get_application_service_costs(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_get_application_service_costs(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admin_get_application_service_costs(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'application-service cost getter ACL is incorrect';
  END IF;
END
$verify$;
