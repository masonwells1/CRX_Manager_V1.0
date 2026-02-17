import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/settings');
  });

  test('should display settings page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show company settings section', async ({ page }) => {
    // Settings page should have company-related fields
    await expect(
      page.locator('text=/company|organization|business/i').first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('should show user management section for admin', async ({ page }) => {
    // Admin should see user management (CardHeader renders "User Management" as h3)
    await expect(
      page.locator('text=/user management|users|team members|add user/i').first()
    ).toBeVisible({ timeout: 10000 });
  });

  test('should have save or update button', async ({ page }) => {
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Update")').first();
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
  });
});
