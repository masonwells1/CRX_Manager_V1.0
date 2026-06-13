-- idempotency-body-check: exempt
-- caller-analysis: void_order :: REVOKE targets PUBLIC + anon ONLY (authenticated keeps EXECUTE, re-GRANTed below) — verbatim from the live 20260610185806 grant block, unchanged. The sole UI caller runs as authenticated and is unaffected: src/pages/OrderDetail.tsx:565 (admin-only Void Order button, authenticated session). No anon/cron caller exists.
-- ============================================================================
-- void_order: resync planned holds when VOIDING a booking-draw order
-- (self-review finding VOID-1 — CONFIRMED inventory under-reservation, the
--  SYMMETRIC TWIN of the cancel_order fix in 20260613150100)
-- ----------------------------------------------------------------------------
-- DEPENDS ON: 20260613150000_planned_holds_drawn_sync.sql (its §1 creates the
-- internal helper public._sync_planned_holds(uuid, uuid)). This migration MUST
-- sort/apply AFTER both 20260613150000 and 20260613150100 — its stamp (…150200)
-- is deliberately the latest of the three.
--
-- THE BUG (empirically verified via a rolled-back measurement on live):
--   draw_down_quote moves a quote's planned holds hold→prebooked (e.g. for a
--   100-unit booking it drops the hold 100→60 and raises inventory.prebooked
--   0→40, leaving Net Free = available − holds − prebooked unchanged at 900 for
--   an avail=1000 / external-booked=100 case). complete_delivery then drains
--   the prebooked back to 0 before the order can reach 'fulfilled' (void
--   requires status='fulfilled'), so by void time there is NO stale-high
--   prebooked to offset an un-rebuilt hold.
--   void_order on that booking_draw order:
--     * reverses quote_product_draws.quantity_drawn to 0 (the A3 reversal
--       block) — correct,
--     * restores quantity_available for delivered units — correct, and
--     * reopens the booking accepted→sent when it was the final draw — correct,
--       BUT
--     * its A3 block NEVER touches inventory_holds and never rebuilds the hold,
--       so the originating quote's hold stayed at the DECREMENTED 60.
--   Net effect: the 40 units that left the hold during the draw, and whose
--   drawn ledger was just reversed (returning them to the booking balance), are
--   no longer reserved anywhere — the stale 60-unit hold understates the
--   reservation by 40. With prebooked already 0 and quantity_available restored,
--   Net Free goes 900 → 940 for a partial draw and 900 → 1000 for a full draw
--   (inventory becomes sellable twice).
--   Measured (rolled back): AFTER_HOLD netfree=900, AFTER_DRAW40+DELIVER
--   netfree=900, AFTER_VOID netfree=940 (must be 900); fully-drawn void
--   netfree=1000 (must be 900).
--
-- THE FIX (this migration — the ONLY change vs the live body):
--   Insert ONE statement in the A3 booking_draw block, after the inner
--   accepted-reopen END IF and before the booking_draw branch's closing END IF
--   (so it runs for EVERY booking_draw void, reopened or not):
--       PERFORM _sync_planned_holds(v_order.quote_id, v_actor);
--   The helper locks the quote, then — because the booking is OPEN (void
--   reopened it accepted→sent above when it was the final draw, or it never
--   left sent/revised) — rebuilds GREATEST(booked − drawn, 0) per product.
--   After the draw is reversed, drawn=0, so the hold is rebuilt to the full 100
--   → Net Free back to 900. (For an unplanned/closed quote the helper self-gates
--   to a hold release + no-op, so it is safe in every case.)
--
-- VERBATIM FIDELITY: the void_order body below is reproduced BYTE-FOR-BYTE from
-- the live prosrc (md5 9a4a73ef41c1eb6a646777fea551aec1, captured 2026-06-13;
-- prosrc is pure LF) with EXACTLY ONE statement inserted in the A3 block. §0
-- asserts the live md5 before any CREATE (aborts on drift); §5 strips the
-- inserted line back out and md5-compares the remainder to the captured live
-- baseline, proving nothing else changed. The actor variable is v_actor in the
-- live body (verified against the live prosrc) and is what the helper call uses.
--
-- SMOKE (rolled back, zero prod footprint): the inline DO scenario in the
-- handoff — a partial-draw delivered void (netfree 900→900) and a full-draw void
-- (booking reopens 'sent', netfree 900→900), both ending in SMOKE_PASS_ROLLBACK.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Precondition: live void_order must equal the authored baseline.
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
  FROM pg_proc WHERE proname = 'void_order' AND pronamespace = 'public'::regnamespace;

  IF v_md5 IS DISTINCT FROM '9a4a73ef41c1eb6a646777fea551aec1' THEN
    RAISE EXCEPTION 'PRECONDITION: live void_order md5 % <> expected baseline 9a4a73ef41c1eb6a646777fea551aec1 — another session re-emitted it; re-base before applying', v_md5;
  END IF;
