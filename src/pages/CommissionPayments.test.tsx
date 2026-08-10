import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockCaptureException, mockResetKey, mockLogActivity } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockCaptureException: vi.fn(),
  mockResetKey: vi.fn(),
  mockLogActivity: vi.fn(),
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

// Delegates to the REAL hook and only observes resetKey. A stub returning a
// constant key would make the retry tests below vacuous: they exist to prove the
// page hands the SAME key to a retry of the same payment, which is only a real
// assertion if the key actually comes from the hook.
vi.mock('../hooks/useIdempotencyKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useIdempotencyKey')>();
  return {
    useIdempotencyKey: (operation: string, userId: string, target = '') => {
      const real = actual.useIdempotencyKey(operation, userId, target);
      return {
        getKey: real.getKey,
        resetKey: () => { mockResetKey(); real.resetKey(); },
      };
    },
  };
});

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: mockCaptureException },
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: mockLogActivity }));

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
    // Exactly once, from the refusal handler. The Post button must NOT reset:
    // that would discard the key a retry of this same payment needs.
    expect(mockResetKey).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('explains a wrong-actor refusal in plain English and reports it to Sentry', async () => {
    const warning = await postAndCaptureRefusal('IDEMPOTENCY_ACTOR_MISMATCH');

    expect(warning).toContain('belongs to another user');
    expect(warning).not.toContain('IDEMPOTENCY');
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
    expect(mockResetKey).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: expect.objectContaining({ context: 'post_commission_payment_actor_mismatch' }),
      }),
    );
  });

  it('still surfaces an unrelated failure as an error, without claiming nothing happened', async () => {
    // Round-5 review finding: a failed RESPONSE is not proof of a failed POST.
    // The request may have committed and the reply been lost, so telling the
    // admin a flat "Failed to post" invites them to treat a posted payment as
    // unposted. The message has to admit the uncertainty and say the retry is
    // safe — the key is retained precisely so pressing Post again replays it.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Admin access required to post a commission payment' } });
    render(<CommissionPayments />);

    const row = (await screen.findByText('CP-0001')).closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Payments' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Failed to post'));
    });
    const message = mockToast.mock.calls.find((call) => call[0] === 'error')![1] as string;
    expect(message).toContain('may still have been posted');
    expect(message).toContain('Check the payment list below');
    expect(message).toContain('safe');
  });

  it('does not report a posting as done when the payment has since been voided', async () => {
    // Round-5 review finding, post side. A retained key does not re-post on a
    // retry — it replays the ORIGINAL outcome. If the first attempt committed,
    // its reply was lost, and another admin voided the payment in between, this
    // "success" describes a payment that no longer holds its commissions.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'commission_payments') {
        const self: Record<string, unknown> = {};
        const method = (..._args: unknown[]) => self;
        for (const name of ['select', 'eq', 'in', 'order', 'limit']) self[name] = method;
        // The post handler's re-read of the row it just posted.
        self.maybeSingle = () => Promise.resolve({ data: { status: 'voided' }, error: null });
        const list = Promise.resolve({
          data: [{ ...paymentBase, id: 'payment-1', payment_number: 'CP-0001' }],
          error: null,
        });
        self.then = list.then.bind(list);
        self.catch = list.catch.bind(list);
        self.finally = list.finally.bind(list);
        return self;
      }
      if (table === 'profile_public_view') {
        return buildChain({ data: [{ id: 'recipient-1', full_name: 'Test Recipient' }], error: null });
      }
      if (table === 'commission_payment_items') {
        return buildChain({ count: 2, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: { success: true, payment_id: 'payment-1' }, error: null });
    render(<CommissionPayments />);

    const row = (await screen.findByText('CP-0001')).closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Payments' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('warning', expect.any(String));
    });
    const message = mockToast.mock.calls.find((call) => call[0] === 'warning')![1] as string;
    expect(message).toContain('has since been voided');
    expect(message).toContain('still unpaid');
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
    // And nothing may record a posting this click did not actually leave standing.
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

