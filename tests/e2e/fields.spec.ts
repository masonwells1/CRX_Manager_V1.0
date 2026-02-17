import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Fields Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/fields');
  });

  test('should display fields page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show fields list or map view', async ({ page }) => {
    // Fields page may show a map or a list/table
    const map = page.locator('.mapboxgl-map, [class*="map"], canvas');
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no fields|no data|add your first/i');
    await expect(map.or(table).or(empty).first()).toBeVisible({ timeout: 15000 });
  });

  test('should have add field or import button', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("New"), button:has-text("Import"), a:has-text("Add")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Field Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should navigate to field detail from list', async ({ page }) => {
    await page.goto('/fields');
    const row = page.locator('tbody tr, [data-testid*="field"]').first();
    if (await row.isVisible({ timeout: 5000 }).catch(() => false)) {
      await row.click();
      await expect(page.url()).toContain('/fields/');
    }
  });
});
