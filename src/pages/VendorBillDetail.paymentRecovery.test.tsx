/**
 * VendorBillDetail.paymentRecovery.test.tsx
 *
 * Pins the recovery path of `handleRecordPayment` for a payment that PROVABLY
 * COMMITTED. `record_vendor_payment` answers a replayed key with
 * IDEMPOTENCY_INTENT_MISMATCH carrying the committed receipt, and the page then
 * calls `paymentIntent.resolveIntent()` — which reaches IndexedDB through
 * `openDurableIntentDb()` and can reject with
 * DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE (private window, blocked
 * connection, quota failure).
 *
 * Before the fix that await was unguarded and `setPaying(false)` sat after the
 * try/catch, so a rejection there skipped the toast, skipped the refresh, and
 * left the modal spinning forever on a payment the vendor had already been
 * paid. It never permitted a double payment — the key stays locked — so this is
 * an availability defect on the AP money path, not a duplication one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';

import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { IDBFactory } from 'fake-indexeddb';

const BILL_ID = '11111111-1111-4111-8111-111111111111';
const COMMITTED_PAYMENT_ID = '22222222-2222-4222-8222-222222222222';

const H = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
}));

const bill = {
  id: BILL_ID,
  vendor_id: 'vendor-1',
  purchase_order_id: null,
  bill_number: 'VB-1001',
  bill_date: '2026-08-01',
  due_date: '2026-08-31',
  payment_terms: 'net_30',
  subtotal_cents: 10_000,
  adjustment_cents: 0,
  total_cents: 10_000,
  paid_cents: 0,
  balance_cents: 10_000,
  status: 'unpaid',
  notes: null,
  vendor: { name: 'Acme Supply' },
  purchase_order: null,
};

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const builder = (table: string) => {
    const result = table === 'vendor_bills'
      ? { data: bill, error: null }
      : { data: [], error: null };
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop: string | symbol) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result);
        if (typeof prop === 'symbol') return undefined;
        return () => proxy;
      },
      apply() { return proxy; },
    });
    return proxy;
  };
  return {
    ...actual,
    supabase: {
      from: (table: string) => builder(table),
      rpc: (...args: unknown[]) => H.rpc(...args),
    },
    checkMutationResult: vi.fn(),
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'admin-user', full_name: 'AP Admin', role: 'admin', is_active: true },
    session: { user: { id: 'admin-user' } },
    user: { id: 'admin-user' },
    loading: false,
    signOut: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const STABLE_TOAST_CONTEXT = { toast: H.toast };
vi.mock('../components/ui/Toast', () => ({
  useToast: () => STABLE_TOAST_CONTEXT,
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../lib/sentry', () => ({
  Sentry: new Proxy({}, { get: (_target, prop) => prop === 'captureException' ? H.captureException : () => undefined }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));

const { default: VendorBillDetail } = await import('./VendorBillDetail');

const idempotencyMismatchError = {
  code: 'P0001',
  message: 'IDEMPOTENCY_INTENT_MISMATCH',
  details: JSON.stringify({
    operation: 'record_vendor_payment',
    result: { payment_id: COMMITTED_PAYMENT_ID },
  }),
};

describe('VendorBillDetail record-payment recovery', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    H.rpc.mockReset();
    H.toast.mockReset();
    H.captureException.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps a confirmed payment frozen and retryable through reopening and cleanup recovery', async () => {
    const removeItem = Storage.prototype.removeItem;
    const cleanupSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (this === window.sessionStorage && key.startsWith('crx:uncertain-mutation-ack:v1:')) {
        throw new Error('Acknowledgment cleanup blocked');
      }
      return removeItem.call(this, key);
    });
    H.rpc.mockResolvedValue({ data: COMMITTED_PAYMENT_ID, error: null });
    render(
      <MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_ID}`]}>
        <Routes><Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    const buttons = await screen.findAllByRole('button', { name: 'Record Payment' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('warning', expect.stringContaining('payment was recorded once')));
    expect(H.toast.mock.calls.filter(([kind]) => kind === 'success')).toEqual([]);
    expect(H.captureException).toHaveBeenCalled();
    expect(screen.getByLabelText(/Payment Amount/)).toHaveValue(100);
    expect(screen.getByLabelText(/Payment Amount/)).toBeDisabled();
    expect(screen.getByText(/this payment was recorded once/i)).toBeInTheDocument();
    const frozenDialog = screen.getByRole('dialog', { name: 'Record Payment' });
    expect(within(frozenDialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(frozenDialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(H.toast.mock.calls.filter(([kind]) => kind === 'error')).toEqual([]);
    expect(H.rpc).toHaveBeenCalledTimes(1);
    const args = H.rpc.mock.calls[0][1] as { p_amount_cents: number; p_idempotency_key: string };
    expect(args.p_amount_cents).toBe(10_000);
    const acknowledgmentKey = Object.keys(window.sessionStorage).find((key) => key.startsWith('crx:uncertain-mutation-ack:v1:'));
    expect(acknowledgmentKey).toBeDefined();
    expect(window.sessionStorage.getItem(acknowledgmentKey!)).toContain(args.p_idempotency_key);
    fireEvent.click(screen.getByRole('button', { name: 'Record Payment' }));
    expect(screen.getByLabelText(/Payment Amount/)).toHaveValue(100);
    const setItem = Storage.prototype.setItem;
    const preparationSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === window.localStorage && key.startsWith('crx:uncertain-mutation:v4:') && key.includes('record_vendor_payment')) throw new Error('Retry preparation storage unavailable');
      return setItem.call(this, key, value);
    });
    fireEvent.click(screen.getByRole('button', { name: /retry exact payment/i }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('This payment was already recorded once.')));
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Do not record this payment again on another device.'));
    expect(H.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/this payment was recorded once/i)).toBeInTheDocument();
    expect(window.sessionStorage.getItem(acknowledgmentKey!)).toContain(args.p_idempotency_key);
    preparationSpy.mockRestore();
    cleanupSpy.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: /retry exact payment/i }));
    await waitFor(() => expect(screen.queryByLabelText(/Payment Amount/)).toBeNull());
    expect(H.rpc).toHaveBeenCalledTimes(2);
    expect(H.rpc.mock.calls[1][1]).toEqual(args);
  });

  it.each(['Cancel', 'Close'])('allows %s on a foreign payment lock and preserves the saved payment key', async (control) => {
    H.rpc.mockResolvedValue({ data: null, error: { code: 'ETIMEDOUT', message: 'socket timeout' } });
    const initial = render(<MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_ID}`]}><Routes><Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Record Payment' })).getByRole('button', { name: 'Record Payment' }));
    await screen.findByRole('button', { name: /retry exact payment/i });
    // Wait for classification and its durable write before simulating another tab.
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('warning', expect.stringContaining('payment may already be recorded')));
    const sharedKey = `crx:uncertain-mutation:v4:${JSON.stringify(['record_vendor_payment', 'admin-user'])}`;
    const saved = window.localStorage.getItem(sharedKey);
    expect(saved).not.toBeNull();
    initial.unmount();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    const peerRecord = { ...JSON.parse(saved!), surface: 'other-payment-page', claimTabIds: ['another-tab'] };
    window.localStorage.setItem(sharedKey, JSON.stringify(peerRecord));
    render(<MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_ID}`]}><Routes><Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} /></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));
    const dialog = screen.getByRole('dialog', { name: 'Record Payment' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /retry exact payment/i })).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: control })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: control }));
    expect(screen.queryByRole('dialog', { name: 'Record Payment' })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(sharedKey)!)).toEqual(peerRecord);
    expect(H.rpc).toHaveBeenCalledTimes(1);
  });

  it('refreshes and preserves the frozen form when bookkeeping fails on a recovered committed payment', async () => {
    // The server answers with the committed receipt, and durable storage dies in
    // the same moment — exactly the ordering that stranded the modal.
    H.rpc.mockImplementation(() => {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        writable: true,
        value: undefined,
      });
      return Promise.resolve({ data: null, error: idempotencyMismatchError });
    });


    render(
      <MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_ID}`]}>
        <Routes>
          <Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('button', { name: 'Record Payment' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record Payment' })); });

    const submitButtons = await screen.findAllByRole('button', { name: 'Record Payment' });
    const submit = submitButtons[submitButtons.length - 1];
    await act(async () => { fireEvent.click(submit); });

    // The operator must be told the payment already completed, and the modal
    // must close instead of spinning on a payment the vendor already received.
    await waitFor(() => {
      expect(H.toast).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('earlier payment was recorded once'),
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Payment Amount/)).toHaveValue(100);
    });
    expect(H.rpc).toHaveBeenCalledTimes(1);
    expect(H.rpc.mock.calls[0][0]).toBe('record_vendor_payment');
    expect(H.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { source: 'durable-intent-resolve', page: 'vendor-bill-detail', operation: 'record_vendor_payment' } }));
    // Exact whole cents reached the RPC — no floating-point dollars.
    expect((H.rpc.mock.calls[0][1] as { p_amount_cents: number }).p_amount_cents).toBe(10_000);
  });
});
