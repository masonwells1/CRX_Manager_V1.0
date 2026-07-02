-- ============================================================================
-- PARKED DRAFT — DO NOT APPLY (structure-fix loop, Wave A / A3). 2026-07-02.
-- Mason applies via the DRAFT/APPLY protocol after review.
--
-- WHAT: save_quote stops silently dropping 4 UI-edited fields on every re-save.
-- WHY:  The live save_quote (rebuilt verbatim from pg_get_functiondef, canonical
--       = 20260616204400) omits section_header_notes / needed_by_date / field_id
--       from the quote_sections INSERT, and never writes quotes.is_planned. Because
--       sections are DELETE+re-INSERTed on every save, those 3 section fields are
--       WIPED to NULL each save, and the is_planned toggle never persists. Downstream:
--       create_planned_holds (is_planned), quote-section→job scheduling (needed_by_date
--       → job date, field_id → job_fields, section_header_notes → job name).
-- SCOPE: ADDITIVE restore only. The UI (QuoteBuilder.tsx:889,898-900) already sends
--        all four keys. Idempotency `AND operation=` is ALREADY LIVE in
--        create_job_from_quote_section (20260611211058) — NOT re-touched here.
-- SAFE:  additive; verbatim reproduction of live save_quote with exactly the 4 field
--        restores. NULLIF(...,'')::date/::uuid so empty/null payloads clear cleanly.
--
-- SMOKE (2026-07-02, live rolled-back BEGIN…ROLLBACK + plpgsql_check): PASS —
--   full function CREATE OR REPLACEd in a tx; plpgsql_check = NO FINDINGS - CLEAN; tx aborted
--   via summary RAISE; live save_quote confirmed unchanged (is_planned + section-field lines
--   absent live, position()=0). No rows written (function never called).
-- CODEX: CLEAN — "did not find any introduced correctness issues in the reviewed changes."
-- DRIFT-REVIEW (migration-drift-reviewer): CLEAN / additive-only. Byte-for-byte diff vs canonical
--   20260616204400 confirms the ONLY changes are the 4 field-restores; all 4 columns/types verified
--   vs registry + DDL + src/types/index.ts. Live overload count = 1 (signature identical), confirmed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_quote(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
  -- DELTA-SQ BEGIN (B #5: trim v_allowed_transitions to a strict subset of _enforce_quote_status_transition;
  -- remove draft->revised/declined/expired and the terminal-expired->revised edge the trigger rejects)
  v_allowed_transitions jsonb := '{
    "draft": ["sent"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"]
  }'::jsonb;
  -- DELTA-SQ END
  -- DELTA-SQ BEGIN (A #5: canonical idempotency — cache/replay the rich result)
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-SQ END
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

  -- DELTA-SQ BEGIN (A #5: canonical check — replay the cached rich result; the save now happens at the tail
  -- with the REAL quote id, not a pre-work gen_random_uuid() placeholder)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  -- DELTA-SQ END

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
      -- A3: persist the is_planned toggle the UI edits (was silently ignored).
      is_planned = COALESCE((p_quote_payload->>'is_planned')::boolean, is_planned),
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
      valid_days, expires_at, header_notes, footer_notes, is_planned, created_at, updated_at
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
      -- A3: persist is_planned on new quotes too.
      COALESCE((p_quote_payload->>'is_planned')::boolean, false),
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  -- Insert sections and items
  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes,
      -- A3: restore the 3 section fields the UI edits (were wiped on every re-save).
      section_header_notes, needed_by_date, field_id
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      NULLIF(v_section->>'needed_by_date', '')::date,
      NULLIF(v_section->>'field_id', '')::uuid
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

  -- DELTA-SQ BEGIN (A #5: build the rich result, cache it via the canonical helper with the REAL quote id, replay it)
  v_result := jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    'server_totals', jsonb_build_object(
      'total_price', (SELECT total_price FROM quotes WHERE id = v_quote_id),
      'total_cost', (SELECT total_cost FROM quotes WHERE id = v_quote_id),
      'total_profit', (SELECT total_profit FROM quotes WHERE id = v_quote_id),
      'total_margin_pct', (SELECT total_margin_pct FROM quotes WHERE id = v_quote_id)
    )
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_quote', v_result);
  END IF;

  RETURN v_result;
  -- DELTA-SQ END
END;
$function$;
