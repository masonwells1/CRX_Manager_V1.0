-- Layer 2 · Part A · Cycle A2 — make _sync_planned_holds job-draw-aware
-- ============================================================================
-- THE ONLY CHANGE vs the live baseline: the per-product `drawn_total` that
-- drives the FIFO hold rebuild now includes job draws (SUM over
-- job_product_draws for this quote), not just order draws (quote_product_draws).
--
-- Why: when a scheduled job draws part of a planned quote's booking (A4), the
-- quote's crop_program hold must SHRINK by that amount — otherwise the next
-- quote edit rebuilds the full quote hold on top of the job's own 'job' hold and
-- the same stock is held twice (the "100 booked + 60 job-reserved => 160 held"
-- double-count the v2 handoff flagged, §4A.3).
--
-- Behaviorally INERT until job_product_draws has rows (A4 creates them): with an
-- empty job_product_draws, `jd.job_drawn` is NULL -> COALESCE 0 -> identical to
-- the live baseline. The function body below is typed out explicitly (not cloned
-- from the catalog) with the single join/expression change marked A2<<< >>>A2.
--
-- Function contract unchanged: internal SECDEF helper, (p_quote_id, p_actor),
-- no idempotency key (rebuild-from-scratch is naturally idempotent), grants
-- preserved by CREATE OR REPLACE.
-- ============================================================================

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
           -- A2<<< order draws + job draws both consume the booking (§4A.3, §6.5)
           COALESCE(d.quantity_drawn, 0) + COALESCE(jd.job_drawn, 0) AS drawn_total
           -- >>>A2
    FROM quote_items qi
    JOIN quote_sections qs ON qs.id = qi.section_id
    LEFT JOIN quote_product_draws d
      ON d.quote_id = qi.quote_id AND d.product_id = qi.product_id
    -- A2<<< aggregate this quote's live job draws per product
    LEFT JOIN (
      SELECT product_id, SUM(quantity_drawn) AS job_drawn
      FROM job_product_draws
      WHERE quote_id = p_quote_id
      GROUP BY product_id
    ) jd ON jd.product_id = qi.product_id
    -- >>>A2
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
