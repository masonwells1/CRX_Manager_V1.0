-- CRX-MONEY-001 — blend-ticket order creation could hard-fail on a fractional quantity.
--
-- Raised by the exact-SHA gpt-5.6-sol push-proof review of PR #371 and confirmed
-- against the live database on 2026-08-11.
--
-- WHAT WAS WRONG
-- `create_order_from_blend_ticket` accumulated `v_price * v_qty_conv` and
-- `v_cost * v_qty_conv` per line WITHOUT rounding, then overwrote the order
-- header with those raw sums. A permitted input such as $0.01 x 0.5 units
-- produces $0.005, which is not a whole cent.
--
-- Live migration 20260810151000 (history row 870) added
-- `orders_total_cost_whole_cents_chk` and `orders_total_profit_whole_cents_chk`.
-- Those constraints are VALID and enforced today, so the raw write could raise
-- check_violation and roll back the ENTIRE order creation — a live UI path from
-- src/pages/BlendTicketDetail.tsx. Exposure at the time of writing is nil only
-- because `blend_tickets` and `blend_ticket_products` are both empty; the button
-- is live and the first fractional-quantity ticket would have hit this.
--
-- WHY THE OVERWRITE WAS ALSO REDUNDANT
-- Every `INSERT INTO order_items` in the loop already fires, in order:
--   1. `trg_order_items_round_money` (BEFORE INSERT/UPDATE FOR EACH ROW) — rounds
--      `order_items.total_price` to whole cents and DERIVES `order_items.profit`
--      from whole-cent components.
--   2. `after_order_items_change` -> `trg_recalc_order_totals` (AFTER
--      INSERT/UPDATE/DELETE FOR EACH ROW) — recomputes the whole order header as
--      `SUM(ROUND(total_price,2))` and `SUM(ROUND(cost_per_unit*total_units_needed,2))`
--      and writes ROUND(...,2) into total_price, total_cost, total_profit and
--      total_margin_pct.
-- So by the time the loop ends the header is ALREADY canonical and already whole
-- cents. The manual UPDATE did not just risk a constraint violation; it replaced
-- correct trigger-derived numbers with a raw sum-then-round value that can differ
-- from the canonical sum-of-rounded-lines by a cent, and it wrote an UNROUNDED
-- `total_margin_pct` where every other order path writes a rounded one.
--
-- THE DELTA
-- Exactly one change to a body that is otherwise verbatim from live
-- (raw md5 19e08adc9d62e13b7482210f6167734d, LF-normalized
-- c056d2bf1200fd0fb73a0da54941a8d9, single overload): the manual
-- `UPDATE orders SET total_price = ...` block is replaced by a re-read of the
-- canonical header into the same two variables, so the value returned in the
-- result JSON is the value actually stored, followed by a postcondition that
-- fails the call if that header is not the canonical sum of the rounded lines.
-- The postcondition is what keeps "let the trigger do it" from degrading into a
-- silent zero-value order if the trigger is ever dropped: §0b can only prove the
-- triggers exist at APPLY time, and nothing but this check covers RUN time.
-- No new variables are declared, so the delta stays one contiguous block.
-- Authorization (AUTH_REQUIRED /
-- ACTOR_MISMATCH / INSUFFICIENT_ROLE), the idempotency check/save pair, the
-- FOR UPDATE ticket lock, SECURITY DEFINER, `search_path = public, pg_temp`,
-- ownership and grants are all unchanged and re-asserted below.
--
-- SCOPE — this is the ONLY unsafe writer to the constrained header columns.
-- A live pg_proc scan on 2026-08-11 found five functions that write
-- orders.total_price/total_cost/total_profit:
--   * trg_recalc_order_totals               — canonical, rounds. SAFE.
--   * draw_down_quote                       — ROUNDs each line, sums rounded. SAFE.
--   * _create_quick_delivery_intent_impl_20260802 — integer cents / 100.0. SAFE.
--   * _update_order_items_impl              — writes total_price only, which is
--     deliberately still UNCONSTRAINED (see row 870); unchanged here and still
--     the reason orders.total_price cannot yet take a CHECK.
--   * create_order_from_blend_ticket        — this one. Fixed below.
--
-- Behaviour is proved end-to-end, against real Postgres and rolled back, by
-- scripts/smoke/smoke-blend-ticket-fractional-cents.sql. This file asserts only
-- the preconditions and the resulting structure.

