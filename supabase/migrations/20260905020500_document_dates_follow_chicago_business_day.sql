-- Document dates follow the America/Chicago business day, never the UTC clock.
--
-- WHY THIS EXISTS
-- ---------------
-- 20260905020400 made a commission inherit its SOURCE DOCUMENT's date. Adversarial review
-- (migration-drift-reviewer, BLOCKER B1) then caught that the document is itself stamped
-- from the UTC clock on four of the five broken paths, so the inherited date was still
-- wrong. Confirmed against live pg_proc.prosrc on 2026-09-05. This migration converts
-- those writers, and only together do the two close the risk.
--
-- The database clock is UTC; the business day is America/Chicago. After ~7pm Chicago the
-- server's CURRENT_DATE is ALREADY TOMORROW. On September 30 that also rolls the CROP
-- SEASON, which is the worst night of the year for it.
--
-- WHAT IS CONVERTED
-- -----------------
--   public._convert_quote_to_order_owner_impl
--     quote -> order. Writes orders.order_date, then creates the commissions.
--     2 CURRENT_DATE value(s) converted.
--   public._draw_down_quote_below_cost_impl_20260810
--     quote drawdown -> order. Writes orders.order_date, then creates the commissions.
--     2 CURRENT_DATE value(s) converted.
--   public._create_quick_delivery_intent_impl_20260802
--     quick delivery. Writes orders.order_date AND invoices.invoice_date, then creates the commissions. Live carries this body under the _impl_20260802 name: 20260803010917 installed it by ALTER FUNCTION ... RENAME TO, so the body is unchanged from this file and only the name differs.
--     3 CURRENT_DATE value(s) converted.
--   public.transfer_job_to_invoice
--     job -> invoice. Writes invoices.invoice_date, its due_date, AND the derived season, on two separate insert paths, then creates the commissions.
--     12 CURRENT_DATE value(s) converted.
--
-- transfer_job_to_invoice is the widest of the four: besides invoices.invoice_date it also
-- derives the invoice's DUE DATE and its SEASON from the same clock, on two separate
-- insert paths. Those are converted too — a due date is meant to run from the invoice date
-- (settled 2026-09-03), and a season read from a UTC clock is exactly the September 30
-- defect. Its UTC invoice_date was ALSO a live defect in its own right, beyond commissions:
-- 20260904160000 converted four invoice-dating functions and this was not one of them, so
-- a field-application invoice raised on a Chicago evening was dated tomorrow, moving its
-- season, due date and aging.
--
-- HOW THIS FILE WAS PRODUCED
-- --------------------------
-- Not transcribed. Each body was copied byte-for-byte out of the migration that installed
-- the version now live, and only non-comment CURRENT_DATE tokens were replaced. Every body
-- was verified by md5 against production before conversion:
--
--   _convert_quote_to_order_owner_impl           f81eab0f5ad504e3707d6355d71eff06  <- 20260812115236_quote_items_cost_at_quote_snapshot.sql (11975 bytes)
--   _draw_down_quote_below_cost_impl_20260810    b921e5349114b04214c616b7b66ac6e1  <- 20260816120000_draw_down_split_order_lines_by_price_tier.sql (70990 bytes)
--   _create_quick_delivery_intent_impl_20260802  5ace886f56af66ad8de02194cc97a96c  <- 20260706130000_stock_policy_warn_not_block.sql (15026 bytes)
--   transfer_job_to_invoice                      78b827f8509a2740ea9879364747c372  <- 20260713060000_harden_field_split_sum100.sql (37311 bytes)
--
-- The quick-delivery body appears in the repo under its ORIGINAL name, create_quick_delivery:
-- 20260803010917 installed the live copy with ALTER FUNCTION ... RENAME TO, changing the
-- name and not the body. It is re-emitted here under the live name.
--
-- Comment text mentioning CURRENT_DATE is deliberately left alone: rewriting prose would
-- change bytes without changing behaviour, and the postflight counts code tokens.
--
-- NOT DESTRUCTIVE: no row deleted, no column dropped, no existing document or commission
-- re-dated. Only how FUTURE dates are derived changes.
--
-- FAIL-CLOSED: each body is pinned by md5 (the pre-image this converts AND the post-image
-- it produces, so a re-run is safe rather than aborting on its own output). If any has
-- drifted at apply time this migration aborts and changes nothing.

BEGIN;

DO $preflight$
DECLARE
  r record;
  v_expected constant jsonb := jsonb_build_object(
    '_convert_quote_to_order_owner_impl',
      jsonb_build_array('f81eab0f5ad504e3707d6355d71eff06', 'd6398064c65664b3fd2145cca89c9286'),
    '_draw_down_quote_below_cost_impl_20260810',
      jsonb_build_array('b921e5349114b04214c616b7b66ac6e1', '90e80d015ce57e882cdc23c0fa6304d2'),
    '_create_quick_delivery_intent_impl_20260802',
      jsonb_build_array('5ace886f56af66ad8de02194cc97a96c', '25b6bca34a8e70ac9617078c21cfb5ae'),
    'transfer_job_to_invoice',
      jsonb_build_array('78b827f8509a2740ea9879364747c372', '65cec26a71dde8c465a64337e25d8098')
  );
  v_seen int := 0;
BEGIN
  FOR r IN
    SELECT p.proname, md5(p.prosrc) AS src_md5, p.prosecdef, p.proconfig, p.proowner::regrole::text AS owner,
           count(*) OVER (PARTITION BY p.proname) AS overloads
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('_convert_quote_to_order_owner_impl', '_draw_down_quote_below_cost_impl_20260810', '_create_quick_delivery_intent_impl_20260802', 'transfer_job_to_invoice')
  LOOP
    v_seen := v_seen + 1;
    IF r.overloads <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_OVERLOAD: public.% has % overloads; refusing to guess which carries the date.', r.proname, r.overloads;
    END IF;
    IF NOT ((v_expected -> r.proname) ? r.src_md5) THEN
      RAISE EXCEPTION
        'PREFLIGHT_DRIFT: public.% body md5 is %, which is neither body this migration accepts (%). Re-read the current body, confirm the date expressions are still the only thing needing conversion, then re-pin.',
        r.proname, r.src_md5, (v_expected -> r.proname)::text;
    END IF;
    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'PREFLIGHT_OWNER: public.% is owned by %, expected postgres.', r.proname, r.owner;
    END IF;
  END LOOP;
  IF v_seen <> 4 THEN
    RAISE EXCEPTION 'PREFLIGHT_MISSING: expected 4 writers, found %.', v_seen;
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- public._convert_quote_to_order_owner_impl — 2 CURRENT_DATE value(s) -> America/Chicago
-- Body copied byte-for-byte from 20260812115236_quote_items_cost_at_quote_snapshot.sql
-- (verified md5 f81eab0f5ad504e3707d6355d71eff06 against live before conversion).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._convert_quote_to_order_owner_impl(p_quote_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_actor_role text;
  v_quote record; v_order_number text; v_order_id uuid; v_item record;
  v_customer record; v_inv record; v_shortfalls text[] := '{}'; v_net_position numeric;
  v_result jsonb; v_existing jsonb;
  v_has_draws boolean; v_fully_drawn boolean;
  v_canonical_profit numeric; -- retained from live 20260810150000 DELTA-A
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

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'convert_quote_to_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Draws guard FIRST and status-independent (2026-06-10 BLOCKER fix): the UI
  -- may have pre-flipped status to 'accepted' before calling this RPC, so the
  -- guard can never key off status. A booking with an undrawn balance is
  -- never whole-convertible; a fully-drawn booking is never re-bookable.
  SELECT EXISTS (
    SELECT 1 FROM quote_product_draws
    WHERE quote_id = p_quote_id AND quantity_drawn > 0
  )
  -- LAYER2<<< job reservations count as draws too (§6.5): a job that reserved
  -- booking units makes this a partially-drawn booking — whole conversion would
  -- re-order units a job already holds/bills.
  OR EXISTS (
    SELECT 1 FROM job_product_draws
    WHERE quote_id = p_quote_id AND quantity_drawn > 0
  )
  -- >>>LAYER2
  INTO v_has_draws;
  IF v_has_draws THEN
    -- ORDER draws only (see header): job draws never satisfy 'fully drawn'.
    SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
    FROM (
      SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
      FROM quote_items WHERE quote_id = p_quote_id
      GROUP BY product_id
    ) b
    LEFT JOIN quote_product_draws d
      ON d.quote_id = p_quote_id AND d.product_id = b.product_id
    WHERE b.booked > 0;
    IF NOT v_fully_drawn THEN
      RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN: this quote has partial draw-downs — draw the remaining balance from the booking instead';
    END IF;
    -- Fully ORDER-drawn: every booked unit is already on an order. Surface the
    -- most recent draw order; never create another.
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    -- LAYER2<<< defensive (Codex): the order-only fully-drawn check is vacuously
    -- TRUE when the booked-rows set is empty (e.g. a job-drawn product was
    -- dropped from quote_items). Never return a null-order 'already_converted'
    -- the caller force-uses (result.order_id!) — treat as an unresolved booking.
    IF v_order_id IS NULL THEN
      RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN: this booking has no order to convert (reservations exist) — review the booking''s jobs and draws';
    END IF;
    -- >>>LAYER2
    v_result := jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
    END IF;
    RETURN v_result;
  END IF;

  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      v_result := jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
      END IF;
      RETURN v_result;
    END IF;
  END IF;

  IF v_quote.status NOT IN ('sent', 'revised', 'accepted') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: cannot convert a % quote', v_quote.status;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
      AND (qi.cost_at_quote_cents IS NULL OR qi.cost_at_quote_cents <= 0)
  ) THEN
    RAISE EXCEPTION 'COST_BASIS_REQUIRED: every converted quote line needs a validated positive quote-time cost';
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  FOR v_item IN
    SELECT qi.product_id, p.product_name, SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_item.qty_needed THEN
        v_shortfalls := array_append(v_shortfalls,
          v_item.product_name || ': need ' || v_item.qty_needed ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  SET LOCAL app.admin_override = 'true';
  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  UPDATE inventory_holds SET is_active = false, updated_at = now()
  WHERE source_id = p_quote_id AND is_active = true;

  v_order_number := generate_order_number();

  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    -- Retain live 20260810150000 DELTA-E. The constraints validate this INSERT
    -- before order-item triggers replace the header from canonical line money.
    v_quote.commission_split,
    ROUND(COALESCE(v_quote.total_price, 0), 2),
    ROUND(COALESCE(v_quote.total_cost, 0), 2),
    ROUND(COALESCE(v_quote.total_profit, 0), 2),
    v_quote.total_margin_pct, (now() AT TIME ZONE 'America/Chicago')::date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs WHERE qs.quote_id = p_quote_id
       AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> ''))
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, notes,
    cost_at_time_cents -- SNAPSHOT
    )
  SELECT v_order_id, qi.product_id, qi.id, qs.section_name, p.product_name,
    qi.price_per_unit, qi.cost_at_quote_cents::numeric / 100, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0), qi.notes,
    -- SNAPSHOT: carry the QUOTE-time cost into the order's own snapshot.
    -- Without it the order line inserts with a NULL cost_at_time_cents and
    -- trg_snapshot_order_item_cost stamps TODAY's catalog cost, so a quote
    -- converted after a cost change reports one profit through the snapshot
    -- reports and a different one through the order header, line profit and
    -- commissions -- all of which follow qi.current_cost. Supplying the value
    -- is honored because that trigger only fills when the caller left it NULL.
    --
    qi.cost_at_quote_cents
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0))
  FROM quote_items qi
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL
  GROUP BY qi.quote_id, qi.product_id
  HAVING SUM(COALESCE(qi.total_units_needed, 0)) > 0
  ON CONFLICT (quote_id, product_id)
  DO UPDATE SET quantity_drawn = EXCLUDED.quantity_drawn, updated_at = now();

  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes)
    VALUES (v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, v_actor, 'Pre-booked for order ' || v_order_number);
  END LOOP;

  -- Retain live 20260810150000 DELTA-A: item triggers have now settled the
  -- canonical order header, so commissions must mint from that value rather
  -- than the quote's cached profit.
  SELECT ROUND(COALESCE(o.total_profit, 0), 2)
    INTO v_canonical_profit
    FROM orders o
   WHERE o.id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_canonical_profit,
    v_quote.commission_split, (now() AT TIME ZONE 'America/Chicago')::date
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'quote_converted', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'order_number', v_order_number,
      'customer_id', v_quote.customer_id,
      'customer_name', COALESCE(v_customer.farm_name, 'unknown'),
      'total_price_dollars', v_quote.total_price,
      'inventory_warnings', to_jsonb(v_shortfalls)
    ),
    ROUND(v_quote.total_price * 100)::bigint,
    'Converted quote ' || v_quote.quote_number || ' to order ' || v_order_number ||
      ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: ' || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_shortfalls, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, v_quote.customer_id);

  v_result := jsonb_build_object('status', 'created', 'order_id', v_order_id,
    'order_number', v_order_number, 'warnings', to_jsonb(v_shortfalls));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;


