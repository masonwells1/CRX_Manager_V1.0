-- idempotency-body-check: exempt
-- Both functions use the canonical check_idempotency / save_idempotency helper
-- pattern (not raw idempotency_keys reads/writes). Marker per CLAUDE.md guidance.
-- =============================================================================
-- 2026-05-16: Wire canonical idempotency into notification RPCs
--
-- Closes the 2026-05-16 ultra-review's P1 #4 finding. The frontend
-- (src/lib/notificationTriggers.ts) was passing `p_idempotency_key:
-- crypto.randomUUID()` to two SQL functions that didn't accept the argument:
--
--   log_failed_notification(p_notification_type, p_entity_type, p_entity_id,
--                           p_error_message, p_payload)         -- 5 args
--   notify_damaged_receiving(p_po_number, p_items_summary, p_po_id)  -- 3 args
--
-- PostgREST would fail function lookup with "function does not exist," meaning
-- damaged-receiving alerts were silently broken AND the fallback failure-queue
-- logging was silently broken (compounding the silence).
--
-- This migration adds `p_idempotency_key text DEFAULT NULL` to both signatures
-- and wires canonical check_idempotency / save_idempotency. Defaults preserve
-- backward compatibility for any other (rare/none) callers that didn't pass
-- the key. Return types are preserved verbatim — log_failed_notification still
-- returns uuid, notify_damaged_receiving still returns void.
--
-- For uuid-returning function: cache as jsonb_build_object('id', v_id) so the
-- canonical jsonb-shaped helper works, then extract on replay.
-- For void-returning function: cache empty jsonb '{}' and return early on
-- replay (no value to extract).
-- =============================================================================

BEGIN;

-- Drop existing signatures first — adding a defaulted parameter creates a NEW
-- overload rather than replacing. Without this, both signatures coexist and
-- PostgREST's function lookup becomes ambiguous when callers pass 5 vs 6 args.
DROP FUNCTION IF EXISTS public.log_failed_notification(text, text, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.notify_damaged_receiving(text, text, uuid);

-- ─── log_failed_notification ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_failed_notification(
  p_notification_type text,
  p_entity_type       text,
  p_entity_id         uuid,
  p_error_message     text,
  p_payload           jsonb,
  p_idempotency_key   text DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_existing jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'log_failed_notification');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'id')::uuid;
    END IF;
  END IF;

  INSERT INTO public.failed_notifications (
    notification_type, entity_type, entity_id, error_message, payload
  )
  VALUES (
    p_notification_type, p_entity_type, p_entity_id, p_error_message, p_payload
  )
  RETURNING id INTO v_id;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'log_failed_notification', jsonb_build_object('id', v_id));
  END IF;

  RETURN v_id;
END;
$function$;

-- ─── notify_damaged_receiving ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_damaged_receiving(
  p_po_number       text,
  p_items_summary   text,
  p_po_id           uuid,
  p_idempotency_key text DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin record;
  v_existing jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'notify_damaged_receiving');
    IF v_existing IS NOT NULL THEN
      RETURN;
    END IF;
  END IF;

  FOR v_admin IN
    SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
  LOOP
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_admin.id,
      'Damaged Items Received on ' || p_po_number,
      'Items received in non-good condition on ' || p_po_number || ': ' || p_items_summary,
      'po_damaged_received', 'purchase_order', p_po_id
    );
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'notify_damaged_receiving', '{}'::jsonb);
  END IF;
END;
$function$;

-- Verification: both functions exist with the new signature (single overload each)
DO $verify$
DECLARE
  v_log_args text;
  v_dmg_args text;
  v_log_body text;
  v_dmg_body text;
BEGIN
  SELECT pg_get_function_identity_arguments(oid), prosrc
    INTO v_log_args, v_log_body
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'log_failed_notification';

  IF v_log_args NOT LIKE '%p_idempotency_key text%' THEN
    RAISE EXCEPTION 'log_failed_notification: p_idempotency_key not in signature, got %', v_log_args;
  END IF;
  IF v_log_body NOT LIKE '%check_idempotency(p_idempotency_key, ''log_failed_notification'')%' THEN
    RAISE EXCEPTION 'log_failed_notification: check_idempotency not wired';
  END IF;

  SELECT pg_get_function_identity_arguments(oid), prosrc
    INTO v_dmg_args, v_dmg_body
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'notify_damaged_receiving';

  IF v_dmg_args NOT LIKE '%p_idempotency_key text%' THEN
    RAISE EXCEPTION 'notify_damaged_receiving: p_idempotency_key not in signature, got %', v_dmg_args;
  END IF;
  IF v_dmg_body NOT LIKE '%check_idempotency(p_idempotency_key, ''notify_damaged_receiving'')%' THEN
    RAISE EXCEPTION 'notify_damaged_receiving: check_idempotency not wired';
  END IF;
END
$verify$;

COMMIT;
