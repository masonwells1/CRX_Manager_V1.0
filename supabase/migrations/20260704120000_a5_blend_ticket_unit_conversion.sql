-- ============================================================================
-- A5 — Blend-ticket unit conversion (money + inventory correctness)
-- PARKED: owner-gated. Do NOT apply without Mason's explicit OK.
-- ----------------------------------------------------------------------------
-- WHY: The three blend-ticket fulfilment RPCs never convert the blend line's
--   rate/quantity unit to the product's inventory (pricing/stock) unit. A line
--   dosed in oz on a gallons-stocked product mis-bills / mis-deducts by up to
--   128x — the exact class already fixed on the field-application path
--   (20260630180000) and flagged as "the single worst correctness bug" in
--   docs/roadmap/product-units-scheduling-deep-dive-2026-07-01.md.
--
-- WHAT (each re-emit is byte-identical to the live def except the A5-marked
--   lines; proven by a whitespace/comment-insensitive pg_get_functiondef diff):
--   1. create_invoice_from_blend_ticket   — bill rate*acres CONVERTED to the
--      inventory unit; pre-validate + REFUSE billable lines with no rate
--      (BLEND_TICKET_ZERO_RATE) or an unconvertible unit
--      (BLEND_TICKET_UNIT_UNCONVERTIBLE) instead of silently billing $0 / 128x.
--   2. create_order_from_blend_ticket      — convert the stored quantity to the
--      inventory unit before pricing, prebooking, and the inventory txn.
--   3. create_application_record_from_blend_ticket — convert the stored quantity
--      to the inventory unit before deducting stock.
--   All three reuse the existing IMMUTABLE helper field_app_priced_quantity()
--   (rate_unit -> inventory_unit; identity when units already match; NULL when
--   unconvertible). The conversion is a NO-OP whenever the line's unit already
--   equals the inventory unit, so only genuinely mis-unit'd lines change.
--   Every unit passed to the helper is first run through normalize_rate_unit()
--   (Codex R1 P2) so free-text/OCR forms like 'oz/ac' or 'gallons' convert instead
--   of being falsely refused; the DISPLAYED unit keeps its original casing.
--
-- BLAST RADIUS: blend_tickets/blend_ticket_products/blend invoices are EMPTY
--   live (0/0/0 rows on 2026-07-04) — this is a purely forward-looking,
--   pre-season fix with zero historical-data risk.
--
-- EDGE FN (process-blend-ticket): INTENTIONALLY UNCHANGED (A5 is MIGRATION-ONLY).
--   We considered persisting the OCR per-acre rate, but OCR yields a bare rate number
--   with no reliable per-acre UNIT (Codex R1/R2 P1: prod.unit is the total-product unit,
--   not the rate's), and these RPCs convert rate->inventory units, so a unitless rate
--   could mis-bill. Instead the office enters the rate + its unit during the mandatory
--   blend-ticket review, and the ZERO_RATE / UNCONVERTIBLE guards below refuse any line
--   that isn't safely billable — which already fixes the old silent-$0 drop with no
--   edge-fn change and no edge-fn deploy.
--
-- OWNER-CONFIRM (surface at apply): the invoice RPC now REFUSES (raises) a blend
--   ticket that has a billable product line with no per-acre rate or an
--   unconvertible unit, rather than silently dropping/mis-billing it. This
--   mirrors the field-app path's existing FIELD_APP_UNIT_UNCONVERTIBLE behavior.
--   Confirm you want a hard refuse (vs a warn) before apply.
--
-- APPLY-ORDER: apply all three re-emits together (this one migration). The
--   edge-fn deploy is independent and can follow.
--
-- PROOF: see the loop ledger cycle-log entry. Codex verdict: <pending>.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) create_invoice_from_blend_ticket
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_ticket              record;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_btf                 record;
  v_field_acres         numeric;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_has_app_service     boolean := false;
  v_fee_rate            bigint;
  v_btp                 record;
  v_share_row           jsonb;
  v_share_acres         numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_quote_section_id    uuid;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_chem_qty_a          numeric;
  v_chem_qty_b          numeric;
  v_rate                numeric;
  -- A5: unit-conversion + pre-billing validation locals
  v_rate_unit_line      text;
  v_inv_unit_line       text;
  v_chem_qty_a_conv     numeric;
  v_chem_qty_b_conv     numeric;
  v_bad_rate            text;
  v_bad_unit            text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_created_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create blend ticket invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_invoice_from_blend_ticket';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved (status: %)', v_ticket.review_status;
  END IF;
  IF v_ticket.payment_status IS DISTINCT FROM 'unbilled' THEN
    RAISE EXCEPTION 'Blend ticket cannot be billed (payment_status: %); only an unbilled ticket can generate an invoice', v_ticket.payment_status;
  END IF;

  -- A5 BEGIN: refuse to bill blend lines that can't be priced correctly.
  -- (1) A billable product line with no per-acre rate would silently bill $0.
  SELECT string_agg(DISTINCT btp.product_name, ', ')
    INTO v_bad_rate
    FROM blend_ticket_products btp
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NOT NULL
     AND (btp.rate_per_acre IS NULL OR btp.rate_per_acre <= 0);
  IF v_bad_rate IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_ZERO_RATE: product(s) have no per-acre rate and cannot be billed: %', v_bad_rate;
  END IF;
  -- (2) A billable line whose rate unit cannot convert to the product's inventory
  --     (pricing) unit would mis-bill by the unit ratio (the oz-vs-gal 128x class).
  SELECT string_agg(DISTINCT btp.product_name, ', ')
    INTO v_bad_unit
    FROM blend_ticket_products btp
    JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NOT NULL
     AND field_app_priced_quantity(
           1,
           normalize_rate_unit(COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)),
           normalize_rate_unit(COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)),
           p.product_form
         ) IS NULL;
  IF v_bad_unit IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product(s) have a rate unit that cannot convert to the inventory unit: %', v_bad_unit;
  END IF;
  -- A5 END

  FOR v_btf IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS field_acres
      FROM blend_ticket_fields btf
      JOIN fields f ON f.id = btf.field_id
     WHERE btf.blend_ticket_id = p_blend_ticket_id
  LOOP
    v_field_ids := array_append(v_field_ids, v_btf.field_id);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_btf.field_id::text, v_btf.field_acres);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    IF v_ticket.field_id IS NOT NULL THEN
      v_field_ids := ARRAY[v_ticket.field_id];
      SELECT COALESCE(v_ticket.total_acres, f.total_acres, 0) INTO v_field_acres
        FROM fields f WHERE f.id = v_ticket.field_id;
      v_applied_acres_map := jsonb_build_object(v_ticket.field_id::text, v_field_acres);
    ELSE
      RAISE EXCEPTION 'Blend ticket has no fields';
    END IF;
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from blend ticket fields';
  END IF;

  IF v_ticket.application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = v_ticket.application_service_id;
    v_has_app_service := FOUND
                         AND (v_app_service IS NOT NULL)
                         AND COALESCE(v_app_service.is_active, false);
  END IF;

  v_quote_section_id := NULL;
  IF v_ticket.job_id IS NOT NULL THEN
    SELECT j.quote_section_id INTO v_quote_section_id FROM jobs j WHERE j.id = v_ticket.job_id;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := gen_random_uuid();
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_number := next_invoice_number();

    INSERT INTO invoices (
      blend_ticket_id, customer_id, invoice_type, status, season,
      invoice_number, salesman_id, created_by,
      total_amount_cents, total_cost_cents,
      invoice_date, invoice_group_id, application_service_id
    ) VALUES (
      p_blend_ticket_id, v_customer_id, 'field_application', 'draft',
      COALESCE(v_ticket.season, current_season()),
      v_invoice_number, v_ticket.salesman_id, p_created_by,
      0, 0,
      CURRENT_DATE, v_invoice_group_id, v_ticket.application_service_id
    ) RETURNING id INTO v_invoice_id;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres        := (v_share_row->>'share_acres')::numeric;
      v_field_override     := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note := v_share_row->>'pricing_note';
      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );
      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_btp IN
      SELECT btp.*, p.tier1_price, p.tier2_price, p.tier3_price,
             p.product_name AS full_product_name, p.current_cost AS product_cost,
             p.unit_size, p.rate_unit,
             -- A5: inventory unit + form drive the rate->pricing-unit conversion
             p.inventory_unit, p.product_form
        FROM blend_ticket_products btp
        LEFT JOIN products p ON p.id = btp.product_id
       WHERE btp.blend_ticket_id = p_blend_ticket_id
       ORDER BY btp.sequence_order
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE(v_btp.rate_per_acre, 0);

      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value ->> 'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      -- A5: convert the accumulated rate-unit quantities to the product's inventory
      -- (pricing) unit so money = price/inventory-unit x qty/inventory-unit. Unmatched
      -- products (no product row) keep the raw quantity (no price, nothing to convert).
      -- Convertibility was pre-validated above, so the helper is non-NULL here.
      -- Display units keep their original casing; the helper gets normalized units
      -- (strips /ac + maps plural/spelled aliases) so oz/ac, gallons, etc. convert.
      v_rate_unit_line := COALESCE(NULLIF(btrim(v_btp.rate_per_acre_unit), ''), v_btp.rate_unit);
      v_inv_unit_line  := COALESCE(NULLIF(btrim(v_btp.inventory_unit), ''), v_btp.unit_size);
      IF v_btp.product_id IS NOT NULL THEN
        v_chem_qty_a_conv := field_app_priced_quantity(v_chem_qty_a, normalize_rate_unit(v_rate_unit_line), normalize_rate_unit(v_inv_unit_line), v_btp.product_form);
        v_chem_qty_b_conv := field_app_priced_quantity(v_chem_qty_b, normalize_rate_unit(v_rate_unit_line), normalize_rate_unit(v_inv_unit_line), v_btp.product_form);
      ELSE
        v_chem_qty_a_conv := v_chem_qty_a;
        v_chem_qty_b_conv := v_chem_qty_b;
      END IF;

      IF v_chem_qty_a > 0 THEN
        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name) || ' — included in grower share',
          ROUND(v_chem_qty_a_conv, 4), v_inv_unit_line,
          0, 0, 0,
          v_btp.sequence_order, v_rate, v_rate_unit_line,
          false, 'manual'
        );
      END IF;

      IF v_chem_qty_b > 0 THEN
        v_unit_price   := NULL;
        v_quoted_price := NULL;
        v_price_source := NULL;

        IF v_btp.unit_price_cents IS NOT NULL THEN
          v_unit_price   := v_btp.unit_price_cents;
          v_price_source := 'manual';
        ELSIF v_quote_section_id IS NOT NULL AND v_btp.product_id IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
           WHERE qi.section_id = v_quote_section_id
             AND qi.product_id = v_btp.product_id
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN
            v_unit_price   := ROUND(v_qi_price * 100)::bigint;
            v_quoted_price := v_unit_price;
            v_price_source := 'quoted';
          END IF;
        END IF;

        IF v_unit_price IS NULL THEN
          IF v_btp.product_id IS NOT NULL THEN
            v_unit_price := CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(v_btp.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(v_btp.tier2_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(v_btp.tier3_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(v_btp.tier1_price * 100), 0)
            END;
          ELSE
            v_unit_price := 0;
          END IF;
          IF v_price_source IS NULL THEN v_price_source := 'tier'; END IF;
        END IF;

        v_unit_cost := COALESCE(v_btp.unit_cost_cents,
                                ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint, 0);
        v_extended := safe_cents_qty(v_unit_price, v_chem_qty_b_conv);

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          quoted_price_cents, is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name),
          ROUND(v_chem_qty_b_conv, 4), v_inv_unit_line,
          v_unit_price, v_extended, v_unit_cost,
          v_btp.sequence_order, v_rate, v_rate_unit_line,
          v_quoted_price, false, v_price_source
        );
        v_invoice_total := v_invoice_total + v_extended;
        v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b_conv);
      END IF;
    END LOOP;

    IF v_has_app_service THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = v_ticket.application_service_id
         AND car.season                 = COALESCE(v_ticket.season, current_season())
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost
    WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_created', 'invoice', v_invoice_id,
      (SELECT role FROM profiles WHERE id = v_actor),
      jsonb_build_object(
        'invoice_number', v_invoice_number,
        'blend_ticket_number', v_ticket.ticket_number,
        'customer_id', v_customer_id,
        'total_cents', v_invoice_total
      ),
      v_invoice_total,
      'Invoice created from blend ticket ' || v_ticket.ticket_number
    );

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'price_override_cents')::bigint
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'pricing_note')
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END
    );
  END LOOP;

  UPDATE blend_tickets SET payment_status = 'billed' WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
          'Invoice(s) created from blend ticket ' || v_ticket.ticket_number ||
            CASE WHEN v_invoice_group_id IS NOT NULL
                 THEN ' (group of ' || v_customer_count || ')' ELSE '' END,
          p_created_by, 'invoice', v_invoice_ids[1], v_ticket.customer_id);

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_invoice_from_blend_ticket', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 2) create_order_from_blend_ticket
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
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
  v_link_result json;
  v_cached      jsonb;
  -- A5: quantity converted to the product's inventory unit + the unit label to store
  v_qty_conv    numeric;
  v_unit_out    text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_order_from_blend_ticket');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached::json;
    END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id;
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
        IF v_qty_conv IS NULL THEN
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
      COALESCE(v_product.product_id, gen_random_uuid()),
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

    IF v_product.product_id IS NOT NULL AND v_qty_conv > 0 THEN
      UPDATE inventory SET
        quantity_prebooked = COALESCE(quantity_prebooked, 0) + v_qty_conv,
        updated_at = now()
      WHERE product_id = v_product.product_id AND location = 'Main Warehouse';

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

  -- CHANGED: Removed balance_due from UPDATE (AR tracked via invoices)
  UPDATE orders
  SET total_price = v_total_price,
      total_cost = v_total_cost,
      total_profit = v_total_price - v_total_cost,
      total_margin_pct = CASE WHEN v_total_price > 0 THEN ((v_total_price - v_total_cost) / v_total_price * 100) ELSE 0 END
  WHERE id = v_order_id;

  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, NULL, p_performed_by);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_order_from_blend_ticket',
      jsonb_build_object('success', true, 'order_id', v_order_id));
  END IF;

  RETURN json_build_object(
    'success', true,
    'order_id', v_order_id,
    'order_number', p_order_number,
    'items_created', v_item_count,
    'total_price', v_total_price
  );
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3) create_application_record_from_blend_ticket
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_application_record_from_blend_ticket(p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_ticket         record;
  v_product_data   jsonb;
  v_season         integer;
  v_bt_product     record;
  v_field          record;
  v_record_id      uuid;
  v_record_ids     uuid[] := '{}';
  v_record_number  text;
  v_applicator_id  uuid;
  v_inv            record;
  v_inv_found      boolean;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_short_count    int := 0;
  v_field_count    int := 0;
  v_first_field_id uuid;
  v_app_time       time;
  -- A5: quantity converted to the product's inventory unit for the stock deduction
  v_deduct_qty     numeric;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create application records from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'create_app_record_from_bt';
    IF v_existing IS NOT NULL THEN
      RETURN ARRAY(SELECT jsonb_array_elements_text(v_existing))::uuid[];
    END IF;
  END IF;

  SELECT bt.* INTO v_ticket FROM blend_tickets bt WHERE bt.id = p_blend_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved. Current status: %', v_ticket.review_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_blend_ticket_id
  ) THEN
    RAISE EXCEPTION 'Application record(s) already exist for this blend ticket';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', btp.product_id, 'product_name', btp.product_name,
        'quantity', btp.quantity, 'unit', btp.unit,
        'rate_per_acre', btp.rate_per_acre, 'rate_unit', btp.rate_per_acre_unit,
        'epa_registration', p.epa_registration, 'is_rup', COALESCE(p.is_rup, false)
      ) ORDER BY btp.sequence_order
    ), '[]'::jsonb
  ) INTO v_product_data
  FROM blend_ticket_products btp
  LEFT JOIN products p ON p.id = btp.product_id
  WHERE btp.blend_ticket_id = p_blend_ticket_id;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) >= 10
    THEN EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) + 1
    ELSE EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date)
  END;

  BEGIN
    v_app_time := NULLIF(btrim(v_ticket.ticket_time), '')::time;
  EXCEPTION WHEN OTHERS THEN
    v_app_time := NULL;
  END;

  v_applicator_id := v_ticket.applicator_id;
  IF v_applicator_id IS NULL AND v_ticket.applicator_name IS NOT NULL THEN
    SELECT id INTO v_applicator_id FROM profiles
    WHERE full_name = v_ticket.applicator_name AND role = 'applicator' LIMIT 1;
  END IF;

  SELECT btf.field_id INTO v_first_field_id
    FROM blend_ticket_fields btf
   WHERE btf.blend_ticket_id = p_blend_ticket_id
   ORDER BY btf.sort_order
   LIMIT 1;

  v_record_number := next_application_record_number();
  INSERT INTO application_records (
    record_number, source_type, source_id, customer_id, applicator_id, field_id,
    application_date, application_time, product_data, total_acres,
    total_volume, total_volume_unit, weather_conditions, notes, season, created_by
  ) VALUES (
    v_record_number, 'blend_ticket', p_blend_ticket_id,
    v_ticket.customer_id, v_applicator_id, COALESCE(v_first_field_id, v_ticket.field_id),
    COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_app_time,
    v_product_data, v_ticket.total_acres,
    v_ticket.total_volume, v_ticket.total_volume_unit, NULL, v_ticket.notes, v_season, p_performed_by
  ) RETURNING id INTO v_record_id;
  v_record_ids := v_record_ids || v_record_id;

  -- B1 lot propagation (ADDED): auto-fill application_record_lots from the blend ticket's
  -- per-product lot numbers so blend-sourced applications carry lots with no re-typing.
  -- Skips null product_id and blank lot_number; dedupes identical (product_id, lot_number)
  -- component rows; source_receiving_record_id stays NULL (these came from the blend, not a
  -- receiving record). Filtering keeps this insert from ever rolling back the whole RPC.
  INSERT INTO application_record_lots (application_record_id, product_id, lot_number, created_by)
  SELECT v_record_id, d.product_id, d.lot_number, p_performed_by
  FROM (
    SELECT DISTINCT ON (btp.product_id, lower(btrim(btp.lot_number)))
           btp.product_id, btrim(btp.lot_number) AS lot_number
    FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
      AND btp.lot_number IS NOT NULL
      AND btrim(btp.lot_number) <> ''
    ORDER BY btp.product_id, lower(btrim(btp.lot_number))
  ) d;

  FOR v_field IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS acres,
           COALESCE(btf.sort_order, 0) AS sort_order
    FROM blend_ticket_fields btf
    LEFT JOIN fields f ON f.id = btf.field_id
    WHERE btf.blend_ticket_id = p_blend_ticket_id ORDER BY btf.sort_order
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_field.field_id, v_field.acres, v_field.sort_order);
    v_field_count := v_field_count + 1;
  END LOOP;

  FOR v_bt_product IN
    -- A5: join products for the inventory unit + form so the deduction converts.
    SELECT btp.product_id, btp.quantity, btp.unit AS qty_unit, btp.product_name,
           p.inventory_unit, p.unit_size, p.product_form
      FROM blend_ticket_products btp
      LEFT JOIN products p ON p.id = btp.product_id
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL AND btp.quantity > 0
  LOOP
    -- A5: deduct in the product's inventory unit. The blend line quantity may be in a
    -- different unit (e.g. pints on a gallons-stocked product) — deducting the raw
    -- number corrupts stock by the unit ratio (the complete_job bug class).
    IF v_bt_product.inventory_unit IS NULL AND v_bt_product.unit_size IS NULL THEN
      v_deduct_qty := v_bt_product.quantity;   -- product row missing: cannot convert, preserve
    ELSE
      v_deduct_qty := field_app_priced_quantity(
                        v_bt_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_bt_product.qty_unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_bt_product.inventory_unit), ''), v_bt_product.unit_size)),
                        v_bt_product.product_form);
      IF v_deduct_qty IS NULL THEN
        RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
          v_bt_product.product_name, v_bt_product.qty_unit, COALESCE(v_bt_product.inventory_unit, v_bt_product.unit_size);
      END IF;
    END IF;

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_bt_product.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory
      SET quantity_available = quantity_available - v_deduct_qty,
          updated_at         = now()
      WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, requires_review
    ) VALUES (
      v_bt_product.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
      p_performed_by,
      'Blend ticket application: ' || v_ticket.ticket_number ||
        ' (application record ' || v_record_id::text || ')' ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      v_short_flag
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'application_record_created',
    'Application record ' || v_record_number || ' created from blend ticket ' || v_ticket.ticket_number ||
      ' (' || v_field_count || ' field(s))' ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END,
    p_performed_by, 'blend_ticket', p_blend_ticket_id, v_ticket.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_app_record_from_bt', to_jsonb(v_record_ids));
  END IF;

  RETURN v_record_ids;
END;
$function$;