-- §0 PRECONDITION — refuse to apply against a body this delta was not written
-- against. Compared LF-normalized so a CRLF checkout and a clean LF rebuild both
-- satisfy it.
DO $precondition$
DECLARE
  v_overloads int;
  v_md5       text;
BEGIN
  SELECT count(*), max(md5(replace(p.prosrc, chr(13) || chr(10), chr(10))))
    INTO v_overloads, v_md5
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'create_order_from_blend_ticket';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'BLEND_TICKET_TOTALS_PRECONDITION: expected exactly 1 public.create_order_from_blend_ticket overload, found %',
      v_overloads;
  END IF;

  IF v_md5 IS DISTINCT FROM 'c056d2bf1200fd0fb73a0da54941a8d9' THEN
    RAISE EXCEPTION
      'BLEND_TICKET_TOTALS_PRECONDITION: live body (LF-normalized md5 %) is not the reviewed baseline c056d2bf1200fd0fb73a0da54941a8d9 — the function drifted, re-review before replacing it',
      v_md5;
  END IF;
END;
$precondition$;

-- §0b PRECONDITION — the fix RELIES on the two order_items triggers still being
-- attached. If either is gone, dropping the manual UPDATE would leave the header
-- at the zeros the INSERT seeded, which is a money bug of its own. Fail closed.
--
-- Name and timing alone are not enough, so each half also pins:
--   * tgenabled IN ('O','A') — pg_trigger.tgenabled has FOUR values, not two.
--     'R' (replica-only) is not 'D', but it does NOT fire for an ordinary origin
--     session, so a `<> 'D'` test would pass while the header went unwritten.
--   * tgconstraint = 0 — a constraint trigger can be DEFERRABLE INITIALLY
--     DEFERRED, which fires at COMMIT, i.e. after the re-read below. The stored
--     header would still end up right, but the value returned to the caller and
--     persisted into the idempotency receipt would be the seeded zero.
--   * tgqual IS NULL — a WHEN clause makes the trigger fire for a subset of rows.
--   * tgfoid — the trigger must still call the function this delta reasons about.
--     A repointed trigger of the same name would otherwise satisfy every bit test.
-- Live catalog read 2026-08-11 before authoring: both are 'O', tgconstraint 0,
-- not deferrable, no WHEN clause, pointing at the two functions named here.
--
-- tgfoid pins WHICH function the AFTER trigger calls, not WHAT that function
-- computes, and the run-time postcondition further down re-implements
-- trg_recalc_order_totals()'s summation expressions verbatim so it can compare
-- against the header the trigger wrote. That formula has already been rewritten
-- twice (20260311200000, then 20260809230500). A third rewrite would leave every
-- bit test above green and turn every blend-ticket order creation into a
-- BLEND_TICKET_HEADER_NOT_RECALCULATED failure in production. So pin the body
-- itself: md5(prosrc) of the live definition this delta was written against,
-- read from pg_proc on 2026-08-11 (prosrc length 1365). Whoever next rewrites
-- that trigger must update the copied expressions here in the same change, and
-- until they do this migration refuses to apply. A SQL-standard BEGIN ATOMIC
-- rewrite blanks prosrc rather than nulling it, so it fails this test too.
DO $trigger_precondition$
DECLARE
  v_before     int;
  v_after      int;
  v_recalc_md5 text;
BEGIN
  SELECT
    count(*) FILTER (
      WHERE t.tgname = 'trg_order_items_round_money'
        AND (t.tgtype & 1) > 0    -- FOR EACH ROW
        AND (t.tgtype & 2) > 0    -- BEFORE
        AND (t.tgtype & 4) > 0    -- INSERT
        AND t.tgenabled IN ('O', 'A')
        AND t.tgconstraint = 0
        AND t.tgqual IS NULL
        AND t.tgfoid = 'public._round_money_to_whole_cents()'::regprocedure
    ),
    count(*) FILTER (
      WHERE t.tgname = 'after_order_items_change'
        AND (t.tgtype & 1) > 0    -- FOR EACH ROW
        AND (t.tgtype & 2) = 0    -- not BEFORE
        AND (t.tgtype & 4) > 0    -- INSERT
        AND t.tgenabled IN ('O', 'A')
        AND t.tgconstraint = 0
        AND t.tgqual IS NULL
        AND t.tgfoid = 'public.trg_recalc_order_totals()'::regprocedure
    )
    INTO v_before, v_after
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal
     AND n.nspname = 'public'
     AND c.relname = 'order_items';

  IF v_before <> 1 OR v_after <> 1 THEN
    RAISE EXCEPTION
      'BLEND_TICKET_TOTALS_PRECONDITION: order_items must carry one unconditional, non-deferred, origin-enabled BEFORE-INSERT trg_order_items_round_money calling public._round_money_to_whole_cents() (found %) and one AFTER-INSERT after_order_items_change calling public.trg_recalc_order_totals() (found %) — the header can only be left to the triggers while both fire for every ordinary insert',
      v_before, v_after;
  END IF;

  SELECT md5(p.prosrc)
    INTO v_recalc_md5
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'trg_recalc_order_totals'
     AND p.pronargs = 0;

  IF v_recalc_md5 IS DISTINCT FROM 'b1d61412adb90325b2a8599a52d929b6' THEN
    RAISE EXCEPTION
      'BLEND_TICKET_TOTALS_PRECONDITION: public.trg_recalc_order_totals() body is %, expected b1d61412adb90325b2a8599a52d929b6 — the run-time postcondition in this delta copies that function''s summation expressions verbatim, so the two must be changed together',
      COALESCE(v_recalc_md5, '<missing>');
  END IF;
