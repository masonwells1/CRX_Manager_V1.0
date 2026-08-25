-- idempotency-body-check: exempt
-- ============================================================================
-- Repair the exact 35 historical order lines whose numeric-dollar total_price
-- still carries fractions of a cent, then make the whole-cent rule a validated
-- database constraint.
--
-- Mason approved this live-data correction in chat on 2026-08-12 after a fresh
-- read-only measurement showed:
--   * 35 lines across 16 orders;
--   * aggregate raw line rounding delta +$0.0863;
--   * two order headers increase by $0.01 each;
--   * one order header profit decreases by $0.01;
--   * no posted/overdue/paid invoice amount changes (the only linked invoice
--     line is draft and already equals the rounded line value).
--
-- The full approved preimage is bound twice:
--   1. an explicit 35-row identity/order/value/profit map; and
--   2. a SHA-256 digest over every line on the 16 affected orders plus all 16
--      order headers. A concurrent or intervening edit therefore fails closed.
--
-- A schema-only rebuild may have zero order_items and takes the no-op path
-- before the constraint is installed. Any populated database that does not
-- contain the exact approved preimage raises APPROVED_SET_DRIFTED.
--
-- APPROVED_SET_DIGEST: 0f8ccef3bf6d3291c654d5abb24a151e16ad759851f5eddfc65d1585d7f5b7db
-- Rollback: the apply is one transaction. Pre-commit/pre-apply proof executes
-- it inside a transaction that ends in ROLLBACK. After a successful live apply,
-- roll forward from the exact map below; restoring fractional cents would
-- deliberately violate the new constraint and reintroduce the defect.
-- ============================================================================

-- The rounding trigger updates orders from order_items. Lock in that same order
-- so measurement, repair, header recomputation, and constraint validation see
-- one stable preimage.
LOCK TABLE public.order_items, public.orders IN ACCESS EXCLUSIVE MODE;

