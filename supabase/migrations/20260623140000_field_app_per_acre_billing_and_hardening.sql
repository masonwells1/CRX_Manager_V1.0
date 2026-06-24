-- 20260623140000_field_app_per_acre_billing_and_hardening.sql
-- Track B (B1+B2): per-acre billing tie-in + billing-engine hardening on the
-- field-application invoice engine. Reproduces the live save_field_app_invoice +
-- preview_field_app_invoice_split byte-faithful (verified via a rolled-back
-- function-definition diff before apply), then applies ONLY:
--   [B1.1/B2] Reject 0 / NULL / negative applied acres; never silently fall back to
--             total_acres (a 0 becoming the whole field was a real over-bill).
--             Preview clamps un-entered/negative to 0 (shows $0, never over-states).
--   [B1.3]    Capture product COST on grower-share (override-acre) lines so internal
--             margin is not overstated. Revenue on those lines stays $0.
--   [B1.5]    Bind salesman_id: a non-admin actor may only attribute to themselves.
--   [B1.2]    Make grouped selects / regeneration deleted_at-aware so a soft-deleted
--             split member (delete_invoices sets invoices.deleted_at, keeps
--             invoice_group_id) is not reused, re-cancelled, or wiped.
-- Owner decision (Mason 2026-06-22): 0 applied acres => REJECT with a clear message.
-- No signature change; single overload preserved. SECURITY DEFINER + search_path pinned.
-- Em-dashes in string literals are real U+2014 (byte-identical to the live function).

CREATE OR REPLACE FUNCTION public.save_field_app_invoice(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
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
  v_this_applied        numeric;   -- [B1.1] per-location applied acres (validated > 0)
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
  v_req_salesman        uuid;   -- [B1.5] salesman_id requested by the client
  v_salesman_id         uuid;   -- [B1.5] salesman_id actually written (gated)
  -- DELTA-AUDIT-ROW BEGIN (#8 nightly-debug: track whether each invoice in the loop was newly created
  -- this call, so the financial_audit_log 'invoice_created' row is written only on creation, not edits.)
  v_is_new_invoice      boolean;
  -- DELTA-AUDIT-ROW END
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save field application invoices';
  END IF;

  -- [B1.5] Bind salesman_id. Admins may attribute to anyone (or NULL); a non-admin
  -- may only attribute the invoice to themselves (mirrors the strict-actor pattern).
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
    -- [B1.1/B2] Applied acres must be entered and > 0. Never silently fall back to
    -- full-field (total_acres) acres; a 0 becoming the whole field was a real over-bill.
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

    -- DELTA-AUDIT-ROW BEGIN (#8 nightly-debug: capture create-vs-edit BEFORE the insert/update branch.)
    v_is_new_invoice := (v_invoice_id IS NULL);
    -- DELTA-AUDIT-ROW END

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
        salesman_id             = COALESCE(v_salesman_id, salesman_id),
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
        v_qa_unit_cost bigint;        -- [B1.3] PER-UNIT product cost for grower-share lines
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

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
          -- [B1.3] Capture product COST on the grower-share line. cost_cents is PER-UNIT
          -- (same semantics as the priced qty_b branch below, and InvoiceDetail multiplies
          -- cost_cents * quantity); v_invoice_cost gets the EXTENDED cost. Revenue stays $0
          -- (the override $/ac line carries revenue), but the cost must count or margin is
          -- overstated on override-acre invoices.
          v_qa_unit_cost := COALESCE((v_chem->>'cost_cents')::bigint, 0);
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            is_application_fee, price_source
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
            'manual'
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
          v_extended   := safe_cents_qty(v_unit_price, v_chem_qty_b);

          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            quoted_price_cents, is_application_fee, price_source
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            v_chem->>'description',
            ROUND(v_chem_qty_b, 4),
            v_chem->>'unit_size',
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source
          );

          v_invoice_total := v_invoice_total + v_extended;
          v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b);
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

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost,
      updated_at         = now()
    WHERE id = v_invoice_id;

    -- DELTA-AUDIT-ROW BEGIN (#8 nightly-debug: write the 'invoice_created' financial_audit_log row only
    -- for invoices created this call, matching create_invoice_from_order; edits keep their activity_feed trail.)
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
    -- DELTA-AUDIT-ROW END

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


CREATE OR REPLACE FUNCTION public.preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_field_ids         uuid[];
  v_applied_acres_map jsonb := '{}'::jsonb;
  v_loc               jsonb;
  v_shares            jsonb;
  v_customers         jsonb;
  v_customer          jsonb;
  v_customer_id       uuid;
  v_customer_tier     int;
  v_app_service       record;
  v_per_customer      jsonb := '[]'::jsonb;
  v_customer_lines    jsonb;
  v_grand_total       bigint := 0;
  v_chem              jsonb;
  v_share_row         jsonb;
  v_chem_qty_a        numeric;
  v_chem_qty_b        numeric;
  v_share_acres       numeric;
  v_field_override    bigint;
  v_unit_price        bigint;
  v_qi_price          numeric;
  v_extended          bigint;
  v_fee_rate          bigint;
  v_fee_acres         numeric;
  v_fee_extended      bigint;
  v_customer_total    bigint;
  v_rate              numeric;
