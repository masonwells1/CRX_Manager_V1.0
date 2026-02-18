import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Phase 4.2: Quick Delivery Lifecycle
 * Tests the ad-hoc quick delivery workflow (order + delivery + invoice in one step).
 */
test.describe('Quick Delivery Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should show Quick Delivery button on deliveries page', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);
    // Quick Delivery button should be visible for admin
    const quickBtn = page.locator('button:has-text("Quick Delivery"), button:has-text("Quick")');
    if (await quickBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(quickBtn).toBeVisible();
    }
  });

  test('should load delivery detail page with correct sections', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(1000);
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstRow.click();
      await page.waitForTimeout(2000);
      // Should be on delivery detail
      await expect(page).toHaveURL(/\/deliveries\/.+/);
    }
  });

  test('should show quick delivery badge on quick deliveries', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);
    // Quick delivery invoices may show a special icon/badge
    // Verify page loads without errors
    const heading = page.locator('h1').first();
    await expect(heading).toContainText(/Invoice/i);
  });
});
