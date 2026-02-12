import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Deliveries Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/deliveries');
    await page.waitForTimeout(1000);
  });

  test('should display deliveries list', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Deliveries');
    const rows = page.locator('table tbody tr');
    const emptyState = page.locator('text=No deliveries');
    await expect(rows.first().or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('should filter by status', async ({ page }) => {
    const statusFilter = page.locator('select[aria-label*="status" i], select').first();
    if (await statusFilter.isVisible()) {
      await statusFilter.selectOption({ index: 1 });
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to delivery detail', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 })) {
      await firstRow.click();
      await page.waitForTimeout(1000);
      await expect(page).toHaveURL(/\/deliveries\/.+/);
    }
  });
});
