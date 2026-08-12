-- Atomically assign an exact set of active customers to an active sales rep.
--
-- The Customers page previously checked profile_public_view and then issued a
-- separate PostgREST UPDATE. A concurrent rep deactivation could land between
-- those requests, and a partial UPDATE could commit before the client noticed
-- the changed-row-count mismatch. This RPC locks the target profile, performs
-- the whole assignment in one transaction, and raises on any missing/inactive
-- customer so PostgreSQL rolls the complete UPDATE back.

CREATE OR REPLACE FUNCTION public.assign_customers_sales_rep(
  p_customer_ids uuid[],
  p_sales_rep_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_customer_ids uuid[];
  v_updated_count integer;
  v_fingerprint text;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT p.role
    INTO v_actor_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_sales_rep_id IS NULL THEN
    RAISE EXCEPTION 'ASSIGNMENT_SALES_REP_INACTIVE';
  END IF;
  IF p_customer_ids IS NULL
     OR cardinality(p_customer_ids) = 0
     OR cardinality(p_customer_ids) > 1000
     OR array_position(p_customer_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSIGNMENT_CUSTOMERS_INVALID';
  END IF;

  SELECT array_agg(ids.customer_id ORDER BY ids.customer_id)
    INTO v_customer_ids
    FROM (
      SELECT DISTINCT unnest(p_customer_ids) AS customer_id
    ) ids;
  IF cardinality(v_customer_ids) IS DISTINCT FROM cardinality(p_customer_ids) THEN
    RAISE EXCEPTION 'ASSIGNMENT_CUSTOMERS_INVALID: duplicate customer ids are not allowed';
  END IF;

  v_fingerprint := md5(jsonb_build_object(
    'actor', v_actor,
    'customer_ids', to_jsonb(v_customer_ids),
    'sales_rep_id', p_sales_rep_id
  )::text);

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'assign_customers_sales_rep'
    );
    IF v_existing IS NOT NULL THEN
      IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH: this key already assigned a different customer set or sales rep';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  -- FOR SHARE conflicts with profile UPDATE/DELETE. A concurrent deactivation
  -- either completes first (and this check fails) or waits until the atomic
  -- assignment commits, so the target is active at assignment time.
  PERFORM p.id
    FROM public.profiles p
   WHERE p.id = p_sales_rep_id
     AND p.role = 'sales_rep'
     AND p.is_active = true
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSIGNMENT_SALES_REP_INACTIVE';
  END IF;

  UPDATE public.customers c
     SET assigned_sales_rep = p_sales_rep_id
   WHERE c.id = ANY(v_customer_ids)
     AND c.is_active = true;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count IS DISTINCT FROM cardinality(v_customer_ids) THEN
    RAISE EXCEPTION 'ASSIGNMENT_CUSTOMER_SET_CHANGED: % of % active customers matched; no assignments were saved',
      v_updated_count, cardinality(v_customer_ids);
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'assigned_count', v_updated_count,
    'customer_ids', to_jsonb(v_customer_ids),
    'sales_rep_id', p_sales_rep_id,
    'request_fingerprint', v_fingerprint
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'assign_customers_sales_rep',
      v_result
    );
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_customers_sales_rep(uuid[], uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_customers_sales_rep(uuid[], uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.assign_customers_sales_rep(uuid[], uuid, text) IS
  'Admin-only atomic bulk ownership assignment. Requires an active sales-rep target, an exact distinct set of active customers, and payload-bound idempotent replay.';

DO $verify$
DECLARE
  v_source text;
  v_executable_source text;
  v_security_definer boolean;
  v_config text[];
BEGIN
  IF (
    SELECT count(*)
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'assign_customers_sales_rep'
  ) <> 1 THEN
    RAISE EXCEPTION 'assign_customers_sales_rep must have exactly one overload';
  END IF;

  SELECT p.prosrc, p.prosecdef, p.proconfig
    INTO v_source, v_security_definer, v_config
    FROM pg_proc p
   WHERE p.oid = 'public.assign_customers_sales_rep(uuid[],uuid,text)'::regprocedure;

  IF v_security_definer IS DISTINCT FROM true
     OR ('search_path=public, pg_temp' = ANY (v_config)) IS NOT TRUE THEN
    RAISE EXCEPTION 'assign_customers_sales_rep security or search_path guard missing';
  END IF;

  -- pg_proc.prosrc retains comments. Remove them and normalize whitespace so
  -- explanatory prose cannot satisfy an executable-statement postflight.
  v_executable_source := regexp_replace(v_source, E'--[^\n\r]*', '', 'g');
  v_executable_source := regexp_replace(v_executable_source, '[[:space:]]+', ' ', 'g');

  IF position(
       'SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.is_active = true;'
       IN v_executable_source
     ) = 0
     OR position(
       'PERFORM p.id FROM public.profiles p WHERE p.id = p_sales_rep_id AND p.role = ''sales_rep'' AND p.is_active = true FOR SHARE;'
       IN v_executable_source
     ) = 0
     OR v_executable_source NOT LIKE '%GET DIAGNOSTICS v_updated_count = ROW_COUNT%'
     OR v_executable_source NOT LIKE '%ASSIGNMENT_CUSTOMER_SET_CHANGED%'
     OR v_executable_source NOT LIKE '%public.check_idempotency%'
     OR v_executable_source NOT LIKE '%ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH%' THEN
    RAISE EXCEPTION 'assign_customers_sales_rep atomicity or replay guard missing';
  END IF;

  -- anon inherits PUBLIC privileges, so a false anon check proves both the
  -- explicit anon revoke and the PUBLIC revoke are effective.
  IF has_function_privilege('anon', 'public.assign_customers_sales_rep(uuid[],uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.assign_customers_sales_rep(uuid[],uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assign_customers_sales_rep execute grants are unsafe';
  END IF;
END;
$verify$;
