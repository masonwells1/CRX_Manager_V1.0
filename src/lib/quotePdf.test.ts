/**
 * quotePdf.test.ts — Tests for quote PDF generation
 * Uses the same jsPDF/autoTable mock pattern as pdfGeneration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  lastAutoTable: { finalY: 300 },
};

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    (doc as typeof mockDoc).lastAutoTable = { finalY: ((opts.startY as number) || 0) + 100 };
  }),
}));

import { generateQuotePdf, downloadQuotePdf } from './quotePdf';

// ── Test Data ───────────────────────────────────────────────────────────

function makeQuoteData(overrides: Record<string, unknown> = {}) {
  return {
    quote_number: 'Q-2026-001',
    customer_name: 'Smith Farm',
    customer_email: 'smith@test.com',
    customer_phone: '555-1234',
    customer_address: '123 Farm Rd',
    sales_rep_name: 'Mason Wells',
    created_at: '2026-03-01',
    expires_at: '2026-04-01',
    valid_days: 30,
    tier: 1,
    header_notes: 'Spring application package',
    footer_notes: 'Prices valid for 30 days',
    sections: [
      {
        section_name: 'Corn Pre-Emerge',
        section_notes: 'Apply early March',
        items: [
          {
            product_name: 'Atrazine 4L',
            actual_rate: 2,
            rate_unit: 'QT',
            acres: 100,
            total_units_needed: 6.25,
            inventory_unit: 'Gallon',
            price_per_unit: 18.5,
            total_price: 115.63,
          },
        ],
      },
    ],
    totals: {
      totalPrice: 115.63,
      totalCost: 80.0,
      totalProfit: 35.63,
      avgMargin: 30.81,
    },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('generateQuotePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('returns a jsPDF document', async () => {
    const doc = await generateQuotePdf(makeQuoteData());
    expect(doc).toBe(mockDoc);
  });

  it('renders the company header', async () => {
    await generateQuotePdf(makeQuoteData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders the quote number', async () => {
    await generateQuotePdf(makeQuoteData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasQuoteNum = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Q-2026-001')
    );
    expect(hasQuoteNum).toBe(true);
  });

  it('renders customer name', async () => {
    await generateQuotePdf(makeQuoteData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasCustomer = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Smith Farm')
    );
    expect(hasCustomer).toBe(true);
  });

  it('handles empty sections', async () => {
    const doc = await generateQuotePdf(makeQuoteData({ sections: [] }));
    expect(doc).toBe(mockDoc);
  });

  it('handles missing optional fields', async () => {
    const doc = await generateQuotePdf(makeQuoteData({
      customer_email: undefined,
      customer_phone: undefined,
      customer_address: undefined,
      header_notes: undefined,
      footer_notes: undefined,
      expires_at: undefined,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles multiple sections', async () => {
    const data = makeQuoteData({
      sections: [
        {
          section_name: 'Section 1',
          items: [{
            product_name: 'Product A',
            actual_rate: 1, rate_unit: 'QT', acres: 50,
            total_units_needed: 3, price_per_unit: 10, total_price: 30,
          }],
        },
        {
          section_name: 'Section 2',
          items: [{
            product_name: 'Product B',
            actual_rate: 2, rate_unit: 'GL', acres: 100,
            total_units_needed: 2, price_per_unit: 25, total_price: 50,
          }],
        },
      ],
    });
    const doc = await generateQuotePdf(data);
    expect(doc).toBe(mockDoc);
  });
});

describe('downloadQuotePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('calls doc.save with the quote number', async () => {
    await downloadQuotePdf(makeQuoteData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
    const saveName = mockDoc.save.mock.calls[0][0] as string;
    expect(saveName).toContain('Q-2026-001');
  });
});
