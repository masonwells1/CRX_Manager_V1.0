import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockAuth } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockAuth: {
    role: 'admin',
    profile: { id: 'admin-1', role: 'admin', full_name: 'Test Admin' },
    deniedPages: [] as string[],
  },
}));

function resolvedChain(data: unknown[] = []): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const returnSelf = () => chain;
  for (const method of ['select', 'eq', 'order', 'limit']) chain[method] = returnSelf;
  const result = Promise.resolve({ data, error: null });
  chain.then = result.then.bind(result);
  chain.catch = result.catch.bind(result);
  chain.finally = result.finally.bind(result);
  return chain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: vi.fn((data) => data),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import Reports from './Reports';

const reportRows = {
  customer: [{
    group_key: 'Acme Farm',
    total_revenue: 1200,
    total_cost: 700,
    total_profit: 500,
    margin_pct: 41.7,
    order_count: 2,
    units_sold: 10,
  }],
  product: [{
    group_key: 'Product A',
    total_revenue: 900,
    total_cost: 600,
    total_profit: 300,
    margin_pct: 33.3,
    order_count: 3,
    units_sold: 42,
  }],
  month: [{
    group_key: '2026-08',
    total_revenue: 2100,
    total_cost: 1300,
    total_profit: 800,
    margin_pct: 38.1,
    order_count: 5,
    units_sold: 52,
  }],
};

describe('Reports profitability database authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue(resolvedChain());
    mockRpc.mockImplementation(async (name: string, args: { p_group_by?: string }) => {
      if (name !== 'get_profitability_report') return { data: [], error: null };
      return {
        data: reportRows[args.p_group_by as keyof typeof reportRows] ?? [],
        error: null,
      };
    });
  });

  it('loads each profitability view from the canonical report RPC', async () => {
    render(<MemoryRouter><Reports /></MemoryRouter>);

    await screen.findByText('Acme Farm');
    expect(mockRpc).toHaveBeenCalledWith('get_profitability_report', {
      p_group_by: 'customer',
      p_start_date: undefined,
      p_end_date: undefined,
    });

    fireEvent.click(screen.getByRole('button', { name: 'By Product' }));
    await screen.findByText('Product A');
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(
      'get_profitability_report',
      expect.objectContaining({ p_group_by: 'product' }),
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Revenue Summary' }));
    await screen.findByText('2026-08');
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(
      'get_profitability_report',
      expect.objectContaining({ p_group_by: 'month' }),
    ));
  });
});
