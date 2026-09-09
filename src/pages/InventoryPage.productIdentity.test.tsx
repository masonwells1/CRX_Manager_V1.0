import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryPage from './InventoryPage';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  resetKey: vi.fn(),
}));

const siblings = [
  {
    id: 'product-a',
    product_name: 'Same Name',
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
  {
    id: 'product-b',
    product_name: 'Same Name',
    sku: 'SKU-B',
    unit_size: '30 GL',
    packaging_variant: 'Drum',
    container_size: 30,
    container_unit: 'GL',
    inventory_unit: 'GAL',
    return_policy: 'no_return',
    is_full_tote_only: false,
    is_active: true,
    product_family: { name: 'Family B' },
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

vi.mock('../lib/db', async () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  checkMutationResult: vi.fn(),
  // The REAL sanitizeError, never a stub. This mock previously declared a
  // second `fallback` parameter the real one-argument function does not have,
  // so it ignored the error and returned a constant -- any assertion about
  // displayed error text here was vacuous. A stub shaped
  // `e instanceof Error ? e.message : <literal>` is no better: it re-implements
  // the plain-object defect fixed in the 2026-09-02 swallowed-server-errors
  // sweep and stays green against a regressed product.
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  )).sanitizeError,
  assertRpcResult: (value: unknown) => value,
  hasRpcCode: () => false,
  RpcErrorCodes: {},
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

// Mirror the REAL hook's full surface. A partial mock is not neutral here: a
// component that scopes its retained key calls getKeyFor/resetKeyFor, and an
// undefined member throws inside the click handler, so the RPC never fires and
// the test fails for a reason that has nothing to do with what it asserts.
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => {
    const scopedKeys = new Map<string, string>();
    return {
      getKey: () => 'idem-1',
      resetKey: mocks.resetKey,
      getKeyFor: (scope: string) => {
        if (!scopedKeys.has(scope)) scopedKeys.set(scope, `idem-1:${scopedKeys.size + 1}`);
        return scopedKeys.get(scope)!;
      },
      resetKeyFor: (scope: string) => {
        scopedKeys.delete(scope);
        mocks.resetKey(scope);
      },
    };
  },
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

describe('InventoryPage Product identity writers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') return query(siblings);
      return query([]);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_inventory_position') return { data: [], error: null };
      if (name === 'manual_inventory_add') return { data: { inventory_id: 'inventory-b' }, error: null };
      if (name === 'create_inventory_hold') return { data: { hold_id: 'hold-b' }, error: null };
      return { data: [], error: null };
    });
  });

  it('distinguishes siblings and sends exact UUID B to manual_inventory_add', async () => {
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /add inventory/i }));
    const dialog = screen.getByRole('dialog', { name: /add.*inventory/i });
    const siblingA = await within(dialog).findByRole('button', { name: /SKU-A.*Family: Family A/i });
    const siblingB = within(dialog).getByRole('button', { name: /SKU-B.*Family: Family B/i });
    expect(siblingA).toBeInTheDocument();
    fireEvent.click(siblingB);
    fireEvent.change(within(dialog).getByLabelText(/initial quantity/i), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^add inventory$/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'manual_inventory_add',
      expect.objectContaining({ p_product_id: 'product-b' }),
    ));
  });

  it('distinguishes siblings and sends exact UUID B to create_inventory_hold', async () => {
    render(<MemoryRouter><InventoryPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /create hold/i }));
    const dialog = screen.getByRole('dialog', { name: /create.*hold/i });
    const siblingA = await within(dialog).findByRole('button', { name: /SKU-A.*Family: Family A/i });
    const siblingB = within(dialog).getByRole('button', { name: /SKU-B.*Family: Family B/i });
    expect(siblingA).toBeInTheDocument();
    fireEvent.click(siblingB);
    fireEvent.change(within(dialog).getByLabelText(/^quantity$/i), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create hold$/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'create_inventory_hold',
      expect.objectContaining({ p_product_id: 'product-b' }),
    ));
  });
});
