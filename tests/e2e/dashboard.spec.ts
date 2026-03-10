import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

test.describe('Operational Dashboard', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForTimeout(2000);
  });

  test('should display operational dashboard header', async ({ page }) => {
    await expect(page.locator('h1').first()).toContainText(/Operational/i);
    await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 });
  });

  test('should show top KPI cards (admin view)', async ({ page }) => {
    await expect(page.getByText('Active Orders')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Open Quotes')).toBeVisible();
    await expect(page.getByText('Pending Deliveries')).toBeVisible();
    await expect(page.getByText('Open POs')).toBeVisible();
  });

  test('should show team board action items section', async ({ page }) => {
    const main = page.locator('#main-content');
    await expect(main.getByText('Team Board')).toBeVisible({ timeout: 5000 });
    // Either shows action items or "All Clear" message
    const hasItems = await main.getByText('All Clear').isVisible().catch(() => false);
    const hasBoard = await main.getByText('View Board').isVisible().catch(() => false);
    expect(hasItems || hasBoard).toBeTruthy();
  });

  test('should show inventory position section', async ({ page }) => {
    await expect(page.getByText('Inventory Position')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Floor Stock').first()).toBeVisible();
    await expect(page.getByText('On Order').first()).toBeVisible();
    await expect(page.getByText('Committed').first()).toBeVisible();
  });

  test('should show delivery command center', async ({ page }) => {
    const main = page.locator('#main-content');
    await expect(main.getByText('Delivery').first()).toBeVisible({ timeout: 5000 });
    await expect(main.getByText('Command Center')).toBeVisible();
    // Stat mini-cards
    await expect(main.getByText('Today').first()).toBeVisible();
    await expect(main.getByText('This Week').first()).toBeVisible();
  });

  test('should show sales pipeline section', async ({ page }) => {
    await expect(page.getByText('Sales Pipeline')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Quote Pipeline')).toBeVisible();
  });

  test('should show operational alerts section', async ({ page }) => {
    await expect(page.getByText('Operational Alerts')).toBeVisible({ timeout: 5000 });
  });

  test('should show monthly activity chart', async ({ page }) => {
    const main = page.locator('#main-content');
    await expect(main.getByText('Monthly').first()).toBeVisible({ timeout: 5000 });
    // Chart legend
    const ordersLegend = main.getByText('Orders').first();
    await expect(ordersLegend).toBeVisible();
  });

  test('should show season progress bar', async ({ page }) => {
    await expect(page.getByText('Season Progress')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Oct 1')).toBeVisible();
    await expect(page.getByText('Sep 30')).toBeVisible();
  });

  test('should show recent activity feed', async ({ page }) => {
    const main = page.locator('#main-content');
    await expect(main.getByText('Recent').first()).toBeVisible({ timeout: 5000 });
  });

  test('should show quick actions', async ({ page }) => {
    const main = page.locator('#main-content');
    await expect(main.getByText('Quick').first()).toBeVisible({ timeout: 5000 });
    await expect(main.getByText('New Order')).toBeVisible();
    await expect(main.getByText('New PO')).toBeVisible();
    await expect(main.getByText('Schedule Delivery')).toBeVisible();
    await expect(main.getByText('Inventory').last()).toBeVisible();
    await expect(main.getByText('Receiving')).toBeVisible();
  });

  test('should NOT show financial data', async ({ page }) => {
    // Financial KPIs should NOT be on the operational dashboard
    await expect(page.getByText('Total Revenue')).not.toBeVisible();
    await expect(page.getByText('Total Profit')).not.toBeVisible();
    await expect(page.getByText('AR Balance')).not.toBeVisible();
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
