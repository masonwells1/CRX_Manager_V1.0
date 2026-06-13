-- Roadmap #2 (sell-side) — ship-now / price-later — v1b: create_rush_order
-- ============================================================================
-- sql-safety: exempt-registry — orders.pricing_status + order_items.pricing_pending
-- are added by the SIBLING file-only migration 20260613170000 (#2 v1a, same
-- branch, intentionally NOT yet applied to live), so the live-derived schema
-- registry can't know them until the G5 apply. order_items.suggested_price is
-- added by THIS migration (ALTER below) before any INSERT references it. No
-- unknown-column risk — these all exist in the branch's migration set.
--
-- FILE-ONLY (NOT applied — apply at G5 with v1a 20260613170000). The producer
-- the v1a gate was shipped ahead of: create an order that is shipped/confirmed
-- but NOT yet priced. Pairs with the PRICING_INCOMPLETE posting gate (v1a) so an
-- unpriced rush order's invoice can be created but never POSTED until price_order
-- (v2) finalizes it.
--
-- Behavior (modeled on create_direct_order, with the rush deltas):
--   • canonical strict-actor (AUTH_REQUIRED / ACTOR_MISMATCH via IS DISTINCT FROM)
--   • roles admin/sales_rep/driver/applicator (BROADER than create_direct_order's
--     admin/sales_rep — field staff create rush orders) → INSUFFICIENT_ROLE else
--   • order: status='confirmed', pricing_status='needs_pricing', all $ totals 0,
--     order_date = CURRENT_DATE (the ship date; G3=price-month means the INVOICE
--     date is set later by price_order, not here)
--   • items {product_id, qty}: price_per_unit/cost_per_unit/total_price/profit 0,
--     pricing_pending=true, total_units_needed=qty; tier price SNAPSHOT into
--     order_items.suggested_price (per customer.assigned_tier) for the v2 pricing
--     screen; cost_at_time_cents auto-snapshots via trg_snapshot_order_item_cost
--   • prebook each item (inventory.quantity_prebooked += qty + 'booked' txn) —
--     WARN on short net-position, NEVER block (rush ships regardless)
--   • NO commissions yet (deferred to price_order on the FINAL profit, v2)
--   • audit order_created (needs-pricing) to activity_feed
--   • idempotency + search_path=public,pg_temp; ACL mirrors create_direct_order
--     (authenticated + service_role; no anon)
--
-- Tokens raised are already registered in RpcErrorCodes (AUTH_REQUIRED,
-- ACTOR_MISMATCH, INSUFFICIENT_ROLE, ITEMS_REQUIRED). Reviewed: rls + drift +
-- types (codex=PENDING → pre-G5 batch per the plan amendment). Rolled-back smoke:
-- docs/roadmap/smoke/02b-create-rush-order.sql.
--
-- DEFERRED to v1c (UI slice): the create-rush-order button, the Orders nav
-- needs_pricing count badge, and rep notification (frontend notificationTriggers,
-- matching the codebase convention — create_direct_order also notifies UI-side).

-- Snapshot column for the locked-at-ship tier price (v2 pricing-screen default).
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS suggested_price numeric;

CREATE OR REPLACE FUNCTION public.create_rush_order(
  p_customer_id uuid,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_notes text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid;
  v_actor_role  text;
  v_order_id    uuid;
  v_order_number text;
  v_item        jsonb;
  v_customer    record;
  v_product     record;
  v_cached      jsonb;
  v_result      jsonb;
  v_inv         record;
  v_warnings    text[] := '{}';
  v_qty         numeric;
  v_net_position numeric;
  v_tier        int;
  v_item_count  int := 0;
BEGIN
  -- ── canonical strict-actor ────────────────────────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin','sales_rep','driver','applicator') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_rush_order');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  SELECT count(*) INTO v_item_count
  FROM jsonb_array_elements(p_items) e
  WHERE (e->>'product_id') IS NOT NULL
    AND COALESCE((e->>'qty')::numeric, (e->>'quantity')::numeric, 0) > 0;
  IF v_item_count = 0 THEN RAISE EXCEPTION 'ITEMS_REQUIRED'; END IF;

  v_order_number := generate_order_number();

  INSERT INTO orders (
    order_number, customer_id, status, pricing_status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes
  ) VALUES (
    v_order_number, p_customer_id, 'confirmed', 'needs_pricing',
    0, 0, 0, 0,
    CURRENT_DATE,
    NULLIF(TRIM(COALESCE(p_notes, '')), '')
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN CONTINUE; END IF;
    v_qty := COALESCE((v_item->>'qty')::numeric, (v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT
      product_name,
      unit_size,
      CASE v_tier WHEN 2 THEN tier2_price WHEN 3 THEN tier3_price ELSE tier1_price END AS tier_price
      INTO v_product
      FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found: %', (v_item->>'product_id'); END IF;

    -- inventory warning (prebook never blocks)
    SELECT * INTO v_inv FROM inventory
      WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      v_warnings := array_append(v_warnings,
        v_product.product_name || ': need ' || v_qty || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_warnings := array_append(v_warnings,
          v_product.product_name || ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;

    -- unpriced line: $ all 0 + pending; tier price snapshot for v2 pricing screen
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining,
      pricing_pending, suggested_price
    ) VALUES (
      v_order_id, (v_item->>'product_id')::uuid, v_product.product_name,
      0, 0,
      v_qty, v_product.unit_size,
      0, 0, 0,
      0, v_qty,
      true, v_product.tier_price
    );

    -- prebook (WARN never block)
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_qty,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES ((v_item->>'product_id')::uuid, 'Main Warehouse', 0, v_qty, 0, v_product.unit_size);
    END IF;
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location, order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', v_qty, 'Main Warehouse', v_order_id, v_actor,
      'Pre-booked for rush order ' || v_order_number || ' (needs pricing)'
    );
  END LOOP;

  -- NO commissions yet — price_order (v2) inserts them on the FINAL profit.

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Rush order ' || v_order_number || ' created for ' || COALESCE(v_customer.farm_name, 'customer') ||
    ' — NEEDS PRICING' ||
    CASE WHEN array_length(v_warnings, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'created', 'order_id', v_order_id, 'order_number', v_order_number,
    'pricing_status', 'needs_pricing', 'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_rush_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ACL mirrors create_direct_order (authenticated + service_role; no anon/PUBLIC).
-- caller-analysis: create_rush_order :: new RPC; authenticated callers (admin/sales_rep/driver/applicator) are gated in-body via INSUFFICIENT_ROLE; REVOKE anon/PUBLIC + GRANT authenticated/service_role exactly mirrors the live create_direct_order ACL; UI caller lands in v1c
REVOKE EXECUTE ON FUNCTION public.create_rush_order(uuid, jsonb, text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_rush_order(uuid, jsonb, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_rush_order(uuid, jsonb, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_rush_order(uuid, jsonb, text, uuid, text) TO service_role;
