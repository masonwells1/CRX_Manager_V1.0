-- Close the final adversarial money/inventory review gaps:
--   * serialize PO saves before omitted-cost hydration;
--   * validate PO line identity and recompute headers from stored lines;
--   * persist a server-side bulk-import intent claim across tabs/devices;
--   * bind invoice save/post replays to the actual invoice/customer scope.

CREATE TABLE public.purchase_order_import_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  intent_key text NOT NULL,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_import_intents_actor_intent_key
    UNIQUE (actor_id, intent_key),
  CONSTRAINT purchase_order_import_intents_purchase_order_key
    UNIQUE (purchase_order_id),
  CONSTRAINT purchase_order_import_intents_key_not_blank
    CHECK (btrim(intent_key) <> '')
);

ALTER TABLE public.purchase_order_import_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_import_intents_no_direct_access
  ON public.purchase_order_import_intents
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
REVOKE ALL ON TABLE public.purchase_order_import_intents
  FROM PUBLIC, anon, authenticated;

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

  -- The advisory lock closes the check-then-save idempotency race. It is taken
  -- before any cache read and held until the transaction commits or rolls back.
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

    -- This persistent claim, unlike browser storage or the 24-hour generic
    -- idempotency cache, prevents the same reviewed vendor document from being
    -- imported again in another tab, browser, or device.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bulk_po:' || v_actor::text || ':' || v_bulk_intent_key, 0)
    );
    SELECT purchase_order_id
      INTO v_result_po_id
      FROM public.purchase_order_import_intents
     WHERE actor_id = v_actor
       AND intent_key = v_bulk_intent_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'already_imported',
        'po_id', v_result_po_id
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
    -- Serialize before reading stored costs. The delegated writer locks this
    -- same row again, so hydration and mutation share one authoritative state.
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

