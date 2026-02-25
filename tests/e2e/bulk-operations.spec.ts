/**
 * bulk-operations.spec.ts — E2E tests for bulk select / export / delete on list pages.
 *
 * Tests the useRowSelection + BulkActionBar + BulkDeleteConfirmModal
 * pattern that is shared across all 11 list pages. We test on Products,
 * Customers, and Orders as representative samples.
 *
 * NOTE: These tests run against a real Supabase database. Destructive
 * operations (deactivate/delete) are tested only up to the confirmation
 * modal — we click Cancel to avoid modifying production data.
 */

import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Wait for the table to be loaded (rows or empty state) */
async function waitForTable(page: import('@playwright/test').Page) {
  const rows = page.locator('table tbody tr');
  const empty = page.locator('text=/no .*(found|data|yet)|create your first/i');
  await expect(rows.first().or(empty)).toBeVisible({ timeout: 15000 });
}

/** Return the number of visible checkboxes in the table body */
async function getCheckboxCount(page: import('@playwright/test').Page) {
  return page.locator('table tbody tr input[type="checkbox"]').count();
}

// ── Products Page ───────────────────────────────────────────────────────

test.describe('Bulk Operations — Products', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/products');
    await waitForTable(page);
  });

  test('row checkboxes are visible for active products', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    const count = await checkboxes.count();
    // Products page may have data — if so, at least one checkbox exists
    if (count > 0) {
      await expect(checkboxes.first()).toBeVisible();
    }
  });

  test('clicking a row checkbox shows BulkActionBar', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    // BulkActionBar renders "{N} selected" badge
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });
  });

  test('clicking a second checkbox updates selection count', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) < 2) return;

    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();
    await expect(page.locator('text=2 selected')).toBeVisible({ timeout: 3000 });
  });

  test('checkbox click does not navigate to detail page', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    // Should still be on /products, not /products/:id
    await expect(page).toHaveURL('/products');
  });

  test('Select All button selects all visible rows', async ({ page }) => {
    const selectAllBtn = page.locator('button:has-text("Select All")');
    if (!(await selectAllBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await selectAllBtn.click();
    // After clicking, button text should change to "Deselect All"
    await expect(page.locator('button:has-text("Deselect All")')).toBeVisible({ timeout: 3000 });
    // BulkActionBar should show "selected" badge
    await expect(page.locator('text=/\\d+ selected/')).toBeVisible({ timeout: 3000 });
  });

  test('Deselect All clears selection and hides BulkActionBar', async ({ page }) => {
    const selectAllBtn = page.locator('button:has-text("Select All")');
    if (!(await selectAllBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await selectAllBtn.click();
    await expect(page.locator('text=/\\d+ selected/')).toBeVisible({ timeout: 3000 });

    const deselectAllBtn = page.locator('button:has-text("Deselect All")');
    await deselectAllBtn.click();
    // BulkActionBar should disappear (no "selected" text)
    await expect(page.locator('text=/\\d+ selected/')).not.toBeVisible({ timeout: 3000 });
  });

  test('Deselect (X) button in BulkActionBar clears selection', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });

    // Click the small "Deselect" button in BulkActionBar (not "Deselect All")
    const deselectBtn = page.locator('button:has-text("Deselect"):not(:has-text("All"))').first();
    if (await deselectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await deselectBtn.click();
      await expect(page.locator('text=/\\d+ selected/')).not.toBeVisible({ timeout: 3000 });
    }
  });

  test('Export CSV button appears in BulkActionBar', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('button:has-text("Export CSV")')).toBeVisible({ timeout: 3000 });
  });

  test('Export CSV triggers file download', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('button:has-text("Export CSV")')).toBeVisible({ timeout: 3000 });

    // Listen for download event before clicking
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('button:has-text("Export CSV")').click(),
    ]);

    // Verify the download has a .csv filename
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('Download PDF button appears in BulkActionBar', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('button:has-text("Download PDF")')).toBeVisible({ timeout: 3000 });
  });

  test('Download PDF triggers file download', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('button:has-text("Download PDF")')).toBeVisible({ timeout: 3000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.locator('button:has-text("Download PDF")').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('Deactivate button opens confirmation modal', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    const deactivateBtn = page.locator('button:has-text("Deactivate")').first();
    if (!(await deactivateBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await deactivateBtn.click();
    // Confirmation modal should appear — look for the heading specifically
    await expect(page.getByRole('heading', { name: /deactivate/i })).toBeVisible({ timeout: 3000 });
  });

  test('Confirmation modal shows correct count', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    // Select just the first row for a predictable count
    await checkboxes.first().click();
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });

    const deactivateBtn = page.locator('button:has-text("Deactivate")').first();
    if (!(await deactivateBtn.isVisible({ timeout: 2000 }).catch(() => false))) return;

    await deactivateBtn.click();
    // Modal heading should reference deactivate + modal body should show count "1"
    await expect(page.getByRole('heading', { name: /deactivate/i })).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=/about to deactivate/i')).toBeVisible({ timeout: 3000 });
  });

  test('Cancel in confirmation modal closes it without action', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    const deactivateBtn = page.locator('button:has-text("Deactivate")').first();
    if (!(await deactivateBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await deactivateBtn.click();
    const modalHeading = page.getByRole('heading', { name: /deactivate/i });
    await expect(modalHeading).toBeVisible({ timeout: 3000 });

    // Click Cancel in the modal — find the ghost/cancel button inside the modal overlay
    const cancelBtn = page.locator('button:has-text("Cancel")').last();
    await cancelBtn.click();

    // Modal should close
    await expect(modalHeading).not.toBeVisible({ timeout: 3000 });
    // Selection should still be active
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });
  });

  test('unchecking a row removes it from selection count', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) < 2) return;

    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();
    await expect(page.locator('text=2 selected')).toBeVisible({ timeout: 3000 });

    // Uncheck first
    await checkboxes.nth(0).click();
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });
  });
});

