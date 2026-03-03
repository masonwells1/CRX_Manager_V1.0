-- Migration: Add calc_mode and price_unit columns to quote_items
-- Supports bidirectional calculation (rate_acres vs units_direct)
-- and per-item price unit override in quotes.

ALTER TABLE quote_items
  ADD COLUMN IF NOT EXISTS calc_mode text DEFAULT 'rate_acres',
  ADD COLUMN IF NOT EXISTS price_unit text;

COMMENT ON COLUMN quote_items.calc_mode IS 'rate_acres = compute units from rate×acres; units_direct = user enters units directly';
COMMENT ON COLUMN quote_items.price_unit IS 'Display unit for price (overrides product inventory_unit)';
