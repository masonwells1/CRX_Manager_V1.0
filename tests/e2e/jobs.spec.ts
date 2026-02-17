import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Jobs Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/jobs');
  });

  test('should display jobs list', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should have create job button', async ({ page }) => {
    const addBtn = page.locator('button:has-text("New"), button:has-text("Create"), button:has-text("Add"), a:has-text("New Job")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
  });

  test('should show jobs table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no jobs|no data|create your first/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });

  test('should have status filter', async ({ page }) => {
    const filter = page.locator('select, [role="combobox"], button:has-text("Status"), button:has-text("Filter")').first();
    await expect(filter).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Job Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should navigate to job detail from list', async ({ page }) => {
    await page.goto('/jobs');
    const row = page.locator('tbody tr').first();
    if (await row.isVisible({ timeout: 5000 }).catch(() => false)) {
      await row.click();
      await expect(page.url()).toContain('/jobs/');
    }
  });
});
