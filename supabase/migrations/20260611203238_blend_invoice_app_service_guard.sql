-- ============================================================================
-- blend_invoice_app_service_guard -- fix the 55000 unassigned-record crash in
-- create_invoice_from_blend_ticket on the no-application-service (MAIN) path
-- (the bug 20260611001954's post-apply smoke unmasked; the defect itself
--  predates today's 42703 colfix)
-- ----------------------------------------------------------------------------
-- BUG (live-verified 2026-06-11 08:5x, re-confirmed against live at draft time):
--   v_app_service record is assigned ONLY inside
--     IF v_ticket.application_service_id IS NOT NULL THEN
--       SELECT * INTO v_app_service FROM application_services WHERE id = ...;
--   yet the application-fee gate inside the per-customer loop reads
--     v_ticket.application_service_id IS NOT NULL
--       AND v_app_service IS NOT NULL AND v_app_service.is_active
--   When blend_tickets.application_service_id IS NULL (plain no-service
--   tickets -- the main path), the record is never assigned and evaluating
--   that IF raises SQLSTATE 55000 'record "v_app_service" is not yet
--   assigned'. The .is_active field reference is resolved while BINDING the
--   expression, BEFORE any AND short-circuit, so the false first operand does
--   NOT save it. Until 20260611001954 this was masked: the chem-line loop's
--   42703 (products.unit_cost) aborted every product-bearing call first; the
--   colfix unmasked it and its post-apply smoke (NULL-service fixture) then
--   failed here with 55000.
--
-- EVIDENCE (all read live at draft time 2026-06-11, project rhyzpcqhnizqbxphqdkr):
--   * live prosrc contains 'v_app_service IS NOT NULL' and NO guard boolean;
--     md5(prosrc) = 036091796baa73eb0754e5c2dd4de95b (exactly the post-apply
--     md5 the 20260611001954 header predicted -- baseline confirmed current).
--   * plpgsql_check_function_tb on the live fn: 0 error rows (only the benign
--     42804 warning on the v_invoice_ids '{}' init) -- this bug class is
--     INVISIBLE to the static analyzer; the two-path smoke is the only proof.
--   * Empirical read-only DO probe, run live at draft time:
--       T1  IF false AND r.is_active  with r never assigned
--           -> 55000 'record "r" is not assigned yet'  (short-circuit does NOT
--           protect a record FIELD reference, so merely prepending a guard
--           boolean to the SAME expression would NOT fix the bug)
--       T2  r IS NOT NULL with r never assigned -> no error (the composite
--           whole-record test is innocent; only the field ref crashes)
--       T3  zero-row SELECT * INTO r -> record assigned an all-NULL row;
--           field refs fine, r IS NULL = true, FOUND = false  (folding the
--           field tests into a boolean RIGHT AFTER the SELECT INTO is safe on
--           every path)
--   * application_services.is_active is boolean NOT NULL DEFAULT true.
--   * all 4 live application_services rows have vehicle_id AND created_by set
--     (active, fully populated) -- real fee-producing services satisfy the
--     gate's quirky all-columns-non-null composite test, which this fix
--     PRESERVES (a service row with any NULL column silently skipped the fee
--     before this fix and still does after; smoke path (b2) regression-checks
--     exactly that).
--
-- FIX (minimal, semantics-preserving; sentinel DELTA-BLEND-INV-APPSVC-GUARD):
--   G1  DECLARE  v_has_app_service boolean := false;
--   G2  immediately after the SELECT INTO (the only place the record is
--       guaranteed assigned):
--         v_has_app_service := FOUND
--                              AND (v_app_service IS NOT NULL)
--                              AND COALESCE(v_app_service.is_active, false);
--       FOUND per the fix spec; the composite IS NOT NULL + is_active terms
--       reproduce the original gate's exact semantics (including its quirky
--       all-columns-non-null composite test) on every path that did not crash.
--   G3  the fee gate becomes  IF v_has_app_service THEN  -- no record
--       reference remains in any expression reachable with it unassigned.
--   Path truth table (original -> new):
--     service id NULL                    : 55000 crash -> false (invoice OK)  THE FIX
--     id set, row gone                   : false -> false                     same
--     id set, row found, some col NULL   : false (composite) -> false         same
--     id set, row found, active          : true  -> true                      same
--     id set, row found, inactive        : false -> false                     same
--
-- BASELINE (verbatim-from-live):
--   md5(prosrc) of live public.create_invoice_from_blend_ticket(uuid,uuid,text)
--   pre-apply = 036091796baa73eb0754e5c2dd4de95b (single overload, prosecdef
--   = true, proconfig = search_path=public, pg_temp, proacl = {postgres=X,
--   authenticated=X, service_role=X}). The body below is that text VERBATIM
--   except the three sentinel-delimited G1/G2/G3 deltas (draft-time
--   reconstruction check: stripping the three DELTA-BLEND-INV-APPSVC-GUARD
--   blocks and restoring the one original gate line reproduces the baseline
--   md5 exactly). The 20260611001954 DELTA-BLEND-INV-COLFIX sentinel block is
--   part of the baseline and is preserved untouched.
--   Expected post-apply prosrc md5 (LF): 621c6844a47fa3b4594eaa6b075419e4.
--   The pre-flight DO block below refuses to apply over a drifted live body
--   (parallel-session staleness guard).
--
-- EXHAUSTIVE DELTA LIST (everything else is verbatim live):
--   G1  DECLARE block, immediately after 'v_app_service         record;':
--         + v_has_app_service     boolean := false;
--   G2  inside 'IF v_ticket.application_service_id IS NOT NULL THEN', after
--       the SELECT INTO: + the v_has_app_service assignment (FIX above).
--   G3  the fee-gate line (4-space indent, inside the customer loop).
--       Original single line:
--         IF v_ticket.application_service_id IS NOT NULL AND v_app_service IS NOT NULL AND v_app_service.is_active THEN
--       -> IF v_has_app_service THEN
--   Deliberately NOT touched (separate queued work -- do not fold in):
--     * the operation-unscoped idempotency lookup (this fn is on the
--       grandfathered list; the 20260611080937 sweep did not cover it);
--     * plpgsql_check's benign 42804 warning on the v_invoice_ids '{}' init.
--   Signature unchanged; one overload. Reversible: re-apply the baseline body.
--
-- GRANTS: restated UNCHANGED from the live proacl
-- {postgres=X, authenticated=X, service_role=X} -- the REVOKE below only
-- strips PUBLIC/anon, which already hold nothing; asserted in
-- self-verification.
-- caller-analysis: create_invoice_from_blend_ticket :: grants restated unchanged -- sole UI caller src/pages/BlendTicketDetail.tsx runs as authenticated, which KEEPS EXECUTE; the REVOKE touches only PUBLIC/anon, neither of which holds EXECUTE in the live proacl
--
-- Smoke (run rolled-back AFTER apply):
--   scripts/smoke/smoke-blend_invoice_app_service_guard.sql -> SMOKE_PASS_ROLLBACK
--   (path (a): completed+approved NO-service ticket -> invoice created with
--    ZERO fee lines -- the exact call that raises 55000 on live today;
--    path (b): ticket WITH an active fully-populated service -> chem line +
--    fee line at the default rate (850c/ac x 10 ac = 8500, cost 300c/ac ->
--    3000), totals 28500/27680, invoices.application_service_id stamped;
--    path (b2): active service with NULL vehicle_id/created_by -> fee still
--    silently skipped (the preserved composite semantics, regression-pinned);
--    path (c): idempotent replay returns the cached jsonb, no second invoice.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Pre-flight: refuse to apply over a drifted body (parallel-session guard).
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE proname = 'create_invoice_from_blend_ticket'
    AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'create_invoice_from_blend_ticket not found in public schema';
  END IF;
  IF v_md5 NOT IN ('036091796baa73eb0754e5c2dd4de95b',   -- the 20260611001954 baseline this draft is verbatim from
                   '621c6844a47fa3b4594eaa6b075419e4') THEN   -- idempotent re-run of this very fix
    RAISE EXCEPTION 'STALE DRAFT: live md5(prosrc) = % is neither the drafted baseline nor this fix -- live drifted since draft time; re-draft from live', v_md5;
  END IF;
END $$;

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
  -- DELTA-BLEND-INV-APPSVC-GUARD BEGIN (G1: guard boolean for the fee gate)
  v_has_app_service     boolean := false;
  -- DELTA-BLEND-INV-APPSVC-GUARD END (G1)
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
    -- DELTA-BLEND-INV-APPSVC-GUARD BEGIN (G2: fold the fee-gate record tests into a
    -- boolean HERE, the only spot v_app_service is guaranteed assigned (found row,
    -- or the all-NULL row a zero-row SELECT INTO leaves; FOUND distinguishes them).
    -- Term-for-term the original gate's semantics, minus the crash.)
    v_has_app_service := FOUND
                         AND (v_app_service IS NOT NULL)
                         AND COALESCE(v_app_service.is_active, false);
    -- DELTA-BLEND-INV-APPSVC-GUARD END (G2)
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

    -- DELTA-BLEND-INV-APPSVC-GUARD BEGIN (G3: gate on the boolean only. The original
    -- three-term AND referenced a field of v_app_service; plpgsql resolves record
    -- fields while binding the expression, BEFORE short-circuit, so with no
    -- application service the never-assigned record raised SQLSTATE 55000 on the
    -- main no-service path.)
    IF v_has_app_service THEN
    -- DELTA-BLEND-INV-APPSVC-GUARD END (G3)
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

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'create_invoice_from_blend_ticket' AND pronamespace = 'public'::regnamespace;

  -- Byte-exact deploy: the strongest check, computed at draft time from the
  -- verbatim baseline + the three deltas.
  IF md5(v_src) <> '621c6844a47fa3b4594eaa6b075419e4' THEN
    RAISE EXCEPTION 'deployed prosrc md5 = %, expected 621c6844a47fa3b4594eaa6b075419e4 (body not byte-faithful)', md5(v_src);
  END IF;

  -- All three guard delta blocks present
  IF v_src NOT LIKE '%DELTA-BLEND-INV-APPSVC-GUARD BEGIN (G1%'
     OR v_src NOT LIKE '%DELTA-BLEND-INV-APPSVC-GUARD BEGIN (G2%'
     OR v_src NOT LIKE '%DELTA-BLEND-INV-APPSVC-GUARD BEGIN (G3%'
     OR v_src NOT LIKE '%DELTA-BLEND-INV-APPSVC-GUARD END (G3)%' THEN
    RAISE EXCEPTION 'deployed body is missing the G1/G2/G3 delta sentinel blocks';
  END IF;

  -- The guard boolean + the boolean-only fee gate
  IF v_src NOT LIKE '%v_has_app_service     boolean := false;%'
     OR v_src NOT LIKE '%IF v_has_app_service THEN%' THEN
    RAISE EXCEPTION 'deployed body is missing the guard boolean or the boolean fee gate';
  END IF;

  -- The crashing three-term gate is GONE (this exact text is unique to the bug;
  -- G2''s parenthesized/COALESCEd terms deliberately cannot match it)
  IF v_src LIKE '%IS NOT NULL AND v_app_service IS NOT NULL AND v_app_service.is_active THEN%' THEN
    RAISE EXCEPTION 'deployed body still contains the unguarded record-field fee gate (the 55000 bug)';
  END IF;

  -- The 20260611001954 COLFIX deltas must survive untouched (no regression)
  IF v_src NOT LIKE '%DELTA-BLEND-INV-COLFIX BEGIN%'
     OR v_src NOT LIKE '%p.current_cost AS product_cost%'
     OR v_src NOT LIKE '%p.unit_size, p.rate_unit%' THEN
    RAISE EXCEPTION 'deployed body lost the 20260611001954 COLFIX deltas';
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

  -- Static analyzer still clean (NB: it could NOT see this bug class; this
  -- assert only protects against introducing a NEW analyzable error)
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check') THEN
    SELECT count(*) INTO v_count
    FROM plpgsql_check_function('public.create_invoice_from_blend_ticket(uuid,uuid,text)'::regprocedure) AS f(msg)
    WHERE f.msg LIKE 'error:%';
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'plpgsql_check reports % error line(s) on create_invoice_from_blend_ticket', v_count;
    END IF;
  END IF;
END $$;
