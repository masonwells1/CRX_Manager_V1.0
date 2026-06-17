-- Feature (nightly-debug #1): multi-field split invoices, allocated by acres.
-- Migration B of 2: rewrite create_split_invoices_from_order to use the new
-- per-line field/acre attribution (order_item_field_allocations, Migration A).
--
-- THE TWO BUGS THIS REPLACES (verified live 2026-06-17):
--   1. Multi-field double-bill: the old body did `sum(split_pct) GROUP BY customer`
--      across ALL of the order's fields, then billed each customer that summed % of
--      EVERY line. Two fields each 100%-owned by different customers -> each summed to
--      100% -> each billed 100% of every line -> 200% of the order billed.
--   2. Penny drift: each customer's per-line share was `round()`d independently, so the
--      rounded shares could sum to +/- a cent off the line total.
--
-- THE NEW MATH (penny-exact by construction):
--   For each order line:
--     line_cents = round(total_price*100)
--     - if the line has NO field allocations -> the whole line bills to the order's
--       own customer (backward-compatible default; un-split lines are unchanged).
--     - else: split line_cents ACROSS the line's fields BY ACRES via
--       calculate_billing_splits (largest-remainder), then split each field's portion
--       AMONG that field's owners (field_billing_defaults) BY split_pct via
--       calculate_billing_splits again. Owners fall back to the field's own
--       customer at 100% when a field has no billing defaults.
--   Largest-remainder at each level guarantees: sum(field shares) = line_cents and
--   sum(owner shares) = field share, so every line reconciles to the penny and the
--   split invoices sum EXACTLY to the order total.
--   If an order has NO allocations on any line, we delegate to create_invoice_from_order
--   (a single invoice) — identical to today's effective behavior.
--
-- GUARD: each involved field's field_billing_defaults must sum to ~100% (the per-row
--   CHECK already bounds each 0<pct<=100; this catches a field whose owners don't total
--   100, which would mis-bill) -> FIELD_SPLIT_NOT_100.
--
-- SIGNATURE UNCHANGED (uuid[]; same 4 args + defaults), SECDEF + search_path preserved,
-- canonical operation-scoped idempotency preserved, invoice_group_id grouping preserved,
-- financial_audit_log 'invoice_created' rows preserved. No new RPC -> no fixture churn.
--
-- get_field_billing_splits_for_order is intentionally LEFT AS-IS: it derives from
-- quote_sections.field_id (which save_quote never persists, so it returns nothing) and
-- has no caller after this rewrite — superseded, harmless dead path. Not touched to keep
-- this migration's surface to the one function that matters.
--
-- DORMANT: 0 split invoices ever, 0 order_item_field_allocations rows. Validated by a
-- JWT-spoofed rolled-back smoke proving a 2-field/2-owner order bills each customer their
-- acre-weighted share to the penny.
--
-- Rollback: restore the prior body from migration 20260611001615_split_invoices_jsonb_fix.sql.

CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL::uuid,
  p_invoice_type text DEFAULT 'chemical_sale'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing text;
  v_order record;
  v_has_alloc boolean := false;
  v_existing_count int;
  v_delivery_count int;
  v_group_id uuid;
  v_invoice_id uuid;
  v_invoice_ids uuid[] := '{}';
  v_item record;
  v_alloc record;
  v_cust record;
  v_line_cents bigint;
  v_total_acres numeric;
  v_acre_pcts numeric[];
  v_field_cents bigint[];
  v_field_idx int;
  v_owner_ids uuid[];
  v_owner_pcts numeric[];
  v_owner_cents bigint[];
  v_owner_acres numeric;
  v_sum_pct numeric;
  v_oidx int;
  v_total_cents bigint;
  -- per-(customer, line) contribution accumulator; aggregated in pass 2.
  v_rows jsonb := '[]'::jsonb;
