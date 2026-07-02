-- Layer 2 · Part A · Cycle A3.6 — quote-lifecycle draw guards count job draws
-- ============================================================================
-- Codex P1 (A3.5 gate): convert_quote_to_order (A3.5) blocks whole-conversion of
-- a job-drawn booking, but the QuoteBuilder flow saves the quote 'accepted'
-- FIRST (which releases the booking's remaining planned holds via the AFTER
-- status-change trigger) and only then calls convert — so for a partial job draw
-- the holds were released before A3.5's guard could refuse.
--
-- FIX: the two BEFORE-UPDATE-OF-status guard triggers on `quotes` must count job
-- draws in their draw-EXISTENCE gate (mirrors A3.5):
--   1. enforce_quote_accepted_fully_drawn — the existence gate now ORs in
--      EXISTS(job_product_draws > 0). v_fully_drawn stays ORDER-DRAWS-ONLY
--      (Codex recheck P2): job draws are REVERSIBLE until a job completes, so
--      they must NEVER satisfy 'accepted' — otherwise a later job cancel strands
--      restored balance on an accepted quote revert_quote_status can't reopen.
--      Net: a quote with any live job draw that isn't fully ORDER-drawn is
--      blocked from accept BEFORE the status flip (so nothing releases).
--   2. _enforce_quote_terminal_not_drawn — the draws-exist condition now ORs in
--      EXISTS(job_product_draws > 0), so a job-drawn quote can't be
--      declined/cancelled/expired out from under the job's reservation.
-- Both are BEFORE UPDATE OF status triggers (verified live 2026-07-02), so a
-- RAISE prevents the transition before any AFTER-trigger hold release fires.
--
-- No auto_expire_quotes change needed: it only expires `is_planned = false`
-- quotes, and job_product_draws exist ONLY on planned quotes (A4 gates the draw
-- on is_planned), so auto_expire never touches a job-drawn quote — this terminal
-- guard cannot break the cron. Only the FUNCTION bodies are replaced (the triggers
-- already point at them); no CREATE TRIGGER needed. Bodies typed out explicitly.
-- The ONLY delta vs each live baseline is the existence-gate `OR EXISTS(job...)`.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_quote_accepted_fully_drawn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_fully_drawn boolean;
BEGIN
  IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    -- Canonical RPC/admin escape hatch (convert_quote_to_order brackets its
    -- own status write AFTER explicitly guarding the draws ledger).
    IF _is_admin_override() THEN RETURN NEW; END IF;

    IF EXISTS (
      SELECT 1 FROM quote_product_draws
      WHERE quote_id = NEW.id AND quantity_drawn > 0
    )
    -- LAYER2<<< job reservations count as draws too (§6.5)
    OR EXISTS (
      SELECT 1 FROM job_product_draws
      WHERE quote_id = NEW.id AND quantity_drawn > 0
    )
    -- >>>LAYER2
    THEN
      -- v_fully_drawn counts ORDER draws ONLY: job draws are reversible until a
      -- job completes, so they must not satisfy 'accepted' (a later job cancel
      -- would strand restored balance). A quote with a live job draw that isn't
      -- fully ORDER-drawn therefore raises BOOKING_PARTIALLY_DRAWN below.
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = NEW.id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = NEW.id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_fully_drawn THEN
        RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN: cannot mark quote % accepted — the booking still has an undrawn balance', NEW.quote_number;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public._enforce_quote_terminal_not_drawn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status IN ('declined', 'cancelled', 'expired')
     AND (
       -- order draws only exist on sent/revised bookings (baseline scope)
       (OLD.status IN ('sent', 'revised') AND EXISTS (
         SELECT 1 FROM quote_product_draws
         WHERE quote_id = NEW.id AND quantity_drawn > 0
       ))
       -- LAYER2<<< a job can be scheduled from a DRAFT planned quote before it's
       -- sent, so a live job reservation must block termination from ANY status
       -- (else draft -> cancelled releases the quote holds under the job).
       OR EXISTS (
         SELECT 1 FROM job_product_draws
         WHERE quote_id = NEW.id AND quantity_drawn > 0
       )
       -- >>>LAYER2
     )
  THEN
    RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN';
  END IF;
  RETURN NEW;
END;
$function$;
