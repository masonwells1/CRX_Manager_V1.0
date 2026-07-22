import type { CellValue, Worksheet } from 'exceljs';
import type {
  SupplierImportInputRow,
  SupplierQuoteSheet,
  SupplierQuoteSheetRow,
} from './supplierPricing';
import type { SupplierPriceKind } from '../types';
import {
  validateXlsxArchiveSafety,
  XlsxArchiveSafetyError,
} from './xlsxArchiveSafety';

export const SUPPLIER_QUOTE_SHEET = 'Supplier Quote';
export const SUPPLIER_QUOTE_MANIFEST_SHEET = '_crx_supplier_manifest';
export const SUPPLIER_QUOTE_FORMAT_VERSION = 'crx-supplier-quote-phase1b-v1';
export const SUPPLIER_QUOTE_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_SUPPLIER_QUOTE_ROWS = 5_000;
export const MAX_SUPPLIER_QUOTE_BYTES = 10 * 1024 * 1024;
export const MAX_SUPPLIER_QUOTE_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

export const SUPPLIER_QUOTE_HEADERS = [
  'product_supplier_link_id',
  'product_id',
  'vendor_id',
  'supplier_sku',
  'product_name',
  'supplier_product_name',
  'supplier_uom',
  'supplier_pack_description',
  'inventory_unit',
  'inventory_units_per_supplier_unit',
  'comparison_status',
  'last_cost',
  'last_effective_date',
  'new_cost',
  'effective_date',
  'price_kind',
  'price_unit',
  'package_quantity',
] as const;

type SupplierQuoteHeader = (typeof SUPPLIER_QUOTE_HEADERS)[number];

const MANIFEST_KEYS = [
  'format_version',
  'vendor_id',
  'vendor_name',
  'generated_at',
  'row_count',
] as const;

const EDITABLE_HEADERS = new Set<SupplierQuoteHeader>([
  'new_cost',
  'effective_date',
  'price_kind',
  'price_unit',
  'package_quantity',
]);

const COLUMN_WIDTHS: Record<SupplierQuoteHeader, number> = {
  product_supplier_link_id: 38,
  product_id: 38,
  vendor_id: 38,
  supplier_sku: 18,
  product_name: 30,
  supplier_product_name: 30,
  supplier_uom: 16,
  supplier_pack_description: 24,
  inventory_unit: 16,
  inventory_units_per_supplier_unit: 29,
  comparison_status: 19,
  last_cost: 15,
  last_effective_date: 20,
  new_cost: 15,
  effective_date: 18,
  price_kind: 16,
  price_unit: 16,
  package_quantity: 18,
};

export interface ParsedSupplierQuoteWorkbook {
  formatVersion: string;
  vendorId: string;
  vendorName: string;
  generatedAt: string;
  rowCount: number;
  rows: SupplierImportInputRow[];
}

export class SupplierQuoteWorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierQuoteWorkbookError';
  }
}

async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const imported = await import('exceljs') as unknown as {
    default?: typeof import('exceljs');
  } & Partial<typeof import('exceljs')>;
  return (imported.default ?? imported) as typeof import('exceljs');
}

function isFormulaValue(value: CellValue): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && ('formula' in value || 'sharedFormula' in value),
  );
}

function formulaResult(value: CellValue): CellValue {
  if (!isFormulaValue(value)) return value;
  return (value as { result?: CellValue }).result;
}

