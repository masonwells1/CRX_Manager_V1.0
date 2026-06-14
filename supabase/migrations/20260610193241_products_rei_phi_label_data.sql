-- B3 (2026-06-10 deep-dive H1): WPS pre-application notices need label data.
-- Adds the two label-derived intervals to products (both optional — entered from
-- the product label; used by the WPS notice PDF now and the B4 REI/PHI field
-- countdowns later):
--   rei_hours  — Worker Protection Standard restricted-entry interval (hours)
--   phi_days   — pre-harvest interval (days)
-- Additive only: no constraints changed, no functions touched, NULL = unknown
-- ("see product label" on printed notices).

ALTER TABLE products ADD COLUMN IF NOT EXISTS rei_hours integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS phi_days integer;

COMMENT ON COLUMN products.rei_hours IS 'WPS restricted-entry interval in hours, from the product label (NULL = not entered)';
COMMENT ON COLUMN products.phi_days IS 'Pre-harvest interval in days, from the product label (NULL = not entered)';

-- Verification
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'products' AND column_name IN ('rei_hours', 'phi_days')) <> 2 THEN
    RAISE EXCEPTION 'products.rei_hours / phi_days missing after migration';
  END IF;
END $$;
