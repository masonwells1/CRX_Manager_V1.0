import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import QuickReceivePanel from './QuickReceivePanel';
import { Sentry } from '../../lib/sentry';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: vi.fn(),
}));

const siblings = [
  {
    id: 'product-a',
    product_name: 'Same Name',
    sku: 'SKU-A',
    vendor: 'Vendor A',
    is_active: true,
    product_family: { name: 'Family A' },
    packaging_variant: 'Jug',
    container_size: 2.5,
    container_unit: 'GL',
    inventory_unit: 'GAL',
    return_policy: 'returnable',
  },
  {
    id: 'product-b',
    product_name: 'Same Name',
    sku: 'SKU-B',
    vendor: 'Vendor B',
    is_active: true,
    product_family: { name: 'Family B' },
    packaging_variant: 'Drum',
    container_size: 30,
    container_unit: 'GL',
    inventory_unit: 'GAL',
    return_policy: 'non_returnable',
  },
];

function productQuery() {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order']) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data: siblings, error: null }).then(resolve);
  return builder;
}

async function seedPendingIntent(storageKey: string, record: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('crx_durable_mutation_intents', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('intents')) {
        request.result.createObjectStore('intents', { keyPath: 'storageKey' });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('intents', 'readwrite');
      transaction.objectStore('intents').put({ storageKey, record });
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Receiver' } }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { from: vi.fn(() => productQuery()), rpc: mocks.rpc } };
});

