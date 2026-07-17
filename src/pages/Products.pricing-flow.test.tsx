import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockApplyPricing,
  mockParsePricing,
  mockPreviewPricing,
  mockProductUpdate,
  mockToast,
  pricingWorkbookFileLimit,
} = vi.hoisted(() => ({
  mockApplyPricing: vi.fn(),
  mockParsePricing: vi.fn(),
  mockPreviewPricing: vi.fn(),
  mockProductUpdate: vi.fn(),
  mockToast: vi.fn(),
  pricingWorkbookFileLimit: 10 * 1024 * 1024,
}));

const product = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Inline Pricing Product',
  sku: 'INLINE-001',
  category: 'Herbicide',
  vendor: 'Test Supplier',
  current_cost: 50,
  tier1_margin: 0.2,
  tier2_margin: 0.15,
  tier3_margin: 0.1,
  tier1_price: 62.5,
  tier2_price: 58.82,
  tier3_price: 55.56,
  tier1_price_per_acre: null,
  tier2_price_per_acre: null,
  tier3_price_per_acre: null,
  pricing_version: 7,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function chainable(resolveWith: unknown) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  for (const method of [
    'select', 'insert', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'is', 'in', 'or', 'not', 'match', 'order', 'limit', 'range',
    'single', 'maybeSingle', 'csv', 'explain',
  ]) {
    builder[method] = vi.fn(self);
  }
  builder.update = mockProductUpdate.mockImplementation(self);
  builder.then = vi.fn((resolve: (value: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
  });
  return builder;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: vi.fn(() => chainable({ data: [product], error: null })),
  },
  sanitizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
  checkMutationResult: vi.fn(),
}));

vi.mock('../lib/productPricing', () => ({
  previewProductPricingChanges: mockPreviewPricing,
  applyProductPricingChangeSet: mockApplyPricing,
  createPricingWorkbookExport: vi.fn(),
}));

vi.mock('../lib/productPricingWorkbook', () => ({
  generateProductPricingWorkbook: vi.fn(),
  MAX_PRICING_WORKBOOK_FILE_BYTES: pricingWorkbookFileLimit,
  parseProductPricingWorkbook: mockParsePricing,
}));

vi.mock('../components/ui/EditableDataTable', () => ({
  default: ({ data, onSave }: {
    data: typeof product[];
    onSave: (changes: Map<string, Record<string, unknown>>) => Promise<void | boolean>;
  }) => (
    <button
      disabled={data.length === 0}
      onClick={() => void onSave(new Map([[
        data[0].id,
        {
          pricing_mode: 'margin_driven',
          current_cost: '55.00',
          tier1_margin_percent: '20',
          tier2_margin_percent: '15',
          tier3_margin_percent: '10',
        },
      ]]))}
    >
      Test inline pricing save
    </button>
  ),
}));

vi.mock('../components/products/BulkProductImport', () => ({ default: () => null }));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Test Admin' },
  }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import Products from './Products';

describe('Products governed inline pricing flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewPricing.mockResolvedValue({
      change_set_id: '22222222-2222-4222-8222-222222222222',
      request_fingerprint: 'inline-fingerprint',
      source: 'products_inline',
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
          },
          cost: '55.00', cost_cents: 5500,
          tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '68.75', tier1_price_cents: 6875,
          tier2_margin_percent: '15', tier2_margin: 0.15, tier2_price: '64.71', tier2_price_cents: 6471,
          tier3_margin_percent: '10', tier3_margin: 0.1, tier3_price: '61.11', tier3_price_cents: 6111,
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

  it('previews and applies inline pricing without a direct products update', async () => {
    render(<Products />);
    const saveButton = await screen.findByRole('button', { name: 'Test inline pricing save' });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledWith(expect.objectContaining({
      source: 'products_inline',
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
        change_reason: 'Products inline pricing edit',
      }],
    })));

    expect(await screen.findByText(product.product_name)).toBeTruthy();
    expect(screen.getByText('$50.00')).toBeTruthy();
    expect(screen.getByText('$55.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));

    await waitFor(() => expect(mockApplyPricing).toHaveBeenCalledWith(expect.objectContaining({
      changeSetId: '22222222-2222-4222-8222-222222222222',
      requestFingerprint: 'inline-fingerprint',
      performedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: expect.any(String),
    })));
    expect(mockProductUpdate).not.toHaveBeenCalled();
  });

  it('rejects an oversized pricing workbook before reading or parsing the file', async () => {
    const { container } = render(<Products />);
    await screen.findByRole('button', { name: 'Review Pricing File' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept^=".xlsx"]')!;
    const arrayBuffer = vi.fn();
    const file = new File(['small test payload'], 'oversized.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    Object.defineProperty(file, 'size', { value: pricingWorkbookFileLimit + 1 });
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Pricing workbooks must be 10 MB or smaller.',
    ));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mockParsePricing).not.toHaveBeenCalled();
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });
});
