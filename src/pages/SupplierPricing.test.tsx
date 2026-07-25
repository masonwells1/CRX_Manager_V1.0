import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockToast,
  mockGetWorkspace,
  mockGetImport,
  mockGetBasisWorkspace,
  mockPreviewPricing,
  mockResetIdempotencyKey,
  mockSentryCaptureException,
} = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockGetWorkspace: vi.fn(),
  mockGetImport: vi.fn(),
  mockGetBasisWorkspace: vi.fn(),
  mockPreviewPricing: vi.fn(),
  mockResetIdempotencyKey: vi.fn(),
  mockSentryCaptureException: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idempotency-key', resetKey: mockResetIdempotencyKey }),
}));

vi.mock('../lib/supplierPricing', async () => {
  const actual = await vi.importActual<typeof import('../lib/supplierPricing')>('../lib/supplierPricing');
  return {
    ...actual,
    getSupplierPricingWorkspace: mockGetWorkspace,
    getSupplierPriceImport: mockGetImport,
    getSupplierQuoteSheet: vi.fn(),
    approveSupplierPriceImport: vi.fn(),
    reviewVendorAlias: vi.fn(),
    stageSupplierPriceImport: vi.fn(),
    stageVendorAlias: vi.fn(),
    uploadSupplierSourcePdf: vi.fn(),
    upsertProductSupplierLink: vi.fn(),
  };
});

vi.mock('../lib/productCostBasis', async () => {
  const actual = await vi.importActual<typeof import('../lib/productCostBasis')>('../lib/productCostBasis');
  return { ...actual, getProductCostBasisWorkspace: mockGetBasisWorkspace };
});

vi.mock('../lib/productPricing', async () => {
  const actual = await vi.importActual<typeof import('../lib/productPricing')>('../lib/productPricing');
  return {
    ...actual,
    previewProductPricingChanges: mockPreviewPricing,
    applyProductPricingChangeSet: vi.fn(),
  };
});

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: mockSentryCaptureException },
}));

import SupplierPricing from './SupplierPricing';

function renderSupplierPricing() {
  return render(
    <MemoryRouter>
      <SupplierPricing />
    </MemoryRouter>,
  );
}

