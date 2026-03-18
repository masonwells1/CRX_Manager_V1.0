-- ============================================================================
-- Add p_idempotency_key parameter to 5 mutation RPCs that don't have it yet.
-- Each function is written explicitly (no dynamic pg_get_functiondef).
-- Verified: each has exactly 1 overload in production (no shadow overloads).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. save_field (uuid, jsonb, jsonb, uuid) → add p_idempotency_key
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.save_field(uuid, jsonb, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.save_field(
  p_field_id uuid,
  p_field_payload jsonb,
  p_billing_defaults jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_field_id uuid;
  v_total_pct numeric;
  v_existing jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'field_id')::uuid; END IF;
  END IF;

  -- Validate billing splits total 100%
  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    SELECT COALESCE(SUM((elem->>'split_pct')::numeric), 0) INTO v_total_pct
    FROM jsonb_array_elements(p_billing_defaults) AS elem;

    IF ABS(v_total_pct - 100) > 0.01 THEN
      RAISE EXCEPTION 'Billing splits must total 100%% (got %.2f%%)', v_total_pct;
    END IF;
  END IF;

  IF p_field_id IS NULL THEN
    INSERT INTO fields (
      customer_id, field_name, legal_description, county, state,
      total_acres, fsa_farm_number, fsa_tract_number, fsa_field_number,
      crop_type, soil_type, irrigation, notes, is_active
    )
    SELECT
      (p_field_payload->>'customer_id')::uuid,
      p_field_payload->>'field_name',
      p_field_payload->>'legal_description',
      p_field_payload->>'county',
      COALESCE(p_field_payload->>'state', 'IL'),
      (p_field_payload->>'total_acres')::numeric,
      p_field_payload->>'fsa_farm_number',
      p_field_payload->>'fsa_tract_number',
      p_field_payload->>'fsa_field_number',
      p_field_payload->>'crop_type',
      p_field_payload->>'soil_type',
      COALESCE((p_field_payload->>'irrigation')::boolean, false),
      p_field_payload->>'notes',
      COALESCE((p_field_payload->>'is_active')::boolean, true)
    RETURNING id INTO v_field_id;
  ELSE
    UPDATE fields SET
      customer_id = (p_field_payload->>'customer_id')::uuid,
      field_name = p_field_payload->>'field_name',
      legal_description = p_field_payload->>'legal_description',
      county = p_field_payload->>'county',
      state = COALESCE(p_field_payload->>'state', 'IL'),
      total_acres = (p_field_payload->>'total_acres')::numeric,
      fsa_farm_number = p_field_payload->>'fsa_farm_number',
      fsa_tract_number = p_field_payload->>'fsa_tract_number',
      fsa_field_number = p_field_payload->>'fsa_field_number',
      crop_type = p_field_payload->>'crop_type',
      soil_type = p_field_payload->>'soil_type',
      irrigation = COALESCE((p_field_payload->>'irrigation')::boolean, false),
      notes = p_field_payload->>'notes',
      is_active = COALESCE((p_field_payload->>'is_active')::boolean, true)
    WHERE id = p_field_id;

    v_field_id := p_field_id;
  END IF;

  -- Replace billing defaults
  DELETE FROM field_billing_defaults WHERE field_id = v_field_id;

  IF jsonb_array_length(p_billing_defaults) > 0 THEN
    INSERT INTO field_billing_defaults (
      field_id, customer_id, split_pct, is_primary, notes,
      price_override_cents, pricing_note
    )
    SELECT
      v_field_id,
      (elem->>'customer_id')::uuid,
      (elem->>'split_pct')::numeric,
      COALESCE((elem->>'is_primary')::boolean, false),
      elem->>'notes',
      (elem->>'price_override_cents')::bigint,
      elem->>'pricing_note'
    FROM jsonb_array_elements(p_billing_defaults) AS elem;
  END IF;

  -- Log activity
  IF p_performed_by IS NOT NULL THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES ('field_saved', 'Field saved: ' || (p_field_payload->>'field_name'), p_performed_by, 'field', v_field_id);
  END IF;

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field', jsonb_build_object('field_id', v_field_id));
  END IF;

  RETURN v_field_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_field(uuid, jsonb, jsonb, uuid, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. save_field_geometry (uuid, text, text) → add p_idempotency_key
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.save_field_geometry(uuid, text, text);

CREATE OR REPLACE FUNCTION public.save_field_geometry(
  p_field_id uuid,
  p_centroid_geojson text DEFAULT NULL,
  p_boundary_geojson text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_existing jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field_geometry');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  UPDATE fields SET
    centroid = CASE
      WHEN p_centroid_geojson IS NOT NULL THEN ST_GeogFromGeoJSON(p_centroid_geojson)
      ELSE centroid
    END,
    boundary = CASE
      WHEN p_boundary_geojson IS NOT NULL THEN ST_GeogFromGeoJSON(p_boundary_geojson)
      ELSE boundary
    END,
    updated_at = now()
  WHERE id = p_field_id;

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_geometry', '{}'::jsonb);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_field_geometry(uuid, text, text, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_update_profile → add p_idempotency_key
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_update_profile(uuid, text, text, text, boolean, text[]);

CREATE OR REPLACE FUNCTION public.admin_update_profile(
  target_user_id uuid,
  new_role text DEFAULT NULL,
  new_full_name text DEFAULT NULL,
  new_phone text DEFAULT NULL,
  new_is_active boolean DEFAULT NULL,
  new_denied_pages text[] DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  caller_role text;
  caller_active boolean;
  updated_count int;
  v_final_role text;
  v_existing jsonb;
BEGIN
  PERFORM require_admin();

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'admin_update_profile');
    IF v_existing IS NOT NULL THEN RETURN v_existing::json; END IF;
  END IF;

  -- Verify caller is an ACTIVE admin
  SELECT role, is_active INTO caller_role, caller_active
  FROM profiles WHERE id = (SELECT auth.uid());

  IF caller_role IS NULL OR caller_role != 'admin' OR caller_active != true THEN
    RETURN json_build_object('error', 'Active admin access required');
  END IF;

  -- Validate role if provided
  IF new_role IS NOT NULL AND new_role NOT IN ('admin', 'sales_rep', 'driver', 'applicator') THEN
    RETURN json_build_object('error', 'Invalid role. Must be admin, sales_rep, driver, or applicator');
  END IF;

  -- Determine the final role
  IF new_role IS NOT NULL THEN
    v_final_role := new_role;
  ELSE
    SELECT role INTO v_final_role FROM profiles WHERE id = target_user_id;
  END IF;

  -- Admins never have denied pages
  IF v_final_role = 'admin' AND new_denied_pages IS NOT NULL THEN
    new_denied_pages := '{}';
  END IF;

  -- Update profile
  UPDATE profiles SET
    role = COALESCE(new_role, role),
    full_name = COALESCE(new_full_name, full_name),
    phone = COALESCE(new_phone, phone),
    is_active = COALESCE(new_is_active, is_active),
    denied_pages = COALESCE(new_denied_pages, denied_pages),
    updated_at = now()
  WHERE id = target_user_id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  IF updated_count = 0 THEN
    RETURN json_build_object('error', 'User not found');
  END IF;

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'admin_update_profile', '{"success": true}'::jsonb);
  END IF;

  RETURN json_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text[], text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. void_order (uuid, uuid, text) → add p_idempotency_key
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.void_order(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.void_order(
  p_order_id uuid,
  p_performed_by uuid,
  p_reason text DEFAULT 'Voided by admin',
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_order               record;
  v_item                record;
  v_invoice             record;
  v_admin               record;
  v_inventory_restored  integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions    integer := 0;
  v_draft_voided        integer := 0;
  v_posted_notified     integer := 0;
  v_existing            jsonb;
  v_result              jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Lock and fetch order
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status != 'fulfilled' THEN
    RAISE EXCEPTION 'void_order only applies to fulfilled orders. This order is %', v_order.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can void orders';
  END IF;

  -- Set order status to voided
  UPDATE public.orders
    SET status     = 'voided',
        updated_at = now()
  WHERE id = p_order_id;

  -- Restore quantity_available for all delivered items
  FOR v_item IN
    SELECT product_id, quantity_delivered
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(quantity_delivered, 0) > 0
  LOOP
    UPDATE public.inventory
      SET quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at         = now()
    WHERE product_id = v_item.product_id
      AND location   = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id,
      'adjusted',
      v_item.quantity_delivered,
      'Main Warehouse',
      p_order_id,
      p_performed_by,
      'Restored ' || v_item.quantity_delivered || ' units — order ' ||
        v_order.order_number || ' voided. Reason: ' || p_reason
    );

    v_inventory_restored := v_inventory_restored + 1;
  END LOOP;

  -- Cancel pending commissions
  UPDATE public.commissions
    SET status            = 'cancelled',
        commission_amount = 0
  WHERE order_id = p_order_id
    AND status   = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions
  WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id, title, message,
        notification_type, related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Voided Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was voided but has ' ||
          v_paid_commissions || ' paid commission(s). Manual review required.',
        'void_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  -- Void draft invoices, notify about posted ones
  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id   = p_order_id
      AND deleted_at IS NULL
      AND status     IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      UPDATE public.invoices
        SET status              = 'voided',
            voided_by           = p_performed_by,
            voided_at           = now(),
            void_reason         = 'Order ' || v_order.order_number || ' voided. ' || p_reason,
            balance_cents       = 0,
            updated_at          = now()
      WHERE id = v_invoice.id;

      INSERT INTO public.financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_voided', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'voided', 'void_reason', 'Order voided'),
        -1 * v_invoice.total_amount_cents,
        'Auto-voided draft invoice ' || v_invoice.invoice_number ||
          ' — order ' || v_order.order_number || ' voided'
      );

      v_draft_voided := v_draft_voided + 1;

    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (
          user_id, title, message,
          notification_type, related_entity_type, related_entity_id
        ) VALUES (
          v_admin.id,
          'Voided Order — Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' was voided. Invoice ' ||
            v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'void_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  -- Audit log entry
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_voided', 'order', p_order_id, 'admin',
    jsonb_build_object('status', 'fulfilled', 'total_price', v_order.total_price),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -1 * ROUND(v_order.total_price * 100)::bigint,
    'Order ' || v_order.order_number || ' voided. Reason: ' || p_reason
  );

  -- Activity feed
  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_voided',
    'Order ' || v_order.order_number || ' voided. ' ||
      v_inventory_restored || ' product(s) inventory restored. ' ||
      v_commissions_cancelled || ' commission(s) cancelled. ' ||
      v_draft_voided || ' draft invoice(s) voided.' ||
      CASE WHEN v_posted_notified > 0
           THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.'
           ELSE '' END ||
      CASE WHEN v_paid_commissions > 0
           THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.'
           ELSE '' END ||
      ' Reason: ' || p_reason,
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status',                    'voided',
    'order_number',              v_order.order_number,
    'inventory_products_restored', v_inventory_restored,
    'commissions_cancelled',     v_commissions_cancelled,
    'paid_commissions_flagged',  v_paid_commissions,
    'draft_invoices_voided',     v_draft_voided,
    'posted_invoices_flagged',   v_posted_notified
  );

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_order(uuid, uuid, text, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. load_recipe_into_job (uuid, uuid) → add p_idempotency_key
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.load_recipe_into_job(uuid, uuid);

CREATE OR REPLACE FUNCTION public.load_recipe_into_job(
  p_job_id uuid,
  p_recipe_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_count integer := 0;
  v_item RECORD;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'load_recipe_into_job');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jobs WHERE id = p_job_id AND status IN ('scheduled', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'Job not found or not editable';
  END IF;

  DELETE FROM job_chemicals WHERE job_id = p_job_id;

  FOR v_item IN
    SELECT bri.*, p.cost_per_unit, p.unit AS product_unit
    FROM blend_recipe_items bri
    JOIN products p ON p.id = bri.product_id
    WHERE bri.recipe_id = p_recipe_id
    ORDER BY bri.sequence_order
  LOOP
    INSERT INTO job_chemicals (
      job_id, product_id, quantity, unit,
      rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents,
      sort_order
    ) VALUES (
      p_job_id,
      v_item.product_id,
      v_item.quantity,
      v_item.unit,
      v_item.rate_per_acre,
      v_item.rate_unit,
      COALESCE(v_item.cost_per_unit * 100, 0)::bigint,
      0,
      v_item.sequence_order
    );
    v_count := v_count + 1;
  END LOOP;

  UPDATE jobs SET recipe_id = p_recipe_id WHERE id = p_job_id;

  v_result := jsonb_build_object('success', true, 'items_loaded', v_count);

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'load_recipe_into_job', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.load_recipe_into_job(uuid, uuid, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification: ensure no overloads were created
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_func text;
  v_count integer;
BEGIN
  FOREACH v_func IN ARRAY ARRAY[
    'save_field', 'save_field_geometry', 'admin_update_profile',
    'void_order', 'load_recipe_into_job'
  ] LOOP
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = v_func;

    IF v_count != 1 THEN
      RAISE EXCEPTION 'OVERLOAD DETECTED: % has % versions (expected 1)', v_func, v_count;
    END IF;
  END LOOP;

  RAISE NOTICE 'Verification passed: all 5 functions have exactly 1 version';
END;
$$;
