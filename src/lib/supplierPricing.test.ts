import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockAssertRpcResult, mockUpload, mockProductFrom, mockProductSelect, mockProductIn } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockAssertRpcResult: vi.fn((data: unknown, name: string) => {
    if (data == null) throw new Error(`${name} returned no data`);
    return data;
  }),
  mockUpload: vi.fn(),
  mockProductFrom: vi.fn(),
  mockProductSelect: vi.fn(),
  mockProductIn: vi.fn(),
}));

vi.mock('./db', () => ({
  supabaseUntyped: { rpc: mockRpc },
  assertRpcResult: mockAssertRpcResult,
  supabase: {
    storage: { from: () => ({ upload: mockUpload }) },
    from: mockProductFrom,
  },
}));

import {
  correctSupplierPriceObservation,
  formatSupplierCents,
  getProductPriceHistory,
  getSupplierMarketEvidence,
  getSupplierPricingWorkspace,
  stageSupplierPriceImport,
} from './supplierPricing';

describe('supplier pricing RPC wrappers', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockAssertRpcResult.mockClear();
    mockUpload.mockReset();
    mockProductFrom.mockReset();
    mockProductSelect.mockReset();
    mockProductIn.mockReset();
    mockProductFrom.mockReturnValue({ select: mockProductSelect });
    mockProductSelect.mockReturnValue({ in: mockProductIn });
  });

  it('hydrates only the workspace RPC Product UUIDs with canonical Stage A metadata', async () => {
    mockRpc.mockResolvedValue({
      data: {
        vendors: [],
        products: [
          { id: '11111111-1111-4111-8111-111111111111', product_name: 'Same Name', sku: null, inventory_unit: 'jug' },
          { id: '22222222-2222-4222-8222-222222222222', product_name: 'Missing row', sku: 'OLD', inventory_unit: 'case' },
        ],
        links: [], imports: [], aliases: [], evidence: [],
      },
      error: null,
    });
    mockProductIn.mockResolvedValue({
      data: [{
        id: '11111111-1111-4111-8111-111111111111', product_name: 'Same Name', sku: 'NEW-A', unit_size: '2.5 gal',
        packaging_variant: '2 x 2.5 gal', container_size: 2.5, container_unit: 'gal',
        inventory_unit: 'gal', return_policy: 'no_return', is_full_tote_only: false,
        product_family: { name: 'Atrazine' },
      }],
      error: null,
    });

    const workspace = await getSupplierPricingWorkspace();

    expect(mockProductFrom).toHaveBeenCalledWith('products');
    expect(mockProductIn).toHaveBeenCalledWith('id', ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    expect(workspace.products[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111', sku: 'NEW-A', packaging_variant: '2 x 2.5 gal',
      return_policy: 'no_return', product_family: { name: 'Atrazine' },
    });
    // A missing canonical row cannot cause a cross-SKU substitution.
    expect(workspace.products[1]).toMatchObject({ id: '22222222-2222-4222-8222-222222222222', sku: 'OLD' });
  });

  it('hydrates a filtered workspace by its returned exact Product UUID', async () => {
    mockRpc.mockResolvedValue({
      data: {
        vendors: [],
        products: [{ id: '11111111-1111-4111-8111-111111111111', product_name: 'Same Name', sku: null, inventory_unit: 'jug' }],
        links: [], imports: [], aliases: [], evidence: [],
      },
      error: null,
    });
    mockProductIn.mockResolvedValue({ data: [], error: null });

    await getSupplierPricingWorkspace('11111111-1111-4111-8111-111111111111');

    expect(mockProductIn).toHaveBeenCalledWith('id', ['11111111-1111-4111-8111-111111111111']);
  });

  it('batches large workspace metadata requests and preserves exact-ID-only hydration', async () => {
    const products = Array.from({ length: 1_001 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`, product_name: `Product ${index}`, sku: null, inventory_unit: 'ea',
    }));
    mockRpc.mockResolvedValue({ data: { vendors: [], products, links: [], imports: [], aliases: [], evidence: [] }, error: null });
    mockProductIn.mockImplementation(async (_column: string, ids: string[]) => ({
      data: ids[0] === '00000000-0000-4000-8000-000000000000'
        ? [{ id: '00000000-0000-4000-8000-000000000000', product_name: 'Product 0', sku: 'EXACT', unit_size: null, packaging_variant: null, container_size: null, container_unit: null, inventory_unit: 'ea', return_policy: 'returnable', is_full_tote_only: false, product_family: null }]
        : [],
      error: null,
    }));

    const workspace = await getSupplierPricingWorkspace();

    expect(mockProductIn).toHaveBeenCalledTimes(11);
    expect(mockProductIn.mock.calls.map(([, ids]) => ids.length)).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 1]);
    expect(mockProductIn.mock.calls.every(([, ids]) => ids.length <= 100 && ids.join(',').length < 4_096)).toBe(true);
    expect(workspace.products[0]).toMatchObject({ id: '00000000-0000-4000-8000-000000000000', sku: 'EXACT' });
    expect(workspace.products[1]).toMatchObject({ id: '00000000-0000-4000-8000-000000000001', sku: null });
  });

  it('surfaces canonical Product metadata query failures', async () => {
    mockRpc.mockResolvedValue({ data: { vendors: [], products: [{ id: '11111111-1111-4111-8111-111111111111', product_name: 'Same', sku: null, inventory_unit: 'ea' }], links: [], imports: [], aliases: [], evidence: [] }, error: null });
    const error = { message: 'metadata unavailable' };
    mockProductIn.mockResolvedValue({ data: null, error });

    await expect(getSupplierPricingWorkspace()).rejects.toBe(error);
  });

  it('surfaces a late metadata batch failure without returning a partial workspace', async () => {
    const products = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`, product_name: `Product ${index}`, sku: null, inventory_unit: 'ea',
    }));
    mockRpc.mockResolvedValue({ data: { vendors: [], products, links: [], imports: [], aliases: [], evidence: [] }, error: null });
    const lateError = { message: 'second batch unavailable' };
    mockProductIn.mockImplementation(async (_column: string, ids: string[]) => ({ data: [], error: ids.length === 1 ? lateError : null }));

    await expect(getSupplierPricingWorkspace()).rejects.toBe(lateError);
    expect(mockProductIn).toHaveBeenCalledTimes(2);
  });

  it('normalizes bigint cents exactly beyond JavaScript safe-integer precision', async () => {
    mockRpc.mockResolvedValue({
      data: [{
        product_id: 'product-1',
        supplier_quote_count: 1,
        comparable_quote_count: 1,
        replacement_cost_cents: '9007199254740993',
        replacement_cost_as_of: '2026-07-18',
        best_supplier: 'Van Diest',
        last_paid_cents: '9007199254740995',
        last_paid_as_of: '2026-07-10',
        recent_po_weighted_average_cents: '9007199254740994',
        recent_po_window: 'trailing_12_months',
        comparison_status: 'comparable',
        suppliers: [{
          vendor_id: 'vendor-1',
          vendor_name: 'Van Diest',
          product_supplier_link_id: 'link-1',
          quoted_package_cost_cents: '18014398509481986',
          normalized_cost_cents: '9007199254740993',
          effective_from: '2026-07-18',
          comparison_status: 'comparable',
          is_best_comparable: true,
        }],
      }],
      error: null,
    });

    const result = await getSupplierMarketEvidence(['product-1']);

    expect(result[0].replacement_cost_cents).toBe(9_007_199_254_740_993n);
    expect(result[0].last_paid_cents).toBe(9_007_199_254_740_995n);
    expect(result[0].recent_po_weighted_average_cents).toBe(9_007_199_254_740_994n);
    expect(result[0].suppliers[0].quoted_package_cost_cents).toBe(18_014_398_509_481_986n);
    expect(mockRpc).toHaveBeenCalledWith('get_supplier_market_evidence', {
      p_product_ids: ['product-1'],
    });
  });

  it('stages only string dollar input and the exact actor/idempotency contract', async () => {
    const response = {
      id: 'import-1',
      vendor_id: 'vendor-1',
      vendor_name: 'The Andersons',
      document_date: '2026-07-18',
      ingestion_method: 'quick_quote',
      format_version: 'quick-v1',
      status: 'needs_review',
      source_document_name: null,
      row_count: 1,
      eligible_row_count: 1,
      approved_observation_count: 0,
      created_at: '2026-07-18T12:00:00Z',
      rows: [{
        id: 'row-1', row_number: 1, product_id: 'product-1', product_name: 'Atrazine',
        product_supplier_link_id: 'link-1', supplier_sku: 'A-1', supplier_product_name: 'Atrazine',
        cost_cents: '12550', price_unit: 'case', package_quantity: 1,
        effective_from: '2026-07-18', effective_to: null, price_kind: 'quote',
        row_status: 'new', validation_errors: [], observation_id: null,
      }],
    };
    mockRpc.mockResolvedValue({ data: response, error: null });
    const rows = [{
      product_supplier_link_id: 'link-1',
      new_cost: '125.50',
      effective_date: '2026-07-18',
      price_kind: 'quote' as const,
      price_unit: 'case',
      package_quantity: '1',
      has_formula: false,
      formula_cells: [],
    }];

    const result = await stageSupplierPriceImport({
      vendorId: 'vendor-1',
      documentDate: '2026-07-18',
      ingestionMethod: 'quick_quote',
      formatVersion: 'quick-v1',
      rows,
      performedBy: 'actor-1',
      idempotencyKey: 'stage-key',
    });

    expect(result.rows[0].cost_cents).toBe(12_550n);
    expect(mockRpc).toHaveBeenCalledWith('stage_supplier_price_import', {
      p_vendor_id: 'vendor-1',
      p_document_date: '2026-07-18',
      p_ingestion_method: 'quick_quote',
      p_format_version: 'quick-v1',
      p_source_document_path: null,
      p_source_document_name: null,
      p_source_document_mime: null,
      p_rows: rows,
      p_performed_by: 'actor-1',
      p_idempotency_key: 'stage-key',
    });
  });

  it('records a correction with the exact dollar-string/actor/idempotency contract and decodes cents', async () => {
    mockRpc.mockResolvedValue({
      data: {
        observation_id: 'observation-2',
        supersedes_observation_id: 'observation-1',
        product_id: 'product-1',
        vendor_id: 'vendor-1',
        product_supplier_link_id: 'link-1',
        cost_cents: '1250',
        price_unit: 'case',
        package_quantity: 1,
        price_kind: 'quote',
        effective_from: '2026-07-18',
        effective_to: null,
        import_id: 'import-corr-1',
        import_row_id: 'row-corr-1',
        reason: 'Transcription typo',
        sell_prices_changed: 0,
        summary: 'Correction recorded. The prior quote is superseded and no sell price changed. New supplier cost: $12.50.',
      },
      error: null,
    });

    const result = await correctSupplierPriceObservation({
      observationId: 'observation-1',
      correctedCost: '12.50',
      reason: 'Transcription typo',
      performedBy: 'actor-1',
      idempotencyKey: 'correction-key',
    });

    // Corrected observation supersedes the original and carries exact integer cents.
    expect(result.supersedes_observation_id).toBe('observation-1');
    expect(result.cost_cents).toBe(1_250n);
    expect(result.sell_prices_changed).toBe(0);
    // Dollars stay a string on the wire — the RPC is the only dollars<->cents boundary.
    expect(mockRpc).toHaveBeenCalledWith('correct_supplier_price_observation', {
      p_observation_id: 'observation-1',
      p_corrected_cost: '12.50',
      p_reason: 'Transcription typo',
      p_performed_by: 'actor-1',
      p_idempotency_key: 'correction-key',
    });
  });

  it('keeps unresolved legacy purchase facts visibly supplier unknown', async () => {
    mockRpc.mockResolvedValue({
      data: {
        product_id: 'product-1',
        summary: {
          product_id: 'product-1', supplier_quote_count: 0, comparable_quote_count: 0,
          replacement_cost_cents: null, replacement_cost_as_of: null, best_supplier: null,
          last_paid_cents: '4200', last_paid_as_of: '2026-07-18',
          recent_po_weighted_average_cents: '4100', recent_po_window: 'trailing_12_months',
          comparison_status: 'no_evidence', suppliers: [],
        },
        suppliers: [],
        points: [{
          stream: 'actual_purchase', source_id: 'po-line-1', vendor_id: null,
          supplier_name: 'supplier unknown', cost_cents: '4200', normalized_cost_cents: null,
          occurred_at: '2026-07-18T12:00:00Z', detail: 'actual_purchase',
          provenance: { resolution_status: 'supplier unknown' },
        }],
      },
      error: null,
    });

    const history = await getProductPriceHistory('product-1');

    expect(history.points[0]).toMatchObject({
      supplier_name: 'supplier unknown',
      cost_cents: 4_200n,
      normalized_cost_cents: null,
    });
    expect(history.summary.recent_po_weighted_average_cents).toBe(4_100n);
  });
});

describe('formatSupplierCents', () => {
  it('formats bigint cents without converting through Number', () => {
    expect(formatSupplierCents(9_007_199_254_740_993n)).toBe('$90071992547409.93');
    expect(formatSupplierCents(null)).toBe('—');
  });
});
