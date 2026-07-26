import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuickReceivePanel from './QuickReceivePanel';

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

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Receiver' } }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem-1', resetKey: vi.fn() }),
}));

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => productQuery()), rpc: mocks.rpc },
  assertRpcResult: (value: unknown) => value,
}));

vi.mock('../../lib/notificationTriggers', () => ({
  notifyDamagedReceiving: vi.fn(),
}));

describe('QuickReceivePanel Product identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('distinguishes siblings, matches UUID B, and receives only its returned PO allocation', async () => {
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
  });
});
