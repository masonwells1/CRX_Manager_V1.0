-- ============================================================================
-- Migration: 20260316100002_return_credit_ar_integration.sql
-- Purpose:   Replace the stub issue_return_credit() with a real implementation
--            that creates credit memo invoices (negative totals) to reduce AR.
--
-- What this does:
--   Part A: Add missing 'credited_by' column to returns table
--   Part B: Create credit memo number sequence
--   Part C: Expand invoice_type CHECK to include 'credit_memo'
--   Part D: Add 'credit_memo' case to next_invoice_number()
--   Part E: Replace issue_return_credit() with full credit-memo-creating version
--
-- Convention: Money in bigint cents, SECURITY DEFINER, FOR UPDATE locks,
--             financial_audit_log for all financial changes.
-- ============================================================================

-- ============================================================================
-- Part A: Add missing column to returns table
-- The returns table already has credit_invoice_id, total_credit_cents,
-- and credited_at. It is missing credited_by (who issued the credit).
-- ============================================================================

ALTER TABLE public.returns
  ADD COLUMN IF NOT EXISTS credited_by uuid REFERENCES auth.users(id);

-- ============================================================================
-- Part B: Create a sequence for credit memo invoice numbers (CM-YYYY-NNNN)
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.cm_invoice_number_seq START 1;

-- ============================================================================
-- Part C: Expand the invoice_type CHECK constraint to include 'credit_memo'
-- The original constraint only allows: chemical_sale, field_application, misc_charge.
-- Credit memo invoices need their own type so they can be filtered/reported.
-- ============================================================================

-- Drop the existing inline CHECK constraint.
-- PostgreSQL names inline CHECK constraints as: {table}_{column}_check
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_invoice_type_check
  CHECK (invoice_type IN (
    'chemical_sale', 'field_application', 'misc_charge', 'credit_memo'
  ));

-- ============================================================================
-- Part D: Replace next_invoice_number() to handle credit_memo type
-- Adds CM prefix case using cm_invoice_number_seq.
-- Preserves existing prefixes: CS, MC, INV.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.next_invoice_number(p_invoice_type text DEFAULT 'field_application')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text := extract(year FROM now())::text;
  v_seq  int;
  v_prefix text;
BEGIN
  CASE p_invoice_type
    WHEN 'chemical_sale' THEN
      v_prefix := 'CS';
      v_seq := nextval('cs_invoice_number_seq');
    WHEN 'misc_charge' THEN
      v_prefix := 'MC';
      v_seq := nextval('mc_invoice_number_seq');
    WHEN 'credit_memo' THEN
      v_prefix := 'CM';
      v_seq := nextval('cm_invoice_number_seq');
    ELSE
      -- field_application or any other type
      v_prefix := 'INV';
      v_seq := nextval('invoice_number_seq');
  END CASE;

  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END;
$$;

-- ============================================================================
-- Part E: Replace issue_return_credit() — the real implementation
--
-- This replaces the stub that only updated the return record. The new version:
--   1. Locks the return row with FOR UPDATE
--   2. Validates status is 'received' (ready for credit)
--   3. Enforces accounting period via check_period_open()
--   4. Calculates total credit from return_items (sum of quantity * unit_price_cents)
--   5. Generates a credit memo number (CM-YYYY-NNNN)
--   6. Creates a NEGATIVE invoice (total_amount_cents = -total) to reduce AR
--      - balance_cents is GENERATED ALWAYS AS (total - paid - prepay) → auto-computed
--   7. Updates return status to 'credited' with credit_invoice_id link
--   8. Logs to financial_audit_log (two entries: credit_memo_created + return_credit_issued)
--   9. Returns jsonb with credit details
-- ============================================================================

