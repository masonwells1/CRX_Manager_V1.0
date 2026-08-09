import { describe, expect, it } from 'vitest';
import type { Workbook } from 'exceljs';
import type { SupplierQuoteSheet } from './supplierPricing';
import {
  generateSupplierQuoteWorkbook,
  MAX_SUPPLIER_QUOTE_BYTES,
  parseSupplierQuoteWorkbook,
  SUPPLIER_QUOTE_FORMAT_VERSION,
  SUPPLIER_QUOTE_HEADERS,
  SUPPLIER_QUOTE_MANIFEST_SHEET,
  SUPPLIER_QUOTE_SHEET,
  SupplierQuoteWorkbookError,
} from './supplierPricingWorkbook';

const quote: SupplierQuoteSheet = {
  format_version: SUPPLIER_QUOTE_FORMAT_VERSION,
  vendor_id: '11111111-1111-4111-8111-111111111111',
  vendor_name: 'The Andersons',
  generated_at: '2026-07-18T12:00:00Z',
  rows: [
    {
      product_supplier_link_id: '22222222-2222-4222-8222-222222222222',
      product_id: '33333333-3333-4333-8333-333333333333',
      vendor_id: '11111111-1111-4111-8111-111111111111',
      supplier_sku: 'AND-001',
      product_name: 'Atrazine 4L',
      supplier_product_name: 'Atrazine 4L 2x2.5',
      supplier_uom: 'case',
      supplier_pack_description: '2 x 2.5 gallon case',
      inventory_unit: 'gallon',
      inventory_units_per_supplier_unit: 5,
      comparison_status: 'comparable',
      last_cost: '120.00',
      last_effective_date: '2026-06-15',
      new_cost: '',
      effective_date: '2026-07-18',
      price_kind: 'quote',
    },
  ],
};

async function loadGeneratedWorkbook(): Promise<Workbook> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const blob = await generateSupplierQuoteWorkbook(quote);
  await workbook.xlsx.load(await blob.arrayBuffer());
  return workbook;
}

async function writeWorkbook(workbook: Workbook): Promise<ArrayBuffer> {
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as unknown as ArrayBuffer).buffer;
}

describe('supplier quote workbook', () => {
  it('creates a protected supplier template and round-trips manual text without float conversion', async () => {
    const workbook = await loadGeneratedWorkbook();
    const sheet = workbook.getWorksheet(SUPPLIER_QUOTE_SHEET)!;
    const manifest = workbook.getWorksheet(SUPPLIER_QUOTE_MANIFEST_SHEET)!;
    const newCostColumn = SUPPLIER_QUOTE_HEADERS.indexOf('new_cost') + 1;
    sheet.getCell(2, newCostColumn).value = '90071992547409.93';

    const parsed = await parseSupplierQuoteWorkbook(await writeWorkbook(workbook));

    expect(manifest.state).toBe('veryHidden');
    expect(sheet.getColumn(1).hidden).toBe(true);
    expect(parsed).toMatchObject({
      formatVersion: SUPPLIER_QUOTE_FORMAT_VERSION,
      vendorId: quote.vendor_id,
      vendorName: quote.vendor_name,
      rowCount: 1,
    });
    expect(parsed.rows[0]).toMatchObject({
      product_supplier_link_id: quote.rows[0].product_supplier_link_id,
      new_cost: '90071992547409.93',
      effective_date: '2026-07-18',
      price_kind: 'quote',
      price_unit: 'case',
      package_quantity: '1',
      has_formula: false,
    });
    // Same ExcelJS generate-and-reparse cost as the product workbook test:
    // fast alone, over the 5s default under full-suite load.
  }, 20000);

  it.each([
    ['.39', '0.39'],
    ['.5', '0.5'],
  ])('normalizes the manual sub-dollar cost %s to %s', async (enteredCost, expectedCost) => {
    const workbook = await loadGeneratedWorkbook();
    const sheet = workbook.getWorksheet(SUPPLIER_QUOTE_SHEET)!;
    const newCostColumn = SUPPLIER_QUOTE_HEADERS.indexOf('new_cost') + 1;
    sheet.getCell(2, newCostColumn).value = enteredCost;

    const parsed = await parseSupplierQuoteWorkbook(await writeWorkbook(workbook));

    expect(parsed.rows[0].new_cost).toBe(expectedCost);
  });

  it.each(['.123', '-.39', '1e-2'])('leaves invalid cost text %s for governed server rejection', async (enteredCost) => {
    const workbook = await loadGeneratedWorkbook();
    const sheet = workbook.getWorksheet(SUPPLIER_QUOTE_SHEET)!;
    const newCostColumn = SUPPLIER_QUOTE_HEADERS.indexOf('new_cost') + 1;
    sheet.getCell(2, newCostColumn).value = enteredCost;

    const parsed = await parseSupplierQuoteWorkbook(await writeWorkbook(workbook));

    expect(parsed.rows[0].new_cost).toBe(enteredCost);
  });

  it('flags formulas for server-side row rejection', async () => {
    const workbook = await loadGeneratedWorkbook();
    const sheet = workbook.getWorksheet(SUPPLIER_QUOTE_SHEET)!;
    const newCostColumn = SUPPLIER_QUOTE_HEADERS.indexOf('new_cost') + 1;
    sheet.getCell(2, newCostColumn).value = { formula: '100+25', result: 125 };

    const parsed = await parseSupplierQuoteWorkbook(await writeWorkbook(workbook));

    expect(parsed.rows[0].has_formula).toBe(true);
    expect(parsed.rows[0].formula_cells).toEqual(['new_cost']);
    expect(parsed.rows[0].new_cost).toBe('125');
  });

  it('rejects duplicate protected supplier links', async () => {
    const workbook = await loadGeneratedWorkbook();
    const sheet = workbook.getWorksheet(SUPPLIER_QUOTE_SHEET)!;
    sheet.duplicateRow(2, 1, true);
    const manifest = workbook.getWorksheet(SUPPLIER_QUOTE_MANIFEST_SHEET)!;
    manifest.getCell(5, 2).value = '2';

    await expect(parseSupplierQuoteWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow(SupplierQuoteWorkbookError);
  });

  it('rejects a row whose protected vendor differs from the manifest', async () => {
    const workbook = await loadGeneratedWorkbook();
    const sheet = workbook.getWorksheet(SUPPLIER_QUOTE_SHEET)!;
    const vendorColumn = SUPPLIER_QUOTE_HEADERS.indexOf('vendor_id') + 1;
    sheet.getCell(2, vendorColumn).value = '99999999-9999-4999-8999-999999999999';

    await expect(parseSupplierQuoteWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('does not belong to The Andersons');
  });

  it('rejects unsafe .xlsx envelopes before Excel parses them', async () => {
    await expect(parseSupplierQuoteWorkbook(new ArrayBuffer(8)))
      .rejects.toThrow('not a readable .xlsx archive');
    await expect(parseSupplierQuoteWorkbook(new ArrayBuffer(MAX_SUPPLIER_QUOTE_BYTES + 1)))
      .rejects.toThrow('10 MB or smaller');
  });
});
