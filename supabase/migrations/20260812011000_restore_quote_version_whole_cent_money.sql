-- Quote-version restore: normalize constrained snapshot money to whole cents
--
-- _restore_quote_version_owner_impl copied four constrained money fields from
-- JSON snapshots with bare numeric casts. A historical snapshot containing a
-- fractional cent therefore failed the table CHECK with an opaque constraint
-- error. The failure rolled the entire restore back atomically, so it could
-- make a version permanently un-restorable but could not store bad money.
--
-- This migration rejects NaN and +/-Infinity before the first restore write
-- with QUOTE_SNAPSHOT_MONEY_NOT_FINITE, then rounds only the constrained
-- extended totals: quotes.total_price, quotes.total_profit,
-- quote_items.total_price, and quote_items.profit. Production currently has
-- 3 quote_versions rows and none contains sub-cent values in those four
-- fields, so this is preventive rather than a data repair.
--
-- Deliberately unchanged: quotes.total_margin_pct and quote_items.net_margin
-- are percentages; quote_items.current_cost, price_per_unit, and
-- price_per_acre are per-unit values that this schema does not cent-round;
-- quotes.total_cost is money but has no whole-cent CHECK and remains a tracked
-- finding under the 2026-08-10 money decision, so it is not rewritten without
-- owner approval.
--
-- The base function text in 20260703130000_layer2_channel_separation_reserve_fixes.sql
-- was LF-normalized md5-verified byte-for-byte against the live owner impl
-- before editing. Apart from the current private name and the money changes
-- described above, the function body is unchanged.

CREATE OR REPLACE FUNCTION public._restore_quote_version_owner_impl(p_quote_id uuid, p_version_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
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

  -- Reject non-finite constrained money before the first destructive restore write.
  IF (v_snapshot->'quote'->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_price in version % is non-finite', p_version_id;
  END IF;
  IF (v_snapshot->'quote'->>'total_profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_profit in version % is non-finite', p_version_id;
  END IF;
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      IF (v_item->>'profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.profit in version % is non-finite', p_version_id;
      END IF;
      IF (v_item->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.total_price in version % is non-finite', p_version_id;
      END IF;
    END LOOP;
  END LOOP;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields. Bracket the status write with the admin override so
  -- the enforcer permits restore->revised from any source state (accepted/declined/etc.).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    total_price = ROUND((v_snapshot->'quote'->>'total_price')::numeric, 2),
    total_cost = (v_snapshot->'quote'->>'total_cost')::numeric,
    total_profit = ROUND((v_snapshot->'quote'->>'total_profit')::numeric, 2),
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
        ROUND((v_item->>'profit')::numeric, 2),
        ROUND((v_item->>'total_price')::numeric, 2),
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
  -- LAYER2<<< drawn guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1).
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — it removes %, which already has % drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — % would fall below its already-drawn % (restored total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;
  -- END drawn-version guard (20260611120100)

  -- BEGIN planned-hold + job-reservation sync (20260611132115 + Layer2 A3.12)
  -- Codex round-2 #3: restores rewrite quote_items wholesale — rebuild the
  -- planned reservation (booked − drawn) to match the restored state.
  -- LAYER2-CHAN (push-gate #C): a restore that changes booked quantity must ALSO
  -- re-sync the quote's ACTIVE jobs (draws + shed holds), exactly as save_quote now
  -- does — else a restored-larger booking leaves stale job draws and reopens balance
  -- the job still needs. _sync_quote_job_reservations rebuilds the jobs THEN calls
  -- _sync_planned_holds itself (strict superset). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(p_quote_id, v_actor);
  -- END planned-hold + job-reservation sync

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

REVOKE ALL ON FUNCTION public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._restore_quote_version_owner_impl(uuid, uuid, uuid, text)
  TO service_role;

DO $verify$
DECLARE
  v_overloads integer;
  v_security_definer boolean;
  v_config text[];
  v_src text;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_restore_quote_version_owner_impl';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 _restore_quote_version_owner_impl, found %', v_overloads;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc
    INTO v_security_definer, v_config, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_restore_quote_version_owner_impl';

  IF NOT v_security_definer THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: _restore_quote_version_owner_impl is not SECURITY DEFINER';
  END IF;
  IF NOT ('search_path=public, pg_temp' = ANY (COALESCE(v_config, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: _restore_quote_version_owner_impl search_path is not public, pg_temp';
  END IF;
  IF has_function_privilege('anon', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: browser role can execute _restore_quote_version_owner_impl';
  END IF;
  IF NOT has_function_privilege('service_role', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role cannot execute _restore_quote_version_owner_impl';
  END IF;

  IF position('QUOTE_SNAPSHOT_MONEY_NOT_FINITE' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: non-finite snapshot-money guard is missing from _restore_quote_version_owner_impl';
  END IF;
  IF position('total_price = ROUND((v_snapshot->''quote''->>''total_price'')::numeric, 2)' in v_src) = 0
     OR position('total_profit = ROUND((v_snapshot->''quote''->>''total_profit'')::numeric, 2)' in v_src) = 0
     OR position('ROUND((v_item->>''profit'')::numeric, 2)' in v_src) = 0
     OR position('ROUND((v_item->>''total_price'')::numeric, 2)' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: constrained snapshot money is not rounded to whole cents';
  END IF;
  IF position('total_price = (v_snapshot->''quote''->>''total_price'')::numeric' in v_src) > 0
     OR position('total_profit = (v_snapshot->''quote''->>''total_profit'')::numeric' in v_src) > 0
     OR position(E'\n        (v_item->>''profit'')::numeric,' in v_src) > 0
     OR position(E'\n        (v_item->>''total_price'')::numeric,' in v_src) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: bare unrounded constrained-money copy remains in _restore_quote_version_owner_impl';
  END IF;
END;
$verify$;
