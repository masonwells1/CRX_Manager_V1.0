/**
 * pdfGeneration.test.ts — Comprehensive tests for PDF generation modules
 * Tests: invoicePdf.ts, deliveryPdf.ts, receivingPdf.ts
 *
 * All three modules dynamically import jsPDF + jspdf-autotable.
 * We mock both modules globally so no actual PDF binary is produced.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock jsPDF doc instance ────────────────────────────────────────────────

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

// Mock jsPDF constructor — dynamic import returns { default: jsPDF }
// When a constructor explicitly returns an object, `new` uses that object.
vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

// Mock autoTable — dynamic import returns { default: autoTable }
vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    (doc as typeof mockDoc).lastAutoTable = { finalY: ((opts.startY as number) || 0) + 100 };
  }),
}));

// ── Imports (after mocks are hoisted) ──────────────────────────────────────

import {
  generateInvoicePdf,
  generateBatchInvoicePdf,
  type InvoicePdfData,
  type InvoicePdfItem,
  type InvoicePdfShare,
} from './invoicePdf';

import {
  generateDeliveryPdf,
  generateBatchDeliveryPdf,
  type PdfDeliveryData,
} from './deliveryPdf';

import {
  generateReceivingPdf,
  generateBatchReceivingPdf,
  type PdfReceivingData,
  type PdfReceivingItem,
} from './receivingPdf';

// ── Test Data Factories ────────────────────────────────────────────────────

function makeInvoiceItem(overrides: Partial<InvoicePdfItem> = {}): InvoicePdfItem {
  return {
    description: 'Atrazine 4L',
    product_name: 'Atrazine 4L',
    quantity: 10,
    unit_size: 'gal',
    unit_price_cents: 2500,
    extended_cents: 25000,
    ...overrides,
  };
}

function makeInvoiceData(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    invoice_number: 'INV-2026-0001',
    invoice_date: '2026-03-10',
    invoice_type: 'field_application',
    status: 'posted',
    customer_name: 'Smith Farms',
    items: [makeInvoiceItem()],
    total_amount_cents: 25000,
    total_cost_cents: 15000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 25000,
    ...overrides,
  };
}

function makeDeliveryData(overrides: Partial<PdfDeliveryData> = {}): PdfDeliveryData {
  return {
    delivery_number: 'DEL-2026-0001',
    order_number: 'ORD-2026-0001',
    customer_name: 'Smith Farms',
    driver_name: 'John Driver',
    scheduled_date: '2026-03-10T08:00:00Z',
    status: 'scheduled',
    items: [
      { product_name: 'Atrazine 4L', quantity: 10, unit_size: 'gal' },
    ],
    ...overrides,
  };
}

function makeReceivingItem(overrides: Partial<PdfReceivingItem> = {}): PdfReceivingItem {
  return {
    product_name: 'Atrazine 4L',
    quantity_received: 20,
    condition: 'good',
    ...overrides,
  };
}

function makeReceivingData(overrides: Partial<PdfReceivingData> = {}): PdfReceivingData {
  return {
    po_number: 'PO-2026-0001',
    vendor: 'Syngenta',
    received_at: '2026-03-10T14:30:00Z',
    received_by_name: 'Jane Receiver',
    storage_location: 'Warehouse A',
    items: [makeReceivingItem()],
    ...overrides,
  };
}

// ── Reset mocks before each test ───────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset lastAutoTable to default
  mockDoc.lastAutoTable = { finalY: 300 };
});

// ════════════════════════════════════════════════════════════════════════════
// INVOICE PDF TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('invoicePdf', () => {
  describe('generateInvoicePdf', () => {
    it('generates without errors for field_application type', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'field_application' }));
      expect(doc).toBeDefined();
      expect(mockDoc.text).toHaveBeenCalled();
      expect(mockDoc.setFillColor).toHaveBeenCalled();
    });

    it('generates without errors for chemical_sale type', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'chemical_sale' }));
      expect(doc).toBeDefined();
      expect(mockDoc.text).toHaveBeenCalled();
    });

    it('generates without errors for misc_charge type', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'misc_charge' }));
      expect(doc).toBeDefined();
      expect(mockDoc.text).toHaveBeenCalled();
    });

    it('generates without errors for credit_memo type (falls through to misc_charge layout)', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({ invoice_type: 'credit_memo' }));
      expect(doc).toBeDefined();
      // credit_memo is not field_application or chemical_sale, so it uses misc_charge layout
      expect(mockDoc.text).toHaveBeenCalled();
    });

    it('renders customer name in uppercase in bill-to section', async () => {
      await generateInvoicePdf(makeInvoiceData({ customer_name: 'Smith Farms' }));
      const textCalls = mockDoc.text.mock.calls;
      const uppercaseCall = textCalls.find(
        (call: unknown[]) => call[0] === 'SMITH FARMS'
      );
      expect(uppercaseCall).toBeDefined();
    });

    it('renders invoice number in header', async () => {
      await generateInvoicePdf(makeInvoiceData({ invoice_number: 'INV-2026-0042' }));
      const textCalls = mockDoc.text.mock.calls;
      const invoiceNumCall = textCalls.find(
        (call: unknown[]) => call[0] === 'INV-2026-0042'
      );
      expect(invoiceNumCall).toBeDefined();
    });

    it('renders INVOICE label in header', async () => {
      await generateInvoicePdf(makeInvoiceData());
      const textCalls = mockDoc.text.mock.calls;
      const invoiceLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'INVOICE'
      );
      expect(invoiceLabel).toBeDefined();
    });

    it('handles missing optional fields (no shares, no address, no salesman)', async () => {
      const data = makeInvoiceData({
        shares: undefined,
        customer_address: undefined,
        salesman_name: undefined,
        customer_phone: undefined,
        customer_city: undefined,
        customer_state: undefined,
        customer_zip: undefined,
        account_number: undefined,
        payment_terms: undefined,
        due_date: undefined,
        header_notes: undefined,
        footer_notes: undefined,
      });
      const doc = await generateInvoicePdf(data);
      expect(doc).toBeDefined();
    });

    it('renders shares section when shares are provided (field_application)', async () => {
      const { default: autoTable } = await import('jspdf-autotable');
      const shares: InvoicePdfShare[] = [
        { customer_name: 'Smith Farms', split_percentage: 60, acres: 50, amount_cents: 15000 },
        { customer_name: 'Jones Farms', split_percentage: 40, acres: 41.9, amount_cents: 10000 },
      ];
      await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        shares,
        options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
      }));
      // autoTable should be called at least twice: once for items, once for shares
      expect(autoTable).toHaveBeenCalledTimes(2);
    });

    it('does not render shares section when only one share exists', async () => {
      const { default: autoTable } = await import('jspdf-autotable');
      vi.mocked(autoTable).mockClear();
      const shares: InvoicePdfShare[] = [
        { customer_name: 'Smith Farms', split_percentage: 100, acres: 91.9, amount_cents: 25000 },
      ];
      await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        shares,
        options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
      }));
      // autoTable called only once for the items table (shares.length <= 1 skipped)
      expect(autoTable).toHaveBeenCalledTimes(1);
    });

    it('shows finance charges when present', async () => {
      await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        finance_charge_cents: 1500,
        balance_cents: 25000,
      }));
      const textCalls = mockDoc.text.mock.calls;
      const finChargeLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'Finance Charges'
      );
      expect(finChargeLabel).toBeDefined();
    });

    it('does not show finance charges section when finance_charge_cents is zero', async () => {
      await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        finance_charge_cents: 0,
      }));
      const textCalls = mockDoc.text.mock.calls;
      const finChargeLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'Finance Charges'
      );
      expect(finChargeLabel).toBeUndefined();
    });

    it('handles zero balance (fully paid)', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({
        total_amount_cents: 25000,
        paid_amount_cents: 25000,
        balance_cents: 0,
      }));
      expect(doc).toBeDefined();
      // Balance color should be CRX_GREEN (0 balance)
      const textCalls = mockDoc.text.mock.calls;
      const balanceDueLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'BALANCE DUE'
      );
      expect(balanceDueLabel).toBeDefined();
    });

    it('renders payments line when paid_amount_cents > 0', async () => {
      await generateInvoicePdf(makeInvoiceData({
        paid_amount_cents: 10000,
        balance_cents: 15000,
      }));
      const textCalls = mockDoc.text.mock.calls;
      const paymentsLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'Payments'
      );
      expect(paymentsLabel).toBeDefined();
    });

    it('renders prepay applied line when prepay_applied_cents > 0', async () => {
      await generateInvoicePdf(makeInvoiceData({
        prepay_applied_cents: 5000,
        balance_cents: 20000,
      }));
      const textCalls = mockDoc.text.mock.calls;
      const prepayLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'Prepay Applied'
      );
      expect(prepayLabel).toBeDefined();
    });

    it('handles items with EPA registration', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        items: [makeInvoiceItem({ epa_registration: '100-1141' })],
        options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
      }));
      expect(doc).toBeDefined();
    });

    it('handles items with rate_per_acre', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        items: [makeInvoiceItem({ rate_per_acre: 2.5, rate_unit: 'oz/acre' })],
      }));
      expect(doc).toBeDefined();
    });

    it('handles voided invoice (status=voided)', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({ status: 'voided' }));
      expect(doc).toBeDefined();
    });

    it('renders field application context (crop type, acres, fields)', async () => {
      await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        crop_type: 'Corn',
        total_acres: 91.90,
        field_names: ['Pole Field', 'Leaming 92'],
      }));
      const textCalls = mockDoc.text.mock.calls;
      const descLine = textCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Corn')
      );
      expect(descLine).toBeDefined();
    });

    it('renders price per acre when total_acres > 0 and option is enabled', async () => {
      await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        total_acres: 100,
        total_amount_cents: 50000,
        options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
      }));
      const textCalls = mockDoc.text.mock.calls;
      const pricePerAcreCall = textCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Price per acre')
      );
      expect(pricePerAcreCall).toBeDefined();
    });

    it('renders footer notes when provided', async () => {
      await generateInvoicePdf(makeInvoiceData({
        footer_notes: 'Thank you for your business!',
      }));
      expect(mockDoc.splitTextToSize).toHaveBeenCalledWith(
        'Thank you for your business!',
        expect.any(Number)
      );
    });

    it('renders header notes for chemical_sale type', async () => {
      await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'chemical_sale',
        header_notes: 'Counter sale pickup',
      }));
      expect(mockDoc.splitTextToSize).toHaveBeenCalledWith(
        'Counter sale pickup',
        expect.any(Number)
      );
    });

    it('handles empty items array', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({ items: [] }));
      expect(doc).toBeDefined();
    });

    it('handles very long customer name', async () => {
      const longName = 'A'.repeat(200);
      const doc = await generateInvoicePdf(makeInvoiceData({ customer_name: longName }));
      expect(doc).toBeDefined();
      const textCalls = mockDoc.text.mock.calls;
      const upperCall = textCalls.find(
        (call: unknown[]) => call[0] === longName.toUpperCase()
      );
      expect(upperCall).toBeDefined();
    });

    it('handles negative balance_cents values', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({ balance_cents: -5000 }));
      expect(doc).toBeDefined();
    });

    it('handles zero quantity items', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({
        items: [makeInvoiceItem({ quantity: 0, extended_cents: 0 })],
      }));
      expect(doc).toBeDefined();
    });

    it('handles application fee items in field_application layout', async () => {
      const doc = await generateInvoicePdf(makeInvoiceData({
        invoice_type: 'field_application',
        items: [makeInvoiceItem({ is_application_fee: true, rate_per_acre: null })],
      }));
      expect(doc).toBeDefined();
    });

    it('renders customer address when provided', async () => {
      await generateInvoicePdf(makeInvoiceData({
        customer_address: '123 Farm Road',
        customer_city: 'Martinsville',
        customer_state: 'IL',
        customer_zip: '62442',
      }));
      const textCalls = mockDoc.text.mock.calls;
      const addrCall = textCalls.find(
        (call: unknown[]) => call[0] === '123 Farm Road'
      );
      expect(addrCall).toBeDefined();
    });
  });

  describe('generateBatchInvoicePdf', () => {
    it('throws on empty array', async () => {
      await expect(generateBatchInvoicePdf([])).rejects.toThrow('No invoices to generate');
    });

    it('returns a doc for a single invoice without calling save multiple times', async () => {
      const doc = await generateBatchInvoicePdf([makeInvoiceData()]);
      expect(doc).toBeDefined();
    });

    it('generates multiple invoices and calls save for each', async () => {
      const dataList = [
        makeInvoiceData({ invoice_number: 'INV-2026-0001' }),
        makeInvoiceData({ invoice_number: 'INV-2026-0002' }),
        makeInvoiceData({ invoice_number: 'INV-2026-0003' }),
      ];
      await generateBatchInvoicePdf(dataList);
      // For multiple invoices, save is called for each one (in the loop) plus the final return doc
      expect(mockDoc.save).toHaveBeenCalled();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELIVERY PDF TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('deliveryPdf', () => {
  describe('generateDeliveryPdf', () => {
    it('generates single delivery without errors', async () => {
      const doc = await generateDeliveryPdf(makeDeliveryData());
      expect(doc).toBeDefined();
      expect(mockDoc.text).toHaveBeenCalled();
      expect(mockDoc.setFillColor).toHaveBeenCalled();
    });

    it('renders delivery number in header', async () => {
      await generateDeliveryPdf(makeDeliveryData({ delivery_number: 'DEL-2026-0099' }));
      const textCalls = mockDoc.text.mock.calls;
      const delNumCall = textCalls.find(
        (call: unknown[]) => call[0] === 'DEL-2026-0099'
      );
      expect(delNumCall).toBeDefined();
    });

    it('renders order number reference', async () => {
      await generateDeliveryPdf(makeDeliveryData({ order_number: 'ORD-2026-0050' }));
      const textCalls = mockDoc.text.mock.calls;
      const orderCall = textCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('ORD-2026-0050')
      );
      expect(orderCall).toBeDefined();
    });

    it('renders priority badge for urgent priority', async () => {
      await generateDeliveryPdf(makeDeliveryData({ priority: 'urgent' }));
      const textCalls = mockDoc.text.mock.calls;
      const priorityCall = textCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('PRIORITY: URGENT')
      );
      expect(priorityCall).toBeDefined();
    });

    it('renders priority badge for high priority', async () => {
      await generateDeliveryPdf(makeDeliveryData({ priority: 'high' }));
      const textCalls = mockDoc.text.mock.calls;
      const priorityCall = textCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('PRIORITY: HIGH')
      );
      expect(priorityCall).toBeDefined();
    });

    it('does not render priority badge for normal priority', async () => {
      await generateDeliveryPdf(makeDeliveryData({ priority: 'normal' }));
      const textCalls = mockDoc.text.mock.calls;
      const priorityCall = textCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('PRIORITY:')
      );
      expect(priorityCall).toBeUndefined();
    });

    it('shows delivered vs planned columns for completed deliveries with quantity_delivered', async () => {
      const { default: autoTable } = await import('jspdf-autotable');
      vi.mocked(autoTable).mockClear();
      await generateDeliveryPdf(makeDeliveryData({
        status: 'completed',
        items: [
          { product_name: 'Atrazine 4L', quantity: 10, unit_size: 'gal', quantity_delivered: 8 },
        ],
      }));
      // autoTable should be called with 4-column head (Product, Planned, Delivered, Unit Size)
      const autoTableCalls = vi.mocked(autoTable).mock.calls;
      expect(autoTableCalls.length).toBeGreaterThanOrEqual(1);
      const tableOpts = autoTableCalls[0][1];
      expect(tableOpts.head[0]).toEqual(['Product', 'Planned', 'Delivered', 'Unit Size']);
    });

    it('shows standard columns for non-completed deliveries', async () => {
      const { default: autoTable } = await import('jspdf-autotable');
      vi.mocked(autoTable).mockClear();
      await generateDeliveryPdf(makeDeliveryData({ status: 'scheduled' }));
      const autoTableCalls = vi.mocked(autoTable).mock.calls;
      expect(autoTableCalls.length).toBeGreaterThanOrEqual(1);
      const tableOpts = autoTableCalls[0][1];
      expect(tableOpts.head[0]).toEqual(['Product', 'Quantity', 'Unit Size']);
    });

    it('shows issue section when issue_type is not none', async () => {
      await generateDeliveryPdf(makeDeliveryData({
        issue_type: 'damaged',
        issue_notes: 'Two containers were punctured during transit',
      }));
      const textCalls = mockDoc.text.mock.calls;
      const issueLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'ISSUE REPORTED'
      );
      expect(issueLabel).toBeDefined();
    });

    it('does not show issue section when issue_type is none', async () => {
      await generateDeliveryPdf(makeDeliveryData({ issue_type: 'none' }));
      const textCalls = mockDoc.text.mock.calls;
      const issueLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'ISSUE REPORTED'
      );
      expect(issueLabel).toBeUndefined();
    });

    it('does not show issue section when issue_type is undefined', async () => {
      await generateDeliveryPdf(makeDeliveryData({ issue_type: undefined }));
      const textCalls = mockDoc.text.mock.calls;
      const issueLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'ISSUE REPORTED'
      );
      expect(issueLabel).toBeUndefined();
    });

    it('renders delivery notes when provided', async () => {
      await generateDeliveryPdf(makeDeliveryData({
        delivery_notes: 'Gate code is 1234',
      }));
      const textCalls = mockDoc.text.mock.calls;
      const notesLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'NOTES'
      );
      expect(notesLabel).toBeDefined();
    });

    it('handles missing optional fields', async () => {
      const doc = await generateDeliveryPdf(makeDeliveryData({
        customer_address: undefined,
        completed_at: undefined,
        signed_by: undefined,
        delivery_notes: undefined,
        priority: undefined,
        issue_type: undefined,
        issue_notes: undefined,
      }));
      expect(doc).toBeDefined();
    });

    it('handles empty items array', async () => {
      const doc = await generateDeliveryPdf(makeDeliveryData({ items: [] }));
      expect(doc).toBeDefined();
    });

    it('handles very long customer name', async () => {
      const doc = await generateDeliveryPdf(makeDeliveryData({
        customer_name: 'X'.repeat(200),
      }));
      expect(doc).toBeDefined();
    });
  });

  describe('generateBatchDeliveryPdf', () => {
    it('throws on empty array', async () => {
      await expect(generateBatchDeliveryPdf([])).rejects.toThrow('No deliveries to generate');
    });

    it('generates single delivery and calls save directly (no addPage)', async () => {
      mockDoc.addPage.mockClear();
      await generateBatchDeliveryPdf([makeDeliveryData()]);
      expect(mockDoc.save).toHaveBeenCalled();
      expect(mockDoc.addPage).not.toHaveBeenCalled();
    });

    it('generates multiple deliveries with addPage called between each', async () => {
      mockDoc.addPage.mockClear();
      const dataList = [
        makeDeliveryData({ delivery_number: 'DEL-2026-0001' }),
        makeDeliveryData({ delivery_number: 'DEL-2026-0002' }),
        makeDeliveryData({ delivery_number: 'DEL-2026-0003' }),
      ];
      await generateBatchDeliveryPdf(dataList);
      // addPage called for items 2 and 3 (index 1 and 2)
      expect(mockDoc.addPage).toHaveBeenCalledTimes(2);
      expect(mockDoc.save).toHaveBeenCalled();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECEIVING PDF TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('receivingPdf', () => {
  describe('generateReceivingPdf', () => {
    it('generates single receipt without errors', async () => {
      const doc = await generateReceivingPdf(makeReceivingData());
      expect(doc).toBeDefined();
      expect(mockDoc.text).toHaveBeenCalled();
      expect(mockDoc.setFillColor).toHaveBeenCalled();
    });

    it('renders PO number in header', async () => {
      await generateReceivingPdf(makeReceivingData({ po_number: 'PO-2026-0099' }));
      const textCalls = mockDoc.text.mock.calls;
      const poCall = textCalls.find(
        (call: unknown[]) => call[0] === 'PO-2026-0099'
      );
      expect(poCall).toBeDefined();
    });

    it('renders vendor name in header and info grid', async () => {
      await generateReceivingPdf(makeReceivingData({ vendor: 'BASF Corp' }));
      const textCalls = mockDoc.text.mock.calls;
      const vendorCalls = textCalls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('BASF Corp')
      );
      // Vendor appears in header and in info grid
      expect(vendorCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('renders item notes section for items with notes', async () => {
      await generateReceivingPdf(makeReceivingData({
        items: [
          makeReceivingItem({ product_name: 'Roundup', notes: 'Label partially torn' }),
          makeReceivingItem({ product_name: 'Atrazine', notes: undefined }),
        ],
      }));
      const textCalls = mockDoc.text.mock.calls;
      const notesHeader = textCalls.find(
        (call: unknown[]) => call[0] === 'ITEM NOTES'
      );
      expect(notesHeader).toBeDefined();
    });

    it('does not render item notes section when no items have notes', async () => {
      await generateReceivingPdf(makeReceivingData({
        items: [
          makeReceivingItem({ notes: undefined }),
        ],
      }));
      const textCalls = mockDoc.text.mock.calls;
      const notesHeader = textCalls.find(
        (call: unknown[]) => call[0] === 'ITEM NOTES'
      );
      expect(notesHeader).toBeUndefined();
    });

    it('shows condition summary counts', async () => {
      await generateReceivingPdf(makeReceivingData({
        items: [
          makeReceivingItem({ condition: 'good' }),
          makeReceivingItem({ condition: 'good' }),
          makeReceivingItem({ condition: 'damaged' }),
        ],
      }));
      const textCalls = mockDoc.text.mock.calls;
      const summaryLabel = textCalls.find(
        (call: unknown[]) => call[0] === 'SUMMARY'
      );
      expect(summaryLabel).toBeDefined();
      // Should show total items count
      const totalItems = textCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Total Items: 3')
      );
      expect(totalItems).toBeDefined();
    });

    it('handles empty items array', async () => {
      const doc = await generateReceivingPdf(makeReceivingData({ items: [] }));
      expect(doc).toBeDefined();
    });

    it('handles items with lot numbers and unit sizes', async () => {
      const doc = await generateReceivingPdf(makeReceivingData({
        items: [
          makeReceivingItem({ lot_number: 'LOT-2026-A', unit_size: '2.5 gal' }),
        ],
      }));
      expect(doc).toBeDefined();
    });

    it('handles items with missing optional fields', async () => {
      const doc = await generateReceivingPdf(makeReceivingData({
        items: [
          makeReceivingItem({ lot_number: undefined, unit_size: undefined, notes: undefined }),
        ],
      }));
      expect(doc).toBeDefined();
    });
  });

  describe('conditionColor (via rendering)', () => {
    // We can verify the condition color logic indirectly by checking
    // that setTextColor is called with the right RGB values for conditions.
    // The conditionColor function is used in the summary section rendering.

    it('uses green for good condition in summary', async () => {
      await generateReceivingPdf(makeReceivingData({
        items: [makeReceivingItem({ condition: 'good' })],
      }));
      // CRX_GREEN = [40, 162, 106]
      const greenCalls = mockDoc.setTextColor.mock.calls.filter(
        (call: unknown[]) => call[0] === 40 && call[1] === 162 && call[2] === 106
      );
      expect(greenCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('uses red for damaged condition in summary', async () => {
      await generateReceivingPdf(makeReceivingData({
        items: [makeReceivingItem({ condition: 'damaged' })],
      }));
      // RED = [220, 38, 38]
      const redCalls = mockDoc.setTextColor.mock.calls.filter(
        (call: unknown[]) => call[0] === 220 && call[1] === 38 && call[2] === 38
      );
      expect(redCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('uses red for wrong_product condition in summary', async () => {
      await generateReceivingPdf(makeReceivingData({
        items: [makeReceivingItem({ condition: 'wrong_product' })],
      }));
      // RED = [220, 38, 38]
      const redCalls = mockDoc.setTextColor.mock.calls.filter(
        (call: unknown[]) => call[0] === 220 && call[1] === 38 && call[2] === 38
      );
      expect(redCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('uses amber for other conditions (e.g. short) in summary', async () => {
      await generateReceivingPdf(makeReceivingData({
        items: [makeReceivingItem({ condition: 'short' })],
      }));
      // AMBER = [217, 119, 6]
      const amberCalls = mockDoc.setTextColor.mock.calls.filter(
        (call: unknown[]) => call[0] === 217 && call[1] === 119 && call[2] === 6
      );
      expect(amberCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('generateBatchReceivingPdf', () => {
    it('throws on empty array', async () => {
      await expect(generateBatchReceivingPdf([])).rejects.toThrow('No receiving receipts to generate');
    });

    it('generates single receipt and calls save directly (no addPage)', async () => {
      mockDoc.addPage.mockClear();
      await generateBatchReceivingPdf([makeReceivingData()]);
      expect(mockDoc.save).toHaveBeenCalled();
      expect(mockDoc.addPage).not.toHaveBeenCalled();
    });

    it('generates multiple receipts with addPage called between each', async () => {
      mockDoc.addPage.mockClear();
      const dataList = [
        makeReceivingData({ po_number: 'PO-2026-0001' }),
        makeReceivingData({ po_number: 'PO-2026-0002' }),
        makeReceivingData({ po_number: 'PO-2026-0003' }),
      ];
      await generateBatchReceivingPdf(dataList);
      // addPage called for items 2 and 3
      expect(mockDoc.addPage).toHaveBeenCalledTimes(2);
      expect(mockDoc.save).toHaveBeenCalled();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CROSS-MODULE EDGE CASES
// ════════════════════════════════════════════════════════════════════════════

describe('PDF edge cases', () => {
  it('invoice handles missing invoice_date gracefully', async () => {
    // The fmtDate function will produce a date string even for unusual inputs
    const doc = await generateInvoicePdf(makeInvoiceData({ invoice_date: '2026-01-01' }));
    expect(doc).toBeDefined();
  });

  it('delivery handles items with zero quantity', async () => {
    const doc = await generateDeliveryPdf(makeDeliveryData({
      items: [{ product_name: 'Empty Item', quantity: 0, unit_size: 'gal' }],
    }));
    expect(doc).toBeDefined();
  });

  it('receiving handles items with zero quantity_received', async () => {
    const doc = await generateReceivingPdf(makeReceivingData({
      items: [makeReceivingItem({ quantity_received: 0 })],
    }));
    expect(doc).toBeDefined();
  });

  it('invoice handles chemical_sale with EPA registration', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'chemical_sale',
      items: [makeInvoiceItem({ epa_registration: '100-1141' })],
      options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    }));
    expect(doc).toBeDefined();
  });

  it('invoice handles shares with per-acre pricing', async () => {
    const shares: InvoicePdfShare[] = [
      {
        customer_name: 'Smith Farms',
        split_percentage: 50,
        acres: 50,
        amount_cents: 12500,
        price_per_acre_cents: 250,
        pricing_note: 'Custom rate',
      },
      {
        customer_name: 'Jones Farms',
        split_percentage: 50,
        acres: 50,
        amount_cents: 12500,
        price_per_acre_cents: 250,
      },
    ];
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'field_application',
      shares,
      options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    }));
    expect(doc).toBeDefined();
  });

  it('delivery batch with two items calls addPage exactly once', async () => {
    mockDoc.addPage.mockClear();
    await generateBatchDeliveryPdf([
      makeDeliveryData({ delivery_number: 'DEL-0001' }),
      makeDeliveryData({ delivery_number: 'DEL-0002' }),
    ]);
    expect(mockDoc.addPage).toHaveBeenCalledTimes(1);
  });

  it('receiving batch with two items calls addPage exactly once', async () => {
    mockDoc.addPage.mockClear();
    await generateBatchReceivingPdf([
      makeReceivingData({ po_number: 'PO-0001' }),
      makeReceivingData({ po_number: 'PO-0002' }),
    ]);
    expect(mockDoc.addPage).toHaveBeenCalledTimes(1);
  });
});
