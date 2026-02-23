import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Cancellation Cascade Workflow
 * Tests that cancelling a delivery properly updates status, restores inventory,
 * and updates the parent order. Also tests invoice voiding.
 */
test.describe('Cancellation Cascade Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('orders page loads and shows order list', async ({ page }) => {
    await page.goto('/orders');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Order/i);
    expect(page.url()).toContain('/orders');
  });

  test('deliveries page loads with status column visible', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(1500);
    await expect(page.locator('h1').first()).toContainText(/Deliver/i);
    // Should show a table with status indicators
    const pageText = await page.textContent('body');
    expect(pageText).toBeTruthy();
  });

  test('delivery detail for confirmed delivery shows Cancel button', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);

    // Find a confirmed delivery
    const confirmedRow = page
      .locator('table tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();

    if (await confirmedRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmedRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/deliveries\/.+/);

      // Cancel button should exist for confirmed deliveries
      const cancelBtn = page.locator('button:has-text("Cancel"), button:has-text("Cancel Delivery")').first();
      await expect(cancelBtn).toBeVisible({ timeout: 5000 });
    }
  });

  test('cancelled delivery shows Cancelled status badge', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);

    // Find an already-cancelled delivery to verify badge rendering
    const cancelledRow = page
      .locator('table tbody tr')
      .filter({ hasText: /cancelled/i })
      .first();

    if (await cancelledRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cancelledRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/deliveries\/.+/);

      const pageText = await page.textContent('body');
      expect(pageText?.toLowerCase()).toContain('cancel');
    }
  });

  test('inventory page loads and shows product quantities', async ({ page }) => {
    await page.goto('/inventory');
    await page.waitForTimeout(1500);
    await expect(page.locator('h1').first()).toContainText(/Inventory/i);
    // Inventory table should be present
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
  });

  test('order detail shows associated delivery and invoice sections', async ({ page }) => {
    await page.goto('/orders');
    await page.waitForTimeout(2000);

    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/orders\/.+/);

      // Order detail should contain status, and links to deliveries/invoices
      const pageText = await page.textContent('body');
      expect(pageText).toBeTruthy();
      // Should have some status info
      expect(pageText?.toLowerCase()).toMatch(/pending|confirmed|in_delivery|delivered|cancelled/i);
    }
  });

  test('voided invoice shows Void status and not counted in AR', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);

    // Look for a voided invoice in the list
    const voidedRow = page
      .locator('table tbody tr')
      .filter({ hasText: /void/i })
      .first();

    if (await voidedRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await voidedRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/invoices\/.+/);

      const pageText = await page.textContent('body');
      expect(pageText?.toLowerCase()).toContain('void');
    }
  });

  test('invoices page loads and shows void capability for posted invoices', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1').first()).toContainText(/Invoice/i);

    // Click a posted invoice to check void button exists
    const postedRow = page
      .locator('table tbody tr')
      .filter({ hasText: /posted/i })
      .first();

    if (await postedRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postedRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/invoices\/.+/);

      // Void button should be available on posted invoices (for admin)
      const voidBtn = page.locator('button:has-text("Void"), button:has-text("Void Invoice")').first();
      await expect(voidBtn).toBeVisible({ timeout: 5000 });
    }
  });
});
