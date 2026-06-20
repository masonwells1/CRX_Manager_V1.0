-- Overnight Bug Hunt — HIGH: field_application invoice segregation (type-flip leak).
--
-- A field_application invoice can be opened in the GENERIC invoice editor
-- (Invoices.tsx routes every row to /invoices/:id -> InvoiceDetail -> save_invoice).
-- save_invoice does `invoice_type = COALESCE(p_invoice->>'invoice_type', invoice_type)`
-- and the InvoiceDetail type <select> offers a field_application option, so a
-- field_application invoice can be silently RETYPED to/from chemical_sale — a
-- segregation + AR/reporting leak (field-app invoices have separate split tables
-- and separate reporting). Confirmed live: save_invoice is the ONLY function that
-- UPDATEs invoices.invoice_type; every other write is an INSERT of a new invoice.
--
-- WHY A TRIGGER (not a save_invoice body guard): the COMPREHENSIVE fix lives on
-- feat/as-applied-invoices, which REWRITES save_invoice (CREATE OR REPLACE) to be
-- field-app-aware. A competing save_invoice rewrite here would COLLIDE on merge.
-- A trigger is a SEPARATE object — it does not collide, and it is RPC-agnostic:
-- it hard-blocks the type-flip from ANY path (generic editor today, anything
-- tomorrow), as a permanent DB-level invariant + defense-in-depth behind feat's
-- app-layer guard.
--
-- SCOPE: this closes the type-flip (the highest-impact harm). The deeper
-- line-item / invoice_shares desync when an ENGINE-built field-app invoice is
-- edited via the generic editor is fixed comprehensively on
-- feat/as-applied-invoices (save_invoice rewrite + UI reroute) — land that branch
-- to fully close this finding.
--
-- Fires only when invoice_type actually changes across the field_application
-- boundary, so normal edits (same type) and non-field invoices are untouched
-- (WHEN clause short-circuits; trigger body does nothing on same-value saves).
--
-- Built on claude/overnight-bug-hunt. NOT applied live (Mason batch-approves).

CREATE OR REPLACE FUNCTION public.enforce_field_application_type_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- XOR over the field_application boundary: block any update that turns a
  -- field_application invoice into something else, or something else into a
  -- field_application invoice. NULL-safe (NULL treated as non-field).
  IF (COALESCE(OLD.invoice_type, '') = 'field_application')
       <> (COALESCE(NEW.invoice_type, '') = 'field_application') THEN
    RAISE EXCEPTION 'FIELD_APP_TYPE_LOCKED'
      USING DETAIL = format(
        'Invoice %s cannot change invoice_type from %L to %L: the field_application boundary is locked (field-app invoices are segregated; edit via save_field_app_invoice).',
        OLD.id, OLD.invoice_type, NEW.invoice_type),
        ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_field_application_type_lock ON public.invoices;
CREATE TRIGGER trg_enforce_field_application_type_lock
  BEFORE UPDATE OF invoice_type ON public.invoices
  FOR EACH ROW
  WHEN (OLD.invoice_type IS DISTINCT FROM NEW.invoice_type)
  EXECUTE FUNCTION public.enforce_field_application_type_lock();
