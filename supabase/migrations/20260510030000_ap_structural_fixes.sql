-- idempotency-body-check: exempt
-- All three RPCs use the check_idempotency() / save_idempotency() helpers which
-- internally read/write idempotency_keys. The body-check hook can't see through
-- the helper indirection.
--
-- ============================================================================
-- PR-04: AP RPC trio + structural fixes (HIGH RISK)
--
-- This migration consolidates 7 related AP-system fixes into one cohesive
-- change. Reviewer should walk through the blocks in order:
--
--   Block 1 — Schema:   add void columns to vendor_bills + vendor_payments,
--                       convert vendor_bills.balance_cents → GENERATED ALWAYS,
--                       add UNIQUE partial index on (vendor_id, bill_number),
--                       expand financial_audit_log CHECK constraints
--   Block 2 — RLS:      tighten vendors_select to admin/sales_rep only
--   Block 3 — RPC:      rewrite create_vendor_bill (idempotency, period guard,
--                       vendor active check, audit log)
--   Block 4 — RPC:      rewrite record_vendor_payment (idempotency, audit log;
--                       remove manual balance_cents write since it's GENERATED)
--   Block 5 — RPC:      rewrite void_vendor_bill (idempotency, paid-bill guard,
--                       new void columns, audit log)
--   Block 6 — Verify
--
-- Risk inventory (Mason should review before applying):
--   1. balance_cents column type change. The DROP + ADD GENERATED dance
--      preserves no data, but the value is computable (total - paid). All
--      existing rows recompute identically.
--   2. RLS change. Old: any authenticated user could SELECT vendors. New:
--      only admin or sales_rep. If any UI used vendor lookups for non-AR roles
--      (drivers, applicators), those reads will start returning 0 rows.
--   3. CHECK constraint expansion is additive only — old values still allowed.
--
-- Idempotency: all three RPCs gain p_idempotency_key wiring via the canonical
-- check_idempotency() / save_idempotency() helper pattern (CLAUDE.md).
-- ============================================================================


-- ============================================================================
-- Block 1 — Schema migrations
-- ============================================================================

-- 1a. Soft-delete columns on vendor_bills
ALTER TABLE public.vendor_bills
  ADD COLUMN IF NOT EXISTS voided_at  timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by  uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS void_reason text;

-- 1b. Soft-delete columns on vendor_payments (prep for PR-13's void_vendor_payment)
ALTER TABLE public.vendor_payments
  ADD COLUMN IF NOT EXISTS voided_at  timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by  uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS void_reason text;

-- 1c. Convert vendor_bills.balance_cents to GENERATED ALWAYS.
--     The current column is plain bigint with values stored. The formula is
--     simple (total_cents - paid_cents) and matches what record_vendor_payment
--     was manually maintaining. After this change, no code can write to
--     balance_cents — it's auto-derived.
ALTER TABLE public.vendor_bills
  DROP COLUMN balance_cents;

ALTER TABLE public.vendor_bills
  ADD COLUMN balance_cents bigint
    GENERATED ALWAYS AS (total_cents - COALESCE(paid_cents, 0)) STORED;

-- 1d. UNIQUE partial index — prevent duplicate (vendor, bill_number) for active bills.
--     Allows the same bill_number across different vendors and across voided/deleted bills.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_bills_vendor_bill_number_active
  ON public.vendor_bills (vendor_id, bill_number)
  WHERE deleted_at IS NULL AND status <> 'voided';

-- 1e. Expand financial_audit_log CHECK constraints to allow vendor entity types
--     and the operations the new RPCs will emit. Additive only — existing values
--     still pass.
ALTER TABLE public.financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_entity_type_check;

ALTER TABLE public.financial_audit_log
  ADD CONSTRAINT financial_audit_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'invoice','payment','split','prepay','prepay_credit','customer','order',
    'delivery','write_off','finance_charge','credit_memo','return',
    'allocation_set','void','batch','commission_payment','cycle_count',
    'blend_ticket',
    -- New for PR-04:
    'vendor_bill','vendor_payment','purchase_order'
  ]));

ALTER TABLE public.financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_operation_type_check;

