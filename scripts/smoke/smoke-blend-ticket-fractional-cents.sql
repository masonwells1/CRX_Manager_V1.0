-- Smoke chain: create_order_from_blend_ticket — fractional-quantity whole-cent regression
-- Guards CRX-MONEY-001 (migration 20260811190000_blend_ticket_order_totals_whole_cents.sql).
--
-- Before that migration the RPC accumulated RAW per-line money (v_price * v_qty_conv) and
-- overwrote the order header with it. On any fractional converted quantity that value is a
-- sub-cent number, so orders_total_cost_whole_cents_chk / orders_total_profit_whole_cents_chk
-- rejected it and the entire order creation rolled back. After the migration the header is
-- left to the canonical trigger pair (trg_order_items_round_money BEFORE each line, then
-- trg_recalc_order_totals AFTER) and re-read, so the stored totals are whole cents and the
-- number returned to the caller equals the number stored.
--
-- This chain builds a rolled-back [SMOKE] fixture whose single line is DELIBERATELY sub-cent
-- (it asserts that up front, so the proof can never go vacuous), runs the real RPC end to end,
-- and checks the stored header against an independent recomputation from order_items. It also
-- covers the auth gate, the actor-forgery gate, idempotent replay, and the grant contract.
--
-- PASS  = terminates with SMOKE_PASS_ROLLBACK (proves the rollback fired).
-- FAIL  = any other error, or no error at all.
DO $smoke$
DECLARE
  v_suffix        text := substr(md5(random()::text), 1, 8);
  v_admin         uuid;
  v_other         uuid;
  v_nonprivileged uuid;
  v_product_id    uuid;
  v_product_name  text;
  v_price         numeric;
  v_cost          numeric;
  v_unit          text;
  v_customer_id   uuid;
  v_ticket_id     uuid;
  v_qty           numeric := 0.5;
  v_order_number  text;
  v_idem          text;
  v_result        json;
  v_replay        json;
  v_order_id      uuid;
  v_line_price    numeric;
  v_line_profit   numeric;
  v_line_units    numeric;
  v_hdr_price     numeric;
  v_hdr_cost      numeric;
  v_hdr_profit    numeric;
  v_hdr_margin    numeric;
  v_exp_price     numeric;
  v_exp_cost      numeric;
  v_order_count   int;
  v_link_status   text;
  v_grantees      text[];
  v_secdef        boolean;
  v_searchpath    text[];
