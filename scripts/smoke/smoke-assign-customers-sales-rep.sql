-- Rollback-only full chain for assign_customers_sales_rep.
--
-- Uses real active profile/customer IDs only as FK-safe targets. Every UPDATE,
-- idempotency receipt, and lock is inside this single transaction and the final
-- SMOKE_PASS_ROLLBACK exception guarantees nothing persists.

DO $smoke$
DECLARE
  v_admin_id uuid;
  v_sales_rep_id uuid;
  v_customer_ids uuid[];
  v_original_reps uuid[];
  v_after_partial uuid;
  v_result jsonb;
  v_replay jsonb;
  v_key text := 'smoke:assign_customers_sales_rep:' || gen_random_uuid()::text;
  v_partial_key text := 'smoke:assign_customers_sales_rep:partial:' || gen_random_uuid()::text;
BEGIN
  SELECT p.id
    INTO v_admin_id
    FROM public.profiles p
   WHERE p.role = 'admin'
     AND p.is_active = true
   ORDER BY p.id
   LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile is available';
  END IF;

  SELECT p.id
    INTO v_sales_rep_id
    FROM public.profiles p
   WHERE p.role = 'sales_rep'
     AND p.is_active = true
   ORDER BY p.id
   LIMIT 1;
  IF v_sales_rep_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active sales-rep profile is available';
  END IF;

  SELECT array_agg(candidate.id ORDER BY candidate.id)
    INTO v_customer_ids
    FROM (
      SELECT c.id
        FROM public.customers c
       WHERE c.is_active = true
       ORDER BY c.id
       LIMIT 2
    ) candidate;
  IF cardinality(v_customer_ids) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active customers are required';
  END IF;

  SELECT array_agg(c.assigned_sales_rep ORDER BY c.id)
    INTO v_original_reps
    FROM public.customers c
   WHERE c.id = ANY(v_customer_ids);

  -- No authenticated actor.
  PERFORM set_config('request.jwt.claims', '{}'::text, true);
  BEGIN
    PERFORM public.assign_customers_sales_rep(
      v_customer_ids,
      v_sales_rep_id,
      'smoke:assign-customers:no-auth:' || gen_random_uuid()::text
    );
    RAISE EXCEPTION 'SMOKE_FAIL: no-auth call unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no-auth expected AUTH_REQUIRED, got %', SQLERRM;
    END IF;
  END;

  -- Authenticated sales reps cannot assign ownership.
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_sales_rep_id, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.assign_customers_sales_rep(
      v_customer_ids,
      v_sales_rep_id,
      'smoke:assign-customers:wrong-role:' || gen_random_uuid()::text
    );
    RAISE EXCEPTION 'SMOKE_FAIL: non-admin call unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: non-admin expected INSUFFICIENT_ROLE, got %', SQLERRM;
    END IF;
  END;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin_id, 'role', 'authenticated')::text,
    true
  );

  -- An admin profile is active but is not a sales-rep target. This exercises
  -- the same locked eligibility predicate without transiently deactivating a
  -- real user, which could leak through external profile-change listeners.
  BEGIN
    PERFORM public.assign_customers_sales_rep(
      v_customer_ids,
      v_admin_id,
      'smoke:assign-customers:wrong-target:' || gen_random_uuid()::text
    );
    RAISE EXCEPTION 'SMOKE_FAIL: non-sales-rep target unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ASSIGNMENT_SALES_REP_INACTIVE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong target expected ASSIGNMENT_SALES_REP_INACTIVE, got %', SQLERRM;
    END IF;
  END;

  -- One real + one nonexistent customer must roll the entire UPDATE back.
  BEGIN
    PERFORM public.assign_customers_sales_rep(
      ARRAY[v_customer_ids[1], gen_random_uuid()],
      v_sales_rep_id,
      v_partial_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: partial customer set unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ASSIGNMENT_CUSTOMER_SET_CHANGED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: partial set expected ASSIGNMENT_CUSTOMER_SET_CHANGED, got %', SQLERRM;
    END IF;
  END;

  SELECT c.assigned_sales_rep
    INTO v_after_partial
    FROM public.customers c
   WHERE c.id = v_customer_ids[1];
  IF v_after_partial IS DISTINCT FROM v_original_reps[1] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: partial assignment changed the real customer from % to %',
      v_original_reps[1], v_after_partial;
  END IF;

  -- Positive two-customer assignment and exact replay.
  v_result := public.assign_customers_sales_rep(
    v_customer_ids,
    v_sales_rep_id,
    v_key
  );
  IF v_result->>'success' IS DISTINCT FROM 'true'
     OR (v_result->>'assigned_count')::integer IS DISTINCT FROM 2
     OR (v_result->>'sales_rep_id')::uuid IS DISTINCT FROM v_sales_rep_id THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unexpected assignment result %', v_result;
  END IF;
  IF (
    SELECT count(*)
      FROM public.customers c
     WHERE c.id = ANY(v_customer_ids)
       AND c.assigned_sales_rep = v_sales_rep_id
  ) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: positive assignment did not update both customers';
  END IF;

  v_replay := public.assign_customers_sales_rep(
    ARRAY[v_customer_ids[2], v_customer_ids[1]],
    v_sales_rep_id,
    v_key
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL: exact replay changed the result: first %, replay %',
      v_result, v_replay;
  END IF;

  BEGIN
    PERFORM public.assign_customers_sales_rep(
      ARRAY[v_customer_ids[1]],
      v_sales_rep_id,
      v_key
    );
    RAISE EXCEPTION 'SMOKE_FAIL: changed-payload replay unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: changed replay expected ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH, got %', SQLERRM;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
