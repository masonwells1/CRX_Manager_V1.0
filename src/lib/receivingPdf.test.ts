import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getTextWidth: vi.fn(() => 50),
  setLineDashPattern: vi.fn(),
  addPage: vi.fn(),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

vi.mock('jspdf', () => {
  function JsPDFMock() {
    return mockDoc;
  }
  return { default: JsPDFMock };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc, opts) => {
    doc.lastAutoTable = { finalY: (opts.startY || 0) + 100 };
  }),
}));

import { generateReceivingPdf, downloadReceivingPdf, generateBatchReceivingPdf } from './receivingPdf';
import type { PdfReceivingData, PdfReceivingItem } from './receivingPdf';

function makeReceivingItem(overrides: Partial<PdfReceivingItem> = {}): PdfReceivingItem {
  return {
    product_name: 'Atrazine 4L',
    quantity_received: 50,
    condition: 'good',
    lot_number: 'LOT-2026-001',
    unit_size: 'gal',
    notes: '',
    ...overrides,
  };
}

function makeReceivingData(overrides: Partial<PdfReceivingData> = {}): PdfReceivingData {
  return {
    po_number: 'PO-2026-0001',
    vendor: 'Syngenta',
    received_at: '2026-03-01T10:30:00',
    received_by_name: 'Mason Wells',
    storage_location: 'Main Warehouse',
    items: [makeReceivingItem()],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDoc.lastAutoTable.finalY = 300;
});

describe('generateReceivingPdf', () => {
  it('returns a jsPDF document', async () => {
    const doc = await generateReceivingPdf(makeReceivingData());
    expect(doc).toBeDefined();
    expect(doc.text).toBeDefined();
    expect(doc.save).toBeDefined();
  });

  it('renders company header "CROP RX SOLUTIONS"', async () => {
    await generateReceivingPdf(makeReceivingData());
    const textCalls = mockDoc.text.mock.calls;
    const headerCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0] === 'CROP RX SOLUTIONS'
    );
    expect(headerCall).toBeDefined();
  });

  it('renders PO number', async () => {
    await generateReceivingPdf(makeReceivingData({ po_number: 'PO-2026-0042' }));
    const textCalls = mockDoc.text.mock.calls;
    const poCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0] === 'PO-2026-0042'
    );
    expect(poCall).toBeDefined();
  });

  it('renders vendor name', async () => {
    await generateReceivingPdf(makeReceivingData({ vendor: 'BASF' }));
    const textCalls = mockDoc.text.mock.calls;
    const vendorCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('BASF')
    );
    expect(vendorCall).toBeDefined();
  });

  it('handles empty items array', async () => {
    const doc = await generateReceivingPdf(makeReceivingData({ items: [] }));
    expect(doc).toBeDefined();
    const textCalls = mockDoc.text.mock.calls;
    const summaryCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0] === 'SUMMARY'
    );
    expect(summaryCall).toBeDefined();
  });

  it('handles item with good condition', async () => {
    const data = makeReceivingData({
      items: [makeReceivingItem({ condition: 'good' })],
    });
    const doc = await generateReceivingPdf(data);
    expect(doc).toBeDefined();
    const textCalls = mockDoc.text.mock.calls;
    const goodCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Good')
    );
    expect(goodCall).toBeDefined();
  });

  it('handles item with damaged condition', async () => {
    const data = makeReceivingData({
      items: [makeReceivingItem({ condition: 'damaged' })],
    });
    await generateReceivingPdf(data);
    const textCalls = mockDoc.text.mock.calls;
    const damagedCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Damaged')
    );
    expect(damagedCall).toBeDefined();
    // Damaged uses RED color [220, 38, 38]
    const redColorCalls = mockDoc.setTextColor.mock.calls.filter(
      (call) => call[0] === 220 && call[1] === 38 && call[2] === 38
    );
    expect(redColorCalls.length).toBeGreaterThan(0);
  });

  it('handles item with wrong_product condition', async () => {
    const data = makeReceivingData({
      items: [makeReceivingItem({ condition: 'wrong_product' })],
    });
    await generateReceivingPdf(data);
    const textCalls = mockDoc.text.mock.calls;
    const wrongCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Wrong Product')
    );
    expect(wrongCall).toBeDefined();
    // wrong_product uses RED color [220, 38, 38]
    const redColorCalls = mockDoc.setTextColor.mock.calls.filter(
      (call) => call[0] === 220 && call[1] === 38 && call[2] === 38
    );
    expect(redColorCalls.length).toBeGreaterThan(0);
  });

  it('handles item with short condition (amber/default)', async () => {
    const data = makeReceivingData({
      items: [makeReceivingItem({ condition: 'short' })],
    });
    await generateReceivingPdf(data);
    const textCalls = mockDoc.text.mock.calls;
    const shortCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Short')
    );
    expect(shortCall).toBeDefined();
    // Short uses AMBER color [217, 119, 6]
    const amberColorCalls = mockDoc.setTextColor.mock.calls.filter(
      (call) => call[0] === 217 && call[1] === 119 && call[2] === 6
    );
    expect(amberColorCalls.length).toBeGreaterThan(0);
  });

  it('handles items with notes', async () => {
    const data = makeReceivingData({
      items: [
        makeReceivingItem({
          notes: 'Container was dented on arrival',
        }),
      ],
    });
    await generateReceivingPdf(data);
    const textCalls = mockDoc.text.mock.calls;
    const notesHeaderCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0] === 'ITEM NOTES'
    );
    expect(notesHeaderCall).toBeDefined();
    expect(mockDoc.splitTextToSize).toHaveBeenCalledWith(
      'Container was dented on arrival',
      expect.any(Number)
    );
  });

  it('handles items without lot_number (undefined)', async () => {
    const data = makeReceivingData({
      items: [makeReceivingItem({ lot_number: undefined })],
    });
    const doc = await generateReceivingPdf(data);
    expect(doc).toBeDefined();
    // The autoTable body row should have '-' for missing lot_number
  });

  it('handles multiple items with mixed conditions', async () => {
    const data = makeReceivingData({
      items: [
        makeReceivingItem({ product_name: 'Atrazine 4L', condition: 'good' }),
        makeReceivingItem({ product_name: 'Roundup PowerMax', condition: 'damaged' }),
        makeReceivingItem({ product_name: 'Dicamba DGA', condition: 'short' }),
      ],
    });
    await generateReceivingPdf(data);
    const textCalls = mockDoc.text.mock.calls;
    const totalItemsCall = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0] === 'Total Items: 3'
    );
    expect(totalItemsCall).toBeDefined();

    // Should have green (good), red (damaged), and amber (short) color calls
    const greenCalls = mockDoc.setTextColor.mock.calls.filter(
      (call) => call[0] === 40 && call[1] === 162 && call[2] === 106
    );
    const redCalls = mockDoc.setTextColor.mock.calls.filter(
      (call) => call[0] === 220 && call[1] === 38 && call[2] === 38
    );
    const amberCalls = mockDoc.setTextColor.mock.calls.filter(
      (call) => call[0] === 217 && call[1] === 119 && call[2] === 6
    );
    expect(greenCalls.length).toBeGreaterThan(0);
    expect(redCalls.length).toBeGreaterThan(0);
    expect(amberCalls.length).toBeGreaterThan(0);
  });
});

