-- ============================================================================
-- PR-12: Add SET search_path = public, pg_temp to SECURITY DEFINER functions
--        that currently have search_path = "" (empty).
--
-- The CLAUDE.md canonical pattern requires `SET search_path = public, pg_temp`
-- on every SECURITY DEFINER function. Empty search_path means the function
-- can't resolve unqualified table/function references — relies on schema-
-- qualified names everywhere. Both functions below already use schema-
-- qualified references in their bodies (public.quotes, public.inventory_holds,
-- public.activity_feed) so the fix is purely additive: bodies stay verbatim.
--
-- Live DB inspection adjusted plan scope:
--   - record_invoice_payment was already canonicalized in PR-02
--     (20260510020000_fix_idempotency_replay_canonical.sql)
--   - close_accounting_period already has search_path = public, pg_temp
--   - That leaves auto_expire_quotes and release_holds_on_quote_status_change.
-- ============================================================================


-- ─── auto_expire_quotes ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote          record;
  v_expired_count  integer := 0;
  v_holds_released integer := 0;
  v_hold_count     integer;
BEGIN
  FOR v_quote IN
    SELECT q.*
    FROM public.quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status NOT IN ('expired', 'declined', 'accepted', 'converted')
      AND q.deleted_at IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.quotes SET
      status = 'expired',
      updated_at = now()
    WHERE id = v_quote.id;

    UPDATE public.inventory_holds SET
      is_active = false,
      updated_at = now()
    WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;

    v_holds_released := v_holds_released + v_hold_count;
    v_expired_count := v_expired_count + 1;
  END LOOP;

  IF v_expired_count > 0 THEN
    INSERT INTO public.activity_feed (event_type, description, performed_by)
    VALUES (
      'quotes_auto_expired',
      'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
      '00000000-0000-0000-0000-000000000000'::uuid
    );
  END IF;

  RETURN jsonb_build_object(
    'expired_count', v_expired_count,
    'holds_released', v_holds_released
  );
END;
$$;


-- ─── release_holds_on_quote_status_change ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_released_count integer := 0;
BEGIN
  IF NEW.status IN ('accepted', 'declined', 'expired')
     AND OLD.status NOT IN ('accepted', 'declined', 'expired') THEN

    UPDATE public.inventory_holds
    SET is_active = false, updated_at = now()
    WHERE source_id = NEW.id AND is_active = true;

    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    IF v_released_count > 0 THEN
      INSERT INTO public.activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'inventory_holds_released',
        'Released ' || v_released_count || ' inventory hold(s) for quote ' || NEW.quote_number || ' (' || NEW.status || ')',
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'),
        'quote', NEW.id, NEW.customer_id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- Verification: both functions now have public, pg_temp
DO $$
DECLARE
  v_auto_expire_path text;
  v_release_holds_path text;
BEGIN
  SELECT array_to_string(proconfig, ',') INTO v_auto_expire_path
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'auto_expire_quotes';
  SELECT array_to_string(proconfig, ',') INTO v_release_holds_path
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'release_holds_on_quote_status_change';

  IF v_auto_expire_path NOT LIKE '%public, pg_temp%' THEN
    RAISE EXCEPTION 'auto_expire_quotes search_path is %, expected to contain "public, pg_temp"', v_auto_expire_path;
  END IF;
  IF v_release_holds_path NOT LIKE '%public, pg_temp%' THEN
    RAISE EXCEPTION 'release_holds_on_quote_status_change search_path is %, expected to contain "public, pg_temp"', v_release_holds_path;
  END IF;
END $$;
