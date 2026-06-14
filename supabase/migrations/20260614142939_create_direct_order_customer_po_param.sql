-- idempotency-body-check: exempt
-- ============================================================================
-- create_direct_order: add p_customer_po_number so the customer PO is set
-- INSIDE the SECURITY DEFINER RPC, not via a post-create frontend UPDATE.
-- ----------------------------------------------------------------------------
-- BUG (money-adjacent, sales_rep-only):
--   NewOrder.tsx called create_direct_order and then ran a follow-up
--     supabase.from('orders').update({ customer_po_number }).eq('id', orderId)
--   guarded by checkMutationResult(). The live orders UPDATE RLS policy
--   `orders_update` is is_admin() for BOTH USING and WITH CHECK (verified live
--   2026-06-14). So for a sales_rep the order is created successfully but that
--   follow-up UPDATE is denied by RLS -> checkMutationResult throws -> the UI
--   reports FAILURE on a real order, and the PO is silently lost and not
--   retryable (the idempotency key just replays create_direct_order, which
--   never set the PO). Mirrors the rush-order path fix; that work is file-only
--   in the sell-side-roadmap worktree, so this applies the same PATTERN.
--
-- FIX: thread the PO through the RPC. create_direct_order is SECURITY DEFINER
--   (owner = postgres), so its INSERT INTO orders may set customer_po_number
--   without being subject to the admin-only orders_update RLS. The frontend
--   drops the follow-up UPDATE and passes p_customer_po_number instead.
--
-- WHY DROP + CREATE (not a bare CREATE OR REPLACE):
--   Adding a parameter changes the function's identity signature, so a plain
--   CREATE OR REPLACE would leave the old 7-arg overload in place and create a
--   SECOND overload (PostgREST resolution ambiguity + violates the one-overload
--   rule). We DROP the old 7-arg function first, then CREATE the 8-arg one.
--   A fresh CREATE resets the ACL to the default (EXECUTE to PUBLIC), so the
--   grants are restated below EXACTLY as live and asserted in the DO block.
--   No DB object depends on the function: only transfer_job_to_invoice
--   *mentions* it in a comment; pg_depend shows zero dependents (verified live).
--
-- BASELINE (verbatim-from-live): md5(prosrc) of the live 7-arg
--   public.create_direct_order = d7ff336715075fc84426b81e772f492e
--   (single overload, prosecdef = true, search_path = public, pg_temp,
--    proacl = {postgres=X, authenticated=X, service_role=X} -- no anon/PUBLIC).
--   The body below is byte-faithful to the live function definition EXCEPT the
--   two sentinel-marked deltas (hand-written explicitly -- not cloned).
--
-- EXHAUSTIVE DELTA LIST (everything else is verbatim live):
--   DELTA-1  signature: + p_customer_po_number text DEFAULT NULL (last arg).
--   DELTA-2  INSERT INTO orders: + customer_po_number column and value
--            NULLIF(TRIM(COALESCE(p_customer_po_number, '')), '') -- the same
--            empty->NULL normalization the live body already uses for p_notes.
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_direct_order(uuid, date, text, text, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION public.create_direct_order(p_customer_id uuid, p_order_date date, p_order_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_items jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_order_id uuid;
  v_order_number text;
  v_item jsonb;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_customer record;
  v_cached_result jsonb;
  v_result jsonb;
  v_inv record;
  v_warnings text[] := '{}';
  v_qty numeric;
  v_net_position numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'create_direct_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  v_order_number := generate_order_number();

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN CONTINUE; END IF;
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      v_warnings := array_append(v_warnings,
        COALESCE(v_item->>'product_name', 'Unknown product') ||
        ': need ' || v_qty || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_warnings := array_append(v_warnings,
          COALESCE(v_item->>'product_name', 'Unknown product') ||
          ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_price := v_total_price
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'price_per_unit')::numeric, 0);
    v_total_cost := v_total_cost
      + COALESCE((v_item->>'quantity')::numeric, 0)
      * COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE
    WHEN v_total_price > 0 THEN (v_total_profit / v_total_price) * 100
    ELSE 0
  END;

  INSERT INTO orders (
    order_number, order_name, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes,
    customer_po_number  -- DELTA-2 (create_direct_order_customer_po_param)
  ) VALUES (
    v_order_number, NULLIF(TRIM(COALESCE(p_order_name, '')), ''),
    p_customer_id, 'confirmed',
    v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
    p_order_date,
    NULLIF(TRIM(COALESCE(p_notes, '')), ''),
    NULLIF(TRIM(COALESCE(p_customer_po_number, '')), '')  -- DELTA-2
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL OR COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_order_id, (v_item->>'product_id')::uuid, v_item->>'product_name',
      COALESCE((v_item->>'price_per_unit')::numeric, 0),
      COALESCE((v_item->>'unit_cost')::numeric, 0),
      (v_item->>'quantity')::numeric, v_item->>'unit_size',
      COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'price_per_unit')::numeric, 0),
      (COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
        * COALESCE((v_item->>'quantity')::numeric, 0),
      CASE WHEN COALESCE((v_item->>'price_per_unit')::numeric, 0) > 0
        THEN ((COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
              / (v_item->>'price_per_unit')::numeric) * 100
        ELSE 0
      END,
      0, (v_item->>'quantity')::numeric
    );
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + (v_item->>'quantity')::numeric,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES ((v_item->>'product_id')::uuid, 'Main Warehouse', 0, (v_item->>'quantity')::numeric, 0, v_item->>'unit_size');
    END IF;
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', (v_item->>'quantity')::numeric,
      'Main Warehouse', v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  PERFORM _insert_commissions_for_order(
    v_order_id, p_customer_id, v_total_profit,
    v_customer.default_commission_split, p_order_date
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Direct order ' || v_order_number || COALESCE(' (' || NULLIF(TRIM(COALESCE(p_order_name, '')), '') || ')', '') || ' created for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_warnings, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'created', 'order_id', v_order_id,
    'order_number', v_order_number, 'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_direct_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Grants restated EXACTLY as live (proacl pre-drop:
-- {postgres=X, authenticated=X, service_role=X} -- no anon, no PUBLIC).
-- caller-analysis: create_direct_order :: only caller is the UI rpc at src/pages/NewOrder.tsx (authenticated); this migration RE-GRANTS EXECUTE to authenticated + service_role and REVOKEs only PUBLIC + anon (which never had EXECUTE per the live ACL) -- it restates the live grants after the DROP+CREATE that adds p_customer_po_number. UI callsite unaffected (re-granted in the same migration); no cron/service caller exists.
REVOKE ALL ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) TO service_role;

-- ============================================================================
-- SELF-VERIFICATION -- raises (rolling back the migration) on any failure.
-- ============================================================================
DO $$
DECLARE
  v_count int;
  v_src text;
  v_args text;
BEGIN
  -- Exactly one overload (the DROP removed the old 7-arg version).
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname = 'create_direct_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_direct_order overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc, pg_get_function_identity_arguments(oid)
    INTO v_src, v_args FROM pg_proc
   WHERE proname = 'create_direct_order' AND pronamespace = 'public'::regnamespace;

  -- DELTA-1: the new parameter is present.
  IF v_args NOT LIKE '%p_customer_po_number text%' THEN
    RAISE EXCEPTION 'create_direct_order missing p_customer_po_number parameter (args: %)', v_args;
  END IF;

  -- DELTA-2: the body sets the column.
  IF v_src NOT LIKE '%customer_po_number%' THEN
    RAISE EXCEPTION 'create_direct_order body does not set customer_po_number';
  END IF;

  -- The role gate from 20260610142204 must survive verbatim.
  IF v_src NOT LIKE '%INSUFFICIENT_ROLE%' THEN
    RAISE EXCEPTION 'create_direct_order role gate missing after apply';
  END IF;

  -- SECDEF + search_path retained.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'create_direct_order' AND pronamespace = 'public'::regnamespace
       AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'create_direct_order must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL exactly as live: authenticated + service_role yes, anon/PUBLIC no.
  IF NOT has_function_privilege('authenticated', 'public.create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_direct_order: authenticated lost EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_direct_order: service_role lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_direct_order: anon must NOT have EXECUTE';
  END IF;
END $$;
