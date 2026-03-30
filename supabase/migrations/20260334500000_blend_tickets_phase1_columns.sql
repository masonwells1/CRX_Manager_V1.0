-- Add FK columns for applicator and vehicle (alongside existing text fields for OCR compat)
-- Add source column to track how ticket was created (ocr, manual, digital)

-- applicator_id: FK to profiles — nullable, set when applicator is known
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS applicator_id uuid REFERENCES profiles(id);

-- vehicle_id: FK to vehicles — nullable, set when vehicle is selected from dropdown
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id);

-- source: how the ticket was created
-- Default 'ocr' for backwards compat with existing tickets
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ocr'
    CHECK (source IN ('ocr', 'manual', 'digital'));

-- Indexes for FK lookups
CREATE INDEX IF NOT EXISTS idx_bt_applicator ON blend_tickets(applicator_id);
CREATE INDEX IF NOT EXISTS idx_bt_vehicle ON blend_tickets(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_bt_source ON blend_tickets(source);

-- Document intent
COMMENT ON COLUMN blend_tickets.source IS 'How the ticket was created: ocr (photo upload), manual (office entry), digital (mixer/Phase 2)';
COMMENT ON COLUMN blend_tickets.applicator_id IS 'FK to profiles. Nullable — text applicator_name kept for OCR backwards compat.';
COMMENT ON COLUMN blend_tickets.vehicle_id IS 'FK to vehicles. Nullable — text vehicle_info kept for OCR backwards compat.';
