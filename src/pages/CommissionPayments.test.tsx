import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const { mockFrom, mockToast, mockCaptureException } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockCaptureException: vi.fn(),
}));

function buildChain(result: { data?: unknown; error?: unknown; count?: number | null }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const name of ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle']) {
    self[name] = method;
  }
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: vi.fn() },
  assertRpcResult: vi.fn((data) => data),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'admin-1', role: 'admin', full_name: 'Test Admin' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-key', resetKey: vi.fn() }),
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: mockCaptureException },
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import CommissionPayments from './CommissionPayments';

const paymentBase = {
  recipient_id: 'recipient-1',
  recipient_name: 'Test Recipient',
  total_amount: 100,
  status: 'unposted',
  payment_method: 'check',
  reference_number: null,
  payment_date: '2026-07-14',
  posted_at: null,
  notes: null,
  created_at: '2026-07-14T12:00:00.000Z',
};

describe('CommissionPayments item-count verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let itemCountCall = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'commission_payments') {
        return buildChain({
          data: [
            { ...paymentBase, id: 'payment-unverified', payment_number: 'CP-UNVERIFIED' },
            { ...paymentBase, id: 'payment-valid', payment_number: 'CP-VALID' },
          ],
          error: null,
        });
      }
      if (table === 'profile_public_view') {
        return buildChain({ data: [{ id: 'recipient-1', full_name: 'Test Recipient' }], error: null });
      }
      if (table === 'commission_payment_items') {
        itemCountCall += 1;
        return itemCountCall === 1
          ? buildChain({ count: null, error: { message: 'count query failed' } })
          : buildChain({ count: 2, error: null });
      }
      return buildChain({ data: [], error: null });
    });
  });

  it('keeps all rows visible and disables Post only for the unverified count', async () => {
    render(<CommissionPayments />);

    const unverifiedPayment = await screen.findByText('CP-UNVERIFIED');
    const validPayment = await screen.findByText('CP-VALID');
    const unverifiedRow = unverifiedPayment.closest('tr');
    const validRow = validPayment.closest('tr');

    expect(unverifiedRow).not.toBeNull();
    expect(validRow).not.toBeNull();
    expect(within(unverifiedRow!).getByText('Count unavailable')).toBeInTheDocument();
    expect(within(unverifiedRow!).getByRole('button', { name: 'Post' })).toBeDisabled();
    expect(within(validRow!).getByText('2 commission(s)')).toBeInTheDocument();
    expect(within(validRow!).getByRole('button', { name: 'Post' })).toBeEnabled();

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        'Some commission payment item counts could not be verified. Posting is disabled for those rows.',
      );
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'count query failed' }),
      expect.objectContaining({
        extra: expect.objectContaining({
          context: 'load_commission_payment_item_count',
          paymentId: 'payment-unverified',
        }),
      }),
    );
  });
});
