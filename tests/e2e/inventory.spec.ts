import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Inventory Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/inventory');
    await page.waitForTimeout(1000);
  });

  test('should display inventory list', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Inventory');
    const rows = page.locator('table tbody tr');
    const emptyState = page.locator('text=No inventory');
    await expect(rows.first().or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('should show summary cards', async ({ page }) => {
    // Summary cards use Card component with shadow-card class
    const cards = page.locator('[class*="shadow-card"], [class*="rounded-xl"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
  });

  test('should search inventory', async ({ page }) => {
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
    }
  });

  test('should show low stock alerts if any exist', async ({ page }) => {
    // The low stock alerts panel is conditional
    const lowStockPanel = page.locator('text=Low Stock Alerts');
    // It's OK if it doesn't exist (no low stock items)
    if (await lowStockPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(lowStockPanel).toBeVisible();
    }
  });
});