CREATE OR REPLACE FUNCTION public.save_invoice(
  p_invoice jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_existing_customer_id uuid;
  v_requested_customer_id uuid := NULLIF(p_invoice->>'customer_id', '')::uuid;
  v_target_customer_id uuid;
  v_requested_salesman_id uuid := NULLIF(p_invoice->>'salesman_id', '')::uuid;
  v_cached jsonb;
  v_cached_invoice_id uuid;
  v_cached_customer_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('save_invoice:' || p_idempotency_key, 0)
    );
    v_cached := public.check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_cached IS NOT NULL THEN
      v_cached_invoice_id := NULLIF(v_cached->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      IF v_invoice_id IS NOT NULL
         AND v_invoice_id IS DISTINCT FROM v_cached_invoice_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;

      SELECT customer_id
        INTO v_cached_customer_id
        FROM public.invoices
       WHERE id = v_cached_invoice_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND';
      END IF;
      IF v_requested_customer_id IS NOT NULL
         AND v_requested_customer_id IS DISTINCT FROM v_cached_customer_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF v_actor_role = 'sales_rep'
         AND NOT EXISTS (
           SELECT 1
             FROM public.customers
            WHERE id = v_cached_customer_id
              AND assigned_sales_rep = v_actor
         ) THEN
        RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
      END IF;
      RETURN v_cached_invoice_id;
    END IF;
  END IF;

  IF v_invoice_id IS NOT NULL THEN
    SELECT customer_id
      INTO v_existing_customer_id
      FROM public.invoices
     WHERE id = v_invoice_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND';
    END IF;
  END IF;

  v_target_customer_id := COALESCE(
    v_requested_customer_id,
    v_existing_customer_id
  );
  IF v_target_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_REQUIRED';
  END IF;

  IF v_actor_role = 'sales_rep' THEN
    IF v_existing_customer_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.customers
          WHERE id = v_existing_customer_id
            AND assigned_sales_rep = v_actor
       ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.customers
       WHERE id = v_target_customer_id
         AND assigned_sales_rep = v_actor
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
    IF v_requested_salesman_id IS NOT NULL
       AND v_requested_salesman_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;

  RETURN public._save_invoice_scoped_impl(
    p_invoice,
    p_items,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  TO authenticated, service_role;

ALTER FUNCTION public.post_invoice(uuid, text)
  RENAME TO _post_invoice_customer_scope_impl;
REVOKE ALL ON FUNCTION public._post_invoice_customer_scope_impl(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.post_invoice(
  p_invoice_id uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_customer_id uuid;
  v_cached jsonb;
  v_cached_invoice_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('post_invoice:' || p_idempotency_key, 0)
    );
    v_cached := public.check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_cached IS NOT NULL THEN
      v_cached_invoice_id := NULLIF(v_cached->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL
         OR v_cached_invoice_id IS DISTINCT FROM p_invoice_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
    END IF;
  END IF;

  SELECT customer_id
    INTO v_customer_id
    FROM public.invoices
   WHERE id = p_invoice_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND'; END IF;

  IF v_actor_role = 'sales_rep'
     AND NOT EXISTS (
       SELECT 1
         FROM public.customers
        WHERE id = v_customer_id
          AND assigned_sales_rep = v_actor
     ) THEN
    RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
  END IF;

  PERFORM public._post_invoice_customer_scope_impl(
    p_invoice_id,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid, text)
  TO authenticated, service_role;

ALTER FUNCTION public.post_invoice_group(uuid, uuid, text)
  RENAME TO _post_invoice_group_customer_scope_impl;
REVOKE ALL ON FUNCTION public._post_invoice_group_customer_scope_impl(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.post_invoice_group(
  p_invoice_group_id uuid,
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
  v_actor_role text;
  v_cached jsonb;
  v_cached_group_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_invoice_group_id IS NULL THEN
    RAISE EXCEPTION 'invoice_group_id is required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('post_invoice_group:' || p_idempotency_key, 0)
    );
    v_cached := public.check_idempotency(
      p_idempotency_key,
      'post_invoice_group'
    );
    IF v_cached IS NOT NULL THEN
      v_cached_group_id := NULLIF(v_cached->>'invoice_group_id', '')::uuid;
      IF v_cached_group_id IS NULL
         OR v_cached_group_id IS DISTINCT FROM p_invoice_group_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_invoice_group_id::text, 0));
  PERFORM 1
    FROM public.invoices
   WHERE invoice_group_id = p_invoice_group_id
     AND deleted_at IS NULL
   ORDER BY id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id;
  END IF;

  IF v_actor_role = 'sales_rep'
     AND EXISTS (
       SELECT 1
         FROM public.invoices invoice_row
         LEFT JOIN public.customers customer_row
           ON customer_row.id = invoice_row.customer_id
        WHERE invoice_row.invoice_group_id = p_invoice_group_id
          AND invoice_row.deleted_at IS NULL
          AND customer_row.assigned_sales_rep IS DISTINCT FROM v_actor
     ) THEN
    RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
  END IF;

  RETURN public._post_invoice_group_customer_scope_impl(
    p_invoice_group_id,
    p_performed_by,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice_group(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_group(uuid, uuid, text)
  TO authenticated, service_role;

DO $verify$
DECLARE
  v_po_source text;
  v_invoice_source text;
  v_post_source text;
BEGIN
  SELECT prosrc INTO v_po_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;
  SELECT prosrc INTO v_invoice_source
    FROM pg_proc
   WHERE oid = 'public.save_invoice(jsonb,jsonb,text)'::regprocedure;
  SELECT prosrc INTO v_post_source
    FROM pg_proc
   WHERE oid = 'public.post_invoice(uuid,text)'::regprocedure;

  IF v_po_source NOT LIKE '%pg_advisory_xact_lock%'
     OR v_po_source NOT LIKE '%FOR UPDATE%'
     OR v_po_source NOT LIKE '%PO_ITEM_ID_DUPLICATE%'
     OR v_po_source NOT LIKE '%purchase_order_import_intents%'
     OR v_po_source NOT LIKE '%SUM(round(poi.quantity_ordered * poi.unit_cost_cents)%' THEN
    RAISE EXCEPTION 'save_purchase_order adversarial hardening is incomplete';
  END IF;
  IF v_invoice_source NOT LIKE '%v_cached_customer_id%'
     OR v_invoice_source NOT LIKE '%IDEMPOTENCY_PAYLOAD_CONFLICT%'
     OR v_invoice_source NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'save_invoice replay binding is incomplete';
  END IF;
  IF v_post_source NOT LIKE '%assigned_sales_rep%'
     OR v_post_source NOT LIKE '%IDEMPOTENCY_PAYLOAD_CONFLICT%' THEN
    RAISE EXCEPTION 'post_invoice customer scope is incomplete';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public._post_invoice_customer_scope_impl(uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._post_invoice_group_customer_scope_impl(uuid,uuid,text)',
       'EXECUTE'
     )
     OR has_table_privilege(
       'authenticated',
       'public.purchase_order_import_intents',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'Adversarial hardening helper grants are too broad';
  END IF;
END;
$verify$;
