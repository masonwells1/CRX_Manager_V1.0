/**
 * PaymentAllocation.test.tsx — Tests for the unified payment entry page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

// parseCents is deliberately NOT mocked: the real parser refuses more than two
// decimals (null) and a rounding stand-in would let this page's refusal branches
// pass whether or not they work (2026-09-03).

import PaymentAllocation, { autoAllocate } from './PaymentAllocation';

function renderPayments() {
  return render(
    <MemoryRouter initialEntries={['/payments']}>
      <Routes>
        <Route path="/payments" element={<PaymentAllocation />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PaymentAllocation page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
  });

  it('renders the Payments heading', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByText('Payments')).toBeInTheDocument();
    });
  });

  it('renders customer search input', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search by name/i)).toBeInTheDocument();
    });
  });

  it('shows payment method selector', async () => {
    renderPayments();
    await waitFor(() => {
      expect(screen.getByText('Method')).toBeInTheDocument();
    });
  });

  it('names a refused check amount right under the field while the actions stay disabled', async () => {
    mockFrom.mockImplementation((table: string) => (table === 'customers'
      ? buildChain({ data: [{ id: 'cust-1', farm_name: 'Acme Farm', account_number: 'A-1', prepay_balance_cents: 0 }], error: null })
      : buildChain({ data: [], error: null })));
    renderPayments();
    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: 'Ac' } });
    fireEvent.click(await screen.findByRole('button', { name: /Acme Farm/ }));

    const amount = await screen.findByPlaceholderText('0.00');
    fireEvent.change(amount, { target: { value: '12.345' } });
    // Before the fix the refusal was invisible: null became 0, both action buttons were
    // disabled, and the handler toasts could never fire (CodeRabbit on PR #588).
    expect(screen.getByText('Enter an amount with no more than two decimal places.')).toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /Auto-Allocate/ })).toBeDisabled();
    expect(mockToast).not.toHaveBeenCalled();

    fireEvent.change(amount, { target: { value: '12.34' } });
    expect(screen.queryByText('Enter an amount with no more than two decimal places.')).not.toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('autoAllocate', () => {
  it('allocates full amount to single invoice', () => {
    const result = autoAllocate(10000, [{ id: 'inv-1', balance_cents: 10000 }]);
    expect(result.get('inv-1')).toBe(10000);
  });

  it('allocates across multiple invoices oldest first', () => {
    const invoices = [
      { id: 'inv-1', balance_cents: 5000 },
      { id: 'inv-2', balance_cents: 3000 },
      { id: 'inv-3', balance_cents: 4000 },
    ];
    const result = autoAllocate(7000, invoices);
    expect(result.get('inv-1')).toBe(5000);
    expect(result.get('inv-2')).toBe(2000);
    expect(result.has('inv-3')).toBe(false);
  });

  it('returns empty map for zero amount', () => {
    const result = autoAllocate(0, [{ id: 'inv-1', balance_cents: 5000 }]);
    expect(result.size).toBe(0);
  });

  it('returns empty map for negative amount', () => {
    const result = autoAllocate(-100, [{ id: 'inv-1', balance_cents: 5000 }]);
    expect(result.size).toBe(0);
  });

  it('skips invoices with zero balance', () => {
    const invoices = [
      { id: 'inv-1', balance_cents: 0 },
      { id: 'inv-2', balance_cents: 3000 },
    ];
    const result = autoAllocate(5000, invoices);
    expect(result.has('inv-1')).toBe(false);
    expect(result.get('inv-2')).toBe(3000);
  });

  it('handles NaN/Infinity gracefully', () => {
    expect(autoAllocate(NaN, [{ id: 'inv-1', balance_cents: 5000 }]).size).toBe(0);
    expect(autoAllocate(Infinity, [{ id: 'inv-1', balance_cents: 5000 }]).size).toBe(0);
  });
});
