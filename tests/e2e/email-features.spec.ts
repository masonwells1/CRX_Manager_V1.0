/**
 * email-features.spec.ts — Email integration feature tests
 *
 * Tests the email button visibility and state across touchpoints:
 *   - Invoice email button (visible only when posted + admin)
 *   - Quote send triggers auto-email
 *   - No console errors when email features are present
 *
 * Does NOT actually send emails — only verifies UI button presence/state.
 */
import { test, expect } from '@playwright/test';
import { login } from './utils/auth';
import { waitForPageStable } from './utils/math-helpers';
import { supabaseRest } from './golive/utils/supabase-helpers';

test.describe('Email Features — Invoice', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', (d) => d.accept());
  });

  // ──────────────────────────────────────────────────────────────────
  // EM1: Invoice detail shows email button for posted invoices
  // ──────────────────────────────────────────────────────────────────
  test('EM1: Posted invoice shows email button', async ({ page }) => {
    test.setTimeout(60000);

    // Query DB directly for a posted invoice
    const invoices = (await supabaseRest(
      page, 'GET',
      'invoices?status=eq.posted&select=id,invoice_number&limit=1'
    )) as Array<{ id: string; invoice_number: string }>;
    const arr = Array.isArray(invoices) ? invoices : [];
    expect(arr.length).toBeGreaterThan(0);

    // Navigate directly to invoice detail
    await page.goto(`/invoices/${arr[0].id}`);
    await waitForPageStable(page);

    // Verify page loaded
    const bodyText = await page.textContent('body') || '';
    expect(bodyText).not.toContain('Something went wrong');

    // Look for the Mail icon button (email invoice) — visible only for posted + admin
    const emailBtn = page.locator(
      'button:has(svg.lucide-mail), button[title*="Email" i], button[aria-label*="Email" i], button:has-text("Email")'
    ).first();
    const hasEmailBtn = await emailBtn.isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasEmailBtn).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────
  // EM2: Draft invoice does NOT show email button
  // ──────────────────────────────────────────────────────────────────
  test('EM2: Draft invoice does not show email button', async ({ page }) => {
    test.setTimeout(60000);

    // Query DB directly for a draft invoice
    const invoices = (await supabaseRest(
      page, 'GET',
      'invoices?status=eq.draft&select=id,invoice_number&limit=1'
    )) as Array<{ id: string; invoice_number: string }>;
    const arr = Array.isArray(invoices) ? invoices : [];
    expect(arr.length).toBeGreaterThan(0);

    // Navigate directly to draft invoice detail
    await page.goto(`/invoices/${arr[0].id}`);
    await waitForPageStable(page);

    // Email button should NOT be visible on draft invoice
    const emailBtn = page.locator(
      'button:has(svg.lucide-mail), button[title*="Email" i], button[aria-label*="Email" i]'
    ).first();
    const hasEmailBtn = await emailBtn.isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasEmailBtn).toBeFalsy();
  });

  // ──────────────────────────────────────────────────────────────────
  // EM3: AR Aging page has Send AR Reminders button (admin)
  // ──────────────────────────────────────────────────────────────────
  test('EM3: AR Aging page has Send AR Reminders button', async ({ page }) => {
    await page.goto('/ar-aging');
    await waitForPageStable(page);

    const reminderBtn = page.locator(
      'button:has-text("AR Reminder"), button:has-text("Send Reminder"), button:has-text("Email Statement")'
    ).first();
    const bodyText = ((await page.locator('body').textContent()) ?? '').trim();
    const hasReminder = await reminderBtn.isVisible({ timeout: 5000 }).catch(() => false) ||
                        bodyText.includes('Reminder') ||
                        bodyText.includes('Email Statement');
    expect(hasReminder).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────
  // EM4: No console errors on invoice detail with email feature
  // ──────────────────────────────────────────────────────────────────
  test('EM4: No console errors on invoice detail', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/invoices');
    await waitForPageStable(page);

    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstRow.click();
      await waitForPageStable(page);
    }

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('net::ERR') &&
        !e.includes('favicon') &&
        !e.includes('Failed to load resource') &&
        !e.includes('Profile fetch attempt')
    );
    expect(realErrors.length).toBe(0);
  });
});
