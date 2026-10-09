/**
 * Pre-post re-check for the invoice editor (2026-10-09).
 *
 * post_invoice posts the SAVED invoice. The editor blocks Post while there are unsaved
 * local edits, but a change saved from another tab or by another person is not a local
 * edit. So before the Post confirm opens, the editor re-reads the saved invoice and
 * compares it with the copy it loaded. Any difference in what gets billed, printed or
 * where it posts (customer, total, invoice date, payment terms, due date, or any
 * line's product, description, quantity, price or amount) means the person posting has
 * not seen what would post: the editor reloads and refuses this Post.
 *
 * Known limit (accepted residual, see docs/manual/KNOWN_ISSUES.md): this is a
 * client-side check. post_invoice takes no "expected version", so a save landing in
 * the instant between this re-read and the post still posts.
 */

export interface PostRecheckLine {
  id?: string | null;
  product_id: string | null;
  description?: string | null;
  quantity: number | string | null;
  unit_price_cents: number | string | null;
  extended_cents: number | string | null;
}

export interface PostRecheckInvoice {
  customer_id: string | null | undefined;
  total_amount_cents: number | string | null | undefined;
  invoice_date: string | null | undefined;
  payment_terms: string | null | undefined;
  due_date: string | null | undefined;
  lines: ReadonlyArray<PostRecheckLine>;
}

const PLAIN_DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** Canonical text for a plain decimal string: "0012.500" -> "12.5", "-0.0" -> "0". */
function canonicalDecimalText(text: string): string | null {
  const match = PLAIN_DECIMAL.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const intPart = whole.replace(/^0+(?=\d)/, '');
  const fracPart = fraction.replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return body === '0' || sign !== '-' ? body : `-${body}`;
}

/**
 * Canonical TEXT for a numeric value, so the comparison never goes through a float:
 * whole numbers (cents) are compared digit for digit (BigInt-safe, no 2^53 rounding),
 * and decimal quantities compare equal whether they arrive as 2.5, "2.5" or "2.5000".
 * A value that is not a plain number is kept as its raw text, so it can only ever
 * compare as DIFFERENT from a real number (which reloads the invoice: the safe side).
 */
export function canonicalNumberText(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `raw:${String(value)}`;
    if (Number.isInteger(value)) return BigInt(value).toString();
    return canonicalDecimalText(String(value)) ?? `raw:${String(value)}`;
  }
  const text = value.trim();
  if (text === '') return null;
  return canonicalDecimalText(text) ?? `raw:${text}`;
}

/** A stable text fingerprint of the billed content; lines are order-independent (sorted by id). */
export function postRecheckFingerprint(invoice: PostRecheckInvoice): string {
  const lines = invoice.lines
    .map((line) => [
      line.id ?? '',
      line.product_id ?? '',
      line.description || null,
      canonicalNumberText(line.quantity),
      canonicalNumberText(line.unit_price_cents),
      canonicalNumberText(line.extended_cents),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    customer_id: invoice.customer_id ?? null,
    total_amount_cents: canonicalNumberText(invoice.total_amount_cents),
    invoice_date: invoice.invoice_date || null,
    payment_terms: invoice.payment_terms || null,
    due_date: invoice.due_date || null,
    lines,
  });
}

/** True when the freshly read saved invoice differs from the copy loaded on screen. */
export function savedInvoiceChangedSinceLoad(saved: PostRecheckInvoice, loaded: PostRecheckInvoice): boolean {
  return postRecheckFingerprint(saved) !== postRecheckFingerprint(loaded);
}
