-- Add denormalized order_number and customer_name columns to commissions table.
-- These are required by the CommissionPayments page query which selects them directly.
-- Without these columns, the fetchUnpaid() query silently fails (column not found),
-- causing the recipients dropdown to always be empty.

ALTER TABLE commissions ADD COLUMN IF NOT EXISTS order_number text;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS customer_name text;

-- Backfill existing records from orders + customers
UPDATE commissions c
SET
  order_number = o.order_number,
  customer_name = cust.farm_name
FROM orders o
JOIN customers cust ON cust.id = o.customer_id
WHERE c.order_id = o.id
  AND (c.order_number IS NULL OR c.customer_name IS NULL);
