-- smoke-allocated-line-cents.sql
--
-- CONTAINER ONLY — run via scripts/smoke/prove-allocated-line-cents.mjs, never
-- through run-smoke.mjs against the live database. The chain INSERTs orders,
-- deliveries and invoices and depends on the disposable scaffolding in
-- fixtures/allocated-line-cents-base.sql, so against live it would both trip
-- the LIVE-DATA GUARD and die on missing helpers.
--
-- CRX-MONEY-LIFECYCLE-001. Once the tier-split draw-down splits a booking
-- across price tiers, an order line's total_price is a DELIBERATE allocation
-- that differs from ROUND(price_per_unit * quantity, 2). Delivery invoicing
-- and Cancel Remaining each re-derived the money by multiplying unit price by
-- quantity again, so every fractional segment rounded on its own and the sum
-- drifted away from what the customer booked.
--
-- Six scenarios. Each records a mismatch rather than aborting, so one run
-- reports every break instead of only the first.
--
--   S1  two 0.25 draws off one 0.50 booking, allocated 13c + 12c, both
--       delivered      -> must bill 25c, not 13+13
--   S2  one 0.50 line allocated 25c, delivered as two 0.25 deliveries
--                      -> the two invoices must telescope to exactly 25c
--   S3  one 0.50 line allocated 24c, deliver 0.25 then Cancel Remaining
--                      -> surviving line must be 12c (half the ALLOCATION),
--                         not 13c (half the re-extension), and must equal
--                         what was billed
--   S4  the backfill invoicing path over the same 24c line
--                      -> must bill 12c
--   S5  three 0.10 draws off a 0.30 line allocated 11c
--                      -> 4+3+4 telescopes to exactly 11c; three independent
--                         re-extensions give 12c
--   S6  deliver, VOID that invoice, deliver again
--                      -> a voided invoice must not consume allocation
--
-- Ends in SMOKE_PASS_ROLLBACK.

DO $chain$
DECLARE
  v_actor  uuid := '11111111-1111-4111-8111-111111111111';
  v_break  text[] := ARRAY[]::text[];
  v_o      uuid;
  v_o2     uuid;
  v_d      uuid;
  v_d2     uuid;
  i        int;
BEGIN
  -- ── S1 ───────────────────────────────────────────────────────────────────
  v_o  := mk_order(0.25, 0.50, 0.13, 's1a');
  v_o2 := mk_order(0.25, 0.50, 0.12, 's1b');
  PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o,  0.25, 's1a'), '[SMOKE]', v_actor);
  PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o2, 0.25, 's1b'), '[SMOKE]', v_actor);

  IF billed_cents(v_o) + billed_cents(v_o2) <> 25 THEN
    v_break := v_break || format(
      'S1 two draws delivered: billed %sc, order says %sc, booking was 25c',
      billed_cents(v_o) + billed_cents(v_o2), line_cents(v_o) + line_cents(v_o2));
  END IF;

  -- ── S2 ───────────────────────────────────────────────────────────────────
  v_o := mk_order(0.50, 0.50, 0.25, 's2');
  PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o, 0.25, 's2a'), '[SMOKE]', v_actor);
  PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o, 0.25, 's2b'), '[SMOKE]', v_actor);

  IF billed_cents(v_o) <> 25 OR line_cents(v_o) <> 25 THEN
    v_break := v_break || format(
      'S2 one line two deliveries: billed %sc, order says %sc, expected 25c both',
      billed_cents(v_o), line_cents(v_o));
  END IF;

  -- ── S3 ───────────────────────────────────────────────────────────────────
  v_o := mk_order(0.50, 0.50, 0.24, 's3');
  PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o, 0.25, 's3'), '[SMOKE]', v_actor);
  PERFORM _close_undelivered_order_remainder_20260718(v_o, v_actor);

  IF line_cents(v_o) <> 12 OR billed_cents(v_o) <> 12 THEN
    v_break := v_break || format(
      'S3 partial cancellation: order line %sc, billed %sc, expected 12c both',
      line_cents(v_o), billed_cents(v_o));
  END IF;
  IF line_cents(v_o) <> billed_cents(v_o) THEN
    v_break := v_break || format(
      'S3 partial cancellation: order (%sc) and invoice (%sc) disagree',
      line_cents(v_o), billed_cents(v_o));
  END IF;

  -- ── S4 ───────────────────────────────────────────────────────────────────
  v_o := mk_order(0.50, 0.50, 0.24, 's4');
  v_d := mk_delivery(v_o, 0.25, 's4');
  UPDATE deliveries SET status = 'completed', completed_at = now() WHERE id = v_d;
  UPDATE order_items SET quantity_delivered = 0.25, quantity_remaining = 0.25 WHERE order_id = v_o;
  PERFORM _create_invoice_for_unbilled_delivery_impl_20260718(v_d, v_actor);

  IF billed_cents(v_o) <> 12 THEN
    v_break := v_break || format(
      'S4 backfill invoice: billed %sc for half of a 24c line, expected 12c', billed_cents(v_o));
  END IF;

  -- ── S5 ───────────────────────────────────────────────────────────────────
  v_o := mk_order(0.30, 0.35, 0.11, 's5');
  FOR i IN 1..3 LOOP
    PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o, 0.10, 's5_' || i), '[SMOKE]', v_actor);
  END LOOP;

  IF billed_cents(v_o) <> 11 OR line_cents(v_o) <> 11 THEN
    v_break := v_break || format(
      'S5 three fractional draws: billed %sc, order says %sc, expected 11c both',
      billed_cents(v_o), line_cents(v_o));
  END IF;

  -- ── S6 ───────────────────────────────────────────────────────────────────
  v_o := mk_order(0.50, 0.50, 0.24, 's6');
  PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o, 0.25, 's6a'), '[SMOKE]', v_actor);
  UPDATE invoices SET status = 'voided'
   WHERE order_id = v_o AND status NOT IN ('voided', 'cancelled');
  PERFORM _complete_delivery_authorized_impl(mk_delivery(v_o, 0.25, 's6b'), '[SMOKE]', v_actor);

  IF billed_cents(v_o) <> 12 THEN
    v_break := v_break || format(
      'S6 void must not consume allocation: live billed %sc, expected 12c', billed_cents(v_o));
  END IF;
  IF (SELECT count(*) FROM invoices
       WHERE order_id = v_o AND deleted_at IS NULL
         AND status NOT IN ('voided', 'cancelled')) <> 1 THEN
    v_break := v_break || 'S6 void: expected exactly one live invoice to survive';
  END IF;

  -- ── verdict ──────────────────────────────────────────────────────────────
  IF array_length(v_break, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'ALLOCATION_DRIFT (% of 6 scenarios): %',
      array_length(v_break, 1), array_to_string(v_break, ' | ');
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$chain$;
