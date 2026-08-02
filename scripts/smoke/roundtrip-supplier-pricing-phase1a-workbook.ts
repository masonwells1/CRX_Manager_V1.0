#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { PricingWorkbookExport } from '../../src/lib/productPricing';
import type { SupplierMarketEvidence } from '../../src/lib/supplierPricing';
import {
  generateProductPricingWorkbook,
  parseProductPricingWorkbook,
  PRICING_WORKBOOK_SHEET,
} from '../../src/lib/productPricingWorkbook';

const [inputPath, payloadPath, exportPath, editedPath, mode] = process.argv.slice(2);
if (!inputPath || !payloadPath || !exportPath || !editedPath) {
  throw new Error('Usage: vite-node roundtrip-supplier-pricing-phase1a-workbook.ts <export.json> <payload.json> <export.xlsx> <edited.xlsx> [supplier-evidence]');
}
if (mode !== undefined && mode !== 'supplier-evidence') {
  throw new Error(`Unsupported workbook roundtrip mode: ${mode}`);
}
const supplierEvidenceMode = mode === 'supplier-evidence';
if (supplierEvidenceMode) {
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
}
const supplierEvidenceWorkbook = supplierEvidenceMode
  ? await import(process.env.CRX_SUPPLIER_EVIDENCE_WORKBOOK_MODULE ?? '')
  : null;

const pricingExport = JSON.parse(await readFile(inputPath, 'utf8')) as PricingWorkbookExport;
if (!Array.isArray(pricingExport.rows) || pricingExport.rows.length !== 3) {
  throw new Error(`Expected exactly 3 exported Product rows, received ${pricingExport.rows?.length ?? 'none'}`);
}

const supplierEvidenceFixture: SupplierMarketEvidence[] = supplierEvidenceMode ? [{
  product_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  supplier_quote_count: 1,
  comparable_quote_count: 1,
  replacement_cost_cents: 9_508n,
  replacement_cost_as_of: '2026-07-28',
  best_supplier: 'Northland Crop Supply',
  last_paid_cents: 10_123n,
  last_paid_as_of: '2026-07-12',
  recent_po_weighted_average_cents: 9_987n,
  recent_po_window: 'trailing_12_months',
  comparison_status: 'comparable',
  suppliers: [{
    vendor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    vendor_name: 'Northland Crop Supply',
    product_supplier_link_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    quoted_package_cost_cents: 95_075n,
    normalized_cost_cents: 9_508n,
    effective_from: '2026-07-28',
    comparison_status: 'comparable',
    is_best_comparable: true,
  }],
}] : [];

const exportedBlob = supplierEvidenceMode
  ? await supplierEvidenceWorkbook!.generateProductPricingWorkbookWithSupplierEvidence(
    pricingExport,
    supplierEvidenceFixture,
  )
  : await generateProductPricingWorkbook(pricingExport);
const exportedBytes = Buffer.from(await exportedBlob.arrayBuffer());
await writeFile(exportPath, exportedBytes);

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(exportedBytes);
const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET);
if (!worksheet) throw new Error(`Missing ${PRICING_WORKBOOK_SHEET} worksheet`);

const headers = new Map<string, number>();
worksheet.getRow(1).eachCell((cell, column) => headers.set(String(cell.value), column));
const requiredHeaders = [
  'product_id', 'pricing_mode', 'new_cost',
  'tier1_margin_percent', 'tier2_margin_percent', 'tier3_margin_percent',
  'tier1_price', 'tier2_price', 'tier3_price', 'change_reason',
];
for (const header of requiredHeaders) {
  if (!headers.has(header)) throw new Error(`Missing workbook header ${header}`);
}

if (supplierEvidenceMode) {
  const fixture = supplierEvidenceFixture[0];
  const evidenceHeaders = [
    'best_supplier',
    'replacement_cost',
    'replacement_cost_as_of',
    'supplier_quote_count',
    'supplier_comparison_status',
    'last_paid',
    'last_paid_as_of',
    'recent_po_weighted_average_trailing_12_months',
  ];
  const expectedSummary = [
    fixture.best_supplier,
    '$95.08',
    fixture.replacement_cost_as_of,
    fixture.supplier_quote_count,
    fixture.comparison_status,
    '$101.23',
    fixture.last_paid_as_of,
    '$99.87',
  ];
  const fixtureRow = pricingExport.rows.find((row) => row.product_id === fixture.product_id);
  const fixtureRowNumber = fixtureRow
    ? pricingExport.rows.indexOf(fixtureRow) + 2
    : 0;
  if (!fixtureRow || fixtureRowNumber === 0) {
    throw new Error(`Supplier-evidence fixture Product ${fixture.product_id} was not exported`);
  }
  if (!worksheet.sheetProtection) {
    throw new Error('Supplier-evidence Pricing Update worksheet was not protected');
  }
  for (const [index, header] of evidenceHeaders.entries()) {
    const column = headers.get(header);
    const cell = column ? worksheet.getCell(fixtureRowNumber, column) : undefined;
    if (cell?.value !== expectedSummary[index] || cell.protection?.locked === false) {
      throw new Error(`Supplier-evidence Pricing Update column ${header} did not preserve the fixture as a locked cell on a protected worksheet`);
    }
  }

  const evidenceSheet = workbook.getWorksheet('Supplier Evidence');
  if (!evidenceSheet || !evidenceSheet.sheetProtection) {
    throw new Error('Supplier Evidence worksheet was not protected');
  }
  const expectedDetail = [
    fixture.product_id,
    fixtureRow.product_name,
    fixture.suppliers[0].vendor_name,
    '$950.75',
    '$95.08',
    fixture.suppliers[0].effective_from,
    fixture.suppliers[0].comparison_status,
    fixture.best_supplier,
    '$95.08',
    fixture.replacement_cost_as_of,
  ];
  for (const [index, expected] of expectedDetail.entries()) {
    const cell = evidenceSheet.getCell(2, index + 1);
    if (cell.value !== expected || cell.protection?.locked === false) {
      throw new Error(`Supplier Evidence fixture field ${index + 1} did not remain exact and locked`);
    }
  }
}

