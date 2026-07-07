-- U13 (re-stamped 2026-07-07): Assignment unification (findings #15-21 / #111)
-- =============================================================================
-- REBASE NOTE (2026-07-07): re-grounded against the LIVE catalog before re-stamping
-- (project rhyzpcqhnizqbxphqdkr). Findings:
--   * get_dashboard_action_items — the LIVE body (fetched via pg catalog
--     introspection, overload count = 1, saved verbatim to .claude/session-state/
--     live-defs/u13-get_dashboard_action_items.sql) is BYTE-IDENTICAL to the
--     draft's categories 1-6. Re-emitted here from the LIVE wrapper verbatim
--     (`p_limit integer`, `SET search_path TO 'public', 'pg_temp'`) + ONLY the
--     one documented delta: a 7th category "unassigned_jobs". Live ACL is
--     {postgres, authenticated, service_role} EXECUTE — anon already has NONE;
--     the REVOKE/GRANT below re-assert that byte-identically.
--   * The 3 trigger functions are genuinely NEW (verified absent live — no
--     parallel session shipped them).
--   * SECURITY IMPROVEMENT over the parked draft: the draft never revoked anon
--     EXECUTE on its 3 NEW SECURITY DEFINER trigger functions. Postgres grants
--     PUBLIC EXECUTE by default, so they would have shipped anon-executable
--     (grant-debt the rls-security-reviewer/advisor flags). REVOKEs added below
--     (trigger functions fire regardless of caller EXECUTE grants, so this does
--     NOT affect the triggers — same pattern as the 2026-07-05 recompute_job_
--     applied_acres security follow-up). The verification block now also asserts
--     anon has no EXECUTE on the 3 trigger fns.
--
-- OVERLAP vs the other pending file (supabase/migrations/20260707010000_field_
-- view_my_day.sql = U12): DISJOINT object sets. U12 re-emits get_dispatched_list
-- / start_job / complete_job and replaces the notif_insert policy; U13 re-emits
-- get_dashboard_action_items and adds 3 triggers. No object is touched by both,
-- so there is NO re-emit clobber. One BENIGN runtime interaction (documented, not
-- a conflict): U12's complete_job does `UPDATE jobs SET status='completed'`, which
-- will now also fire U13's trg_close_job_location_dispatch_on_job_terminal and
-- close that job's per-location dispatch rows — this is the intended lifecycle
-- behavior, not a collision. U12's start_job sets status='in_progress' (matches no
-- U13 trigger condition) and neither U12 fn writes jobs.applicator_id or inserts
-- job_fields, so no other U13 trigger co-fires.
--
-- THE PROBLEM (re-verified against the LIVE schema, 2026-07-06):
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
--   a save — re-emitted save_job body in 20260706080000_customer_supplied_
--   chemicals.sql). job_location_dispatches.job_field_id is
--   `REFERENCES job_fields(id) ON DELETE CASCADE` (20260626120000) — so EVERY
--   JobDetail save (even one that only edits a chemical rate, never touching the
--   applicator) CASCADE-DELETES every per-location dispatch row for that job. A
--   dispatcher's wizard split is silently wiped by the next unrelated office
--   edit. This is a bigger bug than "the applicator dropdown doesn't sync" — it's
--   "any save wipes dispatch."
--
-- THE FIX — trigger-based auto-sync (never bypassable by a future code path):
--     1. `_sync_job_location_dispatch_on_field_insert()` — AFTER INSERT ON
--        job_fields (per row). Every job_fields row that re-appears after
--        save_job's delete+recreate gets its dispatch re-established to the
--        job's CURRENT whole-job applicator (if set and the job is
--        dispatchable) — undoes the cascade-wipe while doing exactly what
--        finding #15 asked for.
--     2. `_sync_job_location_dispatch_on_applicator_change()` — AFTER UPDATE OF
--        applicator_id ON jobs (per row, only when it actually changed). Covers
--        assign_job_applicator() and any future direct .update(). Re-syncs ALL
--        of the job's CURRENT job_fields to the new applicator — "reassign via
--        JobDetail replaces the whole-job dispatch" (mission brief), deliberately
--        OVERWRITING a prior wizard split back to one applicator.
--     3. `_close_job_location_dispatch_on_job_terminal()` — AFTER UPDATE OF
--        status ON jobs (per row). On 'completed'/'cancelled', every still-
--        'dispatched' per-location row for that job is flipped to the matching
--        terminal dispatch_status (both already allowed by
--        job_location_dispatches_dispatch_status_check — verified live, no CHECK
--        change). Mirrors undispatch_job_locations's "cancel, don't delete".
--   All three are SECURITY DEFINER (mirroring the one other cross-table AFTER
--   trigger on jobs, trg_release_job_holds_on_lifecycle) so they can write
--   job_location_dispatches (RPC-only writes) regardless of the invoking role.
--   Each silently no-ops (never RAISEs) when the applicator is missing/inactive/
--   wrong-role. License-expiry is NOT re-checked: jobs.applicator_id is already
--   gated by the existing BEFORE trigger enforce_applicator_license, which runs
--   BEFORE these AFTER triggers.
--
-- FIRING ORDER (verified against live inventory — see
-- .claude/session-state/live-defs/u13-triggers-inventory.txt): on a status change
-- to completed/cancelled the AFTER-ROW set fires alphabetically —
-- trg_close_job_location_dispatch_on_job_terminal (touches job_location_dispatches)
-- BEFORE trg_release_job_holds_on_lifecycle (touches inventory holds). No data
-- dependency between them; order is immaterial. job_fields had NO prior triggers.
--
-- KNOWN RESIDUAL GAP (documented, out of scope): a job with jobs.applicator_id
-- NULL that was split across a CREW / multiple applicators purely via the wizard
-- still loses those per-location assignments on the next JobDetail save (no
-- job-level applicator to re-sync to; job_location_dispatches is keyed on
-- job_fields.id, which churns every save). Fully closing this needs a schema
-- change (key on (job_id, field_id)) — a larger, separate migration.
--
-- ADDITIVE ONLY: 1 new internal table (job_dispatch_preservation, RLS enabled,
-- clients revoked) + 4 new trigger functions + 4 new triggers + one CREATE OR
-- REPLACE re-emit of get_dashboard_action_items (adds a 7th "unassigned_jobs"
-- category, byte-identical everywhere else). No existing table, column, CHECK,
-- policy, or trigger is dropped or altered.
-- =============================================================================

