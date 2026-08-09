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
-- QUANTITY CAP: the reversal is scaled to LEAST(returned, posted invoiced)
-- quantity. create_return caps returns against DELIVERED quantity, which on a
-- part-invoiced order line can exceed what any posted invoice carries; without
-- the cap the credit memo would subtract more COGS than the reports ever added.
-- The credit-memo row keeps the full negative returned quantity — the customer
-- is credited for everything returned — and only the per-unit cost is scaled.
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

  -- NEW: one credit-memo line per return item. Negative quantity, positive
  -- per-unit price/cost, negative extended — see header sign-convention note.
  INSERT INTO invoice_items (
    invoice_id, order_item_id, product_id, description,
    quantity, unit_price_cents, extended_cents, cost_cents,
    unit_size, sort_order
  )
  SELECT
    v_invoice_id,
    ri.order_item_id,
    ri.product_id,
    'Return ' || v_return_number || ' - ' || ri.product_name,
    -ri.quantity,
    ri.unit_price_cents,
    -ri.extended_cents,
    -- COGS reversal. Four rules, each learned the hard way (Codex rounds 35-39);
    -- all of them exist to stop the reversal exceeding what the invoice-basis
    -- rollups actually counted, because that direction INFLATES profit.
    --
    --  1. restocked only. restocked, not restock: restock is the intent flag,
    --     but receive_return sets restocked = true only after inventory was
    --     really incremented, and leaves it false when the item was ineligible
    --     or no inventory row existed. Those are cases where we refunded the
    --     customer and got no sellable goods back, so the cost stays on the
    --     books. Safe to read here because credit_return refuses to run unless
    --     the return is already 'received', so receive_return has finished.
    --  2. An eligible source line must EXIST (src.posted_qty > 0). No sale line
    --     on the books means no counted cost to reverse.
    --  3. 'posted' ONLY -- the INTERSECTION of the two invoice-basis reports,
    --     not the union. get_bottom_line_pnl (20260216200000:309) counts
    --     'posted' alone while get_monthly_summary counts 'posted' and
    --     'overdue'; admitting 'overdue' would let the bottom line exclude the
    --     original COGS while including this credit memo's negative COGS.
    --     Accepted residual: a credited overdue sale gets no reversal, so
    --     get_monthly_summary understates profit. Conservative on purpose, and
    --     it clears once the reports are unified (tracked in KNOWN_ISSUES.md).
    --  4. CAPPED to the posted quantity. An order line delivered in batches can
    --     have only part of it on a posted invoice, while create_return caps
    --     returns against DELIVERED quantity, not invoiced quantity. Returning
    --     10 delivered units when only 2 are posted must reverse 2 units of
    --     cost, not 10. The credit-memo row keeps the full -ri.quantity (the
    --     customer is credited for everything returned); only the per-unit cost
    --     is scaled, so cost_cents * quantity lands on the capped total.
    CASE WHEN ri.restocked AND COALESCE(src.posted_qty, 0) > 0 AND ri.quantity > 0 THEN
      ROUND(
        COALESCE(
          src.line_cost_cents,
          -- The order line's own snapshot before its mutable legacy dollars:
          -- cost_at_time_cents is the canonical basis the sibling reporting
          -- migration uses, and the two can differ on an older order.
          oi.cost_at_time_cents,
          ROUND(oi.cost_per_unit * 100)::bigint,
          0
        )::numeric
        * LEAST(ri.quantity, src.posted_qty) / ri.quantity
      )::bigint
    ELSE 0 END,
    ri.unit,
    ri.sort_order
  FROM return_items ri
  LEFT JOIN order_items oi ON oi.id = ri.order_item_id
  -- One resolution of the original sale line, used for eligibility, for the
  -- per-unit cost and for the quantity cap -- so those three can never be
  -- decided from different rows. product_id is matched as well as
  -- order_item_id: update_order_items may swap an order line's product after
  -- it was invoiced, leaving a historical invoice line under the same
  -- order_item_id carrying the OLD product and its cost.
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
  ) src ON true
  WHERE ri.return_id = p_return_id;

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
