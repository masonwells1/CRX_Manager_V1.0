-- U5 — "Close a booking the customer walked away from" lifecycle ('closed_short')
-- =============================================================================
-- Finding #1 (CONFIRMED). Sibling of the 2026-07-03 'closed_by_application'
-- migration (20260703200000). Same shape, different meaning:
--
--   * closed_by_application = WE fulfilled the booking by APPLYING the product
--     (jobs -> application invoices). Terminal, no money moves (already billed).
--   * closed_short (THIS)   = the customer ABANDONED the open booking (walked
--     away, or drew only part of it and never took the rest). We close it and
--     RELEASE the un-fulfilled remainder back to free inventory. No money moves:
--     any drawn portion was already billed via its order; the released remainder
--     was never billed.
--
-- WHY A NEW STATUS IS NEEDED (not just decline/cancel/expire):
--   A partially-drawn booking (a draw or job draw exists) is HARD-BLOCKED from
--   declined/cancelled/expired by trg_enforce_quote_terminal_not_drawn
--   (_enforce_quote_terminal_not_drawn raises BOOKING_PARTIALLY_DRAWN). So a
--   customer who took 60% and walked away from 40% left the booking stuck OPEN
--   forever. 'closed_short' is NOT in that trigger's blocked set, so it is the
--   clean terminal exit that trigger deliberately leaves open — mirroring how
--   'closed_by_application' escapes the same block.
--
-- OWNER/DESIGN DECISIONS baked in (U5):
--   * is_planned is NOT required (diverges from close_quote_as_applied, which
--     requires it). Reason: "fulfilled by application" is inherently a planned-
--     application concept, but "customer walked away, release the remainder"
--     applies to ANY open booking. The hold-release path
--     (release_holds_on_quote_status_change) releases whatever holds exist by
--     source_id and is a harmless no-op when a non-planned quote has none, so
--     requiring is_planned would only needlessly block a legitimate walk-away.
--   * ACTIVE JOBS are REFUSED (diverges from close_quote_as_applied, which only
--     warns). Reason: a scheduled/in_progress job still reserves and expects to
--     APPLY its chemicals; short-closing the booking as "walked away, release the
--     remainder" is contradictory while application work is still planned. The
--     user must cancel or complete those jobs first (token BOOKING_HAS_ACTIVE_JOBS).
--     Because we refuse when active jobs exist, at close time there are no active
--     'job' holds to reconcile — the crop_program remainder release is all that
--     happens.
--
-- Surface touched (verified against LIVE introspection 2026-07-05 — every body
-- below reproduced VERBATIM from live pg_proc.prosrc + the single marked edit):
--   1. quotes_status_check                — superset: add 'closed_short'.
--   2. _enforce_quote_status_transition   — add edge sent/revised -> closed_short.
--   3. release_holds_on_quote_status_change — add 'closed_short' to both status sets.
--   4. _sync_quote_job_reservations        — add 'closed_short' to not-open denylist.
--   5. close_quote_as_short()              — the RPC (new).
--   6. create_job_from_quote_section       — reject 'closed_short'; ALSO block
--        'accepted' with QUOTE_ALREADY_CONVERTED (finding #103, CONFIRMED).
--   7. run_data_integrity_sweep            — stale-hold sweep also covers 'closed_short'.
-- Deliberately NOT touched (same reasoning as the 'closed_by_application'
-- migration — each auto-handles the new terminal status correctly):
--   _enforce_quote_terminal_not_drawn (blocks only declined/cancelled/expired ->
--     closed_short passes, by design), enforce_quote_accepted_fully_drawn (fires
--     only for 'accepted'), _sync_planned_holds (allowlist draft/sent/revised ->
--     auto-releases a closed_short quote's holds), auto_expire_quotes /
--     get_open_booking_rollover / draw_down_quote / convert_quote_to_order
--     (allowlist sent/revised[/accepted] -> auto-exclude closed_short),
--     revert_quote_status (allowlist declined/expired/cancelled/accepted ->
--     closed_short is not revertible via this path, in parity with
--     closed_by_application; admin-override on the transition enforcer is the
--     escape hatch), get_program_completion (excludes only declined/expired/
--     cancelled -> a short-closed program keeps its partial-applied amounts
--     visible, same as closed_by_application), get_expiring_planned_holds /
--     restore_quote_version (unchanged, parity with closed_by_application).

-- 1. CHECK constraint: superset of all 8 LIVE values + the new one.
--    LIVE (verified 2026-07-05): draft, sent, revised, accepted, declined,
--    expired, cancelled, closed_by_application.
ALTER TABLE public.quotes DROP CONSTRAINT quotes_status_check;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_status_check
  CHECK (status = ANY (ARRAY['draft', 'sent', 'revised', 'accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short']));

-- 2. Status-transition enforcer: reproduce VERBATIM from live + one new legal edge.
CREATE OR REPLACE FUNCTION public._enforce_quote_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  -- U5 (Codex round-2 P2): a DIRECT status UPDATE to 'closed_short' (RLS lets
  -- admin/sales write quotes.status without the RPC) must honor the same
  -- active-jobs refusal as close_quote_as_short — otherwise the release trigger
  -- would drop this booking's holds while live jobs still expect to apply the
  -- product. The RPC passes this check trivially (it refuses first).
  -- NOTE (invoker-rights dependency): this EXISTS runs under the CALLER's jobs
  -- RLS. Safe today because everyone who passes quotes_update (admin / owning
  -- sales_rep) has UNFILTERED jobs SELECT. If jobs_select is ever row-scoped
  -- for sales_rep, this guard silently weakens — re-check then.
  IF NEW.status = 'closed_short' AND EXISTS (
    SELECT 1 FROM jobs
    WHERE quote_id = NEW.id AND deleted_at IS NULL
      AND status IN ('scheduled', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'BOOKING_HAS_ACTIVE_JOBS: cancel or complete the booking''s scheduled/in-progress jobs before closing it as short';
  END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled'))
  OR (OLD.status = 'sent' AND NEW.status IN ('revised', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'revised' AND NEW.status IN ('sent', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'accepted' AND NEW.status = 'sent')
  -- LAYER2<<< a booking we fulfilled by APPLYING product (job applications)
  -- closes to its own terminal status, distinct from 'accepted' (= convert-to-
  -- order, a chemical sale). Reachable only from an open booking. (owner 2026-07-03)
  OR (OLD.status IN ('sent', 'revised') AND NEW.status = 'closed_by_application')
  -- >>>LAYER2
  -- U5<<< a booking the customer ABANDONED (walked away / drew only part) closes
  -- to its own terminal 'closed_short', releasing the un-fulfilled remainder.
  -- Reachable only from an open booking, terminal (no outgoing edge). (#1)
  OR (OLD.status IN ('sent', 'revised') AND NEW.status = 'closed_short')
  -- >>>U5
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
END;
$function$;

-- 3. Hold-release trigger fn: reproduce VERBATIM + add 'closed_short' to both
--    the entry set (release its quote holds) and the OLD-side symmetric set.
CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_released_count integer := 0;
BEGIN
  IF NEW.status IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short')
     AND OLD.status NOT IN ('accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short') THEN
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

-- 4. Coordinated job-reservation allocator: reproduce VERBATIM from live with a
--    SINGLE change — add 'closed_short' to the v_planned_open denylist so a
--    closed-short booking is treated as NOT open (crop_pool = 0; no new draws
--    pulled if a stray later job event re-fires the engine).
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

-- 5. The RPC. Mirrors close_quote_as_applied's structure: actor-bound
--    (auth.uid + ACTOR_MISMATCH), role-gated (admin / sales_rep), idempotent
--    (operation-scoped), lock-then-check ordering. TWO deliberate divergences
--    (see header): is_planned is NOT required; ACTIVE jobs are REFUSED.
CREATE OR REPLACE FUNCTION public.close_quote_as_short(
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
    v_existing := check_idempotency(p_idempotency_key, 'close_quote_as_short');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Already closed short? Return gracefully (repeat click without a key).
  IF v_quote.status = 'closed_short' THEN
    RETURN jsonb_build_object(
      'success', true, 'status', 'closed_short', 'already_closed', true,
      'quote_id', p_quote_id, 'released_units', 0, 'warnings', '[]'::jsonb);
  END IF;

  -- Only an OPEN booking can be short-closed.
  IF v_quote.status NOT IN ('sent', 'revised') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: quote % is % — only sent or revised bookings can be closed as short',
      v_quote.quote_number, v_quote.status;
  END IF;

  -- DIVERGENCE #1 vs close_quote_as_applied: is_planned is NOT required. A
  -- non-planned open booking a customer walked away from is a valid short-close;
  -- it simply has no crop_program holds to release (the release trigger no-ops).

  -- DIVERGENCE #2 vs close_quote_as_applied: REFUSE while any job is still
  -- scheduled/in-progress. A live job still reserves + expects to APPLY its
  -- chemicals, which contradicts "walked away, release the remainder". The user
  -- must cancel or complete those jobs first.
  SELECT COUNT(*) INTO v_active_jobs FROM jobs
  WHERE quote_id = p_quote_id AND deleted_at IS NULL
    AND status IN ('scheduled', 'in_progress');
  IF v_active_jobs > 0 THEN
    RAISE EXCEPTION 'BOOKING_HAS_ACTIVE_JOBS: quote % still has % scheduled/in-progress job(s) — cancel or complete them before closing the booking as short',
      v_quote.quote_number, v_active_jobs;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  -- Measure what this close will actually release: the quote's ACTIVE
  -- crop_program holds — exactly the rows the release trigger deactivates.
  -- (Codex round-2 P2: computing this from quote_items over-reported a
  -- "release" on a NON-planned booking, which has no holds at all — the
  -- trigger no-ops there and released_units correctly comes out 0.)
  SELECT
    COALESCE(SUM(h.quantity), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
      'product_id', h.product_id,
      'product_name', p.product_name,
      'released_qty', h.quantity) ORDER BY p.product_name)
      FILTER (WHERE h.quantity > 0), '[]'::jsonb)
  INTO v_released_units, v_released_lines
  FROM inventory_holds h
  LEFT JOIN products p ON p.id = h.product_id
  WHERE h.source_id = p_quote_id
    AND h.is_active = true
    AND h.hold_type = 'crop_program';

  IF v_released_units > 0 THEN
    v_warnings := array_append(v_warnings,
      'Released ' || v_released_units || ' un-fulfilled unit(s) back to free inventory');
  END IF;

  -- Flip to the terminal status. This UPDATE fires:
  --   _enforce_quote_status_transition   (edge sent/revised -> closed_short added above)
  --   release_holds_on_quote_status_change (deactivates the quote's crop_program
  --     holds — the released remainder)
  --   trg_enforce_quote_terminal_not_drawn only blocks declined/cancelled/expired
  --     -> closed_short passes even for a partially-drawn booking (the whole point)
  --   enforce_quote_accepted_fully_drawn fires only for 'accepted'
  UPDATE quotes SET status = 'closed_short', updated_at = now()
  WHERE id = p_quote_id;

  -- No financial_audit_log entry: closing moves NO money (any drawn portion was
  -- billed via its order; the released remainder was never billed). Log to
  -- activity_feed only — always, even when nothing was released.
  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('quote_closed_short',
    'Booking ' || v_quote.quote_number || ' closed short — customer walked away, for ' ||
      COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN v_released_units > 0
        THEN ' (released ' || v_released_units || ' un-fulfilled unit(s))' ELSE '' END,
    v_actor, 'quote', p_quote_id, v_quote.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'status', 'closed_short',
    'quote_id', p_quote_id,
    'quote_number', v_quote.quote_number,
    'released_units', v_released_units,
    'released_lines', v_released_lines,
    'warnings', to_jsonb(v_warnings));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'close_quote_as_short', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.close_quote_as_short(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_quote_as_short(uuid, uuid, text) TO authenticated, service_role;

-- 6. Job-creation guard: reproduce create_job_from_quote_section VERBATIM from
--    live with TWO changes:
--      (a) add 'closed_short' to the terminal-status rejection (parity with
--          'closed_by_application' — no new job against a closed booking); and
--      (b) block 'accepted' with a DISTINCT token QUOTE_ALREADY_CONVERTED
--          (finding #103, CONFIRMED): an accepted quote was converted to a
--          chemical SALE (order + delivery); scheduling a job from it would
--          re-reserve/double-count. Draft is intentionally NOT blocked here
--          (UI warns; a job can legitimately be pre-scheduled from a draft plan).
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

  -- U5 (Codex P2): lock the quote BEFORE the status checks so a concurrent
  -- convert/close (each takes this same row lock first) serializes with job
  -- scheduling — a plain read could pass the guards on a booking another
  -- transaction is mid-way through accepting or closing.
  SELECT q.* INTO v_quote FROM quotes q WHERE q.id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF NOT v_quote.is_planned THEN RAISE EXCEPTION 'Quote must be marked as planned to schedule a job'; END IF;

  -- U5<<< #103: an 'accepted' booking was converted to a chemical SALE (order +
  -- delivery). Scheduling a job from it would re-reserve/double-count the same
  -- product. Block with a distinct token so the UI can point the user to a
  -- standalone job instead. (finding #103, CONFIRMED 2026-07-05)
  IF v_quote.status = 'accepted' THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_CONVERTED: quote % was accepted and converted to a chemical sale (order) — create a standalone job instead of scheduling from this booking', v_quote.quote_number;
  END IF;
  -- >>>U5

  IF v_quote.status IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short') THEN
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

-- 7. Data-integrity sweep: reproduce VERBATIM from live with a SINGLE change —
--    add 'closed_short' to the stale_quote_hold terminal-status list so a
--    surviving crop_program hold on a short-closed booking is also flagged.
CREATE OR REPLACE FUNCTION public.run_data_integrity_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_negative_inventory integer := 0;
  v_negative_invoices  integer := 0;
  v_stale_holds        integer := 0;
  v_overdraws          integer := 0;
BEGIN
  -- admin-only when an authenticated user calls this; pg_cron / service_role
  -- (auth.uid() = NULL) bypass. Same pattern as check_unpriced_orders.
  IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- (a) NEW negative inventory: per-product net position across locations,
  --     skipping the pre-existing negatives in the baseline (H1).
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_inventory', 'products', neg.product_id,
         jsonb_build_object('net_quantity_available', neg.net_qty)
  FROM (
    SELECT product_id, SUM(quantity_available) AS net_qty
    FROM inventory
    GROUP BY product_id
    HAVING SUM(quantity_available) < 0
  ) neg
  WHERE NOT EXISTS (
    SELECT 1 FROM integrity_negative_baseline b WHERE b.product_id = neg.product_id
  )
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_inventory = ROW_COUNT;

  -- (b) Invoices with a negative balance. balance_cents is GENERATED ALWAYS
  --     ((total - paid - prepay_applied - write_off)) — SELECT-only here.
  --     Negative means we over-collected — anomalous EXCEPT for credit memos,
  --     which are legitimately negative (the live invoices_balance_non_negative
  --     CHECK exempts invoice_type='credit_memo' for exactly this reason).
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_invoice_balance', 'invoices', inv.id,
         jsonb_build_object(
           'invoice_number', inv.invoice_number,
           'status',         inv.status,
           'balance_cents',  inv.balance_cents)
  FROM invoices inv
  WHERE inv.balance_cents < 0
    AND inv.invoice_type <> 'credit_memo'  -- CHANGED (Codex 2026-07-05 P2): valid open credits are negative by design
    AND inv.deleted_at IS NULL
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_invoices = ROW_COUNT;

  -- (c) Active crop_program holds whose parent quote is terminal — those holds
  --     should have been released by the decline/expire/cancel/close paths;
  --     a survivor silently shrinks Net Free forever.
  --     U5<<< 'closed_short' is a terminal booking whose crop_program remainder
  --     is released on close — a survivor is stale, same as the others. (#1)
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'stale_quote_hold', 'inventory_holds', h.id,
         jsonb_build_object(
           'quote_id',     q.id,
           'quote_status', q.status,
           'product_id',   h.product_id,
           'quantity',     h.quantity)
  FROM inventory_holds h
  JOIN quotes q ON q.id = h.source_id
  WHERE h.is_active = true
    AND h.hold_type = 'crop_program'
    AND q.status IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short')
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_stale_holds = ROW_COUNT;

  -- (d) Booking overdraw: drawn more than the booking cap. Cap = the same
  --     SUM(COALESCE(quote_items.total_units_needed, 0)) per (quote, product)
  --     that draw_down_quote's fully-drawn check uses (20260610145253).
  --     Also catches drawn > 0 rows whose quote_items lines were edited away
  --     (cap collapses to 0) — that IS drift worth flagging.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'booking_overdraw', 'quote_product_draws', d.id,
         jsonb_build_object(
           'quote_id',       d.quote_id,
           'product_id',     d.product_id,
           'quantity_drawn', d.quantity_drawn,
           'booking_cap',    cap.booked)
  FROM quote_product_draws d
  JOIN quotes q ON q.id = d.quote_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(COALESCE(qi.total_units_needed, 0)), 0) AS booked
    FROM quote_items qi
    WHERE qi.quote_id = d.quote_id AND qi.product_id = d.product_id
  ) cap
  WHERE q.deleted_at IS NULL
    AND d.quantity_drawn > cap.booked
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_overdraws = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'new_negative_inventory', v_negative_inventory,
    'new_negative_invoice_balance', v_negative_invoices,
    'new_stale_quote_holds', v_stale_holds,
    'new_booking_overdraws', v_overdraws
  );
END;
$function$;

-- 8. Overload sanity: every function this migration re-emitted must have exactly
--    ONE overload (no accidental dual-signature).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT proname, count(*) AS n
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('_enforce_quote_status_transition','release_holds_on_quote_status_change',
                      '_sync_quote_job_reservations','close_quote_as_short',
                      'create_job_from_quote_section','run_data_integrity_sweep')
    GROUP BY proname
  LOOP
    IF r.n <> 1 THEN
      RAISE EXCEPTION 'Overload check failed: % has % overloads (expected 1)', r.proname, r.n;
    END IF;
  END LOOP;
END $$;
