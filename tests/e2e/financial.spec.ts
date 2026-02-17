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
    // Should have some period selection or checklist
    const content = page.locator('text=/period|month|close|checklist/i').first();
    await expect(content).toBeVisible({ timeout: 10000 });
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
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no commissions|no data|no payments/i');
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
    // AR aging should show aging categories
    const content = page.locator('text=/current|30|60|90|overdue|aging/i').first();
    await expect(content).toBeVisible({ timeout: 10000 });
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
    const empty = page.locator('text=/no prepayments|no data/i');
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