-- ── 0) Dispatch-preservation stash (Codex R3 P1) ─────────────────────────────
-- save_job deletes + re-inserts every job_fields row, and job_location_dispatches
-- CASCADEs on job_field_id — so a job SPLIT via the wizard would lose its split
-- and trigger 1 would blindly re-dispatch every location to the whole-job
-- applicator. Fix: a BEFORE DELETE trigger on job_fields stashes each ACTIVE
-- dispatch keyed by the STABLE (job_id, field_id) pair; trigger 1 restores the
-- stashed assignee first and only falls back to the whole-job applicator when
-- no stash entry exists. Stash rows are consumed on restore and self-expire
-- (1 hour) so a genuinely REMOVED field's row can't resurrect much later.
-- Internal plumbing table: client roles fully revoked; only the SECURITY
-- DEFINER triggers (which bypass RLS) write it. The single admin-read policy
-- exists for debuggability (and the moot-without-GRANT rule).
CREATE TABLE IF NOT EXISTS public.job_dispatch_preservation (
  job_id        uuid        NOT NULL,
  field_id      uuid        NOT NULL,
  applicator_id uuid,
  crew_id       uuid,
  dispatched_by uuid,
  dispatched_at timestamptz,
  preserved_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, field_id),
  -- mirror job_location_dispatches_one_assignee_check so a restore can never
  -- violate the target table's XOR constraint
  CONSTRAINT job_dispatch_preservation_one_assignee_check
    CHECK ((applicator_id IS NOT NULL) <> (crew_id IS NOT NULL))
);
ALTER TABLE public.job_dispatch_preservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_dispatch_preservation FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "jdp_admin_select" ON public.job_dispatch_preservation;
CREATE POLICY "jdp_admin_select" ON public.job_dispatch_preservation
  FOR SELECT TO authenticated USING (is_admin());

