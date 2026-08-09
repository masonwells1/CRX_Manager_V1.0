-- ============================================================================
-- Return credit COGS reversal (defect fix, prospective only)
--
-- WHAT: Redefines public._issue_return_credit_impl (the service_role-only
-- private implementation behind the public issue_return_credit wrapper) so
-- that issuing a return credit also writes credit-memo LINE ITEMS carrying
-- the cost of the returned goods, and stamps the credit-memo invoice's
-- total_cost_cents.
--
-- WHY (defect): until now, crediting a return reversed REVENUE (the credit
-- memo header was inserted with total_amount_cents = -credit) but never
-- reversed COGS — the credit memo had no invoice_items rows and
-- total_cost_cents stayed 0. Profit reports therefore overstated cost (and
-- understated margin) for any period containing a credited return: the
-- original sale's cost stayed fully counted even though the goods came back.
--
-- SIGN CONVENTION: each credit-memo line is written with NEGATIVE quantity
-- (-ri.quantity), positive per-unit unit_price_cents and cost_cents, and
-- negative extended_cents. This is deliberate: the INVOICE-basis COGS
-- aggregates (get_bottom_line_pnl, get_monthly_summary — the rollups that
-- SUM(cost_cents * quantity) over invoice_items) then self-correct with NO
-- report changes — the negative quantity times the positive per-unit cost
-- yields a negative COGS contribution that offsets the original sale's cost.
-- SCOPE: this reversal reaches ONLY invoice-basis reporting. The order-basis
-- report RPCs rewritten by sibling migration 20260808170100 never read
-- invoices/invoice_items and exclude returns by design; they are unaffected.
--
-- PER-UNIT COST SOURCE (best available, in order):
--   1. the cost_cents snapshot on the ORIGINAL sale invoice line, resolved by
--      order_item_id AND product_id over POSTED, non-credit-memo, non-deleted
--      invoices,
--   2. order_items.cost_at_time_cents — the order line's own immutable snapshot,
--      the canonical basis of sibling migration 20260808170100,
--   3. ROUND(order_items.cost_per_unit * 100)::bigint — mutable legacy dollars,
--   4. 0 — legacy return_items with no order_item link get zero cost
--      (revenue still reverses; cost reversal is simply unknown).
--
-- QUANTITY CAP: COGS is reversed only for
--   LEAST(returned, posted invoiced − already reversed by earlier credits),
-- never for more. create_return caps returns against DELIVERED quantity, which
-- on a part-invoiced order line can exceed what any posted invoice carries; and
-- the posted quantity is a budget spent across ALL credits against that line,
-- not a fresh allowance per return. Exceeding either subtracts cost the reports
-- never counted, which inflates profit.
--
-- Each return item therefore becomes up to TWO credit-memo rows: a cost-bearing
-- row for the allowed quantity and a zero-cost row for the remainder. Revenue is
-- split exactly between them, so the customer is still credited in full.
-- Splitting rather than scaling the per-unit cost is deliberate — cost_cents is
-- an integer the rollups multiply by the row's full quantity, so a scaled unit
-- cost cannot represent a capped total exactly (1 posted unit at 100c over 6
-- returned units → ROUND(100/6) = 17, and 17 × 6 = 102c). Two rows are exact by
-- construction. Concurrent credits against one order line are serialized by
-- locking the order_items rows before the allocation reads prior reversals.
--
-- PROSPECTIVE ONLY: no backfill of historically credited returns — explicitly
-- out of scope per docs/plans/2026-07-16-inventory-costing-plan.md non-goals.
--
-- CONSTRAINT SAFETY (verified against all migrations, latest wins):
--   * invoice_items has NO CHECK constraint on quantity, extended_cents, or
--     cost_cents (only chk_invoice_items_price_source, untouched here), so
--     negative-quantity lines need no relaxation.
--   * invoices_total_non_negative / invoices_balance_non_negative already
--     exempt invoice_type='credit_memo' (20260609130744), and
--     invoices.total_cost_cents carries no CHECK constraint, so a negative
--     total_cost_cents on a credit memo is accepted.
--   * balance_cents is GENERATED and is never written here;
--     total_cost_cents is a plain bigint column (see 20260716120104 which
--     already UPDATEs it directly).
--
-- The public wrapper issue_return_credit(uuid, uuid, text) from
-- 20260723193312 is NOT changed; it continues to delegate here after source
-- verification and Phase 3 policy checks. Signature, SECURITY DEFINER,
-- search_path, grants, and idempotency behavior are preserved exactly.
--
-- ADDITIVE OUTPUT: new_values on the two financial_audit_log rows and the
-- returned jsonb gain a 'cogs_reversed_cents' key (positive = amount of COGS
-- removed from the books). All existing keys are unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._issue_return_credit_impl(p_return_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_return record;
  v_total bigint;
  v_invoice_id uuid;
  v_invoice_num text;
  v_customer_id uuid;
  v_order_id uuid;
  v_return_number text;
  v_salesman_id uuid;
  v_cached jsonb;
  v_result jsonb;
  v_credit_cogs_cents bigint;   -- SUM(cost_cents * quantity) on the credit memo: <= 0
  v_cogs_reversed_cents bigint; -- positive magnitude of COGS reversed
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT r.id, r.status, r.customer_id, r.order_id, r.return_number
    INTO v_return
    FROM returns r
   WHERE r.id = p_return_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND'; END IF;
  IF v_return.status <> 'received' THEN RAISE EXCEPTION 'INVALID_RETURN_STATUS: %', v_return.status; END IF;

  v_customer_id := v_return.customer_id;
  v_order_id := v_return.order_id;
  v_return_number := v_return.return_number;

  PERFORM check_period_open(CURRENT_DATE);

  SELECT COALESCE(SUM(ri.extended_cents), 0)
    INTO v_total
    FROM return_items ri
   WHERE ri.return_id = p_return_id;

  IF v_total <= 0 THEN RAISE EXCEPTION 'RETURN_CREDIT_EMPTY'; END IF;

  v_invoice_num := next_invoice_number('credit_memo');

  IF v_order_id IS NOT NULL THEN
    SELECT o.salesman_id INTO v_salesman_id
      FROM orders o
     WHERE o.id = v_order_id;
  END IF;

  INSERT INTO invoices (
    invoice_number, order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, paid_amount_cents,
    prepay_applied_cents, posted_by, posted_at, invoice_date, due_date,
    header_notes, parent_invoice_id
  ) VALUES (
    v_invoice_num, v_order_id, v_customer_id, 'credit_memo', 'posted', current_season(),
    v_salesman_id, v_actor, -v_total, 0, 0, v_actor, now(),
    CURRENT_DATE, CURRENT_DATE,
    'Credit memo for return ' || v_return_number, NULL
  )
  RETURNING id INTO v_invoice_id;

  -- Serialize credits that touch the same order line. Two returns against one
  -- partly invoiced line must not each reverse the full posted quantity, so the
  -- allocation below reads what earlier credit memos already reversed -- and a
  -- concurrent credit could otherwise read the same "already reversed" value
  -- and double-spend the cap. Locking the order_items rows in id order (the
  -- returns row itself is already locked above) makes the read-then-allocate
  -- atomic. (Codex round 40.)
  PERFORM 1
     FROM order_items
    WHERE id IN (
            SELECT ri.order_item_id
              FROM return_items ri
             WHERE ri.return_id = p_return_id
               AND ri.order_item_id IS NOT NULL
          )
    ORDER BY id
      FOR UPDATE;

  -- Credit-memo lines. Each return item becomes up to TWO rows: a cost-bearing
  -- row for the quantity whose COGS may legitimately be reversed, and a
  -- zero-cost row for the remainder. Revenue is credited in full across the two
  -- (the customer gets back everything they returned); only cost is limited.
  --
  -- Splitting rather than scaling the per-unit cost is deliberate. cost_cents is
  -- an integer per-unit value that the rollups multiply by the row's full
  -- quantity, so a scaled unit cost cannot represent a capped total exactly --
  -- 1 posted unit at 100 cents spread over 6 returned units gives ROUND(100/6)
  -- = 17, and 17 x 6 = 102 cents reversed instead of 100. Two rows make the
  -- arithmetic exact by construction. (Codex round 40.)
  WITH src AS (
    SELECT
      ri.id, ri.order_item_id, ri.product_id, ri.product_name, ri.quantity,
      ri.unit_price_cents, ri.extended_cents, ri.unit, ri.sort_order,
      ri.restocked,
      oi.cost_at_time_cents,
      oi.cost_per_unit,
      COALESCE(posted.posted_qty, 0) AS posted_qty,
      posted.line_cost_cents,
      COALESCE(prior.reversed_qty, 0) AS reversed_qty
    FROM return_items ri
    LEFT JOIN order_items oi ON oi.id = ri.order_item_id
    -- One resolution of the original sale line: eligibility, per-unit cost and
    -- the quantity cap all come from here, so they cannot be decided from
    -- different rows. product_id is matched as well as order_item_id, because
    -- update_order_items may swap an order line's product after invoicing and
    -- leave a historical line under the same id carrying the OLD product.
    -- 'posted' only -- the intersection of what the two invoice-basis reports
    -- count (get_bottom_line_pnl counts 'posted' alone; get_monthly_summary
    -- counts 'posted' and 'overdue'). Reversing against anything they did not
    -- count inflates profit.
    LEFT JOIN LATERAL (
      SELECT
        SUM(ii.quantity) AS posted_qty,
        (ARRAY_AGG(ii.cost_cents ORDER BY ii.created_at, ii.id))[1] AS line_cost_cents
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      WHERE ri.order_item_id IS NOT NULL
        AND ii.order_item_id = ri.order_item_id
        AND ii.product_id = ri.product_id
        AND inv.invoice_type <> 'credit_memo'
        AND inv.deleted_at IS NULL
        AND inv.status = 'posted'
        AND ii.quantity > 0
    ) posted ON true
    -- What earlier credit memos already reversed for this line. The posted
    -- quantity is a budget spent across ALL credits against the line, not a
    -- fresh allowance per return: two 2-unit returns against a line with only
    -- 2 posted units must reverse 2 units in total, not 2 each. Cost-bearing
    -- rows only (cost_cents > 0) -- the zero-cost halves below consumed nothing.
    LEFT JOIN LATERAL (
      SELECT SUM(-ii.quantity) AS reversed_qty
      FROM invoice_items ii
      JOIN invoices inv ON inv.id = ii.invoice_id
      WHERE ri.order_item_id IS NOT NULL
        AND ii.order_item_id = ri.order_item_id
        AND ii.product_id = ri.product_id
        AND inv.invoice_type = 'credit_memo'
        AND inv.deleted_at IS NULL
        AND inv.status <> 'voided'
        AND ii.quantity < 0
        AND ii.cost_cents > 0
    ) prior ON true
    WHERE ri.return_id = p_return_id
  ),
  alloc AS (
    SELECT
      s.*,
      -- restocked: goods actually came back (receive_return sets it only after
      -- inventory really moved), so there is stock whose cost should return to
      -- the shelf. Everything else reverses no cost.
      CASE
        WHEN s.restocked
          THEN GREATEST(LEAST(s.quantity, s.posted_qty - s.reversed_qty), 0)
        ELSE 0
      END AS cost_qty,
      COALESCE(
        s.line_cost_cents,
        s.cost_at_time_cents,
        ROUND(s.cost_per_unit * 100)::bigint,
        0
      ) AS unit_cost_cents
    FROM src s
  ),
  parts AS (
    SELECT
      a.*,
      -- Revenue split exactly: the cost-bearing row takes its proportional
      -- share and the zero-cost row takes the remainder, so the two always sum
      -- back to the full credited amount with no rounding drift.
      ROUND(a.extended_cents * a.cost_qty / NULLIF(a.quantity, 0)) AS cost_part_cents
    FROM alloc a
  )
  INSERT INTO invoice_items (
    invoice_id, order_item_id, product_id, description,
    quantity, unit_price_cents, extended_cents, cost_cents,
    unit_size, sort_order
  )
  SELECT
    v_invoice_id,
    p.order_item_id,
    p.product_id,
    'Return ' || v_return_number || ' - ' || p.product_name,
    -part.qty,
    p.unit_price_cents,
    -part.ext_cents,
    part.unit_cost,
    p.unit,
    p.sort_order
  FROM parts p
  CROSS JOIN LATERAL (VALUES
    (p.cost_qty,              COALESCE(p.cost_part_cents, 0),                    p.unit_cost_cents),
    (p.quantity - p.cost_qty, p.extended_cents - COALESCE(p.cost_part_cents, 0), 0::bigint)
  ) AS part(qty, ext_cents, unit_cost)
  WHERE part.qty > 0;

  -- NEW: stamp the credit memo's cost total from its own lines (negative or
  -- zero). total_cost_cents is a plain column; balance_cents (GENERATED) is
  -- never written.
  SELECT ROUND(COALESCE(SUM(ii.cost_cents * ii.quantity), 0))::bigint
    INTO v_credit_cogs_cents
    FROM invoice_items ii
   WHERE ii.invoice_id = v_invoice_id;

  UPDATE invoices
     SET total_cost_cents = v_credit_cogs_cents
   WHERE id = v_invoice_id;

  v_cogs_reversed_cents := -v_credit_cogs_cents;

  PERFORM set_config('app.return_rpc', 'true', true);  -- PARKED-004
  UPDATE returns
     SET status = 'credited',
         total_credit_cents = v_total,
         credit_invoice_id = v_invoice_id,
         credited_at = now(),
         credited_by = v_actor,
         updated_at = now()
   WHERE id = p_return_id;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'credit_memo_created', 'credit_memo', v_invoice_id,
    v_actor, -v_total,
    'Credit memo ' || v_invoice_num || ' created for return ' || v_return_number,
    jsonb_build_object(
      'invoice_id', v_invoice_id,
      'invoice_number', v_invoice_num,
      'return_id', p_return_id,
      'return_number', v_return_number,
      'customer_id', v_customer_id,
      'credit_amount_cents', v_total,
      'cogs_reversed_cents', v_cogs_reversed_cents
    )
  );

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description, new_values
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    v_actor, -v_total,
    'Credit issued for return ' || v_return_number || ' -> invoice ' || v_invoice_num,
    jsonb_build_object(
      'credit_invoice_id', v_invoice_id,
      'credit_invoice_number', v_invoice_num,
      'credit_amount_cents', v_total,
      'customer_id', v_customer_id,
      'cogs_reversed_cents', v_cogs_reversed_cents
    )
  );

  v_result := jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return_number,
    'credit_invoice_id', v_invoice_id,
    'credit_invoice_number', v_invoice_num,
    'credit_amount_cents', v_total,
    'cogs_reversed_cents', v_cogs_reversed_cents,
    'customer_id', v_customer_id,
    'credited_at', now()
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'issue_return_credit', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Re-assert the service_role-only ACL from 20260714222000 (CREATE OR REPLACE
-- preserves existing grants; this is explicit belt-and-suspenders).
REVOKE ALL ON FUNCTION public._issue_return_credit_impl(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._issue_return_credit_impl(uuid, uuid, text) TO service_role;

-- NOTE (2026-08-08 drift review): no change to guard_terminal_order_invoice_items
-- is needed. On a terminal (cancelled/voided/soft-deleted) order the credit-memo
-- HEADER insert is already rejected by guard_invoice_terminal_order
-- (20260721014858), so _issue_return_credit_impl never reaches the line insert
-- there — behavior unchanged since 2026-07-21. An earlier draft re-emitted the
-- items guard with a credit_memo exemption; it was removed as unreachable dead
-- code that only widened a rep-reachable money surface. If terminal-order
-- return credits are ever wanted, BOTH invoice guards need a paired, non-RLS-
-- reachable allowance in one reviewed migration.