// Round-4 review finding: posting closes its own confirmation dialog before the
// RPC answers, so every retry after an uncertain response goes back through the
// row button. The button used to reset the key there, which meant the retry
// arrived as a brand-new request the server refused as already posted — real
// committed work reported to the admin as a failure.
describe('CommissionPayments uncertain-response retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'commission_payments') {
        return buildChain({
          data: [
            { ...paymentBase, id: 'payment-1', payment_number: 'CP-0001' },
            { ...paymentBase, id: 'payment-2', payment_number: 'CP-0002' },
          ],
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

  async function clickPost(paymentNumber: string) {
    const row = (await screen.findByText(paymentNumber)).closest('tr');
    fireEvent.click(within(row!).getByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Payments' }));
  }

  const postKeys = () =>
    mockRpc.mock.calls
      .filter((call) => call[0] === 'post_commission_payment')
      .map((call) => (call[1] as { p_idempotency_key: string }).p_idempotency_key);

  it('retries the SAME payment with the SAME key after a timeout', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await clickPost('CP-0001');
    await waitFor(() => expect(postKeys()).toHaveLength(1));
    await clickPost('CP-0001');
    await waitFor(() => expect(postKeys()).toHaveLength(2));

    const [first, second] = postKeys();
    expect(first).toBeTruthy();
    // The whole point: identical key, so the server can replay the original
    // outcome instead of refusing a request it has already carried out.
    expect(second).toBe(first);
    expect(mockResetKey).not.toHaveBeenCalled();
  });

  it('still mints a fresh key when the admin posts a DIFFERENT payment', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await clickPost('CP-0001');
    await waitFor(() => expect(postKeys()).toHaveLength(1));
    await clickPost('CP-0002');
    await waitFor(() => expect(postKeys()).toHaveLength(2));

    const [first, second] = postKeys();
    expect(second).not.toBe(first);
  });

  it('replays the first payment\'s key when the admin comes BACK to it', async () => {
    // The A -> B -> A round trip. One retained key looks identical to per-target
    // keys on the two tests above and only diverges here — the moment the admin
    // returns to the payment whose outcome they are unsure about. A third key
    // for CP-0001 makes the server treat an already-posted payment as new work.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await clickPost('CP-0001');
    await waitFor(() => expect(postKeys()).toHaveLength(1));
    await clickPost('CP-0002');
    await waitFor(() => expect(postKeys()).toHaveLength(2));
    await clickPost('CP-0001');
    await waitFor(() => expect(postKeys()).toHaveLength(3));

    const [first, second, third] = postKeys();
    expect(second).not.toBe(first);
    expect(third).toBe(first);
  });

  async function clickVoid(paymentNumber: string) {
    // A failed void leaves its modal open, and that modal also prints the
    // payment number — so back out of it first, both to keep the row lookup
    // unambiguous and because backing out and returning is what an admin
    // actually does when they are unsure whether the void landed.
    const goBack = screen.queryByRole('button', { name: 'Go Back' });
    if (goBack) fireEvent.click(goBack);
    await screen.findByText(paymentNumber);
    const row = screen.getAllByText(paymentNumber).map((el) => el.closest('tr')).find(Boolean);
    fireEvent.click(within(row!).getByRole('button', { name: 'Void' }));
    const reason = await screen.findByPlaceholderText(/Enter reason for voiding/);
    fireEvent.change(reason, { target: { value: 'entered in error' } });
    fireEvent.click(screen.getByRole('button', { name: 'Void Payment' }));
  }

  const voidKeys = () =>
    mockRpc.mock.calls
      .filter((call) => call[0] === 'void_commission_payment')
      .map((call) => (call[1] as { p_idempotency_key: string }).p_idempotency_key);

  it('voids the same payment with the same key and switches keys per payment', async () => {
    // Void closes its own modal before the RPC answers, exactly like post, so a
    // retry after an uncertain response also comes back through the row button.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await clickVoid('CP-0001');
    await waitFor(() => expect(voidKeys()).toHaveLength(1));
    await clickVoid('CP-0001');
    await waitFor(() => expect(voidKeys()).toHaveLength(2));
    await clickVoid('CP-0002');
    await waitFor(() => expect(voidKeys()).toHaveLength(3));
    await clickVoid('CP-0001');
    await waitFor(() => expect(voidKeys()).toHaveLength(4));

    const [first, retry, other, back] = voidKeys();
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
    expect(back).toBe(first);
  });
});

