import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

/**
 * Renders the REAL NewVendorBill page and drives a real PO-overage rejection.
 *
 * A source-text guard cannot catch this class of defect, because the defect was
 * WHICH dialog the cross-tab branch opens. `ReasonModal` collects a reason that
 * `beginIntent()` then discards whenever a pending record survives, so prompting
 * there loops forever — the operator confirms, the confirmation is dropped, and
 * the same refusal comes back. These tests render the page and look at the DOM.
 *
 * They also pin the healthy path: an ordinary overage must still prompt, and
 * confirming it must put `p_confirm_po_overage` and `p_po_overage_reason` on the
 * wire. That is the payload the stale-`useState` read used to strip.
 */

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => chain;
  for (const name of ['select', 'eq', 'is', 'in', 'order', 'limit']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: vi.fn((value) => value),
  hasRpcCode: (error: { code?: string } | null, code: string) => error?.code === code,
  RpcErrorCodes: { PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED: '22023' },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-overage' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));

import NewVendorBill from './NewVendorBill';

const VENDORS = [
  { id: 'v-1', name: 'Acme Chemical', default_payment_terms: null, default_payment_terms_days: null },
];

describe('NewVendorBill PO-overage handling', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    mockToast.mockClear();
    mockRpc.mockReset();
    mockFrom.mockImplementation((table: string) =>
      buildChain({ data: table === 'vendors' ? VENDORS : [], error: null }));
  });

  async function fillAndSave() {
    await waitFor(() => expect(screen.getByText('Acme Chemical')).toBeTruthy());
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'v-1' } });
    fireEvent.change(screen.getByPlaceholderText("Vendor's invoice/bill #"), {
      target: { value: 'VB-OVERAGE-1' },
    });
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '1000.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Bill/i }));
  }

  it('prompts for a reason on an ordinary overage and sends the confirmation on retry', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'overage' } });
    render(<NewVendorBill />);
    await fillAndSave();

    await waitFor(() => {
      expect(screen.getByText(/Enter a reason to confirm the overage/i)).toBeTruthy();
    });
    expect(screen.queryByText(/still open in another tab/i)).toBeNull();

    mockRpc.mockResolvedValue({ data: 'bill-1', error: null });
    fireEvent.change(screen.getByPlaceholderText(/Why should cumulative billing exceed/i), {
      target: { value: 'Freight surcharge approved by the owner' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^Create Bill$/ }).slice(-1)[0]);

    await waitFor(() => expect(mockRpc.mock.calls.length).toBeGreaterThan(1));
    const retryArgs = mockRpc.mock.calls[mockRpc.mock.calls.length - 1][1];
    expect(retryArgs.p_confirm_po_overage).toBe(true);
    expect(retryArgs.p_po_overage_reason).toBe('Freight surcharge approved by the owner');
  });

  it('shows a blocking banner and opens no reason prompt when the pending record survives', async () => {
    // beginIntent() has already succeeded by the time the RPC answers. Killing the
    // durable store here — and only here — makes the release fail the way a live peer
    // claim does, so the record survives into classifyFailure(). Confirming anything
    // in this state is futile, so no confirmation control may be offered.
    mockRpc.mockImplementation(async () => {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: undefined });
      return { data: null, error: { code: '22023', message: 'overage' } };
    });
    render(<NewVendorBill />);
    await fillAndSave();

    await waitFor(() => {
      expect(screen.getByText(/still open in another tab/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Enter a reason to confirm the overage/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/Why should cumulative billing exceed/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry Exact Bill/i })).toBeTruthy();
  });
});
