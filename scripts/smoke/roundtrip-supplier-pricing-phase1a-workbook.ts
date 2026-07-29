#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { PricingWorkbookExport } from '../../src/lib/productPricing';
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

const exportedBlob = supplierEvidenceMode
  ? await supplierEvidenceWorkbook!.generateProductPricingWorkbookWithSupplierEvidence(
    pricingExport,
    [],
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
