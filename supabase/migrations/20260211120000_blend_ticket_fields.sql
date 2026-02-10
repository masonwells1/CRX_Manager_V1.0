-- Add enhanced fields to blend_tickets
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS job_number text;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS invoice_number text;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS ticket_time text;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS vehicle_info text;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS mixer_name text;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS field_names text;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS total_acres numeric;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS application_rate text;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS total_volume numeric;
ALTER TABLE blend_tickets ADD COLUMN IF NOT EXISTS total_volume_unit text;

-- Add rate per acre fields to blend_ticket_products
ALTER TABLE blend_ticket_products ADD COLUMN IF NOT EXISTS rate_per_acre numeric;
ALTER TABLE blend_ticket_products ADD COLUMN IF NOT EXISTS rate_per_acre_unit text;
