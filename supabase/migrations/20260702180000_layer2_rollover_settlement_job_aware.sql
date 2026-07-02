-- Layer 2 · Part A polish · Cycle A3.7 — rollover/settlement trio → job-aware (§6.5)
-- ============================================================================
-- draw_down_quote (A3) already subtracts job draws from a booking's drawable
-- remainder, so a job-consumed booking can't be re-drawn to an ORDER. But three
-- other functions on the drawable-booking surface still compute
--   remaining = booked − order_drawn   (they ignore job_product_draws entirely)
-- so they OVER-state what's open — a booking partially consumed by a JOB would be
-- rolled to next season / reported as settleable including the job-consumed portion
-- (the secondary §6.5 double-fulfillment path). This makes all three job-aware,
-- consistent with A3.
--
-- Each function is reproduced verbatim from its live definition (diffed against the
-- live catalog and typed out explicitly — not cloned dynamically) EXCEPT the changes
-- marked LAYER2<<< / >>>LAYER2. Valuation choice: order draws keep their locked-order
-- price; JOB draws have no order (billed via transfer_job_to_invoice), so they are
-- valued at the booked weighted-average CURRENT price. Both are FOLDED into the
-- existing `drawn_cents`/`drawn_qty` fields (Codex round-3 P2) so the identity
--   booked = drawn (order + job) + remaining
-- holds in the existing settlement card / rollover table WITHOUT a new field the UI
-- would ignore. remaining always subtracts BOTH order and job draws (§6.5).
-- ============================================================================


-- ── (1) get_open_booking_rollover — read (STABLE) ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_open_booking_rollover(p_customer_id uuid DEFAULT NULL::uuid, p_season integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_role text;
  v_active boolean;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  SELECT role, is_active INTO v_role, v_active FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') OR v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  WITH open_bookings AS (
    SELECT q.id, q.quote_number, q.customer_id, q.status, q.season
      FROM quotes q
      WHERE q.status IN ('sent', 'revised')
        AND q.deleted_at IS NULL
        AND (p_customer_id IS NULL OR q.customer_id = p_customer_id)
        AND (p_season IS NULL OR q.season = p_season)
  ),
  booked AS (
    SELECT qi.quote_id, qi.product_id,
           SUM(COALESCE(qi.total_units_needed, 0)) AS booked_qty,
           CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
                THEN SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0))
                     / SUM(COALESCE(qi.total_units_needed, 0))
                ELSE 0 END AS wavg_price
      FROM quote_items qi
      WHERE qi.quote_id IN (SELECT id FROM open_bookings)
      GROUP BY qi.quote_id, qi.product_id
  ),
  -- LAYER2<<< job draws consuming each booking line (Layer 2 §6.5)
  job_drawn AS (
    SELECT jd.quote_id, jd.product_id, SUM(jd.quantity_drawn) AS qty
      FROM job_product_draws jd
      WHERE jd.quote_id IN (SELECT id FROM open_bookings)
      GROUP BY jd.quote_id, jd.product_id
  ),
  -- >>>LAYER2
  locked AS (
    SELECT dle.quote_id, dle.product_id,
           CASE WHEN SUM(dle.eff_qty) > 0
                THEN SUM(dle.unit_price * dle.eff_qty) / SUM(dle.eff_qty)
                ELSE NULL END AS locked_price
      FROM (
        SELECT o.quote_id, oi.product_id,
               oi.total_price / NULLIF(oi.total_units_needed, 0) AS unit_price,
               CASE WHEN o.status = 'voided'    THEN 0
                    WHEN o.status = 'cancelled' THEN COALESCE(oi.quantity_delivered, 0)
                    ELSE COALESCE(oi.total_units_needed, 0) END AS eff_qty
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.booking_draw = true AND o.quote_id IN (SELECT id FROM open_bookings)
      ) dle
      GROUP BY dle.quote_id, dle.product_id
  ),
  per_product AS (
    SELECT b.quote_id,
           -- LAYER2<<< "drawn" folds ORDER draws (at their locked price) AND JOB draws
           -- (at current wavg — a job carries no locked order price), so the existing
           -- Quotes rollover table reconciles booked = drawn + remaining WITHOUT a new
           -- field the UI would ignore (Codex round-3 P2). remaining subtracts both
           -- order and job draws (§6.5): booked − order − job.
           ROUND((COALESCE(d.quantity_drawn, 0) * COALESCE(l.locked_price, b.wavg_price)
                  + COALESCE(jd.qty, 0) * b.wavg_price) * 100)::bigint AS drawn_cents,
           ROUND(GREATEST(b.booked_qty - COALESCE(d.quantity_drawn, 0) - COALESCE(jd.qty, 0), 0) * b.wavg_price * 100)::bigint AS remaining_cents
           -- >>>LAYER2
      FROM booked b
      LEFT JOIN quote_product_draws d ON d.quote_id = b.quote_id AND d.product_id = b.product_id
      LEFT JOIN job_drawn jd ON jd.quote_id = b.quote_id AND jd.product_id = b.product_id
      LEFT JOIN locked l ON l.quote_id = b.quote_id AND l.product_id = b.product_id
  ),
  booking_money AS (
    SELECT quote_id,
           COALESCE(SUM(drawn_cents + remaining_cents), 0) AS booked_cents,
           COALESCE(SUM(drawn_cents), 0) AS drawn_cents,
           COALESCE(SUM(remaining_cents), 0) AS remaining_cents
      FROM per_product
      GROUP BY quote_id
  ),
  booking_prepay AS (
    SELECT pc.quote_id,
           COALESCE(SUM(pc.balance_cents), 0) AS remaining_prepay_cents
      FROM prepay_credits pc
      WHERE pc.quote_id IN (SELECT id FROM open_bookings)
      GROUP BY pc.quote_id
  ),
  booking_applied AS (
    SELECT pc.quote_id,
           COALESCE(SUM(pa.applied_amount_cents), 0) AS applied_cents
      FROM prepay_applications pa
      JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
      WHERE pc.quote_id IN (SELECT id FROM open_bookings)
      GROUP BY pc.quote_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'quote_id', ob.id,
    'quote_number', ob.quote_number,
    'customer_id', ob.customer_id,
    'customer_name', c.farm_name,
    'status', ob.status,
    'season', ob.season,
    'booked_cents', COALESCE(bm.booked_cents, 0),
    'drawn_cents', COALESCE(bm.drawn_cents, 0),   -- LAYER2: folds order + job draws
    'remaining_cents', COALESCE(bm.remaining_cents, 0),
    'prepay_earmarked_cents', COALESCE(ba.applied_cents, 0) + COALESCE(bp.remaining_prepay_cents, 0),
    'prepay_remaining_cents', COALESCE(bp.remaining_prepay_cents, 0),
    'prepay_applied_cents', COALESCE(ba.applied_cents, 0)
  ) ORDER BY c.farm_name, ob.quote_number), '[]'::jsonb)
  INTO v_result
  FROM open_bookings ob
  LEFT JOIN customers c ON c.id = ob.customer_id
  LEFT JOIN booking_money bm ON bm.quote_id = ob.id
  LEFT JOIN booking_prepay bp ON bp.quote_id = ob.id
  LEFT JOIN booking_applied ba ON ba.quote_id = ob.id;

  RETURN jsonb_build_object('success', true, 'bookings', v_result);
