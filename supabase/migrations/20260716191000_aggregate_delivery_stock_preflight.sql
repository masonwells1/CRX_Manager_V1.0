-- Close the duplicate-product short-stock blind spot in complete_delivery.
-- The original implementation checks each delivery line independently against
-- the same locked inventory row. This wrapper aggregates effective quantities
-- for repeated products, preserves WARN-NOT-BLOCK policy, marks every affected
-- ledger row for review, emits the normal warning trail, and caches that result.

DO $guard$
BEGIN
  IF to_regprocedure(
    'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Expected complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)';
  END IF;

  IF to_regprocedure(
    'public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Aggregate complete_delivery implementation already exists';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._mark_delivery_aggregate_short_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_delivery_id text := current_setting(
    'app.delivery_aggregate_short_delivery_id',
    true
  );
  v_product_ids text := current_setting(
    'app.delivery_aggregate_short_product_ids',
    true
  );
BEGIN
  IF NEW.transaction_type = 'delivered'
     AND NEW.delivery_id IS NOT NULL
     AND NEW.product_id IS NOT NULL
     AND v_delivery_id IS NOT NULL
     AND v_product_ids IS NOT NULL
     AND NEW.delivery_id::text = v_delivery_id
     AND NEW.product_id = ANY(string_to_array(v_product_ids, ',')::uuid[]) THEN
    NEW.requires_review := true;
    IF COALESCE(NEW.notes, '') NOT LIKE '%[SHORT STOCK — review required]%' THEN
      NEW.notes := COALESCE(NEW.notes, '') || ' [SHORT STOCK — review required]';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._mark_delivery_aggregate_short_stock()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_mark_delivery_aggregate_short_stock
BEFORE INSERT ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION public._mark_delivery_aggregate_short_stock();

COMMENT ON FUNCTION public._mark_delivery_aggregate_short_stock()
  IS 'Marks newly inserted delivered ledger rows for transaction-local aggregate short-stock products without mutating the append-only ledger later.';

ALTER FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
RENAME TO _complete_delivery_aggregate_impl;

REVOKE ALL ON FUNCTION public._complete_delivery_aggregate_impl(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamptz DEFAULT NULL::timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_delivery record;
  v_existing jsonb;
  v_result jsonb;
  v_item record;
  v_admin record;
  v_short_count integer := 0;
  v_short_product_ids uuid[] := '{}';
  v_stock_warnings text[] := '{}';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, delivery_number, customer_id, assigned_driver
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- Authorization deliberately precedes replay lookup.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'complete_delivery'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Lock every existing warehouse row involved before taking the aggregate
  -- snapshot. Missing rows are already handled by the proven inner function.
  PERFORM 1
    FROM public.inventory inv
   WHERE inv.location = 'Main Warehouse'
     AND inv.product_id IN (
       SELECT di.product_id
         FROM public.delivery_items di
        WHERE di.delivery_id = p_delivery_id
     )
   ORDER BY inv.product_id
   FOR UPDATE;

  FOR v_item IN
    WITH effective_lines AS (
      SELECT
        di.product_id,
        p.product_name,
        CASE
          WHEN p_quantities IS NOT NULL AND p_quantities ? di.id::text
            THEN GREATEST(
              0,
              LEAST((p_quantities->>di.id::text)::numeric, di.quantity)
            )
          ELSE di.quantity
        END AS effective_quantity
      FROM public.delivery_items di
      JOIN public.products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
    )
    SELECT
      el.product_id,
      el.product_name,
      SUM(el.effective_quantity) AS quantity_needed,
      COALESCE(inv.quantity_available, 0) AS quantity_available
    FROM effective_lines el
    LEFT JOIN public.inventory inv
      ON inv.product_id = el.product_id
     AND inv.location = 'Main Warehouse'
    GROUP BY
      el.product_id,
      el.product_name,
      inv.quantity_available
    HAVING COUNT(*) FILTER (WHERE el.effective_quantity > 0) > 1
       AND SUM(el.effective_quantity) > COALESCE(inv.quantity_available, 0)
       AND MAX(el.effective_quantity) <= COALESCE(inv.quantity_available, 0)
  LOOP
    v_short_count := v_short_count + 1;
    v_short_product_ids := array_append(v_short_product_ids, v_item.product_id);
    v_stock_warnings := array_append(
      v_stock_warnings,
      v_item.product_name || ': need ' || v_item.quantity_needed ||
        ' across repeated lines, only ' || v_item.quantity_available || ' on-hand'
    );
  END LOOP;

  IF v_short_count > 0 THEN
    PERFORM pg_catalog.set_config(
      'app.delivery_aggregate_short_delivery_id',
      p_delivery_id::text,
      true
    );
    PERFORM pg_catalog.set_config(
      'app.delivery_aggregate_short_product_ids',
      array_to_string(v_short_product_ids, ','),
      true
    );
  END IF;

  v_result := public._complete_delivery_aggregate_impl(
    p_delivery_id,
    p_signed_by,
    p_performed_by,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key,
    p_completed_at
  );

  IF v_short_count > 0 THEN
    INSERT INTO public.activity_feed (
      event_type,
      description,
      performed_by,
      related_entity_type,
      related_entity_id,
      customer_id
    ) VALUES (
      'delivery_short_stock',
      'WARNING: Delivery ' || v_delivery.delivery_number || ' completed with ' ||
        v_short_count || ' repeated-line product(s) short on stock: ' ||
        array_to_string(v_stock_warnings, ' | ') ||
        '. Completion proceeded; on-hand inventory went negative — review with the warehouse.',
      v_actor,
      'delivery',
      p_delivery_id,
      v_delivery.customer_id
    );

    FOR v_admin IN
      SELECT id
        FROM public.profiles
       WHERE role = 'admin'
         AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id,
        title,
        message,
        notification_type,
        related_entity_type,
        related_entity_id
      ) VALUES (
        v_admin.id,
        'Short Stock — Delivery ' || v_delivery.delivery_number,
        'Delivery ' || v_delivery.delivery_number || ' was completed but ' ||
          v_short_count || ' repeated-line product(s) exceeded aggregate on-hand stock: ' ||
          array_to_string(v_stock_warnings, ' | ') ||
          '. The completion proceeded and inventory went negative; please review.',
        'stock_warning',
        'delivery',
        p_delivery_id
      );
    END LOOP;

    v_result := v_result || jsonb_build_object(
      'stock_warning', true,
      'short_stock_count',
        COALESCE((v_result->>'short_stock_count')::integer, 0) + v_short_count,
      'warnings',
        COALESCE(v_result->'warnings', '[]'::jsonb) || to_jsonb(v_stock_warnings)
    );

    IF p_idempotency_key IS NOT NULL THEN
      UPDATE public.idempotency_keys
         SET result = v_result
       WHERE idempotency_key = p_idempotency_key
         AND operation = 'complete_delivery';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
)
TO authenticated, service_role;

COMMENT ON FUNCTION public._complete_delivery_aggregate_impl(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
) IS 'Internal delivery completion wrapper. Direct execution is revoked; use public.complete_delivery so aggregate repeated-product stock checks run first.';
COMMENT ON FUNCTION public.complete_delivery(
  uuid, text, uuid, jsonb, text, text, text, timestamptz
) IS 'Completes a delivery after active authorization and aggregate repeated-product short-stock review.';

DO $verify$
BEGIN
  IF has_function_privilege(
       'authenticated',
       'public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._mark_delivery_aggregate_short_stock()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Delivery aggregate helper grants are too broad';
  END IF;
END
$verify$;
