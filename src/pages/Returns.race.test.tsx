import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockRpc, mockToast, mockSentryCaptureException, intentKeys, nextIntentKey } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockSentryCaptureException: vi.fn(),
  intentKeys: new Map<string, string>(),
  nextIntentKey: { value: 0 },
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => chain;
  for (const name of ['select', 'eq', 'gt', 'is', 'in', 'not', 'order', 'limit', 'single', 'maybeSingle']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

function buildDeferredChain(): { chain: Record<string, unknown>; resolve: (result: { data: unknown; error: unknown }) => void } {
  let resolve!: (result: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((done) => { resolve = done; });
  const chain: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => chain;
  for (const name of ['select', 'eq', 'gt', 'is', 'in', 'not', 'order', 'limit', 'single', 'maybeSingle']) chain[name] = method;
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return { chain, resolve };
}

vi.mock('../lib/db', async () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((value) => value),
  // The REAL sanitizeError, never a stub. The previous stub was typed
  // `(error: Error) => error.message`, which misrepresents the null, string and
  // plain-object inputs the real function exists to survive -- postgrest-js only
  // constructs a real Error under `.throwOnError()`, so a failing rpc resolves a
  // plain object here.
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  )).sanitizeError,
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: (operation: string, userId: string, intentScope = '') => {
    const scope = JSON.stringify([operation, userId, intentScope]);
    const getFor = (dynamicIntentScope: string) => JSON.stringify([operation, userId, dynamicIntentScope]);
    const getOrCreate = (keyScope: string) => {
      let key = intentKeys.get(keyScope);
      if (!key) {
        nextIntentKey.value += 1;
        key = `return-idem-${nextIntentKey.value}`;
        intentKeys.set(keyScope, key);
      }
      return key;
    };
    return {
      getKey: () => getOrCreate(scope),
      resetKey: () => { intentKeys.delete(scope); },
      getKeyFor: (dynamicIntentScope: string) => getOrCreate(getFor(dynamicIntentScope)),
      resetKeyFor: (dynamicIntentScope: string) => { intentKeys.delete(getFor(dynamicIntentScope)); },
    };
  },
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockSentryCaptureException } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/reportPdf', () => ({ downloadReportPdf: vi.fn() }));
vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: vi.fn(async (opts: {
    action: () => Promise<unknown>;
    toast: (type: string, message: string) => void;
    successMessage?: string;
    onSuccess?: () => void;
    setLoading?: (loading: boolean) => void;
  }) => {
    opts.setLoading?.(true);
    try {
      await opts.action();
      if (opts.successMessage) opts.toast('success', opts.successMessage);
      opts.onSuccess?.();
    } catch (error) {
      opts.toast('error', (error as Error).message);
    } finally {
      opts.setLoading?.(false);
    }
  }),
}));

import Returns from './Returns';