BEGIN
  ----------------------------------------------------------------------------
  -- 0. Actors
  ----------------------------------------------------------------------------
  SELECT id INTO v_admin
    FROM profiles
   WHERE role = 'admin' AND is_active IS TRUE
   ORDER BY id
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no active admin profile to act as';
  END IF;

  SELECT id INTO v_other
    FROM profiles
   WHERE id <> v_admin
   ORDER BY id
   LIMIT 1;
  IF v_other IS NULL THEN
    v_other := gen_random_uuid();
  END IF;

  -- Optional: a real active profile that is neither admin nor sales rep, for the role gate.
  SELECT id INTO v_nonprivileged
    FROM profiles
   WHERE is_active IS TRUE
     AND COALESCE(role, '') NOT IN ('admin', 'sales_rep')
   ORDER BY id
   LIMIT 1;

  ----------------------------------------------------------------------------
  -- 1. Pick a real catalog product whose HALF-UNIT price AND cost are both
  --    sub-cent, and whose inventory unit is present so the unit conversion is
  --    the identity. This is what makes the regression reproducible.
  ----------------------------------------------------------------------------
  SELECT p.id,
         p.product_name,
         p.tier1_price,
         p.current_cost,
         COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)
    INTO v_product_id, v_product_name, v_price, v_cost, v_unit
    FROM products p
   WHERE p.is_active IS TRUE
     AND p.tier1_price > 0
     AND p.current_cost > 0
     AND COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size) IS NOT NULL
     AND ROUND(p.tier1_price * 0.5, 2) <> p.tier1_price * 0.5
     AND ROUND(p.current_cost  * 0.5, 2) <> p.current_cost  * 0.5
   ORDER BY p.id
   LIMIT 1;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no active product with a sub-cent half-unit price AND cost — the fixture cannot exercise the fractional path';
  END IF;

  -- Fail loudly rather than silently proving nothing.
  IF ROUND(v_price * v_qty, 2) = v_price * v_qty THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fixture is vacuous — raw line price % * % is already a whole cent', v_price, v_qty;
  END IF;
  IF ROUND(v_cost * v_qty, 2) = v_cost * v_qty THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fixture is vacuous — raw line cost % * % is already a whole cent', v_cost, v_qty;
  END IF;

  v_exp_price := ROUND(v_price * v_qty, 2);
  v_exp_cost  := ROUND(v_cost  * v_qty, 2);

  ----------------------------------------------------------------------------
  -- 2. Fixture: customer + completed/approved/unbilled blend ticket + one line
  ----------------------------------------------------------------------------
  INSERT INTO customers (farm_name, is_active, assigned_tier)
  VALUES ('[SMOKE] blend fractional cents ' || v_suffix, true, 1)
  RETURNING id INTO v_customer_id;

  INSERT INTO blend_tickets (
    ticket_number, uploaded_by, customer_id, salesman_id,
    status, review_status, payment_status, order_link_status,
    total_acres, season, source
  ) VALUES (
    '[SMOKE]-BT-' || v_suffix, v_admin, v_customer_id, v_admin,
    'completed', 'approved', 'unbilled', 'unlinked',
    1, '2026', 'manual'
  ) RETURNING id INTO v_ticket_id;

  INSERT INTO blend_ticket_products (
    blend_ticket_id, product_id, product_name, quantity, unit, sequence_order
  ) VALUES (
    v_ticket_id, v_product_id, v_product_name, v_qty, v_unit, 0
  );

  ----------------------------------------------------------------------------
  -- 3. Auth gate: no JWT at all must raise AUTH_REQUIRED before anything runs
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM create_order_from_blend_ticket(
      v_ticket_id, '[SMOKE]-NOAUTH-' || v_suffix, CURRENT_DATE, NULL, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: unauthenticated create_order_from_blend_ticket was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected AUTH_REQUIRED with no JWT, got: %', SQLERRM;
    END IF;
  END;

  ----------------------------------------------------------------------------
  -- 4. Actor-forgery gate: authenticated as admin, claiming to be someone else
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM create_order_from_blend_ticket(
      v_ticket_id, '[SMOKE]-FORGE-' || v_suffix, CURRENT_DATE, NULL, v_other, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: forged p_performed_by was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH for a forged actor, got: %', SQLERRM;
    END IF;
  END;

  ----------------------------------------------------------------------------
  -- 5. Role gate: a non-admin, non-sales actor must be rejected
  ----------------------------------------------------------------------------
  IF v_nonprivileged IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_nonprivileged, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM create_order_from_blend_ticket(
        v_ticket_id, '[SMOKE]-ROLE-' || v_suffix, CURRENT_DATE, NULL, v_nonprivileged, NULL);
      RAISE EXCEPTION 'SMOKE_FAIL: a non-admin/non-sales actor created an order from a blend ticket';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE '%INSUFFICIENT_ROLE%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: expected INSUFFICIENT_ROLE for a non-privileged actor, got: %', SQLERRM;
      END IF;
    END;
  ELSE
    RAISE WARNING 'SMOKE_NOTE: no active non-admin/non-sales profile exists, role gate not exercised';
  END IF;

  ----------------------------------------------------------------------------
  -- 6. THE REGRESSION: the real call must succeed and store whole cents
  ----------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  v_order_number := '[SMOKE]-ORD-' || v_suffix;
  v_idem         := '[SMOKE]-IDEM-' || v_suffix;

  v_result := create_order_from_blend_ticket(
    v_ticket_id, v_order_number, CURRENT_DATE, NULL, v_admin, v_idem);

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fractional blend-ticket order was rejected: %', v_result::text;
  END IF;
  IF COALESCE((v_result->>'items_created')::int, 0) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 order item, got %', v_result->>'items_created';
  END IF;

  v_order_id := (v_result->>'order_id')::uuid;

  SELECT o.total_price, o.total_cost, o.total_profit, o.total_margin_pct
    INTO v_hdr_price, v_hdr_cost, v_hdr_profit, v_hdr_margin
    FROM orders o
   WHERE o.id = v_order_id;
  IF v_hdr_price IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order % was not stored', v_order_id;
  END IF;

  -- 6a. Every header money column is a whole cent (this is what the live CHECKs enforce).
  IF v_hdr_price  IS DISTINCT FROM ROUND(v_hdr_price,  2)
  OR v_hdr_cost   IS DISTINCT FROM ROUND(v_hdr_cost,   2)
  OR v_hdr_profit IS DISTINCT FROM ROUND(v_hdr_profit, 2) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order header is not whole cents — price %, cost %, profit %',
      v_hdr_price, v_hdr_cost, v_hdr_profit;
  END IF;

  -- 6b. The header equals the canonical sum-of-rounded-lines, not a re-rounded raw sum.
  SELECT oi.total_price, oi.profit, oi.total_units_needed
    INTO v_line_price, v_line_profit, v_line_units
    FROM order_items oi
   WHERE oi.order_id = v_order_id;

  IF v_line_units IS DISTINCT FROM v_qty THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unit conversion was not the identity — stored % units, fixture used %',
      v_line_units, v_qty;
  END IF;
  IF v_line_price IS DISTINCT FROM v_exp_price THEN
    RAISE EXCEPTION 'SMOKE_FAIL: line total_price % <> expected ROUND(%*%,2) = %',
      v_line_price, v_price, v_qty, v_exp_price;
  END IF;
  IF v_line_profit IS DISTINCT FROM (v_exp_price - v_exp_cost) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: line profit % <> expected % - % = %',
      v_line_profit, v_exp_price, v_exp_cost, v_exp_price - v_exp_cost;
  END IF;
  IF v_hdr_price  IS DISTINCT FROM v_exp_price
  OR v_hdr_cost   IS DISTINCT FROM v_exp_cost
  OR v_hdr_profit IS DISTINCT FROM (v_exp_price - v_exp_cost) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: header (%, %, %) <> canonical trigger totals (%, %, %)',
      v_hdr_price, v_hdr_cost, v_hdr_profit,
      v_exp_price, v_exp_cost, v_exp_price - v_exp_cost;
  END IF;
  IF v_hdr_margin IS DISTINCT FROM ROUND((v_exp_price - v_exp_cost) / v_exp_price * 100, 2) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: header margin % <> canonical %',
      v_hdr_margin, ROUND((v_exp_price - v_exp_cost) / v_exp_price * 100, 2);
  END IF;

  -- 6c. What the RPC reported to the caller is what is stored (the re-read).
  IF (v_result->>'total_price')::numeric IS DISTINCT FROM v_hdr_price THEN
    RAISE EXCEPTION 'SMOKE_FAIL: RPC reported total_price % but the order stores %',
      v_result->>'total_price', v_hdr_price;
  END IF;

  -- 6d. The blend ticket really was linked (link_blend_ticket_to_order ran).
  SELECT bt.order_link_status INTO v_link_status
    FROM blend_tickets bt WHERE bt.id = v_ticket_id;
  IF v_link_status IS DISTINCT FROM 'linked' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blend ticket order_link_status is % after order creation', v_link_status;
  END IF;

  ----------------------------------------------------------------------------
  -- 7. Idempotent replay returns the saved result and creates no second order
  ----------------------------------------------------------------------------
  v_replay := create_order_from_blend_ticket(
    v_ticket_id, v_order_number, CURRENT_DATE, NULL, v_admin, v_idem);
  IF (v_replay->>'order_id') IS DISTINCT FROM (v_result->>'order_id') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: idempotent replay returned a different order (% vs %)',
      v_replay->>'order_id', v_result->>'order_id';
  END IF;

  SELECT count(*) INTO v_order_count
    FROM orders o WHERE o.customer_id = v_customer_id;
  IF v_order_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: replay created a duplicate order (% orders for the fixture customer)', v_order_count;
  END IF;

  ----------------------------------------------------------------------------
  -- 8. Contract: SECURITY DEFINER, pinned search_path, no anon/PUBLIC EXECUTE
  ----------------------------------------------------------------------------
  SELECT p.prosecdef, p.proconfig
    INTO v_secdef, v_searchpath
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'create_order_from_blend_ticket';
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_order_from_blend_ticket is not SECURITY DEFINER';
  END IF;
  IF NOT COALESCE(v_searchpath, ARRAY[]::text[]) @> ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: search_path is not pinned to public, pg_temp — got %', v_searchpath;
  END IF;

  SELECT array_agg(DISTINCT COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC') ORDER BY COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC'))
    INTO v_grantees
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid = 'public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text)'::regprocedure
     AND a.privilege_type = 'EXECUTE';
  IF v_grantees IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: could not read EXECUTE grants on create_order_from_blend_ticket';
  END IF;
  IF 'anon' = ANY(v_grantees) OR 'PUBLIC' = ANY(v_grantees) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon or PUBLIC can EXECUTE create_order_from_blend_ticket — grantees %', v_grantees;
  END IF;
  IF NOT ('authenticated' = ANY(v_grantees)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated lost EXECUTE on create_order_from_blend_ticket — the UI callsite would break; grantees %', v_grantees;
  END IF;

  ----------------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
