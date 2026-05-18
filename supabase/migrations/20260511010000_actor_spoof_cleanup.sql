-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helper functions — same
-- pattern as 20260510080000_bulk_idempotency_wiring.sql. The schema hook
-- can't see helpers from this migration's text.)
-- ============================================================================
-- Post-audit follow-up — PR-10 actor-spoof cleanup
-- ============================================================================
-- Tracks: docs/audits/2026-05-09-execution-summary.md → "Sprint 2 open
--         follow-ups → PR-10 actor-spoof cleanup"
-- Same security class: codex audit F1/F2 (closed 2026-05-10 in commit 3c04f61)
--
-- WHY THIS MIGRATION EXISTS:
--   `reassign_delivery` and `batch_cancel_deliveries` (re-created by
--   PR-10's bulk_idempotency_wiring migration, applied 2026-05-10) inherited
--   the spoofable `v_actor := COALESCE(p_performed_by, auth.uid())` pattern
--   from pg_proc. With that pattern an authenticated caller can pass any
--   UUID as `p_performed_by` and the function executes with that user's
--   identity for downstream role checks — privilege escalation in a
--   SECURITY DEFINER RPC.
--
-- THE FIX (same as F1/F2 in commit 3c04f61):
--   v_actor := auth.uid();
--   IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
--   IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
--     RAISE EXCEPTION 'ACTOR_MISMATCH';
--   END IF;
--
-- All 3 frontend callsites (src/pages/Deliveries.tsx, src/pages/DeliveryDetail.tsx)
-- pass `p_performed_by: profile.id`, which always equals auth.uid() for the
-- authenticated user — the strict mismatch check passes cleanly. No
-- frontend changes needed.
--
-- Bodies otherwise verbatim from the live pg_proc state (queried 2026-05-10
-- after PR-10 applied) — only the actor block is changed.
--
-- After applying, verify:
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('reassign_delivery','batch_cancel_deliveries')
--     AND pronamespace='public'::regnamespace
--     AND prosrc ~ 'COALESCE\(p_performed_by';
--   Expected: 0 rows.
-- ============================================================================

-- ─── reassign_delivery ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reassign_delivery(p_delivery_id uuid, p_new_driver uuid, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_delivery record;
  v_old_driver uuid;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  -- Strict actor pattern (post-audit follow-up, mirrors codex F1/F2 in 3c04f61):
  -- derive v_actor from the JWT and reject mismatched p_performed_by values.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'driver'
    ) OR NOT EXISTS (
      SELECT 1 FROM deliveries WHERE id = p_delivery_id AND assigned_driver IS NULL
    ) THEN
      RAISE EXCEPTION 'Not authorized to reassign deliveries';
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reassign_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_new_driver AND is_active = true AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Target driver not found or inactive';
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot reassign a % delivery', v_delivery.status;
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  UPDATE deliveries SET
    assigned_driver = p_new_driver,
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  IF v_old_driver IS NOT NULL AND v_old_driver != p_new_driver THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_old_driver, 'Delivery Reassigned',
      'Delivery ' || v_delivery.delivery_number || ' has been reassigned.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
  VALUES (
    p_new_driver, 'New Delivery Assigned',
    'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
    'delivery_update', 'delivery', p_delivery_id
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_reassigned',
    'Delivery ' || v_delivery.delivery_number || ' reassigned',
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object('status', 'reassigned', 'delivery_id', p_delivery_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reassign_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── batch_cancel_deliveries ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION batch_cancel_deliveries(p_delivery_ids uuid[], p_cancel_reason text DEFAULT 'Batch cancelled', p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_del record;
  v_count integer := 0;
  v_actor uuid;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  -- Strict actor pattern (post-audit follow-up, mirrors codex F1/F2 in 3c04f61):
  -- derive v_actor from the JWT before rate-limit / role checks. p_performed_by
  -- must match auth.uid() if provided — no spoofing of an admin UUID.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  PERFORM check_rate_limit(v_actor, 'batch_cancel_deliveries', 3, 60);
  IF array_length(p_delivery_ids, 1) IS NULL THEN RAISE EXCEPTION 'No delivery IDs provided'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_cancel_deliveries');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'count')::integer; END IF;
  END IF;

  FOR v_del IN SELECT id, status FROM deliveries WHERE id = ANY(p_delivery_ids) ORDER BY id
  LOOP
    IF v_del.status NOT IN ('scheduled', 'in_progress', 'completed') THEN CONTINUE; END IF;
    v_result := cancel_delivery(p_delivery_id := v_del.id, p_cancel_reason := p_cancel_reason, p_performed_by := v_actor);
    IF (v_result->>'success')::boolean THEN v_count := v_count + 1; END IF;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_cancel_deliveries', jsonb_build_object('count', v_count));
  END IF;

  RETURN v_count;
END;
$$;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_spoofable_count integer;
  v_spoofable_names text;
BEGIN
  SELECT count(*), string_agg(proname, ', ' ORDER BY proname)
    INTO v_spoofable_count, v_spoofable_names
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('reassign_delivery', 'batch_cancel_deliveries')
    AND prosrc ~ 'COALESCE\(p_performed_by';

  IF v_spoofable_count > 0 THEN
    RAISE EXCEPTION 'actor-spoof cleanup verification: % function(s) still use COALESCE(p_performed_by, auth.uid()): %', v_spoofable_count, v_spoofable_names;
  END IF;

  RAISE NOTICE 'Actor-spoof cleanup verification passed: reassign_delivery + batch_cancel_deliveries now use strict actor pattern.';
END;
$$;
