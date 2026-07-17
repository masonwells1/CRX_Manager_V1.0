/**
 * BulkProductImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Fully chainable Supabase query-builder mock
function chainable(resolveWith: unknown = { data: [], error: null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','is','in','or','not','match',
    'order','limit','range','single','maybeSingle',
    'csv','explain',
  ];
  for (const m of methods) builder[m] = vi.fn(self);
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: vi.fn(() => chainable()) },
}));

vi.mock('../../lib/documentOCR', () => ({
  isCSVFile: vi.fn(() => true),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import BulkProductImport from './BulkProductImport';
import {
  buildProductInsert,
  isProductImportStringField,
  isRetiredPricingColumn,
  type ParsedProduct,
} from './bulkProductImportSafety';

describe('BulkProductImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => vi.clearAllMocks());

  it('renders when open', () => {
    render(<BulkProductImport {...defaultProps} />);
    expect(screen.getByText(/bulk product/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkProductImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/bulk product/i)).not.toBeInTheDocument();
  });

  it('shows file upload area', () => {
    render(<BulkProductImport {...defaultProps} />);
    expect(screen.getAllByText(/csv/i).length).toBeGreaterThan(0);
  });

  it('accepts CSV files only and makes the pricing boundary explicit', () => {
    render(<BulkProductImport {...defaultProps} />);

    expect(screen.getByLabelText('Select File')).toHaveAttribute('accept', '.csv,text/csv');
    expect(screen.getByText(/pricing columns are rejected/i)).toBeInTheDocument();
    expect(screen.queryByText(/vision ocr/i)).not.toBeInTheDocument();
  });

  it.each([
    'cost',
    'current_cost',
    'unit-cost-cents',
    'price',
    'tier1_price',
    'tier_2_margin',
    't3_gross_margin',
    'tier3_price_per_acre',
    'pricing_version',
  ])('rejects retired pricing header %s', (header) => {
    expect(isRetiredPricingColumn(header)).toBe(true);
  });

  it('does not mistake application-rate details for pricing', () => {
    expect(isRetiredPricingColumn('rate_per_acre')).toBe(false);
    expect(isRetiredPricingColumn('suggested_rate')).toBe(false);
  });

  it.each(['product_form', 'inventory_unit', 'container_unit', 'container_type'])(
    'preserves catalog metadata field %s during CSV parsing',
    (field) => {
      expect(isProductImportStringField(field)).toBe(true);
    },
  );

  it('builds the database insert from an explicit non-pricing allowlist', () => {
    const unsafeInput = {
      product_name: 'Safe Product',
      sku: 'SAFE-1',
      category: 'Herbicide',
      rate_per_acre: 2,
      current_cost: 10,
      tier1_price: 20,
      tier1_margin: 0.5,
      tier1_gross_margin: 1,
      tier1_price_per_acre: 40,
      pricing_version: 99,
    } as unknown as ParsedProduct;

    const insert = buildProductInsert(unsafeInput);

    expect(insert).toMatchObject({
      product_name: 'Safe Product',
      sku: 'SAFE-1',
      category: 'Herbicide',
      rate_per_acre: 2,
      is_active: true,
    });
    expect(insert).not.toHaveProperty('current_cost');
    expect(insert).not.toHaveProperty('tier1_price');
    expect(insert).not.toHaveProperty('tier1_margin');
    expect(insert).not.toHaveProperty('tier1_gross_margin');
    expect(insert).not.toHaveProperty('tier1_price_per_acre');
    expect(insert).not.toHaveProperty('pricing_version');
  });
});