function numberToPlainDecimal(value: number, context: string): string {
  if (!Number.isFinite(value)) {
    throw new SupplierQuoteWorkbookError(`${context} contains a non-finite number.`);
  }
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const match = raw.match(/^(-?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) throw new SupplierQuoteWorkbookError(`${context} contains an unsupported number.`);
  const [, sign, integer, fraction = '', exponentText] = match;
  const exponent = Number(exponentText);
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function cellValueToText(value: CellValue, context: string): string {
  const resolved = formulaResult(value);
  if (resolved == null) return '';
  if (typeof resolved === 'string') return resolved.trim();
  if (typeof resolved === 'number') return numberToPlainDecimal(resolved, context);
  if (typeof resolved === 'boolean') return String(resolved);
  if (resolved instanceof Date) {
    return resolved.toISOString().slice(0, 10);
  }
  if ('richText' in resolved) return resolved.richText.map((part) => part.text).join('').trim();
  if ('hyperlink' in resolved) return resolved.text.trim();
  if ('error' in resolved) {
    throw new SupplierQuoteWorkbookError(`${context} contains the Excel error ${resolved.error}.`);
  }
  throw new SupplierQuoteWorkbookError(`${context} contains an unsupported cell value.`);
}

function normalizeSupplierCostText(value: string): string {
  // Staff commonly enter sub-dollar quotes as `.39`. Keep the database parser
  // strict and normalize only this unambiguous workbook shorthand at the edge.
  return /^\.[0-9]{1,2}$/.test(value) ? `0${value}` : value;
}

function quoteWorkbookRow(row: SupplierQuoteSheetRow): Record<SupplierQuoteHeader, string> {
  return {
    product_supplier_link_id: row.product_supplier_link_id,
    product_id: row.product_id,
    vendor_id: row.vendor_id,
    supplier_sku: row.supplier_sku ?? '',
    product_name: row.product_name,
    supplier_product_name: row.supplier_product_name,
    supplier_uom: row.supplier_uom ?? '',
    supplier_pack_description: row.supplier_pack_description ?? '',
    inventory_unit: row.inventory_unit ?? '',
    inventory_units_per_supplier_unit: row.inventory_units_per_supplier_unit == null
      ? ''
      : numberToPlainDecimal(row.inventory_units_per_supplier_unit, 'Supplier conversion'),
    comparison_status: row.comparison_status,
    last_cost: row.last_cost ?? '',
    last_effective_date: row.last_effective_date ?? '',
    new_cost: '',
    effective_date: row.effective_date,
    price_kind: row.price_kind,
    price_unit: row.supplier_uom ?? '',
    package_quantity: '1',
  };
}

function styleQuoteSheet(worksheet: Worksheet, rowCount: number): void {
  worksheet.views = [{ state: 'frozen', xSplit: 5, ySplit: 1, showGridLines: false }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rowCount + 1, 1), column: SUPPLIER_QUOTE_HEADERS.length },
  };

  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6B4F' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.protection = { locked: true };
  });

  SUPPLIER_QUOTE_HEADERS.forEach((header, index) => {
    const column = worksheet.getColumn(index + 1);
    column.width = COLUMN_WIDTHS[header];
    column.hidden = header === 'product_supplier_link_id'
      || header === 'product_id'
      || header === 'vendor_id';
    column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber === 1) return;
      const editable = EDITABLE_HEADERS.has(header);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: editable ? 'FFEAF7EF' : 'FFF2F4F3' },
      };
      cell.protection = { locked: !editable };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.numFmt = '@';
    });
  });

  const kindColumn = SUPPLIER_QUOTE_HEADERS.indexOf('price_kind') + 1;
  for (let row = 2; row <= rowCount + 1; row += 1) {
    worksheet.getCell(row, kindColumn).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"list,quote,contract,promo,manual"'],
      showErrorMessage: true,
      errorTitle: 'Invalid price type',
      error: 'Choose list, quote, contract, promo, or manual.',
    };
  }
}

