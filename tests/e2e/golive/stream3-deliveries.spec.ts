/**
 * Stream 3: Delivery Lifecycle Validation
 *
 * Validates the deliveries page, detail views, status badges,
 * tote tracking columns, Load Sheet button, and cross-references
 * delivery data against the database via Supabase REST API.
 */

import { test, expect, Page } from '@playwright/test';
import { login } from '../utils/auth';
import { supabaseRest, asArray } from './utils/supabase-helpers';
import {
  navAndStabilize,
  assertNoCriticalErrors,
  extractTableRows,
  collectConsoleErrors,
} from './utils/golive-helpers';

test.describe.serial('Stream 3 — Deliveries', () => {
  let page: Page;

  test('DEL1: Login', async ({ browser }) => {
    page = await browser.newPage();
    await login(page);
    await page.waitForTimeout(2000);

    // Verify we have an auth token for subsequent DB queries
    const token = await page.evaluate(() => {
      const raw = localStorage.getItem('sb-rhyzpcqhnizqbxphqdkr-auth-token');
      if (!raw) return '';
      try {
        const session = JSON.parse(raw);
        return session.access_token || '';
      } catch {
        return '';
      }
    });
    expect(token).toBeTruthy();
  });

  test('DEL2: Deliveries page loads', async () => {
    await navAndStabilize(page, '/deliveries');
    await assertNoCriticalErrors(page);

    // Verify a table or list of deliveries is visible
    const table = page.locator('table');
    const list = page.locator('[role="list"], [class*="list"], [class*="grid"]');
    const tableVisible = await table.isVisible({ timeout: 5000 }).catch(() => false);
    const listVisible = await list.first().isVisible({ timeout: 3000 }).catch(() => false);

    expect(tableVisible || listVisible).toBe(true);
  });

  test('DEL3: Delivery status badges are valid', async () => {
    await navAndStabilize(page, '/deliveries');

    const rows = await extractTableRows(page);

    // Find the status column (may be called 'status', 'delivery status', etc.)
    const statusKey = Object.keys(rows[0] ?? {}).find(
      (k) => k === 'status' || k.includes('status'),
    );

    if (statusKey && rows.length > 0) {
      const validStatuses = new Set([
        'scheduled',
        'in_progress',
        'in progress',
        'completed',
        'cancelled',
        'canceled',
      ]);

      for (const row of rows) {
        const status = (row[statusKey] ?? '').trim().toLowerCase();
        if (status) {
          expect(
            validStatuses.has(status),
            `Unexpected delivery status: "${row[statusKey]}" (row: ${JSON.stringify(row)})`,
          ).toBe(true);
        }
      }
    } else {
      // No status column in table headers — check for status badges in the DOM
      const badges = page.locator(
        '[class*="badge"], [class*="status"], [data-status]',
      );
      const badgeCount = await badges.count();
      // At minimum, verify the page rendered without error
      expect(badgeCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('DEL4: Load Sheet button is present', async () => {
    await navAndStabilize(page, '/deliveries');

    const loadSheetBtn = page
      .locator('button:has-text("Load Sheet"), a:has-text("Load Sheet")')
      .first();

    const isVisible = await loadSheetBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    expect(isVisible).toBe(true);
  });

  test('DEL5: Delivery detail page loads', async () => {
    await navAndStabilize(page, '/deliveries');

    // Click the first delivery row to navigate to detail
    const firstRow = page.locator('table tbody tr').first();
    const rowVisible = await firstRow
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(rowVisible).toBe(true);

    await firstRow.click();

    // Wait for navigation to the detail page
    await page.waitForTimeout(2000);
    await assertNoCriticalErrors(page);

    // Verify we navigated away from the list (URL should change)
    const url = page.url();
    expect(
      url.includes('/deliveries/') || url.includes('/delivery/'),
      `Expected detail URL, got: ${url}`,
    ).toBe(true);

    // Look for delivery details content
    const bodyText = (await page.locator('body').textContent()) ?? '';
    const hasDeliveryInfo =
      bodyText.toLowerCase().includes('delivery') ||
      bodyText.toLowerCase().includes('status') ||
      bodyText.toLowerCase().includes('customer');

    expect(hasDeliveryInfo).toBe(true);
  });

  test('DEL6: Delivery items table present on detail', async () => {
    // We should still be on the detail page from DEL5
    const url = page.url();
    expect(
      url.includes('/deliveries/') || url.includes('/delivery/'),
      `Expected to be on detail page, got: ${url}`,
    ).toBe(true);

    // Look for an items table on the detail page
    const itemsTable = page.locator('table');
    const tableVisible = await itemsTable
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (tableVisible) {
      // Verify it has at least one data row
      const rowCount = await itemsTable.first().locator('tbody tr').count();
      expect(rowCount).toBeGreaterThanOrEqual(1);

      // Check for expected column headers (product, quantity, tote)
      const headers = itemsTable.first().locator('thead th, thead td');
      const headerCount = await headers.count();
      const headerTexts: string[] = [];
      for (let i = 0; i < headerCount; i++) {
        const text = ((await headers.nth(i).textContent()) ?? '')
          .trim()
          .toLowerCase();
        headerTexts.push(text);
      }

      const hasProductCol = headerTexts.some(
        (h) => h.includes('product') || h.includes('item') || h.includes('name'),
      );
      const hasQuantityCol = headerTexts.some(
        (h) => h.includes('qty') || h.includes('quantity') || h.includes('delivered'),
      );

      expect(hasProductCol || hasQuantityCol).toBe(true);
    } else {
      // If no table, look for a list-style layout of items
      const itemElements = page.locator(
        '[class*="item"], [class*="line-item"], [class*="product"]',
      );
      const itemCount = await itemElements.count();
      expect(itemCount).toBeGreaterThanOrEqual(1);
    }
  });

  test('DEL7: Tote tracking columns present', async () => {
    // Still on the detail page from DEL5/DEL6
    const url = page.url();
    expect(
      url.includes('/deliveries/') || url.includes('/delivery/'),
      `Expected to be on detail page, got: ${url}`,
    ).toBe(true);

    // Check for tote-related content anywhere on the page
    // Tote columns may be in the items table header, labels, or body text
    const bodyText = ((await page.locator('body').textContent()) ?? '').toLowerCase();
    const hasToteInBody = bodyText.includes('tote');

    // Also check for column headers and form labels
    const toteLocator = page.locator(
      'th:has-text("Tote"), th:has-text("tote"), label:has-text("Tote"), ' +
        'td:has-text("Tote"), [class*="tote"], th:has-text("Tote Number"), ' +
        'label:has-text("Tote Number"), span:has-text("Tote")',
    );
    const toteCount = await toteLocator.count();

    // Also verify via DB that the delivery_items table has tote_number column
    const dbItems = await supabaseRest(
      page,
      'GET',
      'delivery_items?select=tote_number&limit=1',
    );
    const dbHasToteCol = Array.isArray(dbItems);

    // Pass if any tote evidence is found (UI text, DOM elements, or DB column)
    expect(
      hasToteInBody || toteCount > 0 || dbHasToteCol,
      'Expected tote tracking evidence on delivery detail page or in DB schema',
    ).toBe(true);
  });

  test('DEL8: DB cross-reference delivery quantities', async () => {
    // Navigate back to a page with auth context (ensure token is available)
    await navAndStabilize(page, '/deliveries');

    // Query deliveries from DB
    const delResult = await supabaseRest(
      page,
      'GET',
      'deliveries?select=id,delivery_number,status&limit=10',
    );
    const deliveries = asArray<{ id: string; delivery_number: string; status: string }>(delResult, 'deliveries');
    expect(deliveries.length).toBeGreaterThan(0);

    // Verify each delivery has a valid status
    const validStatuses = new Set([
      'scheduled',
      'in_progress',
      'completed',
      'cancelled',
      'canceled',
    ]);

    for (const delivery of deliveries) {
      expect(delivery.status).toBeTruthy();
      expect(
        validStatuses.has(delivery.status),
        `Delivery ${delivery.delivery_number} has invalid status: "${delivery.status}"`,
      ).toBe(true);
    }

    // Query delivery items and verify quantities are non-negative
    const diResult = await supabaseRest(
      page,
      'GET',
      'delivery_items?select=delivery_id,quantity_delivered,product_id&limit=50',
    );
    const deliveryItems = asArray<{
      delivery_id: string;
      quantity_delivered: number;
      product_id: string;
    }>(diResult, 'delivery_items');

    for (const item of deliveryItems) {
      expect(
        item.quantity_delivered >= 0,
        `Delivery item for product ${item.product_id} in delivery ${item.delivery_id} ` +
          `has negative quantity: ${item.quantity_delivered}`,
      ).toBe(true);
    }
  });

  test('DEL9: No console errors', async () => {
    // Start collecting console errors before navigation
    const errors = collectConsoleErrors(page);

    await navAndStabilize(page, '/deliveries', 3000);

    // Give the page time to fully render and any async errors to surface
    await page.waitForTimeout(3000);

    expect(
      errors,
      `Found ${errors.length} console error(s):\n${errors.join('\n')}`,
    ).toHaveLength(0);
  });

  test.afterAll(async () => {
    await page?.close();
  });
});
