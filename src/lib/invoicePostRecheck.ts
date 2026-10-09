/**
 * Pre-post re-check for the invoice editor (2026-10-09).
 *
 * post_invoice posts the SAVED invoice. The editor blocks Post while there are unsaved
 * local edits, but a change saved from another tab or by another person is not a local
 * edit. So before the Post confirm opens, the editor re-reads the saved invoice and
 * compares it with the copy it loaded. Any difference in what gets billed or where it
 * posts (customer, total, invoice date, payment terms, due date, or any line's product,
 * quantity, price or amount) means the person posting has not seen what would post:
 * the editor reloads and refuses this Post.
 */

export interface PostRecheckLine {
  id?: string | null;
  product_id: string | null;
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

const num = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined || value === '' ? null : Number(value);

/** A stable text fingerprint of the billed content; lines are order-independent (sorted by id). */
export function postRecheckFingerprint(invoice: PostRecheckInvoice): string {
  const lines = invoice.lines
    .map((line) => [
      line.id ?? '',
      line.product_id ?? '',
      num(line.quantity),
      num(line.unit_price_cents),
      num(line.extended_cents),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    customer_id: invoice.customer_id ?? null,
    total_amount_cents: num(invoice.total_amount_cents),
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
