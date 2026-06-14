-- Roadmap #2 (sell-side) — ship-now / price-later — v2: price_order
-- ============================================================================
-- sql-safety: exempt-registry — orders.pricing_status, order_items.pricing_pending,
-- order_items.suggested_price, invoices.pricing_pending are added by sibling
-- FILE-ONLY migrations 20260613170000 (v1a) + 20260613180000 (v1b), same branch,
-- not yet applied to live; the live-derived schema registry can't know them until
-- the G5 apply. No unknown-column risk — all exist in the branch's migration set.
--
-- FILE-ONLY (NOT applied — apply at G5 AFTER 20260613170000 + 20260613180000).
-- Completes the ship-now/price-later loop: finalize the price of a rush order so
-- its invoice can post. MONEY-CRITICAL.
--
-- price_order(p_order_id, p_items[{order_item_id, price}], p_performed_by, p_idem):
--   • canonical strict-actor; roles admin/sales_rep (pricing is a sales decision)
--   • FOR UPDATE the order; price-only — never touches qty, so it is unaffected
--     by the (UI-only) fulfillment edit-lock; there is NO DB write-lock on
--     order_items, so no override is needed
--   • per item: price_per_unit = given price; cost_per_unit = cost_at_time_cents
--     snapshot (cents→dollars); recompute total_price/profit/net_margin;
--     pricing_pending=false. trg_recalc_order_totals auto-recomputes order totals
--   • when NO order line remains pending → orders.pricing_status='priced' (not a
--     trigger-gated column) AND, only on the needs_pricing→priced transition,
--     insert the DEFERRED commissions on the FINAL recomputed profit
--   • sweep linked DRAFT/UNPOSTED invoices to the now-known prices: invoice_items
--     unit_price_cents/extended_cents/cost_cents (dollars→cents, round), recompute
--     invoices.total_amount_cents (no invoice_items totals trigger exists),
--     invoice_date = CURRENT_DATE (G3 = PRICE-MONTH), pricing_pending=false
--   • audit order_priced; idempotency + search_path; tokens in RpcErrorCodes
--
-- Reviewed: rls + drift + types (codex=PENDING → pre-G5 batch). Rolled-back smoke
-- (post-apply): docs/roadmap/smoke/02c-price-order.sql.

