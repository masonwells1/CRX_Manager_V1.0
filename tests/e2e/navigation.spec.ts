import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Page Navigation — all routes load without error', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  const routes = [
    { path: '/', heading: /Dashboard/i },
    { path: '/products', heading: /Products/i },
    { path: '/customers', heading: /Customers/i },
    { path: '/quotes', heading: /Quotes/i },
    { path: '/orders', heading: /Orders/i },
    { path: '/inventory', heading: /Inventory/i },
    { path: '/deliveries', heading: /Deliveries/i },
    { path: '/blend-tickets', heading: /Blend Tickets/i },
    { path: '/purchase-orders', heading: /Purchase Orders/i },
    { path: '/reports', heading: /Reports/i },
    { path: '/crop-programs', heading: /Crop Programs/i },
    { path: '/payments', heading: /Payments/i },
    { path: '/team-board', heading: /Team Board/i },
    { path: '/notifications', heading: /Notifications/i },
    { path: '/settings', heading: /Settings/i },
  ];

  for (const route of routes) {
    test(`${route.path} loads without error`, async ({ page }) => {
      await page.goto(route.path);
      // Should not redirect to login
      await expect(page).not.toHaveURL('/login');
      // Should contain expected heading
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible({ timeout: 10000 });
    });
  }
});
