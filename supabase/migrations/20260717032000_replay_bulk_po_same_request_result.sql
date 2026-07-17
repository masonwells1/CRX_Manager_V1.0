-- Preserve the exact public result for a committed bulk-PO request replay.
--
-- The durable document claim must still win for a different request key, but
-- the same request key represents a lost-response retry and must return the
-- original cached `saved` result before duplicate-document classification.

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
  v_cached jsonb;
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

  -- A same-key retry is the same request, not a second document import. Read
  -- this first so a response lost after commit replays the original `saved`
  -- result. check_idempotency also holds the key-only transaction lock, so a
  -- concurrent retry waits for the first writer and then observes its result.
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(
      p_idempotency_key,
      'save_purchase_order'
    );
    IF v_cached IS NOT NULL THEN
      v_existing_po_id := NULLIF(v_cached->>'po_id', '')::uuid;
      IF v_existing_po_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_PURCHASE_ORDER_RESULT_INVALID';
      END IF;
      IF p_po_id IS NOT NULL AND p_po_id IS DISTINCT FROM v_existing_po_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;

      SELECT po_number
        INTO v_po_number
        FROM public.purchase_orders
       WHERE id = v_existing_po_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Purchase order not found after save: %', v_existing_po_id;
      END IF;

      RETURN v_cached || jsonb_build_object('po_number', v_po_number);
    END IF;
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    IF p_po_id IS NOT NULL OR p_idempotency_key IS NULL
       OR length(v_bulk_intent_key) > 512 THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_INVALID';
    END IF;

    -- A different request for the same reviewed document is a true duplicate.
    -- Serialize by global document identity and check its durable claim before
    -- allocating a new PO number.
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

COMMENT ON FUNCTION public.save_purchase_order(
  uuid, jsonb, jsonb, uuid, text
) IS 'Saves a purchase order; same-key retries replay the original result, different-key bulk duplicates return the durable document claim, and new PO numbers are allocated atomically.';

DO $verify$
DECLARE
  v_save_source text;
BEGIN
  SELECT prosrc
    INTO v_save_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  IF v_save_source NOT LIKE '%public.check_idempotency(%'
     OR v_save_source NOT LIKE '%RETURN v_cached || jsonb_build_object(''po_number'', v_po_number)%'
     OR strpos(v_save_source, 'public.check_idempotency(')
        > strpos(v_save_source, 'WHERE claim.intent_key = v_bulk_intent_key')
     OR strpos(v_save_source, 'WHERE claim.intent_key = v_bulk_intent_key')
        > strpos(v_save_source, 'public.next_po_number()') THEN
    RAISE EXCEPTION 'Purchase-order replay and duplicate checks are ordered incorrectly';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Purchase-order save grants are incorrect';
  END IF;
END;
$verify$;