BEGIN
  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    -- [B1.1/B2] Never fall back to total_acres. Un-entered / negative applied acres
    -- preview as 0 (a $0 line) rather than over-stating the bill at full-field acres.
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id',
      GREATEST(COALESCE((v_loc->>'applied_acres')::numeric, 0), 0)
    );
  END LOOP;

  IF v_field_ids IS NULL THEN
    RETURN jsonb_build_object('per_customer', '[]'::jsonb, 'grand_total_cents', 0, 'customer_count', 0);
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id    := (v_customer->>'customer_id')::uuid;
    v_customer_tier  := COALESCE((v_customer->>'tier')::int, 1);
    v_customer_total := 0;
    v_customer_lines := '[]'::jsonb;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'customer_id')::uuid = v_customer_id
        AND (value->>'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres    := (v_share_row->>'share_acres')::numeric;
      v_field_override := (v_share_row->>'price_override_cents')::bigint;
      v_extended := ROUND(v_field_override * v_share_acres)::bigint;
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'grower_share',
        'description', (v_share_row->>'field_name') || ' grower share @ $' ||
                       (v_field_override / 100.0)::numeric(12,2) || '/ac',
        'quantity', v_share_acres,
        'unit_price_cents', v_field_override,
        'extended_cents', v_extended
      );
      v_customer_total := v_customer_total + v_extended;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);
      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value->>'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      IF v_chem_qty_b > 0 THEN
        v_unit_price := NULL;
        IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
           AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
          v_unit_price := (v_chem->>'unit_price_cents')::bigint;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
            JOIN quote_sections qs ON qs.id = qi.section_id
           WHERE qi.product_id = (v_chem->>'product_id')::uuid
             AND qs.field_id   = ANY(v_field_ids)
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN v_unit_price := ROUND(v_qi_price * 100)::bigint; END IF;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT CASE v_customer_tier
            WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
            WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
            WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
            ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
          END INTO v_unit_price FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_unit_price := COALESCE(v_unit_price, 0);
        v_extended := ROUND(v_unit_price * v_chem_qty_b)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'chemical', 'description', v_chem->>'description',
          'quantity', ROUND(v_chem_qty_b, 4),
          'unit_price_cents', v_unit_price, 'extended_cents', v_extended
        );
        v_customer_total := v_customer_total + v_extended;
      END IF;
    END LOOP;

    IF p_application_service_id IS NOT NULL AND v_app_service IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season = current_season() LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;
      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;
      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := ROUND(v_fee_rate * v_fee_acres)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'service_fee', 'description', v_app_service.name,
          'quantity', v_fee_acres, 'unit_price_cents', v_fee_rate,
          'extended_cents', v_fee_extended
        );
        v_customer_total := v_customer_total + v_fee_extended;
      END IF;
    END IF;

    v_per_customer := v_per_customer || jsonb_build_object(
      'customer_id',   v_customer_id,
      'customer_name', v_customer->>'customer_name',
      'is_primary',    COALESCE((v_customer->>'is_primary')::boolean, false),
      'tier',          v_customer_tier,
      'total_cents',   v_customer_total,
      'lines',         v_customer_lines
    );
    v_grand_total := v_grand_total + v_customer_total;
  END LOOP;

  RETURN jsonb_build_object(
    'per_customer',      v_per_customer,
    'grand_total_cents', v_grand_total,
    'customer_count',    jsonb_array_length(v_customers),
    'shares_detail',     v_shares
  );
END;
$function$;


-- [B1.2] post_invoice_group must also skip soft-deleted members. delete_invoices
-- sets invoices.deleted_at but KEEPS invoice_group_id, so without this filter a
-- soft-deleted split member would be counted, locked, validated, and POSTED here
-- (or block the group). Reproduced byte-faithful from live + AND deleted_at IS NULL
-- on every invoice_group_id loop. (Codex P1, 2026-06-23.)
CREATE OR REPLACE FUNCTION public.post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_inv            record;
  v_posted_ids     uuid[] := '{}';
  v_total_cents    bigint := 0;
  v_member_count   int := 0;
  v_result         jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to post invoice groups';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'post_invoice_group';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_group_id IS NULL THEN RAISE EXCEPTION 'invoice_group_id is required'; END IF;

  PERFORM 1 FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL FOR UPDATE;

  SELECT COUNT(*) INTO v_member_count FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL;
  IF v_member_count = 0 THEN RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id; END IF;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL
  LOOP
    IF v_inv.status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot post group — invoice % has status %', v_inv.invoice_number, v_inv.status;
    END IF;
    -- PRICING_INCOMPLETE gate (sell-side #2): fail fast before posting any member;
    -- post_invoice() (called below) also enforces the order-level check.
    IF v_inv.pricing_pending THEN
      RAISE EXCEPTION 'PRICING_INCOMPLETE';
    END IF;
    PERFORM check_period_open(v_inv.invoice_date);
  END LOOP;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL ORDER BY invoice_number
  LOOP
    PERFORM post_invoice(v_inv.id, NULL);
    v_posted_ids := array_append(v_posted_ids, v_inv.id);
    v_total_cents := v_total_cents + v_inv.total_amount_cents;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('invoice_group_posted',
          'Posted ' || v_member_count || ' invoice(s) in group — total $' ||
            (v_total_cents / 100.0)::numeric(12,2),
          p_performed_by, 'invoice', v_posted_ids[1]);

  v_result := jsonb_build_object(
    'posted_invoice_ids', to_jsonb(v_posted_ids),
    'invoice_group_id',   p_invoice_group_id,
    'total_posted_cents', v_total_cents,
    'member_count',       v_member_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'post_invoice_group', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
