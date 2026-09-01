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
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';

import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { IDBFactory } from 'fake-indexeddb';

const BILL_ID = '11111111-1111-4111-8111-111111111111';
const COMMITTED_PAYMENT_ID = '22222222-2222-4222-8222-222222222222';

const H = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: vi.fn(),
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
    assertRpcResult: (data: unknown) => data,
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
  Sentry: new Proxy({}, { get: () => () => undefined }),
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
  });

  afterEach(() => {
    cleanup();
  });

  it('still refreshes and warns when durable-intent bookkeeping fails on a committed payment', async () => {
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
        'The earlier payment already completed. The bill has been refreshed instead of recording a duplicate.',
      );
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/Payment Amount/)).toBeNull();
    });
    expect(H.rpc).toHaveBeenCalledTimes(1);
    expect(H.rpc.mock.calls[0][0]).toBe('record_vendor_payment');
    // Exact whole cents reached the RPC — no floating-point dollars.
    expect((H.rpc.mock.calls[0][1] as { p_amount_cents: number }).p_amount_cents).toBe(10_000);
  });
});
