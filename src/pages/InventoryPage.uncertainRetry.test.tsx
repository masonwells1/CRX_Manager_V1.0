/**
 * InventoryPage.uncertainRetry.test.tsx
 *
 * adjust_inventory, create_inventory_hold and retire_inventory_item replay on
 * the idempotency KEY ALONE — the server never compares the payload. Before
 * this fix the page reset its key every time a dialog opened, so an operator
 * whose reply was lost (server committed, browser saw an error) would close the
 * dialog, reopen it, re-enter the same numbers and hand the server a brand-new
 * key. PostgreSQL applied the adjustment twice.
 *
 * These tests drive the RENDERED page with the REAL useUncertainMutationIntent
 * and REAL useIdempotencyKey hooks (fake-indexeddb stands in for the browser's
 * IndexedDB). Only the Supabase client, auth, toasts, Sentry and the activity
 * logger are mocked. Every assertion is about what the server receives.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import InventoryPage from './InventoryPage';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
}));

// A transport-shaped failure: PostgREST never answered, so the browser cannot
// know whether the server committed. isDefinitiveRpcRejection() returns false
// for this code, which is exactly the case the lock exists for.
const LOST_REPLY = { code: 'ETIMEDOUT', message: 'socket timeout' };

function positionRow(overrides: Record<string, unknown>) {
  return {
    inventory_id: 'inv-a',
    product_id: 'product-a',
    product_name: 'Product A',
    sku: 'SKU-A',
    location: 'Main Warehouse',
    unit_size: '2.5 GL',
    inventory_unit: 'GAL',
    container_size: 2.5,
    container_type: 'Jug',
    vendor: 'Vendor',
    current_cost: 10,
    quantity_available: 100,
    quantity_prebooked: 0,
    quantity_on_order: 0,
    holds_qty: 0,
    job_holds_qty: 0,
    planned_qty: 0,
    net_position: 100,
    delivered_ytd: 0,
    reorder_point: 0,
    min_stock_level: 0,
    is_low_stock: false,
    ...overrides,
  };
}

const positions = [
  positionRow({}),
  positionRow({ inventory_id: 'inv-b', product_id: 'product-b', product_name: 'Product B', sku: 'SKU-B' }),
];

const products = [
  {
    id: 'product-a',
    product_name: 'Product A',
    sku: 'SKU-A',
    unit_size: '2.5 GL',
    packaging_variant: 'Jug',
    container_size: 2.5,
    container_unit: 'GL',
    inventory_unit: 'GAL',
    return_policy: 'returnable',
    is_full_tote_only: false,
    is_active: true,
    product_family: { name: 'Family A' },
  },
];

function query(data: unknown, error: unknown = null) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'or', 'order', 'in', 'update']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data, error }).then(resolve);
  return builder;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    supabase: { from: mocks.from, rpc: mocks.rpc },
    checkMutationResult: vi.fn(),
    sanitizeError: actual.sanitizeError,
    assertRpcResult: actual.assertRpcResult,
    hasRpcCode: actual.hasRpcCode,
    RpcErrorCodes: actual.RpcErrorCodes,
  };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'admin-1', full_name: 'Admin' } }),
}));

vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock('../lib/sentry', () => ({
  Sentry: new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (prop === 'captureException' ? mocks.captureException : () => undefined),
  }),
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

/** Every call the server saw for one RPC, oldest first. */
function callsTo(name: string): Array<Record<string, unknown>> {
  return mocks.rpc.mock.calls
    .filter((call) => call[0] === name)
    .map((call) => call[1] as Record<string, unknown>);
}

function respond(handlers: Record<string, () => { data: unknown; error: unknown }>) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_inventory_position') return { data: positions, error: null };
    const handler = handlers[name];
    if (handler) return handler();
    return { data: [], error: null };
  });
}

async function renderPage() {
  const view = render(<MemoryRouter><InventoryPage /></MemoryRouter>);
  // Wait for the grid, so the row action buttons exist.
  await screen.findAllByRole('button', { name: 'Manual Adjustment' });
  return view;
}

