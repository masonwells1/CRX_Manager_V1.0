-- 20260625140000_fuel_surcharge_setting.sql
-- Field-app parity #32 (FUEL SURCHARGE — configurable setting, OFF by default).
--
-- ⚠️ MONEY-RULE SAFETY (read before touching): the actual surcharge rate/formula
-- is a BILLING DECISION ONLY THE OWNER CAN MAKE. This migration builds the
-- MECHANISM ONLY. It ships:
--   * OFF by default (enabled = false), and
--   * with the rate/basis LEFT BLANK (no invented number anywhere).
-- With that default, EVERY field-app invoice behaves byte-for-byte as it did
-- before this migration — ZERO surcharge line, ZERO change to any total. The
-- surcharge is computed ONLY when the owner (an admin) both flips it ON *and*
-- enters a non-blank rate in Settings. If the rate is blank, NOTHING is added
-- even when "enabled". NO DEFAULT RATE OR FORMULA IS INVENTED HERE.
--
-- WHAT THIS DOES (all additive / money-neutral at the shipped default):
--   1. Seed an INERT config row in the existing app_settings table
--      (key 'fuel_surcharge', value = {"enabled":false,"basis":"","rate":""}).
--      app_settings already has admin-only INSERT/UPDATE RLS (settings_insert /
--      settings_update gate on is_admin()), so only admins can ever change it.
--   2. compute_fuel_surcharge_cents(p_acres, p_subtotal_cents) — a PURE, IMMUTABLE
--      bigint-cents helper. Returns 0 when off OR rate blank/non-positive. No float.
--   3. Re-create save_field_app_invoice + preview_field_app_invoice_split with ONE
--      added surcharge block per customer (modeled on the is_application_fee /
--      sort_order=9999 app-service-fee line). The block reads the setting, computes
--      the surcharge in cents, writes/returns a single clearly-labeled line, and
--      adds it to that customer's total — which already flows into the PDF and the
--      per-customer share split. EVERYTHING ELSE in both bodies is a verbatim copy
--      of the live 20260624212000 / live preview body.
--
-- Single overload of each function (CREATE OR REPLACE on the exact live signature).
-- Em-dashes below are real U+2014.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Seed the inert config row (OFF, blank rate). ON CONFLICT DO NOTHING so a
--    re-run / an owner-edited value is never clobbered. enabled=false + rate=''
--    means the compute helper returns 0 → no surcharge, no money change.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings (setting_key, setting_value, description)
VALUES (
  'fuel_surcharge',
  '{"enabled": false, "basis": "", "rate": ""}',
  'Field-app fuel surcharge. OFF by default with a BLANK rate — the owner sets the rule. '
  || 'JSON: {"enabled": bool, "basis": "per_acre"|"percent"|"flat", "rate": "<owner number, blank by default>"}. '
  || 'per_acre/flat rate is in DOLLARS; percent is a percentage of the customer subtotal. '
  || 'No surcharge is ever computed while enabled=false OR rate is blank/non-positive.'
)
ON CONFLICT (setting_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Pure bigint-cents surcharge math. Shared by save + preview so the editor
--    Preview, the saved invoice, the PDF and the share split can never disagree.
--    Returns 0 (no line) unless enabled=true AND a positive numeric rate is set.
--    p_acres        = this customer's billable applied acres (for the per_acre basis)
--    p_subtotal_cents = this customer's running subtotal BEFORE the surcharge
--                       (for the percent basis). flat ignores both.
--    NEVER reads a default rate — only the owner-entered value in app_settings.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_fuel_surcharge_cents(
  p_acres numeric,
  p_subtotal_cents bigint
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cfg       jsonb;
  v_enabled   boolean;
  v_basis     text;
  v_rate_text text;
  v_rate      numeric;
BEGIN
  SELECT setting_value::jsonb INTO v_cfg
    FROM app_settings WHERE setting_key = 'fuel_surcharge';

  -- No config row, or malformed → behave exactly as if the feature did not exist.
  IF v_cfg IS NULL THEN RETURN 0; END IF;

  v_enabled := COALESCE((v_cfg->>'enabled')::boolean, false);
  IF NOT v_enabled THEN RETURN 0; END IF;     -- OFF (the shipped default) → no surcharge.

  v_basis     := COALESCE(v_cfg->>'basis', '');
  v_rate_text := NULLIF(TRIM(COALESCE(v_cfg->>'rate', '')), '');
  IF v_rate_text IS NULL THEN RETURN 0; END IF;  -- BLANK rate → no surcharge (even if "enabled").

  -- Parse the owner's number defensively; a non-numeric value yields no surcharge
  -- rather than an error that would block saving an invoice.
  BEGIN
    v_rate := v_rate_text::numeric;
  EXCEPTION WHEN others THEN
    RETURN 0;
  END;

  IF v_rate IS NULL OR v_rate <= 0 THEN RETURN 0; END IF;  -- non-positive → no surcharge.

  -- All math in exact numeric, ROUND to whole cents, cast to bigint. No float.
  IF v_basis = 'per_acre' THEN
    -- rate is DOLLARS/acre → cents/acre = rate*100; × acres.
    IF p_acres IS NULL OR p_acres <= 0 THEN RETURN 0; END IF;
    RETURN ROUND(v_rate * 100 * p_acres)::bigint;
  ELSIF v_basis = 'percent' THEN
    -- rate is a percentage of the customer subtotal.
    IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN RETURN 0; END IF;
    RETURN ROUND(p_subtotal_cents::numeric * v_rate / 100)::bigint;
  ELSIF v_basis = 'flat' THEN
    -- rate is a flat DOLLARS amount per customer invoice → cents.
    RETURN ROUND(v_rate * 100)::bigint;
  ELSE
    -- Unknown/blank basis → no surcharge (owner hasn't finished configuring).
    RETURN 0;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.compute_fuel_surcharge_cents(numeric, bigint) IS
  'Field-app parity #32: pure bigint-cents fuel-surcharge amount from app_settings.fuel_surcharge. Returns 0 unless enabled=true AND a positive owner-entered rate is set (OFF/blank by default = 0). Never invents a rate. basis per_acre/flat = dollars, percent = percent of subtotal.';

-- This helper only READS the setting and is not a frontend RPC. Keep it off anon AND
-- the default PUBLIC grant (the CREATE auto-grants EXECUTE to PUBLIC, which anon inherits);
-- authenticated retains EXECUTE so the SECURITY DEFINER callers below can invoke it.
REVOKE EXECUTE ON FUNCTION public.compute_fuel_surcharge_cents(numeric, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.compute_fuel_surcharge_cents(numeric, bigint) FROM anon;
GRANT  EXECUTE ON FUNCTION public.compute_fuel_surcharge_cents(numeric, bigint) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3a. save_field_app_invoice — verbatim copy of the live 20260624212000 body
--     with ONE addition: a fuel-surcharge fee line per customer, inserted right
--     after the application-service fee block and BEFORE the invoice-total UPDATE,
--     so v_invoice_total (and therefore invoice_shares.amount_cents, the PDF, and
--     the share split) includes it. The surcharge line is modeled on the
--     is_application_fee / sort_order=9999 app-fee line. Delta marked  -- #32:.
-- ─────────────────────────────────────────────────────────────────────────────
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
  v_skipped_customer_ids uuid[] := '{}';   -- [2026-06-24] deleted split members we will NOT recreate
  v_is_new_invoice      boolean;
  v_surcharge_acres     numeric;  -- #32: this customer's priced (non-override) acres for per_acre basis
  v_surcharge_cents     bigint;   -- #32: computed fuel surcharge (0 unless owner enabled + set a rate)
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
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

        IF (v_chem->>'product_id') IS NOT NULL THEN
          SELECT p.product_form::text, COALESCE(v_epa, p.epa_registration), COALESCE(v_vendor, p.vendor)
            INTO v_form, v_epa, v_vendor
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
          v_extended   := safe_cents_qty(v_unit_price, v_chem_qty_b);

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
            ROUND(v_chem_qty_b, 4),
            v_chem->>'unit_size',
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source,
            v_wh, v_vendor, ROUND(v_chem_qty_b, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
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

    -- #32: FUEL SURCHARGE LINE (owner-configured; OFF + blank by default = NOTHING here).
    -- compute_fuel_surcharge_cents returns 0 unless an admin enabled the setting AND
    -- entered a positive rate. When it returns 0 NO line is written and v_invoice_total
    -- is byte-identical to the pre-#32 total. The line is a non-product fee line
    -- (is_application_fee=true so the PDF/total treat extended_cents as the flat amount;
    -- sort_order=9998 keeps it just before the application-service fee). Cost is $0
    -- (a surcharge is pure revenue/markup — there is no product cost behind it).
    -- For the per_acre basis the surcharge is on this customer's PRICED (non-override)
    -- acres only, mirroring the application-service fee's acre basis; the percent basis
    -- is on this customer's running subtotal (v_invoice_total so far).
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3b. preview_field_app_invoice_split — verbatim copy of the live body with the
--     SAME surcharge block so the editor Preview matches what Save will write.
--     Delta marked  -- #32:.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid)
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
  v_group_id          uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_surcharge_acres   numeric;   -- #32
  v_surcharge_cents   bigint;    -- #32
BEGIN
  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
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

  IF p_invoice_id IS NOT NULL THEN
    SELECT invoice_group_id INTO v_group_id FROM invoices WHERE id = p_invoice_id;
    IF v_group_id IS NOT NULL THEN
      SELECT COALESCE(array_agg(DISTINCT d.customer_id), '{}') INTO v_skipped_customer_ids
        FROM invoices d
       WHERE d.invoice_group_id = v_group_id
         AND d.deleted_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM invoices l
            WHERE l.invoice_group_id = v_group_id
              AND l.customer_id = d.customer_id
              AND l.deleted_at IS NULL
         );
    END IF;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id    := (v_customer->>'customer_id')::uuid;
    IF v_customer_id = ANY(v_skipped_customer_ids) THEN CONTINUE; END IF;
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

    -- #32: FUEL SURCHARGE preview line — identical math + ordering to save_field_app_invoice
    -- so the editor Preview total equals the saved total. Returns 0 (no line) unless the
    -- owner enabled the setting AND entered a positive rate. per_acre = this customer's
    -- priced (non-override) acres; percent = this customer's running subtotal so far.
    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_customer_total);

    IF v_surcharge_cents > 0 THEN
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'fuel_surcharge', 'description', 'Fuel Surcharge',
        'quantity', 1, 'unit_price_cents', v_surcharge_cents,
        'extended_cents', v_surcharge_cents
      );
      v_customer_total := v_customer_total + v_surcharge_cents;
    END IF;
    -- #32 END

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
    'customer_count',    jsonb_array_length(v_per_customer),
    'shares_detail',     v_shares
  );
END;
$function$;

-- Keep anon off the re-created preview fn (matches 20260624030000 revoke).
REVOKE ALL ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid) FROM anon;
