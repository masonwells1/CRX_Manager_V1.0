-- LIVE function definitions read read-only from project rhyzpcqhnizqbxphqdkr on 2026-09-03T17:29:18.963Z
-- via pg_get_functiondef(), byte-exact (the _save_field_app_split_invoice_impl body keeps its CRLF).
-- Starting state for scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs; each body must hash to
-- the live pin named in 20260903170000_invoice_date_fallbacks_chicago.sql. Never hand-edit.
-- _price_order_below_cost_impl_20260810: md5(prosrc) 775317b102a0cd211418773aa409d510
CREATE OR REPLACE FUNCTION public._price_order_below_cost_impl_20260810(p_order_id uuid, p_items jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid;
  v_actor_role  text;
  v_order       record;
  v_cached      jsonb;
  v_result      jsonb;
  v_item        jsonb;
  v_oi          record;
  v_price       numeric;
  v_cost        numeric;
  v_remaining   int;
  v_was_pending boolean;
  v_total_profit numeric;
  v_inv         record;
  v_swept       int := 0;
BEGIN
  -- ── canonical strict-actor + role gate ────────────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin','sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  -- Codex round-11 P2: idempotency check AFTER the order FOR UPDATE (TOCTOU). A pre-lock
  -- check_idempotency let two same-key calls both miss the cache; the 1st prices the order
  -- (pricing_status→priced) and saves its result, then the 2nd — which was waiting on the
  -- FOR UPDATE — resumes and would hit the ALREADY_PRICED guard below, returning a FALSE
  -- failure even though the order was priced. Re-checking here (the order row lock
  -- serializes same-order/same-key calls) returns the 1st call's saved result instead.
  -- Canonical pattern from draw_down_quote (20260610181726).
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'price_order');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;
  -- Terminal-order guard (Codex round 2 P1): a cancelled/voided/deleted rush order
  -- still carries pricing_status='needs_pricing' (the cancel/void RPCs don't clear
  -- it), so without this check price_order would price it and create commissions
  -- for a dead order. Reject terminal orders before any mutation.
  IF v_order.status IN ('cancelled', 'voided') OR v_order.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_ACTIVE';
  END IF;
  -- State guard (Codex P1): only an unpriced order may be priced. Once an order
  -- is finalized to 'priced', reject re-pricing — a stale second tab would
  -- otherwise update prices/totals while the v_was_pending-gated invoice +
  -- commission refresh is skipped, desyncing the financial records. A partially
  -- priced order stays 'needs_pricing' (the flip to 'priced' only happens when no
  -- line remains pending), so legitimate multi-call pricing still passes here.
  IF v_order.pricing_status IS DISTINCT FROM 'needs_pricing' THEN
    RAISE EXCEPTION 'ALREADY_PRICED';
  END IF;
  v_was_pending := true;

  -- ── price each provided line (price-only) ─────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'order_item_id') IS NULL THEN CONTINUE; END IF;
    v_price := COALESCE((v_item->>'price')::numeric, 0);
    IF v_price < 0 THEN RAISE EXCEPTION 'INVALID_PRICE'; END IF;
    SELECT * INTO v_oi FROM order_items
      WHERE id = (v_item->>'order_item_id')::uuid AND order_id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ITEM_NOT_FOUND'; END IF;
    v_cost := COALESCE(v_oi.cost_at_time_cents, 0) / 100.0;  -- snapshot cost (cents→dollars)
    UPDATE order_items SET
      price_per_unit  = v_price,
      cost_per_unit   = v_cost,
      total_price     = v_price * total_units_needed,
      profit          = (v_price - v_cost) * total_units_needed,
      net_margin      = CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price) * 100 ELSE 0 END,
      pricing_pending = false
    WHERE id = v_oi.id;
  END LOOP;

  -- ── any lines still pending? ──────────────────────────────────────────────
  SELECT count(*) INTO v_remaining
  FROM order_items WHERE order_id = p_order_id AND pricing_pending = true;

  IF v_remaining = 0 THEN
    -- pricing_status is NOT a trigger-gated column (enforce_order_status_transition
    -- is BEFORE UPDATE OF status only) — a plain UPDATE is safe.
    UPDATE orders SET pricing_status = 'priced', updated_at = now() WHERE id = p_order_id;

    -- deferred commissions on the FINAL profit, only on the needs_pricing→priced
    -- transition (re-read total_profit after trg_recalc_order_totals ran).
    IF v_was_pending THEN
      SELECT total_profit INTO v_total_profit FROM orders WHERE id = p_order_id;
      -- Codex round-7 P1: use the split SNAPSHOTTED onto the order at rush-order
      -- creation (create_rush_order stores customers.default_commission_split into
      -- orders.commission_split), NOT the customer's CURRENT default — a split change
      -- between ship and pricing must not re-attribute this sale's commissions.
      PERFORM _insert_commissions_for_order(
        p_order_id, v_order.customer_id, v_total_profit,
        v_order.commission_split, v_order.order_date
      );

      -- sweep linked DRAFT/UNPOSTED invoices to the now-known prices — gated on
      -- v_was_pending (the needs_pricing→priced transition) so a redundant re-call
      -- on an already-priced order never re-sweeps or re-dates a draft invoice.
      FOR v_inv IN SELECT * FROM invoices
                 WHERE order_id = p_order_id AND status IN ('draft','unposted') FOR UPDATE
    LOOP
      -- cost_cents is PER-UNIT by convention (create_invoice_from_delivery:
      -- total_cost_cents = SUM(cost_cents * quantity)). Codex P1: write per-unit
      -- cost, NOT the line total, or total_cost_cents double-counts quantity.
      UPDATE invoice_items ii SET
        unit_price_cents = round(oi.price_per_unit * 100)::bigint,
        extended_cents   = round(oi.price_per_unit * ii.quantity * 100)::bigint,
        cost_cents       = round(oi.cost_per_unit * 100)::bigint
      FROM order_items oi
      WHERE ii.invoice_id = v_inv.id AND ii.order_item_id = oi.id;

      -- Recompute BOTH header money columns (Codex P1: total_cost_cents was left
      -- at 0/stale → wrong posted margin + month-end profit). total_cost_cents
      -- mirrors the create_invoice_from_delivery convention SUM(cost_cents*qty).
      UPDATE invoices SET
        total_amount_cents = COALESCE((SELECT sum(extended_cents) FROM invoice_items WHERE invoice_id = v_inv.id), 0),
        total_cost_cents   = COALESCE((SELECT round(sum(cost_cents * quantity))::bigint FROM invoice_items WHERE invoice_id = v_inv.id), 0),
        invoice_date       = CURRENT_DATE,   -- G3: PRICE-MONTH
        pricing_pending    = false,
        updated_at         = now()
      WHERE id = v_inv.id;
      v_swept := v_swept + 1;
    END LOOP;
    END IF;  -- close v_was_pending (commissions + invoice sweep)
  END IF;  -- close v_remaining = 0

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_priced',
    'Priced order ' || v_order.order_number ||
    CASE WHEN v_remaining = 0 THEN ' — fully priced' ELSE ' — ' || v_remaining || ' line(s) still pending' END,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'pricing_status', CASE WHEN v_remaining = 0 THEN 'priced' ELSE 'needs_pricing' END,
    'remaining_pending', v_remaining,
    'invoices_swept', v_swept
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'price_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- _save_field_app_invoice_impl_20260714: md5(prosrc) a44110b8398943fc6e450e776a7d7098
CREATE OR REPLACE FUNCTION public._save_field_app_invoice_impl_20260714(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_existing_group_id   uuid;
  v_existing_status     text;
  v_locked_count        int;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_total_applied_acres numeric := 0;
  v_this_applied        numeric;
  v_loc                 jsonb;
  v_chem                jsonb;
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
  v_fee_rate            bigint;
  v_loc_id              uuid;
  v_share_row           jsonb;
  v_share_pct           numeric;
  v_share_acres         numeric;
  v_field_id            uuid;
  v_field_applied_acres numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
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
  v_orphan              record;
  v_req_salesman        uuid;
  v_salesman_id         uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_is_new_invoice      boolean;
  v_surcharge_acres     numeric;
  v_surcharge_cents     bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save field application invoices';
  END IF;

  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user (salesman_id)';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'save_field_app_invoice';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT status, invoice_group_id INTO v_existing_status, v_existing_group_id
      FROM invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
    SELECT COUNT(*) INTO v_locked_count
      FROM invoices
     WHERE (id = p_invoice_id OR invoice_group_id = v_existing_group_id)
       AND v_existing_group_id IS NOT NULL
       AND deleted_at IS NULL
       AND status NOT IN ('draft', 'unposted');
    IF v_locked_count > 0 OR v_existing_status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot edit field app invoice — % invoice(s) in this group are posted/voided. Use void/reissue.', GREATEST(v_locked_count, 1);
    END IF;

    IF v_existing_group_id IS NOT NULL THEN
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_group_id = v_existing_group_id
      );
      DELETE FROM field_app_locations WHERE invoice_group_id = v_existing_group_id;
      DELETE FROM invoice_items   WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
      DELETE FROM invoice_shares  WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
    ELSE
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_id = p_invoice_id
      );
      DELETE FROM field_app_locations WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
    END IF;
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_this_applied := (v_loc->>'applied_acres')::numeric;
    IF v_this_applied IS NULL OR v_this_applied <= 0 THEN
      RAISE EXCEPTION 'ZERO_APPLIED_ACRES: applied acres must be greater than 0 for field % (enter applied acres, or remove the field)', v_loc->>'field_id';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_total_applied_acres := v_total_applied_acres + v_this_applied;
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_loc->>'field_id', v_this_applied);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one field is required';
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from selected fields';
  END IF;

  IF v_existing_group_id IS NOT NULL THEN
    FOR v_orphan IN
      SELECT id, invoice_number, customer_id
        FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND deleted_at IS NULL
         AND customer_id NOT IN (
           SELECT (c->>'customer_id')::uuid FROM jsonb_array_elements(v_customers) c
         )
    LOOP
      UPDATE invoices SET
        status              = 'cancelled',
        invoice_group_id    = NULL,
        total_amount_cents  = 0,
        total_cost_cents    = 0,
        updated_at          = now()
      WHERE id = v_orphan.id;

      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'invoice_orphan_cancelled',
        'Field app invoice ' || v_orphan.invoice_number ||
          ' cancelled — customer removed from group during edit',
        p_performed_by, 'invoice', v_orphan.id, v_orphan.customer_id
      );
    END LOOP;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := COALESCE(v_existing_group_id, gen_random_uuid());
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

    v_invoice_id := NULL;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM invoices
       WHERE invoice_group_id = v_existing_group_id AND customer_id = v_customer_id AND deleted_at IS NULL LIMIT 1;
    ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
      v_invoice_id := p_invoice_id;
    END IF;

    IF v_invoice_id IS NULL AND v_existing_group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND customer_id = v_customer_id
         AND deleted_at IS NOT NULL
    ) THEN
      v_skipped_customer_ids := array_append(v_skipped_customer_ids, v_customer_id);
      CONTINUE;
    END IF;

    v_is_new_invoice := (v_invoice_id IS NULL);

    IF v_invoice_id IS NULL THEN
      v_invoice_number := next_invoice_number();
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id,
        season
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
        v_salesman_id,
        p_invoice->>'header_notes',
        p_performed_by,
        0, 0,
        v_invoice_group_id,
        p_application_service_id,
        current_season()
      ) RETURNING id INTO v_invoice_id;
    ELSE
      UPDATE invoices SET
        invoice_date            = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id             = CASE WHEN is_admin() THEN COALESCE(v_salesman_id, salesman_id) ELSE salesman_id END,
        header_notes            = COALESCE(p_invoice->>'header_notes', header_notes),
        application_service_id  = p_application_service_id,
        invoice_group_id        = v_invoice_group_id,
        total_amount_cents      = 0,
        total_cost_cents        = 0,
        updated_at              = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_field_id            := (v_share_row->>'field_id')::uuid;
      v_field_applied_acres := (v_share_row->>'field_applied_acres')::numeric;
      v_share_pct           := (v_share_row->>'split_pct')::numeric;
      v_share_acres         := (v_share_row->>'share_acres')::numeric;
      v_field_override      := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note  := v_share_row->>'pricing_note';

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

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      DECLARE
        v_chem_qty_a   numeric := 0;
        v_chem_qty_b   numeric := 0;
        v_rate         numeric;
        v_qa_unit_cost bigint;
        v_wh           text := NULLIF(v_chem->>'warehouse', '');
        v_vendor       text := NULLIF(v_chem->>'vendor', '');
        v_form         text;
        v_epa          text := NULLIF(v_chem->>'epa_registration', '');
        v_ta_unit      text := COALESCE(NULLIF(v_chem->>'rate_unit',''), NULLIF(v_chem->>'unit_size',''));
        v_conv         record;
        v_inv_unit     text;       -- PARKED-010: product's sold/pricing unit (inventory_unit)
        v_priced_qty   numeric;    -- PARKED-010: applied qty converted into the pricing unit
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

        IF (v_chem->>'product_id') IS NOT NULL THEN
          SELECT p.product_form::text, COALESCE(v_epa, p.epa_registration), COALESCE(v_vendor, p.vendor), p.inventory_unit
            INTO v_form, v_epa, v_vendor, v_inv_unit
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;

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

        IF v_chem_qty_a > 0 THEN
          v_qa_unit_cost := COALESCE((v_chem->>'cost_cents')::bigint, 0);
          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_a, 4), v_ta_unit, v_form);
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            (v_chem->>'description') || ' — included in grower share',
            ROUND(v_chem_qty_a, 4),
            v_chem->>'unit_size',
            0, 0, v_qa_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            false,
            'manual',
            v_wh, v_vendor, ROUND(v_chem_qty_a, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );
          v_invoice_cost := v_invoice_cost + safe_cents_qty(v_qa_unit_cost, v_chem_qty_a);
        END IF;

        IF v_chem_qty_b > 0 THEN
          v_unit_price   := NULL;
          v_quoted_price := NULL;
          v_price_source := NULL;

          IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
             AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
            v_unit_price   := (v_chem->>'unit_price_cents')::bigint;
            v_price_source := 'manual';
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT qi.price_per_unit INTO v_qi_price
              FROM quote_items qi
              JOIN quote_sections qs ON qs.id = qi.section_id
             WHERE qi.product_id = (v_chem->>'product_id')::uuid
               AND qs.field_id   = ANY(v_field_ids)
             ORDER BY qi.id LIMIT 1;
            IF v_qi_price IS NOT NULL THEN
              v_unit_price   := ROUND(v_qi_price * 100)::bigint;
              v_quoted_price := v_unit_price;
              v_price_source := 'quoted';
            END IF;
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
            END INTO v_unit_price
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
            v_price_source := 'tier';
          END IF;

          v_unit_price := COALESCE(v_unit_price, 0);
          v_unit_cost  := COALESCE((v_chem->>'cost_cents')::bigint, 0);

          -- PARKED-010 (field-app billing unit fix): the applied amount (v_chem_qty_b) is in the
          -- RATE unit (e.g. oz), but v_unit_price is per the product's SOLD unit (inventory_unit,
          -- e.g. $/gal). Convert the applied amount into the pricing unit BEFORE multiplying, so a
          -- 16 oz/ac product at $32.10/gal bills $/gal x gallons (not $/gal x ounces = ~128x high).
          -- Manual line (no product_id): no inventory_unit, so price in the rate unit as entered
          -- (identity). If the units genuinely do not convert (e.g. an oz rate on a product sold
          -- "per unit"), refuse rather than silently mis-bill.
          v_priced_qty := field_app_priced_quantity(v_chem_qty_b, v_ta_unit, COALESCE(v_inv_unit, v_ta_unit), v_form);
          IF v_priced_qty IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "%" — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), v_ta_unit, COALESCE(v_inv_unit, v_ta_unit);
          END IF;
          -- Round once to the stored precision so quantity x unit_price == extended_cents
          -- (the invoice line stays internally consistent on any later re-compute).
          v_priced_qty := ROUND(v_priced_qty, 4);
          v_extended   := safe_cents_qty(v_unit_price, v_priced_qty);

          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_b, 4), v_ta_unit, v_form);

          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            quoted_price_cents, is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            v_chem->>'description',
            ROUND(v_priced_qty, 4),
            COALESCE(v_inv_unit, v_chem->>'unit_size'),
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source,
            v_wh, v_vendor, ROUND(v_chem_qty_b, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );

          v_invoice_total := v_invoice_total + v_extended;
          -- PARKED-010: cost (v_unit_cost is also per the SOLD unit) must use the converted
          -- quantity too, otherwise margin = revenue(gallons) - cost(ounces) is wildly wrong.
          v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_priced_qty);
        END IF;
      END;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season                 = current_season()
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
        INTO v_fee_acres
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

    -- #32: FUEL SURCHARGE LINE (owner-configured; OFF + blank by default = NOTHING here).
    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_invoice_total);

    IF v_surcharge_cents > 0 THEN
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, 'Fuel Surcharge', 1,
        v_surcharge_cents, v_surcharge_cents, 0,
        9998, NULL, NULL, NULL,
        true, 'manual'
      );
      v_invoice_total := v_invoice_total + v_surcharge_cents;
    END IF;
    -- #32 END

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost,
      updated_at         = now()
    WHERE id = v_invoice_id;

    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
          'customer_id', v_customer_id,
          'total_cents', v_invoice_total
        ),
        v_invoice_total,
        'Field application invoice created'
      );
    END IF;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_total_share_acres
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
      CASE WHEN v_has_override
        THEN (SELECT (value->>'price_override_cents')::bigint
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'pricing_note')
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END
    );
  END LOOP;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO field_app_locations (
      invoice_id, invoice_group_id,
      field_id, map_number, total_acres, planted_acres,
      applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      CASE WHEN v_invoice_group_id IS NULL THEN v_invoice_ids[1] ELSE NULL END,
      v_invoice_group_id,
      (v_loc->>'field_id')::uuid,
      (v_loc->>'map_number')::int,
      (v_loc->>'total_acres')::numeric,
      (v_loc->>'planted_acres')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type',
      v_loc->>'wind_direction',
      COALESCE((v_loc->>'sort_order')::int, 0)
    ) RETURNING id INTO v_loc_id;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'field_id')::uuid = (v_loc->>'field_id')::uuid
        AND NOT ((value->>'customer_id')::uuid = ANY(v_skipped_customer_ids))
    LOOP
      INSERT INTO field_app_location_shares (
        location_id, customer_id, split_pct, acres, amount_cents
      ) VALUES (
        v_loc_id,
        (v_share_row->>'customer_id')::uuid,
        (v_share_row->>'split_pct')::numeric,
        (v_share_row->>'share_acres')::numeric,
        0
      );
    END LOOP;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN p_invoice_id IS NULL THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    'Field app invoice ' ||
      CASE WHEN v_invoice_group_id IS NOT NULL
           THEN '(group of ' || v_customer_count || ') '
           ELSE '' END ||
      'saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_app_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- _save_field_app_split_invoice_impl: md5(prosrc) 263dee1e74eab819f36dafbe59a5ba5e
