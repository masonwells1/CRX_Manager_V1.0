-- ============================================================================
-- AUTH-PROBE TEMPLATE (rolled back by design) + worked example: draw_down_quote
-- ----------------------------------------------------------------------------
-- The standard 4-probe set every authenticated SECURITY DEFINER mutator must
-- survive (the actor-forgery class recurred across SIX dates before this
-- became a standing check - see docs/audits/2026-06-10-error-prevention-review.md):
--
--   P1 no-auth        request.jwt.claims = ''            -> AUTH_REQUIRED
--   P2 anon-key       claims = {"role":"anon"} (no sub)  -> AUTH_REQUIRED,
--                     and ZERO rows written/leaked
--   P3 wrong-role     claims sub = active driver (honest p_performed_by)
--                                                        -> INSUFFICIENT_ROLE
--   P4 forged actor   claims sub = admin, p_performed_by = SOMEONE ELSE's id
--                                                        -> ACTOR_MISMATCH
--   P5 positive ctrl  claims sub = admin, honest args    -> success
--                     (proves the probes failed for the RIGHT reason, not a
--                      broken fixture)
--
-- ---------------------------------------------------------------------------
-- HOW TO ADAPT (placeholders to replace when copying this for a new RPC):
--
--   __RPC_CALL(...)__    the call under test. Build REAL fixtures first (as
--                        table owner, before any claims are set) so P5 can
--                        actually succeed - probes against garbage args can
--                        pass for the wrong reason (e.g. NOT_FOUND before the
--                        role gate would mask a missing gate).
--   __ACTOR_PARAM__      the p_performed_by / p_approved_by / p_actor_id-style
--                        argument. P3 passes the caller's OWN id (honest);
--                        P4 passes a DIFFERENT real profile's id (the forgery).
--   __ALLOWED_ROLES__    the in-body role set (read it from the LIVE body via
--                        pg_get_functiondef first - never from disk).
--   __WRONG_ROLE_PICK__  an active profile whose role is OUTSIDE that set
--                        (prefer driver, then applicator). If none exists
--                        live, raise SMOKE_SETUP - do NOT silently skip P3.
--   __NO_WRITE_ASSERT__  a SELECT count(*) proving the probes wrote NOTHING
--                        (target the rows the RPC would have created).
--
-- Conventions that make the probes trustworthy:
--   * Match errors with  SQLERRM LIKE 'TOKEN%'  (tokens may carry a ': ...'
--     suffix per the canonical error-token pattern).
--   * Set claims at the TOP LEVEL of the DO body (outside the probe
--     BEGIN/EXCEPTION sub-blocks): set_config(..., is_local => true) made
--     inside a sub-block would roll back with the probe's sub-transaction.
--   * auth.uid() treats '' claims as NULL (live auth.uid() wraps
--     current_setting in nullif(..., '')), so P1 uses ''.
--   * Set both request.jwt.claims and the legacy request.jwt.claim.sub GUC;
--     disposable baseline auth helpers can read the latter directly.
--   * For READ RPCs the anon probe asserts the role-gate exception (e.g.
--     get_customer_statement raises 'Access denied: admin or sales_rep role
--     required') or zero returned rows - "no error" + rows = a leak.
--   * For RPCs with NO actor param, drop P4 and note why in the header.
--   * The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
--
-- ---------------------------------------------------------------------------
-- WORKED EXAMPLE below: draw_down_quote(p_quote_id uuid, p_draws jsonb,
--   p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL,
--   p_below_cost_reason text DEFAULT NULL)
-- Pending post-cutover order: barrier -> AUTH_REQUIRED -> ACTOR_MISMATCH -> role
-- gate (admin, sales_rep, is_active) -> key required -> payload validation ->
-- intent replay -> live quote FOR UPDATE -> governed money/inventory call.
-- Fixtures mirror smoke-draw-ledger-reversal.sql (quote 'sent', one section,
-- one 500-unit item; no inventory rows needed - draws tolerate shortfalls).
-- ============================================================================

DO $smoke$
DECLARE
  v_admin    uuid;
  v_wrong    uuid;   -- active profile OUTSIDE the allowed role set
  v_wrong_role text;
  v_suffix   text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_product  uuid;
  v_cost     numeric;
  v_quote    uuid;
  v_sec      uuid;
  v_lines    jsonb;
  v_res      jsonb;
  v_n        int;
  v_drawn    numeric;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Real actors (no synthetic profiles: profiles.id FKs auth.users)
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;

  -- __WRONG_ROLE_PICK__: any active role outside ('admin','sales_rep')
  SELECT id, role INTO v_wrong, v_wrong_role FROM profiles
  WHERE is_active = true AND role IN ('driver', 'applicator')
  ORDER BY CASE role WHEN 'driver' THEN 0 ELSE 1 END, created_at
  LIMIT 1;
  IF v_wrong IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active driver/applicator profile for the wrong-role probe';
  END IF;

  -- --------------------------------------------------------------------
  -- 1. Fixtures FIRST, as owner, before any claims exist (so P5 can pass)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Auth Probe Farm ' || v_suffix) RETURNING id INTO v_customer;

  SELECT id, current_cost INTO v_product, v_cost
  FROM products
  WHERE is_active IS TRUE
    AND current_cost IS NOT NULL
    AND current_cost > 0
    AND current_cost = round(current_cost, 2)
    AND current_cost <= 10
  ORDER BY current_cost, id
  LIMIT 1;
  IF v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active product with a positive whole-cent current_cost of 10.00 or less';
  END IF;

  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('SMK-APT-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_quote;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_quote, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_quote, v_sec, v_product, 10, v_cost, 500, 'gal');

  v_lines := jsonb_build_array(
    jsonb_build_object('product_id', v_product, 'quantity', 100));

  -- --------------------------------------------------------------------
  -- P1: no-auth -> AUTH_REQUIRED
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM draw_down_quote(v_quote, v_lines, NULL, NULL);    -- __RPC_CALL__
    RAISE EXCEPTION 'SMOKE_FAIL: P1 no-auth call was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P1 expected AUTH_REQUIRED, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- P2: anon-key (role claim, no sub) -> AUTH_REQUIRED, nothing written
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM draw_down_quote(v_quote, v_lines, NULL, NULL);    -- __RPC_CALL__
    RAISE EXCEPTION 'SMOKE_FAIL: P2 anon call was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P2 expected AUTH_REQUIRED, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- P3: wrong role (honest actor id, insufficient role) -> INSUFFICIENT_ROLE
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_wrong::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_wrong::text, true);
  BEGIN
    PERFORM draw_down_quote(v_quote, v_lines, v_wrong, NULL); -- __RPC_CALL__ w/ honest __ACTOR_PARAM__
    RAISE EXCEPTION 'SMOKE_FAIL: P3 % call was ALLOWED', v_wrong_role;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'INSUFFICIENT_ROLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P3 expected INSUFFICIENT_ROLE, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- P4: forged actor (authenticated admin passing someone ELSE's id)
  --     -> ACTOR_MISMATCH
  -- --------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM draw_down_quote(v_quote, v_lines, v_wrong, NULL); -- forged __ACTOR_PARAM__
    RAISE EXCEPTION 'SMOKE_FAIL: P4 forged p_performed_by was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P4 expected ACTOR_MISMATCH, got: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- __NO_WRITE_ASSERT__: four rejected probes wrote NOTHING
  -- --------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM orders WHERE quote_id = v_quote;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % order(s) exist after rejected probes - a gate is leaking writes', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM quote_product_draws WHERE quote_id = v_quote;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % draw-ledger row(s) exist after rejected probes', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- P5: positive control - honest admin draw succeeds (claims already admin)
  -- --------------------------------------------------------------------
  v_res := draw_down_quote(v_quote, v_lines, v_admin, 'smk-apt-' || v_suffix);
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'fully_drawn')::boolean, true) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: P5 admin control draw failed or mis-reported: %', v_res;
  END IF;
  SELECT count(*) INTO v_n FROM orders WHERE quote_id = v_quote;
  SELECT quantity_drawn INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_quote AND product_id = v_product;
  IF v_n <> 1 OR v_drawn IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: P5 expected 1 order / 100 drawn, got % / %', v_n, v_drawn;
  END IF;

  -- --------------------------------------------------------------------
  -- All probes correct - force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
