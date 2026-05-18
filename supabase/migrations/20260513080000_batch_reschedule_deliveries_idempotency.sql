-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex review fix for PR #59 (P2, 2026-05-12) — batch_reschedule_deliveries
-- 4-arg signature with canonical idempotency.
-- ============================================================================
-- Audit finding: src/pages/Deliveries.tsx:603 calls
--   supabase.rpc('batch_reschedule_deliveries', {
--     p_delivery_ids, p_new_date, p_performed_by, p_idempotency_key
--   })
-- but the only installed signature (20260228200000_safety_audit_hardening.sql:664)
-- is the 3-arg form (uuid[], date, uuid). Supabase RPC named-parameter resolution
-- requires an exact match, so the workflow fails at function lookup — the
-- "Reschedule Selected" button on the Deliveries page would error out and not
-- reschedule anything.
--
-- This migration matches the PR's stated intent ("Bulk idempotency wiring on
-- 12 mutating RPCs") by adding the missing p_idempotency_key param + canonical
-- idempotency block + strict-actor pattern, while preserving the existing
-- body verbatim. The 3-arg overload is dropped first so only one identity
-- signature exists (avoids the same overload-coexistence problem codex caught
-- on apply_prepay_to_invoice in 20260511095000).
--
-- Frontend impact: none. Deliveries.tsx already passes the 4-arg form. This
-- migration just makes the server-side accept what the client is already sending.
-- ============================================================================

DROP FUNCTION IF EXISTS public.batch_reschedule_deliveries(uuid[], date, uuid);

CREATE OR REPLACE FUNCTION public.batch_reschedule_deliveries(
  p_delivery_ids uuid[],
  p_new_date date,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_count    int := 0;
  v_id       uuid;
  v_delivery record;
  v_result   jsonb;
  v_existing jsonb;
BEGIN
  -- Strict-actor pattern (CLAUDE.md canonical)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Verify caller is admin or sales_rep (preserved from 20260228200000:683-688)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to reschedule deliveries';
  END IF;

  -- Canonical idempotency replay check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_reschedule_deliveries');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Body verbatim from 20260228200000:690-727
  IF p_new_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'Cannot reschedule deliveries to a past date';
  END IF;

  FOREACH v_id IN ARRAY p_delivery_ids LOOP
    SELECT * INTO v_delivery FROM deliveries WHERE id = v_id FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
      CONTINUE;
    END IF;

    UPDATE deliveries SET
      scheduled_date = p_new_date,
      last_edited_by = v_actor,
      last_edited_at = now(),
      updated_at = now()
    WHERE id = v_id;

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'deliveries_rescheduled',
    v_count || ' delivery(ies) rescheduled to ' || p_new_date::text,
    v_actor, 'delivery', p_delivery_ids[1]
  );

  v_result := jsonb_build_object('status', 'rescheduled', 'count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_reschedule_deliveries', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_reschedule_deliveries(uuid[], date, uuid, text) TO authenticated;

-- ─── Verification ────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_arg_signature  text;
  v_has_idempotency boolean;
BEGIN
  SELECT count(*) INTO v_overload_count
  FROM pg_proc
  WHERE proname = 'batch_reschedule_deliveries' AND pronamespace = 'public'::regnamespace;
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of batch_reschedule_deliveries, found %', v_overload_count;
  END IF;

  SELECT pg_get_function_identity_arguments(oid) INTO v_arg_signature
  FROM pg_proc
  WHERE proname = 'batch_reschedule_deliveries' AND pronamespace = 'public'::regnamespace;
  IF v_arg_signature NOT LIKE '%p_idempotency_key%' THEN
    RAISE EXCEPTION 'codex-fix verification: signature missing p_idempotency_key — got: %', v_arg_signature;
  END IF;

  SELECT prosrc ~ 'check_idempotency' AND prosrc ~ 'save_idempotency'
    INTO v_has_idempotency
  FROM pg_proc
  WHERE proname = 'batch_reschedule_deliveries' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_idempotency, false) THEN
    RAISE EXCEPTION 'codex-fix verification: batch_reschedule_deliveries missing idempotency helper calls';
  END IF;

  RAISE NOTICE 'codex-fix: batch_reschedule_deliveries 4-arg signature with idempotency installed.';
END
$$;