-- ---------------------------------------------------------------------------
-- public._draw_down_quote_below_cost_impl_20260810 — 2 CURRENT_DATE value(s) -> America/Chicago
-- Body copied byte-for-byte from 20260816120000_draw_down_split_order_lines_by_price_tier.sql
-- (verified md5 b921e5349114b04214c616b7b66ac6e1 against live before conversion).
-- ---------------------------------------------------------------------------
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
  v_unmatched numeric;
  v_over numeric := 0;
  v_tier_count integer;
  v_skip numeric;
  v_take numeric;
  v_alloc_left numeric;
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
    v_quote.commission_split, 0, 0, 0, 0, (now() AT TIME ZONE 'America/Chicago')::date,
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
    -- Acres are NOT prorated from a whole-draw figure any more. Each emitted
    -- line takes the share of its OWN booked line's acreage that the draw takes
    -- of that line's OWN units -- see the long note at the write site (Codex
    -- review 2026-08-16, P2 3793063419). v_total_acres is still read above for
    -- the booking-level checks; it no longer feeds the per-line figure.

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
    -- still bill the customer, keyed on WHICH QUOTE LINE each was drawn from.
    -- Every line this body writes stamps order_items.quote_item_id, so a tier
    -- is consumed exactly to the extent that live lines name it.
    --
    -- WHY AN IDENTITY AND NOT THE TIER KEY (Codex review 2026-08-16, P1
    -- 3792521137 / 3792687211). The previous version keyed attribution on the
    -- pair (price_per_unit, cost_at_time_cents) carried by each order line.
    -- That key is neither unique nor immutable, and both failures cost money.
    --
    -- NOT UNIQUE: two quote lines at the same price and cost collapsed into one
    -- tier, so a booking reading 100 @ A, 100 @ B, 100 @ A billed the two A
    -- lines as a single 200-unit block sitting at the FRONT of the list. The
    -- customer's own document order was not what got drawn.
    --
    -- NOT IMMUTABLE (drift review 2026-08-16, H2 and M1). The cost half of the
    -- key moves in three distinct ways, and the earlier version of this comment
    -- named only the first:
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
    -- Under the OLD key any of these orphaned a billed line from its tier. That
    -- failure was fail-CLOSED -- the tiers stopped summing to the drawn
    -- quantity, so the conservation assert refused the whole draw with
    -- DRAW_ALLOCATION_MISMATCH rather than mis-pricing or double-selling --
    -- but it refused LEGITIMATE draws until an admin intervened.
    --
    -- Keying on quote_items.id retires all three. It is a primary key: no
    -- trigger writes it, no repair migration re-snapshots it, and it does not
    -- collapse two lines into one. The vectors above are recorded because they
    -- are still true of the COLUMNS -- an admin edit still moves a line's cost
    -- snapshot, and anything else that reasons off that pair inherits the
    -- problem -- but they no longer reach tier attribution.
    --
    -- WHAT THE STAMP SURVIVES, and what still gets past it:
    -- save_quote DELETEs quote_sections on every revision, cascading to
    -- quote_items, and reinserts them. The deferred FK installed near the end
    -- of this file moves the referential check to COMMIT, and save_quote reuses
    -- the same quote_items id on both of its paths, so an ordinary revision
    -- leaves every stamp intact. A stamp can no longer be ORPHANED at all: the
    -- FK is still NO ACTION, so a save that failed to bring an id back would
    -- abort the whole transaction rather than commit a dangling reference.
    --
    -- What still lands unattributed is narrower, and both cases are covered the
    -- same way: lines written before this migration, which carry no stamp; and
    -- lines whose quote line survives but is no longer a TIER, because its
    -- total_units_needed was edited to 0. Those fall into v_unmatched below,
    -- walk off the FRONT of the list, and are REFUSED outright by
    -- DRAW_MIXED_TIER_UNMATCHED_LINE the moment the product carries more than
    -- one distinct (price, cost). So the front-walk only ever runs where every
    -- tier row shares one price and one cost, and at a single price which
    -- identically-priced line a unit came off cannot change the bill.
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
    INTO v_unmatched
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.quote_id = p_quote_id
      AND o.booking_draw IS TRUE
      AND o.status <> 'voided'
      AND oi.product_id = v_product_id
      -- "This billed line names no tier row that still exists." The mirror
      -- half of the LEFT JOIN further down, which is now keyed on the same
      -- identity (Codex review 2026-08-16, P1 3792521137 / 3792687211).
      --
      -- Two populations fall in here, and both want the same treatment:
      --
      --   1. quote_item_id IS NULL -- written by the pre-cutover body, which
      --      stamped nothing. `qi.id = NULL` is never true, so these are caught
      --      with no special case.
      --   2. quote_item_id names a line that survives but is no longer a tier
      --      (its total_units_needed was edited to 0 or below).
      --
      -- A third population -- "quote_item_id names a quote line that no longer
      -- exists" -- was listed here while the FK was ON DELETE SET NULL, and is
      -- now unreachable. The FK is NO ACTION DEFERRABLE INITIALLY DEFERRED, so
      -- a revision that failed to bring an id back aborts at COMMIT instead of
      -- committing an orphan. Nothing can leave a stamp pointing at a deleted
      -- quote line. This test still tolerates it (the NOT EXISTS simply
      -- matches), so the code stays correct if that ever changes -- but no live
      -- route produces it.
      --
      -- All three are counted into v_unmatched, walked off the FRONT of the
      -- document-ordered tier list by v_skip, and -- crucially -- refused
      -- outright by DRAW_MIXED_TIER_UNMATCHED_LINE below whenever the product
      -- carries more than one distinct (price, cost). That refusal is what
      -- makes the front-walk sound rather than a guess: it only ever runs on a
      -- product whose every tier row carries ONE price and ONE cost, and at a
      -- single price it cannot matter which identically-priced line a unit came
      -- off. Where the stamp is missing the fallback is therefore "match on
      -- today's price and cost", and where even that is ambiguous the draw
      -- stops instead of guessing.
      --
      -- The old form of this test compared (price_per_unit, cost_at_time_cents)
      -- with IS NOT DISTINCT FROM on both halves, mirroring the old join. That
      -- discipline is retired with the key it protected: quote_items.id is a
      -- NOT NULL primary key, so `=` is total here and the NULL-vs-NULL hazard
      -- is gone. What must still be mirrored is the PARTITION -- a billed line
      -- has to be counted by exactly one of this test and that join, or the
      -- same units are billed twice or freed while still billed. If either side
      -- is edited, edit both.
      --
      -- One asymmetry with the tiers CTE is deliberate and worth naming (drift
      -- review 2026-08-16, L6): tiers additionally INNER JOINs quote_sections
      -- for its ordering columns, and this NOT EXISTS does not. That cannot
      -- drop a row, because quote_items.section_id is NOT NULL and REFERENCES
      -- quote_sections(id) ON DELETE CASCADE (20260206172436:176), so the join
      -- is total. The partition is exact -- but it leans on that foreign key,
      -- so if it is ever dropped this test must join quote_sections too.
      AND NOT EXISTS (
        SELECT 1
        FROM quote_items qi
        WHERE qi.id = oi.quote_item_id
          AND qi.quote_id = p_quote_id
          AND qi.product_id = v_product_id
          AND COALESCE(qi.total_units_needed, 0) > 0
      );

    -- Fail closed on a mixed-tier booking whose billed lines no longer name a
    -- tier that exists. Consuming those units off the FRONT of the list, as the
    -- block above does, is only sound when they really did come off the front.
    -- That holds for the legacy averaged body, which priced a whole product at
    -- one figure, and it holds for any product whose tier rows all share one
    -- price and one cost. It does NOT hold on a genuinely mixed booking.
    --
    -- The stamp makes this rarer than it was but does not remove it, and the
    -- guard is deliberately kept exactly as fail-closed as before (this is the
    -- "keep every existing refusal" half of the 2026-08-16 provenance rework).
    -- Two live routes still land here:
    --
    --   1. Lines drawn before this migration, which carry no stamp at all.
    --   2. A quote line that survives a revision but is edited down to zero
    --      units, so it stops being a tier while lines billed against it are
    --      still standing.
    --
    -- A revision ORPHANING a stamp is no longer one of them: the deferred FK
    -- keeps the id alive across save_quote's delete-and-reinsert, and refuses
    -- to commit if it ever did not.
    --
    -- Worked example (Codex review 2026-08-16, CRX-MONEY-TIER-001, restated for
    -- the stamp): book 100 units at $1.00 and 100 at $2.00; draw the $1.00 tier
    -- in full and 50 of the $2.00 tier; void the $1.00 order, which returns
    -- that tier to the pool; revise the quote so the surviving line's stamp
    -- names a quote line that no longer exists; draw the remaining 150. Without
    -- this refusal the orphaned 50 units come off the front and the booking
    -- bills $350.00 against a $300.00 order. DRAW_ALLOCATION_MISMATCH below
    -- cannot see it: that assertion fires only when the pool is too SMALL to
    -- absorb the draw, never when it is too large.
    --
    -- This same refusal is the net under the cutover race described at the top
    -- of this file. A legacy averaged draw that commits just after the preflight
    -- scan leaves precisely this trace -- billed units naming no live tier --
    -- so the next draw on that booking stops loudly instead of quietly
    -- misbilling the remainder.
    --
    -- Still counted on (price, cost), NOT on the number of tier ROWS, and that
    -- is the point rather than a leftover: two quote lines at the SAME price
    -- and cost are now two separate tier rows, but which of them an unstamped
    -- unit came off cannot change what the customer is billed. Counting rows
    -- here would refuse a perfectly determinate draw -- e.g. the same product
    -- booked into two fields at one price, drawn once before this migration.
    -- Distinct (price, cost) is exactly the condition under which the
    -- front-walk stops being money-exact.
    SELECT count(DISTINCT (qi.price_per_unit, qi.cost_at_quote_cents))
    INTO v_tier_count
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id = v_product_id
      AND COALESCE(qi.total_units_needed, 0) > 0;

    IF COALESCE(v_tier_count, 0) > 1 AND COALESCE(v_unmatched, 0) > 0 THEN
      RAISE EXCEPTION
        'DRAW_MIXED_TIER_UNMATCHED_LINE: % unit(s) already billed against this booking for % do not name any of its % booked price tiers, so which tiers those units consumed is not known. Drawing more could bill the same units twice. Void and re-book the order(s) holding those units, or undo the quote revision that changed those lines, then re-try.',
        v_unmatched, COALESCE(v_product_name, v_product_id::text), v_tier_count;
    END IF;

    -- Job reservations consume from the front alongside the legacy lines.
    v_skip := COALESCE(v_unmatched, 0) + COALESCE(v_job_drawn, 0);
    v_over := 0;

    v_alloc_left := v_qty;

    FOR v_tier IN
      WITH tiers AS (
        SELECT
          -- IMMUTABLE TIER PROVENANCE (Codex review 2026-08-16, P1 x2 --
          -- 3792521137 and 3792687211). A "tier" is now ONE QUOTE LINE, not a
          -- (price, cost) bucket aggregated across lines.
          --
          -- The old GROUP BY (price, cost) merged every quote line sharing a
          -- key into a single tier, and that merge caused two distinct money
          -- defects that no amount of downstream patching could reach:
          --
          --   1. INTERLEAVING. A booking reading 100 @ A, 100 @ B, 100 @ A
          --      collapsed to A=200, B=100, and the merged A sorted to A's
          --      FIRST document position. A 150-unit draw then billed all 150
          --      at A, where consuming the document top-down owes 100 A and
          --      50 B. The customer was billed the wrong tier's price.
          --   2. ROUNDING BOUNDARY. Merging two lines moved the cumulative
          --      rounding basis off the boundary save_quote booked them at.
          --      Two 0.5-unit lines at $1.01 book 0.51 + 0.51 = $1.02; merged
          --      into one 1.0-unit tier they extend to $1.01, underbilling a
          --      cent per merged pair.
          --
          -- Keying on qi.id fixes both at the source: lines never merge, each
          -- keeps its own document position, and each rounds against its own
          -- booked extension. It also gives every line written below a real
          -- quote_item_id to stamp, which is what lets the next draw match
          -- billed lines back EXACTLY instead of guessing by (price, cost).
          qi.id                  AS quote_item_id,
          qi.price_per_unit      AS price,
          qi.cost_at_quote_cents AS cost_cents,
          COALESCE(qi.total_units_needed, 0) AS units,
          -- Per-LINE now, not per-(price,cost)-bucket. The write site below
          -- still takes COALESCE(v_tier.unit_size, v_unit_size), so a line
          -- with no pack size falls back to the product-level value exactly as
          -- before (RLS review 2026-08-16, M1).
          qi.unit_size           AS unit_size,
          -- Per-LINE booked acreage, replacing the by-quantity proration the
          -- write site used to do (Codex review 2026-08-16, P2 3793063419).
          -- Splitting one draw's acres in proportion to units is wrong the
          -- moment two lines carry different rates: 100u/100ac + 100u/10ac
          -- drew two 55-acre lines, a figure neither line was booked at, and
          -- complete_delivery copies acres into invoice_items. With the line's
          -- own identity in hand its own booked acreage is simply available.
          qi.acres               AS line_acres,
          COALESCE(qi.total_units_needed, 0) AS line_units,
          -- Document order is (section position, then line position within the
          -- section). quote_items.sort_order restarts per section, so ordering
          -- on it alone ties two lines that sit in different sections and falls
          -- through to price -- which is not the order the customer sees.
          -- Both columns are NOT NULL live, so no COALESCE is needed.
          --
          -- No longer an aggregate at all. The earlier version had to take
          -- element 1 of an array_agg to keep (section, line) an atomic pair
          -- while collapsing many lines into one tier; one row per line makes
          -- the genuine document position directly available, so the class of
          -- bug that fix defended against cannot arise here.
          qs.sort_order          AS section_ord,
          qi.sort_order          AS ord
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
      ),
      -- Units still billed to the customer. Voided orders drop out entirely;
      -- cancelled orders keep only their delivered units. Same rule as v_skip
      -- above -- see the long comment there for why the two reversal states
      -- differ.
      --
      -- KEYED BY PROVENANCE (Codex review 2026-08-16, P1 3792521137 /
      -- 3792687211). Every line this body writes carries the id of the quote
      -- line it was drawn from, so it can be matched back EXACTLY. Lines
      -- written by the OLD body carry NULL there and are handled separately
      -- below, by the same front-walk v_skip has always used.
      --
      -- SPLIT AGAIN BY PRICE (Mason's rule, 2026-08-19). Changing the price on
      -- a partly-drawn booking must not rewrite what the customer was already
      -- billed: already-drawn units KEEP the price they were billed at, and
      -- only the units still owing use the new price. A genuine early-price
      -- error is corrected with a credit memo, not by silently rebilling
      -- delivered product.
      --
      -- So each tier's history divides in two, on whether the order line was
      -- billed at the price the quote line carries TODAY:
      --
      --   * units_current / money -- billed at the current price. These are
      --     still "live" against this price, so they remain the telescoping
      --     rounding basis: the next draw bills the running total of the whole
      --     price band minus the cents already standing in it, which is what
      --     stops four 0.25-unit draws on a $1.01 tier from billing $1.00.
      --   * units_settled -- billed at some other price. These are FINISHED.
      --     They still consume the tier's capacity (the customer has had that
      --     product and been billed for it, so it is no longer available to
      --     draw), but they are never re-based and their money never enters
      --     the basis. Re-basing them is exactly the rebilling Mason ruled out.
      --
      -- The comparison is against ti.price -- the quote line's price_per_unit
      -- as it stands now -- not against a remembered figure, so it re-partitions
      -- correctly if the price is changed again, or changed back.
      --
      -- IS NOT DISTINCT FROM, not =, so a NULL price on a billed line lands in
      -- units_settled rather than vanishing from both halves. ti.price itself
      -- cannot be NULL here: BOOKED_PRICE_REQUIRED above refuses the draw on a
      -- booked line with units > 0 and no price, and tiers only carries lines
      -- with units > 0. Numeric equality is exact-decimal in PostgreSQL and
      -- ignores trailing-zero scale, so 1.00 and 1.0000 match as they should.
      --
      -- The JOIN to tiers is what makes ti.price reachable. It cannot change
      -- which rows are counted: the outer LEFT JOIN below already keeps only
      -- billed rows whose quote_item_id names a live tier, and every billed row
      -- that does NOT is counted by the v_unmatched front-walk instead. The
      -- partition against v_unmatched is therefore unchanged -- still exactly
      -- one side per billed line.
      billed_stamped AS (
        SELECT
          oi.quote_item_id       AS quote_item_id,
          -- Units billed at the tier's CURRENT price -- the live rounding basis.
          SUM(
            CASE WHEN oi.price_per_unit IS NOT DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN COALESCE(oi.quantity_delivered, 0)
                           ELSE COALESCE(oi.total_units_needed, 0)
                      END
                 ELSE 0
            END) AS units_current,
          -- Units billed at some OTHER price -- settled. Capacity only.
          SUM(
            CASE WHEN oi.price_per_unit IS DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN COALESCE(oi.quantity_delivered, 0)
                           ELSE COALESCE(oi.total_units_needed, 0)
                      END
                 ELSE 0
            END) AS units_settled,
          -- MONEY actually standing against this tier key AT THE CURRENT PRICE,
          -- in dollars, on the same surviving quantity units_current counts
          -- (Codex push-proof 2026-08-16, CRX-MONEY-LIFECYCLE-001, High).
          --
          -- The money and the units MUST describe the same surviving rows, so
          -- the cancelled branch is mirrored here: a cancelled order keeps only
          -- its delivered units, so it may keep only the value of those units,
          -- not the whole line's total_price. Valuing them at the line's own
          -- price_per_unit is exact -- that is the price they were billed at.
          --
          -- Settled money is deliberately absent. It is not zero and it is not
          -- forgotten: it stands on the invoice exactly as billed. It simply
          -- takes no part in the arithmetic for the units still owing, because
          -- those units are priced from a fresh basis at the new price.
          --
          -- Why this column has to exist at all: the previous version re-based
          -- the running total on surviving UNITS and assumed the surviving
          -- lines held ROUND(price * units, 2) cents. A void breaks that
          -- assumption. Two 0.25-unit draws at $0.50 write $0.13 and $0.12;
          -- void the FIRST and 0.25 surviving units carry $0.12, not $0.13, so
          -- a units-only basis re-billed $0.12 and left the customer charged
          -- $0.24 for half a unit that costs $0.25. Which of two identical
          -- draws was voided must not change the bill.
          SUM(
            CASE WHEN oi.price_per_unit IS NOT DISTINCT FROM ti.price
                 THEN CASE WHEN o.status = 'cancelled'
                           THEN ROUND(COALESCE(oi.price_per_unit, 0)
                                      * COALESCE(oi.quantity_delivered, 0), 2)
                           ELSE COALESCE(oi.total_price, 0)
                      END
                 ELSE 0
            END) AS money
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        JOIN tiers ti ON ti.quote_item_id = oi.quote_item_id
        WHERE o.quote_id = p_quote_id
          AND o.booking_draw IS TRUE
          AND o.status <> 'voided'
          AND oi.product_id = v_product_id
          AND oi.quote_item_id IS NOT NULL
        GROUP BY oi.quote_item_id
      )
      SELECT
        t.quote_item_id,
        t.price,
        t.cost_cents,
        t.unit_size,
        t.line_acres,
        t.line_units,
        -- What this tier still has available to draw. BOTH halves of the
        -- billed history are subtracted: units already billed at the current
        -- price, and units settled at an earlier price. A settled unit has been
        -- delivered and charged, so it is gone from the booking whatever price
        -- it went out at -- treating it as still available would sell the same
        -- product twice.
        --
        -- GREATEST(..., 0) clamps PER TIER (drift review 2026-08-16, L7) so a
        -- negative tier cannot silently eat a neighbour's units.
        --
        -- The clamp alone is NOT sufficient, and an earlier version of this
        -- comment wrongly said it was ("bounded on both sides regardless by the
        -- v_remaining balance guard and DRAW_ALLOCATION_MISMATCH"). Neither
        -- bound sees an over-billed tier. v_remaining works on PER-PRODUCT
        -- aggregates, and DRAW_ALLOCATION_MISMATCH fires only when the pool is
        -- too SMALL. So the excess this clamp discards was invisible. It is
        -- carried out as the "over" column below and refused after the loop
        -- (DRAW_TIER_OVERCONSUMED). See that guard for the worked example.
        GREATEST(
          t.units
            - COALESCE(b.units_current, 0)
            - COALESCE(b.units_settled, 0), 0) AS units,
        -- Units billed against this tier BEYOND what the tier now holds --
        -- exactly the quantity the clamp above throws away. Counted across both
        -- halves, for the same reason: an over-draw is an over-draw whether the
        -- excess was billed at today's price or an earlier one.
        GREATEST(
          COALESCE(b.units_current, 0)
            + COALESCE(b.units_settled, 0)
            - t.units, 0) AS over,
        -- Units already billed at this tier's CURRENT price by earlier draws.
        -- This is the rounding BASIS for the money below, not a quantity the
        -- loop spends. See the telescoping comment at v_line_total.
        --
        -- Settled units are excluded on purpose. That is the whole of Mason's
        -- rule in one expression: a unit billed at a price the quote no longer
        -- carries is finished, so it must not appear in a running total that
        -- the next draw subtracts money from. If it did, the new units would be
        -- billed the difference between the old and new price on quantity the
        -- customer has already paid for -- a silent rebill.
        --
        -- Clamped to the current-price budget the line still has, which is its
        -- booked units less what is settled. (The over-billed excess is refused
        -- separately by DRAW_TIER_OVERCONSUMED, and that guard aborts the whole
        -- transaction, so the clamp cannot ship a wrong number -- it only keeps
        -- this column from going out of range on a run that is about to roll
        -- back anyway.)
        LEAST(
          COALESCE(b.units_current, 0),
          GREATEST(t.units - COALESCE(b.units_settled, 0), 0)) AS prior,
        -- Cents already standing against this tier key AT THE CURRENT PRICE.
        -- Deliberately NOT clamped the way "prior" is: this is a statement of
        -- fact about money that has been billed, and shrinking it would
        -- re-invent the very assumption CRX-MONEY-LIFECYCLE-001 was about --
        -- that the surviving lines hold whatever the arithmetic says they
        -- should. The one case where it can exceed the tier's own extension is
        -- an over-billed tier, which DRAW_TIER_OVERCONSUMED refuses outright
        -- after the loop; the GREATEST at v_line_total keeps the interim value
        -- in range until that guard aborts the transaction.
        COALESCE(b.money, 0) AS money
      FROM tiers t
      LEFT JOIN billed_stamped b
        -- EXACT provenance, replacing the (price, cost) key this join used to
        -- carry (Codex review 2026-08-16, P1 3792521137 / 3792687211).
        --
        -- quote_items.id is a NOT NULL primary key and order_items.quote_item_id
        -- REFERENCES it, so plain `=` is total here and there is no NULL-vs-NULL
        -- question to get wrong -- billed_stamped already filters
        -- quote_item_id IS NOT NULL, and the tiers side is a primary key. The
        -- long-standing IS NOT DISTINCT FROM discipline that used to live in
        -- this comment existed only because the old key included a NULLABLE
        -- cost column; keying on an identity retires that hazard rather than
        -- managing it.
        --
        -- What DOES still have to be mirrored token for token is the partition
        -- rule: a billed line must be counted by EXACTLY ONE of this join and
        -- the v_unmatched front-walk above, or the same units are counted twice
        -- (double-charging) or zero times (re-selling a tier that is still
        -- billed). The mirror above is now the same test in the negative --
        -- "no tier row carries this line's quote_item_id" -- so the two split
        -- the set exactly. If either side is edited, edit both.
        ON b.quote_item_id = t.quote_item_id
      -- Document order, with the line's own id as a deterministic tiebreak.
      -- (section_ord, ord) is not unique-by-constraint, and an unstable order
      -- here would make WHICH tier a partial draw lands in vary between calls.
      ORDER BY t.section_ord, t.ord, t.quote_item_id
    LOOP
      -- Over-consumption is accumulated across EVERY tier, so this loop no
      -- longer EXITs at the allocation boundary -- it CONTINUEs, leaving the
      -- tiers past that point still inspected. Tier counts per product are in
      -- the single digits, so walking the tail costs nothing.
      v_over := v_over + COALESCE(v_tier.over, 0);
      IF v_alloc_left <= 0 THEN CONTINUE; END IF;

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

      -- Money is rounded only AFTER extension by quantity, never before -- and,
      -- since the 2026-08-16 push-proof (CRX-MONEY-TIER-ROUND-001, High), the
      -- extension is CUMULATIVE per tier rather than per draw.
      --
      -- The earlier form was ROUND(price * take, 2) on each draw in isolation.
      -- That is exact for whole-unit draws, but draw quantities are genuinely
      -- fractional -- the draw box in QuoteBuilder is step="any", and so are the
      -- quote-line quantity boxes it draws against -- and on a fractional draw
      -- the per-draw rounding residual does not cancel. It ACCUMULATES across
      -- partial draws, so the tier ends up billed for more (or less) than its
      -- own authoritative extension. Worked case from the proof: 0.50 units at
      -- $0.50 plus 0.50 units at $1.50 books $1.00; drawn as four 0.25-unit
      -- draws the old form billed 2 x $0.13 + 2 x $0.38 = $1.02. Two cents
      -- invented out of rounding, and it grows with the number of partial draws.
      --
      -- The fix is to round the RUNNING TOTAL and subtract what is already
      -- charged. After this draw the tier has been billed for (prior + take)
      -- units, whose authoritative value is ROUND(price * (prior + take), 2).
      -- Subtract the money already standing against the tier and the remainder
      -- is what this line owes. Successive draws therefore telescope: whatever
      -- sequence of partial draws consumes a tier, the surviving lines sum to
      -- EXACTLY ROUND(price * units_billed_at_that_tier, 2), with no
      -- path-dependence and no accumulating residual. On a whole-unit draw this
      -- is identical to the old expression, so nothing changes for the ordinary
      -- case.
      --
      -- The subtrahend is v_tier.money -- the cents ACTUALLY standing on the
      -- surviving lines -- and NOT the computed ROUND(price * prior, 2). Those
      -- two agree in the ordinary case but diverge after a void, and using the
      -- computed figure made the final bill depend on WHICH of two identical
      -- draws had been reversed (Codex push-proof 2026-08-16,
      -- CRX-MONEY-LIFECYCLE-001, High). Reading the real money instead makes
      -- every path self-correcting, and it also repairs, on the next draw
      -- against that tier, a tier that legacy per-draw rounding had already
      -- over- or under-billed.
      --
      -- prior and money are keyed on the tier each line was WRITTEN at, not on
      -- units-drawn-from-the-product. Legacy averaged lines carry a DIFFERENT
      -- price and so land under a different key; they are handled by v_skip and
      -- correctly contribute 0 here, because this tier has genuinely not been
      -- billed for them.
      --
      -- GREATEST(..., 0): on an already over-billed tier the remainder can come
      -- out negative -- a credit. This path does not issue one. Refunding a
      -- historical over-charge belongs in a credit memo against the order that
      -- carries it, not silently inside an unrelated draw line, and a negative
      -- total_price would be refused by the whole-cent money CHECKs anyway. The
      -- clamp writes 0 and the over-charge stands, visible, on the line that
      -- created it. It hides nothing that is not already surfaced: the quantity
      -- form of the same condition is carried out as "over" and refused after
      -- the loop by DRAW_TIER_OVERCONSUMED.
      v_line_total := GREATEST(
                        ROUND(v_tier.price * (v_tier.prior + v_take), 2)
                        - v_tier.money, 0);

      -- COST is deliberately NOT telescoped. This asymmetry is load-bearing
      -- (Codex push-proof 2026-08-16, CRX-MONEY-PROFIT-001, High).
      --
      -- order_items.profit is not the caller's to choose. The canonical trigger
      -- from 20260809230500 overwrites any supplied profit with total_price -
      -- ROUND(cost_per_unit * total_units_needed, 2) -- a PER-LINE, explicitly
      -- non-cumulative cost. A cumulative v_line_cost therefore never reaches
      -- the stored line profit at all; it only desynchronises the order header
      -- and the commission basis from the lines they are meant to summarise.
      -- Measured shape: a $1.50 sale at $0.50 cost drawn as two 0.25-unit draws
      -- stores line profits of $0.25 + $0.24 = $0.49 under a header claiming
      -- $0.50.
      --
      -- So the cost basis is computed with the SAME expression the trigger
      -- uses, and the header below accumulates exactly the per-line figures the
      -- trigger will go on to store. Header, lines, and commission basis then
      -- agree by construction -- the invariant the 2026-08-09 decision exists
      -- to hold. The cost side keeps the per-draw rounding residual that the
      -- revenue side now sheds: a sub-cent artefact on internal margin, and the
      -- same one every other order path already carries. Shedding it there too
      -- means changing the shared canonical trigger for ALL order lines, which
      -- is a wider, separate change and is deliberately not made here.
      v_line_cost  := ROUND(v_tier_cost_unit * v_take, 2);

      -- ACRES COME FROM THE LINE'S OWN BOOKED RATE (Codex review 2026-08-16,
      -- P2 3793063419), not from prorating one whole-draw figure by units.
      --
      -- The previous form computed a single v_draw_acres for the product --
      -- ROUND(total_acres * qty / booked, 2) -- and handed it out in proportion
      -- to each tier's units. That is only right when every booked line for the
      -- product carries the same acres-per-unit. The moment two lines differ it
      -- invents a rate neither line was booked at: 100 units over 100 acres
      -- plus 100 units over 10 acres, drawn in full, wrote 55 acres on each of
      -- the two lines. Nothing on the booking says 55, and the figure does not
      -- stay internal -- complete_delivery copies order_items.acres straight
      -- into invoice_items, so it reaches the customer's paperwork.
      --
      -- With the quote line's own identity in hand its own booked acreage and
      -- its own booked quantity are directly available, so the line simply gets
      -- the share of ITS OWN acres that this draw takes of ITS OWN units. The
      -- two lines above now correctly read 100 and 10.
      --
      -- line_units is guaranteed > 0 by the tiers CTE filter, so the division
      -- is safe; the guard is written anyway because the filter and this
      -- division live 300 lines apart. A line booked with no acreage stays
      -- NULL rather than becoming a zero -- 0 acres and "not recorded" are
      -- different statements on a customer's order line.
      --
      -- No residual-absorbing last line any more, because there is no longer a
      -- whole-draw total the parts have to add back up to: each line's acreage
      -- is now an independent statement about its own booked line, and the only
      -- rounding is the single ROUND on that line's own figure. On a one-tier
      -- draw this is arithmetically identical to what the single-line version
      -- wrote (v_booked and v_total_acres collapse to that line's own values,
      -- and v_take = v_qty), so nothing changes for the ordinary case.
      v_tier_acres := CASE
        WHEN v_tier.line_acres IS NULL OR COALESCE(v_tier.line_units, 0) <= 0
          THEN NULL
        ELSE ROUND(v_tier.line_acres * v_take / v_tier.line_units, 2)
      END;

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
        cost_at_time_cents, -- SNAPSHOT
        quote_item_id       -- PROVENANCE
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
        v_tier.cost_cents,
        -- PROVENANCE: which booked quote line this order line was drawn from
        -- (Codex review 2026-08-16, P1 3792521137 / 3792687211). This is the
        -- root fix the rest of this body is built on -- the tier attribution
        -- above reads exactly this column back on the NEXT draw, so a line that
        -- fails to stamp here would be re-attributed by the front-walk and
        -- could re-sell its tier.
        --
        -- The column already existed on order_items and is already written by
        -- the FULL-conversion path (convert_quote_to_order); only this partial
        -- path left it NULL. Nothing downstream has to change to accept it:
        -- src/types/index.ts already declares quote_item_id as string | null,
        -- and every existing consumer already handles the NULL that legacy rows
        -- carry. Filling it strictly ADDS information.
        --
        -- The postflight assertion at the end of this migration re-reads the
        -- installed source and refuses the whole apply if this stamp is not
        -- present, so the body cannot ship with the attribution reading a
        -- column the writes never populate.
        v_tier.quote_item_id);

      v_total_price := v_total_price + v_line_total;
      v_total_cost := v_total_cost + v_line_cost;
    END LOOP;

    -- Fail closed when a tier is billed for more units than it now holds. That
    -- means the units already drawn can no longer be attributed to the tiers as
    -- they stand, so any further split is a guess.
    --
    -- This is reachable through a SUPPORTED workflow, not just a hand-edit
    -- (Codex review 2026-08-16, second HIGH). Revising a booking is allowed by
    -- save_quote's drawn-product guard on the PER-PRODUCT aggregate alone --
    -- 20260812115236:844 groups by product_id and compares total booked against
    -- total drawn, with no tier attribution preserved. So: book 200 units at
    -- one price, draw 150 of them, then revise the booking to 100 units at a
    -- lower price plus 100 at the original one. Booked (200) still covers drawn
    -- (150), so the revision saves. The 150 billed units still match the
    -- original tier, which now holds only 100 -- the clamp above silently
    -- discarded that 50-unit overhang, the remaining 50 units were drawn from
    -- the cheaper tier, and the booking billed more than its revised total.
    -- v_remaining could not catch it (per-product aggregate) and
    -- DRAW_ALLOCATION_MISMATCH could not catch it (the pool was large enough).
    --
    -- This guard is also the net under the coincidental-average case of the
    -- cutover race described at the top of this file: a late legacy averaged
    -- draw whose average happens to equal a real tier key escapes the unmatched
    -- -line guard, but it is attributed wholly to that one tier while it
    -- actually consumed several, so it over-bills that tier and stops here.
    --
    -- This migration now carries the provenance an earlier draft of this
    -- comment described as out of scope: every line written below stamps
    -- order_items.quote_item_id, so both scenarios are normally caught EARLIER
    -- and more precisely than here. In the revision case the stamps SURVIVE:
    -- the deferred FK installed further down lets save_quote delete and
    -- reinsert the same quote_items ids inside one transaction, so the next
    -- draw resolves attribution by identity and never reaches this net at
    -- all; in the cutover-race case a late legacy line carries no stamp and
    -- is caught the same way.
    --
    -- This refusal stays as the net beneath both, for the residue the stamp
    -- cannot reach: a product whose tiers all share ONE (price, cost) -- which
    -- the unmatched-line guard deliberately lets through as unbillable-either
    -- -way -- can still be resized below what it has already billed. It is
    -- deliberately stricter than strictly necessary rather than looser.
    IF v_over > 0 THEN
      RAISE EXCEPTION
        'DRAW_TIER_OVERCONSUMED: % unit(s) already billed against this booking for % exceed what its price tiers now hold, so which tiers the earlier draws consumed can no longer be determined. This usually follows a booking revision that repriced or resized a tier after part of it was drawn. Restore the tier quantities that were in place when those units were drawn, or void and re-book the affected orders, then re-try.',
        v_over, COALESCE(v_product_name, v_product_id::text);
    END IF;

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
    v_quote.commission_split, (now() AT TIME ZONE 'America/Chicago')::date
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


