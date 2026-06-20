-- Overnight bug-hunt MED: lifecycle-segregation:jobs:cancel-from-any-status
--
-- BUG: _enforce_job_status_transition() accepts a cancel from ANY status via an
-- UNCONDITIONAL `IF NEW.status = 'cancelled' THEN RETURN NEW` placed BEFORE the
-- forward-transition whitelist. So a DB-layer cancel from 'completed' or 'invoiced'
-- is accepted, orphaning the job's already-created field_application invoice +
-- application_records with no reversal. The sibling order/delivery enforcers gate
-- cancel by source state; this one is a real deviation. Only the frontend
-- (JobDetail.tsx) blocks it today, and the cancel write is a raw .update().
--
-- FIX: gate the cancel clause to live source states ('scheduled','in_progress'),
-- mirroring _enforce_order_status_transition / _enforce_delivery_status_transition.
-- The _is_admin_override() escape hatch above the clause is preserved, so a
-- deliberate admin reversal still works.
--
-- Body reproduced verbatim from the live definition (read 2026-06-20) with ONLY the
-- cancel clause gated — verified by a rolled-back line-level diff. Latent on live
-- data (1 scheduled job, 0 completed/invoiced/cancelled). Not SECURITY DEFINER;
-- search_path kept exactly as live ('public').

CREATE OR REPLACE FUNCTION public._enforce_job_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  -- Cancel gate (overnight bug-hunt MED, 20260620): only allow cancel from a live
  -- source state, mirroring the order/delivery enforcers. A terminal completed/invoiced
  -- job must not be cancellable here (it would orphan its field_application invoice +
  -- application_records); the _is_admin_override() hatch above still permits a
  -- deliberate admin reversal.
  IF NEW.status = 'cancelled' AND OLD.status IN ('scheduled', 'in_progress') THEN RETURN NEW; END IF;

  IF (OLD.status = 'scheduled' AND NEW.status = 'in_progress')
  OR (OLD.status = 'in_progress' AND NEW.status = 'completed')
  OR (OLD.status = 'completed' AND NEW.status = 'invoiced')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid job status transition: % → %', OLD.status, NEW.status;
END;
$function$;
