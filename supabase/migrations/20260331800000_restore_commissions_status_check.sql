-- ============================================================================
-- Restore commissions.status CHECK constraint
--
-- PROBLEM: Migration 20260302200000_business_logic_enhancements.sql dropped
-- the commissions_status_check constraint (which only allowed 'pending','paid')
-- to support the new 'cancelled' status. But it never re-created the constraint
-- with the expanded values, leaving the column completely unconstrained.
--
-- The column comment says "pending, paid, or cancelled" but nothing enforces it.
--
-- FIX: Add the CHECK constraint back with all three valid values.
-- ============================================================================

ALTER TABLE commissions
  DROP CONSTRAINT IF EXISTS commissions_status_check;

ALTER TABLE commissions
  ADD CONSTRAINT commissions_status_check
  CHECK (status IN ('pending', 'paid', 'cancelled'));
