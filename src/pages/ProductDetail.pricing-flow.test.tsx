import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockApplyPricing,
  mockPreviewPricing,
  mockProductUpdate,
  mockProductEq,
  mockToast,
  mockGetCostBasisWorkspace,
} = vi.hoisted(() => ({
  mockApplyPricing: vi.fn(),
  mockPreviewPricing: vi.fn(),
  mockProductUpdate: vi.fn(),
  mockProductEq: vi.fn(),
  mockToast: vi.fn(),
  mockGetCostBasisWorkspace: vi.fn(),
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
  quoting_notes: 'Default quote guidance',
  is_active: true,
  pricing_version: 7,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

let routeProductId = product.id;

let productLoadResults: Array<{ data: typeof product | null; error: unknown }> = [];
let costHistoryLoadResult: { data: unknown[] | null; error: unknown } = { data: [], error: null };
let productMutationResult: { data: Array<typeof product>; error: unknown } = {
  data: [product],
  error: null,
};

function chainable(resolveWith: unknown) {
  const builder: Record<string, unknown> = {};
  let resolved = resolveWith;
  const self = () => builder;
  for (const method of [
    'select', 'insert', 'upsert', 'delete', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'is', 'in', 'or', 'not', 'match', 'order', 'limit', 'range',
    'single', 'csv', 'explain',
  ]) {
    builder[method] = vi.fn(self);
  }
  builder.eq = vi.fn((...args: unknown[]) => {
    mockProductEq(...args);
    return builder;
  });
  builder.update = vi.fn((...args: unknown[]) => {
    mockProductUpdate(...args);
    resolved = productMutationResult;
    return builder;
  });
  builder.maybeSingle = vi.fn(() => {
    resolved = productLoadResults.shift() ?? { data: product, error: null };
    return builder;
  });
  builder.then = vi.fn((resolve: (value: unknown) => void) => {
    Promise.resolve(resolved).then(resolve);
  });
  return builder;
}

vi.mock('../lib/db', async () => {
  // Use the REAL sanitizeError. Stubbing it as `e instanceof Error ? e.message : …`
  // would re-implement the very defect these screens were just fixed for: a
  // non-throwing postgrest call resolves its error as a PLAIN OBJECT, so an
  // `instanceof Error` stub silently reproduces the swallowed-message bug and the
  // test would pass against a regressed product.
  const { sanitizeError } = await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  );
  const supabase = {
    from: vi.fn((table: string) => chainable(
      table === 'products'
        ? { data: [product], error: null }
        : table === 'cost_history'
          ? costHistoryLoadResult
        : { data: [], error: null },
    )),
    rpc: vi.fn(() => chainable({ data: {}, error: null })),
    functions: { invoke: vi.fn() },
  };
  return {
    supabase,
    supabaseUntyped: supabase,
    assertRpcResult: vi.fn((value: unknown) => value),
    // Faithful to the real helper: it RE-THROWS result.error, and that error is
    // a plain PostgREST object. A `vi.fn()` no-op here silently deletes the
    // error path, so any test aiming at a catch block would assert against a
    // save that quietly "succeeded" — the same class of problem as stubbing
    // sanitizeError.
    checkMutationResult: vi.fn((result: { error: unknown; data: unknown }) => {
      if (result.error) throw result.error;
    }),
    sanitizeError,
  };
});

vi.mock('../lib/productPricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/productPricing')>();
  return {
    ...actual,
    previewProductPricingChanges: mockPreviewPricing,
    applyProductPricingChangeSet: mockApplyPricing,
  };
});

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../lib/productCostBasis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/productCostBasis')>();
  return { ...actual, getProductCostBasisWorkspace: mockGetCostBasisWorkspace };
});

