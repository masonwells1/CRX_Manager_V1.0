-- idempotency-body-check: exempt
-- ============================================================================
-- Planned-hold synchronization across quote workflows (Codex round-2, #3)
-- ----------------------------------------------------------------------------
-- RE-HOMED 2026-06-13 (overlapping-sessions recovery): this migration SUPERSEDES
-- the unapplied disk file 20260611132115_planned_holds_drawn_sync.sql, which had
-- an impossible clean-rebuild order — it sorted BEFORE the operation-scope sweep
-- 20260611211058 yet its precondition/baselines describe the POST-sweep live
-- state. 20260611132115 was NEVER applied live (verified absent from
-- supabase_migrations.schema_migrations 2026-06-13). This re-home carries a stamp
-- AFTER 20260611211058 so a clean rebuild reaches the three baseline functions in
-- their final post-sweep state before this runs (211058 carves out save_quote and
-- create_planned_holds and never touches restore_quote_version, so all three sit
-- at the asserted baselines when this lands). Body is byte-identical to the
-- re-based 132115 working copy. The in-body sentinel comments keep the original
-- "(20260611132115)" change-id as the historical marker; §5's strip-and-compare
-- keys on that literal sentinel, so it is retained verbatim. The final on-disk
-- stamp will be the MCP-assigned version at apply time (B7 rename).
-- ----------------------------------------------------------------------------
-- FINDING (Codex 2026-06-11, handoff §3): planned inventory holds were only
-- rebuilt by the Save Draft handler's explicit create_planned_holds call.
-- Revise and Mark-Presented saved quote data WITHOUT rebuilding holds (stale
-- reservations after a revision), and create_planned_holds itself recreated
-- holds from FULL quote_items.total_units_needed — re-reserving quantity that
-- quote_product_draws says was already drawn into orders (double-reservation:
-- the drawn quantity is counted in BOTH inventory.quantity_prebooked and the
-- hold, understating Net Free).
--
-- SEMANTICS (the business rule this encodes): while a planned quote is OPEN
-- (is_planned = true, status in draft/sent/revised), its active holds must
-- reserve exactly the REMAINING booking — GREATEST(booked − drawn, 0) per
-- product. Closed/unplanned quotes hold nothing. Per-draw FIFO decrement in
-- draw_down_quote stays (it keeps the invariant between saves); this
-- migration makes every SAVE re-establish it authoritatively.
--
-- FIX (server-side, one helper + three call sites):
--   * NEW internal helper _sync_planned_holds(p_quote_id, p_actor):
--     locks the quotes row (same lock draw_down_quote takes — serializes
--     against concurrent draws), releases holds for unplanned/closed quotes,
--     else rebuilds: DELETE active holds (create_planned_holds' existing
--     delete semantics) + re-insert per item at booked-minus-drawn, consuming
--     each product's drawn total against the EARLIEST items first (ORDER BY
--     needed_by_date NULLS LAST, section/item sort) so per-item expires_at
--     (needed_by + 14 days) follows the later, still-reserved portions.
--     EXECUTE revoked from PUBLIC/anon/authenticated — SECDEF bodies call it
--     as owner; not a client-callable RPC.
--   * create_planned_holds: auth/idempotency/not-planned guard byte-identical
--     (pre-change live prosrc md5 912db30f89fce14b0d114f6c1ea20c01); the
--     DELETE+rebuild loop is replaced by one helper call. Return shape
--     unchanged ({status:'created', holds_created}).
--   * save_quote: VERBATIM from live (pre-change prosrc md5
--     980a624c4e29ce01de0c977a007c0a15) + ONE sentinel-delimited PERFORM
--     block before the final RETURN. Draft-save, Revise, and Mark-Presented
--     all flow through save_quote, so every quote-saving workflow now syncs.
--   * restore_quote_version: VERBATIM from live (pre-change prosrc md5
--     9c5aedb109f35501dd53eadb5b4fcf1a — the 20260611131000 drawn-guard body)
--     + the same sentinel-delimited PERFORM block after the drawn-version
--     guard (restores rewrite quote_items wholesale).
-- The self-verification block strips the sentinel insertions and md5-compares
-- the remainders against the live baselines; create_planned_holds (small,
-- fully rewritten) is asserted to delegate to the helper.
--
-- The frontend's direct hold release on plan-toggle-off (QuoteBuilder) keeps
-- working and becomes redundant-but-harmless: the next save re-syncs.
--
-- OPERATION-SCOPE RECONCILIATION (re-based 2026-06-11 against the ACTUAL live
-- state): the live idempotency operation-scope sweep that shipped is
-- 20260611211058_idempotency_operation_scope_sweep, and it INTENTIONALLY
-- EXCLUDED save_quote and create_planned_holds (verified live: both remain at
-- their pre-scope baselines — save_quote md5 980a624c4e29ce01de0c977a007c0a15,
-- create_planned_holds 912db30f89fce14b0d114f6c1ea20c01, neither carries an
-- `operation = '<fn>'` filter) precisely so THIS migration owns them and the
-- two sessions don't clobber each other's re-emit. The superseded draft
-- 20260611080937 never applied. Consequently this migration takes the UNSCOPED
-- live baselines as its verbatim base and adds BOTH the operation-scope filter
-- AND the planned-hold sync call to save_quote / create_planned_holds in one
-- step. restore_quote_version was ALREADY operation-scoped live by the
-- 20260611131000 drawn-guard (md5 9c5aedb109f35501dd53eadb5b4fcf1a), so it
-- receives only the sync insertion. §0 asserts all three live baseline md5s
-- before any CREATE (aborts on drift — another session touching these); §5
-- strips the known insertions and md5-compares the remainder back to the
-- captured baseline, proving the re-emit changed nothing else.
--
-- SMOKE TEST (rolled back): scripts/smoke/smoke-planned-holds-drawn-sync.sql
-- (registered in scripts/smoke/smoke-specs.json under create_planned_holds).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Precondition + baseline capture (rls-review H1)
-- ----------------------------------------------------------------------------
DO $pre$
DECLARE
  v_sq  text;
  v_cph text;
  v_rqv text;
