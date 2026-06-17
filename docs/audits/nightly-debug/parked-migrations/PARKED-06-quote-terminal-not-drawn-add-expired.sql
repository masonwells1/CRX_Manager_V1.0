-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ PARKED MIGRATION — NOT YET APPLIED. Awaiting Mason's approval.            ║
-- ║ Nightly Debug Mission · Cycle 5 · 2026-06-16                              ║
-- ║ Finding: quote:_enforce_quote_terminal_not_drawn:missing-expired-in-guard ║
-- ║ Severity: LOW (currently unreachable; latent partial-draw protection gap)  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHAT'S WRONG (verified live, project rhyzpcqhnizqbxphqdkr):
--   _enforce_quote_terminal_not_drawn raises BOOKING_PARTIALLY_DRAWN only when a sent/revised
--   quote with a positive draw transitions to 'declined' or 'cancelled' — it OMITS 'expired'.
--   The status enforcer (and save_quote's map) allow sent/revised -> expired. The protection is
--   asymmetric. Currently UNREACHABLE: auto_expire_quotes explicitly skips drawn + is_planned
--   quotes, and no UI/RPC sets status='expired' manually (grep found none) — so no live exposure.
--   But if a future feature ever lets staff manually expire a quote, a partially-drawn OPEN
--   BOOKING could be flipped to 'expired' (terminal), destroying the undrawn balance and releasing
--   the booking's holds — bypassing the partial-draw protection that already blocks decline/cancel.
--
-- THE FIX (one-word tightening; verbatim body otherwise):
--   Add 'expired' to the NEW.status set so the guard is symmetric across all terminal statuses,
--   matching auto_expire_quotes' intent. Strictly blocks one more illegal transition — adds no
--   new allowed path.
--
-- VALIDATION: compiled against the live schema inside a rolled-back transaction (VALIDATION_OK).
--
-- ROLLBACK: re-apply with NEW.status IN ('declined', 'cancelled').

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