vi.mock('../components/products/ProductPriceHistory', () => ({
  default: ({ costBasisWorkspace, onSelectSupplierBasis, onSelectPurchaseBasis }: {
    costBasisWorkspace?: {
      supplier_candidates: Array<{ supplier_price_observation_id: string }>;
      purchase_candidates: Array<{ purchase_order_item_id: string }>;
    } | null;
    onSelectSupplierBasis?: (candidate: unknown) => void;
    onSelectPurchaseBasis?: (candidate: unknown) => void;
  }) => (
    <div>
      {costBasisWorkspace?.supplier_candidates.map((candidate) => (
        <button key={candidate.supplier_price_observation_id} type="button" onClick={() => onSelectSupplierBasis?.(candidate)}>
          Select supplier evidence
        </button>
      ))}
      {costBasisWorkspace?.purchase_candidates.map((candidate) => (
        <button key={candidate.purchase_order_item_id} type="button" onClick={() => onSelectPurchaseBasis?.(candidate)}>
          Select received PO evidence
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Test Admin' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: routeProductId }),
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
    routeProductId = product.id;
    productLoadResults = [];
    costHistoryLoadResult = { data: [], error: null };
    productMutationResult = { data: [product], error: null };
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
            cost: '50.00', cost_cents: 5000n,
            tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '62.50', tier1_price_cents: 6250n,
            tier2_margin_percent: '15', tier2_margin: 0.15, tier2_price: '58.82', tier2_price_cents: 5882n,
            tier3_margin_percent: '10', tier3_margin: 0.1, tier3_price: '55.56', tier3_price_cents: 5556n,
            tier1_price_per_acre_cents: null,
            tier2_price_per_acre_cents: null,
            tier3_price_per_acre_cents: null,
          },
          cost: '55.00',
          cost_cents: 5500n,
          tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '68.75', tier1_price_cents: 6875n,
          tier2_margin_percent: '15', tier2_margin: 0.15, tier2_price: '64.71', tier2_price_cents: 6471n,
          tier3_margin_percent: '10', tier3_margin: 0.1, tier3_price: '61.11', tier3_price_cents: 6111n,
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
    mockGetCostBasisWorkspace.mockResolvedValue({
      enabled: true,
      product: {
        id: product.id,
        product_name: product.product_name,
        sku: product.sku,
        pricing_version: product.pricing_version,
        current_cost_cents: 5_000n,
        tier1_margin_percent: '20',
        tier2_margin_percent: '15',
        tier3_margin_percent: '10',
      },
      current_basis: null,
      supplier_candidates: [{
        supplier_price_observation_id: 'observation-1',
        vendor_id: 'vendor-1',
        vendor_name: 'Test Supplier',
        quoted_package_cost_cents: 5_500n,
        normalized_cost_cents: 5_500n,
        effective_from: '2026-07-21',
        price_kind: 'quote',
      }],
      purchase_candidates: [],
    });
  });

  it('loads and saves customer-facing Quoting Notes with pricing-version conflict protection', async () => {
    render(<ProductDetail />);
    const quotingNotes = await screen.findByLabelText('Quoting Notes');
    expect(quotingNotes).toHaveValue('Default quote guidance');
    expect(screen.getByText(/customer-facing guidance automatically added to the quote line/i))
      .toBeInTheDocument();

    fireEvent.change(quotingNotes, { target: { value: 'Updated quote guidance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ quoting_notes: 'Updated quote guidance' }),
    ));
    expect(mockProductEq).toHaveBeenCalledWith('pricing_version', product.pricing_version);
  });

  it('labels a migration baseline as unverified current provenance when legacy cost history is empty', async () => {
    mockGetCostBasisWorkspace.mockResolvedValueOnce({
      enabled: true,
      product: {
        id: product.id,
        product_name: product.product_name,
        sku: product.sku,
        pricing_version: product.pricing_version,
        current_cost_cents: 5_000n,
        tier1_margin_percent: '20',
        tier2_margin_percent: '15',
        tier3_margin_percent: '10',
      },
      current_basis: {
        id: 'basis-current',
        basis_type: 'migration_baseline',
        cost_cents: 5_000n,
        supplier_price_observation_id: null,
        purchase_order_item_id: null,
        selection_source: 'migration_baseline',
        reason: 'Current cost baseline',
        selected_at: '2026-08-04T12:00:00Z',
      },
      supplier_candidates: [],
      purchase_candidates: [],
    });

    render(<ProductDetail />);

    expect(await screen.findByText('No legacy cost changes recorded.')).toBeInTheDocument();
    expect(screen.getByText(/Current governed cost baseline:/)).toBeInTheDocument();
    const basisCopy = screen.getByText(/Current governed cost baseline:/);
    expect(within(basisCopy).getByText('$50.00')).toBeInTheDocument();
    expect(screen.getByText(/not independently verified against supplier evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/not a backfilled historical price-change event/i)).toBeInTheDocument();
  });

  it('does not present missing history or basis details as facts after a governed-basis load failure', async () => {
    mockGetCostBasisWorkspace.mockRejectedValueOnce(new Error('workspace unavailable'));

    render(<ProductDetail />);

    expect(await screen.findByText(/Current governed cost-basis details could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/no current governed cost-basis record is available/i)).not.toBeInTheDocument();
  });

  it('does not claim cost history is empty when the legacy-history load fails', async () => {
    costHistoryLoadResult = { data: null, error: new Error('history unavailable') };

    render(<ProductDetail />);

    expect(await screen.findByText(/Cost history could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('No legacy cost changes recorded.')).not.toBeInTheDocument();
  });

  it('renders loaded legacy history while governed cost-basis details are still loading', async () => {
    costHistoryLoadResult = {
      data: [{
        id: 'history-1',
        old_cost: 49,
        new_cost: 50,
        change_note: 'Legacy cost update',
        changed_at: '2026-08-04T12:00:00Z',
      }],
      error: null,
    };
    mockGetCostBasisWorkspace.mockReturnValueOnce(new Promise(() => {}));

    render(<ProductDetail />);

    expect(await screen.findByText('Legacy cost update')).toBeInTheDocument();
    expect(screen.queryByText('Loading cost history…')).not.toBeInTheDocument();
  });

  it('rejects a direct detail save when the loaded pricing version is stale', async () => {
    productMutationResult = { data: [], error: null };
    render(<ProductDetail />);
    const quotingNotes = await screen.findByLabelText('Quoting Notes');

    fireEvent.change(quotingNotes, { target: { value: 'Stale overwrite attempt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Product details changed after this page loaded. Reload before saving.',
    ));
    expect(mockProductEq).toHaveBeenCalledWith('pricing_version', product.pricing_version);
  });

  // The catches on this page were converted to sanitizeError() in the 2026-09-02
  // sweep. The error they receive is a PLAIN OBJECT (postgrest-js only builds a
  // real PostgrestError under .throwOnError()), so this exercises the actual
  // shape rather than an Error the product never sees — and asserts BOTH halves
  // of the contract: a user-facing refusal survives intact, a raw Postgres
  // identifier does not.
  it('shows a plain-object server refusal verbatim but redacts raw identifiers', async () => {
    const refusal = 'This Product is locked by an open pricing review. No changes were saved.';
    productMutationResult = {
      data: [],
      error: { message: refusal, details: null, hint: null, code: 'P0001' },
    };
    expect(productMutationResult.error instanceof Error).toBe(false);

    render(<ProductDetail />);
    fireEvent.change(await screen.findByLabelText('Quoting Notes'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', refusal));
  });

  it('redacts an unquoted Postgres permission error from a plain-object save failure', async () => {
    productMutationResult = {
      data: [],
      // The UNQUOTED form Postgres actually emits — the form that used to pass
      // through sanitizeError unredacted.
      error: { message: 'permission denied for table products', details: null, hint: null, code: '42501' },
    };

    render(<ProductDetail />);
    fireEvent.change(await screen.findByLabelText('Quoting Notes'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'You do not have permission to perform this action',
    ));
    const shown = mockToast.mock.calls.map((c) => String(c[1])).join(' | ');
    expect(shown).not.toContain('permission denied for table');
  });

  it('defaults supplier evidence selection to keeping sell prices with Product-detail provenance', async () => {
    render(<ProductDetail />);
    await screen.findByText('Select supplier evidence');

    expect(screen.getByLabelText('Pricing behavior')).toHaveValue('keep_sell_prices');
    fireEvent.change(screen.getByLabelText('Cost basis reason'), {
      target: { value: 'Current confirmed supplier quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select supplier evidence' }));

    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledWith(expect.objectContaining({
      source: 'product_page',
      rows: [expect.objectContaining({
        pricing_mode: 'price_driven',
        new_cost: '55.00',
        tier1_price: '62.5',
        tier2_price: '58.82',
        tier3_price: '55.56',
        basis_type: 'selected_supplier_price',
        supplier_price_observation_id: 'observation-1',
        basis_source: 'product_detail',
        basis_selection: true,
      })],
    })));
  });

  it('rejects a cost-basis preview when Product and workspace pricing versions differ', async () => {
    const currentWorkspace = await mockGetCostBasisWorkspace(product.id);
    mockGetCostBasisWorkspace.mockClear();
    mockGetCostBasisWorkspace.mockResolvedValue({
      ...currentWorkspace,
      product: {
        ...currentWorkspace.product,
        pricing_version: product.pricing_version + 1,
      },
    });

    render(<ProductDetail />);
    await screen.findByText('Select supplier evidence');
    fireEvent.change(screen.getByLabelText('Cost basis reason'), {
      target: { value: 'Current confirmed supplier quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select supplier evidence' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Product pricing changed while this cost-basis workspace loaded. Reload before selecting a cost basis.',
    ));
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });

  it('uses a fresh preview intent when a failed supplier selection switches to manual cost', async () => {
    mockPreviewPricing
      .mockRejectedValueOnce(new Error('temporary preview failure'))
      .mockResolvedValueOnce({
        change_set_id: 'manual-change', request_fingerprint: 'manual-fingerprint',
        source: 'product_page', status: 'previewed', expires_at: '2026-07-22T12:00:00Z',
        submitted_row_count: 1, ready_count: 1, unchanged_count: 0,
        conflict_count: 0, invalid_count: 0, apply_allowed: true, rows: [],
      });
    render(<ProductDetail />);
    await screen.findByText('Select supplier evidence');
    fireEvent.change(screen.getByLabelText('Cost basis reason'), {
      target: { value: 'Owner reviewed current evidence' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Select supplier evidence' }));
    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledTimes(1));
    const failedKey = mockPreviewPricing.mock.calls[0][0].idempotencyKey;

    fireEvent.change(screen.getByLabelText('Manual replacement cost'), {
      target: { value: '54.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview manual basis' }));
    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledTimes(2));
    expect(mockPreviewPricing.mock.calls[1][0].idempotencyKey).not.toBe(failedKey);
    expect(mockPreviewPricing.mock.calls[1][0].rows[0]).toMatchObject({
      basis_type: 'manual_override',
      basis_source: 'product_detail',
      new_cost: '54.00',
    });
  });

  it('discards a stale cost-basis workspace after Product route navigation', async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    mockGetCostBasisWorkspace.mockImplementation((productId: string) => (
      productId === product.id ? first : second
    ));
    const { rerender } = render(<ProductDetail />);
    await waitFor(() => expect(mockGetCostBasisWorkspace).toHaveBeenCalledWith(product.id));

    const secondProductId = '22222222-2222-4222-8222-222222222222';
    routeProductId = secondProductId;
    rerender(<ProductDetail />);
    await waitFor(() => expect(mockGetCostBasisWorkspace).toHaveBeenCalledWith(secondProductId));

    resolveSecond({
      enabled: true,
      product: {
        id: secondProductId, product_name: 'Second Product', sku: null, pricing_version: 1,
        current_cost_cents: 6_000n, tier1_margin_percent: '20',
        tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: {
        id: 'basis-2', basis_type: 'manual_override', cost_cents: 6_000n,
        supplier_price_observation_id: null, purchase_order_item_id: null,
        selection_source: 'product_detail', reason: 'Current Product basis',
        selected_at: '2026-07-22T12:00:00Z',
      },
      supplier_candidates: [], purchase_candidates: [],
    });
    expect(await screen.findByText('Current Product basis')).toBeInTheDocument();

    resolveFirst({
      enabled: true,
      product: {
        id: product.id, product_name: product.product_name, sku: product.sku, pricing_version: 7,
        current_cost_cents: 5_000n, tier1_margin_percent: '20',
        tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: {
        id: 'basis-1', basis_type: 'manual_override', cost_cents: 5_000n,
        supplier_price_observation_id: null, purchase_order_item_id: null,
        selection_source: 'product_detail', reason: 'Stale Product basis',
        selected_at: '2026-07-22T11:00:00Z',
      },
      supplier_candidates: [], purchase_candidates: [],
    });
    await waitFor(() => expect(screen.queryByText('Stale Product basis')).not.toBeInTheDocument());
    expect(screen.getByText('Current Product basis')).toBeInTheDocument();
  });

  it('clears an open Product preview when the route changes', async () => {
    const { rerender } = render(<ProductDetail />);
    await screen.findByText('Select supplier evidence');
    fireEvent.change(screen.getByLabelText('Cost basis reason'), {
      target: { value: 'Current confirmed supplier quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select supplier evidence' }));
    expect(await screen.findByText('Ready for approval')).toBeInTheDocument();

    routeProductId = '22222222-2222-4222-8222-222222222222';
    rerender(<ProductDetail />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('discards an in-flight Product preview when the route changes', async () => {
    let resolvePreview!: (value: unknown) => void;
    mockPreviewPricing.mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve; }));
    const { rerender } = render(<ProductDetail />);
    await screen.findByText('Select supplier evidence');
    fireEvent.change(screen.getByLabelText('Cost basis reason'), {
      target: { value: 'Current confirmed supplier quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select supplier evidence' }));
    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledTimes(1));

    routeProductId = '22222222-2222-4222-8222-222222222222';
    rerender(<ProductDetail />);
    act(() => {
      resolvePreview({
        change_set_id: 'stale-change', request_fingerprint: 'stale-fingerprint',
        source: 'product_page', status: 'previewed', expires_at: '2026-07-22T12:00:00Z',
        submitted_row_count: 1, ready_count: 1, unchanged_count: 0,
        conflict_count: 0, invalid_count: 0, apply_allowed: true,
        rows: [{
          sequence: 1, product_id: product.id, submitted_row: {}, row_status: 'ready',
          error_code: null, effect: {},
        }],
      });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('reports a basis-only apply as a selected cost basis, not zero Products priced', async () => {
    mockApplyPricing.mockResolvedValueOnce({
      change_set_id: 'basis-change',
      status: 'applied',
      applied_count: 0,
      rows: [],
      cost_basis_rows: [{ product_id: product.id }],
    });
    render(<ProductDetail />);
    await screen.findByText('Select supplier evidence');
    fireEvent.change(screen.getByLabelText('Cost basis reason'), {
      target: { value: 'Current confirmed supplier quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select supplier evidence' }));
    await screen.findByText('Ready for approval');
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'success',
      'Selected cost basis for 1 Product.',
    ));
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Applied pricing to 0 Product.');
  });

  it('reports both basis selection and sell-price application when both occur', async () => {
    mockApplyPricing.mockResolvedValueOnce({
      change_set_id: 'basis-reprice-change',
      status: 'applied',
      applied_count: 1,
      rows: [],
      cost_basis_rows: [{ product_id: product.id }],
    });
    render(<ProductDetail />);
    await screen.findByText('Select supplier evidence');
    fireEvent.change(screen.getByLabelText('Pricing behavior'), {
      target: { value: 'keep_margins_and_reprice' },
    });
    fireEvent.change(screen.getByLabelText('Cost basis reason'), {
      target: { value: 'Reprice from confirmed supplier quote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select supplier evidence' }));
    await screen.findByText('Ready for approval');
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'success',
      'Selected cost basis and applied pricing to 1 Product.',
    ));
  });

  it('requires an explicit mode when saved prices and margins are both populated', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');

    expect(screen.getByLabelText('Pricing mode')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
    fireEvent.change(screen.getByLabelText('New Cost'), { target: { value: '55.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Cost Change' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Choose margin-driven or price-driven before reviewing pricing.',
    ));
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });

  it('previews and applies a quick cost change without a direct products update', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');

    fireEvent.change(screen.getByLabelText('Pricing mode'), { target: { value: 'margin_driven' } });
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

    fireEvent.change(screen.getByLabelText('Pricing mode'), { target: { value: 'margin_driven' } });
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

  it('locks editing until the authoritative post-apply Product reload succeeds', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');

    fireEvent.change(screen.getByLabelText('Pricing mode'), { target: { value: 'margin_driven' } });
    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
    fireEvent.change(screen.getByLabelText('New Cost'), { target: { value: '55.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Cost Change' }));
    await screen.findByText('Ready for approval');

    // Keep the quick-cost modal mounted while apply finishes so its own lock is
    // verified in addition to the main Product fieldset.
    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));
    productLoadResults.push({ data: null, error: new Error('reload failed') });
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));

    expect(await screen.findByText(/Editing is locked until the latest values load/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Current Cost')).toBeDisabled();
    expect(screen.getByLabelText('New Cost')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reload Product' }));
    await waitFor(() => {
      expect(screen.queryByText(/Editing is locked until the latest values load/i)).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Current Cost')).not.toBeDisabled();
  });

  it('preserves exact cents from the Product pricing form through preview', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');

    fireEvent.change(screen.getByLabelText('Pricing mode'), { target: { value: 'price_driven' } });
    fireEvent.change(screen.getByLabelText('Current Cost'), {
      target: { value: '90071992547409.93' },
    });
    fireEvent.change(screen.getByLabelText('Tier 1 price'), {
      target: { value: '90071992547410.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        pricing_mode: 'price_driven',
        new_cost: '90071992547409.93',
        tier1_price: '90071992547410.01',
      })],
    })));
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
