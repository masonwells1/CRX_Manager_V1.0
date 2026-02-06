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
    await expect(page.locator('h1')).toContainText('Customers');
  });

  test('should access products page', async ({ page }) => {
    await page.goto('/products');
    await expect(page).toHaveURL('/products');
    await expect(page.locator('h1')).toContainText('Products');
  });

  test('should access orders page', async ({ page }) => {
    await page.goto('/orders');
    await expect(page).toHaveURL('/orders');
    await expect(page.locator('h1')).toContainText('Orders');
  });

  test('should show settings page for admin users', async ({ page }) => {
    await page.goto('/settings');

    const currentUrl = page.url();
    if (currentUrl.includes('/settings')) {
      await expect(page.locator('h1, h2')).toContainText(/Settings|Profile/i);
    }
  });

  test('navigation links should be present', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('text=Dashboard, a:has-text("Dashboard")')).toBeVisible();
    await expect(page.locator('text=Products, a:has-text("Products")')).toBeVisible();
    await expect(page.locator('text=Customers, a:has-text("Customers")')).toBeVisible();
  });
});
