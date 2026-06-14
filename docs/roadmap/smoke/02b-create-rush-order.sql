-- Roadmap #2 v1b — create_rush_order — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- Proves migration 20260613180000. Because create_rush_order + its columns do
-- not exist until applied, this is a POST-APPLY rolled-back smoke: at G5 the
-- APPLY session applies 20260613170000 + 20260613180000, THEN runs this; it
-- creates real rows and RAISEs to roll them all back (zero footprint, safe on
-- prod). Impersonates an active admin via the JWT claim.
--   P1  positive: create_rush_order -> order needs_pricing/confirmed, $0 totals;
--       items pending + price 0 + suggested_price (tier) set; 'booked' inventory
--       txn; NO commissions; result status=created.
--   P2  forged p_performed_by                 -> ACTOR_MISMATCH
--   P3  no auth (no JWT claim)                 -> AUTH_REQUIRED
--   (role-gate INSUFFICIENT_ROLE for a non-admin/sales/driver/applicator role is
--    covered by the in-house rls review; add here if a spare role profile exists.)
--
-- NOTE (2026-06-13): build-loop session's Supabase MCP is READ-ONLY → not run
-- live here; the migration was verified by rls + drift + types reviewers
-- (codex=PENDING per the pre-G5 batch policy). NB: generate_order_number() may
-- advance a sequence that does NOT roll back (a consumed order number) — benign.

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  v_prod  uuid := (SELECT id FROM products LIMIT 1);
  r jsonb; out text := '';
  v_oid uuid; v_ord record; v_it record; v_comm int; v_book int; v_caught text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- P1 positive
  r := create_rush_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 5)), 'smoke rush', v_admin, NULL);
  v_oid := (r->>'order_id')::uuid;
  SELECT * INTO v_ord FROM orders WHERE id = v_oid;
  SELECT * INTO v_it FROM order_items WHERE order_id = v_oid LIMIT 1;
  SELECT count(*) INTO v_comm FROM commissions WHERE order_id = v_oid;
  SELECT count(*) INTO v_book FROM inventory_transactions WHERE order_id = v_oid AND transaction_type = 'booked';
  out := out || format('P1 create: result=%s ord.pricing=%s ord.status=%s ord.total=%s | item.pending=%s item.price=%s item.suggested=%s item.qty=%s | commissions=%s booked_txn=%s -> %s | ',
    r->>'status', v_ord.pricing_status, v_ord.status, v_ord.total_price,
    v_it.pricing_pending, v_it.price_per_unit, v_it.suggested_price, v_it.total_units_needed,
    v_comm, v_book,
    CASE WHEN r->>'status'='created' AND v_ord.pricing_status='needs_pricing' AND v_ord.status='confirmed'
          AND v_ord.total_price=0 AND v_it.pricing_pending IS TRUE AND v_it.price_per_unit=0
          AND v_it.suggested_price IS NOT NULL AND v_it.total_units_needed=5
          AND v_comm=0 AND v_book=1
         THEN 'PASS' ELSE 'FAIL' END);

  -- P2 forged actor
  BEGIN
    r := create_rush_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)),
      'forged', '00000000-0000-0000-0000-000000000001'::uuid, NULL);
    v_caught := 'NO-EXCEPTION';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P2 forged: "%s" -> %s | ', left(v_caught,20),
    CASE WHEN v_caught='ACTOR_MISMATCH' THEN 'PASS' ELSE 'FAIL' END);

  -- P3 no auth
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    r := create_rush_order(v_cust, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'qty', 1)), 'noauth', NULL, NULL);
    v_caught := 'NO-EXCEPTION';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P3 no-auth: "%s" -> %s', left(v_caught,20),
    CASE WHEN v_caught='AUTH_REQUIRED' THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
