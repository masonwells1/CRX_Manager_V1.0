-- ============================================================================
-- restore_quote_version: drawn-version guard (Codex round-2 review, MEDIUM)
-- ----------------------------------------------------------------------------
-- FINDING (Codex 2026-06-11, MED): restore_quote_version deletes every
-- quote_section (cascading items) and re-inserts the snapshot's sections/items
-- directly — it never consults quote_product_draws. Restoring a version that
-- predates a draw could remove a drawn product or reduce a product's booked
-- quantity below quantity_drawn, bypassing the exact invariant save_quote's
-- drawn-product guard (20260610184230) enforces. Same corruption class:
-- ledger says 200 drawn of a product the quote no longer books, so reversal
-- math (20260610185806) and remainder rollover (20260610191456) both operate
-- on phantom quantities.
--
-- FIX: the identical guard block save_quote uses, placed AFTER the snapshot
-- restore loop (validating the FINAL persisted quote_items, exactly like
-- save_quote validates after its recalc) and BEFORE the idempotency save. For
-- every quote_product_draws row with quantity_drawn > 0, the restored booked
-- SUM(total_units_needed) per product must be >= quantity_drawn; otherwise
-- RAISE 'BOOKING_OVERDRAWN' (existing token, already mapped in the frontend)
-- and the whole restore — including the section DELETE — rolls back
-- atomically. Restores that keep every drawn product at/above its drawn
-- quantity are untouched, as is every quote with an empty ledger (the guard
-- SELECT finds no rows — natural no-op).
--
-- CONCURRENCY: the function's own `UPDATE quotes ... status='revised'` (live,
-- before the restore loop) takes the quotes row lock; draw_down_quote locks
-- the same row before touching the ledger. Under READ COMMITTED the guard's
-- ledger read therefore sees committed draw state — same serialization
-- argument as save_quote's guard (20260610184230 header).
--
-- VERBATIM BASE: body reproduced byte-for-byte from live prosrc (pre-apply
-- md5 36d8ddf7fa1807342ab64164427f8517, fetched 2026-06-11 — this is the
-- 20260608193139 strict-actor + operation-scoped-idempotency body). Exactly
-- TWO insertions, both sentinel-delimited / line-exact:
--   1. one DECLARE line:  v_drawn_guard record; -- drawn-version guard (20260611120100)
--   2. one guard block:   -- BEGIN drawn-version guard (20260611120100) ...
--                         -- END drawn-version guard (20260611120100)
-- The self-verification block strips both and md5-compares the remainder
-- against the live baseline.
--
-- Status literal 'revised' is a verbatim live carry-over (the admin_override-
-- bracketed restore write), not a new transition.
--
-- Grants: live proacl is {postgres, authenticated, service_role} (no anon /
-- PUBLIC). CREATE OR REPLACE preserves the ACL; the REVOKE/GRANT below just
-- re-asserts the verified live state, and the self-verify block asserts it.
-- caller-analysis: restore_quote_version :: sole caller is the version-history
--   UI (src/pages/QuoteBuilder.tsx:1177 handleRestoreVersion), which calls as
--   the AUTHENTICATED role — kept via the GRANT on the next line. The REVOKE
--   strips only PUBLIC/anon, which already lack EXECUTE live (proacl
--   {postgres,authenticated,service_role}). No caller loses access.
--
-- SMOKE TEST (rolled back): scripts/smoke/smoke-restore-version-drawn-guard.sql
-- (registered in scripts/smoke/smoke-specs.json under restore_quote_version).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.restore_quote_version(p_quote_id uuid, p_version_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
  v_actor uuid;
  v_drawn_guard record; -- drawn-version guard (20260611120100)
BEGIN
  -- Strict-actor auth (function previously had NO auth check). Before idempotency.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check — operation-scoped so a key minted for a different operation
  -- can't short-circuit a legitimate restore (was: matched idempotency_key alone).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'restore_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields. Bracket the status write with the admin override so
  -- the enforcer permits restore->revised from any source state (accepted/declined/etc.).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    total_price = (v_snapshot->'quote'->>'total_price')::numeric,
    total_cost = (v_snapshot->'quote'->>'total_cost')::numeric,
    total_profit = (v_snapshot->'quote'->>'total_profit')::numeric,
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes, needed_by_date)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      (v_section->>'needed_by_date')::date
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit
      )
      VALUES (
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        (v_item->>'profit')::numeric,
        (v_item->>'total_price')::numeric,
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit'
      );
    END LOOP;
  END LOOP;

  -- BEGIN drawn-version guard (20260611120100)
  -- Codex round-2 MED (2026-06-11): a restore must never under-book the drawn
  -- ledger (quote_product_draws deliberately survives the section delete +
  -- re-insert above). Validates the FINAL persisted quote_items — the same
  -- invariant, token, and block shape as save_quote's drawn-product guard
  -- (20260610184230). A violation rolls back the entire restore atomically,
  -- including the section DELETE.
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM quote_product_draws d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quote_id = p_quote_id
    AND d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — it removes %, which already has % drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — % would fall below its already-drawn % (restored total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;
  -- END drawn-version guard (20260611120100)

  -- Save idempotency key (result stored as a valid jsonb object — was a bare ::text UUID).
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'restore_quote_version', jsonb_build_object('quote_id', p_quote_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$function$;

-- Grants: re-assert the verified live state (no anon/PUBLIC; CREATE OR REPLACE
-- preserves the existing ACL — this is belt-and-suspenders, not a change).
REVOKE EXECUTE ON FUNCTION public.restore_quote_version(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_quote_version(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count int;
  v_src text;
  v_body text;
  v_b int;
  v_e int;
  v_end_marker text := '  -- END drawn-version guard (20260611120100)' || E'\n\n';
  v_md5 text;
BEGIN
  -- 1. Overload count unchanged (live pre-apply: exactly 1)
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'restore_quote_version' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'restore_quote_version overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'restore_quote_version' AND pronamespace = 'public'::regnamespace;

  -- 2. Guard present
  IF v_src NOT LIKE '%BOOKING_OVERDRAWN%'
     OR v_src NOT LIKE '%BEGIN drawn-version guard (20260611120100)%' THEN
    RAISE EXCEPTION 'restore_quote_version is missing the drawn-version guard';
  END IF;

  -- 3. Verbatim fidelity: body minus the two insertions must md5-match the
  --    pre-apply live body exactly (line endings normalized).
  v_body := replace(v_src, E'\r\n', E'\n');
  v_body := replace(v_body,
    '  v_drawn_guard record; -- drawn-version guard (20260611120100)' || E'\n', '');
  v_b := position('  -- BEGIN drawn-version guard (20260611120100)' IN v_body);
  v_e := position(v_end_marker IN v_body);
  IF v_b = 0 OR v_e = 0 OR v_e < v_b THEN
    RAISE EXCEPTION 'drawn-version guard markers not found or misordered in restore_quote_version body';
  END IF;
  v_body := left(v_body, v_b - 1) || substr(v_body, v_e + length(v_end_marker));
  v_md5 := md5(v_body);
  IF v_md5 <> '36d8ddf7fa1807342ab64164427f8517' THEN
    RAISE EXCEPTION 'restore_quote_version body-minus-guard md5 = % (expected 36d8ddf7fa1807342ab64164427f8517) — verbatim drift', v_md5;
  END IF;

  -- 4. Operation-scoped idempotency retained (regression guard contract,
  --    src/lib/rpcIdempotencyScope.test.ts)
  IF v_src NOT LIKE '%operation = ''restore_quote_version''%' THEN
    RAISE EXCEPTION 'restore_quote_version lost its operation-scoped idempotency lookup';
  END IF;

  -- 5. SECDEF + search_path intact
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'restore_quote_version' AND pronamespace = 'public'::regnamespace
      AND prosecdef
      AND array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'restore_quote_version must be SECURITY DEFINER with search_path = public, pg_temp';
  END IF;

  -- 6. Grants: authenticated keeps EXECUTE (in-body auth is the gate), anon
  --    must not have it, service_role must.
  IF NOT has_function_privilege('authenticated', 'public.restore_quote_version(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'restore_quote_version: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.restore_quote_version(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'restore_quote_version: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.restore_quote_version(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'restore_quote_version: service_role lost EXECUTE';
  END IF;
END $verify$;