-- ---------------------------------------------------------------------------
-- public._create_quick_delivery_intent_impl_20260802 — 3 CURRENT_DATE value(s) -> America/Chicago
-- Body copied byte-for-byte from 20260706130000_stock_policy_warn_not_block.sql
-- (verified md5 5ace886f56af66ad8de02194cc97a96c against live before conversion).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._create_quick_delivery_intent_impl_20260802(p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_actor_role text;
  v_order_id uuid; v_order_number text;
  v_delivery_id uuid; v_delivery_number text;
  v_invoice_id uuid; v_invoice_number text;
  v_item jsonb; v_order_item_id uuid; v_product record;
  v_inv record; v_total_cents bigint := 0; v_total_cost_cents bigint := 0;
  v_item_price_cents bigint; v_item_qty numeric; v_sort integer := 0;
  v_customer record; v_split jsonb;
  v_order_profit numeric; v_split_total numeric; v_net_available numeric;
  v_ar_balance_cents bigint; v_projected_cents bigint;
  v_credit_warning boolean := false; v_admin record;
  v_result jsonb; v_existing jsonb;
  -- U9 stock-policy WARN-NOT-BLOCK
  v_short_count int := 0;
  v_stock_warnings text[] := '{}';
  v_short_product_ids uuid[] := '{}';
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep', 'driver') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins, sales reps, and drivers can create quick deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_quick_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF NOT v_customer.is_active THEN RAISE EXCEPTION 'Customer is inactive'; END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  FOR v_item IN
    SELECT jsonb_build_object('product_id', sub.product_id::text, 'quantity', sub.quantity) AS item
      FROM (
        SELECT (elem->>'product_id')::uuid AS product_id,
               SUM((elem->>'quantity')::numeric) AS quantity
          FROM jsonb_array_elements(p_items) elem
         GROUP BY (elem->>'product_id')::uuid
      ) sub
  LOOP
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;
    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_product.id AND location = 'Main Warehouse' FOR UPDATE;
    v_net_available := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);
    -- U9: WARN-NOT-BLOCK (was: RAISE EXCEPTION 'Insufficient inventory ...').
    -- Same net-available math; delivery proceeds, short products are flagged/notified.
    IF NOT FOUND OR v_net_available < v_item_qty THEN
      v_short_count := v_short_count + 1;
      v_short_product_ids := array_append(v_short_product_ids, v_product.id);
      v_stock_warnings := array_append(v_stock_warnings,
        v_product.product_name || ': need ' || v_item_qty || ', only ' ||
        GREATEST(v_net_available, 0) || ' net available (' ||
        COALESCE(v_inv.quantity_available, 0) || ' on hand, ' ||
        COALESCE(v_inv.quantity_prebooked, 0) || ' prebooked)');
      -- U9 (Codex R2 P2): with NO Main Warehouse row the later prebook UPDATE
      -- would no-op and the shortage would vanish from the position math. Seed a
      -- zero row so the aggregate goes visibly negative (complete_job pattern).
      IF NOT FOUND THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
        VALUES (v_product.id, 'Main Warehouse', 0, 0, true)  -- surfaces on /integrity-cleanup (P4-7 phantom-row flag)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;

    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, v_product.tier1_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, v_product.tier1_price, 0) * 100)
    END;
    v_total_cents := v_total_cents + safe_cents_qty(v_item_price_cents, v_item_qty);
  END LOOP;

  IF COALESCE(v_customer.credit_limit_cents, 0) > 0 THEN
    SELECT COALESCE(SUM(balance_cents), 0) INTO v_ar_balance_cents
      FROM invoices WHERE customer_id = p_customer_id
        AND status IN ('draft', 'posted', 'overdue');
    v_projected_cents := v_ar_balance_cents + v_total_cents;
    IF v_projected_cents >= v_customer.credit_limit_cents THEN
      v_credit_warning := true;
      INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
      VALUES ('credit_limit_warning',
        'WARNING: Quick delivery for "' || v_customer.farm_name || '" projected to push AR exposure to $' ||
          (v_projected_cents / 100.0)::numeric(12,2) ||
          ' (limit $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
          '). Current AR (draft+posted+overdue) is $' || (v_ar_balance_cents / 100.0)::numeric(12,2) ||
          '. Delivery proceeded; review with finance.',
        v_actor, 'customer', p_customer_id, p_customer_id);
      FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (v_admin.id,
          'Credit Limit Exceeded — ' || v_customer.farm_name,
          'A quick delivery was created for ' || v_customer.farm_name ||
            ' that projects AR exposure to $' || (v_projected_cents / 100.0)::numeric(12,2) ||
            ', exceeding the $' || (v_customer.credit_limit_cents / 100.0)::numeric(12,2) ||
            ' credit limit. Current AR (incl. draft+overdue) is $' ||
            (v_ar_balance_cents / 100.0)::numeric(12,2) ||
            '. The delivery proceeded; please review.',
          'credit_warning', 'customer', p_customer_id);
      END LOOP;
    END IF;
  END IF;

  v_split := v_customer.default_commission_split;
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
      INTO v_split_total FROM jsonb_array_elements(v_split->'splits') elem;
    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %.2f%%). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, total_price, total_cost, total_profit, total_margin_pct, commission_split)
  VALUES (v_order_id, v_order_number, p_customer_id, 'confirmed', (now() AT TIME ZONE 'America/Chicago')::date, 'Quick delivery', 0, 0, 0, 0, v_customer.default_commission_split);

  v_delivery_id := gen_random_uuid();
  v_delivery_number := next_delivery_number();
  INSERT INTO deliveries (id, delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, delivery_notes, is_quick_delivery, created_by)
  VALUES (v_delivery_id, v_delivery_number, v_order_id, p_customer_id, p_driver_id, p_scheduled_date, 'scheduled', p_delivery_notes, true, v_actor);

  IF NOT p_skip_invoice THEN
    v_invoice_id := gen_random_uuid();
    v_invoice_number := next_invoice_number('chemical_sale');
    INSERT INTO invoices (id, invoice_number, invoice_type, order_id, delivery_id, customer_id, status, total_amount_cents, paid_amount_cents, prepay_applied_cents, invoice_date, is_quick_delivery, created_by)
    VALUES (v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, v_delivery_id, p_customer_id, 'draft', 0, 0, 0, (now() AT TIME ZONE 'America/Chicago')::date, true, v_actor);
  END IF;

  v_total_cents := 0;
  v_total_cost_cents := 0;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sort := v_sort + 1;
    SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
    v_item_qty := (v_item->>'quantity')::numeric;

    v_item_price_cents := CASE v_customer.assigned_tier
      WHEN 1 THEN ROUND(COALESCE(v_product.tier1_price, 0) * 100)
      WHEN 2 THEN ROUND(COALESCE(v_product.tier2_price, v_product.tier1_price, 0) * 100)
      ELSE ROUND(COALESCE(v_product.tier3_price, v_product.tier1_price, 0) * 100)
    END;

    v_total_cents := v_total_cents + safe_cents_qty(v_item_price_cents, v_item_qty);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_product.current_cost, 0) * 100 * v_item_qty)::bigint;

    INSERT INTO order_items (order_id, product_id, product_name, total_units_needed, price_per_unit, cost_per_unit, quantity_delivered, quantity_remaining, total_price, profit, net_margin, sort_order)
    VALUES (
      v_order_id, v_product.id, v_product.product_name, v_item_qty,
      (v_item_price_cents / 100.0)::numeric,
      COALESCE(v_product.current_cost, 0),
      0, v_item_qty,
      (v_item_price_cents / 100.0)::numeric * v_item_qty,
      ((v_item_price_cents / 100.0)::numeric - COALESCE(v_product.current_cost, 0)) * v_item_qty,
      CASE WHEN (v_item_price_cents / 100.0)::numeric > 0
        THEN (((v_item_price_cents / 100.0)::numeric - COALESCE(v_product.current_cost, 0))
              / (v_item_price_cents / 100.0)::numeric) * 100
        ELSE 0
      END,
      v_sort)
    RETURNING id INTO v_order_item_id;

    INSERT INTO delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_delivery_id, v_order_item_id, v_product.id, v_item_qty, 0, COALESCE(v_item->>'unit_size', v_product.unit_size));

    IF NOT p_skip_invoice THEN
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
      VALUES (v_invoice_id, v_order_item_id, v_product.id, v_product.product_name, v_item_qty, v_item_price_cents,
        safe_cents_qty(v_item_price_cents, v_item_qty), ROUND(COALESCE(v_product.current_cost, 0) * 100)::bigint, v_sort);
    END IF;

    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item_qty, updated_at = now()
    WHERE product_id = v_product.id AND location = 'Main Warehouse';

    -- U9: flag the prebooked ledger row for review when the product was short.
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, delivery_id, performed_by, notes, requires_review)
    VALUES (v_product.id, 'prebooked', v_item_qty, v_order_id, v_delivery_id, v_actor,
      'Quick delivery prebooked: ' || v_delivery_number ||
        CASE WHEN v_product.id = ANY(v_short_product_ids) THEN ' [SHORT STOCK — review required]' ELSE '' END,
      v_product.id = ANY(v_short_product_ids));
  END LOOP;

  UPDATE orders SET total_price = (v_total_cents / 100.0)::numeric, total_cost = (v_total_cost_cents / 100.0)::numeric,
    total_profit = ((v_total_cents - v_total_cost_cents) / 100.0)::numeric,
    total_margin_pct = CASE WHEN v_total_cents > 0 THEN ROUND((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100, 2) ELSE 0 END
  WHERE id = v_order_id;

  IF NOT p_skip_invoice THEN
    UPDATE invoices SET total_amount_cents = v_total_cents, total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;
  END IF;

  v_order_profit := (v_total_cents - v_total_cost_cents) / 100.0;
  PERFORM _insert_commissions_for_order(
    v_order_id, p_customer_id, v_order_profit,
    v_split, (now() AT TIME ZONE 'America/Chicago')::date
  );

  -- U9: short-stock WARN emit (mirrors the credit-limit warn+notify pattern above).
  IF v_short_count > 0 THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('quick_delivery_short_stock',
      'WARNING: Quick delivery ' || v_delivery_number || ' for "' || v_customer.farm_name ||
        '" created with ' || v_short_count || ' product(s) short on stock: ' ||
        array_to_string(v_stock_warnings, ' | ') ||
        '. Delivery proceeded; net inventory may be negative — review with the warehouse.',
      v_actor, 'delivery', v_delivery_id, p_customer_id);
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (v_admin.id,
        'Short Stock — Quick Delivery ' || v_delivery_number,
        'Quick delivery ' || v_delivery_number || ' for ' || v_customer.farm_name ||
          ' was created but ' || v_short_count || ' product(s) did not have enough stock: ' ||
          array_to_string(v_stock_warnings, ' | ') ||
          '. The delivery proceeded; please review inventory.',
        'stock_warning', 'delivery', v_delivery_id);
    END LOOP;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'order_created', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'order_number', v_order_number,
      'customer_id', p_customer_id,
      'customer_name', v_customer.farm_name,
      'total_cents', v_total_cents,
      'total_cost_cents', v_total_cost_cents,
      'is_quick_delivery', true,
      'delivery_id', v_delivery_id,
      'invoice_id', v_invoice_id,
      'credit_warning', v_credit_warning
    ),
    v_total_cents,
    'Quick delivery order ' || v_order_number || ' for ' || v_customer.farm_name ||
      ' — $' || (v_total_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'delivery_created', 'delivery', v_delivery_id, v_actor_role,
    jsonb_build_object(
      'delivery_number', v_delivery_number,
      'order_id', v_order_id,
      'order_number', v_order_number,
      'customer_id', p_customer_id,
      'scheduled_date', p_scheduled_date,
      'assigned_driver', p_driver_id,
      'is_quick_delivery', true
    ),
    v_total_cents,
    'Delivery ' || v_delivery_number || ' scheduled for ' || p_scheduled_date::text ||
      ' (' || v_customer.farm_name || ')'
  );

  -- U9: additive result fields — warnings[] + stock_warning flag.
  v_result := jsonb_build_object('order_id', v_order_id, 'delivery_id', v_delivery_id, 'invoice_id', v_invoice_id,
    'order_number', v_order_number, 'delivery_number', v_delivery_number, 'invoice_number', v_invoice_number,
    'total_cents', v_total_cents, 'credit_warning', v_credit_warning,
    'stock_warning', (v_short_count > 0), 'short_stock_count', v_short_count,
    'warnings', to_jsonb(v_stock_warnings));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_quick_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;