-- Must DROP first because the return type changes from void → jsonb.
-- CREATE OR REPLACE cannot change a function's return type.
DROP FUNCTION IF EXISTS public.issue_return_credit(uuid, uuid);
DROP FUNCTION IF EXISTS public.issue_return_credit(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.issue_return_credit(
  p_return_id uuid,
  p_actor_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_return       record;
  v_total        bigint;
  v_invoice_id   uuid;
  v_invoice_num  text;
  v_customer_id  uuid;
  v_order_id     uuid;
  v_return_number text;
  v_salesman_id  uuid;
BEGIN
  -- ── Step 1: Lock the return row and validate status ──────────────────
  SELECT r.id, r.status, r.customer_id, r.order_id, r.return_number
    INTO v_return
    FROM public.returns r
   WHERE r.id = p_return_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return % not found', p_return_id;
  END IF;

  IF v_return.status <> 'received' THEN
    RAISE EXCEPTION 'Return % is in status "%" — must be "received" to issue credit',
      p_return_id, v_return.status;
  END IF;

  v_customer_id   := v_return.customer_id;
  v_order_id      := v_return.order_id;
  v_return_number := v_return.return_number;

  -- ── Step 2: Enforce accounting period ────────────────────────────────
  PERFORM public.check_period_open(CURRENT_DATE);

  -- ── Step 3: Calculate total credit from return items ─────────────────
  -- Uses extended_cents (quantity * unit_price_cents) already computed on each item.
  SELECT COALESCE(SUM(ri.extended_cents), 0)
    INTO v_total
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Return % has no items or zero credit amount', p_return_id;
  END IF;

  -- ── Step 4: Generate credit memo number ──────────────────────────────
  v_invoice_num := public.next_invoice_number('credit_memo');

  -- ── Step 5: Look up salesman from the order (if linked) ──────────────
  IF v_order_id IS NOT NULL THEN
    SELECT o.salesman_id INTO v_salesman_id
      FROM public.orders o
     WHERE o.id = v_order_id;
  END IF;

  -- ── Step 6: Create negative credit memo invoice ──────────────────────
  -- IMPORTANT: balance_cents is GENERATED ALWAYS AS
  --   (total_amount_cents - paid_amount_cents - prepay_applied_cents)
  -- so we do NOT set it. A negative total_amount_cents with zero paid/prepay
  -- produces a negative balance, which naturally reduces customer AR.
  INSERT INTO public.invoices (
    invoice_number,
    order_id,
    customer_id,
    invoice_type,
    status,
    season,
    salesman_id,
    created_by,
    total_amount_cents,
    paid_amount_cents,
    prepay_applied_cents,
    posted_by,
    posted_at,
    invoice_date,
    due_date,
    header_notes,
    parent_invoice_id
  ) VALUES (
    v_invoice_num,
    v_order_id,                              -- link to originating order (nullable)
    v_customer_id,
    'credit_memo',
    'posted',                                -- credit memos are auto-posted
    public.current_season(),
    v_salesman_id,
    p_actor_id,
    -v_total,                                -- NEGATIVE amount reduces AR
    0,                                       -- no payments against a credit
    0,                                       -- no prepay against a credit
    p_actor_id,                              -- auto-posted by the issuer
    now(),                                   -- posted immediately
    CURRENT_DATE,
    CURRENT_DATE,                            -- due immediately (credit)
    'Credit memo for return ' || v_return_number,
    NULL                                     -- no parent invoice
  )
  RETURNING id INTO v_invoice_id;

  -- ── Step 7: Update return to 'credited' with link to credit invoice ──
  UPDATE public.returns
     SET status             = 'credited',
         total_credit_cents = v_total,
         credit_invoice_id  = v_invoice_id,
         credited_at        = now(),
         credited_by        = p_actor_id,
         updated_at         = now()
   WHERE id = p_return_id;

  -- ── Step 8: Log to financial_audit_log (two entries) ─────────────────
  -- Entry 1: Credit memo invoice created
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description,
    new_values
  ) VALUES (
    'credit_memo_created',
    'credit_memo',
    v_invoice_id,
    p_actor_id,
    -v_total,
    'Credit memo ' || v_invoice_num || ' created for return ' || v_return_number,
    jsonb_build_object(
      'invoice_id', v_invoice_id,
      'invoice_number', v_invoice_num,
      'return_id', p_return_id,
      'return_number', v_return_number,
      'customer_id', v_customer_id,
      'credit_amount_cents', v_total
    )
  );

  -- Entry 2: Return credit issued (links return → credit memo)
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description,
    new_values
  ) VALUES (
    'return_credit_issued',
    'return',
    p_return_id,
    p_actor_id,
    -v_total,
    'Credit issued for return ' || v_return_number || ' → invoice ' || v_invoice_num,
    jsonb_build_object(
      'credit_invoice_id', v_invoice_id,
      'credit_invoice_number', v_invoice_num,
      'credit_amount_cents', v_total,
      'customer_id', v_customer_id
    )
  );

  -- ── Step 9: Return result ────────────────────────────────────────────
  RETURN jsonb_build_object(
    'success', true,
    'return_id', p_return_id,
    'return_number', v_return_number,
    'credit_invoice_id', v_invoice_id,
    'credit_invoice_number', v_invoice_num,
    'credit_amount_cents', v_total,
    'customer_id', v_customer_id,
    'credited_at', now()
  );
END;
$$;

-- Grant execute to authenticated users (RLS on underlying tables handles authorization)
GRANT EXECUTE ON FUNCTION public.issue_return_credit(uuid, uuid, text) TO authenticated;
