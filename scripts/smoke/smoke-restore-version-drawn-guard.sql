-- ============================================================================
-- ROLLED-BACK post-cutover smoke test for
-- 20260816120000_draw_down_split_order_lines_by_price_tier
-- ----------------------------------------------------------------------------
-- Verifies the post-tier-split restore guard: once a draw stamps per-line
-- billing provenance on an order, restore_quote_version must fail closed rather
-- than mint new quote-item IDs that cannot preserve those stamps. The older
-- fall-below/removes checks remain defense in depth inside the owner body, but
-- the provenance refusal intentionally fires first for every drawn booking.
--
-- HOW TO RUN: CONTAINER ONLY through
-- prove-draw-down-quote-intent-binding.mjs after the pending cutover sequence.
-- Do not run this chain against live before that sequence is applied: its
-- provenance-first restore behavior does not exist there yet. The post-cutover
-- draw wrapper is authenticated-only and service_role cannot execute it. The
-- block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
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
--       -> QUOTE_RESTORE_BLOCKED_BY_DRAW; quote and ledger stay intact
--   (b) snapshot V2 books only a DIFFERENT product; restore V2 (removes the
--       drawn product) -> QUOTE_RESTORE_BLOCKED_BY_DRAW; state stays intact
--   (c) snapshot V3 @400 (>= 200 drawn) is also refused because even a
--       quantity-safe version cannot preserve per-line provenance; drawing the
--       remaining 300 from the untouched 500-unit booking closes it
--   (d) control: a quote with NO draws restores a lower-qty version freely
--   (e) accepted limitation: the guard remains after the draw reaches closure
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
    IF v_err NOT LIKE 'QUOTE_RESTORE_BLOCKED_BY_DRAW%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (a) expected QUOTE_RESTORE_BLOCKED_BY_DRAW, got: %', v_err;
    END IF;
  END;
  -- The refusal leaves the quote intact. Ordering before the section DELETE is
  -- pinned by the migration postflight; this caught subtransaction proves only
  -- the externally observable atomic state.
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
    IF v_err NOT LIKE 'QUOTE_RESTORE_BLOCKED_BY_DRAW%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (b) expected QUOTE_RESTORE_BLOCKED_BY_DRAW, got: %', v_err;
    END IF;
  END;
  SELECT count(*), COALESCE(SUM(total_units_needed), 0) INTO v_items, v_booked
  FROM quote_items WHERE quote_id = v_q;
  IF v_items <> 1 OR v_booked <> 500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) state corrupted after block: items=%, booked=%', v_items, v_booked;
  END IF;

  -- --------------------------------------------------------------------
  -- (c) Restore V3 on a DRAWN booking: REFUSED, nothing changes, then the
  --     booking still draws to closure from its un-restored state.
  --
  --     Before 20260816120000 this restore succeeded, because a draw left no
  --     per-line provenance behind. That migration stamps
  --     order_items.quote_item_id on every drawn line, and a version restore
  --     mints brand-new quote_items ids, so it cannot carry that stamp
  --     forward. Dropping the stamp instead of refusing was tried and refuted:
  --     it discards the telescoping rounding basis and was reproduced billing
  --     $1.02 against a $1.01 booking. So the restore now fails CLOSED.
  -- --------------------------------------------------------------------
  SELECT status INTO v_status FROM quotes WHERE id = v_q;
  v_err := NULL;
  BEGIN
    v_res := pg_temp.restore_quote_version_smoke(
      v_q, v_v3, v_admin, NULL,
      (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
    );
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) restore of a DRAWN booking was allowed (returned %) -- it must raise QUOTE_RESTORE_BLOCKED_BY_DRAW', v_res;
  END IF;
  IF v_err NOT LIKE 'QUOTE_RESTORE_BLOCKED_BY_DRAW%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) restore refused with the WRONG error: %', v_err;
  END IF;

  -- The quote is untouched: still 500 booked, still 200 drawn, same status.
  --
  -- READ THIS BEFORE CITING IT AS AN ORDERING PROOF. It is not one. The
  -- BEGIN ... EXCEPTION block above opens an implicit subtransaction, and
  -- catching the error rolls that subtransaction back -- so a refusal raised
  -- AFTER 'DELETE FROM quote_sections' would leave 500/200 here too. These
  -- assertions cannot tell pre-delete from post-delete refusal, and an earlier
  -- comment here wrongly claimed they could.
  --
  -- What they DO prove: the refusal leaves nothing behind outside the rolled-
  -- back subtransaction, and the booking is still whole afterwards (the draw
  -- below closes it). The ORDERING is pinned instead by the migration
  -- postflight, which compares the position of QUOTE_RESTORE_BLOCKED_BY_DRAW
  -- against 'DELETE FROM quote_sections' in the installed function body and
  -- fails the apply if the refusal comes second.
  SELECT COALESCE(SUM(total_units_needed), 0) INTO v_booked
  FROM quote_items WHERE quote_id = v_q AND product_id = v_prod_a;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_q AND product_id = v_prod_a;
  IF v_booked <> 500 OR v_drawn <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) refused restore still mutated the quote: booked=%, drawn=% (expected 500/200)',
      v_booked, v_drawn;
  END IF;
  IF (SELECT status FROM quotes WHERE id = v_q) IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) refused restore changed quote status from % to %',
      v_status, (SELECT status FROM quotes WHERE id = v_q);
  END IF;

  -- The booking is still fully usable: draw the remaining 300 of 500.
  v_res := draw_down_quote(v_q,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 300)),
    v_admin, 'smk-rvdg-final-' || v_suffix);
  IF (v_res->>'fully_drawn')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) draw to 500/500 not reported fully drawn: %', v_res;
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
  -- (e) ACCEPTED LIMITATION, pinned deliberately for the exercised state: a
  --     booking that reached full draw/accepted still cannot restore a version.
  --
  --     The guard in _restore_quote_version_owner_impl joins order_items
  --     UNFILTERED by order status. cancel_order returns the quantity to
  --     quote_product_draws and reopens the booking, but keeps the order_items
  --     rows for audit -- and those rows still carry their quote_item_id
  --     stamp. So the source-level rule stays true forever once a booking has
  --     been drawn, including after cancellation/void. This scenario directly
  --     executes the post-closure case; the unfiltered join and migration
  --     postflight pin the broader reversed-order scope described in
  --     docs/manual/KNOWN_ISSUES.md.
  --
  --     Codex round 3 (2026-08-19) flagged this as over-broad. Mason accepted
  --     it on 2026-08-20 rather than narrow it, because narrowing means
  --     RELEASING the stamps on those dead lines, which puts back the
  --     order_items UPDATE whose after_order_items_change ->
  --     trg_recalc_order_totals locks the order row under the quote lock --
  --     the deadlock this rework removed.
  --
  --     If this case ever starts FAILING, the guard was narrowed. That may be
  --     correct, but it is a decision: update docs/manual/KNOWN_ISSUES.md and
  --     migration-history row 887 in the same change, and prove the lock
  --     ordering again.
  -- --------------------------------------------------------------------
  SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q;
  IF v_drawn <= 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) setup -- draw ledger is empty (drawn=%), so this scenario would pass vacuously: the restore guard reads order_items, not quote_product_draws', v_drawn;
  END IF;

  v_err := NULL;
  BEGIN
    v_res := pg_temp.restore_quote_version_smoke(
      v_q, v_v3, v_admin, NULL,
      (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
    );
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  IF v_err IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) restore succeeded on a drawn booking -- the accepted limitation changed; see the comment above before updating this test';
  END IF;
  IF v_err NOT LIKE 'QUOTE_RESTORE_BLOCKED_BY_DRAW%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) restore blocked by the WRONG error: %', v_err;
  END IF;

  -- --------------------------------------------------------------------
  -- All scenarios passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
