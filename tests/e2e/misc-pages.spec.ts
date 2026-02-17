import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Compliance Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/compliance');
  });

  test('should display compliance page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show compliance data or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no data|no records|no compliance/i');
    const content = page.locator('text=/license|applicator|RUP|restricted/i').first();
    await expect(table.or(empty).or(content).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Rebates Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/rebates');
  });

  test('should display rebates page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show rebates table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no rebates|no data|no programs/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Cycle Counts Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/cycle-counts');
  });

  test('should display cycle counts page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show counts table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no counts|no data|no cycle/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Returns Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/returns');
  });

  test('should display returns page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show returns table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no returns|no data|no RMA/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Brand vs Generic Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/brand-vs-generic');
  });

  test('should display brand vs generic page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show mapping data or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no data|no mappings|no ingredients/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Crop Programs Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/crop-programs');
  });

  test('should display crop programs page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show programs table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no programs|no data|create your first/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Notifications Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/notifications');
  });

  test('should display notifications page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show notifications list or empty state', async ({ page }) => {
    const list = page.locator('[role="list"], ul, .notification, table');
    const empty = page.locator('text=/no notifications|all caught up|no new/i');
    await expect(list.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Invoices Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/invoices');
  });

  test('should display invoices page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show invoices table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no invoices|no data/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});