ALTER TABLE public.financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK (operation_type = ANY (ARRAY[
    'invoice_created','invoice_posted','invoice_voided','invoice_cancelled',
    'invoice_updated','invoice_deleted','invoice_marked_overdue',
    'payment_recorded','payment_allocation','payment_voided','split_modified',
    'split_invoices_generated','prepay_created','prepay_applied',
    'prepay_credit_created','prepay_batch_applied','prepay_edited',
    'prepay_deleted','prepay_reconciliation','batch_prepay_apply',
    'write_off_recorded','write_off_reversed','write_off_applied',
    'finance_charge','finance_charge_generated','finance_charge_voided',
    'credit_memo_created','credit_memo_applied','credit_memo_unapplied',
    'return_created','return_approved','return_received','return_credit_issued',
    'order_updated','order_voided','order_cancelled','order_restored',
    'delivery_updated','delivery_cancelled','delivery_voided','delivery_restored',
    'blend_ticket_linked','blend_ticket_unlinked',
    'commission_payment_created','commission_payment_posted','commission_payment_voided',
    'batch_post','batch_void','batch_payment','period_reopened',
    'quote_status_reverted','blend_ticket_approval_reversed','cycle_count_completed',
    -- New for PR-04 (and PR-13/PR-14 reservation):
    'vendor_bill_created','vendor_bill_voided','vendor_bill_updated',
    'vendor_payment_recorded','vendor_payment_voided'
  ]));


-- ============================================================================
-- Block 2 — vendors_select RLS tightening
-- ============================================================================
-- Old policy was USING (deleted_at IS NULL) — any authenticated user could
-- read vendors. New policy: admin and sales_rep only. Drivers + applicators
-- have no business reading vendor records.

DROP POLICY IF EXISTS vendors_select ON public.vendors;

CREATE POLICY vendors_select ON public.vendors
  FOR SELECT
  USING (
    deleted_at IS NULL
    -- (codex audit F6, 2026-05-10): use (SELECT auth.uid()) so the function
    -- is evaluated once per query rather than per row. Project convention
    -- per RLS_SECURITY_GUIDE.md.
    AND (SELECT role FROM public.profiles WHERE id = (SELECT auth.uid()))
        IN ('admin', 'sales_rep')
  );


-- ============================================================================
-- Block 3 — Rewrite create_vendor_bill
-- ============================================================================
-- Adds: canonical idempotency, closed-period guard, vendor-active check,
--       financial_audit_log INSERT.
-- Signature unchanged.

CREATE OR REPLACE FUNCTION public.create_vendor_bill(
  p_vendor_id          uuid,
  p_purchase_order_id  uuid    DEFAULT NULL,
  p_bill_number        text    DEFAULT '',
  p_bill_date          date    DEFAULT CURRENT_DATE,
  p_due_date           date    DEFAULT NULL,
  p_payment_terms      text    DEFAULT NULL,
  p_subtotal_cents     bigint  DEFAULT 0,
  p_adjustment_cents   bigint  DEFAULT 0,
  p_notes              text    DEFAULT NULL,
  p_idempotency_key    text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total       bigint;
  v_bill_id     uuid;
  v_terms_days  integer;
  v_terms       text;
  v_actor       uuid;
  v_actor_role  text;
  v_existing    jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;

  -- Idempotency check (canonical pattern)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_vendor_bill');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'bill_id')::uuid;
    END IF;
  END IF;

  -- Closed-period guard — vendor bill creation is the AP equivalent of
  -- invoice posting. Reject if the bill_date falls in a closed period.
  PERFORM check_period_open(p_bill_date);

  -- Vendor active check (avoid creating bills against deleted/inactive vendors)
  IF NOT EXISTS (
    SELECT 1 FROM vendors
    WHERE id = p_vendor_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;

  -- Subtotal sanity check
  IF p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;

  -- Resolve payment terms
  IF p_payment_terms IS NULL THEN
    SELECT default_payment_terms, default_payment_terms_days
      INTO v_terms, v_terms_days
      FROM vendors WHERE id = p_vendor_id;
  ELSE
    v_terms := p_payment_terms;
    v_terms_days := CASE
      WHEN p_payment_terms ILIKE '%90%' THEN 90
      WHEN p_payment_terms ILIKE '%60%' THEN 60
      WHEN p_payment_terms ILIKE '%45%' THEN 45
      WHEN p_payment_terms ILIKE '%30%' THEN 30
      WHEN p_payment_terms ILIKE '%15%' THEN 15
      WHEN p_payment_terms ILIKE '%10%' THEN 10
      ELSE 30
    END;
  END IF;

  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  -- (codex audit F4, 2026-05-10): reject zero-or-negative computed totals.
  -- After PR-15's parseDollarsToCents fix preserves negatives, a UI input
  -- of subtotal $100 + adjustment -$200 now produces a real -$100 total,
  -- which would create a stuck/misleading AP record. The subtotal>0 check
  -- above isn't sufficient on its own — adjustments can flip the sign.
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_total;
  END IF;

  -- Insert bill (balance_cents now GENERATED — do NOT include in column list)
  INSERT INTO vendor_bills (
    vendor_id, purchase_order_id, bill_number, bill_date, due_date,
    payment_terms, subtotal_cents, adjustment_cents, total_cents,
    paid_cents, status, notes, created_by
  ) VALUES (
    p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date,
    COALESCE(p_due_date, p_bill_date + (COALESCE(v_terms_days, 30) || ' days')::interval),
    v_terms, p_subtotal_cents, COALESCE(p_adjustment_cents, 0), v_total,
    0, 'unpaid', p_notes, v_actor
  )
  RETURNING id INTO v_bill_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'vendor_bill_created', 'vendor_bill', v_bill_id, v_actor, v_actor_role,
    jsonb_build_object(
      'vendor_id', p_vendor_id,
      'purchase_order_id', p_purchase_order_id,
      'bill_number', p_bill_number,
      'bill_date', p_bill_date,
      'total_cents', v_total
    ),
    v_total,
    'Vendor bill ' || COALESCE(NULLIF(p_bill_number, ''), v_bill_id::text) ||
      ' created for $' || (v_total / 100.0)::numeric(12,2)
  );

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'create_vendor_bill',
      jsonb_build_object('bill_id', v_bill_id)
    );
  END IF;

  RETURN v_bill_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text) TO authenticated;


