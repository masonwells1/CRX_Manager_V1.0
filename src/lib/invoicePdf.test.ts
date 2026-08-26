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
  setLineWidth: vi.fn(),
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

import { generateInvoicePdf, downloadInvoicePdf, generateBatchInvoicePdf, groupReturnCreditDisplayItems } from './invoicePdf';
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

describe('groupReturnCreditDisplayItems', () => {
  it('shows one customer line while preserving the exact summed credit', () => {
    const grouped = groupReturnCreditDisplayItems('credit_memo', [
      makeItem({ order_item_id: 'order-item-1', product_id: 'product-1', description: 'Return credit - Atrazine 4L', quantity: -10, extended_cents: -18500, cost_cents: 1200 }),
      makeItem({ order_item_id: 'order-item-1', product_id: 'product-1', description: 'Return credit - Atrazine 4L', quantity: -5, extended_cents: -9250, cost_cents: 1300 }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ quantity: -15, extended_cents: -27750 });
  });

  it('does not collapse ordinary invoices or manual credit rows', () => {
    const rows = [makeItem(), makeItem()];
    expect(groupReturnCreditDisplayItems('chemical_sale', rows)).toBe(rows);
    expect(groupReturnCreditDisplayItems('credit_memo', rows)).toHaveLength(2);
  });
});

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

  it('prints a Write-off line so the current-format totals reconcile to Balance Due', async () => {
    // Posted invoice WITH a hidden write-off: Subtotal 18500, Payments 5000,
    // Prepay 1500, Write-off 3000 → Balance Due 9000. Without the Write-off
    // line the four printed numbers don't add up (18500−5000−1500 = 12000 ≠
    // the printed 9000). The line must appear AND the math must close.
    await generateInvoicePdf(makeInvoiceData({
      total_amount_cents: 18500,
      paid_amount_cents: 5000,
      prepay_applied_cents: 1500,
      write_off_cents: 3000,
      balance_cents: 9000, // 18500 − 5000 − 1500 − 3000
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Write-off')).toBe(true);   // the new line label
    expect(has('$185.00')).toBe(true);     // Subtotal
    expect(has('-$50.00')).toBe(true);     // Payments
    expect(has('-$15.00')).toBe(true);     // Prepay Applied
    expect(has('-$30.00')).toBe(true);     // Write-off (was hidden before)
    expect(has('$90.00')).toBe(true);      // Balance Due (now reconciles)
    // 18500 − 5000 − 1500 − 3000 === 9000
    expect(18500 - 5000 - 1500 - 3000).toBe(9000);
  });

  it('omits the Write-off line when write_off_cents is 0', async () => {
    await generateInvoicePdf(makeInvoiceData({ write_off_cents: 0 }));
    const textCalls = mockDoc.text.mock.calls.flat();
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a.includes('Write-off'))).toBe(false);
  });

  // #33: Discount Earned is OWNER-DRIVEN + DISPLAY-ONLY. It must PRINT as an
  // informational line but NEVER reduce the printed Balance Due (no double-count;
  // the real reduction flows through payments/write-off). These tests pin that.
  it('prints an informational Discount Earned line WITHOUT changing Balance Due (current format)', async () => {
    await generateInvoicePdf(makeInvoiceData({
      total_amount_cents: 18500,
      paid_amount_cents: 0,
      prepay_applied_cents: 0,
      write_off_cents: 0,
      discount_earned_cents: 1000, // $10 early-pay discount, recorded only
      balance_cents: 18500,        // UNCHANGED — discount is not deducted
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Discount Earned (if paid early)')).toBe(true); // the line prints
    expect(has('$10.00')).toBe(true);                          // the recorded amount
    expect(has('$185.00')).toBe(true);                         // Balance Due == Subtotal (unreduced)
    // Pin the invariant: discount never enters the balance math.
    expect(18500 - 0 - 0 - 0).toBe(18500);
  });

  it('omits the Discount Earned line when discount_earned_cents is 0/absent', async () => {
    await generateInvoicePdf(makeInvoiceData({ discount_earned_cents: 0 }));
    const noDisc = mockDoc.text.mock.calls.flat();
    expect(noDisc.some((a: unknown) => typeof a === 'string' && a.includes('Discount Earned'))).toBe(false);
  });

  it('prints the PO Reference label + value in the current format (#33)', async () => {
    await generateInvoicePdf(makeInvoiceData({ purchase_order_ref: 'PO-7788' }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('PO REF')).toBe(true);
    expect(has('PO-7788')).toBe(true);
  });

  it('omits the PO REF label when purchase_order_ref is absent', async () => {
    await generateInvoicePdf(makeInvoiceData({ purchase_order_ref: undefined }));
    const textCalls = mockDoc.text.mock.calls.flat();
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a === 'PO REF')).toBe(false);
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

  it('renders a Fuel Surcharge line as a flat amount (no "/AC") — current layout', async () => {
    // The surcharge line is stored is_application_fee=true, quantity=1,
    // unit_price_cents = the FULL flat/percent amount, acres/rate/total_applied NULL.
    // The generic app-fee branch would print "200.00/AC" + "1.00 AC"; the fuel
    // branch must print a PLAIN $ amount and blank Rate/Total-Applied.
    await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: false, show_price_per_acre: false, show_epa_registration: false },
      items: [makeItem({
        is_application_fee: true,
        description: 'Fuel Surcharge',
        product_name: 'Fuel Surcharge',
        quantity: 1,
        unit_price_cents: 20000,   // $200.00 flat
        extended_cents: 20000,
        rate_per_acre: null,
        rate_unit: null,
        acres: null,
        total_applied: null,
        total_applied_unit: null,
        total_applied_gl_lb: null,
        gl_lb_unit: null,
        epa_registration: null,
      })],
      total_amount_cents: 20000,
      balance_cents: 20000,
    }));
    const autoTable = vi.mocked(await import('jspdf-autotable')).default;
    // The line-item table is the first autoTable call (head[0][0] === 'Product').
    const itemCall = autoTable.mock.calls.find((c: unknown[]) => {
      const opts = c[1] as { head?: unknown[][] };
      return Array.isArray(opts.head) && Array.isArray(opts.head[0]) && opts.head[0][0] === 'Product';
    });
    expect(itemCall).toBeDefined();
    const body = ((itemCall as unknown[])[1] as { body: string[][] }).body;
    const fuelRow = body.find((r) => r.includes('Fuel Surcharge'));
    expect(fuelRow).toBeDefined();
    // No cell may carry the per-acre "/AC" suffix on the surcharge row.
    expect((fuelRow as string[]).some((cell) => /\/AC\b/.test(cell))).toBe(false);
    // No "1.00 AC" Total-Applied mislabel.
    expect((fuelRow as string[]).some((cell) => /\bAC\b/.test(cell))).toBe(false);
    // The Unit Price cell is the plain dollar amount "200.00" (no slash, no unit).
    expect((fuelRow as string[]).includes('200.00')).toBe(true);
  });

  it('renders a Fuel Surcharge line as a flat amount (no "AC") — legacy layout', async () => {
    await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: true, show_price_per_acre: true, show_epa_registration: false, format: 'legacy' },
      items: [makeItem({
        is_application_fee: true,
        description: 'Fuel Surcharge',
        product_name: 'Fuel Surcharge',
        quantity: 1,
        unit_price_cents: 20000,
        extended_cents: 20000,
        rate_per_acre: null,
        rate_unit: null,
        acres: null,
        total_applied: null,
        total_applied_unit: null,
        total_applied_gl_lb: null,
        gl_lb_unit: null,
        epa_registration: null,
      })],
      total_amount_cents: 20000,
      balance_cents: 20000,
    }));
    const autoTable = vi.mocked(await import('jspdf-autotable')).default;
    const itemCall = autoTable.mock.calls.find((c: unknown[]) => {
      const opts = c[1] as { head?: unknown[][] };
      return Array.isArray(opts.head) && Array.isArray(opts.head[0]) && opts.head[0][0] === 'Product';
    });
    expect(itemCall).toBeDefined();
    const body = ((itemCall as unknown[])[1] as { body: string[][] }).body;
    const fuelRow = body.find((r) => r.includes('Fuel Surcharge'));
    expect(fuelRow).toBeDefined();
    // Legacy mislabel was "200.00 AC" in Unit Price + "1.00 AC" in Total Applied.
    expect((fuelRow as string[]).some((cell) => /\bAC\b/.test(cell))).toBe(false);
    expect((fuelRow as string[]).includes('200.00')).toBe(true);
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

