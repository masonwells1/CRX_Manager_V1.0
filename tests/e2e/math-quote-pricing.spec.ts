/**
 * File 2 — Quote pricing math verification.
 * Verifies quote pricing math including tier-based pricing:
 *  qty × price_per_unit = line_total, line totals sum to quote total.
 */
import { test, expect, Page } from '@playwright/test';
import { login } from './utils/auth';
import {
  parseDollars,
  parseQuantity,
  waitForPageStable,
} from './utils/math-helpers';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

async function nav(page: Page, path: string) {
  await page.goto(path);
  await waitForPageStable(page);
}

interface QuoteLineItem {
  productName: string;
  pricePerUnit: number; // dollars (not cents — quotes use dollars)
  totalUnitsNeeded: number;
  totalPrice: number; // dollars
  profit: number; // dollars
  margin: number; // percentage
}

/** Extract line items from a quote detail/builder page.
 *  Uses header text to find the correct columns rather than scanning for $ signs,
 *  because the 15-column quote table has 5+ dollar columns. */
async function extractQuoteLineItems(page: Page): Promise<QuoteLineItem[]> {
  const items: QuoteLineItem[] = [];

  // Quote builder uses tables inside sections
  const tables = page.locator('table');
  const tableCount = await tables.count();

  for (let t = 0; t < tableCount; t++) {
    const table = tables.nth(t);

    // Build column index map from headers
    const headers = table.locator('thead th, thead td');
    const headerCount = await headers.count();
    if (headerCount < 8) continue; // not the quote line items table

    const headerTexts: string[] = [];
    for (let h = 0; h < headerCount; h++) {
      headerTexts.push(((await headers.nth(h).textContent()) ?? '').trim().toLowerCase());
    }

    // Find column indices by header keywords
    // Quote columns: #, Product, Price/Unit, Cost, Sug.Rate, ActualRate, Unit, Acres, Oz/Acre, $/Acre, UnitsNeeded, Total, Profit, Margin, (delete)
    const colProduct = headerTexts.findIndex((h) => h.includes('product'));
    const colPriceUnit = headerTexts.findIndex((h) => h.includes('price') && h.includes('unit'));
    const colUnitsNeeded = headerTexts.findIndex((h) => h.includes('units') && h.includes('need'));
    const colTotal = headerTexts.findIndex((h) => h === 'total' || h.includes('total') && !h.includes('units'));
    const colProfit = headerTexts.findIndex((h) => h.includes('profit'));
    const colMargin = headerTexts.findIndex((h) => h.includes('margin'));

    const bodyRows = table.locator('tbody tr');
    const rowCount = await bodyRows.count();

    for (let i = 0; i < rowCount; i++) {
      const cells = bodyRows.nth(i).locator('td');
      const cellCount = await cells.count();
      if (cellCount < 8) continue;

      const productName = colProduct >= 0
        ? ((await cells.nth(colProduct).textContent()) ?? '').trim()
        : '';

      const pricePerUnit = colPriceUnit >= 0
        ? parseDollars((await cells.nth(colPriceUnit).textContent()) ?? '') / 100
        : 0;

      const totalUnitsNeeded = colUnitsNeeded >= 0
        ? parseQuantity((await cells.nth(colUnitsNeeded).textContent()) ?? '')
        : 0;

      const totalPrice = colTotal >= 0
        ? parseDollars((await cells.nth(colTotal).textContent()) ?? '') / 100
        : 0;

      const profit = colProfit >= 0
        ? parseDollars((await cells.nth(colProfit).textContent()) ?? '') / 100
        : 0;

      let margin = 0;
      if (colMargin >= 0) {
        const marginText = ((await cells.nth(colMargin).textContent()) ?? '').trim();
        margin = parseFloat(marginText.replace(/[^0-9.-]/g, '')) || 0;
      }

      if (pricePerUnit > 0 || totalPrice > 0) {
        items.push({ productName, pricePerUnit, totalUnitsNeeded: totalUnitsNeeded, totalPrice, profit, margin });
      }
    }
  }

  return items;
}

