-- Return-credit COGS reversal. A usable returned product is restored to the
-- Main Warehouse even when its inventory row has not been created yet; the
-- credit then reverses only the cost recognized by its original sale lines.
-- Credit-memo reversals are not new below-cost sales, so their tightly scoped
-- server context bypasses sale-only guards without weakening normal writes.
-- This file must be applied transactionally; the guarded repository apply
-- path and disposable prover both wrap each migration in one transaction.

-- Freeze return reads and writes until the migration commits. ACCESS EXCLUSIVE
-- is acquired up front because removing the cutover trigger needs that mode;
-- taking it now avoids a late lock upgrade and its reader/return_items deadlock
-- cycle. The zero-credit assertion below is therefore race-free.
SET lock_timeout = '5s';
LOCK TABLE public.returns IN ACCESS EXCLUSIVE MODE;

DO $cutover_barrier$
DECLARE
  v_cutover_barrier regprocedure := to_regprocedure('public.block_return_credit_during_cogs_cutover()');
BEGIN
  IF v_cutover_barrier IS NULL THEN
    RAISE EXCEPTION 'RETURN_COGS_CUTOVER_BARRIER_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = v_cutover_barrier
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  )
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'block_return_credit_during_cogs_cutover') <> 1
     OR has_function_privilege('anon', v_cutover_barrier, 'EXECUTE')
     OR has_function_privilege('authenticated', v_cutover_barrier, 'EXECUTE')
     OR has_function_privilege('service_role', v_cutover_barrier, 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = 'public.returns'::regclass
         AND t.tgname = 'aa_crx_block_return_credit_during_cogs_cutover'
         AND NOT t.tgisinternal
         AND t.tgfoid = v_cutover_barrier
    ) THEN
    RAISE EXCEPTION 'RETURN_COGS_CUTOVER_BARRIER_DRIFTED';
  END IF;
END;
$cutover_barrier$;

DO $preflight$
DECLARE
  v_expected jsonb := jsonb_build_object(
    'void_invoice', 'c7a488d58bd876e92565bca9bd4edc90',
    'unapply_credit_memo', '286de5b0ac196331713278f335ba1b02e73e9de334cc2fb5f22e49629922b374',
    '_issue_return_credit_impl', '9c12163485bab6917cf884ed043157e34af8ba0e532a8a443081bd262626ff06',
    '_receive_return_impl_20260714', '9fc0e677df01af0afab1c4469cda14bdb4eebb9b0c55ef6f1512ef39bdb22062',
    '_enforce_below_cost_line', '42f7bcfb02fc14b82a9d994236d466130c372cd632ee63c22cda47733d3f8f51',
    'guard_terminal_order_invoice_items', '62ab7b24b32b4ebfecb6c7046d747a1875eb3bd8ab3e9b3f6e1d115e7c761a9f',
    '_allocated_delivery_cents', '1df1d230c19e5d129038b1e5dfbca30db0b369ea5a91a22f19dd98cc53129142',
    'issue_return_credit', 'b93b4948fd138e6e65031b81959c7311f2846d354af45a8a882c09f1514a6314',
    '_issue_return_credit_intent_impl_20260812', '55607c6dae0cc11f4837f67c54de88a6f4d83413cd3686e04c21bf33afa4ffa5',
    'receive_return', '80873cb93b67293a811f6be91efb224f7f4dd085fa8c4282267336be430b8b6a',
    '_receive_return_intent_impl_20260812', '9f5e2cfa95f6c0fb6ae06c3d7f0c04a31efdd8309b431f6dba5330c78aad9ded'
  );
  v_name text;
  v_hash text;
  v_trigger_hash text;
