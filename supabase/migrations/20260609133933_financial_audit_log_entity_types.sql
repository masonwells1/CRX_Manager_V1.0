-- Fix (foundation audit 2026-06-09 follow-on, discovered during H1 smoke testing).
--
-- financial_audit_log_entity_type_check did NOT allow 'accounting_period' or 'quote', yet:
--   * reopen_accounting_period (LIVE — MonthEndClose) inserts entity_type='accounting_period'
--   * revert_quote_status inserts entity_type='quote'
-- Both audit inserts therefore threw a CHECK violation, so the happy path of those RPCs was
-- latently broken (never surfaced because neither had been successfully exercised — same class
-- as the B1 credit_memo break). The H1 strict-actor fix alone did not address this.
--
-- Fix: expand the entity_type CHECK to include 'accounting_period' and 'quote'. Strict SUPERSET
-- of the live 21-value list (adds 2, drops none) per the migration-drift CHECK-superset rule.
-- financial_audit_log is append-only; existing rows all use already-allowed values, so the
-- re-added constraint validates immediately. Reversible: restore the 21-value list.

ALTER TABLE public.financial_audit_log DROP CONSTRAINT IF EXISTS financial_audit_log_entity_type_check;
ALTER TABLE public.financial_audit_log ADD CONSTRAINT financial_audit_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'invoice'::text, 'payment'::text, 'split'::text, 'prepay'::text, 'prepay_credit'::text,
    'customer'::text, 'order'::text, 'delivery'::text, 'write_off'::text, 'finance_charge'::text,
    'credit_memo'::text, 'return'::text, 'allocation_set'::text, 'void'::text, 'batch'::text,
    'commission_payment'::text, 'cycle_count'::text, 'blend_ticket'::text, 'vendor_bill'::text,
    'vendor_payment'::text, 'purchase_order'::text,
    'accounting_period'::text, 'quote'::text
  ]));
