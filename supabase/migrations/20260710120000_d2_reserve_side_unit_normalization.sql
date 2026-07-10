-- D2 (U11 follow-up): reserve-side unit normalization.
-- Gap: the four reserve/planning paths pass raw per-acre-suffixed units (for example, 'pt/ac')
-- to field_app_priced_quantity, which returns NULL and falls back to the raw quantity.
-- Mirror: complete_job already normalizes the rate unit before converting deduction quantity.
-- All four bases below are the 20260706080000 emits, byte-identical to live; signatures and
-- ACLs are unchanged (CREATE OR REPLACE preserves grants). This is an additive behavior
-- correction: holds/planning use the converted quantity exactly as the deduction side already
-- does. Live blast radius verified: 0 rows today.

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
               -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
               SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
        FROM job_chemicals jc
        JOIN products p ON p.id = jc.product_id
        -- U4<<< customer-supplied lines demand nothing from our shed. (#102)
        WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL AND jc.customer_supplied = false
        -- >>>U4
        GROUP BY jc.product_id
        HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) > 0
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
             SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
      -- U4<<< customer-supplied lines demand nothing — never a shortfall. (#102)
      WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL AND jc.customer_supplied = false
      -- >>>U4
      GROUP BY jc.product_id
      HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) > 0
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
  v_draw numeric;
  v_hold numeric;