BEGIN
  SELECT encode(sha256(convert_to(pg_get_triggerdef(t.oid), 'UTF8')), 'hex') INTO v_trigger_hash
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.invoice_items'::regclass AND t.tgname = 'zz_crx_below_cost_invoice_items' AND NOT t.tgisinternal;
  FOREACH v_name IN ARRAY ARRAY[
    'void_invoice','unapply_credit_memo','_issue_return_credit_impl','_receive_return_impl_20260714',
    '_enforce_below_cost_line','guard_terminal_order_invoice_items',
    '_allocated_delivery_cents',
    'issue_return_credit','_issue_return_credit_intent_impl_20260812',
    'receive_return','_receive_return_intent_impl_20260812'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = v_name) <> 1 THEN
      RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_OVERLOAD_DRIFT:%', v_name;
    END IF;
    SELECT CASE WHEN v_name = 'void_invoice'
      THEN md5(p.prosrc)
      ELSE encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
    END INTO v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_hash IS DISTINCT FROM (v_expected ->> v_name) THEN
      RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_DRIFT:%', v_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'current_season') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.current_season()')
         AND p.proargtypes = ''::oidvector
         AND p.prorettype = 'integer'::regtype
         AND NOT p.prosecdef AND p.provolatile = 's'
         AND p.proconfig = ARRAY['search_path=public']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'void_invoice' AND p.proargtypes = '2950 25 25'::oidvector AND p.prorettype = 'void'::regtype) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'unapply_credit_memo' AND p.proargtypes = '2950 25 2950 25'::oidvector AND p.prorettype = 'jsonb'::regtype) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_issue_return_credit_impl' AND p.proargtypes = '2950 2950 25'::oidvector AND p.prorettype = 'jsonb'::regtype) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_receive_return_impl_20260714' AND p.proargtypes = '2950 2950 25'::oidvector AND p.prorettype = 'jsonb'::regtype) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_enforce_below_cost_line' AND p.proargtypes = ''::oidvector) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'guard_terminal_order_invoice_items' AND p.proargtypes = ''::oidvector) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_allocated_delivery_cents' AND p.proargtypes = '2950 1700 2950'::oidvector) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'issue_return_credit' AND p.proargtypes = '2950 2950 25'::oidvector) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_issue_return_credit_intent_impl_20260812' AND p.proargtypes = '2950 2950 25'::oidvector) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'receive_return' AND p.proargtypes = '2950 2950 25'::oidvector) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '_receive_return_intent_impl_20260812' AND p.proargtypes = '2950 2950 25'::oidvector) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.void_invoice(uuid,text,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.unapply_credit_memo(uuid,text,uuid,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._issue_return_credit_impl(uuid,uuid,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._receive_return_impl_20260714(uuid,uuid,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.issue_return_credit(uuid,uuid,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.receive_return(uuid,uuid,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._receive_return_intent_impl_20260812(uuid,uuid,text)'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._enforce_below_cost_line()'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.guard_terminal_order_invoice_items()'::regprocedure AND p.prosecdef AND p.provolatile = 'v' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._allocated_delivery_cents(uuid,numeric,uuid)'::regprocedure AND NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[] AND pg_get_userbyid(p.proowner) = 'postgres')
     OR has_function_privilege('anon', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._issue_return_credit_impl(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._issue_return_credit_impl(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public._issue_return_credit_impl(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._receive_return_impl_20260714(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._receive_return_impl_20260714(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public._receive_return_impl_20260714(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.issue_return_credit(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.issue_return_credit(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.issue_return_credit(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.receive_return(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.receive_return(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.receive_return(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._enforce_below_cost_line()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._enforce_below_cost_line()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public._enforce_below_cost_line()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_terminal_order_invoice_items()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_terminal_order_invoice_items()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_terminal_order_invoice_items()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE') IS NOT TRUE
     OR v_trigger_hash IS DISTINCT FROM 'c2ae0d583e558d9ea86f69a4870f35e324adf029798e54543fccf9a2dc0eb367' THEN
    RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_CONTRACT_DRIFT';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'batch_void_invoices') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public.batch_void_invoices(uuid[],text,uuid,text)'::regprocedure
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND position('PERFORM void_invoice(v_inv.id, p_void_reason)' IN p.prosrc) > 0
         AND position('UPDATE invoices SET' IN p.prosrc) = 0
     )
     OR has_function_privilege('anon', 'public.batch_void_invoices(uuid[],text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.batch_void_invoices(uuid[],text,uuid,text)', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.batch_void_invoices(uuid[],text,uuid,text)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_BATCH_VOID_CONTRACT_DRIFT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.return_items
    WHERE order_item_id IS NOT NULL
    GROUP BY return_id, order_item_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_DUPLICATE_RETURN_LINE'; END IF;
  IF EXISTS (SELECT 1 FROM public.returns WHERE status = 'credited') THEN
    RAISE EXCEPTION 'RETURN_COGS_PREEXISTING_CREDIT_REQUIRES_BACKFILL';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.returns r
    WHERE r.status = 'received'
      AND EXISTS (
        SELECT 1 FROM public.return_items ri
        WHERE ri.return_id = r.id AND ri.restock AND NOT ri.restocked
      )
  ) THEN
    RAISE EXCEPTION 'RETURN_COGS_RECEIVED_UNRESTOCKED_REQUIRES_REPAIR';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.inventory'::regclass
      AND c.contype = 'u'
      AND c.convalidated
      AND pg_get_constraintdef(c.oid) = 'UNIQUE (product_id, location)'
  ) THEN
    RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_INVENTORY_UPSERT_CONSTRAINT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    WHERE i.invoice_type = 'credit_memo'
      AND i.status IN ('posted','overdue','paid') AND i.deleted_at IS NULL
      AND ii.quantity < 0 AND ii.cost_cents > 0 AND ii.order_item_id IS NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_UNLINKED_COST_CREDIT';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'guard_return_credit_source_recognition',
           'guard_return_credit_lineage',
           'guard_recognized_return_credit_delete',
           '_void_invoice_return_credit_guard_impl_20260826',
           '_unapply_return_credit_guard_impl_20260826'
         )
     )
     OR EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE (t.tgrelid, t.tgname) IN (
         ('public.invoices'::regclass, 'aa_crx_guard_return_credit_source_recognition'),
         ('public.invoice_items'::regclass, 'aa_crx_guard_return_credit_lineage'),
         ('public.returns'::regclass, 'aa_crx_guard_recognized_return_credit_delete')
       )
         AND NOT t.tgisinternal
     ) THEN
    RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_SOURCE_GUARD_COLLISION';
  END IF;
  IF to_regclass('public.returns_credit_invoice_id_active_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_INDEX_COLLISION';
  END IF;
END;
$preflight$;

-- Return-credit invoice lines are accounting reversals, not prior customer
-- billing. Exclude them atomically with the first migration that creates those
-- lines so a later delivery cannot reopen or distort its billable allocation.
CREATE OR REPLACE FUNCTION public._allocated_delivery_cents(
  p_order_item_id uuid,
  p_quantity numeric,
  p_exclude_invoice_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prior_qty numeric := 0;
  v_prior_cents bigint := 0;
BEGIN
  IF p_order_item_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(ii.quantity), 0), COALESCE(SUM(ii.extended_cents), 0)
    INTO v_prior_qty, v_prior_cents
    FROM public.invoice_items ii
    JOIN public.invoices inv ON inv.id = ii.invoice_id
   WHERE ii.order_item_id = p_order_item_id
     AND inv.invoice_type <> 'credit_memo'
     AND inv.deleted_at IS NULL
     AND inv.status NOT IN ('voided', 'cancelled')
     AND (p_exclude_invoice_id IS NULL OR inv.id <> p_exclude_invoice_id);

  RETURN GREATEST(
    public._allocated_cumulative_cents(
      p_order_item_id,
      v_prior_qty + GREATEST(COALESCE(p_quantity, 0), 0)
    ) - v_prior_cents,
    0);
END;
$function$;
REVOKE ALL ON FUNCTION public._allocated_delivery_cents(uuid, numeric, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE INDEX returns_credit_invoice_id_active_idx
  ON public.returns (credit_invoice_id)
  WHERE credit_invoice_id IS NOT NULL;

-- The database already rejects duplicate payload order-item ids. Make the
-- invariant structural too, so a future direct writer cannot double-spend a
-- recognized invoice lot.
ALTER TABLE public.return_items
  ADD CONSTRAINT return_items_return_order_item_unique UNIQUE (return_id, order_item_id);

ALTER FUNCTION public._receive_return_impl_20260714(uuid, uuid, text)
  RENAME TO _receive_return_impl_before_inventory_seed_20260825;
REVOKE ALL ON FUNCTION public._receive_return_impl_before_inventory_seed_20260825(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- A received return is physically verified stock coming back into the
-- warehouse. It is not a phantom row manufactured by a delivery shortage, so
-- manufactured_at_delivery deliberately keeps its false default.
CREATE FUNCTION public._receive_return_impl_20260714(
  p_return_id uuid, p_received_by uuid, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_return record; v_item record; v_cached jsonb; v_result jsonb;
  v_restocked_ids uuid[] := ARRAY[]::uuid[];
  v_restocked_qty numeric := 0; v_restocked_count int := 0;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_received_by IS NOT NULL AND p_received_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active AND role IN ('admin','sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'receive_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;
  SELECT id, return_number, status, customer_id INTO v_return FROM public.returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND'; END IF;
  IF v_return.status <> 'approved' THEN RAISE EXCEPTION 'RETURN_NOT_APPROVED:%', v_return.status; END IF;
  FOR v_item IN
    SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition, ri.unit
    FROM public.return_items ri
    WHERE ri.return_id = p_return_id AND ri.restock AND NOT ri.restocked
    ORDER BY ri.sort_order, ri.id
  LOOP
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
    VALUES (v_item.product_id, 'Main Warehouse', v_item.quantity, 0, 0, v_item.unit)
    ON CONFLICT (product_id, location) DO UPDATE
      SET quantity_available = public.inventory.quantity_available + EXCLUDED.quantity_available,
          updated_at = now();
    INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
    VALUES (v_item.product_id, 'returned', v_item.quantity, 'Main Warehouse', v_actor,
            'Return ' || v_return.return_number || ': ' || v_item.product_name || ' (' || v_item.condition || ')');
    v_restocked_ids := array_append(v_restocked_ids, v_item.item_id);
    v_restocked_qty := v_restocked_qty + v_item.quantity;
    v_restocked_count := v_restocked_count + 1;
  END LOOP;
  PERFORM set_config('app.return_rpc', 'true', true);
  UPDATE public.returns SET status = 'received', received_by = v_actor, received_at = now(), updated_at = now() WHERE id = p_return_id;
  IF cardinality(v_restocked_ids) > 0 THEN UPDATE public.return_items SET restocked = true WHERE id = ANY(v_restocked_ids); END IF;
  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('return_received', 'Return ' || v_return.return_number || ' received - ' || v_restocked_count || ' item(s) restocked', v_actor, 'return', p_return_id, v_return.customer_id);
  v_result := jsonb_build_object('success', true, 'return_id', p_return_id, 'return_number', v_return.return_number, 'status', 'received', 'restocked_count', v_restocked_count, 'restocked_quantity', v_restocked_qty, 'skipped_count', 0);
  IF p_idempotency_key IS NOT NULL THEN PERFORM public.save_idempotency(p_idempotency_key, 'receive_return', v_result); END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public._receive_return_impl_20260714(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._receive_return_impl_20260714(uuid, uuid, text) TO service_role;

DROP TRIGGER IF EXISTS zz_crx_below_cost_invoice_items ON public.invoice_items;
CREATE TRIGGER zz_crx_below_cost_invoice_items BEFORE INSERT OR UPDATE OF product_id, order_item_id, unit_price_cents, extended_cents, cost_cents, quantity, is_application_fee ON public.invoice_items
  FOR EACH ROW WHEN (NOT (NEW.quantity < 0 AND current_setting('app.crx_return_credit_lineage', true) = '1'))
  EXECUTE FUNCTION public._enforce_below_cost_line();

-- Once an active return credit reverses a sale line, that source sale must
-- remain recognized until the credit is voided/unapplied. Otherwise the
-- positive sale COGS/revenue disappears while the negative reversal remains.
CREATE FUNCTION public.guard_return_credit_source_recognition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_leaves_recognized boolean;
  v_enters_recognized boolean := false;
  v_lock_order_item_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_leaves_recognized := true;
  ELSE
    v_leaves_recognized := NEW.deleted_at IS NOT NULL
      OR NEW.status IS NULL
      OR NEW.status NOT IN ('posted','overdue','paid');
    v_enters_recognized := OLD.invoice_type <> 'credit_memo'
      AND (OLD.status IS NULL OR OLD.status NOT IN ('posted','overdue','paid') OR OLD.deleted_at IS NOT NULL)
      AND NEW.status IN ('posted','overdue','paid')
      AND NEW.deleted_at IS NULL;
  END IF;
  IF OLD.invoice_type = 'credit_memo'
     AND OLD.status IN ('posted','overdue','paid')
     AND OLD.deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.returns r WHERE r.credit_invoice_id = OLD.id
     ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'RETURN_CREDIT_HEADER_IMMUTABLE';
    ELSIF current_setting('app.crx_return_credit_lineage', true) = '1' THEN
      NULL;
    ELSIF TG_OP = 'UPDATE'
       AND current_setting('app.crx_return_credit_void', true) = '1'
       AND NEW.status = 'voided'
       AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
       AND NEW.season IS NOT DISTINCT FROM OLD.season
       AND NEW.total_amount_cents = 0
       AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents THEN
      NULL;
    ELSIF TG_OP = 'UPDATE'
       AND current_setting('app.crx_return_credit_unapply', true) = '1'
       AND NEW.status = 'voided'
       AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
       AND NEW.season IS NOT DISTINCT FROM OLD.season
       AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
       AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents THEN
      NULL;
    ELSIF v_leaves_recognized
       OR ROW(NEW.total_amount_cents, NEW.total_cost_cents, NEW.season)
          IS DISTINCT FROM ROW(OLD.total_amount_cents, OLD.total_cost_cents, OLD.season) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_HEADER_IMMUTABLE';
    END IF;
  END IF;
  IF OLD.invoice_type <> 'credit_memo'
     AND (
       (OLD.status IN ('posted','overdue','paid') AND OLD.deleted_at IS NULL AND v_leaves_recognized)
       OR v_enters_recognized
     ) THEN
    -- Only the dangerous transition takes the shared lineage locks. Fail fast
    -- if credit issuance already owns one: the posting path holds its invoice
    -- row before this trigger, so waiting here would create a three-way cycle
    -- with delivery completion's order-item -> invoice lock order.
    FOR v_lock_order_item_id IN
      SELECT DISTINCT ii.order_item_id
      FROM public.invoice_items ii
      WHERE ii.invoice_id = OLD.id AND ii.order_item_id IS NOT NULL
      ORDER BY ii.order_item_id
    LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361)) THEN
        RAISE EXCEPTION 'RETURN_CREDIT_SOURCE_CONCURRENT';
      END IF;
    END LOOP;
    IF v_leaves_recognized AND EXISTS (
       SELECT 1
       FROM public.invoice_items source_line
       JOIN public.invoice_items credit_line
        ON credit_line.order_item_id = source_line.order_item_id
       AND credit_line.product_id = source_line.product_id
        AND credit_line.unit_size IS NOT DISTINCT FROM source_line.unit_size
        AND credit_line.quantity < 0
       JOIN public.invoices credit_invoice ON credit_invoice.id = credit_line.invoice_id
       WHERE source_line.invoice_id = OLD.id
         AND source_line.order_item_id IS NOT NULL
         AND credit_invoice.invoice_type = 'credit_memo'
         AND credit_invoice.status IN ('posted','overdue','paid')
         AND credit_invoice.deleted_at IS NULL
     ) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED';
    END IF;
    IF v_enters_recognized AND EXISTS (
       SELECT 1
       FROM public.invoice_items source_line
       WHERE source_line.invoice_id = OLD.id
         AND source_line.order_item_id IS NOT NULL
         AND source_line.quantity > 0
         AND (
           SELECT COALESCE(SUM(ri.quantity), 0)
           FROM public.returns r
           JOIN public.invoices credit_invoice ON credit_invoice.id = r.credit_invoice_id
           JOIN public.return_items ri ON ri.return_id = r.id
           WHERE credit_invoice.invoice_type = 'credit_memo'
             AND credit_invoice.status IN ('posted','overdue','paid')
             AND credit_invoice.deleted_at IS NULL
             AND ri.restock
             AND ri.restocked
             AND ri.order_item_id = source_line.order_item_id
             AND ri.product_id = source_line.product_id
             AND ri.unit IS NOT DISTINCT FROM source_line.unit_size
         ) > (
           SELECT COALESCE(SUM(existing_line.quantity), 0)
           FROM public.invoice_items existing_line
           JOIN public.invoices existing_invoice ON existing_invoice.id = existing_line.invoice_id
           WHERE existing_invoice.id <> OLD.id
             AND existing_invoice.invoice_type <> 'credit_memo'
             AND existing_invoice.status IN ('posted','overdue','paid')
             AND existing_invoice.deleted_at IS NULL
             AND existing_line.quantity > 0
             AND existing_line.order_item_id = source_line.order_item_id
             AND existing_line.product_id = source_line.product_id
             AND existing_line.unit_size IS NOT DISTINCT FROM source_line.unit_size
         )
     ) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_return_credit_source_recognition() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER aa_crx_guard_return_credit_source_recognition
  BEFORE UPDATE OF status, deleted_at, total_amount_cents, total_cost_cents, season OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_return_credit_source_recognition();

-- Keep the protected header reachable. Deleting the parent return while its
-- credit is recognized would silently switch reports from the exact header
-- reversal to per-line fallback rounding.
CREATE FUNCTION public.guard_recognized_return_credit_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF OLD.credit_invoice_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.invoices i
       WHERE i.id = OLD.credit_invoice_id
         AND i.invoice_type = 'credit_memo'
         AND i.status IN ('posted','overdue','paid')
         AND i.deleted_at IS NULL
     ) THEN
    RAISE EXCEPTION 'RETURN_CREDIT_PARENT_IMMUTABLE';
  END IF;
  RETURN OLD;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_recognized_return_credit_delete() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER aa_crx_guard_recognized_return_credit_delete
  BEFORE DELETE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.guard_recognized_return_credit_delete();

-- The normal invoice-detail action calls void_invoice for every invoice type.
-- Preserve that supported lifecycle for return-linked credit memos, but expose
-- the narrow trigger context only around the existing admin-only, atomic void
-- implementation. Its established return cleanup must complete before this
-- wrapper returns, or the whole transaction fails closed.
ALTER FUNCTION public.void_invoice(uuid, text, text)
  RENAME TO _void_invoice_return_credit_guard_impl_20260826;
REVOKE ALL ON FUNCTION public._void_invoice_return_credit_guard_impl_20260826(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.void_invoice(
  p_invoice_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_is_return_credit boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.returns r
    WHERE r.credit_invoice_id = p_invoice_id
  ) INTO v_is_return_credit;

  IF v_is_return_credit THEN
    PERFORM set_config('app.crx_return_credit_void', '1', true);
  END IF;

  PERFORM public._void_invoice_return_credit_guard_impl_20260826(
    p_invoice_id,
    p_void_reason,
    p_idempotency_key
  );

  IF v_is_return_credit THEN
    PERFORM set_config('app.crx_return_credit_void', '0', true);
    IF EXISTS (
      SELECT 1
      FROM public.returns r
      WHERE r.credit_invoice_id = p_invoice_id
    ) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_VOID_RELEASE_FAILED';
    END IF;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.void_invoice(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_invoice(uuid, text, text) TO authenticated, service_role;

ALTER FUNCTION public.unapply_credit_memo(uuid, text, uuid, text)
  RENAME TO _unapply_return_credit_guard_impl_20260826;
REVOKE ALL ON FUNCTION public._unapply_return_credit_guard_impl_20260826(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.unapply_credit_memo(
  p_credit_memo_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_is_return_credit boolean;
  v_result jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.returns r
    WHERE r.credit_invoice_id = p_credit_memo_id
  ) INTO v_is_return_credit;

  IF v_is_return_credit THEN
    PERFORM set_config('app.crx_return_credit_unapply', '1', true);
  END IF;

  v_result := public._unapply_return_credit_guard_impl_20260826(
    p_credit_memo_id,
    p_reason,
    p_performed_by,
    p_idempotency_key
  );

  IF v_is_return_credit THEN
    PERFORM set_config('app.crx_return_credit_unapply', '0', true);
    IF EXISTS (
      SELECT 1
      FROM public.returns r
      WHERE r.credit_invoice_id = p_credit_memo_id
    ) THEN
      RAISE EXCEPTION 'RETURN_CREDIT_UNAPPLY_RELEASE_FAILED';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) TO authenticated, service_role;

-- The active source and credit lines are the ledger that caps every later
-- reversal. Keep their lineage, unit, quantity, and cost immutable until the
-- credit memo is first voided/unapplied; otherwise a later return could
-- consume the same recognized cost twice.
CREATE FUNCTION public.guard_return_credit_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_type text;
  v_invoice_status text;
  v_invoice_deleted_at timestamptz;
  v_material_change boolean := TG_OP = 'DELETE';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_material_change := ROW(NEW.invoice_id, NEW.order_item_id, NEW.product_id, NEW.quantity, NEW.unit_price_cents, NEW.extended_cents, NEW.cost_cents, NEW.unit_size)
      IS DISTINCT FROM ROW(OLD.invoice_id, OLD.order_item_id, OLD.product_id, OLD.quantity, OLD.unit_price_cents, OLD.extended_cents, OLD.cost_cents, OLD.unit_size);
  END IF;
  IF NOT v_material_change THEN
    RETURN NEW;
  END IF;

  SELECT i.invoice_type, i.status, i.deleted_at
    INTO v_invoice_type, v_invoice_status, v_invoice_deleted_at
  FROM public.invoices i
  WHERE i.id = OLD.invoice_id;

  IF v_invoice_status IN ('posted','overdue','paid')
     AND v_invoice_deleted_at IS NULL THEN
    IF v_invoice_type = 'credit_memo'
       AND OLD.order_item_id IS NOT NULL
       AND OLD.quantity < 0 THEN
      RAISE EXCEPTION 'RETURN_CREDIT_LEDGER_IMMUTABLE';
    END IF;
    IF v_invoice_type <> 'credit_memo'
       AND OLD.order_item_id IS NOT NULL
       AND OLD.quantity > 0 THEN
      IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.order_item_id::text, 361)) THEN
        RAISE EXCEPTION 'RETURN_CREDIT_SOURCE_CONCURRENT';
      END IF;
      IF EXISTS (
         SELECT 1
         FROM public.invoice_items credit_line
         JOIN public.invoices credit_invoice ON credit_invoice.id = credit_line.invoice_id
         WHERE credit_line.order_item_id = OLD.order_item_id
           AND credit_line.product_id = OLD.product_id
           AND credit_line.unit_size IS NOT DISTINCT FROM OLD.unit_size
           AND credit_line.quantity < 0
           AND credit_invoice.invoice_type = 'credit_memo'
           AND credit_invoice.status IN ('posted','overdue','paid')
           AND credit_invoice.deleted_at IS NULL
       ) THEN
        RAISE EXCEPTION 'RETURN_CREDIT_LEDGER_IMMUTABLE';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_return_credit_lineage() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER aa_crx_guard_return_credit_lineage
  BEFORE UPDATE OF invoice_id, order_item_id, product_id, quantity, unit_price_cents, extended_cents, cost_cents, unit_size OR DELETE
  ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_return_credit_lineage();

ALTER FUNCTION public._issue_return_credit_impl(uuid, uuid, text)
  RENAME TO _issue_return_credit_header_only_impl_20260825;
REVOKE ALL ON FUNCTION public._issue_return_credit_header_only_impl_20260825(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public._issue_return_credit_impl(
  p_return_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_cached jsonb; v_header jsonb; v_result jsonb; v_invoice_id uuid;
  v_cogs bigint;
  v_lock_order_item_id uuid;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'RETURN_CREDIT_ISOLATION_UNSUPPORTED';
  END IF;

  -- Lock before the header-only helper changes the return or creates its
  -- credit memo. A concurrent source void/edit must therefore either commit
  -- first and be visible to the helper, or wait and be rejected after the
  -- credit lines exist. Every participant uses the same UUID order.
  FOR v_lock_order_item_id IN
    SELECT DISTINCT ri.order_item_id
    FROM public.return_items ri
    WHERE ri.return_id = p_return_id AND ri.order_item_id IS NOT NULL
    ORDER BY ri.order_item_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361));
  END LOOP;

  -- Preserve the current authorization, lifecycle, invoice-header, period and
  -- financial-audit behavior; defer caching until the cost lines are complete.
  -- This statement receives a fresh READ COMMITTED snapshot after any wait.
  v_header := public._issue_return_credit_header_only_impl_20260825(p_return_id, p_actor_id, NULL);
  v_invoice_id := (v_header ->> 'credit_invoice_id')::uuid;
  IF v_invoice_id IS NULL THEN RAISE EXCEPTION 'RETURN_CREDIT_HEADER_RESULT_INVALID'; END IF;

  -- A source unit mismatch indicates broken lineage. Do not silently turn a
  -- known sale lot into a zero-cost reversal.
  IF EXISTS (
    SELECT 1 FROM public.return_items ri
    JOIN public.invoice_items ii ON ii.order_item_id = ri.order_item_id AND ii.product_id = ri.product_id AND ii.quantity > 0
    JOIN public.invoices i ON i.id = ii.invoice_id
    WHERE ri.return_id = p_return_id AND i.invoice_type <> 'credit_memo'
      AND i.status IN ('posted','overdue','paid') AND i.deleted_at IS NULL
      AND ii.unit_size IS DISTINCT FROM ri.unit
  ) THEN RAISE EXCEPTION 'RETURN_CREDIT_UNIT_MISMATCH'; END IF;

  -- A manually created cost credit without order-item lineage cannot be
  -- allocated safely against one source lot. Fail closed instead of risking a
  -- second reversal of the same recognized cost.
  IF EXISTS (
    SELECT 1
    FROM public.return_items ri
    JOIN public.returns r ON r.id = ri.return_id
    JOIN public.invoices ci
      ON ci.customer_id = r.customer_id
     AND (ci.order_id = r.order_id OR ci.order_id IS NULL)
     AND ci.invoice_type = 'credit_memo'
     AND ci.status IN ('posted','overdue','paid')
     AND ci.deleted_at IS NULL
    JOIN public.invoice_items ii
      ON ii.invoice_id = ci.id
     AND ii.product_id = ri.product_id
     AND ii.order_item_id IS NULL
     AND ii.quantity < 0
     AND ii.cost_cents > 0
    WHERE ri.return_id = p_return_id
      AND ri.order_item_id IS NOT NULL
      AND ci.id <> v_invoice_id
  ) THEN RAISE EXCEPTION 'RETURN_CREDIT_UNLINKED_COST_LINE'; END IF;

  -- Row locks protect delivered-quantity state. The advisory loop above, not
  -- this query's sort order, is the cross-table deadlock ordering protocol.
  PERFORM 1 FROM public.order_items oi
  WHERE oi.id IN (SELECT ri.order_item_id FROM public.return_items ri WHERE ri.return_id = p_return_id AND ri.order_item_id IS NOT NULL)
  FOR UPDATE;
  PERFORM set_config('app.crx_return_credit_lineage', '1', true);

  WITH return_src AS (
    SELECT ri.id, ri.order_item_id, ri.product_id, ri.product_name, ri.quantity, ri.unit_price_cents, ri.extended_cents, ri.unit, ri.sort_order, ri.restocked
    FROM public.return_items ri WHERE ri.return_id = p_return_id
  ), source_lots AS (
    SELECT rs.*, ii.id AS source_item_id, ii.cost_cents AS line_cost_cents, ii.quantity AS posted_qty, i.invoice_date, ii.created_at
    FROM return_src rs JOIN public.invoice_items ii ON ii.order_item_id = rs.order_item_id AND ii.product_id = rs.product_id AND ii.quantity > 0 AND ii.cost_cents > 0 AND ii.unit_size IS NOT DISTINCT FROM rs.unit
    JOIN public.invoices i ON i.id = ii.invoice_id AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL AND i.status IN ('posted','overdue','paid')
  ), prior_lots AS (
    SELECT rs.id AS return_item_id, ii.cost_cents AS line_cost_cents, SUM(-ii.quantity) AS reversed_qty
    FROM return_src rs JOIN public.invoice_items ii ON ii.order_item_id = rs.order_item_id AND ii.product_id = rs.product_id AND ii.quantity < 0 AND ii.cost_cents > 0 AND ii.unit_size IS NOT DISTINCT FROM rs.unit
    JOIN public.invoices i ON i.id = ii.invoice_id AND i.invoice_type = 'credit_memo' AND i.deleted_at IS NULL AND i.status IN ('posted','overdue','paid')
    GROUP BY rs.id, ii.cost_cents
  ), available_lots AS (
    SELECT sl.*, GREATEST(sl.posted_qty - GREATEST(LEAST(COALESCE(pl.reversed_qty,0) - COALESCE(SUM(sl.posted_qty) OVER (PARTITION BY sl.id, sl.line_cost_cents ORDER BY sl.invoice_date, sl.created_at, sl.source_item_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0), sl.posted_qty),0),0) AS available_qty
    FROM source_lots sl LEFT JOIN prior_lots pl ON pl.return_item_id = sl.id AND pl.line_cost_cents = sl.line_cost_cents
  ), cost_parts AS (
    SELECT al.*, ROW_NUMBER() OVER (PARTITION BY al.id ORDER BY al.invoice_date, al.created_at, al.source_item_id, al.line_cost_cents) AS part_order,
      GREATEST(LEAST(al.quantity - COALESCE(SUM(al.available_qty) OVER (PARTITION BY al.id ORDER BY al.invoice_date, al.created_at, al.source_item_id, al.line_cost_cents ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0), al.available_qty),0) AS part_qty
    FROM available_lots al WHERE al.available_qty > 0 AND al.restocked
  ), cost_allocated_parts AS (
    SELECT cp.*,
      (ROUND(cp.line_cost_cents * (cp.posted_qty - cp.available_qty + cp.part_qty))
       - ROUND(cp.line_cost_cents * (cp.posted_qty - cp.available_qty)))::bigint AS part_cost_cents
    FROM cost_parts cp WHERE cp.part_qty > 0
  ), all_parts AS (
    SELECT id, order_item_id, product_id, product_name, quantity, unit_price_cents, extended_cents, unit, sort_order, part_order, part_qty, line_cost_cents, part_cost_cents FROM cost_allocated_parts
    UNION ALL
    SELECT rs.id, rs.order_item_id, rs.product_id, rs.product_name, rs.quantity, rs.unit_price_cents, rs.extended_cents, rs.unit, rs.sort_order, 2147483647::bigint,
      rs.quantity - COALESCE((SELECT SUM(cp.part_qty) FROM cost_allocated_parts cp WHERE cp.id = rs.id),0), 0::bigint, 0::bigint
    FROM return_src rs WHERE rs.quantity > COALESCE((SELECT SUM(cp.part_qty) FROM cost_allocated_parts cp WHERE cp.id = rs.id),0)
  ), sequenced AS (
    SELECT ap.*, SUM(ap.part_qty) OVER (PARTITION BY ap.id ORDER BY ap.part_order, ap.line_cost_cents ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_qty,
      COALESCE(SUM(ap.part_qty) OVER (PARTITION BY ap.id ORDER BY ap.part_order, ap.line_cost_cents ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior_qty
    FROM all_parts ap
  ), inserted AS (
    INSERT INTO public.invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, unit_size, sort_order)
    SELECT v_invoice_id, s.order_item_id, s.product_id, 'Return credit - ' || s.product_name, -s.part_qty, s.unit_price_cents,
      -(ROUND(s.extended_cents * s.cum_qty / NULLIF(s.quantity,0)) - ROUND(s.extended_cents * s.prior_qty / NULLIF(s.quantity,0))), s.line_cost_cents, s.unit, s.sort_order
    FROM sequenced s
    RETURNING id
  )
  SELECT COALESCE(SUM(s.part_cost_cents),0)::bigint INTO v_cogs FROM sequenced s;

  -- Cost allocation telescopes per source line, so sequential fractional
  -- returns share the exact whole-cent source cost without double-rounding.
  UPDATE public.invoices
  -- Owner decision 2026-08-26: keep prior customer year-end summaries stable
  -- by recognizing the return credit in the current crop season. A late return
  -- can therefore produce negative current-season usage instead of restating
  -- the season in which the original sale occurred.
  SET total_cost_cents = -v_cogs, season = public.current_season()
  WHERE id = v_invoice_id;
  IF EXISTS (
    SELECT 1
    FROM public.invoices i
    WHERE i.id = v_invoice_id
      AND i.total_amount_cents IS DISTINCT FROM (
        SELECT COALESCE(SUM(ii.extended_cents), 0)::bigint
        FROM public.invoice_items ii
        WHERE ii.invoice_id = v_invoice_id
      )
  ) THEN
    RAISE EXCEPTION 'RETURN_CREDIT_LINE_TOTAL_MISMATCH';
  END IF;
  PERFORM set_config('app.crx_return_credit_lineage', '0', true);
  v_result := v_header || jsonb_build_object('cogs_reversed_cents', v_cogs);
  IF p_idempotency_key IS NOT NULL THEN PERFORM public.save_idempotency(p_idempotency_key, 'issue_return_credit', v_result); END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public._issue_return_credit_impl(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._issue_return_credit_impl(uuid, uuid, text) TO service_role;

-- Credit dates can differ from original-sale dates. This is normal credit-memo
-- accounting: date-ranged reports recognize the reversal in its credit period.

DO $postflight$
DECLARE
  v_expected jsonb := jsonb_build_object(
    '_issue_return_credit_header_only_impl_20260825', '9c12163485bab6917cf884ed043157e34af8ba0e532a8a443081bd262626ff06',
    '_issue_return_credit_impl', '4724b26d13c30047b37c187b4a4d9058db2c35c531b825c8c040d90a7a3e3881',
    '_receive_return_impl_before_inventory_seed_20260825', '9fc0e677df01af0afab1c4469cda14bdb4eebb9b0c55ef6f1512ef39bdb22062',
    '_receive_return_impl_20260714', 'f8becf522d34caa804006e9372759b1088220fb1ea8c020b23ce949051a7581c',
    'issue_return_credit', 'b93b4948fd138e6e65031b81959c7311f2846d354af45a8a882c09f1514a6314',
    '_issue_return_credit_intent_impl_20260812', '55607c6dae0cc11f4837f67c54de88a6f4d83413cd3686e04c21bf33afa4ffa5',
    'receive_return', '80873cb93b67293a811f6be91efb224f7f4dd085fa8c4282267336be430b8b6a',
    '_receive_return_intent_impl_20260812', '9f5e2cfa95f6c0fb6ae06c3d7f0c04a31efdd8309b431f6dba5330c78aad9ded'
  );
  v_name text;
  v_src text;
  v_triggerdef text;
  v_source_guard_triggerdef text;
  v_parent_guard_triggerdef text;
  v_lineage_guard_triggerdef text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    '_issue_return_credit_header_only_impl_20260825',
    '_issue_return_credit_impl',
    '_receive_return_impl_before_inventory_seed_20260825',
    '_receive_return_impl_20260714',
    'issue_return_credit',
    '_issue_return_credit_intent_impl_20260812',
    'receive_return',
    '_receive_return_intent_impl_20260812'
  ] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = v_name) <> 1
       OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = v_name AND p.proargtypes = '2950 2950 25'::oidvector) <> 1 THEN
      RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_CONTRACT_DRIFT:%', v_name;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name AND p.proargtypes = '2950 2950 25'::oidvector;
    IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') <> (v_expected ->> v_name) THEN
      RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_BODY_DRIFT:%', v_name;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public._allocated_delivery_cents(uuid,numeric,uuid)');
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') IS DISTINCT FROM
       '44a739b026385996b66355ee5c4b1175dbe5260bad57a459a91e69c3873bae81'
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_allocated_delivery_cents') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public._allocated_delivery_cents(uuid,numeric,uuid)'::regprocedure
         AND NOT p.prosecdef AND p.provolatile = 's'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR has_function_privilege('anon', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._allocated_delivery_cents(uuid,numeric,uuid)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_DELIVERY_ALLOCATION_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class idx
    JOIN pg_index i ON i.indexrelid = idx.oid
    WHERE idx.oid = to_regclass('public.returns_credit_invoice_id_active_idx')
      AND i.indrelid = 'public.returns'::regclass
      AND i.indisvalid AND i.indisready
      AND i.indpred IS NOT NULL
      AND pg_get_indexdef(idx.oid) =
        'CREATE INDEX returns_credit_invoice_id_active_idx ON public.returns USING btree (credit_invoice_id) WHERE (credit_invoice_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_INDEX_DRIFT';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['_enforce_below_cost_line','guard_terminal_order_invoice_items'] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = v_name) <> 1
       OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = v_name AND p.proargtypes = ''::oidvector) <> 1 THEN
      RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_DEPENDENCY_OVERLOAD_DRIFT:%', v_name;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name AND p.proargtypes = ''::oidvector;
    IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') IS DISTINCT FROM (CASE v_name
         WHEN '_enforce_below_cost_line' THEN '42f7bcfb02fc14b82a9d994236d466130c372cd632ee63c22cda47733d3f8f51'
         ELSE '62ab7b24b32b4ebfecb6c7046d747a1875eb3bd8ab3e9b3f6e1d115e7c761a9f'
       END)
       OR NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name AND p.proargtypes = ''::oidvector
           AND p.prosecdef AND p.provolatile = 'v'
           AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
           AND pg_get_userbyid(p.proowner) = 'postgres'
       )
       OR has_function_privilege('anon', format('public.%I()', v_name), 'EXECUTE')
       OR has_function_privilege('authenticated', format('public.%I()', v_name), 'EXECUTE')
       OR (v_name = '_enforce_below_cost_line'
           AND NOT has_function_privilege('service_role', format('public.%I()', v_name), 'EXECUTE'))
       OR (v_name = 'guard_terminal_order_invoice_items'
           AND has_function_privilege('service_role', format('public.%I()', v_name), 'EXECUTE')) THEN
      RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_DEPENDENCY_DRIFT:%', v_name;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.void_invoice(uuid,text,text)');
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') IS DISTINCT FROM
       '6d7c17279c90a9d6817129ba6f43bb490523f2844657074046a9f66f019af3ec'
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'void_invoice') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public.void_invoice(uuid,text,text)'::regprocedure
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public._void_invoice_return_credit_guard_impl_20260826(uuid,text,text)'::regprocedure
         AND md5(p.prosrc) = 'c7a488d58bd876e92565bca9bd4edc90'
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR has_function_privilege('anon', 'public.void_invoice(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.void_invoice(uuid,text,text)', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.void_invoice(uuid,text,text)', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('anon', 'public._void_invoice_return_credit_guard_impl_20260826(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_invoice_return_credit_guard_impl_20260826(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._void_invoice_return_credit_guard_impl_20260826(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_VOID_CONTRACT_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.unapply_credit_memo(uuid,text,uuid,text)');
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') IS DISTINCT FROM
       'a151010fc4556ab78d9254c42f7fe3c6ac06ba6dc03c19f52c44fe882ba2b520'
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'unapply_credit_memo') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public.unapply_credit_memo(uuid,text,uuid,text)'::regprocedure
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public._unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)'::regprocedure
         AND encode(sha256(convert_to(replace(p.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
             '286de5b0ac196331713278f335ba1b02e73e9de334cc2fb5f22e49629922b374'
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR has_function_privilege('anon', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.unapply_credit_memo(uuid,text,uuid,text)', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('anon', 'public._unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_UNAPPLY_CONTRACT_DRIFT';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'batch_void_invoices') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public.batch_void_invoices(uuid[],text,uuid,text)'::regprocedure
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND position('PERFORM void_invoice(v_inv.id, p_void_reason)' IN p.prosrc) > 0
         AND position('UPDATE invoices SET' IN p.prosrc) = 0
     )
     OR has_function_privilege('anon', 'public.batch_void_invoices(uuid[],text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.batch_void_invoices(uuid[],text,uuid,text)', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.batch_void_invoices(uuid[],text,uuid,text)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_BATCH_VOID_CONTRACT_DRIFT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._issue_return_credit_impl(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._receive_return_impl_20260714(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._receive_return_impl_before_inventory_seed_20260825(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public.issue_return_credit(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public.receive_return(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public._receive_return_intent_impl_20260812(uuid,uuid,text)'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  ) OR has_function_privilege('anon', 'public._issue_return_credit_impl(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._issue_return_credit_impl(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public._receive_return_impl_20260714(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._receive_return_impl_20260714(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public._issue_return_credit_impl(uuid,uuid,text)', 'EXECUTE') IS NOT TRUE
    OR has_function_privilege('service_role', 'public._receive_return_impl_20260714(uuid,uuid,text)', 'EXECUTE') IS NOT TRUE
    OR has_function_privilege('anon', 'public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public._receive_return_impl_before_inventory_seed_20260825(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._receive_return_impl_before_inventory_seed_20260825(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public._receive_return_impl_before_inventory_seed_20260825(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.issue_return_credit(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.issue_return_credit(uuid,uuid,text)', 'EXECUTE') IS NOT TRUE
    OR has_function_privilege('service_role', 'public.issue_return_credit(uuid,uuid,text)', 'EXECUTE') IS NOT TRUE
    OR has_function_privilege('anon', 'public.receive_return(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.receive_return(uuid,uuid,text)', 'EXECUTE') IS NOT TRUE
    OR has_function_privilege('service_role', 'public.receive_return(uuid,uuid,text)', 'EXECUTE') IS NOT TRUE
    OR has_function_privilege('anon', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_SECURITY_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.guard_recognized_return_credit_delete()');
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') IS DISTINCT FROM
       '89c96dabb82f6dada53e0084d5c65e72f11ea0630b56cf6e4f7f99620be48a8d'
     OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = 'public.guard_recognized_return_credit_delete()'::regprocedure
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
      AND pg_get_userbyid(p.proowner) = 'postgres'
  )
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'guard_recognized_return_credit_delete') <> 1
     OR has_function_privilege('anon', 'public.guard_recognized_return_credit_delete()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_recognized_return_credit_delete()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_recognized_return_credit_delete()', 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1
       FROM pg_trigger t
       WHERE t.tgrelid = 'public.returns'::regclass
         AND t.tgname = 'aa_crx_guard_recognized_return_credit_delete'
         AND NOT t.tgisinternal
         AND t.tgfoid = 'public.guard_recognized_return_credit_delete()'::regprocedure
     ) THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_PARENT_GUARD_DRIFT';
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_parent_guard_triggerdef
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.returns'::regclass
    AND t.tgname = 'aa_crx_guard_recognized_return_credit_delete'
    AND NOT t.tgisinternal;
  IF encode(sha256(convert_to(v_parent_guard_triggerdef, 'UTF8')), 'hex') IS DISTINCT FROM
       '3d528e657bb97824f50145c7388f74da6da713d271268fba346e6e1a94cb84f7' THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_PARENT_GUARD_TRIGGER:%',
      encode(sha256(convert_to(v_parent_guard_triggerdef, 'UTF8')), 'hex');
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_triggerdef FROM pg_trigger t WHERE t.tgrelid = 'public.invoice_items'::regclass AND t.tgname = 'zz_crx_below_cost_invoice_items' AND NOT t.tgisinternal;
  IF v_triggerdef IS NULL
     OR encode(sha256(convert_to(v_triggerdef, 'UTF8')), 'hex') IS DISTINCT FROM
        '8db113f5da2277a791ca6f4744581faa1bc02fe532ca19fec93c8120f80c1a05' THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_TRIGGER_DRIFT';
  END IF;
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.guard_return_credit_source_recognition()');
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') IS DISTINCT FROM
         'cce665d2c4b34a2b253a9e4518599f75d489309f25cc402fe6ae59269c41442e'
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'guard_return_credit_source_recognition') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public.guard_return_credit_source_recognition()'::regprocedure
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR has_function_privilege('anon', 'public.guard_return_credit_source_recognition()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_return_credit_source_recognition()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_return_credit_source_recognition()', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_SOURCE_GUARD_BODY:%',
      encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex');
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_source_guard_triggerdef
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.invoices'::regclass
    AND t.tgname = 'aa_crx_guard_return_credit_source_recognition'
    AND NOT t.tgisinternal;
  IF encode(sha256(convert_to(v_source_guard_triggerdef, 'UTF8')), 'hex') IS DISTINCT FROM
         '0f0ad06a8e8fe0994d051fc5b6659cef04f9f16829cbf9998e8b3f1265a257cb' THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_SOURCE_GUARD_TRIGGER:%',
      encode(sha256(convert_to(v_source_guard_triggerdef, 'UTF8')), 'hex');
  END IF;
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.guard_return_credit_lineage()');
  IF encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') IS DISTINCT FROM
        '7b5ccb72380c54cd2a202f891de659bce1b916c09c76ad9884446ba1544dd89f'
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'guard_return_credit_lineage') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = 'public.guard_return_credit_lineage()'::regprocedure
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR has_function_privilege('anon', 'public.guard_return_credit_lineage()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_return_credit_lineage()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_return_credit_lineage()', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_LINEAGE_GUARD_BODY:%',
      encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex');
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_lineage_guard_triggerdef
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.invoice_items'::regclass
    AND t.tgname = 'aa_crx_guard_return_credit_lineage'
    AND NOT t.tgisinternal;
  IF encode(sha256(convert_to(v_lineage_guard_triggerdef, 'UTF8')), 'hex') IS DISTINCT FROM
       'cc146431df3ab52d734ce3f62189bbbd51e3779ce64cfa789ee829e704f9e27c' THEN
    RAISE EXCEPTION 'RETURN_COGS_POSTFLIGHT_LINEAGE_GUARD_TRIGGER:%',
      encode(sha256(convert_to(v_lineage_guard_triggerdef, 'UTF8')), 'hex');
  END IF;
END;
$postflight$;

-- Removal is deliberately last. If any statement or postflight assertion above
-- fails, the migration transaction rolls back and the persistent barrier keeps
-- return-credit issuance disabled rather than reopening the unsafe gap.
RESET lock_timeout;
DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover ON public.returns;
DROP FUNCTION public.block_return_credit_during_cogs_cutover();