describe('SupplierPricing page', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBasisWorkspace.mockResolvedValue({
      enabled: false,
      product: {
        id: 'product-1', product_name: 'Atrazine', sku: 'A-1', pricing_version: 7,
        current_cost_cents: 10_000n, tier1_margin_percent: '20',
        tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: null,
      supplier_candidates: [],
      purchase_candidates: [],
    });
  });

  it('shows the manual-only boundary and the zero-sell-price import review gate', async () => {
    mockGetWorkspace.mockResolvedValue({
      vendors: [{ id: 'vendor-1', name: 'The Andersons' }],
      products: [{ id: 'product-1', product_name: 'Atrazine', sku: 'A-1', inventory_unit: 'gallon' }],
      links: [{
        id: 'link-1', product_id: 'product-1', product_name: 'Atrazine',
        vendor_id: 'vendor-1', vendor_name: 'The Andersons', supplier_sku: 'AND-1',
        supplier_product_name: 'Atrazine 4L', supplier_uom: 'case',
        supplier_pack_description: '2 x 2.5 gal', inventory_units_per_supplier_unit: 5,
        conversion_unit: 'gallons', comparison_status: 'comparable', comparison_note: null,
        link_status: 'confirmed', is_reusable: true, is_preferred: true, is_active: true,
      }],
      imports: [{
        id: 'import-1', vendor_id: 'vendor-1', vendor_name: 'The Andersons',
        document_date: '2026-07-18', ingestion_method: 'quote_sheet', status: 'needs_review',
        row_count: 1, eligible_row_count: 1, approved_observation_count: 0,
        source_document_name: 'quote.pdf', created_at: '2026-07-18T12:00:00Z',
      }],
      aliases: [],
      evidence: [],
    });
    mockGetImport.mockResolvedValue({
      id: 'import-1', vendor_id: 'vendor-1', vendor_name: 'The Andersons',
      document_date: '2026-07-18', ingestion_method: 'quote_sheet',
      format_version: 'crx-supplier-quote-phase1b-v1', status: 'needs_review',
      source_document_name: 'quote.pdf', row_count: 1, eligible_row_count: 1,
      approved_observation_count: 0, created_at: '2026-07-18T12:00:00Z',
      rows: [{
        id: 'row-1', row_number: 1, product_id: 'product-1', product_name: 'Atrazine',
        product_supplier_link_id: 'link-1', supplier_sku: 'AND-1',
        supplier_product_name: 'Atrazine 4L', cost_cents: 12_500n, price_unit: 'case',
        package_quantity: 1, effective_from: '2026-07-18', effective_to: null,
        price_kind: 'quote', row_status: 'new', validation_errors: [], observation_id: null,
      }],
    });

    renderSupplierPricing();

    expect(await screen.findByRole('heading', { name: 'Supplier Pricing' })).toBeInTheDocument();
    expect(screen.getByText(
      'Manual supplier evidence only. Observation approval changes no sell prices; cost-basis changes require a separate preview and approval.',
    )).toBeInTheDocument();
    expect(screen.getByText(/No OCR or AI extraction/)).toBeInTheDocument();
    expect(screen.getByText(/PDFs are retained only as audit evidence/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download prefilled .xlsx/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /The Andersons/ }));

    await waitFor(() => expect(mockGetImport).toHaveBeenCalledWith('import-1'));
    expect(screen.getByText(
      'You are adding 1 supplier observations. You are changing ZERO sell prices.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve selected observations' })).toBeInTheDocument();

    await waitFor(() => expect(mockGetBasisWorkspace).toHaveBeenCalledWith('product-1'));
    const workspaceLoads = mockGetWorkspace.mock.calls.length;
    const basisLoads = mockGetBasisWorkspace.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(mockGetWorkspace).toHaveBeenCalledTimes(workspaceLoads + 1);
      expect(mockGetBasisWorkspace).toHaveBeenCalledTimes(basisLoads + 1);
    });
  });

  it('clears an already-populated workspace when the current refresh fails', async () => {
    const populated = {
      vendors: [{ id: 'vendor-1', name: 'Current vendor' }],
      products: [{ id: '11111111-1111-4111-8111-111111111111', product_name: 'Current Product', sku: 'CUR-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    mockGetWorkspace.mockResolvedValueOnce(populated).mockRejectedValueOnce(new Error('metadata hydration failed'));

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('tab', { name: 'Comparison' }));
    const productSelect = screen.getByLabelText('Product');
    await waitFor(() => expect(productSelect).toHaveValue(populated.products[0].id));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'metadata hydration failed'));
    expect(mockSentryCaptureException).toHaveBeenCalled();
    expect(productSelect).toHaveValue('');
    expect(screen.queryByRole('option', { name: /Current Product/ })).not.toBeInTheDocument();
  });

  it('ignores stale workspace completions after a newer refresh wins', async () => {
    const newest = {
      vendors: [],
      products: [{ id: '22222222-2222-4222-8222-222222222222', product_name: 'Newest Product', sku: 'NEW-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    let resolveFirst!: (value: typeof newest) => void;
    const first = new Promise<typeof newest>((resolve) => { resolveFirst = resolve; });
    mockGetWorkspace.mockImplementationOnce(() => first).mockResolvedValueOnce(newest);

    renderSupplierPricing();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-busy', 'true'));
    fireEvent.click(screen.getByRole('tab', { name: 'Comparison' }));
    expect(await screen.findByRole('option', { name: /Newest Product/ })).toBeInTheDocument();

    act(() => {
      resolveFirst({
        vendors: [],
        products: [{ id: '33333333-3333-4333-8333-333333333333', product_name: 'Stale Product', sku: 'OLD-1', inventory_unit: 'gallon' }],
        links: [], imports: [], aliases: [], evidence: [],
      });
    });
    await Promise.resolve();
    expect(screen.queryByRole('option', { name: /Stale Product/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Newest Product/ })).toBeInTheDocument();
  });

  it('ignores a stale workspace failure after a newer refresh succeeds', async () => {
    let rejectFirst!: (reason?: unknown) => void;
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const newest = {
      vendors: [],
      products: [{ id: '66666666-6666-4666-8666-666666666666', product_name: 'Newest Product', sku: 'NEW-2', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    mockGetWorkspace.mockImplementationOnce(() => first).mockResolvedValueOnce(newest);

    renderSupplierPricing();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Comparison' }));
    expect(await screen.findByRole('option', { name: /Newest Product/ })).toBeInTheDocument();

    act(() => rejectFirst(new Error('stale hydration failure')));
    await Promise.resolve();
    expect(mockToast).not.toHaveBeenCalledWith('error', 'stale hydration failure');
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /Newest Product/ })).toBeInTheDocument();
  });

  it('replaces selections that no longer belong to a successful refreshed workspace', async () => {
    const initial = {
      vendors: [{ id: 'vendor-old', name: 'Old vendor' }],
      products: [{ id: '44444444-4444-4444-8444-444444444444', product_name: 'Old Product', sku: 'OLD-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    const refreshed = {
      vendors: [{ id: 'vendor-new', name: 'New vendor' }],
      products: [{ id: '55555555-5555-4555-8555-555555555555', product_name: 'New Product', sku: 'NEW-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    mockGetWorkspace.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('tab', { name: 'Comparison' }));
    const productSelect = screen.getByLabelText('Product');
    await waitFor(() => expect(productSelect).toHaveValue(initial.products[0].id));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(productSelect).toHaveValue(refreshed.products[0].id));
  });

  it('routes comparable supplier evidence to the single-Product governed flow', async () => {
    mockGetWorkspace.mockResolvedValue({
      vendors: [{ id: 'vendor-1', name: 'The Andersons' }],
      products: [{ id: 'product-1', product_name: 'Atrazine', sku: 'A-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    });
    mockGetBasisWorkspace.mockResolvedValue({
      enabled: true,
      product: {
        id: 'product-1', product_name: 'Atrazine', sku: 'A-1', pricing_version: 7,
        current_cost_cents: 10_000n, tier1_margin_percent: '20',
        tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: {
        id: 'basis-1', basis_type: 'manual_override', cost_cents: 10_000n,
        supplier_price_observation_id: null, purchase_order_item_id: null,
        selection_source: 'migration_baseline', reason: 'Baseline',
        selected_at: '2026-07-21T12:00:00Z',
      },
      supplier_candidates: [{
        supplier_price_observation_id: 'observation-1', vendor_id: 'vendor-1',
        vendor_name: 'The Andersons', quoted_package_cost_cents: 60_000n,
        normalized_cost_cents: 12_000n, effective_from: '2026-07-21', price_kind: 'quote',
      }],
      purchase_candidates: [],
    });
    mockPreviewPricing.mockResolvedValue({
      change_set_id: 'change-1', request_fingerprint: 'fingerprint-1',
      source: 'product_page', status: 'previewed', expires_at: '2026-07-21T14:00:00Z',
      submitted_row_count: 1, ready_count: 1, unchanged_count: 0,
      conflict_count: 0, invalid_count: 0, apply_allowed: true, rows: [],
    });

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('tab', { name: 'Comparison' }));
    expect(await screen.findByText('The Andersons')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Product cost-basis flow' }))
      .toHaveAttribute('href', '/products/product-1');
    expect(screen.queryByRole('button', { name: 'Preview as cost basis' })).not.toBeInTheDocument();
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });

  it('keeps multiple supplier candidates read-only in the comparison workspace', async () => {
    mockGetWorkspace.mockResolvedValue({
      vendors: [],
      products: [{ id: 'product-1', product_name: 'Atrazine', sku: 'A-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    });
    mockGetBasisWorkspace.mockResolvedValue({
      enabled: true,
      product: {
        id: 'product-1', product_name: 'Atrazine', sku: 'A-1', pricing_version: 7,
        current_cost_cents: 10_000n, tier1_margin_percent: '20',
        tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: null,
      supplier_candidates: [
        {
          supplier_price_observation_id: 'observation-1', vendor_id: 'vendor-1',
          vendor_name: 'First supplier', quoted_package_cost_cents: 60_000n,
          normalized_cost_cents: 12_000n, effective_from: '2026-07-21', price_kind: 'quote',
        },
        {
          supplier_price_observation_id: 'observation-2', vendor_id: 'vendor-2',
          vendor_name: 'Second supplier', quoted_package_cost_cents: 65_000n,
          normalized_cost_cents: 13_000n, effective_from: '2026-07-21', price_kind: 'quote',
        },
      ],
      purchase_candidates: [],
    });
    mockPreviewPricing
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        change_set_id: 'change-2', request_fingerprint: 'fingerprint-2',
        source: 'product_page', status: 'previewed', expires_at: '2026-07-21T14:00:00Z',
        submitted_row_count: 1, ready_count: 1, unchanged_count: 0,
        conflict_count: 0, invalid_count: 0, apply_allowed: true, rows: [],
      });

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('tab', { name: 'Comparison' }));
    expect(await screen.findByText('First supplier')).toBeInTheDocument();
    expect(screen.getByText('Second supplier')).toBeInTheDocument();
    expect(screen.getAllByText('Select from Product Detail')).toHaveLength(2);
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });

  it('labels a received PO candidate without claiming it was paid or applying from comparison', async () => {
    mockGetWorkspace.mockResolvedValue({
      vendors: [],
      products: [{ id: 'product-1', product_name: 'Atrazine', sku: 'A-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    });
    mockGetBasisWorkspace.mockResolvedValue({
      enabled: true,
      product: {
        id: 'product-1', product_name: 'Atrazine', sku: 'A-1', pricing_version: 7,
        current_cost_cents: 10_000n, tier1_margin_percent: '20',
        tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: null,
      supplier_candidates: [],
      purchase_candidates: [{
        purchase_order_item_id: 'po-item-1', purchase_order_id: 'po-1',
        po_number: 'PO-10', vendor_name: 'The Andersons',
        normalized_cost_cents: 12_000n, purchased_at: '2026-07-21T12:00:00Z',
      }],
    });
    mockPreviewPricing.mockResolvedValue({
      change_set_id: 'change-po', request_fingerprint: 'fingerprint-po',
      source: 'product_page', status: 'previewed', expires_at: '2026-07-21T14:00:00Z',
      submitted_row_count: 1, ready_count: 1, unchanged_count: 0,
      conflict_count: 0, invalid_count: 0, apply_allowed: true, rows: [],
    });

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('tab', { name: 'Comparison' }));

    expect(await screen.findByText('Normalized received cost: $120.00')).toBeInTheDocument();
    expect(screen.queryByText(/paid/i)).not.toBeInTheDocument();
    expect(screen.getByText('Select from Product Detail')).toBeInTheDocument();
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });

  it('discards stale cost-basis loads and clears actions when the Product selection is cleared', async () => {
    mockGetWorkspace.mockResolvedValue({
      vendors: [],
      products: [
        { id: 'product-1', product_name: 'Atrazine', sku: 'A-1', inventory_unit: 'gallon' },
        { id: 'product-2', product_name: 'Glyphosate', sku: 'G-1', inventory_unit: 'gallon' },
      ],
      links: [], imports: [], aliases: [], evidence: [],
    });

    let resolveFirst!: (value: Awaited<ReturnType<typeof mockGetBasisWorkspace>>) => void;
    let resolveSecond!: (value: Awaited<ReturnType<typeof mockGetBasisWorkspace>>) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    mockGetBasisWorkspace.mockImplementation((productId: string) => (
      productId === 'product-1' ? first : second
    ));

    const workspaceFor = (productId: string, productName: string, vendorName: string) => ({
      enabled: true,
      product: {
        id: productId, product_name: productName, sku: null, pricing_version: 1,
        current_cost_cents: 10_000n, tier1_margin_percent: '20',
        tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: null,
      supplier_candidates: [{
        supplier_price_observation_id: `observation-${productId}`,
        vendor_id: `vendor-${productId}`, vendor_name: vendorName,
        quoted_package_cost_cents: 12_000n, normalized_cost_cents: 12_000n,
        effective_from: '2026-07-21', price_kind: 'quote',
      }],
      purchase_candidates: [],
    });

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('tab', { name: 'Comparison' }));
    await waitFor(() => expect(mockGetBasisWorkspace).toHaveBeenCalledWith('product-1'));

    const productSelect = screen.getByLabelText('Product');
    fireEvent.change(productSelect, { target: { value: 'product-2' } });
    await waitFor(() => expect(mockGetBasisWorkspace).toHaveBeenCalledWith('product-2'));

    act(() => {
      resolveSecond(workspaceFor('product-2', 'Glyphosate', 'Current supplier'));
    });
    expect(await screen.findByText('Current supplier')).toBeInTheDocument();

    act(() => {
      resolveFirst(workspaceFor('product-1', 'Atrazine', 'Stale supplier'));
    });
    expect(screen.queryByText('Stale supplier')).not.toBeInTheDocument();
    expect(screen.getByText('Current supplier')).toBeInTheDocument();

    fireEvent.change(productSelect, { target: { value: '' } });
    expect(screen.queryByText('Current supplier')).not.toBeInTheDocument();
    expect(screen.getByText('Choose a Product to load its selected cost basis.')).toBeInTheDocument();
  });

  it('updates the Product-detail destination when the selected Product changes', async () => {
    mockGetWorkspace.mockResolvedValue({
      vendors: [],
      products: [
        { id: 'product-1', product_name: 'Atrazine', sku: 'A-1', inventory_unit: 'gallon' },
        { id: 'product-2', product_name: 'Glyphosate', sku: 'G-1', inventory_unit: 'gallon' },
      ],
      links: [], imports: [], aliases: [], evidence: [],
    });
    mockGetBasisWorkspace.mockImplementation(async (productId: string) => ({
      enabled: true,
      product: {
        id: productId, product_name: productId === 'product-1' ? 'Atrazine' : 'Glyphosate',
        sku: null, pricing_version: 1, current_cost_cents: 10_000n,
        tier1_margin_percent: '20', tier2_margin_percent: '15', tier3_margin_percent: '10',
      },
      current_basis: null,
      supplier_candidates: productId === 'product-1' ? [{
        supplier_price_observation_id: 'observation-1', vendor_id: 'vendor-1',
        vendor_name: 'Pending supplier', quoted_package_cost_cents: 12_000n,
        normalized_cost_cents: 12_000n, effective_from: '2026-07-21', price_kind: 'quote',
      }] : [],
      purchase_candidates: [],
    }));
    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('tab', { name: 'Comparison' }));
    expect(await screen.findByRole('link', { name: 'Open Product cost-basis flow' }))
      .toHaveAttribute('href', '/products/product-1');

    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'product-2' } });
    await waitFor(() => expect(mockGetBasisWorkspace).toHaveBeenCalledWith('product-2'));
    expect(await screen.findByRole('link', { name: 'Open Product cost-basis flow' }))
      .toHaveAttribute('href', '/products/product-2');
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });
});
