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
  invoice_items: [{ product_id: 'prod-A' }, { product_id: 'prod-RUP' }],
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

function setup(screenItems: Array<Record<string, unknown>>) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'invoices') return chain({ data: SAVED_INVOICE, error: null });
    if (table === 'invoice_items') return chain({ data: screenItems, error: null });
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
    expect(screen.getByText(/Save your changes before posting/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(screen.queryByText(/This will lock amounts/)).not.toBeInTheDocument();
    expect(postInvoiceCalls()).toHaveLength(0);
  });

  it('allows Post again once the edits are saved', async () => {
    setup([lineItem({})]);
    mockRpc.mockImplementation((name: string) => {
      const result = Promise.resolve(name === 'save_invoice' ? { data: 'inv-1', error: null } : { data: null, error: null });
      return Object.assign(result, { throwOnError: () => result });
    });
    renderPage();
    await screen.findByRole('button', { name: 'Post' });

    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'save_invoice')).toBe(true));
    // The save reloads the saved invoice; the screen matches it again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled());
    expect(screen.queryByText(/Save your changes before posting/i)).not.toBeInTheDocument();
  });

  it('runs the credit-limit and RUP checks on the saved invoice that will be posted', async () => {
    // What this screen loaded ($2,500, prod-A only) is not what is saved now ($4,000 with
    // a restricted-use line, e.g. saved from another tab). post_invoice posts the SAVED
    // invoice, so the checks must look at the saved one.
    setup([lineItem({ quantity: 1, unit_price_cents: 250000, extended_cents: 250000 })]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post Invoice' }));

    await waitFor(() => expect(postInvoiceCalls()).toHaveLength(1));
    expect(mockRupCheck).toHaveBeenCalledWith('cust-1', ['prod-A', 'prod-RUP']);
    expect(mockCreditCheck).toHaveBeenCalledWith({ customerId: 'cust-1', newAmountCents: 400000 });
  });
});
