import type { Cell, CellValue, Worksheet } from 'exceljs';
import type {
  PricingWorkbookExport,
  PricingWorkbookExportRow,
  PricingWorksheetPreviewRow,
} from './productPricing';

export const PRICING_WORKBOOK_SHEET = 'Pricing Update';
export const PRICING_WORKBOOK_MANIFEST_SHEET = '_crx_manifest';
export const PRICING_WORKBOOK_FORMAT_VERSION = 'crx-product-pricing-phase1a-v1';
export const MAX_PRICING_WORKBOOK_ROWS = 5_000;
export const MAX_PRICING_WORKBOOK_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_PRICING_WORKBOOK_ZIP_ENTRIES = 2_000;
export const PRICING_WORKBOOK_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const PRICING_WORKBOOK_HEADERS = [
  'product_id',
  'sku',
  'product_name',
  'category',
  'container_size',
  'unit_size',
  'inventory_unit',
  'identity_fingerprint',
  'row_token',
  'row_version',
  'current_cost',
  'current_tier1_margin_percent',
  'current_tier1_price',
  'current_tier2_margin_percent',
  'current_tier2_price',
  'current_tier3_margin_percent',
  'current_tier3_price',
  'pricing_mode',
  'new_cost',
  'tier1_margin_percent',
  'tier1_price',
  'tier2_margin_percent',
  'tier2_price',
  'tier3_margin_percent',
  'tier3_price',
  'change_reason',
] as const;

export type PricingWorkbookHeader = (typeof PRICING_WORKBOOK_HEADERS)[number];

const MANIFEST_KEYS = [
  'format_version',
  'export_id',
  'manifest_fingerprint',
  'expires_at',
  'row_count',
] as const;

const EDITABLE_HEADERS = new Set<PricingWorkbookHeader>([
  'pricing_mode',
  'new_cost',
  'tier1_margin_percent',
  'tier1_price',
  'tier2_margin_percent',
  'tier2_price',
  'tier3_margin_percent',
  'tier3_price',
  'change_reason',
]);

const DOLLAR_HEADERS = new Set<PricingWorkbookHeader>([
  'current_cost',
  'current_tier1_price',
  'current_tier2_price',
  'current_tier3_price',
  'new_cost',
  'tier1_price',
  'tier2_price',
  'tier3_price',
]);

const MARGIN_HEADERS = new Set<PricingWorkbookHeader>([
  'current_tier1_margin_percent',
  'current_tier2_margin_percent',
  'current_tier3_margin_percent',
  'tier1_margin_percent',
  'tier2_margin_percent',
  'tier3_margin_percent',
]);

const COLUMN_WIDTHS: Record<PricingWorkbookHeader, number> = {
  product_id: 38,
  sku: 16,
  product_name: 30,
  category: 18,
  container_size: 16,
  unit_size: 14,
  inventory_unit: 16,
  identity_fingerprint: 34,
  row_token: 34,
  row_version: 13,
  current_cost: 15,
  current_tier1_margin_percent: 23,
  current_tier1_price: 18,
  current_tier2_margin_percent: 23,
  current_tier2_price: 18,
  current_tier3_margin_percent: 23,
  current_tier3_price: 18,
  pricing_mode: 18,
  new_cost: 15,
  tier1_margin_percent: 20,
  tier1_price: 15,
  tier2_margin_percent: 20,
  tier2_price: 15,
  tier3_margin_percent: 20,
  tier3_price: 15,
  change_reason: 32,
};

const HEADER_FILL = 'FF1F6B4F';
const READ_ONLY_FILL = 'FFF2F4F3';
const EDITABLE_FILL = 'FFEAF7EF';
const HEADER_FONT = 'FFFFFFFF';
const TEXT_FONT = 'FF17231E';
const BORDER_COLOR = 'FFD5DED9';

export interface ParsedPricingWorkbook {
  formatVersion: string;
  exportId: string;
  manifestFingerprint: string;
  expiresAt: string;
  rowCount: number;
  rows: PricingWorksheetPreviewRow[];
}

export class PricingWorkbookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingWorkbookFormatError';
  }
}

const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES = 46;
const ZIP_LOCAL_FILE_HEADER_BYTES = 30;
const ZIP_MAX_COMMENT_BYTES = 65_535;

