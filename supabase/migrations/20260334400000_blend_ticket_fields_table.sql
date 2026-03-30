-- Per-field application tracking for blend tickets
-- Supports: multi-field loads, multi-customer billing (Q6-B decision), planned vs actual acres
-- One blend ticket can reference multiple fields across multiple customers

CREATE TABLE IF NOT EXISTS blend_ticket_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid NOT NULL REFERENCES blend_tickets(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES fields(id),
  customer_id uuid REFERENCES customers(id),
  planned_acres numeric(10,2),
  actual_acres numeric(10,2),
  applied_at timestamptz,
  applied_by uuid REFERENCES profiles(id),
  notes text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),

  UNIQUE(blend_ticket_id, field_id)
);

-- Indexes for FK lookups and common queries
CREATE INDEX IF NOT EXISTS idx_btf_ticket ON blend_ticket_fields(blend_ticket_id);
CREATE INDEX IF NOT EXISTS idx_btf_field ON blend_ticket_fields(field_id);
CREATE INDEX IF NOT EXISTS idx_btf_customer ON blend_ticket_fields(customer_id);

-- Enable RLS
ALTER TABLE blend_ticket_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blend_ticket_fields_select" ON blend_ticket_fields;
CREATE POLICY "blend_ticket_fields_select" ON blend_ticket_fields
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "blend_ticket_fields_insert" ON blend_ticket_fields;
CREATE POLICY "blend_ticket_fields_insert" ON blend_ticket_fields
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "blend_ticket_fields_update" ON blend_ticket_fields;
CREATE POLICY "blend_ticket_fields_update" ON blend_ticket_fields
  FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "blend_ticket_fields_delete" ON blend_ticket_fields;
CREATE POLICY "blend_ticket_fields_delete" ON blend_ticket_fields
  FOR DELETE TO authenticated USING (true);

-- NOTE: No updated_at column — this table is in the "no updated_at" category
-- (append rows, delete+reinsert pattern via save_blend_ticket_fields RPC)
