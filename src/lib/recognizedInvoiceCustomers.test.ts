import { describe, expect, it, vi } from 'vitest';
import {
  collectRecognizedInvoiceCustomerIds,
  type RecognizedInvoiceCustomerRow,
} from './recognizedInvoiceCustomers';

describe('collectRecognizedInvoiceCustomerIds', () => {
  it('paginates beyond the API row cap and deduplicates non-null customers', async () => {
    const firstPage: RecognizedInvoiceCustomerRow[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `invoice-${index}`,
      customer_id: index === 999 ? null : `customer-${index % 3}`,
    }));
    const fetchPage = vi.fn(async (from: number) => (
      from === 0
        ? firstPage
        : [
            { id: 'invoice-1000', customer_id: 'customer-3' },
            { id: 'invoice-1001', customer_id: 'customer-1' },
          ]
    ));

    await expect(collectRecognizedInvoiceCustomerIds(fetchPage)).resolves.toEqual([
      'customer-0',
      'customer-1',
      'customer-2',
      'customer-3',
    ]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 999);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 1000, 1999);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