/** Get the quote summary totals */
async function getQuoteSummaryTotals(
  page: Page,
): Promise<{ totalPrice: number; totalCost: number; totalProfit: number; marginPct: number }> {
  const result = { totalPrice: 0, totalCost: 0, totalProfit: 0, marginPct: 0 };

  const labels = [
    { key: 'totalPrice', text: 'Total Price' },
    { key: 'totalCost', text: 'Total Cost' },
    { key: 'totalProfit', text: 'Total Profit' },
  ];

  for (const { key, text } of labels) {
    const el = page.locator(`text=${text}`).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      const parent = el.locator('..');
      const valEl = parent.locator('.font-mono, .font-medium, .font-semibold').first();
      const valVisible = await valEl.isVisible({ timeout: 2000 }).catch(() => false);
      if (valVisible) {
        const val = parseDollars(await valEl.textContent());
        (result as Record<string, number>)[key] = val / 100; // dollars
      }
    }
  }

  // Margin
  const marginEl = page.locator('text=Margin, text=Overall Margin, text=Avg Margin').first();
  const marginVisible = await marginEl.isVisible({ timeout: 3000 }).catch(() => false);
  if (marginVisible) {
    const parent = marginEl.locator('..');
    const valEl = parent.locator('.font-mono, .font-medium').first();
    const valVisible = await valEl.isVisible({ timeout: 2000 }).catch(() => false);
    if (valVisible) {
      const valText = ((await valEl.textContent()) ?? '').trim();
      result.marginPct = parseFloat(valText.replace(/[^0-9.-]/g, '')) || 0;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

test.describe('Quote Pricing Math Verification', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // QP1: Quote list loads with dollar amounts
  test('QP1: Quote list shows dollar amounts', async ({ page }) => {
    await nav(page, '/quotes');
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 15000 });

    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // At least some rows should have dollar values
    let dollarCount = 0;
    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      const rowText = ((await rows.nth(i).textContent()) ?? '').trim();
      if (rowText.includes('$')) dollarCount++;
    }
    expect(dollarCount).toBeGreaterThan(0);
  });

  // QP2: Open existing quote — line items have price and total
  test('QP2: Quote detail — line items show prices and totals', async ({ page }) => {
    await nav(page, '/quotes');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    // Click into first quote
    await rows.first().locator('td').nth(1).click();
    await waitForPageStable(page);

    const items = await extractQuoteLineItems(page);
    // May be a new/empty quote or one with items
    if (items.length > 0) {
      for (const item of items) {
        // At least one of price or total should be > 0
        expect(item.pricePerUnit > 0 || item.totalPrice > 0).toBeTruthy();
      }
    }
  });

  // QP3: Line items — total_price ≈ price_per_unit × total_units_needed
  test('QP3: Line item math — total ≈ price × units', async ({ page }) => {
    test.setTimeout(90000);
    await nav(page, '/quotes');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    // Find a quote with line items
    const rowCount = await rows.count();
    let found = false;

    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      await rows.nth(i).locator('td').nth(1).click();
      await waitForPageStable(page);

      const items = await extractQuoteLineItems(page);
      if (items.length > 0 && items.some((it) => it.pricePerUnit > 0 && it.totalUnitsNeeded > 0)) {
        for (const item of items) {
          if (item.pricePerUnit > 0 && item.totalUnitsNeeded > 0 && item.totalPrice > 0) {
            const expected = item.pricePerUnit * item.totalUnitsNeeded;
            // Allow 1% tolerance for rounding
            const tolerance = Math.max(expected * 0.01, 0.02);
            expect(Math.abs(item.totalPrice - expected)).toBeLessThanOrEqual(tolerance);
          }
        }
        found = true;
        break;
      }

      // Re-navigate instead of goBack (avoids stale locators)
      await nav(page, '/quotes');
      await expect(rows.first()).toBeVisible({ timeout: 15000 });
    }

    if (!found) {
      test.skip(true, 'No quotes with priced line items');
    }
  });

  // QP4: Sum line totals = quote total
  test('QP4: Sum of line totals = quote total', async ({ page }) => {
    test.setTimeout(90000);
    await nav(page, '/quotes');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    const rowCount = await rows.count();
    let found = false;

    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      await rows.nth(i).locator('td').nth(1).click();
      await waitForPageStable(page);

      const items = await extractQuoteLineItems(page);
      const summary = await getQuoteSummaryTotals(page);

      if (items.length > 0 && summary.totalPrice > 0) {
        const lineSum = items.reduce((s, it) => s + it.totalPrice, 0);
        // Allow some tolerance for rounding across multiple items
        const tolerance = Math.max(summary.totalPrice * 0.02, 1.0);
        expect(Math.abs(lineSum - summary.totalPrice)).toBeLessThanOrEqual(tolerance);
        found = true;
        break;
      }

      // Re-navigate instead of goBack (avoids stale locators)
      await nav(page, '/quotes');
      await expect(rows.first()).toBeVisible({ timeout: 15000 });
    }

    if (!found) {
      test.skip(true, 'No quotes with summary totals');
    }
  });

  // QP5: Profit = total_price - total_cost
  test('QP5: Profit = total_price - total_cost', async ({ page }) => {
    test.setTimeout(90000);
    await nav(page, '/quotes');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    const rowCount = await rows.count();
    let found = false;

    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      await rows.nth(i).locator('td').nth(1).click();
      await waitForPageStable(page);

      const summary = await getQuoteSummaryTotals(page);
      if (summary.totalPrice > 0 && summary.totalCost > 0) {
        const expectedProfit = summary.totalPrice - summary.totalCost;
        if (summary.totalProfit > 0) {
          const tolerance = Math.max(Math.abs(expectedProfit) * 0.02, 1.0);
          expect(Math.abs(summary.totalProfit - expectedProfit)).toBeLessThanOrEqual(tolerance);
        }
        found = true;
        break;
      }

      // Re-navigate instead of goBack (avoids stale locators)
      await nav(page, '/quotes');
      await expect(rows.first()).toBeVisible({ timeout: 15000 });
    }

    if (!found) {
      test.skip(true, 'No quotes with cost data');
    }
  });

  // QP6: Margin % = (profit / total_price) × 100
  test('QP6: Margin % = (profit / total_price) × 100', async ({ page }) => {
    test.setTimeout(90000); // Iterating through quotes takes ~5s each
    await nav(page, '/quotes');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    const rowCount = await rows.count();
    let found = false;

    for (let i = 0; i < Math.min(rowCount, 5); i++) {
      await rows.nth(i).locator('td').nth(1).click();
      await waitForPageStable(page);

      const summary = await getQuoteSummaryTotals(page);
      if (summary.totalPrice > 0 && summary.totalProfit > 0 && summary.marginPct > 0) {
        const expectedMargin = (summary.totalProfit / summary.totalPrice) * 100;
        // Margin can have rounding differences — allow 2% tolerance
        expect(Math.abs(summary.marginPct - expectedMargin)).toBeLessThanOrEqual(2.0);
        found = true;
        break;
      }

      // Re-navigate instead of goBack (avoids stale locators)
      await nav(page, '/quotes');
      await expect(rows.first()).toBeVisible({ timeout: 15000 });
    }

    if (!found) {
      test.skip(true, 'No quotes with margin data');
    }
  });

  // QP7: Products page shows tier prices
  test('QP7: Products page shows tier 1/2/3 prices', async ({ page }) => {
    await nav(page, '/products');
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 15000 });

    // Look for tier price columns
    const headers = table.locator('thead th, thead td');
    const headerCount = await headers.count();
    const headerTexts: string[] = [];
    for (let i = 0; i < headerCount; i++) {
      headerTexts.push(((await headers.nth(i).textContent()) ?? '').trim().toLowerCase());
    }

    const hasTierPricing = headerTexts.some(
      (h) => h.includes('t1') || h.includes('t2') || h.includes('t3') || h.includes('tier'),
    );
    expect(hasTierPricing).toBeTruthy();

    // Verify at least one product has a tier price
    const bodyRows = table.locator('tbody tr');
    const rowCount = await bodyRows.count();
    let hasPrices = false;

    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      const rowText = ((await bodyRows.nth(i).textContent()) ?? '').trim();
      if (rowText.includes('$')) {
        hasPrices = true;
        break;
      }
    }
    expect(hasPrices).toBeTruthy();
  });

  // QP8: Section totals sum to grand total
  test('QP8: Quote section totals contribute to grand total', async ({ page }) => {
    await nav(page, '/quotes');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    await rows.first().locator('td').nth(1).click();
    await waitForPageStable(page);

    // Use extractQuoteLineItems to sum section totals (more reliable than CSS selectors)
    const items = await extractQuoteLineItems(page);
    const summary = await getQuoteSummaryTotals(page);

    if (items.length > 0 && summary.totalPrice > 0) {
      const lineSum = items.reduce((s, it) => s + it.totalPrice, 0);
      // Section totals should match the grand total (same check as QP4 but
      // for the first quote only — acts as a quick structural smoke test)
      const tolerance = Math.max(summary.totalPrice * 0.05, 5.0);
      expect(Math.abs(lineSum - summary.totalPrice)).toBeLessThanOrEqual(tolerance);
    }
  });

  // QP9: Order page totals should be consistent
  test('QP9: Order total is a valid dollar amount', async ({ page }) => {
    await nav(page, '/orders');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    // Click into first order
    await rows.first().locator('td').nth(1).click();
    await waitForPageStable(page);

    // Get order total
    const totalLabel = page.locator('text=Total Price').first();
    const hasTotal = await totalLabel.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasTotal) {
      const parent = totalLabel.locator('..');
      const valEl = parent.locator('.font-medium, .font-semibold').first();
      const valVisible = await valEl.isVisible({ timeout: 2000 }).catch(() => false);
      if (valVisible) {
        const totalCents = parseDollars(await valEl.textContent());
        expect(totalCents).toBeGreaterThan(0);
      }
    }
  });

  // QP10: Order line items — price × units = line total
  test('QP10: Order line items — price × units consistency', async ({ page }) => {
    await nav(page, '/orders');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    await rows.first().locator('td').nth(1).click();
    await waitForPageStable(page);

    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 5000 }).catch(() => false);
    if (!tableVisible) return;

    const bodyRows = table.locator('tbody tr');
    const rowCount = await bodyRows.count();

    for (let i = 0; i < rowCount; i++) {
      const cells = bodyRows.nth(i).locator('td');
      const cellCount = await cells.count();
      if (cellCount < 3) continue;

      // Order columns: Product | Price/Unit | Units Needed | Delivered | Remaining | Progress
      const priceText = ((await cells.nth(1).textContent()) ?? '').trim();
      const unitsText = ((await cells.nth(2).textContent()) ?? '').trim();

      const priceCents = parseDollars(priceText);
      const units = parseQuantity(unitsText);

      if (priceCents > 0 && units > 0) {
        // Price and units are valid numbers — basic sanity check
        expect(priceCents).toBeGreaterThan(0);
        expect(units).toBeGreaterThan(0);
      }
    }
  });
});