describe('Returns loading and retry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intentKeys.clear();
    nextIntentKey.value = 0;
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  function setupCreateReturnData() {
    let returnableQuantity = 5;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return buildChain({ data: [{ id: 'customer-1', farm_name: 'Test Farm' }], error: null });
      if (table === 'orders') return buildChain({ data: [{ id: 'order-1', order_number: 'ORD-1', order_date: '2026-08-01' }], error: null });
      if (table === 'order_items') return buildChain({ data: [{
        id: 'order-item-1', product_id: 'product-1', product_name: 'Test Product',
        price_per_unit: 12.34, quantity_delivered: returnableQuantity,
        unit_size: 'ea', section_name: null, product: { id: 'product-1', product_name: 'Test Product' },
      }], error: null });
      if (table === 'returns') return buildChain({ data: [], error: null });
      return buildChain({ data: [], error: null });
    });
    return { setReturnableQuantity: (value: number) => { returnableQuantity = value; } };
  }

  async function fillCreateReturn() {
    fireEvent.click(screen.getAllByRole('button', { name: 'New Return' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
    fireEvent.change(within(dialog).getByLabelText('Customer'), { target: { value: 'customer-1' } });
    await waitFor(() => expect(within(dialog).getByLabelText('Original Order')).toHaveValue(''));
    fireEvent.change(within(dialog).getByLabelText('Original Order'), { target: { value: 'order-1' } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Add Item/ })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: /Add Item/ }));
    await screen.findByLabelText('Return product 1');
    fireEvent.change(screen.getByLabelText('Return product 1'), { target: { value: 'order-item-1' } });
    fireEvent.change(screen.getByLabelText('Notes (Optional)'), { target: { value: 'unchanged retry payload' } });
    return dialog;
  }

  it('locks and replays an unresolved Create Return after committed state changes', async () => {
    const serverState = setupCreateReturnData();
    let createCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'create_return') return Promise.resolve({ data: null, error: null });
      createCalls += 1;
      if (createCalls === 1) serverState.setReturnableQuantity(4);
      return Promise.resolve(createCalls === 1
        ? { data: null, error: { code: 'ECONNRESET', message: 'network response lost after commit' } }
        : { data: { return_id: 'return-1', return_number: 'RMA-1', item_count: 1 }, error: null });
    });

    render(<Returns />);
    await screen.findByText('No returns yet');
    let dialog = await fillCreateReturn();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Return' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'network response lost after commit'));
    expect(within(dialog).getByLabelText('Notes (Optional)')).toBeDisabled();
    expect(within(dialog).getByLabelText('Return quantity 1')).toBeDisabled();
    expect(within(dialog).getByText(/previous response was not confirmed/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Return / RMA' })).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'New Return' })[0]);
    dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
    expect(within(dialog).getByLabelText('Notes (Optional)')).toHaveValue('unchanged retry payload');
    expect(within(dialog).getByLabelText('Return quantity 1')).toHaveValue(1);
    expect(within(dialog).getByLabelText('Notes (Optional)')).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Return' }));

    await waitFor(() => expect(createCalls).toBe(2));
    const calls = mockRpc.mock.calls.filter(([name]) => name === 'create_return');
    expect(calls[1][1].p_idempotency_key).toBe(calls[0][1].p_idempotency_key);
    expect(calls[1][1].p_return).toEqual(calls[0][1].p_return);
    expect(calls[1][1].p_items).toEqual(calls[0][1].p_items);
  });

  it('retires a definitively refused Create Return key and unlocks the payload', async () => {
    setupCreateReturnData();
    let createCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'create_return') return Promise.resolve({ data: null, error: null });
      createCalls += 1;
      return Promise.resolve(createCalls === 1
        ? { data: null, error: { code: 'P0001', message: 'RETURN_QUANTITY_EXCEEDS_DELIVERED' } }
        : { data: { return_id: 'return-2', return_number: 'RMA-2', item_count: 1 }, error: null });
    });

    render(<Returns />);
    await screen.findByText('No returns yet');
    const dialog = await fillCreateReturn();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Return' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'RETURN_QUANTITY_EXCEEDS_DELIVERED'));
    await waitFor(() => expect(within(dialog).getByLabelText('Notes (Optional)')).toBeEnabled());
    fireEvent.change(within(dialog).getByLabelText('Notes (Optional)'), { target: { value: 'corrected payload' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Return' }));

    await waitFor(() => expect(createCalls).toBe(2));
    const calls = mockRpc.mock.calls.filter(([name]) => name === 'create_return');
    expect(calls[1][1].p_idempotency_key).not.toBe(calls[0][1].p_idempotency_key);
    expect(calls[1][1].p_return.notes).toBe('corrected payload');
  });

  it('scopes Cancel Return keys to the exact normalized reason', async () => {
    const returns = [{
      id: 'return-cancel-uuid', return_number: 'RMA-CANCEL', customer: { farm_name: 'Farm C' },
      order: { order_number: 'ORD-C' }, requested_by: null, items: [], status: 'requested',
      reason: 'defective', total_credit_cents: 100, requested_at: '2026-07-25T00:00:00Z',
    }];
    mockFrom.mockImplementation((table: string) => table === 'returns'
      ? buildChain({ data: returns, error: null })
      : buildChain({ data: [], error: null }));
    let cancelCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'cancel_return') return Promise.resolve({ data: null, error: null });
      cancelCalls += 1;
      return Promise.resolve(cancelCalls < 3
        ? { data: null, error: { message: 'network response lost after commit' } }
        : { data: { was_received: false, reversed_count: 0, skipped_count: 0 }, error: null });
    });

    render(<Returns />);
    await screen.findByText('RMA-CANCEL');
    fireEvent.click(screen.getByRole('button', { name: /RMA-CANCEL/ }));
    await screen.findByRole('heading', { name: 'Return: RMA-CANCEL' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const modal = await screen.findByRole('dialog', { name: 'Cancel Return' });
    const reason = within(modal).getByLabelText('Reason *');
    fireEvent.change(reason, { target: { value: '  Exact reason  ' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel Return' }));
    await waitFor(() => expect(cancelCalls).toBe(1));
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel Return' }));
    await waitFor(() => expect(cancelCalls).toBe(2));
    fireEvent.change(reason, { target: { value: 'Different reason' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel Return' }));
    await waitFor(() => expect(cancelCalls).toBe(3));

    const calls = mockRpc.mock.calls.filter(([name]) => name === 'cancel_return');
    expect(calls[1][1].p_idempotency_key).toBe(calls[0][1].p_idempotency_key);
    expect(calls[2][1].p_idempotency_key).not.toBe(calls[0][1].p_idempotency_key);
    expect(calls.map(([, args]) => args.p_reason)).toEqual(['Exact reason', 'Exact reason', 'Different reason']);
  });

  it('reconciles a pre-migration Create Return receipt from mismatch details', async () => {
    setupCreateReturnData();
    mockRpc.mockImplementation((name: string) => name === 'create_return'
      ? Promise.resolve({
          data: null,
          error: {
            message: 'IDEMPOTENCY_INTENT_MISMATCH',
            details: JSON.stringify({ operation: 'create_return', result: { return_id: 'legacy-return', return_number: 'RMA-LEGACY', item_count: 1 } }),
          },
        })
      : Promise.resolve({ data: null, error: null }));

    render(<Returns />);
    await screen.findByText('No returns yet');
    const dialog = await fillCreateReturn();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Return' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Return created'));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'create_return')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'New Return / RMA' })).not.toBeInTheDocument();
  });

  it('keeps the newest opened return when an older detail request fails late', async () => {
    const first = buildDeferredChain();
    const second = buildDeferredChain();
    const returns = [
      { id: 'return-a-uuid', return_number: 'RMA-A', customer: { farm_name: 'Farm A' }, order: { order_number: 'ORD-A' }, requested_by: null, items: [], status: 'requested', reason: 'defective', total_credit_cents: 100, requested_at: '2026-07-25T00:00:00Z' },
      { id: 'return-b-uuid', return_number: 'RMA-B', customer: { farm_name: 'Farm B' }, order: { order_number: 'ORD-B' }, requested_by: null, items: [], status: 'requested', reason: 'defective', total_credit_cents: 4567, requested_at: '2026-07-25T00:00:00Z' },
    ];
    let detailCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'returns') return buildChain({ data: returns, error: null });
      if (table === 'return_items') {
        detailCalls += 1;
        return detailCalls === 1 ? first.chain : second.chain;
      }
      return buildChain({ data: [], error: null });
    });

    render(<Returns />);
    await screen.findByText('RMA-A');
    fireEvent.click(screen.getByRole('button', { name: /RMA-A/ }));
    await waitFor(() => expect(detailCalls).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /RMA-B/ }));
    await waitFor(() => expect(detailCalls).toBe(2));

    await act(async () => {
      second.resolve({
        data: [{
          id: 'return-item-b-uuid', product_name: 'Latest return Product', quantity: 2, unit: 'case',
          condition: 'unopened', extended_cents: 4567, restock: false, restocked: false,
          product: { id: 'product-b-uuid', product_name: 'Latest return Product', sku: null },
        }],
        error: null,
      });
    });
    expect(await screen.findByRole('heading', { name: 'Return: RMA-B' })).toBeInTheDocument();
    expect(screen.getAllByText('Product ID: product-b-uuid')).toHaveLength(2);
    expect(screen.getAllByText('$45.67').length).toBeGreaterThan(0);

    await act(async () => {
      first.resolve({ data: null, error: { message: 'stale A failure' } });
    });
    expect(screen.getByRole('heading', { name: 'Return: RMA-B' })).toBeInTheDocument();
    expect(screen.getAllByText('Product ID: product-b-uuid')).toHaveLength(2);
    expect(screen.queryByText('stale A failure')).not.toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Failed to load return item details');
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
  });

  it('retains an unresolved lifecycle key across return A to B to A navigation', async () => {
    const returns = [
      { id: 'return-a-uuid', return_number: 'RMA-A', customer: { farm_name: 'Farm A' }, order: { order_number: 'ORD-A' }, requested_by: null, items: [], status: 'requested', reason: 'defective', total_credit_cents: 100, requested_at: '2026-07-25T00:00:00Z' },
      { id: 'return-b-uuid', return_number: 'RMA-B', customer: { farm_name: 'Farm B' }, order: { order_number: 'ORD-B' }, requested_by: null, items: [], status: 'requested', reason: 'defective', total_credit_cents: 200, requested_at: '2026-07-25T00:00:00Z' },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'returns') return buildChain({ data: returns, error: null });
      if (table === 'return_items') return buildChain({ data: [], error: null });
      return buildChain({ data: [], error: null });
    });
    let approveCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'approve_return') return Promise.resolve({ data: null, error: null });
      approveCalls += 1;
      return Promise.resolve(approveCalls === 1
        ? { data: null, error: { message: 'network response lost after commit' } }
        : { data: { success: true, return_id: 'return-a-uuid' }, error: null });
    });

    render(<Returns />);
    await screen.findByText('RMA-A');
    fireEvent.click(screen.getByRole('button', { name: /RMA-A/ }));
    await screen.findByRole('heading', { name: 'Return: RMA-A' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const firstApproveDialog = await screen.findByRole('dialog', { name: 'Approve Return' });
    fireEvent.click(within(firstApproveDialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'network response lost after commit'));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /RMA-B/ }));
    await screen.findByRole('heading', { name: 'Return: RMA-B' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: /RMA-A/ }));
    await screen.findByRole('heading', { name: 'Return: RMA-A' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const retryApproveDialog = await screen.findByRole('dialog', { name: 'Approve Return' });
    fireEvent.click(within(retryApproveDialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(approveCalls).toBe(2));
    const calls = mockRpc.mock.calls.filter(([name]) => name === 'approve_return');
    expect(calls[0][1]).toEqual(expect.objectContaining({ p_return_id: 'return-a-uuid' }));
    expect(calls[1][1].p_idempotency_key).toBe(calls[0][1].p_idempotency_key);
  });
});