export async function generateSupplierQuoteWorkbook(quote: SupplierQuoteSheet): Promise<Blob> {
  if (quote.format_version !== SUPPLIER_QUOTE_FORMAT_VERSION) {
    throw new SupplierQuoteWorkbookError('This supplier quote format is not supported.');
  }
  if (quote.rows.length > MAX_SUPPLIER_QUOTE_ROWS) {
    throw new SupplierQuoteWorkbookError(`Supplier quote sheets are limited to ${MAX_SUPPLIER_QUOTE_ROWS} rows.`);
  }

  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CRX Manager';
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet(SUPPLIER_QUOTE_SHEET);
  worksheet.addRow([...SUPPLIER_QUOTE_HEADERS]);
  for (const quoteRow of quote.rows) {
    const row = quoteWorkbookRow(quoteRow);
    worksheet.addRow(SUPPLIER_QUOTE_HEADERS.map((header) => row[header]));
  }
  styleQuoteSheet(worksheet, quote.rows.length);
  await worksheet.protect('crx-supplier-phase1b-layout', {
    spinCount: 1_000,
    selectLockedCells: false,
    selectUnlockedCells: true,
    autoFilter: true,
    sort: true,
  });

  const manifest = workbook.addWorksheet(SUPPLIER_QUOTE_MANIFEST_SHEET, { state: 'veryHidden' });
  manifest.addRows([
    ['format_version', SUPPLIER_QUOTE_FORMAT_VERSION],
    ['vendor_id', quote.vendor_id],
    ['vendor_name', quote.vendor_name],
    ['generated_at', quote.generated_at],
    ['row_count', String(quote.rows.length)],
  ]);
  manifest.getColumn(1).numFmt = '@';
  manifest.getColumn(2).numFmt = '@';
  await manifest.protect('crx-supplier-phase1b-layout', { spinCount: 1_000 });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer as unknown as ArrayBuffer)], { type: SUPPLIER_QUOTE_MIME });
}

function readManifest(worksheet: Worksheet): Record<(typeof MANIFEST_KEYS)[number], string> {
  const entries = new Map<string, string>();
  for (let rowNumber = 1; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const keyCell = worksheet.getCell(rowNumber, 1);
    const valueCell = worksheet.getCell(rowNumber, 2);
    if (isFormulaValue(keyCell.value) || isFormulaValue(valueCell.value)) {
      throw new SupplierQuoteWorkbookError('The supplier quote manifest cannot contain formulas.');
    }
    const key = cellValueToText(keyCell.value, `Manifest row ${rowNumber} key`);
    const value = cellValueToText(valueCell.value, `Manifest row ${rowNumber} value`);
    if (!key) continue;
    if (entries.has(key)) {
      throw new SupplierQuoteWorkbookError(`The supplier quote manifest contains duplicate key ${key}.`);
    }
    entries.set(key, value);
  }
  if (entries.size !== MANIFEST_KEYS.length || MANIFEST_KEYS.some((key) => !entries.has(key))) {
    throw new SupplierQuoteWorkbookError('The supplier quote manifest is missing or has unexpected fields.');
  }
  if (entries.get('format_version') !== SUPPLIER_QUOTE_FORMAT_VERSION) {
    throw new SupplierQuoteWorkbookError('This supplier quote workbook format is not supported.');
  }
  return Object.fromEntries(entries) as Record<(typeof MANIFEST_KEYS)[number], string>;
}

function validateHeaders(worksheet: Worksheet): void {
  const headerRow = worksheet.getRow(1);
  const headers = Array.from({ length: headerRow.cellCount }, (_, index) => {
    const cell = headerRow.getCell(index + 1);
    if (isFormulaValue(cell.value)) {
      throw new SupplierQuoteWorkbookError('Supplier quote headers cannot contain formulas.');
    }
    return cellValueToText(cell.value, `Header column ${index + 1}`);
  });
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) {
    throw new SupplierQuoteWorkbookError('The Supplier Quote sheet contains duplicate headers.');
  }
  if (headers.length !== SUPPLIER_QUOTE_HEADERS.length
      || SUPPLIER_QUOTE_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new SupplierQuoteWorkbookError('The Supplier Quote sheet headers do not match the CRX template.');
  }
}

