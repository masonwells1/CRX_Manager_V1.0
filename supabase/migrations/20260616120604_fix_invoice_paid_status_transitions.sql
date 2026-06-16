-- Fix (BLOCKER): _enforce_invoice_status_transition() had no outgoing transition from 'paid',
-- so void_invoice (paid->voided), void_payment (paid->posted), and reverse_write_off
-- (paid->overdue/posted) — none of which bracket their write in app.admin_override — all hit
-- RAISE EXCEPTION 'Invalid invoice status transition' the first time anyone corrects a fully-paid
-- invoice. AR would become uncorrectable for any invoice that reached 'paid'. Latent today only
-- because live AR is empty (0 invoices in status 'paid').
--
-- Fix: STRICT SUPERSET — add paid -> {voided, posted, overdue}, the three legitimate reversal
-- transitions. It only ADDS legal transitions; it removes none, so no existing path can break.
-- Body is live-verbatim except the one added arm. Source: nightly-debug (PARKED-01),
-- Codex-reviewed; rls-security + migration-drift clean. Validated: compiles against live rolled back.
-- Rollback: re-apply this function without the `OLD.status = 'paid'` arm.

CREATE OR REPLACE FUNCTION public._enforce_invoice_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'draft'    AND NEW.status IN ('unposted', 'posted', 'cancelled'))
  OR (OLD.status = 'unposted' AND NEW.status IN ('posted', 'cancelled'))
  OR (OLD.status = 'posted'   AND NEW.status IN ('voided', 'paid', 'overdue'))
  OR (OLD.status = 'overdue'  AND NEW.status IN ('paid', 'voided'))
  OR (OLD.status = 'paid'     AND NEW.status IN ('voided', 'posted', 'overdue'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid invoice status transition: % → %', OLD.status, NEW.status;
END;
$function$;
