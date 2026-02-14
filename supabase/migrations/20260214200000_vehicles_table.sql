-- ============================================================================
-- SPRINT 7: VEHICLES TABLE
-- CRX Manager V1.0
-- Date: 2026-02-14
--
-- Creates the vehicles table as a first-class entity for tracking ground
-- and aerial application equipment. Vehicles are assigned to jobs and
-- used in loader worksheet calculations (capacity ÷ rate × acres = loads).
-- ============================================================================

-- ============================================================================
-- 1. VEHICLES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_name    text NOT NULL,
  vehicle_type    text NOT NULL CHECK (vehicle_type IN ('ground', 'air')),
  category        text,             -- e.g. 'Sprayer', 'Airplane', 'Helicopter', 'Spreader', 'Drone'
  capacity_gallons numeric,
  capacity_unit   text DEFAULT 'gallons',
  registration    text,             -- FAA N-number for aircraft, DOT# for ground
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
  notes           text,
  created_by      uuid REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
CREATE INDEX IF NOT EXISTS idx_vehicles_type ON vehicles(vehicle_type);

-- ============================================================================
-- 2. RLS POLICIES
-- ============================================================================

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;

-- All authenticated users can view vehicles
DROP POLICY IF EXISTS vehicles_select ON vehicles;
CREATE POLICY vehicles_select ON vehicles
  FOR SELECT TO authenticated
  USING (true);

-- Only admins can insert/update/delete
DROP POLICY IF EXISTS vehicles_insert ON vehicles;
CREATE POLICY vehicles_insert ON vehicles
  FOR INSERT TO authenticated
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS vehicles_update ON vehicles;
CREATE POLICY vehicles_update ON vehicles
  FOR UPDATE TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS vehicles_delete ON vehicles;
CREATE POLICY vehicles_delete ON vehicles
  FOR DELETE TO authenticated
  USING (is_admin());

-- ============================================================================
-- 3. UPDATED_AT TRIGGER
-- ============================================================================

CREATE TRIGGER set_vehicles_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
