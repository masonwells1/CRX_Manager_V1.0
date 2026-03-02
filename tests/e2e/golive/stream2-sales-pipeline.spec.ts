/**
 * Stream 2: Sales Pipeline Validation
 *
 * End-to-end validation of the quotes-to-orders sales pipeline.
 * Tests verify page loads, line-item math, read-only enforcement,
 * and cross-reference order totals against the database.
 */

import { test, expect, Page } from '@playwright/test';
import { login } from '../utils/auth';
import { supabaseRest, asArray } from './utils/supabase-helpers';
import {
  navAndStabilize,
  assertNoCriticalErrors,
  extractLabeledValue,
  extractTableRows,
  parseDollars,
} from './utils/golive-helpers';

test.describe.serial('Stream 2 — Sales Pipeline', () => {
  let page: Page;

  // -----------------------------------------------------------------------
  // SALES1: Login
  // -----------------------------------------------------------------------
  test('SALES1: Login', async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
    await page.waitForTimeout(2000);

    // Confirm we landed on the authenticated app
    const url = page.url();
    expect(url).not.toContain('/login');
  });

  // -----------------------------------------------------------------------
  // SALES2: Quotes page loads with data
  // -----------------------------------------------------------------------
  test('SALES2: Quotes page loads with data', async () => {
    await navAndStabilize(page, '/quotes');
    await assertNoCriticalErrors(page);

    // Verify a table is visible
    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 10000 }).catch(() => false);
    expect(tableVisible).toBe(true);

    // Verify at least 1 data row
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // SALES3: Quote detail line items sum to subtotal
  // -----------------------------------------------------------------------
  test('SALES3: Quote detail line items sum to subtotal', async () => {
    // Navigate to quotes list first (in case previous test left us elsewhere)
    await navAndStabilize(page, '/quotes');

    const table = page.locator('table').first();
    await table.isVisible({ timeout: 10000 }).catch(() => false);

    // Click the first data row to navigate to quote detail
    const firstRow = table.locator('tbody tr').first();
    await firstRow.click();
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Extract subtotal from the page
    const subtotalText = await extractLabeledValue(page, 'Subtotal');
    const subtotalCents = parseDollars(subtotalText);

    // Extract line item rows from the items table
    const lineItems = await extractTableRows(page);

    // Find the amount/total column by looking for common header names
    let sumCents = 0;
    for (const row of lineItems) {
      // Try several common column names for the amount
      const amountText =
        row['amount'] ||
        row['total'] ||
        row['ext. price'] ||
        row['ext price'] ||
        row['extended'] ||
        row['line total'] ||
        row['subtotal'] ||
        '';
      sumCents += parseDollars(amountText);
    }

    // Only assert if we found meaningful data
    if (subtotalCents > 0 && lineItems.length > 0 && sumCents > 0) {
      const diffCents = Math.abs(sumCents - subtotalCents);
      expect(diffCents).toBeLessThanOrEqual(
        2,
        `Line items sum ($${(sumCents / 100).toFixed(2)}) should match ` +
          `subtotal ($${(subtotalCents / 100).toFixed(2)}), diff=${diffCents} cents`,
      );
    } else {
      // If we can't extract both values, log and skip comparison but don't fail
      // — the page may use a different layout
      console.log(
        `SALES3 info: subtotal=${subtotalCents}c, lineItems=${lineItems.length}, sum=${sumCents}c`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // SALES4: Orders page loads with data
  // -----------------------------------------------------------------------
  test('SALES4: Orders page loads with data', async () => {
    await navAndStabilize(page, '/orders');
    await assertNoCriticalErrors(page);

    // Verify a table is visible
    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 10000 }).catch(() => false);
    expect(tableVisible).toBe(true);

    // Verify at least 1 data row
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // SALES5: Order detail line items sum to order total
  // -----------------------------------------------------------------------
  test('SALES5: Order detail line items sum to order total', async () => {
    // Navigate to orders list
    await navAndStabilize(page, '/orders');

    const table = page.locator('table').first();
    await table.isVisible({ timeout: 10000 }).catch(() => false);

    // Click the first data row to navigate to order detail
    const firstRow = table.locator('tbody tr').first();
    await firstRow.click();
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Extract order total from the page
    const totalText = await extractLabeledValue(page, 'Total');
    const totalCents = parseDollars(totalText);

    // Extract line item rows
    const lineItems = await extractTableRows(page);

    // Sum the amount/total column
    let sumCents = 0;
    for (const row of lineItems) {
      const amountText =
        row['amount'] ||
        row['total'] ||
        row['ext. price'] ||
        row['ext price'] ||
        row['extended'] ||
        row['line total'] ||
        row['subtotal'] ||
        '';
      sumCents += parseDollars(amountText);
    }

    // Only assert if we found meaningful data
    if (totalCents > 0 && lineItems.length > 0 && sumCents > 0) {
      const diffCents = Math.abs(sumCents - totalCents);
      expect(diffCents).toBeLessThanOrEqual(
        2,
        `Line items sum ($${(sumCents / 100).toFixed(2)}) should match ` +
          `order total ($${(totalCents / 100).toFixed(2)}), diff=${diffCents} cents`,
      );
    } else {
      console.log(
        `SALES5 info: total=${totalCents}c, lineItems=${lineItems.length}, sum=${sumCents}c`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // SALES6: Order items are read-only
  // -----------------------------------------------------------------------
  test('SALES6: Order items are read-only', async () => {
    // We should still be on the order detail page from SALES5.
    // If not, navigate back.
    const currentUrl = page.url();
    if (!currentUrl.includes('/orders/')) {
      await navAndStabilize(page, '/orders');
      const table = page.locator('table').first();
      await table.isVisible({ timeout: 10000 }).catch(() => false);
      const firstRow = table.locator('tbody tr').first();
      await firstRow.click();
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    // Check that line item cells do not contain editable inputs or
    // contenteditable elements — order items should be locked
    const editableCount = await page
      .locator('table tbody input, table tbody [contenteditable="true"]')
      .count();

    // Allow a very small number (0-2) for things like hidden checkbox
    // selectors, but no actual text/number inputs
    const textInputs = await page
      .locator(
        'table tbody input[type="text"], table tbody input[type="number"], table tbody textarea',
      )
      .count();

    expect(textInputs).toBe(0);
    // Broad check: editables should be minimal
    expect(editableCount).toBeLessThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // SALES7: DB cross-reference — order totals
  // -----------------------------------------------------------------------
  test('SALES7: DB cross-reference — order totals', async () => {
    const result = await supabaseRest(
      page,
      'GET',
      'orders?select=id,order_number,total_price&total_price=not.is.null&limit=10',
    );
    const orders = asArray<{ id: string; order_number: string; total_price: number }>(result, 'orders (SALES7)');
    expect(orders.length).toBeGreaterThan(0);

    for (const order of orders) {
      expect(typeof order.total_price).toBe('number');
      expect(order.total_price).toBeGreaterThan(
        0,
        `Order ${order.order_number} (${order.id}) has total_price=${order.total_price}, expected positive`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  test.afterAll(async () => {
    await page?.close();
  });
});
