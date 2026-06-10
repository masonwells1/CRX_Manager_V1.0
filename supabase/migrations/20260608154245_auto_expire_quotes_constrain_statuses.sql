-- Fix (MED, 2026-06-08 workflow review): auto_expire_quotes would crash on draft -> expired
-- and references a non-existent 'converted' status.
--
-- The function selects every quote with expires_at < CURRENT_DATE whose status is NOT IN
-- ('expired','declined','accepted','converted') and sets status='expired'. But the quote
-- transition trigger _enforce_quote_status_transition only permits 'expired' from 'sent'
-- and 'revised' — NOT from 'draft' — and this function sets no app.admin_override, so a
-- draft quote with a past expires_at would raise 'Invalid quote status transition:
-- draft -> expired' and abort the run. (Latent: the function is not scheduled in pg_cron
-- and has no caller in src/, but it is a loaded gun if ever wired up.) 'converted' is also
-- an orphan token — it is not in quotes_status_check and no quote ever holds it.
--
-- Fix: drive the loop off the positive set the trigger actually allows to expire
-- (status IN ('sent','revised')) instead of a NOT-IN exclusion. This removes the latent
-- draft -> expired crash and drops the stale 'converted' reference. Hold-release behavior,
-- counters, and the activity-feed summary are unchanged.
--
-- Body reproduced verbatim from the live catalog (project rhyzpcqhnizqbxphqdkr,
-- 2026-06-08) with ONLY the WHERE-clause status filter changed.

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
    INSERT INTO public.activity_feed (event_type, description, performed_by)
    VALUES ('quotes_auto_expired',
      'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
      '00000000-0000-0000-0000-000000000000'::uuid);
  END IF;

  RETURN jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
END;
$function$;