END;
$trigger_precondition$;

CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_ticket      blend_tickets%ROWTYPE;
  v_order_id    uuid;
  v_customer    customers%ROWTYPE;
  v_product     blend_ticket_products%ROWTYPE;
  v_db_product  products%ROWTYPE;
  v_item_id     uuid;
  v_tier        int;
  v_price       numeric;
  v_cost        numeric;
  v_total_price numeric := 0;
  v_total_cost  numeric := 0;
  v_item_count  int := 0;
  v_invalid_count int;
  v_link_result json;
  v_cached      jsonb;
  v_result      jsonb;
  -- A5: quantity converted to the product's inventory unit + the unit label to store
  v_qty_conv    numeric;
  v_unit_out    text;
  -- Per-blend-line mappings retain the ticket quantity/unit truth. The order
  -- line and inventory transaction may use a converted inventory-unit value.
  v_mappings    jsonb := '[]'::jsonb;
BEGIN
  -- A5-actor: reject a forged actor / non-admin up front, mirroring the two sibling
  -- blend-ticket RPCs (create_invoice_/create_application_record_from_blend_ticket).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create orders from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_order_from_blend_ticket');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached::json;
    END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices
     WHERE blend_ticket_id = p_blend_ticket_id
       AND deleted_at IS NULL
       AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ACTIVE_INVOICE_ORDER_LOCKED';
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;
  IF v_ticket.status <> 'completed' OR v_ticket.review_status <> 'approved' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket must be completed and approved before creating an order');
  END IF;
  IF v_ticket.payment_status <> 'unbilled' THEN
    RETURN json_build_object('success', false, 'error', 'Only an unbilled blend ticket can create an order');
  END IF;

  SELECT count(*) FILTER (
           WHERE btp.product_id IS NULL
              OR btp.quantity <= 0
              OR btp.quantity::text IN ('NaN', 'Infinity', '-Infinity')
              OR p.id IS NULL
              OR p.is_active IS DISTINCT FROM true
         )
    INTO v_invalid_count
    FROM blend_ticket_products btp
    LEFT JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id;

  IF NOT EXISTS (
    SELECT 1 FROM blend_ticket_products
     WHERE blend_ticket_id = p_blend_ticket_id
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no products');
  END IF;
  IF v_invalid_count > 0 THEN
    RETURN json_build_object('success', false, 'error', 'Every blend-ticket product must be matched to an active catalog product with a positive quantity');
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Customer not found');
  END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- CHANGED: Removed total_paid and balance_due from INSERT (AR tracked via invoices)
  v_order_id := gen_random_uuid();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, season, salesman_id, total_price, total_cost, total_profit, total_margin_pct)
  VALUES (
    v_order_id,
    p_order_number,
    v_ticket.customer_id,
    'confirmed',
    p_order_date,
    COALESCE(p_notes, 'Created from blend ticket ' || v_ticket.ticket_number),
    v_ticket.season,
    v_ticket.salesman_id,
    0, 0, 0, 0
  );

  FOR v_product IN
    SELECT * FROM blend_ticket_products
    WHERE blend_ticket_id = p_blend_ticket_id
    ORDER BY sequence_order
  LOOP
    v_price := 0;
    v_cost := 0;
    -- A5: default for an unmatched product (no product row) — no price, no conversion.
    v_qty_conv := v_product.quantity;
    v_unit_out := COALESCE(v_product.unit, 'ea');

    IF v_product.product_id IS NOT NULL THEN
      SELECT * INTO v_db_product FROM products WHERE id = v_product.product_id;
      IF FOUND THEN
        v_price := CASE v_tier
          WHEN 1 THEN COALESCE(v_db_product.tier1_price, 0)
          WHEN 2 THEN COALESCE(v_db_product.tier2_price, 0)
          WHEN 3 THEN COALESCE(v_db_product.tier3_price, 0)
          ELSE COALESCE(v_db_product.tier1_price, 0)
        END;
        v_cost := COALESCE(v_db_product.current_cost, 0);
        -- A5: convert the stored quantity (in v_product.unit) to the inventory unit
        -- so total_price, prebook, and the inventory txn all use the pricing/stock unit.
        v_qty_conv := field_app_priced_quantity(
                        v_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_product.unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size)),
                        v_db_product.product_form);
        IF v_qty_conv IS NULL
           OR v_qty_conv <= 0
           OR v_qty_conv::text IN ('NaN', 'Infinity', '-Infinity') THEN
          RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
            v_product.product_name, v_product.unit, COALESCE(v_db_product.inventory_unit, v_db_product.unit_size);
        END IF;
        v_unit_out := COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size, v_product.unit, 'ea');
      END IF;
    END IF;

    v_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      actual_rate, rate_unit, acres, total_units_needed, unit_size,
      total_price, profit, net_margin, quantity_delivered, quantity_remaining, sort_order
    )
    VALUES (
      v_item_id,
      v_order_id,
      v_product.product_id,
      v_product.product_name,
      v_price,
      v_cost,
      v_product.rate_per_acre,
      v_product.rate_per_acre_unit,
      v_ticket.total_acres,
      v_qty_conv,
      v_unit_out,
      v_price * v_qty_conv,
      (v_price - v_cost) * v_qty_conv,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_qty_conv,
      v_product.sequence_order
    );

    -- Preserve exact blend-line identity and source quantity for link validation.
    IF v_product.product_id IS NOT NULL THEN
      v_mappings := v_mappings || jsonb_build_object(
        'blend_product_id', v_product.id,
        'order_item_id', v_item_id,
        'quantity_applied', v_product.quantity
      );
    END IF;

    IF v_product.product_id IS NOT NULL AND v_qty_conv > 0 THEN
      INSERT INTO inventory (
        product_id, location, quantity_available,
        quantity_prebooked, quantity_on_order, unit_size, updated_at
      ) VALUES (
        v_product.product_id, 'Main Warehouse', 0,
        v_qty_conv, 0, v_unit_out, now()
      )
      ON CONFLICT (product_id, location) DO UPDATE
        SET quantity_prebooked = COALESCE(inventory.quantity_prebooked, 0)
                                 + EXCLUDED.quantity_prebooked,
            updated_at = now();

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_product.product_id, 'booked', v_qty_conv, 'Main Warehouse',
        v_order_id, p_performed_by,
        'Prebooked for blend ticket order ' || p_order_number
      );
    END IF;

    v_total_price := v_total_price + (v_price * v_qty_conv);
    v_total_cost := v_total_cost + (v_cost * v_qty_conv);
    v_item_count := v_item_count + 1;
  END LOOP;

  -- CRX-MONEY-001: the order header is NOT written here any more.
  --
  -- Each order_items INSERT above already fired trg_order_items_round_money
  -- (BEFORE, whole-cent line values) and then trg_recalc_order_totals (AFTER),
  -- which wrote the canonical ROUND(...,2) total_price / total_cost /
  -- total_profit / total_margin_pct derived from those rounded lines. The manual
  -- UPDATE that used to sit here wrote the RAW accumulators instead, which on a
  -- fractional converted quantity is a sub-cent value: it violated
  -- orders_total_cost_whole_cents_chk / orders_total_profit_whole_cents_chk and
  -- rolled the whole order back, and even when it fit it clobbered the canonical
  -- sum-of-rounded-lines with a differently-rounded number.
  --
  -- Re-read the header the triggers produced so the value reported to the caller
  -- is the value actually stored. The accumulators above are left intact so this
  -- body stays a one-block delta from the reviewed baseline.
  SELECT o.total_price, o.total_cost
    INTO v_total_price, v_total_cost
    FROM orders o
   WHERE o.id = v_order_id;

  -- Tested immediately, while FOUND still belongs to the SELECT above, so a
  -- vanished order row is diagnosed as such instead of being blamed on the
  -- trigger by the postcondition below.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'BLEND_TICKET_ORDER_HEADER_UNREADABLE: order % is not readable back after insert', v_order_id;
  END IF;

  -- ...and then PROVE the header was actually written. (One shape is outside the
  -- guard's reach: an order whose every line prices and costs to 0 has a canonical
  -- header of 0/0, which is exactly what the INSERT seeded, so it passes whether or
  -- not the trigger fired. That is not a money bug -- 0 IS the right answer there --
  -- but the guard is not literally proving trigger execution on every call.)
  --
  -- §0b proves both order_items triggers were attached at APPLY time. Nothing
  -- proves they are still attached at RUN time, and this body no longer has a
  -- fallback: if trg_recalc_order_totals were later dropped or disabled, the
  -- re-read above would return the 0/0/0/0 the INSERT seeded and the RPC would
  -- report `success: true` on a zero-value order — a silent money bug, strictly
  -- worse than the loud check_violation the old code would have raised. So
  -- assert the invariant this delta now depends on, inline: the stored header
  -- must equal the canonical sum of the whole-cent lines, computed here with the
  -- exact expressions trg_recalc_order_totals uses (live body read 2026-08-11).
  -- A mismatch aborts the transaction, so no order is booked on a broken header.
  -- Written as IF NOT EXISTS rather than PERFORM + IF NOT FOUND on purpose: the
  -- FOUND flag is set by whatever statement ran last, so any statement later
  -- inserted between the probe and the test would silently disarm the guard while
  -- leaving the error string below in place for the §1 self-verify to find. This
  -- form cannot be decoupled, and declares no new variables.
  -- Read the header straight out of orders rather than through the two variables
  -- above, so total_profit is covered too. total_profit carries one of the two
  -- validated whole-cent CHECKs this migration exists to stop tripping, and it is
  -- derived by the same trigger; leaving it unasserted would let a trigger that
  -- gets price and cost right but profit wrong pass the guard.
  IF NOT EXISTS (
    SELECT 1
      FROM orders o
      CROSS JOIN LATERAL (
        SELECT
          ROUND(COALESCE(SUM(ROUND(oi.total_price, 2)), 0), 2) AS canonical_price,
          ROUND(COALESCE(SUM(ROUND(COALESCE(oi.cost_per_unit, 0)
                                   * COALESCE(oi.total_units_needed, 0), 2)), 0), 2) AS canonical_cost
          FROM order_items oi
         WHERE oi.order_id = o.id
      ) canonical
     WHERE o.id = v_order_id
       AND o.total_price  IS NOT DISTINCT FROM canonical.canonical_price
       AND o.total_cost   IS NOT DISTINCT FROM canonical.canonical_cost
       AND o.total_profit IS NOT DISTINCT FROM
           ROUND(canonical.canonical_price - canonical.canonical_cost, 2)
  ) THEN
    RAISE EXCEPTION
      'BLEND_TICKET_HEADER_NOT_RECALCULATED: order % stored total_price=% total_cost=%, which is not the canonical sum of its rounded order_items — the order_items recalculation trigger did not run',
      v_order_id, v_total_price, v_total_cost;
  END IF;

  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, v_mappings, p_performed_by);
  IF COALESCE((v_link_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'BLEND_TICKET_ORDER_LINK_FAILED: %', COALESCE(v_link_result->>'error', 'unknown link failure');
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  v_result := jsonb_build_object(
     'success', true,
     'order_id', v_order_id,
     'order_number', p_order_number,
     'items_created', v_item_count,
     'total_price', v_total_price
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'create_order_from_blend_ticket',
      v_result
    );
  END IF;

  RETURN v_result::json;
END;
$function$;

-- caller-analysis: create_order_from_blend_ticket :: The one live caller is the
-- "Create Order" button in src/pages/BlendTicketDetail.tsx:945, a supabase.rpc()
-- from the browser client, which authenticates as the `authenticated` role. This
-- REVOKE/GRANT pair is a verbatim re-emission of the posture already live today
-- (live proacl on 2026-08-11: postgres=X, authenticated=X, service_role=X — anon
-- and PUBLIC already hold nothing). CREATE OR REPLACE preserves the existing ACL,
-- so this block only pins it; `authenticated` keeps EXECUTE and the UI callsite is
-- unaffected. Nothing calls this as anon: the function's own first three
-- statements raise AUTH_REQUIRED / ACTOR_MISMATCH / INSUFFICIENT_ROLE, so an
-- anon caller could never have completed it even when it was reachable.
REVOKE EXECUTE ON FUNCTION public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text)
  TO authenticated, service_role;

-- §1 SELF-VERIFY — assert in-database that the replacement kept every security
-- property and actually dropped the raw header write.
DO $self_verify$
DECLARE
  v_overloads   int;
  v_secdef      boolean;
  v_config      text[];
  v_owner       text;
  v_src         text;
  v_anon_grants int;
  v_expected    int;
BEGIN
  SELECT count(*) INTO v_overloads
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: expected 1 overload after replace, found %', v_overloads;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.proowner::regrole::text, p.prosrc
    INTO v_secdef, v_config, v_owner, v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket';

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: function is no longer SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: search_path is %, expected {search_path=public, pg_temp}', v_config;
  END IF;
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: owner is %, expected postgres', v_owner;
  END IF;

  -- The three authorization gates and both idempotency halves survived.
  IF v_src NOT LIKE '%AUTH_REQUIRED%'
     OR v_src NOT LIKE '%ACTOR_MISMATCH%'
     OR v_src NOT LIKE '%INSUFFICIENT_ROLE%'
     OR v_src NOT LIKE '%check_idempotency(p_idempotency_key%'
     OR v_src NOT LIKE '%save_idempotency(%'
     OR v_src NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: an authorization, idempotency or locking clause is missing from the replaced body';
  END IF;

  -- The delta itself: the raw header assignment is gone, the canonical re-read is present.
  IF v_src LIKE '%SET total_price = v_total_price%' THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: the raw order-header overwrite is still present';
  END IF;
  IF v_src NOT LIKE '%SELECT o.total_price, o.total_cost%' THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: the canonical header re-read is missing';
  END IF;
  -- The re-read is only safe while it is paired with the run-time postcondition
  -- that proves the trigger actually wrote the header. Losing the guard would
  -- turn a dropped trigger into a silent zero-value order.
  IF v_src NOT LIKE '%BLEND_TICKET_HEADER_NOT_RECALCULATED%' THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: the run-time header postcondition is missing';
  END IF;

  -- Grants posture: authenticated + service_role only, never anon or PUBLIC.
  SELECT count(*) INTO v_anon_grants
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF v_anon_grants <> 0 THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: anon or PUBLIC can execute the function';
  END IF;

  SELECT count(*) INTO v_expected
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket'
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_expected <> 1 THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_SELF_VERIFY: authenticated/service_role lost EXECUTE';
  END IF;
END;
$self_verify$;

-- §2 PROBE — prove the constraints this migration exists to stop tripping are
-- actually live and actually bite a sub-cent value. Runs entirely on a throwaway
-- temp table, touching no business row.
DO $probe$
DECLARE
  v_constraints int;
  v_rejected    boolean := false;
BEGIN
  SELECT count(*) INTO v_constraints
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'orders'
     AND c.contype = 'c'
     AND c.convalidated
     AND c.conname IN ('orders_total_cost_whole_cents_chk', 'orders_total_profit_whole_cents_chk');
  IF v_constraints <> 2 THEN
    RAISE EXCEPTION
      'BLEND_TICKET_TOTALS_PROBE: expected both validated whole-cent CHECKs on public.orders, found % — this migration is scoped to the schema row 870 created',
      v_constraints;
  END IF;

  CREATE TEMP TABLE _crx_money_001_probe (v numeric) ON COMMIT DROP;
  ALTER TABLE _crx_money_001_probe
    ADD CONSTRAINT _crx_money_001_probe_chk
    CHECK (v IS NULL OR (v = ROUND(v, 2) AND v > '-Infinity'::numeric AND v < 'Infinity'::numeric));

  BEGIN
    -- 0.01 * 0.5 — exactly the input Codex used. This is what the old raw write produced.
    INSERT INTO _crx_money_001_probe (v) VALUES (0.01 * 0.5);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'BLEND_TICKET_TOTALS_PROBE: the whole-cent predicate did NOT reject 0.005 — the premise of this fix is wrong';
  END IF;

  -- ...and the trigger-derived shape the function now relies on is accepted.
  INSERT INTO _crx_money_001_probe (v) VALUES (ROUND(0.01 * 0.5, 2));
END;
$probe$;
