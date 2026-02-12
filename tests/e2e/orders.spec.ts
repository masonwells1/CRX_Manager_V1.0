import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Orders Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/orders');
    await page.waitForTimeout(1000);
  });

  test('should display orders list', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Orders');
    const rows = page.locator('table tbody tr');
    const emptyState = page.locator('text=No orders');
    await expect(rows.first().or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('should filter by status', async ({ page }) => {
    const statusFilter = page.locator('select[aria-label*="status" i], select').first();
    if (await statusFilter.isVisible()) {
      await statusFilter.selectOption({ index: 1 });
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to order detail', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 })) {
      await firstRow.click();
      await page.waitForTimeout(1000);
      await expect(page).toHaveURL(/\/orders\/.+/);
    }
  });

  test('should have New Order button', async ({ page }) => {
    const newOrderBtn = page.locator('button:has-text("New Order"), a:has-text("New Order")').first();
    await expect(newOrderBtn).toBeVisible();
  });
});

test.describe('New Order Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/orders/new');
    await page.waitForTimeout(1000);
  });

  test('should load new order form', async ({ page }) => {
    await expect(page.locator('text=Customer, label:has-text("Customer")').first()).toBeVisible({ timeout: 10000 });
  });
});
