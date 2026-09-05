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
  // Mutable durable-intent state. The first version of this file hard-coded
  // `unresolvedIntent: null` and `isIntentLocked: false`, which mocked away the
  // exact production state the tests claimed to exercise — after a real failed
  // resolveIntent() the hook stays LOCKED and the button reads "Retry Exact
  // Receiving", not "Confirm & Receive". (gpt-5.6-sol on 2ff8bdafc.)
  intent: {
    unresolvedIntent: null as unknown,
    isIntentLocked: false,
    isRetryExpired: false,
    isForeignIntentLocked: false,
  },
  // When the durable store is genuinely broken, preparation rejects too — not just
  // the post-commit cleanup. That is the retry case the preparation catch must
  // describe honestly.
  beginIntentShouldReject: false,
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
    get isForeignIntentLocked() { return mocks.intent.isForeignIntentLocked; },
    get isRetryExpired() { return mocks.intent.isRetryExpired; },
    get isIntentLocked() { return mocks.intent.isIntentLocked; },
    get unresolvedIntent() { return mocks.intent.unresolvedIntent; },
    beginIntent: async (intent: unknown) => {
      if (mocks.beginIntentShouldReject) throw new Error('QuotaExceededError');
      return intent;
    },
    getIdempotencyKey: () => 'idem-1',
    resolveIntent: mocks.resolveIntent,
    classifyFailure: mocks.classifyFailure,
  }),
}));

// A frozen request exactly as the durable hook would hand one back after a lost
// response: same shape the page builds, already committed-or-not on the server.
const LOCKED_REQUEST = {
  performedBy: 'admin-1',
  itemsPayload: [{
    po_item_id: 'po-item-1',
    quantity: 4,
    condition: 'good',
    lot_number: null,
    notes: null,
    storage_location: 'Main Warehouse',
  }],
  finalPayload: [{
    po_item_id: 'po-item-1',
    quantity: 4,
    condition: 'good',
    lot_number: null,
    notes: null,
    storage_location: 'Main Warehouse',
  }],
  allowOverReceive: false,
  storageLocation: 'Main Warehouse',
};

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
    mocks.intent.unresolvedIntent = null;
    mocks.intent.isIntentLocked = false;
    mocks.intent.isRetryExpired = false;
    mocks.intent.isForeignIntentLocked = false;
    mocks.beginIntentShouldReject = false;
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

  // THE CASE THE FIRST FIX MISSED ENTIRELY (gpt-5.6-sol on 2ff8bdafc).
  //
  // An ordinary retry of an IDENTICAL request is not an error. `check_idempotency_intent`
  // matches the fingerprint and `receive_po_items` does `RETURN v_replay -> 'result'`
  // — a normal success, no error, no replay marker
  // (20260831233000_bind_section9_replays_to_intent.sql). Every assignment of
  // `completedElsewhere = true` lives in the RPC error branch, so the previous gate
  // could never close on this path, and the test written for it passed against the
  // MISMATCH path instead. This is the common replay: it needs the frozen-request
  // flag, not the error flag.
  it('does not regenerate the receiving slip on an ordinary same-payload retry', async () => {
    // A receipt was submitted, the response was lost, and the intent stayed locked.
    mocks.intent.unresolvedIntent = LOCKED_REQUEST;
    mocks.intent.isIntentLocked = true;

    // The server recognises the key and returns the STORED result as plain success.
    mocks.rpc.mockResolvedValue({
      data: { receiving_record_ids: ['rr-1'] },
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
        <Routes>
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // The recovery effect restores the frozen request and opens the form at review.
    // The button says "Retry Exact Receiving" — the real locked-state label, which
    // the earlier all-defaults mock could never have produced.
    const retry = await screen.findByRole('button', { name: /Retry Exact Receiving/i });
    fireEvent.click(retry);

    // Positive sentinel: the submission completed.
    await waitFor(() => {
      expect(mocks.rpc).toHaveBeenCalledWith('receive_po_items', expect.anything());
    });
    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith('success', expect.stringContaining('Receiving reconciled'));
    });

    // No second slip stamped with this moment and this operator.
    expect(mocks.downloadReceivingPdf).not.toHaveBeenCalled();
    // And nothing claims THIS attempt performed the receipt.
    expect(mocks.toast).not.toHaveBeenCalledWith('success', 'Items received and inventory updated');
  });

  // gpt-5.6-sol on 2ff8bdafc: the retry after a failed cleanup is the MOST likely
  // way to reach the preparation catch, because the same broken store that failed
  // the cleanup also fails preparation. Telling that operator "Nothing was received"
  // contradicts the warning they just read and sends them to another device, where
  // no local pending intent exists, a fresh key is minted, and the goods can be
  // received twice.
  it('does not tell a retrying operator that nothing was received', async () => {
    mocks.intent.unresolvedIntent = LOCKED_REQUEST;
    mocks.intent.isIntentLocked = true;
    mocks.rpc.mockResolvedValue({ data: { receiving_record_ids: ['rr-1'] }, error: null });

    render(
      <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
        <Routes>
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
        </Routes>
      </MemoryRouter>
    );

    const retry = await screen.findByRole('button', { name: /Retry Exact Receiving/i });

    // The local store is still broken, so preparation itself now rejects.
    mocks.beginIntentShouldReject = true;
    fireEvent.click(retry);

    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('do NOT receive these goods again'));
    });
    expect(mocks.toast).not.toHaveBeenCalledWith(
      'error',
      'Receiving could not be safely prepared. Nothing was received; refresh and try again.',
    );
    // Nothing was sent to the server on this attempt.
    expect(mocks.rpc).not.toHaveBeenCalledWith('receive_po_items', expect.anything());
  });
});
