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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function query(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'or', 'order', 'in', 'update']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data, error: null }).then(resolve);
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
  render(<MemoryRouter><InventoryPage /></MemoryRouter>);
  // Wait for the grid, so the row action buttons exist.
  await screen.findAllByRole('button', { name: 'Manual Adjustment' });
}

function adjustDialog() {
  return screen.getByRole('dialog', { name: /manual.*adjustment/i });
}

async function openAdjustForRow(index: number) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Manual Adjustment' })[index]);
  return adjustDialog();
}

describe('InventoryPage — a lost reply freezes the request instead of minting a new key', () => {
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
