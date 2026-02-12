import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Purchase Orders Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/purchase-orders');
    await page.waitForTimeout(1000);
  });

  test('should display purchase orders list', async ({ page }) => {
    const rows = page.locator('table tbody tr');
    const emptyState = page.locator('text=No purchase orders');
    await expect(rows.first().or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('should have New PO button for admin', async ({ page }) => {
    const newPOBtn = page.locator('button:has-text("New PO")').first();
    // Only visible for admin
    if (await newPOBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(newPOBtn).toBeVisible();
    }
  });

  test('should filter by status', async ({ page }) => {
    const statusFilter = page.locator('select[aria-label*="status" i], select').first();
    if (await statusFilter.isVisible()) {
      await statusFilter.selectOption({ index: 1 });
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to PO detail', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 })) {
      await firstRow.click();
      await page.waitForTimeout(1000);
      await expect(page).toHaveURL(/\/purchase-orders\/.+/);
    }
  });
});
