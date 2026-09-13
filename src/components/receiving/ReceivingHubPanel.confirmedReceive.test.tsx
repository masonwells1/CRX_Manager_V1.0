import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import ReceivingHubPanel from './ReceivingHubPanel';
import { Sentry } from '../../lib/sentry';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), toast: vi.fn() }));
const toastContext = { toast: mocks.toast };
let receiptCommitted = false;

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'receiver-1' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => toastContext }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { from: mocks.from, rpc: mocks.rpc } };
});

describe('ReceivingHubPanel confirmed receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    receiptCommitted = false;
    window.sessionStorage.clear();
    window.localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    mocks.from.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'in', 'order', 'limit']) chain[method] = () => chain;
      const result = Promise.resolve({ data: [{
        id: 'po-a', po_number: 'PO-A', vendor: 'Vendor A', status: 'submitted', expected_delivery_date: null,
        items: [{ id: 'line-a', product_id: 'product-a', product_name: 'Product A', quantity_ordered: 3, quantity_received: receiptCommitted ? 3 : 0, unit_size: 'GAL' }],
      }], error: null });
      chain.then = result.then.bind(result);
      return chain;
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_inventory_position') return { data: [], error: null };
      receiptCommitted = true;
      return { data: { receiving_record_ids: ['receipt-a'] }, error: null };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('refreshes the committed line off the board while keeping the same frozen receipt retryable', async () => {
    const removeItem = Storage.prototype.removeItem;
    const cleanupSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (this === window.sessionStorage && key.startsWith('crx:uncertain-mutation-ack:v1:')) throw new Error('Acknowledgment cleanup blocked');
      return removeItem.call(this, key);
    });
    render(<MemoryRouter><ReceivingHubPanel /></MemoryRouter>);
    const receiveButtons = await screen.findAllByRole('button', { name: /receive/i });
    fireEvent.click(receiveButtons[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Receive Stock' });
    const loadsBefore = mocks.from.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: /^receive$/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringContaining('receipt was saved once')));
    expect(mocks.toast.mock.calls.filter(([kind]) => kind === 'success')).toEqual([]);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: expect.objectContaining({ source: 'durable-intent-resolve', operation: 'receive_po_items' }) }));
    expect(mocks.toast.mock.calls.filter(([kind]) => kind === 'error')).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Receive Stock' })).toBeInTheDocument();
    await screen.findByText(/nothing on order/i);
    await waitFor(() => expect(mocks.from.mock.calls.length).toBeGreaterThan(loadsBefore));
    const calls = () => mocks.rpc.mock.calls.filter(([name]) => name === 'receive_po_items');
    expect(calls()).toHaveLength(1);
    const first = calls()[0][1] as { p_idempotency_key: string };
    const acknowledgmentKey = Object.keys(window.sessionStorage).find((key) => key.startsWith('crx:uncertain-mutation-ack:v1:'));
    expect(acknowledgmentKey).toBeDefined();
    expect(window.sessionStorage.getItem(acknowledgmentKey!)).toContain(first.p_idempotency_key);
    // A shared resolved tombstone must not erase this tab's pending
    // acknowledgment or unlock a different receipt under the same notice.
    const sharedKey = `crx:uncertain-mutation:v4:${JSON.stringify(['receive_po_items', 'receiver-1'])}`;
    fireEvent(window, new StorageEvent('storage', { key: sharedKey, storageArea: window.localStorage, newValue: window.localStorage.getItem(sharedKey) }));
    expect(screen.getByRole('dialog', { name: 'Receive Stock' })).toBeInTheDocument();
    expect(within(dialog).getByText(/these goods were recorded once/i)).toBeInTheDocument();
    cleanupSpy.mockRestore();
    const retryDialog = await screen.findByRole('dialog', { name: 'Receive Stock' });
    fireEvent.click(within(retryDialog).getByRole('button', { name: /retry exact receiving/i }));
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1][1]).toEqual(first);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Receive Stock' })).toBeNull());
  });
});
