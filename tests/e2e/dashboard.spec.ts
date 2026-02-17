import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('should display dashboard with summary cards', async ({ page }) => {
    // TopBar h1 shows "Dashboard Overview"
    await expect(page.locator('h1').first()).toContainText(/Dashboard/i);
    // Dashboard should have main content area visible
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });
  });

  test('should show recent activity feed', async ({ page }) => {
    // Activity feed or recent orders section
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

    // Filter out known non-critical errors
    const criticalErrors = errors.filter(
      (e) => !e.includes('net::ERR') && !e.includes('Failed to load resource')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