const rowByProduct = new Map<string, number>();
for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
  rowByProduct.set(String(worksheet.getCell(rowNumber, headers.get('product_id')!).value), rowNumber);
}

function editProduct(productId: string, values: Record<string, string | number>) {
  const rowNumber = rowByProduct.get(productId);
  if (!rowNumber) throw new Error(`Export did not contain Product ${productId}`);
  for (const [header, value] of Object.entries(values)) {
    worksheet.getCell(rowNumber, headers.get(header)!).value = value;
  }
}

editProduct('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', {
  pricing_mode: 'margin_driven', new_cost: '90.01',
  tier1_margin_percent: 20, tier2_margin_percent: 25, tier3_margin_percent: 30,
  change_reason: 'Monthly supplier worksheet',
});
editProduct('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', {
  pricing_mode: 'price_driven', new_cost: '60.99',
  tier1_price: '70.01', tier2_price: '80.99', tier3_price: '90.01',
  change_reason: 'Monthly supplier worksheet',
});
editProduct('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', {
  pricing_mode: 'margin_driven', new_cost: '45.99',
  tier1_margin_percent: 20, tier2_margin_percent: 25, tier3_margin_percent: 30,
  change_reason: 'Third Product monthly update',
});

await workbook.xlsx.writeFile(editedPath);
const editedBytes = await readFile(editedPath);
const editedArrayBuffer = editedBytes.buffer.slice(
  editedBytes.byteOffset,
  editedBytes.byteOffset + editedBytes.byteLength,
) as ArrayBuffer;
const parsed = supplierEvidenceMode
  ? await supplierEvidenceWorkbook!.parseProductPricingWorkbookWithSupplierEvidence(editedArrayBuffer)
  : await parseProductPricingWorkbook(editedArrayBuffer);

if (parsed.exportId !== pricingExport.export_id || parsed.rowCount !== 3) {
  throw new Error('Parsed workbook manifest did not round-trip the server export');
}
const modes = parsed.rows.map((row) => row.pricing_mode).sort();
if (JSON.stringify(modes) !== JSON.stringify(['margin_driven', 'margin_driven', 'price_driven'])) {
  throw new Error(`Workbook pricing modes did not round-trip: ${modes.join(',')}`);
}
if (parsed.rows.some((row) => row.has_formula || row.formula_cells.length > 0)) {
  throw new Error('Plain-value proof workbook unexpectedly parsed a formula');
}
const parsedByProduct = new Map(parsed.rows.map((row) => [row.product_id, row]));
const exactMoneyEdits: Record<string, Record<string, string>> = {
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1': { new_cost: '90.01' },
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2': {
    new_cost: '60.99', tier1_price: '70.01', tier2_price: '80.99', tier3_price: '90.01',
  },
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3': { new_cost: '45.99' },
};
for (const [productId, expected] of Object.entries(exactMoneyEdits)) {
  const row = parsedByProduct.get(productId);
  if (!row) throw new Error(`Parsed workbook omitted Product ${productId}`);
  for (const [field, value] of Object.entries(expected)) {
    if (row[field as keyof typeof row] !== value) {
      throw new Error(`Cent-sensitive ${field} did not round-trip exactly for Product ${productId}`);
    }
  }
}

const normalizedRows = supplierEvidenceMode
  ? (await import(process.env.CRX_COST_BASIS_ROWS_MODULE ?? '')).costBasisRows(
    parsed.rows,
    'pricing_worksheet',
  )
  : parsed.rows;
await writeFile(payloadPath, JSON.stringify({
  ...parsed,
  rows: normalizedRows,
}));
process.stdout.write('PHASE1A_XLSX_PARSE_PASS\n');
