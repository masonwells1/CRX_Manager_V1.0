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
-- The applied payload bound the full approved preimage twice:
--   1. an explicit 35-row identity/order/value/profit map; and
--   2. a SHA-256 digest over every line on the 16 affected orders plus all 16
--      order headers. A concurrent or intervening edit therefore failed closed.
--
-- A database with no fractional-cent order lines takes the no-op path before
-- the constraint is installed. A populated replay with dirty lines derives its
-- candidate set under the table lock and must match the exact approved digest,
-- counts, sibling rows, headers, and financial impact before any write occurs.
--
-- APPROVED_SET_DIGEST: 0f8ccef3bf6d3291c654d5abb24a151e16ad759851f5eddfc65d1585d7f5b7db
-- APPLIED_LEDGER_VERSION: 20260812154757
-- APPLIED_PAYLOAD_SHA256: 7498b0befab4cd6355560cf9dc29c270a3e0098d2327d24d7eb7ab13d0d927ca
-- PUBLIC RECOVERY REPLAY — NOT A MIGRATION LEDGER SOURCE:
-- Unlike the other five migrations recovered alongside it,
-- this file is NOT byte-identical to the payload that was applied. The applied
-- 35-row preimage map remains in the access-controlled applying-session record
-- because it contains live order-line identifiers, prices and profit. This
-- recovery replay derives that same candidate set from every dirty line,
-- then uses the applied payload's fixed digest/count/impact checks to prove the
-- exact preimage before writing. It therefore remains disaster-recovery capable
-- without publishing customer-linked financial data.
-- Rollback: the apply is one transaction. Pre-commit/pre-apply proof executes
-- it inside a transaction that ends in ROLLBACK. After a successful live apply,
-- roll forward from the private applied payload or this digest-bound public
-- replay path; restoring fractional cents would
-- deliberately violate the new constraint and reintroduce the defect.
-- ============================================================================

-- The rounding trigger updates orders from order_items. Lock in that same order
-- so measurement, repair, header recomputation, and constraint validation see
-- one stable preimage.
LOCK TABLE public.order_items, public.orders IN ACCESS EXCLUSIVE MODE;

DO $approved_repair$
DECLARE
  v_approved jsonb;
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
    RAISE NOTICE 'HISTORICAL_ORDER_LINE_CENTS_ALREADY_CLEAN: no business rows to repair';
    RETURN;
  END IF;

  -- The original applied payload embedded these rows explicitly. The public
  -- recovery source derives them under ACCESS EXCLUSIVE lock so identifiers and
  -- values need not be published. The fixed full-snapshot digest and impact
  -- assertions below still make any different population fail closed.
  SELECT jsonb_agg(
           jsonb_build_object(
             'id', oi.id,
             'order_id', oi.order_id,
             'old_total_price', oi.total_price,
             'new_total_price', ROUND(oi.total_price, 2),
             'old_profit', oi.profit
           ) ORDER BY oi.id
         )
    INTO v_approved
    FROM public.order_items AS oi
   WHERE oi.total_price IS NOT NULL
     AND oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2);

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

DO $constraint$
DECLARE
  v_found_def text;
  v_expected_def constant text :=
    'CHECK (total_price = ROUND(total_price, 2) AND total_price > ''-Infinity''::numeric AND total_price < ''Infinity''::numeric)';
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_found_def
    FROM pg_constraint AS c
   WHERE c.conrelid = 'public.order_items'::regclass
     AND c.conname = 'order_items_total_price_whole_cents_chk';

  IF v_found_def IS NULL THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_total_price_whole_cents_chk
      CHECK (
        total_price = ROUND(total_price, 2)
        AND total_price > '-Infinity'::numeric
        AND total_price < 'Infinity'::numeric
      );
  ELSIF regexp_replace(lower(v_found_def), '[[:space:]()]', '', 'g')
        IS DISTINCT FROM regexp_replace(lower(v_expected_def), '[[:space:]()]', '', 'g') THEN
    RAISE EXCEPTION
      'PRECOND: existing order_items_total_price_whole_cents_chk differs from the reviewed definition. Found: %',
      v_found_def;
  END IF;
END
$constraint$;

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
