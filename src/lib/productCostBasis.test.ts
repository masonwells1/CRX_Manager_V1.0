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
  formatCostBasisDollars,
  getProductCostBasisWorkspace,
  manualCostBasisPricingRow,
  purchaseCandidatePricingRow,
  supplierCandidatePricingRow,
  type ProductCostBasisWorkspace,
} from './productCostBasis';

const workspace: ProductCostBasisWorkspace = {
  enabled: true,
  product: {
    id: 'product-1',
    product_name: 'Test Product',
    sku: 'TP-1',
    pricing_version: 7,
    current_cost_cents: 10_000n,
    tier1_margin_percent: '20',
    tier2_margin_percent: '15',
    tier3_margin_percent: '10',
  },
  current_basis: null,
  supplier_candidates: [],
  purchase_candidates: [],
};

describe('product cost basis', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockAssertRpcResult.mockClear();
  });

  it('loads exact bigint cents and never converts through Number', async () => {
    const response = {
      ...workspace,
      product: { ...workspace.product, current_cost_cents: '9007199254740993' },
      current_basis: {
        id: 'basis-1',
        basis_type: 'manual_override',
        cost_cents: '9007199254740993',
        supplier_price_observation_id: null,
        purchase_order_item_id: null,
        selection_source: 'migration_baseline',
        reason: 'Baseline',
        selected_at: '2026-07-21T12:00:00Z',
      },
      supplier_candidates: [{
        supplier_price_observation_id: 'observation-1',
        vendor_id: 'vendor-1',
        vendor_name: 'Vendor',
        quoted_package_cost_cents: '9007199254740994',
        normalized_cost_cents: '9007199254740993',
        effective_from: '2026-07-21',
        price_kind: 'quote',
      }],
      purchase_candidates: [],
    };
    mockRpc.mockResolvedValue({ data: response, error: null });

    const result = await getProductCostBasisWorkspace('product-1');

    expect(mockRpc).toHaveBeenCalledWith('get_product_cost_basis_workspace', {
      p_product_id: 'product-1',
    });
    expect(result.product.current_cost_cents).toBe(9_007_199_254_740_993n);
    expect(result.current_basis?.cost_cents).toBe(9_007_199_254_740_993n);
    expect(result.supplier_candidates[0].quoted_package_cost_cents)
      .toBe(9_007_199_254_740_994n);
  });

  it('builds a supplier selection row with explicit provenance', () => {
    expect(supplierCandidatePricingRow(workspace, {
      supplier_price_observation_id: 'observation-1',
      vendor_id: 'vendor-1',
      vendor_name: 'Vendor',
      quoted_package_cost_cents: 15_000n,
      normalized_cost_cents: 12_345n,
      effective_from: '2026-07-21',
      price_kind: 'quote',
    }, {
      reason: 'Owner selected current quote.',
      basisSource: 'supplier_pricing',
      pricingBehavior: 'keep_margins_and_reprice',
    })).toMatchObject({
      product_id: 'product-1',
      row_version: 7,
      pricing_mode: 'margin_driven',
      new_cost: '123.45',
      basis_type: 'selected_supplier_price',
      supplier_price_observation_id: 'observation-1',
      basis_selection: true,
      basis_source: 'supplier_pricing',
    });
  });

  it('builds an actual-purchase selection row with PO provenance', () => {
    expect(purchaseCandidatePricingRow(workspace, {
      purchase_order_item_id: 'po-item-1',
      purchase_order_id: 'po-1',
      po_number: 'PO-10',
      vendor_name: 'Vendor',
      normalized_cost_cents: 333n,
      purchased_at: '2026-07-20T12:00:00Z',
    }, {
      reason: 'Owner selected last paid cost.',
      basisSource: 'product_detail',
      pricingBehavior: 'keep_margins_and_reprice',
    })).toMatchObject({
      new_cost: '3.33',
      basis_type: 'actual_purchase',
      purchase_order_item_id: 'po-item-1',
      basis_selection: true,
    });
  });

  it('loads a Product with no current cost but requires margins before selection', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ...workspace,
        product: { ...workspace.product, current_cost_cents: null },
      },
      error: null,
    });
    const result = await getProductCostBasisWorkspace('product-1');
    expect(result.product.current_cost_cents).toBeNull();

    expect(() => supplierCandidatePricingRow({
      ...workspace,
      product: { ...workspace.product, tier1_margin_percent: null },
    }, {
      supplier_price_observation_id: 'observation-1',
      vendor_id: 'vendor-1',
      vendor_name: 'Vendor',
      quoted_package_cost_cents: 100n,
      normalized_cost_cents: 100n,
      effective_from: '2026-07-21',
      price_kind: 'quote',
    }, {
      reason: 'Owner selection',
      basisSource: 'supplier_pricing',
      pricingBehavior: 'keep_margins_and_reprice',
    })).toThrow('Set all three Product margins');
  });

  it('defaults the Product flow to preserving current tier sell prices', () => {
    expect(manualCostBasisPricingRow(workspace, 12_345n, {
      reason: 'Owner-entered replacement cost.',
      basisSource: 'product_detail',
      pricingBehavior: 'keep_sell_prices',
      currentTierPrices: {
        tier1: '150.00',
        tier2: '140.00',
        tier3: '130.00',
      },
    })).toMatchObject({
      pricing_mode: 'price_driven',
      new_cost: '123.45',
      tier1_price: '150.00',
      tier2_price: '140.00',
      tier3_price: '130.00',
      basis_type: 'manual_override',
      basis_selection: true,
      basis_source: 'product_detail',
    });
  });

  it('fails closed to the keep-sell-prices default when callers omit pricing behavior', () => {
    expect(supplierCandidatePricingRow(workspace, {
      supplier_price_observation_id: 'observation-1',
      vendor_id: 'vendor-1',
      vendor_name: 'Vendor',
      quoted_package_cost_cents: 15_000n,
      normalized_cost_cents: 12_345n,
      effective_from: '2026-07-21',
      price_kind: 'quote',
    }, {
      reason: 'Owner selected current quote.',
      basisSource: 'product_detail',
      currentTierPrices: { tier1: '150.00', tier2: '140.00', tier3: '130.00' },
    })).toMatchObject({
      pricing_mode: 'price_driven',
      tier1_price: '150.00',
      tier2_price: '140.00',
      tier3_price: '130.00',
    });
  });

  it('formats integer cents exactly', () => {
    expect(formatCostBasisDollars(1n)).toBe('0.01');
    expect(formatCostBasisDollars(12_345n)).toBe('123.45');
  });
});