function adjustDialog() {
  return screen.getByRole('dialog', { name: /manual.*adjustment/i });
}

async function openAdjustForRow(index: number) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Manual Adjustment' })[index]);
  return adjustDialog();
}

describe('InventoryPage — a lost reply freezes the request instead of minting a new key', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') return query(products);
      return query([]);
    });
  });

  it('closes and refreshes a confirmed receipt when acknowledgment cleanup fails, preserving its exact retry', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') return query(products);
      if (table === 'purchase_order_items') return query([{
        id: 'receive-line-a', quantity_ordered: 100, quantity_received: 0,
        unit_cost: 10, unit_size: '2.5 GL', product_id: 'product-a', purchase_order_id: 'po-a',
        purchase_orders: { po_number: 'PO-A', status: 'submitted' },
      }]);
      return query([]);
    });
    respond({ receive_po_items: () => ({ data: { receiving_record_ids: ['receipt-a'] }, error: null }) });
    const removeItem = Storage.prototype.removeItem;
    const cleanupSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (this === window.sessionStorage && key.startsWith('crx:uncertain-mutation-ack:v1:')) {
        throw new Error('Acknowledgment cleanup blocked');
      }
      return removeItem.call(this, key);
    });
    await renderPage();
    const refreshesBefore = callsTo('get_inventory_position').length;
    fireEvent.click(screen.getAllByRole('button', { name: 'Receive Shipment' })[0]);
    const dialog = await screen.findByRole('dialog', { name: /receive.*shipment/i });
    fireEvent.change(within(dialog).getByLabelText(/purchase order/i), { target: { value: 'receive-line-a' } });
    fireEvent.change(within(dialog).getByLabelText(/quantity received/i), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^receive$/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Received 3 units'));
    expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringContaining('receipt was saved'));
    expect(mocks.toast.mock.calls.filter(([kind]) => kind === 'error')).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /receive.*shipment/i })).toBeNull());
    await waitFor(() => expect(callsTo('get_inventory_position').length).toBeGreaterThan(refreshesBefore));
    const first = callsTo('receive_po_items')[0];
    const acknowledgmentKey = Object.keys(window.sessionStorage).find((key) => key.startsWith('crx:uncertain-mutation-ack:v1:'));
    expect(acknowledgmentKey).toBeDefined();
    expect(window.sessionStorage.getItem(acknowledgmentKey!)).toContain(first.p_idempotency_key as string);
    cleanupSpy.mockRestore();
    fireEvent.click(screen.getAllByRole('button', { name: 'Receive Shipment' })[0]);
    const retryDialog = await screen.findByRole('dialog', { name: /receive.*shipment/i });
    expect(within(retryDialog).getByLabelText(/quantity received/i)).toHaveValue(3);
    expect(within(retryDialog).getByLabelText(/quantity received/i)).toBeDisabled();
    fireEvent.click(within(retryDialog).getByRole('button', { name: /retry exact receiving/i }));
    await waitFor(() => expect(callsTo('receive_po_items')).toHaveLength(2));
    expect(callsTo('receive_po_items')[1]).toEqual(first);
  });

  it('retries a lost adjustment under the SAME key and payload, and refuses to close or edit meanwhile', async () => {
    let attempts = 0;
    respond({
      adjust_inventory: () => {
        attempts += 1;
        return attempts === 1
          ? { data: null, error: LOST_REPLY }
          : { data: { status: 'adjusted', new_quantity: 150 }, error: null };
      },
    });
    await renderPage();

    const dialog = await openAdjustForRow(0);
    fireEvent.change(within(dialog).getByLabelText(/adjustment quantity/i), { target: { value: '50' } });
    fireEvent.change(within(dialog).getByLabelText(/^note$/i), { target: { value: 'cycle count' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^apply adjustment$/i }));

    // First attempt goes out, reply is lost.
    await waitFor(() => expect(callsTo('adjust_inventory')).toHaveLength(1));
    const first = callsTo('adjust_inventory')[0];
    expect(first.p_inventory_id).toBe('inv-a');
    expect(first.p_delta).toBe(50);
    expect(typeof first.p_idempotency_key).toBe('string');

    // The dialog is now locked: still open, inputs frozen, cannot be dismissed.
    await waitFor(() => expect(within(adjustDialog()).getByRole('button', { name: /retry exact adjustment/i })).toBeInTheDocument());
    const locked = adjustDialog();
    expect(within(locked).getByLabelText(/adjustment quantity/i)).toBeDisabled();
    expect(within(locked).getByLabelText(/^note$/i)).toBeDisabled();
    expect(within(locked).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(adjustDialog()).toBeInTheDocument();

    // The natural retry re-sends the exact request under the exact key.
    fireEvent.click(within(locked).getByRole('button', { name: /retry exact adjustment/i }));
    await waitFor(() => expect(callsTo('adjust_inventory')).toHaveLength(2));
    const second = callsTo('adjust_inventory')[1];
    expect(second.p_idempotency_key).toBe(first.p_idempotency_key);
    expect(second.p_inventory_id).toBe('inv-a');
    expect(second.p_delta).toBe(50);
    expect(second.p_reason).toBe('cycle count');

    // Confirmed success releases the lock and closes the dialog.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /manual.*adjustment/i })).not.toBeInTheDocument());
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Adjusted by 50 units');
  });

  it.each([
    { operation: 'adjust_inventory', fault: 'mirror' },
    { operation: 'create_inventory_hold', fault: 'mirror' },
    { operation: 'adjust_inventory', fault: 'acknowledgment' },
    { operation: 'create_inventory_hold', fault: 'acknowledgment' },
  ] as const)(
    'reports confirmed $operation success and refreshes when cleanup fails in $fault',
    async ({ operation, fault }) => {
      const originalSetItem = Storage.prototype.setItem;
      const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (fault === 'mirror' && this === window.localStorage && key.startsWith('crx:uncertain-mutation:v4:') && JSON.parse(value).status === 'resolved') {
          throw new DOMException('resolved mirror quota exhausted', 'QuotaExceededError');
        }
        originalSetItem.call(this, key, value);
      });
      const originalRemoveItem = Storage.prototype.removeItem;
      const acknowledgementStorage = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
        if (fault === 'acknowledgment' && this === window.sessionStorage && key.startsWith('crx:uncertain-mutation-ack:v1:')) {
          throw new DOMException('acknowledgment removal unavailable', 'SecurityError');
        }
        originalRemoveItem.call(this, key);
      });
      respond({ [operation]: () => ({ data: operation === 'adjust_inventory' ? { status: 'adjusted', new_quantity: 150 } : { hold_id: 'hold-saved' }, error: null }) });
      await renderPage();
      const beforeRefresh = callsTo('get_inventory_position').length;
      let dialog: HTMLElement;
      if (operation === 'adjust_inventory') {
        dialog = await openAdjustForRow(0);
        fireEvent.change(within(dialog).getByLabelText(/adjustment quantity/i), { target: { value: '50' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /^apply adjustment$/i }));
      } else {
        fireEvent.click(screen.getByRole('button', { name: /create hold/i }));
        dialog = screen.getByRole('dialog', { name: /create.*hold/i });
        fireEvent.click(await within(dialog).findByRole('button', { name: /SKU-A/i }));
        fireEvent.change(within(dialog).getByLabelText(/^quantity$/i), { target: { value: '3' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /^create hold$/i }));
      }
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', operation === 'adjust_inventory' ? 'Adjusted by 50 units' : 'Hold created successfully'));
      expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringContaining('was saved'));
      expect(mocks.toast.mock.calls.filter(([variant]) => variant === 'error')).toEqual([]);
      await waitFor(() => expect(callsTo('get_inventory_position').length).toBeGreaterThan(beforeRefresh));
      const committed = callsTo(operation)[0];
      storage.mockRestore();
      acknowledgementStorage.mockRestore();
      if (operation === 'adjust_inventory') {
        dialog = await openAdjustForRow(0);
      } else {
        fireEvent.click(screen.getByRole('button', { name: /create hold/i }));
        dialog = screen.getByRole('dialog', { name: /create.*hold/i });
      }
      const retry = within(dialog).getByRole('button', { name: operation === 'adjust_inventory' ? /retry exact adjustment/i : /retry exact hold/i });
      await waitFor(() => expect(retry).toBeEnabled());
      fireEvent.click(retry);
      await waitFor(() => expect(callsTo(operation)).toHaveLength(2));
      expect(callsTo(operation)[1]).toEqual(committed);
    },
  );

  it('cannot re-aim a locked adjustment at a different row', async () => {
    let attempts = 0;
    respond({
      adjust_inventory: () => {
        attempts += 1;
        return attempts === 1
          ? { data: null, error: LOST_REPLY }
          : { data: { status: 'adjusted', new_quantity: 90 }, error: null };
      },
    });
    await renderPage();

    const dialog = await openAdjustForRow(0);
    fireEvent.change(within(dialog).getByLabelText(/adjustment quantity/i), { target: { value: '-10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^apply adjustment$/i }));
    await waitFor(() => expect(callsTo('adjust_inventory')).toHaveLength(1));
    await waitFor(() => expect(within(adjustDialog()).getByRole('button', { name: /retry exact adjustment/i })).toBeInTheDocument());

    // Operator clicks Manual Adjustment on row B while row A's request is unresolved.
    fireEvent.click(screen.getAllByRole('button', { name: 'Manual Adjustment' })[1]);
    fireEvent.click(within(adjustDialog()).getByRole('button', { name: /retry exact adjustment/i }));

    await waitFor(() => expect(callsTo('adjust_inventory')).toHaveLength(2));
    const [first, second] = callsTo('adjust_inventory');
    expect(second.p_inventory_id).toBe('inv-a');
    expect(second.p_delta).toBe(-10);
    expect(second.p_idempotency_key).toBe(first.p_idempotency_key);
  });

  it('a positively rejected adjustment is released, so the next attempt is a genuinely new request', async () => {
    let attempts = 0;
    respond({
      adjust_inventory: () => {
        attempts += 1;
        return attempts === 1
          // RAISE EXCEPTION → SQLSTATE P0001: the server definitely refused.
          ? { data: null, error: { code: 'P0001', message: 'Adjustment would result in negative inventory' } }
          : { data: { status: 'adjusted', new_quantity: 50 }, error: null };
      },
    });
    await renderPage();

    const dialog = await openAdjustForRow(0);
    fireEvent.change(within(dialog).getByLabelText(/adjustment quantity/i), { target: { value: '-500' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^apply adjustment$/i }));
    await waitFor(() => expect(callsTo('adjust_inventory')).toHaveLength(1));

    // Not locked: the operator can correct the number and try again.
    await waitFor(() => expect(within(adjustDialog()).getByLabelText(/adjustment quantity/i)).not.toBeDisabled());
    expect(within(adjustDialog()).getByRole('button', { name: /^apply adjustment$/i })).toBeInTheDocument();
    fireEvent.change(within(adjustDialog()).getByLabelText(/adjustment quantity/i), { target: { value: '-50' } });
    fireEvent.click(within(adjustDialog()).getByRole('button', { name: /^apply adjustment$/i }));

    await waitFor(() => expect(callsTo('adjust_inventory')).toHaveLength(2));
    const [first, second] = callsTo('adjust_inventory');
    expect(second.p_delta).toBe(-50);
    expect(second.p_idempotency_key).not.toBe(first.p_idempotency_key);
  });

  it('retries a lost hold under the SAME key and payload with the form frozen', async () => {
    let attempts = 0;
    respond({
      create_inventory_hold: () => {
        attempts += 1;
        return attempts === 1
          ? { data: null, error: LOST_REPLY }
          : { data: { hold_id: 'hold-1' }, error: null };
      },
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /create hold/i }));
    const dialog = screen.getByRole('dialog', { name: /create.*hold/i });
    fireEvent.click(await within(dialog).findByRole('button', { name: /SKU-A/i }));
    fireEvent.change(within(dialog).getByLabelText(/^quantity$/i), { target: { value: '3' } });
    fireEvent.change(within(dialog).getByLabelText(/notes/i), { target: { value: 'spring burndown' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create hold$/i }));

    await waitFor(() => expect(callsTo('create_inventory_hold')).toHaveLength(1));
    const first = callsTo('create_inventory_hold')[0];
    expect(first.p_product_id).toBe('product-a');
    expect(first.p_quantity).toBe(3);

    const holdDialog = () => screen.getByRole('dialog', { name: /create.*hold/i });
    await waitFor(() => expect(within(holdDialog()).getByRole('button', { name: /retry exact hold/i })).toBeInTheDocument());
    expect(within(holdDialog()).getByLabelText(/^quantity$/i)).toBeDisabled();
    expect(within(holdDialog()).getByLabelText(/notes/i)).toBeDisabled();
    expect(within(holdDialog()).getByRole('button', { name: /^cancel$/i })).toBeDisabled();

    await waitFor(() => expect(within(holdDialog()).getByRole('button', { name: /retry exact hold/i })).toBeEnabled());
    fireEvent.click(within(holdDialog()).getByRole('button', { name: /retry exact hold/i }));
    await waitFor(() => expect(callsTo('create_inventory_hold')).toHaveLength(2));
    const second = callsTo('create_inventory_hold')[1];
    expect(second.p_idempotency_key).toBe(first.p_idempotency_key);
    expect(second.p_product_id).toBe('product-a');
    expect(second.p_quantity).toBe(3);
    expect(second.p_notes).toBe('spring burndown');
    expect(second.p_force).toBe(false);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /create.*hold/i })).not.toBeInTheDocument());
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Hold created successfully');
  });

  it.each(['none', 'customers', 'products', 'inactive-product'] as const)('preserves frozen hold IDs on reload with unavailable lookup: %s', async (lookupFailure) => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') return query(products);
      if (table === 'customers') return query([{ id: 'customer-a', farm_name: 'Farm A' }]);
      return query([]);
    });
    let attempts = 0;
    respond({
      create_inventory_hold: () => ++attempts === 1
        ? { data: null, error: LOST_REPLY }
        : { data: { hold_id: 'hold-1' }, error: null },
    });
    const initial = await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /create hold/i }));
    const dialog = screen.getByRole('dialog', { name: /create.*hold/i });
    fireEvent.click(await within(dialog).findByRole('button', { name: /SKU-A/i }));
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'customer-a' } });
    fireEvent.change(within(dialog).getByLabelText(/^quantity$/i), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create hold$/i }));
    await within(dialog).findByRole('button', { name: /retry exact hold/i });
    const original = callsTo('create_inventory_hold')[0];
    initial.unmount();
    if (lookupFailure !== 'none') {
      mocks.from.mockImplementation((table: string) => {
        if (table === 'products') {
          if (lookupFailure === 'products') return query([], { message: 'product lookup unavailable' });
          return query(lookupFailure === 'inactive-product' ? [] : products);
        }
        if (table === 'customers') return lookupFailure === 'customers'
          ? query([], { message: 'customer lookup unavailable' })
          : query([{ id: 'customer-a', farm_name: 'Farm A' }]);
        return query([]);
      });
    }

    await renderPage();
    const recovered = screen.getByRole('dialog', { name: /create.*hold/i });
    if (lookupFailure === 'products' || lookupFailure === 'inactive-product') {
      expect(await within(recovered).findByText('Saved product (name unavailable)')).toBeInTheDocument();
      expect(within(recovered).queryByText('No products found')).not.toBeInTheDocument();
    } else {
      expect(await within(recovered).findByRole('button', { name: /SKU-A/i })).toBeInTheDocument();
    }
    expect(await within(recovered).findByRole('option', {
      name: lookupFailure === 'customers' ? 'Saved customer (name unavailable)' : 'Farm A',
    })).toHaveProperty('selected', true);
    if (lookupFailure === 'customers') {
      expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringContaining('Customer names could not be loaded'));
    }
    if (lookupFailure === 'products') {
      expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringContaining('Failed to load products'));
    }
    expect(within(recovered).getByRole('combobox')).toBeDisabled();
    expect(callsTo('create_inventory_hold')).toHaveLength(1);
    fireEvent.click(within(recovered).getByRole('button', { name: /retry exact hold/i }));
    await waitFor(() => expect(callsTo('create_inventory_hold')).toHaveLength(2));
    expect(callsTo('create_inventory_hold')[1]).toMatchObject({
      p_product_id: original.p_product_id,
      p_customer_id: original.p_customer_id,
      p_quantity: original.p_quantity,
      p_idempotency_key: original.p_idempotency_key,
    });
  });

  it.each(['adjust_inventory', 'create_inventory_hold'] as const)(
    'allows dismissing another tab\'s %s dialog while retaining its frozen key and blocking mutations',
    async (operation) => {
      respond({ [operation]: () => ({ data: null, error: LOST_REPLY }) });
      const initial = await renderPage();
      let dialog: HTMLElement;
      if (operation === 'adjust_inventory') {
        dialog = await openAdjustForRow(0);
        fireEvent.change(within(dialog).getByLabelText(/adjustment quantity/i), { target: { value: '50' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /^apply adjustment$/i }));
      } else {
        fireEvent.click(screen.getByRole('button', { name: /create hold/i }));
        dialog = screen.getByRole('dialog', { name: /create.*hold/i });
        fireEvent.click(await within(dialog).findByRole('button', { name: /SKU-A/i }));
        fireEvent.change(within(dialog).getByLabelText(/^quantity$/i), { target: { value: '3' } });
        fireEvent.click(within(dialog).getByRole('button', { name: /^create hold$/i }));
      }
      await waitFor(() => expect(callsTo(operation)).toHaveLength(1));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: /retry exact/i })).toBeEnabled());
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(operation === 'adjust_inventory' ? 'error' : 'warning', expect.any(String)));
      initial.unmount();
      // A second tab has neither this page's acknowledgment nor its claim.
      window.sessionStorage.clear();
      globalThis.indexedDB = new IDBFactory();
      const key = `crx:uncertain-mutation:v4:${JSON.stringify([operation, 'admin-1'])}`;
      const frozen = { ...JSON.parse(window.localStorage.getItem(key)!), surface: 'another-page', claimTabIds: ['another-tab'] };
      window.localStorage.setItem(key, JSON.stringify(frozen));
      await renderPage();
      const reopen = async () => {
        if (operation === 'adjust_inventory') return openAdjustForRow(0);
        fireEvent.click(screen.getByRole('button', { name: /create hold/i }));
        return screen.getByRole('dialog', { name: /create.*hold/i });
      };
      dialog = await reopen();
      expect(within(dialog).getByRole('button', { name: /retry exact/i })).toBeDisabled();
      if (operation === 'create_inventory_hold') {
        await within(dialog).findByRole('button', { name: /SKU-A/i });
      }
      expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeEnabled();
      fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      dialog = await reopen();
      expect(within(dialog).getByRole('button', { name: /retry exact/i })).toBeDisabled();
      expect(callsTo(operation)).toHaveLength(1);
      expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(frozen);
    },
  );

  it('retries a lost ADMIN OVERRIDE under the SAME key with the frozen force flag and reason', async () => {
    let attempts = 0;
    respond({
      create_inventory_hold: () => {
        attempts += 1;
        if (attempts === 1) {
          return { data: null, error: { code: 'P0001', message: 'INSUFFICIENT_HOLD_INVENTORY: only 2 units are free' } };
        }
        return attempts === 2
          ? { data: null, error: LOST_REPLY }
          : { data: { hold_id: 'hold-1' }, error: null };
      },
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /create hold/i }));
    const dialog = screen.getByRole('dialog', { name: /create.*hold/i });
    fireEvent.click(await within(dialog).findByRole('button', { name: /SKU-A/i }));
    fireEvent.change(within(dialog).getByLabelText(/^quantity$/i), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create hold$/i }));

    // The server refuses for stock, so the admin override dialog opens.
    const forceDialog = await screen.findByRole('dialog', { name: /force-create hold/i });
    fireEvent.change(within(forceDialog).getByLabelText(/reason/i), { target: { value: 'physical stock confirmed' } });
    fireEvent.click(within(forceDialog).getByRole('button', { name: /force-create hold/i }));

    await waitFor(() => expect(callsTo('create_inventory_hold')).toHaveLength(2));
    const forced = callsTo('create_inventory_hold')[1];
    expect(forced.p_force).toBe(true);
    expect(forced.p_force_reason).toBe('physical stock confirmed');

    // The forced reply was lost. The only way forward is the ordinary retry
    // button, which must re-send the override, not a plain hold.
    const holdDialog = () => screen.getByRole('dialog', { name: /^create.*hold$/i });
    await waitFor(() => expect(within(holdDialog()).getByRole('button', { name: /retry exact hold/i })).toBeInTheDocument());
    await waitFor(() => expect(within(holdDialog()).getByRole('button', { name: /retry exact hold/i })).toBeEnabled());
    fireEvent.click(within(holdDialog()).getByRole('button', { name: /retry exact hold/i }));

    await waitFor(() => expect(callsTo('create_inventory_hold')).toHaveLength(3));
    const retry = callsTo('create_inventory_hold')[2];
    expect(retry.p_idempotency_key).toBe(forced.p_idempotency_key);
    expect(retry.p_force).toBe(true);
    expect(retry.p_force_reason).toBe('physical stock confirmed');
    expect(retry.p_product_id).toBe('product-a');
    expect(retry.p_quantity).toBe(3);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^create.*hold$/i })).not.toBeInTheDocument());
    expect(mocks.toast).toHaveBeenCalledWith('success', 'Hold created with admin override');
  });

  it('retire keeps one key per row: a lost reply retries the same key, a different row gets its own', async () => {
    let attempts = 0;
    respond({
      retire_inventory_item: () => {
        attempts += 1;
        // Attempt 1 (row A) is lost; every later attempt succeeds.
        return attempts === 1
          ? { data: null, error: LOST_REPLY }
          : { data: { status: 'retired' }, error: null };
      },
    });
    await renderPage();

    const confirmDelete = async () => {
      const dialog = await screen.findByRole('dialog', { name: /delete inventory item/i });
      fireEvent.click(within(dialog).getByRole('button', { name: /^delete item$/i }));
    };

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete Inventory Item' })[0]);
    await confirmDelete();
    await waitFor(() => expect(callsTo('retire_inventory_item')).toHaveLength(1));

    // Row A again after the lost reply: same key, so the server replays its receipt.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete Inventory Item' })[0]);
    await confirmDelete();
    await waitFor(() => expect(callsTo('retire_inventory_item')).toHaveLength(2));

    // Row B: its own key, never row A's receipt.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete Inventory Item' })[1]);
    await confirmDelete();
    await waitFor(() => expect(callsTo('retire_inventory_item')).toHaveLength(3));

    const [first, second, third] = callsTo('retire_inventory_item');
    expect(first.p_inventory_id).toBe('inv-a');
    expect(second.p_inventory_id).toBe('inv-a');
    expect(second.p_idempotency_key).toBe(first.p_idempotency_key);
    expect(third.p_inventory_id).toBe('inv-b');
    expect(third.p_idempotency_key).not.toBe(first.p_idempotency_key);
  });
});
