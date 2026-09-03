import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PurchaseOrderDetail from './PurchaseOrderDetail';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  resetKey: vi.fn(),
}));

const siblingA = {
  id: 'product-a',
  product_name: 'Same Name',
  sku: 'SKU-A',
  unit_size: '2.5 GL',
  packaging_variant: 'Jug',
  container_size: 2.5,
  container_unit: 'GL',
  inventory_unit: 'GAL',
  return_policy: 'returnable',
  product_family: { name: 'Family A' },
};
const siblingB = {
  id: 'product-b',
  product_name: 'Same Name',
  sku: 'SKU-B',
  unit_size: '30 GL',
  packaging_variant: 'Drum',
  container_size: 30,
  container_unit: 'GL',
  inventory_unit: 'GAL',
  return_policy: 'non_returnable',
  product_family: { name: 'Family B' },
};

const po = {
  id: 'po-1',
  po_number: 'PO-1',
  vendor: 'Vendor',
  status: 'draft',
  submitted_date: null,
  expected_delivery_date: null,
  notes: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};
const poItems = [
  {
    id: 'received-line',
    purchase_order_id: 'po-1',
    product_id: 'product-a',
    product: siblingA,
    quantity_ordered: 10,
    quantity_received: 4,
    unit_cost: 100,
    unit_size: '2.5 GL',
  },
  {
    id: 'editable-line',
    purchase_order_id: 'po-1',
    product_id: 'product-a',
    product: siblingA,
    quantity_ordered: 2,
    quantity_received: 0,
    unit_cost: 20,
    unit_size: '2.5 GL',
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
  // The REAL sanitizeError, never a stub. This mock previously declared a
  // second `fallback` parameter the real one-argument function does not have,
  // so no caller ever supplied it and the mock returned `undefined` for every
  // error -- any assertion about displayed error text here was vacuous. A stub
  // shaped `e instanceof Error ? e.message : <literal>` is no better: it
  // re-implements the plain-object defect fixed in the 2026-09-02
  // swallowed-server-errors sweep and stays green against a regressed product.
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  )).sanitizeError,
  assertRpcResult: (value: unknown) => value,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'admin-1', full_name: 'Admin' },
  }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKey: () => 'idem-1',
    resetKey: mocks.resetKey,
  }),
}));

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

describe('PurchaseOrderDetail Product identity edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'purchase_orders') return query(po);
      if (table === 'purchase_order_items') return query(poItems);
      if (table === 'receiving_records') return query([]);
      if (table === 'products') return query([siblingA, siblingB]);
      return query([]);
    });
    mocks.rpc.mockResolvedValue({
      data: { po_id: 'po-1', po_number: 'PO-1', status: 'saved' },
      error: null,
    });
  });

  it('locks the received line and saves original UUID A plus selected sibling UUID B', async () => {
    render(
      <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
        <Routes>
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const dialog = screen.getByRole('dialog', { name: /edit purchase.*order/i });
    expect(within(dialog).getByText(/received line locked · 4 received/i)).toBeInTheDocument();
    const disabledInputs = within(dialog).getAllByRole('spinbutton').filter((input) => input.hasAttribute('disabled'));
    expect(disabledInputs).toHaveLength(2);

    const editableProduct = within(dialog).getAllByRole('button', { name: /same name/i })
      .find((button) => !button.textContent?.includes('Received line locked'));
    expect(editableProduct).toBeDefined();
    fireEvent.click(editableProduct!);
    fireEvent.change(within(dialog).getByPlaceholderText(/search products/i), {
      target: { value: 'Same' },
    });
    const siblingBResult = await within(dialog).findByRole('button', { name: /SKU-B.*Family B/i });
    expect(within(dialog).getByRole('button', { name: /SKU-A.*Family A/i })).toBeInTheDocument();
    fireEvent.click(siblingBResult);
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_purchase_order',
      expect.objectContaining({
        p_items: expect.arrayContaining([
          expect.objectContaining({
            id: 'received-line',
            product_id: 'product-a',
            quantity_received: 4,
          }),
          expect.objectContaining({
            id: 'editable-line',
            product_id: 'product-b',
            quantity_received: 0,
          }),
        ]),
      }),
    ));
  });
});
