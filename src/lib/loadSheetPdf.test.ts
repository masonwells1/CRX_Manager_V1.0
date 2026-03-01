import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock jsPDF doc instance (same pattern as deliveryPdf.test.ts) ──
const mockDoc = {
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
  save: vi.fn(),
  text: vi.fn(),
  setFontSize: vi.fn(),
  setFont: vi.fn(),
  setTextColor: vi.fn(),
  setFillColor: vi.fn(),
  setDrawColor: vi.fn(),
  rect: vi.fn(),
  line: vi.fn(),
  getTextWidth: vi.fn().mockReturnValue(50),
  addPage: vi.fn(),
  lastAutoTable: { finalY: 100 },
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

import { generateLoadSheetPdf, type LoadSheetStop } from './loadSheetPdf';

beforeEach(() => {
  vi.clearAllMocks();
});

const makeStop = (overrides?: Partial<LoadSheetStop>): LoadSheetStop => ({
  delivery_number: 'DEL-2026-0001',
  customer_name: 'Smith Farm',
  customer_address: '123 Rural Rd',
  driver_name: 'John',
  scheduled_date: '2026-03-01',
  priority: 'normal',
  items: [
    { product_name: 'Roundup PowerMax', quantity: 10, unit_size: '2.5 Gal', tote_number: 'T-100' },
    { product_name: 'Atrazine 4L', quantity: 5, unit_size: '2.5 Gal' },
  ],
  ...overrides,
});

describe('generateLoadSheetPdf', () => {
  it('calls jsPDF save with correct filename', async () => {
    await generateLoadSheetPdf([makeStop()]);
    expect(mockDoc.save).toHaveBeenCalledWith(expect.stringContaining('load_sheet_'));
  });

  it('creates product summary table (autoTable call #1)', async () => {
    await generateLoadSheetPdf([makeStop()]);
    // First autoTable call is the product summary
    expect(mockAutoTable).toHaveBeenCalled();
    const firstCallArgs = mockAutoTable.mock.calls[0];
    const opts = firstCallArgs[1];
    // Should aggregate products: Roundup 10, Atrazine 5
    expect(opts.body).toHaveLength(2);
  });

  it('aggregates quantities across multiple stops for same product', async () => {
    const stop1 = makeStop({ delivery_number: 'DEL-2026-0001' });
    const stop2 = makeStop({
      delivery_number: 'DEL-2026-0002',
      customer_name: 'Jones Farm',
      items: [
        { product_name: 'Roundup PowerMax', quantity: 15, unit_size: '2.5 Gal' },
      ],
    });
    await generateLoadSheetPdf([stop1, stop2]);
    const firstCallOpts = mockAutoTable.mock.calls[0][1];
    // Roundup should be 10 + 15 = 25, Atrazine should be 5
    const roundupRow = firstCallOpts.body.find((r: string[]) => r[0] === 'Roundup PowerMax');
    expect(roundupRow).toBeTruthy();
    expect(Number(roundupRow[1])).toBe(25);
  });

  it('creates one per-stop table per delivery', async () => {
    const stops = [
      makeStop({ delivery_number: 'DEL-2026-0001' }),
      makeStop({ delivery_number: 'DEL-2026-0002', customer_name: 'Jones Farm' }),
    ];
    await generateLoadSheetPdf(stops);
    // autoTable calls: 1 (summary) + 2 (per-stop) = 3
    expect(mockAutoTable).toHaveBeenCalledTimes(3);
  });

  it('accepts custom filename', async () => {
    await generateLoadSheetPdf([makeStop()], 'my_sheet.pdf');
    expect(mockDoc.save).toHaveBeenCalledWith('my_sheet.pdf');
  });

  it('throws on empty stops array', async () => {
    await expect(generateLoadSheetPdf([])).rejects.toThrow('No stops');
  });
});
