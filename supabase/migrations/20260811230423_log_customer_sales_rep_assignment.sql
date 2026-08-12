-- Record Customer 360 ownership assignments in the user-facing activity feed.
--
-- The original atomic assignment RPC intentionally moved customer ownership
-- changes out of save_customer, but save_customer is also the path that writes
-- customer_updated activity rows. This forward-only replacement keeps every
-- existing authorization, locking, exact-set, and idempotency guard while
-- advancing the customer's normal updated_at timestamp and inserting one
-- customer-scoped activity row per successful assignment. The audit insert is
-- in the same transaction: any insert/count failure rolls the customer UPDATE
-- and idempotency receipt back together.

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
  v_audit_count integer;
  v_sales_rep_name text;
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
  -- assignment and its activity rows commit.
  SELECT COALESCE(NULLIF(p.full_name, ''), p.id::text)
    INTO v_sales_rep_name
    FROM public.profiles p
   WHERE p.id = p_sales_rep_id
     AND p.role = 'sales_rep'
     AND p.is_active = true
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASSIGNMENT_SALES_REP_INACTIVE';
  END IF;

  UPDATE public.customers c
     SET assigned_sales_rep = p_sales_rep_id,
         updated_at = now()
   WHERE c.id = ANY(v_customer_ids)
     AND c.is_active = true;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count IS DISTINCT FROM cardinality(v_customer_ids) THEN
    RAISE EXCEPTION 'ASSIGNMENT_CUSTOMER_SET_CHANGED: % of % active customers matched; no assignments were saved',
      v_updated_count, cardinality(v_customer_ids);
  END IF;

  INSERT INTO public.activity_feed (
    event_type,
    description,
    performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  )
  SELECT
    'customer_sales_rep_assigned',
    'Customer ' || c.farm_name || ' assigned to sales rep '
      || v_sales_rep_name || ' (' || p_sales_rep_id::text || ')',
    v_actor,
    'customer',
    c.id,
    c.id
  FROM public.customers c
  WHERE c.id = ANY(v_customer_ids);
  GET DIAGNOSTICS v_audit_count = ROW_COUNT;

  IF v_audit_count IS DISTINCT FROM v_updated_count THEN
    RAISE EXCEPTION 'ASSIGNMENT_AUDIT_COUNT_MISMATCH: % of % customer activity rows were written; no assignments were saved',
      v_audit_count, v_updated_count;
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
  TO authenticated, service_role;

COMMENT ON FUNCTION public.assign_customers_sales_rep(uuid[], uuid, text) IS
  'Admin-only atomic bulk ownership assignment with updated customer timestamps and customer-scoped activity rows. Requires an active sales-rep target, an exact distinct set of active customers, and payload-bound idempotent replay.';

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

  v_executable_source := regexp_replace(v_source, E'--[^\n\r]*', '', 'g');
  v_executable_source := regexp_replace(v_executable_source, '[[:space:]]+', ' ', 'g');

  IF position(
       'SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.is_active = true;'
       IN v_executable_source
     ) = 0
     OR position(
       'SELECT COALESCE(NULLIF(p.full_name, ''''), p.id::text) INTO v_sales_rep_name FROM public.profiles p WHERE p.id = p_sales_rep_id AND p.role = ''sales_rep'' AND p.is_active = true FOR SHARE;'
       IN v_executable_source
     ) = 0
     OR v_executable_source NOT LIKE '%SET assigned_sales_rep = p_sales_rep_id, updated_at = now()%'
     OR v_executable_source NOT LIKE '%GET DIAGNOSTICS v_updated_count = ROW_COUNT%'
     OR v_executable_source NOT LIKE '%ASSIGNMENT_CUSTOMER_SET_CHANGED%'
     OR v_executable_source NOT LIKE '%public.check_idempotency%'
     OR v_executable_source NOT LIKE '%ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH%'
     OR v_executable_source NOT LIKE '%INSERT INTO public.activity_feed%'
     OR v_executable_source NOT LIKE '%customer_sales_rep_assigned%'
     OR v_executable_source NOT LIKE '%GET DIAGNOSTICS v_audit_count = ROW_COUNT%'
     OR v_executable_source NOT LIKE '%ASSIGNMENT_AUDIT_COUNT_MISMATCH%' THEN
    RAISE EXCEPTION 'assign_customers_sales_rep atomicity, replay, or activity-feed guard missing';
  END IF;

  IF has_function_privilege('anon', 'public.assign_customers_sales_rep(uuid[],uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.assign_customers_sales_rep(uuid[],uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.assign_customers_sales_rep(uuid[],uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assign_customers_sales_rep execute grants are unsafe';
  END IF;
END;
$verify$;
