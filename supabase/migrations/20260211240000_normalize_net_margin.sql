-- ============================================================================
-- S1-5: NORMALIZE net_margin TO PERCENTAGE
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- Problem: QuoteBuilder stored net_margin as fraction (0.20 = 20%)
-- while BulkImport and create_direct_order stored as percentage (20.0 = 20%).
-- Convention: percentage (20.0 = 20%) to match total_margin_pct.
--
-- This migration converts all fraction-based values to percentage.
-- Values <= 1.0 and > 0 are assumed to be fractions and are multiplied by 100.
-- Values > 1.0 or = 0 are assumed to already be percentages and are left as-is.
-- ============================================================================

-- Fix quote_items
UPDATE quote_items
SET net_margin = net_margin * 100
WHERE net_margin > 0 AND net_margin <= 1;

-- Fix order_items (inherited from quote_items via convert_quote_to_order)
UPDATE order_items
SET net_margin = net_margin * 100
WHERE net_margin > 0 AND net_margin <= 1;
