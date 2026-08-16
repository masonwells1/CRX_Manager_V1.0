-- =============================================================================
-- Draw-down: split the order into one line per booked price tier
-- =============================================================================
--
-- PLAIN ENGLISH
-- -------------
-- When a booking (quote) lists the same product more than once at different
-- prices -- say 1,000 units at $1.00 and 2,000 units at $1.01 -- drawing that
-- booking down used to collapse both onto ONE order line priced at the
-- weighted average, $1.00666...  That average is not a real price: it is not a
-- whole number of cents.
--
-- Two bad outcomes followed from that:
--
--   1. The draw FAILS today.  order_items_price_per_unit_cent_scale_chk and the
--      below-cost trigger both require a whole-cent unit price, so the insert is
--      rejected with INVALID_UNIT_PRICE_CENTS and the customer's order cannot be
--      created at all.
--   2. The "obvious" fix -- rounding that average to $1.01 -- is WORSE than the
--      failure, because the rounded unit price is then multiplied by the
--      quantity.  The error is not one cent; it is up to half a cent TIMES THE
--      QUANTITY.  On the example above, an exact $3,020.00 becomes $3,030.00.
--      That total feeds order revenue, profit, commissions and the audit log.
--      An earlier candidate migration took that approach; the adversarial
--      review gate blocked it and it was abandoned.  Do not reintroduce it.
--
-- This migration removes the average entirely.  Each booked price tier becomes
-- its own order line, carrying the quote's own price -- which is already
-- guaranteed to be a whole number of cents by
-- quote_items_price_per_unit_cent_scale_chk.  Nothing is rounded at the unit
-- level, so nothing can be scaled up by quantity.  Money is exact by
-- construction rather than exact by rounding.
--
-- WHAT ELSE THIS FIXES
-- --------------------
-- The old code also averaged the COST across tiers and rounded that average to
-- whole cents before multiplying by quantity -- the same defect, on the cost
-- side, already live.  Each tier now carries its own exact snapshot cost from
-- quote_items.cost_at_quote_cents (already stored as integer cents), so the
-- cost basis is exact too, and the order line's profit, the order header, the
-- commission basis and the cost_at_time_cents stamp all agree on one value.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- Inventory pre-booking, the inventory_transactions entry, hold consumption and
-- the quote_product_draws ledger stay PER PRODUCT and still move the full drawn
-- quantity exactly once.  They are deliberately left outside the new per-tier
-- loop.  The JSON returned to the app also keeps its existing per-product shape
-- ('product_id', 'product_name', 'drawn', 'remaining'), so no frontend change is
-- required.
--
-- HOW UNITS ARE ALLOCATED ACROSS TIERS
-- ------------------------------------
-- Tiers are consumed in the order they appear on the quote (quote_items
-- sort_order, then price and cost as a deterministic tiebreak) -- the order the
-- customer's own document lists them.  A tier counts as used up to the extent
-- that ORDER LINES WHICH STILL BILL THE CUSTOMER were written at that tier's
-- price and cost.  The split is a running cursor over what is left, never a
-- division, so the allocated quantities sum to the requested quantity EXACTLY.
-- A fail-closed assertion (DRAW_ALLOCATION_MISMATCH) refuses the whole draw if
-- they ever do not.
--
-- Acres are the one prorated figure.  The per-tier acres are rounded, and the
-- LAST line of each product absorbs the rounding residual, so the acres across
-- the split lines land on the figure the single-line version produced to within
-- the rounding of the earlier lines.  Where every earlier line rounded UP the
-- residual would go negative, and the last line is clamped to zero instead --
-- so with N tiers the parts can overshoot the whole by up to (N-1) x 0.005
-- acres.  Acres are an agronomic reference figure, not money; the money lines
-- sum EXACTLY (see the allocation assertion above).
--
-- BEHAVIOUR CHANGE WORTH KNOWING
-- ------------------------------
-- Below-cost detection gets sharper.  Previously an average price above cost
-- could hide one tier that was genuinely below cost; each tier is now checked on
-- its own.  A draw with a below-cost tier will therefore now correctly require
-- admin below-cost approval through the draw_down_quote wrapper.  That is the
-- intended behaviour, not a regression.
--
-- SAFETY
-- ------
-- Read-only preflight pins the live function body (md5
-- 87bf7adcdc63d94684676da5ab09bfde) and refuses to run if a second overload of
-- the same name exists, so this fails closed if anything else has redefined it
-- since this migration was written.  No business rows are read, written, moved
-- or deleted by this migration -- it replaces one function body.
-- CREATE OR REPLACE preserves the existing owner and the deliberate
-- postgres-only EXECUTE grant established by 20260812115237; the REVOKE below
-- re-states that posture defensively rather than relying on inheritance.
--
-- No explicit BEGIN/COMMIT: the applier wraps each migration in its own
-- transaction, and the surrounding migrations in this series do the same. An
-- explicit COMMIT here would end that outer transaction early and leave the
-- postflight running outside it.
-- =============================================================================

-- --- Preflight: refuse to run against an unexpected body ----------------------
DO $preflight$
DECLARE
  v_md5 text;
  v_overloads integer;
  v_legacy integer;
