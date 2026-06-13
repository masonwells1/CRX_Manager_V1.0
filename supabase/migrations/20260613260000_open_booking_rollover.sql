-- sql-safety: exempt-registry
--   Justification: references prepay_credits.quote_id (added by 20260613230000,
--   file-only this session, not yet in .claude/schema-registry.json). No other
--   off-registry columns referenced.
--
-- Roadmap #6(d) — Season-end / open-booking rollover report (FILE-ONLY)
-- ============================================================================
-- WHAT: a read-only SECDEF RPC get_open_booking_rollover([customer],[season])
--   listing every OPEN booking (quote status sent/revised, not deleted) with its
--   booked/drawn/remaining ($ cents) + prepay earmarked/applied/remaining — one
--   summary row per booking. Powers a season-end "what's still open + how much is
--   prepaid" report. Optional customer/season filters.
--
-- WHY: reuses the EXACT per-product weighted-average locked-price math from
--   get_booking_settlement (#6a) so a booking's rollover totals reconcile with its
--   settlement card and with what draws actually charge. Prepay totals come from
--   the prepay_credits.quote_id ledger (earmarked = SUM(original), remaining =
--   SUM(balance), applied = earmarked − remaining). No per-product lines here
--   (that detail lives in get_booking_settlement); this is the cross-booking roll-up.
--
-- SAFETY: read-only; self-gates (auth.uid()+admin/sales_rep+is_active); REVOKE
--   PUBLIC/anon, GRANT authenticated/service_role. Money: quotes/quote_items are
--   numeric DOLLARS → ROUND($*100)::bigint at the boundary; prepay already cents.
--   No writes, no CHECK/audit change. FILE-ONLY — do NOT apply this session.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_open_booking_rollover(
  p_customer_id uuid DEFAULT NULL,
  p_season int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_role text;
  v_active boolean;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  SELECT role, is_active INTO v_role, v_active FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') OR v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  WITH open_bookings AS (
    SELECT q.id, q.quote_number, q.customer_id, q.status, q.season
      FROM quotes q
      WHERE q.status IN ('sent', 'revised')
        AND q.deleted_at IS NULL
        AND (p_customer_id IS NULL OR q.customer_id = p_customer_id)
        AND (p_season IS NULL OR q.season = p_season)
  ),
  booked AS (
    SELECT qi.quote_id, qi.product_id,
           SUM(COALESCE(qi.total_units_needed, 0)) AS booked_qty,
           CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
                THEN SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0))
                     / SUM(COALESCE(qi.total_units_needed, 0))
                ELSE 0 END AS wavg_price
      FROM quote_items qi
      WHERE qi.quote_id IN (SELECT id FROM open_bookings)
      GROUP BY qi.quote_id, qi.product_id
  ),
  per_product AS (
    SELECT b.quote_id,
           ROUND(b.booked_qty * b.wavg_price * 100)::bigint AS booked_cents,
           ROUND(COALESCE(d.quantity_drawn, 0) * b.wavg_price * 100)::bigint AS drawn_cents,
           ROUND(GREATEST(b.booked_qty - COALESCE(d.quantity_drawn, 0), 0) * b.wavg_price * 100)::bigint AS remaining_cents
      FROM booked b
      LEFT JOIN quote_product_draws d ON d.quote_id = b.quote_id AND d.product_id = b.product_id
  ),
  booking_money AS (
    SELECT quote_id,
           COALESCE(SUM(booked_cents), 0) AS booked_cents,
           COALESCE(SUM(drawn_cents), 0) AS drawn_cents,
           COALESCE(SUM(remaining_cents), 0) AS remaining_cents
      FROM per_product
      GROUP BY quote_id
  ),
  booking_prepay AS (
    SELECT pc.quote_id,
           COALESCE(SUM(pc.balance_cents), 0) AS remaining_prepay_cents
      FROM prepay_credits pc
      WHERE pc.quote_id IN (SELECT id FROM open_bookings)
      GROUP BY pc.quote_id
  ),
  booking_applied AS (
    -- Codex P2: prepay APPLIED to this booking = the application ledger joined
    -- invoice→order→quote, NOT original−balance (which misattributes a reassigned
    -- credit's other-booking history). earmarked = applied + remaining.
    SELECT o.quote_id,
           COALESCE(SUM(pa.applied_amount_cents), 0) AS applied_cents
      FROM prepay_applications pa
      JOIN invoices i ON i.id = pa.invoice_id
      JOIN orders o ON o.id = i.order_id
      WHERE o.quote_id IN (SELECT id FROM open_bookings)
      GROUP BY o.quote_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'quote_id', ob.id,
    'quote_number', ob.quote_number,
    'customer_id', ob.customer_id,
    'customer_name', c.farm_name,
    'status', ob.status,
    'season', ob.season,
    'booked_cents', COALESCE(bm.booked_cents, 0),
    'drawn_cents', COALESCE(bm.drawn_cents, 0),
    'remaining_cents', COALESCE(bm.remaining_cents, 0),
    'prepay_earmarked_cents', COALESCE(ba.applied_cents, 0) + COALESCE(bp.remaining_prepay_cents, 0),
    'prepay_remaining_cents', COALESCE(bp.remaining_prepay_cents, 0),
    'prepay_applied_cents', COALESCE(ba.applied_cents, 0)
  ) ORDER BY c.farm_name, ob.quote_number), '[]'::jsonb)
  INTO v_result
  FROM open_bookings ob
  LEFT JOIN customers c ON c.id = ob.customer_id
  LEFT JOIN booking_money bm ON bm.quote_id = ob.id
  LEFT JOIN booking_prepay bp ON bp.quote_id = ob.id
  LEFT JOIN booking_applied ba ON ba.quote_id = ob.id;

  RETURN jsonb_build_object('success', true, 'bookings', v_result);
END;
$$;

-- caller-analysis: get_open_booking_rollover :: NEW read-only RPC; UI caller deferred to the #6(d) UI slice (Quotes/Reports rollover view, authenticated); no cron/Edge caller; self-gates auth.uid()+admin/sales_rep; REVOKE PUBLIC/anon, GRANT authenticated/service_role.
REVOKE EXECUTE ON FUNCTION public.get_open_booking_rollover(uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_open_booking_rollover(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_open_booking_rollover(uuid, int) TO authenticated, service_role;

DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
    WHERE proname = 'get_open_booking_rollover' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'EXPECTED exactly 1 get_open_booking_rollover overload, found %', v_n;
  END IF;
END $$;
