-- Make an admin-deleted bulk-imported purchase order safely importable again.
-- The durable document claim already cascades with the PO, but the generic
-- 24-hour idempotency result also has to be removed or it can replay a deleted
-- po_id. Browser markers remain hints only; save_purchase_order rechecks the
-- server-side document claim before deciding an import is a duplicate.

CREATE OR REPLACE FUNCTION public._invalidate_deleted_purchase_order_retry_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  DELETE FROM public.idempotency_keys
   WHERE operation = 'save_purchase_order'
     AND NULLIF(result->>'po_id', '') = OLD.id::text;

  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public._invalidate_deleted_purchase_order_retry_state()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS invalidate_deleted_purchase_order_retry_state
  ON public.purchase_orders;
CREATE TRIGGER invalidate_deleted_purchase_order_retry_state
  AFTER DELETE ON public.purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION public._invalidate_deleted_purchase_order_retry_state();

CREATE OR REPLACE FUNCTION public.save_purchase_order(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_payload jsonb := COALESCE(p_po_payload, '{}'::jsonb);
  v_result jsonb;
  v_po_number text;
  v_bulk_intent_key text := NULLIF(btrim(p_po_payload->>'bulk_import_intent_key'), '');
  v_existing_po_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admins or sales reps can manage purchase orders';
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    IF p_po_id IS NOT NULL OR p_idempotency_key IS NULL
       OR length(v_bulk_intent_key) > 512 THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_INVALID';
    END IF;

    -- The browser's persisted marker is only a hint. Serialize by global
    -- document identity and recheck the durable claim before allocating a new
    -- PO number. If the original PO was deleted, its claim has cascaded and the
    -- delete trigger above has removed every cached save result for that po_id.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bulk_po:' || v_bulk_intent_key, 0)
    );
    SELECT claim.purchase_order_id, po.po_number
      INTO v_existing_po_id, v_po_number
      FROM public.purchase_order_import_intents AS claim
      JOIN public.purchase_orders AS po
        ON po.id = claim.purchase_order_id
     WHERE claim.intent_key = v_bulk_intent_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'already_imported',
        'po_id', v_existing_po_id,
        'po_number', v_po_number
      );
    END IF;
  END IF;

  IF p_po_id IS NULL THEN
    -- next_po_number takes a transaction-scoped advisory lock. Calling it from
    -- this outer writer keeps that lock until the delegated INSERT commits, so
    -- a concurrent creator cannot receive the same MAX+1 value.
    v_po_number := public.next_po_number();
    v_payload := jsonb_set(
      v_payload,
      '{po_number}',
      to_jsonb(v_po_number),
      true
    );
  END IF;

  v_result := public._save_purchase_order_atomic_number_impl(
    p_po_id,
    v_payload,
    p_items,
    p_performed_by,
    p_idempotency_key
  );

  IF NULLIF(v_result->>'po_id', '') IS NOT NULL THEN
    SELECT po_number
      INTO v_po_number
      FROM public.purchase_orders
     WHERE id = (v_result->>'po_id')::uuid;
    IF v_po_number IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('po_number', v_po_number);
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
)
TO authenticated, service_role;

COMMENT ON FUNCTION public._invalidate_deleted_purchase_order_retry_state()
  IS 'Internal trigger that removes save_purchase_order idempotency results when their PO is deliberately hard-deleted.';
COMMENT ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
) IS 'Saves a purchase order; bulk imports recheck the durable global document claim and new PO numbers are allocated atomically.';

DO $verify$
DECLARE
  v_save_source text;
  v_trigger_source text;
BEGIN
  SELECT prosrc
    INTO v_save_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  SELECT prosrc
    INTO v_trigger_source
    FROM pg_proc
   WHERE oid = 'public._invalidate_deleted_purchase_order_retry_state()'::regprocedure;

  IF v_save_source NOT LIKE '%WHERE claim.intent_key = v_bulk_intent_key%'
     OR v_save_source NOT LIKE '%''status'', ''already_imported''%'
     OR strpos(v_save_source, 'WHERE claim.intent_key = v_bulk_intent_key')
        > strpos(v_save_source, 'public.next_po_number()') THEN
    RAISE EXCEPTION 'Bulk PO server verification must precede number allocation';
  END IF;
  IF v_trigger_source NOT LIKE '%DELETE FROM public.idempotency_keys%'
     OR v_trigger_source NOT LIKE '%operation = ''save_purchase_order''%'
     OR v_trigger_source NOT LIKE '%result->>''po_id''%'
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger
        WHERE tgrelid = 'public.purchase_orders'::regclass
          AND tgname = 'invalidate_deleted_purchase_order_retry_state'
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'Deleted PO retry-state invalidation is incomplete';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public._invalidate_deleted_purchase_order_retry_state()',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Deleted PO retry-state grants are too broad';
  END IF;
END;
$verify$;