-- ============================================================================
-- Block 4 — Rewrite record_vendor_payment
-- ============================================================================
-- Adds: canonical idempotency, audit log.
-- Removes: manual balance_cents UPDATE (the column is now GENERATED).
-- Signature unchanged.

CREATE OR REPLACE FUNCTION public.record_vendor_payment(
  p_vendor_bill_id    uuid,
  p_amount_cents      bigint,
  p_payment_date      date    DEFAULT CURRENT_DATE,
  p_payment_method    text    DEFAULT NULL,
  p_reference_number  text    DEFAULT NULL,
  p_notes             text    DEFAULT NULL,
  p_idempotency_key   text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment_id      uuid;
  v_bill            record;
  v_new_paid        bigint;
  v_new_status      text;
  v_actor           uuid;
  v_actor_role      text;
  v_existing        jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to record vendor payments';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'record_vendor_payment');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'payment_id')::uuid;
    END IF;
  END IF;

  -- Lock and fetch bill
  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id;
  END IF;

  IF v_bill.status = 'voided' THEN
    RAISE EXCEPTION 'BILL_VOIDED: cannot record payment on a voided bill';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: payment amount must be positive';
  END IF;

  IF p_amount_cents > v_bill.balance_cents THEN
    RAISE EXCEPTION 'OVER_PAYMENT: payment of $% exceeds remaining balance $%',
      (p_amount_cents / 100.0)::numeric(12,2),
      (v_bill.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- Insert payment
  INSERT INTO vendor_payments (
    vendor_bill_id, payment_date, amount_cents, payment_method,
    reference_number, notes, created_by
  ) VALUES (
    p_vendor_bill_id, p_payment_date, p_amount_cents, p_payment_method,
    p_reference_number, p_notes, v_actor
  )
  RETURNING id INTO v_payment_id;

  v_new_paid := COALESCE(v_bill.paid_cents, 0) + p_amount_cents;
  v_new_status := CASE
    WHEN v_new_paid >= v_bill.total_cents THEN 'paid'
    WHEN v_new_paid > 0 THEN 'partially_paid'
    ELSE 'unpaid'
  END;

  -- Update only the columns we own. balance_cents is GENERATED (omit it).
  UPDATE vendor_bills SET
    paid_cents = v_new_paid,
    status     = v_new_status,
    updated_at = now()
  WHERE id = p_vendor_bill_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'vendor_payment_recorded', 'vendor_payment', v_payment_id, v_actor, v_actor_role,
    jsonb_build_object(
      'vendor_bill_id', p_vendor_bill_id,
      'amount_cents', p_amount_cents,
      'payment_method', p_payment_method,
      'reference_number', p_reference_number,
      'new_bill_status', v_new_status
    ),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
      ' on vendor bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_vendor_bill_id::text)
  );

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'record_vendor_payment',
      jsonb_build_object('payment_id', v_payment_id)
    );
  END IF;

  RETURN v_payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) TO authenticated;


-- ============================================================================
-- Block 5 — Rewrite void_vendor_bill
-- ============================================================================
-- Adds: canonical idempotency, paid-bill guard (Q11 hard-block), populates
--       voided_at/voided_by/void_reason columns instead of stuffing reason
--       into notes, audit log INSERT.
-- Signature unchanged.