BEGIN
  SELECT md5(prosrc) INTO v_sq  FROM pg_proc WHERE proname = 'save_quote'            AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_cph FROM pg_proc WHERE proname = 'create_planned_holds'  AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_rqv FROM pg_proc WHERE proname = 'restore_quote_version' AND pronamespace = 'public'::regnamespace;

  -- Assert the exact live baselines this migration was authored against. If any
  -- differs, another session re-emitted the function since 2026-06-11 — ABORT
  -- rather than risk reverting their change (the cross-session clobber class).
  IF v_sq IS DISTINCT FROM '980a624c4e29ce01de0c977a007c0a15' THEN
    RAISE EXCEPTION 'PRECONDITION: live save_quote md5 % <> expected unscoped baseline 980a624c4e29ce01de0c977a007c0a15 — re-base before applying', v_sq;
  END IF;
  IF v_cph IS DISTINCT FROM '912db30f89fce14b0d114f6c1ea20c01' THEN
    RAISE EXCEPTION 'PRECONDITION: live create_planned_holds md5 % <> expected unscoped baseline 912db30f89fce14b0d114f6c1ea20c01 — re-base before applying', v_cph;
  END IF;
  IF v_rqv IS DISTINCT FROM '9c5aedb109f35501dd53eadb5b4fcf1a' THEN
    RAISE EXCEPTION 'PRECONDITION: live restore_quote_version md5 % <> expected scoped baseline 9c5aedb109f35501dd53eadb5b4fcf1a — re-base before applying', v_rqv;
  END IF;
END $pre$;

-- Captured for the §5 strip-and-compare self-verification.
CREATE TEMP TABLE _phs_baselines ON COMMIT DROP AS
SELECT proname, md5(prosrc) AS base_md5
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('save_quote', 'restore_quote_version');

