-- Layer 2 · Part A polish · Cycle A3.11 — quote<->job reservation coordination
-- (Codex push-gate findings #2 / #3 / #4 / #5, 2026-07-03)
-- ============================================================================
-- THE GAP (one area, four facets): quote edits and job scheduling did not
-- coordinate their inventory reservations. The per-job reserve engine sized each
-- job INDEPENDENTLY, and nothing re-synced a quote's jobs when the quote itself
-- changed. Concretely:
--   #4  save_quote grows a quote's booking but never re-runs the job reserve, so
--       a job keeps its stale (too-small) draw -> the added quantity reopens as
--       re-drawable balance while the job hold already reserves that demand.
--   #5  the A3.10 unplan guard reads job_product_draws WITHOUT locking the quote
--       first -> a concurrent schedule can slip a draw in between the guard's
--       EXISTS check and the UPDATE (TOCTOU).
--   #2  when one of several jobs on the same quote+product is cancelled/deleted,
--       its draw is reversed but the SIBLING jobs are NOT re-drawn -> the freed
--       booking shows drawable while a sibling still needs it.
--   #3  the hold formula subtracted the quote-level ORDER draw PER JOB, so two
--       jobs on one product each assumed the full order-prebooked coverage ->
--       under-reserve.
--
-- THE FIX -- one coordinated allocator, `_sync_quote_job_reservations(quote,actor)`:
-- rebuild EVERY active job's draws+holds for the quote together, allocating the
-- crop-drawable remainder AND the order-prebooked coverage ONCE across sibling
-- jobs (FIFO by job creation). For a single job with no siblings it is
-- ARITHMETICALLY IDENTICAL to the old per-job formula (draw = LEAST(demand,
-- booking - order - consumed); hold = draw + GREATEST(demand - draw - order, 0)),
-- so single-job behavior is unchanged; it differs -- correctly -- only when 2+
-- jobs share a product.
--   * `_sync_job_holds(job,actor)` becomes a thin ROUTER: a quote-linked job goes
--     through the coordinated allocator (which handles that job's own
--     reserve/release AND sibling reallocation on cancel/delete); a quote-less
--     job keeps the old independent full-demand behavior. It still returns the
--     job's warn shortfalls, so the job_chemicals / jobs triggers and
--     reserve_job_inventory are UNCHANGED.
--   * `save_quote`: (a) locks the quote FOR UPDATE before the unplan guard (#5),
--     and (b) calls the coordinated allocator instead of _sync_planned_holds at
--     the end, so a quote edit re-syncs its jobs (#4). save_quote is otherwise
--     reproduced VERBATIM from its live catalog definition (introspected +
--     diffed; single overload (uuid,jsonb,jsonb,uuid,text)). Only the two lines
--     marked LAYER2-COORD change.
--
-- All four facets are DORMANT on the current operational DB (0 job draws, 0 job
-- holds; the 2 live jobs are fake test data / §6.6 no backfill). Warn-only --
-- never blocks a schedule or a save.
--
-- status-enum-check: exempt
--   (writes the inventory_holds.hold_type literal 'job'; the CHECK was extended
--    to a superset in A1 20260702170000.)
-- ============================================================================

-- == Coordinated allocator (new) =============================================
CREATE OR REPLACE FUNCTION public._sync_quote_job_reservations(p_quote_id uuid, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote quotes%ROWTYPE;
  v_planned_open boolean := false;
  v_actor uuid;
  v_row RECORD;
  v_prev_product uuid;
  v_booking numeric;
  v_order_drawn numeric;
  v_consumed_drawn numeric;
  v_crop_pool numeric := 0;
  v_preb_pool numeric := 0;
  v_draw numeric;
  v_rem numeric;
  v_cover numeric;
  v_hold numeric;
BEGIN
  v_actor := COALESCE(p_actor, auth.uid());

  -- Lock the parent quote (same rule the per-job engine used: 'accepted' still
  -- counts as open; only declined/expired/cancelled do not). This lock also
  -- serializes concurrent job syncs on the same quote AND the save_quote unplan
  -- guard (both take the quote FOR UPDATE first) -- the fix for #5.
  SELECT * INTO v_quote FROM quotes
  WHERE id = p_quote_id AND deleted_at IS NULL
  FOR UPDATE;
  v_planned_open := FOUND
    AND v_quote.is_planned
    AND v_quote.status NOT IN ('declined', 'expired', 'cancelled');

  -- Clean slate for this quote's job reservations:
  --   * drop every 'job' hold for jobs on this quote (the loop re-adds one per
  --     ACTIVE job);
  --   * drop draws for every NON-consumed job (ACTIVE -> rebuilt below;
  --     cancelled / soft-deleted-while-active -> stay gone). KEEP completed /
  --     invoiced job draws: that chemical was physically applied (complete_job
  --     already deducted the stock), so its draw permanently consumes the
  --     booking (Codex A+B round-1 P1 #1).
  DELETE FROM inventory_holds
   WHERE hold_type = 'job'
     AND source_id IN (SELECT id FROM jobs WHERE quote_id = p_quote_id);

  DELETE FROM job_product_draws jpd
   USING jobs j
   WHERE jpd.job_id = j.id
     AND jpd.quote_id = p_quote_id
     AND j.status NOT IN ('completed', 'invoiced');

  -- Coordinated allocation across ACTIVE sibling jobs, product by product.
  -- Per product (only when the parent quote is an open planned booking):
  --   crop_pool = booking - order_drawn - consumed_job_drawn   (drawable crop)
  --   preb_pool = order_drawn                                  (order-prebooked)
  -- Jobs draw crop first (FIFO by creation), then prebooked covers what's left;
  -- any demand beyond both pools is genuinely new stock the job must hold in
  -- full. Allocating each pool ONCE across siblings fixes #2 (a cancelled job
  -- frees crop that this re-sync re-draws to the remaining siblings) and #3
  -- (order coverage counted once, not per job). For a lone active job with no
  -- consumed sibling the result equals the prior per-job formula exactly.
  v_prev_product := NULL;
  FOR v_row IN
    SELECT j.id AS job_id, j.customer_id, j.job_number, j.created_by, j.created_at,
           jc.product_id,
           SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) AS demand
    FROM jobs j
    JOIN job_chemicals jc ON jc.job_id = j.id
    JOIN products p ON p.id = jc.product_id
    WHERE j.quote_id = p_quote_id
      AND j.deleted_at IS NULL
      AND j.status IN ('scheduled', 'in_progress')
      AND jc.product_id IS NOT NULL
    GROUP BY j.id, j.customer_id, j.job_number, j.created_by, j.created_at, jc.product_id
    HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) > 0
    ORDER BY jc.product_id, j.created_at NULLS LAST, j.id
  LOOP
    IF v_row.product_id IS DISTINCT FROM v_prev_product THEN
      -- New product: lock its inventory row (serialize concurrent same-product
      -- reserves; lock order quote -> inventory matches draw_down_quote), then
      -- (re)compute the two pools.
      PERFORM 1 FROM inventory
      WHERE product_id = v_row.product_id AND location = 'Main Warehouse'
      FOR UPDATE;

      IF v_planned_open THEN
        SELECT COALESCE(SUM(qi.total_units_needed), 0) INTO v_booking
        FROM quote_items qi
        WHERE qi.quote_id = p_quote_id AND qi.product_id = v_row.product_id;

        SELECT COALESCE(quantity_drawn, 0) INTO v_order_drawn
        FROM quote_product_draws
        WHERE quote_id = p_quote_id AND product_id = v_row.product_id;
        v_order_drawn := COALESCE(v_order_drawn, 0);

        -- After the DELETE above, the only job_product_draws rows left for this
        -- quote+product belong to completed/invoiced (consumed) jobs -- their
        -- chemical was applied, so it permanently consumes the booking.
        SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_consumed_drawn
        FROM job_product_draws
        WHERE quote_id = p_quote_id AND product_id = v_row.product_id;

        v_crop_pool := GREATEST(v_booking - v_order_drawn - v_consumed_drawn, 0);
        v_preb_pool := v_order_drawn;
      ELSE
        v_crop_pool := 0;
        v_preb_pool := 0;
      END IF;

      v_prev_product := v_row.product_id;
    END IF;

    v_draw  := LEAST(v_row.demand, v_crop_pool);
    v_crop_pool := v_crop_pool - v_draw;
    v_rem   := v_row.demand - v_draw;
    v_cover := LEAST(v_rem, v_preb_pool);
    v_preb_pool := v_preb_pool - v_cover;
    v_hold  := v_draw + (v_rem - v_cover);

    IF v_draw > 0 THEN
      INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn)
      VALUES (v_row.job_id, p_quote_id, v_row.product_id, v_draw)
      ON CONFLICT (job_id, product_id)
      DO UPDATE SET quantity_drawn = EXCLUDED.quantity_drawn,
                    quote_id       = EXCLUDED.quote_id,
                    updated_at     = now();
    END IF;

    -- status-enum-check: exempt (writes the 'job' hold_type added by A1 20260702170000)
    IF v_hold > 0 THEN
      INSERT INTO inventory_holds (
        product_id, customer_id, quantity, hold_type, source_id,
        notes, created_by, expires_at, is_active
      ) VALUES (
        v_row.product_id, v_row.customer_id, v_hold, 'job', v_row.job_id,
        'Job reservation for ' || COALESCE(v_row.job_number, v_row.job_id::text),
        COALESCE(v_actor, v_row.created_by), NULL, true
      );
    END IF;
  END LOOP;

  -- Resync the parent quote's crop_program holds to reflect the new job draws
  -- (A2 made _sync_planned_holds job-draw-aware). It self-guards on a missing /
  -- deleted quote (returns 0 without touching holds), so calling it
  -- unconditionally matches the prior per-job engine exactly.
  PERFORM _sync_planned_holds(p_quote_id, v_actor);
END;
$function$;

-- == Router: _sync_job_holds now delegates quote-linked jobs to the allocator ==
CREATE OR REPLACE FUNCTION public._sync_job_holds(p_job_id uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job jobs%ROWTYPE;
  v_actor uuid;
  v_item RECORD;
  v_active boolean;
  v_free numeric;
  v_shortfalls jsonb := '[]'::jsonb;
BEGIN
  v_actor := COALESCE(p_actor, auth.uid());

  -- Lock the job first (lock order: job -> quote -> inventory).
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('shortfalls', v_shortfalls); END IF;

  v_active := (v_job.deleted_at IS NULL AND v_job.status IN ('scheduled', 'in_progress'));

  IF v_job.quote_id IS NOT NULL THEN
    -- Quote-linked: coordinate ALL sibling jobs on the quote together. This
    -- reserves/releases THIS job, reallocates siblings on cancel/delete (#2),
    -- allocates the order coverage once across siblings (#3), and resyncs the
    -- parent quote's crop_program holds.
    PERFORM _sync_quote_job_reservations(v_job.quote_id, v_actor);
  ELSE
    -- Quote-less job: independent, no booking to draw from. Rebuild its holds
    -- (full demand per product, no draws). Release when terminal/deleted.
    DELETE FROM inventory_holds WHERE source_id = p_job_id AND hold_type = 'job';
    DELETE FROM job_product_draws WHERE job_id = p_job_id;
    IF v_active THEN
      FOR v_item IN
        SELECT jc.product_id,
               SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
        FROM job_chemicals jc
        JOIN products p ON p.id = jc.product_id
        WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL
        GROUP BY jc.product_id
        HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) > 0
      LOOP
        PERFORM 1 FROM inventory
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
        FOR UPDATE;
        -- status-enum-check: exempt (writes the 'job' hold_type added by A1 20260702170000)
        INSERT INTO inventory_holds (
          product_id, customer_id, quantity, hold_type, source_id,
          notes, created_by, expires_at, is_active
        ) VALUES (
          v_item.product_id, v_job.customer_id, v_item.job_demand, 'job', p_job_id,
          'Job reservation for ' || COALESCE(v_job.job_number, p_job_id::text),
          COALESCE(v_actor, v_job.created_by), NULL, true
        );
      END LOOP;
    END IF;
  END IF;

  -- WARN (never block, §6.1): shortfalls for THIS job's products, only while the
  -- job is active. free = available - prebooked - active non-expired holds, read
  -- AFTER the (re)sync above so it reflects the final hold state. A released job
  -- returns empty shortfalls (matches the old RELEASE branch).
  IF v_active THEN
    FOR v_item IN
      SELECT jc.product_id,
             SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
      WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL
      GROUP BY jc.product_id
      HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) > 0
    LOOP
      SELECT inv.quantity_available - inv.quantity_prebooked
             - COALESCE((
                 SELECT SUM(h.quantity) FROM inventory_holds h
                 WHERE h.product_id = v_item.product_id AND h.is_active = true
                   AND (h.expires_at IS NULL OR h.expires_at >= CURRENT_DATE)
               ), 0)
        INTO v_free
      FROM inventory inv
      WHERE inv.product_id = v_item.product_id AND inv.location = 'Main Warehouse';

      IF v_free IS NULL THEN
        -- No Main Warehouse inventory row => the whole demand is short (Codex P2).
        v_shortfalls := v_shortfalls || jsonb_build_object(
          'product_id', v_item.product_id,
          'product_name', (SELECT product_name FROM products WHERE id = v_item.product_id),
          'short', v_item.job_demand
        );
      ELSIF v_free < 0 THEN
        v_shortfalls := v_shortfalls || jsonb_build_object(
          'product_id', v_item.product_id,
          'product_name', (SELECT product_name FROM products WHERE id = v_item.product_id),
          'short', -v_free
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('shortfalls', v_shortfalls);
END;
$function$;

-- == save_quote: lock-early (#5) + re-sync jobs after an edit (#4) ============
-- Reproduced VERBATIM from the live catalog definition (single overload). The
-- ONLY changes vs live are the two lines marked LAYER2-COORD.
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
  v_drawn_guard record;
  v_allowed_transitions jsonb := '{
    "draft": ["sent"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"]
  }'::jsonb;
  v_existing jsonb;
  v_result jsonb;
BEGIN
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

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_status := COALESCE(p_quote_payload->>'status', 'draft');
  v_tier := COALESCE((p_quote_payload->>'tier')::int, 1);

  IF p_quote_id IS NOT NULL THEN
    -- LAYER2-COORD (#5): lock the quote row up front (FOR UPDATE) so the unplan
    -- guard's job_product_draws check below can't be raced by a concurrent job
    -- schedule (_sync_quote_job_reservations locks the same row FOR UPDATE, so
    -- the two serialize). Was: SELECT status ... WHERE id = p_quote_id;
    SELECT status INTO v_old_status FROM quotes WHERE id = p_quote_id FOR UPDATE;
    IF v_old_status IS NULL THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;

    IF v_status IS DISTINCT FROM v_old_status THEN
      IF NOT (
        v_allowed_transitions->v_old_status IS NOT NULL
        AND v_allowed_transitions->v_old_status ? v_status
      ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', v_old_status, v_status;
      END IF;
    END IF;

    -- LAYER2<<< block unplanning a booking a scheduled job is still drawing from
    -- (Codex final push-gate P1 #1): if is_planned would become false while a live
    -- job_product_draws row exists for this quote, the UPDATE below + trailing
    -- _sync_planned_holds release the quote's crop_program holds, and the next job
    -- re-sync drops the draw (quote no longer planned-open) — reopening the full
    -- booking balance while the job still consumes the stock (double-count). Clear the
    -- job reservation via the job lifecycle (cancel/reschedule) before unplanning.
    IF COALESCE((p_quote_payload->>'is_planned')::boolean,
                (SELECT is_planned FROM quotes WHERE id = p_quote_id)) = false
       AND EXISTS (
         SELECT 1 FROM job_product_draws
         WHERE quote_id = p_quote_id AND quantity_drawn > 0
       ) THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB_RESERVATION: cannot unplan this booking — a scheduled job is still reserving product from it; cancel or reschedule the job first';
    END IF;
    -- >>>LAYER2

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
      is_planned = COALESCE((p_quote_payload->>'is_planned')::boolean, is_planned),
      sent_at = CASE
        WHEN v_status = 'sent' AND sent_at IS NULL THEN now()
        WHEN v_status = 'sent' THEN sent_at
        ELSE sent_at
      END,
      updated_at = now()
    WHERE id = p_quote_id;

    v_quote_id := p_quote_id;

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  ELSE
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
      COALESCE((p_quote_payload->>'is_planned')::boolean, false),
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes,
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

  -- LAYER2<<< drawn-product guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1):
  -- a line can't be reduced below what an order OR a scheduled job already drew from it.
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = v_quote_id
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
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot remove % — % already drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot reduce % below its already-drawn % (new total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;

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

  -- LAYER2-COORD (#4): re-sync this quote's ACTIVE jobs to the edited booking,
  -- then resync crop_program holds. _sync_quote_job_reservations rebuilds every
  -- active job's draws+holds (so a grown line re-draws its job, a shrunk line
  -- reallocates siblings) and ends by calling _sync_planned_holds itself, so it
  -- is a strict superset of the prior trailing `_sync_planned_holds(v_quote_id)`
  -- (identical for a quote with no jobs). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(v_quote_id, v_actor);

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
END;
$function$;

-- == Grants: allocator is internal (SECDEF-invoked); anon revoked everywhere ===
-- CREATE OR REPLACE preserves existing privileges on _sync_job_holds / save_quote;
-- the block below only sets the NEW allocator's grants (matching _sync_job_holds).
REVOKE ALL ON FUNCTION public._sync_quote_job_reservations(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_quote_job_reservations(uuid, uuid) TO service_role;
