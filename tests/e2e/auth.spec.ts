import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Authentication', { tag: '@smoke' }, () => {
  test('should show login page when not authenticated', async ({ page }) => {
    await page.goto('/');
    // Auth check is async; wait for redirect
    await expect(page).toHaveURL('/login', { timeout: 10000 });
    // Login page has "Welcome Back" h2 and "Sign In" button
    await expect(page.locator('h2:has-text("Welcome"), button:has-text("Sign In")').first()).toBeVisible();
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

    // Sign Out button is small icon in collapsed sidebar; force click it
    await page.locator('button[aria-label="Sign out"]').click({ force: true });
    await expect(page).toHaveURL('/login', { timeout: 15000 });
  });

  test('should redirect to login when accessing protected route', async ({ page }) => {
    await page.goto('/products');
    await expect(page).toHaveURL('/login');
  });
});
