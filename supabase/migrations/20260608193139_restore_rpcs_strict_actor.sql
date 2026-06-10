-- Migration: restore RPCs — strict-actor on restore_cancelled_* + operation-scoped
--   idempotency on restore_quote_version
--   (Codex cross-review of 2026-06-08 batch — 1 HIGH + 1 LOW)
--
-- Follow-up to 20260608174251_restore_rpcs_admin_override (already live). That
-- migration bracketed the status writes but DEFERRED the actor model on the two
-- restore_cancelled_* functions as "attribution-only / out-of-scope". Codex's
-- independent review showed that deferral was wrong, and a live read-only check
-- confirmed it:
--
--   HIGH — restore_cancelled_order / restore_cancelled_delivery are SECURITY DEFINER,
--   EXECUTE-granted to `authenticated`, and authorize off COALESCE(p_performed_by,
--   auth.uid()) then gate on THAT (caller-supplied) actor's role = 'admin'. So any
--   logged-in lower-role user (e.g. a `driver`/`applicator`) can read an active admin's
--   id from profile_public_view, pass it as p_performed_by, and DIRECTLY (via PostgREST —
--   the functions have no UI caller, but the grant is all that matters) restore a
--   cancelled order/delivery while logging the forged admin as the actor. This is a
--   privilege-escalation + actor-forgery hole, same class as 20260531151134 /
--   20260608152631. (Verified live: secdef=true, acl includes authenticated=X.)
--
-- Fix (HIGH): replace the COALESCE actor with the canonical strict-actor block —
--   derive the actor from auth.uid(), reject a forged p_performed_by (ACTOR_MISMATCH),
--   require an ACTIVE admin (INSUFFICIENT_ROLE). The authorization SCOPE is unchanged
--   (still admin-only). audit/activity rows already log v_actor, which is now the real
--   caller. No UI caller exists, so no legit call is affected (a service_role/backend
--   call — none exist per grep — would now correctly get AUTH_REQUIRED).
--
--   LOW — restore_quote_version's idempotency check matched idempotency_key WITHOUT an
--   operation filter (and returned a 'duplicate' status rather than a cached result), so
--   a direct caller reusing a key from a different operation could short-circuit a real
--   restore. Fix: scope the check to operation = 'restore_quote_version' (the value the
--   save path already writes). Return shape left as-is — its sole caller
--   (QuoteBuilder.tsx:1167) only calls assertRpcResult and ignores the fields, so this
--   is behaviour-preserving for the UI. Its strict-actor block (added 20260608174251)
--   is already correct and is reproduced unchanged.
--
-- All three bodies are reproduced VERBATIM from 20260608174251 (which Codex confirmed
-- hashes match live) EXCEPT the changes described above. No other logic / column /
-- return-shape / signature change. Single overload each (verified live).
--
-- idempotency-body-check: exempt  (inline idempotency_keys read/write)

-- ── restore_cancelled_order ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_cancelled_order(
  p_order_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_order    record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  -- Strict-actor admin guard (was COALESCE(p_performed_by, auth.uid()) gating on the
  -- caller-supplied actor's role — forgeable). Authorize the REAL caller only.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to restore a cancelled order';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'restore_cancelled_order';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_order
    FROM orders
   WHERE id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  IF v_order.status != 'cancelled' THEN
    RAISE EXCEPTION 'Only cancelled orders can be restored (current status: %)', v_order.status;
  END IF;

  -- Bracket the enforcer-forbidden cancelled->confirmed write with the admin override.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE orders SET
    status     = 'confirmed',
    updated_at = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.admin_override', 'false', true);

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'order_restored', 'order', p_order_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'cancelled'),
    jsonb_build_object('status', 'confirmed'),
    'Order ' || v_order.order_number || ' restored from cancelled to confirmed: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_restored',
    'Order ' || v_order.order_number || ' restored from cancelled to confirmed: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'order_id',      p_order_id,
    'order_number',  v_order.order_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'restore_cancelled_order', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- ── restore_cancelled_delivery ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_cancelled_delivery(
  p_delivery_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_delivery record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  -- Strict-actor admin guard (was COALESCE(p_performed_by, auth.uid()) gating on the
  -- caller-supplied actor's role — forgeable). Authorize the REAL caller only.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to restore a cancelled delivery';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'restore_cancelled_delivery';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_delivery
    FROM deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_delivery.status != 'cancelled' THEN
    RAISE EXCEPTION 'Only cancelled deliveries can be restored (current status: %)', v_delivery.status;
  END IF;

  -- Bracket the enforcer-forbidden cancelled->scheduled write with the admin override.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE deliveries SET
    status     = 'scheduled',
    updated_at = now()
  WHERE id = p_delivery_id;
  PERFORM set_config('app.admin_override', 'false', true);

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'delivery_restored', 'delivery', p_delivery_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'cancelled'),
    jsonb_build_object('status', 'scheduled'),
    'Delivery ' || v_delivery.delivery_number || ' restored from cancelled to scheduled: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_restored',
    'Delivery ' || v_delivery.delivery_number || ' restored from cancelled to scheduled: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'delivery_id',       p_delivery_id,
    'delivery_number',   v_delivery.delivery_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'restore_cancelled_delivery', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- ── restore_quote_version ───────────────────────────────────────────────────────
-- Strict-actor block UNCHANGED from 20260608174251 (already correct). Only the
-- idempotency check gains an `operation` filter (LOW).
CREATE OR REPLACE FUNCTION public.restore_quote_version(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
  v_actor uuid;
BEGIN
  -- Strict-actor auth (function previously had NO auth check). Before idempotency.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check — operation-scoped so a key minted for a different operation
  -- can't short-circuit a legitimate restore (was: matched idempotency_key alone).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'restore_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields. Bracket the status write with the admin override so
  -- the enforcer permits restore->revised from any source state (accepted/declined/etc.).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    total_price = (v_snapshot->'quote'->>'total_price')::numeric,
    total_cost = (v_snapshot->'quote'->>'total_cost')::numeric,
    total_profit = (v_snapshot->'quote'->>'total_profit')::numeric,
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes, needed_by_date)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      (v_section->>'needed_by_date')::date
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit
      )
      VALUES (
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        (v_item->>'profit')::numeric,
        (v_item->>'total_price')::numeric,
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit'
      );
    END LOOP;
  END LOOP;

  -- Save idempotency key (result stored as a valid jsonb object — was a bare ::text UUID).
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'restore_quote_version', jsonb_build_object('quote_id', p_quote_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$$;
