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
 *
 * ⚠️ Do NOT re-alias these to a local `fmt` (e.g. `const fmt = formatCents`).
 * A single name `fmt` is exactly the cents-vs-dollars ambiguity this module was
 * created to remove; import `formatCents` / `formatUSD` by their explicit names
 * so the semantics stay visible at the callsite. (Enforcing this with a lint rule
 * is possible future hardening — deliberately not added yet, since it would force
 * a blind rename across the existing `fmt` callsites.)
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

// Below 2^46 dollars, adjacent IEEE-754 values are still less than one cent
// apart. Given the report RPC's whole-cent PostgreSQL numeric invariant, the
// JSON-decoded number therefore identifies one unique cent value. At and above
// this boundary, distinct cent values can collapse to the same JS number.
const MAX_LOSSLESS_WHOLE_CENT_JSON_DOLLARS = 2 ** 46;

/**
 * Format exact decimal dollar text, or a whole-cent JSON number only while its
 * cent value is still lossless. Invalid/fractional-cent inputs fail visibly.
 */
export function formatExactUSD(value: unknown): string {
  let text: string;

  if (typeof value === 'string') {
    text = value.trim();
  } else if (
    typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) < MAX_LOSSLESS_WHOLE_CENT_JSON_DOLLARS
  ) {
    text = String(value);
  } else {
    return 'Invalid amount';
  }

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return 'Invalid amount';

  const whole = BigInt(match[2]).toString();
  const fraction = (match[3] || '').padEnd(2, '0');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const isZero = whole === '0' && fraction === '00';
  const sign = match[1] === '-' && !isZero ? '-' : '';

  return `${sign}$${groupedWhole}.${fraction}`;
}

