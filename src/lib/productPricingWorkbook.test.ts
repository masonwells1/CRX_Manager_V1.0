import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import type { Workbook } from 'exceljs';
import type { PricingWorkbookExport } from './productPricing';
import {
  generateProductPricingWorkbook,
  MAX_PRICING_WORKBOOK_FILE_BYTES,
  MAX_PRICING_WORKBOOK_ROWS,
  MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES,
  parseProductPricingWorkbook,
  PRICING_WORKBOOK_FORMAT_VERSION,
  PRICING_WORKBOOK_HEADERS,
  PRICING_WORKBOOK_MANIFEST_SHEET,
  PRICING_WORKBOOK_SHEET,
  PricingWorkbookFormatError,
} from './productPricingWorkbook';

const pricingExport: PricingWorkbookExport = {
  export_id: '11111111-1111-4111-8111-111111111111',
  format_version: PRICING_WORKBOOK_FORMAT_VERSION,
  manifest_fingerprint: 'manifest-fingerprint',
  expires_at: '2026-07-17T21:00:00+00:00',
  rows: [
    {
      product_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sku: '000123',
      product_name: 'Leading Zero Herbicide',
      category: 'Herbicide',
      container_size: '2.5',
      unit_size: 'gal',
      inventory_unit: 'gallon',
      identity_fingerprint: 'identity-a',
      row_token: 'token-a',
      row_version: 7,
      current_cost: '125.40',
      current_tier1_margin_percent: '20',
      current_tier1_price: '156.75',
      current_tier2_margin_percent: '15.5',
      current_tier2_price: '148.40',
      current_tier3_margin_percent: '10.125',
      current_tier3_price: '139.53',
      suggested_rate: '12-16 oz',
      rate_per_acre: '16',
      rate_unit: 'oz',
      use_timing: 'Post-emergence',
      internal_notes: 'Warehouse note',
      quoting_notes: 'Sales guidance',
    },
    {
      product_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sku: null,
      product_name: 'Exact Decimal Product',
      category: null,
      container_size: null,
      unit_size: null,
      inventory_unit: null,
      identity_fingerprint: 'identity-b',
      row_token: 'token-b',
      row_version: 2,
      current_cost: '0.07',
      current_tier1_margin_percent: '12.3456789',
      current_tier1_price: '0.08',
      current_tier2_margin_percent: '0',
      current_tier2_price: '0.07',
      current_tier3_margin_percent: null,
      current_tier3_price: null,
      suggested_rate: null,
      rate_per_acre: null,
      rate_unit: null,
      use_timing: null,
      internal_notes: null,
      quoting_notes: null,
    },
  ],
};

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

async function loadGeneratedWorkbook(): Promise<{ workbook: Workbook; buffer: ArrayBuffer }> {
  const ExcelJS = await import('exceljs');
  const blob = await generateProductPricingWorkbook(pricingExport);
  const buffer = await blobToArrayBuffer(blob);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return { workbook, buffer };
}

async function writeWorkbook(workbook: Workbook): Promise<ArrayBuffer> {
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as unknown as ArrayBuffer).buffer;
}

function withFirstZipEntryUncompressedSize(buffer: ArrayBuffer, size: number): ArrayBuffer {
  const copy = buffer.slice(0);
  const view = new DataView(copy);
  for (let offset = 0; offset <= view.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, size, true);
      return copy;
    }
  }
  throw new Error('Generated workbook had no ZIP central-directory entry');
}

