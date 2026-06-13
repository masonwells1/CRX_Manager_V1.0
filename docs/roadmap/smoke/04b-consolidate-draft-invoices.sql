-- Roadmap #4(b) — consolidate_draft_invoices — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- POST-APPLY rolled-back: at G5 apply 20260613220000, THEN run this; it creates
-- an order with 2 draft invoices, merges them, and RAISEs to roll back (zero
-- footprint). Runs as an admin via the JWT claim.
--   P1  2 draft invoices (items 2000c + 3000c) -> consolidated; survivor holds both
--       items (total 5000c); the other draft cancelled; merged_count=1.
--   P2  re-run -> only 1 draft remains -> no-op (consolidated=false).
--
-- NOTE (2026-06-13): build-loop Supabase MCP is READ-ONLY → not run live here;
-- verified by rls + drift reviewers (codex=PENDING per the pre-G5 batch policy).

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  v_prod  uuid := (SELECT id FROM products LIMIT 1);
  o1 uuid; inv1 uuid; inv2 uuid; r jsonb; out text := '';
  v_surv uuid; v_items int; v_total bigint; v_other_status text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO orders (order_number, customer_id, status) VALUES ('SMOKE-CONS', v_cust, 'confirmed') RETURNING id INTO o1;
  INSERT INTO invoices (customer_id, order_id, status, invoice_type) VALUES (v_cust, o1, 'draft', 'chemical_sale') RETURNING id INTO inv1;
  INSERT INTO invoices (customer_id, order_id, status, invoice_type) VALUES (v_cust, o1, 'draft', 'chemical_sale') RETURNING id INTO inv2;
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES (inv1, v_prod, 'a', 2, 1000, 2000, 0);
  INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES (inv2, v_prod, 'b', 3, 1000, 3000, 0);

  r := consolidate_draft_invoices(o1, v_admin, NULL);
  v_surv := (r->>'surviving_invoice_id')::uuid;
  SELECT count(*) INTO v_items FROM invoice_items WHERE invoice_id = v_surv;
  SELECT total_amount_cents INTO v_total FROM invoices WHERE id = v_surv;
  SELECT status INTO v_other_status FROM invoices WHERE id = CASE WHEN v_surv = inv1 THEN inv2 ELSE inv1 END;
  out := out || format('P1 consolidate: consolidated=%s merged=%s surv_items=%s surv_total=%s other=%s -> %s | ',
    r->>'consolidated', r->>'merged_count', v_items, v_total, v_other_status,
    CASE WHEN (r->>'consolidated')='true' AND (r->>'merged_count')='1' AND v_items=2 AND v_total=5000 AND v_other_status='cancelled'
         THEN 'PASS' ELSE 'FAIL' END);

  r := consolidate_draft_invoices(o1, v_admin, NULL);
  out := out || format('P2 noop: consolidated=%s -> %s',
    r->>'consolidated', CASE WHEN (r->>'consolidated')='false' THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
