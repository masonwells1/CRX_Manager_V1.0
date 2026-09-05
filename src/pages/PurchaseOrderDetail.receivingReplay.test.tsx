/**
 * PurchaseOrderDetail.receivingReplay.test.tsx
 *
 * Drives the REAL receiving flow through the rendered page for the two
 * post-commit cases the suite could not previously reach, both raised by
 * gpt-5.6-sol on 862cd144d:
 *
 *  1. The local durable-intent cleanup REJECTS after the receipt committed. The
 *     warning toast tells the operator the form "stays open showing this same
 *     receipt" — and it must actually stay open. The reopen the earlier wording
 *     promised never happened: the recovery effect is edge-triggered on the
 *     identity of `unresolvedIntent`, and a failed resolve leaves the very same
 *     object in place, so nothing re-ran it and the next line closed the form.
 *
 *  2. A REPLAY (`completedElsewhere`) must not regenerate the receiving slip.
 *     The PDF is stamped with `new Date()` and the CURRENT operator, but a
 *     replay answers for a receipt that committed earlier, possibly by someone
 *     else — so it produced a receiving document stating the wrong time and the
 *     wrong receiver.
 *
 * The page is rendered and clicked, not inspected as source: these are claims
 * about what an operator sees after a specific server answer.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PurchaseOrderDetail from './PurchaseOrderDetail';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  resetKey: vi.fn(),
  resolveIntent: vi.fn(),
  classifyFailure: vi.fn(),
  downloadReceivingPdf: vi.fn(),
  captureException: vi.fn(),
}));

const po = {
  id: 'po-1',
  po_number: 'PO-1',
  vendor: 'Vendor',
  // `Receive Items` renders only for a submitted or partially received PO.
  status: 'submitted',
  submitted_date: '2026-07-01',
  expected_delivery_date: null,
  notes: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const poItems = [
  {
    id: 'po-item-1',
    purchase_order_id: 'po-1',
    product_id: 'product-a',
    quantity_ordered: 10,
    quantity_received: 0,
    unit_cost_cents: 1000,
    unit_size: '2.5 GL',
    product: {
      id: 'product-a',
      product_name: 'Test Product',
      sku: 'SKU-A',
      unit_size: '2.5 GL',
      product_family: { name: 'Family A' },
    },
  },
];

function query(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'in', 'ilike', 'limit']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  builder.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return builder;
}

vi.mock('../lib/db', async () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  )).sanitizeError,
  assertRpcResult: (value: unknown) => value,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'admin-1', full_name: 'Admin' } }),
}));

vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock('../lib/sentry', () => ({
  Sentry: new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (prop === 'captureException' ? mocks.captureException : () => undefined),
  }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKey: () => 'idem-1',
    resetKey: mocks.resetKey,
    getKeyFor: (scope: string) => `idem-1:${scope}`,
    resetKeyFor: mocks.resetKey,
  }),
}));

// The durable intent is the subject of both tests, so it is driven directly
// rather than through IndexedDB: `resolveIntent` is what must be made to reject.
// `beginIntent` echoes the intent back the way the real hook does.
vi.mock('../hooks/useUncertainMutationIntent', () => ({
  UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE: 'other surface',
  UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE: 'reconciliation',
  useUncertainMutationIntent: () => ({
    isForeignIntentLocked: false,
    isRetryExpired: false,
    isIntentLocked: false,
    unresolvedIntent: null,
    beginIntent: async (intent: unknown) => intent,
    getIdempotencyKey: () => 'idem-1',
    resolveIntent: mocks.resolveIntent,
    classifyFailure: mocks.classifyFailure,
  }),
}));

vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: async (options: {
    action: () => Promise<unknown>;
    onSuccess?: (result: unknown) => void;
  }) => {
    const result = await options.action();
    options.onSuccess?.(result);
  },
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDamagedReceiving: vi.fn(),
  notifyOverReceive: vi.fn(),
}));
vi.mock('../lib/receivingPdf', () => ({
  downloadReceivingPdf: mocks.downloadReceivingPdf,
  generateReceivingPdf: vi.fn(),
}));

async function openReceiveAndSubmit() {
  await waitFor(() => expect(screen.getByRole('button', { name: /Receive Items/i })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /Receive Items/i }));

  const qty = await screen.findByPlaceholderText('0');
  fireEvent.change(qty, { target: { value: '4' } });

  fireEvent.click(await screen.findByRole('button', { name: /Review \(1 item\)/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Confirm & Receive/i }));
}

describe('PurchaseOrderDetail receiving — post-commit corridor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'purchase_orders') return query(po);
      if (table === 'purchase_order_items') return query(poItems);
      if (table === 'receiving_records') return query([]);
      return query([]);
    });
    mocks.resolveIntent.mockResolvedValue(undefined);
  });

  it('keeps the receiving form open when the local cleanup fails after the receipt committed', async () => {
    mocks.rpc.mockResolvedValue({
      data: { receiving_record_ids: ['rr-1'] },
      error: null,
    });
    // The receipt COMMITTED; only the local record could not be cleared.
    mocks.resolveIntent.mockRejectedValue(new Error('QuotaExceededError'));

    render(
      <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
        <Routes>
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await openReceiveAndSubmit();

    // Positive sentinel: the cleanup-failure branch ran to completion.
    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('These goods WERE received and recorded'),
      );
    });

    // The toast says the form stays open showing this same receipt. It must.
    expect(screen.getByRole('button', { name: /Confirm & Receive/i })).toBeTruthy();
    // And the message must not have been narrowed back to a bare promise of a retry.
    expect(mocks.toast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('stays open'),
    );
  });

  it('closes the receiving form on the ordinary path where cleanup succeeds', async () => {
    mocks.rpc.mockResolvedValue({ data: { receiving_record_ids: ['rr-1'] }, error: null });

    render(
      <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
        <Routes>
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await openReceiveAndSubmit();

    // The counterpart to the test above: without it, "keeps the form open" would
    // also pass against a page that never closes the form at all.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Confirm & Receive/i })).toBeNull();
    });
    expect(mocks.downloadReceivingPdf).toHaveBeenCalledTimes(1);
  });

  it('does not regenerate the receiving slip when the receipt already committed elsewhere', async () => {
    // The server refuses the replay and hands back the committed receipt.
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'IDEMPOTENCY_INTENT_MISMATCH',
        details: JSON.stringify({
          operation: 'receive_po_items',
          result: { receiving_record_ids: ['rr-1'] },
        }),
      },
    });

    render(
      <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
        <Routes>
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
        </Routes>
      </MemoryRouter>
    );

    await openReceiveAndSubmit();

    // Positive sentinel: the replay branch ran to completion.
    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('already completed'),
      );
    });

    // A slip printed here would carry THIS moment and THIS operator for a receipt
    // that committed earlier. Receiving history reprints it correctly instead.
    expect(mocks.downloadReceivingPdf).not.toHaveBeenCalled();
  });
});
