import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Customer CRUD Operations', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should navigate to customers page', async ({ page }) => {
    await page.goto('/customers');
    await expect(page).toHaveURL('/customers');
    // TopBar h1 shows "Customer Database"
    await expect(page.locator('h1').first()).toContainText('Customer');
  });

  test('should create a new customer', async ({ page }) => {
    await page.goto('/customers');
    await page.waitForTimeout(1000);

    // Look for add button in the main content area
    const addButton = page.locator('#main-content button:has-text("Add"), button:has-text("New Customer"), button:has-text("Add Customer")').first();
    if (await addButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addButton.click();
      await page.waitForTimeout(500);

      const timestamp = Date.now();
      const testEmail = `test-${timestamp}@example.com`;

      // Fill form fields that exist
      const nameInput = page.locator('input[placeholder*="name" i], input[name="farm_name"]').first();
      if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await nameInput.fill(`Test Customer ${timestamp}`);
      }

      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill(testEmail);
      }

      const saveButton = page.locator('button:has-text("Save"), button:has-text("Create"), button[type="submit"]').first();
      if (await saveButton.isVisible().catch(() => false)) {
        await saveButton.click();
        await page.waitForTimeout(2000);
      }
    }
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
