import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Quotes Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/quotes');
    await page.waitForTimeout(1000);
  });

  test('should display quotes list', async ({ page }) => {
    await expect(page.locator('h1').first()).toContainText('Quote');
    const rows = page.locator('table tbody tr');
    const emptyState = page.locator('text=/no quotes/i');
    await expect(rows.first().or(emptyState)).toBeVisible({ timeout: 10000 });
  });

  test('should have New Quote button', async ({ page }) => {
    const newQuoteBtn = page.locator('button:has-text("New Quote"), a:has-text("New Quote")').first();
    await expect(newQuoteBtn).toBeVisible();
  });

  test('should navigate to quote builder', async ({ page }) => {
    const newQuoteBtn = page.locator('button:has-text("New Quote"), a:has-text("New Quote")').first();
    await newQuoteBtn.click();
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/\/quotes\/new/);
  });

  test('should filter quotes by status', async ({ page }) => {
    const statusFilter = page.locator('select[aria-label*="status" i], select').first();
    if (await statusFilter.isVisible()) {
      await statusFilter.selectOption({ index: 1 });
      await page.waitForTimeout(500);
    }
  });

  test('should navigate to existing quote detail', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 })) {
      await firstRow.click();
      await page.waitForTimeout(1000);
      await expect(page).toHaveURL(/\/quotes\/.+/);
    }
  });
});

test.describe('Quote Builder', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/quotes/new');
    await page.waitForTimeout(2000);
  });

  test('should load quote builder page', async ({ page }) => {
    // Should have customer selector and section area
    await expect(page.locator('label:has-text("Customer"), select').first()).toBeVisible({ timeout: 10000 });
  });

  test('should have tier selector', async ({ page }) => {
    const tierSelect = page.locator('select, [role="combobox"]').first();
    await expect(tierSelect).toBeVisible({ timeout: 10000 });
  });
});
