import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeInvoiceCoversDelivery,
  activeInvoiceCoversOrder,
  type DeliveryInvoiceCoverage,
} from './deliveryInvoiceCoverage';

const root = process.cwd();

function invoice(overrides: Partial<DeliveryInvoiceCoverage> = {}): DeliveryInvoiceCoverage {
  return {
    order_id: 'order-1',
    delivery_id: null,
    invoice_type: 'chemical_sale',
    status: 'posted',
    deleted_at: null,
    ...overrides,
  };
}

describe('activeInvoiceCoversDelivery', () => {
  it('keeps order billing coverage limited to active sale invoices', () => {
    expect(activeInvoiceCoversOrder(invoice(), 'order-1')).toBe(true);
    expect(activeInvoiceCoversOrder(invoice({ invoice_type: 'credit_memo' }), 'order-1')).toBe(false);
    expect(activeInvoiceCoversOrder(invoice({ status: 'voided' }), 'order-1')).toBe(false);
    expect(activeInvoiceCoversOrder(invoice({ status: 'cancelled' }), 'order-1')).toBe(false);
    expect(activeInvoiceCoversOrder(
      invoice({ deleted_at: '2026-08-26T12:00:00Z' }),
      'order-1',
    )).toBe(false);
    expect(activeInvoiceCoversOrder(invoice(), 'order-2')).toBe(false);
  });

  it('does not let an active order-level return credit hide an unbilled delivery', () => {
    expect(activeInvoiceCoversDelivery(
      invoice({ invoice_type: 'credit_memo' }),
      'delivery-2',
      'order-1',
    )).toBe(false);
  });

  it('accepts active sale coverage for the same delivery or its whole order', () => {
    expect(activeInvoiceCoversDelivery(invoice(), 'delivery-2', 'order-1')).toBe(true);
    expect(activeInvoiceCoversDelivery(
      invoice({ delivery_id: 'delivery-2' }),
      'delivery-2',
      'order-1',
    )).toBe(true);
  });

  it('rejects sibling-delivery, other-order, voided, cancelled, and soft-deleted invoices', () => {
    expect(activeInvoiceCoversDelivery(
      invoice({ delivery_id: 'delivery-1' }),
      'delivery-2',
      'order-1',
    )).toBe(false);
    expect(activeInvoiceCoversDelivery(invoice(), 'delivery-2', 'order-2')).toBe(false);
    expect(activeInvoiceCoversDelivery(invoice({ status: 'voided' }), 'delivery-2', 'order-1')).toBe(false);
    expect(activeInvoiceCoversDelivery(invoice({ status: 'cancelled' }), 'delivery-2', 'order-1')).toBe(false);
    expect(activeInvoiceCoversDelivery(
      invoice({ deleted_at: '2026-08-26T12:00:00Z' }),
      'delivery-2',
      'order-1',
    )).toBe(false);
  });

  it('is used by every UI that reports or recovers unbilled deliveries', () => {
    // Deliberate wiring guard: behavior tests above prove the predicate itself;
    // this check prevents any consumer from silently copying an older local
    // predicate that lets credit memos hide unbilled deliveries.
    for (const relativePath of [
      'src/components/integrity/IntegrityCleanupPanel.tsx',
      'src/pages/DeliveryDetail.tsx',
      'src/pages/OfficeCockpit.tsx',
    ]) {
      const source = readFileSync(resolve(root, relativePath), 'utf8');
      expect(source).toContain('activeInvoiceCoversDelivery');
      expect(source).toContain('invoice_type');
    }
  });

  it('is used by every order UI that reports or recovers billing coverage', () => {
    for (const relativePath of [
      'src/pages/OrderDetail.tsx',
      'src/pages/Orders.tsx',
    ]) {
      const source = readFileSync(resolve(root, relativePath), 'utf8');
      expect(source).toContain('activeInvoiceCoversOrder');
      expect(source).toContain('invoice_type');
      expect(source).toContain('deleted_at');
    }
  });
});
