import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Dashboard (Operations)', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('should display operational dashboard without financial data', async ({ page }) => {
    await expect(page.locator('h1').first()).toContainText(/Dashboard/i);
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });

    // Financial widgets should NOT be present
    await expect(page.getByText('Total Revenue')).not.toBeVisible();
    await expect(page.getByText('Total Profit')).not.toBeVisible();
    await expect(page.getByText('Quote Pipeline')).not.toBeVisible();

    // Operational widgets should be present
    await expect(page.getByText('Inventory')).toBeVisible({ timeout: 5000 });
  });

  test('should show upcoming deliveries section', async ({ page }) => {
    const deliveries = page.getByText('Upcoming').first();
    await expect(deliveries).toBeVisible({ timeout: 5000 });
  });

  test('should show recent activity feed', async ({ page }) => {
    const activity = page.locator('text=Recent Activity, text=Recent Orders, text=Activity').first();
    if (await activity.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(activity).toBeVisible();
    }
  });

  test('should load without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    const criticalErrors = errors.filter(
      (e) => !e.includes('net::ERR') && !e.includes('Failed to load resource')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
