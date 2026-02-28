-- Phase 1: Optional tote-level tracking
-- Adds nullable tote_number to delivery_items and invoice_items.
-- Adds is_non_returnable flag to receiving_records.

-- delivery_items: optional tote # per line item
ALTER TABLE public.delivery_items ADD COLUMN IF NOT EXISTS tote_number text;

-- invoice_items: tote # copied from delivery during invoicing
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS tote_number text;

-- receiving_records: flag non-returnable totes
ALTER TABLE public.receiving_records ADD COLUMN IF NOT EXISTS is_non_returnable boolean NOT NULL DEFAULT false;