/** Format integer CENTS for a decimal money input without floating-point math. */
export function centsToDollarInput(cents: number): string {
  if (!Number.isSafeInteger(cents)) return '0.00';
  const value = BigInt(cents);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const dollars = absolute / 100n;
  const remainder = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${dollars}.${remainder}`;
}

// ── Exact cents × quantity ────────────────────────────────────────────────────
//
// THE SERVER IS AUTHORITATIVE. Every extended amount is computed by the SQL helper
// `safe_cents_qty(p_cents bigint, p_qty numeric)` (migration 20260513030000):
//
//     SELECT ROUND(COALESCE(p_cents,0)::numeric * COALESCE(p_qty,0))::bigint;
//
// The multiply happens in PostgreSQL `numeric`, which is EXACT decimal, and ROUND on a
// numeric rounds half AWAY FROM ZERO. (The migration's own comment calls this "banker's
// rounding" — that is wrong; round(numeric) is half-away-from-zero in PostgreSQL, while
// only round(double precision) is half-to-even. The code is right, the comment is not.)
//
// Doing the same multiply in JavaScript with `qty * cents` computes in BINARY floating
// point, where most decimal fractions have no exact representation, so a product whose
// exact value lands on a half-cent can fall to the wrong side of the rounding boundary:
//
//     5c x 0.3  → exact 1.5  → server ROUND(1.5) = 2c
//                 float 0.3 * 5 = 1.4999999999999998  → Math.round = 1c   ← off by a cent
//
// JobDetail SAVES its client-side totals into jobs.total_cost_cents / total_price_cents,
// so that divergence is not cosmetic — it persists a figure the database's own arithmetic
// disagrees with. AGENTS.md forbids binary floating-point rounding on a money path.
//
// This helper reproduces safe_cents_qty exactly: parse the quantity as a decimal string
// into an integer numerator and a power-of-ten scale, multiply in BigInt (exact), then
// round half away from zero. For the non-negative values this app deals in, that is the
// same rule Math.round applies — the difference is purely that the product is exact.

// The ONE grammar this module can multiply exactly: a plain decimal. Exponent notation
// ('1e3'), NaN, Infinity and stray text are all outside it. Every caller that decides
// whether an amount is saveable MUST gate on `isExactDecimalText` rather than on
// `Number.isFinite(Number(text))`, or the two disagree and the save persists a nonzero
// line against a zero total. `<input type="number">` really does accept '1e3' as a valid
// value, so that divergence is reachable from the keyboard, not just in theory. (Codex P2)
const PLAIN_DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * True when `text` is a plain decimal that `centsTimesQuantity` can multiply EXACTLY.
 * This is the saveability gate: if it returns false, the value must be refused, never
 * coerced — coercing is what silently produced a zero total behind a nonzero line.
 */
export function isExactDecimalText(text: string | number | null | undefined): boolean {
  const raw = String(text ?? '').trim();
  if (raw === '') return false;
  const m = PLAIN_DECIMAL.exec(raw);
  return m != null && !(m[2] === '' && (m[3] ?? '') === '');
}

/** Split a plain decimal into (negative, numerator, scale) — exact, no float. */
function decimalParts(text: string): { negative: boolean; numerator: bigint; scale: number } | null {
  const m = PLAIN_DECIMAL.exec(String(text ?? '').trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const frac = m[3] || '';
  return { negative: m[1] === '-', numerator: BigInt((m[2] || '0') + frac), scale: frac.length };
}

/**
 * True when two plain-decimal strings denote the SAME exact value ('0.30' === '0.3').
 * Compares by cross-multiplying to a common scale in BigInt — never through a float.
 */
export function sameExactDecimal(a: string | number, b: string | number): boolean {
  const pa = decimalParts(String(a));
  const pb = decimalParts(String(b));
  if (pa == null || pb == null) return false;
  const scale = Math.max(pa.scale, pb.scale);
  const na = pa.numerator * 10n ** BigInt(scale - pa.scale);
  const nb = pb.numerator * 10n ** BigInt(scale - pb.scale);
  if (na === 0n && nb === 0n) return true;   // -0 === 0
  return na === nb && pa.negative === pb.negative;
}

/**
 * True when a quantity's decimal text still means the same number after the trip it
 * actually takes on save.
 *
 * WHY THIS GATE EXISTS (Codex P2, 2026-08-23). The page now totals money from the exact
 * decimal STRING via `centsTimesQuantity`, but `buildJobChemicalsPayload` persists the same
 * field as `parseFloat(quantity)` — a binary double. When those two disagree, so do the
 * header and the line: typing `0.29999999999999999` against a 5c unit price totals 1c here
 * (exact 1.4999…), while the payload stores `0.3` and the server's `safe_cents_qty` bills
 * 2c (exact 1.5, rounded away from zero). The stored total then contradicts the stored line.
 *
 * Refused rather than coerced, matching how this module treats fractional cents and
 * exponent notation. Every quantity an operator can realistically type — anything within
 * ~15 significant digits, which includes every 4-decimal value the rate maths produces —
 * round-trips unchanged and is unaffected.
 */
export function quantitySurvivesSave(text: string | number | null | undefined): boolean {
  const raw = String(text ?? '').trim();
  if (!isExactDecimalText(raw)) return false;
  const asFloat = parseFloat(raw);
  if (!Number.isFinite(asFloat)) return false;
  const persisted = String(asFloat);
  // `String(1e-7)` is '1e-7' — exponent notation, which centsTimesQuantity cannot multiply.
  // Such a value cannot be reconciled with the server at all, so it fails here too.
  if (!isExactDecimalText(persisted)) return false;
  return sameExactDecimal(raw, persisted);
}

/**
 * Multiply an integer CENTS amount by a decimal quantity and round to whole cents
 * EXACTLY as the server's `safe_cents_qty` does. Returns 0 for a blank/non-finite
 * quantity, matching the server's COALESCE(...,0).
 *
 * @param cents        integer cents (a non-integer is rejected as 0 — cents are whole)
 * @param quantityText the quantity as the UI holds it: a decimal STRING, so no precision
 *                     is lost before we get here. A number is accepted for convenience but
 *                     has already been through binary float, so prefer the string form.
 */
export function centsTimesQuantity(cents: number, quantityText: string | number): number {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return 0;
  const raw = String(quantityText ?? '').trim();
  if (raw === '') return 0;
  // Reject anything that is not a plain decimal (exponents, NaN, Infinity, stray text).
  const m = PLAIN_DECIMAL.exec(raw);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return 0;

  const negative = m[1] === '-';
  const whole = m[2] || '0';
  const frac = m[3] || '';
  const numerator = BigInt(whole + frac);           // qty × 10^scale, exactly
  const denominator = 10n ** BigInt(frac.length);   // 10^scale

  // `numerator` is built from digits only, so the quantity's sign is carried separately.
  const product = BigInt(cents) * numerator * (negative ? -1n : 1n);  // exact — no float anywhere
  const absProduct = product < 0n ? -product : product;
  const quotient = absProduct / denominator;
  const remainder = absProduct % denominator;
  // Half AWAY FROM ZERO, matching PostgreSQL's ROUND(numeric).
  const roundedAbs = remainder * 2n >= denominator ? quotient + 1n : quotient;

  // Above 2^53 − 1 a Number no longer holds every integer, so Number(...) would silently
  // land on a NEIGHBOURING cent (9007199254740993n → 9007199254740992). The server's
  // numeric has no such boundary, so past this point the client cannot reproduce the
  // server's figure at all. NaN, deliberately — not 0 (this function's invalid-input
  // convention), because 0 would bill NOTHING for the largest line on the job, and not a
  // clamp, which is just a different wrong number. NaN survives summation, so the totals
  // fail runJobSave's Number.isSafeInteger gate and the save is refused loudly instead of
  // billed a cent off. (Codex Medium, 2026-08-24)
  if (roundedAbs > 9007199254740991n) return Number.NaN;

  return Number(product < 0n ? -roundedAbs : roundedAbs);
}
