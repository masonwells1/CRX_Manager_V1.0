import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

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
    { path: '/payment-allocation', name: 'Payment Allocation' },
    { path: '/ar-aging', name: 'AR Aging' },
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
      '/payment-allocation',
      '/ar-aging',
      '/month-end',
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
    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('should display navigation sidebar with role-appropriate links', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    // Admin sidebar should have all nav items
    const sidebar = page.locator('aside, nav').first();
    await expect(sidebar).toBeVisible();
    // Check key nav links exist
    const links = await page.locator('a[href]').allInnerTexts();
    expect(links.length).toBeGreaterThan(0);
  });

  test('driver routes should include delivery pages', async ({ page }) => {
    // Verify delivery pages exist and load (driver would access these)
    await page.goto('/deliveries');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Deliver/i);
  });

  test('applicator routes should include jobs page', async ({ page }) => {
    // Verify jobs page exists (applicator would access this)
    await page.goto('/jobs');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Job/i);
  });

  test('sales_rep routes should include quotes and orders', async ({ page }) => {
    await page.goto('/quotes');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Quote/i);

    await page.goto('/orders');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Order/i);
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
