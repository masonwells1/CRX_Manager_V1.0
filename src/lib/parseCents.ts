/**
 * Parse a dollar string into cents (integer). Preserves leading minus signs
 * so negative inputs like "-50" parse to -5000 (used for discount/credit
 * fields where the UI invites negatives).
 *
 * Uses string splitting to avoid parseFloat precision issues.
 *   "25.50" → 2550, "$1,234.56" → 123456, "10" → 1000, "" → 0
 *   "-50" → -5000, "-5.50" → -550, "$-50" → -5000, "-$50" → -5000
 *
 * Use `parseDollarsToCentsPositive` if you need to enforce non-negative input.
 */
export function parseDollarsToCents(input: string): number {
  if (!input || typeof input !== 'string') return 0;
  // Audit #20: reject scientific notation ("1e5" was being silently stripped
  // to "15" and parsed as $15). Anything containing 'e' or 'E' is not a
  // dollar amount; treat as invalid.
  if (/[eE]/.test(input)) return 0;
  // Keep digits, decimal point, and minus signs; drop everything else
  const cleaned = input.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return 0;
  // Audit #20: reject multi-dot input ("1.2.3" was parsing as $1.20 because
  // we kept parts[0] and parts[1] and dropped the rest). A dollar amount has
  // at most one decimal point.
  if ((cleaned.match(/\./g) || []).length > 1) return 0;
  // A minus anywhere in the cleaned string means "negative" (handles "-$5", "$-5")
  const sign = cleaned.includes('-') ? -1 : 1;
  const absStr = cleaned.replace(/-/g, '');
  const parts = absStr.split('.');
  const dollars = parseInt(parts[0] || '0', 10);
  const centStr = (parts[1] || '00').substring(0, 2).padEnd(2, '0');
  const cents = parseInt(centStr, 10);
  return sign * (dollars * 100 + cents);
}

/**
 * Same as parseDollarsToCents but always returns a non-negative integer.
 * Use for fields that semantically require positive input (payment amounts,
 * write-off amounts, etc.) — callers that get a 0 back should treat that as
 * "user typed something invalid."
 */
export function parseDollarsToCentsPositive(input: string): number {
  return Math.abs(parseDollarsToCents(input));
}
