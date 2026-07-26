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
  mockStageSupplierPriceImport,
  mockStageVendorAlias,
  mockUploadSupplierSourcePdf,
  mockUpsertProductSupplierLink,
  mockParseSupplierQuoteWorkbook,
} = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockGetWorkspace: vi.fn(),
  mockGetImport: vi.fn(),
  mockGetBasisWorkspace: vi.fn(),
  mockPreviewPricing: vi.fn(),
  mockResetIdempotencyKey: vi.fn(),
  mockSentryCaptureException: vi.fn(),
  mockStageSupplierPriceImport: vi.fn(),
  mockStageVendorAlias: vi.fn(),
  mockUploadSupplierSourcePdf: vi.fn(),
  mockUpsertProductSupplierLink: vi.fn(),
  mockParseSupplierQuoteWorkbook: vi.fn(),
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
    stageSupplierPriceImport: mockStageSupplierPriceImport,
    stageVendorAlias: mockStageVendorAlias,
    uploadSupplierSourcePdf: mockUploadSupplierSourcePdf,
    upsertProductSupplierLink: mockUpsertProductSupplierLink,
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

vi.mock('../lib/supplierPricingWorkbook', async () => {
  const actual = await vi.importActual<typeof import('../lib/supplierPricingWorkbook')>('../lib/supplierPricingWorkbook');
  return { ...actual, parseSupplierQuoteWorkbook: mockParseSupplierQuoteWorkbook };
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

function makeImportSummary(
  id: string,
  vendorName: string,
  status: 'needs_review' | 'approved' = 'needs_review',
) {
  return {
    id,
    vendor_id: `vendor-${id}`,
    vendor_name: vendorName,
    document_date: '2026-07-18',
    ingestion_method: 'quote_sheet' as const,
    status,
    row_count: 1,
    eligible_row_count: status === 'needs_review' ? 1 : 0,
    approved_observation_count: status === 'approved' ? 1 : 0,
    source_document_name: `${id}.pdf`,
    created_at: '2026-07-18T12:00:00Z',
  };
}

function makeImportDetail(
  id: string,
  vendorName: string,
  productName: string,
  status: 'needs_review' | 'approved' = 'needs_review',
) {
  return {
    ...makeImportSummary(id, vendorName, status),
    format_version: 'crx-supplier-quote-phase1b-v1',
    rows: [{
      id: `row-${id}`,
      row_number: 1,
      product_id: `product-${id}`,
      product_name: productName,
      product_supplier_link_id: `link-${id}`,
      supplier_sku: `SKU-${id}`,
      supplier_product_name: productName,
      cost_cents: 12_500n,
      price_unit: 'case',
      package_quantity: 1,
      effective_from: '2026-07-18',
      effective_to: null,
      price_kind: 'quote',
      row_status: status === 'approved' ? 'approved' as const : 'new' as const,
      validation_errors: [],
      observation_id: status === 'approved' ? `observation-${id}` : null,
    }],
  };
}

describe('SupplierPricing page', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadSupplierSourcePdf.mockResolvedValue('supplier-evidence/source.pdf');
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
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(mockGetWorkspace).toHaveBeenCalledTimes(workspaceLoads + 1);
    });
  });

  it('keeps the workbook supplier selected through its immediate workspace refresh', async () => {
    const vendors = [
      { id: 'vendor-a', name: 'Supplier A' },
      { id: 'vendor-b', name: 'Supplier B' },
    ];
    const stagedImport = {
      ...makeImportDetail('import-b', 'Supplier B', 'Workbook Product'),
      vendor_id: 'vendor-b',
    };
    mockGetWorkspace
      .mockResolvedValueOnce({
        vendors,
        products: [],
        links: [],
        imports: [],
        aliases: [],
        evidence: [],
      })
      .mockResolvedValueOnce({
        vendors,
        products: [],
        links: [],
        imports: [makeImportSummary('import-b', 'Supplier B')],
        aliases: [],
        evidence: [],
      });
    mockParseSupplierQuoteWorkbook.mockResolvedValue({
      vendorId: 'vendor-b',
      formatVersion: 'crx-supplier-quote-phase1b-v1',
      rows: [],
    });
    mockStageSupplierPriceImport.mockResolvedValue(stagedImport);
    mockGetImport.mockResolvedValue(stagedImport);

    const { container } = renderSupplierPricing();
    const supplierSelect = await screen.findByLabelText('Supplier');
    expect(supplierSelect).toHaveValue('vendor-a');
    const workbookInput = container.querySelector<HTMLInputElement>('input[accept^=".xlsx"]');
    expect(workbookInput).not.toBeNull();
    fireEvent.change(workbookInput!, {
      target: {
        files: [new File(['workbook'], 'supplier-b.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })],
      },
    });

    await waitFor(() => expect(supplierSelect).toHaveValue('vendor-b'));
    expect(mockStageSupplierPriceImport).toHaveBeenCalledWith(expect.objectContaining({ vendorId: 'vendor-b' }));
  });

  it('keeps the latest import detail when rapid opens resolve out of order', async () => {
    const importA = makeImportDetail('import-a', 'Supplier A', 'Product from A');
    const importB = makeImportDetail('import-b', 'Supplier B', 'Product from B');
    let resolveA!: (value: typeof importA) => void;
    let resolveB!: (value: typeof importB) => void;
    const pendingA = new Promise<typeof importA>((resolve) => { resolveA = resolve; });
    const pendingB = new Promise<typeof importB>((resolve) => { resolveB = resolve; });

    mockGetWorkspace.mockResolvedValue({
      vendors: [],
      products: [],
      links: [],
      imports: [
        makeImportSummary('import-a', 'Supplier A'),
        makeImportSummary('import-b', 'Supplier B'),
      ],
      aliases: [],
      evidence: [],
    });
    mockGetImport.mockImplementation((id: string) => id === 'import-a' ? pendingA : pendingB);

    renderSupplierPricing();
    const openA = await screen.findByRole('button', { name: /Supplier A/ });
    const openB = screen.getByRole('button', { name: /Supplier B/ });
    act(() => {
      openA.click();
      openB.click();
    });
    expect(mockGetImport).toHaveBeenNthCalledWith(1, 'import-a');
    expect(mockGetImport).toHaveBeenNthCalledWith(2, 'import-b');

    await act(async () => {
      resolveB(importB);
      await pendingB;
    });
    expect(await screen.findAllByText('Product from B')).toHaveLength(2);

    await act(async () => {
      resolveA(importA);
      await pendingA;
    });
    expect(screen.getAllByText('Product from B')).toHaveLength(2);
    expect(screen.queryAllByText('Product from A')).toHaveLength(0);
  });

  it('invalidates a pending import on refresh and reloads a same-ID status change', async () => {
    const importA = makeImportDetail('import-a', 'Supplier A', 'Product from A');
    const importBNeedsReview = makeImportDetail('import-b', 'Supplier B', 'Product from B');
    const importBApproved = makeImportDetail('import-b', 'Supplier B', 'Product from B', 'approved');
    const initialWorkspace = {
      vendors: [],
      products: [],
      links: [],
      imports: [
        makeImportSummary('import-a', 'Supplier A'),
        makeImportSummary('import-b', 'Supplier B'),
      ],
      aliases: [],
      evidence: [],
    };
    const withoutA = {
      ...initialWorkspace,
      imports: [makeImportSummary('import-b', 'Supplier B')],
    };
    const withBApproved = {
      ...initialWorkspace,
      imports: [makeImportSummary('import-b', 'Supplier B', 'approved')],
    };
    let resolveA!: (value: typeof importA) => void;
    const pendingA = new Promise<typeof importA>((resolve) => { resolveA = resolve; });
    let importBLoads = 0;
    mockGetWorkspace
      .mockResolvedValueOnce(initialWorkspace)
      .mockResolvedValueOnce(withoutA)
      .mockResolvedValueOnce(withBApproved);
    mockGetImport.mockImplementation((id: string) => {
      if (id === 'import-a') return pendingA;
      importBLoads += 1;
      return Promise.resolve(importBLoads === 1 ? importBNeedsReview : importBApproved);
    });

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('button', { name: /Supplier A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Supplier A/ })).not.toBeInTheDocument());

    await act(async () => {
      resolveA(importA);
      await pendingA;
    });
    expect(screen.queryAllByText('Product from A')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Supplier B/ }));
    expect(await screen.findAllByText('Product from B')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Approve selected observations' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Approve selected observations' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reject import' })).not.toBeInTheDocument();
    });
    expect(importBLoads).toBe(2);
    expect(screen.getAllByText('approved').length).toBeGreaterThan(0);
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

  it('preserves a refreshed workspace when only the current import review refetch fails', async () => {
    const workspace = {
      vendors: [{ id: 'vendor-1', name: 'Current vendor' }],
      products: [{ id: '11111111-1111-4111-8111-111111111111', product_name: 'Current Product', sku: 'CUR-1', inventory_unit: 'gallon' }],
      links: [],
      imports: [makeImportSummary('import-1', 'Current vendor')],
      aliases: [],
      evidence: [],
    };
    mockGetWorkspace.mockResolvedValue(workspace);
    mockGetImport
      .mockResolvedValueOnce(makeImportDetail('import-1', 'Current vendor', 'Current Product'))
      .mockRejectedValueOnce(new Error('review refetch unavailable'));

    renderSupplierPricing();
    fireEvent.click(await screen.findByRole('button', { name: /Current vendor/ }));
    expect(await screen.findByRole('button', { name: 'Approve selected observations' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'review refetch unavailable'));
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { context: 'refresh_supplier_price_import' } }),
    );
    expect(screen.queryByRole('button', { name: 'Approve selected observations' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Current vendor/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Comparison' }));
    const productSelect = screen.getByLabelText('Product');
    await waitFor(() => expect(productSelect).toHaveValue(workspace.products[0].id));
    expect(screen.getByRole('option', { name: /Current Product/ })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('tab', { name: 'Comparison' }));
    expect(await screen.findByRole('option', { name: /Newest Product/ })).toBeInTheDocument();

    await act(async () => {
      resolveFirst({
        vendors: [],
        products: [{ id: '33333333-3333-4333-8333-333333333333', product_name: 'Stale Product', sku: 'OLD-1', inventory_unit: 'gallon' }],
        links: [], imports: [], aliases: [], evidence: [],
      });
      await first;
    });
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: /Stale Product/ })).not.toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Newest Product/ })).toBeInTheDocument();
    });
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

    await act(async () => {
      rejectFirst(new Error('stale hydration failure'));
      await first.catch(() => undefined);
    });
    await waitFor(() => {
      expect(mockToast).not.toHaveBeenCalledWith('error', 'stale hydration failure');
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
      expect(screen.getByRole('option', { name: /Newest Product/ })).toBeInTheDocument();
    });
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

  it('loads cost basis exactly once for the final reconciled Product after refresh', async () => {
    const initial = {
      vendors: [],
      products: [{ id: 'basis-old', product_name: 'Old Basis Product', sku: 'BASIS-OLD', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    const refreshed = {
      vendors: [],
      products: [{ id: 'basis-new', product_name: 'New Basis Product', sku: 'BASIS-NEW', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    mockGetWorkspace.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);

    renderSupplierPricing();
    await waitFor(() => expect(mockGetBasisWorkspace).toHaveBeenCalledWith('basis-old'));
    mockGetBasisWorkspace.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mockGetBasisWorkspace).toHaveBeenCalledWith('basis-new'));
    expect(mockGetBasisWorkspace).toHaveBeenCalledTimes(1);
    expect(mockGetBasisWorkspace).not.toHaveBeenCalledWith('basis-old');
  });

  it('reconciles every stale vendor/product/link form ID before a refreshed workspace can submit it', async () => {
    const oldWorkspace = {
      vendors: [{ id: 'vendor-old', name: 'Old vendor' }],
      products: [{ id: '77777777-7777-4777-8777-777777777777', product_name: 'Old Product', sku: 'OLD-1', inventory_unit: 'gallon' }],
      links: [{
        id: 'link-old', product_id: '77777777-7777-4777-8777-777777777777', product_name: 'Old Product',
        vendor_id: 'vendor-old', vendor_name: 'Old vendor', supplier_sku: 'OLD-SKU', supplier_product_name: 'Old Product',
        supplier_uom: 'case', supplier_pack_description: null, inventory_units_per_supplier_unit: 1,
        conversion_unit: 'gallon', comparison_status: 'comparable' as const, comparison_note: null,
        link_status: 'confirmed' as const, is_reusable: true, is_preferred: false, is_active: true,
      }],
      imports: [], aliases: [], evidence: [],
    };
    const refreshedWorkspace = {
      vendors: [{ id: 'vendor-new', name: 'New vendor' }],
      products: [{ id: '88888888-8888-4888-8888-888888888888', product_name: 'New Product', sku: 'NEW-1', inventory_unit: 'gallon' }],
      links: [], imports: [], aliases: [], evidence: [],
    };
    mockGetWorkspace.mockResolvedValueOnce(oldWorkspace).mockResolvedValueOnce(refreshedWorkspace);

    renderSupplierPricing();
    await screen.findByRole('option', { name: /Old Product/ });
    fireEvent.change(screen.getByLabelText('Linked Product'), { target: { value: 'link-old' } });
    fireEvent.change(screen.getByLabelText('Quoted cost (dollars)'), { target: { value: '12.50' } });

    fireEvent.click(screen.getByRole('tab', { name: /Product links/ }));
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: oldWorkspace.products[0].id } });
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'vendor-old' } });
    fireEvent.change(screen.getByLabelText('Supplier SKU'), { target: { value: 'OLD-SKU' } });

    fireEvent.click(screen.getByRole('tab', { name: /Vendor aliases/ }));
    fireEvent.change(screen.getByLabelText('Alias spelling'), { target: { value: 'Old alias' } });
    fireEvent.change(screen.getByLabelText('Proposed canonical vendor'), { target: { value: 'vendor-old' } });

    mockUpsertProductSupplierLink.mockClear();
    mockStageSupplierPriceImport.mockClear();
    mockStageVendorAlias.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByLabelText('Proposed canonical vendor')).toHaveValue(''));

    fireEvent.click(screen.getByRole('tab', { name: /Product links/ }));
    expect(screen.getByLabelText('Product')).toHaveValue('');
    expect(screen.getByLabelText('Supplier')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Save confirmed link' }));
    expect(mockUpsertProductSupplierLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Quote review' }));
    expect(screen.getByLabelText('Linked Product')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Stage quick quote' }));
    expect(mockStageSupplierPriceImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /Vendor aliases/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
    expect(mockStageVendorAlias).not.toHaveBeenCalled();
  });

  it('removes a Quick Quote link when its Product disappears but the link remains', async () => {
    const product = {
      id: '99999999-9999-4999-8999-999999999999',
      product_name: 'Duplicate Name',
      sku: 'EXACT-SKU',
      inventory_unit: 'gallon',
    };
    const link = {
      id: 'link-still-returned',
      product_id: product.id,
      product_name: product.product_name,
      vendor_id: 'vendor-1',
      vendor_name: 'Supplier One',
      supplier_sku: 'SUP-1',
      supplier_product_name: product.product_name,
      supplier_uom: 'case',
      supplier_pack_description: null,
      inventory_units_per_supplier_unit: 1,
      conversion_unit: 'gallon',
      comparison_status: 'comparable' as const,
      comparison_note: null,
      link_status: 'confirmed' as const,
      is_reusable: true,
      is_preferred: false,
      is_active: true,
    };
    const initial = {
      vendors: [{ id: 'vendor-1', name: 'Supplier One' }],
      products: [product],
      links: [link],
      imports: [], aliases: [], evidence: [],
    };
    const refreshed = {
      ...initial,
      products: [],
      links: [link],
    };
    mockGetWorkspace.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);

    renderSupplierPricing();
    const linkedProduct = await screen.findByLabelText('Linked Product');
    expect(screen.getByRole('option', { name: /SKU: EXACT-SKU.*Supplier SKU: SUP-1/ })).toBeInTheDocument();
    fireEvent.change(linkedProduct, { target: { value: link.id } });
    fireEvent.change(screen.getByLabelText('Quoted cost (dollars)'), { target: { value: '12.50' } });

    mockStageSupplierPriceImport.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(linkedProduct).toHaveValue(''));
    expect(screen.queryByRole('option', { name: /EXACT-SKU/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stage quick quote' }));
    expect(mockStageSupplierPriceImport).not.toHaveBeenCalled();
  });

  it('blocks Quick Quote staging while a refresh that removes its Product is unresolved', async () => {
    const product = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      product_name: 'Refresh Race Product',
      sku: 'RACE-SKU',
      inventory_unit: 'gallon',
    };
    const link = {
      id: 'link-refresh-race',
      product_id: product.id,
      product_name: product.product_name,
      vendor_id: 'vendor-1',
      vendor_name: 'Supplier One',
      supplier_sku: 'RACE-SUP',
      supplier_product_name: product.product_name,
      supplier_uom: 'case',
      supplier_pack_description: null,
      inventory_units_per_supplier_unit: 1,
      conversion_unit: 'gallon',
      comparison_status: 'comparable' as const,
      comparison_note: null,
      link_status: 'confirmed' as const,
      is_reusable: true,
      is_preferred: false,
      is_active: true,
    };
    const initial = {
      vendors: [{ id: 'vendor-1', name: 'Supplier One' }],
      products: [product],
      links: [link],
      imports: [], aliases: [], evidence: [],
    };
    const refreshed = { ...initial, products: [], links: [link] };
    let resolveRefresh: ((workspace: typeof refreshed) => void) | undefined;
    const pendingRefresh = new Promise<typeof refreshed>((resolve) => {
      resolveRefresh = resolve;
    });
    mockGetWorkspace.mockResolvedValueOnce(initial).mockReturnValueOnce(pendingRefresh);

    renderSupplierPricing();
    const linkedProduct = await screen.findByLabelText('Linked Product');
    fireEvent.change(linkedProduct, { target: { value: link.id } });
    fireEvent.change(screen.getByLabelText('Quoted cost (dollars)'), { target: { value: '12.50' } });

    mockStageSupplierPriceImport.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const stageButton = screen.getByRole('button', { name: 'Stage quick quote' });
    expect(stageButton).toBeDisabled();
    fireEvent.click(stageButton);
    expect(mockStageSupplierPriceImport).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefresh?.(refreshed);
      await pendingRefresh;
    });
    await waitFor(() => expect(linkedProduct).toHaveValue(''));
    expect(stageButton).toBeEnabled();
    expect(mockStageSupplierPriceImport).not.toHaveBeenCalled();
  });

  it('cancels Quick Quote staging when Refresh removes its Product during PDF upload', async () => {
    const product = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      product_name: 'Upload Race Product',
      sku: 'UPLOAD-RACE',
      inventory_unit: 'gallon',
    };
    const link = {
      id: 'link-upload-race',
      product_id: product.id,
      product_name: product.product_name,
      vendor_id: 'vendor-1',
      vendor_name: 'Supplier One',
      supplier_sku: 'UPLOAD-SUP',
      supplier_product_name: product.product_name,
      supplier_uom: 'case',
      supplier_pack_description: null,
      inventory_units_per_supplier_unit: 1,
      conversion_unit: 'gallon',
      comparison_status: 'comparable' as const,
      comparison_note: null,
      link_status: 'confirmed' as const,
      is_reusable: true,
      is_preferred: false,
      is_active: true,
    };
    const initial = {
      vendors: [{ id: 'vendor-1', name: 'Supplier One' }],
      products: [product],
      links: [link],
      imports: [], aliases: [], evidence: [],
    };
    const refreshed = { ...initial, products: [], links: [link] };
    let resolveUpload!: (path: string) => void;
    const pendingUpload = new Promise<string>((resolve) => { resolveUpload = resolve; });
    mockGetWorkspace.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    mockUploadSupplierSourcePdf.mockReturnValueOnce(pendingUpload);

    const { container } = renderSupplierPricing();
    const linkedProduct = await screen.findByLabelText('Linked Product');
    fireEvent.change(linkedProduct, { target: { value: link.id } });
    fireEvent.change(screen.getByLabelText('Quoted cost (dollars)'), { target: { value: '12.50' } });
    const pdfInput = container.querySelector<HTMLInputElement>('input[accept*="application/pdf"]');
    expect(pdfInput).not.toBeNull();
    fireEvent.change(pdfInput!, {
      target: { files: [new File(['pdf'], 'supplier-quote.pdf', { type: 'application/pdf' })] },
    });

    mockStageSupplierPriceImport.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Stage quick quote' }));
    await waitFor(() => expect(mockUploadSupplierSourcePdf).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(linkedProduct).toHaveValue(''));

    await act(async () => {
      resolveUpload('supplier-evidence/upload-race.pdf');
      await pendingUpload;
    });
    expect(mockStageSupplierPriceImport).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Supplier pricing changed while the PDF was uploading. Choose a current link and try again.',
    );
  });

  it('never reuses an older PDF path after the selected PDF changes during upload', async () => {
    const product = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      product_name: 'PDF Identity Product',
      sku: 'PDF-IDENTITY',
      inventory_unit: 'gallon',
    };
    const link = {
      id: 'link-pdf-identity',
      product_id: product.id,
      product_name: product.product_name,
      vendor_id: 'vendor-1',
      vendor_name: 'Supplier One',
      supplier_sku: 'PDF-SUP',
      supplier_product_name: product.product_name,
      supplier_uom: 'case',
      supplier_pack_description: null,
      inventory_units_per_supplier_unit: 1,
      conversion_unit: 'gallon',
      comparison_status: 'comparable' as const,
      comparison_note: null,
      link_status: 'confirmed' as const,
      is_reusable: true,
      is_preferred: false,
      is_active: true,
    };
    const workspace = {
      vendors: [{ id: 'vendor-1', name: 'Supplier One' }],
      products: [product],
      links: [link],
      imports: [], aliases: [], evidence: [],
    };
    let resolveFirstUpload!: (path: string) => void;
    const firstUpload = new Promise<string>((resolve) => { resolveFirstUpload = resolve; });
    mockGetWorkspace.mockResolvedValue(workspace);
    mockUploadSupplierSourcePdf
      .mockReturnValueOnce(firstUpload)
      .mockResolvedValueOnce('supplier-evidence/b.pdf');
    mockStageSupplierPriceImport.mockResolvedValue(
      makeImportDetail('pdf-identity', 'Supplier One', product.product_name),
    );

    const { container } = renderSupplierPricing();
    const linkedProduct = await screen.findByLabelText('Linked Product');
    fireEvent.change(linkedProduct, { target: { value: link.id } });
    fireEvent.change(screen.getByLabelText('Quoted cost (dollars)'), { target: { value: '12.50' } });
    const pdfInput = container.querySelector<HTMLInputElement>('input[accept*="application/pdf"]');
    expect(pdfInput).not.toBeNull();
    const firstPdf = new File(['a'], 'A.pdf', { type: 'application/pdf' });
    const secondPdf = new File(['b'], 'B.pdf', { type: 'application/pdf' });
    fireEvent.change(pdfInput!, { target: { files: [firstPdf] } });

    fireEvent.click(screen.getByRole('button', { name: 'Stage quick quote' }));
    await waitFor(() => expect(mockUploadSupplierSourcePdf).toHaveBeenCalledWith(firstPdf, 'actor-1'));
    fireEvent.change(pdfInput!, { target: { files: [secondPdf] } });

    await act(async () => {
      resolveFirstUpload('supplier-evidence/a.pdf');
      await firstUpload;
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'The source PDF changed while it was uploading. Stage again with the current PDF.',
    ));
    expect(mockStageSupplierPriceImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stage quick quote' }));
    await waitFor(() => expect(mockStageSupplierPriceImport).toHaveBeenCalledTimes(1));
    expect(mockUploadSupplierSourcePdf).toHaveBeenNthCalledWith(2, secondPdf, 'actor-1');
    expect(mockStageSupplierPriceImport).toHaveBeenCalledWith(expect.objectContaining({
      sourceDocumentPath: 'supplier-evidence/b.pdf',
      sourceDocumentName: 'B.pdf',
      sourceDocumentMime: 'application/pdf',
    }));
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