DO $approved_repair$
DECLARE
  v_approved jsonb := $approved_rows$
  [
    {"id":"00684521-e88b-4366-a0d8-3e868aefddb7","order_id":"709c4e24-47dc-4985-a6ac-b5cf6efe2b7c","old_total_price":"537.6753","new_total_price":"537.68","old_profit":"189.41"},
    {"id":"14dff95d-8c99-40d6-bf76-8912553d467b","order_id":"2e56bd1c-9f8e-49aa-8c5d-bca7ac7a16b4","old_total_price":"4164.225","new_total_price":"4164.23","old_profit":"1332.500"},
    {"id":"15ad141f-7b33-4047-bc39-f8d59e20ed8f","order_id":"2e56bd1c-9f8e-49aa-8c5d-bca7ac7a16b4","old_total_price":"5332.375","new_total_price":"5332.38","old_profit":"358.88"},
    {"id":"1af9c3e0-fe4d-4aba-913f-2ea04891d150","order_id":"2ef58bcc-3be7-4f47-bc9f-5f956dcd365e","old_total_price":"11126.6907","new_total_price":"11126.69","old_profit":"1109.37"},
    {"id":"20eede22-be78-42f7-852b-d2312f9c1834","order_id":"575211e2-41c8-479b-bcd6-3380e471b98f","old_total_price":"963.164","new_total_price":"963.16","old_profit":"160.32"},
    {"id":"2f30708e-4f50-45a1-9a0b-498adc11be8b","order_id":"5c26d0a8-f7d9-4945-b864-43525a17c73e","old_total_price":"26507.325","new_total_price":"26507.33","old_profit":"2276.950"},
    {"id":"5b6b75d5-7bec-4f27-8c63-dab08cf08568","order_id":"606a06c1-7014-4a17-a6a0-b32b7ec0859c","old_total_price":"550.125","new_total_price":"550.13","old_profit":"60.53"},
    {"id":"764e87cf-7b16-4ab2-875b-2421e6885808","order_id":"2ef58bcc-3be7-4f47-bc9f-5f956dcd365e","old_total_price":"1946.6465","new_total_price":"1946.65","old_profit":"280.1300"},
    {"id":"8d415ecd-c452-4c88-a6de-17d03f516352","order_id":"071275a3-7a7e-470c-852b-1ebab59fc4d8","old_total_price":"330.875","new_total_price":"330.88","old_profit":"71.000"},
    {"id":"8f129241-84b4-4652-a309-ab2023552923","order_id":"b947ca2e-6fdc-4440-b11f-8dae896bdb9e","old_total_price":"1233.2664","new_total_price":"1233.27","old_profit":"135.72"},
    {"id":"91abc74d-c400-4e4e-8235-ebf3b51de611","order_id":"b947ca2e-6fdc-4440-b11f-8dae896bdb9e","old_total_price":"2099.9568","new_total_price":"2099.96","old_profit":"252.02"},
    {"id":"95754d56-d794-4be7-a44c-f3b4765fbfb4","order_id":"b947ca2e-6fdc-4440-b11f-8dae896bdb9e","old_total_price":"636.9258","new_total_price":"636.93","old_profit":"127.32"},
    {"id":"97682e29-2765-460b-8a8c-11b3e72d0357","order_id":"54a398ed-8cb0-4ed2-bd7a-053624330004","old_total_price":"330.875","new_total_price":"330.88","old_profit":"71.000"},
    {"id":"a2338776-a195-41ec-87fe-088fea23e66c","order_id":"90270ce1-9252-426d-914f-0e7587f2aa04","old_total_price":"4386.375","new_total_price":"4386.38","old_profit":"526.58"},
    {"id":"a4d73a76-cf5c-4edf-a91d-0000159fd23d","order_id":"105d683a-cec1-4590-8946-c603b1fe44d7","old_total_price":"5818.394","new_total_price":"5818.39","old_profit":"1101.09"},
    {"id":"aab3cb34-b88b-4239-9439-57d14d8ec925","order_id":"606a06c1-7014-4a17-a6a0-b32b7ec0859c","old_total_price":"229.628","new_total_price":"229.63","old_profit":"45.90"},
    {"id":"ab44126c-ead2-4a52-bd06-270343f0c32d","order_id":"f25e78dd-faa7-4f58-b030-9fd894a68b50","old_total_price":"1131.375","new_total_price":"1131.38","old_profit":"158.38"},
    {"id":"aec4d1de-677d-4b43-bb54-45a6ec17614f","order_id":"f25e78dd-faa7-4f58-b030-9fd894a68b50","old_total_price":"817.278","new_total_price":"817.28","old_profit":"122.50"},
    {"id":"b1833117-6b15-468a-b386-6166e45e22aa","order_id":"2e56bd1c-9f8e-49aa-8c5d-bca7ac7a16b4","old_total_price":"1389.675","new_total_price":"1389.68","old_profit":"298.200"},
    {"id":"b3169ac5-6fc3-48e0-8f93-3cf0ec200cd3","order_id":"32a52b9b-2270-4e59-b2a1-24389856255f","old_total_price":"1175.625","new_total_price":"1175.63","old_profit":"282.500"},
    {"id":"b674a893-eb3a-4c8c-a9c1-02d2fc227194","order_id":"606a06c1-7014-4a17-a6a0-b32b7ec0859c","old_total_price":"2640.708","new_total_price":"2640.71","old_profit":"308.700"},
    {"id":"c4545ad8-27cb-4e6d-a203-89cc3eda3c82","order_id":"32a52b9b-2270-4e59-b2a1-24389856255f","old_total_price":"270.712","new_total_price":"270.71","old_profit":"73.16"},
    {"id":"cd06d843-6ba6-42e7-8685-2735a2142376","order_id":"709c4e24-47dc-4985-a6ac-b5cf6efe2b7c","old_total_price":"588.2352","new_total_price":"588.24","old_profit":"88.17"},
    {"id":"cd75ac58-61fc-43de-9af2-6f440d2a031c","order_id":"709c4e24-47dc-4985-a6ac-b5cf6efe2b7c","old_total_price":"714.6708","new_total_price":"714.67","old_profit":"118.96"},
    {"id":"ce92eea9-77ce-4313-8d7d-a575f114271d","order_id":"606a06c1-7014-4a17-a6a0-b32b7ec0859c","old_total_price":"1106.028","new_total_price":"1106.03","old_profit":"265.78"},
    {"id":"d8fb47d1-02ba-4bdc-ac22-6fd53298341b","order_id":"32a52b9b-2270-4e59-b2a1-24389856255f","old_total_price":"596.891","new_total_price":"596.89","old_profit":"189.99"},
    {"id":"de914d64-582c-417f-aab5-995681ef4f84","order_id":"105d683a-cec1-4590-8946-c603b1fe44d7","old_total_price":"4870.125","new_total_price":"4870.13","old_profit":"1076.400"},
    {"id":"df65fe1c-c057-4b31-84ed-573393ae740d","order_id":"a7d13875-e415-4689-ba2d-8a804cdd1333","old_total_price":"3554.582","new_total_price":"3554.58","old_profit":"782.05"},
    {"id":"e5992c90-d637-46d7-9bd9-7a93578ec424","order_id":"002579ab-feb7-4a47-93c5-4c83251e160e","old_total_price":"6138.925","new_total_price":"6138.93","old_profit":"1105.000"},
    {"id":"ea7d7d3a-f2fb-4f31-8a36-29979504fe48","order_id":"575211e2-41c8-479b-bcd6-3380e471b98f","old_total_price":"1625.6952","new_total_price":"1625.70","old_profit":"292.62"},
    {"id":"eb0b61ee-bcf5-4af4-8312-951b0c2903ab","order_id":"f25e78dd-faa7-4f58-b030-9fd894a68b50","old_total_price":"1605.565","new_total_price":"1605.57","old_profit":"289.000"},
    {"id":"ecb2a79e-ead2-47d0-b759-a5e5f6b9f61f","order_id":"b947ca2e-6fdc-4440-b11f-8dae896bdb9e","old_total_price":"1651.241","new_total_price":"1651.24","old_profit":"237.620"},
    {"id":"f264a5b4-90ae-4bdd-a187-48d1404badbd","order_id":"105d683a-cec1-4590-8946-c603b1fe44d7","old_total_price":"12796.875","new_total_price":"12796.88","old_profit":"2559.38"},
    {"id":"f83425e9-3ec0-4fcf-871a-e8e314908a9d","order_id":"dba56e65-e6f5-44a7-a043-381281011e18","old_total_price":"1179.9510","new_total_price":"1179.95","old_profit":"118.31"},
    {"id":"fd5769e4-0d89-474a-af40-dd9737030daf","order_id":"f25e78dd-faa7-4f58-b030-9fd894a68b50","old_total_price":"709.404","new_total_price":"709.40","old_profit":"225.80"}
  ]
  $approved_rows$::jsonb;
  v_dirty_count integer;
  v_impacted_order_count integer;
  v_impacted_line_count integer;
  v_mapping_mismatches integer;
  v_extra_dirty integer;
  v_snapshot_digest text;
  v_profit_change_count integer;
  v_header_price_change_count integer;
  v_header_profit_change_count integer;
  v_header_price_delta numeric;
  v_header_profit_delta numeric;
  v_updated integer;
  v_post_failures integer;
