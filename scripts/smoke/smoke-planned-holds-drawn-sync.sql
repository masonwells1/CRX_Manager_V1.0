-- ============================================================================
-- ROLLED-BACK smoke test for 20260611132115_planned_holds_drawn_sync
-- ----------------------------------------------------------------------------
-- Verifies authoritative server-side planned-hold synchronization (Codex r2
-- handoff §3): active holds for an OPEN planned quote always equal
-- GREATEST(booked − drawn, 0) per product after EVERY quote-saving workflow —
-- create_planned_holds, save_quote (Draft save / Revise / Mark Presented all
-- flow through it). A drawn booking's restore_quote_version path now refuses
-- before mutation because it cannot preserve per-line billing provenance; this
-- smoke proves that refusal leaves the already-synchronized holds unchanged.
-- Each product's drawn total consumes the EARLIEST items first so per-item expires_at
-- (needed_by + 14 days) follows the still-reserved tail.
--
-- HOW TO RUN: CONTAINER ONLY through
-- prove-draw-down-quote-intent-binding.mjs after the pending cutover sequence.
-- Do not run this chain against live before that sequence is applied: its
-- provenance-first restore behavior does not exist there yet. The post-cutover
-- draw wrapper is authenticated-only and service_role cannot execute it. The
-- block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK',
-- so every fixture, hold, order and ledger row created here is rolled back —
-- nothing persists. Any other exception text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims — injected below via set_config(..., is_local => true)
-- using a real active admin profile id. Direct fixture DML bypasses RLS
-- because we run as the table owner; the RPCs under test still enforce their
-- own auth/role gates.
--
-- Scenarios:
--   (a) planned quote (PA 300 early + PA 200 late + PB 100), create_planned_
--       holds -> 3 holds, PA 500 / PB 100, early item expires needed_by+14d
--   (b) draw 250 of PA -> existing FIFO hold decrement leaves PA 250
--   (c) create_planned_holds AGAIN (the reported bug: previously re-reserved
--       the full 500) -> PA 250 (50 @ early expiry + 200 @ late expiry),
--       PB 100 — booked − drawn with FIFO expiry
--   (d) save_quote rebooks PA to 400 (Revise/Present path; previously synced
--       nothing) -> PA holds 150 (= 400 − 250), PB 100
--   (e) snapshot at the 400 state, rebook to 450 via save (holds 200), then
--       restore_quote_version -> QUOTE_RESTORE_BLOCKED_BY_DRAW and holds stay 200
--   (f) is_planned switched off + save -> 0 active holds (server-side
--       release; the frontend's direct release becomes redundant)
-- ============================================================================

CREATE OR REPLACE FUNCTION pg_temp.restore_quote_version_smoke(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid,
  p_idempotency_key text,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_result jsonb;
BEGIN
  IF to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.restore_quote_version($1, $2, $3, $4, $5, NULL)'
      INTO v_result
      USING p_quote_id, p_version_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  ELSIF to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.restore_quote_version($1, $2, $3, $4, $5)'
      INTO v_result
      USING p_quote_id, p_version_id, p_performed_by, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  RETURN public.restore_quote_version(
    p_quote_id,
    p_version_id,
    p_performed_by,
    p_idempotency_key
  );
END;
$helper$;

CREATE OR REPLACE FUNCTION pg_temp.create_quote_version_smoke(
  p_quote_id uuid,
  p_performed_by uuid,
  p_method text,
  p_idempotency_key text,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_result jsonb;
BEGIN
  IF to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NOT NULL THEN
    EXECUTE
      'SELECT public.create_quote_version($1, $2, $3, $4, $5)'
      INTO v_result
      USING p_quote_id, p_performed_by, p_method, p_idempotency_key, p_expected_row_version;
    RETURN v_result;
  END IF;
  RETURN public.create_quote_version(
    p_quote_id,
    p_performed_by,
    p_method,
    p_idempotency_key
  );
END;
$helper$;

DO $smoke$
DECLARE
  v_admin uuid; v_cust uuid; v_pa uuid; v_pb uuid; v_q uuid;
  v_s1 uuid; v_s2 uuid; v_res jsonb; v_ver uuid; v_quote_version bigint;
  v_pa_early_item uuid; v_pa_late_item uuid; v_pb_early_item uuid;
  v_pa_total numeric; v_pb_total numeric; v_cnt int;
  v_e1 date; v_e2 date;
  v_err text;
  v_payload jsonb; v_sections jsonb;
  sfx text := substr(md5(random()::text), 1, 8);
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] PHS Farm ' || sfx) RETURNING id INTO v_cust;
  -- Establish real governed costs so the quote-cost snapshot trigger remains
  -- enabled while this rollback-only hold proof exercises booking draws.
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] PHS A ' || sfx, 'gal') RETURNING id INTO v_pa;
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] PHS B ' || sfx, 'gal') RETURNING id INTO v_pb;
  v_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_pa,
        'row_version', (SELECT pricing_version FROM products WHERE id = v_pa),
        'pricing_mode', 'margin_driven',
        'new_cost', '6.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke planned-holds fixture A'
      ),
      jsonb_build_object(
        'product_id', v_pb,
        'row_version', (SELECT pricing_version FROM products WHERE id = v_pb),
        'pricing_mode', 'margin_driven',
        'new_cost', '6.00',
        'tier1_margin_percent', '20',
        'tier2_margin_percent', '25',
        'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke planned-holds fixture B'
      )
    ),
    v_admin, 'smk-phds-price-preview-' || sfx
  );
  PERFORM apply_product_pricing_change_set(
    (v_res->>'change_set_id')::uuid,
    v_res->>'request_fingerprint',
    v_admin,
    'smk-phds-price-apply-' || sfx
  );

  INSERT INTO quotes (quote_number, customer_id, created_by, status, is_planned, commission_split)
  VALUES ('[SMOKE] PHS-' || sfx, v_cust, v_admin, 'sent', true, '{"splits": []}'::jsonb) RETURNING id INTO v_q;
  INSERT INTO quote_sections (quote_id, section_name, sort_order, needed_by_date) VALUES (v_q, 'Early', 0, DATE '2026-07-01') RETURNING id INTO v_s1;
  INSERT INTO quote_sections (quote_id, section_name, sort_order, needed_by_date) VALUES (v_q, 'Late', 1, DATE '2026-08-01') RETURNING id INTO v_s2;
  INSERT INTO quote_items (quote_id, section_id, product_id, price_per_unit, current_cost, total_units_needed, unit_size, sort_order, calc_mode)
  VALUES (v_q, v_s1, v_pa, 10, 6, 300, 'gal', 0, 'units_direct'),
         (v_q, v_s2, v_pa, 10, 6, 200, 'gal', 0, 'units_direct'),
         (v_q, v_s1, v_pb, 8, 4, 100, 'gal', 1, 'units_direct');
  SELECT id INTO STRICT v_pa_early_item FROM quote_items
  WHERE quote_id = v_q AND section_id = v_s1 AND product_id = v_pa;
  SELECT id INTO STRICT v_pa_late_item FROM quote_items
  WHERE quote_id = v_q AND section_id = v_s2 AND product_id = v_pa;
  SELECT id INTO STRICT v_pb_early_item FROM quote_items
  WHERE quote_id = v_q AND section_id = v_s1 AND product_id = v_pb;

  -- (a) create_planned_holds: full reservation, per-item expiry
  v_res := create_planned_holds(v_q, v_admin, NULL);
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0),
         COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pb), 0), count(*)
  INTO v_pa_total, v_pb_total, v_cnt
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 500 OR v_pb_total <> 100 OR v_cnt <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) holds pa=% pb=% cnt=%', v_pa_total, v_pb_total, v_cnt;
  END IF;
  SELECT expires_at::date INTO v_e1 FROM inventory_holds WHERE source_id = v_q AND product_id = v_pa AND quantity = 300;
  IF v_e1 IS DISTINCT FROM DATE '2026-07-15' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) early-item expiry = %, expected 2026-07-15', v_e1;
  END IF;

  -- (b) draw 250: existing FIFO decrement keeps invariant between saves
  v_res := draw_down_quote(v_q, jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 250)), v_admin, 'smk-phds-draw-' || sfx);
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0) INTO v_pa_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 250 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) after draw 250, pa holds = %, expected 250', v_pa_total;
  END IF;

  -- (c) create_planned_holds AGAIN: the reported bug would re-reserve 500
  v_res := create_planned_holds(v_q, v_admin, NULL);
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0),
         COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pb), 0), count(*)
  INTO v_pa_total, v_pb_total, v_cnt
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 250 OR v_pb_total <> 100 OR v_cnt <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) rebuild pa=% pb=% cnt=% (expected 250/100/3)', v_pa_total, v_pb_total, v_cnt;
  END IF;
  SELECT expires_at::date INTO v_e1 FROM inventory_holds WHERE source_id = v_q AND product_id = v_pa AND quantity = 50;
  SELECT expires_at::date INTO v_e2 FROM inventory_holds WHERE source_id = v_q AND product_id = v_pa AND quantity = 200;
  IF v_e1 IS DISTINCT FROM DATE '2026-07-15' OR v_e2 IS DISTINCT FROM DATE '2026-08-15' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) FIFO expiry wrong: 50@%, 200@%', v_e1, v_e2;
  END IF;

  -- (d) save_quote (Revise/Present path): rebooks PA to 400 -> holds 150
  -- This fixture has the same product in two sections, so it echoes item IDs to
  -- keep those duplicate-product rows identifiable across repeated saves. The
  -- save-quote-drawn-guard smoke separately preserves the production id-less
  -- fallback shape; this lane is about planned-hold synchronization.
  v_payload := jsonb_build_object('quote_number', '[SMOKE] PHS-' || sfx, 'customer_id', v_cust, 'status', 'sent', 'tier', 1);
  v_sections := jsonb_build_array(
    jsonb_build_object('section_name', 'Early', 'sort_order', 0, 'items', jsonb_build_array(
      jsonb_build_object('id', v_pa_early_item, 'product_id', v_pa, 'calc_mode', 'units_direct', 'total_units_needed', 200, 'price_per_unit', 10, 'current_cost', 6, 'sort_order', 0),
      jsonb_build_object('id', v_pb_early_item, 'product_id', v_pb, 'calc_mode', 'units_direct', 'total_units_needed', 100, 'price_per_unit', 8, 'current_cost', 4, 'sort_order', 1))),
    jsonb_build_object('section_name', 'Late', 'sort_order', 1, 'items', jsonb_build_array(
      jsonb_build_object('id', v_pa_late_item, 'product_id', v_pa, 'calc_mode', 'units_direct', 'total_units_needed', 200, 'price_per_unit', 10, 'current_cost', 6, 'sort_order', 0))));
  SELECT (to_jsonb(q)->>'row_version')::bigint
  INTO v_quote_version
  FROM quotes q
  WHERE q.id = v_q;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_quote_version);
  v_res := save_quote(v_q, v_payload, v_sections, v_admin, NULL);
  IF v_res->>'status' IS DISTINCT FROM 'saved' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) save_quote returned %', v_res;
  END IF;
  SELECT qi.id INTO STRICT v_pa_early_item FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  WHERE qi.quote_id = v_q AND qs.section_name = 'Early' AND qi.product_id = v_pa;
  SELECT qi.id INTO STRICT v_pa_late_item FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  WHERE qi.quote_id = v_q AND qs.section_name = 'Late' AND qi.product_id = v_pa;
  SELECT qi.id INTO STRICT v_pb_early_item FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  WHERE qi.quote_id = v_q AND qs.section_name = 'Early' AND qi.product_id = v_pb;
  v_sections := jsonb_set(
    jsonb_set(
      jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_pa_early_item)),
      '{0,items,1,id}', to_jsonb(v_pb_early_item)
    ),
    '{1,items,0,id}', to_jsonb(v_pa_late_item)
  );
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0),
         COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pb), 0)
  INTO v_pa_total, v_pb_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 150 OR v_pb_total <> 100 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) after save holds pa=% pb=% (expected 150/100)', v_pa_total, v_pb_total;
  END IF;

  -- (e) restore_quote_version on a drawn booking is now refused before any
  -- child or hold mutation. Ordinary save above remains the supported revision
  -- path and has already proven the 450 - 250 = 200 invariant.
  PERFORM pg_temp.create_quote_version_smoke(
    v_q,
    v_admin,
    'presented',
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
  );
  SELECT id INTO v_ver FROM quote_versions WHERE quote_id = v_q ORDER BY version_number DESC LIMIT 1;
  v_sections := jsonb_set(v_sections, '{1,items,0,total_units_needed}', to_jsonb(250));
  SELECT (to_jsonb(q)->>'row_version')::bigint
  INTO v_quote_version
  FROM quotes q
  WHERE q.id = v_q;
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_quote_version);
  v_res := save_quote(v_q, v_payload, v_sections, v_admin, NULL);
  SELECT qi.id INTO STRICT v_pa_early_item FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  WHERE qi.quote_id = v_q AND qs.section_name = 'Early' AND qi.product_id = v_pa;
  SELECT qi.id INTO STRICT v_pa_late_item FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  WHERE qi.quote_id = v_q AND qs.section_name = 'Late' AND qi.product_id = v_pa;
  SELECT qi.id INTO STRICT v_pb_early_item FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  WHERE qi.quote_id = v_q AND qs.section_name = 'Early' AND qi.product_id = v_pb;
  v_sections := jsonb_set(
    jsonb_set(
      jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_pa_early_item)),
      '{0,items,1,id}', to_jsonb(v_pb_early_item)
    ),
    '{1,items,0,id}', to_jsonb(v_pa_late_item)
  );
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0) INTO v_pa_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e-pre) after rebook 450 holds pa=% (expected 200)', v_pa_total;
  END IF;
  v_err := NULL;
  BEGIN
    v_res := pg_temp.restore_quote_version_smoke(
      v_q, v_ver, v_admin, NULL,
      (SELECT (to_jsonb(q)->>'row_version')::bigint FROM public.quotes q WHERE q.id = v_q)
    );
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  IF v_err IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) restore of a drawn booking was allowed: %', v_res;
  END IF;
  IF v_err NOT LIKE 'QUOTE_RESTORE_BLOCKED_BY_DRAW%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) restore refused with the wrong error: %', v_err;
  END IF;
  SELECT COALESCE(SUM(quantity) FILTER (WHERE product_id = v_pa), 0) INTO v_pa_total
  FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_pa_total <> 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (e) refused restore changed holds pa=% (expected 200)', v_pa_total;
  END IF;

  -- (f) plan switched off: save_quote releases everything transactionally.
  UPDATE quotes SET is_planned = false WHERE id = v_q;
  SELECT (to_jsonb(q)->>'row_version')::bigint
  INTO v_quote_version
  FROM quotes q
  WHERE q.id = v_q;
  v_payload := v_payload || jsonb_build_object('status', 'revised', 'row_version_expected', v_quote_version);
  v_res := save_quote(v_q, v_payload, v_sections, v_admin, NULL);
  SELECT count(*) INTO v_cnt FROM inventory_holds WHERE source_id = v_q AND is_active = true;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (f) unplanned quote still has % active holds', v_cnt;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
