import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockToast, mockSentryCaptureException } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockSentryCaptureException: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => chain;
  for (const name of ['select', 'eq', 'order', 'limit', 'maybeSingle']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: vi.fn() },
  supabaseUntyped: { from: vi.fn(), rpc: vi.fn() },
  assertRpcResult: vi.fn((value) => value),
  sanitizeError: vi.fn((error: Error) => error.message),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }),
}));
vi.mock('../hooks/useGuardrails', () => ({
  useCreditLimitCheck: () => ({ check: vi.fn() }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockSentryCaptureException } }));

import FieldAppSplitInvoiceEditor from './FieldAppSplitInvoiceEditor';

describe('FieldAppSplitInvoiceEditor picker loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'app_settings') return buildChain({ data: { setting_value: 'true' }, error: null });
      if (table === 'fields') return buildChain({ data: [{ id: 'field-1', field_name: 'North 40' }], error: null });
      if (table === 'products') {
        return buildChain({
          data: [{
            id: '11111111-1111-4111-8111-111111111111',
            product_name: 'Exact Product',
            sku: 'SKU-EXACT',
            inventory_unit: 'gal',
            return_policy: 'returnable',
            is_full_tote_only: false,
            product_family: { name: 'Family Alpha' },
          }],
          error: null,
        });
      }
      if (table === 'application_services') return buildChain({ data: [{ id: 'service-1', name: 'Aerial application' }], error: null });
      if (table === 'jobs') return buildChain({ data: null, error: new Error('jobs unavailable') });
      return buildChain({ data: [], error: null });
    });
  });

  it('keeps successful field, Product, and service pickers usable when jobs fail', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Split Billing — New' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'North 40' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Source job/).querySelectorAll('option')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));
    expect(await screen.findByRole('option', { name: /Exact Product.*SKU-EXACT/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    expect(await screen.findByRole('option', { name: 'Aerial application' })).toBeInTheDocument();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Some field application invoice pickers could not be loaded.'));
    expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { context: 'load_field_app_split_invoice_pickers' } }),
    );
  });
});
