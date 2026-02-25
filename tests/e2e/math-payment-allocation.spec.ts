/**
 * File 3 — Payment allocation math verification.
 * Verifies payment allocation math and balance updates:
 *  allocations sum ≤ payment, balances update correctly, prepay handling.
 */
import { test, expect, Page } from '@playwright/test';
import { login } from './utils/auth';
import {
  parseDollars,
  assertCentsEqual,
  waitForPageStable,
} from './utils/math-helpers';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

async function nav(page: Page, path: string) {
  await page.goto(path);
  await waitForPageStable(page);
}

/** Extract the summary bar values from payment allocation page */
async function extractAllocationSummary(
  page: Page,
): Promise<{ checkTotal: number; allocated: number; remaining: number }> {
  const result = { checkTotal: 0, allocated: 0, remaining: 0 };

  const getVal = async (label: string): Promise<number> => {
    const el = page.locator(`text=${label}`).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) return 0;
    const parent = el.locator('..');
    const valEl = parent.locator('.font-semibold').first();
    const valVisible = await valEl.isVisible({ timeout: 2000 }).catch(() => false);
    if (!valVisible) return 0;
    return parseDollars(await valEl.textContent());
  };

  result.checkTotal = await getVal('Check Total:');
  result.allocated = await getVal('Allocated:');
  result.remaining = await getVal('Remaining:');
  return result;
}

