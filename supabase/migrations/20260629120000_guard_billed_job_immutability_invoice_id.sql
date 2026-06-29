-- 20260629120000_guard_billed_job_immutability_invoice_id.sql
--
-- Field-app parity remediation (P1 SECURITY) — close the invoice_id hole in the
-- billed-job immutability guard introduced by 20260625190000.
--
-- THE DEFECT (live-proven by the reviewer as a non-admin sales_rep under RLS)
--   _enforce_billed_job_immutability() (the BEFORE UPDATE guard on jobs) EXEMPTED
--   invoice_id from its protected-equality block. jobs_update RLS is
--   (is_admin() OR is_sales_rep()) with no status predicate, so a non-admin
--   sales_rep could PATCH ONLY invoice_id on an invoiced/cancelled job:
--     * ATTACK-1: set invoice_id = NULL   → DETACH the billed job from its invoice
--     * ATTACK-2: set invoice_id = <other> → REPOINT it at a different invoice
--   Both SUCCEEDED, while rewriting total_price_cents was correctly BLOCKED. This
--   corrupts billed-history integrity and breaks the transfer_invoice_to_job
--   reversal (which keys off jobs.invoice_id).
--
-- THE FIX (this migration)
--   CREATE OR REPLACE the SAME function with one change: invoice_id is MOVED into
--   the protected-equality NOT(...) block (NEW.invoice_id IS NOT DISTINCT FROM
--   OLD.invoice_id), so a non-admin direct PATCH that changes invoice_id on a
--   billed job now RAISES. Everything else is byte-for-byte the prior body:
--   SECURITY-INVOKER (not DEFINER), SET search_path='public', the is_admin()/
--   _is_admin_override() early-return hatch, the OLD.status NOT IN
--   ('invoiced','cancelled') early return, and the soft-delete block.
--
-- WHY THE TWO LEGIT WRITERS ARE UNAFFECTED (the only sanctioned invoice_id writes)
--   * transfer_job_to_invoice writes invoice_id while OLD.status = 'completed'
--     (it RAISEs unless the job is completed) — the guard early-returns for any
--     status that is not invoiced/cancelled, so it never fires on this write.
--   * transfer_invoice_to_job clears invoice_id to NULL on an OLD.status='invoiced'
--     job, but does so under SET LOCAL app.admin_override='true' — the guard's
--     _is_admin_override() early return fires BEFORE the column check, so it passes.
--   Both were re-run in rolled-back transactions and confirmed to still SUCCEED.
--
-- No RLS policy added/removed. Single definition (no overload). Trigger unchanged
-- (the existing enforce_billed_job_immutability BEFORE UPDATE trigger already
-- points at this function name).

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
   -- P1 remediation: invoice_id is NOW protected (was exempt). A non-admin can
   -- no longer detach (->NULL) or repoint a billed job's invoice via direct PATCH.
   -- The two legitimate writers still pass: transfer_job_to_invoice writes it on a
   -- 'completed' job (guard early-returns), transfer_invoice_to_job clears it under
   -- the admin_override hatch (early-returns above the column check).
   AND NEW.invoice_id             IS NOT DISTINCT FROM OLD.invoice_id
   -- EXEMPT (intentionally NOT checked — see header): status, deleted_at*,
   -- applied_acres, remaining_acres (GENERATED), printed_at, last_printed_by,
   -- updated_at, updated_by.
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

-- Trigger already exists from 20260625190000 (same function name); no DROP/CREATE
-- needed. CREATE OR REPLACE above re-points it at the new body in place.

COMMENT ON FUNCTION public._enforce_billed_job_immutability() IS
  'Field-app parity #12 (+P1 invoice_id remediation): DB guard for billed-history '
  'immutability. For a non-admin (and without the app.admin_override hatch), an '
  'invoiced/cancelled job cannot be soft-deleted (deleted_at NULL->non-NULL) nor '
  'have its billed-relevant columns rewritten — INCLUDING invoice_id (a non-admin '
  'can no longer detach or repoint a billed job''s invoice). Exempt: status '
  '(status-enforcer), applied_acres (recompute), printed_at/last_printed_by (print '
  'audit), updated_at/updated_by. Admins and sanctioned SECURITY DEFINER flows '
  '(override hatch) are unaffected.';
