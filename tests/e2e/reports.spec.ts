import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Reports Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/reports');
    await page.waitForTimeout(1000);
  });

  test('should display reports page', async ({ page }) => {
    await expect(page.locator('h1, h2').first()).toContainText(/Reports/i);
  });

  test('should have report type tabs or sections', async ({ page }) => {
    // Reports page has tabs for different report types
    const tabs = page.locator('button, [role="tab"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Payments Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/payments');
    await page.waitForTimeout(1000);
  });

  test('should display payments page', async ({ page }) => {
    await expect(page.locator('h1')).toContainText(/Payments/i);
  });

  test('should show payment records or empty state', async ({ page }) => {
    const rows = page.locator('table tbody tr');
    const emptyState = page.locator('text=No payments');
    await expect(rows.first().or(emptyState)).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Team Board Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/team-board');
    await page.waitForTimeout(1000);
  });

  test('should display team board', async ({ page }) => {
    await expect(page.locator('h1, h2').first()).toContainText(/Team Board/i);
  });

  test('should have add note button', async ({ page }) => {
    const addBtn = page.locator('button:has-text("New Note"), button:has-text("Add Note"), button:has-text("New")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
  });
});
