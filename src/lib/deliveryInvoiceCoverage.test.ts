import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from './db';
import {
  activeInvoiceCoversDelivery,
  activeInvoiceCoversOrder,
  activeInvoiceCountsTowardBilling,
  fetchActiveInvoiceCoveragePages,
  type ActiveInvoiceCoverageRow,
  type DeliveryInvoiceCoverage,
} from './deliveryInvoiceCoverage';

vi.mock('./db', () => ({
  supabase: { from: vi.fn() },
}));

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

function coverageRow(id: string, orderId: string): ActiveInvoiceCoverageRow {
  return {
    id,
    order_id: orderId,
    delivery_id: null,
    total_amount_cents: 100,
    invoice_type: 'chemical_sale',
    status: 'posted',
    deleted_at: null,
  };
}

function queryReturning(data: ActiveInvoiceCoverageRow[]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'in', 'not', 'is', 'order']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.range = vi.fn(() => Promise.resolve({ data, error: null }));
  return chain;
}

describe('activeInvoiceCoversDelivery', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
  });

  it('chunks large order filters and paginates each chunk without duplicate ids', async () => {
    const orderIds = Array.from({ length: 201 }, (_, index) => `order-${index}`);
    const queryResults = [
      [coverageRow('invoice-1', 'order-0')],
      [],
      [coverageRow('invoice-2', 'order-200')],
      [],
    ];
    const queries = queryResults.map(queryReturning);
    const pendingQueries = [...queries];
    vi.mocked(supabase.from).mockImplementation(() => pendingQueries.shift() as never);

    const result = await fetchActiveInvoiceCoveragePages([...orderIds, 'order-0']);

    expect(result).toEqual({
      data: [coverageRow('invoice-1', 'order-0'), coverageRow('invoice-2', 'order-200')],
      error: null,
    });
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(4);
    expect(pendingQueries).toHaveLength(0);
    expect(queries[0].in).toHaveBeenCalledWith('order_id', orderIds.slice(0, 200));
    expect(queries[2].in).toHaveBeenCalledWith('order_id', orderIds.slice(200));
    expect(queries[0].range).toHaveBeenCalledWith(0, 999);
    expect(queries[1].range).toHaveBeenCalledWith(1, 1000);
    expect(queries[2].range).toHaveBeenCalledWith(0, 999);
    expect(queries[3].range).toHaveBeenCalledWith(1, 1000);
  });

  it('keeps order billing coverage limited to active sale invoices', () => {
    expect(activeInvoiceCountsTowardBilling(invoice())).toBe(true);
    expect(activeInvoiceCountsTowardBilling(invoice({ invoice_type: 'credit_memo' }))).toBe(false);
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
    }
    const sharedSource = readFileSync(resolve(root, 'src/lib/deliveryInvoiceCoverage.ts'), 'utf8');
    expect(sharedSource).toContain('invoice_type');
    expect(sharedSource).toContain('fetchActiveInvoiceCoveragePages');
  });

  it('is used by every order UI that reports or recovers billing coverage', () => {
    const orderDetail = readFileSync(resolve(root, 'src/pages/OrderDetail.tsx'), 'utf8');
    expect(orderDetail).toContain("activeInvoiceCoversOrder(inv, order?.id ?? '')");

    const orders = readFileSync(resolve(root, 'src/pages/Orders.tsx'), 'utf8');
    expect(orders).toContain('activeInvoiceCountsTowardBilling(inv)');
    expect(orders).toContain('fetchActiveInvoiceCoveragePages(orderIds)');
    expect(orders).toContain('Failed to load invoice coverage. Invoiced percentages are unavailable; refresh to try again.');

    const integrityCleanup = readFileSync(resolve(root, 'src/components/integrity/IntegrityCleanupPanel.tsx'), 'utf8');
    expect(integrityCleanup).toContain('fetchActiveInvoiceCoveragePages(orderIds)');
    expect(integrityCleanup).toContain('Failed to verify invoice coverage. Unbilled delivery results are hidden');
    expect(integrityCleanup).toContain('setInvoiceCoverageFailed(true)');
    expect(integrityCleanup).toContain('Could not verify invoice coverage — refresh to try again.');

    const sharedSource = readFileSync(resolve(root, 'src/lib/deliveryInvoiceCoverage.ts'), 'utf8');
    expect(sharedSource).toContain(".select('id, order_id, delivery_id, total_amount_cents, invoice_type, status, deleted_at')");
    expect(sharedSource).toContain('chunkIds(uniqueOrderIds, INVOICE_COVERAGE_ID_CHUNK_SIZE)');
    expect(sharedSource).toContain(".not('status', 'in', '(\"voided\",\"cancelled\")')");
    expect(sharedSource).toContain(".is('deleted_at', null)");
    expect(sharedSource).toContain('.range(from, from + INVOICE_COVERAGE_PAGE_SIZE - 1)');
    expect(sharedSource).toContain('if (page.length === 0)');
    expect(sharedSource).toContain('from += page.length');
  });
});
