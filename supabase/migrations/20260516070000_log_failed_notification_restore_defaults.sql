-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex P2 fix (PR #59, 2026-05-16 review of d5f047f) — restore DEFAULT NULL
-- on log_failed_notification's optional parameters.
-- ============================================================================
-- Migration 20260516020000 (notification_rpcs_canonical_idempotency) wired
-- canonical idempotency but accidentally dropped DEFAULT NULL from three
-- parameters: p_entity_type, p_entity_id, p_payload. The previous 5-arg
-- function had those as optional.
--
-- Affected callers (live grep):
--   - src/pages/Dashboard.tsx:353 — catch block for check_remainder_reminders
--     calls with ONLY p_notification_type + p_error_message
--   - src/pages/Dashboard.tsx:365 — catch block for release_expired_quote_holds
--     calls with ONLY p_notification_type + p_error_message
--
-- PostgREST named-arg function resolution now silently fails to find a
-- matching overload, so the fallback notification-failure logs (which are
-- themselves already inside a catch block) are silently dropped — we lose
-- the audit trail for failed cron-like reminders.
--
-- Fix: restore DEFAULT NULL on p_entity_type, p_entity_id, p_payload.
-- Body unchanged from 20260516020000.
--
-- Applied to live via Supabase MCP before this commit. Live verification:
-- pg_get_function_arguments now returns all 5 optional params with
-- DEFAULT NULL, matching the pre-20260516020000 contract.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.log_failed_notification(
  p_notification_type text,
  p_entity_type       text   DEFAULT NULL,
  p_entity_id         uuid   DEFAULT NULL,
  p_error_message     text   DEFAULT NULL,
  p_payload           jsonb  DEFAULT NULL,
  p_idempotency_key   text   DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_id       uuid;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'log_failed_notification');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'id')::uuid;
    END IF;
  END IF;

  INSERT INTO failed_notifications (
    notification_type, entity_type, entity_id, error_message, payload
  ) VALUES (
    p_notification_type, p_entity_type, p_entity_id, p_error_message, p_payload
  )
  RETURNING id INTO v_id;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'log_failed_notification',
      jsonb_build_object('id', v_id)
    );
  END IF;

  RETURN v_id;
END;
$$;

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_sig text;
  v_defaults_count int;
BEGIN
  SELECT pg_get_function_arguments(oid) INTO v_sig
  FROM pg_proc
  WHERE proname = 'log_failed_notification' AND pronamespace = 'public'::regnamespace;

  -- Count DEFAULT clauses (should be 5: entity_type, entity_id, error_message,
  -- payload, idempotency_key). p_notification_type stays required.
  SELECT array_length(regexp_split_to_array(v_sig, 'DEFAULT'), 1) - 1
    INTO v_defaults_count;
  IF v_defaults_count <> 5 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 5 DEFAULT clauses, found % in signature: %',
      v_defaults_count, v_sig;
  END IF;

  RAISE NOTICE 'codex-fix: log_failed_notification restored to 5 optional + 1 required param.';
END
$$;
