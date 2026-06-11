-- ============================================================================
-- blend_invoice_column_fix -- repair the 42703 in create_invoice_from_blend_ticket
-- (error-prevention follow-up queue item 1 of the plpgsql_check sweep;
--  docs/audits/2026-06-10-error-prevention-execution-log.md SS4.1)
-- ----------------------------------------------------------------------------
-- BUG (live today): the chem-line loop reads
--       LEFT JOIN products p ... SELECT ... p.unit_cost AS product_cost
-- but public.products has NO unit_cost column (the cost column is
-- current_cost, numeric DOLLARS). The loop query raises 42703 the moment it
-- is planned, so EVERY call on a ticket that has blend_ticket_products rows
-- crashes; only product-less tickets could ever invoice.
--   Evidence (live catalog, 2026-06-10):
--   * plpgsql_check_function('public.create_invoice_from_blend_ticket(uuid,uuid,text)')
--       -> error:42703:172:FOR over SELECT rows: column p.unit_cost does not
--          exist (plus the 10x "v_btp not assigned" cascade -- the record
--          never gets a type because its source query is invalid).
--   * information_schema.columns: products has current_cost (numeric dollars,
--     the same dollars family as tier1/2/3_price) and no unit_cost.
--
-- LATENT SIBLINGS MASKED BY THE SAME ERROR (must ship together or the fn is
-- STILL broken): the loop body also reads v_btp.unit_size and v_btp.rate_unit
-- (both chem-line INSERTs). v_btp = btp.* + 5 aliased products columns;
-- blend_ticket_products has NO unit_size / rate_unit (its own columns are
-- unit / rate_per_acre_unit) and the SELECT list never pulled p.unit_size /
-- p.rate_unit -- so after fixing ONLY the 42703, every chem line would still
-- die with: record "v_btp" has no field "unit_size". plpgsql_check cannot see
-- these yet because analysis of the statement stops at the first error (D1).
--   Intent evidence for the product-side source: products has columns of
--   exactly these names; the sister fn save_field_app_invoice (same
--   qty_a/qty_b INSERT shape) fills invoice_items.unit_size/rate_unit per
--   line; create_quick_delivery uses products.unit_size as the canonical
--   product-side fallback for a line's unit_size. The LEFT JOIN means
--   custom/OCR-only rows (product_id NULL) get NULL -- both invoice_items
--   columns are nullable.
--
-- BASELINE (verbatim-from-live): prosrc md5 de71d06949bb83c246fd884705ddf4e2
-- -- the CURRENT live body, i.e. the 20260609142447 FOR UPDATE hardening
-- (byte-verified: that disk file's $function$ body hashes to the same md5).
-- The body below is that text VERBATIM except one contiguous
-- sentinel-delimited SELECT-list edit. Reconstruction check: replacing the
-- five DELTA-BLEND-INV-COLFIX lines with the original two-line SELECT tail
--   |      SELECT btp.*, p.tier1_price, p.tier2_price, p.tier3_price,
--   |             p.product_name AS full_product_name, p.unit_cost AS product_cost
-- restores the baseline md5 exactly (verified at staging time).
-- Expected post-apply prosrc md5 (LF): 036091796baa73eb0754e5c2dd4de95b.
--
-- DELTAS, exhaustively (one sentinel block, nothing else changed):
--   D1  p.unit_cost AS product_cost -> p.current_cost AS product_cost
--       (numeric dollars; the body already converts product_cost dollars ->
--       bigint cents via ROUND(... * 100)::bigint exactly as it does the tier
--       prices -- money stays bigint cents at every write, per house rule).
--   D2  append p.unit_size, p.rate_unit to the same SELECT list so the
--       body's existing v_btp.unit_size / v_btp.rate_unit reads resolve.
-- Deliberately NOT touched (separate queued work -- do not fold in):
--   * the operation-unscoped idempotency lookup (22-RPC sweep, log SS4.4;
--     this fn is on the grandfathered list in src/lib/rpcIdempotencyScope.test.ts);
--   * plpgsql_check's benign 42804 warning on the v_invoice_ids '{}' init.
-- Signature unchanged; one overload. Reversible: re-apply the baseline body.
--
-- GRANTS: restated UNCHANGED from the live proacl
-- {postgres, authenticated, service_role} -- the REVOKE below only strips
-- PUBLIC/anon, which already hold nothing; asserted in self-verification.
-- caller-analysis: create_invoice_from_blend_ticket :: grants restated unchanged -- sole UI caller src/pages/BlendTicketDetail.tsx:608 runs as authenticated, which KEEPS EXECUTE; the REVOKE touches only PUBLIC/anon, neither of which holds EXECUTE in the live proacl
--
-- Smoke (run rolled-back AFTER apply):
--   scripts/smoke/smoke-blend_invoice_column_fix.sql -> SMOKE_PASS_ROLLBACK
--   (fixture completed+approved ticket -> invoice 'draft' field_application,
--    chem line cost_cents proves p.current_cost was read, unit_size/rate_unit
--    prove D2, ticket flips to 'billed', idempotent replay returns the cached
--    result without a second invoice).
-- ============================================================================

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
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_created_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create blend ticket invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved (status: %)', v_ticket.review_status;
  END IF;
  IF v_ticket.payment_status = 'billed' THEN
    RAISE EXCEPTION 'Blend ticket already billed';
  END IF;

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
             -- DELTA-BLEND-INV-COLFIX BEGIN (D1: p.unit_cost -> p.current_cost; D2: + p.unit_size, p.rate_unit)
             p.product_name AS full_product_name, p.current_cost AS product_cost,
             p.unit_size, p.rate_unit
             -- DELTA-BLEND-INV-COLFIX END
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

      IF v_chem_qty_a > 0 THEN
        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name) || ' — included in grower share',
          ROUND(v_chem_qty_a, 4), v_btp.unit_size,
          0, 0, 0,
          v_btp.sequence_order, v_rate, v_btp.rate_unit,
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
        v_extended := safe_cents_qty(v_unit_price, v_chem_qty_b);

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          quoted_price_cents, is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name),
          ROUND(v_chem_qty_b, 4), v_btp.unit_size,
          v_unit_price, v_extended, v_unit_cost,
          v_btp.sequence_order, v_rate, v_btp.rate_unit,
          v_quoted_price, false, v_price_source
        );
        v_invoice_total := v_invoice_total + v_extended;
        v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b);
      END IF;
    END LOOP;

    IF v_ticket.application_service_id IS NOT NULL AND v_app_service IS NOT NULL AND v_app_service.is_active THEN
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
-- Grants: restated verbatim from the live proacl (no change in effect).
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'create_invoice_from_blend_ticket' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_invoice_from_blend_ticket overload count = %, expected 1', v_count;
  END IF;

  -- Delta sentinels + both fixes present; the 42703 column gone
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'create_invoice_from_blend_ticket' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%DELTA-BLEND-INV-COLFIX BEGIN%' OR v_src NOT LIKE '%DELTA-BLEND-INV-COLFIX END%' THEN
    RAISE EXCEPTION 'deployed body is missing the delta sentinel block';
  END IF;
  IF v_src NOT LIKE '%p.current_cost AS product_cost%'
     OR v_src NOT LIKE '%p.unit_size, p.rate_unit%' THEN
    RAISE EXCEPTION 'deployed body is missing the D1/D2 column fixes';
  END IF;
  -- NB: deliberately NOT testing bare '%p.unit_cost%' -- that would
  -- substring-match the legitimate btp.unit_cost_cents read. The full
  -- aliased form below is unique to the bug.
  IF v_src LIKE '%unit_cost AS product_cost%' THEN
    RAISE EXCEPTION 'deployed body still references products.unit_cost (the 42703 bug)';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'create_invoice_from_blend_ticket' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'create_invoice_from_blend_ticket must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL unchanged: authenticated + service_role keep EXECUTE, anon/PUBLIC none
  IF NOT has_function_privilege('authenticated', 'public.create_invoice_from_blend_ticket(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_invoice_from_blend_ticket: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.create_invoice_from_blend_ticket(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_invoice_from_blend_ticket: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.create_invoice_from_blend_ticket(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_invoice_from_blend_ticket: service_role lost EXECUTE';
  END IF;

  -- The repair is only done when the static analyzer agrees: 0 error lines.
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check') THEN
    SELECT count(*) INTO v_count
    FROM plpgsql_check_function('public.create_invoice_from_blend_ticket(uuid,uuid,text)'::regprocedure) AS f(msg)
    WHERE f.msg LIKE 'error:%';
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'plpgsql_check still reports % error line(s) on create_invoice_from_blend_ticket', v_count;
    END IF;
  END IF;
END $$;
