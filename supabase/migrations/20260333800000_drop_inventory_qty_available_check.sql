-- Migration: Drop chk_inventory_qty_available CHECK constraint
-- Date: 2026-03-20
-- Issue: INV-4 from mega logic audit
--
-- The complete_delivery() function was redesigned in 20260319200000 to allow
-- negative inventory with admin notifications. But the old CHECK constraint
-- from 20260209200000 was never dropped, causing deliveries to fail when
-- stock is insufficient (e.g. "Premium 8-29-2 (50/50) - Bulk" at 0 available).
--
-- The function already handles this gracefully:
--   1. Deducts inventory even if it goes negative
--   2. Tracks which items went negative
--   3. Sends notifications to all active admins
--   4. Logs to activity feed
--
-- Keeping chk_inventory_qty_prebooked and chk_inventory_qty_on_order
-- since those should never go negative (prebooked uses LEAST() guard,
-- on_order is only modified by PO receiving).

ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_qty_available;