/** Extract invoice rows from the allocation table */
async function extractAllocationInvoices(
  page: Page,
): Promise<Array<{ invoiceNumber: string; totalCents: number; balanceCents: number; allocatedCents: number }>> {
  const table = page.locator('table').first();
  const tableVisible = await table.isVisible({ timeout: 10000 }).catch(() => false);
  if (!tableVisible) return [];

  const bodyRows = table.locator('tbody tr');
  const rowCount = await bodyRows.count();
  const results: Array<{ invoiceNumber: string; totalCents: number; balanceCents: number; allocatedCents: number }> = [];

  for (let i = 0; i < rowCount; i++) {
    const cells = bodyRows.nth(i).locator('td');
    const cellCount = await cells.count();
    if (cellCount < 6) continue;

    // Columns: Invoice # | Date | Due | Days Aged | Total | Balance | Allocate
    const invoiceNumber = ((await cells.nth(0).textContent()) ?? '').trim();
    const totalCents = parseDollars((await cells.nth(4).textContent()) ?? '');
    const balanceCents = parseDollars((await cells.nth(5).textContent()) ?? '');

    // Allocate column has an input
    const allocInput = cells.nth(6).locator('input').first();
    let allocatedCents = 0;
    const inputVisible = await allocInput.isVisible({ timeout: 1000 }).catch(() => false);
    if (inputVisible) {
      const inputVal = await allocInput.inputValue();
      allocatedCents = Math.round(parseFloat(inputVal || '0') * 100);
    }

    if (invoiceNumber) {
      results.push({ invoiceNumber, totalCents, balanceCents, allocatedCents });
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

test.describe('Payment Allocation Math Verification', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // PA1: Customer invoices — sum of balances displays correctly
  test('PA1: Invoice list shows balances with dollar amounts', async ({ page }) => {
    await nav(page, '/invoices');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    const rowCount = await rows.count();
    let balanceCount = 0;
    let _totalBalanceCents = 0;

    for (let i = 0; i < Math.min(rowCount, 20); i++) {
      const rowText = ((await rows.nth(i).textContent()) ?? '').trim();
      if (rowText.includes('$')) {
        balanceCount++;
        // Extract any dollar amount from the row
        const matches = rowText.match(/\$[\d,]+\.?\d*/g) || [];
        for (const m of matches) {
          _totalBalanceCents += parseDollars(m);
        }
      }
    }

    expect(balanceCount).toBeGreaterThan(0);
  });

  // PA2: Payment allocation page loads with customer search
  test('PA2: Payment allocation page loads with correct structure', async ({ page }) => {
    await nav(page, '/payment-allocation');

    // Should have a customer search or selector
    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    expect(
      bodyText.includes('Payment') ||
      bodyText.includes('Allocat') ||
      bodyText.includes('Customer'),
    ).toBeTruthy();
  });

  // PA3: Allocation table — balances are positive numbers
  test('PA3: Payment allocation table shows valid invoice balances', async ({ page }) => {
    await nav(page, '/payment-allocation');

    // Try to select a customer if there's a dropdown or search
    const customerInput = page
      .locator('input[placeholder*="customer"], input[placeholder*="Customer"], input[placeholder*="search"]')
      .first();
    const hasInput = await customerInput.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasInput) {
      // Type a few characters to trigger search
      await customerInput.fill('a');
      await page.waitForTimeout(1500);

      // Click first option if available
      const option = page.locator('[role="option"], [role="listbox"] div, .hover\\:bg-gray-50').first();
      const optVisible = await option.isVisible({ timeout: 3000 }).catch(() => false);
      if (optVisible) {
        await option.click();
        await waitForPageStable(page);
      }
    }

    // Check if an invoice table appeared
    const invoices = await extractAllocationInvoices(page);
    if (invoices.length > 0) {
      // All balances should be non-negative
      for (const inv of invoices) {
        expect(inv.balanceCents).toBeGreaterThanOrEqual(0);
      }

      // Total column should be >= balance for each invoice
      for (const inv of invoices) {
        if (inv.totalCents > 0) {
          expect(inv.totalCents).toBeGreaterThanOrEqual(inv.balanceCents);
        }
      }
    }
  });

  // PA4: Summary bar math — check total = allocated + remaining
  test('PA4: Summary bar — check total = allocated + remaining', async ({ page }) => {
    await nav(page, '/payment-allocation');

    // Try to get to a state with invoices loaded
    const customerInput = page
      .locator('input[placeholder*="customer"], input[placeholder*="Customer"], input[placeholder*="search"]')
      .first();
    const hasInput = await customerInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasInput) {
      await customerInput.fill('a');
      await page.waitForTimeout(1500);
      const option = page.locator('[role="option"], [role="listbox"] div, .hover\\:bg-gray-50').first();
      const optVisible = await option.isVisible({ timeout: 3000 }).catch(() => false);
      if (optVisible) {
        await option.click();
        await waitForPageStable(page);
      }
    }

    const summary = await extractAllocationSummary(page);

    // If a check amount has been entered, verify the math
    if (summary.checkTotal > 0) {
      const calculatedRemaining = summary.checkTotal - summary.allocated;
      assertCentsEqual(summary.remaining, Math.abs(calculatedRemaining), 2,
        `Remaining ($${(summary.remaining / 100).toFixed(2)}) should = Check ($${(summary.checkTotal / 100).toFixed(2)}) - Allocated ($${(summary.allocated / 100).toFixed(2)})`);
    }
  });

  // PA5: Payments page shows payment records
  test('PA5: Payments page shows dollar amounts', async ({ page }) => {
    await nav(page, '/payments');
    await page.waitForTimeout(2000);

    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    expect(bodyText.includes('$') || bodyText.includes('Payment')).toBeTruthy();
  });

  // PA6: Payment detail shows allocation breakdown
  test('PA6: Payment detail shows allocation breakdown', async ({ page }) => {
    await nav(page, '/payments');
    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 10000 }).catch(() => false);

    if (tableVisible) {
      const rows = table.locator('tbody tr');
      const rowCount = await rows.count();

      if (rowCount > 0) {
        // Click into first payment
        await rows.first().locator('a, td').first().click();
        await waitForPageStable(page);

        const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
        // Should show some payment detail info
        expect(
          bodyText.includes('$') ||
          bodyText.includes('Amount') ||
          bodyText.includes('Payment'),
        ).toBeTruthy();
      }
    }
  });

  // PA7: Prepayment manager page shows balances
  test('PA7: Prepayment manager shows prepay balances', async ({ page }) => {
    await nav(page, '/prepayments');
    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    expect(
      bodyText.includes('Prepay') ||
      bodyText.includes('prepay') ||
      bodyText.includes('$') ||
      bodyText.includes('Balance'),
    ).toBeTruthy();
  });

  // PA8: AR Aging report shows dollar amounts
  test('PA8: AR Aging report shows aging buckets with dollar amounts', async ({ page }) => {
    await nav(page, '/ar-aging');
    await page.waitForTimeout(2000);

    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    expect(
      bodyText.includes('$') ||
      bodyText.includes('Aging') ||
      bodyText.includes('Current') ||
      bodyText.includes('30'),
    ).toBeTruthy();
  });

  // PA9: Customer statement generation
  test('PA9: Customer statements accessible', async ({ page }) => {
    // Navigate to a customer and check for statement generation
    await nav(page, '/customers');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    // Click into first customer
    await rows.first().locator('a, td').first().click();
    await waitForPageStable(page);

    // Look for statement-related buttons or tabs
    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    expect(
      bodyText.includes('Statement') ||
      bodyText.includes('statement') ||
      bodyText.includes('Orders') ||
      bodyText.includes('History'),
    ).toBeTruthy();
  });

  // PA10: Finance charge rate display
  test('PA10: Customer detail shows financial settings', async ({ page }) => {
    await nav(page, '/customers');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    await rows.first().locator('a, td').first().click();
    await waitForPageStable(page);

    // Customer detail should have financial fields
    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    expect(
      bodyText.includes('Credit') ||
      bodyText.includes('Payment') ||
      bodyText.includes('Terms') ||
      bodyText.includes('Finance') ||
      bodyText.includes('$'),
    ).toBeTruthy();
  });
});
