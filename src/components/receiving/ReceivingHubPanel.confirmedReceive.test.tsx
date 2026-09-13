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

  it.each(['Cancel', 'Close'])('allows %s while another surface owns the saved receipt and preserves its key', async (control) => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'receive_po_items'
      ? { data: null, error: { code: 'ETIMEDOUT', message: 'socket timeout' } }
      : { data: [], error: null });
    const initial = render(<MemoryRouter><ReceivingHubPanel /></MemoryRouter>);
    fireEvent.click((await screen.findAllByRole('button', { name: /receive/i }))[0]);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Receive Stock' })).getByRole('button', { name: /^receive$/i }));
    await screen.findByRole('button', { name: /retry exact receiving/i });
    // Wait for classification and its durable write, not merely beginIntent's lock.
    await waitFor(() => expect(mocks.toast.mock.calls.some(([kind]) => kind === 'error')).toBe(true));
    const sharedKey = `crx:uncertain-mutation:v4:${JSON.stringify(['receive_po_items', 'receiver-1'])}`;
    const saved = window.localStorage.getItem(sharedKey);
    expect(saved).not.toBeNull();
    initial.unmount();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    const peerRecord = { ...JSON.parse(saved!), surface: 'quick-receive', claimTabIds: ['another-tab'] };
    window.localStorage.setItem(sharedKey, JSON.stringify(peerRecord));
    render(<MemoryRouter><ReceivingHubPanel /></MemoryRouter>);
    fireEvent.click((await screen.findAllByRole('button', { name: /receive/i }))[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Receive Stock' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /retry exact receiving/i })).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: control })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: control }));
    expect(screen.queryByRole('dialog', { name: 'Receive Stock' })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(sharedKey)!)).toEqual(peerRecord);
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'receive_po_items')).toHaveLength(1);
  });

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
    const sharedRecord = window.localStorage.getItem(sharedKey);
    expect(sharedRecord).not.toBeNull();
    fireEvent(window, new StorageEvent('storage', { key: sharedKey, storageArea: window.localStorage, newValue: sharedRecord }));
    expect(screen.getByRole('dialog', { name: 'Receive Stock' })).toBeInTheDocument();
    expect(within(dialog).getByText(/these goods were recorded once/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    cleanupSpy.mockRestore();
    const retryDialog = await screen.findByRole('dialog', { name: 'Receive Stock' });
    fireEvent.click(within(retryDialog).getByRole('button', { name: /retry exact receiving/i }));
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1][1]).toEqual(first);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Receive Stock' })).toBeNull());
  });
});
