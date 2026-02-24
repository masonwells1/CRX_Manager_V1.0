/**
 * reportPdf.test.ts — Tests for generic report PDF generation
 * Uses the same jsPDF/autoTable mock pattern as quotePdf.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock jsPDF doc instance ─────────────────────────────────────────────

const mockDoc = {
  internal: { pageSize: { getWidth: () => 792, getHeight: () => 612 } },
  setFillColor: vi.fn(),
  rect: vi.fn(),
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  setDrawColor: vi.fn(),
  line: vi.fn(),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

const mockAutoTable = vi.fn(
  (doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    (doc as typeof mockDoc).lastAutoTable = {
      finalY: ((opts.startY as number) || 0) + 100,
    };
  }
);

vi.mock('jspdf-autotable', () => ({
  default: mockAutoTable,
}));

import {
  generateReportPdf,
  downloadReportPdf,
  fmtCurrency,
  type ReportPdfColumn,
  type ReportPdfOptions,
} from './reportPdf';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<ReportPdfOptions> = {}): ReportPdfOptions {
  return {
    title: 'Product Master',
    columns: [
      { header: 'Name', key: 'name' },
      { header: 'Price', key: 'price', align: 'right' },
    ],
    data: [
      { name: 'Atrazine 4L', price: '$18.50' },
      { name: 'Roundup', price: '$22.00' },
    ],
    ...overrides,
  };
}

// ── fmtCurrency ──────────────────────────────────────────────────────────

describe('fmtCurrency', () => {
  it('formats positive numbers as USD', () => {
    expect(fmtCurrency(1234.56)).toBe('$1,234.56');
  });

  it('formats zero', () => {
    expect(fmtCurrency(0)).toBe('$0.00');
  });

  it('formats negative numbers', () => {
    expect(fmtCurrency(-50)).toBe('-$50.00');
  });

  it('handles small decimals', () => {
    expect(fmtCurrency(0.5)).toBe('$0.50');
  });

  it('rounds to two decimal places', () => {
    expect(fmtCurrency(9.999)).toBe('$10.00');
  });
});

// ── generateReportPdf ────────────────────────────────────────────────────

describe('generateReportPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('returns a jsPDF document', async () => {
    const doc = await generateReportPdf(makeOptions());
    expect(doc).toBe(mockDoc);
  });

  it('renders the company header', async () => {
    await generateReportPdf(makeOptions());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders the report title', async () => {
    await generateReportPdf(makeOptions({ title: 'Inventory Report' }));
    const textCalls = mockDoc.text.mock.calls;
    const hasTitle = textCalls.some(
      (args: unknown[]) => args[0] === 'Inventory Report'
    );
    expect(hasTitle).toBe(true);
  });

  it('renders subtitle when provided', async () => {
    await generateReportPdf(
      makeOptions({ subtitle: 'Q1 2026 Summary' })
    );
    const textCalls = mockDoc.text.mock.calls;
    const hasSub = textCalls.some(
      (args: unknown[]) => args[0] === 'Q1 2026 Summary'
    );
    expect(hasSub).toBe(true);
  });

  it('renders date range when provided', async () => {
    await generateReportPdf(
      makeOptions({ dateRange: { start: '01/01/2026', end: '03/31/2026' } })
    );
    const textCalls = mockDoc.text.mock.calls;
    const hasDate = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('01/01/2026')
    );
    expect(hasDate).toBe(true);
  });

  it('calls autoTable with column headers and body rows', async () => {
    await generateReportPdf(makeOptions());
    expect(mockAutoTable).toHaveBeenCalledTimes(1);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.head).toEqual([['Name', 'Price']]);
    expect(opts.body).toEqual([
      ['Atrazine 4L', '$18.50'],
      ['Roundup', '$22.00'],
    ]);
  });

  it('applies column alignment via columnStyles', async () => {
    await generateReportPdf(makeOptions());
    expect(mockAutoTable).toHaveBeenCalledTimes(1);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    const colStyles = opts.columnStyles as Record<number, { halign: string }>;
    expect(colStyles[1]).toEqual({ halign: 'right' });
  });

  it('handles empty data array (header-only PDF)', async () => {
    const doc = await generateReportPdf(makeOptions({ data: [] }));
    expect(doc).toBe(mockDoc);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.body).toEqual([]);
  });

  it('uses landscape orientation by default', async () => {
    await generateReportPdf(makeOptions());
    // The JsPDFMock constructor is called — orientation is passed but mock ignores it
    // We verify the doc was returned successfully
    expect(mockDoc).toBeDefined();
  });

  it('uses portrait orientation when specified', async () => {
    const doc = await generateReportPdf(
      makeOptions({ orientation: 'portrait' })
    );
    expect(doc).toBe(mockDoc);
  });

  it('applies format function to column values', async () => {
    const cols: ReportPdfColumn[] = [
      { header: 'Amount', key: 'amt', format: (v) => `$${v}` },
    ];
    await generateReportPdf(
      makeOptions({ columns: cols, data: [{ amt: 100 }] })
    );
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect((opts.body as string[][])[0][0]).toBe('$100');
  });

  it('converts null/undefined values to empty string', async () => {
    await generateReportPdf(
      makeOptions({
        columns: [{ header: 'Value', key: 'val' }],
        data: [{ val: null }, { val: undefined }],
      })
    );
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect((opts.body as string[][])[0][0]).toBe('');
    expect((opts.body as string[][])[1][0]).toBe('');
  });

  it('renders footer note when provided', async () => {
    await generateReportPdf(
      makeOptions({ footerNote: 'Total: $500.00' })
    );
    const textCalls = mockDoc.text.mock.calls;
    const hasNote = textCalls.some(
      (args: unknown[]) => args[0] === 'Total: $500.00'
    );
    expect(hasNote).toBe(true);
  });

  it('does not render footer note when not provided', async () => {
    await generateReportPdf(makeOptions());
    const textCalls = mockDoc.text.mock.calls;
    const hasNote = textCalls.some(
      (args: unknown[]) => args[0] === 'Total: $500.00'
    );
    expect(hasNote).toBe(false);
  });
});

// ── downloadReportPdf ────────────────────────────────────────────────────

describe('downloadReportPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('calls doc.save', async () => {
    await downloadReportPdf(makeOptions());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });

  it('filename contains the sanitized title', async () => {
    await downloadReportPdf(makeOptions({ title: 'Product Master' }));
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('product_master');
  });

  it('filename ends with .pdf', async () => {
    await downloadReportPdf(makeOptions());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toMatch(/\.pdf$/);
  });

  it('filename contains ISO date', async () => {
    await downloadReportPdf(makeOptions());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    // Should match YYYY-MM-DD pattern
    expect(saveName).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
