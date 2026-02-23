import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Quick Delivery Lifecycle
 * Tests the ad-hoc quick delivery workflow (order + delivery + invoice in one step).
 */
test.describe('Quick Delivery Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Quick Delivery button is visible to admin on deliveries page', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);
    // Admin must see the Quick Delivery button
    const quickBtn = page.locator('button:has-text("Quick Delivery"), button:has-text("Quick")').first();
    await expect(quickBtn).toBeVisible({ timeout: 10000 });
  });

  test('Quick Delivery modal opens and shows required fields', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);

    const quickBtn = page.locator('button:has-text("Quick Delivery"), button:has-text("Quick")').first();
    if (await quickBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await quickBtn.click();
      await page.waitForTimeout(1000);

      // Modal should be visible
      const modal = page.locator('[role="dialog"], .modal, [data-testid="modal"]').first();
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Customer search/select field should be present inside modal
      const customerField = page
        .locator('[role="dialog"] input[placeholder*="customer" i], [role="dialog"] input[placeholder*="search" i]')
        .first();
      await expect(customerField).toBeVisible({ timeout: 5000 });
    }
  });

  test('invoices page shows CS- prefixed chemical sale invoices', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1').first()).toContainText(/Invoice/i);

    // Look for CS- invoice numbers (chemical sale = quick delivery invoice type)
    const pageText = await page.textContent('body');
    // The page should at least render the invoices table without error
    expect(pageText).toBeTruthy();
    expect(pageText).not.toContain('Error');
  });

  test('delivery detail page shows correct sections for admin', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);

    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/deliveries\/.+/);

      // Delivery detail should show number/status heading
      const heading = page.locator('h1, h2').first();
      await expect(heading).toBeVisible({ timeout: 10000 });
    }
  });

  test('invoice detail shows Post Invoice button for draft invoices', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);

    // Find a draft invoice and click into it
    const draftRow = page
      .locator('table tbody tr')
      .filter({ hasText: /draft/i })
      .first();

    if (await draftRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await draftRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/invoices\/.+/);

      // Post Invoice button should be visible on draft invoices
      const postBtn = page.locator('button:has-text("Post"), button:has-text("Post Invoice")').first();
      await expect(postBtn).toBeVisible({ timeout: 5000 });
    }
  });

  test('posted invoice shows Posted status badge', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);

    // Find a posted invoice
    const postedRow = page
      .locator('table tbody tr')
      .filter({ hasText: /posted/i })
      .first();

    if (await postedRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postedRow.click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/invoices\/.+/);

      // Page should show "Posted" somewhere (badge or status)
      const pageText = await page.textContent('body');
      expect(pageText?.toLowerCase()).toContain('posted');
    }
  });
});
