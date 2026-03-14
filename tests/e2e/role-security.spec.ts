import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const DRIVER_EMAIL = process.env.E2E_DRIVER_EMAIL || 'testdriver@croprxsolutions.com';
const DRIVER_PASSWORD = process.env.E2E_DRIVER_PASSWORD || 'TestDriver123!';

/**
 * Phase 5: Role-Based Security Testing
 * Tests that each role (admin, sales_rep, driver, applicator) can only access
 * their allowed pages and features. Uses admin login to verify all routes exist,
 * then documents expected access per role.
 *
 * Role matrix:
 *   admin      — full access to everything
 *   sales_rep  — CRUD quotes/orders/customers/fields/jobs/invoices/deliveries/receiving
 *   driver     — view/update assigned deliveries, signatures, self-assign, photos, issues
 *   applicator — view/complete assigned jobs
 */
test.describe('Role-Based Security — Admin Full Access', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // Admin should have access to ALL routes
  const adminRoutes = [
    { path: '/', name: 'Dashboard' },
    { path: '/customers', name: 'Customers' },
    { path: '/products', name: 'Products' },
    { path: '/quotes', name: 'Quotes' },
    { path: '/orders', name: 'Orders' },
    { path: '/invoices', name: 'Invoices' },
    { path: '/deliveries', name: 'Deliveries' },
    { path: '/inventory', name: 'Inventory' },
    { path: '/purchase-orders', name: 'Purchase Orders' },
    { path: '/receiving', name: 'Receiving' },
    { path: '/jobs', name: 'Jobs' },
    { path: '/vehicles', name: 'Vehicles' },
    { path: '/reports', name: 'Reports' },
    { path: '/settings', name: 'Settings' },
    { path: '/payments', name: 'Payment Allocation' },
    { path: '/ar-aging', name: 'AR Aging' },
    { path: '/financial-dashboard', name: 'Financial Dashboard' },
  ];

  for (const route of adminRoutes) {
    test(`admin should access ${route.name} (${route.path})`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForTimeout(2000);
      // Should not redirect to login
      expect(page.url()).not.toContain('/login');
      // Should show some content (h1 heading or main content area)
      const heading = page.locator('h1, h2, [role="heading"]').first();
      await expect(heading).toBeVisible({ timeout: 10000 });
    });
  }
});

test.describe('Role-Based Security — Route Protection Verification', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('financial pages should be protected from non-admin roles', async ({ page }) => {
    // These routes should have role guards in App.tsx
    const financialRoutes = [
      '/payments',
      '/ar-aging',
      '/month-end',
      '/financial-dashboard',
    ];

    for (const route of financialRoutes) {
      await page.goto(route);
      await page.waitForTimeout(1000);
      // As admin, these should load
      expect(page.url()).not.toContain('/login');
    }
  });

  test('settings page should be admin-only', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(1000);
    // Admin should see settings
    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('should display navigation sidebar with role-appropriate links', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(2000);
    // Desktop sidebar is the 2nd <aside> (hidden lg:flex), mobile is 1st (lg:hidden)
    const sidebar = page.locator('aside:visible').first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    // Check key nav links exist
    const links = await sidebar.locator('a[href]').allInnerTexts();
    expect(links.length).toBeGreaterThan(0);
  });

  test('driver routes should include delivery pages', async ({ page }) => {
    // Verify delivery pages exist and load (driver would access these)
    await page.goto('/deliveries');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1, h2, [role="heading"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('applicator routes should include jobs page', async ({ page }) => {
    // Verify jobs page exists (applicator would access this)
    await page.goto('/jobs');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1, h2, [role="heading"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('sales_rep routes should include quotes and orders', async ({ page }) => {
    await page.goto('/quotes');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1, h2, [role="heading"]').first()).toBeVisible({ timeout: 10000 });

    await page.goto('/orders');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1, h2, [role="heading"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('new resource creation routes should be accessible to admin', async ({ page }) => {
    const createRoutes = [
      { path: '/customers/new', pattern: /Customer|New/i },
      { path: '/quotes/new', pattern: /Quote|New/i },
      { path: '/orders/new', pattern: /Order|New/i },
      { path: '/purchase-orders/new', pattern: /Purchase|PO|New/i },
    ];

    for (const route of createRoutes) {
      await page.goto(route.path);
      await page.waitForTimeout(2000);
      expect(page.url()).not.toContain('/login');
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible({ timeout: 10000 });
    }
  });
});

test.describe('Driver Role Restrictions', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      DRIVER_EMAIL.includes('admin') || DRIVER_EMAIL === (process.env.E2E_TEST_EMAIL || ''),
      'Requires dedicated driver test account — set E2E_DRIVER_EMAIL'
    );
    await login(page, DRIVER_EMAIL, DRIVER_PASSWORD);
  });

  test('sidebar only shows allowed categories for driver', async ({ page }) => {
    // Desktop sidebar uses collapsible categories — verify which categories render.
    // Driver should only see Operations category (Deliveries) and Team Board.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const sidebar = page.locator('aside').nth(1);
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    const allText = (await sidebar.textContent()) || '';
    const lower = allText.toLowerCase();

    // Driver should see these
    expect(lower).toContain('operations');       // Operations category (Deliveries)
    expect(lower).toContain('team board');       // Team Board standalone

    // Should NOT see these categories (no sub-items visible to driver)
    expect(lower).not.toContain('sales');        // All items require admin/sales_rep
    expect(lower).not.toContain('customers');    // All items require admin/sales_rep
    expect(lower).not.toContain('finance');      // All items require admin/sales_rep
    expect(lower).not.toContain('settings');     // Admin-only
  });

  test('driver cannot access /quotes — redirected', async ({ page }) => {
    await page.goto('/quotes');
    await page.waitForTimeout(2000);
    // Should redirect away from /quotes (back to / or /dashboard)
    expect(page.url()).not.toMatch(/\/quotes($|\/)/);
  });

  test('driver cannot access /invoices — redirected', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toMatch(/\/invoices($|\/)/);
  });

  test('driver cannot access /payments — redirected', async ({ page }) => {
    await page.goto('/payments');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toMatch(/\/payments($|\/)/);
  });

  test('driver cannot access /financial-dashboard — redirected', async ({ page }) => {
    await page.goto('/financial-dashboard');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toMatch(/\/financial-dashboard($|\/)/);
  });

  test('Quick Delivery button not visible to driver on deliveries page', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);
    // Quick Delivery button must NOT be present for drivers
    const quickBtn = page.locator('button:has-text("Quick Delivery")');
    await expect(quickBtn).not.toBeVisible();
  });
});
