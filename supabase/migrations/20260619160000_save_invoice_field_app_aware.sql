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
      customer_id = COALESCE((p_invoice->>'customer_id')::uuid, customer_id),
      invoice_type = COALESCE(p_invoice->>'invoice_type', invoice_type),
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
    -- DELTA-A2 (Codex): an is_application_fee line carries an EXACT extended_cents
    -- (the summed per-customer fee from transfer_job_to_invoice) but only a ROUNDED
    -- blended per-acre display rate, so quantity x unit_price != that exact total.
    -- Honor the client's extended_cents for the fee line so a no-op editor save
    -- can't drift the machine-fee total / grower shares by a rounding cent. Product
    -- lines stay recomputed from quantity x unit_price (anti-tamper, no rounding gap).
    IF COALESCE((v_item->>'is_application_fee')::boolean, false) THEN
      v_extended := COALESCE((v_item->>'extended_cents')::bigint, ROUND(v_qty * v_unit_price)::bigint);
    ELSE
      v_extended := ROUND(v_qty * v_unit_price)::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL THEN
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
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents, updated_at = now()
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
  -- the original order/blend new-invoice guard must remain (not weakened)
  IF v_src NOT LIKE '%Invoices must link to an order or blend ticket%' THEN
    RAISE EXCEPTION 'save_invoice: new-invoice order/blend guard went missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='save_invoice' AND pronamespace='public'::regnamespace
                 AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%') THEN
    RAISE EXCEPTION 'save_invoice must be SECURITY DEFINER with search_path';
  END IF;
END $$;