END;
$function$;


-- ── (2) get_booking_settlement — read (STABLE) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.get_booking_settlement(p_quote_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_role text;
  v_active boolean;
  v_quote record;
  v_lines jsonb;
  v_booked_cents bigint;
  v_drawn_cents bigint;
  v_remaining_cents bigint;
  v_prepay_earmarked_cents bigint;
  v_prepay_remaining_cents bigint;
  v_prepay_applied_cents bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  SELECT role, is_active INTO v_role, v_active FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') OR v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  SELECT q.id, q.quote_number, q.customer_id, q.status, q.season, q.is_planned, q.deleted_at
    INTO v_quote
    FROM quotes q
    WHERE q.id = p_quote_id;

  IF NOT FOUND OR v_quote.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'found', false, 'quote_id', p_quote_id);
  END IF;

  WITH booked AS (
    SELECT qi.product_id,
           SUM(COALESCE(qi.total_units_needed, 0)) AS booked_qty,
           CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
                THEN SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0))
                     / SUM(COALESCE(qi.total_units_needed, 0))
                ELSE 0 END AS wavg_price
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
      GROUP BY qi.product_id
  ),
  drawn AS (
    SELECT d.product_id, d.quantity_drawn
      FROM quote_product_draws d
      WHERE d.quote_id = p_quote_id
  ),
  -- LAYER2<<< job draws consuming each booking line (§6.5)
  job_drawn AS (
    SELECT jd.product_id, SUM(jd.quantity_drawn) AS qty
      FROM job_product_draws jd
      WHERE jd.quote_id = p_quote_id
      GROUP BY jd.product_id
  ),
  -- >>>LAYER2
  locked AS (
    SELECT dle.product_id,
           CASE WHEN SUM(dle.eff_qty) > 0
                THEN SUM(dle.unit_price * dle.eff_qty) / SUM(dle.eff_qty)
                ELSE NULL END AS locked_price
      FROM (
        SELECT oi.product_id,
               oi.total_price / NULLIF(oi.total_units_needed, 0) AS unit_price,
               CASE WHEN o.status = 'voided'    THEN 0
                    WHEN o.status = 'cancelled' THEN COALESCE(oi.quantity_delivered, 0)
                    ELSE COALESCE(oi.total_units_needed, 0) END AS eff_qty
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.quote_id = p_quote_id AND o.booking_draw = true
      ) dle
      GROUP BY dle.product_id
  ),
  line_rows AS (
    SELECT b.product_id,
           p.product_name,
           b.booked_qty,
           -- LAYER2<<< "drawn" folds ORDER + JOB draws so booked = drawn + remaining
           -- reconciles in the existing settlement card (Codex round-3 P2); remaining
           -- subtracts both (§6.5): booked − order − job. Order draws keep their locked
           -- price; a job draw has no locked order price, valued at current wavg.
           (COALESCE(d.quantity_drawn, 0) + COALESCE(jd.qty, 0)) AS drawn_qty,
           GREATEST(b.booked_qty - COALESCE(d.quantity_drawn, 0) - COALESCE(jd.qty, 0), 0) AS remaining_qty,
           COALESCE(l.locked_price, b.wavg_price) AS locked_price,
           b.wavg_price AS current_price,
           ROUND((COALESCE(d.quantity_drawn, 0) * COALESCE(l.locked_price, b.wavg_price)
                  + COALESCE(jd.qty, 0) * b.wavg_price) * 100)::bigint AS drawn_cents,
           ROUND(GREATEST(b.booked_qty - COALESCE(d.quantity_drawn, 0) - COALESCE(jd.qty, 0), 0) * b.wavg_price * 100)::bigint AS remaining_cents
           -- >>>LAYER2
      FROM booked b
      LEFT JOIN drawn d ON d.product_id = b.product_id
      LEFT JOIN job_drawn jd ON jd.product_id = b.product_id
      LEFT JOIN locked l ON l.product_id = b.product_id
      LEFT JOIN products p ON p.id = b.product_id
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'booked_qty', booked_qty,
      'drawn_qty', drawn_qty,               -- LAYER2: folds order + job draws
      'remaining_qty', remaining_qty,
      'locked_price', locked_price,
      'current_price', current_price,
      'booked_cents', drawn_cents + remaining_cents,
      'drawn_cents', drawn_cents,
      'remaining_cents', remaining_cents
    ) ORDER BY product_name), '[]'::jsonb),
    COALESCE(SUM(drawn_cents + remaining_cents), 0),
    COALESCE(SUM(drawn_cents), 0),
    COALESCE(SUM(remaining_cents), 0)
  INTO v_lines, v_booked_cents, v_drawn_cents, v_remaining_cents
  FROM line_rows;

  SELECT COALESCE(SUM(pc.balance_cents), 0)
    INTO v_prepay_remaining_cents
    FROM prepay_credits pc
    WHERE pc.quote_id = p_quote_id;
  SELECT COALESCE(SUM(pa.applied_amount_cents), 0)
    INTO v_prepay_applied_cents
    FROM prepay_applications pa
    JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.quote_id = p_quote_id;
  v_prepay_earmarked_cents := v_prepay_applied_cents + v_prepay_remaining_cents;

  RETURN jsonb_build_object(
    'success', true,
    'found', true,
    'quote_id', v_quote.id,
    'quote_number', v_quote.quote_number,
    'customer_id', v_quote.customer_id,
    'status', v_quote.status,
    'season', v_quote.season,
    'is_planned', v_quote.is_planned,
    'lines', v_lines,
    'booked_cents', v_booked_cents,
    'drawn_cents', v_drawn_cents,   -- LAYER2: folds order + job draws
    'remaining_cents', v_remaining_cents,
    'prepay_earmarked_cents', v_prepay_earmarked_cents,
    'prepay_applied_cents', v_prepay_applied_cents,
    'prepay_remaining_cents', v_prepay_remaining_cents
  );
