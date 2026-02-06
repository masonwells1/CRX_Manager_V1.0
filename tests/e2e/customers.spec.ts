import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Customer CRUD Operations', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should navigate to customers page', async ({ page }) => {
    await page.click('text=Customers');
    await expect(page).toHaveURL('/customers');
    await expect(page.locator('h1')).toContainText('Customers');
  });

  test('should create a new customer', async ({ page }) => {
    await page.goto('/customers');

    const addButton = page.locator('button:has-text("Add Customer"), button:has-text("New Customer")').first();
    await addButton.click();

    await page.waitForTimeout(500);

    const timestamp = Date.now();
    const testEmail = `test-${timestamp}@example.com`;

    await page.fill('input[name="name"], input[placeholder*="name" i]', `Test Customer ${timestamp}`);
    await page.fill('input[type="email"], input[name="email"]', testEmail);
    await page.fill('input[name="phone"], input[placeholder*="phone" i]', '555-1234');

    const saveButton = page.locator('button:has-text("Save"), button:has-text("Create"), button[type="submit"]').first();
    await saveButton.click();

    await page.waitForTimeout(2000);
    await expect(page.locator(`text=${testEmail}`).first()).toBeVisible({ timeout: 5000 });
  });

  test('should search for customers', async ({ page }) => {
    await page.goto('/customers');

    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await page.waitForTimeout(1000);
    }
  });

  test('should view customer details', async ({ page }) => {
    await page.goto('/customers');
    await page.waitForTimeout(1000);

    const firstCustomer = page.locator('table tbody tr, [role="row"]').first();
    if (await firstCustomer.isVisible()) {
      await firstCustomer.click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/\/customers\/.+/);
    }
  });
});
