-- ============================================================================
-- Phase 5: Crop History Tracking (Pillar 5)
-- Track multi-year crop history per field per season
-- ============================================================================

-- ---------------------------------------------------------------------------
-- New table: field_crop_history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_crop_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id      uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  season        integer NOT NULL,
  crop_type     text NOT NULL,
  variety       text,
  planting_date date,
  harvest_date  date,
  yield_per_acre numeric(10,2),
  yield_unit    text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_field_crop_history_unique
  ON field_crop_history(field_id, season);

CREATE INDEX IF NOT EXISTS idx_field_crop_history_field
  ON field_crop_history(field_id);

CREATE INDEX IF NOT EXISTS idx_field_crop_history_season
  ON field_crop_history(season);

-- RLS
ALTER TABLE field_crop_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read crop history"
  ON field_crop_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert crop history"
  ON field_crop_history FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update crop history"
  ON field_crop_history FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete crop history"
  ON field_crop_history FOR DELETE TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Trigger: Auto-snapshot crop_type changes to field_crop_history
-- When field.crop_type is updated to a new value, the OLD value is saved
-- to field_crop_history for the previous season.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION snapshot_field_crop_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer;
BEGIN
  -- Only fire when crop_type actually changes (and old value was not null)
  IF OLD.crop_type IS NULL OR OLD.crop_type = NEW.crop_type THEN
    RETURN NEW;
  END IF;

  -- Calculate the season for the OLD crop type (previous season)
  v_season := compute_season(CURRENT_DATE);

  -- Upsert: if a record already exists for this field+season, update it
  INSERT INTO field_crop_history (field_id, season, crop_type)
  VALUES (OLD.id, v_season, OLD.crop_type)
  ON CONFLICT (field_id, season)
  DO UPDATE SET crop_type = EXCLUDED.crop_type;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_snapshot_crop_history ON fields;
CREATE TRIGGER trg_snapshot_crop_history
  BEFORE UPDATE ON fields
  FOR EACH ROW
  WHEN (OLD.crop_type IS DISTINCT FROM NEW.crop_type)
  EXECUTE FUNCTION snapshot_field_crop_history();
