-- ============================================================================
-- FIELD-APP PARITY #19: START + END weather pair on as-applied entries
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan's "Applied Info" records, PER ENTRY, a START weather set and an END
-- weather set (the spray window), each with: Time, Temp (F), Wind Direction,
-- Wind mph (speed), and Humidity, plus a computed Total Time (end - start). A
-- "Get Weather" button auto-fills the values from a weather service keyed by the
-- application date + the field location. CRX keeps the existing FREE Open-Meteo
-- auto-pull (src/lib/weatherCapture.ts) instead of ChemMan's paid Visual Crossing.
--
-- This migration adds the start_/end_ weather columns to job_applied_records
-- (#17). Weather is a LEGAL compliance record proving conditions were within
-- label/regulatory limits, so every value is editable after an auto-pull (the
-- crew can correct a wrong/failed fetch). A per-set "source" flag records whether
-- the set was auto-pulled or hand-entered, surfaced in the UI.
--
-- WHY COLUMNS ON job_applied_records (not a child table):
--   A weather pair is strictly 1:1 with an as-applied entry (one start reading +
--   one end reading per pass). Columns keep the read/write a single row and avoid
--   a join. This mirrors the legacy job_applied_info weather snapshot shape.
--
-- DOES NOT AFFECT THE #18 APPLIED-ACRES ROLLUP:
--   recompute_job_applied_acres() reads ONLY job_applied_record_fields and writes
--   jobs.applied_acres -> GENERATED jobs.remaining_acres. Adding weather columns
--   to job_applied_records touches neither — the trigger is left UNTOUCHED. The
--   set_job_applied_records_updated_at BEFORE-UPDATE trigger keeps updated_at fresh.
--
-- ALL changes are ADDITIVE: only new nullable columns on an existing table. No
-- column/table/policy/RPC is removed or weakened. RLS is row-level and already
-- covers every column on job_applied_records (job-scoped, all 4 verbs from #17),
-- so the new columns need NO new policy. No money, no lifecycle transition, no
-- actor-sensitive financial write -> plain RLS-gated mutations, no RPC.
-- ============================================================================

-- START weather set (the conditions at the beginning of the spray window).
-- All nullable: weather is a convenience capture, never a save gate.
--   *_time     : the clock time the reading was taken (HH:MM, local to the field).
--                Stored as `time` (no date) — the date is the entry's application_date.
--   *_temp_f   : temperature in Fahrenheit (matches weatherCapture.ts output).
--   *_wind_dir : 16-point cardinal direction (e.g. 'NNW') — free text so a manual
--                value the crew writes ('Variable') is never rejected.
--   *_wind_mph : wind speed in mph.
--   *_humidity : relative humidity percent.
--   *_source   : 'auto' (pulled from Open-Meteo) or 'manual' (hand-entered/edited),
--                so the UI can show which values were machine-pulled vs typed.
ALTER TABLE job_applied_records
  ADD COLUMN IF NOT EXISTS start_weather_time      time,
  ADD COLUMN IF NOT EXISTS start_temp_f            numeric,
  ADD COLUMN IF NOT EXISTS start_wind_direction    text,
  ADD COLUMN IF NOT EXISTS start_wind_mph          numeric CHECK (start_wind_mph IS NULL OR start_wind_mph >= 0),
  ADD COLUMN IF NOT EXISTS start_humidity_pct      numeric CHECK (start_humidity_pct IS NULL OR (start_humidity_pct >= 0 AND start_humidity_pct <= 100)),
  ADD COLUMN IF NOT EXISTS start_weather_source    text CHECK (start_weather_source IS NULL OR start_weather_source IN ('auto', 'manual')),
  -- END weather set (the conditions at the end of the spray window).
  ADD COLUMN IF NOT EXISTS end_weather_time        time,
  ADD COLUMN IF NOT EXISTS end_temp_f              numeric,
  ADD COLUMN IF NOT EXISTS end_wind_direction      text,
  ADD COLUMN IF NOT EXISTS end_wind_mph            numeric CHECK (end_wind_mph IS NULL OR end_wind_mph >= 0),
  ADD COLUMN IF NOT EXISTS end_humidity_pct        numeric CHECK (end_humidity_pct IS NULL OR (end_humidity_pct >= 0 AND end_humidity_pct <= 100)),
  ADD COLUMN IF NOT EXISTS end_weather_source      text CHECK (end_weather_source IS NULL OR end_weather_source IN ('auto', 'manual'));

COMMENT ON COLUMN job_applied_records.start_weather_time IS 'Field-app #19: clock time (local) of the START weather reading; date is the entry application_date.';
COMMENT ON COLUMN job_applied_records.end_weather_time   IS 'Field-app #19: clock time (local) of the END weather reading. Total Time = end - start.';
COMMENT ON COLUMN job_applied_records.start_weather_source IS 'Field-app #19: ''auto'' (Open-Meteo pull) or ''manual'' (hand-entered/edited).';
COMMENT ON COLUMN job_applied_records.end_weather_source   IS 'Field-app #19: ''auto'' (Open-Meteo pull) or ''manual'' (hand-entered/edited).';
