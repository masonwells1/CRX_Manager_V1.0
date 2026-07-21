import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockAssertRpcResult } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockAssertRpcResult: vi.fn((data: unknown, name: string) => {
    if (data == null) throw new Error(`${name} returned no data`);
    return data;
  }),
}));

vi.mock('./db', () => ({
  supabase: { rpc: mockRpc },
  assertRpcResult: mockAssertRpcResult,
}));

import {
  applyProductPricingChangeSet,
  assertPricingPreviewRowsSafe,
  createPricingWorkbookExport,
  formatPricingMarginPercent,
  pricingDollarInputToCents,
  previewProductPricingChanges,
} from './productPricing';

describe('pricingDollarInputToCents', () => {
  it('preserves cents beyond JavaScript safe-integer precision', () => {
    expect(pricingDollarInputToCents('90071992547409.93')).toBe(9_007_199_254_740_993n);
  });

  it.each(['-1.00', '1.001', '1e2', '92233720368547758.08'])(
    'rejects a value the PostgreSQL dollar parser will reject: %s',
    (value) => expect(pricingDollarInputToCents(value)).toBeNull(),
  );
});

describe('formatPricingMarginPercent', () => {
  it('serializes stored ratios without binary floating-point artifacts', () => {
    expect(formatPricingMarginPercent(0.29)).toBe('29');
    expect(formatPricingMarginPercent(0.07)).toBe('7');
    expect(formatPricingMarginPercent(0.1555555555)).toBe('15.55555555');
  });

  it('rejects non-finite values before they reach the pricing RPC', () => {
    expect(() => formatPricingMarginPercent(Number.NaN)).toThrow('finite number');
  });
});

describe('assertPricingPreviewRowsSafe', () => {
  it.each(['0', '0.00', '-0', '0e0'])(
    'rejects margin-driven zero cost before preview for %s',
    (newCost) => {
      expect(() => assertPricingPreviewRowsSafe([{
        pricing_mode: 'margin_driven',
        new_cost: newCost,
        product_name: 'Safety Product',
      }])).toThrow('cost greater than $0 for Safety Product');
    },
  );

  it('preserves zero cost for price-driven review', () => {
    expect(() => assertPricingPreviewRowsSafe([{
      pricing_mode: 'price_driven',
      new_cost: '0.00',
      product_name: 'Price-driven Product',
    }])).not.toThrow();
  });
});

