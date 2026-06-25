-- 20260625150000_invoice_header_footer_discount.sql
-- Field-app parity #33: Header/footer notes, PO ref, due date, terms, discount-earned.
--
-- WHAT THIS ADDS (additive only — no existing object dropped, no generated column changed)
--   invoices.payment_terms        text     — ChemMan "Terms" (free text, printed)
--   invoices.internal_notes       text     — internal job/invoice memo, NOT printed
--   invoices.discount_earned_cents bigint  — early-pay "Discount Earned" amount (owner-entered;
--                                            DEFAULT 0 / "off"; >= 0 check). MONEY = bigint cents.
--   invoices.discount_date        date     — the early-pay discount date (optional)
--
-- The other four fields this section surfaces — header_notes, footer_notes,
-- purchase_order_ref, due_date — ALREADY exist on invoices (added in earlier
-- migrations) and already print on both PDF layouts; this section only wires the
-- editor inputs to them. The audit's "needs_migration: false" was based on those
-- four; the BACKLOG told us to verify, and payment_terms / internal_notes /
-- discount_earned_cents / discount_date are genuinely MISSING from invoices
-- (payment_terms lives on customers/vendor_bills, internal_notes on products —
-- never on invoices). So this small additive migration is required.
--
-- MONEY DISCIPLINE — "Discount Earned" is OWNER-DRIVEN, NOT a rule.
--   ChemMan's "Discount Earned" is an early-pay discount the office records per
--   customer. We store it as a manual owner-entered AMOUNT (bigint cents, DEFAULT
--   0 / blank), shown on the Customers tab and printed as an informational line.
--   We DO NOT invent a discount percentage or formula, and we DELIBERATELY do NOT
--   fold it into the billed total / balance: balance_cents is a GENERATED column
--   (total - paid - prepay - write_off) with no discount term, and the real
--   money reduction at early payment already flows through the existing
--   payment / write-off machinery (the #30 write-off line). Mutating the billed
--   total here would corrupt the penny-exact split engine and double-count the
--   reduction. So discount_earned_cents is a recorded + displayed figure only.
--   (Same hard rule as #32 fuel surcharge: never invent a billing rule.)
--
-- WHY AN RPC (not a raw frontend .update())
--   The live invoices_update RLS policy is USING is_admin() ONLY — a raw
--   .update() by a sales_rep matches zero rows and silently "fails" (the exact
--   bug 20260622030000 fixed for Applied Info). This SECURITY DEFINER RPC mirrors
--   that companion (update_field_app_applied_info): it re-gates on
--   (is_admin() OR is_sales_rep()), binds the actor to auth.uid(), and restricts
--   the write to editable (draft/unposted) field-application invoices, so it can
--   never touch a posted/voided row or a non-field invoice.
--
-- "Per customer" = per invoice. In a split, each customer already has their OWN
--   invoice row (save_field_app_invoice creates one invoice per customer in the
--   group). So the per-customer Discount Earned is a per-invoice value: the header
--   fields (PO/due/terms/notes/memo) apply uniformly to every group member, while
--   p_discounts carries the per-invoice {amount_cents, date} for each customer.
--
-- ROLLBACK:
--   DROP FUNCTION public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text);
--   ALTER TABLE public.invoices
--     DROP COLUMN IF EXISTS payment_terms,
--     DROP COLUMN IF EXISTS internal_notes,
--     DROP COLUMN IF EXISTS discount_earned_cents,
--     DROP COLUMN IF EXISTS discount_date;

-- ── 1. Additive columns ──────────────────────────────────────────────────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_terms          text,
  ADD COLUMN IF NOT EXISTS internal_notes         text,
  ADD COLUMN IF NOT EXISTS discount_earned_cents  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_date          date;

-- Money guard: an early-pay discount can never be negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.invoices'::regclass
       AND conname = 'invoices_discount_earned_nonneg'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_discount_earned_nonneg
      CHECK (discount_earned_cents >= 0);
  END IF;
END$$;

COMMENT ON COLUMN public.invoices.payment_terms IS
  'ChemMan "Terms" — free-text payment terms printed on the invoice. Distinct from customers.payment_terms (invoice-level override).';
COMMENT ON COLUMN public.invoices.internal_notes IS
  'Internal job/invoice memo. NOT printed on the customer copy (field-app parity #33).';
COMMENT ON COLUMN public.invoices.discount_earned_cents IS
  'Early-pay "Discount Earned" amount in cents (owner-entered; default 0/off). Informational/displayed — does NOT reduce the GENERATED balance_cents; real reduction flows through payments/write-off. Never a formula.';
COMMENT ON COLUMN public.invoices.discount_date IS
  'Early-pay discount date for the Discount Earned amount (optional).';

-- ── 2. SECURITY DEFINER billing-fields RPC ───────────────────────────────────
-- Mirrors update_field_app_applied_info: definer bypasses the admin-only
-- invoices_update RLS while re-gating on (is_admin() OR is_sales_rep()), binding
-- the actor, and restricting to editable field-application invoices. Header
-- fields apply to every id; p_discounts overrides the per-invoice discount.
CREATE OR REPLACE FUNCTION public.update_field_app_invoice_billing(
  p_invoice_ids        uuid[],
  p_purchase_order_ref text DEFAULT NULL,
  p_payment_terms      text DEFAULT NULL,
  p_header_notes       text DEFAULT NULL,
  p_due_date           date DEFAULT NULL,
  p_footer_notes       text DEFAULT NULL,
  p_internal_notes     text DEFAULT NULL,
  -- Per-invoice discount map: { "<invoice_id>": { "amount_cents": <bigint>, "date": "<YYYY-MM-DD|null>" }, ... }
  -- Any id absent from the map keeps amount 0 / date NULL (the column defaults).
  p_discounts          jsonb DEFAULT '{}'::jsonb,
  p_performed_by       uuid DEFAULT NULL,
  p_idempotency_key    text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid := auth.uid();
  v_expected int;
  v_updated  int;
  v_existing jsonb;
  v_result   jsonb;
  v_disc     jsonb := COALESCE(p_discounts, '{}'::jsonb);
  v_id       uuid;
  v_amount   bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoice billing details';
  END IF;

  v_expected := COALESCE(array_length(p_invoice_ids, 1), 0);
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'At least one invoice id is required';
  END IF;

  -- Validate any supplied discount amounts up-front (non-negative; matches the
  -- column CHECK). A blank/absent entry leaves the column at 0 (off).
  FOR v_id, v_amount IN
    SELECT key::uuid, COALESCE((value->>'amount_cents')::bigint, 0)
      FROM jsonb_each(v_disc)
  LOOP
    IF v_amount < 0 THEN
      RAISE EXCEPTION 'Discount Earned cannot be negative for invoice %', v_id;
    END IF;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'update_field_app_invoice_billing';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Header fields apply uniformly; the discount is resolved per-invoice from the
  -- map (absent id -> 0 / NULL). Only editable field-application invoices.
  UPDATE invoices i SET
    purchase_order_ref    = p_purchase_order_ref,
    payment_terms         = p_payment_terms,
    header_notes          = p_header_notes,
    due_date              = p_due_date,
    footer_notes          = p_footer_notes,
    internal_notes        = p_internal_notes,
    discount_earned_cents = COALESCE((v_disc -> i.id::text ->> 'amount_cents')::bigint, 0),
    discount_date         = (v_disc -> i.id::text ->> 'date')::date,
    updated_at            = now()
  WHERE i.id = ANY(p_invoice_ids)
    AND i.invoice_type = 'field_application'
    AND i.status IN ('draft', 'unposted');
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_expected THEN
    RAISE EXCEPTION 'Invoice billing update affected % of % invoice(s) — some are not editable field-application invoices', v_updated, v_expected;
  END IF;

  v_result := jsonb_build_object('updated', v_updated);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'update_field_app_invoice_billing', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text) TO authenticated;
