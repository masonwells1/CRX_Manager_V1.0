-- Preserve immutable order-line and historical-cost lineage when a draft
-- generated invoice is edited through save_invoice, then end the PR #361
-- cutover only after every dependent accounting migration has succeeded.

SET lock_timeout = '5s';
LOCK TABLE public.returns IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_cutover_barrier regprocedure := to_regprocedure('public.block_return_credit_during_cogs_cutover()');
  v_writer regprocedure := to_regprocedure('public._save_invoice_scoped_impl(jsonb,jsonb,text)');
  v_cancel_return regprocedure := to_regprocedure('public._cancel_return_intent_impl_20260812(uuid,text,uuid,text)');
BEGIN
  IF v_cutover_barrier IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'block_return_credit_during_cogs_cutover') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_cutover_barrier
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
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

  IF v_writer IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_save_invoice_scoped_impl') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_save_invoice_lineage_unaware_impl_20260827') <> 0
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_writer
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         -- Fresh read-only production fingerprint, 2026-08-27. This is the
         -- exact private writer body the wrapper below delegates to.
         AND md5(p.prosrc) = '45e63ffc8e821467bcca056cad535163'
     )
     OR has_function_privilege('anon', v_writer, 'EXECUTE')
     OR has_function_privilege('authenticated', v_writer, 'EXECUTE')
     OR has_function_privilege('service_role', v_writer, 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_INVOICE_WRITER_PREFLIGHT_DRIFT:md5=%,owner=%,config=%,anon=%,authenticated=%,service_role=%',
      (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_writer),
      (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = v_writer),
      (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_writer),
      has_function_privilege('anon', v_writer, 'EXECUTE'),
      has_function_privilege('authenticated', v_writer, 'EXECUTE'),
      has_function_privilege('service_role', v_writer, 'EXECUTE');
  END IF;

  IF v_cancel_return IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_cancel_return_intent_impl_20260812') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_cancel_return
         AND p.prorettype = 'jsonb'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
         -- The intent-binding migration renamed the then-public implementation
         -- byte-for-byte. Pin that exact live body before correcting it.
         AND md5(p.prosrc) = '3af6073d9e608274dba2b183d02c918b'
     )
     OR has_function_privilege('anon', v_cancel_return, 'EXECUTE')
     OR has_function_privilege('authenticated', v_cancel_return, 'EXECUTE')
     OR has_function_privilege('service_role', v_cancel_return, 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1
       FROM pg_attribute a
       WHERE a.attrelid = 'public.return_items'::regclass
         AND a.attname = 'restocked_quantity'
         AND a.atttypid = 'numeric'::regtype
         AND a.attnum > 0
         AND NOT a.attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
       WHERE c.conrelid = 'public.return_items'::regclass
         AND c.conname = 'return_items_restocked_quantity_positive_chk'
         AND c.convalidated
     ) THEN
    RAISE EXCEPTION 'RETURN_COGS_CANCEL_RETURN_PREFLIGHT_DRIFT';
  END IF;
END;
$preflight$;

