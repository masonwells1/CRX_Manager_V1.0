-- Money/inventory gauntlet: close money-calculation and prepay workflow gaps.
-- Built from the live function definitions inspected 2026-07-15. No data changes.

CREATE OR REPLACE FUNCTION public.save_invoice(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_invoice_id uuid; v_is_new boolean := false; v_item jsonb;
  v_total_cents bigint := 0; v_qty numeric; v_unit_price bigint; v_extended bigint;
  v_cost_cents bigint; v_product record; v_order_id uuid; v_blend_id uuid; v_existing jsonb;
  v_total_cost bigint := 0;
  v_is_field boolean := false;
  v_is_fee boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- PARKED-002 (codex-driven cycle 1 #1 MED): credit memos must come exclusively
    -- from issue_return_credit (the ONLY caller that derives the credit from a
    -- 'received' return and gates on check_period_open). save_invoice's NEW-invoice
    -- branch otherwise allows an admin/sales-rep to forge a posted credit memo by
    -- riding on the enforce_invoice_draft_on_insert credit_memo exemption. Reject
    -- BEFORE the order/blend check so the error surfaced is the intent-mismatch one.
    IF (p_invoice->>'invoice_type') = 'credit_memo' THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;
    -- Manual miscellaneous charges are the one controlled orderless invoice
    -- type. Chemical sales still require a source order/blend ticket.
    IF v_order_id IS NULL
       AND v_blend_id IS NULL
       AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') <> 'misc_charge' THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    IF COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') = 'misc_charge'
       AND COALESCE(NULLIF(p_invoice->>'status', ''), 'draft') <> 'draft' THEN
      RAISE EXCEPTION 'MISC_CHARGE_MUST_START_DRAFT: orderless miscellaneous charges must be reviewed before posting';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, purchase_order_ref, header_notes, footer_notes, total_amount_cents, created_by)
    VALUES (v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      COALESCE((p_invoice->>'season')::int, (SELECT current_season())),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
      (p_invoice->>'due_date')::date,
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor) RETURNING id INTO v_invoice_id;
  ELSE
    -- An orderless miscellaneous charge must remain a miscellaneous charge.
    -- The edit payload does not carry source IDs, so enforce this against the
    -- stored invoice rather than trusting the client to keep the type locked.
    IF EXISTS (
      SELECT 1
       FROM invoices
       WHERE id = v_invoice_id
         AND invoice_type = 'misc_charge'
         AND order_id IS NULL
         AND blend_ticket_id IS NULL
         AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), invoice_type) <> 'misc_charge'
    ) THEN
      RAISE EXCEPTION 'ORDERLESS_INVOICE_TYPE_LOCKED: an orderless miscellaneous charge cannot be reclassified';
    END IF;

    -- PARKED-002 (Codex r3): EXPLICIT pre-UPDATE guard on the credit_memo boundary.
    -- A silent CASE-keep would swallow an attempted chemical_sale -> credit_memo flip
    -- (other payload fields still save) so the caller never sees the rejection. Fail
    -- LOUDLY with CREDIT_MEMO_VIA_SAVE_INVOICE whenever OLD or NEW crosses 'credit_memo'.
    -- Mirrors how enforce_field_application_type_lock errors on its boundary cross,
    -- except this is RPC-side because credit_memo is born 'posted' and the trigger only
    -- fires on UPDATE OF invoice_type (a posted credit_memo never gets here at all).
    -- PARKED-002 (Codex r4): drop the status filter — surface the boundary cross even
    -- when the target invoice is posted/voided/etc. The existing post-UPDATE
    -- "NOT EXISTS ... status IN ('draft','unposted')" path would otherwise silently
    -- no-op a posted-invoice credit_memo attempt; the caller deserves a clear error.
    IF EXISTS (
      SELECT 1 FROM invoices
       WHERE id = v_invoice_id
         AND (
              invoice_type = 'credit_memo'
           OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
         )
         AND invoice_type IS DISTINCT FROM COALESCE(p_invoice->>'invoice_type', invoice_type)
    ) THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;

    UPDATE invoices SET
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- PARKED-002 (Codex r2): symmetric lock — credit_memo is a SEGREGATION boundary like
      -- field_application. The pre-UPDATE guard above ALREADY rejected any cross-boundary
      -- attempt with CREDIT_MEMO_VIA_SAVE_INVOICE; this CASE is the second-line invariant
      -- so a bug in the guard can't silently let the column flip. Stacks on top of DELTA-F.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
        THEN invoice_type
        WHEN invoice_type = 'credit_memo'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
        THEN invoice_type
        ELSE COALESCE(p_invoice->>'invoice_type', invoice_type) END,
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = (p_invoice->>'due_date')::date,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  IF NOT v_is_new THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
      RETURN v_invoice_id;
    END IF;
  END IF;

  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE v_share_n int; v_has_ovr boolean;
    BEGIN
      SELECT count(*), COALESCE(bool_or(price_per_acre_cents IS NOT NULL), false)
        INTO v_share_n, v_has_ovr
        FROM invoice_shares WHERE invoice_id = v_invoice_id;
      IF v_share_n > 1 OR v_has_ovr THEN
        RAISE EXCEPTION 'FIELD_INVOICE_SPLIT_LOCKED: this field invoice is split across growers (or has a fixed-price grower) — void and reissue to change it';
      END IF;
    END;
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invoice line item quantity must be greater than zero'; END IF;
    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_is_fee := COALESCE((v_item->>'is_application_fee')::boolean, false) AND (v_item->>'product_id') IS NULL;
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    IF v_is_fee
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      v_item->>'rate_unit',
      v_is_fee,
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_item->>'epa_registration',
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint);
    v_total_cents := v_total_cents + v_extended;
    v_total_cost := v_total_cost + CASE
      WHEN v_is_fee THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    WITH s AS (
      SELECT id, COALESCE(amount_cents, 0) AS amount_cents,
             row_number() OVER (ORDER BY is_primary DESC, sort_order, id) AS rn,
             SUM(COALESCE(amount_cents, 0)) OVER () AS tot
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    ),
    alloc AS (
      SELECT id, rn,
             CASE WHEN tot > 0 THEN ROUND(v_total_cents * amount_cents / tot)::bigint
                  WHEN rn = 1 THEN v_total_cents ELSE 0 END AS part
      FROM s
    ),
    recon AS (
      SELECT id, rn, part, v_total_cents - COALESCE(SUM(part) OVER (), 0) AS rem
      FROM alloc
    )
    UPDATE invoice_shares isr
       SET amount_cents = r.part + CASE WHEN r.rn = 1 THEN r.rem ELSE 0 END
      FROM recon r WHERE isr.id = r.id;
  END IF;

  -- U8<<< (Codex R2 P1): a job-born field_application invoice stays editable while
  -- draft/unposted, and the items rewrite above changes chemical-line profit without
  -- touching the pending job commissions minted at transfer time. Recompute them from
  -- the just-written lines — the exact mirror of update_order_items' commission-
  -- recompute-on-edit (20260617040000), including its batch-freeze guard. Scoped by
  -- commissions.invoice_id (generation-precise): order-channel rows and other
  -- generations are untouched, and a non-job invoice simply matches zero rows.
  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE
      v_u8_profit numeric;
    BEGIN
      -- Codex R6 P2: an edit while any of this generation's pending commissions sit
      -- in an active payout batch would leave that batch stale (post_commission_payment
      -- pays the OLD amount) — block, mirroring the reversal paths' guard.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this invoice''s pending commissions are in an active payout batch — void that commission payment before editing';
      END IF;
      -- Codex R7 P1: commissions already PAID against this still-unposted invoice
      -- must also block the edit — the recompute below only touches pending rows,
      -- so an edit would silently strand the paid ledger on the old profit. Fully
      -- recoverable: void the commission payment (rows reset to pending because
      -- this invoice is live), edit, then re-batch.
      IF EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL AND c.status = 'paid'
      ) THEN
        RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this invoice''s commissions were already paid out — void that commission payment before editing the invoice';
      END IF;

      -- Codex R6 P2: COGS per line is cost_cents × quantity (save_invoice stores
      -- per-unit cost — the SAME math its own v_total_cost uses); transfer-minted
      -- lines carry quantity=1 with line-total cost, so ×1 is identical there.
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - ROUND(COALESCE(ii.cost_cents, 0) * COALESCE(ii.quantity, 1))::bigint), 0)::numeric / 100.0
        INTO v_u8_profit
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      UPDATE commissions c
         SET order_profit      = ROUND(COALESCE(v_u8_profit, 0), 2),
             commission_amount = calc.new_amount
        FROM (
          SELECT x.id,
                 -- Codex R5 P2: mirror the mint's last-row penny reconciliation so the
                 -- recomputed rows sum EXACTLY to the rounded profit (a 33.33/33.33/33.34
                 -- split of $0.02 must not round up to $0.03). Only safe when the eligible
                 -- pending rows ARE the whole generation (x.cnt = x.cnt_all, and cnt_all
                 -- counts EVERY non-deleted row of the generation regardless of status —
                 -- drift-review R6 H1: a sibling already PAID via a posted batch must
                 -- force the per-row fallback, or the last pending row would absorb the
                 -- paid recipient's entire share, not a penny). The mixed case keeps the
                 -- per-row math (update_order_items parity).
                 CASE WHEN x.rn = x.cnt AND x.cnt = x.cnt_all THEN
                     GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                     - COALESCE(SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                         OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
                   ELSE compute_commission_amount(v_u8_profit, x.split_percentage)
                 END AS new_amount
          FROM (
            SELECT c2.id, c2.split_percentage,
                   row_number() OVER (ORDER BY c2.id) AS rn,
                   count(*) OVER () AS cnt,
                   (SELECT count(*) FROM commissions c3
                     WHERE c3.invoice_id = v_invoice_id AND c3.job_id IS NOT NULL
                       AND c3.deleted_at IS NULL) AS cnt_all
            FROM commissions c2
            WHERE c2.invoice_id = v_invoice_id
              AND c2.job_id IS NOT NULL
              AND c2.status = 'pending'
              AND c2.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM commission_payment_items cpi
                JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                WHERE cpi.commission_id = c2.id AND cp.status <> 'voided'
              )
          ) x
        ) calc
       WHERE c.id = calc.id;
    END;
  END IF;
  -- >>>U8

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id, (p_invoice->>'customer_id')::uuid);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb, jsonb, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_customer_statement(p_customer_id uuid, p_start_date date DEFAULT ((CURRENT_DATE - '90 days'::interval))::date, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Access denied: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  WITH txns AS (
    SELECT
      i.invoice_date::date AS txn_date,
      CASE WHEN i.invoice_type = 'credit_memo' THEN 'credit' ELSE 'invoice' END AS txn_type,
      i.invoice_number AS ref_num,
      CASE WHEN i.invoice_type = 'credit_memo'
           THEN 'Credit Memo ' || i.invoice_number
           ELSE 'Invoice ' || i.invoice_number END AS descr,
      i.total_amount_cents AS amt
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      -- [CSB-DELTA-1 BEGIN] paid/overdue invoices must keep their charge line
      AND i.status IN ('posted', 'paid', 'overdue')
      -- [CSB-DELTA-1 END]
      AND i.deleted_at IS NULL
      AND i.invoice_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT
      p.payment_date::date AS txn_date,
      'payment' AS txn_type,
      COALESCE(p.reference_number, '') AS ref_num,
      'Payment - ' || p.payment_method AS descr,
      -(p.amount * 100)::bigint AS amt
    FROM payments p
    -- [CSB-DELTA-2 BEGIN] NULL-order_id payments (order-less invoices) included
    LEFT JOIN orders o ON o.id = p.order_id
    WHERE COALESCE(o.customer_id, p.customer_id) = p_customer_id
      -- [CSB-DELTA-2 END]
      -- [CSB-DELTA-3 BEGIN] soft-deleted payments excluded
      AND p.deleted_at IS NULL
      -- [CSB-DELTA-3 END]
      AND p.payment_date::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    -- [CSB-DELTA-4 BEGIN] allocate_payment-path payments (allocation_sets,
    -- never payments rows). Amount = invoice-applied portion ONLY
    -- (total_allocated_cents); the overpayment remainder is counted by the
    -- prepay branch below when applied — see header DEDUP RULE.
    SELECT
      COALESCE(a.payment_date, a.created_at::date) AS txn_date,
      'payment' AS txn_type,
      COALESCE(a.reference_number, a.check_number, '') AS ref_num,
      'Payment - ' || COALESCE(a.payment_method, 'other') AS descr,
      -COALESCE(a.total_allocated_cents, 0) AS amt
    FROM allocation_sets a
    WHERE a.entity_type = 'payment'
      AND a.is_active = true
      AND a.customer_id = p_customer_id
      AND COALESCE(a.total_allocated_cents, 0) > 0
      AND COALESCE(a.payment_date, a.created_at::date) BETWEEN p_start_date AND p_end_date
    -- [CSB-DELTA-4 END]

    UNION ALL

    SELECT
      pa.applied_at::date AS txn_date,
      'prepay' AS txn_type,
      '' AS ref_num,
      'Prepay Applied' AS descr,
      -pa.applied_amount_cents AS amt
    FROM prepay_applications pa
    INNER JOIN prepay_credits pc ON pc.id = pa.prepay_credit_id
    WHERE pc.customer_id = p_customer_id
      AND pa.applied_at::date BETWEEN p_start_date AND p_end_date

    UNION ALL

    SELECT
      (wo.created_at AT TIME ZONE 'America/Chicago')::date AS txn_date,
      'write_off' AS txn_type,
      i.invoice_number AS ref_num,
      'Write-off - ' || wo.reason AS descr,
      -wo.amount_cents AS amt
    FROM write_offs wo
    INNER JOIN invoices i ON i.id = wo.invoice_id
    WHERE wo.customer_id = p_customer_id
      AND wo.reversed_at IS NULL
      AND (wo.created_at AT TIME ZONE 'America/Chicago')::date BETWEEN p_start_date AND p_end_date
  )
  SELECT
    t.txn_date AS transaction_date,
    t.txn_type AS transaction_type,
    t.ref_num AS reference_number,
    t.descr AS description,
    t.amt AS amount_cents,
    (SUM(t.amt) OVER (ORDER BY t.txn_date, t.txn_type))::bigint AS running_balance
  FROM txns t
  ORDER BY t.txn_date, t.txn_type;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_customer_statement(uuid, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_statement(uuid, date, date)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ap_dashboard_summary(p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM require_admin();
  SELECT jsonb_build_object(
    'total_owed_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') THEN balance_cents ELSE 0 END), 0),
    'overdue_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN balance_cents ELSE 0 END), 0),
    'overdue_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN 1 END),
    'due_this_week_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN balance_cents ELSE 0 END), 0),
    'due_this_week_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN 1 END),
    'due_this_month_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 THEN balance_cents ELSE 0 END), 0),
    'total_bills', COUNT(*),
    'unpaid_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') THEN 1 END),
    'paid_this_month_cents', COALESCE((
      SELECT SUM(vp.amount_cents)
      FROM vendor_payments vp
      JOIN vendor_bills vb2 ON vb2.id = vp.vendor_bill_id
      WHERE vp.payment_date >= date_trunc('month', CURRENT_DATE)
        AND vp.voided_at IS NULL
    ), 0)
  )
  INTO v_result
  FROM vendor_bills
  WHERE deleted_at IS NULL AND status <> 'voided';

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_ap_dashboard_summary(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ap_dashboard_summary(text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.generate_finance_charges(p_as_of_date date, p_performed_by uuid, p_customer_ids uuid[] DEFAULT NULL::uuid[], p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_customer record;
  v_charge_amount bigint;
  v_invoice_id uuid;
  v_inv_num text;
  v_charges jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_skipped integer := 0;
  v_min_balance bigint;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'FINANCE_CHARGE_DATE_REQUIRED';
  END IF;
  IF p_as_of_date > (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'FUTURE_FINANCE_CHARGE_DATE: finance charges cannot be generated for a future business date';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_finance_charges');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('generate_finance_charges:' || p_as_of_date::text));
  PERFORM public.check_period_open(p_as_of_date);

  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  FOR v_customer IN
    SELECT c.id AS customer_id, c.farm_name, c.finance_charge_rate,
           COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
           COALESCE(sum(i.balance_cents), 0) AS overdue_balance
      FROM public.customers c
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status IN ('posted', 'overdue')
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.invoice_type != 'misc_charge'
        AND i.due_date IS NOT NULL
        AND i.due_date < (p_as_of_date - (COALESCE(c.finance_charge_grace_days, 0) || ' days')::interval)
      WHERE c.finance_charge_rate > 0
        AND c.is_active = true
        AND COALESCE(c.finance_charge_enabled, true) = true
        AND (p_customer_ids IS NULL OR c.id = ANY(p_customer_ids))
      GROUP BY c.id, c.farm_name, c.finance_charge_rate, c.finance_charge_grace_days
      HAVING sum(i.balance_cents) >= v_min_balance
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.finance_charges
      WHERE customer_id = v_customer.customer_id
        AND period_end = p_as_of_date
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_charge_amount := ROUND(v_customer.overdue_balance * (v_customer.finance_charge_rate / 100.0 / 12.0));

    IF v_charge_amount > 0 THEN
      v_inv_num := next_invoice_number('misc_charge');

      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents,
        header_notes, season, created_by
      ) VALUES (
        -- OVERNIGHT FIX (finding #1): insert as 'draft' — the BEFORE INSERT trigger
        -- rejects any non-draft, non-credit_memo insert. Flipped to 'unposted' below
        -- once the item / finance_charges / audit rows are built. Live literal was 'unposted'.
        v_inv_num, v_customer.customer_id, 'misc_charge', 'draft', p_as_of_date,
        (p_as_of_date + interval '30 days')::date,
        v_charge_amount, 0,
        'Finance charge: ' || v_customer.finance_charge_rate || '% annual on overdue balance of $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') ||
        CASE WHEN v_customer.grace_days > 0
             THEN ' (after ' || v_customer.grace_days || ' day grace period)'
             ELSE '' END,
        CASE WHEN extract(month FROM p_as_of_date) >= 10
             THEN extract(year FROM p_as_of_date)::integer + 1
             ELSE extract(year FROM p_as_of_date)::integer END,
        v_actor
      ) RETURNING id INTO v_invoice_id;

      INSERT INTO public.invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, is_application_fee, sort_order
      ) VALUES (
        v_invoice_id,
        'Finance Charge - ' || v_customer.finance_charge_rate || '% annual rate on overdue balance',
        1, v_charge_amount, v_charge_amount,
        0, false, 1
      );

      INSERT INTO public.finance_charges (
        customer_id, invoice_id, amount_cents, charge_rate,
        base_amount_cents, period_start, period_end, created_by
      ) VALUES (
        v_customer.customer_id, v_invoice_id, v_charge_amount,
        v_customer.finance_charge_rate, v_customer.overdue_balance,
        (p_as_of_date - interval '30 days')::date, p_as_of_date,
        v_actor
      );

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_user_id, total_impact_cents, description
      ) VALUES (
        'finance_charge', 'invoice', v_invoice_id,
        v_actor, v_charge_amount,
        'Finance charge generated for ' || v_customer.farm_name ||
        ': $' || to_char(v_charge_amount / 100.0, 'FM999,999,990.00') ||
        ' at ' || v_customer.finance_charge_rate || '% on $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') || ' overdue'
      );

      -- OVERNIGHT FIX (finding #1): now that the invoice and its child rows are fully
      -- built, flip draft -> unposted (the original intended end state). Allowed by
      -- _enforce_invoice_status_transition (draft -> unposted).
      UPDATE public.invoices SET status = 'unposted' WHERE id = v_invoice_id;

      v_count := v_count + 1;
      v_charges := v_charges || jsonb_build_object(
        'customer', v_customer.farm_name,
        'base_balance_cents', v_customer.overdue_balance,
        'charge_cents', v_charge_amount,
        'rate', v_customer.finance_charge_rate,
        'invoice_number', v_inv_num,
        'grace_days', v_customer.grace_days
      );
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'charges_generated', v_count,
    'skipped_already_charged', v_skipped,
    'details', v_charges
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_finance_charges', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_finance_charges(date, uuid, uuid[], text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preview_finance_charges(p_as_of_date date)
 RETURNS TABLE(customer_id uuid, customer_name text, account_number text, overdue_balance_cents bigint, charge_rate numeric, grace_days integer, days_overdue integer, charge_amount_cents bigint, finance_charge_enabled boolean, open_credit_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_min_balance bigint;
BEGIN
  PERFORM require_admin();
  IF p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'FINANCE_CHARGE_DATE_REQUIRED';
  END IF;
  IF p_as_of_date > (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'FUTURE_FINANCE_CHARGE_DATE: finance charges cannot be previewed for a future business date';
  END IF;
  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  RETURN QUERY
  SELECT
    c.id AS customer_id,
    c.farm_name::text AS customer_name,
    c.account_number::text AS account_number,
    agg.overdue_balance_cents,
    c.finance_charge_rate AS charge_rate,
    COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
    agg.max_days_overdue AS days_overdue,
    ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint AS charge_amount_cents,
    COALESCE(c.finance_charge_enabled, true) AS finance_charge_enabled,
    COALESCE(cm.credit_cents, 0)::bigint AS open_credit_cents
  FROM public.customers c
  INNER JOIN (
    -- Base overdue set — MUST mirror generate_finance_charges exactly so the previewed
    -- amount equals the billed amount: status IN ('posted','overdue') + grace-aware
    -- per-invoice due_date predicate (grace read per-customer via the cc join).
    SELECT
      i.customer_id,
      COALESCE(sum(i.balance_cents), 0)::bigint AS overdue_balance_cents,
      max((p_as_of_date - i.due_date))::integer AS max_days_overdue
    FROM public.invoices i
    JOIN public.customers cc ON cc.id = i.customer_id
    WHERE i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_type != 'misc_charge'
      AND i.due_date IS NOT NULL
      AND i.due_date < (p_as_of_date - (COALESCE(cc.finance_charge_grace_days, 0) || ' days')::interval)
    GROUP BY i.customer_id
  ) agg ON agg.customer_id = c.id
  LEFT JOIN (
    SELECT ci.customer_id, -SUM(ci.balance_cents) AS credit_cents
    FROM public.invoices ci
    WHERE ci.invoice_type = 'credit_memo' AND ci.status = 'posted'
      AND ci.balance_cents < 0 AND ci.deleted_at IS NULL
    GROUP BY ci.customer_id
  ) cm ON cm.customer_id = c.id
  WHERE c.finance_charge_rate > 0
    AND c.is_active = true
    AND COALESCE(c.finance_charge_enabled, true) = true
    AND agg.overdue_balance_cents >= v_min_balance
    AND ROUND(agg.overdue_balance_cents * (c.finance_charge_rate / 100.0 / 12.0))::bigint > 0
  ORDER BY c.farm_name;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.preview_finance_charges(date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_finance_charges(date)
  TO authenticated, service_role;

DROP FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text);

-- Keep the original five named arguments in their original order and append the
-- expected total as a trailing default. Old/stale PWA bundles can therefore keep
-- calling the hardened body with five arguments while the new bundle supplies the
-- sixth penny-exact assertion. There is still only one function identity.
CREATE OR REPLACE FUNCTION public.create_prepay_check_splits(p_customer_id uuid, p_reference_number text, p_splits jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_total_cents bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor         uuid;
  v_actor_role    text;
  v_split         jsonb;
  v_total_cents   bigint := 0;
  v_credit_id     uuid;
  v_credit_ids    uuid[] := '{}';
  v_label         text;
  v_amount_cents  bigint;
  v_season        integer;
  v_result        jsonb;
  v_existing      jsonb;
  v_declared_split_total bigint;
  v_expected_total_cents bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): include is_active = true so deactivated admins
  -- with still-valid JWTs cannot create prepay credits.
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role != 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only active admins can create prepay credits';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_prepay_check_splits');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_splits IS NULL OR jsonb_typeof(p_splits) <> 'array' OR jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'INVALID_SPLITS: at least one split is required';
  END IF;
  SELECT COALESCE(SUM(NULLIF(split->>'amount_cents', '')::bigint), 0)
    INTO v_declared_split_total
    FROM jsonb_array_elements(p_splits) split;

  -- A missing value identifies a pre-deploy/stale client. Its historical contract
  -- declared the check total only through the splits themselves, so preserve that
  -- behavior during rollout. New clients send the independent expected total.
  v_expected_total_cents := COALESCE(p_expected_total_cents, v_declared_split_total);
  IF v_expected_total_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_CHECK_TOTAL: expected check total must be positive';
  END IF;

  IF v_declared_split_total IS DISTINCT FROM v_expected_total_cents THEN
    RAISE EXCEPTION 'PREPAY_SPLIT_TOTAL_MISMATCH: split total % must equal check total %',
      v_declared_split_total, v_expected_total_cents
      USING ERRCODE = 'P0001';
  END IF;

  v_season := current_season();

  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits)
  LOOP
    v_label        := NULLIF(v_split->>'label', '');
    v_amount_cents := (v_split->>'amount_cents')::bigint;

    IF v_amount_cents IS NULL OR v_amount_cents <= 0 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT: each split amount must be positive (got %)', v_amount_cents;
    END IF;

    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      payment_method, reference_number, notes, created_by,
      source_type, source_reference, bucket_label
    ) VALUES (
      p_customer_id, v_season, v_amount_cents, v_amount_cents,
      'check', p_reference_number,
      'Check #' || p_reference_number || COALESCE(' — ' || v_label, ''),
      v_actor, 'check', p_reference_number, v_label
    )
    RETURNING id INTO v_credit_id;

    v_credit_ids  := v_credit_ids || v_credit_id;
    v_total_cents := v_total_cents + v_amount_cents;
  END LOOP;

  UPDATE customers
     SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_cents,
         updated_at = now()
   WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', p_customer_id;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_credit_created', 'prepay_credit', p_customer_id,
    v_actor_role,
    jsonb_build_object(
      'reference_number', p_reference_number,
      'split_count', jsonb_array_length(p_splits),
      'credit_ids', to_jsonb(v_credit_ids),
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Check #' || p_reference_number || ' split into ' ||
      jsonb_array_length(p_splits) || ' bucket(s) — $' ||
      (v_total_cents / 100.0)::numeric(12,2)
  );

  v_result := jsonb_build_object(
    'success', true,
    'credit_ids', to_jsonb(v_credit_ids),
    'total_cents', v_total_cents,
    'split_count', jsonb_array_length(p_splits)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_prepay_check_splits', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text, bigint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text, bigint)
  TO authenticated, service_role;