vi.mock('../../lib/notificationTriggers', () => ({
  notifyDamagedReceiving: vi.fn(),
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

describe('QuickReceivePanel Product identity', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'match_quick_receive_items') {
        return {
          data: [{
            product_id: 'product-b',
            product_name: 'Same Name',
            quantity_requested: 3,
            quantity_unmatched: 0,
            has_multiple_costs: false,
            allocations: [{
              po_item_id: 'po-item-for-b',
              purchase_order_id: 'po-b',
              po_number: 'PO-B',
              quantity_allocated: 3,
              unit_cost: 25,
            }],
          }],
          error: null,
        };
      }
      if (name === 'receive_po_items') {
        return { data: { receiving_record_ids: [] }, error: null };
      }
      return { data: null, error: new Error(`Unexpected RPC ${name}`) };
    });
  });

  it.each([false, true])('distinguishes siblings and receives only the returned PO allocation, cleanup blocked=%s', async (cleanupBlocked) => {
    let cleanupSpy: ReturnType<typeof vi.spyOn> | undefined;
    if (cleanupBlocked) {
      // afterEach restores this persistent transport fault between parameter cases.
      vi.mocked(Sentry.captureException).mockImplementation((_error, context) => {
        if (context && typeof context === 'object' && 'tags' in context && context.tags?.source === 'durable-intent-resolve') throw new Error('Reporting transport failed');
        return 'captured';
      });
      const removeItem = Storage.prototype.removeItem;
      cleanupSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
        if (this === window.sessionStorage && key.startsWith('crx:uncertain-mutation-ack:v1:')) {
          throw new Error('Acknowledgment cleanup blocked');
        }
        return removeItem.call(this, key);
      });
    }
    render(
      <MemoryRouter>
        <QuickReceivePanel />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
    fireEvent.click(await screen.findByRole('button', { name: /select product/i }));

    const siblingA = await screen.findByRole('button', { name: /SKU-A.*Family A/i });
    const siblingB = screen.getByRole('button', { name: /SKU-B.*Family B/i });
    expect(siblingA).toBeInTheDocument();
    fireEvent.click(siblingB);
    fireEvent.change(screen.getByRole('spinbutton', { name: /quantity received/i }), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /review & match \(1 item\)/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'match_quick_receive_items',
      expect.objectContaining({
        p_items: [{ product_id: 'product-b', quantity: 3, lot_number: null }],
      }),
    ));
    fireEvent.click(await screen.findByRole('button', { name: /confirm & receive/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'receive_po_items',
      expect.objectContaining({
        p_items: [expect.objectContaining({
          po_item_id: 'po-item-for-b',
          quantity: 3,
        })],
      }),
    ));
    if (cleanupBlocked) {
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringContaining('receipt was saved once')));
      expect(screen.getByText(/these goods were recorded once/i)).toBeInTheDocument();
      expect(screen.queryByText(/shipment received!/i)).toBeNull();
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: expect.objectContaining({ source: 'durable-intent-resolve', operation: 'receive_po_items' }) }));
      expect(screen.queryByRole('button', { name: 'Receive Another Shipment' })).toBeNull();
      expect(screen.getByRole('button', { name: /back to edit/i })).toBeDisabled();
      expect(mocks.toast.mock.calls.filter(([kind]) => kind === 'success')).toEqual([]);
      expect(mocks.toast.mock.calls.filter(([kind]) => kind === 'error')).toEqual([]);
      const receivingCalls = mocks.rpc.mock.calls.filter(([name]) => name === 'receive_po_items');
      expect(receivingCalls).toHaveLength(1);
      const args = receivingCalls[0][1] as { p_idempotency_key: string };
      const acknowledgmentKey = Object.keys(window.sessionStorage).find((key) => key.startsWith('crx:uncertain-mutation-ack:v1:'));
      expect(acknowledgmentKey).toBeDefined();
      expect(window.sessionStorage.getItem(acknowledgmentKey!)).toContain(args.p_idempotency_key);
      cleanupSpy?.mockRestore();
      fireEvent.click(screen.getByRole('button', { name: /retry exact receiving/i }));
      expect(await screen.findByText(/successfully received 1 item allocation/i)).toBeInTheDocument();
      const replayCalls = mocks.rpc.mock.calls.filter(([name]) => name === 'receive_po_items');
      expect(replayCalls).toHaveLength(2);
      expect(replayCalls[1][1]).toEqual(args);

      // Only after A's cleanup succeeds may B become a new receipt, with B's
      // allocation and a new key instead of a hidden replay of A.
      mocks.rpc.mockImplementation(async (name: string) => name === 'match_quick_receive_items'
        ? { data: [{
          product_id: 'product-a', product_name: 'Same Name', quantity_requested: 2,
          quantity_unmatched: 0, has_multiple_costs: false,
          allocations: [{ po_item_id: 'po-item-for-a', purchase_order_id: 'po-a', po_number: 'PO-A', quantity_allocated: 2, unit_cost: 25 }],
        }], error: null }
        : { data: { receiving_record_ids: [] }, error: null });
      fireEvent.click(screen.getByRole('button', { name: 'Receive Another Shipment' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
      fireEvent.click(await screen.findByRole('button', { name: /select product/i }));
      fireEvent.click(await screen.findByRole('button', { name: /SKU-A.*Family A/i }));
      fireEvent.change(screen.getByRole('spinbutton', { name: /quantity received/i }), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: /review & match \(1 item\)/i }));
      fireEvent.click(await screen.findByRole('button', { name: /confirm & receive/i }));
      expect(await screen.findByText(/successfully received 1 item allocation/i)).toBeInTheDocument();
      const finalCalls = mocks.rpc.mock.calls.filter(([name]) => name === 'receive_po_items');
      expect(finalCalls).toHaveLength(3);
      const nextArgs = finalCalls[2][1] as { p_items: Array<{ po_item_id: string; quantity: number }>; p_idempotency_key: string };
      expect(nextArgs.p_items).toEqual([expect.objectContaining({ po_item_id: 'po-item-for-a', quantity: 2 })]);
      expect(nextArgs.p_idempotency_key).not.toBe(args.p_idempotency_key);
    } else {
      expect(await screen.findByText(/successfully received 1 item allocation/i)).toBeInTheDocument();
    }
  });

  it('restores a locked request after reload and retries its frozen payload without revalidation', async () => {
    const sourceItem = {
      key: 'frozen-line',
      product_id: 'product-b',
      product_name: 'Same Name',
      sku: 'SKU-B',
      quantity: 3,
      condition: 'good',
      lot_number: '',
      notes: '',
    };
    const frozenMatch = {
      product_id: 'product-b',
      product_name: 'Same Name',
      quantity_requested: 3,
      quantity_unmatched: 0,
      has_multiple_costs: true,
      allocations: [{
        po_item_id: 'po-item-frozen',
        purchase_order_id: 'po-frozen',
        po_number: 'PO-FROZEN',
        po_vendor: 'Vendor B',
        quantity_allocated: 3,
        unit_cost: 25,
        po_remaining_before: 3,
        po_remaining_after: 0,
      }],
    };
    const frozenPayload = [{
      po_item_id: 'po-item-frozen',
      quantity: 3,
      condition: 'good',
      lot_number: null,
      notes: null,
      storage_location: 'Cold Storage',
    }];
    const storageKey = `crx:uncertain-mutation:v4:${JSON.stringify([
      'receive_po_items',
      'user-1',
    ])}`;
    const frozenRecord = {
      version: 4,
      status: 'pending',
      requestVersion: 'frozen-version',
      claimTabIds: ['frozen-tab'],
      resolvedAtMs: null,
      operation: 'receive_po_items',
      userId: 'user-1',
      surface: 'quick-receive',
      scope: '',
      idempotencyKey: 'receive_po_items:user-1:frozen-key',
      intentIdentity: JSON.stringify({
        p_allow_over_receive: false,
        p_items: [{
          condition: 'good',
          lot_number: null,
          notes: null,
          po_item_id: 'po-item-frozen',
          quantity: 3,
          storage_location: 'Cold Storage',
        }],
        p_performed_by: 'user-1',
      }),
      createdAtMs: Date.now(),
      retryNotAfterMs: Date.now() + (23 * 60 * 60 * 1000),
      intent: {
        itemsPayload: frozenPayload,
        performedBy: 'user-1',
        receivedByName: 'Receiver',
        vendor: 'Vendor B',
        storageLocation: 'Cold Storage',
        matchResults: [frozenMatch],
        sourceItems: [sourceItem],
      },
    };
    // A real reload retains both durable stores. localStorage renders the
    // recovery UI, while IndexedDB is the coordinator that authorizes this
    // exact pending retry rather than a stale mirror replay.
    window.localStorage.setItem(storageKey, JSON.stringify(frozenRecord));
    await seedPendingIntent(storageKey, frozenRecord);

    render(
      <MemoryRouter>
        <QuickReceivePanel />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /retry exact receiving/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'receive_po_items',
      expect.objectContaining({
        p_items: frozenPayload,
        p_performed_by: 'user-1',
        p_idempotency_key: 'receive_po_items:user-1:frozen-key',
      }),
    ));
    expect(await screen.findByText(/successfully received 1 item allocation/i)).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(storageKey)).toContain('"status":"resolved"'));
  });

  it('keeps an expired request locked and never calls the receiving RPC', async () => {
    const storageKey = `crx:uncertain-mutation:v4:${JSON.stringify([
      'receive_po_items',
      'user-1',
    ])}`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 4,
      status: 'pending',
      requestVersion: 'expired-version',
      claimTabIds: ['expired-tab'],
      resolvedAtMs: null,
      operation: 'receive_po_items',
      userId: 'user-1',
      surface: 'quick-receive',
      scope: '',
      idempotencyKey: 'receive_po_items:user-1:expired-key',
      intentIdentity: 'expired-identity',
      createdAtMs: Date.now() - (24 * 60 * 60 * 1000),
      retryNotAfterMs: Date.now() - (60 * 60 * 1000),
      intent: {
        itemsPayload: [{
          po_item_id: 'po-item-expired',
          quantity: 3,
          condition: 'good',
          lot_number: null,
          notes: null,
          storage_location: 'Cold Storage',
        }],
        performedBy: 'user-1',
        receivedByName: 'Receiver',
        vendor: 'Vendor B',
        storageLocation: 'Cold Storage',
        matchResults: [{
          product_id: 'product-b',
          product_name: 'Same Name',
          quantity_requested: 3,
          quantity_unmatched: 0,
          has_multiple_costs: false,
          allocations: [{
            po_item_id: 'po-item-expired',
            purchase_order_id: 'po-expired',
            po_number: 'PO-EXPIRED',
            po_vendor: 'Vendor B',
            quantity_allocated: 3,
            unit_cost: 25,
            po_remaining_before: 3,
            po_remaining_after: 0,
          }],
        }],
        sourceItems: [{
          key: 'expired-line',
          product_id: 'product-b',
          product_name: 'Same Name',
          sku: 'SKU-B',
          quantity: 3,
          condition: 'good',
          lot_number: '',
          notes: '',
        }],
      },
    }));

    render(
      <MemoryRouter>
        <QuickReceivePanel />
      </MemoryRouter>,
    );

    const retry = await screen.findByRole('button', { name: /retry exact receiving/i });
    expect(retry).toBeDisabled();
    expect(screen.getByText(/safe automatic retry window expired/i)).toBeInTheDocument();
    fireEvent.click(retry);
    await Promise.resolve();
    expect(mocks.rpc).not.toHaveBeenCalledWith('receive_po_items', expect.anything());
    expect(window.localStorage.getItem(storageKey)).toContain('expired-key');
  });
});
