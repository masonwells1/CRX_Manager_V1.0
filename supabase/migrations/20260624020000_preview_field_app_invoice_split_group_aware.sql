-- 20260624020000_preview_field_app_invoice_split_group_aware.sql
-- Align the billing PREVIEW with Save's "deleted stays deleted" behavior (Codex P2,
-- 2026-06-24). preview_field_app_invoice_split was field-based (no group context), so
-- when editing a split group after one member was soft-deleted it could still show a
-- customer + total that save_field_app_invoice (since 20260624010000) correctly drops.
-- Fix: add an optional p_invoice_id; when given, resolve its group and exclude customers
-- whose only invoice in the group was soft-deleted (no live one) — the exact set Save skips.
--
-- Signature changes (jsonb,jsonb,uuid) -> (jsonb,jsonb,uuid,uuid), so this DROPs the old
-- overload and CREATEs the new one (single overload preserved) and re-grants the exact live
-- posture (authenticated + service_role; NO anon/public). Backward compatible: a 3-arg call
-- still resolves (p_invoice_id defaults NULL -> no exclusion, identical to today).
-- Reproduces the now-live (20260623140000 B1+B2) body byte-faithful + 5 additive deltas:
-- the p_invoice_id param, two declares, the skip-set computation, the customer-loop CONTINUE,
-- and customer_count now counts the emitted per_customer list. No em-dashes in this function.
--
-- caller-analysis: preview_field_app_invoice_split :: the only live caller (FieldApplicationInvoice.tsx
--   handlePreview) calls it as an AUTHENTICATED user. The live grant posture is exactly
--   authenticated:EXECUTE + service_role:EXECUTE (NO anon/public — verified via
--   information_schema.role_routine_grants). A fresh CREATE FUNCTION would default-grant
--   EXECUTE to PUBLIC, so this REVOKE ALL FROM PUBLIC + GRANT TO authenticated,service_role
--   RESTORES that exact posture (it does not remove access the function had). The authenticated
--   UI caller is therefore unaffected; only the would-be-new PUBLIC/anon grant is stripped.

DROP FUNCTION IF EXISTS public.preview_field_app_invoice_split(jsonb, jsonb, uuid);

CREATE FUNCTION public.preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid)
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
  v_group_id          uuid;                    -- [2026-06-24] group being edited (deleted-member exclusion)
  v_skipped_customer_ids uuid[] := '{}';       -- [2026-06-24] deleted split members, excluded to match Save
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

  -- [2026-06-24] Mirror save_field_app_invoice's "deleted stays deleted": when previewing an
  -- edit of a split group, exclude customers whose only invoice in the group was soft-deleted
  -- (no live one), so Preview shows the same customers/total Save will actually create.
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
    -- [2026-06-24] skip a deleted split member so Preview matches Save (deleted stays deleted)
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

REVOKE ALL ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid) TO authenticated, service_role;
