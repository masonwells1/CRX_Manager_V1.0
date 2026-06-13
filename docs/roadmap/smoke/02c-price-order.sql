-- Roadmap #2 v2 — price_order — rolled-back smoke proof (the #2 done-criteria chain)
-- ----------------------------------------------------------------------------
-- Full chain: rush order (needs_pricing) → its draft invoice CANNOT post
-- (PRICING_INCOMPLETE) → price_order finalizes → invoice posts. POST-APPLY
-- rolled-back: at G5 apply 20260613170000 + 180000 + 190000, THEN run this; it
-- creates real rows and RAISEs to roll them all back (zero footprint, safe on
-- prod). Impersonates an active admin via the JWT claim.
--   P1 create_rush_order            -> order needs_pricing, item pending+price0
--   P2 post the draft invoice       -> PRICING_INCOMPLETE (v1a gate)
--   P3 price_order([{item, price}]) -> order priced; item priced+not-pending;
--      commissions inserted; invoice swept (extended_cents>0, invoice_date today,
--      pricing_pending cleared, total recomputed)
--   P4 post the now-priced invoice  -> posts (status='posted')
--
-- NOTE (2026-06-13): build-loop Supabase MCP is READ-ONLY → not run live here;
-- verified by rls + drift reviewers (codex=PENDING per the pre-G5 batch policy).
-- generate_order_number()/next_invoice_number() may advance non-rollback
-- sequences (consumed numbers) — benign.

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  v_prod  uuid := (SELECT id FROM products LIMIT 1);
  r jsonb; out text := '';
  v_oid uuid; v_item_id uuid; v_inv_id uuid;
  v_ord record; v_oi record; v_inv record; v_comm int; v_caught text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- P1: rush order
  r := create_rush_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 10)), 'smoke price chain', v_admin, NULL);
  v_oid := (r->>'order_id')::uuid;
  SELECT id INTO v_item_id FROM order_items WHERE order_id = v_oid LIMIT 1;
  -- a draft invoice from the unpriced order (pricing_pending), with a $0 line
  INSERT INTO invoices (customer_id, order_id, status, pricing_pending) VALUES (v_cust, v_oid, 'draft', true) RETURNING id INTO v_inv_id;
  INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents)
    VALUES (v_inv_id, v_item_id, v_prod, 'smoke line', 10, 0, 0, 0);
  out := out || format('P1 rush: pricing=%s item_pending=%s -> %s | ',
    (SELECT pricing_status FROM orders WHERE id=v_oid),
    (SELECT pricing_pending FROM order_items WHERE id=v_item_id),
    CASE WHEN (SELECT pricing_status FROM orders WHERE id=v_oid)='needs_pricing' THEN 'PASS' ELSE 'FAIL' END);

  -- P2: posting the draft invoice is blocked
  BEGIN PERFORM post_invoice(v_inv_id, NULL); v_caught := 'NO-EXCEPTION';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P2 post-blocked: "%s" -> %s | ', left(v_caught,20),
    CASE WHEN v_caught='PRICING_INCOMPLETE' THEN 'PASS' ELSE 'FAIL' END);

  -- P3: price the order at $25/unit
  r := price_order(v_oid, jsonb_build_array(jsonb_build_object('order_item_id', v_item_id, 'price', 25)), v_admin, NULL);
  SELECT * INTO v_ord FROM orders WHERE id=v_oid;
  SELECT * INTO v_oi FROM order_items WHERE id=v_item_id;
  SELECT * INTO v_inv FROM invoices WHERE id=v_inv_id;
  SELECT count(*) INTO v_comm FROM commissions WHERE order_id=v_oid;
  out := out || format('P3 price: ord.pricing=%s item.price=%s item.pending=%s ord.profit=%s comm=%s inv.ext=%s inv.total=%s inv.cost=%s inv.pending=%s inv.date=%s -> %s | ',
    v_ord.pricing_status, v_oi.price_per_unit, v_oi.pricing_pending, v_ord.total_profit, v_comm,
    (SELECT extended_cents FROM invoice_items WHERE invoice_id=v_inv_id LIMIT 1), v_inv.total_amount_cents, v_inv.total_cost_cents, v_inv.pricing_pending, v_inv.invoice_date,
    CASE WHEN v_ord.pricing_status='priced' AND v_oi.price_per_unit=25 AND v_oi.pricing_pending IS FALSE
          AND v_inv.pricing_pending IS FALSE AND v_inv.total_amount_cents=25000 AND v_inv.invoice_date=CURRENT_DATE
          -- Codex P1 cost fix: invoice_items.cost_cents is PER-UNIT and the header
          -- total_cost_cents = SUM(cost_cents*quantity) (consistency, exact value
          -- depends on the product's snapshot cost which the smoke doesn't pin).
          AND (SELECT cost_cents FROM invoice_items WHERE invoice_id=v_inv_id LIMIT 1) = round(v_oi.cost_per_unit * 100)::bigint
          AND v_inv.total_cost_cents = COALESCE((SELECT round(sum(cost_cents * quantity))::bigint FROM invoice_items WHERE invoice_id=v_inv_id), 0)
         THEN 'PASS' ELSE 'FAIL' END);

  -- P4: now the invoice posts
  BEGIN PERFORM post_invoice(v_inv_id, NULL); v_caught := 'POSTED'; EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P4 post-ok: "%s" inv.status=%s -> %s',
    left(v_caught,20), (SELECT status FROM invoices WHERE id=v_inv_id),
    CASE WHEN (SELECT status FROM invoices WHERE id=v_inv_id)='posted' THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
