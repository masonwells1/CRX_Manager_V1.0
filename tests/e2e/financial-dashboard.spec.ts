import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Financial Dashboard', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/financial-dashboard');
    await page.waitForTimeout(2000);
  });

  test('should load with financial KPI cards', async ({ page }) => {
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });

    // Financial KPI cards should be visible
    await expect(page.getByText('Total Revenue').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Total Profit').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Quote Pipeline').first()).toBeVisible({ timeout: 5000 });
  });

  test('should show AR aging summary', async ({ page }) => {
    const main = page.locator('#main-content');
    await expect(main.getByText(/AR Aging/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('should show financial summary cards', async ({ page }) => {
    const main = page.locator('#main-content');
    // Prepay, Commission, and Month-End summary cards must be visible
    await expect(main.getByText(/Prepay/i).first()).toBeVisible({ timeout: 5000 });
    await expect(main.getByText(/Commission/i).first()).toBeVisible({ timeout: 5000 });
    await expect(main.getByText(/Month-End/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('should show quick access links to financial pages', async ({ page }) => {
    const main = page.locator('#main-content');
    // Quick access grid must link to financial sub-pages
    const links = ['AR Aging', 'Prepayments', 'Month-End', 'Reports', 'Compliance'];
    for (const label of links) {
      await expect(main.getByText(label).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('should show monthly revenue chart header', async ({ page }) => {
    const main = page.locator('#main-content');
    // Chart section header must be visible
    await expect(main.getByText(/Monthly.*Revenue/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('should load without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        errors.push(msg.text());
      }
    });

    await page.goto('/financial-dashboard');
    await page.waitForTimeout(3000);

    const criticalErrors = errors.filter(
      (e) => !e.includes('net::ERR') && !e.includes('Failed to load resource')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
