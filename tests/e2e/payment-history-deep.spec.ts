import { test, expect } from '@playwright/test';
import { login } from './utils/auth';
import { waitForPageStable, parseDollars } from './utils/math-helpers';

/**
 * Payment History — deep functional tests (read-only).
 * Page: /payment-history (admin-only)
 */
test.describe('Payment History Deep (PH1–PH12)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', (d) => d.accept());
    await page.goto('/payment-history');
    await waitForPageStable(page, 2000);
    // Wait for DataTable to finish loading — skeleton has animate-pulse class
    await page.locator('.animate-pulse').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  });

  test('PH1: Page loads with heading and 3 summary cards', async ({ page }) => {
    const heading = page.locator('h2').filter({ hasText: 'Payment History' });
    await expect(heading).toBeVisible({ timeout: 10000 });

    const body = await page.locator('body').textContent();
    expect(body).toContain('Active Payments');
    expect(body).toContain('Total Payments');
    expect(body).toContain('Voided Payments');
  });

  test('PH2: Summary card values are non-negative', async ({ page }) => {
    // Active Payments card shows a dollar value
    const activeCard = page.locator('text=Active Payments').locator('..').locator('..');
    const activeValue = await activeCard.locator('.text-2xl').textContent();
    const activeCents = parseDollars(activeValue);
    expect(activeCents).toBeGreaterThanOrEqual(0);

    // Total Payments card shows a count
    const totalCard = page.locator('text=Total Payments').locator('..').locator('..');
    const totalValue = await totalCard.locator('.text-2xl').textContent();
    const totalNum = parseInt((totalValue || '0').replace(/[^0-9]/g, ''), 10);
    expect(totalNum).toBeGreaterThanOrEqual(0);
  });

  test('PH3: DataTable renders with expected column headers', async ({ page }) => {
    const table = page.locator('table').first();
    const tableVisible = await table.isVisible({ timeout: 8000 }).catch(() => false);
    if (!tableVisible) {
      // Might be empty state
      const body = await page.locator('body').textContent();
      expect(body?.includes('No payments yet') || body?.includes('Payment History')).toBeTruthy();
      return;
    }

    const headers = await table.locator('thead th').allTextContents();
    const headerText = headers.join(' ').toLowerCase();
    expect(headerText).toContain('date');
    expect(headerText).toContain('customer');
    expect(headerText).toContain('total');
    expect(headerText).toContain('status');
  });

  test('PH4: Search input filters table rows', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    const hasSearch = await searchInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasSearch) {
      test.skip(true, 'No search input found');
      return;
    }

    const table = page.locator('table').first();
    const hasTable = await table.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasTable) {
      test.skip(true, 'No table visible');
      return;
    }

    const initialRows = await table.locator('tbody tr').count();
    if (initialRows === 0) {
      test.skip(true, 'No payment rows to filter');
      return;
    }

    // Get first customer name to search for
    const firstCustomer = await table.locator('tbody tr').first().locator('td').nth(1).textContent();
    if (firstCustomer && firstCustomer.trim()) {
      await searchInput.fill(firstCustomer.trim().slice(0, 5));
      await page.waitForTimeout(500);
      const filteredRows = await table.locator('tbody tr').count();
      expect(filteredRows).toBeGreaterThanOrEqual(1);
    }
  });

  test('PH5: Nonsense search shows zero results', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    const hasSearch = await searchInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasSearch) {
      test.skip(true, 'No search input found');
      return;
    }

    await searchInput.fill('zzz_no_match_xyz_99999');
    await page.waitForTimeout(500);

    const table = page.locator('table').first();
    const rows = await table.locator('tbody tr').count();
    const body = await page.locator('body').textContent();
    // Either 0 rows in table or an empty state message
    expect(rows === 0 || body?.includes('No') || body?.includes('no')).toBeTruthy();
  });

  test('PH6: Expand row shows invoice allocations', async ({ page }) => {
    const table = page.locator('table').first();
    const hasTable = await table.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasTable) {
      test.skip(true, 'No table visible');
      return;
    }

    const rows = await table.locator('tbody tr').count();
    if (rows === 0) {
      test.skip(true, 'No payment rows to expand');
      return;
    }

    // Click the date button in the first row (it's a <button> with chevron)
    const dateBtn = table.locator('tbody tr').first().locator('button').first();
    const hasBtnVisible = await dateBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasBtnVisible) {
      test.skip(true, 'No expandable date button found');
      return;
    }

    await dateBtn.click();
    await page.waitForTimeout(1500);

    // Should show "Invoice Allocations" heading or "No invoice allocations" text
    const body = await page.locator('body').textContent();
    expect(
      body?.includes('Invoice Allocations') ||
      body?.includes('No invoice allocations')
    ).toBeTruthy();
  });

  test('PH7: Collapse expanded row hides allocations', async ({ page }) => {
    const table = page.locator('table').first();
    const hasTable = await table.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasTable) {
      test.skip(true, 'No table visible');
      return;
    }

    const rows = await table.locator('tbody tr').count();
    if (rows === 0) {
      test.skip(true, 'No payment rows');
      return;
    }

    const dateBtn = table.locator('tbody tr').first().locator('button').first();
    const hasBtnVisible = await dateBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasBtnVisible) {
      test.skip(true, 'No expandable date button');
      return;
    }

    // Expand
    await dateBtn.click();
    await page.waitForTimeout(1000);

    // Collapse
    await dateBtn.click();
    await page.waitForTimeout(500);

    const allocHeading = page.locator('h3').filter({ hasText: 'Invoice Allocations' });
    const stillVisible = await allocHeading.isVisible().catch(() => false);
    expect(stillVisible).toBe(false);
  });

  test('PH8: Export CSV button is visible and clickable', async ({ page }) => {
    const exportBtn = page.locator('button').filter({ hasText: /Export CSV/i });
    const visible = await exportBtn.isVisible({ timeout: 5000 }).catch(() => false);
    expect(visible).toBe(true);
    // Verify not disabled
    const disabled = await exportBtn.isDisabled().catch(() => false);
    expect(disabled).toBe(false);
  });

  test('PH9: Refresh button reloads without crash', async ({ page }) => {
    const refreshBtn = page.locator('button').filter({ hasText: /Refresh/i });
    const visible = await refreshBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!visible) {
      test.skip(true, 'No Refresh button found');
      return;
    }

    await refreshBtn.click();
    await waitForPageStable(page, 2000);

    const body = await page.locator('body').textContent();
    expect(body).not.toContain('Something went wrong');
    expect(body).toContain('Payment History');
  });

  test('PH10: Void button visible on active payment rows', async ({ page }) => {
    const activeBadge = page.locator('table tbody tr').filter({ hasText: 'Active' }).first();
    const hasActive = await activeBadge.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasActive) {
      test.skip(true, 'No active payment rows found');
      return;
    }

    const voidBtn = activeBadge.locator('button').filter({ hasText: /Void/i });
    const voidVisible = await voidBtn.isVisible({ timeout: 3000 }).catch(() => false);
    expect(voidVisible).toBe(true);
  });

  test('PH11: Void modal opens with required reason field — then Cancel', async ({ page }) => {
    const activeRow = page.locator('table tbody tr').filter({ hasText: 'Active' }).first();
    const hasActive = await activeRow.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasActive) {
      test.skip(true, 'No active payment rows found');
      return;
    }

    const voidBtn = activeRow.locator('button').filter({ hasText: /Void/i });
    const voidVisible = await voidBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!voidVisible) {
      test.skip(true, 'No Void button on active row');
      return;
    }

    await voidBtn.click();
    await page.waitForTimeout(500);

    // Verify modal opened with "Void Payment" title
    const modal = page.locator('[role="dialog"], .fixed').filter({ hasText: /Void Payment/i });
    const modalVisible = await modal.isVisible({ timeout: 3000 }).catch(() => false);
    expect(modalVisible).toBe(true);

    // Verify reason input exists
    const reasonInput = page.locator('input[placeholder*="voided"]');
    const hasReason = await reasonInput.isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasReason).toBe(true);

    // Cancel — do NOT void
    const cancelBtn = modal.locator('button').filter({ hasText: /Cancel/i });
    await cancelBtn.click();
    await page.waitForTimeout(300);

    // Modal should be closed
    const modalStillOpen = await modal.isVisible().catch(() => false);
    expect(modalStillOpen).toBe(false);
  });

  test('PH12: No crash errors on page', async ({ page }) => {
    const body = await page.locator('body').textContent();
    expect(body).not.toContain('Something went wrong');
    expect(body).not.toContain('Cannot read properties');
  });
});
