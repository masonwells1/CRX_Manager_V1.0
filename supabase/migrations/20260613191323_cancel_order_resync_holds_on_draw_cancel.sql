-- idempotency-body-check: exempt
-- caller-analysis: cancel_order :: REVOKE targets PUBLIC + anon ONLY (authenticated keeps EXECUTE, re-GRANTed below) — verbatim from the live 20260610185806 grant block, unchanged. Both UI callers run as authenticated and are unaffected: src/lib/offlineSync.ts:179 (offline replay, authenticated session) and src/pages/OrderDetail.tsx:484 (admin Cancel Order button, authenticated). No anon/cron caller exists.
-- ============================================================================
-- cancel_order: resync planned holds when cancelling a booking-draw order
-- (Codex 2026-06-13 finding 1 — CONFIRMED inventory under-reservation, MED/HIGH)
-- ----------------------------------------------------------------------------
-- DEPENDS ON: 20260613150000_planned_holds_drawn_sync.sql (its §1 creates the
-- internal helper public._sync_planned_holds(uuid, uuid)). This migration MUST
-- sort/apply AFTER that one — its stamp (…150100) is deliberately one tick later.
--
-- THE BUG (empirically verified via a rolled-back measurement on live):
--   draw_down_quote moves a quote's planned holds hold→prebooked (e.g. for a
--   100-unit booking it drops the hold 100→60 and raises inventory.prebooked
--   0→40, leaving Net Free = available − holds − prebooked unchanged at 900 for
--   an avail=1000 / external-booked=100 case).
--   cancel_order on that booking_draw order:
--     * releases the prebooked (40→0) — correct, and
--     * reduces quote_product_draws.quantity_drawn by the undelivered remainder
--       (the A3 reversal block above) — correct, BUT
--     * its F7 hold branch SKIPPED holds entirely for booking_draw orders
--       (IF NOT COALESCE(v_order.booking_draw,false)), so the originating
--       quote's hold stayed at the DECREMENTED 60.
--   Net effect: the 40 units that left the hold during the draw, and were just
--   returned to the booking balance + released from prebooked, are no longer
--   reserved anywhere — the stale 60-unit hold understates the reservation by
--   40. Net Free goes 900 → 940 (should stay 900). The booking balance now
--   claims 100 available to re-draw, but only 60 is held.
--   Measured (rolled back): AFTER_HOLD netfree=900, AFTER_DRAW40 netfree=900,
--   AFTER_CANCEL netfree=940 (must be 900).
--
-- THE FIX (this migration — the ONLY change vs the live body):
--   Replace the F7 hold branch so the booking_draw case REBUILDS the holds via
--   _sync_planned_holds(v_order.quote_id, v_actor) instead of preserving the
--   stale decremented hold. The helper locks the quote, then (because the
--   booking is still OPEN — cancel reopened it accepted→sent above when it was
--   the final draw, or it never left sent/revised) re-reserves
--   GREATEST(booked − drawn, 0) per product. After the draw is reversed,
--   drawn=0, so the hold is rebuilt to the full 100 → Net Free back to 900. The
--   non-draw branch is byte-identical to before (deactivate the booking's holds).
--
-- VERBATIM FIDELITY: the cancel_order body below is reproduced BYTE-FOR-BYTE
-- from the live prosrc (md5 890e34b5f3d3550102799bc77cc2fb20, captured
-- 2026-06-13) with EXACTLY ONE region changed — the F7 hold branch. §0 asserts
-- the live md5 before any CREATE (aborts on drift); §5 strips the new branch
-- back to the original and md5-compares the remainder to the captured live
-- baseline, proving nothing else changed. The actor variable is v_actor in the
-- live body (verified against the live prosrc) and is what the helper call uses.
--
-- SMOKE (rolled back, zero prod footprint): the inline DO scenario in the
-- handoff + scripts/smoke/smoke-draw-ledger-reversal.sql (S4 updated to assert
-- the REAL hold is rebuilt to booked−drawn after a draw cancel).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Precondition: live cancel_order must equal the authored baseline.
--    Capture the LF-normalized baseline for the §5 strip-and-compare.
-- ----------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  -- Helper dependency must already exist (20260613150000 applied first).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = '_sync_planned_holds' AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'DEPENDENCY: public._sync_planned_holds(uuid, uuid) is missing — apply 20260613150000_planned_holds_drawn_sync.sql first';
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
  FROM pg_proc WHERE proname = 'cancel_order' AND pronamespace = 'public'::regnamespace;

  IF v_md5 IS DISTINCT FROM '890e34b5f3d3550102799bc77cc2fb20' THEN
    RAISE EXCEPTION 'PRECONDITION: live cancel_order md5 % <> expected baseline 890e34b5f3d3550102799bc77cc2fb20 — another session re-emitted it; re-base before applying', v_md5;
  END IF;
END $pre$;

-- Captured (LF-normalized) for the §5 strip-and-compare self-verification.
CREATE TEMP TABLE _cor_baseline ON COMMIT DROP AS
SELECT md5(replace(prosrc, chr(13), '')) AS base_md5
FROM pg_proc
WHERE proname = 'cancel_order' AND pronamespace = 'public'::regnamespace;

-- ----------------------------------------------------------------------------
-- 1. cancel_order — VERBATIM from live (md5 890e34b5f3d3550102799bc77cc2fb20)
--    with ONLY the F7 hold branch replaced (booking_draw → rebuild via helper)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_order record;
  v_item record;
  v_undelivered numeric;
  v_holds_released integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_cancelled integer := 0;
  v_posted_notified integer := 0;
  v_deliveries_cancelled integer := 0;
  v_invoice record;
  v_admin record;
  v_result jsonb;
  -- A3<<<
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  -- >>>A3
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'already_cancelled');
  END IF;
  IF v_order.status = 'fulfilled' THEN
    RAISE EXCEPTION 'Cannot cancel a fulfilled order';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = 'Parent order ' || v_order.order_number || ' cancelled',
    updated_at = now()
  WHERE order_id = p_order_id
    AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

  IF v_deliveries_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT
      d.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || d.delivery_number || ' cancelled — order ' || v_order.order_number || ' was cancelled.',
      'delivery_update', 'delivery', d.id
    FROM deliveries d
    WHERE d.order_id = p_order_id
      AND d.status = 'cancelled'
      AND d.cancel_reason LIKE 'Parent order%'
      AND d.assigned_driver IS NOT NULL;
  END IF;

  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;
  -- A3<<< draw-ledger reversal (finding A3, 20260610190000 — see file header).
  -- cancel = only the UNDELIVERED remainder returns to the booking balance
  -- (mirrors the prebook release below); delivered units stay consumed so the
  -- customer cannot be over-entitled.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    -- Lock the parent quote first: same quote → inventory order as
    -- draw_down_quote, and serializes against a concurrent draw.
    SELECT * INTO v_draw_quote FROM quotes
    WHERE id = v_order.quote_id FOR UPDATE;

    FOR v_draw_item IN
      SELECT product_id,
             SUM(GREATEST(COALESCE(total_units_needed, 0) - COALESCE(quantity_delivered, 0), 0)) AS qty_undelivered
      FROM order_items
      WHERE order_id = p_order_id AND product_id IS NOT NULL
      GROUP BY product_id
      HAVING SUM(GREATEST(COALESCE(total_units_needed, 0) - COALESCE(quantity_delivered, 0), 0)) > 0
    LOOP
      UPDATE quote_product_draws
        SET quantity_drawn = GREATEST(quantity_drawn - v_draw_item.qty_undelivered, 0),
            updated_at = now()
      WHERE quote_id = v_order.quote_id
        AND product_id = v_draw_item.product_id;
    END LOOP;

    -- If this was the final draw, the quote sits at 'accepted'; with the
    -- balance restored it is no longer fully drawn, so reopen the booking.
    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_draw_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = v_order.quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        -- app.admin_override is already 'true' for this whole function body
        -- (SET LOCAL above) and is deliberately NOT reset here — the later
        -- unposted-invoice cancellation depends on it staying set.
        UPDATE quotes SET status = 'sent', updated_at = now()
        WHERE id = v_order.quote_id;

        INSERT INTO activity_feed (event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id)
        VALUES ('booking_reopened',
          'Booking ' || v_draw_quote.quote_number || ' reopened (accepted → sent): draw order ' ||
            v_order.order_number || ' was cancelled, returning its undelivered quantity to the booking balance',
          v_actor, 'quote', v_order.quote_id, v_draw_quote.customer_id);
      END IF;
    END IF;
  END IF;
  -- >>>A3

  FOR v_item IN
    SELECT product_id, total_units_needed, quantity_delivered
    FROM order_items WHERE order_id = p_order_id
  LOOP
    v_undelivered := GREATEST(v_item.total_units_needed - COALESCE(v_item.quantity_delivered, 0), 0);
    IF v_undelivered <= 0 THEN CONTINUE; END IF;

    UPDATE inventory SET
      quantity_prebooked = GREATEST(quantity_prebooked - v_undelivered, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'released', v_undelivered, 'Main Warehouse',
      p_order_id, v_actor,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- F7 fix / A3b: a non-draw cancel deactivates the booking's holds; a draw cancel
  -- keeps the booking OPEN but must REBUILD its holds to booked−drawn — the draw
  -- moved hold→prebooked, the prebooked was just released above, and the drawn
  -- ledger was just reduced, so a preserved (decremented) hold leaks the returned
  -- quantity out of the reservation (Net Free over-counts). Codex 2026-06-13 finding 1.
  IF v_order.quote_id IS NOT NULL THEN
    IF COALESCE(v_order.booking_draw, false) THEN
      PERFORM _sync_planned_holds(v_order.quote_id, v_actor);
    ELSE
      UPDATE inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_order.quote_id AND is_active = true;
      GET DIAGNOSTICS v_holds_released = ROW_COUNT;
    END IF;
  END IF;

  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  SELECT COUNT(*) INTO v_paid_commissions
  FROM commissions WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Cancelled Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was cancelled but has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
        'cancellation_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  FOR v_invoice IN
    SELECT * FROM invoices
    WHERE order_id = p_order_id
      AND deleted_at IS NULL
      AND status IN ('draft', 'unposted', 'posted')
  LOOP
    IF v_invoice.status IN ('draft', 'unposted') THEN
      UPDATE invoices SET
        status = 'cancelled',
        total_amount_cents = 0,
        paid_amount_cents = 0,
        prepay_applied_cents = 0,
        write_off_cents = 0,
        updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_cancelled', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', v_invoice.status, 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'cancelled', 'reason', 'Order ' || v_order.order_number || ' cancelled'),
        -1 * v_invoice.total_amount_cents,
        'Auto-cancelled ' || v_invoice.status || ' invoice ' || v_invoice.invoice_number || ' — order ' || v_order.order_number || ' cancelled'
      );

      v_draft_cancelled := v_draft_cancelled + 1;

    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (
          v_admin.id,
          'Order Cancelled — Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' cancelled. Invoice ' || v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'cancellation_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_cancelled', 'order', p_order_id, 'admin',
    jsonb_build_object('status', v_order.status, 'order_number', v_order.order_number),
    jsonb_build_object(
      'status', 'cancelled',
      'deliveries_cancelled', v_deliveries_cancelled,
      'holds_released', v_holds_released,
      'commissions_cancelled', v_commissions_cancelled,
      'draft_invoices_cancelled', v_draft_cancelled,
      'posted_invoices_flagged', v_posted_notified
    ),
    0,
    'Order ' || v_order.order_number || ' cancelled by admin'
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_cancelled',
    'Order ' || v_order.order_number || ' cancelled. ' ||
      v_deliveries_cancelled || ' delivery(s) cancelled, ' ||
      v_holds_released || ' hold(s) released, ' ||
      v_commissions_cancelled || ' commission(s) zeroed, ' ||
      v_draft_cancelled || ' draft/unposted invoice(s) cancelled.' ||
      CASE WHEN v_posted_notified > 0 THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.' ELSE '' END ||
      CASE WHEN v_paid_commissions > 0 THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.' ELSE '' END,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'status', 'cancelled',
    'order_number', v_order.order_number,
    'deliveries_cancelled', v_deliveries_cancelled,
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_cancelled', v_draft_cancelled,
    'posted_invoices_flagged', v_posted_notified
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. Self-verification
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count int;
  v_src text;
  v_src_lf text;
  v_stripped_md5 text;
  v_new_branch text;
  v_orig_branch text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'cancel_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'cancel_order overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'cancel_order' AND pronamespace = 'public'::regnamespace;
  v_src_lf := replace(v_src, chr(13), '');  -- LF-normalize for the byte-comparison

  -- The new draw branch must call the helper
  IF v_src_lf NOT LIKE '%PERFORM _sync_planned_holds(v_order.quote_id, v_actor);%' THEN
    RAISE EXCEPTION 'cancel_order is missing the _sync_planned_holds(v_order.quote_id, v_actor) rebuild call';
  END IF;

  -- search_path pinned (B-class)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'cancel_order' AND p.pronamespace = 'public'::regnamespace
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'cancel_order search_path is not pinned to public, pg_temp';
  END IF;

  -- STRIP-AND-COMPARE: replace the NEW branch with the ORIGINAL branch -> the
  -- remainder must md5-equal the captured live baseline (proves ONLY the branch
  -- changed). Literals are LF-only (live prosrc is pure LF).
  v_new_branch :=
    E'  -- F7 fix / A3b: a non-draw cancel deactivates the booking''s holds; a draw cancel\n'
 || E'  -- keeps the booking OPEN but must REBUILD its holds to booked−drawn — the draw\n'
 || E'  -- moved hold→prebooked, the prebooked was just released above, and the drawn\n'
 || E'  -- ledger was just reduced, so a preserved (decremented) hold leaks the returned\n'
 || E'  -- quantity out of the reservation (Net Free over-counts). Codex 2026-06-13 finding 1.\n'
 || E'  IF v_order.quote_id IS NOT NULL THEN\n'
 || E'    IF COALESCE(v_order.booking_draw, false) THEN\n'
 || E'      PERFORM _sync_planned_holds(v_order.quote_id, v_actor);\n'
 || E'    ELSE\n'
 || E'      UPDATE inventory_holds SET is_active = false, updated_at = now()\n'
 || E'      WHERE source_id = v_order.quote_id AND is_active = true;\n'
 || E'      GET DIAGNOSTICS v_holds_released = ROW_COUNT;\n'
 || E'    END IF;\n'
 || E'  END IF;';

  v_orig_branch :=
    E'  -- F7 fix: deactivate the originating quote''s holds without restoring quantity_available\n'
 || E'  IF v_order.quote_id IS NOT NULL THEN\n'
 || E'    -- A3<<< draw orders: the booking stays OPEN after cancelling one draw, so\n'
 || E'    -- the undrawn balance''s still-active holds must survive (see file header).\n'
 || E'    IF NOT COALESCE(v_order.booking_draw, false) THEN\n'
 || E'    -- >>>A3\n'
 || E'    UPDATE inventory_holds SET is_active = false, updated_at = now()\n'
 || E'    WHERE source_id = v_order.quote_id AND is_active = true;\n'
 || E'    GET DIAGNOSTICS v_holds_released = ROW_COUNT;\n'
 || E'    -- A3<<<\n'
 || E'    END IF;\n'
 || E'    -- >>>A3\n'
 || E'  END IF;';

  IF position(v_new_branch in v_src_lf) = 0 THEN
    RAISE EXCEPTION 'cancel_order: new hold branch literal not found in stored body (line-ending or text drift)';
  END IF;

  v_stripped_md5 := md5(replace(v_src_lf, v_new_branch, v_orig_branch));
  IF v_stripped_md5 <> (SELECT base_md5 FROM _cor_baseline) THEN
    RAISE EXCEPTION 'cancel_order body drifted beyond the single hold-branch swap (stripped md5 = %, baseline = %)',
      v_stripped_md5, (SELECT base_md5 FROM _cor_baseline);
  END IF;

  -- Grants: anon must NOT execute
  IF has_function_privilege('anon', 'public.cancel_order(uuid, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on cancel_order';
  END IF;
END $verify$;