-- ---------------------------------------------------------------------------
-- public.transfer_job_to_invoice — 12 CURRENT_DATE value(s) -> America/Chicago
-- Body copied byte-for-byte from 20260713060000_harden_field_split_sum100.sql
-- (verified md5 78b827f8509a2740ea9879364747c372 against live before conversion).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
  v_field_names text[];
  v_crop_types text[];
  v_crop_type text;
  v_total_acres numeric := 0;
  v_applicator_name text;
  v_vehicle_name text;
  v_field RECORD;
  v_billing RECORD;
  v_total_cost_cents bigint := 0;
  v_conversion RECORD;
  v_total_applied numeric;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-8 (G1 per-acre fee) locals
  v_fee jsonb;
  v_fee_total bigint := 0;
  v_fee_cost bigint := 0;
  v_fee_c bigint;
  v_cost_c bigint;
  v_fee_acres numeric := 0;
  -- U8 (#99 commissions on the application channel) locals
  v_commission_split jsonb;
  v_chem_profit_cents bigint := 0;
  -- U7 (#42/#100/#50 multi-owner group) locals
  v_n_owners integer := 0;
  v_group_id uuid;
  v_owner_ids uuid[];
  v_owner_names text[];
  v_owner_acres numeric[];
  v_owner_primary boolean[];
  v_total_billable_acres numeric := 0;
  v_acre_pcts numeric[];
  v_chem_price_split bigint[];
  v_chem_cost_split bigint[];
  v_oidx integer;
  v_member_id uuid;
  v_member_ids uuid[] := '{}';
  v_anchor_id uuid;
  v_member_acres numeric;
  v_member_total bigint;
  v_member_cost bigint;
  v_member_profit_cents bigint := 0;
  v_member_field_names text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- BEGIN DELTA-7 (G3 strict-actor): the role gate above is on auth.uid(), but
  -- p_performed_by was written verbatim to created_by / the activity log, so the
  -- recorded performer was forgeable. Bind the authenticated user and reject a
  -- mismatch (matches complete_job / start_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  -- END DELTA-7

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_job_to_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.* INTO v_job FROM jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  IF v_job.status = 'invoiced' THEN RAISE EXCEPTION 'Job already invoiced'; END IF;
  IF v_job.status != 'completed' THEN RAISE EXCEPTION 'Job must be completed to invoice (status: %)', v_job.status; END IF;

  -- U6 #91b: refuse to invoice the job if a blend ticket for the SAME job has already
  -- been billed (payment_status='billed' = a live, non-voided invoice exists for it).
  -- The blend-ticket invoice and this job invoice bill the same application, so
  -- allowing both double-bills the customer. Block, do not warn. (The
  -- trg_sync_blend_ticket_payment trigger resets billed->unbilled when that invoice
  -- is voided, so a genuine re-bill after a void is unaffected.)
  -- Codex R3 P2: test for a LIVE blend-ticket invoice directly (mirror of the
  -- opposite guard's invoices.job_id test) — payment_status can be written
  -- manually via update_blend_ticket_billing_status and drift out of sync.
  IF EXISTS (
    SELECT 1 FROM blend_tickets bt
    JOIN invoices i ON i.blend_ticket_id = bt.id
    WHERE bt.job_id = p_job_id
      AND bt.deleted_at IS NULL  -- Codex R2 P2: a soft-deleted ticket must not block forever
      AND i.status NOT IN ('voided', 'cancelled')
      AND i.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ALREADY_BILLED: a blend ticket for this job has already been billed; invoicing the job too would double-bill the customer. Void that blend-ticket invoice first if you meant to re-bill here.';
  END IF;

  FOR v_field IN
    SELECT jf.field_id, jf.acres_to_treat, f.field_name, f.crop_type AS f_crop_type
    FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY f.field_name
  LOOP
    v_field_names := array_append(v_field_names, v_field.field_name);
    v_total_acres := v_total_acres + COALESCE(v_field.acres_to_treat, 0);
    IF v_field.f_crop_type IS NOT NULL THEN v_crop_types := array_append(v_crop_types, v_field.f_crop_type); END IF;
  END LOOP;

  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    SELECT mode() WITHIN GROUP (ORDER BY unnest) INTO v_crop_type FROM unnest(v_crop_types);
  END IF;

  IF v_job.applicator_id IS NOT NULL THEN
    SELECT p.full_name INTO v_applicator_name FROM profiles p WHERE p.id = v_job.applicator_id;
  END IF;

  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT v.vehicle_name INTO v_vehicle_name FROM vehicles v WHERE v.id = v_job.vehicle_id;
  END IF;

  -- ==========================================================================
  -- U7 (#42 / #100 / #50): MULTI-OWNER per-owner invoice GROUP.
  -- Trigger ONLY on EXPLICIT multi-owner billing: >1 distinct field_billing_defaults
  -- customer across the job's fields (the landlord/tenant setup the finding is about).
  -- A job with NO billing defaults keeps today's single-invoice behavior, even if its
  -- fields belong to different customers — no surprise change. In the group path, any
  -- field WITHOUT billing defaults falls back to the field's own customer at 100%
  -- (mirror of create_split_invoices_from_order).
  -- ==========================================================================
  SELECT count(DISTINCT fbd.customer_id) INTO v_n_owners
    FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id;

  IF COALESCE(v_n_owners, 0) > 1 THEN
    -- Scope guard: per-field $/acre overrides are not supported by the percentage/acre
    -- split. Refuse rather than silently drop an override the single-invoice path honors.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'SPLIT_OVERRIDE_UNSUPPORTED: this multi-owner job has per-field $/acre price overrides. Percentage split billing does not support overrides — bill it as a single invoice, or price each owner in the field-application editor.';
    END IF;

    -- Validate every billed field's splits total 100 (mirror FIELD_SPLIT_NOT_100), so the
    -- owner acre shares sum to the job acres and calculate_billing_splits stays penny-exact.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id
      GROUP BY jf.field_id HAVING sum(fbd.split_pct) < 99.99 OR sum(fbd.split_pct) > 100.01
    ) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
    END IF;

    -- Ordered owner arrays (stable ORDER BY owner_id) with each owner's BILLABLE ACRES:
    -- fbd fields contribute acres_to_treat * split_pct/100; non-fbd fields contribute
    -- their full acres to the field's own customer.
    SELECT array_agg(owner_id ORDER BY owner_id),
           array_agg(farm_name ORDER BY owner_id),
           array_agg(billable_acres ORDER BY owner_id),
           array_agg(is_primary ORDER BY owner_id)
      INTO v_owner_ids, v_owner_names, v_owner_acres, v_owner_primary
    FROM (
      SELECT owner_id,
             sum(billable_acres) AS billable_acres,
             bool_or(is_primary) AS is_primary,
             max(farm_name) AS farm_name
      FROM (
        SELECT fbd.customer_id AS owner_id,
               COALESCE(jf.acres_to_treat, 0) * fbd.split_pct / 100.0 AS billable_acres,
               COALESCE(fbd.is_primary, false) AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN customers c ON c.id = fbd.customer_id
          WHERE jf.job_id = p_job_id
        UNION ALL
        SELECT COALESCE(f.customer_id, v_job.customer_id) AS owner_id,
               COALESCE(jf.acres_to_treat, 0) AS billable_acres,
               false AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN fields f ON f.id = jf.field_id
          JOIN customers c ON c.id = COALESCE(f.customer_id, v_job.customer_id)
          WHERE jf.job_id = p_job_id
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) parts
      GROUP BY owner_id
    ) oa;

    v_total_billable_acres := COALESCE((SELECT sum(a) FROM unnest(v_owner_acres) a), 0);
    IF v_total_billable_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_NO_ACRES: cannot split a multi-owner job with zero billable acres (job %)', v_job.job_number;
    END IF;

    -- Acre-share percentages across owners (sum to exactly 100 -> penny-exact splits).
    SELECT array_agg(a / v_total_billable_acres * 100 ORDER BY ord)
      INTO v_acre_pcts FROM unnest(v_owner_acres) WITH ORDINALITY AS u(a, ord);

    v_group_id := gen_random_uuid();

    -- Create one draft invoice per owner (empty; filled in the chemical/fee loops below).
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_acres := v_owner_acres[v_oidx];

      -- Fields this owner is billed for (informational header list).
      SELECT array_agg(DISTINCT fname ORDER BY fname) INTO v_member_field_names FROM (
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND fbd.customer_id = v_owner_ids[v_oidx]
        UNION
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND f.customer_id = v_owner_ids[v_oidx]
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) mf;

      v_invoice_number := next_invoice_number('field_application');
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
        field_names, crop_type, total_acres, applicator_name, vehicle_name,
        application_date, header_notes, season, created_by, job_id,
        application_service_id, invoice_group_id
      ) VALUES (
        v_invoice_number, v_owner_ids[v_oidx], 'field_application', 'draft',
        (now() AT TIME ZONE 'America/Chicago')::date, ((now() AT TIME ZONE 'America/Chicago')::date + interval '30 days')::date,
        0, 0, 0, 0,
        COALESCE(v_member_field_names, v_field_names), v_crop_type, v_member_acres, v_applicator_name, v_vehicle_name,
        v_job.job_date, v_job.notes,
        COALESCE(
          v_job.season,
          CASE WHEN extract(month FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10
               THEN extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer + 1
               ELSE extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer END
        ),
        p_performed_by, p_job_id, v_job.application_service_id, v_group_id
      ) RETURNING id INTO v_member_id;
      v_member_ids := array_append(v_member_ids, v_member_id);
    END LOOP;

    -- Chemical lines: split each chemical's agreed price/cost across owners BY acre share
    -- (penny-exact). qty / applied-acres are prorated by the same share.
    v_item_order := 0;
    FOR v_chem IN
      SELECT jc.product_id, jc.rate_per_acre,
             safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
             safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
             jc.quantity,
             jc.customer_supplied,
             p.product_name, p.unit_size, p.epa_registration, p.product_form,
             COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
      FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
      WHERE jc.job_id = p_job_id ORDER BY p.product_name
    LOOP
      v_item_order := v_item_order + 1;
      -- customer-supplied products carry $0 price AND $0 cost (we didn't buy them).
      v_chem_price_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END, v_acre_pcts);
      v_chem_cost_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END, v_acre_pcts);

      FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
        v_member_acres := v_owner_acres[v_oidx];
        -- Owner's applied amount = rate x their acres (their slice of the uniform-rate
        -- application). The line quantity stays 1 (a single job-chemical line, matching
        -- the single-owner path where unit_price == extended); the real applied amount
        -- lives in total_applied / total_applied_gl_lb.
        v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_member_acres > 0
          THEN v_chem.rate_per_acre * v_member_acres ELSE NULL END;
        SELECT * INTO v_conversion
          FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
          epa_registration, product_form, is_application_fee, price_source
        ) VALUES (
          v_member_ids[v_oidx], v_chem.product_id,
          CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
          1,
          v_chem.unit_size,
          v_chem_price_split[v_oidx],
          v_chem_price_split[v_oidx],
          v_chem_cost_split[v_oidx],
          v_item_order, v_member_acres,
          v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
          COALESCE(v_chem.rate_unit, v_chem.unit_size),
          v_conversion.converted_value, v_conversion.converted_unit,
          v_chem.epa_registration, v_chem.product_form, false,
          CASE WHEN v_chem.customer_supplied THEN 'manual' ELSE NULL END
        );
      END LOOP;
    END LOOP;

    -- Per-owner totals, per-acre application fee, header flip, and per-member commission.
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      v_member_acres := v_owner_acres[v_oidx];

      SELECT COALESCE(SUM(extended_cents), 0), COALESCE(SUM(cost_cents), 0)
        INTO v_member_total, v_member_cost
        FROM invoice_items WHERE invoice_id = v_member_id;

      -- DELTA-8 per-acre machine fee at this owner's own rate, on this owner's acres.
      IF v_job.application_service_id IS NOT NULL AND v_member_acres > 0 THEN
        v_fee := compute_application_service_fee(
                   v_job.application_service_id, v_owner_ids[v_oidx], v_member_acres, v_job.season);
        v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
        v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
        IF v_fee_c > 0 THEN
          v_item_order := v_item_order + 1;
          INSERT INTO invoice_items (
            invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
            cost_cents, sort_order, acres, rate_per_acre, rate_unit,
            is_application_fee, price_source
          ) VALUES (
            v_member_id, COALESCE(v_fee->>'service_name', 'Application'), v_member_acres, 'acre',
            ROUND(v_fee_c / v_member_acres)::bigint, v_fee_c,
            v_cost_c, v_item_order, v_member_acres,
            ROUND(v_fee_c / v_member_acres)::bigint, 'acre',
            true, 'tier'
          );
          v_member_total := v_member_total + v_fee_c;
          v_member_cost  := v_member_cost + v_cost_c;
        END IF;
      END IF;

      UPDATE invoices SET total_amount_cents = v_member_total, total_cost_cents = v_member_cost
        WHERE id = v_member_id;

      -- one invoice_shares row (100% of this member -> itself) so statements/year-end read it.
      INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
      VALUES (v_member_id, v_owner_ids[v_oidx], v_owner_names[v_oidx], 100.0, v_member_acres, v_member_total,
              COALESCE(v_owner_primary[v_oidx], false), v_oidx);

      -- DELTA-4: draft -> unposted now that the member is fully built.
      UPDATE invoices SET status = 'unposted' WHERE id = v_member_id;
    END LOOP;

    -- Commission split resolution (mirror of the single-owner path: snapshot on the job,
    -- else the parent quote's split, else the customer default for pre-U8 jobs).
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Anchor = the primary owner's member (else the first). jobs.invoice_id is a scalar,
    -- so it points at the anchor; siblings are found via invoices.invoice_group_id / job_id.
    -- v_member_ids[i] corresponds to v_owner_ids[i] / v_owner_primary[i] (same build order).
    v_anchor_id := v_member_ids[1];
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      IF COALESCE(v_owner_primary[v_oidx], false) THEN
        v_anchor_id := v_member_ids[v_oidx];
        EXIT;
      END IF;
    END LOOP;

    UPDATE jobs SET status = 'invoiced', invoice_id = v_anchor_id,
      commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
    WHERE id = p_job_id;
    UPDATE application_records SET invoice_id = v_anchor_id WHERE source_type = 'job' AND source_id = p_job_id;

    -- Per-member commission: on THAT member's chemical-line profit (product lines only,
    -- excludes the per-acre fee). Sum across members == the whole job's chemical profit.
    FOR v_oidx IN 1 .. array_length(v_member_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
        INTO v_member_profit_cents
      FROM invoice_items ii
      WHERE ii.invoice_id = v_member_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      PERFORM _insert_commissions_for_job(
        p_job_id, v_member_id, v_owner_ids[v_oidx],
        v_member_profit_cents::numeric / 100.0,
        v_commission_split,
        (now() AT TIME ZONE 'America/Chicago')::date
      );

      -- Per-member creation audit row (mirror of the single path's invoice_created row).
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_user_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_member_id, auth.uid(),
        (SELECT role FROM profiles WHERE id = auth.uid()),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_member_id),
          'job_id', p_job_id,
          'customer_id', v_owner_ids[v_oidx],
          'invoice_group_id', v_group_id,
          'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_member_id)
        ),
        (SELECT total_amount_cents FROM invoices WHERE id = v_member_id),
        'Split invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_member_id) ||
          ' created from job ' || v_job.job_number || ' (per-owner group)'
      );
    END LOOP;

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('job_invoiced',
      'Job ' || v_job.job_number || ' transferred to a ' || array_length(v_member_ids, 1) ||
        '-owner split invoice group',
      COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

    v_result := jsonb_build_object(
      'success', true, 'job_id', p_job_id,
      'invoice_id', v_anchor_id,
      'invoice_ids', to_jsonb(v_member_ids),
      'invoice_group_id', v_group_id,
      'invoice_count', array_length(v_member_ids, 1),
      'split', true
    );

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
    END IF;

    RETURN v_result;
  END IF;
  -- ================= end multi-owner group path =================

  -- Fail-safe for legacy single-owner defaults that predate the deferred table guard.
  -- Match the multi-owner FIELD_SPLIT_NOT_100 validation before creating any invoice rows.
  IF EXISTS (
    SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id
    GROUP BY jf.field_id HAVING sum(fbd.split_pct) < 99.99 OR sum(fbd.split_pct) > 100.01
  ) THEN
    RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
  END IF;

  -- OVERNIGHT FIX (Run 2 cycle 6 — invoice-number canonicalization, Codex-confirmed MEDIUM):
  -- use the shared next_invoice_number() — the SAME invoice_number_seq, 'invoice_number:INV:<year>'
  -- advisory lock, and setval self-heal that every other invoice creator AND the
  -- invoices.invoice_number column default use. The previous inline
  -- `pg_advisory_xact_lock(hashtext('invoice_number'))` + MAX(regexp_replace(...))+1 scan took a
  -- DIFFERENT advisory-lock key, so it did not serialize against other INV creators (two callers
  -- could compute the same number -> 23505 on the UNIQUE index invoices_invoice_number_key,
  -- aborting the transfer) and it never advanced invoice_number_seq.
  v_invoice_number := next_invoice_number('field_application');

  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres, applicator_name, vehicle_name,
    application_date, header_notes, season, created_by, job_id,
    application_service_id
  ) VALUES (
    -- insert as 'draft' (DELTA-1) — trg_invoice_draft_insert rejects non-draft,
    -- non-credit_memo inserts; DELTA-4 flips to 'unposted' once fully built.
    v_invoice_number, v_job.customer_id, 'field_application', 'draft',
    (now() AT TIME ZONE 'America/Chicago')::date, ((now() AT TIME ZONE 'America/Chicago')::date + interval '30 days')::date,
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    v_job.job_date, v_job.notes,
    -- N2-7 #109<<< stamp the JOB's season, not the season-of-now. An invoice cut in a
    -- later season for a prior-season job must file under the job's season (reports/
    -- year-end read invoices.season). invoices.season is NOT NULL and jobs.season is
    -- nullable, so COALESCE back to the ORIGINAL CURRENT_DATE-based expression when the
    -- job has no season — never stamp NULL, and legacy null-season jobs behave exactly
    -- as before this migration.
    COALESCE(
      v_job.season,
      CASE WHEN extract(month FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10
           THEN extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer + 1
           ELSE extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::integer END
    ),
    -- >>>N2-7 #109
    p_performed_by, p_job_id, v_job.application_service_id
  ) RETURNING id INTO v_invoice_id;

  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre,
           safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
           safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
           jc.customer_supplied,
           p.product_name, p.unit_size, p.epa_registration, p.product_form,
           COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    -- U4<<< a grower-supplied product costs us nothing (we didn't buy it) — keep
    -- it OUT of the invoice cost so margin isn't understated. (#53/#54)
    v_total_cost_cents := v_total_cost_cents + CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END;
    -- >>>U4
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    -- DELTA-6: call convert_to_gl_lb unconditionally so v_conversion always receives a
    -- tuple structure (the helper returns one row even for NULL inputs); an unrated line
    -- yields (NULL, NULL) without leaving v_conversion unassigned.
    SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, acres, rate_per_acre, rate_unit,
      total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form, is_application_fee, price_source
    ) VALUES (
      v_invoice_id, v_chem.product_id,
      -- U4<<< customer-supplied: keep the line (legal/application record) but at $0
      -- with a labeled description; force cost + price to 0. price_source='manual'
      -- pins the $0 (Codex R5 P1: a product-backed $0 line without it would be
      -- re-priced by tier when the unposted invoice is edited + re-saved). (#53/#54)
      CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
      1,
      v_chem.unit_size,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END,
      -- >>>U4
      v_item_order, v_total_acres,
      v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit_size),
      v_conversion.converted_value, v_conversion.converted_unit,
      v_chem.epa_registration, v_chem.product_form, false,
      CASE WHEN v_chem.customer_supplied THEN 'manual' ELSE NULL END
    );
  END LOOP;

  UPDATE invoices SET total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;

  IF EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id) THEN
    SELECT EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL) INTO v_has_price_override;
    FOR v_share IN
      SELECT fbd.customer_id, c.farm_name,
        CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct) END AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
            THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
            ELSE avg(fbd.split_pct) END / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        CASE WHEN count(DISTINCT fbd.price_override_cents) = 1 AND min(fbd.price_override_cents) IS NOT NULL
          THEN min(fbd.price_override_cents) ELSE NULL END AS price_override_cents,
        max(fbd.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord
      FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE v_amount bigint; v_ppa bigint;
      BEGIN
        IF v_share.price_override_cents IS NOT NULL THEN
          v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres);
          v_ppa := v_share.price_override_cents;
        ELSE
          v_amount := ROUND(COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)::bigint;
          v_ppa := NULL;
        END IF;
        INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents, pricing_note)
        VALUES (v_invoice_id, v_share.customer_id, v_share.farm_name, v_share.avg_split_pct, v_share.share_acres, v_amount, v_share.is_primary, v_share.sort_ord, v_ppa, v_share.pricing_note);
        v_share_total := v_share_total + v_amount;
      END;
    END LOOP;
    -- OVERNIGHT FIX (Run 2 cycle 2, finding #3 — penny-drift): reconcile the header to the share
    -- sum for BOTH the override AND the percentage-split path (was override-only). Independent
    -- per-customer ROUND(total_price_cents * pct/100) can drift ±1c on odd-cent splits, so without
    -- this the percentage-split header stayed at total_price_cents while invoice_shares summed a cent
    -- off — and get_customer_year_end_summary / get_detailed_statement_data read invoice_shares.amount_cents,
    -- so statements wouldn't tie. v_share_total is the exact sum of the shares; DELTA-8 then adds the
    -- per-acre fee to both shares and header, preserving the tie. The single-customer ELSE branch
    -- already inserts header = its one share, so it ties without this.
    UPDATE invoices SET total_amount_cents = v_share_total WHERE id = v_invoice_id;
  ELSE
    INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
    SELECT v_invoice_id, v_job.customer_id, c.farm_name, 100.0, v_total_acres, COALESCE(v_job.total_price_cents, 0), true, 1
    FROM customers c WHERE c.id = v_job.customer_id;
  END IF;

  -- DELTA-8 (G1 per-acre application fee, PER-CUSTOMER rate): now that invoice_shares exist,
  -- charge each billed customer the per-acre machine fee at that customer's own rate; add each
  -- customer's fee to their share, emit one is_application_fee line, fold into the header.
  IF v_job.application_service_id IS NOT NULL AND v_total_acres > 0 THEN
    FOR v_share IN
      SELECT id, customer_id, COALESCE(acres, 0) AS acres, price_per_acre_cents
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    LOOP
      -- A grower on a price_override (all-inclusive $/acre) does NOT also pay the per-acre
      -- machine fee, or they'd be double-charged (mirrors save_field_app_invoice).
      IF v_share.price_per_acre_cents IS NOT NULL THEN CONTINUE; END IF;
      v_fee := compute_application_service_fee(
                 v_job.application_service_id, v_share.customer_id, v_share.acres, v_job.season);
      v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
      v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
      v_fee_total := v_fee_total + v_fee_c;
      v_fee_cost  := v_fee_cost  + v_cost_c;
      v_fee_acres := v_fee_acres + v_share.acres;
      IF v_fee_c <> 0 THEN
        UPDATE invoice_shares SET amount_cents = amount_cents + v_fee_c WHERE id = v_share.id;
      END IF;
    END LOOP;

    IF v_fee_total > 0 AND v_fee_acres > 0 THEN
      v_item_order := v_item_order + 1;
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, COALESCE(v_fee->>'service_name', 'Application'), v_fee_acres, 'acre',
        ROUND(v_fee_total / v_fee_acres)::bigint, v_fee_total,
        v_fee_cost, v_item_order, v_fee_acres,
        ROUND(v_fee_total / v_fee_acres)::bigint, 'acre',
        true, 'tier'
      );
      UPDATE invoices SET
        total_amount_cents = COALESCE(total_amount_cents, 0) + v_fee_total,
        total_cost_cents   = total_cost_cents + v_fee_cost
      WHERE id = v_invoice_id;
    END IF;
  END IF;
  -- END DELTA-8

  -- U8<<< (#99): resolve the commission split. New jobs carry a creation-time
  -- snapshot (quote-born: the quote's split via create_job_from_quote_section;
  -- direct: the customer default via trg_jobs_snapshot_commission_split), so this
  -- fallback only fires for PRE-U8 jobs. Order-channel parity (Codex R3 P1): a
  -- quote-born job uses the parent quote's split and ONLY that — convert_quote_to_order
  -- passes only v_quote.commission_split, so a NULL quote split pays no commission,
  -- never the customer default. A pre-U8 direct job uses the customer default, like
  -- a direct order. Codex R2 P2: the resolved fallback is PERSISTED onto the job in
  -- the same UPDATE that flips it to 'invoiced', so attribution locks at first use.
  v_commission_split := v_job.commission_split;
  IF v_commission_split IS NULL THEN
    IF v_job.quote_id IS NOT NULL THEN
      SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
    ELSE
      SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
    END IF;
  END IF;
  -- >>>U8

  UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_id,
    -- U8 (Codex R2 P2 + R4 P1): persist the resolution — even a nothing-anywhere
    -- result locks as the empty sentinel so re-invoices never re-read live sources.
    commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
  WHERE id = p_job_id;
  UPDATE application_records SET invoice_id = v_invoice_id WHERE source_type = 'job' AND source_id = p_job_id;

  -- DELTA-4: invoice was inserted as 'draft'; flip to 'unposted' now that items, shares and
  -- totals are final. draft -> unposted is allowed by _enforce_invoice_status_transition.
  UPDATE invoices SET status = 'unposted' WHERE id = v_invoice_id;

  -- U8<<< (#99): mint the application-channel commissions — chemical-line profit only.
  -- Mirror of the order channel (convert_quote_to_order → _insert_commissions_for_order).
  -- Profit basis: the chemical lines just written to THIS invoice. The per-acre machine
  -- fee (is_application_fee=true, product_id NULL) is excluded per the owner rule, and
  -- customer-supplied lines carry $0 price AND $0 cost so they contribute exactly 0.
  -- invoice_items money is bigint CENTS; commissions are numeric DOLLARS → /100.0.
  -- The helper no-ops on a NULL/splits-less split and validates a present one
  -- (COMMISSION_SPLIT_INVALID aborts, matching the order-conversion behavior).
  -- Pending amounts stay in sync with later unposted-invoice edits via the
  -- recompute in the item-rewrite path (Codex R2 P1), mirroring update_order_items.
  SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
    INTO v_chem_profit_cents
  FROM invoice_items ii
  WHERE ii.invoice_id = v_invoice_id
    AND COALESCE(ii.is_application_fee, false) = false
    AND ii.product_id IS NOT NULL;

  PERFORM _insert_commissions_for_job(
    p_job_id, v_invoice_id, v_job.customer_id,
    v_chem_profit_cents::numeric / 100.0,
    v_commission_split,
    (now() AT TIME ZONE 'America/Chicago')::date
  );
  -- >>>U8

  -- DELTA-5: log to activity_feed (performed_by NOT NULL: COALESCE to auth.uid()).
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('job_invoiced',
    'Job ' || v_job.job_number || ' transferred to invoice ' || v_invoice_number,
    COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

  -- OVERNIGHT FIX (finding #3): write the canonical 'invoice_created' financial_audit_log row
  -- the other six invoice creators write, so the append-only money ledger records creation
  -- provenance for job-built invoices too. Read the FINAL header total back (DELTA-8 may have
  -- adjusted it). Shape mirrors save_field_app_invoice's invoice_created row.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id, auth.uid(),
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'job_id', p_job_id,
      'customer_id', v_job.customer_id,
      'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id)
    ),
    (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id),
    'Invoice ' || v_invoice_number || ' created from job ' || v_job.job_number
  );

  v_result := jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  r record;
  v_seen int := 0;
  v_code text;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc, p.prosecdef, p.proconfig, p.proowner::regrole::text AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('_convert_quote_to_order_owner_impl', '_draw_down_quote_below_cost_impl_20260810', '_create_quick_delivery_intent_impl_20260802', 'transfer_job_to_invoice')
  LOOP
    v_seen := v_seen + 1;

    -- Strip comment tails before counting, so a CURRENT_DATE mentioned in prose cannot
    -- fail this and a real one cannot hide behind it.
    v_code := (
      SELECT string_agg(
               CASE WHEN position('--' in l) > 0 THEN left(l, position('--' in l) - 1) ELSE l END,
               E'\n')
        FROM regexp_split_to_table(r.prosrc, E'\n') AS l
    );

    IF v_code ~* '\mcurrent_date\M' THEN
      RAISE EXCEPTION
        'POSTFLIGHT_UTC_RESIDUAL: public.% still evaluates CURRENT_DATE in code after conversion; a document date would still follow the UTC clock.', r.proname;
    END IF;

    IF (SELECT count(*) FROM regexp_matches(r.prosrc, 'America/Chicago', 'g')) < 1 THEN
      RAISE EXCEPTION 'POSTFLIGHT_CHICAGO: public.% carries no America/Chicago conversion.', r.proname;
    END IF;

    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'POSTFLIGHT_OWNER: public.% changed owner to %.', r.proname, r.owner;
    END IF;
  END LOOP;
  IF v_seen <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_MISSING: expected 4 writers, found %.', v_seen;
  END IF;
END;
$postflight$;

COMMIT;