BEGIN
  v_actor := COALESCE(p_actor, auth.uid());

  -- Lock the parent quote (same rule the per-job engine used: 'accepted' still
  -- counts as open; only declined/expired/cancelled do not). This lock also
  -- serializes concurrent job syncs on the same quote AND the save_quote unplan
  -- guard (both take the quote FOR UPDATE first).
  SELECT * INTO v_quote FROM quotes
  WHERE id = p_quote_id AND deleted_at IS NULL
  FOR UPDATE;
  -- LAYER2<<< 'closed_by_application' (a booking fulfilled by us applying it) is
  -- a terminal, NOT-open booking too — exclude it so a stray later job event
  -- can't re-draw against the closed booking's balance. (owner 2026-07-03)
  -- U5<<< 'closed_short' (a booking the customer abandoned) is likewise terminal
  -- and NOT-open — exclude it so a stray later job event can't re-draw. (#1)
  v_planned_open := FOUND
    AND v_quote.is_planned
    AND v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short');
  -- >>>U5 >>>LAYER2

  -- Clean slate for this quote's job reservations:
  --   * drop every 'job' hold for jobs on this quote (the loop re-adds one per
  --     ACTIVE job);
  --   * drop draws for every NON-consumed job (ACTIVE -> rebuilt below;
  --     cancelled / soft-deleted-while-active -> stay gone). KEEP completed /
  --     invoiced job draws: that chemical was physically applied (complete_job
  --     already deducted the stock), so its draw permanently consumes the booking.
  DELETE FROM inventory_holds
   WHERE hold_type = 'job'
     AND source_id IN (SELECT id FROM jobs WHERE quote_id = p_quote_id);

  DELETE FROM job_product_draws jpd
   USING jobs j
   WHERE jpd.job_id = j.id
     AND jpd.quote_id = p_quote_id
     AND j.status NOT IN ('completed', 'invoiced');

  -- Coordinated allocation across ACTIVE sibling jobs, product by product.
  -- crop_pool = booking - order_drawn - consumed_job_drawn = the booking balance
  -- still open to draw. Active jobs draw from it FIFO (by job creation) so their
  -- DRAWS never exceed the booking (no double-BILL, and a cancelled sibling frees
  -- crop the next re-sync re-draws — push-gate #2). But the job HOLD is the FULL
  -- application demand: chemical-sale (order) stock is a SEPARATE channel — delivered
  -- to the customer, not available for us to apply — so it must NOT offset the shed
  -- reservation (owner 2026-07-03, push-gate #A). The drawn portion shrinks the crop
  -- hold (net-zero within the booking); demand beyond the drawable booking is real
  -- extra shed need. For a lone job this yields hold = demand (draw + undrawn excess).
  v_prev_product := NULL;
  FOR v_row IN
    SELECT j.id AS job_id, j.customer_id, j.job_number, j.created_by, j.created_at,
           jc.product_id,
           -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
           SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) AS demand
    FROM jobs j
    JOIN job_chemicals jc ON jc.job_id = j.id
    JOIN products p ON p.id = jc.product_id
    WHERE j.quote_id = p_quote_id
      AND j.deleted_at IS NULL
      AND j.status IN ('scheduled', 'in_progress')
      AND jc.product_id IS NOT NULL
      -- U4<<< a grower-supplied line demands nothing from our shed — it must not
      -- draw the booking nor add a 'job' hold. (#102)
      AND jc.customer_supplied = false
      -- >>>U4
    GROUP BY j.id, j.customer_id, j.job_number, j.created_by, j.created_at, jc.product_id
    HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)) > 0
    ORDER BY jc.product_id, j.created_at NULLS LAST, j.id
  LOOP
    IF v_row.product_id IS DISTINCT FROM v_prev_product THEN
      -- New product: lock its inventory row (serialize concurrent same-product
      -- reserves; lock order quote -> inventory matches draw_down_quote), then
      -- (re)compute the drawable crop pool.
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
      ELSE
        v_crop_pool := 0;
      END IF;

      v_prev_product := v_row.product_id;
    END IF;

    -- Draw from the open booking balance (for billing / no double-bill), FIFO.
    v_draw := LEAST(v_row.demand, v_crop_pool);
    v_crop_pool := v_crop_pool - v_draw;
    -- Hold the FULL application demand in the shed (channels don't offset, #A).
    v_hold := v_row.demand;

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
  -- (A2 made _sync_planned_holds job-draw-aware). Self-guards on a missing /
  -- deleted quote, so calling it unconditionally is safe.
  PERFORM _sync_planned_holds(p_quote_id, v_actor);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_job_inventory_shortfalls(p_days_ahead integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin_or_sales_rep();

  RETURN (
    WITH win_jobs AS (
      SELECT j.id, j.job_number, j.quote_id
      FROM jobs j
      WHERE j.status IN ('scheduled', 'in_progress')
        AND j.deleted_at IS NULL
        AND j.job_date >= CURRENT_DATE
        AND j.job_date <= (CURRENT_DATE + (p_days_ahead || ' days')::interval)::date
    ),
    demand AS (
      -- Codex A+B P2 #3: needed = FULL job demand when the job HAS its own 'job' hold
      -- (that hold is excluded from active_holds below, so free isn't reduced by it);
      -- the leftover quote crop_program hold covers the UN-drawn booking, NOT this job,
      -- so subtracting it too would double-discount and hide real shortfalls (e.g.
      -- 100-booked quote, 60-unit job -> 40 crop hold; with 50 free the true shortfall
      -- is 60 - (50-40) = 50).
      -- Codex round-3 P2: BUT a PRE-EXISTING scheduled/in-progress job (one that
      -- existed before Layer 2 — A4 does no backfill, §6.6) has no own 'job' hold yet,
      -- so nothing is excluded from active_holds; falling through to full demand while
      -- the crop hold is still subtracted from free would report a PHANTOM shortfall.
      -- So: cover = 0 when the job has its own hold; otherwise fall back to the parent
      -- quote's crop coverage (the Layer-1 behavior) until the job is reserved.
      SELECT jc.product_id,
             SUM(GREATEST(cq.demand_qty - cov.covered, 0)) AS needed_qty,
             COUNT(DISTINCT wj.id) FILTER (WHERE cq.demand_qty - cov.covered > 0) AS job_count,
             ARRAY_AGG(DISTINCT wj.job_number ORDER BY wj.job_number)
               FILTER (WHERE cq.demand_qty - cov.covered > 0) AS job_numbers
      FROM win_jobs wj
      JOIN job_chemicals jc ON jc.job_id = wj.id
      JOIN products p ON p.id = jc.product_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
                 -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
                 field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form),
                 jc.quantity
               ) AS demand_qty
      ) cq
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN EXISTS (
                   SELECT 1 FROM inventory_holds ih
                   WHERE ih.source_id = wj.id AND ih.hold_type = 'job'
                     AND ih.product_id = jc.product_id AND ih.is_active = true
                     AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
                 ) THEN 0
                 ELSE COALESCE((
                   SELECT SUM(ih.quantity) FROM inventory_holds ih
                   WHERE ih.source_id = wj.quote_id
                     AND ih.product_id = jc.product_id AND ih.is_active = true
                     AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
                 ), 0)
               END AS covered
      ) cov
      -- U4<<< a grower-supplied line demands nothing from our shed — exclude it
      -- from the planning-window shortfall so it never shows a phantom shortage. (#102)
      WHERE jc.quantity > 0 AND jc.customer_supplied = false
      -- >>>U4
      GROUP BY jc.product_id
    ),
    avail AS (
      SELECT i.product_id,
             COALESCE(SUM(i.quantity_available - i.quantity_prebooked), 0) AS avail_less_prebooked
      FROM inventory i
      GROUP BY i.product_id
    ),
    active_holds AS (
      SELECT ih.product_id, SUM(ih.quantity) AS holds_qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        -- LAYER2<<< don't subtract the window jobs' OWN job holds from free —
        -- their demand is already sized above, so counting their reservation
        -- here too would report a phantom shortfall (§4B.1).
        AND NOT (ih.hold_type = 'job' AND ih.source_id IN (SELECT id FROM win_jobs))
        -- >>>LAYER2
      GROUP BY ih.product_id
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.shortfall_qty DESC), '[]'::jsonb)
    FROM (
      SELECT
        d.product_id,
        p.product_name,
        p.inventory_unit,
        d.needed_qty,
        (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0)) AS available_free,
        (d.needed_qty - (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))) AS shortfall_qty,
        d.job_count,
        d.job_numbers
      FROM demand d
      JOIN products p ON p.id = d.product_id
      LEFT JOIN avail a          ON a.product_id  = d.product_id
      LEFT JOIN active_holds ah  ON ah.product_id = d.product_id
      WHERE d.needed_qty > 0
        AND d.needed_qty > (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))
    ) r
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatch_stock_status(p_job_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    WITH jobs_in AS (
      SELECT j.id
      FROM jobs j
      WHERE j.id = ANY(p_job_ids)
        AND j.deleted_at IS NULL
        AND j.status IN ('scheduled', 'in_progress')
    ),
    demand AS (
      SELECT ji.id AS job_id, jc.product_id,
             SUM(COALESCE(
               -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
               field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form),
               jc.quantity
             )) AS demand_qty
      FROM jobs_in ji
      JOIN job_chemicals jc ON jc.job_id = ji.id
      JOIN products p ON p.id = jc.product_id
      -- U4<<< a grower-supplied line demands nothing from our shed — exclude it
      -- from the dispatch stock light. (#102)
      WHERE jc.quantity > 0 AND jc.customer_supplied = false
      -- >>>U4
      GROUP BY ji.id, jc.product_id
    ),
    avail AS (
      SELECT i.product_id,
             SUM(i.quantity_available - i.quantity_prebooked) AS free_base,
             MAX(i.reorder_point) AS reorder_point
      FROM inventory i
      GROUP BY i.product_id
    ),
    total_holds AS (
      SELECT ih.product_id, SUM(ih.quantity) AS holds_qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    own_hold AS (
      SELECT ih.source_id AS job_id, ih.product_id, SUM(ih.quantity) AS own_qty
      FROM inventory_holds ih
      WHERE ih.hold_type = 'job'
        AND ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        AND ih.source_id = ANY(p_job_ids)
      GROUP BY ih.source_id, ih.product_id
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      SELECT
        d.job_id,
        d.product_id,
        d.demand_qty,
        (a.product_id IS NOT NULL) AS has_inventory,
        (COALESCE(a.free_base, 0) - (COALESCE(th.holds_qty, 0) - COALESCE(oh.own_qty, 0)))
          AS free_excluding_own_hold,
        COALESCE(a.reorder_point, 0) AS reorder_point
      FROM demand d
      LEFT JOIN avail a        ON a.product_id  = d.product_id
      LEFT JOIN total_holds th ON th.product_id = d.product_id
      LEFT JOIN own_hold oh    ON oh.job_id = d.job_id AND oh.product_id = d.product_id
    ) r
  );
END;
$function$;

DO $$
DECLARE
  v_name text;
  v_overloads integer;
  v_anon_exec integer;
  v_normalized integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    '_sync_job_holds',
    '_sync_quote_job_reservations',
    'get_job_inventory_shortfalls',
    'get_dispatch_stock_status'
  ]
  LOOP
    SELECT count(*),
           count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')),
           count(*) FILTER (WHERE p.prosrc LIKE '%normalize_rate_unit(jc.unit)%')
      INTO v_overloads, v_anon_exec, v_normalized
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_name;

    IF v_overloads <> 1 THEN
      RAISE EXCEPTION 'D2 post-check failed: % has % overloads (expected 1)', v_name, v_overloads;
    END IF;

    IF v_anon_exec <> 0 THEN
      RAISE EXCEPTION 'D2 post-check failed: anon retains EXECUTE on %', v_name;
    END IF;

    IF v_normalized <> 1 THEN
      RAISE EXCEPTION 'D2 post-check failed: % does not normalize jc.unit before conversion', v_name;
    END IF;
  END LOOP;
END $$;
