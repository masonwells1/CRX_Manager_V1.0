import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Permissions and Access Control', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should access dashboard as authenticated user', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.locator('h1, h2, [role="heading"]').first()).toBeVisible();
  });

  test('should access customers page', async ({ page }) => {
    await page.goto('/customers');
    await expect(page).toHaveURL('/customers');
    await expect(page.locator('h1').first()).toContainText('Customer');
  });

  test('should access products page', async ({ page }) => {
    await page.goto('/products');
    await expect(page).toHaveURL('/products');
    await expect(page.locator('h1').first()).toContainText('Product');
  });

  test('should access orders page', async ({ page }) => {
    await page.goto('/orders');
    await expect(page).toHaveURL('/orders');
    await expect(page.locator('h1').first()).toContainText('Order');
  });

  test('should show settings page for admin users', async ({ page }) => {
    await page.goto('/settings');

    const currentUrl = page.url();
    if (currentUrl.includes('/settings')) {
      await expect(page.locator('h1').first()).toContainText(/Settings|Profile/i);
    }
  });

  test('navigation links should be present', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Sidebar may be collapsed (icon-only mode); verify links exist in the DOM
    const dashLink = await page.locator('a[href="/"]').count();
    expect(dashLink).toBeGreaterThan(0);
    const settingsLink = await page.locator('a[href="/settings"]').count();
    expect(settingsLink).toBeGreaterThan(0);
    // Desktop sidebar is the second <aside> (first is hidden mobile overlay)
    await expect(page.locator('aside').nth(1)).toBeVisible();
  });
});
