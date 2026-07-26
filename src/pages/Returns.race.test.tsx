import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockToast, mockSentryCaptureException } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockSentryCaptureException: vi.fn(),
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

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: vi.fn() },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((value) => value),
  sanitizeError: vi.fn((error: Error) => error.message),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockSentryCaptureException } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/reportPdf', () => ({ downloadReportPdf: vi.fn() }));
vi.mock('../lib/criticalAction', () => ({ runCriticalAction: vi.fn() }));

import Returns from './Returns';

describe('Returns detail loading', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
