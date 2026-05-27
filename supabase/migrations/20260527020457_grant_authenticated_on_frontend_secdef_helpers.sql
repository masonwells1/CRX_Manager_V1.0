-- B10 (2026-05-26 post-Codex-final-audit): re-grant authenticated EXECUTE
-- idempotency-body-check: exempt
--   notify_damaged_receiving uses the canonical check_idempotency /
--   save_idempotency helper pair (same as the rest of the codebase) instead
--   of inlining the literal `INSERT INTO idempotency_keys` block. The
--   schema-aware hook's regex only recognizes the literal pattern, so the
--   file-level marker tells it to stand down — matches the convention used
--   by 20260526151856_execute_full_codebase_ultra_review and prior helper
--   migrations.
--
-- Background: migration 20260526201319_revoke_anon_on_secdef_dml_helpers
-- revoked EXECUTE from `authenticated` on all 6 SECDEF DML helpers Codex
-- flagged in the post-apply audit. That was correct for the 3 pure
-- server-side helpers (check_idempotency, check_rate_limit, cleanup_rate_limits)
-- but BROKE the 3 functions the frontend legitimately calls:
--   * check_remainder_reminders — Dashboard.tsx:348
--   * log_failed_notification    — Dashboard.tsx:353/365, notificationTriggers.ts:37
--   * notify_damaged_receiving   — notificationTriggers.ts:278
--
-- This migration:
--   1. Re-grants `authenticated` EXECUTE on those 3 functions.
--   2. CREATE OR REPLACE the bodies of check_remainder_reminders and
--      notify_damaged_receiving with role checks that allow auth.uid()=NULL
--      (pg_cron / service_role context) to pass through, so the existing
--      pg_cron job `check-remainder-reminders` keeps working.
--   3. log_failed_notification body is unchanged — it's a pure logging helper
--      that any authenticated caller can use (no role gate inside the body
--      beyond the GRANT).
--   4. Verification block asserts the final per-function policy for all 6.
--
-- Why the `auth.uid() IS NOT NULL AND NOT <role>` pattern:
--   * anon: blocked by REVOKE EXECUTE at GRANT level (never reaches the body).
--   * authenticated user with wrong role: auth.uid() not NULL + role check fails -> blocked.
--   * authenticated user with right role: auth.uid() not NULL + role check passes -> allowed.
--   * pg_cron / service_role: auth.uid() IS NULL -> bypass role check, allowed.
--
-- See docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §12
-- for the post-final-audit reconciliation.

BEGIN;

-- ---------------------------------------------------------------------------
-- Re-grant EXECUTE on the 3 frontend-called functions.
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.check_remainder_reminders() TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_failed_notification(text, text, uuid, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_damaged_receiving(text, text, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- check_remainder_reminders: admin-only when called by an authenticated user.
-- pg_cron and service_role bypass via auth.uid() IS NULL.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_remainder_reminders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remainder record;
  v_admin record;
  v_sales_rep_id uuid;
  v_reminders_sent integer := 0;
  v_escalations_sent integer := 0;
BEGIN
  -- B10 (2026-05-26): admin-only when an authenticated user calls this.
  -- pg_cron (job `check-remainder-reminders`, runs as superuser) and
  -- service_role have auth.uid() = NULL and bypass this check.
  IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- M3 FIX: Use FOR UPDATE SKIP LOCKED to prevent duplicate notifications
  FOR v_remainder IN
    SELECT dr.*, p.product_name, d.delivery_number,
           o.customer_id AS order_customer_id
    FROM delivery_remainders dr
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    JOIN orders o ON o.id = dr.order_id
    WHERE dr.status = 'pending'
      AND dr.created_at < NOW() - INTERVAL '7 days'
      AND dr.reminder_sent_at IS NULL
    FOR UPDATE OF dr SKIP LOCKED
  LOOP
    SELECT c.assigned_sales_rep INTO v_sales_rep_id
    FROM customers c WHERE c.id = v_remainder.customer_id;

    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Delivery Remainder Pending 7+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 7+ days.',
        'remainder_reminder', 'delivery', v_remainder.original_delivery_id
      );
    END LOOP;

    IF v_sales_rep_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = v_sales_rep_id AND role = 'admin'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_sales_rep_id,
        'Delivery Remainder Pending 7+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 7+ days.',
        'remainder_reminder', 'delivery', v_remainder.original_delivery_id
      );
    END IF;

    UPDATE delivery_remainders SET reminder_sent_at = NOW() WHERE id = v_remainder.id;
    v_reminders_sent := v_reminders_sent + 1;
  END LOOP;

  -- 14-day escalation (also with FOR UPDATE SKIP LOCKED)
  FOR v_remainder IN
    SELECT dr.*, p.product_name, d.delivery_number
    FROM delivery_remainders dr
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    WHERE dr.status = 'pending'
      AND dr.created_at < NOW() - INTERVAL '14 days'
      AND dr.reminder_sent_at IS NOT NULL
      AND dr.escalation_sent_at IS NULL
    FOR UPDATE OF dr SKIP LOCKED
  LOOP
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'URGENT: Delivery Remainder Pending 14+ Days',
        v_remainder.product_name || ' (' || v_remainder.quantity_remaining || ' units) from delivery ' || v_remainder.delivery_number || ' has been pending for 14+ days. Please schedule follow-up or cancel.',
        'remainder_escalation', 'delivery', v_remainder.original_delivery_id
      );
    END LOOP;

    UPDATE delivery_remainders SET escalation_sent_at = NOW() WHERE id = v_remainder.id;
    v_escalations_sent := v_escalations_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('reminders_sent', v_reminders_sent, 'escalations_sent', v_escalations_sent);
