-- ============================================================================
-- ROLLED-BACK smoke test for 20260611120100_restore_quote_version_drawn_guard
-- ----------------------------------------------------------------------------
-- Verifies the drawn-version guard in restore_quote_version (Codex round-2
-- MED): restoring a version snapshot must never under-book the drawn ledger
-- (quote_product_draws) — the same invariant save_quote's drawn-product guard
-- enforces (20260610184230), closed for the version-restore bypass.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1) as postgres/service_role AFTER the migration is
-- applied. The block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, version, ledger row and audit row created here is rolled
-- back — nothing persists. Any other exception text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims — injected below via set_config(..., is_local => true)
-- using a real active admin profile id. Direct fixture DML bypasses RLS (and
-- save_quote's own guard) because we run as the table owner — deliberate, to
-- craft snapshot states; the RPCs under test still enforce their own gates.
--
-- Scenarios:
--   (a) snapshot V1 @100, raise booking to 500, draw 200; restore V1
--       (100 < 200 drawn) -> BOOKING_OVERDRAWN 'would fall below'; the
--       section DELETE inside restore must roll back too (items intact)
--   (b) snapshot V2 books only a DIFFERENT product; restore V2 (removes the
--       drawn product) -> BOOKING_OVERDRAWN 'removes'
--   (c) snapshot V3 @400 (>= 200 drawn): restore SUCCEEDS -> status revised,
--       booked 400, ledger still 200; drawing the remaining 200 then closes
--       the booking (accepted, drawn = 400) — full chain to closure
--   (d) control: a quote with NO draws restores a lower-qty version freely
-- ============================================================================

CREATE OR REPLACE FUNCTION pg_temp.restore_quote_version_smoke(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid,
  p_idempotency_key text,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_result jsonb;
BEGIN
  IF to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.restore_quote_version($1, $2, $3, $4, $5, NULL)'
      INTO v_result
      USING p_quote_id, p_version_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  ELSIF to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.restore_quote_version($1, $2, $3, $4, $5)'
      INTO v_result
      USING p_quote_id, p_version_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  RETURN public.restore_quote_version(
    p_quote_id,
    p_version_id,
    p_performed_by,
    p_idempotency_key
  );
END;
$helper$;

CREATE OR REPLACE FUNCTION pg_temp.create_quote_version_smoke(
  p_quote_id uuid,
  p_performed_by uuid,
  p_method text,
  p_idempotency_key text,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_result jsonb;
BEGIN
  IF to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.create_quote_version($1, $2, $3, $4, $5)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_method, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  RETURN public.create_quote_version(
    p_quote_id,
    p_performed_by,
    p_method,
    p_idempotency_key
  );
END;
$helper$;

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_prod_a uuid;
  v_prod_b uuid;
  v_q uuid;
  v_qc uuid;
  v_sec uuid;
  v_v1 uuid;
  v_v2 uuid;
  v_v3 uuid;
  v_vc uuid;
  v_res jsonb;
  v_err text;
  v_booked numeric;
  v_drawn numeric;
  v_status text;
  v_items int;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Auth as a real active admin
  -- --------------------------------------------------------------------
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------------
  -- 1. Fixtures (txn-local; rolled back at the end)
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Restore Guard Farm ' || v_suffix)
  RETURNING id INTO v_customer;
  INSERT INTO products (product_name, unit_size)
  VALUES ('[SMOKE] Restore Guard A ' || v_suffix, 'gal')
  RETURNING id INTO v_prod_a;
  INSERT INTO products (product_name, unit_size)
  VALUES ('[SMOKE] Restore Guard B ' || v_suffix, 'gal')
  RETURNING id INTO v_prod_b;

  v_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_prod_a,
        'row_version', (SELECT pricing_version FROM products WHERE id = v_prod_a),
        'pricing_mode', 'margin_driven',
        'new_cost', '6.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke restore guard fixture A'
      ),
      jsonb_build_object(
        'product_id', v_prod_b,
        'row_version', (SELECT pricing_version FROM products WHERE id = v_prod_b),
        'pricing_mode', 'margin_driven',
        'new_cost', '6.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke restore guard fixture B'
      )
    ),
    v_admin, 'smk-rvdg-price-preview-' || v_suffix
  );
  PERFORM apply_product_pricing_change_set(
    (v_res->>'change_set_id')::uuid,
    v_res->>'request_fingerprint',
    v_admin,
    'smk-rvdg-price-apply-' || v_suffix
  );

  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('[SMOKE] RVG-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_q;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_q, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q, v_sec, v_prod_a, 10, 6, 100, 'gal');

  -- V1: snapshot @ A=100
  PERFORM pg_temp.create_quote_version_smoke(
    v_q, v_admin, 'presented', NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
  );
  SELECT id INTO v_v1 FROM quote_versions WHERE quote_id = v_q
  ORDER BY version_number DESC LIMIT 1;
  IF v_v1 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: create_quote_version produced no version row';
  END IF;

  -- V2: snapshot that books ONLY product B (drawn product A absent)
  DELETE FROM quote_items WHERE quote_id = v_q;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q, v_sec, v_prod_b, 10, 6, 400, 'gal');
  PERFORM pg_temp.create_quote_version_smoke(
    v_q, v_admin, 'presented', NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
  );
  SELECT id INTO v_v2 FROM quote_versions WHERE quote_id = v_q
  ORDER BY version_number DESC LIMIT 1;

  -- V3: snapshot @ A=400 (legal: >= the 200 that will be drawn)
  DELETE FROM quote_items WHERE quote_id = v_q;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q, v_sec, v_prod_a, 10, 6, 400, 'gal');
  PERFORM pg_temp.create_quote_version_smoke(
    v_q, v_admin, 'presented', NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
  );
  SELECT id INTO v_v3 FROM quote_versions WHERE quote_id = v_q
  ORDER BY version_number DESC LIMIT 1;
  IF v_v1 = v_v2 OR v_v2 = v_v3 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: version ids not distinct (%, %, %)', v_v1, v_v2, v_v3;
  END IF;

  -- Live booking state: A @ 500 booked, then draw 200
  UPDATE quote_items SET total_units_needed = 500 WHERE quote_id = v_q;
  v_res := draw_down_quote(v_q,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 200)),
    v_admin, 'smk-rvdg-first-' || v_suffix);
  IF (v_res->>'fully_drawn')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: setup draw 200/500 reported fully_drawn: %', v_res;
  END IF;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_q AND product_id = v_prod_a;
  IF v_drawn IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: setup expected drawn=200, got %', v_drawn;
  END IF;

  -- --------------------------------------------------------------------
  -- (a) Restore V1 (A booked 100 < 200 drawn): must be BLOCKED
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM pg_temp.restore_quote_version_smoke(
      v_q, v_v1, v_admin, NULL,
      (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
    );
    RAISE EXCEPTION 'SMOKE_FAIL: (a) restoring below the drawn ledger was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BOOKING_OVERDRAWN: cannot restore this version — % would fall below%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (a) expected BOOKING_OVERDRAWN fall-below, got: %', v_err;
    END IF;
  END;
  -- The restore's section DELETE must have rolled back with the guard
  SELECT count(*), COALESCE(SUM(total_units_needed), 0) INTO v_items, v_booked
  FROM quote_items WHERE quote_id = v_q;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_q AND product_id = v_prod_a;
  IF v_items <> 1 OR v_booked <> 500 OR v_drawn <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) state corrupted after block: items=%, booked=%, drawn=%',
      v_items, v_booked, v_drawn;
  END IF;

  -- --------------------------------------------------------------------
  -- (b) Restore V2 (books only product B — removes drawn A): must be BLOCKED
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM pg_temp.restore_quote_version_smoke(
      v_q, v_v2, v_admin, NULL,
      (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
    );
    RAISE EXCEPTION 'SMOKE_FAIL: (b) restoring a version without the drawn product was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BOOKING_OVERDRAWN: cannot restore this version — it removes%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (b) expected BOOKING_OVERDRAWN removes, got: %', v_err;
    END IF;
  END;
  SELECT count(*), COALESCE(SUM(total_units_needed), 0) INTO v_items, v_booked
  FROM quote_items WHERE quote_id = v_q;
  IF v_items <> 1 OR v_booked <> 500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) state corrupted after block: items=%, booked=%', v_items, v_booked;
  END IF;

  -- --------------------------------------------------------------------
  -- (c) Restore V3 (A @ 400 >= 200 drawn): SUCCEEDS, then draws to closure
  -- --------------------------------------------------------------------
  v_res := pg_temp.restore_quote_version_smoke(
    v_q, v_v3, v_admin, NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
  );
  IF v_res->>'status' IS DISTINCT FROM 'restored' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) legal restore returned %', v_res;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q;
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_q AND product_id = v_prod_a;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_q AND product_id = v_prod_a;
  IF v_status <> 'revised' OR v_booked <> 400 OR v_drawn <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) after restore expected revised/400/200, got %/%/%',
      v_status, v_booked, v_drawn;
  END IF;

  v_res := draw_down_quote(v_q,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 200)),
    v_admin, 'smk-rvdg-final-' || v_suffix);
  IF (v_res->>'fully_drawn')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) draw to 400/400 not reported fully drawn: %', v_res;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q;
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) booking did not close after final draw, status=%', v_status;
  END IF;

  -- --------------------------------------------------------------------
  -- (d) Control: a quote with NO draws restores a lower-qty version freely
  -- --------------------------------------------------------------------
  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('[SMOKE] RVG-CTRL-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_qc;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_qc, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_qc, v_sec, v_prod_a, 10, 6, 300, 'gal');

  PERFORM pg_temp.create_quote_version_smoke(
    v_qc, v_admin, 'presented', NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_qc)
  );
  SELECT id INTO v_vc FROM quote_versions WHERE quote_id = v_qc
  ORDER BY version_number DESC LIMIT 1;

  UPDATE quote_items SET total_units_needed = 500 WHERE quote_id = v_qc;

  v_res := pg_temp.restore_quote_version_smoke(
    v_qc, v_vc, v_admin, NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_qc)
  );
  IF v_res->>'status' IS DISTINCT FROM 'restored' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) control restore returned %', v_res;
  END IF;
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_qc;
  IF v_booked <> 300 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) control restore blocked or wrong, booked=%', v_booked;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
