import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockApplyPricing,
  mockPreviewPricing,
  mockProductUpdate,
  mockToast,
} = vi.hoisted(() => ({
  mockApplyPricing: vi.fn(),
  mockPreviewPricing: vi.fn(),
  mockProductUpdate: vi.fn(),
  mockToast: vi.fn(),
}));

const product = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Test Product',
  sku: '000123',
  category: 'Herbicide',
  vendor: 'Test Supplier',
  manufacturer: 'Test Manufacturer',
  container_size: 2.5,
  unit_size: 'gal',
  inventory_unit: 'gal',
  container_unit: 'jug',
  container_type: 'Jug',
  epa_registration: null,
  is_rup: false,
  signal_word: null,
  rei_hours: null,
  phi_days: null,
  product_form: 'liquid',
  current_cost: 50,
  cost_updated_date: null,
  tier1_price: 62.5,
  tier1_margin: 0.2,
  tier1_gross_margin: 0.25,
  tier2_price: 58.82,
  tier2_margin: 0.15,
  tier2_gross_margin: 0.1765,
  tier3_price: 55.56,
  tier3_margin: 0.1,
  tier3_gross_margin: 0.1111,
  tier1_price_per_acre: null,
  tier2_price_per_acre: null,
  tier3_price_per_acre: null,
  rate_per_acre: null,
  rate_unit: null,
  suggested_rate: null,
  notes: null,
  internal_notes: null,
  is_active: true,
  pricing_version: 7,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function chainable(resolveWith: unknown) {
  const builder: Record<string, unknown> = {};
  let resolved = resolveWith;
  const self = () => builder;
  for (const method of [
    'select', 'insert', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'is', 'in', 'or', 'not', 'match', 'order', 'limit', 'range',
    'single', 'csv', 'explain',
  ]) {
    builder[method] = vi.fn(self);
  }
  builder.update = mockProductUpdate.mockImplementation(self);
  builder.maybeSingle = vi.fn(() => {
    resolved = { data: product, error: null };
    return builder;
  });
  builder.then = vi.fn((resolve: (value: unknown) => void) => {
    Promise.resolve(resolved).then(resolve);
  });
  return builder;
}

vi.mock('../lib/db', () => {
  const supabase = {
    from: vi.fn((table: string) => chainable(
      table === 'products'
        ? { data: [product], error: null }
        : { data: [], error: null },
    )),
    rpc: vi.fn(() => chainable({ data: {}, error: null })),
    functions: { invoke: vi.fn() },
  };
  return {
    supabase,
    supabaseUntyped: supabase,
    assertRpcResult: vi.fn((value: unknown) => value),
    checkMutationResult: vi.fn(),
  };
});

vi.mock('../lib/productPricing', () => ({
  previewProductPricingChanges: mockPreviewPricing,
  applyProductPricingChangeSet: mockApplyPricing,
  formatPricingMarginPercent: (value: number) => (value * 100).toFixed(8).replace(/\.?0+$/, ''),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Test Admin' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: product.id }),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: `/products/${product.id}` }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked' }),
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import ProductDetail from './ProductDetail';

describe('ProductDetail governed pricing flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewPricing.mockResolvedValue({
      change_set_id: '22222222-2222-4222-8222-222222222222',
      request_fingerprint: 'preview-fingerprint',
      source: 'product_page',
      status: 'previewed',
      expires_at: '2026-07-16T23:00:00Z',
      submitted_row_count: 1,
      ready_count: 1,
      unchanged_count: 0,
      conflict_count: 0,
      invalid_count: 0,
      apply_allowed: true,
      rows: [{
        sequence: 1,
        product_id: product.id,
        submitted_row: { product_name: product.product_name, sku: product.sku },
        row_status: 'ready',
        error_code: null,
        effect: {
          product_id: product.id,
          product_name: product.product_name,
          sku: product.sku,
          pricing_mode: 'margin_driven',
          before: {
            cost: '50.00', cost_cents: 5000,
            tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '62.50', tier1_price_cents: 6250,
            tier2_margin_percent: '15', tier2_margin: 0.15, tier2_price: '58.82', tier2_price_cents: 5882,
            tier3_margin_percent: '10', tier3_margin: 0.1, tier3_price: '55.56', tier3_price_cents: 5556,
            tier1_price_per_acre_cents: null,
            tier2_price_per_acre_cents: null,
            tier3_price_per_acre_cents: null,
          },
          cost: '55.00',
          cost_cents: 5500,
          tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '68.75', tier1_price_cents: 6875,
          tier2_margin_percent: '15', tier2_margin: 0.15, tier2_price: '64.71', tier2_price_cents: 6471,
          tier3_margin_percent: '10', tier3_margin: 0.1, tier3_price: '61.11', tier3_price_cents: 6111,
          tier1_price_per_acre_cents: null,
          tier2_price_per_acre_cents: null,
          tier3_price_per_acre_cents: null,
        },
      }],
    });
    mockApplyPricing.mockResolvedValue({
      change_set_id: '22222222-2222-4222-8222-222222222222',
      status: 'applied',
      applied_count: 1,
      rows: [],
    });
  });

  it('previews and applies a quick cost change without a direct products update', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');

    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
    fireEvent.change(screen.getByLabelText('New Cost'), { target: { value: '55.00' } });
    fireEvent.change(screen.getByLabelText('Change Note (optional)'), { target: { value: 'Mid-month supplier increase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Cost Change' }));

    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledWith(expect.objectContaining({
      source: 'product_page',
      performedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: expect.any(String),
      rows: [{
        product_id: product.id,
        product_name: product.product_name,
        sku: product.sku,
        row_version: 7,
        pricing_mode: 'margin_driven',
        new_cost: '55.00',
        tier1_margin_percent: '20',
        tier2_margin_percent: '15',
        tier3_margin_percent: '10',
        change_reason: 'Mid-month supplier increase',
      }],
    })));
    expect(await screen.findByText('Ready for approval')).toBeTruthy();
    expect(screen.getByText('$68.75')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));
    await waitFor(() => expect(mockApplyPricing).toHaveBeenCalledWith(expect.objectContaining({
      changeSetId: '22222222-2222-4222-8222-222222222222',
      requestFingerprint: 'preview-fingerprint',
      performedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: expect.any(String),
    })));

    expect(mockProductUpdate).not.toHaveBeenCalled();
  });

  it('blocks a margin-driven zero cost before the preview RPC', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');

    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
    fireEvent.change(screen.getByLabelText('New Cost'), { target: { value: '0.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Cost Change' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Margin-driven pricing requires a cost greater than $0. No prices were changed.',
    ));
    expect(mockPreviewPricing).not.toHaveBeenCalled();
    expect(mockProductUpdate).not.toHaveBeenCalled();
  });

  it('keeps unrelated unsaved Product details intact by blocking quick pricing review', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');

    fireEvent.change(screen.getByLabelText('Grower Description'), {
      target: { value: 'Unsaved grower-facing description' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
    fireEvent.change(screen.getByLabelText('New Cost'), { target: { value: '55.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Cost Change' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Save or discard the unsaved Product details before reviewing a pricing change.',
    ));
    expect(mockPreviewPricing).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Grower Description')).toHaveValue('Unsaved grower-facing description');
  });
});
