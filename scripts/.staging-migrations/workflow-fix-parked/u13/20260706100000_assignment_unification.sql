-- U13 — Assignment unification (findings #15-21 / #111)
-- =============================================================================
-- THE PROBLEM (re-verified against the LIVE schema + current working-tree code,
-- 2026-07-06):
--   Two disconnected assignment systems exist for a job's field locations:
--     (A) JobDetail's "Applicator" dropdown -> save_job persists jobs.applicator_id
--         (a single WHOLE-JOB applicator).
--     (B) The Dispatch Board's 3-step wizard -> dispatch_job_locations() writes
--         PER-LOCATION rows into job_location_dispatches (added 2026-06-26,
--         migration 20260626120000), keyed 1:1 on job_fields.id (UNIQUE
--         job_field_id) with an applicator XOR crew assignee.
--   FieldView (the phone list) reads ONLY job_location_dispatches. The office
--   Jobs list reads ONLY jobs.applicator_id. Saving a job from JobDetail never
--   touches job_location_dispatches, so a job assigned there never appears
--   dispatched to the field crew, and a job dispatched via the wizard never
--   shows its assignee in the Jobs list unless jobs.applicator_id also happens
--   to be set.
--
--   A SECOND, WORSE bug was found while verifying this: save_job UNCONDITIONALLY
--   does `DELETE FROM job_fields WHERE job_id = v_job_id` then re-INSERTs fresh
--   rows with NEW gen_random_uuid() ids (job_fields.id is never preserved across
--   a save — verified in supabase/migrations/20260706080000_customer_supplied_
--   chemicals.sql's re-emitted save_job body, lines ~204-218). job_location_
--   dispatches.job_field_id is `REFERENCES job_fields(id) ON DELETE CASCADE`
--   (20260626120000) — so EVERY JobDetail save (even one that only edits a
--   chemical rate, never touching the applicator) CASCADE-DELETES every
--   per-location dispatch row for that job. A dispatcher's wizard split is
--   silently wiped by the next unrelated office edit. This is a bigger bug than
--   "the applicator dropdown doesn't sync" — it's "any save wipes dispatch."
--
-- THE FIX — trigger-based auto-sync, NOT a save_job re-emit, NOT a second RPC
-- called from the client:
--   save_job has already been re-emitted 3 times this session (U3 app-service-id,
--   U4 customer-supplied, and this file would be a 4th) — the mission brief
--   explicitly flagged the re-emit clobber-chain risk. A second RPC the frontend
--   must remember to call after save_job would (a) still need a frontend change
--   in >1 place (JobDetail AND any future caller of assign_job_applicator), and
--   (b) do nothing about the job_fields cascade-wipe above, since that fires from
--   ANY save_job call regardless of whether the applicator changed.
--
--   A DATABASE TRIGGER fixes both problems in one shot and can never be bypassed
--   by a future code path:
--     1. `_sync_job_location_dispatch_on_field_insert()` — AFTER INSERT ON
--        job_fields (per row). Every job_fields row that re-appears after
--        save_job's delete+recreate gets its dispatch re-established to the
--        job's CURRENT whole-job applicator (if one is set and the job is
--        dispatchable) — this undoes the cascade-wipe as a side effect of doing
--        exactly what finding #15 asked for: "when save_job persists
--        applicator_id, create/refresh job_location_dispatches for ALL the
--        job's locations for that applicator."
--     2. `_sync_job_location_dispatch_on_applicator_change()` — AFTER UPDATE OF
--        applicator_id ON jobs (per row, only when it actually changed). Covers
--        the OTHER caller that sets jobs.applicator_id directly:
--        assign_job_applicator() (the B5 license-override reassign path in
--        JobDetail, and any future direct .update()). Re-syncs ALL of the job's
--        CURRENT job_fields to the new applicator — "reassign via JobDetail
--        replaces the whole-job dispatch" (mission brief), i.e. it deliberately
--        OVERWRITES a prior wizard split back to one applicator. The Dispatch
--        Board wizard remains the tool for re-splitting a job across crews
--        after that.
--     3. `_close_job_location_dispatch_on_job_terminal()` — AFTER UPDATE OF
--        status ON jobs (per row). When a job reaches 'completed' or
--        'cancelled', every still-'dispatched' per-location row for that job is
--        flipped to the matching terminal dispatch_status ('completed' /
--        'cancelled' — both already allowed by the existing
--        job_location_dispatches_dispatch_status_check CHECK, no constraint
--        change needed). Mirrors undispatch_job_locations's "cancel, don't
--        delete" semantics (keeps the audit trail).
--   All three are SECURITY DEFINER (mirroring the one other cross-table AFTER
--   trigger on jobs, `_trg_release_job_holds_on_lifecycle`, prosecdef=true) so
--   they can write job_location_dispatches (RPC-only writes, no client policy)
--   regardless of the invoking role's own grants. Each silently no-ops (does
--   NOT raise) when the applicator is missing/inactive/wrong-role — an ordinary
--   job save or a crew-only/unassigned job must never be blocked by this
--   auto-sync side effect. License-expiry is NOT re-checked here: jobs.
--   applicator_id is already gated by the existing BEFORE trigger
--   `enforce_applicator_license` (raises LICENSE_EXPIRED unless the caller set
--   the admin-override session flag `_is_admin_override()`), which runs BEFORE
--   these AFTER triggers — by the time our triggers see NEW.applicator_id it is
--   already a validated (or deliberately overridden) assignment.
--
-- KNOWN RESIDUAL GAP (documented, not fixed here — out of scope for "ONE small
-- migration", flagged for a follow-up): a job with NO whole-job applicator set
-- (jobs.applicator_id IS NULL) that was split across a CREW or multiple
-- applicators purely via the Dispatch Board wizard still LOSES those
-- per-location assignments on the next JobDetail save, because there is no
-- job-level applicator to re-sync to and job_location_dispatches has no OTHER
-- stable key across a job_fields.id churn (it is keyed on job_fields.id, which
-- is recreated every save). Fully closing this needs a job_location_dispatches
-- schema change (key on (job_id, field_id) instead of job_fields.id) — a larger,
-- separate migration. Until then: dispatch a job via the wizard AFTER its
-- fields/chemicals are finalized, and re-dispatch after any further JobDetail
-- edit that is not just an applicator-dropdown change.
--
-- ADDITIVE ONLY: 3 new trigger functions + 3 new triggers (2 on job_fields/jobs
-- that did not have them before) + one CREATE OR REPLACE re-emit of
-- get_dashboard_action_items (adds an 8th... 7th "unassigned_jobs" category,
-- byte-identical everywhere else). No table, column, or existing trigger is
-- dropped or altered.
-- =============================================================================

-- ── 1) Auto-sync on job_fields insert (fixes the cascade-wipe + finding #15) ──
CREATE OR REPLACE FUNCTION public._sync_job_location_dispatch_on_field_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = NEW.job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- No whole-job applicator to sync to, or the job isn't in a dispatchable
  -- lifecycle state (mirrors dispatch_job_locations's own gate) — leave the
  -- location undispatched; the Dispatch Board wizard is the tool for that.
  IF v_job.applicator_id IS NULL THEN RETURN NEW; END IF;
  IF v_job.status NOT IN ('scheduled', 'in_progress') THEN RETURN NEW; END IF;

  -- Defensive mirror of dispatch_job_locations's INVALID_APPLICATOR check.
  -- License expiry is NOT re-checked: enforce_applicator_license (BEFORE
  -- INSERT/UPDATE OF applicator_id ON jobs) already validated it before this
  -- job_fields row could exist with this applicator_id.
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_job.applicator_id AND is_active = true AND role = 'applicator'
  ) THEN
    RETURN NEW;
  END IF;

  -- NEW.id is a freshly gen_random_uuid()'d job_fields row, so no existing
  -- job_location_dispatches row can already reference it — ON CONFLICT DO
  -- NOTHING is defensive belt-and-suspenders, not a live code path.
  INSERT INTO job_location_dispatches
    (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
  VALUES
    (NEW.id, NEW.job_id, v_job.applicator_id, NULL, now(), 'dispatched',
     COALESCE(v_job.updated_by, v_job.created_by))
  ON CONFLICT (job_field_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_job_location_dispatch_on_field_insert ON public.job_fields;
CREATE TRIGGER trg_sync_job_location_dispatch_on_field_insert
  AFTER INSERT ON public.job_fields
  FOR EACH ROW EXECUTE FUNCTION public._sync_job_location_dispatch_on_field_insert();

-- ── 2) Auto-sync on jobs.applicator_id change (covers assign_job_applicator /
--       any direct .update(), not just save_job) ───────────────────────────────
CREATE OR REPLACE FUNCTION public._sync_job_location_dispatch_on_applicator_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jf record;
BEGIN
  -- Clearing the whole-job applicator does NOT touch existing per-location
  -- dispatches (deliberately non-destructive — there is no new assignee to
  -- sync to, and a crew-only split should not be silently undone by clearing
  -- an unrelated job-level field).
  IF NEW.applicator_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('scheduled', 'in_progress') THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = NEW.applicator_id AND is_active = true AND role = 'applicator'
  ) THEN
    RETURN NEW;
  END IF;

  -- "Reassign via JobDetail replaces the whole-job dispatch" (mission brief):
  -- every CURRENT location on this job is overwritten to the new applicator,
  -- including one previously split to a different applicator/crew via the
  -- Dispatch Board wizard. Re-split via the wizard after this if needed.
  FOR v_jf IN SELECT id FROM job_fields WHERE job_id = NEW.id LOOP
    INSERT INTO job_location_dispatches
      (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
    VALUES
      (v_jf.id, NEW.id, NEW.applicator_id, NULL, now(), 'dispatched',
       COALESCE(NEW.updated_by, NEW.created_by))
    ON CONFLICT (job_field_id) DO UPDATE
      SET applicator_id   = EXCLUDED.applicator_id,
          crew_id         = NULL,
          job_id          = EXCLUDED.job_id,
          dispatched_at   = now(),
          dispatch_status = 'dispatched',
          dispatched_by   = EXCLUDED.dispatched_by;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_job_location_dispatch_on_applicator_change ON public.jobs;
CREATE TRIGGER trg_sync_job_location_dispatch_on_applicator_change
  AFTER UPDATE OF applicator_id ON public.jobs
  FOR EACH ROW
  WHEN (NEW.applicator_id IS DISTINCT FROM OLD.applicator_id)
  EXECUTE FUNCTION public._sync_job_location_dispatch_on_applicator_change();

-- ── 3) Auto-close dispatch rows when a job reaches a terminal status ─────────
CREATE OR REPLACE FUNCTION public._close_job_location_dispatch_on_job_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('completed', 'cancelled') THEN
    -- Cancel (never hard-delete) — mirrors undispatch_job_locations's audit-
    -- preserving semantics. NEW.status is used directly as the new
    -- dispatch_status: both 'completed' and 'cancelled' are already allowed by
    -- job_location_dispatches_dispatch_status_check, so this maps 1:1 with no
    -- constraint change.
    UPDATE job_location_dispatches
       SET dispatch_status = NEW.status,
           updated_at = now()
     WHERE job_id = NEW.id
       AND dispatch_status = 'dispatched';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_job_location_dispatch_on_job_terminal ON public.jobs;
CREATE TRIGGER trg_close_job_location_dispatch_on_job_terminal
  AFTER UPDATE OF status ON public.jobs
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed', 'cancelled'))
  EXECUTE FUNCTION public._close_job_location_dispatch_on_job_terminal();

-- ── 4) get_dashboard_action_items — add "unassigned_jobs" (finding #17/#111) ──
-- Re-emitted VERBATIM from the live body (confirmed byte-identical to its base
-- migration 20260404040300_get_dashboard_action_items_rpc.sql via
-- pg_get_functiondef — no drift since) with ONE addition: a 7th category,
-- "unassigned_jobs" — scheduled jobs with NO currently-active ('dispatched')
-- per-location dispatch row. Feeds the new Action-Queue category (frontend,
-- see ActionQueue.tsx patch) and mirrors the existing "unassigned_deliveries"
-- category's shape exactly (id / primary_text / secondary_text / scheduled_date)
-- so the SAME ActionQueueItem type + formatSubtitle pattern covers it with no
-- type change needed.
CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(
  p_limit int DEFAULT 5
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_today date := current_date;
BEGIN
  -- 1. Overdue Invoices
  SELECT jsonb_agg(row_to_json(t))
  INTO v_result
  FROM (
    SELECT
      'overdue_invoice' AS category,
      i.id,
      i.invoice_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - i.due_date) AS days_overdue,
      i.balance_cents AS amount_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'overdue'
      AND i.balance_cents > 0
    ORDER BY (v_today - i.due_date) DESC
    LIMIT p_limit
  ) t;

  v_result := jsonb_build_object('overdue_invoices', COALESCE(v_result, '[]'::jsonb));

  -- 2. Cancelled Orders with Posted Invoices
  v_result := v_result || jsonb_build_object('cancelled_posted', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        o.id,
        o.order_number AS primary_text,
        c.farm_name AS secondary_text,
        i.invoice_number
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN invoices i ON i.order_id = o.id AND i.status = 'posted'
      WHERE o.status = 'cancelled'
      ORDER BY o.created_at DESC
      LIMIT p_limit
    ) t
  ));

  -- 3. Overdue Deliveries
  v_result := v_result || jsonb_build_object('overdue_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        (v_today - d.scheduled_date) AS days_overdue
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status IN ('scheduled', 'in_progress')
        AND d.scheduled_date < v_today
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- 4. Low Stock Items
  v_result := v_result || jsonb_build_object('low_stock', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        p.id,
        p.product_name AS primary_text,
        p.category AS secondary_text,
        COALESCE(inv.quantity_available, 0) AS current_qty,
        COALESCE(inv.reorder_point, 0) AS reorder_point
      FROM products p
      JOIN inventory inv ON inv.product_id = p.id
      WHERE p.is_active = true
        AND inv.reorder_point IS NOT NULL
        AND inv.reorder_point > 0
        AND COALESCE(inv.quantity_available, 0) < inv.reorder_point
      ORDER BY (COALESCE(inv.quantity_available, 0)::float / NULLIF(inv.reorder_point, 0)) ASC
      LIMIT p_limit
    ) t
  ));

  -- 5. Expiring Quotes (within 7 days)
  v_result := v_result || jsonb_build_object('expiring_quotes', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        q.id,
        q.quote_number AS primary_text,
        c.farm_name AS secondary_text,
        (q.expires_at::date - v_today) AS days_until_expiry
      FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      WHERE q.status = 'sent'
        AND q.expires_at IS NOT NULL
        AND q.expires_at::date BETWEEN v_today AND (v_today + interval '7 days')
      ORDER BY q.expires_at ASC
      LIMIT p_limit
    ) t
  ));

  -- 6. Unassigned Deliveries
  v_result := v_result || jsonb_build_object('unassigned_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'scheduled'
        AND d.assigned_driver IS NULL
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- U13<<< 7. Unassigned Jobs (findings #15-21/#111): a SCHEDULED job with no
  -- currently-active per-location dispatch — neither the wizard's per-location
  -- assignment NOR (indirectly, since the trigger above keeps them in sync)
  -- a whole-job applicator has reached the field crew. deleted_at IS NULL
  -- mirrors the other job reads in this function's sibling tiles.
  v_result := v_result || jsonb_build_object('unassigned_jobs', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        j.id,
        j.job_number AS primary_text,
        c.farm_name AS secondary_text,
        j.job_date AS scheduled_date
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      WHERE j.status = 'scheduled'
        AND j.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM job_location_dispatches d
          WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched'
        )
      ORDER BY j.job_date ASC
      LIMIT p_limit
    ) t
  ));
  -- >>>U13

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_action_items(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_action_items(int) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- exactly one overload of each new/re-emitted function (checked individually
  -- — a GROUP BY/HAVING form here would be needlessly indirect).
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_sync_job_location_dispatch_on_field_insert';
  IF v_count <> 1 THEN RAISE EXCEPTION '_sync_job_location_dispatch_on_field_insert overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_sync_job_location_dispatch_on_applicator_change';
  IF v_count <> 1 THEN RAISE EXCEPTION '_sync_job_location_dispatch_on_applicator_change overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_close_job_location_dispatch_on_job_terminal';
  IF v_count <> 1 THEN RAISE EXCEPTION '_close_job_location_dispatch_on_job_terminal overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dashboard_action_items';
  IF v_count <> 1 THEN RAISE EXCEPTION 'get_dashboard_action_items overload count is % (expected 1)', v_count; END IF;

  -- all 3 trigger functions must be SECURITY DEFINER with a pinned search_path
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN (
       '_sync_job_location_dispatch_on_field_insert',
       '_sync_job_location_dispatch_on_applicator_change',
       '_close_job_location_dispatch_on_job_terminal'
     )
     AND prosecdef = true
     AND array_to_string(coalesce(proconfig, '{}'), ',') LIKE '%search_path=public, pg_temp%';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'expected 3 SECURITY DEFINER trigger fns with search_path pinned, found %', v_count;
  END IF;

  -- all 3 triggers exist on the expected tables
  SELECT count(*) INTO v_count FROM pg_trigger
   WHERE tgname = 'trg_sync_job_location_dispatch_on_field_insert'
     AND tgrelid = 'public.job_fields'::regclass AND NOT tgisinternal;
  IF v_count <> 1 THEN RAISE EXCEPTION 'trg_sync_job_location_dispatch_on_field_insert missing on job_fields'; END IF;

  SELECT count(*) INTO v_count FROM pg_trigger
   WHERE tgname = 'trg_sync_job_location_dispatch_on_applicator_change'
     AND tgrelid = 'public.jobs'::regclass AND NOT tgisinternal;
  IF v_count <> 1 THEN RAISE EXCEPTION 'trg_sync_job_location_dispatch_on_applicator_change missing on jobs'; END IF;

  SELECT count(*) INTO v_count FROM pg_trigger
   WHERE tgname = 'trg_close_job_location_dispatch_on_job_terminal'
     AND tgrelid = 'public.jobs'::regclass AND NOT tgisinternal;
  IF v_count <> 1 THEN RAISE EXCEPTION 'trg_close_job_location_dispatch_on_job_terminal missing on jobs'; END IF;

  -- get_dashboard_action_items still has anon revoked
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_dashboard_action_items'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'anon must NOT have EXECUTE on get_dashboard_action_items';
  END IF;
END $$;
