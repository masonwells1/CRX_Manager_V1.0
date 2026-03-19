/**
 * E2E Test Data Constants
 *
 * ALL test-created entities MUST use the E2E_PREFIX in their names.
 * This makes cleanup reliable — globalTeardown deletes everything
 * matching this prefix after every test run.
 *
 * ── The Two Designated Test Customers ─────────────────────────────────────
 *   [E2E] Farm Alpha  — tier 1, used for standard workflows
 *   [E2E] Farm Beta   — tier 3, used for tier-specific tests
 *
 * ── The Three Designated Test Products ────────────────────────────────────
 *   [E2E] Herbicide Alpha  — $50 cost, 30% margin
 *   [E2E] Adjuvant Beta    — $80 cost, 25% margin
 *   [E2E] Fertilizer Gamma — $30 cost, 40% margin
 *
 * ── The Designated Test Vendor ────────────────────────────────────────────
 *   [E2E] Test Vendor
 *
 * ── Rules ─────────────────────────────────────────────────────────────────
 *   1. NEVER create customers/products/vendors without the E2E_PREFIX
 *   2. Reuse the shared fixtures below whenever possible
 *   3. If a test needs a UNIQUE entity (e.g., concurrency tests),
 *      create it with `${E2E_PREFIX} UniqueDesc-${RUN}` and it will
 *      still get cleaned up by globalTeardown
 *   4. globalTeardown runs after every `npx playwright test` and deletes
 *      ALL rows where the name column starts with "[E2E]"
 */

/** Every test-created entity name MUST start with this prefix */
export const E2E_PREFIX = '[E2E]';

/** Generate a unique run suffix for tests that need isolation */
export function runId(): string {
  return Date.now().toString(36);
}

/* ─── Shared Test Customer Definitions ──────────────────────────────────── */

export const TEST_CUSTOMER_A = {
  farm_name: `${E2E_PREFIX} Farm Alpha`,
  contact_name: 'Test Contact A',
  email: 'testa@test.com',
  phone: '555-0001',
  assigned_tier: 1,
  payment_terms: 'net_30' as const,
  total_acres: 1000,
  corn_acres: 500,
  soybean_acres: 500,
  other_acres: 0,
  is_active: true,
};

export const TEST_CUSTOMER_B = {
  farm_name: `${E2E_PREFIX} Farm Beta`,
  contact_name: 'Test Contact B',
  email: 'testb@test.com',
  phone: '555-0002',
  assigned_tier: 3,
  payment_terms: 'net_30' as const,
  total_acres: 500,
  corn_acres: 300,
  soybean_acres: 200,
  other_acres: 0,
  is_active: true,
};

/* ─── Shared Test Product Definitions ───────────────────────────────────── */

export const TEST_PRODUCT_ALPHA = {
  product_name: `${E2E_PREFIX} Herbicide Alpha`,
  category: 'Herbicide',
  inventory_unit: 'gal',
  container_size: 2.5,
  container_type: 'Jug',
  current_cost: 50.00, // $50.00 (dollars, not cents)
  tier1_price: 65.00,
  tier2_price: 68.00,
  tier3_price: 72.00,
  is_active: true,
  is_rup: false,
};

export const TEST_PRODUCT_BETA = {
  product_name: `${E2E_PREFIX} Adjuvant Beta`,
  category: 'Adjuvant',
  inventory_unit: 'gal',
  container_size: 2.5,
  container_type: 'Jug',
  current_cost: 80.00, // $80.00
  tier1_price: 100.00,
  tier2_price: 106.00,
  tier3_price: 112.00,
  is_active: true,
  is_rup: false,
};

export const TEST_PRODUCT_GAMMA = {
  product_name: `${E2E_PREFIX} Fertilizer Gamma`,
  category: 'Fertilizer',
  inventory_unit: 'lb',
  container_size: 50,
  container_type: 'Bag',
  current_cost: 30.00, // $30.00
  tier1_price: 42.00,
  tier2_price: 45.00,
  tier3_price: 48.00,
  is_active: true,
  is_rup: false,
};

/* ─── Shared Test Vendor Definition ─────────────────────────────────────── */

export const TEST_VENDOR = {
  name: `${E2E_PREFIX} Test Vendor`,
  contact_name: 'Vendor Contact',
  email: 'vendor@test.com',
  phone: '555-0099',
};