BEGIN
  -- Authorization (mirror create_invoice_from_order): creating invoices is admin/sales_rep only.
  -- The old split path was unreachable (quote_sections.field_id was never persisted), so it had
  -- no gate; making it reachable means it MUST gate here or any authenticated user (driver/applicator)
  -- could mint invoices via this SECURITY DEFINER RPC (Codex P1).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  -- Lock the order FIRST (mirror create_invoice_from_order's Codex-P1 lock): serializes against a
  -- concurrent delivery/invoice insert AND against a same-key retry, so the idempotency replay below
  -- runs only after any in-flight first call on this order has committed.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  -- Canonical operation-scoped idempotency replay, AFTER the order lock (draw_down_quote 2026-06-10
  -- pattern): a racing same-key retry blocks on the lock above, then resumes here and returns the
  -- cached invoice ids — instead of missing the still-uncommitted row pre-lock and then falsely
  -- erroring on the active-invoice guard below (Codex round-3 P2). result is a jsonb string; #>>'{}'
  -- extracts the bare "id1,id2" text so string_to_array sees no surrounding quotes.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result #>> '{}' INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_split_invoices_from_order';
    IF v_existing IS NOT NULL THEN RETURN string_to_array(v_existing, ',')::uuid[]; END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM order_item_field_allocations oifa
    JOIN order_items oi ON oi.id = oifa.order_item_id
    WHERE oi.order_id = p_order_id
  ) INTO v_has_alloc;

  -- No per-line field allocations anywhere on this order -> single invoice (unchanged).
  IF NOT v_has_alloc THEN
    v_invoice_id := create_invoice_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key);
    RETURN ARRAY[v_invoice_id];
  END IF;

  -- The split path inserts invoices DIRECTLY (the single-invoice path above delegates to
  -- create_invoice_from_order, which carries these guards). Replicate them so an allocated order
  -- that already has an active invoice or an active delivery cannot be double-billed (Codex P1).
  SELECT COUNT(*) INTO v_existing_count FROM invoices
    WHERE order_id = p_order_id AND status NOT IN ('voided', 'cancelled');
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;
  SELECT COUNT(*) INTO v_delivery_count FROM deliveries
    WHERE order_id = p_order_id AND status NOT IN ('cancelled', 'voided');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  -- Split-by-acre needs real line prices: a price-pending order would allocate $0 across fields
  -- (meaningless) and price_order cannot re-split a multi-customer invoice, so the single-invoice
  -- path's "create $0 drafts, sweep later" does not transfer here. Reject EXPLICITLY rather than
  -- silently produce no invoice (Codex round-2 P2). Price the order first, then split.
  IF EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND pricing_pending) THEN
    RAISE EXCEPTION 'PRICING_INCOMPLETE: price the order before generating split invoices';
  END IF;

  -- PASS 1: compute every (customer, line) cents + prorated qty into v_rows.
  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    v_line_cents := round(v_item.total_price * 100)::bigint;

    IF NOT EXISTS (SELECT 1 FROM order_item_field_allocations WHERE order_item_id = v_item.id) THEN
      -- Unallocated line: bill the whole line (incl. its full acres) to the order's own customer.
      v_rows := v_rows || jsonb_build_object(
        'c', v_order.customer_id, 'oi', v_item.id,
        'cents', v_line_cents, 'qty', COALESCE(v_item.total_units_needed, 0),
        'acres', COALESCE(v_item.acres, 0));
      CONTINUE;
    END IF;

    -- Split the line across its fields BY ACRES (stable order = field_id).
    SELECT sum(acres) INTO v_total_acres
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    SELECT array_agg(acres / v_total_acres * 100 ORDER BY field_id) INTO v_acre_pcts
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    v_field_cents := calculate_billing_splits(v_line_cents, v_acre_pcts);

    v_field_idx := 0;
    FOR v_alloc IN
      SELECT field_id, acres FROM order_item_field_allocations
      WHERE order_item_id = v_item.id ORDER BY field_id
    LOOP
      v_field_idx := v_field_idx + 1;

      -- Owners of this field, or fall back to the field's own customer at 100%.
      IF EXISTS (SELECT 1 FROM field_billing_defaults WHERE field_id = v_alloc.field_id) THEN
        SELECT array_agg(customer_id ORDER BY customer_id),
               array_agg(split_pct ORDER BY customer_id),
               sum(split_pct)
          INTO v_owner_ids, v_owner_pcts, v_sum_pct
          FROM field_billing_defaults WHERE field_id = v_alloc.field_id;
        IF v_sum_pct < 99.99 OR v_sum_pct > 100.01 THEN
          RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: field % billing splits total % (must equal 100)',
            v_alloc.field_id, v_sum_pct;
        END IF;
        -- Normalize to sum EXACTLY 100 (order-preserving) so calculate_billing_splits — which assumes
        -- the percentages total 100 — cannot over-allocate within the tolerance band, e.g. 50.01+50.00
        -- would otherwise floor to MORE than the field's cents (Codex P2). v_owner_ids stays aligned.
        SELECT array_agg(p / v_sum_pct * 100 ORDER BY ord)
          INTO v_owner_pcts FROM unnest(v_owner_pcts) WITH ORDINALITY AS u(p, ord);
      ELSE
        SELECT ARRAY[customer_id] INTO v_owner_ids FROM fields WHERE id = v_alloc.field_id;
        v_owner_pcts := ARRAY[100::numeric];
      END IF;

      -- Split this field's portion among its owners BY split_pct (penny-exact).
      v_owner_cents := calculate_billing_splits(v_field_cents[v_field_idx], v_owner_pcts);

      FOR v_oidx IN 1..array_length(v_owner_ids, 1) LOOP
        -- This owner's slice of THIS field = field acres * their normalized pct. Bill that many
        -- acres to them (so split invoice items carry PRORATED acres, not the line's full acres —
        -- otherwise year-end/RUP acre reports double-count; Codex round-5 P2). qty is prorated by the
        -- same acre-share: well-defined even for a $0 line (v_total_acres > 0 for any allocated line)
        -- and it sums back to the line's total qty across owners.
        v_owner_acres := v_alloc.acres * v_owner_pcts[v_oidx] / 100;
        v_rows := v_rows || jsonb_build_object(
          'c', v_owner_ids[v_oidx], 'oi', v_item.id,
          'cents', v_owner_cents[v_oidx],
          'acres', round(v_owner_acres, 4),
          'qty', round(COALESCE(v_item.total_units_needed, 0) * v_owner_acres / v_total_acres, 4));
      END LOOP;
    END LOOP;
  END LOOP;

  -- A customer whose allocated subtotal is NEGATIVE (a discount line allocated to them exceeds their
  -- charges) cannot become a non-negative invoice; silently skipping them (the outer HAVING > 0 below)
  -- would make the OTHER customers' invoices over-sum the order total — breaking the penny-exact
  -- reconciliation guarantee. Fail loudly instead of mis-billing (Codex round-6 P2). A net-ZERO customer
  -- is safe to skip (contributes 0, reconciliation still holds); only a strictly-negative net is rejected.
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
    GROUP BY x.c HAVING sum(x.cents) < 0
  ) THEN
    RAISE EXCEPTION 'SPLIT_NET_NEGATIVE: a customer''s allocated subtotal is negative — cannot create split invoices (adjust the discount/allocation or issue a credit memo)';
  END IF;

  -- PASS 2: one invoice per customer, from the accumulated contributions.
  v_group_id := gen_random_uuid();

  FOR v_cust IN
    SELECT x.c AS customer_id, sum(x.cents) AS cust_total
    FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric)
    GROUP BY x.c
    HAVING sum(x.cents) > 0
    ORDER BY x.c
  LOOP
    INSERT INTO invoices (order_id, customer_id, invoice_type, status, season, salesman_id,
      created_by, total_amount_cents, invoice_date, invoice_group_id, header_notes)
    VALUES (p_order_id, v_cust.customer_id, p_invoice_type, 'draft',
      COALESCE(v_order.season, current_season()),
      COALESCE(p_salesman_id, v_order.salesman_id), auth.uid(), 0, CURRENT_DATE, v_group_id,
      'Split invoice (by field/acre) from order ' || v_order.order_number)
    RETURNING id INTO v_invoice_id;

    v_total_cents := 0;
    FOR v_item IN
      SELECT oi.*, agg.cents AS cust_cents, agg.qty AS cust_qty, agg.acres AS cust_acres
      FROM (
        SELECT x.oi AS order_item_id, sum(x.cents)::bigint AS cents, sum(x.qty) AS qty, sum(x.acres) AS acres
        FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
        WHERE x.c = v_cust.customer_id
        GROUP BY x.oi
        -- Keep a line on the invoice if the customer has ANY contribution to it: non-zero cents
        -- (incl. a negative discount line, so the total reconciles to their net — Codex round-4 P2),
        -- OR non-zero qty/acres (so a legitimate $0 / no-charge product line still carries its product,
        -- quantity and acres for the PDF and year-end usage reports, matching create_invoice_from_order
        -- — Codex round-5 P2). The per-customer (outer) HAVING > 0 still gates which customers get a
        -- (CHECK-non-negative) invoice; a customer whose net is <= 0 is skipped (v1 — a net credit /
        -- a $0-only allocation would need a credit_memo / explicit $0 invoice, out of scope).
        HAVING sum(x.cents) <> 0 OR sum(x.qty) <> 0 OR sum(x.acres) <> 0
      ) agg
      JOIN order_items oi ON oi.id = agg.order_item_id
      ORDER BY oi.sort_order NULLS LAST, oi.id
    LOOP
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity,
        unit_price_cents, extended_cents, cost_cents, sort_order, rate_per_acre, acres, unit_size)
      VALUES (v_invoice_id, v_item.id, v_item.product_id, COALESCE(v_item.product_name, ''),
        v_item.cust_qty, round(v_item.price_per_unit * 100)::bigint, v_item.cust_cents,
        round(v_item.cost_per_unit * 100)::bigint, COALESCE(v_item.sort_order, 0),
        v_item.actual_rate, v_item.cust_acres, v_item.unit_size);
      v_total_cents := v_total_cents + v_item.cust_cents;
    END LOOP;

    UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description)
    VALUES ('invoice_created', 'invoice', v_invoice_id,
      COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'admin'),
      jsonb_build_object('order_number', v_order.order_number, 'group_id', v_group_id,
        'split_basis', 'field_acre'),
      v_total_cents, 'Split invoice (by field/acre) from order ' || v_order.order_number);

    v_invoice_ids := v_invoice_ids || v_invoice_id;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_created',
    COALESCE(array_length(v_invoice_ids, 1), 0) || ' split invoices from order ' || v_order.order_number,
    auth.uid(), 'order', p_order_id, v_order.customer_id);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_split_invoices_from_order',
      to_jsonb(array_to_string(v_invoice_ids, ',')));
  END IF;

  RETURN v_invoice_ids;
END;
$function$;