-- ----------------------------------------------------------------------------
-- 1. Internal helper
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._sync_planned_holds(p_quote_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote quotes%ROWTYPE;
  v_item RECORD;
  v_consumed_so_far numeric;
  v_remaining_drawn numeric;
  v_consume numeric;
  v_hold_qty numeric;
  v_holds_created integer := 0;
  v_consumed jsonb := '{}'::jsonb;
BEGIN
  -- Lock the quote row: draw_down_quote takes the same lock before touching
  -- the ledger/holds, so a rebuild can never interleave with a draw.
  SELECT * INTO v_quote FROM quotes
  WHERE id = p_quote_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF NOT v_quote.is_planned OR v_quote.status NOT IN ('draft', 'sent', 'revised') THEN
    -- Not an open planned program: any active holds are stale — release them.
    -- (Terminal statuses are also covered by release_holds_on_quote_status_change;
    -- this additionally covers is_planned switched off without a status change.)
    UPDATE inventory_holds SET is_active = false, updated_at = now()
    WHERE source_id = p_quote_id AND is_active = true;
    RETURN 0;
  END IF;

  -- Rebuild from scratch (same DELETE semantics create_planned_holds used).
  DELETE FROM inventory_holds WHERE source_id = p_quote_id AND is_active = true;

  -- Reserve booked − drawn per product. Each product's drawn total consumes
  -- the earliest items first so expiry follows the still-reserved tail.
  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qs.needed_by_date,
           COALESCE(d.quantity_drawn, 0) AS drawn_total
    FROM quote_items qi
    JOIN quote_sections qs ON qs.id = qi.section_id
    LEFT JOIN quote_product_draws d
      ON d.quote_id = qi.quote_id AND d.product_id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND qi.total_units_needed IS NOT NULL
      AND qi.total_units_needed > 0
    ORDER BY qs.needed_by_date NULLS LAST, qs.sort_order, qi.sort_order, qi.id
  LOOP
    v_consumed_so_far := COALESCE((v_consumed->>v_item.product_id::text)::numeric, 0);
    v_remaining_drawn := GREATEST(v_item.drawn_total - v_consumed_so_far, 0);
    v_consume := LEAST(v_item.total_units_needed, v_remaining_drawn);
    v_hold_qty := v_item.total_units_needed - v_consume;
    v_consumed := jsonb_set(v_consumed, ARRAY[v_item.product_id::text],
      to_jsonb(v_consumed_so_far + v_consume));

    IF v_hold_qty > 0 THEN
      INSERT INTO inventory_holds (
        product_id, customer_id, quantity, hold_type, source_id,
        notes, created_by, expires_at, is_active
      ) VALUES (
        v_item.product_id,
        v_quote.customer_id,
        v_hold_qty,
        'crop_program',
        p_quote_id,
        'Planned program hold for quote ' || v_quote.quote_number,
        COALESCE(p_actor, v_quote.created_by),
        v_item.needed_by_date + INTERVAL '14 days',
        true
      );
      v_holds_created := v_holds_created + 1;
    END IF;
  END LOOP;

  RETURN v_holds_created;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public._sync_planned_holds(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_planned_holds(uuid, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- 2. create_planned_holds — delegates the rebuild to the helper
--    (auth / idempotency / not-planned guard byte-identical to live)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_planned_holds(p_quote_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote quotes%ROWTYPE;
  v_holds_created integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_planned_holds' AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_planned_holds', to_jsonb(p_quote_id));
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF NOT v_quote.is_planned THEN
    RAISE EXCEPTION 'Quote is not marked as planned: %', p_quote_id;
  END IF;

  -- Planned-hold sync (20260611132115): the rebuild now reserves
  -- GREATEST(booked − drawn, 0) per product instead of the full booked
  -- quantity — quantity already drawn to orders lives in
  -- inventory.quantity_prebooked and must not be reserved twice.
  v_holds_created := _sync_planned_holds(p_quote_id, v_actor);

  RETURN jsonb_build_object('status', 'created', 'holds_created', v_holds_created);
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3. save_quote — VERBATIM from live + ONE sentinel-delimited sync block
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_quote(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_section_id uuid;
  v_item jsonb;
  v_section jsonb;
  v_status text;
  v_old_status text;
  v_tier int;
  v_server_totals record;
  v_drawn_guard record; -- drawn-product guard (20260610190100)
  v_allowed_transitions jsonb := '{
    "draft": ["sent","revised","declined","expired"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"],
    "expired": ["revised"]
  }'::jsonb;
BEGIN
  -- Auth: derive actor from JWT
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND role IN ('admin','sales_rep') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'save_quote' AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object(
        'status', 'duplicate',
        'quote_id', p_quote_id
      );
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_quote', jsonb_build_object('quote_id', COALESCE(p_quote_id, gen_random_uuid())));
  END IF;

  v_status := COALESCE(p_quote_payload->>'status', 'draft');
  v_tier := COALESCE((p_quote_payload->>'tier')::int, 1);

  IF p_quote_id IS NOT NULL THEN
    -- UPDATE existing quote
    SELECT status INTO v_old_status FROM quotes WHERE id = p_quote_id;
    IF v_old_status IS NULL THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;

    -- State machine validation
    IF v_status IS DISTINCT FROM v_old_status THEN
      IF NOT (
        v_allowed_transitions->v_old_status IS NOT NULL
        AND v_allowed_transitions->v_old_status ? v_status
      ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', v_old_status, v_status;
      END IF;
    END IF;

    UPDATE quotes SET
      customer_id = (p_quote_payload->>'customer_id')::uuid,
      tier = v_tier,
      status = v_status,
      commission_split = CASE
        WHEN p_quote_payload->'commission_split' IS NOT NULL
        THEN p_quote_payload->'commission_split'
        ELSE commission_split
      END,
      valid_days = COALESCE((p_quote_payload->>'valid_days')::int, valid_days),
      expires_at = COALESCE((p_quote_payload->>'expires_at')::date, expires_at),
      header_notes = p_quote_payload->>'header_notes',
      footer_notes = p_quote_payload->>'footer_notes',
      sent_at = CASE
        WHEN v_status = 'sent' AND sent_at IS NULL THEN now()
        WHEN v_status = 'sent' THEN sent_at
        ELSE sent_at
      END,
      updated_at = now()
    WHERE id = p_quote_id;

    v_quote_id := p_quote_id;

    -- Delete old sections (cascade deletes items)
    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  ELSE
    -- INSERT new quote (must start as draft)
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft';
    END IF;

    INSERT INTO quotes (
      id, quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit, total_margin_pct,
      valid_days, expires_at, header_notes, footer_notes, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      v_actor,
      v_tier,
      'draft',
      COALESCE(p_quote_payload->'commission_split', '{"splits":[]}'::jsonb),
      0, 0, 0, 0,
      COALESCE((p_quote_payload->>'valid_days')::int, 15),
      COALESCE((p_quote_payload->>'expires_at')::date, current_date + 15),
      p_quote_payload->>'header_notes',
      p_quote_payload->>'footer_notes',
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  -- Insert sections and items
  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes'
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        id, quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, price_override, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin,
        calc_mode, price_unit
      ) VALUES (
        gen_random_uuid(),
        v_quote_id,
        v_section_id,
        (v_item->>'product_id')::uuid,
        COALESCE((v_item->>'sort_order')::int, 0),
        v_item->>'notes',
        COALESCE((v_item->>'price_per_unit')::numeric, 0),
        (v_item->>'price_override')::numeric,
        COALESCE((v_item->>'current_cost')::numeric, 0),
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        COALESCE((v_item->>'profit')::numeric, 0),
        COALESCE((v_item->>'total_price')::numeric, 0),
        COALESCE((v_item->>'net_margin')::numeric, 0),
        COALESCE(v_item->>'calc_mode', 'rate_acres'),
        v_item->>'price_unit'
      );
    END LOOP;
  END LOOP;

  -- SERVER-AUTHORITATIVE RECALCULATION
  -- ppu uses the stored price_override when present, falls back to tier pricing.
  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.calc_mode, 'rate_acres') AS calc_mode,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      COALESCE(qi.total_units_needed, 0) AS client_units,
      COALESCE(qi.price_override, CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
      END) AS ppu,
      COALESCE(p.current_cost, 0) AS cc,
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(COALESCE(p.inventory_unit, p.unit_size, 'Ea'))
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      calc_mode,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0 AND inv_oz > 0
          THEN ROUND((client_units * inv_oz) / ac, 2)
        WHEN calc_mode = 'rate_acres'
          THEN ROUND(ar * rate_oz, 2)
        ELSE 0
      END AS oz_per_acre,
      CASE
        WHEN calc_mode = 'units_direct' THEN ROUND(client_units, 2)
        WHEN inv_oz > 0 THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0
      END AS total_units,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0
          THEN ROUND(ppu * client_units / ac, 2)
        WHEN calc_mode = 'rate_acres' AND inv_oz > 0
          THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0
      END AS price_per_acre
    FROM base
  ),
  final AS (
    SELECT
      item_id,
      ppu,
      cc,
      oz_per_acre,
      total_units,
      price_per_acre,
      ROUND(ppu * total_units, 2) AS total_price,
      ROUND((ppu - cc) * total_units, 2) AS profit,
      CASE
        WHEN ppu * total_units > 0
          THEN ROUND(((ppu - cc) * total_units) / (ppu * total_units) * 100, 2)
        ELSE 0
      END AS net_margin
    FROM calc
  )
  UPDATE quote_items qi SET
    price_per_unit = f.ppu,
    current_cost = f.cc,
    oz_per_acre = f.oz_per_acre,
    total_units_needed = f.total_units,
    price_per_acre = f.price_per_acre,
    total_price = f.total_price,
    profit = f.profit,
    net_margin = f.net_margin
  FROM final f
  WHERE qi.id = f.item_id;

  -- BEGIN drawn-product guard (20260610190100)
  -- A4: a partially-drawn booking must never be edited below — or out of —
  -- its drawn history (quote_product_draws deliberately survives the section
  -- delete+recreate above). Runs AFTER the server-authoritative recalc so it
  -- validates the FINAL persisted total_units_needed (the recalc rewrites the
  -- client-supplied values). Reuses the existing BOOKING_OVERDRAWN token.
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM quote_product_draws d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = v_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quote_id = v_quote_id
    AND d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot remove % — % already drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot reduce % below its already-drawn % (new total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;
  -- END drawn-product guard (20260610190100)

  -- Recalculate quote-level totals
  SELECT
    COALESCE(SUM(total_price), 0) AS total_price,
    COALESCE(SUM(current_cost * total_units_needed), 0) AS total_cost,
    COALESCE(SUM(profit), 0) AS total_profit
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  UPDATE quotes SET
    total_price = v_server_totals.total_price,
    total_cost = (SELECT COALESCE(SUM(current_cost * total_units_needed), 0) FROM quote_items WHERE quote_id = v_quote_id),
    total_profit = (SELECT COALESCE(SUM(profit), 0) FROM quote_items WHERE quote_id = v_quote_id),
    total_margin_pct = CASE
      WHEN (SELECT COALESCE(SUM(total_price), 0) FROM quote_items WHERE quote_id = v_quote_id) > 0
      THEN ROUND(
        (SELECT COALESCE(SUM(profit), 0) FROM quote_items WHERE quote_id = v_quote_id)
        / (SELECT COALESCE(SUM(total_price), 0) FROM quote_items WHERE quote_id = v_quote_id) * 100, 2
      )
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  -- Log activity
  INSERT INTO activity_feed (id, event_type, description, performed_by, related_entity_type, related_entity_id, created_at)
  VALUES (
    gen_random_uuid(),
    CASE WHEN p_quote_id IS NOT NULL THEN 'quote_updated' ELSE 'quote_created' END,
    'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' saved',
    v_actor,
    'quote',
    v_quote_id,
    now()
  );

  -- BEGIN planned-hold sync (20260611132115)
  -- Codex round-2 #3: planned holds must reflect the remaining reservation
  -- (booked − drawn) after EVERY save — Draft save, Revise, and Mark
  -- Presented all flow through save_quote. The helper self-gates: no-op for
  -- non-planned quotes, releases holds when is_planned was switched off or
  -- the status closed.
  PERFORM _sync_planned_holds(v_quote_id, v_actor);
  -- END planned-hold sync (20260611132115)

  RETURN jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    'server_totals', jsonb_build_object(
      'total_price', (SELECT total_price FROM quotes WHERE id = v_quote_id),
      'total_cost', (SELECT total_cost FROM quotes WHERE id = v_quote_id),
      'total_profit', (SELECT total_profit FROM quotes WHERE id = v_quote_id),
      'total_margin_pct', (SELECT total_margin_pct FROM quotes WHERE id = v_quote_id)
    )
  );
END;
$function$;

-- ----------------------------------------------------------------------------
-- 4. restore_quote_version — VERBATIM from live + the same sync block
-- ----------------------------------------------------------------------------
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

  -- BEGIN planned-hold sync (20260611132115)
  -- Codex round-2 #3: restores rewrite quote_items wholesale — rebuild the
  -- planned reservation (booked − drawn) to match the restored state.
  PERFORM _sync_planned_holds(p_quote_id, v_actor);
  -- END planned-hold sync (20260611132115)

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

-- ----------------------------------------------------------------------------
-- 5. Self-verification
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count int;
  v_src text;
  v_md5 text;
BEGIN
  -- Overload counts: exactly 1 each
  FOR v_src IN SELECT unnest(ARRAY['_sync_planned_holds','create_planned_holds','save_quote','restore_quote_version'])
  LOOP
    SELECT count(*) INTO v_count
    FROM pg_proc WHERE proname = v_src AND pronamespace = 'public'::regnamespace;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% overload count = %, expected 1', v_src, v_count;
    END IF;
  END LOOP;

  -- create_planned_holds delegates to the helper
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'create_planned_holds' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%_sync_planned_holds(p_quote_id, v_actor)%' THEN
    RAISE EXCEPTION 'create_planned_holds does not delegate to _sync_planned_holds';
  END IF;

  -- save_quote: strip BOTH insertions (the operation-scope filter AND the sync
  -- block) -> the remainder must equal the captured UNSCOPED baseline 980a624c,
  -- proving the re-emit added exactly those two things and nothing else.
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'save_quote' AND pronamespace = 'public'::regnamespace;
  v_md5 := md5(replace(replace(v_src,
    E'\n  -- BEGIN planned-hold sync (20260611132115)\n  -- Codex round-2 #3: planned holds must reflect the remaining reservation\n  -- (booked − drawn) after EVERY save — Draft save, Revise, and Mark\n  -- Presented all flow through save_quote. The helper self-gates: no-op for\n  -- non-planned quotes, releases holds when is_planned was switched off or\n  -- the status closed.\n  PERFORM _sync_planned_holds(v_quote_id, v_actor);\n  -- END planned-hold sync (20260611132115)\n',
    ''),
    E' AND operation = ''save_quote''', ''));
  IF v_md5 <> (SELECT base_md5 FROM _phs_baselines WHERE proname = 'save_quote') THEN
    RAISE EXCEPTION 'save_quote body drifted beyond the two known insertions (stripped md5 = %, baseline = %)',
      v_md5, (SELECT base_md5 FROM _phs_baselines WHERE proname = 'save_quote');
  END IF;
  -- ...and the operation-scope filter this migration installs must be present
  IF v_src NOT LIKE '%operation = ''save_quote''%' THEN
    RAISE EXCEPTION 'save_quote is missing the operation-scoped idempotency lookup';
  END IF;

  -- restore_quote_version: strip the sentinel block -> must equal the
  -- apply-time live body captured in §0
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'restore_quote_version' AND pronamespace = 'public'::regnamespace;
  v_md5 := md5(replace(v_src,
    E'\n  -- BEGIN planned-hold sync (20260611132115)\n  -- Codex round-2 #3: restores rewrite quote_items wholesale — rebuild the\n  -- planned reservation (booked − drawn) to match the restored state.\n  PERFORM _sync_planned_holds(p_quote_id, v_actor);\n  -- END planned-hold sync (20260611132115)\n',
    ''));
  IF v_md5 <> (SELECT base_md5 FROM _phs_baselines WHERE proname = 'restore_quote_version') THEN
    RAISE EXCEPTION 'restore_quote_version body drifted beyond the sync insertion (stripped md5 = %, apply-time baseline = %)',
      v_md5, (SELECT base_md5 FROM _phs_baselines WHERE proname = 'restore_quote_version');
  END IF;

  -- create_planned_holds: rewritten body must carry the operation-scoped lookup
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'create_planned_holds' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%operation = ''create_planned_holds''%' THEN
    RAISE EXCEPTION 'create_planned_holds is missing the operation-scoped idempotency lookup';
  END IF;

  -- Helper must not be client-callable
  IF has_function_privilege('authenticated', 'public._sync_planned_holds(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '_sync_planned_holds is EXECUTE-able by authenticated — must be owner/service only';
  END IF;
END $verify$;
