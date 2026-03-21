/**
 * orderPickListPdf.test.ts — Tests for warehouse pick list PDF generation
 * Follows the same jsPDF/autoTable mock pattern as deliveryPdf.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PickListData } from './orderPickListPdf';

// ── Mock jsPDF doc instance ─────────────────────────────────────────────

const mockDoc = {
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
  setFillColor: vi.fn(),
  rect: vi.fn(),
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  setDrawColor: vi.fn(),
  line: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
  addPage: vi.fn(),
  save: vi.fn(),
  lastAutoTable: { finalY: 400 },
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
  generatePickListPdf,
  downloadPickListPdf,
  downloadBatchPickListPdf,
} from './orderPickListPdf';

// ── Test Data ────────────────────────────────────────────────────────────

function makePickListData(
  overrides: Partial<PickListData> = {}
): PickListData {
  return {
    order_number: 'ORD-2026-050',
    order_name: 'Spring Program',
    order_date: '2026-03-15',
    farm_name: 'Smith Farm',
    contact_name: 'John Smith',
    phone: '555-1234',
    delivery_addresses: ['123 Farm Rd, Robinson, IL 62454'],
    items: [
      {
        product_name: 'Atrazine 4L',
        unit_size: 'Gallon',
        total_units_needed: 50,
        quantity_delivered: 20,
        quantity_remaining: 30,
        inventory_available: 100,
        has_shortage: false,
      },
      {
        product_name: 'Roundup PowerMax',
        unit_size: '2.5 Gallon',
        total_units_needed: 100,
        quantity_delivered: 0,
        quantity_remaining: 100,
        inventory_available: 40,
        has_shortage: true,
      },
    ],
    notes: 'Gate code: 1234',
    program_notes: 'Spring herbicide program',
    ...overrides,
  };
}

// ── generatePickListPdf ──────────────────────────────────────────────────

describe('generatePickListPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('returns a jsPDF document', async () => {
    const doc = await generatePickListPdf(makePickListData());
    expect(doc).toBe(mockDoc);
  });

  it('renders the company header', async () => {
    await generatePickListPdf(makePickListData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders PICK LIST label', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasLabel = textCalls.some(
      (args: unknown[]) => args[0] === 'PICK LIST'
    );
    expect(hasLabel).toBe(true);
  });

  it('renders the order number', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasOrd = textCalls.some(
      (args: unknown[]) => args[0] === 'ORD-2026-050'
    );
    expect(hasOrd).toBe(true);
  });

  it('renders customer name', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasCust = textCalls.some(
      (args: unknown[]) => args[0] === 'Smith Farm'
    );
    expect(hasCust).toBe(true);
  });

  it('renders contact name and phone', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasContact = textCalls.some((args: unknown[]) => args[0] === 'John Smith');
    const hasPhone = textCalls.some((args: unknown[]) => args[0] === '555-1234');
    expect(hasContact).toBe(true);
    expect(hasPhone).toBe(true);
  });

  it('renders delivery address', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasAddrLabel = textCalls.some(
      (args: unknown[]) => args[0] === 'DELIVERY ADDRESS'
    );
    expect(hasAddrLabel).toBe(true);
    expect(mockDoc.splitTextToSize).toHaveBeenCalledWith(
      '123 Farm Rd, Robinson, IL 62454',
      expect.any(Number),
    );
  });

  it('handles no delivery addresses', async () => {
    await generatePickListPdf(makePickListData({ delivery_addresses: [] }));
    const textCalls = mockDoc.text.mock.calls;
    const hasNoAddr = textCalls.some(
      (args: unknown[]) => args[0] === 'No delivery address on file'
    );
    expect(hasNoAddr).toBe(true);
  });

  it('renders items table with fulfillment columns', async () => {
    await generatePickListPdf(makePickListData());
    expect(mockAutoTable).toHaveBeenCalledTimes(1);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.head).toEqual([['Product', 'Unit', 'Ordered', 'Delivered', 'Remaining', 'Available', 'Status']]);
  });

  it('renders items table body with correct data', async () => {
    await generatePickListPdf(makePickListData());
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    const body = opts.body as string[][];
    expect(body[0][0]).toBe('Atrazine 4L');
    expect(body[0][2]).toBe('50');
    expect(body[0][3]).toBe('20');
    expect(body[0][4]).toBe('30');
    expect(body[0][5]).toBe('100');
    expect(body[0][6]).toBe('OK');
  });

  it('marks shortage items with LOW status', async () => {
    await generatePickListPdf(makePickListData());
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    const body = opts.body as string[][];
    expect(body[1][6]).toBe('LOW');
  });

  it('has didParseCell hook for cell highlighting', async () => {
    await generatePickListPdf(makePickListData());
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof opts.didParseCell).toBe('function');
  });

  it('renders INVENTORY WARNINGS section when shortages exist', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasWarning = textCalls.some(
      (args: unknown[]) => args[0] === 'INVENTORY WARNINGS'
    );
    expect(hasWarning).toBe(true);
  });

  it('renders shortage details with product name and quantities', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasShortageDetail = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' &&
        args[0].includes('Roundup PowerMax') &&
        args[0].includes('Need 100') &&
        args[0].includes('Short 60')
    );
    expect(hasShortageDetail).toBe(true);
  });

  it('does not render warnings section when no shortages', async () => {
    const data = makePickListData({
      items: [
        {
          product_name: 'Atrazine 4L',
          unit_size: 'Gallon',
          total_units_needed: 10,
          quantity_delivered: 0,
          quantity_remaining: 10,
          inventory_available: 100,
          has_shortage: false,
        },
      ],
    });
    await generatePickListPdf(data);
    const textCalls = mockDoc.text.mock.calls;
    const hasWarning = textCalls.some(
      (args: unknown[]) => args[0] === 'INVENTORY WARNINGS'
    );
    expect(hasWarning).toBe(false);
  });

  it('handles null inventory_available gracefully', async () => {
    const data = makePickListData({
      items: [
        {
          product_name: 'New Product',
          unit_size: null,
          total_units_needed: 10,
          quantity_delivered: 0,
          quantity_remaining: 10,
          inventory_available: null,
          has_shortage: false,
        },
      ],
    });
    const doc = await generatePickListPdf(data);
    expect(doc).toBe(mockDoc);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    const body = opts.body as string[][];
    expect(body[0][5]).toBe('N/A');
    expect(body[0][6]).toBe('N/A');
  });

  it('renders notes when provided', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasNotes = textCalls.some(
      (args: unknown[]) => args[0] === 'NOTES'
    );
    expect(hasNotes).toBe(true);
  });

  it('renders program notes', async () => {
    await generatePickListPdf(makePickListData());
    expect(mockDoc.splitTextToSize).toHaveBeenCalledWith(
      'Program: Spring herbicide program',
      expect.any(Number),
    );
  });

  it('renders Internal Use Only footer', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasFooter = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('Internal Use Only')
    );
    expect(hasFooter).toBe(true);
  });

  it('renders order name when provided', async () => {
    await generatePickListPdf(makePickListData());
    const textCalls = mockDoc.text.mock.calls;
    const hasName = textCalls.some(
      (args: unknown[]) => args[0] === 'Spring Program'
    );
    expect(hasName).toBe(true);
  });
});

// ── downloadPickListPdf ──────────────────────────────────────────────────

describe('downloadPickListPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('calls doc.save', async () => {
    await downloadPickListPdf(makePickListData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });

  it('filename contains the order number', async () => {
    await downloadPickListPdf(makePickListData());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('ORD-2026-050');
  });

  it('filename contains _pick_list', async () => {
    await downloadPickListPdf(makePickListData());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('_pick_list');
  });
});

// ── downloadBatchPickListPdf ─────────────────────────────────────────────

describe('downloadBatchPickListPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('throws on empty order list', async () => {
    await expect(downloadBatchPickListPdf([])).rejects.toThrow(
      'No orders to generate'
    );
  });

  it('generates single-page PDF for one order', async () => {
    await downloadBatchPickListPdf([makePickListData()]);
    expect(mockDoc.addPage).not.toHaveBeenCalled();
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });

  it('adds page breaks between multiple orders', async () => {
    const orders = [
      makePickListData({ order_number: 'ORD-001' }),
      makePickListData({ order_number: 'ORD-002' }),
      makePickListData({ order_number: 'ORD-003' }),
    ];
    await downloadBatchPickListPdf(orders);
    expect(mockDoc.addPage).toHaveBeenCalledTimes(2);
  });

  it('calls autoTable once per order in batch', async () => {
    const orders = [
      makePickListData({ order_number: 'ORD-001' }),
      makePickListData({ order_number: 'ORD-002' }),
    ];
    await downloadBatchPickListPdf(orders);
    expect(mockAutoTable).toHaveBeenCalledTimes(2);
  });

  it('batch filename contains count', async () => {
    const orders = [
      makePickListData({ order_number: 'ORD-001' }),
      makePickListData({ order_number: 'ORD-002' }),
      makePickListData({ order_number: 'ORD-003' }),
    ];
    await downloadBatchPickListPdf(orders);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('batch_3');
  });

  it('saves batch PDF as .pdf file', async () => {
    const orders = [
      makePickListData({ order_number: 'ORD-001' }),
      makePickListData({ order_number: 'ORD-002' }),
    ];
    await downloadBatchPickListPdf(orders);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toMatch(/\.pdf$/);
  });
});
