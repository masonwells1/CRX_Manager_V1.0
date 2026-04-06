-- Code review fixes 2026-04-05
-- Money: no money columns affected in this migration

-- 1. SELECT RLS policy for customer_application_rates (was missing)
DO $$ BEGIN
  CREATE POLICY "car_select" ON customer_application_rates
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Fix index: old one indexed PK (useless), new one indexes name for filtered queries
DROP INDEX IF EXISTS idx_application_services_active;
CREATE INDEX IF NOT EXISTS idx_application_services_active_name
  ON application_services(name) WHERE is_active = true;
