/**
 * Go-Live Validation Helpers
 *
 * Extraction and assertion utilities for reading dollar amounts,
 * quantities, and summary cards from the CRX Manager UI.
 */

import { Page, Locator, expect } from '@playwright/test';

// Re-export everything from the shared math helpers
export {
  parseDollars,
  parseQuantity,
  parsePercent,
  assertCentsEqual,
  assertApproxEqual,
  sumDollarStrings,
  allTexts,
  allDollarValues,
  getColumnMap,
  cellText,
  waitForPageStable,
} from '../../utils/math-helpers';

// Also import locally for use within this file
import { waitForPageStable } from '../../utils/math-helpers';

/**
 * Navigate to a path and wait for the page to stabilize.
 */
export async function navAndStabilize(page: Page, path: string, ms = 2000) {
  await page.goto(path);
  await waitForPageStable(page, ms);
}

/**
 * Assert the page body does not contain critical error messages.
 */
export async function assertNoCriticalErrors(page: Page) {
  const body = await page.locator('body').textContent();
  const text = body ?? '';
  expect(text).not.toContain('Something went wrong');
  expect(text).not.toContain('Cannot read properties of undefined');
  expect(text).not.toContain('Cannot read properties of null');
}

/**
 * Extract a labeled value from the page.
 * Looks for a text element containing the label, then reads the
 * nearest value element (typically a sibling with font-medium/semibold).
 *
 * Returns the raw text string. Use parseDollars() or parseQuantity() to convert.
 */
export async function extractLabeledValue(
  page: Page,
  label: string,
): Promise<string> {
  // Try to find the label and grab the parent container's text
  const labelEl = page.locator(`text=${label}`).first();
  const isVisible = await labelEl.isVisible({ timeout: 3000 }).catch(() => false);
  if (!isVisible) return '';

  // Get the parent element and look for the value sibling
  const parent = labelEl.locator('..');
  const valueEl = parent.locator('.text-2xl, .text-xl, .text-lg, .font-semibold, .font-medium, .font-bold').first();
  const isValueVisible = await valueEl.isVisible({ timeout: 2000 }).catch(() => false);

  if (isValueVisible) {
    return ((await valueEl.textContent()) ?? '').trim();
  }

  // Fallback: just grab the full parent text
  return ((await parent.textContent()) ?? '').trim();
}

/**
 * Extract all rows from a table as objects keyed by lowercased header names.
 */
export async function extractTableRows(
  page: Page,
  tableLocator?: Locator,
): Promise<Record<string, string>[]> {
  const table = tableLocator ?? page.locator('table').first();
  const isVisible = await table.isVisible({ timeout: 5000 }).catch(() => false);
  if (!isVisible) return [];

  // Get headers
  const headers = table.locator('thead th, thead td');
  const headerCount = await headers.count();
  const headerNames: string[] = [];
  for (let i = 0; i < headerCount; i++) {
    const text = ((await headers.nth(i).textContent()) ?? '').trim().toLowerCase();
    headerNames.push(text || `col_${i}`);
  }

  // Get rows
  const rows = table.locator('tbody tr');
  const rowCount = await rows.count();
  const result: Record<string, string>[] = [];

  for (let r = 0; r < Math.min(rowCount, 50); r++) {
    const cells = rows.nth(r).locator('td');
    const cellCount = await cells.count();
    const row: Record<string, string> = {};

    for (let c = 0; c < Math.min(cellCount, headerNames.length); c++) {
      const text = ((await cells.nth(c).textContent()) ?? '').trim();
      row[headerNames[c]] = text;
    }

    result.push(row);
  }

  return result;
}

/**
 * Extract summary card values from a dashboard-style page.
 * Returns a Map of label → raw text value.
 */
export async function extractSummaryCards(page: Page): Promise<Map<string, string>> {
  const cards = new Map<string, string>();

  // Look for common card patterns: div with a label span and value span
  const cardEls = page.locator('[class*="rounded"], [class*="card"], [class*="stat"]');
  const count = await cardEls.count();

  for (let i = 0; i < Math.min(count, 20); i++) {
    const card = cardEls.nth(i);
    const text = ((await card.textContent()) ?? '').trim();

    // Try to split label from value — look for small text (label) and large text (value)
    const label = card.locator('.text-sm, .text-xs, .text-gray-500, .text-gray-600, .text-muted-foreground').first();
    const value = card.locator('.text-2xl, .text-xl, .text-lg, .font-semibold, .font-bold').first();

    const labelVisible = await label.isVisible({ timeout: 1000 }).catch(() => false);
    const valueVisible = await value.isVisible({ timeout: 1000 }).catch(() => false);

    if (labelVisible && valueVisible) {
      const labelText = ((await label.textContent()) ?? '').trim();
      const valueText = ((await value.textContent()) ?? '').trim();
      if (labelText && valueText) {
        cards.set(labelText, valueText);
      }
    }
  }

  return cards;
}

/**
 * Collect console errors from the page, filtering out known non-critical ones.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter known non-critical errors
      if (text.includes('ResizeObserver')) return;
      if (text.includes('net::ERR')) return;
      if (text.includes('favicon')) return;
      if (text.includes('Profile fetch attempt')) return;
      if (text.includes('Failed to load resource') && text.includes('favicon')) return;
      errors.push(text);
    }
  });

  return errors;
}
