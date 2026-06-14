-- Roadmap #5 — Unstick quote lifecycle — rolled-back smoke chain
-- ----------------------------------------------------------------------------
-- Proves the DB contracts the new QuoteBuilder UI relies on (all PRE-EXISTING
-- live triggers/RPCs — this slice is frontend-only and adds no migration):
--   P1  Decline button  -> direct UPDATE quotes.status='declined'
--                          fires release_holds_on_quote_status_change -> holds released
--   P2  Auto-expire(sim) -> auto_expire_quotes() flips sent(past-expiry)->expired + releases holds
--   P3  Un-accept button -> revert_quote_status(accepted) -> sent
--   P4  Un-accept guard  -> revert_quote_status blocked when an order already exists
--
-- ZERO PROD FOOTPRINT: the whole block RAISEs at the end, rolling everything
-- back. Impersonates an active admin via the JWT claim so auth.uid() resolves
-- (faithful to a logged-in admin clicking the buttons).
--
-- NOTE (2026-06-13): the build-loop session's Supabase MCP is READ-ONLY, so
-- this could not be executed live there. The four contracts were instead
-- verified by direct inspection of the live function/trigger definitions
-- (revert_quote_status, auto_expire_quotes, release_holds_on_quote_status_change,
-- _enforce_quote_status_transition). Run this from a write-capable session
-- (Supabase SQL editor / APPLY-role MCP) to get the live PASS/FAIL line; it
-- ROLLS BACK, so it is safe to run against production.
--
-- Replace the three seed ids below with current live ids if these have changed.

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  v_prod  uuid := (SELECT id FROM products LIMIT 1);
  q1 uuid; q2 uuid; q3 uuid; q4 uuid;
  r jsonb; out text := '';
  v_hold_active boolean; v_status text; v_caught text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- PATH 1: sent -> declined releases holds (direct UPDATE = what the Decline button does)
  INSERT INTO quotes (quote_number, customer_id, created_by, status)
    VALUES ('SMOKE-DECL', v_cust, v_admin, 'draft') RETURNING id INTO q1;
  UPDATE quotes SET status='sent' WHERE id=q1;
  INSERT INTO inventory_holds (product_id, quantity, hold_type, created_by, is_active, source_id)
    VALUES (v_prod, 10, 'crop_program', v_admin, true, q1);
  UPDATE quotes SET status='declined' WHERE id=q1;
  SELECT bool_or(is_active) INTO v_hold_active FROM inventory_holds WHERE source_id=q1;
  SELECT status INTO v_status FROM quotes WHERE id=q1;
  out := out || format('P1 decline: status=%s hold_active=%s -> %s | ', v_status, v_hold_active,
    CASE WHEN v_status='declined' AND v_hold_active IS FALSE THEN 'PASS' ELSE 'FAIL' END);

  -- PATH 2: sent (past expiry) -> auto_expire_quotes() flips to expired + releases holds
  INSERT INTO quotes (quote_number, customer_id, created_by, status, expires_at)
    VALUES ('SMOKE-EXP', v_cust, v_admin, 'draft', CURRENT_DATE - 5) RETURNING id INTO q2;
  UPDATE quotes SET status='sent' WHERE id=q2;
  INSERT INTO inventory_holds (product_id, quantity, hold_type, created_by, is_active, source_id)
    VALUES (v_prod, 7, 'crop_program', v_admin, true, q2);
  PERFORM auto_expire_quotes();
  SELECT status INTO v_status FROM quotes WHERE id=q2;
  SELECT bool_or(is_active) INTO v_hold_active FROM inventory_holds WHERE source_id=q2;
  out := out || format('P2 expire: status=%s hold_active=%s -> %s | ', v_status, v_hold_active,
    CASE WHEN v_status='expired' AND v_hold_active IS FALSE THEN 'PASS' ELSE 'FAIL' END);

  -- PATH 3: accepted -> un-accept via revert_quote_status RPC -> sent
  INSERT INTO quotes (quote_number, customer_id, created_by, status)
    VALUES ('SMOKE-REV', v_cust, v_admin, 'draft') RETURNING id INTO q3;
  UPDATE quotes SET status='sent' WHERE id=q3;
  UPDATE quotes SET status='accepted' WHERE id=q3;
  r := revert_quote_status(q3, 'smoke reopen', v_admin, NULL);
  SELECT status INTO v_status FROM quotes WHERE id=q3;
  out := out || format('P3 un-accept: rpc_new=%s status=%s -> %s | ', r->>'new_status', v_status,
    CASE WHEN v_status='sent' AND (r->>'new_status')='sent' THEN 'PASS' ELSE 'FAIL' END);

  -- PATH 4: revert blocked when an order already exists on the accepted quote
  INSERT INTO quotes (quote_number, customer_id, created_by, status)
    VALUES ('SMOKE-REVBLK', v_cust, v_admin, 'draft') RETURNING id INTO q4;
  UPDATE quotes SET status='sent' WHERE id=q4;
  UPDATE quotes SET status='accepted' WHERE id=q4;
  BEGIN
    INSERT INTO orders (order_number, customer_id, quote_id, status)
      VALUES ('SMOKE-ORD', v_cust, q4, 'confirmed');
    r := revert_quote_status(q4, 'should fail', v_admin, NULL);
    v_caught := 'NO-EXCEPTION(FAIL)';
  EXCEPTION WHEN OTHERS THEN
    v_caught := SQLERRM;
  END;
  out := out || format('P4 order-block: "%s" -> %s', left(v_caught, 50),
    CASE WHEN v_caught LIKE '%order has already been created%' THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