function createZipWithForgedSmallExpandedSize(actualSize: number): ArrayBuffer {
  const fileName = new TextEncoder().encode('bomb.bin');
  const compressed = deflateRawSync(new Uint8Array(actualSize));
  const declaredUncompressedSize = 1;
  const localHeaderSize = 30 + fileName.byteLength;
  const directoryOffset = localHeaderSize + compressed.byteLength;
  const directorySize = 46 + fileName.byteLength;
  const endOffset = directoryOffset + directorySize;
  const archive = new Uint8Array(endOffset + 22);
  const view = new DataView(archive.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint32(18, compressed.byteLength, true);
  view.setUint32(22, declaredUncompressedSize, true);
  view.setUint16(26, fileName.byteLength, true);
  archive.set(fileName, 30);
  archive.set(compressed, localHeaderSize);

  view.setUint32(directoryOffset, 0x02014b50, true);
  view.setUint16(directoryOffset + 4, 20, true);
  view.setUint16(directoryOffset + 6, 20, true);
  view.setUint16(directoryOffset + 10, 8, true);
  view.setUint32(directoryOffset + 20, compressed.byteLength, true);
  view.setUint32(directoryOffset + 24, declaredUncompressedSize, true);
  view.setUint16(directoryOffset + 28, fileName.byteLength, true);
  archive.set(fileName, directoryOffset + 46);

  view.setUint32(endOffset, 0x06054b50, true);
  view.setUint16(endOffset + 8, 1, true);
  view.setUint16(endOffset + 10, 1, true);
  view.setUint32(endOffset + 12, directorySize, true);
  view.setUint32(endOffset + 16, directoryOffset, true);
  return archive.buffer;
}

describe('product pricing workbook', () => {
  it('round-trips exact server strings and preserves leading-zero SKUs', async () => {
    const { buffer } = await loadGeneratedWorkbook();

    const parsed = await parseProductPricingWorkbook(buffer);

    expect(parsed).toMatchObject({
      formatVersion: PRICING_WORKBOOK_FORMAT_VERSION,
      exportId: pricingExport.export_id,
      manifestFingerprint: pricingExport.manifest_fingerprint,
      expiresAt: pricingExport.expires_at,
      rowCount: 2,
    });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      product_id: pricingExport.rows[0].product_id,
      sku: '000123',
      row_version: '7',
      current_cost: '125.40',
      current_tier1_margin_percent: '20',
      current_tier2_margin_percent: '15.5',
      current_tier3_margin_percent: '10.125',
      pricing_mode: '',
      new_cost: '125.40',
      tier1_margin_percent: '20',
      tier1_price: '156.75',
      suggested_rate: '12-16 oz',
      rate_per_acre: '16',
      rate_unit: 'oz',
      use_timing: 'Post-emergence',
      internal_notes: 'Warehouse note',
      quoting_notes: 'Sales guidance',
      has_formula: false,
      formula_cells: [],
    });
  });

  it('creates the exact sheets, a veryHidden manifest, hidden row tokens, and blank mode validation', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    const identityColumn = PRICING_WORKBOOK_HEADERS.indexOf('identity_fingerprint') + 1;
    const tokenColumn = PRICING_WORKBOOK_HEADERS.indexOf('row_token') + 1;
    const modeColumn = PRICING_WORKBOOK_HEADERS.indexOf('pricing_mode') + 1;
    const currentCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('current_cost') + 1;
    const quotingNotesColumn = PRICING_WORKBOOK_HEADERS.indexOf('quoting_notes') + 1;
    const ratePerAcreColumn = PRICING_WORKBOOK_HEADERS.indexOf('rate_per_acre') + 1;

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      PRICING_WORKBOOK_SHEET,
      PRICING_WORKBOOK_MANIFEST_SHEET,
    ]);
    expect(manifest.state).toBe('veryHidden');
    expect(worksheet.getColumn(identityColumn).hidden).toBe(true);
    expect(worksheet.getColumn(tokenColumn).hidden).toBe(true);
    expect(worksheet.getCell(2, modeColumn).value).toBe('');
    expect(worksheet.getCell(2, currentCostColumn).value).toBe('125.40');
    expect(worksheet.getCell(2, currentCostColumn).numFmt).toBe('@');
    expect(worksheet.getCell(2, quotingNotesColumn).value).toBe('Sales guidance');
    expect(worksheet.getCell(2, quotingNotesColumn).protection.locked).toBe(false);
    expect(worksheet.getCell(2, ratePerAcreColumn).numFmt).toBe('@');
    expect(manifest.getCell(5, 2).value).toBe('2');
    expect(worksheet.getCell(2, modeColumn).dataValidation).toMatchObject({
      type: 'list',
      allowBlank: true,
      formulae: ['"margin_driven,price_driven"'],
    });
  });

  it('emits formula flags per row so the server can reject the row', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const newCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('new_cost') + 1;
    worksheet.getCell(2, newCostColumn).value = { formula: '100+25.4', result: 125.4 };

    const parsed = await parseProductPricingWorkbook(await writeWorkbook(workbook));

    expect(parsed.rows[0].has_formula).toBe(true);
    expect(parsed.rows[0].formula_cells).toEqual(['new_cost']);
    expect(parsed.rows[0].new_cost).toBe('125.40');
  });

  it('serializes numeric cells as plain decimal strings without cents or ratio conversion', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const newCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('new_cost') + 1;
    const marginColumn = PRICING_WORKBOOK_HEADERS.indexOf('tier1_margin_percent') + 1;
    worksheet.getCell(2, newCostColumn).value = 0.0000001;
    worksheet.getCell(2, marginColumn).value = 19.75;

    const parsed = await parseProductPricingWorkbook(await writeWorkbook(workbook));

    expect(parsed.rows[0].new_cost).toBe('0.0000001');
    expect(parsed.rows[0].tier1_margin_percent).toBe('19.75');
    expect(Object.keys(parsed.rows[0]).some((key) => key.endsWith('_cents'))).toBe(false);
    expect(parsed.rows[0]).not.toHaveProperty('tier1_margin', 0.1975);
  });

  it('keeps exported cents exact beyond JavaScript safe-integer precision', async () => {
    const exactValue = '90071992547409.93';
    const exactExport: PricingWorkbookExport = {
      ...pricingExport,
      rows: [{
        ...pricingExport.rows[0],
        current_cost: exactValue,
        current_tier1_price: exactValue,
      }],
    };
    const ExcelJS = await import('exceljs');
    const blob = await generateProductPricingWorkbook(exactExport);
    const buffer = await blobToArrayBuffer(blob);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    const currentCostColumn = PRICING_WORKBOOK_HEADERS.indexOf('current_cost') + 1;

    expect(worksheet.getCell(2, currentCostColumn).value).toBe(exactValue);
    const parsed = await parseProductPricingWorkbook(buffer);
    expect(parsed.rows[0].current_cost).toBe(exactValue);
    expect(parsed.rows[0].new_cost).toBe(exactValue);
    expect(parsed.rows[0].tier1_price).toBe(exactValue);
  });

  it('accepts the zero-row workbook emitted by the generator', async () => {
    const blob = await generateProductPricingWorkbook({ ...pricingExport, rows: [] });
    const parsed = await parseProductPricingWorkbook(await blobToArrayBuffer(blob));

    expect(parsed.rowCount).toBe(0);
    expect(parsed.rows).toEqual([]);
  });

  it('rejects duplicate headers before sending workbook rows to the server', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const worksheet = workbook.getWorksheet(PRICING_WORKBOOK_SHEET)!;
    worksheet.getCell(1, 2).value = 'product_id';

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('duplicate headers');
  });

  it('rejects a workbook with no CRX manifest', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    workbook.removeWorksheet(manifest.id);

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow(PricingWorkbookFormatError);
    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('Missing CRX workbook manifest');
  });

  it('rejects an expired v1 workbook format and requires a fresh v2 export', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    manifest.getCell(1, 2).value = 'crx-product-pricing-phase1a-v1';

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow('not supported');
  });

  it('rejects a manifest that could make the browser parse an excessive row count', async () => {
    const { workbook } = await loadGeneratedWorkbook();
    const manifest = workbook.getWorksheet(PRICING_WORKBOOK_MANIFEST_SHEET)!;
    manifest.getCell(5, 2).value = String(MAX_PRICING_WORKBOOK_ROWS + 1);

    await expect(parseProductPricingWorkbook(await writeWorkbook(workbook)))
      .rejects.toThrow(`limited to ${MAX_PRICING_WORKBOOK_ROWS} rows`);
  });

  it('rejects an oversized upload before ExcelJS parses it', async () => {
    await expect(parseProductPricingWorkbook(new ArrayBuffer(MAX_PRICING_WORKBOOK_FILE_BYTES + 1)))
      .rejects.toThrow('10 MB or smaller');
  });

  it('rejects an archive whose declared expanded size exceeds the browser safety limit', async () => {
    const { buffer } = await loadGeneratedWorkbook();
    const oversizedArchive = withFirstZipEntryUncompressedSize(
      buffer,
      MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES + 1,
    );

    await expect(parseProductPricingWorkbook(oversizedArchive))
      .rejects.toThrow('expand to at most 25 MB');
  });

  it('bounds actual decompression when a hostile ZIP lies about its expanded size', async () => {
    const forgedArchive = createZipWithForgedSmallExpandedSize(
      MAX_PRICING_WORKBOOK_UNCOMPRESSED_BYTES + 1,
    );

    await expect(parseProductPricingWorkbook(forgedArchive))
      .rejects.toThrow('expand to at most 25 MB');
  }, 15_000);
});
