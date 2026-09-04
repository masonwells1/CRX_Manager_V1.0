/**
 * DeliveryDetail.followupRetry.test.tsx — the retained idempotency key must be SPENDABLE.
 *
 * F1 moved `followupIdem.resetKey()` to after `assertRpcResult`, so an ambiguous reply
 * (a null success payload, where the server may already have committed) keeps the key and
 * the retry can be replayed. That is only worth something if the operator can actually
 * retry: `assertRpcResult` throws on exactly that reply, and `handleCreateFollowup` had no
 * `finally`, so `setCreatingFollowup(false)` never ran. The button stayed in its loading
 * state, and the only escape — navigating away — unmounts the page and drops the key, so
 * the retry travelled under a FRESH key the server cannot replay. That is the duplicate F1
 * exists to prevent.
 *
 * This drives the REAL DeliveryDetail component and the REAL useIdempotencyKey hook, and
 * asserts on what the operator can do: the button comes back, and the second attempt
 * carries the SAME key. Removing the `finally` from handleCreateFollowup turns both red.
 *
 * `assertRpcResult` is stubbed to its documented behavior — reject null/undefined, pass
 * anything else — because the point here is to SIMULATE the ambiguous reply, not to retest
 * that helper. Its real semantics are covered in src/__tests__/idempotency-reset-order.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { auth, mockFrom, mockRpc, mockToast, tables } = vi.hoisted(() => ({
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] },
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  tables: { data: {} as Record<string, unknown[]> },
}));

function buildChain(rows: unknown[]): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'returns', 'abortSignal',
  ]) self[m] = method;
  const result = { data: rows, error: null };
  const one = { data: rows[0] ?? null, error: null };
  self.single = () => Promise.resolve(one);
  self.maybeSingle = () => Promise.resolve(one);
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(ok, bad);
  self.catch = (bad: (e: unknown) => unknown) => Promise.resolve(result).catch(bad);
  self.finally = (fn: () => void) => Promise.resolve(result).finally(fn);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc, storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: null }) }) } },
  sanitizeError: (e: unknown) => (e as Error)?.message || 'Error',
  checkMutationResult: vi.fn(),
  assertRpcResult: (d: unknown, op: string) => {
    if (d === null || d === undefined) throw new Error(`${op} returned no result`);
    return d;
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDeliveryRemainder: vi.fn(), notifyDeliveryCompleted: vi.fn(),
}));
vi.mock('../lib/deliveryPdf', () => ({ downloadDeliveryPdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), buildEmailHtml: vi.fn() }));
vi.mock('../lib/rupCompliance', () => ({ checkRUPCompliance: () => ({ compliant: true, issues: [] }) }));
vi.mock('../lib/deliverySplitBilling', () => ({
  fetchSplitBillingOrderIds: () => Promise.resolve(new Set()), SPLIT_BILLING_BLOCK_REASON: '',
}));
vi.mock('../lib/offlineQueue', () => ({ queueAction: vi.fn(), getOfflineStorageErrorMessage: () => '' }));
vi.mock('../lib/imageCompression', () => ({ compressImage: vi.fn() }));
vi.mock('../components/deliveries/StartDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/ui/SignatureCanvas', () => ({ default: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'del-1' }), useNavigate: () => vi.fn() };
});

import DeliveryDetail from './DeliveryDetail';

const COMPLETED_DELIVERY = {
  id: 'del-1',
  delivery_number: 'DEL-1',
  status: 'completed',
  scheduled_date: '2026-09-01',
  delivery_date: '2026-09-01',
  customer_id: 'cust-1',
  order_id: null,
  assigned_driver: null,
  signature_url: null,
  customer: { farm_name: 'Test Farm', parent_customer_id: null, phone: null, address: null },
};

const PENDING_REMAINDER = {
  id: 'rem-1',
  original_delivery_id: 'del-1',
  product_id: 'prod-1',
  status: 'pending',
  remaining_quantity: 4,
  product: { product_name: 'Test Chem' },
};

beforeEach(() => {
  vi.clearAllMocks();
  tables.data = {
    deliveries: [COMPLETED_DELIVERY],
    delivery_items: [],
    delivery_remainders: [PENDING_REMAINDER],
    delivery_photos: [],
    invoices: [],
    orders: [],
    customers: [],
    products: [],
    profile_public_view: [],
  };
  mockFrom.mockImplementation((table: string) => buildChain(tables.data[table] ?? []));
});

async function renderAndFindButton(): Promise<HTMLButtonElement> {
  render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
  const btn = await screen.findByRole('button', { name: /Create Follow-up Delivery/i });
  return btn as HTMLButtonElement;
}

describe('F1 — an ambiguous follow-up reply leaves the retry REACHABLE', () => {
  it('re-enables the button and reuses the same key after a null success payload', async () => {
    // The ambiguous reply: no error, no payload. The server may already have committed.
    mockRpc.mockResolvedValue({ data: null, error: null });

    const button = await renderAndFindButton();
    fireEvent.click(button);

    // The handler must finish and hand control back, not strand the operator mid-flight.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).not.toBeDisabled());

    // And the retry must carry the SAME key, so the server can recognise the replay.
    fireEvent.click(button);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));

    const firstKey = mockRpc.mock.calls[0][1].p_idempotency_key;
    const retryKey = mockRpc.mock.calls[1][1].p_idempotency_key;
    expect(firstKey, 'no idempotency key was sent').toBeTruthy();
    expect(retryKey, 'the retry minted a FRESH key — the server cannot replay it, so the work double-applies').toBe(firstKey);
  });

  it('retires the key once the reply is confirmed, so the next follow-up is a new intent', async () => {
    mockRpc.mockResolvedValue({
      data: { delivery_id: 'del-2', delivery_number: 'DEL-2', item_count: 1 }, error: null,
    });

    const button = await renderAndFindButton();
    fireEvent.click(button);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));

    expect(
      mockRpc.mock.calls[1][1].p_idempotency_key,
      'a CONFIRMED success must retire the key — reusing it would make a genuine second follow-up replay the first',
    ).not.toBe(mockRpc.mock.calls[0][1].p_idempotency_key);
  });
});
