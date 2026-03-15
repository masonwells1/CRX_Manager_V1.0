import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Expanded navigation smoke tests — covers routes NOT in navigation.spec.ts.
 * Each test: navigate → verify no redirect to /login → verify heading visible.
 */
test.describe('Expanded Navigation — additional routes load without error', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  const routes = [
    { path: '/invoices', heading: /Invoice/i },
    { path: '/ar-aging', heading: /Aging/i },
    { path: '/month-end', heading: /Month/i },
    { path: '/commission-payments', heading: /Commission/i },
    { path: '/customer-transactions', heading: /Customer Transaction/i },
    { path: '/prepayments', heading: /Prepay/i },
    { path: '/prepay-workspace', heading: /Prepay|Allocat/i },
    { path: '/financial-dashboard', heading: /Financial/i },
    { path: '/payment-history', heading: /Payment History/i },
    { path: '/delivery-remainders', heading: /Delivery Remainder/i },
    { path: '/receiving', heading: /Receiving/i },
    { path: '/receiving/quick', heading: /Quick.*Receive|Receive/i },
    { path: '/fields', heading: /Field/i },
    { path: '/recipes', heading: /Recipe|Blend/i },
    { path: '/cycle-counts', heading: /Cycle Count/i },
    { path: '/returns', heading: /Return/i },
    { path: '/jobs', heading: /Job/i },
    { path: '/vehicles', heading: /Vehicle/i },
    { path: '/application-records', heading: /Application Record/i },
    { path: '/compliance', heading: /Compliance/i },
    { path: '/rebates', heading: /Rebate/i },
    { path: '/quotes/new', heading: /Quote/i },
    { path: '/orders/new', heading: /Order/i },
    { path: '/deliveries/new', heading: /Deliver/i },
    { path: '/purchase-orders/new', heading: /Purchase Order/i },
  ];

  for (const route of routes) {
    test(`${route.path} loads without error`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page).not.toHaveURL('/login');
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible({ timeout: 10000 });
    });
  }
});
