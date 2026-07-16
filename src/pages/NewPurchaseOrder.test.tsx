import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockNavigate, mockRpc, mockToast, mockGenerateIdempotencyKey } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockGenerateIdempotencyKey: vi.fn(),
}));

const product = {
  id: 'product-1',
  product_name: 'Test Herbicide',
  sku: 'TEST-1',
  vendor: 'Test Vendor',
  current_cost: 12.5,
  unit_size: 'Gallon',
};

function buildProductsQuery() {
  const result = Promise.resolve({ data: [product], error: null });
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = result.then.bind(result);
  chain.catch = result.catch.bind(result);
  chain.finally = result.finally.bind(result);
  return chain;
}

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock('../lib/db', () => ({
  supabase: {
    from: vi.fn(() => buildProductsQuery()),
    rpc: mockRpc,
  },
  assertRpcResult: <T,>(data: T) => data,
}));

vi.mock('../lib/idempotency', () => ({
  generateIdempotencyKey: mockGenerateIdempotencyKey,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'sales_rep', full_name: 'Sales User' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked' }),
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

import NewPurchaseOrder from './NewPurchaseOrder';

async function fillValidPurchaseOrder() {
  render(<NewPurchaseOrder />);

  fireEvent.click(await screen.findByRole('button', { name: 'Select Product' }));
  fireEvent.click(screen.getByRole('button', { name: /Test Herbicide/ }));
  fireEvent.change(screen.getByPlaceholderText('Enter or select vendor...'), {
    target: { value: 'Test Vendor' },
  });

  const [quantity] = screen.getAllByRole('spinbutton');
  fireEvent.change(quantity, { target: { value: '5' } });
  await waitFor(() => expect(screen.getByDisplayValue('Test Vendor')).toBeInTheDocument());
}

describe('NewPurchaseOrder save and submit workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const counts = new Map<string, number>();
    mockGenerateIdempotencyKey.mockImplementation((operation: string) => {
      const count = (counts.get(operation) ?? 0) + 1;
      counts.set(operation, count);
      return `${operation}-key-${count}`;
    });
  });

  it('saves a draft before submit and retries a lost submit response without resaving', async () => {
    let submitAttempts = 0;
    const calls: string[] = [];
    mockRpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'next_po_number') return { data: 'PO-TEST-1', error: null };
      if (name === 'save_purchase_order') {
        expect(args?.p_po_payload).toEqual(expect.objectContaining({ status: 'draft' }));
        return { data: { po_id: 'po-1' }, error: null };
      }
      if (name === 'submit_purchase_order') {
        submitAttempts += 1;
        return submitAttempts === 1
          ? { data: null, error: new Error('Submit response lost') }
          : { data: { po_id: 'po-1', status: 'submitted' }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    await fillValidPurchaseOrder();
    fireEvent.click(screen.getByRole('button', { name: 'Submit PO' }));

    await waitFor(() => expect(submitAttempts).toBe(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit PO' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Submit PO' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/purchase-orders/po-1', { replace: true }));
    expect(calls).toEqual([
      'next_po_number',
      'save_purchase_order',
      'submit_purchase_order',
      'submit_purchase_order',
    ]);
    const submitCalls = mockRpc.mock.calls.filter(([name]) => name === 'submit_purchase_order');
    expect(submitCalls).toHaveLength(2);
    expect(submitCalls[0][1].p_idempotency_key).toBe(submitCalls[1][1].p_idempotency_key);
  });

  it('reuses the PO number and save key when the save response is lost', async () => {
    let saveAttempts = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'next_po_number') return { data: 'PO-TEST-2', error: null };
      if (name === 'save_purchase_order') {
        saveAttempts += 1;
        return saveAttempts === 1
          ? { data: null, error: new Error('Save response lost') }
          : { data: { po_id: 'po-2' }, error: null };
      }
      if (name === 'submit_purchase_order') {
        return { data: { po_id: 'po-2', status: 'submitted' }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    await fillValidPurchaseOrder();
    fireEvent.click(screen.getByRole('button', { name: 'Submit PO' }));

    await waitFor(() => expect(saveAttempts).toBe(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit PO' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Submit PO' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/purchase-orders/po-2', { replace: true }));
    const numberCalls = mockRpc.mock.calls.filter(([name]) => name === 'next_po_number');
    const saveCalls = mockRpc.mock.calls.filter(([name]) => name === 'save_purchase_order');
    expect(numberCalls).toHaveLength(1);
    expect(saveCalls).toHaveLength(2);
    expect(saveCalls[0][1].p_po_payload.po_number).toBe('PO-TEST-2');
    expect(saveCalls[1][1].p_po_payload.po_number).toBe('PO-TEST-2');
    expect(saveCalls[0][1].p_idempotency_key).toBe(saveCalls[1][1].p_idempotency_key);
  });
});
