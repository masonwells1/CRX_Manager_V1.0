import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { mockGetHistory } = vi.hoisted(() => ({ mockGetHistory: vi.fn() }));

vi.mock('../../lib/supplierPricing', async () => {
  const actual = await vi.importActual<typeof import('../../lib/supplierPricing')>(
    '../../lib/supplierPricing',
  );
  return { ...actual, getProductPriceHistory: mockGetHistory };
});

import ProductPriceHistory from './ProductPriceHistory';

describe('ProductPriceHistory', () => {
  it('shows all evidence streams, supplier unknown, and filters supplier-specific points', async () => {
    mockGetHistory.mockResolvedValue({
      product_id: 'product-1',
      summary: {
        product_id: 'product-1', supplier_quote_count: 2, comparable_quote_count: 1,
        replacement_cost_cents: 2_000n, replacement_cost_as_of: '2026-07-01',
        best_supplier: 'The Andersons', last_paid_cents: 2_200n,
        last_paid_as_of: '2026-07-04', recent_po_weighted_average_cents: 2_150n,
        recent_po_window: 'trailing_12_months', comparison_status: 'comparable', suppliers: [],
      },
      suppliers: [
        { id: 'vendor-1', name: 'The Andersons' },
        { id: 'vendor-2', name: 'Van Diest' },
      ],
      points: [
        {
          stream: 'supplier_observation', source_id: 'observation-1', vendor_id: 'vendor-1',
          supplier_name: 'The Andersons', cost_cents: 10_000n, normalized_cost_cents: 2_000n,
          occurred_at: '2026-07-01T12:00:00Z', detail: 'quote', provenance: {},
        },
        {
          stream: 'supplier_observation', source_id: 'observation-2', vendor_id: 'vendor-2',
          supplier_name: 'Van Diest', cost_cents: 9_000n, normalized_cost_cents: null,
          occurred_at: '2026-07-02T12:00:00Z', detail: 'quote', provenance: {},
        },
        {
          stream: 'selected_cost_basis', source_id: 'cost-1', vendor_id: null,
          supplier_name: null, cost_cents: 2_100n, normalized_cost_cents: 2_100n,
          occurred_at: '2026-07-03T12:00:00Z', detail: 'pricing_worksheet', provenance: {},
        },
        {
          stream: 'actual_purchase', source_id: 'po-1', vendor_id: null,
          supplier_name: 'supplier unknown', cost_cents: 2_200n, normalized_cost_cents: null,
          occurred_at: '2026-07-04T12:00:00Z', detail: 'actual_purchase', provenance: {},
        },
      ],
    });

    const selectSupplier = vi.fn();
    const selectPurchase = vi.fn();
    render(
      <ProductPriceHistory
        productId="product-1"
        costBasisWorkspace={{
          enabled: true,
          product: {
            id: 'product-1', product_name: 'Atrazine', sku: null, pricing_version: 1,
            current_cost_cents: 2_100n, tier1_margin_percent: '20',
            tier2_margin_percent: '15', tier3_margin_percent: '10',
          },
          current_basis: null,
          supplier_candidates: [{
            supplier_price_observation_id: 'observation-1', vendor_id: 'vendor-1',
            vendor_name: 'The Andersons', quoted_package_cost_cents: 10_000n,
            normalized_cost_cents: 2_000n, effective_from: '2026-07-01', price_kind: 'quote',
          }],
          purchase_candidates: [{
            purchase_order_item_id: 'po-1', purchase_order_id: 'purchase-1',
            po_number: 'PO-1', vendor_name: 'supplier unknown',
            normalized_cost_cents: 2_200n, purchased_at: '2026-07-04T12:00:00Z',
          }],
        }}
        onSelectSupplierBasis={selectSupplier}
        onSelectPurchaseBasis={selectPurchase}
      />,
    );

    await screen.findByText('supplier unknown');
    expect(screen.getAllByText('The Andersons')).toHaveLength(2);
    expect(screen.getAllByText('Van Diest')).toHaveLength(2);
    expect(screen.getByText('CRX selected basis')).toBeInTheDocument();
    expect(screen.getAllByText('Received PO cost').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Product supplier price history chart' })).toBeInTheDocument();
    const selectButtons = screen.getAllByRole('button', { name: 'Select as cost basis' });
    expect(selectButtons).toHaveLength(2);
    fireEvent.click(selectButtons[0]);
    fireEvent.click(selectButtons[1]);
    expect(selectSupplier).toHaveBeenCalledWith(expect.objectContaining({
      supplier_price_observation_id: 'observation-1',
    }));
    expect(selectPurchase).toHaveBeenCalledWith(expect.objectContaining({
      purchase_order_item_id: 'po-1',
    }));

    fireEvent.change(screen.getByLabelText('Filter supplier'), { target: { value: 'vendor-1' } });

    expect(screen.getAllByText('The Andersons')).toHaveLength(2);
    expect(screen.getAllByText('Van Diest')).toHaveLength(1);
    expect(screen.queryByText('supplier unknown')).not.toBeInTheDocument();
    expect(screen.getByText('CRX selected basis')).toBeInTheDocument();
  });
});
