import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
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
    window.sessionStorage.clear();
    window.localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
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
    expect(await screen.findByText(/successfully received 1 item allocation/i)).toBeInTheDocument();
  });

  it('restores a locked request after reload and retries its frozen payload without revalidation', async () => {
    const sourceItem = {
      key: 'frozen-line',
      product_id: 'product-b',
      product_name: 'Same Name',
      sku: 'SKU-B',
      quantity: 3,
      condition: 'good',
      lot_number: '',
      notes: '',
    };
    const frozenMatch = {
      product_id: 'product-b',
      product_name: 'Same Name',
      quantity_requested: 3,
      quantity_unmatched: 0,
      has_multiple_costs: true,
      allocations: [{
        po_item_id: 'po-item-frozen',
        purchase_order_id: 'po-frozen',
        po_number: 'PO-FROZEN',
        po_vendor: 'Vendor B',
        quantity_allocated: 3,
        unit_cost: 25,
        po_remaining_before: 3,
        po_remaining_after: 0,
      }],
    };
    const frozenPayload = [{
      po_item_id: 'po-item-frozen',
      quantity: 3,
      condition: 'good',
      lot_number: null,
      notes: null,
      storage_location: 'Cold Storage',
    }];
    const storageKey = `crx:uncertain-mutation:v3:${JSON.stringify([
      'receive_po_items',
      'user-1',
    ])}`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 3,
      operation: 'receive_po_items',
      userId: 'user-1',
      surface: 'quick-receive',
      scope: '',
      idempotencyKey: 'receive_po_items:user-1:frozen-key',
      intentIdentity: 'frozen-identity',
      createdAtMs: Date.now(),
      retryNotAfterMs: Date.now() + (23 * 60 * 60 * 1000),
      intent: {
        itemsPayload: frozenPayload,
        performedBy: 'user-1',
        receivedByName: 'Receiver',
        vendor: 'Vendor B',
        storageLocation: 'Cold Storage',
        matchResults: [frozenMatch],
        sourceItems: [sourceItem],
      },
    }));

    render(
      <MemoryRouter>
        <QuickReceivePanel />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /retry exact receiving/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'receive_po_items',
      expect.objectContaining({
        p_items: frozenPayload,
        p_performed_by: 'user-1',
        p_idempotency_key: 'receive_po_items:user-1:frozen-key',
      }),
    ));
    expect(await screen.findByText(/successfully received 1 item allocation/i)).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(storageKey)).toBeNull());
  });

  it('keeps an expired request locked and never calls the receiving RPC', async () => {
    const storageKey = `crx:uncertain-mutation:v3:${JSON.stringify([
      'receive_po_items',
      'user-1',
    ])}`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 3,
      operation: 'receive_po_items',
      userId: 'user-1',
      surface: 'quick-receive',
      scope: '',
      idempotencyKey: 'receive_po_items:user-1:expired-key',
      intentIdentity: 'expired-identity',
      createdAtMs: Date.now() - (24 * 60 * 60 * 1000),
      retryNotAfterMs: Date.now() - (60 * 60 * 1000),
      intent: {
        itemsPayload: [{
          po_item_id: 'po-item-expired',
          quantity: 3,
          condition: 'good',
          lot_number: null,
          notes: null,
          storage_location: 'Cold Storage',
        }],
        performedBy: 'user-1',
        receivedByName: 'Receiver',
        vendor: 'Vendor B',
        storageLocation: 'Cold Storage',
        matchResults: [{
          product_id: 'product-b',
          product_name: 'Same Name',
          quantity_requested: 3,
          quantity_unmatched: 0,
          has_multiple_costs: false,
          allocations: [{
            po_item_id: 'po-item-expired',
            purchase_order_id: 'po-expired',
            po_number: 'PO-EXPIRED',
            po_vendor: 'Vendor B',
            quantity_allocated: 3,
            unit_cost: 25,
            po_remaining_before: 3,
            po_remaining_after: 0,
          }],
        }],
        sourceItems: [{
          key: 'expired-line',
          product_id: 'product-b',
          product_name: 'Same Name',
          sku: 'SKU-B',
          quantity: 3,
          condition: 'good',
          lot_number: '',
          notes: '',
        }],
      },
    }));

    render(
      <MemoryRouter>
        <QuickReceivePanel />
      </MemoryRouter>,
    );

    const retry = await screen.findByRole('button', { name: /retry exact receiving/i });
    expect(retry).toBeDisabled();
    expect(screen.getByText(/safe automatic retry window expired/i)).toBeInTheDocument();
    fireEvent.click(retry);
    expect(mocks.rpc).not.toHaveBeenCalledWith('receive_po_items', expect.anything());
    expect(window.localStorage.getItem(storageKey)).toContain('expired-key');
  });
});