describe('product pricing RPC wrappers', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockAssertRpcResult.mockClear();
  });

  it('creates a workbook export with the exact parked-RPC arguments', async () => {
    const response = { export_id: 'export-1', rows: [] };
    mockRpc.mockResolvedValue({ data: response, error: null });

    await expect(createPricingWorkbookExport({
      productIds: ['product-1'],
      performedBy: 'actor-1',
      idempotencyKey: 'export-key',
    })).resolves.toEqual(response);

    expect(mockRpc).toHaveBeenCalledWith('create_pricing_workbook_export', {
      p_product_ids: ['product-1'],
      p_performed_by: 'actor-1',
      p_idempotency_key: 'export-key',
    });
    expect(mockAssertRpcResult).toHaveBeenCalledWith(response, 'create_pricing_workbook_export');
  });

  it('previews direct pricing without an export id or client-side conversions', async () => {
    const response = { change_set_id: 'change-1', apply_allowed: true, rows: [] };
    const rows = [{
      product_id: 'product-1',
      row_version: 7,
      pricing_mode: 'margin_driven' as const,
      new_cost: '125.40',
      tier1_margin_percent: '20',
      tier2_margin_percent: '15.5',
      tier3_margin_percent: '10',
      change_reason: 'Monthly update',
    }];
    mockRpc.mockResolvedValue({ data: response, error: null });

    await expect(previewProductPricingChanges({
      source: 'product_page',
      rows,
      performedBy: 'actor-1',
      idempotencyKey: 'preview-key',
    })).resolves.toEqual(response);

    expect(mockRpc).toHaveBeenCalledWith('preview_product_pricing_changes', {
      p_source: 'product_page',
      p_export_id: undefined,
      p_rows: rows,
      p_performed_by: 'actor-1',
      p_idempotency_key: 'preview-key',
    });
  });

  it('normalizes RPC money to exact bigint cents beyond the safe-integer boundary', async () => {
    const exactDollars = '90071992547409.93';
    const response = {
      change_set_id: 'change-unsafe',
      request_fingerprint: 'fingerprint-unsafe',
      source: 'product_page',
      status: 'previewed',
      expires_at: '2026-07-17T23:00:00Z',
      submitted_row_count: 1,
      ready_count: 1,
      unchanged_count: 0,
      conflict_count: 0,
      invalid_count: 0,
      apply_allowed: true,
      rows: [{
        sequence: 1,
        product_id: 'product-1',
        submitted_row: {},
        row_status: 'ready',
        error_code: null,
        effect: {
          product_id: 'product-1',
          cost: exactDollars,
          cost_cents: Number('9007199254740993'),
          tier1_margin_percent: '0',
          tier1_margin: 0,
          tier1_price: exactDollars,
          tier1_price_cents: Number('9007199254740993'),
          tier2_margin_percent: '0',
          tier2_margin: 0,
          tier2_price: exactDollars,
          tier2_price_cents: Number('9007199254740993'),
          tier3_margin_percent: '0',
          tier3_margin: 0,
          tier3_price: exactDollars,
          tier3_price_cents: Number('9007199254740993'),
          tier1_price_per_acre_cents: '9007199254740993',
          tier2_price_per_acre_cents: null,
          tier3_price_per_acre_cents: null,
        },
      }],
    };
    mockRpc.mockResolvedValue({ data: response, error: null });

    const result = await previewProductPricingChanges({
      source: 'product_page',
      rows: [{
        product_id: 'product-1',
        row_version: 7,
        pricing_mode: 'price_driven',
        new_cost: exactDollars,
        tier1_price: exactDollars,
        tier2_price: exactDollars,
        tier3_price: exactDollars,
      }],
      performedBy: 'actor-1',
      idempotencyKey: 'preview-unsafe-key',
    });

    expect(result.rows[0].effect).toMatchObject({
      cost_cents: 9_007_199_254_740_993n,
      tier1_price_cents: 9_007_199_254_740_993n,
      tier1_price_per_acre_cents: 9_007_199_254_740_993n,
    });

    (response.rows[0].effect as Record<string, unknown>).tier1_price_per_acre_cents =
      Number('9007199254740993');
    mockRpc.mockResolvedValue({ data: response, error: null });
    await expect(previewProductPricingChanges({
      source: 'product_page',
      rows: [{
        product_id: 'product-1',
        row_version: 7,
        pricing_mode: 'price_driven',
        new_cost: exactDollars,
        tier1_price: exactDollars,
        tier2_price: exactDollars,
        tier3_price: exactDollars,
      }],
      performedBy: 'actor-1',
      idempotencyKey: 'preview-unsafe-number-key',
    })).rejects.toThrow('unsafe tier 1 per-acre cents');
  });

  it('never calls the preview RPC for margin-driven zero cost', async () => {
    await expect(previewProductPricingChanges({
      source: 'product_page',
      rows: [{
        product_id: 'product-1',
        product_name: 'Safety Product',
        row_version: 7,
        pricing_mode: 'margin_driven',
        new_cost: '0.00',
        tier1_margin_percent: '20',
        tier2_margin_percent: '15',
        tier3_margin_percent: '10',
        change_reason: 'Should be blocked',
      }],
      performedBy: 'actor-1',
      idempotencyKey: 'preview-zero-key',
    })).rejects.toThrow('cost greater than $0 for Safety Product');

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('passes a worksheet export id and all rows unchanged', async () => {
    const response = { change_set_id: 'change-1', status: 'no_changes', rows: [] };
    const rows = [{
      product_id: 'product-1',
      sku: '000123',
      product_name: 'Product A',
      category: 'Herbicide',
      container_size: '2.5',
      unit_size: 'gal',
      inventory_unit: 'gallon',
      identity_fingerprint: 'identity',
      row_token: 'token',
      row_version: '7',
      current_cost: '125.40',
      current_tier1_margin_percent: '20',
      current_tier1_price: '156.75',
      current_tier2_margin_percent: '15',
      current_tier2_price: '147.53',
      current_tier3_margin_percent: '10',
      current_tier3_price: '139.33',
      pricing_mode: '' as const,
      new_cost: '125.40',
      tier1_margin_percent: '20',
      tier1_price: '156.75',
      tier2_margin_percent: '15',
      tier2_price: '147.53',
      tier3_margin_percent: '10',
      tier3_price: '139.33',
      change_reason: '',
      has_formula: false,
      formula_cells: [],
    }];
    mockRpc.mockResolvedValue({ data: response, error: null });

    await previewProductPricingChanges({
      source: 'pricing_worksheet',
      exportId: 'export-1',
      rows,
      performedBy: 'actor-1',
      idempotencyKey: 'preview-key',
    });

    expect(mockRpc).toHaveBeenCalledWith('preview_product_pricing_changes', {
      p_source: 'pricing_worksheet',
      p_export_id: 'export-1',
      p_rows: rows,
      p_performed_by: 'actor-1',
      p_idempotency_key: 'preview-key',
    });
  });

  it('applies the approved change set with its exact request fingerprint', async () => {
    const response = { change_set_id: 'change-1', status: 'applied', applied_count: 1, rows: [] };
    mockRpc.mockResolvedValue({ data: response, error: null });

    await expect(applyProductPricingChangeSet({
      changeSetId: 'change-1',
      requestFingerprint: 'request-fingerprint',
      performedBy: 'actor-1',
      idempotencyKey: 'apply-key',
    })).resolves.toEqual(response);

    expect(mockRpc).toHaveBeenCalledWith('apply_product_pricing_change_set', {
      p_change_set_id: 'change-1',
      p_request_fingerprint: 'request-fingerprint',
      p_performed_by: 'actor-1',
      p_idempotency_key: 'apply-key',
    });
    expect(mockAssertRpcResult).toHaveBeenCalledWith(response, 'apply_product_pricing_change_set');
  });

  it('throws the Supabase error before asserting a result', async () => {
    const error = { code: 'P0001', message: 'ADMIN_REQUIRED' };
    mockRpc.mockResolvedValue({ data: null, error });

    await expect(createPricingWorkbookExport({
      performedBy: 'actor-1',
      idempotencyKey: 'export-key',
    })).rejects.toBe(error);
    expect(mockAssertRpcResult).not.toHaveBeenCalled();
  });

  it('uses assertRpcResult to reject a silent null response', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await expect(applyProductPricingChangeSet({
      changeSetId: 'change-1',
      requestFingerprint: 'request-fingerprint',
      performedBy: 'actor-1',
      idempotencyKey: 'apply-key',
    })).rejects.toThrow('apply_product_pricing_change_set returned no data');
  });
});