-- The source/customer quantity and the quantity added to inventory are not
-- always the same unit. Reverse the exact persisted inventory delta and fail
-- closed if an older received row has no trustworthy delta or if its stock has
-- already been consumed.
CREATE OR REPLACE FUNCTION public._cancel_return_intent_impl_20260812(
  p_return_id uuid,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_return record;
  v_item record;
  v_cached jsonb;
  v_result jsonb;
  v_reversed_ids uuid[] := ARRAY[]::uuid[];
  v_reversed_qty numeric := 0;
  v_reversed_count integer := 0;
  v_was_received boolean;
  v_actor uuid := auth.uid();
  v_product_ids uuid[];
  v_invalid_item_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to cancel a return';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'cancel_return');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT id, return_number, status, customer_id
    INTO v_return
  FROM public.returns
  WHERE id = p_return_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;
  IF v_return.status NOT IN ('requested', 'approved', 'received') THEN
    RAISE EXCEPTION 'Cannot cancel return in status "%" - only requested/approved/received returns can be cancelled', v_return.status;
  END IF;

  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
  FROM public.return_items ri
  WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);

  v_was_received := (v_return.status = 'received');
  IF v_was_received THEN
    SELECT ri.id
      INTO v_invalid_item_id
    FROM public.return_items ri
    WHERE ri.return_id = p_return_id
      AND ri.restocked = true
      AND (ri.restocked_quantity IS NULL OR ri.restocked_quantity <= 0)
    ORDER BY ri.sort_order, ri.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'RETURN_RESTOCKED_QUANTITY_MISSING:%', v_invalid_item_id;
    END IF;

    FOR v_item IN
      SELECT ri.product_id,
             min(ri.product_name) AS product_name,
             array_agg(ri.id ORDER BY ri.sort_order, ri.id) AS item_ids,
             count(*)::integer AS item_count,
             sum(ri.restocked_quantity) AS restocked_quantity,
             inv.id AS inv_id,
             inv.location AS inv_location,
             inv.quantity_available
      FROM public.return_items ri
      LEFT JOIN LATERAL (
        SELECT i.id, i.location, i.quantity_available
        FROM public.inventory i
        WHERE i.product_id = ri.product_id
          AND i.location = 'Main Warehouse'
        LIMIT 1
        FOR UPDATE
      ) inv ON true
      WHERE ri.return_id = p_return_id
        AND ri.restocked = true
      GROUP BY ri.product_id, inv.id, inv.location, inv.quantity_available
      ORDER BY ri.product_id
    LOOP
      IF v_item.inv_id IS NULL THEN
        RAISE EXCEPTION 'RETURN_RESTOCK_INVENTORY_MISSING:product=% items=%',
          v_item.product_id, v_item.item_ids;
      END IF;
      IF v_item.quantity_available < v_item.restocked_quantity THEN
        RAISE EXCEPTION 'RETURN_RESTOCK_INVENTORY_INSUFFICIENT:product=% items=% available=% required=%',
          v_item.product_id, v_item.item_ids,
          v_item.quantity_available, v_item.restocked_quantity;
      END IF;

      UPDATE public.inventory
         SET quantity_available = quantity_available - v_item.restocked_quantity,
             updated_at = now()
       WHERE id = v_item.inv_id;
      INSERT INTO public.inventory_transactions (
        product_id, transaction_type, quantity, to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'returned', -v_item.restocked_quantity,
        v_item.inv_location, v_actor,
        'Cancel of return ' || v_return.return_number || ': ' ||
          v_item.product_name || ' (' || v_item.item_count ||
          ' line(s)) - exact restock reversed: ' || p_reason
      );
      v_reversed_ids := v_reversed_ids || v_item.item_ids;
      v_reversed_qty := v_reversed_qty + v_item.restocked_quantity;
      v_reversed_count := v_reversed_count + v_item.item_count;
    END LOOP;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.returns
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = v_actor,
         cancellation_reason = p_reason,
         updated_at = now()
   WHERE id = p_return_id;
  PERFORM set_config('app.admin_override', 'false', true);

  IF cardinality(v_reversed_ids) > 0 THEN
    UPDATE public.return_items
       SET restocked = false,
           restocked_quantity = NULL
     WHERE id = ANY(v_reversed_ids);
  END IF;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'return_cancelled',
    'Return ' || v_return.return_number || ' cancelled' ||
      CASE WHEN v_was_received
        THEN ' - ' || v_reversed_count || ' item(s) exact restock reversed'
        ELSE ''
      END || ': ' || p_reason,
    v_actor, 'return', p_return_id, v_return.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return.return_number,
    'status', 'cancelled',
    'was_received', v_was_received,
    'reversed_count', v_reversed_count,
    'reversed_quantity', v_reversed_qty,
    'skipped_count', 0
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'cancel_return', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._cancel_return_intent_impl_20260812(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._cancel_return_intent_impl_20260812(uuid, text, uuid, text)
  TO postgres;

ALTER FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)
  RENAME TO _save_invoice_lineage_unaware_impl_20260827;
