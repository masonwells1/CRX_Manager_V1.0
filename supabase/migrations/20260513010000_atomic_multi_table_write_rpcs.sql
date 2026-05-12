-- 20260513010000 — Atomic multi-table write RPCs (audits #10, #31, #34)
-- idempotency-body-check: exempt
--   All three RPCs use the canonical `check_idempotency`/`save_idempotency`
--   helper pair (per CLAUDE.md). The hook's literal-string body check would
--   false-negative because the helpers wrap the table access.
--
-- Closes audit findings:
--   #10 — NewDelivery.tsx inserted `deliveries` then `delivery_items` separately;
--         a failure on the second call left an orphaned delivery row.
--   #31 — BulkOrderImport.tsx looped per-order, inserting order then items in
--         separate calls; orphaned orders on item-insert failure.
--   #34 — BlendRecipes.tsx DELETEd then INSERTed items in separate calls;
--         a failed insert wiped a recipe's items with no rollback.
--
-- All three problems share a shape: multi-table write that wasn't a single
-- transaction. Postgres function bodies run inside an implicit transaction
-- (or extend the caller's), so wrapping the writes in a SECURITY DEFINER RPC
-- gives us atomicity for free — if any statement raises, every prior write
-- in the function rolls back together.
--
-- Each RPC follows the canonical 2026-05 pattern:
--   - SECURITY DEFINER + `SET search_path = public, pg_temp`
--   - `auth.uid()` for actor identity (no positional p_performed_by trust)
--   - Role gate (admin or sales_rep, matching the table RLS WITH CHECK)
--   - `check_idempotency`/`save_idempotency` helpers
--   - Machine-readable error tokens registered in RpcErrorCodes
--   - Returns `jsonb_build_object('success', true, ...)`

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. create_delivery_with_items — closes audit #10
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_delivery_with_items(
  p_order_id              uuid,
  p_customer_id           uuid,
  p_scheduled_date        date,
  p_items                 jsonb,
  p_delivery_address_id   uuid    DEFAULT NULL,
  p_assigned_driver       uuid    DEFAULT NULL,
  p_scheduled_time        text    DEFAULT NULL,
  p_delivery_notes        text    DEFAULT NULL,
  p_idempotency_key       text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_delivery_id    uuid;
  v_delivery_no    text;
  v_existing       jsonb;
  v_result         jsonb;
  v_item           jsonb;
  v_item_count     int := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_order_id IS NULL THEN RAISE EXCEPTION 'ORDER_ID_REQUIRED'; END IF;
  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED'; END IF;
  IF p_scheduled_date IS NULL THEN RAISE EXCEPTION 'SCHEDULED_DATE_REQUIRED'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_delivery_with_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Generate delivery_number atomically (existing helper).
  v_delivery_no := next_delivery_number();

  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, delivery_address_id,
    assigned_driver, scheduled_date, scheduled_time, delivery_notes,
    status, created_by
  ) VALUES (
    v_delivery_no, p_order_id, p_customer_id, p_delivery_address_id,
    p_assigned_driver, p_scheduled_date, p_scheduled_time, p_delivery_notes,
    'scheduled', v_actor
  )
  RETURNING id INTO v_delivery_id;

  -- Insert all items. If any item is malformed, the whole function rolls back.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'order_item_id') IS NULL OR (v_item->>'product_id') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: order_item_id and product_id required';
    END IF;
    IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity')::numeric <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: quantity must be > 0';
    END IF;

    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity,
      unit_size, tote_number, notes
    ) VALUES (
      v_delivery_id,
      (v_item->>'order_item_id')::uuid,
      (v_item->>'product_id')::uuid,
      (v_item->>'quantity')::numeric,
      NULLIF(v_item->>'unit_size', ''),
      NULLIF(v_item->>'tote_number', ''),
      NULLIF(v_item->>'notes', '')
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success',          true,
    'delivery_id',      v_delivery_id,
    'delivery_number',  v_delivery_no,
    'item_count',       v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_delivery_with_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_delivery_with_items(uuid, uuid, date, jsonb, uuid, uuid, text, text, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. bulk_import_order — closes audit #31
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Frontend resolves customer + product IDs first (preserves the existing
-- friendly per-row error messages), then calls this RPC per order. Each
-- per-order call is its own atomic unit — partial-success semantics across
-- the file remain (some orders import, some fail) but each individual order
-- is all-or-nothing.

CREATE OR REPLACE FUNCTION public.bulk_import_order(
  p_order_number       text,
  p_customer_id        uuid,
  p_status             text,
  p_total_price        numeric,
  p_total_cost         numeric,
  p_total_profit       numeric,
  p_total_margin_pct   numeric,
  p_order_date         date,
  p_items              jsonb,
  p_notes              text    DEFAULT NULL,
  p_idempotency_key    text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_order_id    uuid;
  v_existing    jsonb;
  v_result      jsonb;
  v_item        jsonb;
  v_item_count  int := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_order_number IS NULL OR p_order_number = '' THEN RAISE EXCEPTION 'ORDER_NUMBER_REQUIRED'; END IF;
  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'bulk_import_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  INSERT INTO public.orders (
    order_number, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes
  ) VALUES (
    p_order_number, p_customer_id,
    CASE WHEN p_status IN ('confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled')
         THEN p_status ELSE 'confirmed' END,
    p_total_price, p_total_cost, p_total_profit, p_total_margin_pct,
    p_order_date, p_notes
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'product_name') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: product_name required';
    END IF;
    IF (v_item->>'total_units_needed') IS NULL OR (v_item->>'total_units_needed')::numeric <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: total_units_needed must be > 0';
    END IF;

    INSERT INTO public.order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size, notes,
      sort_order, quantity_delivered
    ) VALUES (
      v_order_id,
      NULLIF(v_item->>'product_id', '')::uuid,
      v_item->>'product_name',
      COALESCE((v_item->>'price_per_unit')::numeric, 0),
      COALESCE((v_item->>'unit_cost')::numeric, 0),
      (v_item->>'total_units_needed')::numeric,
      NULLIF(v_item->>'unit_size', ''),
      NULLIF(v_item->>'notes', ''),
      COALESCE((v_item->>'sort_order')::int, v_item_count + 1),
      0
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success',     true,
    'order_id',    v_order_id,
    'item_count',  v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'bulk_import_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_import_order(text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. save_blend_recipe — closes audit #34
-- ─────────────────────────────────────────────────────────────────────────────
--
-- p_recipe_id NULL => create; UUID => update.
-- For update, all existing items are deleted and the supplied items inserted.
-- The whole thing is atomic — if any insert fails, the DELETE rolls back too,
-- so a recipe never ends up with zero items unintentionally.

CREATE OR REPLACE FUNCTION public.save_blend_recipe(
  p_recipe_id        uuid,
  p_name             text,
  p_recipe_type      text,
  p_items            jsonb,
  p_description      text    DEFAULT NULL,
  p_crop_type        text    DEFAULT NULL,
  p_timing           text    DEFAULT NULL,
  p_idempotency_key  text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_recipe_id    uuid;
  v_existing     jsonb;
  v_result       jsonb;
  v_item         jsonb;
  v_item_count   int := 0;
  v_idx          int := 0;
  v_was_create   boolean := (p_recipe_id IS NULL);
  v_creator      uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF p_name IS NULL OR p_name = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF p_recipe_type NOT IN ('generic', 'crop_specific') THEN RAISE EXCEPTION 'RECIPE_TYPE_INVALID'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'ITEMS_INVALID';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_blend_recipe');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_was_create THEN
    -- Create path: anyone with a session can author their own recipe (matches
    -- blend_recipes_insert WITH CHECK: is_admin() OR (created_by = uid)).
    INSERT INTO public.blend_recipes (
      name, description, recipe_type, crop_type, timing, created_by
    ) VALUES (
      trim(p_name), NULLIF(p_description, ''), p_recipe_type,
      CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_crop_type, '') ELSE NULL END,
      CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_timing, '') ELSE NULL END,
      v_actor
    )
    RETURNING id INTO v_recipe_id;
  ELSE
    -- Update path: only admin OR original creator (matches RLS USING).
    SELECT created_by INTO v_creator FROM public.blend_recipes WHERE id = p_recipe_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'RECIPE_NOT_FOUND'; END IF;
    IF NOT (is_admin() OR v_creator = v_actor) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

    UPDATE public.blend_recipes SET
      name        = trim(p_name),
      description = NULLIF(p_description, ''),
      recipe_type = p_recipe_type,
      crop_type   = CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_crop_type, '') ELSE NULL END,
      timing      = CASE WHEN p_recipe_type = 'crop_specific' THEN NULLIF(p_timing, '') ELSE NULL END,
      updated_at  = now()
    WHERE id = p_recipe_id;

    -- Atomic replace: DELETE + INSERT inside the function — both roll back
    -- together if anything fails (audit #34).
    DELETE FROM public.blend_recipe_items WHERE recipe_id = p_recipe_id;
    v_recipe_id := p_recipe_id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'product_id') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: product_id required';
    END IF;
    IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity')::numeric <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: quantity must be > 0';
    END IF;

    INSERT INTO public.blend_recipe_items (
      recipe_id, product_id, product_name, quantity, unit,
      rate_per_acre, sort_order, notes
    ) VALUES (
      v_recipe_id,
      (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'product_name', ''),
      (v_item->>'quantity')::numeric,
      COALESCE(NULLIF(v_item->>'unit', ''), 'gal'),
      NULLIF(v_item->>'rate_per_acre', '')::numeric,
      v_idx,
      NULLIF(v_item->>'notes', '')
    );
    v_idx := v_idx + 1;
    v_item_count := v_item_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success',     true,
    'recipe_id',   v_recipe_id,
    'created',     v_was_create,
    'item_count',  v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_blend_recipe', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.save_blend_recipe(uuid, text, text, jsonb, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_blend_recipe(uuid, text, text, jsonb, text, text, text, text) TO authenticated;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'create_delivery_with_items'
       AND pg_get_function_identity_arguments(oid)
           = 'p_order_id uuid, p_customer_id uuid, p_scheduled_date date, p_items jsonb, p_delivery_address_id uuid, p_assigned_driver uuid, p_scheduled_time text, p_delivery_notes text, p_idempotency_key text'
  ) THEN RAISE EXCEPTION 'verify failed: create_delivery_with_items signature mismatch'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'bulk_import_order'
       AND pg_get_function_identity_arguments(oid)
           = 'p_order_number text, p_customer_id uuid, p_status text, p_total_price numeric, p_total_cost numeric, p_total_profit numeric, p_total_margin_pct numeric, p_order_date date, p_items jsonb, p_notes text, p_idempotency_key text'
  ) THEN RAISE EXCEPTION 'verify failed: bulk_import_order signature mismatch'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = 'save_blend_recipe'
       AND pg_get_function_identity_arguments(oid)
           = 'p_recipe_id uuid, p_name text, p_recipe_type text, p_items jsonb, p_description text, p_crop_type text, p_timing text, p_idempotency_key text'
  ) THEN RAISE EXCEPTION 'verify failed: save_blend_recipe signature mismatch'; END IF;
END$$;
