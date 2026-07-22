import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PricingPreviewResult } from '../../lib/productPricing';
import PricingChangePreviewModal from './PricingChangePreviewModal';

function makePreview(overrides: Partial<PricingPreviewResult> = {}): PricingPreviewResult {
  return {
    change_set_id: 'change-set-1',
    request_fingerprint: 'fingerprint-1',
    source: 'product_page',
    status: 'previewed',
    expires_at: '2026-07-16T22:00:00Z',
    submitted_row_count: 2,
    ready_count: 1,
    unchanged_count: 0,
    conflict_count: 1,
    invalid_count: 0,
    apply_allowed: true,
    rows: [
      {
        sequence: 2,
        product_id: 'product-2',
        submitted_row: { product_name: 'Later Product', sku: 'SKU-2' },
        row_status: 'conflict',
        error_code: 'PRICING_ROW_CONFLICT',
        effect: null,
      },
      {
        sequence: 1,
        product_id: 'product-1',
        submitted_row: { product_name: 'Untrusted Client Label', sku: 'CLIENT-SKU' },
        row_status: 'ready',
        error_code: null,
        effect: {
          product_id: 'product-1',
          product_name: 'First Product',
          sku: 'SKU-1',
          pricing_mode: 'price_driven',
          before: {
            cost: '10.00',
            cost_cents: 1000n,
            tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '12.50', tier1_price_cents: 1250n,
            tier2_margin_percent: '25', tier2_margin: 0.25, tier2_price: '13.33', tier2_price_cents: 1333n,
            tier3_margin_percent: '30', tier3_margin: 0.3, tier3_price: '14.29', tier3_price_cents: 1429n,
            tier1_price_per_acre_cents: 625n,
            tier2_price_per_acre_cents: null,
            tier3_price_per_acre_cents: null,
          },
          cost: '12.00',
          cost_cents: 1200n,
          tier1_margin_percent: '-4.35',
           tier1_margin: -0.0435,
          tier1_gross_margin: -0.0417,
          tier1_price: '11.50',
          tier1_price_cents: 1150n,
          tier2_margin_percent: '20',
           tier2_margin: 0.2,
          tier2_gross_margin: 0.25,
          tier2_price: '15.00',
          tier2_price_cents: 1500n,
          tier3_margin_percent: '25',
           tier3_margin: 0.25,
          tier3_gross_margin: 0.33333333,
          tier3_price: '16.00',
          tier3_price_cents: 1600n,
          tier1_price_per_acre_cents: 575n,
          tier2_price_per_acre_cents: null,
          tier3_price_per_acre_cents: null,
        },
      },
    ],
    ...overrides,
  };
}

