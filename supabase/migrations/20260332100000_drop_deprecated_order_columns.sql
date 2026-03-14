-- Drop deprecated orders.total_paid and orders.balance_due columns
-- These columns were deprecated in migration 20260311200000_invoice_ar_single_source.sql
-- AR tracking now lives on invoices.balance_cents (GENERATED ALWAYS column)
-- The trigger that maintained these (trg_payment_update_order) was already dropped
-- No frontend code, views, or functions read these columns

ALTER TABLE orders DROP COLUMN IF EXISTS total_paid;
ALTER TABLE orders DROP COLUMN IF EXISTS balance_due;
