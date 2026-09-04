/**
 * VendorBillDetail.routeReset.test.tsx
 *
 * Drives the REAL page through a route change with the PO-overage confirmation
 * prompt open.
 *
 * `VendorBillDetail` stays MOUNTED across `/accounts-payable/bills/:id` changes,
 * so the `[id]` effect is the only thing that retires per-bill form state. That
 * effect cleared every other edit field but not `editOverageMessage`, and
 * `ReasonModal` opens solely on that value — so navigating to another bill kept
 * the previous bill's overage prompt on screen while the edit state behind it had
 * already been cleared. Confirming there would have submitted the earlier bill's
 * reason against whatever was current.
 *
 * This test navigates rather than re-rendering a fresh tree on purpose: a remount
 * would reset state by itself and prove nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { IDBFactory } from 'fake-indexeddb';

const BILL_A = '11111111-1111-4111-8111-111111111111';
const BILL_B = '33333333-3333-4333-8333-333333333333';

const H = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }));

const bill = {
  id: BILL_A,
  vendor_id: 'vendor-1',
  purchase_order_id: 'po-1',
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
    const result = table === 'vendor_bills' ? { data: bill, error: null } : { data: [], error: null };
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop: string | symbol) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
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
    supabase: { from: (table: string) => builder(table), rpc: (...args: unknown[]) => H.rpc(...args) },
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
vi.mock('../lib/sentry', () => ({ Sentry: new Proxy({}, { get: () => () => undefined }) }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));

const { default: VendorBillDetail } = await import('./VendorBillDetail');

// Rendered OUTSIDE <Routes> so it survives the navigation and the page under
// test is never unmounted.
function GoToOtherBill() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/accounts-payable/bills/${BILL_B}`)}>go-to-bill-b</button>;
}

const OVERAGE_PROMPT = /Why should cumulative billing exceed/i;

describe('VendorBillDetail route change with the overage prompt open', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    H.rpc.mockReset();
    H.toast.mockReset();
  });
  afterEach(() => cleanup());

  it('retires the previous bill overage prompt when the route id changes', async () => {
    // update_vendor_bill refuses with the cumulative-overage code, which is what
    // opens ReasonModal on the real page.
    H.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED: cumulative active bills would reach 112% of the PO total' },
    });

    render(
      <MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_A}`]}>
        <GoToOtherBill />
        <Routes>
          <Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // Open Edit Bill and save, so the server refusal opens the overage prompt.
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit Bill/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    // The prompt is genuinely open before we navigate — otherwise the assertion
    // below would pass for the wrong reason.
    await waitFor(() => expect(screen.getByPlaceholderText(OVERAGE_PROMPT)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'go-to-bill-b' }));

    // Wait for the NEXT bill to finish loading before asserting. The [id] effect
    // sets loading=true, and while loading the page renders a spinner instead of
    // the modal tree — so asserting immediately after navigation passes whether
    // or not editOverageMessage was cleared. The prompt only reappears once the
    // full page renders again, so this is the point where the two cases differ.
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());
    expect(screen.queryByPlaceholderText(OVERAGE_PROMPT)).toBeNull();
  });
});
