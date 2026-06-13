-- Roadmap #2 (sell-side) — ship-now / price-later — v3: check_unpriced_orders cron
-- ============================================================================
-- sql-safety: exempt-registry — orders.pricing_status is added by sibling
-- FILE-ONLY migration 20260613170000 (#2 v1a, same branch, not yet applied);
-- the live-derived schema registry can't know it until the G5 apply. The two
-- reminder columns are added by THIS migration (ALTER below) before the function
-- references them. No unknown-column risk — all exist in the branch's set.
--
-- FILE-ONLY (NOT applied — apply at G5 AFTER 20260613170000). A daily nudge so a
-- rush order that shipped unpriced doesn't sit forgotten (its invoice can't post
-- until priced). Modeled EXACTLY on the live check_remainder_reminders cron:
-- SECDEF + admin-gate-for-authenticated (pg_cron runs with auth.uid()=NULL and
-- bypasses), and a per-order dedupe via sent-at columns so it never re-spams.
--
--   • 48h reminder: needs_pricing orders older than 48h with pricing_reminder_sent_at
--     NULL → notify all admins + the customer's assigned sales rep; stamp reminder.
--   • 7d escalation: needs_pricing orders older than 7d already reminded, not yet
--     escalated → urgent notify admins; stamp escalation.
--   • FOR UPDATE SKIP LOCKED (no duplicate sends across concurrent runs).
--
-- Scheduled at 06:10 daily (between the live 06:00 mark-overdue and 06:15
-- release-holds jobs). ACL mirrors check_remainder_reminders (authenticated +
-- service_role; no anon). Reviewed: rls + drift (codex=PENDING → pre-G5 batch).
-- Rolled-back smoke (post-apply): docs/roadmap/smoke/02d-check-unpriced-orders.sql.

-- Dedupe columns (mirror delivery_remainders.reminder_sent_at/escalation_sent_at).
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pricing_reminder_sent_at   timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pricing_escalation_sent_at timestamptz;

CREATE OR REPLACE FUNCTION public.check_unpriced_orders()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order       record;
  v_admin       record;
  v_rep         uuid;
  v_reminders   integer := 0;
  v_escalations integer := 0;
BEGIN
  -- admin-only when an authenticated user calls this; pg_cron / service_role
  -- (auth.uid() = NULL) bypass. Same pattern as check_remainder_reminders.
  IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- 48h reminder
  FOR v_order IN
    SELECT o.id, o.order_number, c.farm_name, c.assigned_sales_rep
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.pricing_status = 'needs_pricing'
      AND o.created_at < NOW() - INTERVAL '48 hours'
      AND o.pricing_reminder_sent_at IS NULL
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (v_admin.id, 'Order needs pricing (48h+)',
        'Order ' || v_order.order_number || ' for ' || COALESCE(v_order.farm_name, 'customer') ||
        ' has been unpriced for 48h+ — set its prices so it can be invoiced.',
        'needs_pricing', 'order', v_order.id);
    END LOOP;

    v_rep := v_order.assigned_sales_rep;
    IF v_rep IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_rep AND role = 'admin') THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (v_rep, 'Order needs pricing (48h+)',
        'Order ' || v_order.order_number || ' for ' || COALESCE(v_order.farm_name, 'customer') ||
        ' has been unpriced for 48h+ — set its prices so it can be invoiced.',
        'needs_pricing', 'order', v_order.id);
    END IF;

    UPDATE orders SET pricing_reminder_sent_at = NOW() WHERE id = v_order.id;
    v_reminders := v_reminders + 1;
  END LOOP;

  -- 7-day escalation
  FOR v_order IN
    SELECT o.id, o.order_number, c.farm_name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.pricing_status = 'needs_pricing'
      AND o.created_at < NOW() - INTERVAL '7 days'
      AND o.pricing_reminder_sent_at IS NOT NULL
      AND o.pricing_escalation_sent_at IS NULL
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (v_admin.id, 'URGENT: Order unpriced 7+ days',
        'Order ' || v_order.order_number || ' for ' || COALESCE(v_order.farm_name, 'customer') ||
        ' has been unpriced for 7+ days. Price it now or cancel — its invoice cannot post until priced.',
        'needs_pricing_escalation', 'order', v_order.id);
    END LOOP;

    UPDATE orders SET pricing_escalation_sent_at = NOW() WHERE id = v_order.id;
    v_escalations := v_escalations + 1;
  END LOOP;

  RETURN jsonb_build_object('reminders_sent', v_reminders, 'escalations_sent', v_escalations);
END;
$function$;

-- Schedule the daily sweep (idempotent re-point by job name), 06:10 daily.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-unpriced-orders') THEN
    PERFORM cron.unschedule('check-unpriced-orders');
  END IF;
  PERFORM cron.schedule('check-unpriced-orders', '10 6 * * *', 'SELECT public.check_unpriced_orders()');
END
$cron$;

-- ACL mirrors check_remainder_reminders (authenticated + service_role; no anon/PUBLIC).
-- caller-analysis: check_unpriced_orders :: new cron fn; admin-gate for authenticated callers (auth.uid IS NOT NULL AND NOT is_admin → INSUFFICIENT_ROLE), pg_cron/service_role (auth.uid NULL) bypass; ACL mirrors the live check_remainder_reminders cron; no UI caller (cron-driven)
REVOKE EXECUTE ON FUNCTION public.check_unpriced_orders() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_unpriced_orders() FROM anon;
GRANT EXECUTE ON FUNCTION public.check_unpriced_orders() TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_unpriced_orders() TO service_role;
