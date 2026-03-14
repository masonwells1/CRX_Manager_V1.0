-- ============================================================================
-- Fix inventory_transactions.transaction_type CHECK constraint
--
-- PROBLEM: Migration 20260331110000_void_delivery.sql rewrote the CHECK
-- constraint on inventory_transactions.transaction_type and accidentally
-- removed 'prebooked' and 'released' from the allowed values. These values
-- are actively used by:
--   - update_order_items() (20260331200002) — product swap & qty adjustment
--   - cancel_order() (20260311000000) — releasing prebooked inventory
--   - create_quick_delivery() (20260328000000) — prebooking inventory
--   - Multiple earlier RPCs that adjust inventory pre-bookings
--
-- FIX: Drop and recreate the CHECK constraint with ALL valid values,
-- including 'prebooked' and 'released'.
-- ============================================================================

ALTER TABLE inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_transaction_type_check;

ALTER TABLE inventory_transactions
  ADD CONSTRAINT inventory_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'received',
    'booked',
    'delivered',
    'returned',
    'adjusted',
    'transferred',
    'job_applied',
    'cancelled_delivery_reversal',
    'void_delivery_reversal',
    'prebooked',
    'released'
  ));
