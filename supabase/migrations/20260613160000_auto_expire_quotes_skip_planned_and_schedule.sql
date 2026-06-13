-- Roadmap #5 (sell-side) — auto-expire quotes: skip Planned Programs + schedule daily
-- ============================================================================
-- Mason owner gate G-AE = Option 1 (2026-06-13): auto-expire forgotten ad-hoc
-- quotes once past their expiry date (freeing the inventory they reserved), but
-- NEVER auto-expire Planned Programs (deliberate season bookings) or open/
-- partially-drawn bookings.
--
-- Two changes:
--   1. auto_expire_quotes(): add `AND q.is_planned = false` to the sweep filter.
--      Body is otherwise BYTE-VERBATIM from the live definition (the 2026-06-10
--      hardening: sent/revised only, skip drawn bookings, release holds BEFORE
--      the status flip, best-effort FK-safe summary log). Single overload, no
--      args — CREATE OR REPLACE is safe. SECURITY DEFINER + search_path kept.
--      ACLs are preserved by CREATE OR REPLACE (the fn stays REVOKEd from
--      authenticated/anon per 20260609203541 — this migration touches no grants).
--   2. Schedule the sweep on pg_cron at 06:05 daily — between mark-overdue-
--      invoices (06:00) and release-expired-quote-holds (06:15), so the hold-
--      cleanup safety net runs immediately after. Idempotent re-point by name.
--
-- FILE-ONLY: written + reviewed; apply at go-live (G5). Rolled-back smoke proof:
-- docs/roadmap/smoke/05b-auto-expire-skip-planned.sql.

CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote record; v_expired_count integer := 0; v_holds_released integer := 0; v_hold_count integer;
BEGIN
  FOR v_quote IN
    SELECT q.* FROM public.quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status IN ('sent', 'revised')
      AND q.deleted_at IS NULL
      -- A5 (2026-06-10): a quote with partial draw-downs is an open season
      -- booking — being past its quote-expiry date is normal business, not an
      -- expired quote. Never auto-expire it (the undrawn balance would be
      -- destroyed: 'expired' is terminal and releases the booking's holds).
      AND NOT EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      )
      -- #5 (2026-06-13, owner gate G-AE = Option 1): Planned Programs are
      -- deliberate season commitments that reserve inventory on purpose — never
      -- silently auto-expire them (that would release the booking's holds out
      -- from under the forecast). Staff close planned quotes by hand if needed.
      AND q.is_planned = false
    FOR UPDATE SKIP LOCKED
  LOOP
    -- M1 (2026-06-10): release holds BEFORE the status flip so the AFTER
    -- UPDATE trigger finds 0 active holds and its FK-fragile log insert
    -- (zero-uuid actor under cron) never fires. End state identical.
    UPDATE public.inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;
    v_holds_released := v_holds_released + v_hold_count;
    UPDATE public.quotes SET status = 'expired', updated_at = now() WHERE id = v_quote.id;
    v_expired_count := v_expired_count + 1;
  END LOOP;

  IF v_expired_count > 0 THEN
    -- Best-effort summary row: performed_by is NOT NULL with an FK to
    -- profiles(id) and no zero-uuid system profile exists, so this insert
    -- currently always fails — without the bracket that FK violation aborts
    -- the whole sweep AFTER the expiry work. Logging must never cancel the
    -- job it is logging.
    BEGIN
      INSERT INTO public.activity_feed (event_type, description, performed_by)
      VALUES ('quotes_auto_expired',
        'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
        '00000000-0000-0000-0000-000000000000'::uuid);
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- best-effort: see header
    END;
  END IF;

  RETURN jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
END;
$function$;

-- Schedule the daily sweep (idempotent re-point by job name).
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-expire-quotes') THEN
    PERFORM cron.unschedule('auto-expire-quotes');
  END IF;
  PERFORM cron.schedule('auto-expire-quotes', '5 6 * * *', 'SELECT public.auto_expire_quotes()');
END
$cron$;