REVOKE ALL ON FUNCTION public._save_invoice_lineage_unaware_impl_20260827(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._save_invoice_scoped_impl(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_invoice_status text;
  v_cached jsonb;
  v_forward_items jsonb := '[]'::jsonb;
  v_lineage jsonb := '[]'::jsonb;
  v_result uuid;
  v_restored integer := 0;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_cached IS NOT NULL THEN
      RETURN (v_cached->>'invoice_id')::uuid;
    END IF;
  END IF;

  IF jsonb_typeof(COALESCE(p_items, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'INVOICE_ITEMS_MUST_BE_ARRAY';
  END IF;

  SELECT COALESCE(
           jsonb_agg(incoming.item || jsonb_build_object('sort_order', incoming.ordinality - 1)
                     ORDER BY incoming.ordinality),
           '[]'::jsonb
         )
    INTO v_forward_items
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS incoming(item, ordinality);

  IF v_invoice_id IS NOT NULL THEN
    SELECT i.status
      INTO v_invoice_status
    FROM public.invoices i
    WHERE i.id = v_invoice_id
    FOR UPDATE;
  END IF;

  IF v_invoice_status IN ('draft', 'unposted') THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_forward_items) AS incoming(item)
      WHERE NULLIF(incoming.item->>'id', '') IS NOT NULL
      GROUP BY incoming.item->>'id'
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINE_ID_DUPLICATE';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_forward_items) AS incoming(item)
      WHERE NULLIF(incoming.item->>'id', '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.invoice_items ii
          WHERE ii.id = (incoming.item->>'id')::uuid
            AND ii.invoice_id = v_invoice_id
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINE_ID_INVALID';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND ii.order_item_id IS NOT NULL
        AND ii.quantity > 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_forward_items) AS incoming(item)
          WHERE incoming.item->>'id' = ii.id::text
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_LINE_REQUIRED: void and reissue instead of deleting an order-linked line';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.invoice_items ii
      JOIN jsonb_array_elements(v_forward_items) AS incoming(item)
        ON incoming.item->>'id' = ii.id::text
      WHERE ii.invoice_id = v_invoice_id
        AND ii.order_item_id IS NOT NULL
        AND ii.quantity > 0
        AND (
          (incoming.item->>'product_id')::uuid IS DISTINCT FROM ii.product_id
          OR incoming.item->>'unit_size' IS DISTINCT FROM ii.unit_size
          OR (incoming.item->>'order_item_id')::uuid IS DISTINCT FROM ii.order_item_id
        )
    ) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_IDENTITY_IMMUTABLE: void and reissue to change product, unit, or order line';
    END IF;

    SELECT COALESCE(
             jsonb_agg(jsonb_build_object(
               'sort_order', incoming.ordinality - 1,
               'source_item_id', ii.id,
               'order_item_id', ii.order_item_id,
               'product_id', ii.product_id,
               'unit_size', ii.unit_size,
               'cost_cents', ii.cost_cents,
               'created_at', ii.created_at,
               'tote_number', ii.tote_number,
               'vendor', ii.vendor,
               'warehouse', ii.warehouse
             ) ORDER BY incoming.ordinality),
             '[]'::jsonb
           )
      INTO v_lineage
    FROM jsonb_array_elements(v_forward_items) WITH ORDINALITY AS incoming(item, ordinality)
    JOIN public.invoice_items ii
      ON ii.id = NULLIF(incoming.item->>'id', '')::uuid
     AND ii.invoice_id = v_invoice_id
     AND ii.order_item_id IS NOT NULL
     AND ii.quantity > 0;
  END IF;

  v_result := public._save_invoice_lineage_unaware_impl_20260827(
    p_invoice,
    v_forward_items,
    p_idempotency_key
  );

  IF jsonb_array_length(v_lineage) > 0 THEN
    WITH preserved AS (
      SELECT
        (entry->>'sort_order')::integer AS sort_order,
        (entry->>'source_item_id')::uuid AS source_item_id,
        (entry->>'order_item_id')::uuid AS order_item_id,
        (entry->>'product_id')::uuid AS product_id,
        entry->>'unit_size' AS unit_size,
        (entry->>'cost_cents')::bigint AS cost_cents,
        (entry->>'created_at')::timestamptz AS created_at,
        entry->>'tote_number' AS tote_number,
        entry->>'vendor' AS vendor,
        entry->>'warehouse' AS warehouse
      FROM jsonb_array_elements(v_lineage) AS saved(entry)
    )
    UPDATE public.invoice_items ii
       SET id = preserved.source_item_id,
           order_item_id = preserved.order_item_id,
           cost_cents = preserved.cost_cents,
           created_at = preserved.created_at,
           tote_number = preserved.tote_number,
           vendor = preserved.vendor,
           warehouse = preserved.warehouse
      FROM preserved
     WHERE ii.invoice_id = v_result
       AND ii.sort_order = preserved.sort_order
       AND ii.product_id IS NOT DISTINCT FROM preserved.product_id
       AND ii.unit_size IS NOT DISTINCT FROM preserved.unit_size;
    GET DIAGNOSTICS v_restored = ROW_COUNT;

    IF v_restored <> jsonb_array_length(v_lineage) THEN
      RAISE EXCEPTION 'GENERATED_INVOICE_LINEAGE_RESTORE_FAILED';
    END IF;
  END IF;

  UPDATE public.invoices i
     SET total_cost_cents = COALESCE((
           SELECT SUM(
             CASE WHEN ii.is_application_fee
               THEN ii.cost_cents
               ELSE ROUND(ii.cost_cents * ii.quantity)::bigint
             END
           )::bigint
           FROM public.invoice_items ii
           WHERE ii.invoice_id = v_result
         ), 0),
         updated_at = now()
   WHERE i.id = v_result
     AND i.status IN ('draft', 'unposted');

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text) IS
  'Internal invoice writer. Preserves server-held generated-line identity, order lineage, historical unit cost, and creation order across draft edits; use public.save_invoice.';

DO $postflight$
DECLARE
  v_cutover_barrier regprocedure := to_regprocedure('public.block_return_credit_during_cogs_cutover()');
  v_writer regprocedure := to_regprocedure('public._save_invoice_scoped_impl(jsonb,jsonb,text)');
  v_old_writer regprocedure := to_regprocedure('public._save_invoice_lineage_unaware_impl_20260827(jsonb,jsonb,text)');
  v_cancel_return regprocedure := to_regprocedure('public._cancel_return_intent_impl_20260812(uuid,text,uuid,text)');
  v_src text;
  v_cancel_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_writer;
  SELECT p.prosrc INTO v_cancel_src FROM pg_proc p WHERE p.oid = v_cancel_return;
  IF v_cutover_barrier IS NULL
     OR v_writer IS NULL
     OR v_old_writer IS NULL
     OR v_cancel_return IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_save_invoice_scoped_impl') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = '_save_invoice_lineage_unaware_impl_20260827') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_writer
         AND p.prorettype = 'uuid'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR encode(sha256(convert_to(replace(v_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
        <> 'cab2bde1aa6bf26d918639cfb8d328ac579d0b7f5429123aa24710a1a835866e'
     OR position('GENERATED_INVOICE_LINEAGE_LINE_REQUIRED' IN v_src) = 0
     OR position('SET id = preserved.source_item_id' IN v_src) = 0
     OR position('cost_cents = preserved.cost_cents' IN v_src) = 0
     OR position('created_at = preserved.created_at' IN v_src) = 0
     OR has_function_privilege('anon', v_writer, 'EXECUTE')
     OR has_function_privilege('authenticated', v_writer, 'EXECUTE')
     OR has_function_privilege('service_role', v_writer, 'EXECUTE')
     OR has_function_privilege('anon', v_old_writer, 'EXECUTE')
     OR has_function_privilege('authenticated', v_old_writer, 'EXECUTE')
     OR has_function_privilege('service_role', v_old_writer, 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_INVOICE_WRITER_POSTFLIGHT_DRIFT';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '_cancel_return_intent_impl_20260812') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p
       WHERE p.oid = v_cancel_return
         AND p.prorettype = 'jsonb'::regtype
         AND p.prosecdef
         AND p.provolatile = 'v'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_userbyid(p.proowner) = 'postgres'
     )
     OR encode(sha256(convert_to(replace(v_cancel_src, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')
        <> '68a39088d3615585a39df4dd4d15a2ecec6daf118a00ee4aaabbf71b051254e9'
     OR position('IF p_reason IS NULL OR btrim(p_reason) = '''' THEN' IN v_cancel_src) = 0
     OR position('v_cached := public.check_idempotency(p_idempotency_key, ''cancel_return'');' IN v_cancel_src) = 0
     OR position('IF p_reason IS NULL OR btrim(p_reason) = '''' THEN' IN v_cancel_src)
        > position('v_cached := public.check_idempotency(p_idempotency_key, ''cancel_return'');' IN v_cancel_src)
     OR position('RETURN_RESTOCKED_QUANTITY_MISSING' IN v_cancel_src) = 0
     OR position('RETURN_RESTOCK_INVENTORY_INSUFFICIENT' IN v_cancel_src) = 0
     OR position('sum(ri.restocked_quantity) AS restocked_quantity' IN v_cancel_src) = 0
     OR position('GROUP BY ri.product_id, inv.id, inv.location, inv.quantity_available' IN v_cancel_src) = 0
     OR position('quantity_available - v_item.restocked_quantity' IN v_cancel_src) = 0
     OR position('restocked_quantity = NULL' IN v_cancel_src) = 0
     OR has_function_privilege('anon', v_cancel_return, 'EXECUTE')
     OR has_function_privilege('authenticated', v_cancel_return, 'EXECUTE')
     OR has_function_privilege('service_role', v_cancel_return, 'EXECUTE') THEN
    RAISE EXCEPTION 'RETURN_COGS_CANCEL_RETURN_POSTFLIGHT_DRIFT';
  END IF;
END;
$postflight$;

-- Deliberately last: any failure above rolls back this removal and keeps
-- return-credit issuance fail-closed on the exact persistent barrier.
RESET lock_timeout;
DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover ON public.returns;
DROP FUNCTION public.block_return_credit_during_cogs_cutover();