END;
$$;

-- ---------------------------------------------------------------------------
-- notify_damaged_receiving: admin OR sales_rep when called by authenticated.
-- pg_cron and service_role bypass via auth.uid() IS NULL.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_damaged_receiving(p_po_number text, p_items_summary text, p_po_id uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin record;
  v_existing jsonb;
BEGIN
  -- B10 (2026-05-26): admin or sales_rep when an authenticated user calls
  -- this (receiving flow is admin/sales_rep work). service_role bypasses.
  IF auth.uid() IS NOT NULL AND NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

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
$$;

-- ---------------------------------------------------------------------------
-- Note: log_failed_notification body is unchanged.
-- It's a pure logging helper — any authenticated caller can use it after the
-- GRANT above. Anon stays blocked by the REVOKE in migration 20260526201319.
-- No role gate inside the body (logging should be open to all auth'd contexts).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Verification: assert the final per-function policy for all 6.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Frontend-called functions: authenticated must have EXECUTE.
  IF NOT has_function_privilege('authenticated', 'public.check_remainder_reminders()', 'EXECUTE') THEN
    RAISE EXCEPTION 'B10 verification failed: authenticated lost EXECUTE on check_remainder_reminders';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.log_failed_notification(text,text,uuid,text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B10 verification failed: authenticated lost EXECUTE on log_failed_notification';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.notify_damaged_receiving(text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B10 verification failed: authenticated lost EXECUTE on notify_damaged_receiving';
  END IF;

  -- Server-only helpers: authenticated must NOT have EXECUTE.
  IF has_function_privilege('authenticated', 'public.check_idempotency(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B10 verification failed: authenticated regained EXECUTE on check_idempotency';
  END IF;
  IF has_function_privilege('authenticated', 'public.check_rate_limit(uuid,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B10 verification failed: authenticated regained EXECUTE on check_rate_limit';
  END IF;
  IF has_function_privilege('authenticated', 'public.cleanup_rate_limits()', 'EXECUTE') THEN
    RAISE EXCEPTION 'B10 verification failed: authenticated regained EXECUTE on cleanup_rate_limits';
  END IF;

  -- All 6 must stay anon-blocked.
  IF has_function_privilege('anon', 'public.check_idempotency(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_rate_limit(uuid,text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_remainder_reminders()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cleanup_rate_limits()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.log_failed_notification(text,text,uuid,text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.notify_damaged_receiving(text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B10 verification failed: anon regained EXECUTE on at least one helper';
  END IF;

  -- Body-level guards must be present in the 2 modified functions.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'check_remainder_reminders'
      AND prosrc LIKE '%auth.uid() IS NOT NULL AND NOT is_admin()%'
  ) THEN
    RAISE EXCEPTION 'B10 verification failed: check_remainder_reminders body missing the auth.uid+is_admin guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'notify_damaged_receiving'
      AND prosrc LIKE '%auth.uid() IS NOT NULL AND NOT (is_admin() OR is_sales_rep())%'
  ) THEN
    RAISE EXCEPTION 'B10 verification failed: notify_damaged_receiving body missing the auth.uid+role guard';
  END IF;
END $$;

COMMIT;