CREATE OR REPLACE FUNCTION public._preserve_job_location_dispatch_on_field_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Stash this field's ACTIVE dispatch (if any) under the stable field_id key
  -- BEFORE the cascade wipes it. Cancelled/completed rows are not preserved.
  INSERT INTO job_dispatch_preservation
    (job_id, field_id, applicator_id, crew_id, dispatched_by, dispatched_at)
  SELECT d.job_id, OLD.field_id, d.applicator_id, d.crew_id, d.dispatched_by, d.dispatched_at
    FROM job_location_dispatches d
   WHERE d.job_field_id = OLD.id
     AND d.dispatch_status = 'dispatched'
  ON CONFLICT (job_id, field_id) DO UPDATE
    SET applicator_id = EXCLUDED.applicator_id,
        crew_id       = EXCLUDED.crew_id,
        dispatched_by = EXCLUDED.dispatched_by,
        dispatched_at = EXCLUDED.dispatched_at,
        preserved_at  = now();
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_job_location_dispatch_on_field_delete ON public.job_fields;
CREATE TRIGGER trg_preserve_job_location_dispatch_on_field_delete
  BEFORE DELETE ON public.job_fields
  FOR EACH ROW EXECUTE FUNCTION public._preserve_job_location_dispatch_on_field_delete();

-- caller-analysis: _preserve_job_location_dispatch_on_field_delete :: trigger-only fn (no frontend
-- .rpc() caller). Triggers fire regardless of EXECUTE grants; the REVOKE only closes grant-debt.
REVOKE EXECUTE ON FUNCTION public._preserve_job_location_dispatch_on_field_delete() FROM PUBLIC, anon;

