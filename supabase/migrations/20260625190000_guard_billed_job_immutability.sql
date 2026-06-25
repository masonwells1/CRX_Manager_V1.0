-- 20260625190000_guard_billed_job_immutability.sql
--
-- Field-app parity #12 review (Medium, pre-existing & app-wide) — billed-history
-- immutability, enforced at the DATABASE instead of only in the React client.
--
-- THE DEFECT (live-proven by the reviewer as a non-admin sales_rep under RLS)
--   The "a billed/finished job is immutable" invariant lived ONLY in the frontend:
--     * jobs_update RLS = (is_admin() OR is_sales_rep()) — NO status predicate.
--     * Soft-delete is a deleted_at UPDATE that rides jobs_update; there is no
--       admin-only soft-delete path (jobs_delete is a hard DELETE policy, unused).
--     * enforce_job_status_transition fires BEFORE UPDATE OF status, so it NEVER
--       sees a deleted_at-only or other non-status edit.
--   Result: a non-admin sales_rep, via raw REST/psql, could soft-delete an
--   `invoiced` job (deleted_at NULL -> non-NULL = UPDATE 1) AND rewrite its
--   billed-relevant columns (e.g. total_price_cents, customer_id = UPDATE 1) —
--   erasing or rewriting real billed money history while bypassing the UI.
--
-- THE GUARD (this migration)
--   A BEFORE UPDATE trigger function _enforce_billed_job_immutability(), companion
--   to _enforce_job_status_transition(). For a NON-admin, when OLD.status is a
--   terminal billed state ('invoiced' or 'cancelled') and the canonical admin
--   override hatch is NOT set, it:
--     (a) REJECTS a soft-delete (deleted_at NULL -> non-NULL), and
--     (b) REJECTS any change to a billed-relevant column.
--   It fires for EACH ROW on BEFORE UPDATE (no OF column list — it must see
--   deleted_at-only and any-column edits the status enforcer can't), so the
--   ordering vs enforce_job_status_transition is irrelevant: both must pass.
--
-- WHY AN ALLOW-LIST, NOT A DENY-LIST
--   Enumerating "billed-relevant columns" is fragile — a column added later would
--   silently be unprotected. Instead the row is allowed through only if every
--   column OTHER than a small, deliberately-vetted EXEMPT set is unchanged
--   (NEW.col IS NOT DISTINCT FROM OLD.col). New columns are protected by default.
--
-- THE EXEMPT (still-mutable) COLUMNS on an invoiced/cancelled job for a non-admin,
-- each tied to a PROVEN legitimate non-admin path that touches a billed job:
--   * status         — governed separately by _enforce_job_status_transition
--                      (forward steps + the gated cancel clause + the override
--                      hatch). Not this guard's job; leaving it here avoids
--                      double-gating a transition the status enforcer already rules.
--   * deleted_at     — handled explicitly: NULL -> non-NULL is BLOCKED here; an
--                      already-set value (idempotent re-stamp / admin un-delete via
--                      hatch) is left to the status/RLS layer. (A non-admin can
--                      never set it from NULL.)
--   * applied_acres  — written by the SECURITY-DEFINER applied-acres recompute
--                      (recompute_job_applied_acres / trg_jarf_recompute, migration
--                      20260624181000), which does NOT set the override hatch. As-
--                      applied legal detail can legitimately be recorded after a job
--                      is invoiced, so this rollup column must stay writable.
--                      remaining_acres is GENERATED (never written) and so is
--                      structurally immutable already.
--   * printed_at,
--     last_printed_by — the compliance/loader print audit stamp is a direct non-
--                      admin .update({printed_at,last_printed_by}) (Jobs.tsx /
--                      JobDetail.tsx) and printing an invoiced job's applicator/
--                      loader sheet is a legitimate, non-billing action.
--   * updated_at,
--     updated_by      — bookkeeping set by every UPDATE (set_jobs_updated_at
--                      trigger + RPCs); never billing data.
--   * invoice_id      — set/cleared by the transfer RPCs. transfer_job_to_invoice
--                      writes it while OLD.status='completed' (guard does not apply);
--                      transfer_invoice_to_job clears it under the override hatch.
--                      Exempting it is belt-and-suspenders and touches no money.
--
-- ALWAYS ALLOWED (early returns, before any column check):
--   * is_admin()              — admins may correct billed history (the UI delete/
--                               edit on an invoiced job is admin-only).
--   * _is_admin_override()    — the SECURITY-DEFINER definer-flow hatch
--                               (current_setting('app.admin_override')='true'),
--                               e.g. transfer_invoice_to_job's bracketed job UPDATE.
--   * OLD.status NOT IN ('invoiced','cancelled') — only billed/terminal jobs are
--                               immutable; scheduled/in_progress/completed jobs edit
--                               exactly as before (zero behavior change for them).
--
-- This is NOT SECURITY DEFINER (it's a constraint-style trigger that must see the
-- caller's is_admin()/override under their own auth context — same as
-- _enforce_job_status_transition). search_path pinned to 'public' to match the
-- sibling enforcer. Single definition (no overload). No RLS policy added/removed.

CREATE OR REPLACE FUNCTION public._enforce_billed_job_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only billed/terminal jobs are immutable. A live job edits exactly as before.
  IF OLD.status NOT IN ('invoiced', 'cancelled') THEN
    RETURN NEW;
  END IF;

  -- Admins may correct billed history; the definer-flow override hatch (set by
  -- SECURITY DEFINER RPCs via SET LOCAL app.admin_override='true') is honored so
  -- sanctioned server-side flows (e.g. transfer_invoice_to_job) still work.
  IF is_admin() OR _is_admin_override() THEN
    RETURN NEW;
  END IF;

  -- (a) Most severe hole: block a non-admin soft-delete of a billed job.
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'A % job is billed history and cannot be deleted by a non-admin (job %).',
      OLD.status, OLD.job_number
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) Block a non-admin rewrite of any billed-relevant column. Allow the row
  -- through only when every NON-exempt column is unchanged. New columns are
  -- protected by default (they are not in the exempt set below).
  IF NOT (
       NEW.id                     IS NOT DISTINCT FROM OLD.id
   AND NEW.job_number             IS NOT DISTINCT FROM OLD.job_number
   AND NEW.customer_id            IS NOT DISTINCT FROM OLD.customer_id
   AND NEW.job_date               IS NOT DISTINCT FROM OLD.job_date
   AND NEW.scheduled_time         IS NOT DISTINCT FROM OLD.scheduled_time
   AND NEW.applicator_id          IS NOT DISTINCT FROM OLD.applicator_id
   AND NEW.vehicle_id             IS NOT DISTINCT FROM OLD.vehicle_id
   AND NEW.recipe_id              IS NOT DISTINCT FROM OLD.recipe_id
   AND NEW.notes                  IS NOT DISTINCT FROM OLD.notes
   AND NEW.tags                   IS NOT DISTINCT FROM OLD.tags
   AND NEW.batch_id               IS NOT DISTINCT FROM OLD.batch_id
   AND NEW.season                 IS NOT DISTINCT FROM OLD.season
   AND NEW.total_acres            IS NOT DISTINCT FROM OLD.total_acres
   AND NEW.total_cost_cents       IS NOT DISTINCT FROM OLD.total_cost_cents
   AND NEW.total_price_cents      IS NOT DISTINCT FROM OLD.total_price_cents
   AND NEW.created_by             IS NOT DISTINCT FROM OLD.created_by
   AND NEW.deleted_at             IS NOT DISTINCT FROM OLD.deleted_at
   AND NEW.created_at             IS NOT DISTINCT FROM OLD.created_at
   AND NEW.priority               IS NOT DISTINCT FROM OLD.priority
   AND NEW.estimated_hours        IS NOT DISTINCT FROM OLD.estimated_hours
   AND NEW.quote_id               IS NOT DISTINCT FROM OLD.quote_id
   AND NEW.quote_section_id       IS NOT DISTINCT FROM OLD.quote_section_id
   AND NEW.application_service_id IS NOT DISTINCT FROM OLD.application_service_id
   AND NEW.call_date              IS NOT DISTINCT FROM OLD.call_date
   AND NEW.date_proposed          IS NOT DISTINCT FROM OLD.date_proposed
   AND NEW.time_proposed          IS NOT DISTINCT FROM OLD.time_proposed
   AND NEW.schedule_date          IS NOT DISTINCT FROM OLD.schedule_date
   AND NEW.date_expires           IS NOT DISTINCT FROM OLD.date_expires
   AND NEW.consultant_id          IS NOT DISTINCT FROM OLD.consultant_id
   AND NEW.loader_comment         IS NOT DISTINCT FROM OLD.loader_comment
   AND NEW.additional_info        IS NOT DISTINCT FROM OLD.additional_info
   AND NEW.internal_memo          IS NOT DISTINCT FROM OLD.internal_memo
   AND NEW.ground_crew_id         IS NOT DISTINCT FROM OLD.ground_crew_id
   AND NEW.batch_ref              IS NOT DISTINCT FROM OLD.batch_ref
   AND NEW.carrier_rate_gpa       IS NOT DISTINCT FROM OLD.carrier_rate_gpa
   AND NEW.loader_tank_capacity   IS NOT DISTINCT FROM OLD.loader_tank_capacity
   -- EXEMPT (intentionally NOT checked — see header): status, deleted_at*,
   -- applied_acres, remaining_acres (GENERATED), printed_at, last_printed_by,
   -- updated_at, updated_by, invoice_id.
   -- (*deleted_at's NULL->non-NULL case is already blocked above; an unchanged
   --  value passes the IS NOT DISTINCT FROM check we DO run on it.)
  ) THEN
    RAISE EXCEPTION 'A % job is billed history; a non-admin cannot edit its billed-relevant fields (job %).',
      OLD.status, OLD.job_number
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- Fire on EVERY row-level UPDATE (no OF column list): the guard must see
-- deleted_at-only edits and any-column rewrites that the status-only enforcer
-- misses. Idempotent re-create.
DROP TRIGGER IF EXISTS enforce_billed_job_immutability ON public.jobs;
CREATE TRIGGER enforce_billed_job_immutability
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_billed_job_immutability();

COMMENT ON FUNCTION public._enforce_billed_job_immutability() IS
  'Field-app parity #12: DB guard for billed-history immutability. For a non-admin '
  '(and without the app.admin_override hatch), an invoiced/cancelled job cannot be '
  'soft-deleted (deleted_at NULL->non-NULL) nor have its billed-relevant columns '
  'rewritten. Exempt: status (status-enforcer), applied_acres (recompute), '
  'printed_at/last_printed_by (print audit), updated_at/updated_by, invoice_id. '
  'Admins and sanctioned SECURITY DEFINER flows (override hatch) are unaffected.';