END;
$function$;


-- ── (3) rollover_quote_to_season — MUTATING action (FIFO) ───────────────────
CREATE OR REPLACE FUNCTION public.rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section RECORD;
  v_new_section_id uuid;
  v_item RECORD;
  v_tier_price numeric;
  v_current_cost numeric;
  v_has_draws boolean := false;
  v_total_remainder numeric;
  v_drawn numeric;
  v_cum_before numeric;
  v_item_tun numeric;
  v_new_tun numeric;
  v_new_acres numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'rollover_quote_to_season' AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'rollover_quote_to_season', to_jsonb(p_quote_id));
  END IF;

  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  -- A5 draw-awareness, GATED to OPEN bookings. LAYER2: "draws" now means BOTH order
  -- draws (quote_product_draws) AND job draws (job_product_draws) — a booking consumed
  -- by a job rolls over only its truly-undrawn remainder (§6.5). The gate includes
  -- 'draft' because a job can be scheduled from a DRAFT planned quote (A4 gates the
  -- reserve on is_planned + non-terminal, which includes draft), so a draft with a live
  -- job draw must NOT clone the job-consumed units into the next season (Codex round-3
  -- P2). Order draws only ever exist on sent/revised, so adding 'draft' only affects
  -- job-draw detection.
  IF v_old_quote.status IN ('draft', 'sent', 'revised') THEN
    SELECT
      EXISTS (SELECT 1 FROM quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
      -- LAYER2<<< job draws also count as "drawn"
      OR EXISTS (SELECT 1 FROM job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
      -- >>>LAYER2
    INTO v_has_draws;
    IF v_has_draws THEN
      -- LAYER2<<< remainder subtracts order + job draws per product
      SELECT COALESCE(SUM(GREATEST(b.booked - COALESCE(d.quantity_drawn, 0) - COALESCE(jd.qty, 0), 0)), 0)
      INTO v_total_remainder
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = p_quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = p_quote_id AND d.product_id = b.product_id
      LEFT JOIN (
        SELECT product_id, SUM(quantity_drawn) AS qty
        FROM job_product_draws WHERE quote_id = p_quote_id
        GROUP BY product_id
      ) jd ON jd.product_id = b.product_id;
      -- >>>LAYER2
      IF v_total_remainder <= 0 THEN
        RAISE EXCEPTION 'BOOKING_FULLY_DRAWN: quote % has no undrawn balance to roll over — every booked quantity is already on orders or jobs', v_old_quote.quote_number;
      END IF;
    END IF;
  END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status, is_planned,
    commission_split, valid_days, header_notes, footer_notes, season, salesman_id
  ) VALUES (
    v_new_quote_number, v_old_quote.customer_id, v_actor, v_old_quote.tier,
    'draft', v_old_quote.is_planned, v_old_quote.commission_split,
    v_old_quote.valid_days, v_old_quote.header_notes, v_old_quote.footer_notes,
    p_new_season, v_old_quote.salesman_id
  ) RETURNING id INTO v_new_quote_id;

  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_new_quote_id, v_section.section_name, v_section.sort_order,
      v_section.section_notes, v_section.section_header_notes)
    RETURNING id INTO v_new_section_id;

    FOR v_item IN
      SELECT * FROM quote_items WHERE section_id = v_section.id ORDER BY sort_order
    LOOP
      v_drawn := 0;
      v_new_tun := NULL;
      v_new_acres := NULL;
      IF v_has_draws THEN
        -- LAYER2<<< consumed quantity = order draws + job draws for this product
        SELECT
          COALESCE((SELECT quantity_drawn FROM quote_product_draws
                    WHERE quote_id = p_quote_id AND product_id = v_item.product_id), 0)
          + COALESCE((SELECT SUM(quantity_drawn) FROM job_product_draws
                      WHERE quote_id = p_quote_id AND product_id = v_item.product_id), 0)
        INTO v_drawn;
        v_drawn := COALESCE(v_drawn, 0);
        -- >>>LAYER2
        IF v_drawn > 0 THEN
          v_item_tun := COALESCE(v_item.total_units_needed, 0);
          SELECT COALESCE(SUM(COALESCE(qi2.total_units_needed, 0)), 0) INTO v_cum_before
          FROM quote_items qi2
          JOIN quote_sections qs2 ON qs2.id = qi2.section_id
          WHERE qi2.quote_id = p_quote_id
            AND qi2.product_id = v_item.product_id
            AND (qs2.sort_order, qs2.id, qi2.sort_order, qi2.id)
              < (v_section.sort_order, v_section.id, v_item.sort_order, v_item.id);
          v_new_tun := LEAST(v_item_tun, GREATEST(v_cum_before + v_item_tun - v_drawn, 0));
          IF v_new_tun <= 0 THEN
            CONTINUE;
          END IF;
          IF v_new_tun = v_item_tun THEN
            v_new_acres := v_item.acres;
          ELSIF v_item.acres IS NOT NULL AND v_item_tun > 0 THEN
            v_new_acres := ROUND(v_item.acres * v_new_tun / v_item_tun, 2);
          ELSE
            v_new_acres := v_item.acres;
          END IF;
        END IF;
      END IF;

      SELECT CASE v_old_quote.tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        WHEN 3 THEN COALESCE(p.tier3_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier1_price, 0)
      END, p.current_cost
      INTO v_tier_price, v_current_cost
      FROM products p WHERE p.id = v_item.product_id;

      IF v_has_draws AND v_drawn > 0 THEN
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit, total_units_needed
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_new_acres,
          v_item.calc_mode, v_item.price_unit, v_new_tun
        );
      ELSE
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_item.acres,
          v_item.calc_mode, v_item.price_unit
        );
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'created',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number,
    'season', p_new_season,
    'remainder_rollover', v_has_draws
  );
END;
$function$;
