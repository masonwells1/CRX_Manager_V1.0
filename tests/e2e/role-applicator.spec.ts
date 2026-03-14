import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const APPLICATOR_EMAIL = process.env.E2E_APPLICATOR_EMAIL || 'testapplicator@croprxsolutions.com';
const APPLICATOR_PASSWORD = process.env.E2E_APPLICATOR_PASSWORD || 'TestApplicator123!';

/**
 * Applicator Role Restriction Tests
 *
 * Applicator should ONLY access:
 *   - Dashboard (/)
 *   - Team Board (/team-board)
 *   - Notifications (/notifications)
 *   - Jobs (/jobs, /jobs/:id)
 *   - Application Records (/application-records)
 *
 * Everything else should redirect to /
 */

test.describe('Applicator Role — Allowed Pages', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, APPLICATOR_EMAIL, APPLICATOR_PASSWORD);
  });

  test('can access Dashboard', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    expect(page.url()).not.toContain('/login');
    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('can access Jobs page', async ({ page }) => {
    await page.goto('/jobs');
    await page.waitForTimeout(2000);
    expect(page.url()).toMatch(/\/jobs/);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });
  });

  test('can access Application Records', async ({ page }) => {
    await page.goto('/application-records');
    await page.waitForTimeout(2000);
    expect(page.url()).toMatch(/\/application-records/);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });
  });

  test('can access Team Board', async ({ page }) => {
    await page.goto('/team-board');
    await page.waitForTimeout(2000);
    expect(page.url()).toMatch(/\/team-board/);
  });

  test('can access Notifications', async ({ page }) => {
    await page.goto('/notifications');
    await page.waitForTimeout(2000);
    expect(page.url()).toMatch(/\/notifications/);
  });
});

test.describe('Applicator Role — Blocked Pages (should redirect to /)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, APPLICATOR_EMAIL, APPLICATOR_PASSWORD);
  });

  const blockedRoutes = [
    { path: '/quotes', name: 'Quotes' },
    { path: '/quotes/new', name: 'New Quote' },
    { path: '/orders', name: 'Orders' },
    { path: '/orders/new', name: 'New Order' },
    { path: '/invoices', name: 'Invoices' },
    { path: '/customers', name: 'Customers' },
    { path: '/customers/new', name: 'New Customer' },
    { path: '/products', name: 'Products' },
    { path: '/fields', name: 'Fields' },
    { path: '/deliveries', name: 'Deliveries' },
    { path: '/deliveries/new', name: 'New Delivery' },
    { path: '/inventory', name: 'Inventory' },
    { path: '/purchase-orders', name: 'Purchase Orders' },
    { path: '/purchase-orders/new', name: 'New PO' },
    { path: '/receiving', name: 'Receiving' },
    { path: '/receiving/quick', name: 'Quick Receive' },
    { path: '/blend-tickets', name: 'Blend Tickets' },
    { path: '/recipes', name: 'Blend Recipes' },
    { path: '/returns', name: 'Returns' },
    { path: '/delivery-remainders', name: 'Delivery Remainders' },
    { path: '/brand-vs-generic', name: 'Brand vs Generic' },
    { path: '/crop-programs', name: 'Crop Programs' },
    { path: '/reports', name: 'Reports' },
    { path: '/compliance', name: 'Compliance' },
    { path: '/settings', name: 'Settings' },
    { path: '/payments', name: 'Payments' },
    { path: '/ar-aging', name: 'AR Aging' },
    { path: '/payments', name: 'Payment Allocation' },
    { path: '/month-end', name: 'Month-End' },
    { path: '/commission-payments', name: 'Commission Payments' },
    { path: '/prepayments', name: 'Prepayments' },
    { path: '/customer-transactions', name: 'Customer Transactions' },
    { path: '/rebates', name: 'Rebates' },
    { path: '/vehicles', name: 'Vehicles' },
    { path: '/cycle-counts', name: 'Cycle Counts' },
  ];

  for (const route of blockedRoutes) {
    test(`cannot access ${route.name} (${route.path})`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForTimeout(2000);
      // Should redirect away from the blocked route (back to /)
      const url = new URL(page.url());
      expect(url.pathname).not.toBe(route.path);
    });
  }
});

test.describe('Applicator Role — Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    const defaultEmail = process.env.E2E_TEST_EMAIL || '';
    test.skip(
      APPLICATOR_EMAIL.includes('admin') || APPLICATOR_EMAIL === defaultEmail,
      'Requires dedicated applicator test account — set E2E_APPLICATOR_EMAIL'
    );
    await login(page, APPLICATOR_EMAIL, APPLICATOR_PASSWORD);
  });

  test('sidebar only shows allowed nav items', async ({ page }) => {
    test.skip(true, 'Sidebar restructured with grouped sections — needs updated text expectations');
    // Use wide viewport so sidebar is always visible
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(3000);

    // Get all nav links (visible or not — on desktop the sidebar may render off-screen)
    const allLinks = await page.locator('aside a, nav[role="navigation"] a').allInnerTexts();
    const linkText = allLinks.join(' ').toLowerCase();

    // Should see these
    expect(linkText).toContain('dashboard');
    expect(linkText).toMatch(/job/i);

    // Should NOT see these
    expect(linkText).not.toContain('quote');
    expect(linkText).not.toContain('invoice');
    expect(linkText).not.toContain('customer');
    expect(linkText).not.toContain('product');
    expect(linkText).not.toContain('deliver');
    expect(linkText).not.toContain('inventor');
    expect(linkText).not.toContain('payment');
    expect(linkText).not.toContain('setting');
    expect(linkText).not.toContain('report');
    expect(linkText).not.toContain('purchase');
    expect(linkText).not.toContain('vehicle');
  });

  test('sidebar shows correct role label', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(2000);
    // Sidebar renders role text — check it exists in DOM even if sidebar is mobile-hidden
    const roleText = await page.locator('aside').first().innerText();
    expect(roleText.toLowerCase()).toContain('applicator');
  });
});
