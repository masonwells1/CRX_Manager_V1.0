-- ============================================================================
-- SPRINT 7: APPLICATOR ROLE EXPANSION
-- CRX Manager V1.0
-- Date: 2026-02-14
--
-- Adds 'applicator' as a fourth role on profiles. Applicators are licensed
-- professionals who apply chemicals to fields. They need login credentials,
-- get assigned to jobs, and earn commissions.
--
-- Also adds applicator-specific columns and a helper function.
-- ============================================================================

-- ============================================================================
-- 1. EXPAND ROLE CHECK CONSTRAINT
-- ============================================================================

-- Drop the existing constraint and re-create with 'applicator'
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'sales_rep', 'driver', 'applicator'));

-- ============================================================================
-- 2. ADD APPLICATOR-SPECIFIC COLUMNS
-- ============================================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS applicator_license_number text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS faa_certificate_number text;

-- ============================================================================
-- 3. HELPER FUNCTION: is_applicator()
-- ============================================================================

CREATE OR REPLACE FUNCTION is_applicator()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'applicator'
      AND is_active = true
  )
$$;

GRANT EXECUTE ON FUNCTION is_applicator() TO authenticated;

-- ============================================================================
-- 4. UPDATE EXISTING RLS POLICIES
-- Applicators get the same base access as drivers PLUS they can read
-- fields, products, customers, and blend recipes (needed for job context).
-- Job-specific RLS will be added in Sprint 8.
-- ============================================================================

-- Applicators can read customers (needed to see job customer info)
DROP POLICY IF EXISTS customers_select ON customers;
CREATE POLICY customers_select ON customers
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR is_driver()
    OR is_applicator()
  );

-- Applicators can read products (needed for job chemical details)
DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products
  FOR SELECT TO authenticated
  USING (true);

-- Applicators can read fields (needed for job field assignments)
DROP POLICY IF EXISTS fields_select ON fields;
CREATE POLICY fields_select ON fields
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR is_applicator()
  );

-- Applicators can read blend recipes (needed for job recipe loading)
DROP POLICY IF EXISTS blend_recipes_select ON blend_recipes;
CREATE POLICY blend_recipes_select ON blend_recipes
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR is_applicator()
  );
