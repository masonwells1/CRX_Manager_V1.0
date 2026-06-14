-- Roadmap #2 v3 — check_unpriced_orders cron — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- POST-APPLY rolled-back: at G5 apply 20260613170000 + 200000, THEN run this; it
-- creates a backdated needs_pricing order, exercises the cron fn, and RAISEs to
-- roll everything back (zero footprint, safe on prod). Runs as cron (no JWT →
-- auth.uid() NULL → admin-gate bypassed, the pg_cron path).
--   P1  needs_pricing order 3d old -> 48h reminder fires; admin notified; reminder stamped
--   P2  re-run                     -> deduped: no NEW notification for that order
--   P3  same order backdated 8d    -> 7d escalation fires; escalation notified; escalation stamped
--
-- NOTE (2026-06-13): build-loop Supabase MCP is READ-ONLY → not run live here;
-- verified by rls + drift reviewers (codex=PENDING per the pre-G5 batch policy).

DO $$
DECLARE
  v_cust uuid := (SELECT id FROM customers LIMIT 1);
  o1 uuid; r jsonb; out text := '';
  v_notif1 int; v_notif2 int; v_esc int;
BEGIN
  -- P1: needs_pricing order, 3 days old -> 48h reminder
  INSERT INTO orders (order_number, customer_id, status, pricing_status, created_at)
    VALUES ('SMOKE-UNPRICED', v_cust, 'confirmed', 'needs_pricing', now() - interval '3 days') RETURNING id INTO o1;
  r := check_unpriced_orders();
  SELECT count(*) INTO v_notif1 FROM notifications WHERE related_entity_id = o1 AND notification_type='needs_pricing';
  out := out || format('P1 reminder: rpc_reminders=%s notif=%s stamped=%s -> %s | ',
    r->>'reminders_sent', v_notif1, (SELECT pricing_reminder_sent_at IS NOT NULL FROM orders WHERE id=o1),
    CASE WHEN (r->>'reminders_sent')::int >= 1 AND v_notif1 >= 1
              AND (SELECT pricing_reminder_sent_at IS NOT NULL FROM orders WHERE id=o1)
         THEN 'PASS' ELSE 'FAIL' END);

  -- P2: re-run -> deduped (no NEW notification for o1)
  r := check_unpriced_orders();
  SELECT count(*) INTO v_notif2 FROM notifications WHERE related_entity_id = o1 AND notification_type='needs_pricing';
  out := out || format('P2 dedupe: notif before=%s after=%s -> %s | ', v_notif1, v_notif2,
    CASE WHEN v_notif2 = v_notif1 THEN 'PASS' ELSE 'FAIL' END);

  -- P3: backdate to 8 days -> 7d escalation
  UPDATE orders SET created_at = now() - interval '8 days' WHERE id=o1;
  r := check_unpriced_orders();
  SELECT count(*) INTO v_esc FROM notifications WHERE related_entity_id = o1 AND notification_type='needs_pricing_escalation';
  out := out || format('P3 escalation: rpc_escalations=%s esc_notif=%s stamped=%s -> %s',
    r->>'escalations_sent', v_esc, (SELECT pricing_escalation_sent_at IS NOT NULL FROM orders WHERE id=o1),
    CASE WHEN (r->>'escalations_sent')::int >= 1 AND v_esc >= 1
              AND (SELECT pricing_escalation_sent_at IS NOT NULL FROM orders WHERE id=o1)
         THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
