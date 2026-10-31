import type { QuoteVersion } from '../types';
import { RpcErrorCodes, rpcCodeDetail } from './db';

/** The lock's refusal (QUOTE_RESEND_REQUIRED) carries a plain-English instruction after its token. */
export function resendRequiredMessage(err: unknown): string {
  return rpcCodeDetail(err, RpcErrorCodes.QUOTE_RESEND_REQUIRED)
    || 'This quote changed after it was last sent. Send it to the customer again, or rewind it to the version last sent, then try again.';
}

// The screen's view of the sent-price lock (migration 20261027040000). The database check
// `_assert_quote_prices_as_sent` stays the authority; these mirror it so the page can say in advance
// what Convert, Partial Order and Schedule Job will refuse.

type SentItem = QuoteVersion['snapshot_data']['sections'][number]['items'][number];

export interface PriceLockLine {
  /** The saved quote_items id the page loaded for this line; absent for a line added since. */
  id?: string;
  product_id: string;
  price_per_unit: number;
}

/** How one line compares with the version last sent: unchanged (null), not sent, or a different price. */
export type SentLineState = null | { kind: 'new' } | { kind: 'price'; sentCents: number };

export type UnsentQuoteChange = null | 'unreadable' | 'customer' | 'prices';

// Both sides are dollars with at most two decimals (a CHECK keeps quote prices at cent scale).
const toCents = (dollars: number) => Math.round(dollars * 100);

/** Whether two cent-scale dollar prices are the same number of cents. */
export function samePrice(a: number, b: number): boolean {
  return toCents(a) === toCents(b);
}

export function sentItemsOf(version: QuoteVersion | null): SentItem[] {
  return version ? version.snapshot_data.sections.flatMap((section) => section.items) : [];
}

/** Versions written since 20261027040000 name every line; older ones are matched by product. */
function sentItemsCarryLineIds(sentItems: SentItem[]): boolean {
  return sentItems.length > 0 && sentItems.every((item) => Boolean(item.quote_item_id));
}

export function sentLineState(sentItems: SentItem[], line: PriceLockLine): SentLineState {
  if (sentItemsCarryLineIds(sentItems)) {
    const sent = sentItems.find((item) => item.quote_item_id === line.id && item.product_id === line.product_id);
    if (!sent) return { kind: 'new' };
    return samePrice(sent.price_per_unit, line.price_per_unit)
      ? null
      : { kind: 'price', sentCents: toCents(sent.price_per_unit) };
  }
  const sameProduct = sentItems.filter((item) => item.product_id === line.product_id);
  if (sameProduct.length === 0) return { kind: 'new' };
  return sameProduct.some((item) => toCents(item.price_per_unit) === toCents(line.price_per_unit))
    ? null
    : { kind: 'price', sentCents: toCents(sameProduct[0].price_per_unit) };
}

/**
 * Whether the quote needs to be sent again before it is billed: the newest version cannot be read
 * here, the customer changed, or a line differs from the version last sent. For a version without
 * line ids the lines must also pair one to one by product, as the database requires.
 */
export function unsentQuoteChange(args: {
  lastSent: QuoteVersion | null;
  newestVersionNumber: number;
  customerId: string;
  lines: PriceLockLine[];
}): UnsentQuoteChange {
  const { lastSent, newestVersionNumber, customerId, lines } = args;
  if (newestVersionNumber === 0) return null;
  if (!lastSent || lastSent.version_number < newestVersionNumber) return 'unreadable';
  if (customerId && lastSent.snapshot_data.quote.customer_id !== customerId) return 'customer';
  const sentItems = sentItemsOf(lastSent);
  if (!sentItemsCarryLineIds(sentItems)) {
    const repeats = (productIds: string[]) => new Set(productIds).size !== productIds.length;
    if (lines.length !== sentItems.length
      || repeats(lines.map((line) => line.product_id))
      || repeats(sentItems.map((item) => item.product_id))) {
      return 'prices';
    }
  }
  // A changed price on a line the customer was sent is recorded when it is saved and needs no
  // re-send (20261029120000, Mason 2026-10-27). A new line, or a version without line ids, still does.
  const carriesIds = sentItemsCarryLineIds(sentItems);
  return lines.some((line) => {
    const state = sentLineState(sentItems, line);
    return state !== null && !(carriesIds && state.kind === 'price');
  }) ? 'prices' : null;
}
