import { describe, expect, it, vi } from 'vitest';
import {
  buildBulkPOIntentKey,
  buildBulkPODocumentClaimKey,
  buildBulkPOIdempotencyKey,
  ensurePendingBulkPOIntent,
  isImportedBulkPOIntent,
  loadPendingBulkPOIntents,
  markBulkPOIntentImported,
  normalizeBulkPOInvoiceDate,
  savePendingBulkPOIntents,
} from './bulkPOImportRetry';

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('bulk PO import retry state', () => {
  it('uses stable document content across file reorder and line reorder', () => {
    const firstDocument = {
      vendorName: '  Vendor A ',
      invoiceNumber: 'INV-100',
      invoiceDate: '2026-07-16',
      items: [
        { productId: 'product-b', quantityOrdered: 2, unitCostCents: 450, unitSize: 'GAL', notes: '' },
        { productId: 'product-a', quantityOrdered: 1, unitCostCents: 300, unitSize: 'EA', notes: 'Seed' },
      ],
    };
    const secondDocument = {
      vendorName: 'Vendor B',
      invoiceNumber: 'INV-200',
      invoiceDate: '2026-07-17',
      items: [
        { productId: 'product-c', quantityOrdered: 3, unitCostCents: 125, unitSize: 'LB', notes: '' },
      ],
    };

    const firstSelection = [firstDocument, secondDocument].map(buildBulkPOIntentKey);
    const reorderedSelection = [
      secondDocument,
      { ...firstDocument, vendorName: 'vendor a', items: [...firstDocument.items].reverse() },
    ].map(buildBulkPOIntentKey);

    expect(new Set(reorderedSelection)).toEqual(new Set(firstSelection));
    expect(firstSelection.every(Boolean)).toBe(true);
  });

  it('canonicalizes equivalent invoice dates and excludes missing or invalid fallbacks', () => {
    expect(normalizeBulkPOInvoiceDate('2026-7-6')).toBe('2026-07-06');
    expect(normalizeBulkPOInvoiceDate('07/06/2026')).toBe('2026-07-06');
    expect(normalizeBulkPOInvoiceDate('')).toBeNull();
    expect(normalizeBulkPOInvoiceDate('2026-02-30')).toBeNull();

    const document = {
      vendorName: 'Vendor A',
      invoiceNumber: 'INV-100',
      invoiceDate: '2026-07-16',
      items: [
        { productId: 'product-a', quantityOrdered: 1, unitCostCents: 300, unitSize: 'EA', notes: '' },
      ],
    };

    expect(buildBulkPOIntentKey({ ...document, invoiceDate: '07/16/2026' }))
      .toBe(buildBulkPOIntentKey(document));
    expect(buildBulkPOIntentKey({ ...document, invoiceDate: '' }))
      .toBe(buildBulkPOIntentKey({ ...document, invoiceDate: 'unrecognized OCR value' }));
  });

  it('requires a vendor invoice number so two legitimate documents cannot collide', () => {
    expect(buildBulkPOIntentKey({
      vendorName: 'Vendor A',
      invoiceNumber: '   ',
      invoiceDate: '2026-07-16',
      items: [
        { productId: 'product-a', quantityOrdered: 1, unitCostCents: 300, unitSize: 'EA', notes: '' },
      ],
    })).toBeNull();
  });

  it('derives the same cross-tab idempotency key for the same reviewed intent', async () => {
    const first = await buildBulkPOIdempotencyKey('sales-1', 'stable-intent');
    const second = await buildBulkPOIdempotencyKey('sales-1', 'stable-intent');

    expect(first).toBe(second);
    expect(first).toMatch(/^save_purchase_order:sales-1:bulk:[a-f0-9]{64}$/);
    expect(await buildBulkPOIdempotencyKey('sales-2', 'stable-intent')).not.toBe(first);
  });

  it('derives one document claim across different importing users', async () => {
    const first = await buildBulkPODocumentClaimKey('stable-intent');
    const second = await buildBulkPODocumentClaimKey('stable-intent');

    expect(first).toBe(second);
    expect(first).toMatch(/^bulk-po-document:[a-f0-9]{64}$/);
  });

  it('reuses pending work and persists successful imports across close/reopen', () => {
    const storage = fakeStorage();
    const createKey = vi.fn()
      .mockReturnValueOnce('idem-first')
      .mockReturnValueOnce('idem-second');
    const pending = {};

    const first = ensurePendingBulkPOIntent(pending, 'intent-A', createKey, 1_000);
    first.poNumber = 'PO-1001';
    savePendingBulkPOIntents(storage, 'sales-1', pending);

    const reopened = loadPendingBulkPOIntents(storage, 'sales-1', 2_000);
    const retry = ensurePendingBulkPOIntent(reopened, 'intent-A', createKey, 2_000);

    expect(retry).toMatchObject({ idempotencyKey: 'idem-first', poNumber: 'PO-1001' });
    expect(createKey).toHaveBeenCalledTimes(1);

    markBulkPOIntentImported(reopened, 'intent-A', 'po-id-1001', 3_000, 'PO-EXISTING');
    savePendingBulkPOIntents(storage, 'sales-1', reopened);

    const afterSuccessReopen = loadPendingBulkPOIntents(storage, 'sales-1', 4_000);
    expect(isImportedBulkPOIntent(afterSuccessReopen, 'intent-A')).toBe(true);
    expect(afterSuccessReopen['intent-A']).toMatchObject({
      idempotencyKey: 'idem-first',
      poNumber: 'PO-EXISTING',
      poId: 'po-id-1001',
      status: 'imported',
    });
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('expires abandoned pending imports after 24 hours', () => {
    const storage = fakeStorage();
    const pending = {};
    ensurePendingBulkPOIntent(pending, 'intent-A', () => 'idem-old', 1_000);
    savePendingBulkPOIntents(storage, 'sales-1', pending);

    expect(loadPendingBulkPOIntents(storage, 'sales-1', 24 * 60 * 60 * 1000 + 1_001)).toEqual({});
  });

  it('retains successful import markers for 30 days', () => {
    const storage = fakeStorage();
    const pending = {};
    ensurePendingBulkPOIntent(pending, 'intent-A', () => 'idem-imported', 1_000);
    markBulkPOIntentImported(pending, 'intent-A', 'po-id', 2_000);
    savePendingBulkPOIntents(storage, 'sales-1', pending);

    const afterOneDay = loadPendingBulkPOIntents(
      storage,
      'sales-1',
      24 * 60 * 60 * 1000 + 2_001,
    );
    expect(isImportedBulkPOIntent(afterOneDay, 'intent-A')).toBe(true);

    expect(loadPendingBulkPOIntents(
      storage,
      'sales-1',
      30 * 24 * 60 * 60 * 1000 + 2_001,
    )).toEqual({});
  });
});
