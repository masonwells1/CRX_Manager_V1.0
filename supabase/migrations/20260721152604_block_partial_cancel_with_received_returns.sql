-- Forward-only correction: the governed cancel router already blocks full
-- cancellation when an order has a received/credited return. Apply the same
-- invariant before routing so "Cancel Remaining" cannot strand that return or
-- invalidate its credit source on a partially fulfilled order.

DO $preflight$
DECLARE
  v_private pg_proc%ROWTYPE;
  v_public pg_proc%ROWTYPE;
BEGIN
  SELECT p.* INTO v_private
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
     'public._cancel_order_idem_impl_20260721(uuid,uuid,text)'
   );
  IF NOT FOUND
     OR md5(v_private.prosrc) <> 'a2f78a473eca08d8ee932892f1c2d263'
     OR NOT v_private.prosecdef
     OR ('search_path=public, pg_temp' = ANY (
          COALESCE(v_private.proconfig, ARRAY[]::text[])
        )) IS NOT TRUE
     OR has_function_privilege('anon', v_private.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_private.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_private.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION: reviewed private cancel router drifted';
  END IF;

  SELECT p.* INTO v_public
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.cancel_order(uuid,uuid,text)');
  IF NOT FOUND
     OR md5(v_public.prosrc) <> '501473a43b505df72bc803a7354b0e60'
     OR NOT v_public.prosecdef
     OR ('search_path=public, pg_temp' = ANY (
          COALESCE(v_public.proconfig, ARRAY[]::text[])
        )) IS NOT TRUE
     OR has_function_privilege('anon', v_public.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION: required-key public cancel wrapper drifted';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._cancel_order_idem_impl_20260721(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'cancel_order_v1';
  v_existing jsonb;
  v_request jsonb;
  v_fingerprint text;
  v_result jsonb;
  v_order_status text;
  v_has_delivered_quantity boolean;
  v_has_completed_delivery boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'order_id', p_order_id
  );
  v_fingerprint := md5(v_request::text);

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'cancel_order',
      v_contract,
      v_fingerprint,
      v_request
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- complete_delivery locks its delivery before its parent order. Lock all
  -- deliveries deterministically first so cancellation follows the same order.
  PERFORM 1
    FROM public.deliveries
   WHERE order_id = p_order_id
   ORDER BY id
   FOR UPDATE;
  SELECT status INTO v_order_status
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.order_items
     WHERE order_id = p_order_id AND COALESCE(quantity_delivered, 0) > 0
  ) INTO v_has_delivered_quantity;
  SELECT EXISTS (
    SELECT 1 FROM public.deliveries
     WHERE order_id = p_order_id AND deleted_at IS NULL AND status = 'completed'
  ) INTO v_has_completed_delivery;

  IF v_has_completed_delivery AND NOT v_has_delivered_quantity THEN
    RAISE EXCEPTION 'ORDER_DELIVERY_QUANTITY_DRIFT: completed delivery exists without delivered order-item quantity';
  END IF;

  -- Both terminal routes must preserve received/credited return provenance.
  -- This check remains after exact idempotent replay so a completed request can
  -- still return its original response if later business state changes.
  IF EXISTS (
    SELECT 1 FROM public.returns r
     WHERE r.order_id = p_order_id
       AND r.deleted_at IS NULL
       AND r.status IN ('received', 'credited')
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_RECEIVED_RETURN';
  END IF;

  -- The UI and state machine expose "Cancel Remaining" only for a genuinely
  -- partially fulfilled order. Keep the mature full-cancel path canonical for
  -- confirmed orders (including governed split-draft fixtures).
  IF v_order_status = 'partially_fulfilled' THEN
    v_result := public._close_undelivered_order_remainder_20260718(
      p_order_id, v_actor
    );
  ELSE
    v_result := public._cancel_order_provenance_wrapper_20260719(
      p_order_id, v_actor, NULL
    ) || jsonb_build_object('mode', 'full_cancel', 'status', 'cancelled');
  END IF;

  -- The mature full-cancel implementation runs under a transaction-local
  -- admin override. Clear it before returning to the caller; the short-close
  -- helper already clears the same bracket internally.
  PERFORM set_config('app.admin_override', 'false', true);

  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key,
    'cancel_order',
    v_contract,
    v_fingerprint,
    v_request,
    v_result
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._cancel_order_idem_impl_20260721(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_private pg_proc%ROWTYPE;
  v_public pg_proc%ROWTYPE;
BEGIN
  SELECT p.* INTO v_private
    FROM pg_proc p
   WHERE p.oid = to_regprocedure(
     'public._cancel_order_idem_impl_20260721(uuid,uuid,text)'
   );
  IF NOT FOUND
     OR md5(v_private.prosrc) <> 'f45063a92e0f5bedcca3d05ea74f7c01'
     OR NOT v_private.prosecdef
     OR ('search_path=public, pg_temp' = ANY (
          COALESCE(v_private.proconfig, ARRAY[]::text[])
        )) IS NOT TRUE
     OR has_function_privilege('anon', v_private.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_private.oid, 'EXECUTE')
     OR has_function_privilege('service_role', v_private.oid, 'EXECUTE')
     OR strpos(v_private.prosrc, 'ORDER_HAS_RECEIVED_RETURN') = 0
     OR strpos(v_private.prosrc, 'ORDER_HAS_RECEIVED_RETURN')
        > strpos(v_private.prosrc, 'IF v_order_status = ''partially_fulfilled'' THEN') THEN
    RAISE EXCEPTION 'POSTCONDITION: private cancel return guard is not exact';
  END IF;

  SELECT p.* INTO v_public
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.cancel_order(uuid,uuid,text)');
  IF NOT FOUND
     OR md5(v_public.prosrc) <> '501473a43b505df72bc803a7354b0e60'
     OR has_function_privilege('anon', v_public.oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: public cancel wrapper changed';
  END IF;
END;
$postflight$;
