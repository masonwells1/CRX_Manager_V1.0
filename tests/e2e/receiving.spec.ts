import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Receiving Log', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/receiving');
  });

  test('should display receiving log page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show receiving records table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no records|no data|no receiving/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });

  test('should have search or filter controls', async ({ page }) => {
    const search = page.locator('input[placeholder*="search" i], input[type="search"], select').first();
    await expect(search).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Delivery Remainders', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/delivery-remainders');
  });

  test('should display delivery remainders page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show remainder items table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no remainders|no data|no pending|all delivered/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});
