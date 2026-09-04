/**
 * Deliveries.shortageBadge.test.tsx — page-level delivery safety regressions.
 *
 * The delivery list shows an amber warning triangle when a scheduled delivery
 * asks for more stock than the warehouse holds. It used to check each delivery
 * LINE on its own, so a tier-split product spread over two lines slipped
 * through: neither half exceeded stock, while together they did.
 *
 * This drives the real page and asserts on the badge the operator actually
 * sees. Reverting the per-product summing in src/lib/inventoryShortage.ts turns
 * the first case red.
 *
 * Out of scope, deliberately: this screen compares against `quantity_available`
 * at Main Warehouse and does not subtract prebooked stock. That is a separate,
 * pre-existing choice; only the per-line/per-product basis changed here.
 *
 * This file also drives the real Load Sheet button so delivery-item read failures
 * and empty item sets cannot masquerade as a successfully generated warehouse PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { auth, mockFrom, mockRpc, mockToast, mockCaptureException, mockGenerateBatchDeliveryPdf, tables, queryResults } = vi.hoisted(() => ({
  // Keep the context value stable when Load Sheet toggles page loading state.
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] },
  mockFrom: vi.fn(),
  mockRpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
  mockCaptureException: vi.fn(),
  mockGenerateBatchDeliveryPdf: vi.fn(() => Promise.resolve()),
  tables: { data: {} as Record<string, unknown[]> },
  queryResults: {
    deliveryItemDetails: {
      data: [] as unknown[] | null,
      error: null as unknown,
    },
  },
}));

type QueryResult = { data: unknown[] | null; error: unknown };

function buildChain(
  rows: unknown[],
  selectResult?: (columns: string) => QueryResult | undefined,
): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  let result: QueryResult = { data: rows, error: null };
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'returns', 'abortSignal',
  ]) self[m] = method;
  // mockFrom creates a fresh chain for every query; each query selects once.
  self.select = (columns: unknown) => {
    result = selectResult?.(String(columns)) ?? { data: rows, error: null };
    return self;
  };
  self.then = (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  self.catch = (onRejected: (reason: unknown) => unknown) => Promise.resolve(result).catch(onRejected);
  self.finally = (onFinally: () => void) => Promise.resolve(result).finally(onFinally);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  assertRpcResult: vi.fn((d) => d),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => auth,
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockCaptureException } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyDeliveryCompleted: vi.fn() }));
vi.mock('../lib/deliveryPdf', () => ({ generateBatchDeliveryPdf: mockGenerateBatchDeliveryPdf }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../components/deliveries/BatchCancelModal', () => ({ default: () => null }));
vi.mock('../components/deliveries/QuickDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/deliveries/DeliveryCalendar', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerDrawer', () => ({ default: () => null }));

import Deliveries from './Deliveries';

const DELIVERY = {
  id: 'del-1',
  delivery_number: 'DEL-TIER-1',
  status: 'scheduled',
  scheduled_date: '2026-08-18',
  delivery_date: null,
  customer_id: 'cust-1',
  assigned_driver: null,
  customer: { farm_name: 'Tier Farm', parent_customer_id: null },
};

/** One product, two tier lines on the same delivery. */
function tierSplitItems() {
  return [
    { delivery_id: 'del-1', product_id: 'product-1', quantity: 6 },
    { delivery_id: 'del-1', product_id: 'product-1', quantity: 6 },
  ];
}

async function renderDeliveries(): Promise<number> {
  mockFrom.mockImplementation((table: string) => buildChain(
    tables.data[table] ?? [],
    table === 'delivery_items'
      ? (columns) => columns === '*, product:products(product_name)'
        ? queryResults.deliveryItemDetails
        : undefined
      : undefined,
  ));

  render(<MemoryRouter><Deliveries /></MemoryRouter>);

  await waitFor(() => expect(screen.getAllByText('DEL-TIER-1').length).toBeGreaterThan(0));
  return document.querySelectorAll('[title="Inventory shortage"]').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryResults.deliveryItemDetails = { data: [], error: null };
});

describe('Deliveries shortage badge — across tier-split lines', () => {
  beforeEach(() => {
    tables.data = {
      deliveries: [DELIVERY],
      delivery_items: tierSplitItems(),
      customers: [],
      profile_public_view: [],
      inventory: [],
    };
  });

  it('warns when two tier lines of one product together exceed stock', async () => {
    // 10 on hand; neither 6-unit line exceeds it alone, but 12 together do.
    tables.data.inventory = [{ product_id: 'product-1', quantity_available: 10 }];

    expect(await renderDeliveries()).toBeGreaterThan(0);
  });

  it('stays quiet when the same two lines are genuinely covered', async () => {
    tables.data.inventory = [{ product_id: 'product-1', quantity_available: 20 }];

    expect(await renderDeliveries()).toBe(0);
  });
});

describe('Deliveries warehouse load sheet', () => {
  const item = {
    id: 'item-1',
    delivery_id: 'del-1',
    product_id: 'product-1',
    quantity: 6,
    unit_size: 'Gallon',
    product: { product_name: 'Atrazine 4L' },
  };

  beforeEach(() => {
    tables.data = {
      deliveries: [DELIVERY],
      delivery_items: [item],
      customers: [],
      profile_public_view: [],
      inventory: [{ product_id: 'product-1', quantity_available: 20 }],
    };
    queryResults.deliveryItemDetails = { data: [item], error: null };
  });

  it('does not generate or report success when delivery items fail to load', async () => {
    const itemReadError = { message: 'permission denied for table delivery_items' };
    queryResults.deliveryItemDetails = {
      data: null,
      error: itemReadError,
    };
    await renderDeliveries();

    fireEvent.click(screen.getByRole('button', { name: 'Load Sheet' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'You do not have permission to perform this action');
    });
    expect(mockGenerateBatchDeliveryPdf).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Delivery receipt(s) generated');
    expect(mockCaptureException).toHaveBeenCalledWith(
      itemReadError,
      expect.objectContaining({ tags: expect.objectContaining({ action: 'print_load_sheet' }) }),
    );
  });

  it('does not generate a blank load sheet when a delivery has no item rows', async () => {
    queryResults.deliveryItemDetails = { data: [], error: null };
    await renderDeliveries();

    fireEvent.click(screen.getByRole('button', { name: 'Load Sheet' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'No delivery items found for DEL-TIER-1');
    });
    expect(mockGenerateBatchDeliveryPdf).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Delivery receipt(s) generated');
  });

  it('generates the load sheet after delivery items load successfully', async () => {
    await renderDeliveries();

    fireEvent.click(screen.getByRole('button', { name: 'Load Sheet' }));

    await waitFor(() => expect(mockGenerateBatchDeliveryPdf).toHaveBeenCalledTimes(1));
    expect(mockGenerateBatchDeliveryPdf).toHaveBeenCalledWith([
      expect.objectContaining({
        delivery_number: 'DEL-TIER-1',
        items: [expect.objectContaining({ product_name: 'Atrazine 4L', quantity: 6 })],
      }),
    ]);
    expect(mockToast).toHaveBeenCalledWith('success', 'Delivery receipt(s) generated');
  });
});
