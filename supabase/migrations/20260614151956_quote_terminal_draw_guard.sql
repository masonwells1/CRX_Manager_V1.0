-- Roadmap #5 hardening / Codex round-3 P1 — atomic decline/cancel-vs-draw guard (FILE-ONLY)
-- ============================================================================
-- WHAT: a BEFORE UPDATE OF status trigger on quotes that blocks an open booking
--   (sent/revised) from going to a terminal declined/cancelled status while it has
--   ANY drawn quantity (quote_product_draws.quantity_drawn > 0).
--
-- WHY: QuoteBuilder's decline/cancel does a frontend draw-check then a separate
--   UPDATE — a TOCTOU: a concurrent draw_down_quote between the check and the
--   UPDATE could let the quote be declined/cancelled and its holds released
--   (trg_release_holds_on_quote_status, AFTER UPDATE) despite now being partially
--   drawn, orphaning the drawn order's inventory entitlement. A BEFORE trigger is
--   ATOMIC with the status UPDATE: the UPDATE takes the quote row lock, so it
--   serializes against draw_down_quote (which locks the quote FOR UPDATE); the
--   trigger then sees the committed draw and aborts BEFORE the AFTER hold-release
--   fires. The frontend pre-check stays as a friendly fast path.
--
-- NO override hatch (deliberate): a drawn booking must be closed via its orders
--   (draw or void/cancel the draw orders, which reverse the quote_product_draws
--   ledger per 20260610185806). Once quantity_drawn returns to 0 the EXISTS check
--   is false and decline/cancel is allowed again — a natural unblock path.
--
-- Token BOOKING_PARTIALLY_DRAWN is already in RpcErrorCodes (draw-down #1). No
-- CHECK/column change. FILE-ONLY — do NOT apply this session.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._enforce_quote_terminal_not_drawn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('sent', 'revised')
     AND NEW.status IN ('declined', 'cancelled')
     AND EXISTS (
       SELECT 1 FROM quote_product_draws
       WHERE quote_id = NEW.id AND quantity_drawn > 0
     ) THEN
    RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN';
  END IF;
  RETURN NEW;
END;
$$;

-- caller-analysis: _enforce_quote_terminal_not_drawn :: trigger-only fn invoked solely by trg_enforce_quote_terminal_not_drawn on public.quotes; no UI/Edge/cron/direct caller; REVOKE EXECUTE FROM PUBLIC/anon/authenticated (trigger execution is unaffected by EXECUTE grants).
REVOKE EXECUTE ON FUNCTION public._enforce_quote_terminal_not_drawn() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._enforce_quote_terminal_not_drawn() FROM anon;
REVOKE EXECUTE ON FUNCTION public._enforce_quote_terminal_not_drawn() FROM authenticated;

DROP TRIGGER IF EXISTS trg_enforce_quote_terminal_not_drawn ON public.quotes;
CREATE TRIGGER trg_enforce_quote_terminal_not_drawn
  BEFORE UPDATE OF status ON public.quotes
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public._enforce_quote_terminal_not_drawn();

-- Self-verification.
DO $$
DECLARE v_fn int; v_trg int;
BEGIN
  SELECT count(*) INTO v_fn FROM pg_proc
    WHERE proname = '_enforce_quote_terminal_not_drawn' AND pronamespace = 'public'::regnamespace;
  IF v_fn <> 1 THEN RAISE EXCEPTION 'EXPECTED 1 _enforce_quote_terminal_not_drawn, found %', v_fn; END IF;
  SELECT count(*) INTO v_trg FROM pg_trigger
    WHERE tgname = 'trg_enforce_quote_terminal_not_drawn' AND tgrelid = 'public.quotes'::regclass AND NOT tgisinternal;
  IF v_trg <> 1 THEN RAISE EXCEPTION 'EXPECTED trg_enforce_quote_terminal_not_drawn on quotes, found %', v_trg; END IF;
END $$;