-- ── 1) Auto-sync on job_fields insert (fixes the cascade-wipe + finding #15) ──
CREATE OR REPLACE FUNCTION public._sync_job_location_dispatch_on_field_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_stash job_dispatch_preservation%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = NEW.job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_job.status NOT IN ('scheduled', 'in_progress') THEN RETURN NEW; END IF;

  -- Codex R3 P1: restore a stashed per-location assignee FIRST (save_job's
  -- delete+recreate cycle — the BEFORE DELETE trigger above stashed it under
  -- the stable (job_id, field_id) key moments ago in this same transaction).
  -- A wizard split survives an unrelated notes/chemicals edit byte-for-byte.
  -- Stash rows older than 1 hour are ignored AND purged (a field re-added to
  -- the job much later is a new decision, not a restore).
  DELETE FROM job_dispatch_preservation
   WHERE job_id = NEW.job_id AND preserved_at < now() - interval '1 hour';

  SELECT * INTO v_stash
    FROM job_dispatch_preservation
   WHERE job_id = NEW.job_id AND field_id = NEW.field_id;

  IF FOUND THEN
    INSERT INTO job_location_dispatches
      (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
    VALUES
      (NEW.id, NEW.job_id, v_stash.applicator_id, v_stash.crew_id,
       COALESCE(v_stash.dispatched_at, now()), 'dispatched', v_stash.dispatched_by)
    ON CONFLICT (job_field_id) DO NOTHING;

    DELETE FROM job_dispatch_preservation
     WHERE job_id = NEW.job_id AND field_id = NEW.field_id;

    RETURN NEW;
  END IF;

  -- No stash entry → fall back to the whole-job applicator (the original #15
  -- fix). No whole-job applicator to sync to, or the job isn't in a
  -- dispatchable lifecycle state (mirrors dispatch_job_locations's own gate) —
  -- leave the location undispatched; the Dispatch Board wizard is the tool for that.
  IF v_job.applicator_id IS NULL THEN RETURN NEW; END IF;

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
     -- RLS review M1: auth.uid() is the real session actor for every
     -- authenticated-invoked path (assign_job_applicator / direct .update()
     -- don't stamp jobs.updated_by, so the fallbacks alone could name the
     -- job's LAST editor as the dispatcher). Fallbacks cover owner/service runs.
     COALESCE(auth.uid(), v_job.updated_by, v_job.created_by))
  ON CONFLICT (job_field_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_job_location_dispatch_on_field_insert ON public.job_fields;
CREATE TRIGGER trg_sync_job_location_dispatch_on_field_insert
  AFTER INSERT ON public.job_fields
  FOR EACH ROW EXECUTE FUNCTION public._sync_job_location_dispatch_on_field_insert();

-- caller-analysis: _sync_job_location_dispatch_on_field_insert :: trigger-only fn (no frontend
-- .rpc() caller — grep of src/ is clean). Triggers fire regardless of EXECUTE grants, so revoking
-- PUBLIC/anon does NOT affect the trigger; it only closes the default-PUBLIC-EXECUTE grant-debt.
REVOKE EXECUTE ON FUNCTION public._sync_job_location_dispatch_on_field_insert() FROM PUBLIC, anon;

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
  -- Clearing the whole-job applicator (Codex R2 P1): cancel the ACTIVE dispatch
  -- rows that belonged to the OLD whole-job applicator — otherwise the UI and
  -- jobs.applicator_id say "unassigned" while the old applicator still sees and
  -- can work the job, and the Needs-Dispatch surfaces won't flag it. Deliberate
  -- SPLIT rows are preserved: only rows held by OLD.applicator_id are touched
  -- (a crew-only or other-applicator split is not silently undone by clearing
  -- an unrelated job-level field).
  IF NEW.applicator_id IS NULL THEN
    IF OLD.applicator_id IS NOT NULL THEN
      UPDATE job_location_dispatches
         SET dispatch_status = 'cancelled',
             updated_at      = now()
       WHERE job_id = NEW.id
         AND applicator_id = OLD.applicator_id
         AND dispatch_status = 'dispatched';
    END IF;
    RETURN NEW;
  END IF;
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
       -- RLS review M1: same auth.uid()-first attribution as trigger 1 — the
       -- assign_job_applicator path never stamps jobs.updated_by, so without
       -- auth.uid() the row would credit the job's last editor, not the assigner.
       COALESCE(auth.uid(), NEW.updated_by, NEW.created_by))
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

-- caller-analysis: _sync_job_location_dispatch_on_applicator_change :: trigger-only fn (no frontend
-- .rpc() caller). REVOKE closes the default PUBLIC-EXECUTE grant-debt; the trigger still fires (grant-independent).
REVOKE EXECUTE ON FUNCTION public._sync_job_location_dispatch_on_applicator_change() FROM PUBLIC, anon;

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

-- caller-analysis: _close_job_location_dispatch_on_job_terminal :: trigger-only fn (no frontend
-- .rpc() caller). REVOKE closes the default PUBLIC-EXECUTE grant-debt; the trigger still fires (grant-independent).
REVOKE EXECUTE ON FUNCTION public._close_job_location_dispatch_on_job_terminal() FROM PUBLIC, anon;

-- ── 4) get_dashboard_action_items — add "unassigned_jobs" (finding #17/#111) ──
-- REBASED onto the LIVE function text verbatim (pg catalog introspection, 2026-07-06,
-- saved to .claude/session-state/live-defs/u13-get_dashboard_action_items.sql) +
-- ONE addition: a 7th category "unassigned_jobs" (scheduled jobs with NO active
-- 'dispatched' per-location row). Mirrors the existing "unassigned_deliveries"
-- category's shape (id / primary_text / secondary_text / scheduled_date) so the
-- same ActionQueueItem type covers it with no type change.
CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- assignment NOR (indirectly, via the sync triggers above) a whole-job
  -- applicator has reached the field crew. deleted_at IS NULL mirrors the other
  -- job reads.
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
        -- Codex R1 P2: a job with a legacy WHOLE-JOB applicator is assigned,
        -- not "unassigned" — pre-trigger jobs have no dispatch rows yet (no
        -- backfill: business-data writes are outside this run's additive-only
        -- mandate; rows materialize via the triggers on the next edit, and
        -- FieldView already surfaces legacy assignments client-side).
        AND j.applicator_id IS NULL
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
$function$;

-- Re-assert the pre-existing ACL byte-identically (live: postgres/authenticated/
-- service_role EXECUTE, anon NONE). CREATE OR REPLACE doesn't reset grants; pinned
-- per convention.
-- caller-analysis: get_dashboard_action_items :: REVOKE strips PUBLIC+anon only (anon already had
-- none live); the very next GRANT re-grants authenticated+service_role, so the one authenticated UI
-- caller (src/components/dashboard/ActionQueue.tsx:143) is unaffected — ACL byte-identical to live.
REVOKE EXECUTE ON FUNCTION public.get_dashboard_action_items(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_action_items(int) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- exactly one overload of each new/re-emitted function
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_sync_job_location_dispatch_on_field_insert';
  IF v_count <> 1 THEN RAISE EXCEPTION '_sync_job_location_dispatch_on_field_insert overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_sync_job_location_dispatch_on_applicator_change';
  IF v_count <> 1 THEN RAISE EXCEPTION '_sync_job_location_dispatch_on_applicator_change overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_close_job_location_dispatch_on_job_terminal';
  IF v_count <> 1 THEN RAISE EXCEPTION '_close_job_location_dispatch_on_job_terminal overload count is % (expected 1)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dashboard_action_items';
  IF v_count <> 1 THEN RAISE EXCEPTION 'get_dashboard_action_items overload count is % (expected 1)', v_count; END IF;

  -- all 4 trigger functions must be SECURITY DEFINER with a pinned search_path
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN (
       '_preserve_job_location_dispatch_on_field_delete',
       '_sync_job_location_dispatch_on_field_insert',
       '_sync_job_location_dispatch_on_applicator_change',
       '_close_job_location_dispatch_on_job_terminal'
     )
     AND prosecdef = true
     AND array_to_string(coalesce(proconfig, '{}'), ',') LIKE '%search_path=public, pg_temp%';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'expected 4 SECURITY DEFINER trigger fns with search_path pinned, found %', v_count;
  END IF;

  -- none of the 4 new trigger functions may be anon-executable
  SELECT count(*) INTO v_count FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN (
       '_preserve_job_location_dispatch_on_field_delete',
       '_sync_job_location_dispatch_on_field_insert',
       '_sync_job_location_dispatch_on_applicator_change',
       '_close_job_location_dispatch_on_job_terminal'
     )
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'anon must NOT have EXECUTE on the U13 trigger functions (found %)', v_count;
  END IF;

  -- the preservation stash exists, has RLS enabled, and no client can touch it
  SELECT count(*) INTO v_count FROM pg_class
   WHERE oid = 'public.job_dispatch_preservation'::regclass AND relrowsecurity = true;
  IF v_count <> 1 THEN RAISE EXCEPTION 'job_dispatch_preservation missing or RLS not enabled'; END IF;

  IF has_table_privilege('anon', 'public.job_dispatch_preservation', 'SELECT')
     OR has_table_privilege('anon', 'public.job_dispatch_preservation', 'INSERT')
     OR has_table_privilege('authenticated', 'public.job_dispatch_preservation', 'INSERT')
     OR has_table_privilege('authenticated', 'public.job_dispatch_preservation', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.job_dispatch_preservation', 'DELETE') THEN
    RAISE EXCEPTION 'client roles must have no write/read grants on job_dispatch_preservation';
  END IF;

  -- the preservation trigger exists on job_fields
  SELECT count(*) INTO v_count FROM pg_trigger
   WHERE tgname = 'trg_preserve_job_location_dispatch_on_field_delete'
     AND tgrelid = 'public.job_fields'::regclass AND NOT tgisinternal;
  IF v_count <> 1 THEN RAISE EXCEPTION 'trg_preserve_job_location_dispatch_on_field_delete missing on job_fields'; END IF;

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
