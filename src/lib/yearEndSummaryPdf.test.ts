/**
 * yearEndSummaryPdf.test.ts — Tests for year-end customer summary PDF
 * Uses the same jsPDF/autoTable mock pattern as pdfGeneration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  YearEndSummaryData,
  YearEndProductUsage,
  YearEndInvoiceRow,
  YearEndShareRow,
} from '../types';

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
  getTextWidth: vi.fn(() => 50),
  setLineDashPattern: vi.fn(),
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

import autoTable from 'jspdf-autotable';

import {
  generateYearEndSummaryPdf,
  downloadYearEndSummaryPdf,
  downloadBatchYearEndSummaries,
} from './yearEndSummaryPdf';

// ── Test Data Factories ─────────────────────────────────────────────────

function makeProductUsage(overrides: Partial<YearEndProductUsage> = {}): YearEndProductUsage {
  return {
    category: 'Herbicide',
    product_name: 'Atrazine 4L',
    epa_registration: '100-497',
    total_quantity: 50,
    unit_size: 'gal',
    avg_rate_per_acre: 2.0,
    rate_unit: 'QT',
    total_acres_treated: 200,
    total_cost_cents: 92500,
    total_applied: 400,
    total_applied_unit: 'QT',
    total_applied_gl_lb: 100,
    gl_lb_unit: 'GL',
    is_application_fee: false,
    ...overrides,
  };
}

function makeInvoiceRow(overrides: Partial<YearEndInvoiceRow> = {}): YearEndInvoiceRow {
  return {
    invoice_number: 'INV-2026-001',
    invoice_date: '2026-03-15',
    invoice_type: 'standard',
    field_names: ['North 40', 'South 80'],
    total_acres: 120,
    crop_type: 'corn',
    total_amount_cents: 185000,
    balance_cents: 0,
    status: 'posted',
    ...overrides,
  };
}

function makeShareRow(overrides: Partial<YearEndShareRow> = {}): YearEndShareRow {
  return {
    invoice_number: 'INV-2026-001',
    field_names: ['North 40'],
    share_customer_name: 'Jones Farm',
    split_percentage: 50,
    acres: 60,
    amount_cents: 92500,
    price_per_acre_cents: 1542,
    pricing_note: '50/50 split',
    ...overrides,
  };
}

function makeSummaryData(overrides: Partial<YearEndSummaryData> = {}): YearEndSummaryData {
  return {
    customer: {
      id: 'cust-1',
      farm_name: 'Smith Farm',
      contact_name: 'John Smith',
      account_number: 'ACC-001',
      email: 'john@smith.com',
      phone: '555-1234',
      billing_address: '123 Farm Rd',
      city: 'Robinson',
      state: 'IL',
      zip: '62454',
      assigned_tier: 1,
      payment_terms: 'Net 30',
    },
    season: 2026,
    season_start: '2026-01-01',
    season_end: '2026-12-31',
    financial: {
      total_invoiced_cents: 185000,
      total_paid_cents: 185000,
      prepay_applied_cents: 0,
      outstanding_balance_cents: 0,
      invoice_count: 3,
    },
    product_usage: [makeProductUsage()],
    acreage: {
      total_acres: 500,
      by_crop: [
        { crop_type: 'corn', acres: 300 },
        { crop_type: 'soybeans', acres: 200 },
      ],
    },
    invoices: [makeInvoiceRow()],
    shares: [],
    prior_season: null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('generateYearEndSummaryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('returns a jsPDF document', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData());
    expect(doc).toBe(mockDoc);
  });

  it('renders company header', async () => {
    await generateYearEndSummaryPdf(makeSummaryData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders season year', async () => {
    await generateYearEndSummaryPdf(makeSummaryData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasSeason = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('2026')
    );
    expect(hasSeason).toBe(true);
  });

  it('handles empty product usage', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData({ product_usage: [] }));
    expect(doc).toBe(mockDoc);
  });

  it('renders a negative returned-product net as a visible negative amount', async () => {
    await generateYearEndSummaryPdf(makeSummaryData({
      product_usage: [makeProductUsage({ total_quantity: -1, total_cost_cents: -1000 })],
    }));
    const productTable = vi.mocked(autoTable).mock.calls.find(([, options]) =>
      JSON.stringify(options.head).includes('"Product"')
    );
    const body = productTable?.[1].body as unknown[][] | undefined;
    expect(body).toContainEqual(expect.arrayContaining(['-$10.00']));
  });

  it('handles empty invoices', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData({ invoices: [] }));
    expect(doc).toBe(mockDoc);
  });

  it('handles shares', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData({
      shares: [makeShareRow()],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles year-over-year comparison with prior season', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData({
      prior_season: {
        total_invoiced_cents: 150000,
        total_paid_cents: 150000,
        invoice_count: 2,
        total_acres: 400,
      },
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles options to hide sections', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData(), {
      show_product_detail: false,
      show_shares: false,
      show_yoy_comparison: false,
    });
    expect(doc).toBe(mockDoc);
  });

  it('handles customer with null optional fields', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData({
      customer: {
        id: 'cust-1',
        farm_name: 'Minimal Farm',
        contact_name: null,
        account_number: null,
        email: null,
        phone: null,
        billing_address: null,
        city: null,
        state: null,
        zip: null,
        assigned_tier: 1,
        payment_terms: null,
      },
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles multiple product categories', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData({
      product_usage: [
        makeProductUsage({ category: 'Herbicide', product_name: 'Atrazine 4L' }),
        makeProductUsage({ category: 'Herbicide', product_name: 'Roundup PowerMAX' }),
        makeProductUsage({ category: 'Insecticide', product_name: 'Lorsban Advanced' }),
        makeProductUsage({ category: 'Application Fee', product_name: 'Application', is_application_fee: true }),
      ],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles zero financial amounts', async () => {
    const doc = await generateYearEndSummaryPdf(makeSummaryData({
      financial: {
        total_invoiced_cents: 0,
        total_paid_cents: 0,
        prepay_applied_cents: 0,
        outstanding_balance_cents: 0,
        invoice_count: 0,
      },
    }));
    expect(doc).toBe(mockDoc);
  });
});

describe('downloadYearEndSummaryPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('calls doc.save', async () => {
    await downloadYearEndSummaryPdf(makeSummaryData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });
});

describe('downloadBatchYearEndSummaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('generates batch with multiple summaries', async () => {
    const summaries = [
      makeSummaryData(),
      makeSummaryData({
        customer: {
          id: 'cust-2',
          farm_name: 'Jones Farm',
          contact_name: null,
          account_number: null,
          email: null,
          phone: null,
          billing_address: null,
          city: null,
          state: null,
          zip: null,
          assigned_tier: 2,
          payment_terms: null,
        },
      }),
    ];
    await downloadBatchYearEndSummaries(summaries);
    expect(mockDoc.save).toHaveBeenCalledTimes(2);
  });
});