BEGIN
  -- Identify the target unambiguously. proname + pronargs alone would still be
  -- ambiguous if a same-name overload with four differently-typed arguments
  -- existed, so assert first that exactly one function carries this name.
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_IMPL_OVERLOADED: expected exactly 1 function named public._draw_down_quote_below_cost_impl_20260810, found % -- reconcile before applying', v_overloads;
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810'
    AND p.pronargs = 4;

  IF v_md5 IS NULL THEN
    RAISE EXCEPTION
      'DRAW_DOWN_IMPL_MISSING: public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text) not found; 20260812115237 must be applied first';
  END IF;

  IF v_md5 <> '87bf7adcdc63d94684676da5ab09bfde' THEN
    RAISE EXCEPTION
      'DRAW_DOWN_IMPL_DRIFTED: expected body md5 87bf7adcdc63d94684676da5ab09bfde, found %; another migration has redefined this function -- reconcile before applying', v_md5;
  END IF;

  -- Apply-time guard for pre-migration draws on a mixed-price booking (money
  -- review 2026-08-16, CRX-MONEY-001).
  --
  -- The old code collapsed every tier of a product into ONE quantity-weighted
  -- average price and billed the draw at that average. It left no record of
  -- WHICH tiers those units came from, and the average does not determine it:
  -- the same average is produced by many different tier consumptions. The new
  -- body has to reconstruct the remaining tiers from what was billed, and on a
  -- booking drawn under the old code that reconstruction is guesswork.
  --
  -- Two distinct ways it goes wrong, both silent:
  --
  --   1. The averaged price matches NO tier, so the line falls through to the
  --      legacy skip and is retired off the FRONT of the list. That conserves
  --      quantity but not money -- the average consumed the tiers
  --      proportionally, so retiring the cheapest units first leaves the dearer
  --      tiers to bill. 100 units at $1.00 plus 100 at $2.00 is a $300.00
  --      booking; a draw of 50 at the $1.50 average bills $75.00, then the
  --      remaining 150 skip 50 off the $1.00 tier and bill $250.00 -- $325.00
  --      in total, a $25.00 overbill.
  --
  --   2. The averaged price COINCIDENTALLY equals a real tier (Codex review
  --      2026-08-16). 100 units each at $1.00, $2.00 and $3.00 at one cost is a
  --      $600.00 booking; a draw of 250 at the exact $2.00 average matches the
  --      middle tier, so the LEFT JOIN below subtracts all 250 from a tier
  --      holding 100 and GREATEST(...,0) clamps the 150-unit excess away
  --      instead of carrying it forward. The remaining 50 ledger units then
  --      bill from the $1.00 tier and the booking closes at $550.00 -- a
  --      $50.00 underbill.
  --
  -- Case 2 is why this guard does NOT test whether the billed line matches a
  -- tier: that test passes precisely when the coincidence happens. Any
  -- pre-migration draw against a multi-tier product is untrustworthy, so the
  -- guard refuses on the draw existing at all. It looks at both the draw ledger
  -- and surviving booking-draw order lines, because a draw can be recorded in
  -- quote_product_draws while its order was later voided.
  --
  -- DRAW_ALLOCATION_MISMATCH does not catch either case: it proves the
  -- requested QUANTITY was allocated, never that the right monetary tiers were
  -- consumed.
  --
  -- Measured read-only against live on 2026-08-15 and again on 2026-08-16: no
  -- quote carries more than one price tier for the same product, so this is a
  -- no-op today. A measurement is not an apply-time guarantee, though -- the
  -- CURRENT live code still accepts a mixed-price booking whenever its weighted
  -- average lands on a whole cent ($1.00 and $2.00 average to exactly $1.50) --
  -- so an affected booking can be created and drawn between review and apply.
  -- This turns that race from a silent mispricing into a refusal to apply.
  --
  -- Deliberately NOT fixed by inferring the historical allocation. The average
  -- does not carry the information needed to invert it, so any inference would
  -- be a guess written into customer money. Failing closed and letting a human
  -- price the one stranded booking is the smaller risk. Scoped to bookings that
  -- are still drawable; one that can no longer be drawn cannot be mispriced by
  -- this path.
  --
  -- The tier key is the (price, cost) PAIR, matching the tiers CTE below. Two
  -- lines at the same price but different snapshot costs are different tiers.
  SELECT count(*) INTO v_legacy
  FROM (
    SELECT q.id AS quote_id, qi.product_id AS product_id
    FROM quotes q
    JOIN quote_items qi ON qi.quote_id = q.id
    WHERE q.deleted_at IS NULL
      AND q.status IN ('sent', 'revised')
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY q.id, qi.product_id
    HAVING count(DISTINCT (qi.price_per_unit, qi.cost_at_quote_cents)) > 1
  ) mixed
  WHERE EXISTS (
          SELECT 1
          FROM quote_product_draws d
          WHERE d.quote_id = mixed.quote_id
            AND d.product_id = mixed.product_id
            AND COALESCE(d.quantity_drawn, 0) > 0
        )
     OR EXISTS (
          SELECT 1
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.quote_id = mixed.quote_id
            AND o.booking_draw IS TRUE
            AND o.status <> 'voided'
            AND oi.product_id = mixed.product_id
        );

  IF v_legacy > 0 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_PREMIGRATION_MIXED_TIER_DRAW: % still-drawable booking/product pair(s) carry more than one price tier AND were already drawn under the weighted-average code. Which tiers those units consumed is not recoverable from the average, so splitting the lines now would misbill the remainder. Reprice or close those bookings, then re-apply.', v_legacy;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote record;
  v_customer record;
  v_draw jsonb;
  v_product_id uuid;
  v_product_name text;
  v_qty numeric;
  v_booked numeric;
  v_drawn numeric;
  v_remaining numeric;
  v_total_acres numeric;
  v_unit_size text;
  v_inv record;
  v_net_position numeric;
  v_order_id uuid;
  v_order_number text;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_line_total numeric;
  v_line_cost numeric;
  v_shortfalls text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_hold record;
  v_to_consume numeric;
  v_fully_drawn boolean;
  v_line_count integer := 0;
  v_result jsonb;
  v_existing jsonb;
  -- LAYER2<<< job reservations consumed against this quote (§6.5)
  v_job_drawn numeric;
  -- >>>LAYER2
  -- TIERSPLIT<<< one order line per booked price tier (replaces the weighted
  -- average that could not be expressed in whole cents)
  v_tier record;
  v_tier_units numeric;
  v_tier_cost_unit numeric;
  v_tier_acres numeric;
  v_skip numeric;
  v_take numeric;
  v_alloc_left numeric;
  v_draw_acres numeric;
  v_acres_assigned numeric;
  -- >>>TIERSPLIT
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Lock the quote: serializes concurrent draws on the same booking.
  --
  -- deleted_at IS NULL is REQUIRED here (adversarial review 2026-08-16,
  -- CRX-RLS-001). Quotes are soft-deleted by stamping deleted_at only --
  -- src/pages/Quotes.tsx leaves status untouched -- so a deleted booking still
  -- reads as 'sent' and would sail past the BOOKING_CLOSED guard below. Without
  -- this predicate a deleted booking stays drawable by anyone holding its id,
  -- minting order lines, commissions, inventory reservations and ledger rows
  -- against a booking the business considers gone. The pre-existing body
  -- (20260702172000) omitted it; this migration closes that hole.
  --
  -- Cross-representative access is DELIBERATE, not an oversight: any active
  -- admin or sales_rep may draw any booking (owner decision, re-confirmed
  -- 2026-08-16), so reps can cover for one another. Do not add a created_by or
  -- customer-assignment predicate here without a fresh owner decision.
  SELECT * INTO v_quote
  FROM quotes
  WHERE id = p_quote_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency check AFTER the lock (2026-06-10 HIGH fix): the row lock
  -- serializes same-key duplicates so the non-atomic check/save pair cannot
  -- both pass. Kept BEFORE the status guard so a retry of the final draw
  -- (which flips status to 'accepted') returns the cached result rather than
  -- BOOKING_CLOSED.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'draw_down_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_quote.status NOT IN ('sent', 'revised') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: quote % is % — only sent or revised quotes can be drawn down', v_quote.quote_number, v_quote.status;
  END IF;

  IF p_draws IS NULL OR jsonb_typeof(p_draws) <> 'array' OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_draws) d
    WHERE (d->>'product_id') IS NOT NULL AND COALESCE((d->>'quantity')::numeric, 0) > 0
  ) THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  v_order_number := generate_order_number();
  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split, 0, 0, 0, 0, current_date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs WHERE qs.quote_id = p_quote_id
       AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> ''))
  RETURNING id INTO v_order_id;
  -- A3<<< mark this order as a booking draw so void_order/cancel_order know
  -- to reverse the quote_product_draws ledger (20260610190000). Kept as a
  -- separate statement (not folded into the INSERT) so the body above stays
  -- byte-identical to the live baseline.
  UPDATE orders SET booking_draw = true WHERE id = v_order_id;
  -- >>>A3

  FOR v_draw IN SELECT * FROM jsonb_array_elements(p_draws) LOOP
    v_product_id := (v_draw->>'product_id')::uuid;
    v_qty := COALESCE((v_draw->>'quantity')::numeric, 0);
    IF v_product_id IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND (qi.cost_at_quote_cents IS NULL OR qi.cost_at_quote_cents <= 0)
    ) THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;

    -- TIERSPLIT / CRX-MONEY-002: refuse a draw whose booking carries a negative
    -- or non-finite quantity for this product.
    --
    -- v_booked below sums EVERY quote line for the product, negatives included,
    -- while the tier pool further down takes only lines with
    -- total_units_needed > 0. The averaging code this replaces read one
    -- weighted price over the same negative-inclusive set, so a negative line
    -- pulled the billed price DOWN. The split cannot do that, because a
    -- negative line has no tier to be billed at. A booking of 100 units at
    -- 2.00 and -50 units at 4.00 is worth nothing and still reports 50 units
    -- drawable: the old code billed those 50 at the 0.00 average, while the
    -- split would take all 50 from the 2.00 tier and invoice 100.00 against a
    -- booking worth 0.00. The conservation assertion cannot catch it -- the
    -- excluded negative line makes the tier pool LARGER than the balance, never
    -- smaller, and that assertion only fires when the pool is too small.
    --
    -- Nothing legitimate writes a negative: every quantity is either entered as
    -- a count or computed as acres x rate. Verified read-only against
    -- production on 2026-08-16 that no quote line holds a negative or
    -- non-finite quantity, and the CHECK added at the end of this migration
    -- makes that permanent. This body still refuses rather than trusting the
    -- constraint, because a constraint can be dropped and this path prices
    -- customer money.
    --
    -- NaN is caught by the finiteness half rather than the sign half:
    -- PostgreSQL orders NaN above every number, so NaN >= 0 is TRUE and only
    -- NaN < 'Infinity' rejects it. (Codex adversarial review 2026-08-16.)
    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND qi.total_units_needed IS NOT NULL
        AND NOT (qi.total_units_needed >= 0 AND qi.total_units_needed < 'Infinity'::numeric)
    ) THEN
      RAISE EXCEPTION
        'BOOKING_QUANTITY_INVALID: % is booked on this quote with a negative or non-finite quantity, so the booking has no honest value to draw against; correct the quote first',
        COALESCE((SELECT product_name FROM products WHERE id = v_product_id), v_product_id::text);
    END IF;

    -- Per-product booking balance (locked quote => stable within this txn).
    -- TIERSPLIT: the weighted-average price and cost that used to be computed
    -- here are gone. They were the whole defect: an average of whole-cent tier
    -- prices is generally NOT a whole-cent price, and neither rounding it nor
    -- carrying it forward is safe. Per-tier figures are read below instead.
    SELECT
      SUM(COALESCE(qi.total_units_needed, 0)),
      SUM(COALESCE(qi.acres, 0)),
      MIN(qi.unit_size)
    INTO v_booked, v_total_acres, v_unit_size
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id AND qi.product_id = v_product_id;

    SELECT product_name INTO v_product_name FROM products WHERE id = v_product_id;

    IF v_booked IS NULL OR v_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: % is not booked on this quote', COALESCE(v_product_name, v_product_id::text);
    END IF;

    -- TIERSPLIT: a booked line with no price has no tier to be drawn at. The
    -- old averaging code silently skipped such a line inside SUM() and spread
    -- its quantity across the other tiers' prices; the split would instead
    -- write an order line with a NULL unit price, whose total_price and profit
    -- both come out NULL and quietly poison the order header. Refuse the draw
    -- with a specific error naming the product so the quote can be corrected.
    -- A zero price is deliberately still allowed: free goods are a real thing
    -- and the below-cost approval gate is the control for that, not this check.
    --
    -- UNREACHABLE TODAY, kept deliberately (drift review 2026-08-16, L1 /
    -- RLS review N1): quote_items.price_per_unit is NOT NULL live, so this
    -- cannot fire against the current schema. Read the paragraph above as the
    -- reason this guard exists, not as a description of a live failure mode.
    -- It is a cheap fail-closed backstop if that NOT NULL is ever relaxed --
    -- unlike the cost half of the tier key, which IS nullable today and does
    -- get a live guard (COST_BASIS_REQUIRED, just below).
    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND qi.price_per_unit IS NULL
    ) THEN
      RAISE EXCEPTION
        'BOOKED_PRICE_REQUIRED: % has a booked line with no unit price; set a price on the quote before drawing it down',
        COALESCE(v_product_name, v_product_id::text);
    END IF;

    SELECT quantity_drawn INTO v_drawn
    FROM quote_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_drawn := COALESCE(v_drawn, 0);
    -- LAYER2<<< job reservations also consume the booking (§6.5): subtract live
    -- job draws so demand a job already reserved can't be re-drawn to an order
    -- (no double-fulfilment via transfer_job_to_invoice + a later order draw).
    SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_job_drawn
    FROM job_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_remaining := GREATEST(v_booked - v_drawn - v_job_drawn, 0);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: %: requested %, only % remaining (booked %, already drawn %)',
        COALESCE(v_product_name, v_product_id::text), v_qty, v_remaining, v_booked, (v_drawn + v_job_drawn);
    END IF;
    -- >>>LAYER2  (baseline: v_remaining := GREATEST(v_booked - v_drawn, 0); and
    -- the message's last arg was v_drawn — text is unchanged, only the value.)

    -- TIERSPLIT<<< emit one order line per booked price tier.
    -- The whole-draw acres figure is computed once, exactly as the single-line
    -- version computed it, and then handed out across the split lines with the
    -- residual going to the last line, so the parts sum back to this figure.
    v_draw_acres := CASE WHEN v_total_acres > 0
      THEN ROUND(v_total_acres * v_qty / v_booked, 2) ELSE NULL END;
    v_acres_assigned := 0;

    -- WHICH TIERS ARE ALREADY USED UP.
    --
    -- An earlier draft of this migration answered that by counting how many
    -- units had been drawn in total (quote_product_draws.quantity_drawn plus
    -- live job reservations) and walking that many units down the tier list.
    -- That is unsound, and the reason is worth stating plainly because it is
    -- the defect this block exists to avoid:
    --
    --   Those totals go DOWN as well as up. void_order/cancel_order subtract
    --   from quantity_drawn (20260610185806), and job_product_draws rows are
    --   deleted outright when a job is cancelled or re-reserved. A running
    --   total that moves backwards is not a position in an ordered list. Draw
    --   tier A, draw tier B, then void the FIRST order, and the total falls
    --   back to one tier's worth -- so the next draw is priced from tier B a
    --   second time. Tier A is never sold, tier B is sold twice, and 200 units
    --   quoted at 100 x $1.00 + 100 x $2.00 bill $400 instead of $300.
    --
    -- So attribution is derived instead from the order lines that ACTUALLY
    -- still bill the customer. Each surviving draw line already carries the
    -- tier key it was billed at (price_per_unit + cost_at_time_cents), so a
    -- tier is consumed exactly to the extent that live lines were billed at
    -- it.
    --
    -- KNOWN LIMIT of that key (drift review 2026-08-16, H2 and M1). The cost
    -- half of the key is not immutable. There are three distinct ways it moves,
    -- and the earlier version of this comment named only the first:
    --
    --   1. _enforce_below_cost_line fires BEFORE INSERT OR UPDATE OF
    --      product_id, price_per_unit, total_units_needed on order_items
    --      (20260812115237:561-564) and, when the declared operation is one of
    --      create_direct_order / bulk_import_order / update_order_items /
    --      price_order, overwrites cost_at_time_cents with TODAY's catalog cost
    --      (:484-490). That rewrite is gated on the declared OPERATION, not on
    --      which column changed, so an edit to ANY of those three watched
    --      columns triggers it -- and an edit to the price rewrites BOTH halves
    --      of the tier key at once, not just the cost half.
    --   2. trg_resnapshot_order_item_cost (20260812115235:97-104) fires BEFORE
    --      UPDATE ON order_items WHEN (NEW.product_id IS DISTINCT FROM
    --      OLD.product_id) and re-snapshots cost_at_time_cents to today's
    --      catalog cost. Unlike vector 1 it is NOT gated by the four-operation
    --      list -- but it IS narrower than the trigger definition alone
    --      suggests (drift review 2026-08-16, L2): its body
    --      (20260812115235:71-92) only rewrites the snapshot when the caller
    --      left it alone (NEW.cost_at_time_cents IS NOT DISTINCT FROM OLD) and
    --      NEW.product_id IS NOT NULL, and it COALESCEs back to the old
    --      snapshot when the new product's current_cost is NULL. So it cannot
    --      clobber a cost the caller set deliberately, and it never erases one.
    --      A product swap also moves the line out of the original product's
    --      attribution set entirely, since both queries below filter on
    --      oi.product_id = v_product_id.
    --   3. A direct UPDATE order_items SET cost_at_time_cents = ... fires no
    --      trigger at all. order_items carries five triggers in the migration
    --      tree and NONE of them watches cost_at_time_cents (drift review
    --      2026-08-16, L3 -- an earlier draft of this list named only three and
    --      read as exhaustive): the below-cost trigger watches product_id /
    --      price_per_unit / total_units_needed, guard_order_item_delivery_
    --      lineage watches order_id / product_id (20260721014858:734-737), the
    --      money-rounding trigger watches total_price / profit / cost_per_unit
    --      / total_units_needed (20260809230500:263-267), the resnapshot
    --      trigger in vector 2 watches product_id, and the INSERT-time snapshot
    --      trigger is INSERT-only. Repair migrations do exactly this.
    --
    -- After any of these the LEFT JOIN below no longer matches the line to its
    -- tier, and v_skip counts it as a legacy line consumed from the FRONT of
    -- the list.
    --
    -- Consequence, and why this ships anyway: the failure is fail-CLOSED. The
    -- tiers stop summing to the drawn quantity, so the conservation assert
    -- refuses the whole draw with DRAW_ALLOCATION_MISMATCH rather than
    -- mis-pricing or double-selling a tier. Nothing is billed wrong; a
    -- legitimate later draw is refused until an admin looks. The durable fix
    -- is to key on the immutable oi.quote_item_id (the column exists but this
    -- path leaves it NULL today) and is tracked as follow-up work, not
    -- attempted here -- populating it changes what every downstream consumer
    -- of order_items sees and deserves its own reviewed change.
    --
    -- Cancelled/voided are the two reversal states in orders_status_check
    -- ('confirmed','partially_fulfilled','fulfilled','cancelled','voided'),
    -- and they reverse DIFFERENT amounts, so they are treated differently:
    --
    --   void_order   subtracts the FULL quantity from quantity_drawn
    --                (20260610185806:493-505). A voided order therefore holds
    --                no booking balance at all, so its lines drop out entirely
    --                and the whole tier returns to the pool.
    --   cancel_order subtracts only the UNDELIVERED portion
    --                (20260610185806:807-820). Delivered units stay drawn and
    --                stay billed, so they must keep holding their tier -- only
    --                the undelivered remainder returns to the pool.
    --
    -- In practice a cancel of a partially delivered order does not land in
    -- 'cancelled' at all: cancel_order routes 'partially_fulfilled' orders to
    -- _close_undelivered_order_remainder_20260718 (20260721014858:1358), which
    -- shrinks total_units_needed to quantity_delivered (:1139) and ends at
    -- 'fulfilled' (:1151) -- so those orders stay in this set at exactly their
    -- surviving quantity via the ELSE branch. The 'cancelled' CASE below is
    -- therefore a no-op on current data (verified read-only against live
    -- 2026-08-16: zero cancelled, confirmed, or voided orders carry delivered
    -- units, and zero quote/product pairs bill more units than are drawn). It
    -- is written anyway because no CHECK constraint enforces that invariant,
    -- and if it ever slipped, excluding cancelled lines outright would free a
    -- tier that is still being billed and re-sell it.
    --
    -- Soft-deleted ORDERS (orders.deleted_at -- order_items has no such column)
    -- are deliberately NOT excluded: a soft delete does not reverse
    -- quantity_drawn, so dropping those lines here would desync attribution from
    -- the balance guard above.
    --
    -- Job reservations DO consume a tier, and are taken off the front with the
    -- legacy lines below. They hold booking balance (already subtracted from
    -- v_remaining above) but they write no order_items row, so nothing in the
    -- `billed` set can see them. Leaving them out would hand the tier they are
    -- holding back to the next order -- the same unit sold twice, once on the
    -- job and once on the order.
    --
    -- Which tier a job should consume is a business choice, not a technical
    -- one. Job chemicals are billed at their own price
    -- (job_chemicals.price_per_unit_cents, 20260713060000:312,547), so the job
    -- document's total does not change either way; what changes is which tiers
    -- are left for the customer's later orders. Front-of-list is chosen here
    -- because it is the same convention the legacy averaged code implicitly
    -- used, it conserves quantity, and it is the only option that cannot
    -- re-sell a tier. If Mason wants job draws to consume the LAST tier
    -- instead (leaving the cheaper tiers for orders), that is a one-line change
    -- to the ORDER BY this skip walks -- it is not a correctness fix.
    --
    -- No live data depends on this today: verified read-only 2026-08-16 that
    -- job_product_draws is empty and no quote has more than one price tier for
    -- the same product.
    --
    -- Legacy lines drawn under the old weighted-average code carry an averaged
    -- price that matches no tier key. They are counted here and taken off the
    -- FRONT of the tier list, which is the position the averaged code
    -- implicitly assumed. It conserves quantity and degrades to a no-op once
    -- there are none. (Verified read-only against live 2026-08-15: no quote
    -- has more than one price tier for the same product, so no such line
    -- exists today -- this is a defensive path, not a live migration concern.)
    SELECT COALESCE(SUM(
             CASE WHEN o.status = 'cancelled'
                  THEN COALESCE(oi.quantity_delivered, 0)
                  ELSE COALESCE(oi.total_units_needed, 0)
             END), 0)
    INTO v_skip
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.quote_id = p_quote_id
      AND o.booking_draw IS TRUE
      AND o.status <> 'voided'
      AND oi.product_id = v_product_id
      AND NOT EXISTS (
        SELECT 1
        FROM quote_items qi
        WHERE qi.quote_id = p_quote_id
          AND qi.product_id = v_product_id
          AND COALESCE(qi.total_units_needed, 0) > 0
          -- IS NOT DISTINCT FROM on BOTH halves, matching the LEFT JOIN below
          -- token for token. These two queries are mirror halves of one rule --
          -- a billed line must be counted by exactly one of them -- so any
          -- difference in how they compare the tier key double-counts the same
          -- units. (Drift review 2026-08-16, H1: the price half was `=` here
          -- while the join used IS NOT DISTINCT FROM.)
          --
          -- One asymmetry between the two is deliberate and worth naming
          -- (drift review 2026-08-16, L6): the tiers CTE additionally
          -- INNER JOINs quote_sections for its ordering columns, and this
          -- NOT EXISTS does not. That cannot drop a row, because
          -- quote_items.section_id is NOT NULL and REFERENCES
          -- quote_sections(id) ON DELETE CASCADE (20260206172436:176), so the
          -- join is total. The partition is exact -- but it leans on that
          -- foreign key, so if it is ever dropped this join must go too.
          AND qi.price_per_unit IS NOT DISTINCT FROM oi.price_per_unit
          AND qi.cost_at_quote_cents IS NOT DISTINCT FROM oi.cost_at_time_cents
      );

    -- Job reservations consume from the front alongside the legacy lines.
    v_skip := v_skip + COALESCE(v_job_drawn, 0);

    v_alloc_left := v_qty;

    FOR v_tier IN
      WITH tiers AS (
        SELECT
          qi.price_per_unit      AS price,
          qi.cost_at_quote_cents AS cost_cents,
          SUM(COALESCE(qi.total_units_needed, 0)) AS units,
          -- Disclosed behaviour change (RLS review 2026-08-16, M1): this is a
          -- PER-TIER MIN(unit_size), where the baseline wrote one product-level
          -- MIN(unit_size) onto the single line. The write site below takes
          -- COALESCE(v_tier.unit_size, v_unit_size), so it falls back to the
          -- old product-level value when a tier somehow has none. On a
          -- single-tier draw the two are identical; on a multi-tier draw each
          -- line now reports the pack size of the quote lines it was actually
          -- built from, which is the more accurate figure. order_items.unit_size
          -- is nullable and carries no CHECK, so nothing downstream constrains
          -- it -- it is a display/reference field, not money.
          MIN(qi.unit_size)      AS unit_size,
          -- Document order is (section position, then line position within the
          -- section). quote_items.sort_order restarts per section, so ordering
          -- on it alone ties two lines that sit in different sections and falls
          -- through to price -- which is not the order the customer sees.
          -- Both columns are NOT NULL live, so no COALESCE is needed.
          --
          -- The pair must come from ONE row, not from two independent minima
          -- (Codex review 2026-08-16, P1). The same (price, cost) tier can
          -- appear in more than one section: a tier sitting at (section 1,
          -- line 10) and (section 2, line 1) would report (1, 1) -- a document
          -- position no quote line occupies -- and would sort ahead of a tier
          -- that genuinely sits at (1, 5). The ORDER BY below consumes tiers in
          -- exactly this order, so an invented position bills the wrong price
          -- first on a partial draw. PostgreSQL has no min() over ROW(...), so
          -- take element 1 of an array_agg ordered by the SAME lexicographic
          -- key on both columns; that yields the tier's genuine first document
          -- position as an atomic pair.
          (array_agg(qs.sort_order ORDER BY qs.sort_order, qi.sort_order))[1] AS section_ord,
          (array_agg(qi.sort_order ORDER BY qs.sort_order, qi.sort_order))[1] AS ord
        FROM quote_items qi
        JOIN quote_sections qs ON qs.id = qi.section_id
        WHERE qi.quote_id = p_quote_id
          AND qi.product_id = v_product_id
          -- > 0, whereas v_booked above sums over ALL of the product's quote
          -- lines with no such filter (drift review 2026-08-16, L5). A
          -- zero-unit line is harmless either way. A NEGATIVE one -- which no
          -- CHECK currently forbids on quote_items.total_units_needed -- makes
          -- the two disagree, and it is worth being precise about WHICH guard
          -- covers that, because the first version of this comment named the
          -- wrong one (RLS review 2026-08-16, M2).
          --
          -- The negative line SUBTRACTS from v_booked and is excluded from the
          -- tiers, so the tier pool comes out LARGER than the balance, never
          -- smaller: sum(tiers) >= v_booked >= v_remaining >= v_qty. The
          -- allocation assertion below fires only when the pool is too SMALL to
          -- absorb the draw, so it cannot fire on this case at all. What
          -- actually holds the line is the v_remaining balance guard further
          -- up, which caps the draw at booked-minus-drawn using the reduced
          -- v_booked -- so the customer is never billed for more units than the
          -- (negative-inclusive) booking supports, and every unit billed still
          -- comes from a real positive tier at that tier's own price.
          AND COALESCE(qi.total_units_needed, 0) > 0
        GROUP BY qi.price_per_unit, qi.cost_at_quote_cents
      ),
      -- Units still billed to the customer, grouped by the tier key the line
      -- was written at. Voided orders drop out entirely; cancelled orders keep
      -- only their delivered units. Same rule as v_skip above -- see the long
      -- comment there for why the two reversal states differ.
      billed AS (
        SELECT
          oi.price_per_unit      AS price,
          oi.cost_at_time_cents  AS cost_cents,
          SUM(
            CASE WHEN o.status = 'cancelled'
                 THEN COALESCE(oi.quantity_delivered, 0)
                 ELSE COALESCE(oi.total_units_needed, 0)
            END) AS units
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.quote_id = p_quote_id
          AND o.booking_draw IS TRUE
          AND o.status <> 'voided'
          AND oi.product_id = v_product_id
        GROUP BY oi.price_per_unit, oi.cost_at_time_cents
      )
      SELECT
        t.price,
        t.cost_cents,
        t.unit_size,
        -- GREATEST(..., 0) clamps PER TIER (drift review 2026-08-16, L7). If a
        -- tier is somehow over-billed, its excess is not charged back against
        -- the other tiers, so the available pool reads slightly high rather
        -- than a negative tier silently eating a neighbour's units. Bounded on
        -- both sides regardless: the v_remaining balance guard caps the draw
        -- before the split, and DRAW_ALLOCATION_MISMATCH refuses it after.
        GREATEST(t.units - COALESCE(b.units, 0), 0) AS units
      FROM tiers t
      LEFT JOIN billed b
        -- Both halves use IS NOT DISTINCT FROM deliberately, and the mirror
        -- NOT EXISTS above uses it on both halves too. The PRICE columns are
        -- NOT NULL live, so on that half this is equivalent to = today. The
        -- COST columns (order_items.cost_at_time_cents,
        -- quote_items.cost_at_quote_cents) are NULLABLE per the schema registry
        -- generated 2026-08-13, so there the difference is live, not
        -- hypothetical. The hazard is ASYMMETRY between these two queries, not
        -- `=` as such (drift review 2026-08-16, L2 -- the earlier wording had
        -- this backwards). If this join used `=` while the NOT EXISTS above
        -- kept IS NOT DISTINCT FROM, a NULL-cost line would drop out of the
        -- join -- freeing a tier that is still being billed, i.e. re-selling it
        -- -- while ALSO being excluded from v_skip, so nothing else would
        -- account for it. If both queries used `=`, quantity would still
        -- conserve; the line would merely be mis-attributed to the front of the
        -- list. Match token for token on both halves and the set is partitioned
        -- exactly. (A booked quote line with a missing cost is separately
        -- refused up front with COST_BASIS_REQUIRED.)
        ON b.price IS NOT DISTINCT FROM t.price
       AND b.cost_cents IS NOT DISTINCT FROM t.cost_cents
      ORDER BY t.section_ord, t.ord, t.price, t.cost_cents
    LOOP
      EXIT WHEN v_alloc_left <= 0;

      v_tier_units := v_tier.units;

      -- Only legacy averaged units walk the list; everything else was already
      -- subtracted per tier by the LEFT JOIN above.
      IF v_skip > 0 THEN
        IF v_skip >= v_tier_units THEN
          v_skip := v_skip - v_tier_units;
          CONTINUE;
        END IF;
        v_tier_units := v_tier_units - v_skip;
        v_skip := 0;
      END IF;

      v_take := LEAST(v_tier_units, v_alloc_left);
      IF v_take <= 0 THEN CONTINUE; END IF;
      v_alloc_left := v_alloc_left - v_take;

      -- Exact whole-cent unit cost straight from the quote-time snapshot; no
      -- average, so nothing to round at the unit level. The division of integer
      -- cents by 100 is already exact -- ROUND here only pins the numeric SCALE
      -- to two places so the stored value looks like every other order path's,
      -- rather than carrying a long trailing-zero tail. It changes no value.
      -- Verified live 2026-08-15: _enforce_below_cost_line overwrites
      -- cost_per_unit/cost_at_time_cents only when the declared operation is one
      -- of create_direct_order, bulk_import_order, update_order_items or
      -- price_order. This path declares draw_down_quote, so the per-tier
      -- snapshot cost written here survives the trigger.
      v_tier_cost_unit := ROUND(v_tier.cost_cents::numeric / 100, 2);

      -- Money is rounded only AFTER extension by quantity, never before.
      v_line_total := ROUND(v_tier.price * v_take, 2);
      v_line_cost  := ROUND(v_tier_cost_unit * v_take, 2);

      IF v_alloc_left = 0 THEN
        -- Last line for this product absorbs the acres rounding residual.
        -- GREATEST(...,0): each earlier line was rounded UP to two places at
        -- worst, so with enough tiers the parts can overshoot the whole-draw
        -- figure by a few hundredths. When that happens the residual is
        -- negative and the clamp writes 0 on this line, which means the SPLIT
        -- LINES TOTAL slightly MORE than the single-line figure -- see the
        -- bound stated in the header. Acres are an agronomic reference figure,
        -- not money; that overshoot is acceptable, a NEGATIVE acreage on a
        -- customer's order line is not.
        v_tier_acres := CASE WHEN v_draw_acres IS NULL THEN NULL
                             ELSE GREATEST(v_draw_acres - v_acres_assigned, 0) END;
      ELSE
        v_tier_acres := CASE WHEN v_draw_acres IS NULL THEN NULL
                             ELSE ROUND(v_draw_acres * v_take / v_qty, 2) END;
      END IF;
      v_acres_assigned := v_acres_assigned + COALESCE(v_tier_acres, 0);

      -- Disclosed behaviour change (drift review 2026-08-16, NIT2): this is a
      -- single counter across the WHOLE draw, so the sort_order written below
      -- runs 1..M over every line of every product, where the single-line
      -- version wrote 1..N with one line per product. On a one-tier draw the
      -- numbering is unchanged; on a multi-tier draw the customer's order shows
      -- more lines and therefore higher line numbers. Deliberate -- lines are
      -- emitted product by product and tier by tier in document order, so a
      -- single ascending counter preserves that order exactly, whereas a
      -- per-product counter would repeat numbers across products.
      v_line_count := v_line_count + 1;

      INSERT INTO order_items (order_id, product_id, product_name,
        price_per_unit, cost_per_unit, acres,
        total_units_needed, unit_size, total_price, profit, net_margin,
        quantity_delivered, quantity_remaining, sort_order, notes,
        cost_at_time_cents -- SNAPSHOT
        )
      VALUES (v_order_id, v_product_id, COALESCE(v_product_name, ''),
        v_tier.price, v_tier_cost_unit, v_tier_acres,
        v_take, COALESCE(v_tier.unit_size, v_unit_size), v_line_total,
        v_line_total - v_line_cost,
        CASE WHEN v_tier.price > 0
          THEN ROUND(((v_tier.price - v_tier_cost_unit) / v_tier.price) * 100, 2)
          ELSE 0 END,
        0, v_take, v_line_count,
        'Drawn from booking ' || v_quote.quote_number,
        -- SNAPSHOT: a partial draw is a conversion too. This tier's own
        -- quote-time cost, already integer cents, is stamped here so the line
        -- profit, the order header, the commission basis and the reports all
        -- share ONE value. Without the stamp the row inserts with a NULL
        -- cost_at_time_cents and trg_snapshot_order_item_cost writes TODAY's
        -- catalog cost, splitting the reports from the order totals. Unknown
        -- historical cost is rejected above; it must never be converted into a
        -- real zero-cost order line.
        v_tier.cost_cents);

      v_total_price := v_total_price + v_line_total;
      v_total_cost := v_total_cost + v_line_cost;
    END LOOP;

    -- Fail closed: the split must conserve quantity exactly. If the booked tiers
    -- could not absorb the requested quantity, refuse the entire draw rather
    -- than book an order that under-bills the customer.
    IF v_alloc_left <> 0 THEN
      RAISE EXCEPTION
        'DRAW_ALLOCATION_MISMATCH: % of % units for % could not be matched to a booked price tier. This usually means an existing order for this product was edited after it was drawn, which rewrites the cost snapshot the tier is recognised by. Check recent edits to orders for this quote before re-trying.',
        v_alloc_left, v_qty, COALESCE(v_product_name, v_product_id::text);
    END IF;
    -- >>>TIERSPLIT

    -- Inventory: warn (never block) on net position, then prebook the draw.
    -- Deliberately PER PRODUCT and outside the tier loop: the full drawn
    -- quantity moves exactly once no matter how many price tiers it spans.
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty || ', net position is 0 (no inventory record)');
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_product_id, 'Main Warehouse', 0, v_qty, 0, v_unit_size);
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_shortfalls := array_append(v_shortfalls,
          COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
      UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_qty, updated_at = now()
      WHERE product_id = v_product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes)
    VALUES (v_product_id, 'booked', v_qty, 'Main Warehouse',
      v_order_id, v_actor, 'Pre-booked for order ' || v_order_number || ' (draw from quote ' || v_quote.quote_number || ')');

    -- Move the drawn quantity out of this quote's active holds (FIFO).
    -- Net Free = available − holds − prebooked stays constant: the quantity
    -- leaves the hold bucket and enters the prebooked bucket.
    v_to_consume := v_qty;
    FOR v_hold IN
      SELECT id, quantity FROM inventory_holds
      WHERE source_id = p_quote_id AND product_id = v_product_id AND is_active = true
      ORDER BY created_at
      FOR UPDATE
    LOOP
      EXIT WHEN v_to_consume <= 0;
      IF v_hold.quantity <= v_to_consume THEN
        UPDATE inventory_holds SET quantity = 0, is_active = false, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := v_to_consume - v_hold.quantity;
      ELSE
        UPDATE inventory_holds SET quantity = quantity - v_to_consume, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := 0;
      END IF;
    END LOOP;

    -- Ledger: record the draw
    INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
    VALUES (p_quote_id, v_product_id, v_qty)
    ON CONFLICT (quote_id, product_id)
    DO UPDATE SET quantity_drawn = quote_product_draws.quantity_drawn + EXCLUDED.quantity_drawn,
                  updated_at = now();

    -- Per-product summary for the caller. Shape unchanged on purpose: the app
    -- reads this and must not have to learn about the tier split.
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product_id,
      'product_name', v_product_name,
      'drawn', v_qty,
      'remaining', v_remaining - v_qty);
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE WHEN v_total_price > 0 THEN ROUND((v_total_profit / v_total_price) * 100, 2) ELSE 0 END;
  UPDATE orders SET total_price = v_total_price, total_cost = v_total_cost,
    total_profit = v_total_profit, total_margin_pct = v_total_margin_pct
  WHERE id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_total_profit,
    v_quote.commission_split, current_date
  );

  -- Fully drawn? Then the booking closes as 'accepted' (enforcer-legal from
  -- sent/revised) and the hold-release trigger clears any leftover holds.
  -- LAYER2 NOTE: this stays on ORDER draws only (quote_product_draws) by design
  -- — job draws are reversible, so letting them flip status to 'accepted' would
  -- require un-accepting on job cancel (a quote-lifecycle change out of scope).
  SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
  FROM (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b
  LEFT JOIN quote_product_draws d
    ON d.quote_id = p_quote_id AND d.product_id = b.product_id
  WHERE b.booked > 0;

  IF v_fully_drawn THEN
    UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  ELSE
    UPDATE quotes SET updated_at = now() WHERE id = p_quote_id;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'quote_converted', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'order_number', v_order_number,
      'customer_id', v_quote.customer_id,
      'customer_name', COALESCE(v_customer.farm_name, 'unknown'),
      'total_price_dollars', v_total_price,
      'booking_draw', true,
      'fully_drawn', v_fully_drawn,
      'lines', v_lines,
      'inventory_warnings', to_jsonb(v_shortfalls)
    ),
    ROUND(v_total_price * 100)::bigint,
    'Drew down quote ' || v_quote.quote_number || ' to order ' || v_order_number ||
      ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN v_fully_drawn THEN ' (booking now fully drawn)' ELSE ' (partial draw — booking stays open)' END ||
      CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: ' || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created',
    'Order ' || v_order_number || ' created from booking ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN v_fully_drawn THEN ' — booking fully drawn' ELSE ' — partial draw' END,
    v_actor, 'order', v_order_id, v_quote.customer_id);

  v_result := jsonb_build_object(
    'success', true, 'status', 'created',
    'order_id', v_order_id, 'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls),
    'fully_drawn', v_fully_drawn,
    'lines', v_lines);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'draw_down_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Defensive: CREATE OR REPLACE preserves the existing ACL, so this changes
