-- Make the persistent vendor-document claim global across employees.
-- The generic idempotency cache remains actor-scoped in the client; this
-- business-level claim only prevents the same reviewed document from creating
-- a second purchase order when another authorized employee imports it.

-- Hold writers out between the duplicate check and the constraint swap. The
-- table was also verified live as empty immediately before review, but this
-- in-transaction preflight keeps the migration safe if a claim arrives later.
LOCK TABLE public.purchase_order_import_intents IN ACCESS EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.purchase_order_import_intents
     GROUP BY intent_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BULK_PO_INTENT_DUPLICATES_REQUIRE_RECONCILIATION';
  END IF;
END;
$preflight$;

ALTER TABLE public.purchase_order_import_intents
  DROP CONSTRAINT purchase_order_import_intents_actor_intent_key;

ALTER TABLE public.purchase_order_import_intents
  ADD CONSTRAINT purchase_order_import_intents_intent_key
  UNIQUE (intent_key);

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
  v_hydrated_items jsonb;
  v_result jsonb;
  v_result_po_id uuid;
  v_result_po_number text;
  v_bulk_intent_key text := NULLIF(btrim(p_po_payload->>'bulk_import_intent_key'), '');
  v_cached jsonb;
  v_stored_total_cents bigint;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admins or sales reps can manage purchase orders';
  END IF;

  -- Generic request replay remains scoped to the caller-provided key.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('save_purchase_order:' || p_idempotency_key, 0)
    );
    v_cached := public.check_idempotency(
      p_idempotency_key,
      'save_purchase_order'
    );
    IF v_cached IS NOT NULL THEN
      v_result_po_id := NULLIF(v_cached->>'po_id', '')::uuid;
      IF p_po_id IS NOT NULL AND p_po_id IS DISTINCT FROM v_result_po_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      RETURN v_cached;
    END IF;
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    IF p_po_id IS NOT NULL OR p_idempotency_key IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_INVALID';
    END IF;
    IF length(v_bulk_intent_key) > 512 THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_INVALID';
    END IF;

    -- Serialize and look up by document identity alone. The actor is retained
    -- only as provenance for the employee who created the first PO.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bulk_po:' || v_bulk_intent_key, 0)
    );
    SELECT claim.purchase_order_id, po.po_number
      INTO v_result_po_id, v_result_po_number
      FROM public.purchase_order_import_intents AS claim
      JOIN public.purchase_orders AS po
        ON po.id = claim.purchase_order_id
     WHERE claim.intent_key = v_bulk_intent_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'already_imported',
        'po_id', v_result_po_id,
        'po_number', v_result_po_number
      );
    END IF;
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'PO_ITEMS_REQUIRED';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) AS item
     WHERE NULLIF(item->>'product_id', '') IS NULL
        OR NULLIF(item->>'quantity_ordered', '') IS NULL
        OR (item->>'quantity_ordered')::numeric <= 0
  ) THEN
    RAISE EXCEPTION 'PO_ITEM_INVALID: product and positive quantity are required';
  END IF;
  IF EXISTS (
    SELECT item->>'id'
      FROM jsonb_array_elements(p_items) AS item
     WHERE NULLIF(item->>'id', '') IS NOT NULL
     GROUP BY item->>'id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PO_ITEM_ID_DUPLICATE';
  END IF;

  IF p_po_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_items) AS item
       WHERE NULLIF(item->>'id', '') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'PO_NEW_ITEM_ID_FORBIDDEN';
    END IF;
    v_hydrated_items := p_items;
  ELSE
    PERFORM 1
      FROM public.purchase_orders
     WHERE id = p_po_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase order not found: %', p_po_id;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_items) AS item
       WHERE NULLIF(item->>'id', '') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM public.purchase_order_items poi
            WHERE poi.purchase_order_id = p_po_id
              AND poi.id = (item->>'id')::uuid
         )
    ) THEN
      RAISE EXCEPTION 'PO_ITEM_ID_NOT_IN_PURCHASE_ORDER';
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN poi.id IS NOT NULL
               AND NOT (item.value ? 'unit_cost')
               AND NOT (item.value ? 'unit_cost_cents')
            THEN item.value || jsonb_build_object(
              'unit_cost_cents',
              poi.unit_cost_cents
            )
          ELSE item.value
        END
        ORDER BY item.ordinality
      ),
      '[]'::jsonb
    )
      INTO v_hydrated_items
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, ordinality)
      LEFT JOIN public.purchase_order_items poi
        ON poi.purchase_order_id = p_po_id
       AND poi.id::text = item.value->>'id';
  END IF;

  v_result := public._save_purchase_order_cost_input_impl(
    p_po_id,
    p_po_payload,
    v_hydrated_items,
    p_performed_by,
    p_idempotency_key
  );
  v_result_po_id := NULLIF(v_result->>'po_id', '')::uuid;
  IF v_result_po_id IS NULL THEN
    RAISE EXCEPTION 'SAVE_PURCHASE_ORDER_RESULT_INVALID';
  END IF;

  SELECT COALESCE(
    SUM(round(poi.quantity_ordered * poi.unit_cost_cents)::bigint),
    0
  )::bigint
    INTO v_stored_total_cents
    FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = v_result_po_id;

  UPDATE public.purchase_orders
     SET total_cost = v_stored_total_cents::numeric / 100.0
   WHERE id = v_result_po_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found after save: %', v_result_po_id;
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    INSERT INTO public.purchase_order_import_intents (
      actor_id,
      intent_key,
      purchase_order_id
    ) VALUES (
      v_actor,
      v_bulk_intent_key,
      v_result_po_id
    );
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  TO authenticated, service_role;

DO $verify$
DECLARE
  v_source text;
BEGIN
  SELECT prosrc INTO v_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.purchase_order_import_intents'::regclass
       AND conname = 'purchase_order_import_intents_intent_key'
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'Global bulk PO intent uniqueness is missing';
  END IF;
  IF v_source NOT LIKE '%hashtextextended(''bulk_po:'' || v_bulk_intent_key, 0)%'
     OR v_source LIKE '%''bulk_po:'' || v_actor::text%'
     OR v_source NOT LIKE '%WHERE claim.intent_key = v_bulk_intent_key%'
     OR v_source NOT LIKE '%''po_number'', v_result_po_number%' THEN
    RAISE EXCEPTION 'Global bulk PO claim implementation is incomplete';
  END IF;
  IF has_table_privilege(
       'authenticated',
       'public.purchase_order_import_intents',
       'SELECT'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Bulk PO hardening grants are incorrect';
  END IF;
END;
$verify$;
