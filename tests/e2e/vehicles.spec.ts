import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Vehicles Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/vehicles');
  });

  test('should display vehicles list', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should have add vehicle button', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("New"), a:has-text("Add")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
  });

  test('should show vehicle table or empty state', async ({ page }) => {
    // Either data table or empty state message
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no vehicles|no data|add your first/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Vehicle Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should navigate to vehicle detail from list', async ({ page }) => {
    await page.goto('/vehicles');
    // Click first row if data exists
    const row = page.locator('tbody tr').first();
    if (await row.isVisible({ timeout: 5000 }).catch(() => false)) {
      await row.click();
      await expect(page.url()).toContain('/vehicles/');
    }
  });
});
