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
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
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

const billB = { ...bill, id: BILL_B, bill_number: 'VB-2002' };

// Which bill row the mocked `vendor_bills` fetch answers with. Flipped by the
// late-response test before it navigates, so that after the route change the
// page's `bill` really is bill B — otherwise `handleEditBill`'s entry guard
// (`bill.id !== id`) would reject on identity grounds and the test would pass
// without ever exercising the stale-response path it exists to cover.
let activeBillRow: Record<string, unknown> = bill;

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const builder = (table: string) => {
    const result = table === 'vendor_bills' ? { data: activeBillRow, error: null } : { data: [], error: null };
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

// Returning to the ORIGINAL bill is the case a route-id check cannot see.
function GoToBillA() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/accounts-payable/bills/${BILL_A}`)}>go-to-bill-a</button>;
}

const OVERAGE_PROMPT = /Why should cumulative billing exceed/i;

describe('VendorBillDetail route change with the overage prompt open', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    H.rpc.mockReset();
    H.toast.mockReset();
    activeBillRow = bill;
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

  // The case the test above deliberately does NOT cover: it navigates only after
  // the refusal has already arrived. Here the refusal is still IN FLIGHT across
  // the route change, which is the dangerous ordering.
  //
  // `handleEditBill`'s entry guard cannot catch this. By the time the late answer
  // lands, `bill`, `id` and `editModalBillId` have all legitimately advanced to
  // bill B, so every identity check passes — the only stale thing is which bill
  // the answer concerns. Reopening the prompt there is a MONEY defect, not a
  // cosmetic one: ReasonModal's onConfirm calls handleEditBill(true, reason),
  // which would submit BILL B with p_confirm_po_overage=true, authorizing an
  // overage B was never checked for and filing A's justification against it.
  it('discards a PO-overage refusal that arrives after the operator moved to another bill', async () => {
    let releaseEdit: (value: unknown) => void = () => {};
    H.rpc.mockImplementation((name: string) => {
      if (name === 'update_vendor_bill') {
        return new Promise((resolve) => { releaseEdit = resolve; });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(
      <MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_A}`]}>
        <GoToOtherBill />
        <Routes>
          <Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // Save bill A. The RPC is held open, so nothing has answered yet.
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit Bill/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('update_vendor_bill', expect.anything()));
    expect(screen.queryByPlaceholderText(OVERAGE_PROMPT)).toBeNull();

    // Move to bill B and open ITS editor, so every identity the entry guard
    // checks is now legitimately bill B.
    activeBillRow = billB;
    fireEvent.click(screen.getByRole('button', { name: 'go-to-bill-b' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit Bill/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy());

    // Now bill A's refusal finally lands.
    await act(async () => {
      releaseEdit({
        data: null,
        error: { code: 'P0001', message: 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED: cumulative active bills would reach 112% of the PO total' },
      });
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    });

    // It must be discarded outright: no overage prompt over bill B, and B's own
    // editor left exactly as the operator opened it.
    expect(screen.queryByPlaceholderText(OVERAGE_PROMPT)).toBeNull();
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy();
  });

  // gpt-5.6-sol on c127bd535: the route-id check passes when the operator LEAVES
  // bill A and COMES BACK. `currentBillIdRef.current === targetBillId` is true
  // again, so bill A's stale refusal was adopted by the new editing session and
  // opened the overage prompt over figures it was never checked against —
  // confirming it would submit the CURRENT form carrying the old justification.
  // The A -> B -> A shape is what the previous test cannot reach.
  it('discards a stale refusal after the operator leaves bill A and returns to it', async () => {
    let releaseEdit: (value: unknown) => void = () => {};
    H.rpc.mockImplementation((name: string) => {
      if (name === 'update_vendor_bill') {
        return new Promise((resolve) => { releaseEdit = resolve; });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(
      <MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_A}`]}>
        <GoToOtherBill />
        <GoToBillA />
        <Routes>
          <Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // Submit edit P1 on bill A; hold the RPC open.
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit Bill/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('update_vendor_bill', expect.anything()));

    // Leave to bill B, then come BACK to A and reopen its editor with fresh
    // figures. Every identity a route check inspects now reads "bill A" again.
    activeBillRow = billB;
    fireEvent.click(screen.getByRole('button', { name: 'go-to-bill-b' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());

    activeBillRow = bill;
    fireEvent.click(screen.getByRole('button', { name: 'go-to-bill-a' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit Bill/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy());

    // P1's refusal finally lands, against a bill whose id matches again.
    await act(async () => {
      releaseEdit({
        data: null,
        error: { code: 'P0001', message: 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED: cumulative active bills would reach 112% of the PO total' },
      });
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    });

    // The session token, not the bill id, is what refuses it.
    expect(screen.queryByPlaceholderText(OVERAGE_PROMPT)).toBeNull();
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy();
  });

  // gpt-5.6-sol on 862cd144d: the session token advanced on open and on route
  // change but NOT on close, so a late refusal for an edit the operator had
  // explicitly cancelled still matched and reopened the overage prompt over a
  // closed editor. Confirming it then failed the entry guard on the now-null
  // editModalBillId, producing an error instead of the action the prompt offered.
  it('discards a stale refusal for an edit the operator cancelled', async () => {
    let releaseEdit: (value: unknown) => void = () => {};
    H.rpc.mockImplementation((name: string) => {
      if (name === 'update_vendor_bill') {
        return new Promise((resolve) => { releaseEdit = resolve; });
      }
      return Promise.resolve({ data: null, error: null });
    });

    render(
      <MemoryRouter initialEntries={[`/accounts-payable/bills/${BILL_A}`]}>
        <Routes>
          <Route path="/accounts-payable/bills/:id" element={<VendorBillDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /Edit Bill/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit Bill/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Changes/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('update_vendor_bill', expect.anything()));

    // Operator gives up on the edit and closes the editor while it is in flight.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Save Changes/i })).toBeNull());

    // The refusal for the cancelled edit lands. Same bill, same route.
    await act(async () => {
      releaseEdit({
        data: null,
        error: { code: 'P0001', message: 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED: cumulative active bills would reach 112% of the PO total' },
      });
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    });

    // A cancelled edit must not be resurrected by its own late answer.
    expect(screen.queryByPlaceholderText(OVERAGE_PROMPT)).toBeNull();
  });
});
