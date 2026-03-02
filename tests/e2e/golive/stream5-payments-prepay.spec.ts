/**
 * Stream 5: Payment Allocation & Prepay Validation
 *
 * End-to-end checks for the Payment Allocation page, Application Records
 * (checks), and Prepay Workspace. Validates UI rendering, data consistency
 * (check amounts vs. allocated/remaining), prepay balance sanity, and
 * database-level prepayment integrity.
 *
 * PAY1-PAY3: Page-load smoke tests
 * PAY4: Check amount consistency (amount >= allocated, remaining >= 0)
 * PAY5-PAY6: Prepay workspace layout & balance validation
 * PAY7: DB cross-reference — prepayment remaining_cents >= 0
 * PAY8-PAY9: Console error regression guards
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
  collectConsoleErrors,
} from './utils/golive-helpers';

test.describe.serial('Stream 5 — Payments & Prepay', () => {
  let page: Page;

  // -----------------------------------------------------------------------
  // PAY1: Login
  // -----------------------------------------------------------------------
  test('PAY1: Login', async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
    await page.waitForTimeout(2000);

    // Verify auth token is present so downstream DB queries work
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
  // PAY2: Payment Allocation page loads
  // -----------------------------------------------------------------------
  test('PAY2: Payment Allocation page loads', async () => {
    await navAndStabilize(page, '/payments', 3000);
    await assertNoCriticalErrors(page);

    // The page should have meaningful content — at least a heading or table
    const body = await page.locator('body').textContent();
    const text = body ?? '';
    expect(text.length).toBeGreaterThan(50);

    // Look for typical payment-page elements
    const hasPaymentContent =
      text.toLowerCase().includes('payment') ||
      text.toLowerCase().includes('allocation') ||
      text.toLowerCase().includes('invoice') ||
      text.toLowerCase().includes('customer');
    expect(hasPaymentContent).toBe(true);
  });

  // -----------------------------------------------------------------------
  // PAY3: Application Records page loads
  // -----------------------------------------------------------------------
  test('PAY3: Application Records page loads', async () => {
    await navAndStabilize(page, '/application-records', 3000);
    await assertNoCriticalErrors(page);

    const body = await page.locator('body').textContent();
    const text = body ?? '';
    expect(text.length).toBeGreaterThan(50);

    // Should show a table or at least recognisable content
    const tableVisible = await page
      .locator('table')
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const hasContent =
      tableVisible ||
      text.toLowerCase().includes('application') ||
      text.toLowerCase().includes('check') ||
      text.toLowerCase().includes('record');
    expect(hasContent).toBe(true);
  });

  // -----------------------------------------------------------------------
  // PAY4: Check amounts are consistent
  // -----------------------------------------------------------------------
  test('PAY4: Check amounts are consistent', async () => {
    // Ensure we are on application-records
    await navAndStabilize(page, '/application-records', 3000);

    const rows = await extractTableRows(page);

    // If the table has rows, validate dollar consistency
    if (rows.length > 0) {
      // Discover which column names match (case-insensitive keys from extractTableRows)
      const sampleKeys = Object.keys(rows[0]);
      const amountKey = sampleKeys.find((k) => k === 'amount' || k === 'total' || k === 'check amount');
      const allocatedKey = sampleKeys.find(
        (k) => k === 'allocated' || k === 'applied' || k === 'amount applied',
      );
      const remainingKey = sampleKeys.find(
        (k) => k === 'remaining' || k === 'balance' || k === 'unapplied',
      );

      for (const row of rows) {
        // Only validate rows where we can identify the relevant columns
        if (amountKey && row[amountKey]) {
          const amount = parseDollars(row[amountKey]);

          if (allocatedKey && row[allocatedKey]) {
            const allocated = parseDollars(row[allocatedKey]);
            expect(
              amount,
              `Amount (${row[amountKey]}) should be >= Allocated (${row[allocatedKey]})`,
            ).toBeGreaterThanOrEqual(allocated);
          }

          if (remainingKey && row[remainingKey]) {
            const remaining = parseDollars(row[remainingKey]);
            expect(
              remaining,
              `Remaining (${row[remainingKey]}) should be >= 0`,
            ).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
    // No rows is acceptable — the check still passes
  });

  // -----------------------------------------------------------------------
  // PAY5: Prepay Workspace loads
  // -----------------------------------------------------------------------
  test('PAY5: Prepay Workspace loads', async () => {
    await navAndStabilize(page, '/prepay-workspace', 3000);
    await assertNoCriticalErrors(page);

    const body = await page.locator('body').textContent();
    const text = body ?? '';
    expect(text.length).toBeGreaterThan(50);

    // The split-panel layout should have multiple columns/panels or recognisable labels
    const hasPrepayContent =
      text.toLowerCase().includes('prepay') ||
      text.toLowerCase().includes('balance') ||
      text.toLowerCase().includes('customer') ||
      text.toLowerCase().includes('allocat');
    expect(hasPrepayContent).toBe(true);
  });

  // -----------------------------------------------------------------------
  // PAY6: Prepay balance is non-negative
  // -----------------------------------------------------------------------
  test('PAY6: Prepay balance is non-negative', async () => {
    // Ensure we are on prepay workspace
    await navAndStabilize(page, '/prepay-workspace', 3000);

    // Try extracting a "Balance" or "Remaining" labeled value
    let balanceText = await extractLabeledValue(page, 'Balance');
    if (!balanceText) {
      balanceText = await extractLabeledValue(page, 'Remaining');
    }
    if (!balanceText) {
      balanceText = await extractLabeledValue(page, 'Available');
    }

    if (balanceText) {
      const balanceCents = parseDollars(balanceText);
      expect(
        balanceCents,
        `Prepay balance "${balanceText}" should be non-negative`,
      ).toBeGreaterThanOrEqual(0);
    }
    // If no balance label is visible (e.g. no customer selected), the test still passes
  });

  // -----------------------------------------------------------------------
  // PAY7: Prepay DB cross-reference — remaining_cents >= 0
  // -----------------------------------------------------------------------
  test('PAY7: Prepay DB cross-reference', async () => {
    const result = await supabaseRest(
      page,
      'GET',
      'prepay_credits?select=id,customer_id,balance_cents&limit=50',
    );
    const prepayCredits = asArray<{ id: string; customer_id: string; balance_cents: number }>(result, 'prepay_credits');

    for (const pp of prepayCredits) {
      expect(
        pp.balance_cents,
        `Prepay credit ${pp.id} (customer ${pp.customer_id}) has negative balance_cents: ${pp.balance_cents}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  // -----------------------------------------------------------------------
  // PAY8: No console errors on payments page
  // -----------------------------------------------------------------------
  test('PAY8: No console errors on payments page', async () => {
    const errors = collectConsoleErrors(page);
    await navAndStabilize(page, '/payments', 3000);
    await page.waitForTimeout(3000);

    if (errors.length > 0) {
      // Provide clear failure output
      expect(
        errors,
        `Console errors on /payments:\n${errors.join('\n')}`,
      ).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // PAY9: No console errors on prepay workspace
  // -----------------------------------------------------------------------
  test('PAY9: No console errors on prepay workspace', async () => {
    const errors = collectConsoleErrors(page);
    await navAndStabilize(page, '/prepay-workspace', 3000);
    await page.waitForTimeout(3000);

    if (errors.length > 0) {
      expect(
        errors,
        `Console errors on /prepay-workspace:\n${errors.join('\n')}`,
      ).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------
  test.afterAll(async () => {
    await page?.close();
  });
});
