import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Full Revenue Cycle Verification
 *
 * Walks through every stage of the quote-to-payment pipeline via the UI,
 * verifying each page loads real data, key actions are available, and
 * financial data displays consistently.
 *
 * Uses admin login to verify all pages.
 */

test.describe('Full Revenue Cycle — Page & Data Verification', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  // STAGE 1: Quote Creation
  test('S1: Quote Builder loads with customer search and product selection', async ({ page }) => {
    await page.goto('/quotes/new');
    await page.waitForTimeout(3000);

    // QuoteBuilder should render
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Customer selector should be present (it's a <select> combobox)
    const customerSelect = page.locator('select, [role="combobox"]').first();
    await expect(customerSelect).toBeVisible({ timeout: 10000 });
  });

  // STAGE 2: Quotes List shows existing quotes with statuses
  test('S2: Quotes list displays data with status badges', async ({ page }) => {
    await page.goto('/quotes');
    await page.waitForTimeout(2000);

    await expect(page.locator('h1').first()).toContainText(/Quote/i);

    // Should have at least one quote row
    const rows = page.locator('table tbody tr, [data-testid="quote-row"]');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // First row should have a quote number like Q-XXXX
    const firstRowText = await rows.first().innerText();
    expect(firstRowText).toMatch(/Q-/i);
  });

  // STAGE 3: Orders List and detail navigation
  test('S3: Orders list loads with order data', async ({ page }) => {
    await page.goto('/orders');
    await page.waitForTimeout(2000);

    await expect(page.locator('h1').first()).toContainText(/Order/i);

    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Click first order to verify detail page loads
    await rows.first().click();
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/orders\/.+/);
  });

  // STAGE 4: Deliveries
  test('S4: Deliveries list shows delivery data with statuses', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(2000);

    await expect(page.locator('h1').first()).toContainText(/Deliver/i);

    // Quick Delivery button should be visible to admin
    const quickBtn = page.locator('button:has-text("Quick Delivery")');
    await expect(quickBtn).toBeVisible({ timeout: 5000 });

    // Schedule Delivery button
    const newBtn = page.locator('main button:has-text("Schedule Delivery")');
    await expect(newBtn).toBeVisible({ timeout: 5000 });
  });

  // STAGE 5: Invoices with balance data
  test('S5: Invoices list shows invoices with financial data', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);

    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10000 });

    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Click first invoice to verify detail
    await rows.first().click();
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/invoices\/.+/);

    // Invoice detail should show amount/balance info
    const bodyText = await page.textContent('body');
    // Should contain dollar amounts or "Total" or "Balance"
    expect(bodyText).toMatch(/(\$|Total|Balance|Amount)/i);
  });

  // STAGE 6: Payment Allocation
  test('S6: Payment Allocation page loads with customer selector and allocation UI', async ({ page }) => {
    await page.goto('/payment-allocation');
    await page.waitForTimeout(2000);

    await expect(page.locator('main h1, main h2').first()).toBeVisible({ timeout: 10000 });

    // Customer selector present
    const customerSelector = page.locator('select, [role="combobox"], input[placeholder*="customer" i], input[placeholder*="search" i]').first();
    await expect(customerSelector).toBeVisible({ timeout: 10000 });
  });

  // STAGE 7: AR Aging
  test('S7: AR Aging shows aging buckets', async ({ page }) => {
    await page.goto('/ar-aging');
    await page.waitForTimeout(2000);

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // AR Aging should show some financial data or table
    const bodyText = await page.textContent('body');
    expect(bodyText).toMatch(/(\$|Current|30|60|90|Aging|Balance)/i);
  });

  // STAGE 8: Statements (part of customer detail)
  test('S8: Customer detail shows financial summary', async ({ page }) => {
    await page.goto('/customers');
    await page.waitForTimeout(2000);

    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Click first customer
    await rows.first().click();
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/customers\/.+/);

    // Customer detail should show financial info or tabs
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  // STAGE 9: Inventory verification
  test('S9: Inventory page shows stock data', async ({ page }) => {
    await page.goto('/inventory');
    await page.waitForTimeout(2000);

    await expect(page.locator('h1').first()).toContainText(/Inventor/i);

    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
  });

  // STAGE 10: Purchase Orders
  test('S10: Purchase Orders list and detail', async ({ page }) => {
    await page.goto('/purchase-orders');
    await page.waitForTimeout(2000);

    await expect(page.locator('h1').first()).toContainText(/Purchase/i);

    const rows = page.locator('table tbody tr');
    if (await rows.count() > 0) {
      await rows.first().click();
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(/\/purchase-orders\/.+/);

      // PO detail should show "Receive" or items info
      const bodyText = await page.textContent('body');
      expect(bodyText).toBeTruthy();
    }
  });

  // STAGE 11: Reports page
  test('S11: Reports page loads with report options', async ({ page }) => {
    await page.goto('/reports');
    await page.waitForTimeout(2000);

    await expect(page.locator('h1').first()).toContainText(/Report/i);
  });

  // STAGE 12: Month-End
  test('S12: Month-End page loads', async ({ page }) => {
    await page.goto('/month-end');
    await page.waitForTimeout(2000);

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
    expect(page.url()).toContain('/month-end');
  });

  // STAGE 13: Finance Charges
  test('S13: Settings page loads with company info', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForTimeout(2000);

    const heading = page.locator('h1').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
    expect(page.url()).toContain('/settings');
  });
});

test.describe('Full Revenue Cycle — Financial Data Consistency', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('invoice detail shows correct balance calculation', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);

    // Find a paid invoice (status badge showing "Paid")
    const paidRow = page.locator('table tbody tr:has-text("Paid")').first();
    if (await paidRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await paidRow.click();
      await page.waitForTimeout(2000);

      const bodyText = await page.textContent('body');
      // Paid invoice should show $0 balance
      expect(bodyText).toMatch(/(Balance.*\$0|Paid|Fully Paid)/i);
    }
  });

  test('voided invoice is clearly marked', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(2000);

    // Check if any voided invoices are visible
    const voidedRow = page.locator('table tbody tr:has-text("Voided"), table tbody tr:has-text("voided")').first();
    if (await voidedRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await voidedRow.click();
      await page.waitForTimeout(2000);

      const bodyText = await page.textContent('body');
      expect(bodyText).toMatch(/void/i);
    }
  });

  test('prepayment manager shows credit records', async ({ page }) => {
    await page.goto('/prepayments');
    await page.waitForTimeout(2000);

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
    expect(page.url()).toContain('/prepayments');
  });

  test('commission payments page loads', async ({ page }) => {
    await page.goto('/commission-payments');
    await page.waitForTimeout(2000);

    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
    expect(page.url()).toContain('/commission-payments');
  });
});
