/**
 * money.ts — canonical money formatting for CRX Manager.
 *
 * Money is stored as bigint CENTS throughout the app.
 *   - formatCents(cents)   → divides by 100   (123456  -> "$1,234.56")
 *   - formatUSD(dollars)   → no division      (1234.56 -> "$1,234.56")
 *
 * Both render en-US USD. These replace ~35 byte-identical local copies that
 * had drifted into TWO different semantics under the same name `fmt` — see
 * docs/audits/2026-06-03-cleanup-money-touch-log.md.
 *
 * ⚠️ formatCents divides by 100; formatUSD does NOT. Passing a cents value to
 * formatUSD (or a dollars value to formatCents) renders the WRONG amount.
 * Each consolidated callsite was classified by whether its original local
 * helper divided by 100.
 */

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Format an integer number of CENTS as USD. Divides by 100. */
export function formatCents(cents: number): string {
  return usdFormatter.format(cents / 100);
}

/** Format a number already in DOLLARS as USD. Does NOT divide. */
export function formatUSD(dollars: number): string {
  return usdFormatter.format(dollars);
}
