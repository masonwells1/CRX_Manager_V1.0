-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PARKED MIGRATION — NOT YET APPLIED. Awaiting Mason's approval.            ║
-- ║ Nightly Debug Mission · Cycle 1 · 2026-06-15                              ║
-- ║ Finding: lifecycle:_enforce_invoice_status_transition:paid-dead-end       ║
-- ║ Severity: BLOCKER (latent — fires on the first paid-invoice correction)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHAT'S WRONG (verified live, project rhyzpcqhnizqbxphqdkr):
--   The BEFORE-UPDATE trigger _enforce_invoice_status_transition() allows transitions
--   out of draft / unposted / posted / overdue, but has NO arm for OLD.status='paid'.
--   The only other bypass is _is_admin_override(). So any transition out of 'paid' that
--   is not wrapped in app.admin_override hits:
--       RAISE EXCEPTION 'Invalid invoice status transition'
--   Three RPCs transition a PAID invoice WITHOUT bracketing in admin_override
--   (confirmed by reading each live function body):
--       • void_invoice       paid → voided   (UPDATE invoices SET status='voided')
--       • void_payment       paid → posted   (loop: ...status IN ('paid','posted') THEN 'posted')
--       • reverse_write_off  paid → overdue / posted
--   (cancel_delivery, by contrast, DOES set_config('app.admin_override','true') around its
--    writes — proving the bracket pattern exists and these three simply omit it.)
--   Impact: the first time anyone voids a fully-paid invoice, voids a payment that fully
--   paid an invoice, or reverses a write-off that marked an invoice paid, the RPC throws
--   and the correction aborts — AR becomes uncorrectable for any invoice that reached
--   'paid'. Invisible today only because live AR is empty (0 invoices in status 'paid').
--
-- THE FIX (strict SUPERSET — adds one arm, removes nothing):
--   Allow paid → {voided, posted, overdue}: the three legitimate reversal transitions.
--   These are real accounting state changes (not admin overrides), so the enforcer is the
--   right home for them — matching the audit finding's own recommendation. Because it only
--   ADDS legal transitions, it cannot break any existing path.
--
-- VALIDATION:
--   • Compiled against the live schema inside a rolled-back transaction (DO block + final
--     RAISE) — succeeded with zero prod footprint (sentinel VALIDATION_OK).
--   • Bug proven by direct reads of the live enforcer + all three caller bodies (above).
--   • A full pay→void smoke test runs at apply time via /migration-review.
--
-- ROLLBACK: re-apply the prior definition (identical to below minus the `paid` arm).

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