describe('PricingChangePreviewModal', () => {
  it('renders Product information old-to-new values without a pricing card for info-only rows', () => {
    const preview = makePreview({ submitted_row_count: 1, conflict_count: 0 });
    preview.rows = [{
      ...preview.rows[1],
      effect: {
        ...preview.rows[1].effect!,
        pricing_changed: false,
        product_info_changes: {
          quoting_notes: { before: null, after: 'Prefer early-season placement' },
          rate_per_acre: { before: 12, after: 16 },
        },
      },
    }];

    render(
      <PricingChangePreviewModal
        open preview={preview} applying={false}
        onClose={vi.fn()} onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText('Product information')).toBeInTheDocument();
    expect(screen.getByText('Quoting notes')).toBeInTheDocument();
    expect(screen.getByText('Prefer early-season placement')).toBeInTheDocument();
    expect(screen.queryByText('Cost')).not.toBeInTheDocument();
  });

  it('renders summary, ordered rows, effects, warnings, and plain-English errors', () => {
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview()}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText('Ready for approval')).toBeInTheDocument();
    expect(screen.getByText('2 submitted rows')).toBeInTheDocument();

    const rows = within(screen.getByRole('list', { name: 'Pricing preview rows' })).getAllByRole('listitem');
    expect(within(rows[0]).getByText('First Product')).toBeInTheDocument();
    expect(within(rows[0]).getByText('SKU SKU-1')).toBeInTheDocument();
    expect(within(rows[0]).getByText('$10.00')).toBeInTheDocument();
    expect(within(rows[0]).getByText('$12.00')).toBeInTheDocument();
    expect(within(rows[0]).getByText('$12.50')).toBeInTheDocument();
    expect(within(rows[0]).getByText('$5.75 / acre')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Gross / markup: 25%')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Warning: this price is below cost.')).toBeInTheDocument();

    expect(within(rows[1]).getByText('Later Product')).toBeInTheDocument();
    expect(
      within(rows[1]).getByText(/changed after the pricing data was loaded/i),
    ).toBeInTheDocument();
  });

  it('formats per-acre cents exactly beyond JavaScript safe-integer precision', () => {
    const preview = makePreview();
    preview.rows[1].effect!.tier2_price_per_acre_cents = 9_007_199_254_740_993n;

    render(
      <PricingChangePreviewModal
        open
        preview={preview}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText('$90,071,992,547,409.93 / acre')).toBeInTheDocument();
  });

  it('disables approval unless the preview is applyable with ready rows', () => {
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({ apply_allowed: false })}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Apply approved changes' })).toBeDisabled();
  });

  it('calls onApprove for an approved preview and shows the loading state', () => {
    const onApprove = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <PricingChangePreviewModal
        open
        preview={makePreview()}
        applying={false}
        onClose={onClose}
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    rerender(
      <PricingChangePreviewModal
        open
        preview={makePreview()}
        applying
        onClose={onClose}
        onApprove={onApprove}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apply approved changes' })).toBeDisabled();
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    closeButtons.forEach((button) => expect(button).toBeDisabled());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.querySelector('[data-modal-panel]')).toHaveFocus();
  });

  it('allows a basis-only selection when the dollar cost is unchanged', () => {
    const onApprove = vi.fn();
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({
          status: 'no_changes',
          ready_count: 0,
          unchanged_count: 1,
          conflict_count: 0,
          apply_allowed: true,
          basis_change_count: 1,
          rows: [{
            sequence: 1,
            product_id: 'product-1',
            submitted_row: {
              product_name: 'First Product',
              basis_selection: true,
              basis_type: 'selected_supplier_price',
              basis_reason: 'Current confirmed supplier quote',
              supplier_price_observation_id: 'observation-1',
            },
            row_status: 'unchanged',
            error_code: null,
            effect: null,
          }],
        })}
        applying={false}
        onClose={vi.fn()}
        onApprove={onApprove}
      />,
    );

    expect(screen.getByText('Cost basis ready — sell prices stay unchanged')).toBeInTheDocument();
    const basisDetails = screen.getByLabelText('Cost basis approval details');
    expect(within(basisDetails).getByText('Supplier price observation')).toBeInTheDocument();
    expect(within(basisDetails).getByText('Current confirmed supplier quote')).toBeInTheDocument();
    expect(within(basisDetails).getByText('Supplier observation observation-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      basisType: 'actual_purchase',
      reason: 'Most recent received inventory cost',
      evidenceKey: 'purchase_order_item_id',
      evidenceId: 'po-item-1',
      expectedType: 'Received purchase order',
      expectedEvidence: 'Purchase order item po-item-1',
    },
    {
      basisType: 'manual_override',
      reason: 'Owner-entered replacement cost',
      evidenceKey: null,
      evidenceId: null,
      expectedType: 'Manual replacement cost',
      expectedEvidence: 'Entered manually',
    },
  ])('shows $expectedType approval metadata', ({
    basisType,
    reason,
    evidenceKey,
    evidenceId,
    expectedType,
    expectedEvidence,
  }) => {
    const submittedRow: Record<string, unknown> = {
      product_name: 'First Product',
      basis_selection: true,
      basis_type: basisType,
      basis_reason: reason,
    };
    if (evidenceKey) submittedRow[evidenceKey] = evidenceId;

    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({
          submitted_row_count: 1,
          ready_count: 1,
          conflict_count: 0,
          basis_change_count: 1,
          rows: [{
            sequence: 1,
            product_id: 'product-1',
            submitted_row: submittedRow,
            row_status: 'ready',
            error_code: null,
            effect: null,
          }],
        })}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    const basisDetails = screen.getByLabelText('Cost basis approval details');
    expect(within(basisDetails).getByText(expectedType)).toBeInTheDocument();
    expect(within(basisDetails).getByText(reason)).toBeInTheDocument();
    expect(within(basisDetails).getByText(expectedEvidence)).toBeInTheDocument();
  });

  it.each([
    ['invalid', 'Some rows need attention'],
    ['no_changes', 'No pricing changes found'],
  ] as const)('shows no approval path for %s previews', (status, statusLabel) => {
    const onClose = vi.fn();
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({ status, apply_allowed: false, ready_count: 0 })}
        applying={false}
        onClose={onClose}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText(statusLabel)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply approved changes' })).not.toBeInTheDocument();
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
