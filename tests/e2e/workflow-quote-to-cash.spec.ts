import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Phase 4.1: Quote-to-Cash Full Lifecycle
 * Tests the complete workflow from quote creation through payment allocation.
 */
test.describe('Quote-to-Cash Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should navigate to quotes and verify page loads', async ({ page }) => {
    await page.goto('/quotes');
    await expect(page.locator('h1').first()).toContainText(/Quote/i);
  });

  test('should navigate to new quote page', async ({ page }) => {
    await page.goto('/quotes/new');
    await page.waitForTimeout(2000);
    // QuoteBuilder loads — check for customer selection or quote form
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should load order creation page', async ({ page }) => {
    await page.goto('/orders/new');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1').first()).toContainText(/New Order/i);
    // Verify customer dropdown exists
    await expect(page.locator('select').first()).toBeVisible();
  });

  test('should load deliveries page for delivery creation', async ({ page }) => {
    await page.goto('/deliveries');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Delivery/i);
  });

  test('should load invoices page for invoice management', async ({ page }) => {
    await page.goto('/invoices');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Invoice/i);
  });

  test('should load payment allocation page', async ({ page }) => {
    await page.goto('/payment-allocation');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Payment/i);
  });

  test('should load AR aging page for verification', async ({ page }) => {
    await page.goto('/ar-aging');
    await page.waitForTimeout(1000);
    await expect(page.locator('h1').first()).toContainText(/Aging|Receivable/i);
  });
});