CREATE OR REPLACE FUNCTION public._save_field_app_split_invoice_impl(p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor              uuid := auth.uid();
  v_req_salesman       uuid;
  v_salesman_id        uuid;
  v_field_ids          uuid[] := '{}';
  v_applied_acres_map  jsonb  := '{}'::jsonb;
  v_fld                jsonb;
  v_this_acres         numeric;
  v_vector             jsonb;          -- default vector [{customer_id, micro_pct}]
  v_micro_map          jsonb := '{}'::jsonb;
  v_members            text[];         -- billing-set member customer_ids, sorted ASC
  v_set_id             uuid;
  v_group_id           uuid;
  v_line               jsonb;
  v_idx                int := 0;
  v_line_id            uuid;
  v_line_kind          text;
  v_product_id         uuid;
  v_app_service_id     uuid;
  v_line_desc          text;
  v_src_qty            numeric;
  v_src_acres          numeric;
  v_src_unit_price     bigint;
  v_src_flat           bigint;
  v_base_source        text;
  v_eff_rate_unit      text;           -- display unit for the line (pricing unit after chemical conversion)
  v_chem_price_map     jsonb;          -- chemical Option B: customer_id -> that customer's own resolved unit price
  v_svc_price_map      jsonb;          -- service Option B: customer_id -> that customer's own per-acre service rate
  v_uniform_price      bigint;         -- chemical/service: the single price when ALL co-owners match (routes round-once)
  v_repr_base_price    bigint;         -- resolved representative base BEFORE the uniform-override penny guard (Codex r7 P2 audit base)
  v_inv_field_names    text[];         -- denormalized field names for the child invoice row (Codex r7 P2)
  v_inv_crop_type      text;           -- denormalized representative crop for the child invoice row (Codex r7 P2)
  v_inv_applicator_name text;          -- source-job applicator, denormalized onto the child (Codex r8 P2)
  v_inv_vehicle_name   text;           -- source-job vehicle, denormalized onto the child (Codex r8 P2)
  v_line_unit_cost     bigint;         -- per-unit COGS for the current line (Codex P1 #3)
  v_invoice_cost       bigint;         -- per-child accumulated total_cost_cents (Codex P1 #3)
  v_is_new_invoice     boolean;        -- true only when a child invoice row is freshly INSERTed (Codex P1 #8)
  v_total_applied_acres numeric := 0;  -- SUM(applied_acres) across p_fields (Codex P2 #9 acre derivation)
  v_shares             jsonb;
  v_line_customers     text[];
  v_calc               jsonb;
  v_app_service        record;
  v_svc_name           text;   -- safe copy of v_app_service.name (fix: unassigned-record crash)
  v_line_plans         jsonb := '[]'::jsonb;   -- [{meta..., alloc}]
  v_plan               jsonb;
  v_cust               text;
  v_customer_id        uuid;
  v_customer_name      text;
  v_is_primary         boolean;
  v_invoice_id         uuid;
  v_invoice_number     text;
  v_invoice_total      bigint;
  v_invoice_ids        uuid[] := '{}';
  v_alloc_row          jsonb;
  v_item_id            uuid;
  v_qty                numeric;
  v_acres_alloc        numeric;
  v_cust_acres         numeric;
  v_send_disposition   text;
  v_line_hashes        jsonb := '[]'::jsonb;
  v_item_price_source  text;
  v_item_cost_cents    bigint;   -- per-item cost_cents (per-unit for chemical, EXTENDED for fee) — Codex r2 #F
  -- #E source-job double-bill guard (Codex round-2 P1) + round-3 season/freeze
  v_job                record;
  v_other_set          uuid;
  v_set_child_ids      uuid[];    -- this set's child invoice ids captured BEFORE orphan-cancel (round-5 B1)
  v_set_source_job     uuid;     -- the set's frozen source_job_id on re-save (round-3 P1)
  v_season             integer;  -- job/invoice season for pricing + stamping (round-3 P1)
  v_job_app_date       date;     -- source job's application/scheduled date for child invoices (round-3 P2)
  -- Commissions on the split (Codex round-4 P1): mirror transfer_job_to_invoice per child
  v_commission_split   jsonb;
  v_child_id           uuid;
  v_child_customer     uuid;
  v_child_profit       numeric;
  -- Codex round-5 P1: per-child CHEMICAL profit using the LR-allocated COGS (not a re-rounded
  -- cost*qty), so commissions tie to the penny-exact allocation already in the header.
  v_invoice_chem_profit  bigint;
  v_chem_profit_by_child jsonb := '{}'::jsonb;   -- child invoice_id::text -> chemical profit cents
  -- #G canonical line COGS + its largest-remainder split (Codex round-2 P1)
  v_line_cogs          bigint;
  v_cogs_weights       jsonb;
  v_cogs_map           jsonb;
  -- #M audited-base + #L reason capture (Codex round-2 P2)
  v_caller_override    text[];   -- customers the caller priced as a genuine manual override
  v_svc_source_map     jsonb;    -- service: customer_id -> 'service_rate' | 'service_default'
  v_reasons_map        jsonb;    -- customer_id -> {split_reason, price_reason}
  v_share_base_price   bigint;
  v_share_base_source  text;
  v_share_price_mode   text;
  v_split_reason       text;
  v_price_reason       text;
  -- invariant probes
  v_sum_cents          bigint;
  v_src_line_cents     bigint;
  v_sum_qty            numeric;
  v_sum_micro          bigint;
  v_line_member_count  int;
  v_line_src_qty       numeric;
  v_result             jsonb;
BEGIN
  -- ---- GUARDS (defense-in-depth; the wrapper already checked these) -----------
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required';
  END IF;

  -- Codex round-4 P1 (posting-boundary integrity): mark THIS transaction as the legitimate
  -- split writer. The trg_guard_split_invoice_items trigger (below) blocks any other path —
  -- notably the generic save_invoice, whose FIELD_INVOICE_SPLIT_LOCKED guard does NOT fire for
  -- our single-compat-share children — from deleting a split child's invoice_items and
  -- cascading away its invoice_line_shares. is_local = true: auto-resets at txn end.
  PERFORM set_config('crx.split_writer', 'on', true);

  -- Salesman attribution: admin may name anyone; a sales_rep is forced to self.
  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  -- ---- FIELDS + Mode-A rejection ---------------------------------------------
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array'
     OR jsonb_array_length(p_fields) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_FIELDS: at least one field is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_fld IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    v_this_acres := (v_fld->>'applied_acres')::numeric;
    IF v_this_acres IS NULL OR v_this_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_ZERO_ACRES: applied acres must be > 0 for field %', v_fld->>'field_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_fld->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map
      || jsonb_build_object(v_fld->>'field_id', v_this_acres);
  END LOOP;

  -- Codex round-4 P1: reject a field id appearing more than once. A duplicate would
  -- double-count its acres into the ownership vector / compat share AND write a duplicate
  -- field_app_locations snapshot for the group. (v_applied_acres_map would silently collapse
  -- dupes to one key, so the acres map and the raw field array could disagree.)
  IF (SELECT count(*) FROM unnest(v_field_ids)) <>
     (SELECT count(DISTINCT x) FROM unnest(v_field_ids) AS x) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_FIELD: a field id appears more than once in p_fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Mode-A: reject the ENTIRE feature for any grower-share field (spec §5).
  IF EXISTS (
    SELECT 1 FROM field_billing_defaults d
     WHERE d.field_id = ANY(v_field_ids)
       AND d.price_override_cents IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MODE_A_UNSUPPORTED: per-line split billing is not available for grower-share (Mode A) fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ---- DEFAULT VECTOR + member set -------------------------------------------
  v_vector := resolve_line_split_vector(v_field_ids, p_source_job_id, v_applied_acres_map);

  SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
    INTO v_members
    FROM jsonb_array_elements(v_vector) AS value;

  SELECT COALESCE(jsonb_object_agg(value->>'customer_id', (value->>'micro_pct')::bigint), '{}'::jsonb)
    INTO v_micro_map
    FROM jsonb_array_elements(v_vector) AS value;

  -- ---- CUSTOMER-SCOPE SECURITY (Codex P1 #4, 2026-07-18) ---------------------
  -- This SECURITY DEFINER writer bypasses RLS. Mirror the customers RLS / save_customer
  -- ownership model: a non-admin sales_rep may bill ONLY customers assigned to them.
  -- The billing members are DERIVED from field ownership, so an actor could otherwise
  -- name another rep's fields and create/replace their customers' invoice lines. Verify
  -- every derived member is assigned to the actor. (Existing children on re-save are
  -- checked in the re-save block below, before any delete.)
  IF NOT is_admin() THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_members) AS m(cust)
      LEFT JOIN customers c ON c.id = m.cust::uuid
      WHERE c.id IS NULL OR c.assigned_sales_rep IS DISTINCT FROM v_actor
    ) THEN
      RAISE EXCEPTION 'SPLIT_CUSTOMER_NOT_ASSIGNED: not authorized to bill one or more of these customers'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Total applied acres across the fields — the acre basis for the per-customer compat
  -- share row (Codex P2 #9), derived ONCE here, independent of the billing lines.
  SELECT COALESCE(SUM((f->>'applied_acres')::numeric), 0) INTO v_total_applied_acres
    FROM jsonb_array_elements(p_fields) AS f;

  -- Codex round-7 P2: denormalized field context for the child invoice ROW. FieldInvoicesListPanel +
  -- buildInvoicePdfDataFromRow read invoices.field_names/crop_type/total_acres directly (the dedicated
  -- Drafts/Posted panels hydrate field_app_locations, but the COMBINED list + its PDFs use the row) —
  -- without these each split child shows blank acreage/fields/crop in the combined list and exports.
  SELECT array_agg(fl.field_name ORDER BY t.ord),
         (array_agg(fl.crop_type ORDER BY t.ord) FILTER (WHERE fl.crop_type IS NOT NULL))[1]
    INTO v_inv_field_names, v_inv_crop_type
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- LINES ------------------------------------------------------------------
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_LINES: at least one billing line is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Codex round-7 P1 (RUP under-reporting): reject the SAME chemical product on more than one line.
  -- Two chemical lines with the same product create two invoice_items with the same
  -- (invoice_id, product_id); generate_rup_sales_records de-dups by (invoice_id, product_id) and
  -- inserts only the FIRST, silently under-reporting the regulated quantity + amount of the second.
  -- The operator must combine them into one line (mirrors the SPLIT_DUPLICATE_FIELD guard).
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS l
     WHERE l->>'line_kind' = 'chemical' AND NULLIF(l->>'product_id', '') IS NOT NULL
     GROUP BY l->>'product_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_PRODUCT: the same chemical product appears on more than one line — combine them into a single line'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
    v_svc_name := v_app_service.name;
  END IF;

  -- ---- RE-SAVE: reuse an existing DRAFT/UNPOSTED billing set -----------------
  -- The wrapper already advisory-locked the set's group and FOR UPDATE-locked the
  -- child invoices, and asserted all draft/unposted. Here we clear the prior child
  -- LINE DATA (invoice_items — cascades invoice_line_shares — plus compat shares and
  -- the billing lines) but we do NOT hard-delete the invoice ROWS: a child that was
  -- posted-then-unposted carries append-only invoice_line_share_snapshots whose FK is
  -- ON DELETE RESTRICT, so a hard invoice delete would abort the whole re-save
  -- (adversarial F1). Instead PASS 2 REUSES the existing child invoice per customer
  -- (UPDATE), preserving its invoice_number + snapshot history, and only INSERTs for a
  -- newly-added customer. The freeze trigger permits the share rewrite because every
  -- member is draft/unposted (not posted).
  IF p_billing_set_id IS NOT NULL THEN
    SELECT id, invoice_group_id, source_job_id INTO v_set_id, v_group_id, v_set_source_job
      FROM field_app_billing_sets WHERE id = p_billing_set_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing set not found: %', p_billing_set_id;
    END IF;

    -- Freeze the source job on re-save (Codex round-3 P1): the set's source_job_id is set
    -- once at first Save and drives the #E consume/guard below. Allowing it to change would
    -- let one billing set consume TWO jobs (the new one gets marked invoiced while the old
    -- stays invoiced and linked). Reject any change; the operator must start a new set.
    IF p_source_job_id IS DISTINCT FROM v_set_source_job THEN
      RAISE EXCEPTION 'SPLIT_JOB_IMMUTABLE: the source job cannot be changed on a saved split set (was %, got %)',
        v_set_source_job, p_source_job_id USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Ownership on re-save (Codex P1 #4): a non-admin may only modify a set whose EXISTING
    -- children all belong to customers assigned to the actor (before any delete/insert).
    IF NOT is_admin() AND EXISTS (
      SELECT 1 FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.field_app_billing_set_id = v_set_id AND i.deleted_at IS NULL
        AND c.assigned_sales_rep IS DISTINCT FROM v_actor
    ) THEN
      RAISE EXCEPTION 'SPLIT_SET_NOT_OWNED: not authorized to modify this billing set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Only EDITABLE children are cleared for the rebuild. A voided/cancelled child keeps its
    -- invoice_items/invoice_shares as the printed audit record of what was billed then reversed
    -- (RLS review M1) — its billing-line links are NULLed below so the line DELETE stays FK-safe.
    -- Posted/paid children can't reach here (the wrapper's already-posted block rejects the set).
    DELETE FROM invoice_items
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    DELETE FROM invoice_shares
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    -- Fable-adversarial BLOCKER: a SOFT-deleted child (via the live delete_invoices) is NOT in the
    -- delete above (deleted_at IS NOT NULL), but its invoice_items still reference this set's
    -- field_app_billing_lines (invoice_items.billing_line_id FK, NO ACTION) — so the DELETE below
    -- would 23503-abort and BRICK every future re-save. NULL those dangling refs first (the soft-
    -- deleted invoice keeps its items as history; only the now-meaningless billing-line link is
    -- cleared). PASS 2 then re-creates a child for that customer if they are still a member.
    UPDATE invoice_items SET billing_line_id = NULL
      WHERE billing_line_id IN (SELECT id FROM field_app_billing_lines WHERE billing_set_id = v_set_id);
    DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id;
    -- Clear the prior group's field snapshots; PASS 3 re-creates them from p_fields (Codex P1 #7).
    DELETE FROM field_app_locations WHERE invoice_group_id = v_group_id;

    -- Round-5 B1: snapshot this set's current child ids BEFORE the orphan-cancel below detaches any
    -- dropped member (it nulls field_app_billing_set_id). The #E already-invoiced guard uses this so a
    -- re-save that drops the member currently stored in jobs.invoice_id still recognizes that anchor as
    -- OURS — otherwise the just-detached anchor looks like a foreign invoice and trips a false
    -- SPLIT_JOB_ALREADY_INVOICED, blocking the drop-member re-save entirely.
    SELECT array_agg(id) INTO v_set_child_ids
      FROM invoices WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL;

    -- Any existing EDITABLE child whose customer is no longer a billing-set member is
    -- soft-cancelled + detached from the set (its snapshots stay pointing at it,
    -- audit intact) — never hard-deleted. Mirrors the live orphan-cancel path.
    -- Fable-adversarial: only draft/unposted children — a child already voided/cancelled via the
    -- live void_invoice must be skipped, since draft->cancelled is fine but voided->cancelled is a
    -- forbidden status transition that would abort the whole re-save.
    UPDATE invoices
       SET status = 'cancelled', invoice_group_id = NULL, field_app_billing_set_id = NULL,
           total_amount_cents = 0, total_cost_cents = 0, send_disposition = 'normal',
           updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND deleted_at IS NULL
       AND status IN ('draft', 'unposted')
       AND customer_id::text <> ALL (v_members);

    -- Codex round-6 P1: a child VOIDED/CANCELLED (or soft-deleted) via the live void/cancel/delete
    -- path stays attached to this set's invoice_group_id. PASS 2 skips it (reuse is draft/unposted +
    -- not-deleted only) and mints a fresh replacement, BUT post_invoice_group loops EVERY non-filtered
    -- member of the group and RAISES on any status not in (draft,unposted) — so leaving the terminal/
    -- deleted child in the group makes the rebuilt group permanently UNPOSTABLE. Detach such children
    -- from the group (invoice_group_id = NULL) so only active draft/unposted children remain postable;
    -- they keep field_app_billing_set_id as set/audit history and the replacement carries the group.
    UPDATE invoices
       SET invoice_group_id = NULL, updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND invoice_group_id IS NOT NULL
       AND (deleted_at IS NOT NULL OR status IN ('voided', 'cancelled'));
  ELSE
    -- New set. R7: ALWAYS assign an invoice_group_id (even single recipient) so
    -- posting is uniformly post_invoice_group and the set is the durable anchor.
    v_group_id := gen_random_uuid();
    INSERT INTO field_app_billing_sets (invoice_group_id, source_job_id, created_by)
    VALUES (v_group_id, p_source_job_id, p_performed_by)
    RETURNING id INTO v_set_id;
  END IF;

  -- ---- #E SOURCE-JOB DOUBLE-BILL GUARD (Codex round-2 P1, 2026-07-18) ---------
  -- source_job_id was recorded as provenance only, so the SAME job could be billed
  -- here AND again through the normal transfer_job_to_invoice flow (double-bill).
  -- Lock the job, refuse it if it was already billed elsewhere, and (after the child
  -- invoices exist) consume it exactly like transfer_job_to_invoice does — flipping
  -- jobs.status to 'invoiced' so that path's own "Job already invoiced" guard fires.
  -- All checks are re-save-safe: this set's own already-consumed job passes.
  IF p_source_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = p_source_job_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_FOUND: source job % not found', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- This SECURITY DEFINER writer bypasses RLS and now MUTATES jobs, so a non-admin may
    -- consume only a job whose customer is assigned to them (mirrors the member-scope check).
    -- No IS NOT NULL short-circuit (RLS review M1): a job with a NULL customer_id must be
    -- REFUSED for a non-admin, not skipped — NOT EXISTS is true when customer_id is null.
    IF NOT is_admin()
       AND NOT EXISTS (SELECT 1 FROM customers c
                        WHERE c.id = v_job.customer_id AND c.assigned_sales_rep = v_actor) THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_ASSIGNED: not authorized to bill source job %', p_source_job_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Already tied to a DIFFERENT split billing set?
    SELECT id INTO v_other_set FROM field_app_billing_sets
      WHERE source_job_id = p_source_job_id AND id IS DISTINCT FROM v_set_id
      LIMIT 1;
    IF v_other_set IS NOT NULL THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_BILLED: source job % is already on split billing set %',
        p_source_job_id, v_other_set USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Already invoiced by the normal flow (linked to an invoice that is NOT one of THIS set's children)?
    -- Round-5 B1: accept the anchor if it is STILL attached to this set OR was one of this set's
    -- children before the orphan-cancel above detached it (a drop-anchor re-save) — v_set_child_ids is
    -- the pre-cancel snapshot; NULL on a first save (COALESCE to empty, so the EXISTS still governs).
    IF v_job.status = 'invoiced' AND v_job.invoice_id IS NOT NULL
       AND NOT (v_job.invoice_id = ANY (COALESCE(v_set_child_ids, ARRAY[]::uuid[])))
       AND NOT EXISTS (SELECT 1 FROM invoices i
                        WHERE i.id = v_job.invoice_id AND i.field_app_billing_set_id = v_set_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_INVOICED: source job % was already invoiced (invoice %)',
        p_source_job_id, v_job.invoice_id USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Must be completed (or already this set's) to bill — mirrors transfer_job_to_invoice.
    IF v_job.status NOT IN ('completed', 'invoiced') THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_COMPLETED: source job % must be completed to bill (status: %)',
        p_source_job_id, v_job.status USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Codex round-4 P1 + round-5 P1: the billed fields must EXACTLY EQUAL the job's job_fields.
    -- Consuming the job marks the WHOLE job 'invoiced', so billing only a subset (or unrelated
    -- fields) would silently orphan the job's other fields — normal transfer then refuses the
    -- now-invoiced job, so that work can never be billed. Enforce set equality (⊆ AND ⊇), exactly
    -- like transfer_job_to_invoice which always bills every job_field. (a) no billed field outside
    -- the job:
    IF EXISTS (
      SELECT 1 FROM unnest(v_field_ids) AS fid
       WHERE NOT EXISTS (SELECT 1 FROM job_fields jf
                          WHERE jf.job_id = p_source_job_id AND jf.field_id = fid)
    ) THEN
      RAISE EXCEPTION 'SPLIT_FIELD_NOT_ON_JOB: one or more billed fields do not belong to source job %', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- (b) no job field left unbilled:
    IF EXISTS (
      SELECT 1 FROM job_fields jf
       WHERE jf.job_id = p_source_job_id
         AND NOT (jf.field_id = ANY (v_field_ids))
    ) THEN
      RAISE EXCEPTION 'SPLIT_JOB_FIELDS_INCOMPLETE: billing a source job must include ALL of its fields (the whole job is consumed as invoiced); job % has fields not in this split', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_job_app_date := v_job.job_date;          -- carried onto each child (round-3 P2); the LIVE
                                               -- jobs table has job_date (no scheduled_date), and
                                               -- live transfer_job_to_invoice uses job_date too.
    v_season       := v_job.season;            -- capture here (v_job is a bare record, only assigned
                                               -- inside this guard; referencing v_job.season outside
                                               -- it — even in a not-taken CASE branch — raises 55000).
    -- Codex round-8 P2: denormalize the job's applicator + vehicle onto each child (like
    -- transfer_job_to_invoice) — field-invoice lists and PDFs read these invoice columns, so without
    -- them a split child loses who applied it and with what equipment. Job-less splits stay NULL.
    IF v_job.applicator_id IS NOT NULL THEN
      SELECT full_name INTO v_inv_applicator_name FROM profiles WHERE id = v_job.applicator_id;
    END IF;
    IF v_job.vehicle_id IS NOT NULL THEN
      SELECT vehicle_name INTO v_inv_vehicle_name FROM vehicles WHERE id = v_job.vehicle_id;
    END IF;
  END IF;

  -- Season for per-customer service-rate lookups AND the child invoice stamp (Codex round-3 P1):
  -- the SOURCE JOB's season if billing a job (captured above), else the invoice DATE's season, else
  -- current. current_season() alone mis-priced a backdated/prior-season job and filed the wrong year.
  v_season := COALESCE(
    v_season,
    compute_season(COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE)),
    current_season());

  -- ---- PASS 1: build billing lines + compute allocations ----------------------
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_idx            := v_idx + 1;
    v_line_kind      := v_line->>'line_kind';
    v_product_id     := (v_line->>'product_id')::uuid;
    v_app_service_id := COALESCE((v_line->>'application_service_id')::uuid, p_application_service_id);
    v_line_desc      := v_line->>'description';
    v_src_qty        := (v_line->>'source_quantity')::numeric;
    v_src_acres      := (v_line->>'source_acres')::numeric;
    v_src_flat       := (v_line->>'source_flat_cents')::bigint;
    v_src_unit_price := (v_line->>'source_unit_price_cents')::bigint;
    v_base_source    := v_line->>'base_price_source';
    v_eff_rate_unit  := v_line->>'rate_unit';   -- default; chemical overrides to the pricing unit below
    v_chem_price_map := NULL;                    -- chemical-only; NULL keeps non-chemical lines untouched
    v_svc_price_map  := NULL;                    -- service-only; NULL keeps non-service lines untouched
    v_svc_source_map := NULL;                    -- service-only: customer_id -> resolved source (#M)
    v_line_unit_cost := 0;                       -- per-unit COGS for this line (Codex P1 #3)

    -- #M: customers the CALLER explicitly priced as a genuine manual per-person override
    -- (those stay audited as an 'override'; every other co-owner's resolved per-customer
    -- price is stored as their BASE, not an override vs the largest-share owner). #L: the
    -- operator's reason for a customized split / price, captured per co-owner.
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array' THEN
      -- Codex round-4 P1 (server defense-in-depth for the editor's per-share guard): a
      -- per-PERSON price override must be a POSITIVE amount. Below, a share flagged
      -- price_mode='override' with a non-null override_unit_price_cents is treated as a genuine
      -- caller override and billed at that price — so a 0 / negative value (e.g. the editor's
      -- "1e5" → 0 path, or a direct RPC call) would bill $0 and give product away. Reject it.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_line->'shares') AS s
         WHERE s->>'price_mode' = 'override'
           AND s->'override_unit_price_cents' IS NOT NULL
           AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
           AND (s->>'override_unit_price_cents')::bigint <= 0
      ) THEN
        RAISE EXCEPTION 'SPLIT_SHARE_OVERRIDE_INVALID: a per-person price override on line % must be a positive amount', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT array_agg(s->>'customer_id')
        INTO v_caller_override
        FROM jsonb_array_elements(v_line->'shares') AS s
       WHERE s->>'price_mode' = 'override'
         AND s->'override_unit_price_cents' IS NOT NULL
         AND jsonb_typeof(s->'override_unit_price_cents') <> 'null';
      SELECT jsonb_object_agg(s->>'customer_id', jsonb_build_object(
               'split_reason', NULLIF(btrim(COALESCE(s->>'split_override_reason', '')), ''),
               'price_reason', NULLIF(btrim(COALESCE(s->>'price_override_reason', '')), '')))
        INTO v_reasons_map
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      v_caller_override := NULL;
      v_reasons_map     := '{}'::jsonb;
    END IF;

    IF v_line_kind IS NULL
       OR v_line_kind NOT IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee') THEN
      RAISE EXCEPTION 'SPLIT_BAD_LINE_KIND: %', COALESCE(v_line_kind, '<null>')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Base-price resolution by kind (see SCOPE NOTE at top for the chemical caveat).
    IF v_line_kind = 'service' THEN
      -- Per-line service record (Codex P1 #1): the editor sends the service id on the LINE
      -- (line.application_service_id); the old code only loaded v_app_service from the always-null
      -- top-level p_application_service_id, so v_app_service was never assigned. Load it per line.
      IF v_app_service_id IS NULL THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_NO_SERVICE: service line % requires an application service', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT * INTO v_app_service FROM application_services WHERE id = v_app_service_id;
      IF NOT FOUND OR NOT v_app_service.is_active THEN
        RAISE EXCEPTION 'Application service not found or inactive: %', v_app_service_id;
      END IF;
      v_svc_name := v_app_service.name;

      IF v_src_acres IS NULL THEN
        v_src_acres := v_total_applied_acres;
      END IF;
      -- Fable-adversarial HIGH: service source_acres is the billable basis and was the one billable
      -- input with no positivity guard (round-5 covered chemical qty, service RATE, flat cents, per-
      -- share override). A direct/modified RPC call with a negative or zero value would mint a NEGATIVE
      -- (credit) invoice that reduces AR and passes every §5 invariant (signed LR; total<>0 so not $0-
      -- suppressed). The editor only sends positive acres; enforce it server-side.
      IF v_src_acres <= 0 THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_ACRES_NONPOSITIVE: service line % requires source_acres > 0', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      -- Service COGS: per-acre cost from the service record (mirrors the live field-app path,
      -- which uses application_services.cost_per_acre_cents). Codex P1 #3.
      v_line_unit_cost := COALESCE(v_app_service.cost_per_acre_cents, 0);

      IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
        -- Explicit single negotiated per-acre rate for the whole line (applies to everyone).
        -- Codex round-5 P1: enforce a POSITIVE amount server-side (the editor rejects <=0, but a
        -- direct/modified RPC call could otherwise create a free or negative service line).
        IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
          RAISE EXCEPTION 'SPLIT_SERVICE_RATE_NONPOSITIVE: a manual service rate must be a positive amount on line %', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_base_source := COALESCE(v_base_source, 'service_rate');
      ELSE
        -- Per-customer service rate (Codex P1 #2 — Option B for service): each co-owner at
        -- their OWN customer_application_rates(service, INVOICE/JOB season) → service default,
        -- exactly like the live per-child field-app save. v_season (round-3 P1) ensures a
        -- backdated/prior-season job uses that season's historical rate, not current_season().
        SELECT COALESCE(jsonb_object_agg(m.cust, COALESCE(
                 (SELECT car.rate_per_acre_cents FROM customer_application_rates car
                   WHERE car.customer_id            = m.cust::uuid
                     AND car.application_service_id = v_app_service_id
                     AND car.season                 = v_season
                   LIMIT 1),
                 v_app_service.default_rate_per_acre_cents, 0)), '{}'::jsonb)
          INTO v_svc_price_map
          FROM unnest(v_members) AS m(cust);
        -- #M: the precise per-customer source (a custom customer_application_rates row =>
        -- 'service_rate', otherwise the service default => 'service_default'), so each
        -- co-owner's audited base_price_source is their OWN resolved source. Same season (round-3).
        SELECT jsonb_object_agg(m.cust, CASE WHEN EXISTS (
                 SELECT 1 FROM customer_application_rates car
                  WHERE car.customer_id            = m.cust::uuid
                    AND car.application_service_id = v_app_service_id
                    AND car.season                 = v_season)
               THEN 'service_rate' ELSE 'service_default' END)
          INTO v_svc_source_map
          FROM unnest(v_members) AS m(cust);
        -- Representative (display + the calculator's default price): the largest-share owner's rate.
        v_src_unit_price := COALESCE((v_svc_price_map->>(
            SELECT (value->>'customer_id') FROM jsonb_array_elements(v_vector) AS value
             ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC LIMIT 1))::bigint, 0);
        v_base_source := COALESCE(v_base_source, 'service_default');
      END IF;
    ELSIF v_line_kind = 'chemical' THEN
      -- R8 (Option B — Mason 2026-07-18): resolve the price SERVER-SIDE and price EACH
      -- co-owner's share at THAT customer's OWN tier (manual override → field quote apply to
      -- everyone; only the tier fallback differs per customer — exactly like the live per-child
      -- field-app save). Also convert the applied quantity rate-unit → product sold unit.
      DECLARE
        v_chem_manual bigint  := NULL;
        v_rep_tier    integer;
        v_inv_unit    text;
        v_form        text;
        v_priced_qty  numeric;
        v_price_res   jsonb;
        v_rate_unit   text := NULLIF(btrim(coalesce(v_line->>'rate_unit', '')), '');
      BEGIN
        IF v_product_id IS NULL THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_PRODUCT: chemical line % requires product_id', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_src_qty IS NULL OR v_src_qty <= 0 THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_QUANTITY: chemical line % requires source_quantity > 0', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Honor a caller price ONLY as an explicit manual override (a single negotiated price
        -- for the whole line — applies to every co-owner).
        IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
          -- Codex round-5 P1: require a POSITIVE manual price server-side (the editor rejects
          -- <=0 / sci-notation, but a direct or modified-client RPC call could otherwise create a
          -- free or negative chemical line despite the UI invariant).
          IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
            RAISE EXCEPTION 'SPLIT_CHEMICAL_OVERRIDE_PRICE_REQUIRED: manual_override set but source_unit_price_cents is missing or not positive on chemical line %', v_idx
              USING ERRCODE = 'invalid_parameter_value';
          END IF;
          v_chem_manual := v_src_unit_price;
        END IF;

        -- Product units for the rate -> pricing-unit conversion, plus the server-resolved
        -- unit COST (Codex P1 #3). current_cost is dollars per the product's inventory (sold)
        -- unit — the SAME unit as the priced quantity below — so per-unit cents = round(*100),
        -- exactly like _snapshot_order_item_cost and the parked save_invoice.
        SELECT p.inventory_unit, p.product_form,
               COALESCE(round(p.current_cost * 100)::bigint, 0)
          INTO v_inv_unit, v_form, v_line_unit_cost
          FROM products p WHERE p.id = v_product_id;

        -- Per-customer price map (Option B): each billing-set member priced at their OWN
        -- assigned_tier. resolve_field_app_chemical_price() naturally makes manual/quote shared
        -- (tier-independent) and only the tier fallback per-customer, so a manual/quote line
        -- yields identical prices for everyone (calculator collapses to source_lr) while a
        -- pure-tier line prices each co-owner at their own tier (calculator per_person).
        SELECT COALESCE(jsonb_object_agg(
                 m.cust,
                 (resolve_field_app_chemical_price(
                    v_product_id, v_field_ids,
                    COALESCE((SELECT c.assigned_tier FROM customers c WHERE c.id = m.cust::uuid), 1),
                    v_chem_manual)->>'unit_price_cents')::bigint), '{}'::jsonb)
          INTO v_chem_price_map
          FROM unnest(v_members) AS m(cust);

        -- Codex round-11 P1: reject an UNRESOLVED chemical price. Without a manual override, if any
        -- co-owner's resolved price (field quote → their assigned tier) is NULL or <= 0, the line would
        -- bill $0, be flagged suppressed_zero_total, and STILL post — consuming inventory + RUP records
        -- with NO receivable and no operator signal. Require a real positive price for EVERY member. A
        -- manual override (already validated > 0 above) resolves the same for everyone, so it passes.
        IF v_chem_manual IS NULL AND EXISTS (
          SELECT 1 FROM unnest(v_members) AS m(cust)
           WHERE COALESCE((v_chem_price_map->>m.cust)::bigint, 0) <= 0
        ) THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_PRICE_UNRESOLVED: chemical line % has no resolvable price (no field quote and no tier price) for one or more co-owners — set the product''s tier pricing / a field quote, or enter a manual override, before saving', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Representative line base (display + the calculator's default price): the largest-share
        -- owner's price. The MONEY comes from the per-customer overrides injected below, not this.
        SELECT c.assigned_tier INTO v_rep_tier
          FROM customers c
         WHERE c.id = (
           SELECT (value->>'customer_id')::uuid
             FROM jsonb_array_elements(v_vector) AS value
            ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC
            LIMIT 1);
        v_price_res      := resolve_field_app_chemical_price(
                              v_product_id, v_field_ids, COALESCE(v_rep_tier, 1), v_chem_manual);
        v_src_unit_price := (v_price_res->>'unit_price_cents')::bigint;
        v_base_source    := v_price_res->>'price_source';

        -- Convert applied qty (rate unit) -> product sold unit so price x qty is per the
        -- SAME unit (the live 128x guard). No inventory_unit -> identity (price as entered).
        v_priced_qty := field_app_priced_quantity(
                          v_src_qty, v_rate_unit, COALESCE(v_inv_unit, v_rate_unit), v_form);
        IF v_priced_qty IS NULL THEN
          RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: chemical line % — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing.',
            v_idx, coalesce(v_rate_unit, '<none>'), COALESCE(v_inv_unit, v_rate_unit, '<none>')
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_src_qty := round(v_priced_qty, 4);
        -- Quantity is now in the pricing (sold) unit; show that unit on the invoice line
        -- so the displayed quantity and its unit label agree.
        v_eff_rate_unit := COALESCE(v_inv_unit, v_rate_unit);
      END;
    ELSE
      -- flat_fee / fuel_surcharge: bill from source_flat_cents; unit price is 0.
      -- Codex round-5 P1: require a POSITIVE amount server-side. The editor rejects <=0
      -- ("credits aren't supported here yet"), but a direct RPC call must not create a free or
      -- negative flat charge (a negative flat_cents would post a CHARGE the operator never saw).
      IF v_src_flat IS NULL OR v_src_flat <= 0 THEN
        RAISE EXCEPTION 'SPLIT_FLAT_CENTS_REQUIRED: source_flat_cents must be a positive amount for % line %', v_line_kind, v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_src_unit_price := COALESCE(v_src_unit_price, 0);
      v_base_source    := 'flat';
    END IF;

    INSERT INTO field_app_billing_lines (
      billing_set_id, line_kind, product_id, application_service_id, description,
      source_quantity, source_acres, source_unit_price_cents, sort_order
    ) VALUES (
      v_set_id, v_line_kind, v_product_id, v_app_service_id, v_line_desc,
      -- Codex round-4 P2 #10: persist the source applied-acre basis alongside the quantity.
      -- Service lines bill on acres (source_quantity is NULL for them), so without this a
      -- post-time verifier had no acre basis for a service line. Now every line records both.
      v_src_qty, v_src_acres, v_src_unit_price, v_idx
    ) RETURNING id INTO v_line_id;

    -- Build the calculator share vector. If the caller omitted 'shares' the line
    -- uses the default vector; otherwise each share may override micro_pct/price
    -- (a null micro_pct on a field_default share is filled from the default map).
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array'
       AND jsonb_array_length(v_line->'shares') > 0 THEN
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', s->>'customer_id',
               'micro_pct',
                 CASE WHEN s->'micro_pct' IS NOT NULL AND jsonb_typeof(s->'micro_pct') <> 'null'
                      THEN (s->>'micro_pct')::bigint
                      ELSE (v_micro_map->>(s->>'customer_id'))::bigint END,
               'split_mode', COALESCE(s->>'split_mode', 'field_default'),
               'price_mode', COALESCE(s->>'price_mode', 'default'),
               'override_unit_price_cents', s->'override_unit_price_cents'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', v->>'customer_id',
               'micro_pct',   (v->>'micro_pct')::bigint,
               'split_mode',  'field_default',
               'price_mode',  'default'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_vector) AS v;
    END IF;

    -- Option B (chemical): price each share at that customer's OWN resolved price from the map,
    -- UNLESS the caller already set an explicit per-person override (a manual draft adjustment,
    -- which wins). The override slot is how per-person prices reach the calculator. Uniform-price
    -- lines are then routed round-once via the penny guard below (source_lr); genuinely mixed
    -- per-customer prices use the calculator's per_person path (exact to its own SUM).
    IF COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL THEN
      SELECT jsonb_agg(
               CASE
                 WHEN s->>'price_mode' = 'override'
                      AND s->'override_unit_price_cents' IS NOT NULL
                      AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
                 THEN s
                 ELSE jsonb_set(
                        jsonb_set(s, '{price_mode}', '"override"'::jsonb),
                        '{override_unit_price_cents}',
                        to_jsonb((COALESCE(v_chem_price_map, v_svc_price_map)->>(s->>'customer_id'))::bigint))
               END)
        INTO v_shares
        FROM jsonb_array_elements(v_shares) AS s;

      -- Penny guard: when EVERY co-owner ends up at the SAME effective price (a manual/quote
      -- line, all-same-tier, OR a uniform manual per-person adjustment that differs from the
      -- representative), align the calculator's source price to that shared value so it routes
      -- through the round-once source_lr path (penny-exact to a single parent total) instead of
      -- per_person (which can differ by up to n-1 cents on the group total). Mixed prices keep
      -- per_person. Adversarial LOW, 2026-07-18.
      SELECT CASE WHEN count(DISTINCT (s->>'override_unit_price_cents')::bigint) = 1
                  THEN max((s->>'override_unit_price_cents')::bigint) END
        INTO v_uniform_price
        FROM jsonb_array_elements(v_shares) AS s
       WHERE s->>'override_unit_price_cents' IS NOT NULL;
      -- Codex round-7 P2: preserve the RESOLVED representative base BEFORE the uniform penny guard may
      -- overwrite v_src_unit_price with a (uniform) caller override. An 'override' share's AUDITED base
      -- must stay the true tier/quote/service base, not the override value — otherwise the audit reads
      -- as if the override equalled the base and the real tier/quote/service price is lost.
      v_repr_base_price := v_src_unit_price;
      IF v_uniform_price IS NOT NULL THEN
        v_src_unit_price := v_uniform_price;
      END IF;
    ELSE
      v_repr_base_price := v_src_unit_price;
    END IF;

    -- Every line's customer set must EXACTLY equal the billing-set members (spec §3).
    SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
      INTO v_line_customers
      FROM jsonb_array_elements(v_shares) AS value;
    IF v_line_customers IS DISTINCT FROM v_members THEN
      RAISE EXCEPTION 'SPLIT_LINE_MEMBER_MISMATCH: line % customers do not equal the billing-set members', v_idx
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The single shared engine — preview and save both call this exact function.
    v_calc := compute_line_split_allocation(jsonb_build_object(
      'billing_line_id',         v_line_id::text,
      'line_kind',               v_line_kind,
      'source_quantity',         v_src_qty,
      'source_acres',            v_src_acres,
      'source_unit_price_cents', v_src_unit_price,
      'source_flat_cents',       v_src_flat,
      'base_price_source',       v_base_source,
      'shares',                  v_shares
    ));

    -- Persist the canonical source-line total for the invariant check. Fable-adversarial MED: also
    -- re-persist source_unit_price_cents to the price the money ACTUALLY used — the billing line was
    -- INSERTed with the representative resolved price, but the uniform-override penny guard above may
    -- have re-pointed v_src_unit_price (e.g. a uniform per-person override that differs from the base),
    -- leaving the audit row's price × source inconsistent with its own source_line_cents.
    UPDATE field_app_billing_lines
       SET source_line_cents = (v_calc->>'source_line_cents')::bigint,
           source_unit_price_cents = v_src_unit_price
     WHERE id = v_line_id;

    -- #G (Codex round-2 P1): allocate the ONE canonical line COGS across co-owners with the
    -- SAME largest-remainder rule used for revenue, so the group total_cost ties EXACTLY to
    -- unit_cost x source — no per-child independent-rounding drift of up to n-1 cents. The
    -- line's micro_pct weights already sum to 100000000 (enforced by the invariant), so
    -- _lr_allocate_int sums the shares to v_line_cogs exactly. Zero cost => all-zero shares.
    v_line_cogs := CASE
      WHEN v_line_kind = 'service'  THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_acres, 0))
      WHEN v_line_kind = 'chemical' THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_qty, 0))
      ELSE 0 END;
    SELECT jsonb_agg(jsonb_build_object('customer_id', a->>'customer_id',
                                        'weight', (a->>'micro_pct')::bigint))
      INTO v_cogs_weights
      FROM jsonb_array_elements(v_calc->'allocations') AS a;
    SELECT jsonb_object_agg(x->>'customer_id', (x->>'amount')::bigint)
      INTO v_cogs_map
      FROM jsonb_array_elements(public._lr_allocate_int(v_line_cogs, v_cogs_weights)) AS x;

    v_line_plans := v_line_plans || jsonb_build_array(jsonb_build_object(
      'billing_line_id', v_line_id::text,
      'line_kind',       v_line_kind,
      'product_id',      v_product_id,
      'description',     v_line_desc,
      'rate_unit',       v_eff_rate_unit,
      'sort_order',      v_idx,
      'unit_cost_cents', v_line_unit_cost,   -- per-unit COGS (Codex P1 #3)
      'cogs_by_customer', v_cogs_map,        -- LR-allocated per-child COGS (Codex r2 #G)
      'per_customer_priced', (COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL), -- Option B (#M)
      'caller_override_custs', COALESCE(to_jsonb(v_caller_override), '[]'::jsonb),       -- genuine overrides (#M)
      'repr_base_unit_price_cents', v_repr_base_price,   -- resolved representative base for the override audit (Codex r7 P2)
      'resolved_price_map', COALESCE(v_chem_price_map, v_svc_price_map, '{}'::jsonb),    -- customer_id -> OWN resolved pre-override price (Codex r8 P2)
      'svc_source_map',  COALESCE(v_svc_source_map, '{}'::jsonb),  -- per-customer service source (#M)
      'reasons_map',     COALESCE(v_reasons_map, '{}'::jsonb),     -- split/price reasons (#L)
      'service_name',    CASE WHEN v_line_kind = 'service' THEN v_svc_name ELSE NULL END, -- Codex r2 #N (via v_svc_name: referencing the record here crashed service-less saves)
      'alloc',           v_calc
    ));
    v_line_hashes := v_line_hashes || jsonb_build_array(v_calc->>'vector_hash');
  END LOOP;

  -- ---- PASS 2: one child invoice per customer --------------------------------
  FOREACH v_cust IN ARRAY v_members
  LOOP
    v_customer_id := v_cust::uuid;
    SELECT farm_name INTO v_customer_name FROM customers WHERE id = v_customer_id;
    -- Display-only "primary grower" flag on the compat share row.
    v_is_primary := EXISTS (
      SELECT 1 FROM field_billing_defaults d
       WHERE d.field_id = ANY(v_field_ids)
         AND d.customer_id = v_customer_id
         AND d.is_primary);

    -- sql-safety: exempt-registry — invoices.field_app_billing_set_id / send_disposition
    -- are created by the prior parked migration 20260718010000 (see file header).
    -- Reuse an existing child for this customer on re-save (preserves invoice_number
    -- + append-only snapshot history — adversarial F1 fix); INSERT only for a new customer.
    v_invoice_id := NULL;
    IF p_billing_set_id IS NOT NULL THEN
      -- Reuse only an EDITABLE (draft/unposted) child. Fable-adversarial BLOCKER: a child voided/
      -- cancelled via the live void_invoice stays attached to the set; reusing (reviving) it would be a
      -- forbidden voided->draft transition AND resurrect a dead invoice. Skip it — a fresh child is
      -- INSERTed below for this still-member customer; the terminal one stays as voided/cancelled history.
      SELECT id INTO v_invoice_id FROM invoices
       WHERE field_app_billing_set_id = v_set_id
         AND customer_id = v_customer_id
         AND deleted_at IS NULL
         AND status IN ('draft', 'unposted')
       LIMIT 1;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_is_new_invoice := true;
      v_invoice_number := next_invoice_number('field_application');
      -- sql-safety: exempt-registry — invoices.field_app_billing_set_id is created by the prior
      -- parked migration 20260718010000 (not yet in the schema-registry); job_id / application_date
      -- / season are long-standing invoices columns (mirrors transfer_job_to_invoice).
      -- sql-safety: exempt-registry — field_app_billing_set_id is created by the parked migration
      -- 20260718010000 (not yet in the registry); field_names/crop_type/total_acres are long-standing
      -- invoices columns (20260219200000_invoice_statement_enrichment).
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id, season,
        field_app_billing_set_id, job_id, application_date,
        field_names, crop_type, total_acres,   -- Codex r7 P2: denormalized field context for the combined list/PDFs
        applicator_name, vehicle_name           -- Codex r8 P2: source-job applicator/vehicle
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
        v_salesman_id, p_invoice->>'header_notes', p_performed_by,
        0, 0,
        v_group_id, p_application_service_id, v_season,   -- season = job/invoice season (round-3 P1)
        -- job_id + application_date on EVERY child so field-invoice lists resolve Job # and the
        -- application date, not just the first child via jobs.invoice_id (round-3 P2).
        v_set_id, p_source_job_id, v_job_app_date,
        v_inv_field_names, v_inv_crop_type, v_total_applied_acres,
        v_inv_applicator_name, v_inv_vehicle_name
      ) RETURNING id INTO v_invoice_id;
    ELSE
      v_is_new_invoice := false;
      -- Load the existing invoice_number so it is never stale/null on a re-save (Codex P1 #8).
      SELECT invoice_number INTO v_invoice_number FROM invoices WHERE id = v_invoice_id;
      -- Keep status as-is (draft or unposted); a non-admin cannot reassign salesman.
      UPDATE invoices SET
        invoice_date           = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id            = CASE WHEN is_admin() THEN v_salesman_id ELSE salesman_id END,
        header_notes           = p_invoice->>'header_notes',
        application_service_id  = p_application_service_id,
        invoice_group_id       = v_group_id,
        season                 = v_season,               -- keep season in sync on re-save (round-3 P1)
        job_id                 = p_source_job_id,         -- round-3 P2 (frozen source job)
        application_date       = v_job_app_date,
        field_names            = v_inv_field_names,        -- Codex r7 P2: keep denormalized field context in sync on re-save
        crop_type              = v_inv_crop_type,
        total_acres            = v_total_applied_acres,
        applicator_name        = v_inv_applicator_name,    -- Codex r8 P2
        vehicle_name           = v_inv_vehicle_name,
        total_amount_cents     = 0,
        total_cost_cents       = 0,
        send_disposition       = 'normal',
        updated_at             = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_chem_profit := 0;   -- round-5 P1: this child's chemical profit (LR COGS), for commissions
    -- Compat share acres derived ONCE from the ownership vector × total applied acres
    -- (Codex P2 #9), independent of the billing lines — so it neither zeroes out on a
    -- no-service set nor double-counts across multiple service lines.
    v_cust_acres    := round(v_total_applied_acres
                             * COALESCE((v_micro_map->>v_cust)::numeric, 0) / 100000000.0, 2);

    FOR v_plan IN SELECT * FROM jsonb_array_elements(v_line_plans)
    LOOP
      v_line_kind := v_plan->>'line_kind';
      -- this customer's allocation row for this line
      SELECT a INTO v_alloc_row
        FROM jsonb_array_elements(v_plan->'alloc'->'allocations') AS a
       WHERE a->>'customer_id' = v_cust;
      IF v_alloc_row IS NULL THEN
        RAISE EXCEPTION 'SPLIT_MISSING_ALLOCATION: customer % missing on line %', v_cust, v_plan->>'billing_line_id'
          USING ERRCODE = 'internal_error';
      END IF;

      v_qty         := (v_alloc_row->>'allocated_quantity')::numeric;
      v_acres_alloc := (v_alloc_row->>'allocated_acres')::numeric;

      -- #M (Codex round-2 P2) + #L reasons: decide each co-owner's AUDITED base price / source /
      -- mode. A co-owner's OWN resolved per-customer price (Option B) is their BASE with its real
      -- source and price_mode='default'; only a genuine caller-supplied manual per-person override
      -- is audited as an 'override' against the representative base. Non-Option-B lines keep the
      -- calculator's values verbatim. Reasons are captured when the operator supplied them.
      v_split_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'split_reason', '');
      v_price_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'price_reason', '');
      IF (v_plan->'caller_override_custs') ? v_cust THEN
        -- Codex round-7/8 P2: audit THIS customer's OWN resolved pre-override price (Option B), falling
        -- back to the resolved representative base (round-7) then the calculator base. Never the override
        -- value itself — the audit must document what the price WOULD have been before the override.
        v_share_base_price  := COALESCE((v_plan->'resolved_price_map'->>v_cust)::bigint,
                                        (v_plan->>'repr_base_unit_price_cents')::bigint,
                                        (v_alloc_row->>'base_unit_price_cents')::bigint);
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'override';
      ELSIF COALESCE((v_plan->>'per_customer_priced')::boolean, false) THEN
        v_share_base_price  := (v_alloc_row->>'unit_price_cents')::bigint;        -- this co-owner's OWN price
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'default';
      ELSE
        v_share_base_price  := (v_alloc_row->>'base_unit_price_cents')::bigint;
        v_share_base_source := v_alloc_row->>'base_price_source';
        v_share_price_mode  := v_alloc_row->>'price_mode';
      END IF;

      -- Map the AUDITED per-customer source onto the invoice_items.price_source
      -- convention set ('manual'|'quoted'|'tier'); the exact source is preserved
      -- on invoice_line_shares.base_price_source.
      v_item_price_source := CASE v_share_base_source
        WHEN 'quoted' THEN 'quoted'
        WHEN 'tier'   THEN 'tier'
        WHEN 'service_rate'    THEN 'tier'
        WHEN 'service_default' THEN 'tier'
        ELSE 'manual' END;

      -- #G (Codex round-2 P1): this co-owner's LR-allocated COGS share for the line, so the
      -- GROUP total_cost ties EXACTLY to the canonical unit_cost x source (no per-child
      -- independent-round drift of up to n-1 cents). The invoice_items.cost_cents keeps its
      -- display convention (#F): a chemical item carries PER-UNIT cost (PDF/detail render unit
      -- economics), a fee (service) item carries this EXTENDED share. The header total_cost
      -- accumulates the LR share below, so the group total is exact regardless.
      v_item_cost_cents := COALESCE((v_plan->'cogs_by_customer'->>v_cust)::bigint, 0);

      -- sql-safety: exempt-registry — invoice_items.billing_line_id is created by the prior parked
      -- migration 20260718010000 (not yet in the registry); unit_size/total_applied/total_applied_unit
      -- are long-standing invoice_items columns (20260219200000_invoice_statement_enrichment).
      -- Codex round-8 P1: the field-application PDF/email renders the price unit from unit_size and the
      -- applied quantity from total_applied/total_applied_unit. For a chemical child, mirror the canonical
      -- field-app item: unit_size = the pricing unit, total_applied = this co-owner's billed quantity in
      -- that unit. Service/flat leave them null (service bills per acre; flat is flat).
      INSERT INTO invoice_items (
        invoice_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_unit,
        unit_size, total_applied, total_applied_unit,
        is_application_fee, price_source, billing_line_id
      ) VALUES (
        v_invoice_id, (v_plan->>'product_id')::uuid,
        COALESCE(NULLIF(v_plan->>'description', ''),
                 (SELECT product_name FROM products WHERE id = (v_plan->>'product_id')::uuid),
                 NULLIF(v_plan->>'service_name', ''),      -- Codex r2 #N: real service name, not literal 'Service'
                 initcap(v_line_kind)),
        CASE WHEN v_line_kind = 'service' THEN COALESCE(v_acres_alloc, 0)
             WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0)
             ELSE 1 END,
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,     -- extended = authoritative allocation
        CASE WHEN v_line_kind = 'chemical' THEN (v_plan->>'unit_cost_cents')::bigint
             ELSE v_item_cost_cents END,            -- chemical: PER-UNIT; fee: EXTENDED LR share (#F/#G)
        (v_plan->>'sort_order')::int,
        v_acres_alloc,
        CASE WHEN v_line_kind = 'service' THEN 'acre' ELSE v_plan->>'rate_unit' END,
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- unit_size = pricing unit
        CASE WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0) END,                  -- total_applied = billed qty
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- total_applied_unit
        (v_line_kind = 'service'),
        v_item_price_source,
        (v_plan->>'billing_line_id')::uuid
      ) RETURNING id INTO v_item_id;

      INSERT INTO invoice_line_shares (
        billing_line_id, invoice_item_id, customer_id,
        split_mode, split_micro_pct, allocated_quantity, allocated_acres,
        base_unit_price_cents, base_price_source, price_mode,
        unit_price_cents, amount_cents,
        split_override_reason, price_override_reason,
        calculation_hash, vector_hash, created_by
      ) VALUES (
        (v_plan->>'billing_line_id')::uuid, v_item_id, v_customer_id,
        v_alloc_row->>'split_mode', (v_alloc_row->>'micro_pct')::bigint,
        v_qty, v_acres_alloc,
        v_share_base_price,          -- #M: co-owner's OWN resolved price is the audited base
        v_share_base_source,         -- #M: their own resolved source (service_rate/tier/...)
        v_share_price_mode,          -- #M: 'default' for resolved pricing, 'override' only for a real one
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,
        v_split_reason, v_price_reason,   -- #L: captured reasons when the operator supplied them
        v_alloc_row->>'calculation_hash',
        v_plan->'alloc'->>'vector_hash',
        p_performed_by
      );

      v_invoice_total := v_invoice_total + (v_alloc_row->>'amount_cents')::bigint;
      -- #G: accumulate this co-owner's LR-allocated COGS share directly; the GROUP total_cost
      -- now ties EXACTLY to the canonical unit_cost x source (no per-child rounding drift).
      v_invoice_cost  := v_invoice_cost + v_item_cost_cents;
      -- Codex round-5 P1: chemical-line profit for commissions uses the SAME LR-allocated COGS
      -- (v_item_cost_cents), NOT a re-rounded cost*qty on the per-unit item cost. Only product-
      -- backed chemical lines count toward commission (fees/service/flat are excluded), mirroring
      -- transfer_job_to_invoice's chemical-only profit basis.
      IF v_line_kind = 'chemical' THEN
        v_invoice_chem_profit := v_invoice_chem_profit
          + ((v_alloc_row->>'amount_cents')::bigint - v_item_cost_cents);
      END IF;
    END LOOP;

    -- Stash this child's chemical profit (cents) for the commission mint below (round-5 P1).
    v_chem_profit_by_child := v_chem_profit_by_child
      || jsonb_build_object(v_invoice_id::text, v_invoice_chem_profit);

    v_send_disposition := CASE WHEN v_invoice_total = 0 THEN 'suppressed_zero_total' ELSE 'normal' END;

    UPDATE invoices
       SET total_amount_cents = v_invoice_total,
           total_cost_cents   = v_invoice_cost,
           send_disposition   = v_send_disposition,
           updated_at         = now()
     WHERE id = v_invoice_id;

    -- R2: keep the compatibility invoice_shares self-100% row (statements/year-end
    -- read invoice_shares.amount_cents). Do NOT drop as "redundant".
    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order, price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_cust_acres, v_invoice_total,
      v_is_primary, 0, NULL, NULL
    );

    -- Append-only ledger: emit the 'invoice_created' row ONLY when this child was freshly
    -- INSERTed (Codex P1 #8). On a re-save we reuse the existing child, so a creation row
    -- here would duplicate the invoice's financial impact and (previously) carry a stale/null
    -- invoice_number. A re-save changes draft line detail only; no creation event is due.
    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object('invoice_number', v_invoice_number,
                           'customer_id', v_customer_id,
                           'total_cents', v_invoice_total,
                           'send_disposition', v_send_disposition),
        v_invoice_total,
        'Per-line split field application invoice created'
      );
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
  END LOOP;

  -- ---- #E CONSUME THE SOURCE JOB (Codex round-2 P1) --------------------------
  -- Now that the child invoices exist, mark the source job invoiced exactly like
  -- transfer_job_to_invoice does, so the normal flow's "Job already invoiced" guard
  -- fires and the same work can never be billed twice. Idempotent on re-save (a job
  -- already 'invoiced' by THIS set is left as-is; the guard above already allowed it).
  IF p_source_job_id IS NOT NULL THEN
    -- Resolve the commission split exactly like transfer_job_to_invoice: the job's own
    -- creation-time snapshot, else the parent quote's split, else the customer default (only
    -- pre-U8 jobs reach the fallback). v_job was loaded FOR UPDATE in the #E guard above.
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Consume the job: flip completed->invoiced, set the anchor invoice_id, AND persist the resolved
    -- split — ALL IN ONE statement while OLD.status='completed'. The live enforce_billed_job_immutability
    -- trigger early-returns for a not-yet-billed job, so this is the ONLY point a non-admin may set
    -- invoice_id (drift B1); it is exactly the single-statement shape of transfer_job_to_invoice.
    -- Idempotent: no-ops on re-save (status already 'invoiced').
    UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_ids[1],
        commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
     WHERE id = p_source_job_id AND status <> 'invoiced';

    -- Codex round-5 P2 / drift B1: on a RE-SAVE that dropped the member previously stored in
    -- jobs.invoice_id, the anchor now points at a cancelled, detached child — repoint it to a surviving
    -- current child (v_invoice_ids only ever holds current members). The job is already 'invoiced', so
    -- the immutability trigger would block a non-admin from changing invoice_id — use the SAME
    -- app.admin_override hatch that trigger sanctions for definer-flow writers (as transfer_invoice_to_job
    -- does), scoped tightly around JUST this repoint, and ONLY when the stored anchor is no longer a live
    -- member child (a no-op when it is unchanged — the common re-save case, no override needed).
    IF NOT EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = (SELECT j.invoice_id FROM jobs j WHERE j.id = p_source_job_id)
         AND i.field_app_billing_set_id = v_set_id
         AND i.deleted_at IS NULL AND i.status <> 'cancelled'
    ) THEN
      PERFORM set_config('app.admin_override', 'true', true);
      UPDATE jobs SET invoice_id = v_invoice_ids[1] WHERE id = p_source_job_id;
      PERFORM set_config('app.admin_override', 'false', true);
    END IF;

    -- application_records has no billed-immutability guard (triggers live only on jobs / job_applied_
    -- records) — repoint it unconditionally to the surviving anchor, matching live transfer_job_to_invoice.
    UPDATE application_records SET invoice_id = v_invoice_ids[1]
     WHERE source_type = 'job' AND source_id = p_source_job_id;

    -- ---- Per-child commissions (Codex round-4 P1) ----------------------------
    -- Mirror transfer_job_to_invoice's PER-OWNER GROUP path: each child invoice mints
    -- commissions on ITS OWN chemical-line profit, so the sum across children equals the
    -- whole job's chemical profit and each recipient is paid per invoice they touch. A
    -- split job billed here previously created NO commissions AND the status flip blocked
    -- the normal path from ever creating them.
    --
    -- Profit basis (Codex round-5 P1): each child's CHEMICAL profit accumulated in PASS 2 using the
    -- SAME largest-remainder-allocated COGS (v_item_cost_cents) that the header total_cost carries —
    -- NOT a re-rounded ROUND(cost × qty) on the per-unit item cost, which would drift on fractional
    -- child quantities (1¢/1u/50-50 rounds both 0.5¢ shares up to 1¢, understating profit). Service /
    -- flat / fee lines contribute 0. Sum across children == the whole job's chemical profit.
    --
    -- Re-save safe: a redraw rewrites every child's items (changing profit) and may DROP a member
    -- (whose child was orphan-cancelled above). The #E guard makes this job EXCLUSIVE to this set
    -- (it cannot be on another set or normally invoiced), so EVERY commission carrying this job_id
    -- belongs to this set — clear them ALL (including a dropped member's, which would otherwise leak
    -- a phantom pending commission on a cancelled invoice), then re-mint only for the current
    -- members. First REFUSE if any are already in an active payout batch or already paid (mirrors
    -- the U8 edit guards): the operator must void that commission payment before re-saving. On a
    -- first save there are none, so the guards pass and the clear is a no-op.
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = p_source_job_id AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this split''s pending commissions are in an active payout batch — void that commission payment before re-saving';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions c WHERE c.job_id = p_source_job_id AND c.status = 'paid'
    ) THEN
      RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this split''s commissions were already paid out — void that commission payment before re-saving';
    END IF;

    -- Fable-adversarial HIGH: SOFT-cancel (never hard-DELETE) the prior commissions, then re-mint.
    -- A hard DELETE FK-violates once any of the job's commissions were EVER in a payout batch — even a
    -- VOIDED one, which is exactly what JOB_HAS_BATCHED_COMMISSIONS tells the operator to do first
    -- (commission_payment_items.commission_id is NO ACTION and void_commission_payment leaves its cpi
    -- rows in place). Soft-cancel mirrors the live convention (delete_invoices / void_invoice cancel+zero
    -- commissions, never delete them) and preserves the audit trail. Re-mint below writes fresh rows.
    UPDATE commissions
       SET status = 'cancelled', commission_amount = 0, deleted_at = now()
     WHERE job_id = p_source_job_id AND deleted_at IS NULL;

    FOREACH v_child_id IN ARRAY v_invoice_ids
    LOOP
      -- Chemical profit for this child from the LR-allocated accumulator (cents -> dollars).
      v_child_profit := COALESCE((v_chem_profit_by_child->>v_child_id::text)::bigint, 0)::numeric / 100.0;

      SELECT customer_id INTO v_child_customer FROM invoices WHERE id = v_child_id;

      PERFORM _insert_commissions_for_job(
        p_source_job_id, v_child_id, v_child_customer,
        COALESCE(v_child_profit, 0), v_commission_split, CURRENT_DATE);
    END LOOP;
  END IF;

  -- ---- PASS 3: field snapshots for the group (Codex P1 #7) -------------------
  -- Grouped (multi-customer) field-app invoices carry their field/crop/acre snapshot at the
  -- GROUP level (invoice_id NULL, invoice_group_id set) — exactly how the live field-app save
  -- and the invoice-list panels read them. Without these, lists and PDFs show blank fields,
  -- crops, and zero acres. job_id carries source-job provenance AND satisfies fal_requires_parent
  -- when no invoice_id is present. The prior group's rows were cleared in the re-save block.
  INSERT INTO field_app_locations (
    invoice_group_id, job_id, field_id, applied_acres, total_acres, crop_type, sort_order
  )
  SELECT v_group_id, p_source_job_id, (t.fld->>'field_id')::uuid,
         (t.fld->>'applied_acres')::numeric,
         fl.total_acres, fl.crop_type, (t.ord - 1)::int
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- §5 INVARIANTS — check the STORED rows, never the allocator's self-report -
  FOR v_line_id, v_src_line_cents, v_line_src_qty IN
    SELECT id, source_line_cents, source_quantity
      FROM field_app_billing_lines WHERE billing_set_id = v_set_id
  LOOP
    SELECT COALESCE(SUM(amount_cents), 0),
           COALESCE(SUM(split_micro_pct), 0),
           count(DISTINCT customer_id),
           SUM(allocated_quantity)
      INTO v_sum_cents, v_sum_micro, v_line_member_count, v_sum_qty
      FROM invoice_line_shares WHERE billing_line_id = v_line_id;

    IF v_sum_cents IS DISTINCT FROM v_src_line_cents THEN
      RAISE EXCEPTION 'INVARIANT_CENTS: line % stored cents % <> source_line_cents %',
        v_line_id, v_sum_cents, v_src_line_cents USING ERRCODE = 'internal_error';
    END IF;
    IF v_sum_micro <> 100000000 THEN
      RAISE EXCEPTION 'INVARIANT_MICRO: line % micro_pct sum % <> 100000000', v_line_id, v_sum_micro
        USING ERRCODE = 'internal_error';
    END IF;
    IF v_line_member_count <> array_length(v_members, 1) THEN
      RAISE EXCEPTION 'INVARIANT_MEMBERS: line % has % customers, expected %',
        v_line_id, v_line_member_count, array_length(v_members, 1) USING ERRCODE = 'internal_error';
    END IF;
    -- quantity ties to source at 4dp when a source quantity was provided
    IF v_line_src_qty IS NOT NULL
       AND round(COALESCE(v_sum_qty, 0), 4) IS DISTINCT FROM round(v_line_src_qty, 4) THEN
      RAISE EXCEPTION 'INVARIANT_QTY: line % qty sum % <> source_quantity %',
        v_line_id, v_sum_qty, v_line_src_qty USING ERRCODE = 'internal_error';
    END IF;
  END LOOP;

  -- ---- RESULT + idempotency ---------------------------------------------------
  v_result := jsonb_build_object(
    'billing_set_id',     v_set_id,
    'invoice_group_id',   v_group_id,
    'invoice_ids',        to_jsonb(v_invoice_ids),
    'line_vector_hashes', v_line_hashes,
    'request_hash',       p_request_hash
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_app_split_invoice_saved',
    'Per-line split field app billing set saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  -- Record the idempotency key (paired with the wrapper's check_idempotency; see the
  -- idempotency-body-check exemption note at the top — canonical wrapper/impl split).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_app_split_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- _save_invoice_lineage_unaware_impl_20260827: md5(prosrc) 45e63ffc8e821467bcca056cad535163
CREATE OR REPLACE FUNCTION public._save_invoice_lineage_unaware_impl_20260827(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_invoice_id uuid; v_is_new boolean := false; v_item jsonb;
  v_total_cents bigint := 0; v_qty numeric; v_unit_price bigint; v_extended bigint;
  v_cost_cents bigint; v_product record; v_order_id uuid; v_blend_id uuid; v_existing jsonb;
  v_total_cost bigint := 0;
  v_is_field boolean := false;
  v_is_fee boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- PARKED-002 (codex-driven cycle 1 #1 MED): credit memos must come exclusively
    -- from issue_return_credit (the ONLY caller that derives the credit from a
    -- 'received' return and gates on check_period_open). save_invoice's NEW-invoice
    -- branch otherwise allows an admin/sales-rep to forge a posted credit memo by
    -- riding on the enforce_invoice_draft_on_insert credit_memo exemption. Reject
    -- BEFORE the order/blend check so the error surfaced is the intent-mismatch one.
    IF (p_invoice->>'invoice_type') = 'credit_memo' THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;
    -- Manual miscellaneous charges are the one controlled orderless invoice
    -- type. Chemical sales still require a source order/blend ticket.
    IF v_order_id IS NULL
       AND v_blend_id IS NULL
       AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') <> 'misc_charge' THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    IF COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') = 'misc_charge'
       AND COALESCE(NULLIF(p_invoice->>'status', ''), 'draft') <> 'draft' THEN
      RAISE EXCEPTION 'MISC_CHARGE_MUST_START_DRAFT: orderless miscellaneous charges must be reviewed before posting';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, payment_terms, purchase_order_ref, header_notes, footer_notes, total_amount_cents, created_by)
    VALUES (v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      NULLIF(btrim(COALESCE(p_invoice->>'payment_terms', '')), ''),
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor) RETURNING id INTO v_invoice_id;
  ELSE
    -- An orderless miscellaneous charge must remain a miscellaneous charge.
    -- The edit payload does not carry source IDs, so enforce this against the
    -- stored invoice rather than trusting the client to keep the type locked.
    IF EXISTS (
      SELECT 1
       FROM invoices
       WHERE id = v_invoice_id
         AND invoice_type = 'misc_charge'
         AND order_id IS NULL
         AND blend_ticket_id IS NULL
         AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), invoice_type) <> 'misc_charge'
    ) THEN
      RAISE EXCEPTION 'ORDERLESS_INVOICE_TYPE_LOCKED: an orderless miscellaneous charge cannot be reclassified';
    END IF;

    -- PARKED-002 (Codex r3): EXPLICIT pre-UPDATE guard on the credit_memo boundary.
    -- A silent CASE-keep would swallow an attempted chemical_sale -> credit_memo flip
    -- (other payload fields still save) so the caller never sees the rejection. Fail
    -- LOUDLY with CREDIT_MEMO_VIA_SAVE_INVOICE whenever OLD or NEW crosses 'credit_memo'.
    -- Mirrors how enforce_field_application_type_lock errors on its boundary cross,
    -- except this is RPC-side because credit_memo is born 'posted' and the trigger only
    -- fires on UPDATE OF invoice_type (a posted credit_memo never gets here at all).
    -- PARKED-002 (Codex r4): drop the status filter — surface the boundary cross even
    -- when the target invoice is posted/voided/etc. The existing post-UPDATE
    -- "NOT EXISTS ... status IN ('draft','unposted')" path would otherwise silently
    -- no-op a posted-invoice credit_memo attempt; the caller deserves a clear error.
    IF EXISTS (
      SELECT 1 FROM invoices
       WHERE id = v_invoice_id
         AND (
              invoice_type = 'credit_memo'
           OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
         )
         AND invoice_type IS DISTINCT FROM COALESCE(p_invoice->>'invoice_type', invoice_type)
    ) THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;

    UPDATE invoices SET
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- PARKED-002 (Codex r2): symmetric lock — credit_memo is a SEGREGATION boundary like
      -- field_application. The pre-UPDATE guard above ALREADY rejected any cross-boundary
      -- attempt with CREDIT_MEMO_VIA_SAVE_INVOICE; this CASE is the second-line invariant
      -- so a bug in the guard can't silently let the column flip. Stacks on top of DELTA-F.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
        THEN invoice_type
        WHEN invoice_type = 'credit_memo'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
        THEN invoice_type
        ELSE COALESCE(p_invoice->>'invoice_type', invoice_type) END,
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = CASE WHEN p_invoice ? 'due_date' THEN (p_invoice->>'due_date')::date ELSE due_date END,
      payment_terms = CASE WHEN p_invoice ? 'payment_terms' THEN NULLIF(btrim(p_invoice->>'payment_terms'), '') ELSE payment_terms END,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  IF NOT v_is_new THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
      RETURN v_invoice_id;
    END IF;
  END IF;

  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE v_share_n int; v_has_ovr boolean;
    BEGIN
      SELECT count(*), COALESCE(bool_or(price_per_acre_cents IS NOT NULL), false)
        INTO v_share_n, v_has_ovr
        FROM invoice_shares WHERE invoice_id = v_invoice_id;
      IF v_share_n > 1 OR v_has_ovr THEN
        RAISE EXCEPTION 'FIELD_INVOICE_SPLIT_LOCKED: this field invoice is split across growers (or has a fixed-price grower) — void and reissue to change it';
      END IF;
    END;
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invoice line item quantity must be greater than zero'; END IF;
    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_is_fee := COALESCE((v_item->>'is_application_fee')::boolean, false) AND (v_item->>'product_id') IS NULL;
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    IF v_is_fee
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      v_item->>'rate_unit',
      v_is_fee,
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_item->>'epa_registration',
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint);
    v_total_cents := v_total_cents + v_extended;
    v_total_cost := v_total_cost + CASE
      WHEN v_is_fee THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    WITH s AS (
      SELECT id, COALESCE(amount_cents, 0) AS amount_cents,
             row_number() OVER (ORDER BY is_primary DESC, sort_order, id) AS rn,
             SUM(COALESCE(amount_cents, 0)) OVER () AS tot
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    ),
    alloc AS (
      SELECT id, rn,
             CASE WHEN tot > 0 THEN ROUND(v_total_cents * amount_cents / tot)::bigint
                  WHEN rn = 1 THEN v_total_cents ELSE 0 END AS part
      FROM s
    ),
    recon AS (
      SELECT id, rn, part, v_total_cents - COALESCE(SUM(part) OVER (), 0) AS rem
      FROM alloc
    )
    UPDATE invoice_shares isr
       SET amount_cents = r.part + CASE WHEN r.rn = 1 THEN r.rem ELSE 0 END
      FROM recon r WHERE isr.id = r.id;
  END IF;

  -- U8<<< (Codex R2 P1): a job-born field_application invoice stays editable while
  -- draft/unposted, and the items rewrite above changes chemical-line profit without
  -- touching the pending job commissions minted at transfer time. Recompute them from
  -- the just-written lines — the exact mirror of update_order_items' commission-
  -- recompute-on-edit (20260617040000), including its batch-freeze guard. Scoped by
  -- commissions.invoice_id (generation-precise): order-channel rows and other
  -- generations are untouched, and a non-job invoice simply matches zero rows.
  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE
      v_u8_profit numeric;
    BEGIN
      -- Codex R6 P2: an edit while any of this generation's pending commissions sit
      -- in an active payout batch would leave that batch stale (post_commission_payment
      -- pays the OLD amount) — block, mirroring the reversal paths' guard.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this invoice''s pending commissions are in an active payout batch — void that commission payment before editing';
      END IF;
      -- Codex R7 P1: commissions already PAID against this still-unposted invoice
      -- must also block the edit — the recompute below only touches pending rows,
      -- so an edit would silently strand the paid ledger on the old profit. Fully
      -- recoverable: void the commission payment (rows reset to pending because
      -- this invoice is live), edit, then re-batch.
      IF EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL AND c.status = 'paid'
      ) THEN
        RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this invoice''s commissions were already paid out — void that commission payment before editing the invoice';
      END IF;

      -- Codex R6 P2: COGS per line is cost_cents × quantity (save_invoice stores
      -- per-unit cost — the SAME math its own v_total_cost uses); transfer-minted
      -- lines carry quantity=1 with line-total cost, so ×1 is identical there.
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - ROUND(COALESCE(ii.cost_cents, 0) * COALESCE(ii.quantity, 1))::bigint), 0)::numeric / 100.0
        INTO v_u8_profit
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      UPDATE commissions c
         SET order_profit      = ROUND(COALESCE(v_u8_profit, 0), 2),
             commission_amount = calc.new_amount
        FROM (
          SELECT x.id,
                 -- Codex R5 P2: mirror the mint's last-row penny reconciliation so the
                 -- recomputed rows sum EXACTLY to the rounded profit (a 33.33/33.33/33.34
                 -- split of $0.02 must not round up to $0.03). Only safe when the eligible
                 -- pending rows ARE the whole generation (x.cnt = x.cnt_all, and cnt_all
                 -- counts EVERY non-deleted row of the generation regardless of status —
                 -- drift-review R6 H1: a sibling already PAID via a posted batch must
                 -- force the per-row fallback, or the last pending row would absorb the
                 -- paid recipient's entire share, not a penny). The mixed case keeps the
                 -- per-row math (update_order_items parity).
                 CASE WHEN x.rn = x.cnt AND x.cnt = x.cnt_all THEN
                     GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                     - COALESCE(SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                         OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
                   ELSE compute_commission_amount(v_u8_profit, x.split_percentage)
                 END AS new_amount
          FROM (
            SELECT c2.id, c2.split_percentage,
                   row_number() OVER (ORDER BY c2.id) AS rn,
                   count(*) OVER () AS cnt,
                   (SELECT count(*) FROM commissions c3
                     WHERE c3.invoice_id = v_invoice_id AND c3.job_id IS NOT NULL
                       AND c3.deleted_at IS NULL) AS cnt_all
            FROM commissions c2
            WHERE c2.invoice_id = v_invoice_id
              AND c2.job_id IS NOT NULL
              AND c2.status = 'pending'
              AND c2.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM commission_payment_items cpi
                JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                WHERE cpi.commission_id = c2.id AND cp.status <> 'voided'
              )
          ) x
        ) calc
       WHERE c.id = calc.id;
    END;
  END IF;
  -- >>>U8

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id, (p_invoice->>'customer_id')::uuid);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$function$;
