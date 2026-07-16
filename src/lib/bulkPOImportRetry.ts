export interface PendingBulkPOIntent {
  idempotencyKey: string;
  poNumber?: string;
  poId?: string;
  status?: 'pending' | 'imported';
  updatedAt: number;
}

export type PendingBulkPOIntents = Record<string, PendingBulkPOIntent>;

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = 'crx:bulk-po-import-pending:';
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_IMPORTED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface BulkPOIntentItem {
  productId: string | null;
  quantityOrdered: number;
  unitCostCents: number;
  unitSize: string;
  notes: string;
}

export interface BulkPOIntentDocument {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  items: BulkPOIntentItem[];
}

function normalizeIdentityText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Stable business-document identity used across file reselection and reorder.
 * File name, browser file position, size, and modified time are deliberately
 * excluded: those can change without changing the vendor document itself.
 */
export function buildBulkPOIntentKey(document: BulkPOIntentDocument): string | null {
  const invoiceNumber = normalizeIdentityText(document.invoiceNumber);
  if (!invoiceNumber) return null;

  const items = document.items
    .filter((item) => item.productId && item.quantityOrdered > 0)
    .map((item) => ({
      product_id: item.productId,
      quantity_ordered: item.quantityOrdered,
      unit_cost_cents: item.unitCostCents,
      unit_size: normalizeIdentityText(item.unitSize),
      notes: normalizeIdentityText(item.notes),
    }))
    .sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  if (items.length === 0) return null;

  return JSON.stringify({
    vendor_name: normalizeIdentityText(document.vendorName),
    invoice_number: invoiceNumber,
    invoice_date: document.invoiceDate,
    items,
  });
}

/**
 * Cross-tab/device idempotency key for one reviewed vendor document. Web
 * Crypto provides a collision-resistant digest without putting the full PO
 * contents into the database's unique idempotency index.
 */
export async function buildBulkPOIdempotencyKey(
  profileId: string,
  intentKey: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${profileId}\u0000${intentKey}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `save_purchase_order:${profileId}:bulk:${hex}`;
}

function storageKey(profileId: string): string {
  return `${STORAGE_PREFIX}${profileId}`;
}

export function loadPendingBulkPOIntents(
  storage: SessionStorageLike,
  profileId: string,
  now = Date.now(),
): PendingBulkPOIntents {
  try {
    const raw = storage.getItem(storageKey(profileId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PendingBulkPOIntents;
    const fresh = Object.fromEntries(
      Object.entries(parsed).filter(([, entry]) => {
        if (typeof entry?.idempotencyKey !== 'string' || typeof entry?.updatedAt !== 'number') {
          return false;
        }
        const maxAge = entry.status === 'imported' ? MAX_IMPORTED_AGE_MS : MAX_PENDING_AGE_MS;
        return now - entry.updatedAt <= maxAge;
      }),
    );
    if (Object.keys(fresh).length === 0) storage.removeItem(storageKey(profileId));
    else if (Object.keys(fresh).length !== Object.keys(parsed).length) {
      storage.setItem(storageKey(profileId), JSON.stringify(fresh));
    }
    return fresh;
  } catch {
    return {};
  }
}

export function savePendingBulkPOIntents(
  storage: SessionStorageLike,
  profileId: string,
  pending: PendingBulkPOIntents,
): void {
  try {
    if (Object.keys(pending).length === 0) storage.removeItem(storageKey(profileId));
    else storage.setItem(storageKey(profileId), JSON.stringify(pending));
  } catch {
    // Retry durability is best-effort when browser storage is unavailable.
  }
}

export function ensurePendingBulkPOIntent(
  pending: PendingBulkPOIntents,
  intentKey: string,
  createIdempotencyKey: () => string,
  now = Date.now(),
): PendingBulkPOIntent {
  const existing = pending[intentKey];
  if (existing) {
    existing.updatedAt = now;
    return existing;
  }

  const created = {
    idempotencyKey: createIdempotencyKey(),
    status: 'pending' as const,
    updatedAt: now,
  };
  pending[intentKey] = created;
  return created;
}

export function isImportedBulkPOIntent(
  pending: PendingBulkPOIntents,
  intentKey: string,
): boolean {
  return pending[intentKey]?.status === 'imported';
}

export function markBulkPOIntentImported(
  pending: PendingBulkPOIntents,
  intentKey: string,
  poId: string,
  now = Date.now(),
): void {
  const entry = pending[intentKey];
  if (!entry) return;
  entry.status = 'imported';
  entry.poId = poId;
  entry.updatedAt = now;
}
