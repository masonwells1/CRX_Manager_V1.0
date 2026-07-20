import type { Worksheet } from 'exceljs';
import type { PricingWorkbookExport } from './productPricing';
import {
  generateProductPricingWorkbook,
  parseProductPricingWorkbook,
  PRICING_WORKBOOK_HEADERS,
  PRICING_WORKBOOK_MIME,
  PRICING_WORKBOOK_SHEET,
  PricingWorkbookFormatError,
  type ParsedPricingWorkbook,
} from './productPricingWorkbook';
import { formatSupplierCents, type SupplierMarketEvidence } from './supplierPricing';

export const PRICING_SUPPLIER_EVIDENCE_SHEET = 'Supplier Evidence';
export const PRICING_MARKET_EVIDENCE_HEADERS = [
  'best_supplier',
  'replacement_cost',
  'replacement_cost_as_of',
  'supplier_quote_count',
  'supplier_comparison_status',
  'last_paid',
  'last_paid_as_of',
  'recent_po_weighted_average_trailing_12_months',
] as const;

const EVIDENCE_HEADERS = [
  'product_id',
  'product_name',
  'supplier',
  'quoted_package_cost',
  'normalized_inventory_unit_cost',
  'effective_from',
  'comparison_status',
  'best_supplier',
  'replacement_cost',
  'replacement_cost_as_of',
] as const;

async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const imported = await import('exceljs') as unknown as {
    default?: typeof import('exceljs');
  } & Partial<typeof import('exceljs')>;
  return (imported.default ?? imported) as typeof import('exceljs');
}

function bufferToArrayBuffer(buffer: unknown): ArrayBuffer {
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function addMarketEvidenceColumns(
  worksheet: Worksheet,
  pricingExport: PricingWorkbookExport,
  evidenceByProduct: Map<string, SupplierMarketEvidence>,
): void {
  const firstColumn = PRICING_WORKBOOK_HEADERS.length + 1;
  PRICING_MARKET_EVIDENCE_HEADERS.forEach((header, index) => {
    const columnNumber = firstColumn + index;
    const column = worksheet.getColumn(columnNumber);
    column.width = [24, 20, 23, 20, 28, 18, 20, 43][index];
    const headerCell = worksheet.getCell(1, columnNumber);
    headerCell.value = header;
    headerCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF355C7D' } };
    headerCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerCell.protection = { locked: true };
  });

  pricingExport.rows.forEach((product, index) => {
    const item = evidenceByProduct.get(product.product_id);
    const values = [
      item?.best_supplier ?? '',
      formatSupplierCents(item?.replacement_cost_cents ?? null),
      item?.replacement_cost_as_of ?? '',
      item?.supplier_quote_count ?? 0,
      item?.comparison_status ?? 'no_evidence',
      formatSupplierCents(item?.last_paid_cents ?? null),
      item?.last_paid_as_of ?? '',
      formatSupplierCents(item?.recent_po_weighted_average_cents ?? null),
    ];
    values.forEach((value, valueIndex) => {
      const cell = worksheet.getCell(index + 2, firstColumn + valueIndex);
      cell.value = value;
      cell.font = { color: { argb: 'FF17231E' }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EFF5' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      cell.protection = { locked: true };
      cell.numFmt = '@';
    });
  });

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: {
      row: Math.max(1, pricingExport.rows.length + 1),
      column: PRICING_WORKBOOK_HEADERS.length + PRICING_MARKET_EVIDENCE_HEADERS.length,
    },
  };
}

function styleEvidenceSheet(worksheet: Worksheet, rowCount: number): void {
  worksheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1, showGridLines: false }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rowCount + 1), column: EVIDENCE_HEADERS.length },
  };
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6B4F' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  const widths = [38, 30, 24, 22, 29, 18, 19, 24, 20, 23];
  EVIDENCE_HEADERS.forEach((_, index) => {
    const column = worksheet.getColumn(index + 1);
    column.width = widths[index];
    column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber === 1) return;
      cell.numFmt = '@';
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F3' } };
      cell.protection = { locked: true };
    });
  });
}

/**
 * Extend the Phase 1a workbook without changing any editable pricing field.
 * The main sheet gets locked summary columns and the detail sheet retains each
 * supplier's package quote and normalized inventory-unit cost.
 */