describe('CommissionPayments create-payment key scoping', () => {
  const commissionBase = {
    order_id: null,
    job_id: null,
    customer_id: null,
    order_date: '2026-07-01',
    recipient_user_id: 'recipient-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'commission_payments') {
        return buildChain({ data: [], error: null });
      }
      if (table === 'commissions') {
        return buildChain({
          data: [
            { ...commissionBase, id: 'commission-a', commission_amount: 100 },
            { ...commissionBase, id: 'commission-b', commission_amount: 200 },
          ],
          error: null,
        });
      }
      if (table === 'profile_public_view') {
        return buildChain({ data: [{ id: 'recipient-1', full_name: 'Test Recipient' }], error: null });
      }
      return buildChain({ data: [], error: null, count: 0 });
    });
  });

  const createKeys = () =>
    mockRpc.mock.calls
      .filter((call) => call[0] === 'create_commission_payment')
      .map((call) => (call[1] as { p_idempotency_key: string }).p_idempotency_key);

  async function openDialogAndSelect(indexes: number[]) {
    fireEvent.click(screen.getByRole('button', { name: /New Payment/ }));
    const recipient = await screen.findByRole('combobox');
    fireEvent.change(recipient, { target: { value: 'recipient-1' } });
    const boxes = await screen.findAllByRole('checkbox');
    for (const i of indexes) fireEvent.click(boxes[i]);
    fireEvent.click(screen.getByRole('button', { name: /Create Payment/ }));
  }

  it('replays the same key when the dialog is reopened on the SAME commissions', async () => {
    // openCreate used to call resetKey(). An admin whose create timed out, who
    // closed the dialog to check the list and then reopened it, lost the only
    // key that could replay the uncertain request — so the retry was a brand-new
    // payment and could pay the same commissions twice.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await openDialogAndSelect([0]);
    await waitFor(() => expect(createKeys()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await openDialogAndSelect([0]);
    await waitFor(() => expect(createKeys()).toHaveLength(2));

    const [first, retry] = createKeys();
    expect(first).toBeTruthy();
    expect(retry).toBe(first);
  });

  it('treats the same commissions picked in a different ORDER as the same request', async () => {
    // The scope is sorted for the same reason the server fingerprint is: ticking
    // two boxes bottom-up is the same payment as ticking them top-down, and an
    // unsorted scope would mint a second key for it and pay them twice.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await openDialogAndSelect([0, 1]);
    await waitFor(() => expect(createKeys()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await openDialogAndSelect([1, 0]);
    await waitFor(() => expect(createKeys()).toHaveLength(2));

    const [first, retry] = createKeys();
    expect(retry).toBe(first);
  });

  it('does not report success when the replayed payment has since been voided', async () => {
    // The uncertain-response case taken to its end: the first attempt committed,
    // its response was lost, someone voided the payment, and this attempt replays
    // the ORIGINAL receipt. The RPC "succeeds" and hands back a payment id that
    // no longer holds the commissions.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'commission_payments') {
        const self: Record<string, unknown> = {};
        const method = (..._args: unknown[]) => self;
        for (const name of ['select', 'eq', 'in', 'order', 'limit']) self[name] = method;
        self.maybeSingle = () => Promise.resolve({
          data: { payment_number: 'CP-9001', total_amount: 100, status: 'voided' },
          error: null,
        });
        const list = Promise.resolve({ data: [], error: null });
        self.then = list.then.bind(list);
        self.catch = list.catch.bind(list);
        self.finally = list.finally.bind(list);
        return self;
      }
      if (table === 'commissions') {
        return buildChain({
          data: [{ ...commissionBase, id: 'commission-a', commission_amount: 100 }],
          error: null,
        });
      }
      if (table === 'profile_public_view') {
        return buildChain({ data: [{ id: 'recipient-1', full_name: 'Test Recipient' }], error: null });
      }
      return buildChain({ data: [], error: null, count: 1 });
    });
    mockRpc.mockResolvedValue({ data: 'payment-voided', error: null });
    render(<CommissionPayments />);

    await openDialogAndSelect([0]);

    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const [level, message] = mockToast.mock.calls[mockToast.mock.calls.length - 1];
    expect(level).toBe('warning');
    expect(message).toContain('has since been voided');
    expect(message).toContain('still unpaid');
    // And nothing may record a creation that this click did not perform.
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it('mints a fresh key when the selected commissions change', async () => {
    // The other half of what the removed reset was doing: a genuinely different
    // payment must not be swallowed as a replay of the first one.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await openDialogAndSelect([0]);
    await waitFor(() => expect(createKeys()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await openDialogAndSelect([1]);
    await waitFor(() => expect(createKeys()).toHaveLength(2));

    const [first, second] = createKeys();
    expect(second).not.toBe(first);
  });

  it('mints a fresh key when a payment DETAIL changes on the same commissions', async () => {
    // The commissions are only half of what makes a payment. Correcting the
    // check number (or the method, date or note) and pressing Create again is a
    // different payment, and if the key did not move with those fields the
    // server would replay the first receipt and hand back the payment carrying
    // the WRONG check number — silently, as a success.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Network request timed out' } });
    render(<CommissionPayments />);

    await openDialogAndSelect([0]);
    await waitFor(() => expect(createKeys()).toHaveLength(1));

    fireEvent.change(screen.getByPlaceholderText('Check #, transaction ID...'), {
      target: { value: 'CHK-1042' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Payment/ }));
    await waitFor(() => expect(createKeys()).toHaveLength(2));

    const [first, second] = createKeys();
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
