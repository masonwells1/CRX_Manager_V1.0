-- ============================================================================
-- M9 (2026-06-10 foundation ultra review, Codex round — MED):
-- The append-only inventory ledger's 'adjusted' type does not reliably
-- describe its own effect — migration 20260331900000 used 'adjusted' rows to
-- document PREBOOKED-only corrections (no quantity_available effect),
-- distinguishable only by free-text notes. That ambiguity produced this
-- audit's F2 false positive and makes ledger recomputation depend on parsing
-- note text.
--
-- Fix: add a dedicated 'prebook_reconciliation' transaction type for future
-- prebooked-only corrections. The new CHECK list is a strict SUPERSET of the
-- live 11 values (read from pg_constraint 2026-06-10) plus the new one — no
-- existing value removed, so no existing row or RPC can break. Historical
-- 'adjusted' prebooked-reconciliation rows are left untouched (the ledger is
-- append-only; their note convention is now documented in
-- docs/workflows/INVENTORY_RULES.md).
-- ============================================================================

ALTER TABLE public.inventory_transactions
  DROP CONSTRAINT inventory_transactions_transaction_type_check;

ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_transaction_type_check
  CHECK (transaction_type = ANY (ARRAY[
    'received'::text,
    'booked'::text,
    'delivered'::text,
    'returned'::text,
    'adjusted'::text,
    'transferred'::text,
    'job_applied'::text,
    'cancelled_delivery_reversal'::text,
    'void_delivery_reversal'::text,
    'prebooked'::text,
    'released'::text,
    'prebook_reconciliation'::text
  ]));

-- Verification: every existing row still satisfies the constraint (the ADD
-- above validates existing rows by default — this is belt-and-braces), and
-- the new value is accepted.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM inventory_transactions it
  WHERE it.transaction_type NOT IN (
    'received','booked','delivered','returned','adjusted','transferred',
    'job_applied','cancelled_delivery_reversal','void_delivery_reversal',
    'prebooked','released','prebook_reconciliation');
  IF v_bad <> 0 THEN RAISE EXCEPTION '% row(s) violate the new CHECK', v_bad; END IF;
END $$;
