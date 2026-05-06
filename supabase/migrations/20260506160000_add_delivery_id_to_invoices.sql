-- =============================================================================
-- Migration: add delivery_id to invoices
-- Date: 2026-05-06
--
-- Fixes a real-world failure where complete_delivery (Phase 15, deployed
-- 2026-05-01) tries to INSERT into invoices.delivery_id, but that column
-- was never actually added to the invoices table. PL/pgSQL only resolves
-- column names at execution time, so the broken function happily lived in
-- pg_proc until a delivery completion hit the auto-invoice code path with
-- no existing invoice on the order.
--
-- Symptom (caught in production via DEL-00074 / ORD-2026-0186 on 2026-05-06):
--   Postgres raises: column "delivery_id" of relation "invoices" does not exist
--   The frontend errorSanitizer matches the catch-all schema-leak pattern
--   (relation "..." + column "...") and replaces the message with the generic
--   "An internal error occurred. Please try again." — which is what the user
--   saw. The Postgres error is clean; the UI just hides it for security.
--
-- Phase 15 paths that need this column:
--   1. Partial-delivery linked-invoice loop (line ~192) — narrows draft
--      invoices for the current order to the one created by THIS delivery.
--   2. Auto-invoice INSERT (line ~221) — links the auto-created draft to
--      the source delivery so it's traceable in audit/PDF/UI.
--
-- After this migration, existing invoices keep delivery_id = NULL (correct —
-- they came from orders, blend tickets, or jobs, not from a delivery). Future
-- invoices that complete_delivery auto-creates will have delivery_id set.
-- =============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS delivery_id uuid REFERENCES deliveries(id);

-- Partial index — only index rows where delivery_id IS NOT NULL, since most
-- invoices won't have one. Keeps the index small and the join fast for the
-- partial-delivery loop in complete_delivery.
CREATE INDEX IF NOT EXISTS idx_invoices_delivery_id
  ON invoices(delivery_id) WHERE delivery_id IS NOT NULL;

COMMENT ON COLUMN invoices.delivery_id IS
  'For invoices auto-created by complete_delivery, points to the source delivery. NULL for invoices originating from orders, blend tickets, jobs, or returns.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'delivery_id'
  ) THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: invoices.delivery_id was not added';
  END IF;
  RAISE NOTICE 'invoices.delivery_id added — Phase 15 auto-invoice path is now functional';
END $$;
