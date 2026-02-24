/**
 * deliveryPdf.test.ts — Tests for delivery receipt PDF generation
 * Uses the same jsPDF/autoTable mock pattern as quotePdf.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PdfDeliveryData } from './deliveryPdf';

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
  roundedRect: vi.fn(),
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
  generateDeliveryPdf,
  downloadDeliveryPdf,
  generateBatchDeliveryPdf,
} from './deliveryPdf';

// ── Test Data ────────────────────────────────────────────────────────────

function makeDeliveryData(
  overrides: Partial<PdfDeliveryData> = {}
): PdfDeliveryData {
  return {
    delivery_number: 'DEL-2026-001',
    order_number: 'ORD-2026-050',
    customer_name: 'Smith Farm',
    customer_address: '123 Farm Rd, Robinson, IL',
    driver_name: 'Mason Wells',
    scheduled_date: '2026-03-15',
    status: 'pending',
    items: [
      {
        product_name: 'Atrazine 4L',
        quantity: 10,
        unit_size: 'Gallon',
      },
      {
        product_name: 'Roundup PowerMax',
        quantity: 5,
        unit_size: '2.5 Gallon',
      },
    ],
    ...overrides,
  };
}

// ── generateDeliveryPdf ──────────────────────────────────────────────────

describe('generateDeliveryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('returns a jsPDF document', async () => {
    const doc = await generateDeliveryPdf(makeDeliveryData());
    expect(doc).toBe(mockDoc);
  });

  it('renders the company header', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders DELIVERY RECEIPT label', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasLabel = textCalls.some(
      (args: unknown[]) => args[0] === 'DELIVERY RECEIPT'
    );
    expect(hasLabel).toBe(true);
  });

  it('renders the delivery number', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasDel = textCalls.some(
      (args: unknown[]) => args[0] === 'DEL-2026-001'
    );
    expect(hasDel).toBe(true);
  });

  it('renders the order number', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasOrd = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('ORD-2026-050')
    );
    expect(hasOrd).toBe(true);
  });

  it('renders customer name in info grid', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasCust = textCalls.some(
      (args: unknown[]) => args[0] === 'Smith Farm'
    );
    expect(hasCust).toBe(true);
  });

  it('renders customer address in info grid', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasAddr = textCalls.some(
      (args: unknown[]) => args[0] === '123 Farm Rd, Robinson, IL'
    );
    expect(hasAddr).toBe(true);
  });

  it('renders driver name in info grid', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasDriver = textCalls.some(
      (args: unknown[]) => args[0] === 'Mason Wells'
    );
    expect(hasDriver).toBe(true);
  });

  it('renders items table with Product, Quantity, Unit Size headers for pending', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    expect(mockAutoTable).toHaveBeenCalledTimes(1);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.head).toEqual([['Product', 'Quantity', 'Unit Size']]);
  });

  it('renders items table body with correct data', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect((opts.body as string[][])[0][0]).toBe('Atrazine 4L');
    expect((opts.body as string[][])[0][1]).toBe('10');
    expect((opts.body as string[][])[0][2]).toBe('Gallon');
  });

  it('renders 4-column table for completed delivery with delivered quantities', async () => {
    const data = makeDeliveryData({
      status: 'completed',
      completed_at: '2026-03-16T14:00:00Z',
      items: [
        { product_name: 'Atrazine 4L', quantity: 10, unit_size: 'Gallon', quantity_delivered: 8 },
      ],
    });
    await generateDeliveryPdf(data);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.head).toEqual([['Product', 'Planned', 'Delivered', 'Unit Size']]);
  });

  it('handles partial delivery with amber highlighting (didParseCell)', async () => {
    const data = makeDeliveryData({
      status: 'completed',
      items: [
        { product_name: 'Atrazine 4L', quantity: 10, unit_size: 'Gallon', quantity_delivered: 7 },
      ],
    });
    await generateDeliveryPdf(data);
    // autoTable was called with didParseCell hook
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof opts.didParseCell).toBe('function');
  });

  it('renders priority badge for urgent deliveries', async () => {
    await generateDeliveryPdf(makeDeliveryData({ priority: 'urgent' }));
    const textCalls = mockDoc.text.mock.calls;
    const hasPriority = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('URGENT')
    );
    expect(hasPriority).toBe(true);
  });

  it('renders priority badge for high priority', async () => {
    await generateDeliveryPdf(makeDeliveryData({ priority: 'high' }));
    const textCalls = mockDoc.text.mock.calls;
    const hasPriority = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('HIGH')
    );
    expect(hasPriority).toBe(true);
  });

  it('does not render priority badge for normal priority', async () => {
    await generateDeliveryPdf(makeDeliveryData({ priority: 'normal' }));
    const textCalls = mockDoc.text.mock.calls;
    const hasPriority = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('PRIORITY:')
    );
    expect(hasPriority).toBe(false);
  });

  it('renders delivery notes when provided', async () => {
    await generateDeliveryPdf(
      makeDeliveryData({ delivery_notes: 'Leave at barn door' })
    );
    const textCalls = mockDoc.text.mock.calls;
    const hasNotes = textCalls.some(
      (args: unknown[]) => args[0] === 'NOTES'
    );
    expect(hasNotes).toBe(true);
    expect(mockDoc.splitTextToSize).toHaveBeenCalledWith(
      'Leave at barn door',
      expect.any(Number),
    );
  });

  it('does not render notes section when no notes', async () => {
    await generateDeliveryPdf(makeDeliveryData({ delivery_notes: undefined }));
    const textCalls = mockDoc.text.mock.calls;
    const hasNotes = textCalls.some(
      (args: unknown[]) => args[0] === 'NOTES'
    );
    expect(hasNotes).toBe(false);
  });

  it('renders issue reporting section when issue_type set', async () => {
    await generateDeliveryPdf(
      makeDeliveryData({
        issue_type: 'damaged_product',
        issue_notes: 'Two containers were cracked',
      })
    );
    const textCalls = mockDoc.text.mock.calls;
    const hasIssue = textCalls.some(
      (args: unknown[]) => args[0] === 'ISSUE REPORTED'
    );
    expect(hasIssue).toBe(true);
  });

  it('does not render issue section when issue_type is none', async () => {
    await generateDeliveryPdf(makeDeliveryData({ issue_type: 'none' }));
    const textCalls = mockDoc.text.mock.calls;
    const hasIssue = textCalls.some(
      (args: unknown[]) => args[0] === 'ISSUE REPORTED'
    );
    expect(hasIssue).toBe(false);
  });

  it('renders signature line', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasSig = textCalls.some(
      (args: unknown[]) => args[0] === 'Customer Signature'
    );
    expect(hasSig).toBe(true);
  });

  it('renders footer with Crop RX branding', async () => {
    await generateDeliveryPdf(makeDeliveryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasFooter = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('Thank you for your business')
    );
    expect(hasFooter).toBe(true);
  });

  it('handles missing customer_address gracefully', async () => {
    const doc = await generateDeliveryPdf(
      makeDeliveryData({ customer_address: undefined })
    );
    expect(doc).toBe(mockDoc);
    const textCalls = mockDoc.text.mock.calls;
    const hasDash = textCalls.some(
      (args: unknown[]) => args[0] === '-'
    );
    expect(hasDash).toBe(true);
  });
});

// ── downloadDeliveryPdf ──────────────────────────────────────────────────

describe('downloadDeliveryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('calls doc.save', async () => {
    await downloadDeliveryPdf(makeDeliveryData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });

  it('filename contains the delivery number', async () => {
    await downloadDeliveryPdf(makeDeliveryData());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('DEL-2026-001');
  });

  it('filename contains _receipt', async () => {
    await downloadDeliveryPdf(makeDeliveryData());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('_receipt');
  });
});

// ── generateBatchDeliveryPdf ─────────────────────────────────────────────

describe('generateBatchDeliveryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('throws on empty delivery list', async () => {
    await expect(generateBatchDeliveryPdf([])).rejects.toThrow(
      'No deliveries to generate'
    );
  });

  it('generates single-page PDF for one delivery', async () => {
    await generateBatchDeliveryPdf([makeDeliveryData()]);
    expect(mockDoc.addPage).not.toHaveBeenCalled();
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('DEL-2026-001');
  });

  it('adds page breaks between multiple deliveries', async () => {
    const deliveries = [
      makeDeliveryData({ delivery_number: 'DEL-001' }),
      makeDeliveryData({ delivery_number: 'DEL-002' }),
      makeDeliveryData({ delivery_number: 'DEL-003' }),
    ];
    await generateBatchDeliveryPdf(deliveries);
    expect(mockDoc.addPage).toHaveBeenCalledTimes(2); // pages 2 and 3
  });

  it('calls autoTable once per delivery in batch', async () => {
    const deliveries = [
      makeDeliveryData({ delivery_number: 'DEL-001' }),
      makeDeliveryData({ delivery_number: 'DEL-002' }),
    ];
    await generateBatchDeliveryPdf(deliveries);
    expect(mockAutoTable).toHaveBeenCalledTimes(2);
  });

  it('batch filename contains count', async () => {
    const deliveries = [
      makeDeliveryData({ delivery_number: 'DEL-001' }),
      makeDeliveryData({ delivery_number: 'DEL-002' }),
      makeDeliveryData({ delivery_number: 'DEL-003' }),
    ];
    await generateBatchDeliveryPdf(deliveries);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('batch_3');
  });

  it('saves batch PDF as .pdf file', async () => {
    const deliveries = [
      makeDeliveryData({ delivery_number: 'DEL-001' }),
      makeDeliveryData({ delivery_number: 'DEL-002' }),
    ];
    await generateBatchDeliveryPdf(deliveries);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toMatch(/\.pdf$/);
  });
});
