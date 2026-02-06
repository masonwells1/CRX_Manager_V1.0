import { test, expect } from '@playwright/test';
import { login, logout, TEST_USER } from './utils/auth';

test.describe('Authentication', () => {
  test('should show login page when not authenticated', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
    await expect(page.locator('h1')).toContainText('Welcome');
  });

  test('should login with valid credentials', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL('/');
    await expect(page.locator('h1, h2, [role="heading"]').first()).toBeVisible();
  });

  test('should show error with invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'invalid@example.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    await page.waitForTimeout(2000);
    await expect(page).toHaveURL('/login');
  });

  test('should logout successfully', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL('/');

    await page.click('[data-testid="user-menu"] button:has-text("Sign Out")');
    await expect(page).toHaveURL('/login');
  });

  test('should redirect to login when accessing protected route', async ({ page }) => {
    await page.goto('/products');
    await expect(page).toHaveURL('/login');
  });
});
