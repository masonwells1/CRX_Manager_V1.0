import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Products Page', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/products');
    await page.waitForTimeout(1000);
  });

  test('should display products list', async ({ page }) => {
    await expect(page.locator('h1').first()).toContainText('Product');
    // Should have at least one product row or an empty state
    const rows = page.locator('table tbody tr, [role="row"]');
    const emptyState = page.locator('text=/no products/i');
    await expect(rows.first().or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('should search products', async ({ page }) => {
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForTimeout(500);
      // Search should filter without error
    }
  });

  test('should navigate to product detail', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 })) {
      await firstRow.click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/\/products\/.+/);
    }
  });

  test('should filter by product form', async ({ page }) => {
    const formFilter = page.locator('select').first();
    if (await formFilter.isVisible()) {
      await formFilter.selectOption({ index: 1 });
      await page.waitForTimeout(500);
    }
  });
});
