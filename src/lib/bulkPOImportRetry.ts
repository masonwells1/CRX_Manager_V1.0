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

const DOCUMENT_IDENTITY_SEPARATOR = '\u001f';

/**
 * Normalize the two date shapes accepted by the OCR review form without
 * relying on locale-sensitive Date parsing. Missing or unrecognized dates are
 * excluded from the claim so a document whose OCR omitted the date does not
 * acquire a different identity on a later import day.
 */
export function normalizeBulkPOInvoiceDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const parts = iso
    ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    : us
      ? { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) }
      : null;
  if (!parts) return null;

  const candidate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    candidate.getUTCFullYear() !== parts.year
    || candidate.getUTCMonth() !== parts.month - 1
    || candidate.getUTCDate() !== parts.day
  ) {
    return null;
  }

  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * Stable vendor-document identity used across file reselection, OCR correction,
 * and line review. File metadata, date, product matching, quantities, costs,
 * units, and notes are deliberately excluded: those describe the reviewed
 * content, but must not let one vendor invoice acquire a second durable claim.
 */
export function buildBulkPOIntentKey(document: BulkPOIntentDocument): string | null {
  const vendorName = normalizeIdentityText(document.vendorName);
  const invoiceNumber = normalizeIdentityText(document.invoiceNumber);
  // The claim is global across employees and devices. Without a vendor, two
  // unrelated vendors that reuse an invoice number and line layout could be
  // mistaken for the same business document.
  if (
    !vendorName
    || !invoiceNumber
    || vendorName.includes(DOCUMENT_IDENTITY_SEPARATOR)
    || invoiceNumber.includes(DOCUMENT_IDENTITY_SEPARATOR)
  ) return null;

  return `${vendorName}${DOCUMENT_IDENTITY_SEPARATOR}${invoiceNumber}`;
}

/**
 * Cross-tab/device idempotency key for one reviewed vendor document. Web
 * Crypto provides a collision-resistant digest without putting the full PO
 * contents into the database's unique idempotency index.
 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function buildBulkPOIdempotencyKey(
  profileId: string,
  intentKey: string,
): Promise<string> {
  return `save_purchase_order:${profileId}:bulk:${await sha256Hex(`${profileId}\u0000${intentKey}`)}`;
}

/** Stable across users so the server can claim one vendor document globally. */
export async function buildBulkPODocumentClaimKey(intentKey: string): Promise<string> {
  return `bulk-po-document:${await sha256Hex(intentKey)}`;
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
  poNumber?: string,
): void {
  const entry = pending[intentKey];
  if (!entry) return;
  entry.status = 'imported';
  entry.poId = poId;
  if (poNumber) entry.poNumber = poNumber;
  entry.updatedAt = now;
}
