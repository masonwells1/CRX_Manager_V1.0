-- Close cross-order item edits, missing prebook rows, and cycle-count lost updates
-- without duplicating the large canonical implementations.

ALTER FUNCTION public.update_order_items(uuid, jsonb, uuid, text)
  RENAME TO _update_order_items_impl;
REVOKE ALL ON FUNCTION public._update_order_items_impl(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._update_order_items_impl(uuid, jsonb, uuid, text)
  TO service_role;

CREATE FUNCTION public.update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_supplied_ids integer;
  v_matching_ids integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'update_order_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  PERFORM 1 FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  SELECT count(*) INTO v_supplied_ids
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) item
  WHERE nullif(item->>'id', '') IS NOT NULL;

  SELECT count(*) INTO v_matching_ids
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) item
  JOIN public.order_items oi
    ON oi.id = (item->>'id')::uuid AND oi.order_id = p_order_id
  WHERE nullif(item->>'id', '') IS NOT NULL;

  IF v_matching_ids <> v_supplied_ids THEN
    RAISE EXCEPTION 'ORDER_ITEM_MISMATCH';
  END IF;

  -- Lock every existing line in a stable order before the implementation can
  -- compare and rewrite it.
  PERFORM 1
  FROM public.order_items oi
  JOIN jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) item
    ON nullif(item->>'id', '') IS NOT NULL
   AND oi.id = (item->>'id')::uuid
  WHERE oi.order_id = p_order_id
  ORDER BY oi.id
  FOR UPDATE OF oi;

  -- A new/swapped product must have a physical snapshot row before the
  -- implementation increments prebooked quantity and writes its ledger row.
  INSERT INTO public.inventory (
    product_id, location, quantity_available, quantity_prebooked, quantity_on_order
  )
  SELECT pending.product_id, 'Main Warehouse', 0, 0, 0
  FROM (
    SELECT DISTINCT (item->>'product_id')::uuid AS product_id
    FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) item
    WHERE nullif(item->>'product_id', '') IS NOT NULL
  ) pending
  ORDER BY pending.product_id
  ON CONFLICT (product_id, location) DO NOTHING;

  RETURN public._update_order_items_impl(
    p_order_id, p_items, v_actor, p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text)
  TO authenticated, service_role;

ALTER FUNCTION public.complete_cycle_count(uuid, uuid, text)
  RENAME TO _complete_cycle_count_impl;
ALTER FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text)
  RENAME TO _reverse_completed_cycle_count_impl;

REVOKE ALL ON FUNCTION public._complete_cycle_count_impl(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._reverse_completed_cycle_count_impl(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._complete_cycle_count_impl(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public._reverse_completed_cycle_count_impl(uuid, uuid, text) TO service_role;

CREATE FUNCTION public.complete_cycle_count(
  p_cycle_count_id uuid,
  p_completed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_completed_by IS NOT NULL AND p_completed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'complete_cycle_count');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;
  PERFORM 1 FROM public.cycle_counts WHERE id = p_cycle_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  PERFORM 1
  FROM public.inventory i
  JOIN public.cycle_count_items cci ON cci.inventory_id = i.id
  WHERE cci.cycle_count_id = p_cycle_count_id
  ORDER BY i.id
  FOR UPDATE OF i;
  PERFORM public._complete_cycle_count_impl(p_cycle_count_id, v_actor, p_idempotency_key);
END;
$function$;

CREATE FUNCTION public.reverse_completed_cycle_count(
  p_cycle_count_id uuid,
  p_reversed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_reversed_by IS NOT NULL AND p_reversed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'reverse_completed_cycle_count');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;
  PERFORM 1 FROM public.cycle_counts WHERE id = p_cycle_count_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  PERFORM 1
  FROM public.inventory i
  JOIN public.cycle_count_items cci ON cci.inventory_id = i.id
  WHERE cci.cycle_count_id = p_cycle_count_id
  ORDER BY i.id
  FOR UPDATE OF i;
  PERFORM public._reverse_completed_cycle_count_impl(p_cycle_count_id, v_actor, p_idempotency_key);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_cycle_count(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_cycle_count(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text) TO authenticated, service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'update_order_items') <> 1 THEN
    RAISE EXCEPTION 'update_order_items overload drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.update_order_items(uuid,jsonb,uuid,text)'::regprocedure
      AND prosrc LIKE '%ORDER_ITEM_MISMATCH%'
      AND prosrc LIKE '%ORDER BY pending.product_id%'
  ) THEN
    RAISE EXCEPTION 'update_order_items wrapper lost ownership or deterministic inventory ordering';
  END IF;
END $$;
