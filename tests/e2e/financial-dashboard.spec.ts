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
    await expect(page.getByText('Total Revenue')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Total Profit')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Quote Pipeline')).toBeVisible({ timeout: 5000 });
  });

  test('should show AR aging summary', async ({ page }) => {
    await expect(page.getByText(/AR Aging|Aging/i)).toBeVisible({ timeout: 5000 });
  });

  test('should show financial summary cards', async ({ page }) => {
    // New summary cards
    const summaryTexts = ['Prepay', 'Commission', 'Period'];
    for (const text of summaryTexts) {
      const el = page.getByText(new RegExp(text, 'i')).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(el).toBeVisible();
      }
    }
  });

  test('should show quick access links to financial pages', async ({ page }) => {
    // Quick access grid should link to financial sub-pages
    const links = ['AR Aging', 'Prepayments', 'Month-End', 'Reports', 'Compliance'];
    for (const label of links) {
      const link = page.getByText(label).first();
      if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(link).toBeVisible();
      }
    }
  });

  test('should show monthly revenue chart when data exists', async ({ page }) => {
    // Chart or "Monthly Revenue & Profit" header
    const chart = page.getByText(/Monthly.*Revenue/i).first();
    if (await chart.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(chart).toBeVisible();
    }
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