CREATE OR REPLACE FUNCTION public.price_order(
  p_order_id uuid,
  p_items jsonb DEFAULT '[]'::jsonb,
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
  v_order       record;
  v_cached      jsonb;
  v_result      jsonb;
  v_item        jsonb;
  v_oi          record;
  v_price       numeric;
  v_cost        numeric;
  v_remaining   int;
  v_was_pending boolean;
  v_total_profit numeric;
  v_customer    record;
  v_inv         record;
  v_swept       int := 0;
BEGIN
  -- ── canonical strict-actor + role gate ────────────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin','sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'price_order');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  -- Terminal-order guard (Codex round 2 P1): a cancelled/voided/deleted rush order
  -- still carries pricing_status='needs_pricing' (the cancel/void RPCs don't clear
  -- it), so without this check price_order would price it and create commissions
  -- for a dead order. Reject terminal orders before any mutation.
  IF v_order.status IN ('cancelled', 'voided') OR v_order.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_ACTIVE';
  END IF;
  -- State guard (Codex P1): only an unpriced order may be priced. Once an order
  -- is finalized to 'priced', reject re-pricing — a stale second tab would
  -- otherwise update prices/totals while the v_was_pending-gated invoice +
  -- commission refresh is skipped, desyncing the financial records. A partially
  -- priced order stays 'needs_pricing' (the flip to 'priced' only happens when no
  -- line remains pending), so legitimate multi-call pricing still passes here.
  IF v_order.pricing_status IS DISTINCT FROM 'needs_pricing' THEN
    RAISE EXCEPTION 'ALREADY_PRICED';
  END IF;
  v_was_pending := true;

  -- ── price each provided line (price-only) ─────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'order_item_id') IS NULL THEN CONTINUE; END IF;
    v_price := COALESCE((v_item->>'price')::numeric, 0);
    IF v_price < 0 THEN RAISE EXCEPTION 'INVALID_PRICE'; END IF;
    SELECT * INTO v_oi FROM order_items
      WHERE id = (v_item->>'order_item_id')::uuid AND order_id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NOT_FOUND'; END IF;
    v_cost := COALESCE(v_oi.cost_at_time_cents, 0) / 100.0;  -- snapshot cost (cents→dollars)
    UPDATE order_items SET
      price_per_unit  = v_price,
      cost_per_unit   = v_cost,
      total_price     = v_price * total_units_needed,
      profit          = (v_price - v_cost) * total_units_needed,
      net_margin      = CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price) * 100 ELSE 0 END,
      pricing_pending = false
    WHERE id = v_oi.id;
  END LOOP;

  -- ── any lines still pending? ──────────────────────────────────────────────
  SELECT count(*) INTO v_remaining
  FROM order_items WHERE order_id = p_order_id AND pricing_pending = true;

  IF v_remaining = 0 THEN
    -- pricing_status is NOT a trigger-gated column (enforce_order_status_transition
    -- is BEFORE UPDATE OF status only) — a plain UPDATE is safe.
    UPDATE orders SET pricing_status = 'priced', updated_at = now() WHERE id = p_order_id;

    -- deferred commissions on the FINAL profit, only on the needs_pricing→priced
    -- transition (re-read total_profit after trg_recalc_order_totals ran).
    IF v_was_pending THEN
      SELECT * INTO v_customer FROM customers WHERE id = v_order.customer_id;
      SELECT total_profit INTO v_total_profit FROM orders WHERE id = p_order_id;
      PERFORM _insert_commissions_for_order(
        p_order_id, v_order.customer_id, v_total_profit,
        v_customer.default_commission_split, v_order.order_date
      );

      -- sweep linked DRAFT/UNPOSTED invoices to the now-known prices — gated on
      -- v_was_pending (the needs_pricing→priced transition) so a redundant re-call
      -- on an already-priced order never re-sweeps or re-dates a draft invoice.
      FOR v_inv IN SELECT * FROM invoices
                 WHERE order_id = p_order_id AND status IN ('draft','unposted') FOR UPDATE
    LOOP
      -- cost_cents is PER-UNIT by convention (create_invoice_from_delivery:
      -- total_cost_cents = SUM(cost_cents * quantity)). Codex P1: write per-unit
      -- cost, NOT the line total, or total_cost_cents double-counts quantity.
      UPDATE invoice_items ii SET
        unit_price_cents = round(oi.price_per_unit * 100)::bigint,
        extended_cents   = round(oi.price_per_unit * ii.quantity * 100)::bigint,
        cost_cents       = round(oi.cost_per_unit * 100)::bigint
      FROM order_items oi
      WHERE ii.invoice_id = v_inv.id AND ii.order_item_id = oi.id;

      -- Recompute BOTH header money columns (Codex P1: total_cost_cents was left
      -- at 0/stale → wrong posted margin + month-end profit). total_cost_cents
      -- mirrors the create_invoice_from_delivery convention SUM(cost_cents*qty).
      UPDATE invoices SET
        total_amount_cents = COALESCE((SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_inv.id), 0),
        total_cost_cents   = COALESCE((SELECT round(sum(cost_cents * quantity))::bigint FROM invoice_items WHERE invoice_id = v_inv.id), 0),
        invoice_date       = CURRENT_DATE,   -- G3: PRICE-MONTH
        pricing_pending    = false,
        updated_at         = now()
      WHERE id = v_inv.id;
      v_swept := v_swept + 1;
    END LOOP;
    END IF;  -- close v_was_pending (commissions + invoice sweep)
  END IF;  -- close v_remaining = 0

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_priced',
    'Priced order ' || v_order.order_number ||
    CASE WHEN v_remaining = 0 THEN ' — fully priced' ELSE ' — ' || v_remaining || ' line(s) still pending' END,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'pricing_status', CASE WHEN v_remaining = 0 THEN 'priced' ELSE 'needs_pricing' END,
    'remaining_pending', v_remaining,
    'invoices_swept', v_swept
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'price_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ACL mirrors create_direct_order / create_rush_order (authenticated + service_role).
-- caller-analysis: price_order :: new RPC; authenticated admin/sales_rep gated in-body via INSUFFICIENT_ROLE; money-critical pricing of a rush order + invoice sweep; REVOKE anon/PUBLIC + GRANT authenticated/service_role mirrors create_direct_order ACL; UI caller (pricing screen) lands in the v2 UI slice
REVOKE EXECUTE ON FUNCTION public.price_order(uuid, jsonb, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.price_order(uuid, jsonb, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.price_order(uuid, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.price_order(uuid, jsonb, uuid, text) TO service_role;
