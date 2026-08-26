import { describe, expect, it } from 'vitest';
import type { PricingWorkbookExport } from './productPricing';
import {
  generateProductPricingWorkbookWithSupplierEvidence,
  parseProductPricingWorkbookWithSupplierEvidence,
  PRICING_MARKET_EVIDENCE_HEADERS,
  PRICING_SUPPLIER_EVIDENCE_SHEET,
} from './productPricingSupplierEvidenceWorkbook';
import { PRICING_WORKBOOK_HEADERS, PRICING_WORKBOOK_SHEET } from './productPricingWorkbook';

describe('pricing workbook supplier evidence', () => {
  it('adds locked market-evidence columns and preserves the Phase 1a pricing payload', async () => {
    const pricingExport: PricingWorkbookExport = {
      export_id: 'export-1',
      manifest_fingerprint: 'fingerprint-1',
      expires_at: '2026-07-25T12:00:00Z',
      rows: [{
        product_id: 'product-1', sku: 'SKU-1', product_name: 'Atrazine', category: 'Herbicide',
        container_size: '2.5', unit_size: 'gal', inventory_unit: 'gallon',
        identity_fingerprint: 'identity-1', row_token: 'token-1', row_version: 1,
        current_cost: '20.00', current_tier1_margin_percent: '10', current_tier1_price: '22.22',
        current_tier2_margin_percent: '15', current_tier2_price: '23.53',
        current_tier3_margin_percent: '20', current_tier3_price: '25.00',
      }],
    };
    const blob = await generateProductPricingWorkbookWithSupplierEvidence(pricingExport, [{
      product_id: 'product-1', supplier_quote_count: 1, comparable_quote_count: 1,
      replacement_cost_cents: 1_900n, replacement_cost_as_of: '2026-07-18',
      best_supplier: 'The Andersons', comparison_status: 'comparable',
      last_paid_cents: 2_100n, last_paid_as_of: '2026-07-10',
      recent_po_weighted_average_cents: 2_050n, recent_po_window: 'trailing_12_months',
      suppliers: [{
        vendor_id: 'vendor-1', vendor_name: 'The Andersons', product_supplier_link_id: 'link-1',
        quoted_package_cost_cents: 9_500n, normalized_cost_cents: 1_900n,
        effective_from: '2026-07-18', comparison_status: 'comparable', is_best_comparable: true,
      }],
    }]);

    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await blob.arrayBuffer());
    const pricingSheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const evidenceSheet = workbook.getWorksheet(PRICING_SUPPLIER_EVIDENCE_SHEET)!;

    expect(Array.from({ length: pricingSheet.getRow(1).cellCount }, (_, index) => (
      pricingSheet.getCell(1, index + 1).value
    ))).toEqual([...PRICING_WORKBOOK_HEADERS, ...PRICING_MARKET_EVIDENCE_HEADERS]);
    expect(pricingSheet.getCell(2, PRICING_WORKBOOK_HEADERS.length + 1).value)
      .toBe('The Andersons');
    expect(pricingSheet.getCell(2, PRICING_WORKBOOK_HEADERS.length + 2).value).toBe('$19.00');
    expect(pricingSheet.getCell(2, PRICING_WORKBOOK_HEADERS.length + 2).protection?.locked)
      .not.toBe(false);
    expect(evidenceSheet.getCell(2, 3).value).toBe('The Andersons');
    expect(evidenceSheet.getCell(2, 4).value).toBe('$95.00');
    expect(evidenceSheet.getCell(2, 5).value).toBe('$19.00');

    const parsed = await parseProductPricingWorkbookWithSupplierEvidence(await blob.arrayBuffer());
    expect(parsed.exportId).toBe('export-1');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].product_id).toBe('product-1');
    // Same ExcelJS generate-and-reparse cost as the product and supplier
    // workbook tests, which already carry this timeout. ~350ms warm, but the
    // first ExcelJS load in a worker is multi-second on a cold module/FS cache
    // (7.0s measured here on the first run after a fresh `npm ci`), which
    // crosses the 5s default and fails the pre-commit gate in a new worktree.
    // The work is I/O- and CPU-bound, not hung — give it headroom rather than
    // retrying the commit until it passes.
  }, 30000);
});
