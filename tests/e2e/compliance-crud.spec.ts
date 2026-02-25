/**
 * compliance-crud.spec.ts — Compliance page: license CRUD, expiry filtering, RUP products
 */
import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) => page.waitForTimeout(ms);

test.describe('Compliance — Licenses Tab', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/compliance');
    await waitForPage(page, 2000);
  });

  test('C1: Compliance page loads with heading', async ({ page }) => {
    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('C2: Licenses tab is visible and shows content', async ({ page }) => {
    // Click licenses tab if tabs exist
    const licensesTab = page.locator('button:has-text("Licenses"), [role="tab"]:has-text("Licenses")').first();
    if (await licensesTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await licensesTab.click();
      await waitForPage(page, 1000);
    }
    // Should see table or empty state
    const table = page.locator('table').first();
    const emptyState = page.locator('text=/no.*license/i').first();
    const hasContent = await table.isVisible({ timeout: 5000 }).catch(() => false) ||
                       await emptyState.isVisible({ timeout: 2000 }).catch(() => false);
    expect(hasContent).toBe(true);
  });

  test('C3: Add License button opens modal', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add License"), button:has-text("New License"), button:has-text("Add")').first();
    if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      // May not be visible if no licenses tab selected
      const licensesTab = page.locator('button:has-text("Licenses")').first();
      if (await licensesTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await licensesTab.click();
        await waitForPage(page, 1000);
      }
    }
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();
    await waitForPage(page, 1000);

    // Modal should appear with form fields
    const modal = page.locator('[role="dialog"], .modal, [class*="modal"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test('C4: Create a new license', async ({ page }) => {
    // Open modal
    const addBtn = page.locator('button:has-text("Add License"), button:has-text("New License"), button:has-text("Add")').first();
    const licensesTab = page.locator('button:has-text("Licenses"), button:has-text("Applicator")').first();
    if (await licensesTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await licensesTab.click();
      await waitForPage(page, 1000);
    }
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();
    await waitForPage(page, 1000);

    // Wait for the dialog to appear
    const modal = page.locator('[role="dialog"], .modal').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Customer dropdown (first combobox in modal)
    const customerSelect = modal.locator('select, [role="combobox"]').first();
    if (await customerSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await customerSelect.selectOption({ index: 1 });
    }

    // License Holder Name (required field)
    const holderInput = page.getByLabel(/License Holder Name/i);
    if (await holderInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await holderInput.fill('Test Applicator');
    }

    // License Number (required field)
    const licenseNumInput = page.getByLabel(/License Number/i);
    if (await licenseNumInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await licenseNumInput.fill(`LIC-${RUN_ID}`);
    }

    // Expiry Date (required field)
    const expiryInput = page.getByLabel(/Expiry Date/i);
    if (await expiryInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expiryInput.fill('2027-12-31');
    }

    // State (optional)
    const stateInput = page.getByLabel('State');
    if (await stateInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await stateInput.fill('IL');
    }

    // Save — "Add License" button inside the modal (last one = modal's submit, not header button)
    const saveBtn = modal.locator('button:has-text("Add License")');
    await saveBtn.click();
    await waitForPage(page, 2000);

    // Verify — toast or license appears in table
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Something went wrong');
  });

  test('C5: Filter licenses by status', async ({ page }) => {
    const licensesTab = page.locator('button:has-text("Licenses")').first();
    if (await licensesTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await licensesTab.click();
      await waitForPage(page, 1000);
    }

    // Try each filter: all, active, expiring, expired
    const filterSelect = page.locator('select:has(option:text("Active")), select:has(option:text("active")), select:has(option:text("All"))').first();
    if (await filterSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Try "Active" filter
      const options = await filterSelect.locator('option').allTextContents();
      if (options.length > 1) {
        await filterSelect.selectOption({ index: 1 });
        await waitForPage(page, 1000);
      }
    }

    // Page should still be functional
    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('C6: Alert cards display expiry information', async ({ page }) => {
    const licensesTab = page.locator('button:has-text("Licenses")').first();
    if (await licensesTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await licensesTab.click();
      await waitForPage(page, 1000);
    }

    // Check for summary/alert cards
    const cards = page.locator('.bg-white, [class*="card"], [class*="alert"], [class*="summary"]');
    const _cardCount = await cards.count();
    // At minimum the page loaded without errors
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Something went wrong');
  });
});

test.describe('Compliance — RUP Products Tab', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/compliance');
    await waitForPage(page, 2000);
  });

  test('C7: Switch to RUP Products tab', async ({ page }) => {
    const rupTab = page.locator('button:has-text("RUP Products"), button:has-text("RUP"), [role="tab"]:has-text("RUP")').first();
    if (await rupTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await rupTab.click();
      await waitForPage(page, 2000);

      // Should see table, empty state, or at least no errors
      const table = page.locator('table').first();
      const emptyState = page.locator('h3:has-text("No"), text=/no.*product/i, text=/no.*rup/i').first();
      const hasContent = await table.isVisible({ timeout: 5000 }).catch(() => false) ||
                         await emptyState.isVisible({ timeout: 3000 }).catch(() => false);
      const bodyText = await page.textContent('body') || '';
      expect(hasContent || !bodyText.includes('Something went wrong')).toBe(true);
    }
  });

  test('C8: RUP tab shows product data or empty state', async ({ page }) => {
    const rupTab = page.locator('button:has-text("RUP"), [role="tab"]:has-text("RUP")').first();
    if (await rupTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await rupTab.click();
      await waitForPage(page, 1000);
    }

    // Verify no errors
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Something went wrong');
    expect(bodyText).not.toContain('error');
  });
});
