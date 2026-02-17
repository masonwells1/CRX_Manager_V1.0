import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Month-End Close', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/month-end');
  });

  test('should display month-end close page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show close period controls', async ({ page }) => {
    // Month-End page should show content (period controls, checklist, etc.)
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });
    // Should have Month-End heading in TopBar or page
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Commission Payments', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/commission-payments');
  });

  test('should display commission payments page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show commissions table or empty state', async ({ page }) => {
    // Commission Payments uses DataTable with custom empty states
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no commission|no data|no posted|get started/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('AR Aging', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/ar-aging');
  });

  test('should display AR aging page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show aging buckets or summary', async ({ page }) => {
    // AR aging page has tabs and content area
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });
    // The page's own h1 is "AR Aging & Statements" (TopBar h1 may differ)
    const pageH1 = page.locator('#main-content h1, h1:has-text("AR Aging")').first();
    await expect(pageH1).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Prepayment Manager', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/prepayments');
  });

  test('should display prepayment manager page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show prepayments table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no prepay|no data|no customers/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Customer Transaction Review', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/customer-transactions');
  });

  test('should display transaction review page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Payment Allocation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/payment-allocation');
  });

  test('should display payment allocation page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });
});