-- nothing today. It is stated explicitly so the deliberate posture set by
-- 20260812115237 -- the implementation is reachable ONLY through the
-- draw_down_quote wrapper, which is what enforces below-cost approval -- cannot
-- be lost by a future edit that recreates this function from scratch. The
-- postflight below proves the posture rather than assuming it.
REVOKE ALL ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- --- CRX-MONEY-002, durable half: make the bad value unrepresentable ---------
-- The refusal inside the function body above is the fail-closed half; this is
-- the half that stops such a row from ever being written. Verified read-only
-- against production on 2026-08-16 that no existing row violates it, so the
-- constraint is added VALIDATED rather than NOT VALID -- a NOT VALID constraint
-- would let the very rows it exists to prevent survive a later backfill.
-- NULL stays legal because a booked line may legitimately carry no quantity
-- yet; the draw path already treats NULL as zero.
-- CRX-MIG-002 (Codex adversarial review, 2026-08-16): creating only when the
-- NAME is free would silently inherit a same-named weaker rule under constraint
-- drift, and the postflight's substring test would still pass it. So the
-- "already exists" path now proves the existing constraint IS this constraint,
-- by comparing the stored expression to the exact text PostgreSQL normalizes
-- ours to, and aborts the migration otherwise. Fails closed: an unrecognised
-- rule stops the apply rather than being adopted unread.
DO $qty_check$
DECLARE
  -- Captured from PostgreSQL 17's own pg_get_constraintdef output for the CHECK
  -- written below, on a throwaway database, not hand-written.
  c_expected constant text :=
    'CHECK (((total_units_needed IS NULL) OR ((total_units_needed >= (0)::numeric) AND (total_units_needed < ''Infinity''::numeric))))';
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.quote_items'::regclass
    AND conname = 'quote_items_total_units_needed_nonneg_finite_chk';

  IF v_def IS NULL THEN
    ALTER TABLE public.quote_items
      ADD CONSTRAINT quote_items_total_units_needed_nonneg_finite_chk
      CHECK (
        total_units_needed IS NULL
        OR (total_units_needed >= 0 AND total_units_needed < 'Infinity'::numeric)
      );
  ELSIF v_def IS DISTINCT FROM c_expected THEN
    RAISE EXCEPTION
      'CONSTRAINT_NAME_DRIFT: quote_items_total_units_needed_nonneg_finite_chk already exists on quote_items with a different rule (%); refusing to skip creation and adopt an unverified constraint', v_def;
  END IF;
