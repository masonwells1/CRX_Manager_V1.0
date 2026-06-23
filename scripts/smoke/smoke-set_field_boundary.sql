-- ============================================================================
-- SMOKE TEST (rolled back by design): set_field_boundary / set_field_override_acres
-- — migrations 20260623120000 (two-acre columns) + 20260623130000 (RPCs + trigger).
-- ----------------------------------------------------------------------------
-- Run AFTER applying both migrations. Pre-apply it FAILS (the functions/columns
-- do not exist). The build proved the same matrix on a local PostGIS 3.3 scaffold
-- (15+ cases); this re-verifies the key guards against the LIVE schema, rolled back.
--
-- Proves:
--   (A) a ~40-ac polygon measures a sane geodesic acreage; acres_source='measured'.
--   (B) the 0.1–5000 acre band rejects an oversized boundary (AREA_OUT_OF_BAND).
--   (C) a typed override SURVIVES a redraw — set_field_boundary never touches
--       override_acres (the #1 defect this feature fixes).
--   (D) idempotency: replaying set_field_boundary with the same key returns the
--       same result (no second measure).
--   (E) the fields_acre_authority trigger BLOCKS a direct UPDATE of measured_acres
--       (only the RPCs may write the acre-authority columns).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid; v_sfx text := substr(gen_random_uuid()::text,1,8); v_cust uuid; v_field uuid;
  r jsonb; m numeric; ov numeric;
  poly40 text := '{"type":"Polygon","coordinates":[[[-100,40],[-100,40.0036],[-99.9955,40.0036],[-99.9955,40],[-100,40]]]}';
  huge   text := '{"type":"Polygon","coordinates":[[[-100,40],[-100,40.065],[-99.93,40.065],[-99.93,40],[-100,40]]]}';
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin profile'; END IF;
  -- live auth.uid() reads request.jwt.claims; the local scaffold's stub reads app.current_actor.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  PERFORM set_config('app.current_actor', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] FAB '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO fields (customer_id, field_name) VALUES (v_cust, '[SMOKE] Field '||v_sfx) RETURNING id INTO v_field;

  -- (A) measure a ~40-ac polygon
  r := set_field_boundary(v_field, poly40, v_admin, NULL);
  m := (r->>'measured_acres')::numeric;
  IF m IS NULL OR m < 30 OR m > 50 THEN RAISE EXCEPTION 'SMOKE_FAIL(A) measured % out of expected range', m; END IF;
  IF (r->>'acres_source') <> 'measured' THEN RAISE EXCEPTION 'SMOKE_FAIL(A) acres_source %', r->>'acres_source'; END IF;

  -- (B) oversized boundary -> AREA_OUT_OF_BAND
  BEGIN
    r := set_field_boundary(v_field, huge, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL(B) oversized boundary not rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%AREA_OUT_OF_BAND%' THEN RAISE EXCEPTION 'SMOKE_FAIL(B) wrong error: %', SQLERRM; END IF;
  END;

  -- (C) override 38.5 survives a redraw
  r := set_field_override_acres(v_field, 38.5, v_admin, NULL);
  IF (r->>'billable_acres')::numeric <> 38.5 THEN RAISE EXCEPTION 'SMOKE_FAIL(C) override billable %', r->>'billable_acres'; END IF;
  r := set_field_boundary(v_field, poly40, v_admin, NULL);   -- redraw
  SELECT override_acres INTO ov FROM fields WHERE id=v_field;
  IF ov <> 38.5 THEN RAISE EXCEPTION 'SMOKE_FAIL(C) override CLOBBERED by redraw: %', ov; END IF;

  -- (D) idempotent replay returns the same result
  r := set_field_boundary(v_field, poly40, v_admin, 'smoke-idem-'||v_sfx);
  m := (r->>'measured_acres')::numeric;
  r := set_field_boundary(v_field, poly40, v_admin, 'smoke-idem-'||v_sfx);
  IF (r->>'measured_acres')::numeric <> m THEN RAISE EXCEPTION 'SMOKE_FAIL(D) replay differs'; END IF;

  -- (E) the authority trigger blocks a direct write to measured_acres
  BEGIN
    UPDATE fields SET measured_acres = 999 WHERE id=v_field;
    RAISE EXCEPTION 'SMOKE_FAIL(E) direct measured_acres write allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%ACRE_AUTHORITY_VIOLATION%' AND SQLERRM NOT LIKE '%permission denied%'
      THEN RAISE EXCEPTION 'SMOKE_FAIL(E) wrong error: %', SQLERRM; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
