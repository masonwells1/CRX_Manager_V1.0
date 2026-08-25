/**
 * Orders.pickListShortage.test.tsx — CRX draw-down tier split, P2.
 *
 * Draw-down splits a booking across price tiers, so one product can occupy
 * SEVERAL lines on the same order. The pick list used to flag a shortage by
 * comparing each line on its own against the product's whole net-free stock,
 * so two half-sized tier lines both looked covered while together they
 * exceeded what was on hand — the warning went quiet on exactly the orders the
 * tier split creates.
 *
 * This drives the real page: it clicks Print Pick Lists and inspects the
 * PickListData the page hands the PDF writer. Mutating
 * src/lib/inventoryShortage.ts back to per-line comparison turns the first
 * case red.
 */
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PickListData } from '../lib/orderPickListPdf';

const { mockFrom, mockToast, mockDownloadPickList, selectedOrder, tables } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockDownloadPickList: vi.fn(),
  selectedOrder: {
    id: 'order-1',
    order_number: 'ORD-TIER-1',
    order_name: null,
    order_date: '2026-08-17',
    customer_id: 'customer-1',
    status: 'confirmed',
    notes: null,
    program_notes: null,
  },
  tables: { data: {} as Record<string, unknown[]> },
}));

type QueryResult = { data: unknown; error: { message: string } | null };
type QueryChain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<QueryResult>;

function buildChain(result: QueryResult): QueryChain {
  const self: Record<string, unknown> = {};
  for (const method of [
    'select', 'update', 'eq', 'gte', 'lte', 'is', 'in', 'not', 'order', 'limit',
  ]) {
    self[method] = vi.fn(() => self);
  }
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  return self as QueryChain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom },
  checkMutationResult: vi.fn(),
  sanitizeError: (error: unknown) => (error instanceof Error ? error.message : 'Request failed'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', deniedPages: [] }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useRowSelection', () => ({
  useRowSelection: () => ({
    selected: new Set(['order-1']),
    toggleSelect: vi.fn(),
    toggleAll: vi.fn(),
    clearSelection: vi.fn(),
    selectedCount: 1,
    selectedRows: [selectedOrder],
    allSelected: true,
  }),
  createCheckboxColumn: () => ({ key: 'select', header: '' }),
}));

vi.mock('../components/ui/PageHeader', () => ({
  default: ({ actions }: { actions?: ReactNode }) => <div>{actions}</div>,
}));
vi.mock('../components/ui/DataTable', () => ({ default: () => <div>orders table</div> }));
vi.mock('../components/ui/BulkDeleteConfirmModal', () => ({ default: () => null }));
vi.mock('../components/orders/BulkOrderImport', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerDrawer', () => ({ default: () => null }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/orderPickListPdf', () => ({
  downloadBatchPickListPdf: mockDownloadPickList,
}));

import Orders from './Orders';

/** One product, two tier lines — exactly what draw-down produces. */
function tierSplitLines() {
  return [
    {
      order_id: 'order-1',
      product_id: 'product-1',
      product_name: 'Tier Split Concentrate',
      unit_size: 'gal',
      total_units_needed: 6,
      quantity_delivered: 0,
      quantity_remaining: 6,
      price_per_unit: 10,
    },
    {
      order_id: 'order-1',
      product_id: 'product-1',
      product_name: 'Tier Split Concentrate',
      unit_size: 'gal',
      total_units_needed: 6,
      quantity_delivered: 0,
      quantity_remaining: 6,
      price_per_unit: 8,
    },
  ];
}

async function printPickList(): Promise<PickListData[]> {
  mockFrom.mockImplementation((table: string) =>
    buildChain({ data: tables.data[table] ?? [], error: null }));

  render(<MemoryRouter><Orders /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /Print Pick Lists/i }));

  await waitFor(() => expect(mockDownloadPickList).toHaveBeenCalled());
  return mockDownloadPickList.mock.calls[0][0] as PickListData[];
}

describe('Orders pick list — shortage across tier-split lines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tables.data = {
      orders: [],
      order_items: tierSplitLines(),
      customers: [{
        id: 'customer-1', farm_name: 'Tier Farm',
        contact_name: null, phone: null, billing_address: null,
      }],
      customer_addresses: [],
      inventory: [],
      invoices: [],
      deliveries: [],
    };
  });

  it('flags a shortage when two tier lines of one product together exceed stock', async () => {
    // 10 net free; neither 6-unit line exceeds it alone, but 12 together do.
    tables.data.inventory = [
      { product_id: 'product-1', quantity_available: 10, quantity_prebooked: 0 },
    ];

    const [pickList] = await printPickList();

    expect(pickList.items).toHaveLength(2);
    expect(pickList.items.map((i) => i.has_shortage)).toEqual([true, true]);
  });

  it('stays quiet when the same two lines are genuinely covered', async () => {
    tables.data.inventory = [
      { product_id: 'product-1', quantity_available: 20, quantity_prebooked: 0 },
    ];

    const [pickList] = await printPickList();

    expect(pickList.items.map((i) => i.has_shortage)).toEqual([false, false]);
  });

  it('still counts prebooked stock against the combined need', async () => {
    // 20 on hand, 9 already spoken for -> 11 net free against a 12-unit need.
    tables.data.inventory = [
      { product_id: 'product-1', quantity_available: 20, quantity_prebooked: 9 },
    ];

    const [pickList] = await printPickList();

    expect(pickList.items.map((i) => i.has_shortage)).toEqual([true, true]);
  });
});
