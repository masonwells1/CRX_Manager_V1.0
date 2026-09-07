import type { CommissionSplit, QuoteVersion } from '../types';
import type { Database } from '../types/supabase';

export type QuoteVersionRow = Database['public']['Tables']['quote_versions']['Row'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isCommissionSplit(value: unknown): value is CommissionSplit | null {
  if (value === null) return true;
  if (!isRecord(value) || !Array.isArray(value.splits)) return false;
  return value.splits.every((split) => (
    isRecord(split)
    && typeof split.recipient === 'string'
    && isFiniteNumber(split.percentage)
    && (
      split.recipient_user_id === undefined
      || split.recipient_user_id === null
      || typeof split.recipient_user_id === 'string'
    )
  ));
}

function isQuoteSnapshotItem(value: unknown): value is QuoteVersion['snapshot_data']['sections'][number]['items'][number] {
  if (!isRecord(value)) return false;
  return typeof value.product_id === 'string'
    && typeof value.product_name === 'string'
    && isNullableString(value.sku)
    && isFiniteNumber(value.sort_order)
    && isNullableString(value.notes)
    && isFiniteNumber(value.price_per_unit)
    && isFiniteNumber(value.current_cost)
    && isNullableString(value.suggested_rate)
    && isNullableFiniteNumber(value.actual_rate)
    && isNullableString(value.rate_unit)
    && isNullableFiniteNumber(value.oz_per_acre)
    && isNullableFiniteNumber(value.price_per_acre)
    && isNullableFiniteNumber(value.acres)
    && isNullableFiniteNumber(value.total_units_needed)
    && isNullableString(value.unit_size)
    && isFiniteNumber(value.profit)
    && isFiniteNumber(value.total_price)
    && isFiniteNumber(value.net_margin)
    && isNullableString(value.calc_mode)
    && isNullableString(value.price_unit);
}

function isQuoteSnapshotQuote(value: unknown): value is QuoteVersion['snapshot_data']['quote'] {
  if (!isRecord(value)) return false;
  const quote = value;
  return typeof quote.quote_number === 'string'
    && typeof quote.customer_id === 'string'
    && isFiniteNumber(quote.tier)
    && typeof quote.status === 'string'
    && isFiniteNumber(quote.total_price)
    && isFiniteNumber(quote.total_cost)
    && isFiniteNumber(quote.total_profit)
    && isFiniteNumber(quote.total_margin_pct)
    && isFiniteNumber(quote.valid_days)
    && isNullableString(quote.expires_at)
    && isNullableString(quote.header_notes)
    && isNullableString(quote.footer_notes)
    && typeof quote.is_planned === 'boolean'
    && isCommissionSplit(quote.commission_split);
}

function parseQuoteSnapshotSection(
  value: unknown,
): QuoteVersion['snapshot_data']['sections'][number] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (typeof value.section_name !== 'string'
    || !isFiniteNumber(value.sort_order)
    || !isNullableString(value.section_notes)
    || (value.section_header_notes !== undefined && !isNullableString(value.section_header_notes))
    || (value.needed_by_date !== undefined && !isNullableString(value.needed_by_date))
    || !value.items.every(isQuoteSnapshotItem)
  ) {
    return null;
  }

  return {
    section_name: value.section_name,
    sort_order: value.sort_order,
    section_notes: value.section_notes,
    section_header_notes: value.section_header_notes ?? null,
    needed_by_date: value.needed_by_date ?? null,
    items: value.items,
  };
}

function parseQuoteVersionSnapshot(value: unknown): QuoteVersion['snapshot_data'] | null {
  if (!isRecord(value) || !isQuoteSnapshotQuote(value.quote) || !Array.isArray(value.sections)) {
    return null;
  }

  const sections: QuoteVersion['snapshot_data']['sections'] = [];
  for (const section of value.sections) {
    const parsedSection = parseQuoteSnapshotSection(section);
    if (!parsedSection) return null;
    sections.push(parsedSection);
  }

  return {
    quote: value.quote,
    sections,
  };
}

export function adaptQuoteVersionRow(row: QuoteVersionRow): QuoteVersion | null {
  const snapshot = parseQuoteVersionSnapshot(row.snapshot_data);
  if (!snapshot) return null;
  return {
    id: row.id,
    quote_id: row.quote_id,
    version_number: row.version_number,
    sent_by: row.sent_by,
    sent_at: row.sent_at,
    sent_method: row.sent_method,
    snapshot_data: snapshot,
    pdf_url: row.pdf_url,
    notes: row.notes,
  };
}

export function adaptQuoteVersionRows(rows: QuoteVersionRow[] | null | undefined): QuoteVersion[] {
  return (rows || []).flatMap((row) => {
    const adapted = adaptQuoteVersionRow(row);
    return adapted ? [adapted] : [];
  });
}

/**
 * A saved version whose snapshot predates the current shape, or is otherwise unreadable.
 * Carries only the row's own trustworthy columns — never a value read out of the snapshot.
 */
export interface UnreadableQuoteVersion {
  id: string;
  version_number: number;
  sent_at: string;
  /**
   * True when the server stamped this row as restorable. `restore_trusted_at` is set by the
   * current version writer and was deliberately never backfilled onto older rows
   * (20260826220000), so an empty value means the server itself treats the row as legacy.
   *
   * A row the server DOES trust that this validator cannot parse is therefore not an old
   * format — it is corruption, or the writer and this validator having drifted apart. The
   * caller must keep reporting those; only the server-legacy rows are expected data.
   */
  server_trusted: boolean;
}

export interface QuoteVersionList {
  versions: QuoteVersion[];
  unreadable: UnreadableQuoteVersion[];
}

/**
 * Split saved versions into the ones whose snapshot can be trusted and the ones that cannot.
 *
 * The history and compare views read `quote.total_price` and `sections[].items` as trusted
 * values, so a snapshot written before the current shape existed must not reach them. But
 * discarding the row hides the fact that the version exists at all: quotes whose only saved
 * versions are legacy would lose their version history entirely. Keep those rows here, with
 * only the columns the row itself guarantees, so the caller can list them without inventing
 * an item count or a total for them.
 *
 * `server_trusted` on each unreadable row says whether the row is expected legacy data or an
 * anomaly the caller should still report — listing a row must never mean going quiet about it.
 */
export function adaptQuoteVersionList(rows: QuoteVersionRow[] | null | undefined): QuoteVersionList {
  const versions: QuoteVersion[] = [];
  const unreadable: UnreadableQuoteVersion[] = [];

  for (const row of rows || []) {
    const adapted = adaptQuoteVersionRow(row);
    if (adapted) {
      versions.push(adapted);
    } else {
      unreadable.push({
        id: row.id,
        version_number: row.version_number,
        sent_at: row.sent_at,
        server_trusted: row.restore_trusted_at != null,
      });
    }
  }

  return { versions, unreadable };
}
