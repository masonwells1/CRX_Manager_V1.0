/**
 * invoicePdf.test.ts — Tests for invoice PDF generation (3 layouts)
 * Uses the same jsPDF/autoTable mock pattern as statementPdf.test.ts
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

import { generateInvoicePdf, downloadInvoicePdf, generateBatchInvoicePdf } from './invoicePdf';
import type { InvoicePdfData, InvoicePdfItem, InvoicePdfShare } from './invoicePdf';

// ── Test Data Factories ─────────────────────────────────────────────────

function makeItem(overrides: Partial<InvoicePdfItem> = {}): InvoicePdfItem {
  return {
    description: 'Atrazine 4L',
    product_name: 'Atrazine 4L',
    quantity: 10,
    unit_size: 'gal',
    unit_price_cents: 1850,
    extended_cents: 18500,
    cost_cents: 1200,
    rate_per_acre: 2.0,
    rate_unit: 'QT',
    acres: 100,
    total_applied: 200,
    total_applied_unit: 'QT',
    total_applied_gl_lb: 50,
    gl_lb_unit: 'GL',
    epa_registration: '100-497',
    is_application_fee: false,
    product_form: 'liquid',
    ...overrides,
  };
}

function makeShare(overrides: Partial<InvoicePdfShare> = {}): InvoicePdfShare {
  return {
    customer_name: 'Jones Farm',
    split_percentage: 50,
    acres: 50,
    amount_cents: 9250,
    price_per_acre_cents: 185,
    pricing_note: '50/50 split',
    ...overrides,
  };
}

function makeInvoiceData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoice_number: 'INV-2026-0001',
    invoice_date: '2026-03-01',
    due_date: '2026-04-01',
    invoice_type: 'field_application',
    status: 'posted',
    customer_name: 'Smith Farm',
    customer_email: 'john@smith.com',
    customer_phone: '555-1234',
    customer_address: '123 Farm Rd',
    customer_city: 'Robinson',
    customer_state: 'IL',
    customer_zip: '62454',
    account_number: 'ACC-001',
    salesman_name: 'Mason Wells',
    payment_terms: 'Net 30',
    items: [makeItem()],
    total_amount_cents: 18500,
    total_cost_cents: 12000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 18500,
    crop_type: 'corn',
    field_names: ['North 40', 'South 80'],
    total_acres: 120,
    applicator_name: 'Driver Test',
    vehicle_name: 'Truck 1',
    application_date: '2026-03-01',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('generateInvoicePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('returns a jsPDF document for field_application layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'field_application' }));
    expect(doc).toBe(mockDoc);
  });

  it('returns a jsPDF document for chemical_sale layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'chemical_sale' }));
    expect(doc).toBe(mockDoc);
  });

  it('returns a jsPDF document for misc_charge layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'misc_charge' }));
    expect(doc).toBe(mockDoc);
  });

  it('renders company header "CROP RX SOLUTIONS"', async () => {
    await generateInvoicePdf(makeInvoiceData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders customer name', async () => {
    await generateInvoicePdf(makeInvoiceData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasCustomer = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('SMITH FARM'),
    );
    expect(hasCustomer).toBe(true);
  });

  it('renders invoice number', async () => {
    await generateInvoicePdf(makeInvoiceData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'INV-2026-0001',
      expect.any(Number),
      expect.any(Number),
      expect.anything(),
    );
  });

  it('handles empty items array', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ items: [] }));
    expect(doc).toBe(mockDoc);
  });

  it('handles items with null optional fields', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      items: [makeItem({
        rate_per_acre: null,
        rate_unit: null,
        acres: null,
        total_applied: null,
        total_applied_unit: null,
        total_applied_gl_lb: null,
        gl_lb_unit: null,
        epa_registration: null,
        cost_cents: undefined,
        product_form: null,
      })],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles field_application with shares', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      shares: [
        makeShare({ customer_name: 'Smith Farm', split_percentage: 50, amount_cents: 9250 }),
        makeShare({ customer_name: 'Jones Farm', split_percentage: 50, amount_cents: 9250 }),
      ],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles field_application with finance charges', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      finance_charge_cents: 1500,
    }));
    expect(doc).toBe(mockDoc);
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasFinanceCharges = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Finance Charges'),
    );
    expect(hasFinanceCharges).toBe(true);
  });

  it('handles customer with null optional fields', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      customer_email: undefined,
      customer_phone: undefined,
      customer_address: undefined,
      customer_city: undefined,
      customer_state: undefined,
      customer_zip: undefined,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles print options (show_shares=false, show_price_per_acre=false, show_epa_registration=false)', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: false, show_price_per_acre: false, show_epa_registration: false },
      shares: [
        makeShare({ customer_name: 'Smith Farm' }),
        makeShare({ customer_name: 'Jones Farm' }),
      ],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles chemical_sale with multiple items', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'chemical_sale',
      items: [
        makeItem({ product_name: 'Atrazine 4L', extended_cents: 18500 }),
        makeItem({ product_name: 'Roundup PowerMax', extended_cents: 24000, unit_price_cents: 2400 }),
        makeItem({ product_name: 'Liberty 280 SL', extended_cents: 31500, unit_price_cents: 3150 }),
      ],
      total_amount_cents: 74000,
      balance_cents: 74000,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles misc_charge with single item', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'misc_charge',
      items: [makeItem({ description: 'Late fee', product_name: 'Late fee', extended_cents: 5000 })],
      total_amount_cents: 5000,
      balance_cents: 5000,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles application fee item', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      items: [makeItem({ is_application_fee: true, description: 'Application Fee', product_name: 'Application Fee' })],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles field_application with all context fields', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      job_number: 'JOB-2026-0010',
      order_number: 'ORD-2026-0005',
      purchase_order_ref: 'PO-REF-123',
      header_notes: 'Applied per customer request on March 1',
      footer_notes: 'Payment due within 30 days. Thank you for your business.',
    }));
    expect(doc).toBe(mockDoc);
    const textCalls = mockDoc.text.mock.calls.flat(Infinity);
    const hasHeaderNote = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Applied per customer request'),
    );
    expect(hasHeaderNote).toBe(true);
  });
});

describe('downloadInvoicePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('calls doc.save with filename containing invoice number', async () => {
    await downloadInvoicePdf(makeInvoiceData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
    expect(mockDoc.save).toHaveBeenCalledWith('INV-2026-0001.pdf');
  });
});

describe('generateBatchInvoicePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  it('processes multiple invoices without throwing', async () => {
    const invoices = [
      makeInvoiceData({ invoice_number: 'INV-2026-0001' }),
      makeInvoiceData({
        invoice_number: 'INV-2026-0002',
        invoice_type: 'chemical_sale',
        customer_name: 'Jones Farm',
        total_amount_cents: 32000,
        balance_cents: 32000,
      }),
    ];
    const doc = await generateBatchInvoicePdf(invoices);
    expect(doc).toBeDefined();
    expect(mockDoc.save).toHaveBeenCalled();
  });
});
