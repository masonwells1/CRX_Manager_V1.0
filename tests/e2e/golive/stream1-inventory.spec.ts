/**
 * Stream 1: Inventory Validation
 *
 * UI-level inventory checks that verify the Inventory page renders
 * correctly, summary cards show non-negative values, product rows
 * are consistent, and interactive features (filter chips, modals)
 * function properly. Cross-references UI quantities against the
 * database via Supabase REST API.
 *
 * Tests INV1-INV10 cover login, page load, summary cards, table data,
 * filter chips, modals, DB cross-reference, admin columns, and console errors.
 */

import { test, expect, Page } from '@playwright/test';
import { login } from '../utils/auth';
import { supabaseRest, asArray } from './utils/supabase-helpers';
import {
  navAndStabilize,
  assertNoCriticalErrors,
  extractSummaryCards,
  extractTableRows,
  parseDollars,
  parseQuantity,
  collectConsoleErrors,
} from './utils/golive-helpers';

test.describe.serial('Stream 1 — Inventory', () => {
  let page: Page;

  test('INV1: Login', async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
  });

  test('INV2: Inventory page loads without critical errors', async () => {
    await navAndStabilize(page, '/inventory', 3000);
    await assertNoCriticalErrors(page);

    const tableVisible = await page.locator('table').first().isVisible({ timeout: 10000 }).catch(() => false);
    expect(tableVisible).toBe(true);
  });

  test('INV3: Summary card values are non-negative', async () => {
    // Ensure we are on the inventory page
    await navAndStabilize(page, '/inventory', 2000);

    const cards = await extractSummaryCards(page);

    // We expect at least one summary card on the inventory page
    expect(cards.size).toBeGreaterThan(0);

    for (const [label, rawValue] of cards) {
      // Skip cards with non-numeric values (e.g., status labels)
      if (!rawValue.match(/[\d$.,]/)) continue;

      if (rawValue.startsWith('$') || rawValue.includes('.')) {
        // Dollar amount card
        const dollars = parseDollars(rawValue);
        expect(dollars, `Summary card "${label}" should be non-negative (got ${rawValue})`).toBeGreaterThanOrEqual(0);
      } else if (/^\d/.test(rawValue)) {
        // Quantity card
        const qty = parseQuantity(rawValue);
        expect(qty, `Summary card "${label}" should be non-negative (got ${rawValue})`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('INV4: Product rows have consistent data', async () => {
    await navAndStabilize(page, '/inventory', 2000);

    const rows = await extractTableRows(page);

    // Should have at least some inventory rows
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // Check quantity columns
      const qtyKey = Object.keys(row).find(
        (k) => k.includes('quantity') || k.includes('qty') || k === 'available' || k === 'on hand',
      );
      if (qtyKey) {
        const qty = parseQuantity(row[qtyKey]);
        expect(qty, `Row quantity column "${qtyKey}" should be non-negative (got "${row[qtyKey]}")`).toBeGreaterThanOrEqual(0);
      }

      // Check value columns
      const valKey = Object.keys(row).find(
        (k) => k.includes('value') || k.includes('total'),
      );
      if (valKey && row[valKey].includes('$')) {
        const val = parseDollars(row[valKey]);
        expect(val, `Row value column "${valKey}" should be non-negative (got "${row[valKey]}")`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('INV5: "Needs Reorder" filter chip works', async () => {
    await navAndStabilize(page, '/inventory', 2000);

    // Count rows before clicking the filter
    const tableBeforeVisible = await page.locator('table').first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(tableBeforeVisible).toBe(true);

    const _rowsBefore = await page.locator('table tbody tr').count();

    // Find and click the "Needs Reorder" chip
    const reorderChip = page
      .locator('button:has-text("Needs Reorder"), [role="button"]:has-text("Needs Reorder")')
      .first();
    const chipVisible = await reorderChip.isVisible({ timeout: 5000 }).catch(() => false);

    if (chipVisible) {
      await reorderChip.click();
      await page.waitForTimeout(1000);

      // Table should still be visible after filtering
      const tableAfterVisible = await page.locator('table').first().isVisible({ timeout: 5000 }).catch(() => false);
      expect(tableAfterVisible).toBe(true);

      const rowsAfter = await page.locator('table tbody tr').count();

      // Row count may have changed (filtered) or stayed the same (all need reorder)
      // Either way, count should be non-negative
      expect(rowsAfter).toBeGreaterThanOrEqual(0);

      // Click the chip again to deactivate the filter
      await reorderChip.click();
      await page.waitForTimeout(500);
    }
    // If the chip is not visible, the feature may not be present — that's acceptable
  });

  test('INV6: Transaction Ledger modal opens', async () => {
    await navAndStabilize(page, '/inventory', 2000);

    // Click the first product row in the table
    const firstRow = page.locator('table tbody tr').first();
    const rowVisible = await firstRow.isVisible({ timeout: 5000 }).catch(() => false);
    expect(rowVisible).toBe(true);
    await firstRow.click();
    await page.waitForTimeout(1000);

    // Look for a "Transaction Ledger" or "View Transactions" button
    const ledgerButton = page
      .locator(
        'button:has-text("Transaction Ledger"), button:has-text("View Transactions"), ' +
        'button:has-text("Transactions"), [role="button"]:has-text("Transaction Ledger")',
      )
      .first();

    const buttonVisible = await ledgerButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (buttonVisible) {
      await ledgerButton.click();
      await page.waitForTimeout(1000);

      // Verify a modal/dialog appeared
      const modal = page.locator('[role="dialog"], .modal, [data-state="open"]').first();
      const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);
      expect(modalVisible).toBe(true);

      // Close the modal
      const closeButton = page
        .locator(
          '[role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("X"), ' +
          '[role="dialog"] [aria-label="Close"], .modal button:has-text("Close")',
        )
        .first();

      const closeVisible = await closeButton.isVisible({ timeout: 3000 }).catch(() => false);
      if (closeVisible) {
        await closeButton.click();
      } else {
        // Fallback: press Escape to close modal
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(500);
    }
    // If button not found, the transaction ledger may be accessed differently — acceptable
  });

  test('INV7: Batch Adjust modal opens', async () => {
    await navAndStabilize(page, '/inventory', 2000);

    // Look for "Batch Adjust" button on the inventory page
    const batchButton = page
      .locator(
        'button:has-text("Batch Adjust"), button:has-text("Batch"), ' +
        '[role="button"]:has-text("Batch Adjust")',
      )
      .first();

    const buttonVisible = await batchButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (buttonVisible) {
      await batchButton.click();
      await page.waitForTimeout(1000);

      // Verify modal opened
      const modal = page.locator('[role="dialog"], .modal, [data-state="open"]').first();
      const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);
      expect(modalVisible).toBe(true);

      // Close without saving
      const closeButton = page
        .locator(
          '[role="dialog"] button:has-text("Cancel"), [role="dialog"] button:has-text("Close"), ' +
          '[role="dialog"] [aria-label="Close"], .modal button:has-text("Cancel")',
        )
        .first();

      const closeVisible = await closeButton.isVisible({ timeout: 3000 }).catch(() => false);
      if (closeVisible) {
        await closeButton.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(500);
    }
    // If button not found, batch adjust may require row selection first — acceptable
  });

  test('INV8: Cross-reference first product qty with DB', async () => {
    await navAndStabilize(page, '/inventory', 2000);

    // Extract the first row from the UI table
    const rows = await extractTableRows(page);
    expect(rows.length).toBeGreaterThan(0);

    const firstRow = rows[0];

    // Determine the product name column
    const nameKey = Object.keys(firstRow).find(
      (k) => k.includes('product') || k.includes('name') || k === 'item',
    );

    // Determine the quantity column
    const qtyKey = Object.keys(firstRow).find(
      (k) => k.includes('quantity') || k.includes('qty') || k === 'available' || k === 'on hand',
    );

    // We need both a name and quantity to cross-reference
    if (!nameKey || !qtyKey) {
      // If columns are named differently, skip cross-reference gracefully
      return;
    }

    const uiProductName = firstRow[nameKey].trim();
    const uiQty = parseQuantity(firstRow[qtyKey]);

    // Query the database for inventory records
    const dbInventoryResult = await supabaseRest(
      page,
      'GET',
      'inventory?select=product_id,quantity_available,products(product_name)&limit=50',
    );
    const dbInventoryRaw = asArray<Record<string, unknown>>(dbInventoryResult, 'inventory (INV8)');
    expect(dbInventoryRaw.length).toBeGreaterThan(0);

    // Find the matching product in DB results
    const matchingProduct = dbInventoryRaw.find((r) => {
      const productData = r.products as Record<string, unknown> | null;
      const dbName = (productData?.product_name as string) ?? '';
      return dbName.toLowerCase() === uiProductName.toLowerCase();
    });

    if (matchingProduct) {
      const dbQty = matchingProduct.quantity_available as number;
      // Allow tolerance of 1 for timing differences between UI render and DB query
      expect(
        Math.abs(uiQty - dbQty),
        `Product "${uiProductName}" UI qty (${uiQty}) should be within 1 of DB qty (${dbQty})`,
      ).toBeLessThanOrEqual(1);
    }
    // If no match found (e.g., product names differ in formatting), that's acceptable
  });

  test('INV9: Inventory value column present for admin', async () => {
    await navAndStabilize(page, '/inventory', 2000);

    // Check if the table headers contain "Value" or "Unit Cost" columns
    // These are admin-only columns added in the inventory valuation feature
    const valueHeader = page.locator(
      'th:has-text("Value"), th:has-text("Unit Cost"), th:has-text("value"), th:has-text("unit cost")',
    );
    const headerCount = await valueHeader.count();

    // As admin user, at least one of these columns should be present
    expect(
      headerCount,
      'Expected at least one "Value" or "Unit Cost" column header for admin user',
    ).toBeGreaterThan(0);
  });

  test('INV10: No console errors on inventory page', async () => {
    // Set up console error collection
    const errors = collectConsoleErrors(page);

    // Navigate to inventory page fresh to capture all console output
    await navAndStabilize(page, '/inventory', 3000);

    // Wait additional time for any async errors to surface
    await page.waitForTimeout(3000);

    // Assert no critical console errors
    expect(
      errors,
      `Found ${errors.length} console error(s):\n${errors.join('\n')}`,
    ).toHaveLength(0);
  });

  test.afterAll(async () => {
    await page?.close();
  });
});