interface PricingWorkbookZipEntry {
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findZipEndOfCentralDirectory(view: DataView): number {
  const firstPossibleOffset = Math.max(
    0,
    view.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  for (
    let offset = view.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= firstPossibleOffset;
    offset -= 1
  ) {
    if (
      view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && offset
        + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES
        + view.getUint16(offset + 20, true) === view.byteLength
    ) {
      return offset;
    }
  }
  return -1;
}

/**
 * Stream one ZIP entry through the platform inflater without retaining its
 * output. This measures the real expanded bytes even when hostile directory
 * metadata lies about the size.
 */
async function measurePricingWorkbookZipEntry(
  arrayBuffer: ArrayBuffer,
  view: DataView,
  entry: PricingWorkbookZipEntry,
  directoryOffset: number,
  expandedBytesBeforeEntry: number,
): Promise<number> {
  if (
    entry.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_BYTES > directoryOffset
    || view.getUint32(entry.localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid local file entry.');
  }

  const localFlags = view.getUint16(entry.localHeaderOffset + 6, true);
  const localCompressionMethod = view.getUint16(entry.localHeaderOffset + 8, true);
  const localFileNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const localExtraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  if (localFlags !== entry.flags || localCompressionMethod !== entry.compressionMethod) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive has inconsistent file metadata.');
  }

  const dataOffset = entry.localHeaderOffset
    + ZIP_LOCAL_FILE_HEADER_BYTES
    + localFileNameLength
    + localExtraLength;
  if (dataOffset > directoryOffset || dataOffset + entry.compressedSize > directoryOffset) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid compressed file range.');
  }

  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid stored file size.');
    }
    if (expandedBytesBeforeEntry + entry.compressedSize > MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES) {
      throw new PricingWorkbookFormatError(
        `Pricing workbooks may expand to at most ${MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES / 1024 / 1024} MB.`,
      );
    }
    return entry.compressedSize;
  }

  if (typeof DecompressionStream !== 'function') {
    throw new PricingWorkbookFormatError('This browser cannot safely inspect compressed pricing workbooks.');
  }

  const compressedBytes = new Uint8Array(arrayBuffer, dataOffset, entry.compressedSize);
  const compressedStream = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(compressedBytes);
      controller.close();
    },
  });
  const reader = compressedStream
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  let actualUncompressedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      actualUncompressedBytes += value.byteLength;
      if (
        expandedBytesBeforeEntry + actualUncompressedBytes
        > MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES
      ) {
        await reader.cancel();
        throw new PricingWorkbookFormatError(
          `Pricing workbooks may expand to at most ${MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES / 1024 / 1024} MB.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof PricingWorkbookFormatError) throw error;
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive contains invalid compressed data.');
  } finally {
    reader.releaseLock();
  }

  if (actualUncompressedBytes !== entry.uncompressedSize) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid expanded file size.');
  }
  return actualUncompressedBytes;
}

/** Validate compressed and actual expanded sizes before ExcelJS loads XML. */
async function validatePricingWorkbookArchive(arrayBuffer: ArrayBuffer): Promise<void> {
  if (arrayBuffer.byteLength > MAX_PRICING_WORKBOOK_FILE_BYTES) {
    throw new PricingWorkbookFormatError(
      `Pricing workbooks must be ${MAX_PRICING_WORKBOOK_FILE_BYTES / 1024 / 1024} MB or smaller.`,
    );
  }
  if (arrayBuffer.byteLength < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw new PricingWorkbookFormatError('The uploaded file is not a readable .xlsx workbook.');
  }

  const view = new DataView(arrayBuffer);
  const endOffset = findZipEndOfCentralDirectory(view);
  if (endOffset < 0) {
    throw new PricingWorkbookFormatError('The uploaded file is not a readable .xlsx workbook.');
  }

  const commentLength = view.getUint16(endOffset + 20, true);
  if (endOffset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + commentLength !== view.byteLength) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid directory.');
  }

  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);

  if (
    diskNumber !== 0
    || directoryDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || directorySize === 0xffffffff
    || directoryOffset === 0xffffffff
  ) {
    throw new PricingWorkbookFormatError('Multi-part and ZIP64 pricing workbooks are not supported.');
  }
  if (entryCount > MAX_PRICING_WORKBOOK_ZIP_ENTRIES) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive contains too many files.');
  }

  const directoryEnd = directoryOffset + directorySize;
  if (directoryOffset > endOffset || directoryEnd > endOffset) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid directory.');
  }

  let offset = directoryOffset;
  let totalUncompressedBytes = 0;
  const entries: PricingWorkbookZipEntry[] = [];
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (
      offset + ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES > directoryEnd
      || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE
    ) {
      throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid file entry.');
    }

    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    if ((flags & 0x0001) !== 0) {
      throw new PricingWorkbookFormatError('Encrypted pricing workbooks are not supported.');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new PricingWorkbookFormatError('The uploaded .xlsx archive uses unsupported compression.');
    }
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) {
      throw new PricingWorkbookFormatError('ZIP64 pricing workbooks are not supported.');
    }
    if (compressedSize === 0 && uncompressedSize > 0) {
      throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid file size.');
    }

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES) {
      throw new PricingWorkbookFormatError(
        `Pricing workbooks may expand to at most ${MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES / 1024 / 1024} MB.`,
      );
    }

    entries.push({
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset += ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES
      + fileNameLength
      + extraLength
      + entryCommentLength;
  }

  if (offset !== directoryEnd) {
    throw new PricingWorkbookFormatError('The uploaded .xlsx archive has an invalid directory size.');
  }

  let actualExpandedBytes = 0;
  for (const entry of entries) {
    actualExpandedBytes += await measurePricingWorkbookZipEntry(
      arrayBuffer,
      view,
      entry,
      directoryOffset,
      actualExpandedBytes,
    );
  }
}

async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const imported = await import('exceljs') as unknown as {
    default?: typeof import('exceljs');
  } & Partial<typeof import('exceljs')>;
  // Vite exposes the CommonJS package members on the namespace, while native
  // Node ESM exposes them under `default`. Normalize both so the same workbook
  // code is exercised by the browser and the real PostgreSQL proof runner.
  return (imported.default ?? imported) as typeof import('exceljs');
}

function workbookRow(exportRow: PricingWorkbookExportRow): Record<PricingWorkbookHeader, string | number> {
  return {
    product_id: exportRow.product_id,
    sku: exportRow.sku ?? '',
    product_name: exportRow.product_name,
    category: exportRow.category ?? '',
    container_size: exportRow.container_size ?? '',
    unit_size: exportRow.unit_size ?? '',
    inventory_unit: exportRow.inventory_unit ?? '',
    identity_fingerprint: exportRow.identity_fingerprint,
    row_token: exportRow.row_token,
    row_version: String(exportRow.row_version),
    current_cost: exportRow.current_cost ?? '',
    current_tier1_margin_percent: exportRow.current_tier1_margin_percent ?? '',
    current_tier1_price: exportRow.current_tier1_price ?? '',
    current_tier2_margin_percent: exportRow.current_tier2_margin_percent ?? '',
    current_tier2_price: exportRow.current_tier2_price ?? '',
    current_tier3_margin_percent: exportRow.current_tier3_margin_percent ?? '',
    current_tier3_price: exportRow.current_tier3_price ?? '',
    pricing_mode: '',
    new_cost: exportRow.current_cost ?? '',
    tier1_margin_percent: exportRow.current_tier1_margin_percent ?? '',
    tier1_price: exportRow.current_tier1_price ?? '',
    tier2_margin_percent: exportRow.current_tier2_margin_percent ?? '',
    tier2_price: exportRow.current_tier2_price ?? '',
    tier3_margin_percent: exportRow.current_tier3_margin_percent ?? '',
    tier3_price: exportRow.current_tier3_price ?? '',
    change_reason: '',
  };
}

function stylePricingWorksheet(worksheet: Worksheet, rowCount: number): void {
  worksheet.views = [{
    state: 'frozen',
    xSplit: 3,
    ySplit: 1,
    showGridLines: false,
  }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rowCount + 1, 1), column: PRICING_WORKBOOK_HEADERS.length },
  };

  const headerRow = worksheet.getRow(1);
  headerRow.height = 34;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: HEADER_FILL } } };
    cell.protection = { locked: true };
  });

  PRICING_WORKBOOK_HEADERS.forEach((header, index) => {
    const column = worksheet.getColumn(index + 1);
    column.width = COLUMN_WIDTHS[header];
    column.hidden = header === 'identity_fingerprint' || header === 'row_token';
    column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber === 1) return;
      const editable = EDITABLE_HEADERS.has(header);
      cell.font = { color: { argb: TEXT_FONT }, size: 10 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: editable ? EDITABLE_FILL : READ_ONLY_FILL },
      };
      cell.border = { bottom: { style: 'hair', color: { argb: BORDER_COLOR } } };
      cell.alignment = {
        vertical: 'middle',
        horizontal: DOLLAR_HEADERS.has(header) || MARGIN_HEADERS.has(header) ? 'right' : 'left',
        wrapText: header === 'product_name' || header === 'change_reason',
      };
      cell.protection = { locked: !editable };
      if (header === 'product_id' || header === 'sku' || header === 'identity_fingerprint'
          || header === 'row_token' || header === 'row_version'
          || DOLLAR_HEADERS.has(header) || MARGIN_HEADERS.has(header)) {
        cell.numFmt = '@';
      }
    });
  });

  const pricingModeColumn = PRICING_WORKBOOK_HEADERS.indexOf('pricing_mode') + 1;
  for (let row = 2; row <= rowCount + 1; row += 1) {
    worksheet.getCell(row, pricingModeColumn).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"margin_driven,price_driven"'],
      showInputMessage: true,
      promptTitle: 'Pricing mode',
      prompt: 'Leave blank for no change, or choose margin_driven or price_driven.',
      showErrorMessage: true,
      errorTitle: 'Invalid pricing mode',
      error: 'Choose margin_driven, price_driven, or leave the cell blank.',
    };
  }
}

export async function generateProductPricingWorkbook(
  pricingExport: PricingWorkbookExport,
): Promise<Blob> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CRX Manager';
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet(PRICING_WORKBOOK_SHEET);
  worksheet.addRow([...PRICING_WORKBOOK_HEADERS]);
  for (const exportRow of pricingExport.rows) {
    const row = workbookRow(exportRow);
    worksheet.addRow(PRICING_WORKBOOK_HEADERS.map((header) => row[header]));
  }
  stylePricingWorksheet(worksheet, pricingExport.rows.length);
  // This is a usability guard only. The preview RPC revalidates every protected
  // value against its retained server manifest; Excel protection is not security.
  await worksheet.protect('crx-phase1a-layout', {
    spinCount: 1_000,
    selectLockedCells: false,
    selectUnlockedCells: true,
    autoFilter: true,
    sort: true,
  });

  const manifest = workbook.addWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET, {
    state: 'veryHidden',
  });
  manifest.addRows([
    ['format_version', PRICING_WORKBOOK_FORMAT_VERSION],
    ['export_id', pricingExport.export_id],
    ['manifest_fingerprint', pricingExport.manifest_fingerprint],
    ['expires_at', pricingExport.expires_at],
    ['row_count', String(pricingExport.rows.length)],
  ]);
  manifest.getColumn(1).width = 24;
  manifest.getColumn(2).width = 72;
  manifest.getColumn(1).numFmt = '@';
  manifest.getColumn(2).numFmt = '@';
  await manifest.protect('crx-phase1a-layout', { spinCount: 1_000 });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(buffer as unknown as ArrayBuffer)], {
    type: PRICING_WORKBOOK_MIME,
  });
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
    throw new PricingWorkbookFormatError(`${context} contains a non-finite number.`);
  }
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;

  const match = raw.match(/^(-?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) {
    throw new PricingWorkbookFormatError(`${context} contains an unsupported number.`);
  }
  const [, sign, integer, fraction = '', exponentText] = match;
  const exponent = Number(exponentText);
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function cellValueToText(value: CellValue, context: string): string {
  const resolved = formulaResult(value);
  if (resolved == null) return '';
  if (typeof resolved === 'string') return resolved;
  if (typeof resolved === 'number') return numberToPlainDecimal(resolved, context);
  if (typeof resolved === 'boolean') return String(resolved);
  if (resolved instanceof Date) {
    throw new PricingWorkbookFormatError(`${context} contains a date instead of text or a decimal.`);
  }
  if ('richText' in resolved) return resolved.richText.map((part) => part.text).join('');
  if ('hyperlink' in resolved) return resolved.text;
  if ('error' in resolved) {
    throw new PricingWorkbookFormatError(`${context} contains the Excel error ${resolved.error}.`);
  }
  throw new PricingWorkbookFormatError(`${context} contains an unsupported cell value.`);
}

function readManifest(manifest: Worksheet): Record<(typeof MANIFEST_KEYS)[number], string> {
  const entries = new Map<string, string>();
  for (let rowNumber = 1; rowNumber <= manifest.actualRowCount; rowNumber += 1) {
    const keyCell = manifest.getCell(rowNumber, 1);
    const valueCell = manifest.getCell(rowNumber, 2);
    if (isFormulaValue(keyCell.value) || isFormulaValue(valueCell.value)) {
      throw new PricingWorkbookFormatError('The workbook manifest cannot contain formulas.');
    }
    const key = cellValueToText(keyCell.value, `Manifest row ${rowNumber} key`);
    const value = cellValueToText(valueCell.value, `Manifest row ${rowNumber} value`);
    if (!key) continue;
    if (entries.has(key)) {
      throw new PricingWorkbookFormatError(`The workbook manifest contains duplicate key ${key}.`);
    }
    entries.set(key, value);
  }

  if (entries.size !== MANIFEST_KEYS.length
      || MANIFEST_KEYS.some((key) => !entries.has(key))) {
    throw new PricingWorkbookFormatError('The workbook manifest is missing or has unexpected fields.');
  }
  if (entries.get('format_version') !== PRICING_WORKBOOK_FORMAT_VERSION) {
    throw new PricingWorkbookFormatError('This pricing workbook format is not supported.');
  }
  for (const key of MANIFEST_KEYS) {
    if (!entries.get(key)) {
      throw new PricingWorkbookFormatError(`The workbook manifest field ${key} is blank.`);
    }
  }

  return Object.fromEntries(entries) as Record<(typeof MANIFEST_KEYS)[number], string>;
}

function validateHeaders(worksheet: Worksheet): void {
  const headerRow = worksheet.getRow(1);
  const headers = Array.from(
    { length: headerRow.cellCount },
    (_, index) => {
      const cell = headerRow.getCell(index + 1);
      if (isFormulaValue(cell.value)) {
        throw new PricingWorkbookFormatError('Pricing workbook headers cannot contain formulas.');
      }
      return cellValueToText(cell.value, `Header column ${index + 1}`);
    },
  );
  const nonBlankHeaders = headers.filter(Boolean);
  if (new Set(nonBlankHeaders).size !== nonBlankHeaders.length) {
    throw new PricingWorkbookFormatError('The Pricing Update sheet contains duplicate headers.');
  }
  if (headers.length !== PRICING_WORKBOOK_HEADERS.length
      || PRICING_WORKBOOK_HEADERS.some((header, index) => headers[index] !== header)) {
    throw new PricingWorkbookFormatError('The Pricing Update sheet headers do not match the CRX template.');
  }
}

function parsePricingRow(worksheet: Worksheet, rowNumber: number): PricingWorksheetPreviewRow {
  const values = {} as Record<PricingWorkbookHeader, string>;
  const formulaCells: string[] = [];
  PRICING_WORKBOOK_HEADERS.forEach((header, index) => {
    const cell: Cell = worksheet.getCell(rowNumber, index + 1);
    if (isFormulaValue(cell.value)) formulaCells.push(header);
    const text = cellValueToText(cell.value, `Row ${rowNumber}, ${header}`);
    const dollarMatch = DOLLAR_HEADERS.has(header) ? text.match(/^(\d+)(?:\.(\d{1,2}))?$/) : null;
    values[header] = dollarMatch
      ? `${dollarMatch[1]}.${(dollarMatch[2] ?? '').padEnd(2, '0')}`
      : text;
  });

  return {
    ...values,
    pricing_mode: values.pricing_mode as PricingWorksheetPreviewRow['pricing_mode'],
    has_formula: formulaCells.length > 0,
    formula_cells: formulaCells,
  };
}

export async function parseProductPricingWorkbook(
  arrayBuffer: ArrayBuffer,
): Promise<ParsedPricingWorkbook> {
  await validatePricingWorkbookArchive(arrayBuffer);
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(arrayBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PricingWorkbookFormatError(`The uploaded file is not a readable .xlsx workbook: ${message}`);
  }

  const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET);
  if (!worksheet) {
    throw new PricingWorkbookFormatError(`Missing required worksheet ${PRICING_WORKBOOK_SHEET}.`);
  }
  const manifestWorksheet = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET);
  if (!manifestWorksheet) {
    throw new PricingWorkbookFormatError('Missing CRX workbook manifest. Export a fresh pricing workbook.');
  }

  validateHeaders(worksheet);
  const manifest = readManifest(manifestWorksheet);
  if (!/^(?:0|[1-9][0-9]*)$/.test(manifest.row_count)) {
    throw new PricingWorkbookFormatError('The workbook manifest row count is invalid.');
  }
  const rowCount = Number(manifest.row_count);
  if (rowCount > MAX_PRICING_WORKBOOK_ROWS) {
    throw new PricingWorkbookFormatError(`Pricing workbooks are limited to ${MAX_PRICING_WORKBOOK_ROWS} rows.`);
  }
  if (worksheet.actualRowCount - 1 !== rowCount) {
    throw new PricingWorkbookFormatError('The Pricing Update row count does not match the CRX manifest.');
  }
  const rows: PricingWorksheetPreviewRow[] = [];
  for (let rowNumber = 2; rowNumber <= rowCount + 1; rowNumber += 1) {
    rows.push(parsePricingRow(worksheet, rowNumber));
  }

  return {
    formatVersion: manifest.format_version,
    exportId: manifest.export_id,
    manifestFingerprint: manifest.manifest_fingerprint,
    expiresAt: manifest.expires_at,
    rowCount,
    rows,
  };
}
