-- Roadmap #2 v1a — PRICING_INCOMPLETE posting gate — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- Proves migration 20260613170000: an invoice for a still-unpriced rush order
-- cannot POST, while a normal priced invoice passes the gate.
--   P1  order pricing_status='needs_pricing' + linked draft invoice -> post_invoice raises PRICING_INCOMPLETE
--   P2  priced order + invoice.pricing_pending=true                 -> post_invoice raises PRICING_INCOMPLETE
--   P3  priced order + non-pending invoice                          -> post_invoice does NOT raise PRICING_INCOMPLETE (gate permissive)
--
-- Self-contained: adds the columns + installs the NEW gated post_invoice body
-- IN-TRANSACTION (so it tests the to-be-applied logic, not the currently-live
-- one), runs the scenarios, then RAISEs to roll EVERYTHING back (columns,
-- function, rows). ZERO prod footprint; safe against production. Impersonates an
-- active admin via the JWT claim so auth.uid()/role checks pass.
--
-- NOTE (2026-06-13): the build-loop session's Supabase MCP is READ-ONLY, so this
-- was not executed live there; the migration was verified by rls-security +
-- migration-drift reviewers and /codex-review, plus live-definition inspection.
-- Run from a write-capable session for the live PASS line.

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  o_np uuid; o_pr uuid; inv1 uuid; inv2 uuid; inv3 uuid;
  out text := ''; v_caught text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  ALTER TABLE public.orders       ADD COLUMN IF NOT EXISTS pricing_status  text    NOT NULL DEFAULT 'priced';
  ALTER TABLE public.order_items  ADD COLUMN IF NOT EXISTS pricing_pending boolean NOT NULL DEFAULT false;
  ALTER TABLE public.invoices     ADD COLUMN IF NOT EXISTS pricing_pending boolean NOT NULL DEFAULT false;

  -- Install the NEW gated post_invoice body in-transaction (mirrors the migration).
  CREATE OR REPLACE FUNCTION public.post_invoice(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
  AS $fn$
  DECLARE v_inv record; v_order_status text; v_order_pricing text; v_existing jsonb;
  BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')) THEN
      RAISE EXCEPTION 'Not authorized to post invoices'; END IF;
    IF p_idempotency_key IS NOT NULL THEN
      v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
      IF v_existing IS NOT NULL THEN RETURN; END IF;
    END IF;
    SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
    PERFORM check_period_open(v_inv.invoice_date);
    IF v_inv.status NOT IN ('draft','unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
    IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
    IF v_inv.order_id IS NOT NULL THEN
      SELECT status, pricing_status INTO v_order_status, v_order_pricing FROM orders WHERE id = v_inv.order_id;
      IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot post invoice — linked order % is cancelled', v_inv.order_id; END IF;
      IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
    END IF;
    SET LOCAL app.admin_override = 'true';
    UPDATE invoices SET status='posted', posted_by=auth.uid(), posted_at=now(), updated_at=now() WHERE id=p_invoice_id;
    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
    VALUES ('invoice_posted','invoice',p_invoice_id,(SELECT role FROM profiles WHERE id=auth.uid()),jsonb_build_object('status',v_inv.status),jsonb_build_object('status','posted','posted_at',now()::text),v_inv.total_amount_cents,'Posted '||v_inv.invoice_number);
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_posted','Posted '||v_inv.invoice_number,auth.uid(),'invoice',p_invoice_id,v_inv.customer_id);
    PERFORM generate_rup_sales_records(p_invoice_id);
  END;
  $fn$;

  -- P1: needs_pricing order + linked draft invoice -> blocked
  INSERT INTO orders (order_number, customer_id, status, pricing_status)
    VALUES ('SMOKE-NP', v_cust, 'confirmed', 'needs_pricing') RETURNING id INTO o_np;
  INSERT INTO invoices (customer_id, order_id, status) VALUES (v_cust, o_np, 'draft') RETURNING id INTO inv1;
  BEGIN
    PERFORM post_invoice(inv1, NULL); v_caught := 'NO-EXCEPTION';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P1 order-needs-pricing: "%s" -> %s | ', left(v_caught,30),
    CASE WHEN v_caught='PRICING_INCOMPLETE' THEN 'PASS' ELSE 'FAIL' END);

  -- P2: priced order + invoice.pricing_pending=true -> blocked
  INSERT INTO orders (order_number, customer_id, status, pricing_status)
    VALUES ('SMOKE-PRPEND', v_cust, 'confirmed', 'priced') RETURNING id INTO o_pr;
  INSERT INTO invoices (customer_id, order_id, status, pricing_pending) VALUES (v_cust, o_pr, 'draft', true) RETURNING id INTO inv2;
  BEGIN
    PERFORM post_invoice(inv2, NULL); v_caught := 'NO-EXCEPTION';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P2 invoice-pending: "%s" -> %s | ', left(v_caught,30),
    CASE WHEN v_caught='PRICING_INCOMPLETE' THEN 'PASS' ELSE 'FAIL' END);

  -- P3: priced order + non-pending invoice -> gate permissive (NOT blocked)
  INSERT INTO invoices (customer_id, order_id, status) VALUES (v_cust, o_pr, 'draft') RETURNING id INTO inv3;
  BEGIN
    PERFORM post_invoice(inv3, NULL); v_caught := 'POSTED-OK';
  EXCEPTION WHEN OTHERS THEN v_caught := SQLERRM; END;
  out := out || format('P3 priced-permissive: "%s" -> %s', left(v_caught,30),
    CASE WHEN v_caught <> 'PRICING_INCOMPLETE' THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;
