-- ============================================================================
-- Codex review fix for PR #59 (P1, 2026-05-12) — Restore 'payment_allocated'
-- in financial_audit_log.operation_type CHECK constraint.
-- ============================================================================
-- allocate_payment's installed body (20260430260000_field_app_workflow_phase14.sql:177)
-- INSERTs a financial_audit_log row with operation_type = 'payment_allocated'
-- (past tense). PR-04 (20260510030000_ap_structural_fixes.sql) rewrote the
-- CHECK and replaced that value with the noun form 'payment_allocation', then
-- 20260512000000_quick_delivery_server_pricing_and_audit_log.sql re-DROPped
-- and re-ADDed the CHECK keeping the noun form.
--
-- Net effect: every allocate_payment call fails the operation_type CHECK and
-- the entire allocation rolls back. PR-04 has been applied live since 2026-05-10
-- — /payments (PaymentAllocation) has likely been broken on prod for any
-- posted-invoice allocation since then. The recent commit switching
-- /invoices/:id payment recording to allocate_payment surfaces the same
-- breakage on that page too.
--
-- Fix: ADDITIVELY include 'payment_allocated' back in the allow-list. This is
-- the safest path — purely cumulative, no existing rows are invalidated, no
-- function bodies need rewriting. The longer-term cleanup (renaming the value
-- allocate_payment writes from past tense to noun) can land in a future
-- sprint; this migration restores production behavior immediately.
--
-- Constraint body verbatim from 20260512000000:38-67 with one addition.
-- ============================================================================

ALTER TABLE public.financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_operation_type_check;

ALTER TABLE public.financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK (operation_type = ANY (ARRAY[
    'invoice_created', 'invoice_posted', 'invoice_voided', 'invoice_cancelled',
    'invoice_updated', 'invoice_deleted', 'invoice_marked_overdue',
    'payment_recorded', 'payment_allocation', 'payment_voided',
    'payment_allocated',  -- restored 2026-05-13 (codex P1 fix for PR #59)
    'split_modified', 'split_invoices_generated',
    'prepay_created', 'prepay_applied', 'prepay_credit_created',
    'prepay_batch_applied', 'prepay_edited', 'prepay_deleted',
    'prepay_reconciliation', 'batch_prepay_apply',
    'write_off_recorded', 'write_off_reversed', 'write_off_applied',
    'finance_charge', 'finance_charge_generated', 'finance_charge_voided',
    'credit_memo_created', 'credit_memo_applied', 'credit_memo_unapplied',
    'return_created', 'return_approved', 'return_received',
    'return_credit_issued',
    'order_created',
    'order_updated', 'order_voided', 'order_cancelled', 'order_restored',
    'delivery_created',
    'delivery_updated', 'delivery_cancelled', 'delivery_voided',
    'delivery_restored',
    'quote_converted',
    'blend_ticket_linked', 'blend_ticket_unlinked',
    'commission_payment_created', 'commission_payment_posted',
    'commission_payment_voided',
    'batch_post', 'batch_void', 'batch_payment',
    'period_reopened', 'quote_status_reverted',
    'blend_ticket_approval_reversed', 'cycle_count_completed',
    'vendor_bill_created', 'vendor_bill_voided', 'vendor_bill_updated',
    'vendor_payment_recorded', 'vendor_payment_voided'
  ]));

DO $$
DECLARE
  v_check_exists boolean;
  v_check_def text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'financial_audit_log_operation_type_check'
  ) INTO v_check_exists;

  IF NOT v_check_exists THEN
    RAISE EXCEPTION 'codex-fix verification: financial_audit_log_operation_type_check missing after migration';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_check_def
  FROM pg_constraint
  WHERE conname = 'financial_audit_log_operation_type_check';

  IF v_check_def NOT LIKE '%payment_allocated%' THEN
    RAISE EXCEPTION 'codex-fix verification: payment_allocated missing from operation_type CHECK';
  END IF;

  RAISE NOTICE 'codex-fix: payment_allocated restored in financial_audit_log.operation_type CHECK.';
END
$$;
