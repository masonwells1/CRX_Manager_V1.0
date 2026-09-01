/**
 * Parse a dollar string into a non-negative cents integer (safer default).
 *
 * Strips currency formatting, decimals, and any sign characters — the result
 * is always >= 0. Use this for money inputs that are semantically positive:
 * payment amounts, write-offs, prices, credit limits, claim amounts, prepay
 * balances, etc. Negative input is treated as a typo/garbage and clamped:
 *   "25.50"  → 2550
 *   "$1,234.56" → 123456
 *   ""       → 0
 *   "-100"   → 10000   (sign stripped — positive semantics enforced)
 *   "1e5"    → 0       (scientific notation rejected)
 *   "1.2.3"  → 0       (multi-dot rejected)
 *
 * Use `parseDollarsToCentsSigned` for the few fields that legitimately accept
 * negative input (vendor bill adjustment_cents, discount fields). Those are
 * the only callsites where -100 means "subtract $1".
 *
 * Codex P2 fix (PR #59, 2026-05-13): previously, this function preserved the
 * sign. Most callers don't revalidate, so e.g. CustomerDetail's Credit Limit
 * input stored a negative credit_limit_cents, and `create_quick_delivery`
 * then skips the credit check when limit ≤ 0. Making positive the default
 * closes that latent bypass.
 */
export function parseDollarsToCents(input: string): number {
  return Math.abs(parseDollarsToCentsSigned(input));
}

/**
 * Validate a form-entered dollar amount before parsing it into cents.
 *
 * The legacy parsers intentionally tolerate formatted input and truncate extra
 * fractional digits. Mutation forms must use this guard first so an operator
 * cannot submit a value such as `1.999` and silently store `1.99`.
 */
export function isWholeCentDollarInput(
  input: string,
  options: { allowNegative?: boolean } = {},
): boolean {
  if (typeof input !== 'string') return false;
  const value = input.trim();
  if (!value) return false;

  const unsignedDollars = String.raw`(?:\d+(?:\.\d{0,2})?|\.\d{1,2})`;
  const pattern = options.allowNegative
    ? new RegExp(`^-?${unsignedDollars}$`)
    : new RegExp(`^${unsignedDollars}$`);
  return pattern.test(value);
}

/**
 * Parse a dollar string into cents (integer), preserving leading minus signs
 * so negative inputs like "-50" parse to -5000.
 *
 * Use ONLY for fields that semantically accept negatives (vendor bill
 * adjustment_cents in NewVendorBill / VendorBillDetail, discount fields).
 * For all other money inputs use `parseDollarsToCents` (positive-only).
 *
 * Examples:
 *   "25.50"  → 2550
 *   "-50"    → -5000
 *   "-5.50"  → -550
 *   "$-50"   → -5000
 *   "-$50"   → -5000
 *   "-"      → 0   (no digits)
 *   "-."     → 0
 *   "12-34"  → 0   (dash not leading = malformed; was -123400)
 *
 * Implementation uses string splitting to avoid parseFloat precision issues.
 * Rejects scientific notation, multi-dot input (audit #20), and a minus sign
 * anywhere but the leading position (codex-driven hunt cycle 2).
 */
export function parseDollarsToCentsSigned(input: string): number {
  if (!input || typeof input !== 'string') return 0;
  if (/[eE]/.test(input)) return 0;
  const cleaned = input.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return 0;
  if ((cleaned.match(/\./g) || []).length > 1) return 0;
  // A minus is only valid as the LEADING sign character. A dash anywhere else
  // ("12-34", "50-", "5-0") is malformed input and is rejected (return 0), the
  // same way multi-dot and scientific notation are rejected above. Previously
  // every dash was treated as the sign and then stripped, so "12-34" parsed as
  // -123400 cents — a large bogus negative on the signed callers (vendor-bill
  // adjustment_cents, discount fields).
  const sign = cleaned[0] === '-' ? -1 : 1;
  const absStr = sign === -1 ? cleaned.slice(1) : cleaned;
  if (absStr.includes('-')) return 0;
  const parts = absStr.split('.');
  const dollars = parseInt(parts[0] || '0', 10);
  const centStr = (parts[1] || '00').substring(0, 2).padEnd(2, '0');
  const cents = parseInt(centStr, 10);
  return sign * (dollars * 100 + cents);
}
