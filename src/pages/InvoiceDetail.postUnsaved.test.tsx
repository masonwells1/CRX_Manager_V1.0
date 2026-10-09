/**
 * InvoiceDetail.postUnsaved.test.tsx — Post on the generic invoice editor.
 *
 * Bug (2026-10-09): Post was allowed while the screen had unsaved edits. post_invoice
 * posts the SAVED invoice, so the old amounts were billed and the edits silently
 * thrown away — while the credit-limit and restricted-use (RUP) checks had looked at
 * the edited on-screen lines. Now Post is blocked until the edits are saved, and the
 * pre-post checks read the saved invoice that will actually be posted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockCreditCheck, mockRupCheck } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockCreditCheck: vi.fn(),
  mockRupCheck: vi.fn(),
}));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: mockFrom, rpc: mockRpc } };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useGuardrails', () => ({
  useCreditLimitCheck: () => ({ warning: null, check: mockCreditCheck, dismiss: vi.fn() }),
}));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: mockRupCheck,
  rupRegisterDisposition: () => ({ label: 'NON-COMPLIANT' }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/invoicePdf', () => ({
  downloadInvoicePdf: vi.fn(),
  generateInvoicePdf: vi.fn(),
  deriveFieldAppAppliedAcres: vi.fn(),
  groupReturnCreditDisplayItems: vi.fn((_type: string, items: unknown[]) => items),
  mapInvoicePdfItem: vi.fn((item: unknown) => item),
}));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  pdfToBase64: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
  isInvoiceEmailSuppressed: vi.fn(() => false),
}));
vi.mock('../components/invoices/WriteOffModal', () => ({ default: () => null }));
vi.mock('../components/invoices/InvoicePrintDialog', () => ({ default: () => null }));

import InvoiceDetail from './InvoiceDetail';

function chain(result: { data: unknown; error: unknown }) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit', 'single', 'maybeSingle']) {
    self[m] = () => self;
  }
  self.then = (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return self;
}

// The SAVED invoice: $4,000.00, with a restricted-use line (prod-RUP) alongside prod-A.
const SAVED_INVOICE = {
  id: 'inv-1',
  invoice_number: 'INV-0042',
  status: 'draft',
  invoice_type: 'chemical_sale',
  customer_id: 'cust-1',
  customer: { farm_name: 'Test Farm' },
  season: 2027,
  order_id: null,
  blend_ticket_id: null,
  job_id: null,
  invoice_group_id: null,
  total_amount_cents: 400000,
  paid_amount_cents: 0,
  prepay_applied_cents: 0,
  credit_applied_cents: 0,
  balance_cents: 400000,
  invoice_date: '2026-10-05',
  due_date: null,
  payment_terms: 'Net 30',
  purchase_order_ref: '',
  header_notes: '',
  footer_notes: '',
  created_at: '2026-10-05T15:00:00Z',
};

function lineItem(overrides: Record<string, unknown>) {
  return {
    id: 'item-1',
    product_id: 'prod-A',
    product: { product_name: 'Product A' },
    description: 'Product A',
    quantity: 1,
    unit_price_cents: 400000,
    extended_cents: 400000,
    cost_cents: 100000,
    sort_order: 0,
    ...overrides,
  };
}

// The saved $4,000.00 invoice's two lines: prod-A and a restricted-use line (prod-RUP).
const SAVED_TWO_LINES = [
  lineItem({ id: 'item-1', product_id: 'prod-A', unit_price_cents: 150000, extended_cents: 150000 }),
  lineItem({ id: 'item-2', product_id: 'prod-RUP', product: { product_name: 'RUP Product' }, description: 'RUP Product', unit_price_cents: 250000, extended_cents: 250000, sort_order: 1 }),
];

// Mutable "database": what the invoices / invoice_items reads return right now. The
// invoices read embeds the SAME saved lines (invoice_items) the line read returns, as
// the real database does.
let savedInvoiceRow: Record<string, unknown> = SAVED_INVOICE;
let savedLineItems: Array<Record<string, unknown>> = [];
let invoiceReadError: { message: string } | null = null;

function setup(screenItems: Array<Record<string, unknown>>) {
  savedInvoiceRow = SAVED_INVOICE;
  savedLineItems = screenItems;
  invoiceReadError = null;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'invoices') {
      return chain(invoiceReadError
        ? { data: null, error: invoiceReadError }
        : { data: { ...savedInvoiceRow, invoice_items: savedLineItems }, error: null });
    }
    if (table === 'invoice_items') return chain({ data: savedLineItems, error: null });
    return chain({ data: [], error: null });
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/invoices/inv-1']}>
      <Routes>
        <Route path="/invoices/:id" element={<InvoiceDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function postInvoiceCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'post_invoice');
}

describe('InvoiceDetail — Post never posts something other than what is on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreditCheck.mockResolvedValue(true);
    mockRupCheck.mockResolvedValue({ hasRUPProducts: false, hasValidLicense: true, rupProductNames: [], missingLicense: false });
    mockRpc.mockImplementation(() => {
      const result = Promise.resolve({ data: null, error: null });
      return Object.assign(result, { throwOnError: () => result });
    });
  });

  it('blocks Post while there are unsaved edits and says why', async () => {
    setup([lineItem({})]);
    renderPage();
    const post = await screen.findByRole('button', { name: 'Post' });
    expect(post).toBeEnabled();

    // Edit the quantity on screen without saving.
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });

    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
    // Print builds the PDF from the saved lines, so it waits for the save too.
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    expect(screen.getByText(/Save your changes before posting/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(screen.queryByText(/This will lock amounts/)).not.toBeInTheDocument();
    expect(postInvoiceCalls()).toHaveLength(0);
  });

  it('allows Post again once the edits are saved', async () => {
    setup([lineItem({})]);
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_invoice') {
        // The save stores the edit: from now on the database holds quantity 2, so the
        // reload after the save shows quantity 2 — DIFFERENT from the first load. Post
        // is enabled again only if the unsaved-edit baseline is retaken after the save.
        savedLineItems = [lineItem({ quantity: 2, extended_cents: 800000 })];
      }
      const result = Promise.resolve(name === 'save_invoice' ? { data: 'inv-1', error: null } : { data: null, error: null });
      return Object.assign(result, { throwOnError: () => result });
    });
    renderPage();
    await screen.findByRole('button', { name: 'Post' });

    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'save_invoice')).toBe(true));
    // The save reloads the saved invoice (quantity 2); the screen matches it again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled());
    expect(screen.getByDisplayValue('2')).toBeInTheDocument();
    expect(screen.queryByText(/Save your changes before posting/i)).not.toBeInTheDocument();
  });

  it('refuses to post when the saved invoice cannot be re-read, instead of checking the loaded copy', async () => {
    setup([lineItem({})]);
    renderPage();
    const post = await screen.findByRole('button', { name: 'Post' });

    // The fresh read of the saved invoice fails (network, permission, ...).
    invoiceReadError = { message: 'network down' };
    fireEvent.click(post);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/Could not re-check the saved invoice/)),
    );
    expect(screen.queryByText(/This will lock amounts/)).not.toBeInTheDocument();
    expect(mockCreditCheck).not.toHaveBeenCalled();
    expect(mockRupCheck).not.toHaveBeenCalled();
    expect(postInvoiceCalls()).toHaveLength(0);
  });

  it('reloads instead of posting when the invoice was moved to another customer elsewhere, then checks the NEW customer', async () => {
    setup(SAVED_TWO_LINES);
    renderPage();
    const post = await screen.findByRole('button', { name: 'Post' });

    // Another tab re-assigned the saved invoice to customer B at $5,000 (prod-RUP line
    // raised to $3,500).
    savedInvoiceRow = { ...SAVED_INVOICE, customer_id: 'cust-2', customer: { farm_name: 'Other Farm' }, total_amount_cents: 500000, balance_cents: 500000 };
    savedLineItems = [SAVED_TWO_LINES[0], { ...SAVED_TWO_LINES[1], unit_price_cents: 350000, extended_cents: 350000 }];
    fireEvent.click(post);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/changed somewhere else/)),
    );
    expect(screen.queryByText(/This will lock amounts/)).not.toBeInTheDocument();
    expect(mockCreditCheck).not.toHaveBeenCalled();
    expect(postInvoiceCalls()).toHaveLength(0);

    // After the reload the screen shows the saved invoice, and a second Post checks
    // customer B's credit with the $5,000 saved total — never customer A's.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Invoice' }));
    await waitFor(() => expect(postInvoiceCalls()).toHaveLength(1));
    expect(mockCreditCheck).toHaveBeenCalledTimes(1);
    expect(mockCreditCheck).toHaveBeenCalledWith({ customerId: 'cust-2', newAmountCents: 500000 });
    expect(mockRupCheck).toHaveBeenCalledWith('cust-2', ['prod-A', 'prod-RUP']);
  });

  it('runs the credit-limit and RUP checks on the saved invoice that will be posted', async () => {
    // Screen and database agree ($4,000 with a restricted-use line): the checks use the
    // freshly read saved customer, total and lines, then the invoice posts.
    setup(SAVED_TWO_LINES);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Invoice' }));

    await waitFor(() => expect(postInvoiceCalls()).toHaveLength(1));
    expect(mockRupCheck).toHaveBeenCalledWith('cust-1', ['prod-A', 'prod-RUP']);
    expect(mockCreditCheck).toHaveBeenCalledWith({ customerId: 'cust-1', newAmountCents: 400000 });
  });

  it('reloads instead of posting when a line was swapped elsewhere at the SAME customer and total', async () => {
    // Review round 2: the re-check used to compare only customer and total, so a product
    // swapped from another tab at the same price posted lines this screen never showed.
    setup(SAVED_TWO_LINES);
    renderPage();
    const post = await screen.findByRole('button', { name: 'Post' });

    // Another tab replaced prod-A with prod-B at the same price: customer and total unchanged.
    savedLineItems = [{ ...SAVED_TWO_LINES[0], product_id: 'prod-B', product: { product_name: 'Product B' }, description: 'Product B' }, SAVED_TWO_LINES[1]];
    fireEvent.click(post);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/changed somewhere else/)),
    );
    expect(screen.queryByText(/This will lock amounts/)).not.toBeInTheDocument();
    expect(mockCreditCheck).not.toHaveBeenCalled();
    expect(postInvoiceCalls()).toHaveLength(0);
    // The reload shows the swapped line before anything can be posted.
    expect((await screen.findAllByText(/Product B/)).length).toBeGreaterThan(0);
  });

  it('reloads instead of posting when the invoice date was moved elsewhere (a different posting month)', async () => {
    setup(SAVED_TWO_LINES);
    renderPage();
    const post = await screen.findByRole('button', { name: 'Post' });

    savedInvoiceRow = { ...SAVED_INVOICE, invoice_date: '2026-11-02' };
    fireEvent.click(post);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/changed somewhere else/)),
    );
    expect(mockCreditCheck).not.toHaveBeenCalled();
    expect(postInvoiceCalls()).toHaveLength(0);
  });
});