END;
$qty_check$;

-- --- Postflight: prove the shape and the security posture --------------------
DO $postflight$
DECLARE
  v_secdef boolean;
  v_config text[];
  v_src text;
  v_bad_grantee text;
  v_overloads integer;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: expected exactly 1 function named public._draw_down_quote_below_cost_impl_20260810, found % -- a second overload would make the wrapper''s target ambiguous', v_overloads;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc
  INTO v_secdef, v_config, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810'
    AND p.pronargs = 4;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation function is missing after replace';
  END IF;

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation lost SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation lost its pinned search_path (found %)', v_config;
  END IF;

  -- A NAME TRIPWIRE, not a behaviour check (drift review 2026-08-16, L5 -- the
  -- earlier wording claimed more than this does). It catches the one identifier
  -- the abandoned averaging candidate used, so a straight revert to that body
  -- is refused; a weighted average reintroduced under any other variable name
  -- would pass it. The real guards against that defect are structural: there is
  -- no averaging anywhere in the body, and DRAW_ALLOCATION_MISMATCH (asserted
  -- present just below) fails the draw closed if the per-tier quantities ever
  -- stop summing to the requested quantity.
  IF position('wavg_price' IN v_src) > 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: a weighted-average unit price is back in the body';
  END IF;

  IF position('DRAW_ALLOCATION_MISMATCH' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the quantity-conservation assertion is missing';
  END IF;

  -- The implementation must stay unreachable from the app roles; only the
  -- draw_down_quote wrapper (which enforces below-cost approval) may reach it.
  SELECT string_agg(g, ', ') INTO v_bad_grantee
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'public']) AS g
  WHERE has_function_privilege(
    g, 'public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)', 'EXECUTE');

  IF v_bad_grantee IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: implementation is executable by % — it must be reachable only through the draw_down_quote wrapper', v_bad_grantee;
  END IF;

  -- The mirror of the check above: the REVOKE must not have gone too far. The
  -- public draw_down_quote wrapper is SECURITY DEFINER owned by postgres, so it
  -- reaches this implementation as postgres. If postgres ever lost EXECUTE the
  -- wrapper would fail at call time, not here -- i.e. the first symptom would
  -- be a broken draw in production. Assert it now instead.
  --
  -- Weak by construction, kept deliberately (drift review 2026-08-16, L4): while
  -- postgres OWNS this function it holds EXECUTE implicitly regardless of the
  -- ACL, so this cannot fail today. It earns its place only if ownership ever
  -- moves, which is exactly the case where a too-broad REVOKE would bite. It is
  -- an ownership tripwire, not a proof that the REVOKE above was well aimed.
  IF NOT has_function_privilege(
       'postgres',
       'public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: postgres lost EXECUTE on the implementation — the draw_down_quote wrapper could no longer reach it';
  END IF;

  -- The checks above prove nobody unauthorised can reach the implementation.
  -- They do NOT prove the front door still enforces below-cost approval, which
  -- is the other half of the posture this file claims. That matters more after
  -- this change than before it: splitting per tier makes below-cost detection
  -- sharper, so draws that used to hide behind an averaged unit price will now
  -- correctly route to the admin approval gate. Assert the wrapper is still
  -- there, still SECURITY DEFINER, still search_path-pinned, and still calls
  -- the gate. Verified live 2026-08-16: exactly one such function exists,
  -- signature (uuid, jsonb, uuid, text, text) -- hence pronargs = 5, pinned the
  -- same way the preflight and the impl postflight pin their own arity rather
  -- than matching on bare name.
  -- Overload uniqueness FIRST, asserted the same way the implementation is
  -- (preflight and postflight both use count(*) = 1) rather than with the bare
  -- NOT EXISTS this check used to be (drift review 2026-08-16 L3, RLS review
  -- L1). A bare EXISTS passes happily while a second, differently-shaped
  -- draw_down_quote sits beside this one -- precisely the ambiguity the
  -- implementation's own check exists to prevent.
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: expected exactly 1 function named public.draw_down_quote, found % -- a second overload would make the front door ambiguous', v_overloads;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc
  INTO v_secdef, v_config, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote'
    AND p.pronargs = 5;

  -- Split into one assertion per claim so a failure names the thing that broke
  -- instead of listing four possibilities, and expressed with the same
  -- `= ANY (v_config)` idiom as the implementation's search_path assert above
  -- (drift review 2026-08-16, L4): the file previously stated one identical
  -- claim two different ways, which invites a later edit to "harmonize" them
  -- and get the semantics subtly wrong.
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper is missing or no longer carries its (uuid, jsonb, uuid, text, text) signature';
  END IF;

  -- IS NOT TRUE, not NOT: the two are the same on a boolean and differ on NULL,
  -- where `NOT NULL` is NULL and the IF quietly takes the false branch (drift
  -- review 2026-08-16 L1, RLS review L1 -- both caught the same half-finished
  -- harmonization). Unreachable today, since pg_proc.prosecdef is NOT NULL and
  -- the v_src IS NULL check above already raises when the row is absent, but
  -- the fail-closed form should not depend on that ordering surviving an edit.
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper is no longer SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper lost its search_path pin';
  END IF;

  IF position('_begin_below_cost_money_write' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper no longer calls the below-cost approval gate';
  END IF;

  -- The wrapper is the FRONT DOOR, so its grants matter more than the
  -- implementation's, not less (RLS review 2026-08-16, M3). The scan above
  -- proves the implementation is unreachable; without this one the file proved
  -- only half the posture it claims to prove, and an anon-executable
  -- draw_down_quote -- a B9-class exposure -- would pass this postflight
  -- untouched. The on-disk baseline is correct today (20260812115237:877
  -- REVOKEs from PUBLIC and anon, :882 GRANTs to authenticated and
  -- service_role); this asserts it rather than trusting it. anon only: an
  -- authenticated grant is required for the app to work at all, and postgres
  -- and the owner are legitimately privileged.
  IF has_function_privilege(
       'anon', 'public.draw_down_quote(uuid, jsonb, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: draw_down_quote is executable by anon — the front door must require an authenticated session';
  END IF;

  RAISE NOTICE 'DRAW_DOWN_TIER_SPLIT_OK: order lines now split per booked price tier; no averaged unit price remains';
END;
$postflight$;

-- --- Postflight: prove the CRX-MONEY-002 constraint landed and is enforcing --
DO $qty_postflight$
DECLARE
  c_expected constant text :=
    'CHECK (((total_units_needed IS NULL) OR ((total_units_needed >= (0)::numeric) AND (total_units_needed < ''Infinity''::numeric))))';
  v_validated boolean;
  v_def text;
BEGIN
  SELECT c.convalidated, pg_get_constraintdef(c.oid)
  INTO v_validated, v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.quote_items'::regclass
    AND c.conname = 'quote_items_total_units_needed_nonneg_finite_chk';

  IF v_validated IS NULL THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: quote_items_total_units_needed_nonneg_finite_chk is absent, so a negative or non-finite booked quantity is still writable';
  END IF;

  IF NOT v_validated THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: quote_items_total_units_needed_nonneg_finite_chk exists but is NOT VALID, so it does not cover the rows already on the table';
  END IF;

  -- Existence is not enforcement. A substring test is not enough either: a
  -- weaker same-named rule can contain both '>= (0)' and 'Infinity' and still
  -- admit the values this exists to stop (CRX-MIG-002). So assert the stored
  -- expression is exactly the one whose rejection behaviour was proven. That it
  -- REJECTS is proven on a throwaway database rather than by probing this one:
  -- an INSERT probe here would trip the table's NOT NULL columns before ever
  -- reaching the CHECK.
  IF v_def IS DISTINCT FROM c_expected THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: quote_items_total_units_needed_nonneg_finite_chk is present but its rule (%) is not the expression proven to reject negative and non-finite quantities', v_def;
  END IF;
END;
$qty_postflight$;
