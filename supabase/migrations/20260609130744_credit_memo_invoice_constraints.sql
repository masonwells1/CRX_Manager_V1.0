-- Fix B1 (foundation audit 2026-06-09, BLOCKER): return -> credit was broken in prod.
--
-- issue_return_credit inserts an invoices row with invoice_type='credit_memo' and
-- total_amount_cents = -v_total (negative). The LIVE invoices constraints rejected this
-- on three counts, so EVERY "Issue Credit" threw a CHECK violation and the return stayed
-- stuck in 'received' (0 returns have ever been credited):
--   * invoices_invoice_type_check  : allowed only ('chemical_sale','field_application','misc_charge')
--   * invoices_total_non_negative  : CHECK (total_amount_cents >= 0)
--   * invoices_balance_non_negative: CHECK (balance_cents >= 0)  [balance_cents is GENERATED]
--
-- This was disk-vs-live drift: migration 20260316100002 intended to add 'credit_memo' and
-- relies on a negative total, but the live constraints never reflected that.
--
-- Fix: relax the three constraints to EXEMPT credit_memo only. No change to the RPC body.
-- The new invoice_type list is a strict SUPERSET of the old (adds 'credit_memo'), per the
-- migration-drift CHECK-superset rule. Non-credit_memo invoices still require >= 0.
--
-- AR consistency confirmed before writing this:
--   * get_customer_statement sources return credits from the returns table
--     (-returns.total_credit_cents), NOT from credit-memo invoices -> no double-count.
--   * get_ar_aging filters `balance_cents > 0`, so a negative credit memo is simply excluded
--     (a credit is not aged AR). Behavior is unchanged for non-credit_memo invoices.
--
-- Reversible: drop these three constraints and restore the unconditional / 3-value versions.

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_invoice_type_check
  CHECK (invoice_type = ANY (ARRAY['chemical_sale'::text, 'field_application'::text, 'misc_charge'::text, 'credit_memo'::text]));

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_total_non_negative;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_total_non_negative
  CHECK (invoice_type = 'credit_memo' OR total_amount_cents >= 0);

ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_balance_non_negative;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_balance_non_negative
  CHECK (invoice_type = 'credit_memo' OR balance_cents >= 0);
