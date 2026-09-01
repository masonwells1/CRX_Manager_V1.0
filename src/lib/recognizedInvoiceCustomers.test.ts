import { describe, expect, it, vi } from 'vitest';
import {
  collectAssignedCustomerIds,
  collectRecognizedInvoiceCustomerIds,
  type RecognizedInvoiceCustomerRow,
} from './recognizedInvoiceCustomers';

describe('collectRecognizedInvoiceCustomerIds', () => {
  it('paginates beyond the API row cap and deduplicates non-null customers', async () => {
    const firstPage: RecognizedInvoiceCustomerRow[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `invoice-${index}`,
      customer_id: index === 999 ? null : `customer-${index % 3}`,
    }));
    const fetchPage = vi.fn(async (from: number) => {
      if (from === 0) return firstPage;
      if (from === 1000) return [
            { id: 'invoice-1000', customer_id: 'customer-3' },
            { id: 'invoice-1001', customer_id: 'customer-1' },
      ];
      return [];
    });

    await expect(collectRecognizedInvoiceCustomerIds(fetchPage)).resolves.toEqual([
      'customer-0',
      'customer-1',
      'customer-2',
      'customer-3',
    ]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 999);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 1000, 1999);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 1002, 2001);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('advances by the server-returned row count when its cap is below 1000', async () => {
    const fetchPage = vi.fn(async (from: number) => {
      if (from === 0) return [
        { id: 'invoice-0', customer_id: 'customer-0' },
        { id: 'invoice-1', customer_id: 'customer-1' },
      ];
      if (from === 2) return [{ id: 'invoice-2', customer_id: 'customer-2' }];
      return [];
    });

    await expect(collectRecognizedInvoiceCustomerIds(fetchPage)).resolves.toEqual([
      'customer-0', 'customer-1', 'customer-2',
    ]);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 1001);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 3, 1002);
  });

  it('chunks large assignment filters and pages every chunk without URL or row-cap loss', async () => {
    const customerIds = Array.from({ length: 205 }, (_, index) => `customer-${index}`);
    const fetchPage = vi.fn(async (chunk: string[], from: number) => {
      if (from > 0) return [];
      return chunk.filter((id) => Number(id.split('-')[1]) % 2 === 0);
    });

    const assigned = await collectAssignedCustomerIds(customerIds, fetchPage);
    expect(assigned).toHaveLength(103);
    expect(assigned).toContain('customer-0');
    expect(assigned).toContain('customer-204');
    expect(fetchPage.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 100, 100, 5, 5]);
  });
});
