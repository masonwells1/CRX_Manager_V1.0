-- Fix: _enforce_quote_terminal_not_drawn() omitted 'expired' from its terminal-status guard.
-- A partially-drawn sent/revised quote could be flipped to 'expired' (a terminal status),
-- destroying the undrawn balance and releasing the booking's holds — bypassing the
-- BOOKING_PARTIALLY_DRAWN protection that already blocks the decline/cancel terminal paths.
-- This is a STRICT SUPERSET: it adds 'expired' to the guarded set and removes no existing
-- behavior, so it can only block one additional illegal transition.
--
-- Source: nightly-debug audit (docs/audits/nightly-debug, finding
--   quote:_enforce_quote_terminal_not_drawn:missing-expired-in-guard). Cross-reviewed by Codex.
-- Validated: compiles against live inside a rolled-back transaction.
-- Rollback: re-apply this function with NEW.status IN ('declined', 'cancelled').

CREATE OR REPLACE FUNCTION public._enforce_quote_terminal_not_drawn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status IN ('sent', 'revised')
     AND NEW.status IN ('declined', 'cancelled', 'expired')
     AND EXISTS (
       SELECT 1 FROM quote_product_draws
       WHERE quote_id = NEW.id AND quantity_drawn > 0
     ) THEN
    RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN';
  END IF;
  RETURN NEW;
END;
$function$;
