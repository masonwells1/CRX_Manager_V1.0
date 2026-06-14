-- Roadmap #2 (sell-side) — ship-now / price-later — v1a: schema + posting gate
-- ============================================================================
-- FILE-ONLY (NOT applied — apply at G5 go-live). First half of #2 v1; the
-- producer (create_rush_order) + Orders filter land in v1b. Shipping the gate
-- BEFORE any producer means there is never a window where an unpriced rush
-- order's invoice could post at $0. Dormant against today's data: every
-- existing order is 'priced' and every existing invoice/order_item pricing_*
-- flag defaults false/'priced', so the gate never fires until v1b creates a
-- needs_pricing order.
--
-- Changes:
--   1. orders.pricing_status   text NOT NULL DEFAULT 'priced'
--        CHECK (pricing_status IN ('priced','needs_pricing'))   [NEW constraint]
--   2. order_items.pricing_pending  boolean NOT NULL DEFAULT false
--   3. invoices.pricing_pending     boolean NOT NULL DEFAULT false
--   4. post_invoice()        — live body VERBATIM + PRICING_INCOMPLETE gate
--   5. post_invoice_group()  — live body VERBATIM + fail-fast PRICING_INCOMPLETE
--
-- Gate semantics (G3 = price-month; invoice_date handling lives in price_order, v2):
--   post_invoice raises PRICING_INCOMPLETE if the invoice is flagged pending OR
--   its linked order is 'needs_pricing'. Invoice CREATION stays allowed; only
--   POSTING is blocked until price_order clears the flags (v2).
--
-- Reviewed: rls-security + migration-drift + /codex-review. Rolled-back smoke:
-- docs/roadmap/smoke/02a-pricing-gate.sql (live-run deferred — read-only MCP).

-- ── 1-3. Columns (additive, idempotent) ────────────────────────────────────
ALTER TABLE public.orders       ADD COLUMN IF NOT EXISTS pricing_status  text    NOT NULL DEFAULT 'priced';
ALTER TABLE public.order_items  ADD COLUMN IF NOT EXISTS pricing_pending boolean NOT NULL DEFAULT false;
ALTER TABLE public.invoices     ADD COLUMN IF NOT EXISTS pricing_pending boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_pricing_status_check') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_pricing_status_check CHECK (pricing_status IN ('priced','needs_pricing'));
  END IF;
END $$;

-- ── 4. post_invoice() — verbatim live body + PRICING_INCOMPLETE gate ────────
CREATE OR REPLACE FUNCTION public.post_invoice(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_inv record; v_order_status text; v_order_pricing text; v_existing jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  PERFORM check_period_open(v_inv.invoice_date);
  IF v_inv.status NOT IN ('draft', 'unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
  -- PRICING_INCOMPLETE gate (sell-side #2): never post an invoice for a still-
  -- unpriced rush order. Cleared by price_order (v2). Dormant until v1b.
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.order_id IS NOT NULL THEN
    SELECT status, pricing_status INTO v_order_status, v_order_pricing FROM orders WHERE id = v_inv.order_id;
    IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot post invoice — linked order % is cancelled', v_inv.order_id; END IF;
    IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  END IF;
  SET LOCAL app.admin_override = 'true';
  UPDATE invoices SET status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now() WHERE id = p_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_id, (SELECT role FROM profiles WHERE id = auth.uid()), jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'posted', 'posted_at', now()::text), v_inv.total_amount_cents, 'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2));
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted', 'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2), auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  PERFORM generate_rup_sales_records(p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_invoice', jsonb_build_object('success', true, 'invoice_id', p_invoice_id));
  END IF;
END;
$function$;

-- ── 5. post_invoice_group() — verbatim live body + fail-fast gate ───────────
CREATE OR REPLACE FUNCTION public.post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_inv            record;
  v_posted_ids     uuid[] := '{}';
  v_total_cents    bigint := 0;
  v_member_count   int := 0;
  v_result         jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to post invoice groups';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'post_invoice_group';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_group_id IS NULL THEN RAISE EXCEPTION 'invoice_group_id is required'; END IF;

  PERFORM 1 FROM invoices WHERE invoice_group_id = p_invoice_group_id FOR UPDATE;

  SELECT COUNT(*) INTO v_member_count FROM invoices WHERE invoice_group_id = p_invoice_group_id;
  IF v_member_count = 0 THEN RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id; END IF;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id
  LOOP
    IF v_inv.status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot post group — invoice % has status %', v_inv.invoice_number, v_inv.status;
    END IF;
    -- PRICING_INCOMPLETE gate (sell-side #2): fail fast before posting any member;
    -- post_invoice() (called below) also enforces the order-level check.
    IF v_inv.pricing_pending THEN
      RAISE EXCEPTION 'PRICING_INCOMPLETE';
    END IF;
    PERFORM check_period_open(v_inv.invoice_date);
  END LOOP;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id ORDER BY invoice_number
  LOOP
    PERFORM post_invoice(v_inv.id, NULL);
    v_posted_ids := array_append(v_posted_ids, v_inv.id);
    v_total_cents := v_total_cents + v_inv.total_amount_cents;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('invoice_group_posted',
          'Posted ' || v_member_count || ' invoice(s) in group — total $' ||
            (v_total_cents / 100.0)::numeric(12,2),
          p_performed_by, 'invoice', v_posted_ids[1]);

  v_result := jsonb_build_object(
    'posted_invoice_ids', to_jsonb(v_posted_ids),
    'invoice_group_id',   p_invoice_group_id,
    'total_posted_cents', v_total_cents,
    'member_count',       v_member_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'post_invoice_group', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
