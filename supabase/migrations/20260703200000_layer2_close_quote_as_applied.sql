-- Layer 2 — "Close a booking that we fulfilled by APPLICATION" lifecycle
-- =====================================================================
-- OWNER DECISION (Mason 2026-07-03): the two sell channels are SEPARATE.
--   * CHEMICAL SALE  = we DELIVER product to the customer (convert/draw a
--     booking -> order -> delivery). Closes the booking to 'accepted'.
--   * JOB APPLICATION = WE apply the product for the customer (jobs ->
--     application invoice, billed off job_chemicals). Until now such a booking
--     had NO clean end-state: 'accepted' is the chemical-sale door (creates an
--     order + prebooks stock + commissions — wrong channel), and
--     declined/cancelled/expired are both wrong ("we didn't decline it, we
--     fulfilled it") AND hard-blocked by _enforce_quote_terminal_not_drawn
--     whenever a job reservation exists. So the booking sat open forever.
--
-- This migration gives that booking its own distinct terminal status,
-- 'closed_by_application', reachable ONLY from an open booking (sent/revised),
-- via one small actor-bound + idempotent RPC close_quote_as_applied().
--
-- NO MONEY MOVES. The customer was already billed through each job's
-- application invoice (transfer_job_to_invoice, priced off job_chemicals) —
-- the booking itself never produces AR for the application channel — so closing
-- cannot double-bill. It is purely a lifecycle + inventory-cleanup action,
-- exactly like Decline/Cancel (which also don't touch financial_audit_log).
--
-- OWNER CHOICES baked in (Mason 2026-07-03):
--   * MANUAL close via a button (never auto).
--   * CLOSE-ANYWAY: any un-applied / un-delivered leftover is released back to
--     free inventory (the crop_program holds drop via the release trigger), and
--     the RPC reports how much was released as a warning (warn, never block).
--
-- Surface touched (verified against live introspection 2026-07-03):
--   1. quotes_status_check    — superset: add 'closed_by_application'.
--   2. _enforce_quote_status_transition — add edge sent/revised -> new status.
--   3. release_holds_on_quote_status_change — release holds on entering it.
--   4. _sync_quote_job_reservations — treat the new status as NOT-open so a
--      later job event can't re-reserve stock against a closed booking.
--   5. close_quote_as_applied() — the RPC.
-- Deliberately NOT touched: _enforce_quote_terminal_not_drawn (only blocks
--   declined/cancelled/expired — the new status isn't in that set, so it
--   passes), enforce_quote_accepted_fully_drawn (fires only for 'accepted'),
--   _sync_planned_holds (allowlist status IN (draft,sent,revised) -> auto-
--   releases the new status's holds), get_open_booking_rollover /
--   get_booking_settlement / draw_down_quote / convert_quote_to_order /
--   revert_quote_status (allowlists -> auto-exclude the new status),
--   get_program_completion (tracks how much of a program was APPLIED — a
--   closed-by-application booking is a COMPLETED program that belongs there).

-- 1. CHECK constraint: superset of all 7 existing values + the new one.
ALTER TABLE public.quotes DROP CONSTRAINT quotes_status_check;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_status_check
  CHECK (status = ANY (ARRAY['draft', 'sent', 'revised', 'accepted', 'declined', 'expired', 'cancelled', 'closed_by_application']));

-- 2. Status-transition enforcer: reproduce verbatim + one new legal edge.
CREATE OR REPLACE FUNCTION public._enforce_quote_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled'))
  OR (OLD.status = 'sent' AND NEW.status IN ('revised', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'revised' AND NEW.status IN ('sent', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'accepted' AND NEW.status = 'sent')
  -- LAYER2<<< a booking we fulfilled by APPLYING product (job applications)
  -- closes to its own terminal status, distinct from 'accepted' (= convert-to-
  -- order, a chemical sale). Reachable only from an open booking. (owner 2026-07-03)
  OR (OLD.status IN ('sent', 'revised') AND NEW.status = 'closed_by_application')
  -- >>>LAYER2
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
END;
$function$;

-- 3. Hold-release trigger fn: reproduce verbatim + add the new status to both
--    sets (release its quote holds on entry; the OLD-side add is symmetric —
--    the new status is terminal so it never leaves, but keeps the guard tidy).
CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_released_count integer := 0;
BEGIN
  IF NEW.status IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_by_application')
     AND OLD.status NOT IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_by_application') THEN
    UPDATE public.inventory_holds
    SET is_active = false, updated_at = now()
    WHERE source_id = NEW.id AND is_active = true;
    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    IF v_released_count > 0 THEN
      INSERT INTO public.activity_feed (event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id)
      VALUES ('inventory_holds_released',
        'Released ' || v_released_count || ' inventory hold(s) for quote ' || NEW.quote_number || ' (' || NEW.status || ')',
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'),
        'quote', NEW.id, NEW.customer_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 4. Coordinated job-reservation allocator: reproduce VERBATIM from live
--    (A3.12 channel-separation body) with a SINGLE change — add
--    'closed_by_application' to the v_planned_open denylist so a closed booking
--    is treated as NOT open: crop_pool = 0, no new draws pulled against a closed
--    booking's balance if a job event happens to re-fire the engine afterward.
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
  v_planned_open := FOUND
    AND v_quote.is_planned
    AND v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'closed_by_application');
  -- >>>LAYER2

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

-- 5. The RPC. Actor-bound (auth.uid + ACTOR_MISMATCH), role-gated (admin /
--    sales_rep — same as draw_down_quote), idempotent (operation-scoped),
--    lock-then-check ordering matches draw_down_quote. Flips the booking to the
--    terminal 'closed_by_application' status (the transition + release triggers
--    do the hold work) and returns how much un-applied leftover was released.
CREATE OR REPLACE FUNCTION public.close_quote_as_applied(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote record;
  v_customer record;
  v_existing jsonb;
  v_released_units numeric := 0;
  v_released_lines jsonb := '[]'::jsonb;
  v_active_jobs integer := 0;
  v_warnings text[] := '{}'::text[];
  v_result jsonb;
BEGIN
  -- Auth + strict actor (a forged p_performed_by is rejected).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Lock the quote: serialize with concurrent draws / job syncs on this booking.
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency AFTER the lock (same ordering as draw_down_quote): the row lock
  -- serializes same-key duplicates so the non-atomic check/save can't both pass.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'close_quote_as_applied');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Already closed this way? Return gracefully (repeat click without a key).
  IF v_quote.status = 'closed_by_application' THEN
    RETURN jsonb_build_object(
      'success', true, 'status', 'closed_by_application', 'already_closed', true,
      'quote_id', p_quote_id, 'released_units', 0, 'warnings', '[]'::jsonb);
  END IF;

  -- Only an OPEN booking can be closed as fulfilled-by-application.
  IF v_quote.status NOT IN ('sent', 'revised') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: quote % is % — only sent or revised bookings can be closed as fulfilled by application',
      v_quote.quote_number, v_quote.status;
  END IF;

  -- Only a PLANNED booking (the application channel) can be closed this way. A
  -- plain non-planned sales quote belongs to the chemical-sale / convert channel
  -- and must not be mislabeled "fulfilled by application". (Codex 2026-07-03 P2)
  IF NOT v_quote.is_planned THEN
    RAISE EXCEPTION 'NOT_A_PLANNED_BOOKING: quote % is not a planned booking — only a planned application program can be closed as fulfilled by application',
      v_quote.quote_number;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  -- Measure the un-applied / un-delivered leftover this close will release:
  -- booked − order draws − job draws, per product (>= 0). This is exactly the
  -- crop_program hold quantity the release trigger will drop.
  WITH booked AS (
    SELECT qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked_qty
    FROM quote_items qi WHERE qi.quote_id = p_quote_id GROUP BY qi.product_id
  ),
  ord AS (
    SELECT product_id, quantity_drawn
    FROM quote_product_draws WHERE quote_id = p_quote_id
  ),
  job AS (
    SELECT product_id, SUM(quantity_drawn) AS qty
    FROM job_product_draws WHERE quote_id = p_quote_id GROUP BY product_id
  ),
  leftover AS (
    SELECT b.product_id,
           GREATEST(b.booked_qty - COALESCE(o.quantity_drawn, 0) - COALESCE(j.qty, 0), 0) AS remaining_qty
    FROM booked b
    LEFT JOIN ord o ON o.product_id = b.product_id
    LEFT JOIN job j ON j.product_id = b.product_id
  )
  SELECT
    COALESCE(SUM(l.remaining_qty), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'product_id', l.product_id,
      'product_name', p.product_name,
      'released_qty', l.remaining_qty) ORDER BY p.product_name)
      FILTER (WHERE l.remaining_qty > 0), '[]'::jsonb)
  INTO v_released_units, v_released_lines
  FROM leftover l LEFT JOIN products p ON p.id = l.product_id;

  -- Informational (never blocks): jobs still scheduled/in-progress on this booking.
  SELECT COUNT(*) INTO v_active_jobs FROM jobs
  WHERE quote_id = p_quote_id AND deleted_at IS NULL
    AND status IN ('scheduled', 'in_progress');

  IF v_released_units > 0 THEN
    v_warnings := array_append(v_warnings,
      'Released ' || v_released_units || ' un-applied unit(s) back to free inventory');
  END IF;
  IF v_active_jobs > 0 THEN
    v_warnings := array_append(v_warnings,
      v_active_jobs || ' job(s) are still scheduled against this booking');
  END IF;

  -- Flip to the terminal status. This UPDATE fires:
  --   _enforce_quote_status_transition   (edge sent/revised -> closed added above)
  --   release_holds_on_quote_status_change (deactivates the quote's crop_program
  --     holds — the leftover; job holds have source_id=job_id, untouched)
  --   trg_enforce_quote_terminal_not_drawn only blocks declined/cancelled/expired
  --   enforce_quote_accepted_fully_drawn fires only for 'accepted'
  UPDATE quotes SET status = 'closed_by_application', updated_at = now()
  WHERE id = p_quote_id;

  -- No financial_audit_log entry: closing moves NO money (billing already
  -- happened via each job's application invoice). Log to activity_feed only —
  -- always, even when nothing was released, so the close itself is visible.
  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('quote_closed_by_application',
    'Booking ' || v_quote.quote_number || ' closed — fulfilled by application for ' ||
      COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN v_released_units > 0
        THEN ' (released ' || v_released_units || ' un-applied unit(s))' ELSE '' END,
    v_actor, 'quote', p_quote_id, v_quote.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'status', 'closed_by_application',
    'quote_id', p_quote_id,
    'quote_number', v_quote.quote_number,
    'released_units', v_released_units,
    'released_lines', v_released_lines,
    'active_jobs_remaining', v_active_jobs,
    'warnings', to_jsonb(v_warnings));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'close_quote_as_applied', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.close_quote_as_applied(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_quote_as_applied(uuid, uuid, text) TO authenticated, service_role;

-- 6. Job-creation guard: reproduce create_job_from_quote_section VERBATIM from
--    live with a SINGLE change — add 'closed_by_application' to its terminal
--    status rejection. Without this, a booking already closed as fulfilled-by-
--    application could still have a NEW job scheduled against an un-scheduled
--    section, re-reserving shed stock against a done booking. (Codex 2026-07-03 P1)
CREATE OR REPLACE FUNCTION public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_existing jsonb; v_quote RECORD; v_section RECORD; v_item RECORD;
  v_job_id uuid; v_job_number text; v_job_date date; v_season integer;
  v_total_acres numeric := 0; v_total_cost_cents bigint := 0;
  v_total_price_cents bigint := 0; v_sort integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_job_from_quote_section';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT q.* INTO v_quote FROM quotes q WHERE q.id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF NOT v_quote.is_planned THEN RAISE EXCEPTION 'Quote must be marked as planned to schedule a job'; END IF;

  IF v_quote.status IN ('declined', 'expired', 'cancelled', 'closed_by_application') THEN
    RAISE EXCEPTION 'Cannot schedule job from quote with status: %', v_quote.status;
  END IF;

  SELECT qs.* INTO v_section FROM quote_sections qs WHERE qs.id = p_section_id AND qs.quote_id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Section not found or does not belong to quote'; END IF;

  IF EXISTS (SELECT 1 FROM jobs WHERE quote_section_id = p_section_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A job already exists for this quote section. Delete or cancel the existing job first.';
  END IF;

  v_job_date := COALESCE(v_section.needed_by_date, CURRENT_DATE);
  v_season := CASE WHEN EXTRACT(MONTH FROM v_job_date) >= 10
    THEN EXTRACT(YEAR FROM v_job_date)::integer + 1 ELSE EXTRACT(YEAR FROM v_job_date)::integer END;
  v_job_number := next_job_number();

  INSERT INTO jobs (
    job_number, customer_id, status, job_date, notes, season, quote_id, quote_section_id,
    total_acres, total_cost_cents, total_price_cents, created_by
  ) VALUES (
    v_job_number, v_quote.customer_id, 'scheduled', v_job_date,
    COALESCE(v_section.section_name, 'Untitled') || COALESCE(': ' || v_section.section_header_notes, ''),
    v_season, p_quote_id, p_section_id, 0, 0, 0, v_actor
  ) RETURNING id INTO v_job_id;

  IF v_section.field_id IS NOT NULL THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job_id, v_section.field_id, v_total_acres, 1);
  END IF;

  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qi.price_unit, qi.actual_rate, qi.rate_unit,
           qi.price_per_unit, qi.current_cost, qi.acres, qi.sort_order, p.unit_size
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.section_id = p_section_id ORDER BY qi.sort_order
  LOOP
    v_sort := v_sort + 1;
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents, sort_order
    ) VALUES (v_job_id, v_item.product_id, COALESCE(v_item.total_units_needed, 0),
      COALESCE(v_item.price_unit, v_item.unit_size), v_item.actual_rate, v_item.rate_unit,
      ROUND(COALESCE(v_item.current_cost, 0) * 100)::bigint,
      ROUND(COALESCE(v_item.price_per_unit, 0) * 100)::bigint, v_sort);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_item.current_cost, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
    v_total_price_cents := v_total_price_cents + ROUND(COALESCE(v_item.price_per_unit, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
  END LOOP;

  IF v_total_acres = 0 THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
  END IF;
  UPDATE jobs SET total_acres = v_total_acres, total_cost_cents = v_total_cost_cents, total_price_cents = v_total_price_cents WHERE id = v_job_id;

  -- F1<<< 42P01 fix (plpgsql_check, 2026-06-10): the logging INSERT targeted
  -- the old log relation (named in the migration header; deliberately NOT
  -- spelled here — this comment lands in prosrc, and the self-verification
  -- block asserts the old relation name appears NOWHERE in the deployed
  -- body), which does not exist — every call aborted here at runtime.
  -- Re-pointed to activity_feed using its live column shape, the exact
  -- pattern draw_down_quote logs with; the old jsonb details payload
  -- (job_number / quote_id / quote_number / section_name) is folded into the
  -- description text. Event token 'job_created_from_quote' kept.
  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('job_created_from_quote',
    'Job ' || v_job_number || ' scheduled from quote ' || v_quote.quote_number ||
    COALESCE(' — section ' || v_section.section_name, ''),
    v_actor, 'job', v_job_id, v_quote.customer_id);
  -- >>>F1

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_job_from_quote_section', jsonb_build_object('job_id', v_job_id));
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id);
END;
$function$;
