-- sql-safety: exempt-registry
--   Justification: this migration ADDS prepay_credits.quote_id; references to that
--   column below are not yet in .claude/schema-registry.json (file-only this session,
--   applied at G5). No other off-registry columns are referenced.
--
-- Roadmap #6(a) — Prepay-backed bookings: link + settlement read (FILE-ONLY)
-- ============================================================================
-- WHAT: (1) add a nullable FK earmarking a prepay credit to a booking (the quote);
--       (2) add a read-only get_booking_settlement(quote_id) RPC reporting
--           booked / drawn / remaining (qty + $ cents) and prepay
--           (earmarked / applied / remaining cents) for one booking.
--
-- WHY this shape (grounded in the 2026-06-13 prepay-subsystem map):
--   * The "booking" IS the quote (status sent/revised + the quote_product_draws
--     ledger). There is no separate bookings table. Many prepay credits can back
--     one booking, and a credit backs at most one booking, so the FK lives on the
--     MANY side: prepay_credits.quote_id.
--   * NULLABLE — legacy + non-booking (customer-level / overpayment) prepay has no
--     booking; this change is purely additive and touches no existing write path.
--   * ON DELETE SET NULL — NEVER cascade-delete money. If a booking quote is ever
--     hard-deleted, the prepay credit survives as generic customer prepay.
--   * Settlement is a READ ONLY foundation: until #6(b) wires earmarking + the
--     post_invoice auto-apply, prepay_* totals are 0 for every booking (correct).
--   * Money: quotes/quote_items are numeric DOLLARS; prepay is bigint CENTS.
--     Convert at the boundary (ROUND($*100)::bigint), exactly like the draw path.
--   * Reuses the LEDGER as truth: earmarked = SUM(original_amount_cents),
--     remaining = SUM(balance_cents) (trigger-maintained from prepay_applications),
--     applied = earmarked - remaining. No cache reads, no source_reference text
--     matching (that text-match is the void_payment guaranteed-miss bug class).
--
-- SAFETY: no financial_audit_log / CHECK-constraint change (read-only + a nullable
--   column). prepay_credits HAS updated_at but this migration does not write rows.
--   The two fin-prepay-balance identities are untouched (no money moves here).
--   FILE-ONLY: write + review + rolled-back smoke; do NOT apply this session.
-- ============================================================================

-- 1) Link column: earmark a prepay credit to a booking quote.
ALTER TABLE public.prepay_credits
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL;

-- Index the FK (codebase indexes every FK; idx_<table>_<col> convention).
CREATE INDEX IF NOT EXISTS idx_prepay_credits_quote
  ON public.prepay_credits USING btree (quote_id);

