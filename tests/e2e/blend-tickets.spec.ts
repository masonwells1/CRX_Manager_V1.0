import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Blend Tickets Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/blend-tickets');
  });

  test('should display blend tickets list', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should have new ticket button', async ({ page }) => {
    const addBtn = page.locator('button:has-text("New"), button:has-text("Create"), button:has-text("Add"), a:has-text("New")').first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
  });

  test('should show tickets table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no blend tickets|no data|no tickets/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Blend Recipes Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/recipes');
  });

  test('should display blend recipes page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show recipes table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no recipes|no data|create your first/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Application Records Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/application-records');
  });

  test('should display application records page', async ({ page }) => {
    await expect(page).not.toHaveURL('/login');
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  test('should show records table or empty state', async ({ page }) => {
    const table = page.locator('table, [role="table"]');
    const empty = page.locator('text=/no records|no data|no application/i');
    await expect(table.or(empty).first()).toBeVisible({ timeout: 10000 });
  });
});