CREATE OR REPLACE FUNCTION public.void_vendor_bill(
  p_vendor_bill_id   uuid,
  p_reason           text    DEFAULT NULL,
  p_idempotency_key  text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bill            record;
  v_actor           uuid;
  v_actor_role      text;
  v_existing        jsonb;
  v_active_payments int;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to void vendor bills';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: void requires a reason string';
  END IF;

  -- Idempotency check (returns void, so we just short-circuit on cache hit)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_vendor_bill');
    IF v_existing IS NOT NULL THEN
      RETURN;
    END IF;
  END IF;

  -- Lock and fetch bill
  SELECT * INTO v_bill FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id;
  END IF;

  IF v_bill.status = 'voided' THEN
    RAISE EXCEPTION 'BILL_ALREADY_VOIDED';
  END IF;

  -- Q11 hard-block: cannot void a paid bill that has active (non-voided)
  -- payments. The user must void each payment individually first
  -- (PR-13 will add void_vendor_payment for that flow).
  SELECT count(*) INTO v_active_payments
    FROM vendor_payments
   WHERE vendor_bill_id = p_vendor_bill_id
     AND voided_at IS NULL;

  -- (codex audit F3, 2026-05-10): block voiding ANY bill with active
  -- payments, not just `status = 'paid'`. The previous predicate let
  -- partially_paid bills slip through with active payments still attached,
  -- producing a voided bill with live payment rows — an inconsistent AP
  -- audit trail.
  IF v_active_payments > 0 THEN
    RAISE EXCEPTION
      'BILL_HAS_ACTIVE_PAYMENTS: bill has % active payment(s); void each payment first',
      v_active_payments;
  END IF;

  -- Mark voided. Populate the new columns; leave notes alone (the void
  -- reason now lives in void_reason, not stuffed into notes).
  UPDATE vendor_bills SET
    status      = 'voided',
    voided_at   = now(),
    voided_by   = v_actor,
    void_reason = p_reason,
    updated_at  = now()
  WHERE id = p_vendor_bill_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'vendor_bill_voided', 'vendor_bill', p_vendor_bill_id, v_actor, v_actor_role,
    jsonb_build_object('status', v_bill.status),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -v_bill.total_cents,
    'Vendor bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_vendor_bill_id::text) ||
      ' voided: ' || p_reason
  );

  -- Save idempotency (store a marker since we return void)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'void_vendor_bill',
      jsonb_build_object('voided', true, 'bill_id', p_vendor_bill_id)
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_vendor_bill(uuid, text, text) TO authenticated;


-- ============================================================================
-- Block 6 — Verification
-- ============================================================================
DO $$
DECLARE
  c_create int;
  c_record int;
  c_void   int;
  has_voided_at_bills bool;
  has_voided_at_pay   bool;
  has_balance_gen     bool;
  has_unique_idx      bool;
BEGIN
  -- Function overloads
  SELECT count(*) INTO c_create FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='create_vendor_bill';
  SELECT count(*) INTO c_record FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='record_vendor_payment';
  SELECT count(*) INTO c_void FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='void_vendor_bill';
  IF c_create != 1 THEN RAISE EXCEPTION 'create_vendor_bill has % overloads (expected 1)', c_create; END IF;
  IF c_record != 1 THEN RAISE EXCEPTION 'record_vendor_payment has % overloads (expected 1)', c_record; END IF;
  IF c_void != 1 THEN RAISE EXCEPTION 'void_vendor_bill has % overloads (expected 1)', c_void; END IF;

  -- Schema changes landed
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='vendor_bills' AND column_name='voided_at'
  ) INTO has_voided_at_bills;
  IF NOT has_voided_at_bills THEN RAISE EXCEPTION 'vendor_bills.voided_at column missing'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='vendor_payments' AND column_name='voided_at'
  ) INTO has_voided_at_pay;
  IF NOT has_voided_at_pay THEN RAISE EXCEPTION 'vendor_payments.voided_at column missing'; END IF;

  SELECT (is_generated = 'ALWAYS') INTO has_balance_gen
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='vendor_bills' AND column_name='balance_cents';
  IF NOT COALESCE(has_balance_gen, false) THEN
    RAISE EXCEPTION 'vendor_bills.balance_cents is not GENERATED ALWAYS';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='vendor_bills'
      AND indexname='uq_vendor_bills_vendor_bill_number_active'
  ) INTO has_unique_idx;
  IF NOT has_unique_idx THEN RAISE EXCEPTION 'unique partial index missing'; END IF;
END $$;