END $pre$;

-- Captured (LF-normalized) for the §5 strip-and-compare self-verification.
CREATE TEMP TABLE _vor_baseline ON COMMIT DROP AS
SELECT md5(replace(prosrc, chr(13), '')) AS base_md5
FROM pg_proc
WHERE proname = 'void_order' AND pronamespace = 'public'::regnamespace;

-- ----------------------------------------------------------------------------
-- 1. void_order — VERBATIM from live (md5 9a4a73ef41c1eb6a646777fea551aec1)
--    with ONLY the A3 booking_draw block's hold-rebuild PERFORM inserted
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_order(p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT 'Voided by admin'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_order record;
  v_item record;
  v_invoice record;
  v_admin record;
  v_inventory_restored integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_existing jsonb;
  v_result jsonb;
  -- A3<<<
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  -- >>>A3
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status != 'fulfilled' THEN
    RAISE EXCEPTION 'INVALID_ORDER_STATUS: %', v_order.status;
  END IF;

  -- fulfilled→voided is a deliberate admin reversal the status-transition trigger does not
  -- include; bracket ONLY this write with the transaction-local admin override.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.orders
    SET status = 'voided',
        updated_at = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  -- A3<<< draw-ledger reversal (finding A3, 20260610190000 — see file header).
  -- void = the order is nulled and goods return to the warehouse, so the FULL
  -- drawn quantity goes back to the booking balance.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    -- Lock the parent quote first: same quote → inventory order as
    -- draw_down_quote, and serializes against a concurrent draw.
    SELECT * INTO v_draw_quote FROM public.quotes
    WHERE id = v_order.quote_id FOR UPDATE;

    FOR v_draw_item IN
      SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS qty_drawn
      FROM public.order_items
      WHERE order_id = p_order_id AND product_id IS NOT NULL
      GROUP BY product_id
      HAVING SUM(COALESCE(total_units_needed, 0)) > 0
    LOOP
      UPDATE public.quote_product_draws
        SET quantity_drawn = GREATEST(quantity_drawn - v_draw_item.qty_drawn, 0),
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
        FROM public.quote_items WHERE quote_id = v_order.quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN public.quote_product_draws d
        ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        -- accepted→sent is enforcer-legal on the live enforcer today; the
        -- override bracket is defense-in-depth (see file header).
        PERFORM set_config('app.admin_override', 'true', true);
        UPDATE public.quotes SET status = 'sent', updated_at = now()
        WHERE id = v_order.quote_id;
        PERFORM set_config('app.admin_override', 'false', true);

        INSERT INTO public.activity_feed (event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id)
        VALUES ('booking_reopened',
          'Booking ' || v_draw_quote.quote_number || ' reopened (accepted → sent): draw order ' ||
            v_order.order_number || ' was voided, returning its drawn quantity to the booking balance',
          v_actor, 'quote', v_order.quote_id, v_draw_quote.customer_id);
      END IF;
    END IF;
    -- VOID-1 fix (2026-06-13): the draw moved hold→prebooked; complete_delivery
    -- drained the prebooked to 0 before fulfilment, and the drawn ledger was just
    -- reversed above, so the still-OPEN booking's hold must be REBUILT to
    -- booked−drawn — a preserved (decremented) hold leaks the returned quantity
    -- out of the reservation (Net Free over-counts). Runs for every booking_draw
    -- void (reopened or not). The helper self-gates for non-planned/closed quotes.
    -- Symmetric twin of the cancel_order fix (20260613150100).
    PERFORM _sync_planned_holds(v_order.quote_id, v_actor);
  END IF;
  -- >>>A3

  FOR v_item IN
    SELECT product_id, quantity_delivered
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(quantity_delivered, 0) > 0
  LOOP
    UPDATE public.inventory
      SET quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
    WHERE product_id = v_item.product_id
      AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id,
      'adjusted',
      v_item.quantity_delivered,
      'Main Warehouse',
      p_order_id,
      v_actor,
      'Restored ' || v_item.quantity_delivered || ' units - order ' ||
        v_order.order_number || ' voided. Reason: ' || p_reason
    );

    v_inventory_restored := v_inventory_restored + 1;
  END LOOP;

  UPDATE public.commissions
    SET status = 'cancelled',
        commission_amount = 0
  WHERE order_id = p_order_id
    AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions
  WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id, title, message,
        notification_type,
        related_entity_type,
        related_entity_id
      ) VALUES (
        v_admin.id,
        'Voided Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was voided but has ' ||
          v_paid_commissions || ' paid commission(s). Manual review required.',
        'void_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id = p_order_id
      AND deleted_at IS NULL
      AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      -- never-posted draft has no financial impact: cancel (allowed transition), do not void.
      UPDATE public.invoices
        SET status = 'cancelled',
            void_reason = 'Order ' || v_order.order_number || ' voided. ' || p_reason,
            updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_cancelled', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'cancelled', 'void_reason', 'Order voided'),
        -1 * v_invoice.total_amount_cents,
        'Auto-cancelled draft invoice ' || v_invoice.invoice_number ||
          ' - order ' || v_order.order_number || ' voided'
      );

      v_draft_voided := v_draft_voided + 1;
    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (
          user_id, title, message,
          notification_type,
          related_entity_type,
          related_entity_id
        ) VALUES (
          v_admin.id,
          'Voided Order - Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' was voided. Invoice ' ||
            v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'void_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_voided', 'order', p_order_id, 'admin',
    jsonb_build_object('status', 'fulfilled', 'total_price', v_order.total_price),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -1 * ROUND(v_order.total_price * 100)::bigint,
    'Order ' || v_order.order_number || ' voided. Reason: ' || p_reason
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'order_voided',
    'Order ' || v_order.order_number || ' voided. ' ||
      v_inventory_restored || ' product(s) inventory restored. ' ||
      v_commissions_cancelled || ' commission(s) cancelled. ' ||
      v_draft_voided || ' draft invoice(s) cancelled.' ||
      CASE WHEN v_posted_notified > 0
           THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.'
           ELSE '' END ||
      CASE WHEN v_paid_commissions > 0
           THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.'
           ELSE '' END ||
      ' Reason: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'voided',
    'order_number', v_order.order_number,
    'inventory_products_restored', v_inventory_restored,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.void_order(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_order(uuid, uuid, text, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. Self-verification
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count int;
  v_src text;
  v_src_lf text;
  v_stripped_md5 text;
  v_insert text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'void_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'void_order overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'void_order' AND pronamespace = 'public'::regnamespace;
  v_src_lf := replace(v_src, chr(13), '');  -- LF-normalize for the byte-comparison

  -- The booking_draw block must now call the helper with the right actor.
  IF v_src_lf NOT LIKE '%PERFORM _sync_planned_holds(v_order.quote_id, v_actor);%' THEN
    RAISE EXCEPTION 'void_order is missing the _sync_planned_holds(v_order.quote_id, v_actor) rebuild call';
  END IF;

  -- search_path pinned (B-class)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'void_order' AND p.pronamespace = 'public'::regnamespace
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'void_order search_path is not pinned to public, pg_temp';
  END IF;

  -- STRIP-AND-COMPARE: remove the inserted comment+PERFORM (with its surrounding
  -- newlines/indent) -> the remainder must md5-equal the captured live baseline
  -- (proves ONLY the one statement was added). Literals are LF-only (live prosrc
  -- is pure LF). The inserted region sits between the inner accepted-reopen
  -- END IF and the booking_draw branch's closing END IF, so stripping it
  -- restores the exact original "    END IF;\n  END IF;" adjacency.
  v_insert :=
    E'\n    -- VOID-1 fix (2026-06-13): the draw moved hold→prebooked; complete_delivery\n'
 || E'    -- drained the prebooked to 0 before fulfilment, and the drawn ledger was just\n'
 || E'    -- reversed above, so the still-OPEN booking''s hold must be REBUILT to\n'
 || E'    -- booked−drawn — a preserved (decremented) hold leaks the returned quantity\n'
 || E'    -- out of the reservation (Net Free over-counts). Runs for every booking_draw\n'
 || E'    -- void (reopened or not). The helper self-gates for non-planned/closed quotes.\n'
 || E'    -- Symmetric twin of the cancel_order fix (20260613150100).\n'
 || E'    PERFORM _sync_planned_holds(v_order.quote_id, v_actor);';

  IF position(v_insert in v_src_lf) = 0 THEN
    RAISE EXCEPTION 'void_order: inserted comment+PERFORM literal not found in stored body (line-ending or text drift)';
  END IF;

  v_stripped_md5 := md5(replace(v_src_lf, v_insert, ''));
  IF v_stripped_md5 <> (SELECT base_md5 FROM _vor_baseline) THEN
    RAISE EXCEPTION 'void_order body drifted beyond the single inserted statement (stripped md5 = %, baseline = %)',
      v_stripped_md5, (SELECT base_md5 FROM _vor_baseline);
  END IF;

  -- Grants: anon must NOT execute
  IF has_function_privilege('anon', 'public.void_order(uuid, uuid, text, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on void_order';
  END IF;
END $verify$;