BEGIN
  SELECT count(*)
    INTO v_dirty_count
    FROM public.order_items AS oi
   WHERE oi.total_price IS NOT NULL
     AND oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2);

  IF v_dirty_count = 0 THEN
    IF EXISTS (SELECT 1 FROM public.order_items) THEN
      RAISE EXCEPTION
        'APPROVED_SET_DRIFTED: populated database has no approved fractional-cent preimage; refuse to record the repair as a no-op';
    END IF;
    RAISE NOTICE 'HISTORICAL_ORDER_LINE_CENTS_EMPTY_REBUILD: no business rows to repair';
    RETURN;
  END IF;

  WITH approved AS (
    SELECT *
      FROM jsonb_to_recordset(v_approved) AS a(
        id uuid,
        order_id uuid,
        old_total_price numeric,
        new_total_price numeric,
        old_profit numeric
      )
  )
  SELECT count(*) FILTER (
           WHERE oi.id IS NULL
              OR oi.order_id IS DISTINCT FROM a.order_id
              OR oi.total_price IS DISTINCT FROM a.old_total_price
              OR ROUND(oi.total_price, 2) IS DISTINCT FROM a.new_total_price
              OR oi.profit IS DISTINCT FROM a.old_profit
         ),
         count(DISTINCT a.order_id)
    INTO v_mapping_mismatches, v_impacted_order_count
    FROM approved AS a
    LEFT JOIN public.order_items AS oi ON oi.id = a.id;

  WITH approved AS (
    SELECT id
      FROM jsonb_to_recordset(v_approved) AS a(id uuid)
  )
  SELECT count(*)
    INTO v_extra_dirty
    FROM public.order_items AS oi
   WHERE oi.total_price IS NOT NULL
     AND oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2)
     AND NOT EXISTS (SELECT 1 FROM approved AS a WHERE a.id = oi.id);

  WITH approved_orders AS (
    SELECT DISTINCT order_id
      FROM jsonb_to_recordset(v_approved) AS a(order_id uuid)
  )
  SELECT count(*)
    INTO v_impacted_line_count
    FROM public.order_items AS oi
    JOIN approved_orders AS a ON a.order_id = oi.order_id;

  WITH approved_orders AS (
    SELECT DISTINCT order_id
      FROM jsonb_to_recordset(v_approved) AS a(order_id uuid)
  ), snapshot_rows AS (
    SELECT 'L'::text AS row_kind,
           oi.id,
           oi.order_id,
           NULL::text AS status,
           oi.total_price,
           oi.profit,
           oi.cost_per_unit,
           oi.total_units_needed,
           NULL::numeric AS total_cost,
           NULL::numeric AS total_profit,
           NULL::numeric AS total_margin_pct
      FROM public.order_items AS oi
      JOIN approved_orders AS a ON a.order_id = oi.order_id
    UNION ALL
    SELECT 'O'::text,
           o.id,
           NULL::uuid,
           o.status,
           o.total_price,
           NULL::numeric,
           NULL::numeric,
           NULL::numeric,
           o.total_cost,
           o.total_profit,
           o.total_margin_pct
      FROM public.orders AS o
      JOIN approved_orders AS a ON a.order_id = o.id
  )
  SELECT encode(
           extensions.digest(
             COALESCE(
               string_agg(
                 CASE row_kind
                   WHEN 'L' THEN
                     'L|' || id::text || '|' || order_id::text || '|'
                     || COALESCE(total_price::text, '<NULL>') || '|'
                     || COALESCE(profit::text, '<NULL>') || '|'
                     || COALESCE(cost_per_unit::text, '<NULL>') || '|'
                     || COALESCE(total_units_needed::text, '<NULL>')
                   ELSE
                     'O|' || id::text || '|' || COALESCE(status, '<NULL>') || '|'
                     || COALESCE(total_price::text, '<NULL>') || '|'
                     || COALESCE(total_cost::text, '<NULL>') || '|'
                     || COALESCE(total_profit::text, '<NULL>') || '|'
                     || COALESCE(total_margin_pct::text, '<NULL>')
                 END,
                 E'\n' ORDER BY row_kind, id
               ),
               ''
             ),
             'sha256'
           ),
           'hex'
         )
    INTO v_snapshot_digest
    FROM snapshot_rows;

  IF jsonb_array_length(v_approved) <> 35
     OR v_dirty_count <> 35
     OR v_impacted_order_count <> 16
     OR v_impacted_line_count <> 151
     OR v_mapping_mismatches <> 0
     OR v_extra_dirty <> 0
     OR v_snapshot_digest IS DISTINCT FROM '0f8ccef3bf6d3291c654d5abb24a151e16ad759851f5eddfc65d1585d7f5b7db' THEN
    RAISE EXCEPTION
      'APPROVED_SET_DRIFTED: expected 35 mapped rows / 16 orders / 151 order lines / zero mismatches / zero extra dirty rows / digest 0f8ccef3..., got % / % / % / % / % / %. Re-measure and obtain fresh approval.',
      v_dirty_count,
      v_impacted_order_count,
      v_impacted_line_count,
      v_mapping_mismatches,
      v_extra_dirty,
      v_snapshot_digest;
  END IF;

  WITH approved AS (
    SELECT id
      FROM jsonb_to_recordset(v_approved) AS a(id uuid)
  )
  SELECT count(*)
    INTO v_profit_change_count
    FROM public.order_items AS oi
    JOIN approved AS a ON a.id = oi.id
   WHERE oi.profit IS DISTINCT FROM
         (ROUND(oi.total_price, 2)
          - ROUND(COALESCE(oi.cost_per_unit, 0)
                  * COALESCE(oi.total_units_needed, 0), 2));

  WITH approved_orders AS (
    SELECT DISTINCT order_id
      FROM jsonb_to_recordset(v_approved) AS a(order_id uuid)
  ), projected AS (
    SELECT o.id,
           o.total_price,
           o.total_profit,
           SUM(ROUND(oi.total_price, 2)) AS projected_total_price,
           SUM(ROUND(oi.total_price, 2)
               - ROUND(COALESCE(oi.cost_per_unit, 0)
                       * COALESCE(oi.total_units_needed, 0), 2)) AS projected_total_profit
      FROM public.orders AS o
      JOIN approved_orders AS a ON a.order_id = o.id
      JOIN public.order_items AS oi ON oi.order_id = o.id
     GROUP BY o.id, o.total_price, o.total_profit
  )
  SELECT count(*) FILTER (
           WHERE total_price IS DISTINCT FROM projected_total_price
         ),
         count(*) FILTER (
           WHERE total_profit IS DISTINCT FROM projected_total_profit
         ),
         SUM(projected_total_price - total_price),
         SUM(projected_total_profit - total_profit)
    INTO v_header_price_change_count,
         v_header_profit_change_count,
         v_header_price_delta,
         v_header_profit_delta
    FROM projected;

  IF v_profit_change_count <> 0
     OR v_header_price_change_count <> 2
     OR v_header_profit_change_count <> 1
     OR v_header_price_delta IS DISTINCT FROM 0.02::numeric
     OR v_header_profit_delta IS DISTINCT FROM (-0.01)::numeric THEN
    RAISE EXCEPTION
      'APPROVED_IMPACT_DRIFTED: expected 0 line-profit changes / 2 header-price changes / 1 header-profit change / +0.02 price / -0.01 profit, got % / % / % / % / %',
      v_profit_change_count,
      v_header_price_change_count,
      v_header_profit_change_count,
      v_header_price_delta,
      v_header_profit_delta;
  END IF;

  WITH approved AS (
    SELECT *
      FROM jsonb_to_recordset(v_approved) AS a(
        id uuid,
        old_total_price numeric,
        new_total_price numeric,
        old_profit numeric
      )
  )
  UPDATE public.order_items AS oi
     SET total_price = a.new_total_price
    FROM approved AS a
   WHERE oi.id = a.id
     AND oi.total_price IS NOT DISTINCT FROM a.old_total_price
     AND oi.profit IS NOT DISTINCT FROM a.old_profit;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 35 THEN
    RAISE EXCEPTION
      'APPROVED_REPAIR_INCOMPLETE: expected 35 updated rows, got %',
      v_updated;
  END IF;

  WITH approved AS (
    SELECT *
      FROM jsonb_to_recordset(v_approved) AS a(
        id uuid,
        new_total_price numeric,
        old_profit numeric
      )
  )
  SELECT count(*)
    INTO v_mapping_mismatches
    FROM approved AS a
    LEFT JOIN public.order_items AS oi ON oi.id = a.id
   WHERE oi.id IS NULL
      OR oi.total_price IS DISTINCT FROM a.new_total_price
      OR oi.profit IS DISTINCT FROM a.old_profit;

  IF v_mapping_mismatches <> 0 THEN
    RAISE EXCEPTION
      'APPROVED_REPAIR_POSTIMAGE_MISMATCH: % mapped row(s) differ from the approved new price/profit',
      v_mapping_mismatches;
  END IF;

  WITH approved_orders AS (
    SELECT DISTINCT order_id
      FROM jsonb_to_recordset(v_approved) AS a(order_id uuid)
  ), expected AS (
    SELECT o.id,
           SUM(ROUND(oi.total_price, 2)) AS total_price,
           SUM(ROUND(COALESCE(oi.cost_per_unit, 0)
                     * COALESCE(oi.total_units_needed, 0), 2)) AS total_cost
      FROM public.orders AS o
      JOIN approved_orders AS a ON a.order_id = o.id
      JOIN public.order_items AS oi ON oi.order_id = o.id
     GROUP BY o.id
  )
  SELECT
    (SELECT count(*)
       FROM public.order_items AS oi
      WHERE oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2)
         OR NOT (oi.total_price > '-Infinity'::numeric
                  AND oi.total_price < 'Infinity'::numeric))
    +
    (SELECT count(*)
       FROM public.orders AS o
       JOIN expected AS e ON e.id = o.id
      WHERE o.total_price IS DISTINCT FROM ROUND(e.total_price, 2)
         OR o.total_cost IS DISTINCT FROM ROUND(e.total_cost, 2)
         OR o.total_profit IS DISTINCT FROM
            ROUND(e.total_price - e.total_cost, 2))
    INTO v_post_failures;

  IF v_post_failures <> 0 THEN
    RAISE EXCEPTION
      'HISTORICAL_CENT_REPAIR_POSTCONDITION_FAILED: % line/header violation(s) remain',
      v_post_failures;
  END IF;
END
$approved_repair$;

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_total_price_whole_cents_chk
  CHECK (
    total_price = ROUND(total_price, 2)
    AND total_price > '-Infinity'::numeric
    AND total_price < 'Infinity'::numeric
  );

DO $postcondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS c
     WHERE c.conrelid = 'public.order_items'::regclass
       AND c.conname = 'order_items_total_price_whole_cents_chk'
       AND c.contype = 'c'
       AND c.convalidated
  ) THEN
    RAISE EXCEPTION
      'POSTCOND: validated order_items_total_price_whole_cents_chk is missing';
  END IF;
END
$postcondition$;
