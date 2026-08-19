/**
 * OrderDetail.pickListShortage.test.tsx — CRX draw-down tier split, P2.
 *
 * The single-order pick list had the same blind spot as the bulk one: a
 * tier-split booking puts one product on SEVERAL order lines, and each line was
 * compared on its own against the product's whole net-free stock, so two
 * half-sized lines both looked covered while together they exceeded what was on
 * hand.
 *
 * This drives the real page: it clicks Print Pick List and inspects the
 * PickListData the page hands the PDF writer. Reverting the per-product summing
 * in src/lib/inventoryShortage.ts turns the first case red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PickListData } from '../lib/orderPickListPdf';

const { mockFrom, mockRpc, mockToast, mockDownloadPickList, tables } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
  mockDownloadPickList: vi.fn(),
  tables: {
    lists: {} as Record<string, unknown[]>,
    singles: {} as Record<string, unknown>,
  },
}));

/**
 * The page reads some tables both ways — `customers` once as a single row for
 * the header and again as a list for the field picker — so the chain has to
 * answer each shape correctly or an unrelated list read explodes mid-test.
 */
function buildChain(list: unknown[], single: unknown): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'range',
    'filter', 'not', 'or', 'and', 'match', 'order', 'limit', 'offset',
    'csv', 'returns', 'textSearch', 'overlaps', 'abortSignal',
  ]) self[m] = method;
  const settle = (data: unknown) => {
    const promise = Promise.resolve({ data, error: null });
    return {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
  };
  self.single = () => settle(single);
  self.maybeSingle = () => settle(single);
  const promise = Promise.resolve({ data: list, error: null });
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: {},
  describePostInvoiceBlock: vi.fn(() => null),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: vi.fn() }));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
}));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../lib/orderPickListPdf', () => ({ downloadPickListPdf: mockDownloadPickList }));

import OrderDetail from './OrderDetail';

const ORDER = {
  id: 'ord-tier', order_number: 'ORD-TIER', status: 'confirmed', customer_id: 'cust-1',
  order_date: '2026-08-17', total_cents: 0, total_cost: 0, total_price: 0,
  total_profit: 0, total_margin_pct: 0, order_name: null, notes: null,
  program_notes: null, created_at: '2026-08-17T00:00:00Z',
  delivery_priority: 'normal', po_number: null, quote_id: null,
};

/** One product, two tier lines — exactly what draw-down produces. */
function tierSplitLines() {
  return [
    {
      id: 'line-a', order_id: 'ord-tier', product_id: 'product-1',
      product_name: 'Tier Split Concentrate', unit_size: 'gal',
      total_units_needed: 6, quantity_delivered: 0, quantity_remaining: 6,
      price_per_unit: 10, pricing_pending: false, section_name: null,
    },
    {
      id: 'line-b', order_id: 'ord-tier', product_id: 'product-1',
      product_name: 'Tier Split Concentrate', unit_size: 'gal',
      total_units_needed: 6, quantity_delivered: 0, quantity_remaining: 6,
      price_per_unit: 8, pricing_pending: false, section_name: null,
    },
  ];
}

async function printPickList(): Promise<PickListData> {
  mockFrom.mockImplementation((table: string) =>
    buildChain(
      (tables.lists[table] ?? []) as unknown[],
      tables.singles[table] ?? null,
    ));

  render(
    <MemoryRouter initialEntries={['/orders/ord-tier']}>
      <Routes><Route path="/orders/:id" element={<OrderDetail />} /></Routes>
    </MemoryRouter>,
  );

  fireEvent.click(await screen.findByRole('button', { name: /Print Pick List/i }));
  await waitFor(() => expect(mockDownloadPickList).toHaveBeenCalled());
  return mockDownloadPickList.mock.calls[0][0] as PickListData;
}

describe('OrderDetail pick list — shortage across tier-split lines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tables.lists = { order_items: tierSplitLines(), customer_addresses: [], inventory: [] };
    tables.singles = {
      orders: ORDER,
      customers: {
        id: 'cust-1', farm_name: 'Tier Farm',
        contact_name: null, phone: null, billing_address: null,
      },
    };
  });

  it('flags a shortage when two tier lines of one product together exceed stock', async () => {
    // 10 net free; neither 6-unit line exceeds it alone, but 12 together do.
    tables.lists.inventory = [
      { product_id: 'product-1', quantity_available: 10, quantity_prebooked: 0 },
    ];

    const pickList = await printPickList();

    expect(pickList.items).toHaveLength(2);
    expect(pickList.items.map((i) => i.has_shortage)).toEqual([true, true]);
  });

  it('stays quiet when the same two lines are genuinely covered', async () => {
    tables.lists.inventory = [
      { product_id: 'product-1', quantity_available: 20, quantity_prebooked: 0 },
    ];

    const pickList = await printPickList();

    expect(pickList.items.map((i) => i.has_shortage)).toEqual([false, false]);
  });

  it('still counts prebooked stock against the combined need', async () => {
    // 20 on hand, 9 already spoken for -> 11 net free against a 12-unit need.
    tables.lists.inventory = [
      { product_id: 'product-1', quantity_available: 20, quantity_prebooked: 9 },
    ];

    const pickList = await printPickList();

    expect(pickList.items.map((i) => i.has_shortage)).toEqual([true, true]);
  });
});
