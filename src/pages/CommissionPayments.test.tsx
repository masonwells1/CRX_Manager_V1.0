import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockCaptureException, mockResetKey } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockCaptureException: vi.fn(),
  mockResetKey: vi.fn(),
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
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: vi.fn((data) => data),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'admin-1', role: 'admin', full_name: 'Test Admin' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-key', resetKey: mockResetKey }),
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

// Section 07 gauntlet finding 2: the retained retry key is now bound to one
// actor and one exact request server-side. The page must translate both
// refusals into plain English instead of surfacing the raw database code, and
// must retire the key so the admin is not stuck retrying a dead ticket.
describe('CommissionPayments idempotency intent-binding refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'commission_payments') {
        return buildChain({
          data: [{ ...paymentBase, id: 'payment-1', payment_number: 'CP-0001' }],
          error: null,
        });
      }
      if (table === 'profile_public_view') {
        return buildChain({ data: [{ id: 'recipient-1', full_name: 'Test Recipient' }], error: null });
      }
      if (table === 'commission_payment_items') {
        return buildChain({ count: 2, error: null });
      }
      return buildChain({ data: [], error: null });
    });
  });

  async function postAndCaptureRefusal(message: string) {
    mockRpc.mockResolvedValue({ data: null, error: { message } });
    render(<CommissionPayments />);

    const row = (await screen.findByText('CP-0001')).closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Payments' }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('post_commission_payment', expect.objectContaining({
        p_payment_id: 'payment-1',
      }));
    });
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('warning', expect.any(String));
    });
    return mockToast.mock.calls.find((call) => call[0] === 'warning')![1] as string;
  }

  it('explains a changed-intent refusal in plain English and retires the key', async () => {
    const warning = await postAndCaptureRefusal('IDEMPOTENCY_INTENT_MISMATCH');

    expect(warning).toContain('nothing was posted now');
    expect(warning).not.toContain('IDEMPOTENCY');
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
    // resetKey also fires when the Post button is pressed, so require the
    // additional reset from the refusal handler itself.
    expect(mockResetKey.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('explains a wrong-actor refusal in plain English and reports it to Sentry', async () => {
    const warning = await postAndCaptureRefusal('IDEMPOTENCY_ACTOR_MISMATCH');

    expect(warning).toContain('belongs to another user');
    expect(warning).not.toContain('IDEMPOTENCY');
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
    expect(mockResetKey.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: expect.objectContaining({ context: 'post_commission_payment_actor_mismatch' }),
      }),
    );
  });

  it('still surfaces an unrelated failure as an error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Admin access required to post a commission payment' } });
    render(<CommissionPayments />);

    const row = (await screen.findByText('CP-0001')).closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Payments' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'Failed to post');
    });
  });
});
