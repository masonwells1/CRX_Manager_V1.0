-- Roadmap #4 W5 — create_invoice_from_order delivery guard — rolled-back smoke
-- ----------------------------------------------------------------------------
-- POST-APPLY rolled-back: at G5 apply 20260613210000, THEN run this; it creates
-- test orders/deliveries, exercises the guard, and RAISEs to roll everything back
-- (zero footprint, safe on prod). Impersonates an active admin via the JWT claim.
--   P1  order with a SCHEDULED delivery -> create_invoice_from_order BLOCKED (active delivery)
--   P2  order with NO deliveries        -> succeeds (draft invoice created)
--   P3  order with only a CANCELLED delivery -> succeeds (cancelled excluded)
--
-- NOTE (2026-06-13): build-loop Supabase MCP is READ-ONLY → not run live here;
-- verified by rls + drift reviewers (codex=PENDING per the pre-G5 batch policy).
-- next_invoice_number()/generate_order_number() may advance non-rollback sequences.

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  o1 uuid; o2 uuid; o3 uuid; v_inv uuid; v_caught text; out text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- P1: order + scheduled delivery -> blocked
  INSERT INTO orders (order_number, customer_id, status) VALUES ('SMOKE-W5-A', v_cust, 'confirmed') RETURNING id INTO o1;
  INSERT INTO deliveries (delivery_number, order_id, customer_id, created_by, status)
    VALUES ('SMOKE-DLV-A', o1, v_cust, v_admin, 'scheduled');
  BEGIN
    v_inv := create_invoice_from_order(o1, NULL, 'chemical_sale', NULL); v_caught := 'NO-EXCEPTION';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P1 scheduled-delivery: "%s" -> %s | ', left(v_caught,45),
    CASE WHEN v_caught ILIKE '%active delivery%' THEN 'PASS' ELSE 'FAIL' END);

  -- P2: order with no deliveries -> succeeds
  INSERT INTO orders (order_number, customer_id, status) VALUES ('SMOKE-W5-B', v_cust, 'confirmed') RETURNING id INTO o2;
  BEGIN
    v_inv := create_invoice_from_order(o2, NULL, 'chemical_sale', NULL); v_caught := 'OK';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P2 no-delivery: "%s" invoice=%s -> %s | ', left(v_caught,30), v_inv IS NOT NULL,
    CASE WHEN v_caught='OK' AND v_inv IS NOT NULL AND EXISTS(SELECT 1 FROM invoices WHERE id=v_inv AND status='draft') THEN 'PASS' ELSE 'FAIL' END);

  -- P3: order with only a cancelled delivery -> succeeds (cancelled excluded)
  v_inv := NULL;
  INSERT INTO orders (order_number, customer_id, status) VALUES ('SMOKE-W5-C', v_cust, 'confirmed') RETURNING id INTO o3;
  INSERT INTO deliveries (delivery_number, order_id, customer_id, created_by, status)
    VALUES ('SMOKE-DLV-C', o3, v_cust, v_admin, 'cancelled');
  BEGIN
    v_inv := create_invoice_from_order(o3, NULL, 'chemical_sale', NULL); v_caught := 'OK';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P3 cancelled-delivery: "%s" invoice=%s -> %s', left(v_caught,30), v_inv IS NOT NULL,
    CASE WHEN v_caught='OK' AND v_inv IS NOT NULL THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
