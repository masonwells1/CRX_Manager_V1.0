-- ============================================================================
-- SUPERSESSION (2026-06-10, applied live as MCP stamp 20260610191550): live
-- auto_expire_quotes at stamp 20260610184254 carried the partial-draw skip
-- predicate but NOT the latent-break fixes (the parallel /ship session
-- applied the in-progress draft from the shared working tree before the
-- reviewed revision landed the bracket). Two fixes here (H1 + M1 of the
-- 2026-06-10 batch review):
--   (1) Best-effort bracket around the function's own summary activity_feed
--       insert (performed_by zero-uuid violates the profiles FK — without
--       the bracket the FIRST real sweep aborts AFTER doing its work).
--   (2) M1: holds are released BEFORE the status flip. The AFTER UPDATE
--       trigger release_holds_on_quote_status_change inserts into
--       activity_feed with COALESCE(auth.uid(), zero-uuid); under cron /
--       service_role auth.uid() IS NULL and the zero-uuid profile does not
--       exist, so if the trigger released >= 1 hold its log insert would
--       FK-crash OUTSIDE any bracket and abort the sweep. Releasing holds
--       first means the trigger always finds 0 active holds and never logs.
--       Trade-off (documented): auto-expired quotes get no per-quote
--       hold-release feed row; the function's own summary row covers it once
--       a system profile exists. Proper follow-up: non-loginable system
--       profile (entity_recipient precedent, 20260516090000) or a nullable
--       performed_by for system events.
-- Body otherwise verbatim from live. Grants unchanged: {postgres,
-- service_role} only (20260609203541 hardening) — asserted below.
-- Smoke (post-apply): scripts/smoke/smoke-auto-expire-draw-skip.sql →
-- SMOKE_PASS_ROLLBACK (partially-drawn expired-date booking untouched;
-- no-draws control expires; grant hardening intact).
-- The 184254 disk file is retained as-committed for history (red line:
-- never modify existing migration files); its bracket block describes THIS
-- body, not the one its stamp applied.
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

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'auto_expire_quotes' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'auto_expire_quotes overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'auto_expire_quotes' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%quote_product_draws%' OR v_src NOT LIKE '%quantity_drawn > 0%' THEN
    RAISE EXCEPTION 'auto_expire_quotes is missing the partial-draw skip predicate';
  END IF;
  IF v_src NOT LIKE '%EXCEPTION WHEN OTHERS%' THEN
    RAISE EXCEPTION 'auto_expire_quotes is missing the best-effort bracket';
  END IF;
  -- M1 ordering: the holds release must come before the status flip.
  IF position('inventory_holds SET is_active' IN v_src) = 0
     OR position('inventory_holds SET is_active' IN v_src) > position('SET status = ''expired''' IN v_src) THEN
    RAISE EXCEPTION 'auto_expire_quotes: holds release is not ordered before the status flip';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'auto_expire_quotes' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'auto_expire_quotes must be SECURITY DEFINER with search_path';
  END IF;

  IF has_function_privilege('authenticated', 'public.auto_expire_quotes()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.auto_expire_quotes()', 'EXECUTE') THEN
    RAISE EXCEPTION 'auto_expire_quotes: authenticated/anon regained EXECUTE — hardening regressed';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.auto_expire_quotes()', 'EXECUTE') THEN
    RAISE EXCEPTION 'auto_expire_quotes: service_role lost EXECUTE';
  END IF;
END $$;
