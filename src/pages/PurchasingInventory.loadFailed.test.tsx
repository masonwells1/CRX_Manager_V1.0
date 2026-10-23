/**
 * PurchasingInventory.loadFailed.test.tsx — To-Do 10.5, purchasing / inventory /
 * receiving: a read that fails (an error, or no list at all) says "could not be
 * loaded" with Try again, never "No … found", zero on hand, $0 outstanding, or an
 * empty count with a live Complete button; Try again shows the rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { IDBFactory } from 'fake-indexeddb';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, unknown>,
  // Table or function name -> how its reads fail.
  failing: new Map<string, 'error' | 'nodata'>(),
  toast: vi.fn(),
}));

// A query that ignores its filters and answers with the given rows (or a failure).
function fixedQuery(reply: { data: unknown; error: unknown; count: number | null }): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(reply);
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => Promise.resolve({
          data: Array.isArray(reply.data) ? (reply.data[0] ?? null) : reply.data,
          error: reply.error,
        });
      }
      return () => q;
    },
  });
  return q;
}

function replyFor(name: string, rows: unknown): { data: unknown; error: unknown; count: number | null } {
  const mode = H.failing.get(name);
  if (mode === 'error') return { data: null, error: { message: 'connection reset' }, count: null };
  if (mode === 'nodata') return { data: null, error: null, count: null };
  return { data: rows, error: null, count: Array.isArray(rows) ? rows.length : null };
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = {
    from: (table: string) => fixedQuery(replyFor(table, H.tables[table] ?? [])),
    rpc: (name: string) => fixedQuery(replyFor(name, H.functions[name] ?? [])),
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked' }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn(), getKeyFor: () => 'idem', resetKeyFor: vi.fn() }),
}));

import PurchaseOrders from './PurchaseOrders';
import PurchaseOrderDetail from './PurchaseOrderDetail';
import NewPurchaseOrder from './NewPurchaseOrder';
import InventoryPage from './InventoryPage';
import CycleCounts from './CycleCounts';
import ReceivingHubPanel from '../components/receiving/ReceivingHubPanel';
import ReceivingLogPanel from '../components/receiving/ReceivingLogPanel';
import QuickReceivePanel from '../components/receiving/QuickReceivePanel';
import TransactionLedgerModal from '../components/inventory/TransactionLedgerModal';

const at = (path: string, node: React.ReactNode) => render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
const tryAgain = () => fireEvent.click(screen.getAllByRole('button', { name: /Try again/ })[0]);

const po = { id: 'po1', po_number: 'PO-1001', vendor: 'Acme Chem', status: 'submitted', created_at: '2026-10-01T12:00:00Z', expected_delivery_date: null, total_cost: 50 };
const poLine = {
  id: 'poi1', purchase_order_id: 'po1', product_id: 'p1', product_name: 'Widget 2.5 GL', quantity_ordered: 10, quantity_received: 0,
  unit_cost: 5, unit_size: '2.5 GL', product: { id: 'p1', product_name: 'Widget 2.5 GL' },
  purchase_orders: { po_number: 'PO-1001', vendor: 'Acme Chem', status: 'submitted', expected_delivery_date: null },
};
const position = {
  inventory_id: 'inv-a', product_id: 'p1', product_name: 'Widget 2.5 GL', sku: 'W-1', location: 'Main Warehouse', unit_size: '2.5 GL',
  inventory_unit: 'GAL', container_size: 2.5, container_type: 'Jug', vendor: 'Acme Chem', current_cost: 10,
  quantity_available: 40, quantity_prebooked: 0, quantity_on_order: 10, holds_qty: 0, job_holds_qty: 0, planned_qty: 0,
  net_position: 50, delivered_ytd: 0, reorder_point: 0, min_stock_level: 0, is_low_stock: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.indexedDB = new IDBFactory();
  H.failing = new Map();
  H.tables = {};
  H.functions = { get_admin_cost_fields: {} };
});
afterEach(cleanup);

describe('Purchase Orders list', () => {
  it.each(['error', 'nodata'] as const)('a %s read says it could not be loaded, not "No purchase orders", and Try again shows them', async (mode) => {
    H.failing.set('purchase_orders', mode);
    at('/purchase-orders', <PurchaseOrders />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No purchase orders')).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting Receipt')).not.toBeInTheDocument();

    H.failing.delete('purchase_orders');
    H.tables.purchase_orders = [po];
    tryAgain();
    expect(await screen.findByText('PO-1001')).toBeInTheDocument();
  });

  it.each(['error', 'nodata'] as const)('a %s outstanding-items read is not "All PO items have been fully received" and $0', async (mode) => {
    H.tables.purchase_orders = [po];
    H.failing.set('purchase_order_items', mode);
    at('/purchase-orders', <PurchaseOrders />);
    expect(await screen.findByText('PO-1001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Outstanding Items/ }));
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('All PO items have been fully received')).not.toBeInTheDocument();
    expect(screen.queryByText('Outstanding Value')).not.toBeInTheDocument();

    H.failing.delete('purchase_order_items');
    H.tables.purchase_order_items = [poLine];
    tryAgain();
    expect(await screen.findByText('Widget 2.5 GL')).toBeInTheDocument();
  });
});

describe('Purchase Order detail', () => {
  const detail = () => at('/purchase-orders/po1', <Routes><Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} /></Routes>);

  it('a failed purchase order read says it could not be loaded, not "Purchase order not found"', async () => {
    H.failing.set('purchase_orders', 'error');
    detail();
    expect(await screen.findByText('This purchase order could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Purchase order not found')).not.toBeInTheDocument();

    H.failing.delete('purchase_orders');
    H.tables.purchase_orders = [po];
    H.tables.purchase_order_items = [poLine];
    tryAgain();
    expect((await screen.findAllByText(/PO-1001/)).length).toBeGreaterThan(0);
  });

  it('a purchase order that is missing or hidden still says "Purchase order not found"', async () => {
    H.failing.set('purchase_orders', 'nodata');
    detail();
    expect(await screen.findByText('Purchase order not found')).toBeInTheDocument();
    expect(screen.queryByText('This purchase order could not be loaded')).not.toBeInTheDocument();
  });

  it.each(['error', 'nodata'] as const)('a %s line read fails the page instead of a header over no lines', async (mode) => {
    H.tables.purchase_orders = [po];
    H.failing.set('purchase_order_items', mode);
    detail();
    expect(await screen.findByText('This purchase order could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Receive Items/ })).not.toBeInTheDocument();
  });

  it.each(['error', 'nodata'] as const)('a %s receiving-history read is not "No items have been received yet."', async (mode) => {
    H.tables.purchase_orders = [po];
    H.tables.purchase_order_items = [poLine];
    H.failing.set('receiving_records', mode);
    detail();
    expect(await screen.findByText('The receiving history could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No items have been received yet.')).not.toBeInTheDocument();

    H.failing.delete('receiving_records');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('No items have been received yet.')).toBeInTheDocument();
  });
});

describe('New Purchase Order', () => {
  it('a product catalog read with no list is a failure, not an empty catalog', async () => {
    H.failing.set('products', 'nodata');
    at('/purchase-orders/new', <NewPurchaseOrder />);
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Failed to load Products')));

    H.failing.delete('products');
    H.tables.products = [{ id: 'p1', product_name: 'Widget 2.5 GL', is_active: true, vendor: 'Acme Chem' }];
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument());
  });
});

describe('Receiving', () => {
  it.each(['error', 'nodata'] as const)('a %s inbound-PO read on the hub is not "Nothing on order", and Try again shows them', async (mode) => {
    H.functions.get_inventory_position = [position];
    H.failing.set('purchase_orders', mode);
    at('/receiving', <ReceivingHubPanel />);
    expect(await screen.findByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.queryByText('Nothing on order')).not.toBeInTheDocument();

    H.failing.delete('purchase_orders');
    H.tables.purchase_orders = [{ ...po, items: [poLine] }];
    tryAgain();
    expect((await screen.findAllByText('Widget 2.5 GL')).length).toBeGreaterThan(0);
  });

  it.each(['error', 'nodata'] as const)('a %s receiving-log read is not "No receiving records", and Try again shows the rows', async (mode) => {
    H.functions.get_receiving_summary = { expected_today: 0, pending_receipt: 0, received_this_week: 0, received_ytd: 0, damaged_this_week: 0 };
    H.failing.set('get_receiving_log', mode);
    at('/receiving?tab=log', <ReceivingLogPanel />);
    expect((await screen.findAllByText('The receiving log could not be loaded')).length).toBeGreaterThan(0);
    expect(screen.queryByText('No receiving records')).not.toBeInTheDocument();

    H.failing.delete('get_receiving_log');
    H.functions.get_receiving_log = [{ id: 'r1', purchase_order_id: 'po1', po_number: 'PO-1001', vendor: 'Acme Chem', product_name: 'Widget 2.5 GL', quantity_received: 5, condition: 'good', received_at: '2026-10-20T12:00:00Z' }];
    tryAgain();
    expect((await screen.findAllByText('PO-1001')).length).toBeGreaterThan(0);
  });

  it('a failed receiving-totals read says so instead of hiding the damaged-goods alert', async () => {
    H.failing.set('get_receiving_summary', 'error');
    at('/receiving?tab=log', <ReceivingLogPanel />);
    expect(await screen.findByText(/The receiving totals could not be loaded/)).toBeInTheDocument();

    H.failing.delete('get_receiving_summary');
    H.functions.get_receiving_summary = { expected_today: 0, pending_receipt: 0, received_this_week: 0, received_ytd: 0, damaged_this_week: 2 };
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.queryByText(/The receiving totals could not be loaded/)).not.toBeInTheDocument());
  });

  it('a Quick Receive catalog read with no list is a failure, not "No products found"', async () => {
    H.failing.set('products', 'nodata');
    at('/receiving?tab=quick', <QuickReceivePanel />);
    expect(await screen.findByText(/Products could not be loaded, so items cannot be added or matched/)).toBeInTheDocument();
  });
});

describe('Inventory', () => {
  it.each(['error', 'nodata'] as const)('a %s stock read says it could not be loaded, not zero on hand, and Try again shows the stock', async (mode) => {
    H.failing.set('get_inventory_position', mode);
    at('/inventory', <InventoryPage />);
    expect((await screen.findAllByText('This list could not be loaded')).length).toBeGreaterThan(0);
    expect(screen.queryByText('No inventory records')).not.toBeInTheDocument();
    expect(screen.queryByText('Total on Floor')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Add Inventory/ })).toBeDisabled();

    H.failing.delete('get_inventory_position');
    H.functions.get_inventory_position = [position];
    tryAgain();
    expect((await screen.findAllByText('Widget 2.5 GL')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Total on Floor').length).toBeGreaterThan(0);
  });

  it.each(['error', 'nodata'] as const)('a %s open-PO read in the receive dialog is not "No open purchase orders found", and Try again lists them', async (mode) => {
    H.functions.get_inventory_position = [position];
    H.failing.set('purchase_order_items', mode);
    at('/inventory', <InventoryPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Receive/ }))[0]);
    expect(await screen.findByText('Open purchase orders for this product could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/No open purchase orders found/)).not.toBeInTheDocument();

    H.failing.delete('purchase_order_items');
    H.tables.purchase_order_items = [poLine];
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.queryByText('Open purchase orders for this product could not be loaded.')).not.toBeInTheDocument());
    expect(screen.queryByText(/No open purchase orders found/)).not.toBeInTheDocument();
  });

  it.each(['error', 'nodata'] as const)('a %s holds read says so instead of hiding the holds', async (mode) => {
    H.functions.get_inventory_position = [position];
    H.failing.set('inventory_holds', mode);
    at('/inventory', <InventoryPage />);
    expect(await screen.findByText('Active holds could not be loaded')).toBeInTheDocument();
  });

  it.each(['error', 'nodata'] as const)('a %s forecast read is not "No planned demand data"', async (mode) => {
    H.functions.get_inventory_position = [position];
    H.failing.set('get_inventory_forecast', mode);
    at('/inventory', <InventoryPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Forecast/ }));
    expect(await screen.findByText('The demand forecast could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/No planned demand data/)).not.toBeInTheDocument();
  });

  it.each(['error', 'nodata'] as const)('a %s ledger read in the transaction history does not load forever or say "No transactions"', async (mode) => {
    H.functions.get_inventory_position = [position];
    H.failing.set(mode === 'error' ? 'inventory_transactions' : 'get_inventory_position', mode);
    render(<TransactionLedgerModal open onClose={vi.fn()} productId="p1" productName="Widget 2.5 GL" />);
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).not.toBeInTheDocument());
    expect(screen.queryByText('No transactions found for this product.')).not.toBeInTheDocument();
    expect(screen.getByText(/connection reset|no list|no data/i)).toBeInTheDocument();
  });

  it('a transaction read with no list is a failure, not "No transactions found"', async () => {
    H.functions.get_inventory_position = [position];
    H.failing.set('inventory_transactions', 'nodata');
    render(<TransactionLedgerModal open onClose={vi.fn()} productId="p1" productName="Widget 2.5 GL" />);
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).not.toBeInTheDocument());
    expect(screen.queryByText('No transactions found for this product.')).not.toBeInTheDocument();
    expect(screen.getByText(/no list/i)).toBeInTheDocument();
  });
});

describe('Cycle Counts', () => {
  const count = { id: 'cc1', count_number: 'CC-0007', warehouse: 'Main Warehouse', status: 'in_progress', started_at: '2026-10-20T12:00:00Z', created_at: '2026-10-20T12:00:00Z', item_revision: 1, items: [] };

  it.each(['error', 'nodata'] as const)('a %s list read is not "No cycle counts yet", and Try again shows the counts', async (mode) => {
    H.failing.set('cycle_counts', mode);
    at('/cycle-counts', <CycleCounts />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No cycle counts yet')).not.toBeInTheDocument();

    H.failing.delete('cycle_counts');
    H.tables.cycle_counts = [count];
    tryAgain();
    expect(await screen.findByText('CC-0007')).toBeInTheDocument();
  });

  it.each(['error', 'nodata'] as const)('a %s line read in a count hides Complete & Apply instead of an empty count', async (mode) => {
    H.tables.cycle_counts = [count];
    H.failing.set('cycle_count_items', mode);
    at('/cycle-counts', <CycleCounts />);
    fireEvent.click(await screen.findByText('CC-0007'));
    expect(await screen.findByText("This count's lines could not be loaded")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Complete & Apply Adjustments/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Products:')).not.toBeInTheDocument();

    H.failing.delete('cycle_count_items');
    H.tables.cycle_count_items = [{ id: 'cci1', cycle_count_id: 'cc1', product_id: 'p1', expected_qty: 40, counted_qty: null, variance: null, variance_pct: null, is_counted: false, product: { product_name: 'Widget 2.5 GL' } }];
    tryAgain();
    expect(await screen.findByText('Widget 2.5 GL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Complete & Apply Adjustments/ })).toBeInTheDocument();
  });
});