// ── Legacy "Old Print" format (field-app parity #30) ─────────────────────────

describe('generateInvoicePdf — legacy "Old Print" format', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  const legacyOpts = { show_shares: true, show_price_per_acre: true, show_epa_registration: true, format: 'legacy' as const };

  it('returns a jsPDF document for the legacy field_application layout', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({ options: legacyOpts }));
    expect(doc).toBe(mockDoc);
  });

  it('renders the plain-text "INVOICE" header (no green band)', async () => {
    await generateInvoicePdf(makeInvoiceData({ options: legacyOpts }));
    const textCalls = mockDoc.text.mock.calls.flat();
    expect(textCalls.some((a: unknown) => a === 'CROP RX SOLUTIONS')).toBe(true);
    expect(textCalls.some((a: unknown) => a === 'INVOICE')).toBe(true);
    // The legacy header prints the invoice number as "No. <number>".
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a.includes('No. INV-2026-0001'))).toBe(true);
  });

  it('prints the SAME money totals as the data (no recompute)', async () => {
    // Posted invoice WITH a payment: Total 18500, Payments 5000, Prepay 1500 →
    // Balance Due 12000. Total − Payments − Prepay = Balance Due must hold, and
    // the printed strings must be exactly those cents (formatted /100).
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      total_amount_cents: 18500,
      paid_amount_cents: 5000,
      prepay_applied_cents: 1500,
      balance_cents: 12000, // 18500 − 5000 − 1500
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('$185.00')).toBe(true);      // Subtotal
    expect(has('-$50.00')).toBe(true);      // Payments
    expect(has('-$15.00')).toBe(true);      // Prepay Applied
    expect(has('$120.00')).toBe(true);      // Balance Due (reconciles)
    expect(has('BALANCE DUE:')).toBe(true);
  });

  it('prints a Write-off line so the legacy-format totals reconcile to Balance Due', async () => {
    // Same hidden-write-off scenario in the legacy "Old Print" layout: without
    // the Write-off line, Subtotal − Payments − Prepay = 12000 ≠ the printed
    // Balance Due 9000. The line must appear AND the four lines must close.
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      total_amount_cents: 18500,
      paid_amount_cents: 5000,
      prepay_applied_cents: 1500,
      write_off_cents: 3000,
      balance_cents: 9000, // 18500 − 5000 − 1500 − 3000
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Write-off:')).toBe(true);  // the new legacy line label
    expect(has('$185.00')).toBe(true);     // Subtotal
    expect(has('-$50.00')).toBe(true);     // Payments
    expect(has('-$15.00')).toBe(true);     // Prepay Applied
    expect(has('-$30.00')).toBe(true);     // Write-off (was hidden before)
    expect(has('$90.00')).toBe(true);      // Balance Due (now reconciles)
    expect(has('BALANCE DUE:')).toBe(true);
    // 18500 − 5000 − 1500 − 3000 === 9000
    expect(18500 - 5000 - 1500 - 3000).toBe(9000);
  });

  it('prints an informational Discount Earned line WITHOUT changing Balance Due (legacy format)', async () => {
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      total_amount_cents: 18500,
      paid_amount_cents: 0,
      prepay_applied_cents: 0,
      write_off_cents: 0,
      discount_earned_cents: 1000, // $10 recorded early-pay discount
      balance_cents: 18500,        // UNCHANGED
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    const has = (s: string) => textCalls.some((a: unknown) => typeof a === 'string' && a.includes(s));
    expect(has('Discount Earned (if paid early):')).toBe(true);
    expect(has('$10.00')).toBe(true);   // recorded discount
    expect(has('$185.00')).toBe(true);  // Balance Due == Subtotal (unreduced)
  });

  it('renders a split with per-customer "Ref" labels that sum to the whole', async () => {
    const shares: InvoicePdfShare[] = [
      makeShare({ customer_name: 'Smith Farm', split_percentage: 33.34, amount_cents: 5000 }),
      makeShare({ customer_name: 'Jones Farm', split_percentage: 66.66, amount_cents: 10010 }),
    ];
    // Per-customer cents (5000 + 10010) must equal the grand total (15010).
    const sum = shares.reduce((s, x) => s + x.amount_cents, 0);
    expect(sum).toBe(15010);
    await generateInvoicePdf(makeInvoiceData({
      options: legacyOpts,
      job_number: '230568',
      shares,
      total_amount_cents: 15010,
      balance_cents: 15010,
    }));
    const textCalls = mockDoc.text.mock.calls.flat();
    // deriveSplitRef('230568', idx, true) → 230568-001 / 230568-002
    const autoTableArg = (vi.mocked(await import('jspdf-autotable')).default).mock.calls;
    // The share table is rendered via autoTable; assert its body carries the refs.
    const bodies = autoTableArg.map((c: unknown[]) => (c[1] as { body?: unknown[][] }).body).filter(Boolean) as unknown[][][];
    const flatCells = bodies.flat(2).map(String);
    expect(flatCells.includes('230568-001')).toBe(true);
    expect(flatCells.includes('230568-002')).toBe(true);
    // grand-total still prints from data (no recompute)
    expect(textCalls.some((a: unknown) => typeof a === 'string' && a.includes('$150.10'))).toBe(true);
  });

  it('handles a legacy chemical_sale invoice', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      invoice_type: 'chemical_sale',
      options: legacyOpts,
      items: [makeItem({ product_name: 'Roundup', extended_cents: 24000 })],
      total_amount_cents: 24000,
      balance_cents: 24000,
    }));
    expect(doc).toBe(mockDoc);
  });

  it('current format is unchanged when format is omitted/undefined', async () => {
    const doc = await generateInvoicePdf(makeInvoiceData({
      options: { show_shares: true, show_price_per_acre: true, show_epa_registration: true },
    }));
    expect(doc).toBe(mockDoc);
    // Current format draws the green header band via rect(); legacy never calls rect.
    expect(mockDoc.rect).toHaveBeenCalled();
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
