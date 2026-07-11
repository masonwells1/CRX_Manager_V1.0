import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockRpc } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('./db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) throw new Error(`${rpcName} returned no data`);
    return data as T;
  },
}));

vi.mock('./jobMapImages', () => ({ fetchJobMapImages: vi.fn() }));

import { fetchApplicatorSheetBillingSplits } from './applicatorSheetPrintData';

describe('fetchApplicatorSheetBillingSplits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits billing splits when saved job shares cannot be read', async () => {
    mockRpc.mockResolvedValue({
      data: [{ customer_id: 'customer-1', farm_name: 'North Farm', account_number: null, is_primary: true }],
      error: null,
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'job_fields') {
        return { select: () => ({ eq: () => ({ data: [{ field_id: 'field-1', acres_to_treat: 40 }], error: null }) }) };
      }
      if (table === 'job_field_shares') {
        return { select: () => ({ eq: () => ({ data: null, error: { message: 'permission denied for table job_field_shares' } }) }) };
      }
      if (table === 'customers') {
        return { select: () => ({ in: () => ({ data: [{ id: 'customer-1', phone: '555-0100' }], error: null }) }) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(fetchApplicatorSheetBillingSplits('job-1', 40)).resolves.toEqual([]);
    expect(mockFrom).not.toHaveBeenCalledWith('field_billing_defaults');
  });
});
