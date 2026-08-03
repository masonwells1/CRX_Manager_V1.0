/**
 * statementPdf.test.ts — Tests for customer statement PDF generation
 * Uses the same jsPDF/autoTable mock pattern as pdfGeneration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  DetailedStatementData,
  DetailedStatementTransaction,
  DetailedStatementItem,
  InvoiceShare,
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

import {
  generateStatementPdf,
  downloadStatementPdf,
  generateBatchStatementsPdf,
} from './statementPdf';

// ── Test Data Factories ─────────────────────────────────────────────────

function makeItem(overrides: Partial<DetailedStatementItem> = {}): DetailedStatementItem {
  return {
    product_name: 'Atrazine 4L',
    epa_registration: '100-497',
    rate_per_acre: 2.0,
    rate_unit: 'QT',
    total_applied: 200,
    total_applied_unit: 'QT',
    total_applied_gl_lb: 50,
    gl_lb_unit: 'GL',
    unit_price_cents: 1850,
    total_cost_cents: 18500,
    is_application_fee: false,
    quantity: 10,
    unit_size: 'gal',
    product_form: 'liquid',
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<DetailedStatementTransaction> = {}): DetailedStatementTransaction {
  return {
    invoice_number: 'INV-2026-001',
    invoice_date: '2026-03-01',
    due_date: '2026-04-01',
    invoice_type: 'standard',
    status: 'posted',
    days_aged: 15,
    description: 'Spring application',
    crop_type: 'corn',
    field_names: ['North 40'],
    grower_names: null,
    total_acres: 100,
    total_amount_cents: 50000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 50000,
    items: [makeItem()],
    shares: [],
    finance_charge_cents: 0,
    net_due_cents: 50000,
    price_per_acre: 5.0,
    ...overrides,
  };
}

function makeStatementData(overrides: Partial<DetailedStatementData> = {}): DetailedStatementData {
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
      payment_terms: 'Net 30',
    },
    transactions: [makeTransaction()],
    aging: {
      current_cents: 50000,
      days_30_cents: 0,
      days_60_cents: 0,
      days_90_cents: 0,
      over_120_cents: 0,
    },
    outstanding_balance_cents: 50000,
    open_credit_cents: 0,
    net_account_position_cents: 50000,
    as_of_date: '2026-03-15',
    mode: 'summary',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('generateStatementPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('returns a jsPDF document for summary mode', async () => {
    const doc = await generateStatementPdf(makeStatementData({ mode: 'summary' }));
    expect(doc).toBe(mockDoc);
  });

  it('returns a jsPDF document for detailed mode', async () => {
    const doc = await generateStatementPdf(makeStatementData({ mode: 'detailed' }));
    expect(doc).toBe(mockDoc);
  });

  it('renders company header', async () => {
    await generateStatementPdf(makeStatementData());
    expect(mockDoc.text).toHaveBeenCalledWith(
      'CROP RX SOLUTIONS',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('renders customer name', async () => {
    await generateStatementPdf(makeStatementData());
    const textCalls = mockDoc.text.mock.calls.flat();
    const hasCustomer = textCalls.some((arg: unknown) =>
      typeof arg === 'string' && arg.includes('Smith Farm')
    );
    expect(hasCustomer).toBe(true);
  });

  it('handles empty transactions', async () => {
    const doc = await generateStatementPdf(makeStatementData({ transactions: [] }));
    expect(doc).toBe(mockDoc);
  });

  it('handles transactions with finance charges', async () => {
    const doc = await generateStatementPdf(makeStatementData({
      mode: 'detailed',
      transactions: [makeTransaction({
        balance_cents: 50000,
        finance_charge_cents: 1500,
        net_due_cents: 50000,
      })],
    }));
    expect(doc).toBe(mockDoc);
    expect(mockDoc.text).toHaveBeenCalledWith('Finance Charges', expect.any(Number), expect.any(Number));
    expect(mockDoc.text).toHaveBeenCalledWith('$15.00', expect.any(Number), expect.any(Number), { align: 'right' });
    expect(mockDoc.text).not.toHaveBeenCalledWith('$515.00', expect.any(Number), expect.any(Number), { align: 'right' });
  });

  it('labels gross invoices, credits, and net account position separately', async () => {
    await generateStatementPdf(makeStatementData({
      outstanding_balance_cents: 50000,
      open_credit_cents: 12500,
      net_account_position_cents: 37500,
    }));

    const labels = mockDoc.text.mock.calls.map(([value]) => value);
    expect(labels).toContain('GROSS OPEN INVOICES');
    expect(labels).toContain('Gross Open Invoices:');
    expect(labels).toContain('Unapplied Credits:');
    expect(labels).toContain('Net Account Position:');
    expect(labels).not.toContain('BALANCE DUE');
    expect(labels).not.toContain('Total Outstanding:');
  });

  it('handles transactions with shares', async () => {
    const share: InvoiceShare = {
      id: 'share-1',
      invoice_id: 'inv-1',
      customer_id: 'cust-2',
      customer_name: 'Jones Farm',
      split_percentage: 50,
      acres: 50,
      amount_cents: 25000,
      is_primary: false,
      sort_order: 0,
      price_per_acre_cents: 500,
      pricing_note: '50/50 split',
      created_at: '',
    };
    const doc = await generateStatementPdf(makeStatementData({
      mode: 'detailed',
      transactions: [makeTransaction({ shares: [share] })],
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles customer with null optional fields', async () => {
    const doc = await generateStatementPdf(makeStatementData({
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
        payment_terms: null,
      },
    }));
    expect(doc).toBe(mockDoc);
  });

  it('handles aging with all buckets populated', async () => {
    const doc = await generateStatementPdf(makeStatementData({
      aging: {
        current_cents: 10000,
        days_30_cents: 20000,
        days_60_cents: 15000,
        days_90_cents: 5000,
        over_120_cents: 2000,
      },
      outstanding_balance_cents: 52000,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('respects statement options', async () => {
    const doc = await generateStatementPdf(
      makeStatementData({ mode: 'detailed' }),
      { mode: 'summary', show_shares: false, as_of_date: '2026-03-15' },
    );
    expect(doc).toBe(mockDoc);
  });
});

describe('downloadStatementPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('calls doc.save', async () => {
    await downloadStatementPdf(makeStatementData());
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });
});

describe('generateBatchStatementsPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('generates batch with multiple statements', async () => {
    const statements = [
      makeStatementData(),
      makeStatementData({
        customer: {
          id: 'cust-2',
          farm_name: 'Jones Farm',
          contact_name: 'Bob Jones',
          account_number: 'ACC-002',
          email: null,
          phone: null,
          billing_address: null,
          city: null,
          state: null,
          zip: null,
          payment_terms: null,
        },
      }),
    ];
    const doc = await generateBatchStatementsPdf(statements);
    expect(doc).toBe(mockDoc);
  });
});
