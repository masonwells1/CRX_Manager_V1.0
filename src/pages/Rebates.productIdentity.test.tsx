import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Rebates from './Rebates';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  insertedProgram: null as Record<string, unknown> | null,
}));

const siblings = [
  {
    id: 'product-a',
    product_name: 'Same Name',
    sku: 'SKU-A',
    vendor: 'Vendor A',
    manufacturer: 'Maker',
    unit_size: '2.5 GL',
    packaging_variant: 'Jug',
    container_size: 2.5,
    container_unit: 'GL',
    inventory_unit: 'GAL',
    return_policy: 'returnable',
    is_full_tote_only: false,
    product_family: { name: 'Family A' },
  },
  {
    id: 'product-b',
    product_name: 'Same Name',
    sku: 'SKU-B',
    vendor: 'Vendor B',
    manufacturer: 'Maker',
    unit_size: '30 GL',
    packaging_variant: 'Drum',
    container_size: 30,
    container_unit: 'GL',
    inventory_unit: 'GAL',
    return_policy: 'non_returnable',
    is_full_tote_only: false,
    product_family: { name: 'Family B' },
  },
];

function query(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'delete']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.insert = vi.fn((payload: Record<string, unknown>) => {
    mocks.insertedProgram = payload;
    return builder;
  });
  builder.update = vi.fn((payload: Record<string, unknown>) => {
    mocks.insertedProgram = payload;
    return builder;
  });
  builder.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return builder;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: (value: unknown) => value,
  hasRpcCode: () => false,
  RpcErrorCodes: {},
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'admin-1' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem-1', resetKey: vi.fn() }),
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

describe('Rebates Product identity writers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertedProgram = null;
    mocks.rpc.mockResolvedValue({
      data: { claim_id: 'claim-1', claim_number: 'RC-1' },
      error: null,
    });
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') return query(siblings);
      if (table === 'customers') return query([]);
      if (table === 'orders') return query([]);
      if (table === 'rebate_programs') {
        return query([{
          id: 'program-1',
          program_name: 'Program One',
          manufacturer: 'Maker',
          status: 'active',
          start_date: '2026-01-01',
          end_date: '2026-12-31',
          rebate_type: 'per_unit',
          rebate_amount: 1,
          season: 2026,
        }]);
      }
      return query([]);
    });
  });

  it('distinguishes same-name siblings and inserts exact Product UUID B for a program', async () => {
    render(<Rebates />);
    fireEvent.click(await screen.findByRole('button', { name: /add program/i }));
    const dialog = screen.getByRole('dialog', { name: /new rebate program/i });
    const productSelect = within(dialog).getAllByRole('combobox')[0];
    const labels = within(productSelect).getAllByRole('option').map((option) => option.textContent);
    expect(labels.some((label) => label?.includes('SKU-A') && label.includes('Family A'))).toBe(true);
    expect(labels.some((label) => label?.includes('SKU-B') && label.includes('Family B'))).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/program name/i), { target: { value: 'Test Program' } });
    fireEvent.change(within(dialog).getByLabelText(/manufacturer/i), { target: { value: 'Maker' } });
    fireEvent.change(productSelect, { target: { value: 'product-b' } });
    fireEvent.change(within(dialog).getByLabelText(/start date/i), { target: { value: '2026-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(/end date/i), { target: { value: '2026-12-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /create program/i }));

    await waitFor(() => expect(mocks.insertedProgram).toEqual(expect.objectContaining({
      product_id: 'product-b',
    })));
  });

  it('distinguishes same-name siblings and sends exact Product UUID B to create_rebate_claim', async () => {
    render(<Rebates />);
    fireEvent.click(await screen.findByRole('button', { name: /^claims$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /new claim/i }));
    const dialog = screen.getByRole('dialog', { name: /new rebate claim/i });
    const selects = within(dialog).getAllByRole('combobox');
    const productSelect = selects[3];
    const labels = within(productSelect).getAllByRole('option').map((option) => option.textContent);
    expect(labels.some((label) => label?.includes('SKU-A') && label.includes('Family A'))).toBe(true);
    expect(labels.some((label) => label?.includes('SKU-B') && label.includes('Family B'))).toBe(true);

    fireEvent.change(selects[0], { target: { value: 'program-1' } });
    fireEvent.change(productSelect, { target: { value: 'product-b' } });
    fireEvent.change(within(dialog).getByLabelText(/quantity/i), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText(/claim amount/i), { target: { value: '25' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /create claim/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'create_rebate_claim',
      expect.objectContaining({ p_product_id: 'product-b' }),
    ));
  });
});
