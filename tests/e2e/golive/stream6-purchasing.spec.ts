/**
 * Stream 6: Purchasing & Receiving Validation
 *
 * End-to-end tests for purchase orders, receiving, and quick receive.
 * Validates UI rendering, line-item math, and DB-level data integrity
 * for the purchasing pipeline.
 *
 * PO1-PO3: Purchase order list and detail validation
 * PO4-PO5: Receiving page structure and quantity sanity
 * PO6:     Quick Receive wizard structure
 * PO7:     DB cross-reference for PO data integrity
 */

import { test, expect, Page } from '@playwright/test';
import { login } from '../utils/auth';
import { supabaseRest, asArray } from './utils/supabase-helpers';
import {
  navAndStabilize,
  assertNoCriticalErrors,
  extractTableRows,
  extractSummaryCards,
  parseDollars,
  parseQuantity,
  collectConsoleErrors,
} from './utils/golive-helpers';

test.describe.serial('Stream 6 — Purchasing', () => {
  let page: Page;
  let _consoleErrors: string[];

  // ---------------------------------------------------------------------------
  // PO1: Login
  // ---------------------------------------------------------------------------
  test('PO1: Login', async ({ browser }) => {
    page = await browser.newPage();
    _consoleErrors = collectConsoleErrors(page);
    await login(page);
    await page.waitForTimeout(2000);

    // Verify session is active by checking we landed on the main page
    const url = page.url();
    expect(url).not.toContain('/login');
  });

  // ---------------------------------------------------------------------------
  // PO2: Purchase Orders page loads
  // ---------------------------------------------------------------------------
  test('PO2: Purchase Orders page loads', async () => {
    await navAndStabilize(page, '/purchase-orders');
    await assertNoCriticalErrors(page);

    // Verify the page has a table (PO list)
    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 10000 }).catch(() => false);
    expect(tableVisible).toBe(true);

    // Verify the table has at least a header row
    const headerCells = await table.locator('thead th, thead td').count();
    expect(headerCells).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // PO3: PO detail line items sum to total
  // ---------------------------------------------------------------------------
  test('PO3: PO detail line items sum to total', async () => {
    await navAndStabilize(page, '/purchase-orders');

    const firstRow = page.locator('table tbody tr').first();
    const rowVisible = await firstRow.isVisible({ timeout: 5000 }).catch(() => false);

    if (!rowVisible) {
      // No POs exist -- skip gracefully
      test.skip();
      return;
    }

    await firstRow.click();
    await page.waitForTimeout(3000);

    // Look for a total value on the detail page (header area or summary)
    const bodyText = (await page.locator('body').textContent()) ?? '';

    // Extract the PO total from a labeled value or heading area
    // Common patterns: "Total: $1,234.56" or "Total Amount" card
    const totalMatch = bodyText.match(/Total(?:\s+Amount)?[:\s]*\$([\d,]+\.?\d*)/i);
    const poTotal = totalMatch ? parseDollars(`$${totalMatch[1]}`) : null;

    // Extract line items table
    const detailTable = page.locator('table').first();
    const detailTableVisible = await detailTable.isVisible({ timeout: 5000 }).catch(() => false);

    if (!detailTableVisible || poTotal === null) {
      // Can't verify math without both values -- just ensure no errors
      await assertNoCriticalErrors(page);
      return;
    }

    const rows = await extractTableRows(page, detailTable);

    if (rows.length === 0) {
      // No line items -- just verify page loaded cleanly
      await assertNoCriticalErrors(page);
      return;
    }

    // Sum line item amounts -- look for "amount", "total", "ext price", "extended" column
    let lineItemSum = 0;
    let foundAmountColumn = false;

    const amountKeys = ['amount', 'total', 'ext price', 'extended', 'extended price', 'line total', 'ext. price'];
    for (const row of rows) {
      for (const key of amountKeys) {
        if (row[key] !== undefined && row[key] !== '') {
          const val = parseDollars(row[key]);
          if (val !== null && !isNaN(val)) {
            lineItemSum += val;
            foundAmountColumn = true;
          }
          break;
        }
      }
    }

    if (foundAmountColumn && poTotal > 0) {
      // Compare with 2-cent tolerance (floating point rounding)
      const diff = Math.abs(poTotal - lineItemSum);
      expect(diff).toBeLessThanOrEqual(0.02);
    } else {
      // Could not find amount column -- verify no errors at minimum
      await assertNoCriticalErrors(page);
    }
  });

  // ---------------------------------------------------------------------------
  // PO4: Receiving page loads
  // ---------------------------------------------------------------------------
  test('PO4: Receiving page loads', async () => {
    await navAndStabilize(page, '/receiving');
    await assertNoCriticalErrors(page);

    // Verify content is visible -- table or cards
    const table = page.locator('table').first();
    const cards = page.locator('[class*="rounded"], [class*="card"]').first();

    const tableVisible = await table.isVisible({ timeout: 5000 }).catch(() => false);
    const cardsVisible = await cards.isVisible({ timeout: 3000 }).catch(() => false);

    expect(tableVisible || cardsVisible).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // PO5: Receiving quantities are non-negative
  // ---------------------------------------------------------------------------
  test('PO5: Receiving quantities are non-negative', async () => {
    await navAndStabilize(page, '/receiving');

    const summaryCards = await extractSummaryCards(page);

    // If summary cards exist, verify all quantity-like values are >= 0
    for (const [label, rawValue] of summaryCards) {
      const qty = parseQuantity(rawValue);
      if (qty !== null && !isNaN(qty)) {
        expect(qty, `Summary card "${label}" has negative quantity: ${rawValue}`).toBeGreaterThanOrEqual(0);
      }

      // Also check dollar values are non-negative
      const dollars = parseDollars(rawValue);
      if (dollars !== null && !isNaN(dollars)) {
        expect(dollars, `Summary card "${label}" has negative dollar value: ${rawValue}`).toBeGreaterThanOrEqual(0);
      }
    }

    // Also check table rows if visible
    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 3000 }).catch(() => false);
    if (tableVisible) {
      const rows = await extractTableRows(page, table);
      for (const row of rows) {
        // Check any column that looks like a quantity
        for (const [col, val] of Object.entries(row)) {
          if (col.includes('qty') || col.includes('quantity') || col.includes('received') || col.includes('ordered')) {
            const qty = parseQuantity(val);
            if (qty !== null && !isNaN(qty)) {
              expect(qty, `Row column "${col}" has negative value: ${val}`).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // PO6: Quick Receive page structure
  // ---------------------------------------------------------------------------
  test('PO6: Quick Receive page structure', async () => {
    await navAndStabilize(page, '/receiving/quick');
    await assertNoCriticalErrors(page);

    // Verify the page has a heading
    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Look for multi-step wizard indicators:
    // - Step indicators (e.g. "Step 1", "Step 2")
    // - Next/Back buttons
    // - Numbered sections
    // - Progress indicators
    const bodyText = (await page.locator('body').textContent()) ?? '';

    const hasStepIndicators = /step\s*[12]/i.test(bodyText);
    const hasNextButton = await page
      .locator('button:has-text("Next"), button:has-text("Review"), button:has-text("Continue")')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const hasBackButton = await page
      .locator('button:has-text("Back"), button:has-text("Previous"), button:has-text("Cancel")')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const hasNumberedSections = /\b[1-3]\.\s/.test(bodyText);

    // At least one wizard/form structure indicator should be present
    const hasWizardStructure = hasStepIndicators || hasNextButton || hasBackButton || hasNumberedSections;

    // Also check for form elements (dropdowns, inputs) which indicate a form structure
    const hasFormElements = await page
      .locator('select, [role="combobox"], input[type="text"], input[placeholder]')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    expect(
      hasWizardStructure || hasFormElements,
      'Quick Receive should have wizard steps, navigation buttons, or form elements',
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // PO7: DB cross-reference PO data
  // ---------------------------------------------------------------------------
  test('PO7: DB cross-reference PO data', async () => {
    // --- Part 1: Validate purchase_orders ---
    const poResult = await supabaseRest(
      page,
      'GET',
      'purchase_orders?select=id,po_number,status,total_cost&limit=20',
    );
    const purchaseOrders = asArray<{
      id: string;
      po_number: string;
      status: string;
      total_cost: number | null;
    }>(poResult, 'purchase_orders');

    const validStatuses = new Set([
      'draft',
      'submitted',
      'partially_received',
      'fully_received',
      'cancelled',
      'sent',
      'approved',
      'received',
      'closed',
    ]);

    for (const po of purchaseOrders) {
      // Every PO must have a valid status
      expect(
        validStatuses.has(po.status),
        `PO ${po.po_number} has invalid status: "${po.status}"`,
      ).toBe(true);

      // total_cost should be non-negative (if set)
      if (po.total_cost !== null && po.total_cost !== undefined) {
        expect(
          po.total_cost,
          `PO ${po.po_number} has negative total_cost: ${po.total_cost}`,
        ).toBeGreaterThanOrEqual(0);
      }
    }

    // --- Part 2: Validate purchase_order_items ---
    const poiResult = await supabaseRest(
      page,
      'GET',
      'purchase_order_items?select=purchase_order_id,quantity_ordered,quantity_received&limit=100',
    );
    const poItems = asArray<{
      purchase_order_id: string;
      quantity_ordered: number;
      quantity_received: number;
    }>(poiResult, 'purchase_order_items');

    for (const item of poItems) {
      const qtyOrdered = item.quantity_ordered ?? 0;
      const qtyReceived = item.quantity_received ?? 0;

      // quantity_received should never exceed quantity_ordered
      expect(
        qtyReceived,
        `PO item (PO ${item.purchase_order_id}) has quantity_received (${qtyReceived}) > quantity_ordered (${qtyOrdered})`,
      ).toBeLessThanOrEqual(qtyOrdered);

      // Both quantities should be non-negative
      expect(qtyOrdered, 'quantity_ordered should be non-negative').toBeGreaterThanOrEqual(0);
      expect(qtyReceived, 'quantity_received should be non-negative').toBeGreaterThanOrEqual(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------
  test.afterAll(async () => {
    await page?.close();
  });
});