function parseQuoteRow(worksheet: Worksheet, rowNumber: number): {
  linkId: string;
  vendorId: string;
  row: SupplierImportInputRow;
} {
  const values = {} as Record<SupplierQuoteHeader, string>;
  const formulaCells: string[] = [];
  SUPPLIER_QUOTE_HEADERS.forEach((header, index) => {
    const cell = worksheet.getCell(rowNumber, index + 1);
    if (isFormulaValue(cell.value)) formulaCells.push(header);
    values[header] = cellValueToText(cell.value, `Row ${rowNumber}, ${header}`);
  });
  const kind = (values.price_kind || 'quote') as SupplierPriceKind;
  return {
    linkId: values.product_supplier_link_id,
    vendorId: values.vendor_id,
    row: {
      product_supplier_link_id: values.product_supplier_link_id,
      new_cost: normalizeSupplierCostText(values.new_cost),
      effective_date: values.effective_date,
      price_kind: kind,
      price_unit: values.price_unit,
      package_quantity: values.package_quantity || '1',
      has_formula: formulaCells.length > 0,
      formula_cells: formulaCells,
    },
  };
}

export async function parseSupplierQuoteWorkbook(
  arrayBuffer: ArrayBuffer,
): Promise<ParsedSupplierQuoteWorkbook> {
  try {
    await validateXlsxArchiveSafety(arrayBuffer, {
      label: 'Supplier quote workbook',
      maxCompressedBytes: MAX_SUPPLIER_QUOTE_BYTES,
      maxUncompressedBytes: MAX_SUPPLIER_QUOTE_UNCOMPRESSED_BYTES,
    });
  } catch (error) {
    if (error instanceof XlsxArchiveSafetyError) {
      throw new SupplierQuoteWorkbookError(error.message);
    }
    throw error;
  }
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SupplierQuoteWorkbookError(`The uploaded file is not a readable .xlsx workbook: ${message}`);
  }

  const worksheet = workbook.getWorksheet(SUPPLIER_QUOTE_SHEET);
  const manifestWorksheet = workbook.getWorksheet(SUPPLIER_QUOTE_MANIFEST_SHEET);
  if (!worksheet || !manifestWorksheet) {
    throw new SupplierQuoteWorkbookError('This is not a CRX supplier quote sheet. Export a fresh template.');
  }
  validateHeaders(worksheet);
  const manifest = readManifest(manifestWorksheet);
  if (!/^(?:0|[1-9][0-9]*)$/.test(manifest.row_count)) {
    throw new SupplierQuoteWorkbookError('The supplier quote manifest row count is invalid.');
  }
  const rowCount = Number(manifest.row_count);
  if (rowCount > MAX_SUPPLIER_QUOTE_ROWS) {
    throw new SupplierQuoteWorkbookError(`Supplier quote sheets are limited to ${MAX_SUPPLIER_QUOTE_ROWS} rows.`);
  }
  if (worksheet.actualRowCount - 1 !== rowCount) {
    throw new SupplierQuoteWorkbookError('The Supplier Quote row count does not match the CRX manifest.');
  }

  const parsedRows = [] as ReturnType<typeof parseQuoteRow>[];
  const linkIds = new Set<string>();
  for (let rowNumber = 2; rowNumber <= rowCount + 1; rowNumber += 1) {
    const parsed = parseQuoteRow(worksheet, rowNumber);
    if (!parsed.linkId) {
      throw new SupplierQuoteWorkbookError(`Row ${rowNumber} is missing its protected supplier link ID.`);
    }
    if (parsed.vendorId !== manifest.vendor_id) {
      throw new SupplierQuoteWorkbookError(`Row ${rowNumber} does not belong to ${manifest.vendor_name}.`);
    }
    if (linkIds.has(parsed.linkId)) {
      throw new SupplierQuoteWorkbookError(`The workbook contains duplicate supplier link ${parsed.linkId}.`);
    }
    linkIds.add(parsed.linkId);
    parsedRows.push(parsed);
  }

  return {
    formatVersion: manifest.format_version,
    vendorId: manifest.vendor_id,
    vendorName: manifest.vendor_name,
    generatedAt: manifest.generated_at,
    rowCount,
    rows: parsedRows.map(({ row }) => row),
  };
}
