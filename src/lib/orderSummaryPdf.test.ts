/**
 * orderSummaryPdf.test.ts — Tests for order summary PDF generation
 * Follows the same jsPDF/autoTable mock pattern as deliveryPdf.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrderSummaryData } from './orderSummaryPdf';

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
  generateOrderSummaryPdf,
  downloadOrderSummaryPdf,
  downloadBatchOrderSummaryPdf,
} from './orderSummaryPdf';

// ── Test Data ────────────────────────────────────────────────────────────

function makeOrderSummaryData(
  overrides: Partial<OrderSummaryData> = {}
): OrderSummaryData {
  return {
    order_number: 'ORD-2026-050',
    order_name: 'Spring Program',
    order_date: '2026-03-15',
    status: 'confirmed',
    customer_po_number: 'PO-1234',
    farm_name: 'Smith Farm',
    contact_name: 'John Smith',
    phone: '555-1234',
    billing_address: '123 Farm Rd, Robinson, IL 62454',
    items: [
      { product_name: 'Atrazine 4L', quantity: 10, unit_size: 'Gallon', price_per_unit: 25.50, extended_price: 255.00 },
      { product_name: 'Roundup PowerMax', quantity: 5, unit_size: '2.5 Gallon', price_per_unit: 45.00, extended_price: 225.00 },
    ],
    total_price: 480.00,
    notes: 'Please deliver before April 1st',
    ...overrides,
  };
}

// ── generateOrderSummaryPdf ──────────────────────────────────────────────

describe('generateOrderSummaryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('returns a jsPDF document', async () => {
    const doc = await generateOrderSummaryPdf(makeOrderSummaryData());
    expect(doc).toBe(mockDoc);
  });

  it('renders the company header', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders ORDER SUMMARY label', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasLabel = textCalls.some(
      (args: unknown[]) => args[0] === 'ORDER SUMMARY'
    );
    expect(hasLabel).toBe(true);
  });

  it('renders the order number', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasOrd = textCalls.some(
      (args: unknown[]) => args[0] === 'ORD-2026-050'
    );
    expect(hasOrd).toBe(true);
  });

  it('renders customer name in info grid', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasCust = textCalls.some(
      (args: unknown[]) => args[0] === 'Smith Farm'
    );
    expect(hasCust).toBe(true);
  });

  it('renders contact name', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasContact = textCalls.some(
      (args: unknown[]) => args[0] === 'John Smith'
    );
    expect(hasContact).toBe(true);
  });

  it('renders customer PO number', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasPO = textCalls.some(
      (args: unknown[]) => args[0] === 'PO-1234'
    );
    expect(hasPO).toBe(true);
  });

  it('renders items table with correct headers (no cost/margin)', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    expect(mockAutoTable).toHaveBeenCalledTimes(1);
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.head).toEqual([['Product', 'Qty', 'Unit', 'Unit Price', 'Extended']]);
  });

  it('does NOT include cost, margin, or profit columns', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    const headers = (opts.head as string[][])[0];
    expect(headers).not.toContain('Cost');
    expect(headers).not.toContain('Margin');
    expect(headers).not.toContain('Profit');
  });

  it('renders items table body with correct data', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const opts = mockAutoTable.mock.calls[0][1] as Record<string, unknown>;
    expect((opts.body as string[][])[0][0]).toBe('Atrazine 4L');
    expect((opts.body as string[][])[0][1]).toBe('10');
    expect((opts.body as string[][])[0][2]).toBe('Gallon');
  });

  it('renders TOTAL line', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasTotal = textCalls.some(
      (args: unknown[]) => args[0] === 'TOTAL'
    );
    expect(hasTotal).toBe(true);
  });

  it('renders notes when provided', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasNotes = textCalls.some(
      (args: unknown[]) => args[0] === 'NOTES'
    );
    expect(hasNotes).toBe(true);
    expect(mockDoc.splitTextToSize).toHaveBeenCalledWith(
      'Please deliver before April 1st',
      expect.any(Number),
    );
  });

  it('does not render notes section when no notes', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData({ notes: null }));
    const textCalls = mockDoc.text.mock.calls;
    const hasNotes = textCalls.some(
      (args: unknown[]) => args[0] === 'NOTES'
    );
    expect(hasNotes).toBe(false);
  });

  it('renders footer with Crop RX branding', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasFooter = textCalls.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('Thank you for your business')
    );
    expect(hasFooter).toBe(true);
  });

  it('handles missing contact_name gracefully', async () => {
    const doc = await generateOrderSummaryPdf(
      makeOrderSummaryData({ contact_name: null })
    );
    expect(doc).toBe(mockDoc);
  });

  it('renders order name when provided', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasName = textCalls.some(
      (args: unknown[]) => args[0] === 'Spring Program'
    );
    expect(hasName).toBe(true);
  });

  it('renders billing address', async () => {
    await generateOrderSummaryPdf(makeOrderSummaryData());
    const textCalls = mockDoc.text.mock.calls;
    const hasBilling = textCalls.some(
      (args: unknown[]) => args[0] === 'BILLING ADDRESS'
    );
    expect(hasBilling).toBe(true);
  });
});

// ── downloadOrderSummaryPdf ──────────────────────────────────────────────

describe('downloadOrderSummaryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('calls doc.save', async () => {
    await downloadOrderSummaryPdf(makeOrderSummaryData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });

  it('filename contains the order number', async () => {
    await downloadOrderSummaryPdf(makeOrderSummaryData());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('ORD-2026-050');
  });

  it('filename contains _summary', async () => {
    await downloadOrderSummaryPdf(makeOrderSummaryData());
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('_summary');
  });
});

// ── downloadBatchOrderSummaryPdf ─────────────────────────────────────────

describe('downloadBatchOrderSummaryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 400 };
  });

  it('throws on empty order list', async () => {
    await expect(downloadBatchOrderSummaryPdf([])).rejects.toThrow(
      'No orders to generate'
    );
  });

  it('generates single-page PDF for one order', async () => {
    await downloadBatchOrderSummaryPdf([makeOrderSummaryData()]);
    expect(mockDoc.addPage).not.toHaveBeenCalled();
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('ORD-2026-050');
  });

  it('adds page breaks between multiple orders', async () => {
    const orders = [
      makeOrderSummaryData({ order_number: 'ORD-001' }),
      makeOrderSummaryData({ order_number: 'ORD-002' }),
      makeOrderSummaryData({ order_number: 'ORD-003' }),
    ];
    await downloadBatchOrderSummaryPdf(orders);
    expect(mockDoc.addPage).toHaveBeenCalledTimes(2);
  });

  it('calls autoTable once per order in batch', async () => {
    const orders = [
      makeOrderSummaryData({ order_number: 'ORD-001' }),
      makeOrderSummaryData({ order_number: 'ORD-002' }),
    ];
    await downloadBatchOrderSummaryPdf(orders);
    expect(mockAutoTable).toHaveBeenCalledTimes(2);
  });

  it('batch filename contains count', async () => {
    const orders = [
      makeOrderSummaryData({ order_number: 'ORD-001' }),
      makeOrderSummaryData({ order_number: 'ORD-002' }),
      makeOrderSummaryData({ order_number: 'ORD-003' }),
    ];
    await downloadBatchOrderSummaryPdf(orders);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('batch_3');
  });

  it('saves batch PDF as .pdf file', async () => {
    const orders = [
      makeOrderSummaryData({ order_number: 'ORD-001' }),
      makeOrderSummaryData({ order_number: 'ORD-002' }),
    ];
    await downloadBatchOrderSummaryPdf(orders);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toMatch(/\.pdf$/);
  });
});
