/**
 * Math verification helpers for E2E tests.
 * Parse displayed dollar amounts / quantities back to numeric values
 * and compare them with tolerance for rounding.
 */

import { expect, Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a displayed dollar string like "$1,234.56" or "($500.00)" → cents (integer).
 * Handles negatives via leading minus or parentheses.
 * Returns 0 for empty / unparseable strings.
 */
export function parseDollars(text: string | null | undefined): number {
  if (!text) return 0;
  const cleaned = text.trim();
  if (!cleaned) return 0;

  const isNegative = cleaned.startsWith('-') || cleaned.startsWith('(');
  // Strip everything except digits and decimal point
  const digits = cleaned.replace(/[^0-9.]/g, '');
  if (!digits) return 0;

  const dollars = parseFloat(digits);
  if (Number.isNaN(dollars)) return 0;

  const cents = Math.round(dollars * 100);
  return isNegative ? -cents : cents;
}

/**
 * Parse a displayed quantity string like "1,234" or "1,234.5" → number.
 */
export function parseQuantity(text: string | null | undefined): number {
  if (!text) return 0;
  const cleaned = text.trim().replace(/[^0-9.-]/g, '');
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse a percentage string like "12.5%" → number (12.5).
 */
export function parsePercent(text: string | null | undefined): number {
  if (!text) return 0;
  const cleaned = text.trim().replace(/[^0-9.-]/g, '');
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Assert two cent values are equal within a tolerance (default ±1 cent).
 * Useful for percentage-based calculations (commissions, margins).
 */
export function assertCentsEqual(
  actual: number,
  expected: number,
  tolerance = 1,
  message?: string,
) {
  const diff = Math.abs(actual - expected);
  const msg =
    message ??
    `Expected ${expected} cents ($${(expected / 100).toFixed(2)}) ` +
      `but got ${actual} cents ($${(actual / 100).toFixed(2)}), diff=${diff}`;
  expect(diff).toBeLessThanOrEqual(tolerance, msg);
}

/**
 * Assert two numeric values are approximately equal (default tolerance ±0.01).
 */
export function assertApproxEqual(
  actual: number,
  expected: number,
  tolerance = 0.01,
  message?: string,
) {
  const diff = Math.abs(actual - expected);
  const msg = message ?? `Expected ~${expected} but got ${actual}, diff=${diff}`;
  expect(diff).toBeLessThanOrEqual(tolerance, msg);
}

// ---------------------------------------------------------------------------
// Bulk extractors
// ---------------------------------------------------------------------------

/**
 * Sum an array of dollar strings.  Returns total in cents.
 */
export function sumDollarStrings(texts: (string | null | undefined)[]): number {
  return texts.reduce((sum, t) => sum + parseDollars(t), 0);
}

/**
 * Extract all text contents from a locator set, return as string array.
 */
export async function allTexts(locator: Locator): Promise<string[]> {
  const count = await locator.count();
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    results.push((await locator.nth(i).textContent()) ?? '');
  }
  return results;
}

/**
 * Extract all dollar values from a locator set, return as cents array.
 */
export async function allDollarValues(locator: Locator): Promise<number[]> {
  const texts = await allTexts(locator);
  return texts.map(parseDollars);
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

/**
 * Given a table locator, extract the text of the header row to discover column indices.
 * Returns a Map of lowercased header text → column index (0-based).
 */
export async function getColumnMap(table: Locator): Promise<Map<string, number>> {
  const headers = table.locator('thead th, thead td');
  const count = await headers.count();
  const map = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const text = ((await headers.nth(i).textContent()) ?? '').trim().toLowerCase();
    if (text) map.set(text, i);
  }
  return map;
}

/**
 * Read a cell from a table row by column index.
 */
export async function cellText(row: Locator, colIndex: number): Promise<string> {
  return ((await row.locator('td').nth(colIndex).textContent()) ?? '').trim();
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a page to settle after navigation (network idle + short pause).
 */
export async function waitForPageStable(page: import('@playwright/test').Page, ms = 1500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}
