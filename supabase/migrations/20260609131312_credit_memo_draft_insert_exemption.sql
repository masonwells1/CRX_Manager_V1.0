-- Fix B1 part 2 (foundation audit 2026-06-09, BLOCKER completion).
--
-- The BEFORE INSERT trigger trg_invoice_draft_insert -> enforce_invoice_draft_on_insert()
-- unconditionally rejected ANY invoice inserted with status != 'draft':
--     "Invoices must be created with status draft. Got: posted"
--
-- issue_return_credit inserts the credit_memo already 'posted' (it calls
-- check_period_open(CURRENT_DATE) first, and credit memos do NOT go through the normal
-- draft -> post_invoice flow). So even after 20260609120000 relaxed the CHECK constraints,
-- this trigger still blocked the insert FIRST (BEFORE INSERT fires before CHECK evaluation).
-- This was the actual first failure point of the broken return -> credit flow; a rolled-back
-- smoke test surfaced it after the constraint fix.
--
-- Fix: exempt invoice_type='credit_memo' from the draft-on-insert rule. This is scoped to
-- the ONE legitimate posted-insert path (issue_return_credit). Every other invoice_type
-- must still be created as 'draft'. Body otherwise byte-identical to the live function.
-- Reversible: restore the unconditional `IF NEW.status != 'draft'` check.

CREATE OR REPLACE FUNCTION public.enforce_invoice_draft_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Credit memos are created already-posted by issue_return_credit (which calls
  -- check_period_open before inserting); they never use the draft -> post flow.
  IF NEW.status <> 'draft' AND NEW.invoice_type <> 'credit_memo' THEN
    RAISE EXCEPTION 'Invoices must be created with status draft. Got: %', NEW.status;
  END IF;
  RETURN NEW;
END;
$function$;
