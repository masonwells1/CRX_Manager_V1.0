-- Roadmap #6(b-B) — auto-apply booking prepay when a draw invoice posts (FILE-ONLY)
-- ============================================================================
-- WHAT: a best-effort AFTER-UPDATE trigger on invoices that calls
--   apply_booking_prepay(NEW.id, ...) the moment an invoice transitions INTO
--   'posted'. So a draw invoice automatically applies its booking's earmarked
--   prepay (Mechanism A, reversible) without anyone clicking the #6(c-3) button.
--
-- WHY a trigger (Option 1, Mason 2026-06-13) instead of rewriting post_invoice:
--   * Additive — no verbatim reproduction of the large, central post_invoice RPC
--     (lower transcription risk for identical behavior).
--   * BEST-EFFORT: the apply call is wrapped in a BEGIN/EXCEPTION subtransaction,
--     so a prepay hiccup can NEVER abort or roll back invoice posting — posting
--     always succeeds; the manual "Apply booking prepay" button stays the fallback.
--   * apply_booking_prepay already no-ops for non-booking-draw / not-postable /
--     no-balance invoices, so firing on every post→posted is safe and cheap.
--
-- NO RECURSION: the trigger is WHEN (NEW.status='posted' AND OLD IS DISTINCT FROM
--   'posted'). apply_booking_prepay may flip a fully-covered invoice posted→'paid'
--   (a nested status UPDATE) — that re-fires this trigger but the WHEN clause
--   ('paid' <> 'posted') rejects it, so it runs at most once per post. Partial
--   applications only touch prepay_applied_cents (not status) so they don't
--   re-trigger an OF-status trigger.
--
-- REENTRANCY: fires AFTER post_invoice's status UPDATE (row already locked by the
--   same txn); apply_booking_prepay's FOR UPDATE re-locks the same row in-txn
--   (fine), and check_period_open is already satisfied by post_invoice.
--
-- AUTH: apply_booking_prepay binds v_actor = auth.uid(); SECDEF does not change
--   auth.uid() (it reads the request JWT), so inside this trigger fired by an
--   authenticated post_invoice the actor is the real poster (admin/sales_rep). If
--   auth.uid() is NULL (e.g. a service_role/cron post), apply_booking_prepay raises
--   AUTH_REQUIRED → swallowed by the wrapper → posting proceeds, prepay deferred.
--
-- DEPENDS ON: 20260613240000 (apply_booking_prepay). Apply 240000 first at G5.
-- SAFETY: no financial_audit_log/CHECK change here (apply_booking_prepay logs its
--   own row). FILE-ONLY — do NOT apply this session.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._apply_booking_prepay_on_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Best-effort: a prepay problem must NEVER block invoice posting.
  BEGIN
    PERFORM apply_booking_prepay(NEW.id, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    -- Non-fatal: the inner subtransaction already rolled back the failed apply;
    -- posting still succeeds and the manual "Apply booking prepay" button
    -- (OrderDetail) remains the fallback. RAISE WARNING (not EXCEPTION) leaves a
    -- log breadcrumb for triage without ever aborting the post.
    RAISE WARNING 'auto-apply booking prepay failed for invoice % (non-fatal, posting unaffected): %', NEW.id, SQLERRM;
  END;
  RETURN NULL; -- AFTER trigger: return value ignored.
END;
$$;

-- Trigger-only function; never called directly (errors as a non-trigger call).
-- caller-analysis: _apply_booking_prepay_on_post :: trigger-only fn invoked solely by trg_apply_booking_prepay_on_post on public.invoices; no UI/Edge/cron/direct caller; REVOKE EXECUTE FROM PUBLIC/anon/authenticated (defense-in-depth — trigger execution is unaffected by EXECUTE grants).
REVOKE EXECUTE ON FUNCTION public._apply_booking_prepay_on_post() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._apply_booking_prepay_on_post() FROM anon;
REVOKE EXECUTE ON FUNCTION public._apply_booking_prepay_on_post() FROM authenticated;

DROP TRIGGER IF EXISTS trg_apply_booking_prepay_on_post ON public.invoices;
CREATE TRIGGER trg_apply_booking_prepay_on_post
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted')
  EXECUTE FUNCTION public._apply_booking_prepay_on_post();

-- Self-verification.
DO $$
DECLARE
  v_fn int;
  v_trg int;
BEGIN
  SELECT count(*) INTO v_fn FROM pg_proc
    WHERE proname = '_apply_booking_prepay_on_post' AND pronamespace = 'public'::regnamespace;
  IF v_fn <> 1 THEN
    RAISE EXCEPTION 'EXPECTED exactly 1 _apply_booking_prepay_on_post overload, found %', v_fn;
  END IF;
  SELECT count(*) INTO v_trg FROM pg_trigger
    WHERE tgname = 'trg_apply_booking_prepay_on_post' AND tgrelid = 'public.invoices'::regclass AND NOT tgisinternal;
  IF v_trg <> 1 THEN
    RAISE EXCEPTION 'EXPECTED trg_apply_booking_prepay_on_post on invoices, found %', v_trg;
  END IF;
END $$;