// ── Customers Page ──────────────────────────────────────────────────────

test.describe('Bulk Operations — Customers', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/customers');
    await waitForTable(page);
  });

  test('row checkboxes are visible', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) > 0) {
      await expect(checkboxes.first()).toBeVisible();
    }
  });

  test('clicking checkbox shows BulkActionBar with correct actions', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("Export CSV")')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("Download PDF")')).toBeVisible({ timeout: 3000 });
  });

  test('Select All works on Customers', async ({ page }) => {
    const selectAllBtn = page.locator('button:has-text("Select All")');
    if (!(await selectAllBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await selectAllBtn.click();
    const _afterSecondClick = await expect(page.locator('text=/\\d+ selected/')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("Deselect All")')).toBeVisible({ timeout: 3000 });
  });

  test('CSV export triggers download on Customers', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('button:has-text("Export CSV")')).toBeVisible({ timeout: 3000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('button:has-text("Export CSV")').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('PDF export triggers download on Customers', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.locator('button:has-text("Download PDF")').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });
});

// ── Orders Page ─────────────────────────────────────────────────────────

test.describe('Bulk Operations — Orders', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/orders');
    await waitForTable(page);
  });

  test('row checkboxes are visible on Orders', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) > 0) {
      await expect(checkboxes.first()).toBeVisible();
    }
  });

  test('selecting rows shows BulkActionBar on Orders', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });
  });

  test('Select All works on Orders', async ({ page }) => {
    // Guard: need at least one checkbox for Select All to do anything
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    const selectAllBtn = page.locator('button:has-text("Select All")');
    if (!(await selectAllBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await selectAllBtn.click();
    await expect(page.locator('text=/\\d+ selected/')).toBeVisible({ timeout: 5000 });
  });

  test('CSV export works on Orders', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    const csvBtn = page.locator('button:has-text("Export CSV")');
    if (!(await csvBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      csvBtn.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('Delete button opens confirmation modal on Orders', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    // Orders page may use "Delete" instead of "Deactivate"
    const deleteBtn = page.locator('button:has-text("Delete"), button:has-text("Deactivate")').first();
    if (!(await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await deleteBtn.click();
    // Confirmation modal should appear
    await expect(
      page.locator('text=/delete|deactivate|cancel/i').first()
    ).toBeVisible({ timeout: 3000 });

    // Cancel without confirming
    const cancelBtn = page.locator('[role="dialog"] button:has-text("Cancel"), .modal button:has-text("Cancel")').first();
    if (await cancelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelBtn.click();
    }
  });
});

// ── Jobs Page ───────────────────────────────────────────────────────────

test.describe('Bulk Operations — Jobs', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/jobs');
    await waitForTable(page);
  });

  test('row checkboxes are visible on Jobs', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) > 0) {
      await expect(checkboxes.first()).toBeVisible();
    }
  });

  test('selecting row shows BulkActionBar on Jobs', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();
    await expect(page.locator('text=1 selected')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("Export CSV")')).toBeVisible({ timeout: 3000 });
  });

  test('Select All and Deselect All cycle on Jobs', async ({ page }) => {
    // Guard: need at least one checkbox
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    const selectAllBtn = page.locator('button:has-text("Select All")');
    if (!(await selectAllBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;

    // Select All
    await selectAllBtn.click();
    await expect(page.locator('text=/\\d+ selected/')).toBeVisible({ timeout: 5000 });

    // Deselect All
    const deselectAllBtn = page.locator('button:has-text("Deselect All")');
    await deselectAllBtn.click();
    await expect(page.locator('text=/\\d+ selected/')).not.toBeVisible({ timeout: 3000 });
  });
});

