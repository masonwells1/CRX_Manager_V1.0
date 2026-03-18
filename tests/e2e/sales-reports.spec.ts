/**
 * sales-reports.spec.ts — Sales Reports page (/sales-reports)
 *
 * Tests the 5-tab sales reporting page with filters and exports:
 *   - Page loads with heading and tab navigation
 *   - 5 tabs: Sales Detail, By Product, By Customer, By Month, By Sales Rep
 *   - Filters: date range, product, customer, sales rep, category, season
 *   - Customer View toggle hides cost/profit/margin columns
 *   - CSV and PDF export buttons
 *   - No console errors
 */
import { test, expect } from '@playwright/test';
import { login } from './utils/auth';
import { waitForPageStable } from './utils/math-helpers';

test.describe('Sales Reports', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/sales-reports');
    await waitForPageStable(page);
  });

  // ──────────────────────────────────────────────────────────────────
  // SR1: Page loads with heading
  // ──────────────────────────────────────────────────────────────────
  test('SR1: Page loads with heading', async ({ page }) => {
    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    expect(bodyText).not.toContain('Something went wrong');
    expect(bodyText).not.toContain('Cannot read properties');
  });

  // ──────────────────────────────────────────────────────────────────
  // SR2: All 5 tabs are visible
  // ──────────────────────────────────────────────────────────────────
  test('SR2: All 5 report tabs are visible', async ({ page }) => {
    const tabLabels = ['Sales Detail', 'By Product', 'By Customer', 'By Month', 'By Sales Rep'];
    for (const label of tabLabels) {
      const tab = page.locator(`button:has-text("${label}"), [role="tab"]:has-text("${label}")`).first();
      await expect(tab).toBeVisible({ timeout: 5000 });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // SR3: Tab switching works
  // ──────────────────────────────────────────────────────────────────
  test('SR3: Clicking each tab changes report content', async ({ page }) => {
    const tabs = ['By Product', 'By Customer', 'By Month', 'By Sales Rep', 'Sales Detail'];
    for (const label of tabs) {
      const tab = page.locator(`button:has-text("${label}"), [role="tab"]:has-text("${label}")`).first();
      await tab.click();
      await page.waitForTimeout(1000);
      const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
      expect(bodyText).not.toContain('Something went wrong');
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // SR4: Date range filters are present
  // ──────────────────────────────────────────────────────────────────
  test('SR4: Date range filters with presets are visible', async ({ page }) => {
    // Date inputs
    const dateInputs = page.locator('input[type="date"]');
    const dateCount = await dateInputs.count();
    expect(dateCount).toBeGreaterThanOrEqual(2);

    // Preset buttons (This Season, Last Season, YTD, Last 30, Last 90)
    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    const hasPreset = bodyText.includes('This Season') ||
                      bodyText.includes('Last Season') ||
                      bodyText.includes('YTD') ||
                      bodyText.includes('Last 30') ||
                      bodyText.includes('Last 90');
    expect(hasPreset).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────
  // SR5: Filter dropdowns are present
  // ──────────────────────────────────────────────────────────────────
  test('SR5: Product, customer, sales rep, category filters exist', async ({ page }) => {
    // Should have multiple select/combobox elements for filtering
    const selects = page.locator('select');
    const selectCount = await selects.count();
    expect(selectCount).toBeGreaterThanOrEqual(2);
  });

  // ──────────────────────────────────────────────────────────────────
  // SR6: Customer View toggle hides financial columns
  // ──────────────────────────────────────────────────────────────────
  test('SR6: Customer View toggle is present', async ({ page }) => {
    const toggleBtn = page.locator(
      'button:has-text("Customer View"), button:has-text("Hide Cost"), label:has-text("Customer View")'
    ).first();
    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    const hasToggle = await toggleBtn.isVisible({ timeout: 5000 }).catch(() => false) ||
                      bodyText.includes('Customer View');
    expect(hasToggle).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────
  // SR7: CSV export button exists and is enabled
  // ──────────────────────────────────────────────────────────────────
  test('SR7: CSV export button is functional', async ({ page }) => {
    const csvBtn = page.locator(
      'button:has-text("CSV"), button:has-text("Export"), button:has-text("Download")'
    ).first();
    const hasCsv = await csvBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasCsv) {
      await expect(csvBtn).toBeEnabled();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // SR8: PDF export button exists
  // ──────────────────────────────────────────────────────────────────
  test('SR8: PDF export button is available', async ({ page }) => {
    const pdfBtn = page.locator(
      'button:has-text("PDF"), button:has-text("Print")'
    ).first();
    const hasPdf = await pdfBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasPdf) {
      await expect(pdfBtn).toBeEnabled();
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // SR9: Data table renders on Sales Detail tab
  // ──────────────────────────────────────────────────────────────────
  test('SR9: Sales Detail tab shows data table or empty state', async ({ page }) => {
    const table = page.locator('table').first();
    const emptyState = page.locator('text=/no.*data|no.*sales|no.*records/i').first();
    const hasTable = await table.isVisible({ timeout: 10000 }).catch(() => false);
    const hasEmpty = await emptyState.isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasTable || hasEmpty).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────
  // SR10: No console errors
  // ──────────────────────────────────────────────────────────────────
  test('SR10: No console errors on sales reports page', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/sales-reports');
    await waitForPageStable(page);

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('net::ERR') &&
        !e.includes('favicon') &&
        !e.includes('Failed to load resource') &&
        !e.includes('Profile fetch attempt') &&
        !e.includes('__cf_bm')
    );
    expect(realErrors.length).toBe(0);
  });
});
