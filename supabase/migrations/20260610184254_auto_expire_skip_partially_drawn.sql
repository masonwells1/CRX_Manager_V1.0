-- ============================================================================
-- Fix A5 (MED, 2026-06-10 partial-draw consumer sweep): auto_expire_quotes
-- must SKIP partially-drawn season bookings.
-- ----------------------------------------------------------------------------
-- Since 20260610145253_partial_quote_draw_down, a sent/revised quote with rows
-- in quote_product_draws (quantity_drawn > 0) is an OPEN SEASON BOOKING: the
-- customer has committed quantities at a locked price and is pulling them down
-- over the season. Such a booking routinely lives long past the quote's
-- original expires_at — that is normal business, not a stale quote.
--
-- auto_expire_quotes (currently dead/uncron'd, but one pg_cron line away from
-- running in bulk) expires EVERY sent/revised quote whose expires_at <
-- CURRENT_DATE. If wired up today it would bulk-expire open bookings:
-- status -> 'expired' (terminal — the enforcer blocks expired -> sent), holds
-- deactivated, and the customer's undrawn balance silently destroyed with no
-- recovery path.
--
-- Fix: body reproduced VERBATIM from live (pre-apply prosrc md5
-- eaa4974b2807dbb6d1153b3461ad140a, byte-exact-verified against the catalog
-- 2026-06-10; identical to disk 20260608154245_auto_expire_quotes_constrain_
-- statuses.sql) with exactly TWO changes:
--
--   (1) ONE inserted predicate in the cursor WHERE clause: NOT EXISTS a
--       quote_product_draws row with quantity_drawn > 0. Quotes with zero
--       draws (the overwhelmingly common case) expire exactly as before.
--       Hold-release behavior, counters, return shape: unchanged.
--   (2) LATENT BREAK fixed (found drafting the rolled-back smoke test —
--       the "never-exercised RPCs stack multiple latent breaks" lesson):
--       the summary insert writes activity_feed.performed_by =
--       '00000000-...-000000' but that column is NOT NULL with an FK to
--       profiles(id) and no zero-uuid profile exists (live-verified
--       2026-06-10), so the FIRST run that expires anything would abort the
--       ENTIRE sweep with an FK violation AFTER expiring quotes — partial
--       work rolled back, cron run failed, forever. The insert is now
--       bracketed best-effort (nested BEGIN/EXCEPTION WHEN OTHERS): the
--       sweep's real job (expiring quotes) can no longer be aborted by its
--       observability row. NOTE: until a real system profile exists, the
--       feed row still cannot land (FK) — the bracket makes that silent
--       instead of fatal. Proper follow-up: a non-loginable system profile
--       (the entity_recipient precedent, 20260516090000) or making
--       performed_by nullable for system events.
--
-- Grants: live proacl is {postgres,service_role} (the 20260609203541
-- hardening — owner/cron/service_role only; authenticated/anon revoked).
-- CREATE OR REPLACE preserves the existing ACL; the self-verification block
-- below ASSERTS the hardened grant state survived rather than re-granting.
-- ============================================================================

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
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.quotes SET status = 'expired', updated_at = now() WHERE id = v_quote.id;
    UPDATE public.inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;
    v_holds_released := v_holds_released + v_hold_count;
    v_expired_count := v_expired_count + 1;
  END LOOP;

  IF v_expired_count > 0 THEN
    -- A5 change (2): best-effort summary row. performed_by is NOT NULL with
    -- an FK to profiles(id) and no zero-uuid system profile exists, so this
    -- insert currently always fails — without the bracket that FK violation
    -- aborts the whole sweep AFTER the expiry work. Logging must never
    -- cancel the job it is logging.
    BEGIN
      INSERT INTO public.activity_feed (event_type, description, performed_by)
      VALUES ('quotes_auto_expired',
        'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
        '00000000-0000-0000-0000-000000000000'::uuid);
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- best-effort: see header note (2)
    END;
  END IF;

  RETURN jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
END;
$function$;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'auto_expire_quotes' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'auto_expire_quotes overload count = %, expected 1', v_count;
  END IF;

  -- The skip predicate must be present in the deployed body
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'auto_expire_quotes' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%quote_product_draws%' OR v_src NOT LIKE '%quantity_drawn > 0%' THEN
    RAISE EXCEPTION 'auto_expire_quotes is missing the partial-draw skip predicate';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'auto_expire_quotes' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'auto_expire_quotes must be SECURITY DEFINER with search_path';
  END IF;

  -- The 20260609203541 hardening must survive the replace:
  -- owner/service_role only; authenticated/anon must NOT execute.
  IF has_function_privilege('authenticated', 'public.auto_expire_quotes()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auto_expire_quotes()', 'EXECUTE') THEN
    RAISE EXCEPTION 'auto_expire_quotes: authenticated/anon regained EXECUTE — hardening regressed';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.auto_expire_quotes()', 'EXECUTE') THEN
    RAISE EXCEPTION 'auto_expire_quotes: service_role lost EXECUTE';
  END IF;
END $$;
