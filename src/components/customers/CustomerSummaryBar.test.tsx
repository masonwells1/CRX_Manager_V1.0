import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CustomerSummaryBar from './CustomerSummaryBar';

const mockRpc = vi.fn();

vi.mock('../../lib/db', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
  assertRpcResult: vi.fn((data: unknown) => data),
}));

describe('CustomerSummaryBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading skeleton initially', () => {
    mockRpc.mockReturnValue(new Promise(() => {})); // never resolves
    render(<CustomerSummaryBar customerId="abc-123" />);
    // Should have 5 skeleton cards with animate-pulse
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBe(5);
  });

  it('renders 5 KPI cards with data', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ar_balance_cents: 250000,
        order_count: 12,
        delivery_count: 8,
        credit_tier: 1,
        last_activity: new Date().toISOString(),
      },
      error: null,
    });

    render(<CustomerSummaryBar customerId="abc-123" />);

    await waitFor(() => {
      expect(screen.getByText('$2,500.00')).toBeInTheDocument();
    });
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('Tier 1')).toBeInTheDocument();
  });

  it('renders nothing on error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'fail' } });

    const { container } = render(<CustomerSummaryBar customerId="abc-123" />);

    await waitFor(() => {
      const skeletons = container.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBe(0);
    });
  });

  it('calls RPC with correct customer ID', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ar_balance_cents: 0,
        order_count: 0,
        delivery_count: 0,
        credit_tier: 2,
        last_activity: null,
      },
      error: null,
    });

    render(<CustomerSummaryBar customerId="test-uuid" />);

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('get_customer_summary', {
        p_customer_id: 'test-uuid',
      });
    });
  });
});
