-- 20260625170000_job_loader_worksheet_fields.sql
-- Field-app parity #10 (Loader Worksheet PDF wired to FIELD JOBS).
--
-- The loader worksheet tells the tank loader how many tank loads to mix and how
-- much of each chemical goes into ONE tank. ChemMan's worksheet takes the
-- applicator + vehicle + vehicle capacity (gallons) + a per-acre CARRIER/diluent
-- rate + acres and computes the number of loads, then prints a per-load mix.
--
-- The job already stores:
--   * jobs.applicator_id / jobs.vehicle_id          (who + which sprayer)
--   * jobs.loader_comment                           (free-text loader memo, #1)
--   * vehicles.capacity_gallons / capacity_unit     (the sprayer tank capacity)
--   * job_chemicals.* + job_fields.acres            (the mix + acreage)
--
-- What is MISSING for a correct loads-count (and what this migration adds) is the
-- per-acre CARRIER rate (gallons of water/spray per acre) so total spray volume =
-- total acres x carrier rate, and an OPTIONAL per-job tank-capacity override so a
-- worksheet can be planned/mass-edited independently of the assigned vehicle.
--
-- ALL changes here are ADDITIVE, calculation/layout-only, and money-neutral. No
-- existing column, table, RLS policy, or RPC is removed or weakened. No new table
-- (so no new RLS surface) and no RPC. jobs is already RLS-protected. Em-dashes
-- below are real U+2014.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. jobs.carrier_rate_gpa — gallons of carrier (water/spray solution) applied
--    PER ACRE. This is the spray-volume driver: total spray volume = total acres
--    x carrier_rate_gpa, and loads = ceil(spray volume / tank capacity). Nullable
--    (NULL/0 => the worksheet shows an "enter carrier rate" invalid state rather
--    than a wrong loads number). numeric (NOT *_cents — this is a volume rate, not
--    money). CHECK keeps it non-negative without forcing a value (NULL allowed).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS carrier_rate_gpa numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_carrier_rate_gpa_nonneg' AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_carrier_rate_gpa_nonneg
      CHECK (carrier_rate_gpa IS NULL OR carrier_rate_gpa >= 0);
  END IF;
END $$;

COMMENT ON COLUMN jobs.carrier_rate_gpa IS
  'Field-app parity #10: carrier (water/spray) gallons per acre. Spray volume = '
  'total acres x carrier_rate_gpa drives the loader-worksheet loads count. '
  'NULL/0 => worksheet shows "enter carrier rate" (no loads computed). Not money.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. jobs.loader_tank_capacity — OPTIONAL per-job tank-capacity override (gallons).
--    When set it wins over the assigned vehicle's capacity_gallons, so a loader
--    worksheet can be planned (and bulk mass-edited) without depending on a vehicle
--    record. NULL => fall back to the assigned vehicle's capacity_gallons. CHECK
--    keeps it strictly positive when present (a 0/negative tank can't hold a load).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS loader_tank_capacity numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_loader_tank_capacity_pos' AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_loader_tank_capacity_pos
      CHECK (loader_tank_capacity IS NULL OR loader_tank_capacity > 0);
  END IF;
END $$;

COMMENT ON COLUMN jobs.loader_tank_capacity IS
  'Field-app parity #10: optional per-job loader tank capacity (gallons) override. '
  'When set, wins over the assigned vehicle.capacity_gallons for the loader '
  'worksheet loads math. NULL => use the vehicle capacity. Not money.';