-- 2) Settlement read RPC (per booking). Read-only; self-gates (does not rely on
--    the EXECUTE grant being inert). Returns bigint cents; callers divide by 100.
CREATE OR REPLACE FUNCTION public.get_booking_settlement(p_quote_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_role text;
  v_active boolean;
  v_quote record;
  v_lines jsonb;
  v_booked_cents bigint;
  v_drawn_cents bigint;
  v_remaining_cents bigint;
  v_prepay_earmarked_cents bigint;
  v_prepay_remaining_cents bigint;
  v_prepay_applied_cents bigint;
BEGIN
  -- Auth: read RPCs in this codebase still self-gate.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  SELECT role, is_active INTO v_role, v_active FROM profiles WHERE id = v_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') OR v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  SELECT q.id, q.quote_number, q.customer_id, q.status, q.season, q.is_planned, q.deleted_at
    INTO v_quote
    FROM quotes q
    WHERE q.id = p_quote_id;

  IF NOT FOUND OR v_quote.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'found', false, 'quote_id', p_quote_id);
  END IF;

  -- Per-product booking position. total_units_needed is NULLABLE -> COALESCE 0.
  -- A product can appear on multiple quote_items (sections) -> aggregate by
  -- product_id with a booked-weighted-average locked price (same model the draw
  -- path uses, so settlement $ matches what draws actually charge).
  WITH booked AS (
    SELECT qi.product_id,
           SUM(COALESCE(qi.total_units_needed, 0)) AS booked_qty,
           CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
                THEN SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0))
                     / SUM(COALESCE(qi.total_units_needed, 0))
                ELSE 0 END AS wavg_price
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
      GROUP BY qi.product_id
  ),
  drawn AS (
    SELECT d.product_id, d.quantity_drawn
      FROM quote_product_draws d
      WHERE d.quote_id = p_quote_id
  ),
  line_rows AS (
    SELECT b.product_id,
           p.product_name,
           b.booked_qty,
           COALESCE(d.quantity_drawn, 0) AS drawn_qty,
           GREATEST(b.booked_qty - COALESCE(d.quantity_drawn, 0), 0) AS remaining_qty,
           b.wavg_price,
           ROUND(b.booked_qty * b.wavg_price * 100)::bigint AS booked_cents,
           ROUND(COALESCE(d.quantity_drawn, 0) * b.wavg_price * 100)::bigint AS drawn_cents,
           ROUND(GREATEST(b.booked_qty - COALESCE(d.quantity_drawn, 0), 0) * b.wavg_price * 100)::bigint AS remaining_cents
      FROM booked b
      LEFT JOIN drawn d ON d.product_id = b.product_id
      LEFT JOIN products p ON p.id = b.product_id
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'booked_qty', booked_qty,
      'drawn_qty', drawn_qty,
      'remaining_qty', remaining_qty,
      'locked_price', wavg_price,
      'booked_cents', booked_cents,
      'drawn_cents', drawn_cents,
      'remaining_cents', remaining_cents
    ) ORDER BY product_name), '[]'::jsonb),
    COALESCE(SUM(booked_cents), 0),
    COALESCE(SUM(drawn_cents), 0),
    COALESCE(SUM(remaining_cents), 0)
  INTO v_lines, v_booked_cents, v_drawn_cents, v_remaining_cents
  FROM line_rows;

  -- Prepay position for THIS booking. remaining = current available balance of
  -- credits earmarked to this booking. applied = prepay actually applied to this
  -- booking's draw invoices, derived from the prepay_applications ledger joined
  -- invoice→order→quote (Codex P2: NOT original−balance, which would misattribute
  -- a reassigned/pre-used credit's other-booking history to this quote). earmarked
  -- = applied + remaining (internally consistent; excludes other-booking usage).
  SELECT COALESCE(SUM(pc.balance_cents), 0)
    INTO v_prepay_remaining_cents
    FROM prepay_credits pc
    WHERE pc.quote_id = p_quote_id;
  SELECT COALESCE(SUM(pa.applied_amount_cents), 0)
    INTO v_prepay_applied_cents
    FROM prepay_applications pa
    JOIN invoices i ON i.id = pa.invoice_id
    JOIN orders o ON o.id = i.order_id
    WHERE o.quote_id = p_quote_id;
  v_prepay_earmarked_cents := v_prepay_applied_cents + v_prepay_remaining_cents;

  RETURN jsonb_build_object(
    'success', true,
    'found', true,
    'quote_id', v_quote.id,
    'quote_number', v_quote.quote_number,
    'customer_id', v_quote.customer_id,
    'status', v_quote.status,
    'season', v_quote.season,
    'is_planned', v_quote.is_planned,
    'lines', v_lines,
    'booked_cents', v_booked_cents,
    'drawn_cents', v_drawn_cents,
    'remaining_cents', v_remaining_cents,
    'prepay_earmarked_cents', v_prepay_earmarked_cents,
    'prepay_applied_cents', v_prepay_applied_cents,
    'prepay_remaining_cents', v_prepay_remaining_cents
  );
END;
$$;

-- caller-analysis: get_booking_settlement :: NEW read-only RPC; UI caller deferred to #6(c) (QuoteBuilder/quote-detail booking settlement panel, authenticated); no cron/Edge caller; self-gates on auth.uid()+admin/sales_rep; REVOKE PUBLIC/anon, GRANT authenticated/service_role (mirrors read RPCs; no anon EXECUTE).
REVOKE EXECUTE ON FUNCTION public.get_booking_settlement(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_booking_settlement(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_booking_settlement(uuid) TO authenticated, service_role;

-- Self-verification (raises if the migration didn't land as intended).
DO $$
DECLARE
  v_overloads int;
  v_col_exists boolean;
  v_idx_exists boolean;
BEGIN
  SELECT count(*) INTO v_overloads
    FROM pg_proc
    WHERE proname = 'get_booking_settlement'
      AND pronamespace = 'public'::regnamespace;
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'EXPECTED exactly 1 get_booking_settlement overload, found %', v_overloads;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'prepay_credits' AND column_name = 'quote_id'
  ) INTO v_col_exists;
  IF NOT v_col_exists THEN
    RAISE EXCEPTION 'EXPECTED prepay_credits.quote_id column to exist';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'prepay_credits' AND indexname = 'idx_prepay_credits_quote'
  ) INTO v_idx_exists;
  IF NOT v_idx_exists THEN
    RAISE EXCEPTION 'EXPECTED idx_prepay_credits_quote index to exist';
  END IF;
END $$;