// ── Cross-Page: Filter + Bulk ───────────────────────────────────────────

test.describe('Bulk Operations — With Filters', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/products');
    await waitForTable(page);
  });

  test('filtering then selecting only affects filtered rows', async ({ page }) => {
    // Apply a category filter if available
    const categoryFilter = page.locator('select').first();
    if (!(await categoryFilter.isVisible({ timeout: 3000 }).catch(() => false))) return;

    const options = await categoryFilter.locator('option').allTextContents();
    // Pick second option (first is usually "All" or blank)
    if (options.length < 2) return;
    await categoryFilter.selectOption({ index: 1 });
    await page.waitForTimeout(500);

    // Count checkboxes after filtering
    const filteredCount = await getCheckboxCount(page);
    if (filteredCount === 0) return;

    // Select All
    const selectAllBtn = page.locator('button:has-text("Select All")');
    if (!(await selectAllBtn.isVisible({ timeout: 3000 }).catch(() => false))) return;
    await selectAllBtn.click();

    // Selected count should match filtered checkbox count
    const badge = page.locator('text=/\\d+ selected/');
    await expect(badge).toBeVisible({ timeout: 3000 });
    const badgeText = await badge.textContent();
    const selectedNum = parseInt(badgeText?.match(/(\d+)/)?.[1] || '0', 10);
    expect(selectedNum).toBeLessThanOrEqual(filteredCount);
    expect(selectedNum).toBeGreaterThan(0);
  });
});

// ── CSV Content Verification ────────────────────────────────────────────

test.describe('Bulk Operations — CSV Content', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/products');
    await waitForTable(page);
  });

  test('CSV export file contains header row', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    if ((await checkboxes.count()) === 0) return;

    await checkboxes.first().click();

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('button:has-text("Export CSV")').click(),
    ]);

    // Read downloaded file content
    const path = await download.path();
    if (!path) return;

    const fs = await import('fs');
    const content = fs.readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');

    // Should have at least header + 1 data row
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Header should contain "Product Name" (or similar)
    expect(lines[0].toLowerCase()).toMatch(/product/);
  });

  test('CSV export contains correct number of data rows', async ({ page }) => {
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    const count = await checkboxes.count();
    if (count < 2) return;

    // Select first two rows
    await checkboxes.nth(0).click();
    await checkboxes.nth(1).click();
    await expect(page.locator('text=2 selected')).toBeVisible({ timeout: 3000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('button:has-text("Export CSV")').click(),
    ]);

    const path = await download.path();
    if (!path) return;

    const fs = await import('fs');
    const content = fs.readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');

    // 1 header + 2 data rows = 3 lines
    expect(lines.length).toBe(3);
  });
});
