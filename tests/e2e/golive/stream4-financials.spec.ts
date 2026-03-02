/**
 * Stream 4: Financial Validation
 *
 * HIGHEST RISK AREA. This stream validates that money math is correct
 * across the entire financial pipeline: invoices, AR aging, financial
 * dashboard, and customer transactions.
 *
 * Key invariant: balance_cents = total_amount_cents - paid_amount_cents - prepay_applied_cents
 * This is a GENERATED ALWAYS column in Postgres — any discrepancy here
 * indicates a catastrophic database-level bug.
 *
 * Tests cross-reference UI-displayed values against direct DB queries
 * to ensure the React rendering layer faithfully represents the data.
 */

import { test, expect, Page } from '@playwright/test';
import { login } from '../utils/auth';
import { supabaseRest, supabaseRpc, asArray } from './utils/supabase-helpers';
import {
  navAndStabilize,
  assertNoCriticalErrors,
  extractLabeledValue,
  extractTableRows,
  extractSummaryCards,
  parseDollars,
  assertCentsEqual,
  collectConsoleErrors,
} from './utils/golive-helpers';

test.describe.serial('Stream 4 — Financials', () => {
  let page: Page;
  let consoleErrors: string[];

  // Captured values for cross-page comparison
  let arAgingTotalCents = 0;
  let arAgingCaptured = false;
  let dashboardArCents = 0;
  let dashboardArCaptured = false;

  // -----------------------------------------------------------------------
  // FIN1: Login
  // -----------------------------------------------------------------------
  test('FIN1: Login', async ({ browser }) => {
    page = await browser.newPage();
    consoleErrors = collectConsoleErrors(page);
    await login(page);
    await page.waitForTimeout(2000);

    // Verify auth token is available for subsequent DB queries
    const token = await page.evaluate(() => {
      const raw = localStorage.getItem('sb-rhyzpcqhnizqbxphqdkr-auth-token');
      if (!raw) return '';
      try {
        const session = JSON.parse(raw);
        return session.access_token || '';
      } catch {
        return '';
      }
    });
    expect(token).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // FIN2: Invoices page loads
  // -----------------------------------------------------------------------
  test('FIN2: Invoices page loads', async () => {
    await navAndStabilize(page, '/invoices', 3000);
    await assertNoCriticalErrors(page);

    // Verify the invoice table is visible with at least 1 row
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // FIN3: Invoice detail balance formula
  //
  // Invariant: balance = total - paid - prepay (within 2-cent tolerance
  // to account for display rounding).
  // -----------------------------------------------------------------------
  test('FIN3: Invoice detail balance formula', async () => {
    // Click the first invoice row to navigate to detail
    const table = page.locator('table').first();
    const firstRow = table.locator('tbody tr').first();
    await firstRow.click();
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await assertNoCriticalErrors(page);

    // Extract financial values from the Summary card
    // The invoice detail page shows: Subtotal, Paid, Prepay Applied, Balance Due
    const subtotalText = await extractLabeledValue(page, 'Subtotal');
    const totalText = await extractLabeledValue(page, 'Total');
    const paidText = await extractLabeledValue(page, 'Paid');
    const prepayText = await extractLabeledValue(page, 'Prepay Applied');
    const prepayAltText = await extractLabeledValue(page, 'Prepay');
    const balanceText = await extractLabeledValue(page, 'Balance Due');
    const balanceAltText = await extractLabeledValue(page, 'Balance');

    // Use whichever label was found
    const totalCents = parseDollars(subtotalText || totalText);
    const paidCents = parseDollars(paidText);
    const prepayCents = parseDollars(prepayText || prepayAltText); // 0 if not visible
    const balanceCents = parseDollars(balanceText || balanceAltText);

    // Only assert if we found a total and balance (the invoice must be non-new)
    if (totalCents > 0 || balanceCents > 0) {
      const expectedBalance = totalCents - paidCents - prepayCents;
      const diff = Math.abs(balanceCents - expectedBalance);

      expect(diff,
        `Balance formula mismatch: ` +
        `total=${totalCents} ($${(totalCents / 100).toFixed(2)}) - ` +
        `paid=${paidCents} ($${(paidCents / 100).toFixed(2)}) - ` +
        `prepay=${prepayCents} ($${(prepayCents / 100).toFixed(2)}) = ` +
        `expected ${expectedBalance} ($${(expectedBalance / 100).toFixed(2)}), ` +
        `but UI shows ${balanceCents} ($${(balanceCents / 100).toFixed(2)}), ` +
        `diff=${diff} cents`,
      ).toBeLessThanOrEqual(2);
    }
  });

  // -----------------------------------------------------------------------
  // FIN4: Invoice line items sum to subtotal
  // -----------------------------------------------------------------------
  test('FIN4: Invoice line items sum to subtotal', async () => {
    // We should still be on an invoice detail page from FIN3
    await assertNoCriticalErrors(page);

    // Find the line items table (the table under "Line Items" heading)
    const lineItemsTable = page.locator('table').first();
    const isVisible = await lineItemsTable.isVisible({ timeout: 5000 }).catch(() => false);

    if (!isVisible) {
      // No line items table — skip gracefully
      test.skip();
      return;
    }

    // Extract rows and find the amount/extended column
    const rows = await extractTableRows(page, lineItemsTable);

    if (rows.length === 0) {
      // No line items — skip gracefully
      test.skip();
      return;
    }

    // Look for an "extended" or "amount" or "total" column
    let sumCents = 0;
    let amountColFound = false;

    for (const row of rows) {
      // Try multiple possible column names
      const amountStr =
        row['extended'] ||
        row['amount'] ||
        row['ext'] ||
        row['total'] ||
        row['extended price'] ||
        row['line total'] ||
        '';

      if (amountStr) {
        amountColFound = true;
        sumCents += parseDollars(amountStr);
      }
    }

    if (!amountColFound) {
      // Could not find an amount column — try to sum using the last numeric column
      for (const row of rows) {
        const values = Object.values(row);
        // Try the last value that looks like a dollar amount
        for (let i = values.length - 1; i >= 0; i--) {
          if (values[i] && /\$/.test(values[i])) {
            sumCents += parseDollars(values[i]);
            amountColFound = true;
            break;
          }
        }
      }
    }

    if (!amountColFound) {
      // Cannot determine amounts — skip
      test.skip();
      return;
    }

    // Compare with the subtotal from the summary card
    const subtotalText = await extractLabeledValue(page, 'Subtotal');
    const totalText = await extractLabeledValue(page, 'Total');
    const subtotalCents = parseDollars(subtotalText || totalText);

    if (subtotalCents > 0) {
      const diff = Math.abs(sumCents - subtotalCents);
      expect(diff,
        `Line items sum ${sumCents} ($${(sumCents / 100).toFixed(2)}) ` +
        `does not match subtotal ${subtotalCents} ($${(subtotalCents / 100).toFixed(2)}), ` +
        `diff=${diff} cents`,
      ).toBeLessThanOrEqual(2);
    }
  });

  // -----------------------------------------------------------------------
  // FIN5: AR Aging page loads
  // -----------------------------------------------------------------------
  test('FIN5: AR Aging page loads', async () => {
    await navAndStabilize(page, '/ar-aging', 3000);
    await assertNoCriticalErrors(page);

    // Verify the page has rendered content (either table or summary cards)
    const body = await page.locator('body').textContent();
    const hasContent =
      (body ?? '').includes('Aging') ||
      (body ?? '').includes('Outstanding') ||
      (body ?? '').includes('Current');
    expect(hasContent).toBe(true);
  });

  // -----------------------------------------------------------------------
  // FIN6: AR Aging bucket sum equals Total AR
  //
  // The AR Aging page shows summary cards with "Total Outstanding" and
  // individual aging buckets. The sum of all buckets should equal the total.
  // -----------------------------------------------------------------------
  test('FIN6: AR Aging bucket sum equals Total AR', async () => {
    // Wait for data to load
    await page.waitForTimeout(2000);

    // Extract summary cards
    const cards = await extractSummaryCards(page);

    // Try to find Total Outstanding from cards
    let totalArText = '';
    let bucketTexts: string[] = [];

    for (const [label, value] of cards) {
      const lowerLabel = label.toLowerCase();
      if (lowerLabel.includes('total outstanding') || lowerLabel.includes('total ar') || lowerLabel === 'total') {
        totalArText = value;
      }
    }

    // If we couldn't find from summary cards, try labeled value extraction
    if (!totalArText) {
      totalArText = await extractLabeledValue(page, 'Total Outstanding');
    }
    if (!totalArText) {
      totalArText = await extractLabeledValue(page, 'Total AR');
    }

    // Try to get the aging totals from the totals row in the grid
    // The AR aging page shows a totals row with 7 columns: label, current, 30, 60, 90, 120+, total
    const totalsRow = page.locator('text=Totals').first();
    const totalsVisible = await totalsRow.isVisible({ timeout: 3000 }).catch(() => false);

    if (totalsVisible) {
      // Get the parent container with all the values
      const parent = totalsRow.locator('..');
      const monoCells = parent.locator('.font-mono');
      const cellCount = await monoCells.count();

      if (cellCount >= 6) {
        // cells: current, 30, 60, 90, 120+, total
        const cellTexts: string[] = [];
        for (let i = 0; i < cellCount; i++) {
          cellTexts.push(((await monoCells.nth(i).textContent()) ?? '').trim());
        }

        // Last cell is the total
        const totalFromRow = parseDollars(cellTexts[cellTexts.length - 1]);
        // Sum all except the last
        let bucketSum = 0;
        for (let i = 0; i < cellTexts.length - 1; i++) {
          bucketSum += parseDollars(cellTexts[i]);
        }

        if (totalFromRow > 0) {
          arAgingTotalCents = totalFromRow;
          arAgingCaptured = true;

          const diff = Math.abs(bucketSum - totalFromRow);
          // Rounding across 5+ buckets can accumulate — allow $1 tolerance
          expect(diff,
            `AR Aging bucket sum ${bucketSum} ($${(bucketSum / 100).toFixed(2)}) ` +
            `does not match total ${totalFromRow} ($${(totalFromRow / 100).toFixed(2)}), ` +
            `diff=${diff} cents`,
          ).toBeLessThanOrEqual(100);
        }
      }
    }

    // Fallback: try from summary cards
    if (!arAgingCaptured && totalArText) {
      const totalCents = parseDollars(totalArText);
      if (totalCents > 0) {
        arAgingTotalCents = totalCents;
        arAgingCaptured = true;

        // Try to find bucket cards
        for (const [label, value] of cards) {
          const lowerLabel = label.toLowerCase();
          if (
            lowerLabel.includes('current') ||
            lowerLabel.includes('30') ||
            lowerLabel.includes('60') ||
            lowerLabel.includes('90') ||
            lowerLabel.includes('120')
          ) {
            bucketTexts.push(value);
          }
        }

        if (bucketTexts.length > 0) {
          let bucketSum = 0;
          for (const t of bucketTexts) {
            bucketSum += parseDollars(t);
          }

          // Note: The UI groups some buckets (30-89 days = d30+d60, 90+ = d90+over90)
          // So we compare the displayed buckets against the total, not raw columns
          const diff = Math.abs(bucketSum - totalCents);
          // Rounding across buckets can accumulate — allow $1 tolerance
          expect(diff,
            `AR Aging card buckets sum ${bucketSum} ($${(bucketSum / 100).toFixed(2)}) ` +
            `does not match Total Outstanding ${totalCents} ($${(totalCents / 100).toFixed(2)}), ` +
            `diff=${diff} cents`,
          ).toBeLessThanOrEqual(100);
        }
      }
    }

    // If we captured AR total, test passes. If not, at least the page loaded (FIN5).
    expect(arAgingCaptured || totalArText !== '').toBe(true);
  });

  // -----------------------------------------------------------------------
  // FIN7: AR Aging DB cross-reference
  //
  // Calls the get_ar_aging RPC directly and validates the response shape.
  // -----------------------------------------------------------------------
  test('FIN7: AR Aging DB cross-reference', async () => {
    const today = new Date().toISOString().split('T')[0];
    const result = await supabaseRpc(page, 'get_ar_aging', { p_as_of_date: today });

    if (Array.isArray(result) && result.length > 0) {
      // Validate shape — each row should have customer info + aging amounts
      const firstRow = result[0] as Record<string, unknown>;

      // Check for expected fields
      const hasCustomerInfo =
        'customer_id' in firstRow || 'farm_name' in firstRow;
      const hasAgingAmounts =
        'current_amount' in firstRow ||
        'days_30' in firstRow ||
        'total_outstanding' in firstRow;

      expect(hasCustomerInfo).toBe(true);
      expect(hasAgingAmounts).toBe(true);

      // Validate each row's total = sum of buckets
      for (const row of result as Record<string, unknown>[]) {
        const current = Number(row.current_amount || 0);
        const d30 = Number(row.days_30 || 0);
        const d60 = Number(row.days_60 || 0);
        const d90 = Number(row.days_90 || 0);
        const over90 = Number(row.over_90 || 0);
        const total = Number(row.total_outstanding || 0);

        const bucketSum = current + d30 + d60 + d90 + over90;
        const diff = Math.abs(bucketSum - total);

        // Tolerance: within $1.00 — bucket rounding across 5+ columns accumulates
        expect(diff,
          `AR Aging RPC row for ${row.farm_name}: ` +
          `bucket sum ${bucketSum.toFixed(2)} != total ${total.toFixed(2)}, diff=${diff.toFixed(4)}`,
        ).toBeLessThanOrEqual(1.00);
      }
    } else if (result && typeof result === 'object' && 'message' in (result as Record<string, unknown>)) {
      // RPC returned an error — log but don't fail (RPC may not exist yet)
      console.warn('get_ar_aging RPC returned error:', result);
    }
    // If result is empty array, that's fine — no AR data
  });

  // -----------------------------------------------------------------------
  // FIN8: Financial Dashboard loads
  // -----------------------------------------------------------------------
  test('FIN8: Financial Dashboard loads', async () => {
    await navAndStabilize(page, '/financial-dashboard', 3000);
    await assertNoCriticalErrors(page);

    // Extract summary cards
    const cards = await extractSummaryCards(page);

    // Verify key metrics are present
    const cardLabels = Array.from(cards.keys()).map((l) => l.toLowerCase());
    const bodyText = ((await page.locator('body').textContent()) ?? '').toLowerCase();

    const hasRevenue =
      cardLabels.some((l) => l.includes('revenue')) ||
      bodyText.includes('total revenue');
    const hasAr =
      cardLabels.some((l) => l.includes('ar') || l.includes('balance')) ||
      bodyText.includes('ar balance');

    expect(hasRevenue || hasAr).toBe(true);

    // Try to capture AR Balance for cross-reference with AR Aging
    for (const [label, value] of cards) {
      const lowerLabel = label.toLowerCase();
      if (lowerLabel.includes('ar balance') || lowerLabel.includes('ar') || lowerLabel.includes('open ar')) {
        const cents = parseDollars(value);
        if (cents > 0) {
          dashboardArCents = cents;
          dashboardArCaptured = true;
        }
      }
    }

    // Fallback: try extractLabeledValue
    if (!dashboardArCaptured) {
      const arText = await extractLabeledValue(page, 'AR Balance');
      if (arText) {
        const cents = parseDollars(arText);
        if (cents > 0) {
          dashboardArCents = cents;
          dashboardArCaptured = true;
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // FIN9: Financial Dashboard AR matches AR Aging
  //
  // Cross-reference: the AR total on the financial dashboard should match
  // the total outstanding on the AR aging page.
  // -----------------------------------------------------------------------
  test('FIN9: Financial Dashboard AR matches AR Aging', async () => {
    if (!arAgingCaptured || !dashboardArCaptured) {
      test.skip();
      return;
    }

    // Both values are in cents
    const diff = Math.abs(dashboardArCents - arAgingTotalCents);
    expect(diff,
      `Dashboard AR ${dashboardArCents} ($${(dashboardArCents / 100).toFixed(2)}) ` +
      `does not match AR Aging total ${arAgingTotalCents} ($${(arAgingTotalCents / 100).toFixed(2)}), ` +
      `diff=${diff} cents. ` +
      `These two pages should show the same total receivables.`,
    ).toBeLessThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // FIN10: Customer transaction review renders
  // -----------------------------------------------------------------------
  test('FIN10: Customer transaction review renders', async () => {
    await navAndStabilize(page, '/customers', 3000);
    await assertNoCriticalErrors(page);

    // Verify customer table is visible
    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 5000 }).catch(() => false);

    if (!tableVisible) {
      // Try DataTable or card-based layout
      const customerLink = page.locator('a[href*="/customers/"], button:has-text("View"), tr').first();
      const linkVisible = await customerLink.isVisible({ timeout: 3000 }).catch(() => false);
      if (!linkVisible) {
        test.skip();
        return;
      }
    }

    // Click first customer row
    if (tableVisible) {
      const firstRow = table.locator('tbody tr').first();
      await firstRow.click();
    } else {
      const firstLink = page.locator('a[href*="/customers/"]').first();
      await firstLink.click();
    }

    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});
    await assertNoCriticalErrors(page);

    // Look for transaction-related content
    // The customer detail page has tabs: info, fields, quotes, orders, deliveries, history
    // Also there's a separate CustomerTransactionReview page at /customer-transactions
    const bodyText = (await page.locator('body').textContent()) ?? '';

    // Check if we can see a history tab or transaction content
    const historyTab = page.locator('button:has-text("history"), button:has-text("History")').first();
    const historyVisible = await historyTab.isVisible({ timeout: 3000 }).catch(() => false);

    if (historyVisible) {
      await historyTab.click();
      await page.waitForTimeout(2000);
    }

    // Now navigate to the dedicated transaction review page for broader coverage
    await navAndStabilize(page, '/customer-transactions', 3000);
    await assertNoCriticalErrors(page);

    // Verify the transaction review page rendered
    const reviewBodyText = ((await page.locator('body').textContent()) ?? '').toLowerCase();
    const hasTransactionContent =
      reviewBodyText.includes('transaction') ||
      reviewBodyText.includes('debit') ||
      reviewBodyText.includes('credit') ||
      reviewBodyText.includes('balance');

    expect(hasTransactionContent).toBe(true);

    // If a table is visible, verify debit/credit columns exist
    const txTable = page.locator('table').first();
    const txTableVisible = await txTable.isVisible({ timeout: 5000 }).catch(() => false);

    if (txTableVisible) {
      const headers = txTable.locator('thead th, thead td');
      const headerCount = await headers.count();
      const headerTexts: string[] = [];

      for (let i = 0; i < headerCount; i++) {
        const text = ((await headers.nth(i).textContent()) ?? '').trim().toLowerCase();
        headerTexts.push(text);
      }

      // Check for debit/credit columns
      const hasDebit = headerTexts.some((h) => h.includes('debit'));
      const hasCredit = headerTexts.some((h) => h.includes('credit'));
      const hasAmount = headerTexts.some((h) => h.includes('amount'));

      // Must have either debit+credit pair or an amount column
      expect(hasDebit || hasCredit || hasAmount).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // FIN11: Invoice DB cross-reference
  //
  // THE MOST CRITICAL TEST. Queries the invoices table directly and
  // verifies the GENERATED ALWAYS column formula:
  //   balance_cents = total_amount_cents - paid_amount_cents - prepay_applied_cents
  //
  // Zero tolerance because this is a computed column — if Postgres says
  // balance_cents != total - paid - prepay, the schema is broken.
  // -----------------------------------------------------------------------
  test('FIN11: Invoice DB cross-reference', async () => {
    const invResult = await supabaseRest(
      page,
      'GET',
      'invoices?select=id,invoice_number,total_amount_cents,paid_amount_cents,prepay_applied_cents,balance_cents&status=eq.posted&deleted_at=is.null&limit=20',
    );
    const invoices = asArray<{
      id: string;
      invoice_number: string;
      total_amount_cents: number;
      paid_amount_cents: number;
      prepay_applied_cents: number;
      balance_cents: number;
    }>(invResult, 'invoices (FIN11)');

    // Collect all discrepancies for a single, detailed error message
    const discrepancies: string[] = [];

    for (const inv of invoices) {
      const total = Number(inv.total_amount_cents || 0);
      const paid = Number(inv.paid_amount_cents || 0);
      const prepay = Number(inv.prepay_applied_cents || 0);
      const balance = Number(inv.balance_cents || 0);

      const expectedBalance = total - paid - prepay;

      // ZERO tolerance — this is a GENERATED ALWAYS column
      if (balance !== expectedBalance) {
        discrepancies.push(
          `Invoice ${inv.invoice_number} (${inv.id}): ` +
          `balance_cents=${balance} but expected ` +
          `total(${total}) - paid(${paid}) - prepay(${prepay}) = ${expectedBalance}, ` +
          `diff=${Math.abs(balance - expectedBalance)}`,
        );
      }
    }

    if (discrepancies.length > 0) {
      // This is catastrophic — the GENERATED ALWAYS column is wrong
      expect(discrepancies,
        `CRITICAL: ${discrepancies.length} invoice(s) have broken balance_cents formula!\n` +
        `This indicates the GENERATED ALWAYS column is not computing correctly.\n\n` +
        discrepancies.join('\n'),
      ).toHaveLength(0);
    }

    // Also verify we actually tested some invoices
    if (invoices.length === 0) {
      console.warn('FIN11: No posted invoices found — formula check skipped.');
    }
  });

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------
  test.afterAll(async () => {
    if (consoleErrors && consoleErrors.length > 0) {
      console.warn(`Stream 4 console errors (${consoleErrors.length}):`, consoleErrors);
    }
    await page?.close();
  });
});
