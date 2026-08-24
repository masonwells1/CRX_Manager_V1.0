-- ============================================================================
-- ROLLED-BACK smoke test for 20260611120100_restore_quote_version_drawn_guard
-- as superseded by 20260816120000_draw_down_split_order_lines_by_price_tier
-- ----------------------------------------------------------------------------
-- Originally verified the drawn-version guard in restore_quote_version (Codex
-- round-2 MED): restoring a version snapshot must never under-book the drawn
-- ledger (quote_product_draws) — the same invariant save_quote's drawn-product
-- guard enforces (20260610184230), closed for the version-restore bypass.
--
-- 20260816120000 replaced that quantity comparison with a broader up-front
-- refusal: a booking that has EVER been drawn cannot be restored at all,
-- because a restore mints new quote_items ids and cannot carry the
-- order_items.quote_item_id provenance stamp forward. This chain now proves the
-- refusal. Before that migration is present the chain raises SMOKE_PREREQ,
-- rather than turning an intentionally parked migration into a red live smoke.
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
-- Scenarios (a)-(c) all restore against a booking that HAS been drawn, and
-- since 20260816120000 all three are refused identically with
-- QUOTE_RESTORE_BLOCKED_BY_DRAW. They stay separate because the shape of the
-- snapshot differs each time, and none of those shapes may buy a way past the
-- guard. Run against a schema WITHOUT 20260816120000, (a) instead reports the
-- older BOOKING_OVERDRAWN 'would fall below' — that difference is what proves
-- this chain actually detects the migration rather than passing vacuously.
--
--   (a) snapshot V1 @100, raise booking to 500, draw 200; restore V1
--       (100 < 200 drawn, i.e. BELOW the ledger) -> refused; the section
--       DELETE inside restore must roll back too (items intact)
--   (b) snapshot V2 books only a DIFFERENT product; restore V2 (REMOVES the
--       drawn product) -> refused
--   (c) snapshot V3 @400 (ABOVE the 200 drawn, and legal under the old
--       quantity rule) -> still refused, nothing changes; the booking then
--       draws its remaining 300 to closure from its un-restored state
--   (d) control: a quote with NO draws restores a lower-qty version freely,
--       proving the refusal is scoped to drawn bookings and nothing else
--   (e) both draw orders are cancelled, returning the ledger to zero and
--       reopening the quote; restore remains refused because their stamped
--       order-item audit rows deliberately survive cancellation
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
  -- Signature-newest-first. 20260813080000 widened the public wrapper to six
  -- arguments (p_below_cost_reason last), and every argument after the fourth
  -- carries a DEFAULT. That matters: a four-argument fallback still RESOLVES
  -- against the six-argument function, silently defaulting p_expected_row_version
  -- to NULL, which the row-version guard rejects as QUOTE_STALE_WRITE long
  -- before the drawn-ledger logic this chain exists to prove. Probing the
  -- widest signature first keeps the row version actually being sent.
  IF to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.restore_quote_version($1, $2, $3, $4, $5, NULL::text)'
      INTO v_result
      USING p_quote_id, p_version_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  IF to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint)') IS NOT NULL THEN
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
  v_draw_order_a uuid;
  v_draw_order_b uuid;
  v_cost numeric;
  v_cost_b numeric;
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
  v_restore_src text;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT p.prosrc INTO v_restore_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_restore_quote_version_owner_impl'
    AND p.pronargs = 4;
  IF v_restore_src IS NULL
     OR position('QUOTE_RESTORE_BLOCKED_BY_DRAW' IN v_restore_src) = 0 THEN
    RAISE EXCEPTION 'SMOKE_PREREQ: 20260816120000 is not installed; drawn-version restore guard is still parked';
  END IF;

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
  -- Products are BORROWED, not created. Since 20260718190000 a product cannot
  -- be born with pricing (require_governed_product_pricing) and cannot be
  -- repriced without a real previewed change set, while 20260812115236 and
  -- 20260812115237 both refuse a quote line whose product has no positive
  -- whole-cent cost. A throwaway product therefore cannot carry a legal cost
  -- basis. Borrow two already-priced products instead — the same "use a real
  -- row" pattern as the admin lookup above. Nothing is written to them; the
  -- quote lines below reference them and roll back with everything else.
  -- Cheapest-first, and capped at the unit price used below so the line never
  -- trips the below-cost approval gate.
  SELECT id, current_cost INTO v_prod_a, v_cost
  FROM products
  WHERE current_cost IS NOT NULL
    AND is_active IS TRUE
    AND current_cost > 0
    AND current_cost = round(current_cost, 2)
    AND current_cost <= 10
  ORDER BY current_cost, id
  LIMIT 1;
  SELECT id, current_cost INTO v_prod_b, v_cost_b
  FROM products
  WHERE current_cost IS NOT NULL
    AND is_active IS TRUE
    AND current_cost > 0
    AND current_cost = round(current_cost, 2)
    AND current_cost <= 10
    AND id IS DISTINCT FROM v_prod_a
  ORDER BY current_cost, id
  LIMIT 1;
  IF v_prod_a IS NULL OR v_prod_b IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need two products with a positive whole-cent current_cost of 10.00 or less';
  END IF;

  INSERT INTO quotes (quote_number, customer_id, created_by, status, commission_split)
  VALUES ('[SMOKE] RVG-' || v_suffix, v_customer, v_admin, 'sent', '{"splits": []}'::jsonb)
  RETURNING id INTO v_q;
  INSERT INTO quote_sections (quote_id, section_name)
  VALUES (v_q, 'Main') RETURNING id INTO v_sec;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q, v_sec, v_prod_a, 10, v_cost, 100, 'gal');

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

  -- V2: snapshot that books ONLY product B (drawn product A absent).
  -- Since 20260812115236 a quote line's product_id is immutable
  -- (QUOTE_ITEM_PRODUCT_IMMUTABLE) so the cost snapshot cannot be silently
  -- re-pointed at a different product. Replace the line the way save_quote
  -- does — delete then reinsert — instead of swapping product_id in place.
  DELETE FROM quote_items WHERE quote_id = v_q;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q, v_sec, v_prod_b, 10, v_cost_b, 400, 'gal');
  PERFORM pg_temp.create_quote_version_smoke(
    v_q, v_admin, 'presented', NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
  );
  SELECT id INTO v_v2 FROM quote_versions WHERE quote_id = v_q
  ORDER BY version_number DESC LIMIT 1;

  -- V3: snapshot @ A=400 (legal: >= the 200 that will be drawn).
  -- Same line-replacement rule as V2 above.
  DELETE FROM quote_items WHERE quote_id = v_q;
  INSERT INTO quote_items (quote_id, section_id, product_id,
    price_per_unit, current_cost, total_units_needed, unit_size)
  VALUES (v_q, v_sec, v_prod_a, 10, v_cost, 400, 'gal');
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
  v_draw_order_a := (v_res->>'order_id')::uuid;
  IF v_draw_order_a IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: setup draw 200/500 returned no order_id: %', v_res;
  END IF;
  SELECT quantity_drawn INTO v_drawn FROM quote_product_draws
  WHERE quote_id = v_q AND product_id = v_prod_a;
  IF v_drawn IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: setup expected drawn=200, got %', v_drawn;
  END IF;

  -- --------------------------------------------------------------------
  -- (a) Restore V1 (A booked 100 < 200 drawn): must be BLOCKED.
  --     Since 20260816120000 the refusal that fires here is
  --     QUOTE_RESTORE_BLOCKED_BY_DRAW, NOT the older BOOKING_OVERDRAWN
  --     fall-below message. Mason chose that deliberately broad scope on
  --     2026-08-19 (option B in the PR #404 entry of KNOWN_ISSUES.md): a
  --     booking that has EVER been drawn refuses restore up front, "before any
  --     destructive work", so the quantity comparison is never reached. The
  --     fall-below branch is therefore unreachable through restore — it is not
  --     dead code in general, only on this path.
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
  -- (b) Restore V2 (books only product B — removes drawn A): must be BLOCKED.
  --     Same broad refusal as (a). Keeping (a), (b) and (c) distinct still
  --     earns its keep: together they prove the refusal is uniform whether the
  --     snapshot falls BELOW the drawn ledger, REMOVES the drawn product
  --     entirely, or sits safely ABOVE it — the shape of the snapshot never
  --     buys a way past the guard.
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
  v_draw_order_b := (v_res->>'order_id')::uuid;
  IF v_draw_order_b IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) final draw returned no order_id: %', v_res;
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
  VALUES (v_qc, v_sec, v_prod_a, 10, v_cost, 300, 'gal');

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
  SELECT public.cancel_order(
    v_draw_order_b, v_admin, 'smoke-restore-cancel-final-' || v_suffix
  ) INTO v_res;
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) final draw cancellation returned %', v_res;
  END IF;
  PERFORM set_config('app.admin_override', 'false', true);

  SELECT public.cancel_order(
    v_draw_order_a, v_admin, 'smoke-restore-cancel-first-' || v_suffix
  ) INTO v_res;
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR v_res->>'status' IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) first draw cancellation returned %', v_res;
  END IF;
  PERFORM set_config('app.admin_override', 'false', true);

  SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_drawn
  FROM quote_product_draws WHERE quote_id = v_q;
  IF v_drawn IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) cancelled draws left ledger quantity % (expected 0)', v_drawn;
  END IF;
  SELECT status INTO v_status FROM quotes WHERE id = v_q;
  IF v_status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) cancelled draws did not reopen quote (status=%)', v_status;
  END IF;
  IF (SELECT count(*) FROM orders WHERE id IN (v_draw_order_a, v_draw_order_b) AND status = 'cancelled') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) both draw orders were not cancelled';
  END IF;
  IF (
    SELECT count(DISTINCT oi.order_id)
    FROM order_items oi
    JOIN quote_items qi ON qi.id = oi.quote_item_id
    WHERE qi.quote_id = v_q
      AND oi.order_id IN (v_draw_order_a, v_draw_order_b)
  ) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) both cancelled draw orders must retain stamped order_items, so the restore refusal is not vacuous';
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