export async function generateProductPricingWorkbookWithSupplierEvidence(
  pricingExport: PricingWorkbookExport,
  evidence: SupplierMarketEvidence[],
): Promise<Blob> {
  const baseWorkbook = await generateProductPricingWorkbook(pricingExport);
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await baseWorkbook.arrayBuffer());

  const evidenceByProduct = new Map(evidence.map((item) => [item.product_id, item]));
  const pricingSheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET);
  if (!pricingSheet) throw new Error(`Missing ${PRICING_WORKBOOK_SHEET} worksheet.`);
  addMarketEvidenceColumns(pricingSheet, pricingExport, evidenceByProduct);
  const sheet = workbook.addWorksheet(PRICING_SUPPLIER_EVIDENCE_SHEET);
  sheet.addRow([...EVIDENCE_HEADERS]);
  let rowCount = 0;
  for (const product of pricingExport.rows) {
    const item = evidenceByProduct.get(product.product_id);
    if (!item || item.suppliers.length === 0) {
      sheet.addRow([
        product.product_id,
        product.product_name,
        '',
        '',
        '',
        '',
        'no_evidence',
        item?.best_supplier ?? '',
        formatSupplierCents(item?.replacement_cost_cents ?? null),
        item?.replacement_cost_as_of ?? '',
      ]);
      rowCount += 1;
      continue;
    }
    for (const supplier of item.suppliers) {
      sheet.addRow([
        product.product_id,
        product.product_name,
        supplier.vendor_name,
        formatSupplierCents(supplier.quoted_package_cost_cents),
        supplier.normalized_cost_cents === null
          ? 'Cannot compare'
          : formatSupplierCents(supplier.normalized_cost_cents),
        supplier.effective_from,
        supplier.comparison_status,
        item.best_supplier ?? '',
        formatSupplierCents(item.replacement_cost_cents),
        item.replacement_cost_as_of ?? '',
      ]);
      rowCount += 1;
    }
  }
  styleEvidenceSheet(sheet, rowCount);
  await sheet.protect('crx-supplier-evidence-read-only', {
    spinCount: 1_000,
    selectLockedCells: true,
    selectUnlockedCells: false,
    autoFilter: true,
    sort: true,
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer as unknown as ArrayBuffer)], {
    type: PRICING_WORKBOOK_MIME,
  });
}

/**
 * Accept old Phase 1a workbooks unchanged. For a Phase 1b export, first run the
 * original parser so its ZIP-bomb and archive checks complete. Its only expected
 * rejection is the known locked evidence suffix; remove that suffix and rerun
 * the unchanged Phase 1a parser for the authoritative pricing payload.
 */
export async function parseProductPricingWorkbookWithSupplierEvidence(
  arrayBuffer: ArrayBuffer,
): Promise<ParsedPricingWorkbook> {
  try {
    return await parseProductPricingWorkbook(arrayBuffer);
  } catch (error) {
    if (!(error instanceof PricingWorkbookFormatError)
      || error.message !== 'The Pricing Update sheet headers do not match the CRX template.') {
      throw error;
    }
  }

  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);
  const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET);
  if (!worksheet) {
    throw new PricingWorkbookFormatError(`Missing required worksheet ${PRICING_WORKBOOK_SHEET}.`);
  }
  const expectedHeaders = [...PRICING_WORKBOOK_HEADERS, ...PRICING_MARKET_EVIDENCE_HEADERS];
  const actualHeaders = Array.from(
    { length: worksheet.getRow(1).cellCount },
    (_, index) => worksheet.getCell(1, index + 1).value,
  );
  if (actualHeaders.length !== expectedHeaders.length
    || expectedHeaders.some((header, index) => actualHeaders[index] !== header)) {
    throw new PricingWorkbookFormatError(
      'The Pricing Update sheet headers do not match the CRX Phase 1b template.',
    );
  }

  worksheet.spliceColumns(
    PRICING_WORKBOOK_HEADERS.length + 1,
    PRICING_MARKET_EVIDENCE_HEADERS.length,
  );
  const sanitizedBuffer = await workbook.xlsx.writeBuffer();
  return parseProductPricingWorkbook(bufferToArrayBuffer(sanitizedBuffer));
}
