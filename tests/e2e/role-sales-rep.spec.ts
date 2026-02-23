import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const SALES_REP_EMAIL = 'admin@croprx.com';
const SALES_REP_PASSWORD = 'TestSalesRep123!';

/**
 * Sales Rep Role Restriction Tests
 *
 * Sales Rep should access:
 *   - Dashboard, Team Board, Notifications
 *   - Products, Customers, Fields, Quotes, Orders, Invoices
 *   - Inventory, Purchase Orders, Receiving, Blend Tickets, Recipes
 *   - Returns, Deliveries, Jobs, Delivery Remainders, Application Records
 *   - Reports, Compliance, Brand vs Generic, Crop Programs
 *   - Payment Allocation
 *
 * Sales Rep should NOT access (admin-only):
 *   - Settings, Payments, AR Aging, Vehicles, Cycle Counts
 *   - Month-End, Commission Payments, Prepayments, Rebates
 *   - Customer Transactions
 */

test.describe('Sales Rep Role — Allowed Pages', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SALES_REP_EMAIL, SALES_REP_PASSWORD);
  });

  const allowedRoutes = [
    { path: '/', name: 'Dashboard' },
    { path: '/products', name: 'Products' },
    { path: '/customers', name: 'Customers' },
    { path: '/fields', name: 'Fields' },
    { path: '/quotes', name: 'Quotes' },
    { path: '/quotes/new', name: 'New Quote' },
    { path: '/orders', name: 'Orders' },
    { path: '/invoices', name: 'Invoices' },
    { path: '/inventory', name: 'Inventory' },
    { path: '/purchase-orders', name: 'Purchase Orders' },
    { path: '/receiving', name: 'Receiving' },
    { path: '/blend-tickets', name: 'Blend Tickets' },
    { path: '/recipes', name: 'Blend Recipes' },
    { path: '/returns', name: 'Returns' },
    { path: '/deliveries', name: 'Deliveries' },
    { path: '/jobs', name: 'Jobs' },
    { path: '/delivery-remainders', name: 'Delivery Remainders' },
    { path: '/application-records', name: 'Application Records' },
    { path: '/reports', name: 'Reports' },
    { path: '/compliance', name: 'Compliance' },
    { path: '/brand-vs-generic', name: 'Brand vs Generic' },
    { path: '/crop-programs', name: 'Crop Programs' },
    { path: '/payment-allocation', name: 'Payment Allocation' },
  ];

  for (const route of allowedRoutes) {
    test(`can access ${route.name} (${route.path})`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForTimeout(2000);
      // Should stay on the page, not redirect to login
      expect(page.url()).not.toContain('/login');
      if (route.path === '/') {
        // Dashboard — just check we stayed
        const heading = page.locator('h1, h2, [role="heading"]').first();
        await expect(heading).toBeVisible({ timeout: 10000 });
      } else {
        // Non-root: should still be on the route (not redirected to /)
        const url = new URL(page.url());
        expect(url.pathname).toBe(route.path);
      }
    });
  }
});

test.describe('Sales Rep Role — Blocked Pages (admin-only, should redirect to /)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SALES_REP_EMAIL, SALES_REP_PASSWORD);
  });

  const blockedRoutes = [
    { path: '/settings', name: 'Settings' },
    { path: '/payments', name: 'Payments' },
    { path: '/ar-aging', name: 'AR Aging' },
    { path: '/vehicles', name: 'Vehicles' },
    { path: '/cycle-counts', name: 'Cycle Counts' },
    { path: '/month-end', name: 'Month-End' },
    { path: '/commission-payments', name: 'Commission Payments' },
    { path: '/prepayments', name: 'Prepayments' },
    { path: '/customer-transactions', name: 'Customer Transactions' },
    { path: '/rebates', name: 'Rebates' },
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

test.describe('Sales Rep Role — Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SALES_REP_EMAIL, SALES_REP_PASSWORD);
  });

  test('sidebar shows sales_rep-accessible items', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(3000);

    const allLinks = await page.locator('aside a, nav[role="navigation"] a').allInnerTexts();
    const linkText = allLinks.join(' ').toLowerCase();

    // Should see these
    expect(linkText).toContain('dashboard');
    expect(linkText).toContain('quote');
    expect(linkText).toContain('order');
    expect(linkText).toContain('invoice');
    expect(linkText).toContain('customer');
    expect(linkText).toContain('product');
    expect(linkText).toContain('deliver');
    expect(linkText).toContain('inventor');
    expect(linkText).toContain('report');

    // Should NOT see admin-only items
    expect(linkText).not.toContain('setting');
    expect(linkText).not.toContain('vehicle');
    expect(linkText).not.toContain('month-end');
    expect(linkText).not.toContain('rebate');
    expect(linkText).not.toContain('cycle count');
  });

  test('sidebar shows correct role label', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForTimeout(2000);
    // Sidebar renders role text — check it exists in DOM
    const roleText = await page.locator('aside').first().innerText();
    expect(roleText.toLowerCase()).toContain('sales rep');
  });

  test('Create New Delivery page is accessible', async ({ page }) => {
    await page.goto('/deliveries/new');
    await page.waitForTimeout(2000);
    const url = new URL(page.url());
    expect(url.pathname).toBe('/deliveries/new');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });
  });

  test('Quick Delivery button IS visible to sales_rep', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(3000);
    // Sales rep should have Quick Delivery access
    const quickBtn = page.locator('button:has-text("Quick Delivery")');
    await expect(quickBtn).toBeVisible({ timeout: 10000 });
  });
});
