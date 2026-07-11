import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNotifyCreditLimitExceeded, mockRpc } = vi.hoisted(() => ({
  mockNotifyCreditLimitExceeded: vi.fn(),
  mockRpc: vi.fn(),
}));

vi.mock('./db', () => ({
  supabase: { rpc: mockRpc },
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data`);
    }
    return data;
  },
}));

vi.mock('./notificationTriggers', () => ({
  notifyCreditLimitExceeded: mockNotifyCreditLimitExceeded,
}));

import { warnIfOverCreditLimit } from './creditLimit';

describe('warnIfOverCreditLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyCreditLimitExceeded.mockResolvedValue(undefined);
  });

  it('warns and notifies when the credit limit is exceeded', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        exceeded: true,
        farm_name: 'Sample Farm',
        outstanding_ar: 125000,
        credit_limit: 100000,
      },
      error: null,
    });
    const toast = vi.fn();

    await warnIfOverCreditLimit('customer-1', toast);

    expect(mockRpc).toHaveBeenCalledWith('check_customer_credit_limit', {
      p_customer_id: 'customer-1',
    });
    expect(toast).toHaveBeenCalledWith(
      'warning',
      'Credit limit warning: Sample Farm outstanding AR $125,000 exceeds limit $100,000'
    );
    expect(mockNotifyCreditLimitExceeded).toHaveBeenCalledWith(
      'Sample Farm',
      125000,
      100000,
      'customer-1'
    );
  });

  it('stays silent when the credit limit is not exceeded', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        exceeded: false,
        farm_name: 'Sample Farm',
        outstanding_ar: 50000,
        credit_limit: 100000,
      },
      error: null,
    });
    const toast = vi.fn();

    await warnIfOverCreditLimit('customer-1', toast);

    expect(toast).not.toHaveBeenCalled();
    expect(mockNotifyCreditLimitExceeded).not.toHaveBeenCalled();
  });

  it('swallows an RPC error without throwing', async () => {
    mockRpc.mockRejectedValueOnce(new Error('RPC unavailable'));

    await expect(warnIfOverCreditLimit('customer-1', vi.fn())).resolves.toBeUndefined();
    expect(mockNotifyCreditLimitExceeded).not.toHaveBeenCalled();
  });

  it('returns immediately for an empty customer id', async () => {
    await expect(warnIfOverCreditLimit('', vi.fn())).resolves.toBeUndefined();

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockNotifyCreditLimitExceeded).not.toHaveBeenCalled();
  });
});