describe('downloadReceivingPdf', () => {
  it('calls doc.save', async () => {
    await downloadReceivingPdf(makeReceivingData({ po_number: 'PO-2026-0099' }));
    expect(mockDoc.save).toHaveBeenCalledWith('PO-2026-0099_receiving_receipt.pdf');
  });
});

describe('generateBatchReceivingPdf', () => {
  it('generates batch with multiple receipts', async () => {
    const dataList = [
      makeReceivingData({ po_number: 'PO-2026-0001', vendor: 'Syngenta' }),
      makeReceivingData({ po_number: 'PO-2026-0002', vendor: 'BASF' }),
    ];
    await generateBatchReceivingPdf(dataList);
    expect(mockDoc.save).toHaveBeenCalledWith('receiving_receipts_batch_2.pdf');
    // Both PO numbers should appear in text calls
    const textCalls = mockDoc.text.mock.calls;
    const po1 = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0] === 'PO-2026-0001'
    );
    const po2 = textCalls.find(
      (call) => typeof call[0] === 'string' && call[0] === 'PO-2026-0002'
    );
    expect(po1).toBeDefined();
    expect(po2).toBeDefined();
  });

  it('calls addPage for second receipt', async () => {
    const dataList = [
      makeReceivingData({ po_number: 'PO-2026-0001' }),
      makeReceivingData({ po_number: 'PO-2026-0002' }),
    ];
    await generateBatchReceivingPdf(dataList);
    expect(mockDoc.addPage).toHaveBeenCalledTimes(1);
  });
});
