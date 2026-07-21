import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { mockToast, mockGetWorkspace, mockGetImport } = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockGetWorkspace: vi.fn(),
  mockGetImport: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idempotency-key', resetKey: vi.fn() }),
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

import SupplierPricing from './SupplierPricing';

describe('SupplierPricing page', () => {
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

    render(<SupplierPricing />);

    expect(await screen.findByRole('heading', { name: 'Supplier Pricing' })).toBeInTheDocument();
    expect(screen.getByText(/No OCR or AI extraction/)).toBeInTheDocument();
    expect(screen.getByText(/PDFs are retained only as audit evidence/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download prefilled .xlsx/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /The Andersons/ }));

    await waitFor(() => expect(mockGetImport).toHaveBeenCalledWith('import-1'));
    expect(screen.getByText(
      'You are adding 1 supplier observations. You are changing ZERO sell prices.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve selected observations' })).toBeInTheDocument();
  });
});
