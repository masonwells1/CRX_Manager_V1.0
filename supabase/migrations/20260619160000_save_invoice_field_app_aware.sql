-- idempotency-body-check: exempt
-- ============================================================================
-- save_invoice — make it field-application AWARE so a job-created field invoice
-- can be edited ("bill actual") on the shared invoice editor without losing the
-- machine-fee flag / applied data, and with its per-grower split kept in sync.
-- Phase 1c follow-up (#3 edit-path) of the As-Applied / Field-Invoice build.
-- ----------------------------------------------------------------------------
-- WHY: a job invoice from transfer_job_to_invoice has quantity-based chemical
-- lines + ONE is_application_fee machine-fee line + invoice_shares, and NO
-- field_app_locations. It must be edited on the generic quantity-based editor
-- (InvoiceDetail), not the per-acre engine editor (which needs field_app_locations
-- and would drop flat lines). But the live save_invoice (md5
-- c65a45b28d9eca4448d4ef205c354fba) (a) reinserts invoice_items WITHOUT
-- is_application_fee or the applied/EPA columns -> the fee line silently becomes a
-- normal line and the applied detail is lost on the first edit, and (b) never
-- updates invoice_shares -> the per-grower split drifts from the edited total.
--
-- THIS MIGRATION (verbatim live body + two sentinel-delimited DELTAs):
--   DELTA-A: the invoice_items reinsert now also carries (all OPTIONAL, all
--     nullable -> chemical_sale invoices that don't send them are byte-identical):
--     is_application_fee, rate_unit, total_applied, total_applied_unit,
--     total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
--     price_source (CHECK-guarded to quoted/tier/manual), quoted_price_cents.
--   DELTA-B: AFTER the header total is recomputed, IF the invoice is
--     invoice_type='field_application', re-balance invoice_shares proportionally
--     to the new total (penny-exact, remainder to the primary share) so the
--     grower split keeps summing to the header. Guarded on field_application, so
--     chemical_sale / credit_memo / misc_charge invoices are untouched (they have
--     no per-grower share allocation through this path).
--
-- NOT CHANGED: the auth gate (auth.uid() + is_admin()/is_sales_rep()), the
--   order_id-OR-blend_ticket_id requirement for NEW invoices (a field invoice is
--   only ever EDITED here, never created — it has neither and the check is
--   new-only), SECDEF + search_path, idempotency scope, the draft/unposted edit
--   lock. save_invoice has NO p_performed_by (already actor-bound to auth.uid()).
--
-- PARKED: do NOT apply without Mason's explicit OK.
-- ============================================================================

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
  v_total_cost bigint := 0;  -- DELTA-E: extended COST accumulator (field-invoice header sync)
  v_is_field boolean := false;  -- DELTA-G: field invoices preserve incoming (extended) line cost
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
    IF v_order_id IS NULL AND v_blend_id IS NULL THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
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
    UPDATE invoices SET
      -- DELTA-D (Codex): a field_application invoice's customer is job-derived and
      -- mirrored in the invoice_shares ledger (+ PDFs/statements); changing only
      -- the header would desync the share customer. Lock the customer on field
      -- invoices (the field editor also shows it read-only); chemical invoices
      -- still allow a customer change.
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- DELTA-F (Codex r12): invoice_type is the SEGREGATION boundary. This SET runs
      -- BEFORE the field-invoice split-lock (DELTA-C) and share/cost rebalance
      -- (DELTA-B/DELTA-E), all of which gate on the CURRENT invoice_type. A crafted or
      -- stale admin/sales client could send invoice_type='chemical_sale'/'misc_charge'
      -- on a field invoice (or 'field_application' on a chemical one) to flip the type
      -- here and make those guards read the NEW type and skip — moving the invoice out
      -- of /field-invoices while leaving invoice_shares / field data inconsistent (or
      -- fabricating a field invoice with no shares). Lock the type whenever
      -- field_application is on EITHER side: a field invoice can't be reclassified out,
      -- and a non-field invoice can't be reclassified in (field invoices are born only
      -- via transfer_job_to_invoice / save_field_app_invoice). Other type changes
      -- (e.g. chemical_sale <-> misc_charge) remain allowed.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
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

  -- DELTA-G (Codex r13): is this an existing field invoice? Its job/blend-built lines
  -- carry quantity=1 + an EXTENDED cost_cents (transfer_job_to_invoice /
  -- create_invoice_from_blend_ticket); the product-cost refresh in the loop must be
  -- skipped for them, else DELTA-E persists per_unit*1 and understates cost/margin.
  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  -- DELTA-C (Codex): only a SINGLE-grower, non-override field invoice has
  -- total = SUM(line items) that an item-driven save can edit correctly. A
  -- MULTI-grower split (each share = chemical split + a fixed per-grower machine
  -- fee at THAT grower's rate) or a fixed-price (override $/acre, share-only)
  -- grower cannot be re-balanced from line items without corrupting the
  -- per-grower fee/override. Block editing those here — void and reissue to
  -- change them. (Common single-grower field invoices edit normally.)
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
    -- Server-authoritative line total: ALWAYS recompute quantity x unit_price first
    -- (anti-tamper) — the payload can never set an arbitrary line total directly.
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    -- DELTA-A2 (Codex r10 + HARDENED r14): a GENUINE machine-fee line carries an EXACT
    -- summed total (sum of per-customer compute_application_service_fee totals) but only
    -- a ROUNDED blended per-acre display rate, so quantity(acres) x unit_price differs
    -- from that exact total by at most a sub-cent-per-acre rounding gap (<= acres cents).
    -- Honor the client's exact extended_cents ONLY when it is within that gap of the
    -- recomputed total — this absorbs the legitimate rounding so a no-op save can't drift
    -- the fee / grower shares, WITHOUT trusting the client-controlled is_application_fee
    -- flag: a normal line forged with is_application_fee=true + an arbitrary extended_cents
    -- diverges far beyond the gap, so it stays at the server-recomputed quantity x unit_price
    -- (no under/over-billing, no share rebalance to a forged amount). r14 P1.
    IF COALESCE((v_item->>'is_application_fee')::boolean, false)
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    -- DELTA-G (Codex r13): refresh a product line's cost from products.current_cost
    -- (a PER-UNIT figure) ONLY for non-field invoices. A field invoice's chemical line
    -- is stored as quantity=1 with cost_cents = the FULL EXTENDED job/blend cost; if we
    -- overwrote it with the per-unit cost, DELTA-E (cost x quantity, quantity=1) would
    -- persist per_unit instead of the extended cost and massively understate margin.
    -- So field invoices PRESERVE the incoming (extended) cost_cents; the price side is
    -- already symmetric (unit_price holds the extended amount, x quantity=1).
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      -- >>> DELTA-A (#3 field-app aware): preserve the machine-fee flag + applied/
      -- EPA detail through edits. All OPTIONAL + nullable; a chemical_sale payload
      -- that omits them inserts the same NULL/false the live body produced.
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents)
      -- <<< DELTA-A
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      -- >>> DELTA-A values
      v_item->>'rate_unit',
      COALESCE((v_item->>'is_application_fee')::boolean, false),
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_item->>'epa_registration',
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint);
      -- <<< DELTA-A values
    v_total_cents := v_total_cents + v_extended;
    -- >>> DELTA-E: accumulate the EXTENDED line cost for the field-invoice header
    -- (invoices.total_cost_cents, read by margin/cost reporting). A normal product
    -- line stores a PER-UNIT cost (v_cost_cents = products.current_cost*100, or the
    -- client cents for a manual line) -> extended cost = cost x quantity. The
    -- is_application_fee line stores its EXACT, already-EXTENDED cost (its quantity
    -- is acres, not a multiplier) -> add it as-is (x1), mirroring how the price side
    -- honors the fee's exact extended_cents (DELTA-A2). Codex r10 P2.
    v_total_cost := v_total_cost + CASE
      WHEN COALESCE((v_item->>'is_application_fee')::boolean, false) THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
    -- <<< DELTA-E
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    -- DELTA-E: keep the field-invoice header COST in sync with the re-billed lines so
    -- margin/cost reporting (which reads invoices.total_cost_cents) is correct after a
    -- "bill actual" edit. FIELD-ONLY: a chemical_sale / credit_memo / misc_charge
    -- invoice's cost is owned by its own creation path; leaving it untouched keeps the
    -- non-field path byte-identical to the live body (the migration's core invariant).
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  -- >>> DELTA-B (#3 field-app aware): a field_application invoice carries a
  -- per-grower invoice_shares allocation; when the billed lines change, re-balance
  -- the shares to the new header total so they keep summing to it. Proportional to
  -- each share's current amount, penny-EXACT (remainder to the primary share). A
  -- single-grower job invoice has one share -> it gets the whole total. Guarded on
  -- field_application: chemical_sale / credit_memo / misc_charge are NOT touched.
  -- Only NON-override field invoices reach here (override invoices are blocked
  -- by DELTA-C above), so total_amount_cents = SUM(line items) is correct and the
  -- per-grower shares simply re-balance to it (penny-exact, remainder to primary).
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
  -- <<< DELTA-B

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

-- ============================================================================
-- SELF-VERIFICATION — raises (rolling back) on any failure.
-- ============================================================================
DO $$
DECLARE v_count int; v_src text;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc WHERE proname='save_invoice' AND pronamespace='public'::regnamespace;
  IF v_count <> 1 THEN RAISE EXCEPTION 'save_invoice overload count = %, expected 1', v_count; END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE proname='save_invoice' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%DELTA-A%' OR v_src NOT LIKE '%is_application_fee%' THEN
    RAISE EXCEPTION 'save_invoice: DELTA-A field-app columns missing';
  END IF;
  IF v_src NOT LIKE '%DELTA-B%'
     OR v_src NOT LIKE '%invoice_type FROM invoices WHERE id = v_invoice_id) = ''field_application''%' THEN
    RAISE EXCEPTION 'save_invoice: DELTA-B field-app share re-balance missing';
  END IF;
  -- DELTA-D: field invoices must lock customer_id (no payload-driven customer change)
  IF v_src NOT LIKE '%DELTA-D%'
     OR v_src NOT LIKE '%CASE WHEN invoice_type = ''field_application''%THEN customer_id%' THEN
    RAISE EXCEPTION 'save_invoice: DELTA-D customer-lock missing';
  END IF;
  -- DELTA-E: field invoices must sync total_cost_cents from the re-billed lines
  IF v_src NOT LIKE '%DELTA-E%'
     OR v_src NOT LIKE '%total_cost_cents = CASE WHEN invoice_type = ''field_application''%' THEN
    RAISE EXCEPTION 'save_invoice: DELTA-E field-app header cost sync missing';
  END IF;
  -- DELTA-F: invoice_type is a segregation boundary; can't be flipped in/out of field_application via save
  IF v_src NOT LIKE '%DELTA-F%'
     OR v_src NOT LIKE '%OR COALESCE(p_invoice->>''invoice_type'', invoice_type) = ''field_application''%' THEN
    RAISE EXCEPTION 'save_invoice: DELTA-F invoice_type lock missing';
  END IF;
  -- DELTA-G: field invoices preserve incoming (extended) line cost (skip per-unit product refresh)
  IF v_src NOT LIKE '%DELTA-G%'
     OR v_src NOT LIKE '%IS NOT NULL AND NOT v_is_field%' THEN
    RAISE EXCEPTION 'save_invoice: DELTA-G field line-cost preserve missing';
  END IF;
  -- DELTA-A2 hardened: the fee-line extended bypass is bounded by the rounding gap so a
  -- forged is_application_fee flag can't set an arbitrary line total (r14 P1)
  IF v_src NOT LIKE '%ABS((v_item->>''extended_cents'')::bigint - v_extended) <=%' THEN
    RAISE EXCEPTION 'save_invoice: DELTA-A2 forged-fee tolerance guard missing';
  END IF;
  -- the original order/blend new-invoice guard must remain (not weakened)
  IF v_src NOT LIKE '%Invoices must link to an order or blend ticket%' THEN
    RAISE EXCEPTION 'save_invoice: new-invoice order/blend guard went missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='save_invoice' AND pronamespace='public'::regnamespace
                 AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%') THEN
    RAISE EXCEPTION 'save_invoice must be SECURITY DEFINER with search_path';
  END IF;
END $$;
