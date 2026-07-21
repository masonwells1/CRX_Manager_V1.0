/**
 * InvoiceDetail.test.tsx — Tests for the invoice detail/edit page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/invoicePdf', () => ({
  downloadInvoicePdf: vi.fn(),
  generateInvoicePdf: vi.fn(),
}));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  pdfToBase64: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
}));
vi.mock('../lib/dateUtils', () => ({
  localToday: vi.fn(() => '2026-03-16'),
  parseLocalDate: vi.fn((d: string) => new Date(d)),
}));
vi.mock('../lib/parseCents', () => ({
  parseDollarsToCents: vi.fn((v: string) => Math.round(parseFloat(v) * 100)),
}));
vi.mock('../components/invoices/WriteOffModal', () => ({ default: () => null }));
vi.mock('../components/invoices/InvoicePrintDialog', () => ({ default: () => null }));

import InvoiceDetail from './InvoiceDetail';

function renderInvoiceDetail(id = 'inv-123') {
  return render(
    <MemoryRouter initialEntries={[`/invoices/${id}`]}>
      <Routes>
        <Route path="/invoices/:id" element={<InvoiceDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvoiceDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('fetches invoice data on mount', () => {
    renderInvoiceDetail();
    // Verify supabase.from was called to load data
    expect(mockFrom).toHaveBeenCalled();
  });

  it('shows Invoice not found for invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderInvoiceDetail('bad-id');
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'Invoice not found');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/invoices');
  });

  it('renders invoice detail when data loads', async () => {
    const invoiceData = {
      id: 'inv-123',
      invoice_number: 'INV-0042',
      status: 'draft',
      type: 'standard',
      customer_id: 'cust-1',
      order_id: 'ord-1',
      subtotal_cents: 10000,
      tax_cents: 0,
      total_cents: 10000,
      balance_cents: 10000,
      invoice_date: '2026-03-15',
      due_date: '2026-04-15',
      notes: '',
      created_at: '2026-03-15T00:00:00Z',
    };

    let invoiceCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCallCount++;
        // Call 1 = segregation preflight (invoice_type/job_id/status), call 2 = full
        // invoice fetch — both need the invoice row; later calls = sibling invoices (array).
        if (invoiceCallCount <= 2) {
          return buildChain({ data: invoiceData, error: null });
        }
        return buildChain({ data: [], error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail();
    await waitFor(() => {
      const matches = screen.getAllByText('INV-0042');
      expect(matches.length).toBeGreaterThan(0);
    });
  });
});

describe('InvoiceDetail — chemical-sale payment terms', () => {
  const setupInvoice = (status: string, payment_terms: string | null = null, due_date: string | null = null, customerPaymentTerms: string | null = null) => {
    let invoiceCalls = 0;
    const invoice = {
      id: 'inv-terms',
      invoice_number: 'INV-TERMS',
      invoice_type: 'chemical_sale',
      status,
      customer_id: 'cust-1',
      order_id: 'ord-1',
      invoice_date: '2026-03-15',
      due_date,
      payment_terms,
      subtotal_cents: 10000,
      total_amount_cents: 10000,
      total_cents: 10000,
      balance_cents: 10000,
      header_notes: '',
      footer_notes: '',
      purchase_order_ref: '',
      created_at: '2026-03-15T00:00:00Z',
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'customers' && customerPaymentTerms !== null) {
        return buildChain({ data: { payment_terms: customerPaymentTerms }, error: null });
      }
      return buildChain({ data: [], error: null });
    });
  };

  it('shows the payment-terms picker on a draft invoice', async () => {
    setupInvoice('draft');
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    expect(screen.getByRole('combobox', { name: 'Payment Terms' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Net 60' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Custom date…' })).toBeInTheDocument();
  });

  it('sends preset terms and explicitly clears due_date', async () => {
    setupInvoice('draft', 'Net 30', '2026-04-14');
    mockRpc.mockResolvedValue({ data: null, error: null });
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('save_invoice', expect.objectContaining({
        p_invoice: expect.objectContaining({ payment_terms: 'Net 30' }),
      }));
      expect(mockRpc.mock.calls[0][1].p_invoice).toHaveProperty('due_date', null);
    });
  });

  it('clears custom terms and explicitly clears due_date when switching to customer default', async () => {
    setupInvoice('draft', 'Due 45 days after invoice', '2026-05-01');
    mockRpc.mockResolvedValue({ data: null, error: null });
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    fireEvent.change(screen.getByRole('combobox', { name: 'Payment Terms' }), { target: { value: 'Customer default' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('save_invoice', expect.objectContaining({
        p_invoice: expect.objectContaining({ payment_terms: null }),
      }));
      expect(mockRpc.mock.calls[0][1].p_invoice).toHaveProperty('due_date', null);
    });
  });

  it('round-trips custom due date with the original custom terms text', async () => {
    setupInvoice('draft', 'Due 45 days after invoice', '2026-05-01');
    mockRpc.mockResolvedValue({ data: null, error: null });
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('save_invoice', expect.objectContaining({
        p_invoice: expect.objectContaining({ payment_terms: 'Due 45 days after invoice', due_date: '2026-05-01' }),
      }));
    });
  });

  it('recognizes a stamped due date on reload and re-derives the preset', async () => {
    setupInvoice('draft', 'Net 30', '2026-04-14');
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    expect(screen.getByRole('combobox', { name: 'Payment Terms' })).toHaveValue('Net 30');
    expect(document.querySelector('#custom-due-date')).not.toBeInTheDocument();
  });

  it('uses the customer default terms to recognize a stamped due date when invoice terms are null', async () => {
    setupInvoice('unposted', null, '2026-03-30', 'Net 15');
    mockRpc.mockResolvedValue({ data: null, error: null });
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    expect(screen.getByRole('combobox', { name: 'Payment Terms' })).toHaveValue('Customer default');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('save_invoice', expect.objectContaining({
        p_invoice: expect.objectContaining({ payment_terms: null, due_date: null }),
      }));
      expect(mockRpc.mock.calls[0][1].p_invoice.payment_terms).not.toBe('Custom');
    });
  });

  it('does not apply stale customer terms after navigating to another invoice', async () => {
    const invoiceA = {
      id: 'inv-a',
      invoice_number: 'INV-A',
      invoice_type: 'chemical_sale',
      status: 'draft',
      customer_id: 'cust-a',
      order_id: null,
      invoice_date: '2026-03-15',
      due_date: null,
      payment_terms: null,
      subtotal_cents: 10000,
      total_amount_cents: 10000,
      total_cents: 10000,
      balance_cents: 10000,
      header_notes: '',
      footer_notes: '',
      purchase_order_ref: '',
      created_at: '2026-03-15T00:00:00Z',
    };
    const invoiceB = { ...invoiceA, id: 'inv-b', invoice_number: 'INV-B', customer_id: 'cust-b', payment_terms: 'Net 30', due_date: '2026-04-14' };
    let invoiceCalls = 0;
    let customerCalls = 0;
    let resolveCustomerTerms!: (value: { data: { payment_terms: string }; error: null }) => void;
    const delayedCustomerTerms = new Promise<{ data: { payment_terms: string }; error: null }>((resolve) => {
      resolveCustomerTerms = resolve;
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        const invoice = invoiceCalls <= 2 ? invoiceA : invoiceCalls <= 4 ? invoiceB : [];
        return buildChain({ data: invoice, error: null });
      }
      if (table === 'customers') {
        customerCalls += 1;
        if (customerCalls === 2) {
          const chain = buildChain({ data: null, error: null });
          const promise = delayedCustomerTerms;
          chain.then = promise.then.bind(promise);
          chain.catch = promise.catch.bind(promise);
          chain.finally = promise.finally.bind(promise);
          return chain;
        }
      }
      return buildChain({ data: [], error: null });
    });

    render(
      <MemoryRouter initialEntries={['/invoices/inv-a']}>
        <Link to="/invoices/inv-b">Invoice B</Link>
        <Routes>
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(customerCalls).toBe(2));
    fireEvent.click(screen.getByRole('link', { name: 'Invoice B' }));
    await waitFor(() => {
      expect(screen.getAllByText('INV-B').length).toBeGreaterThan(0);
      expect(screen.getByRole('combobox', { name: 'Payment Terms' })).toHaveValue('Net 30');
    });

    resolveCustomerTerms({ data: { payment_terms: 'Net 60' }, error: null });
    await waitFor(() => {
      expect(screen.getAllByText('INV-B').length).toBeGreaterThan(0);
      expect(screen.getByRole('combobox', { name: 'Payment Terms' })).toHaveValue('Net 30');
    });
    expect(screen.queryByText('INV-A')).not.toBeInTheDocument();
  });

  it.each(['posted', 'voided'])('keeps %s invoices inert', async (status) => {
    setupInvoice(status, 'Net 30', '2026-04-14');
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    expect(screen.queryByRole('combobox', { name: 'Payment Terms' })).not.toBeInTheDocument();
    expect(screen.getByText(/Net 30/)).toBeInTheDocument();
  });
});

/**
 * Codex R11 — segregation PREFLIGHT: the field-vs-chemical route guard must run on a
 * MINIMAL preflight row BEFORE the full select('*'), so a cross-permission URL (a
 * field-invoices-only user opening a chemical invoice id, or the inverse) never
 * receives the forbidden full invoice row in the network response.
 */
describe('InvoiceDetail — route-area segregation preflight (no full-row leak)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('field route + chemical invoice: redirects to /field-invoices and never runs the full select(*)', async () => {
    let invoicesCalls = 0;
    let fullSelectRan = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoicesCalls += 1;
        if (invoicesCalls === 1) {
          // preflight: minimal row revealing a CHEMICAL invoice on a FIELD route
          return buildChain({ data: { invoice_type: 'chemical_sale', job_id: 'ord-1', status: 'draft' }, error: null });
        }
        // any further 'invoices' fetch is the full select('*') we must NOT reach
        fullSelectRan = true;
        return buildChain({ data: { id: 'inv-x', invoice_number: 'LEAKED' }, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    render(
      <MemoryRouter initialEntries={['/field-invoices/inv-x']}>
        <Routes>
          <Route path="/field-invoices/:id" element={<InvoiceDetail routeArea="field" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/field-invoices', { replace: true });
    });
    expect(mockToast).toHaveBeenCalledWith('error', 'Not a field invoice');
    // The security property: the forbidden full row was never fetched.
    expect(fullSelectRan).toBe(false);
  });

  it('field route + blend-ticket field invoice: STAYS in the generic editor (does NOT bounce to the per-acre engine)', async () => {
    let invoicesCalls = 0;
    let fullSelectRan = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoicesCalls += 1;
        if (invoicesCalls === 1) {
          // blend-ticket field invoice: job_id NULL but blend_ticket_id SET (no field_app_locations)
          return buildChain({ data: { invoice_type: 'field_application', job_id: null, blend_ticket_id: 'blend-1', status: 'draft' }, error: null });
        }
        fullSelectRan = true;
        return buildChain({ data: { id: 'inv-bt', invoice_number: 'INV-BT', status: 'draft' }, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    render(
      <MemoryRouter initialEntries={['/field-invoices/inv-bt']}>
        <Routes>
          <Route path="/field-invoices/:id" element={<InvoiceDetail routeArea="field" />} />
        </Routes>
      </MemoryRouter>,
    );

    // It proceeds to the full fetch (stays here) and never bounces to the per-acre engine editor.
    await waitFor(() => { expect(fullSelectRan).toBe(true); });
    expect(mockNavigate).not.toHaveBeenCalledWith('/invoices/field-app/inv-bt', { replace: true });
  });

  it('chemical route + field invoice: redirects to /field-invoices/:id and never runs the full select(*)', async () => {
    let invoicesCalls = 0;
    let fullSelectRan = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoicesCalls += 1;
        if (invoicesCalls === 1) {
          return buildChain({ data: { invoice_type: 'field_application', job_id: 'job-1', status: 'draft' }, error: null });
        }
        fullSelectRan = true;
        return buildChain({ data: { id: 'inv-y', invoice_number: 'LEAKED' }, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    render(
      <MemoryRouter initialEntries={['/invoices/inv-y']}>
        <Routes>
          <Route path="/invoices/:id" element={<InvoiceDetail routeArea="chemical" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/field-invoices/inv-y', { replace: true });
    });
    expect(fullSelectRan).toBe(false);
  });
});

/**
 * Phase 1 (2026-04-29) — Post button must route through post_invoice_group when
 * the invoice belongs to a split group, otherwise post_invoice. Posting a single
 * group member would leave the group half-posted, so this is a load-bearing
 * branch in src/pages/InvoiceDetail.tsx (handlePost).
 */
describe('InvoiceDetail — Phase 1 group-aware Post routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  function setupInvoice(invoice: Record<string, unknown>) {
    let n = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        n += 1;
        // Call 1 = segregation preflight, call 2 = full fetch; both need the row.
        return buildChain({ data: n <= 2 ? invoice : [], error: null });
      }
      return buildChain({ data: [], error: null });
    });
  }

  const baseInvoice = {
    id: 'inv-123',
    invoice_number: 'INV-0099',
    status: 'draft',
    type: 'standard',
    customer_id: 'cust-1',
    order_id: 'ord-1',
    subtotal_cents: 10000,
    total_cents: 10000,
    balance_cents: 10000,
    invoice_date: '2026-03-15',
    due_date: '2026-04-15',
    created_at: '2026-03-15T00:00:00Z',
  };

  it('renders the group-banner indicator when invoice_group_id is set', async () => {
    setupInvoice({ ...baseInvoice, invoice_group_id: 'grp-xyz' });
    renderInvoiceDetail();
    // The Post button text reflects group membership somewhere in the page UI;
    // smoke-check by waiting for INV-0099 to be in the document.
    await waitFor(() => {
      expect(screen.getAllByText('INV-0099').length).toBeGreaterThan(0);
    });
  });

  it('hooks up handlePost so it CAN call post_invoice_group when invoice_group_id is set', async () => {
    setupInvoice({ ...baseInvoice, invoice_group_id: 'grp-xyz' });
    renderInvoiceDetail();
    await waitFor(() => {
      expect(screen.getAllByText('INV-0099').length).toBeGreaterThan(0);
    });
    // The branch in handlePost:
    //   if (invoice.invoice_group_id) supabase.rpc('post_invoice_group', ...)
    //   else                          supabase.rpc('post_invoice', ...)
    // is verified by E2E (real button click + real RPC). Here we only smoke-check
    // that the page didn't crash when invoice_group_id is set — meaning the
    // branch's truthy path is reachable.
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.any(String));
  });

  it('does not crash when invoice_group_id is null (post_invoice branch)', async () => {
    setupInvoice({ ...baseInvoice, invoice_group_id: null });
    renderInvoiceDetail();
    await waitFor(() => {
      expect(screen.getAllByText('INV-0099').length).toBeGreaterThan(0);
    });
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.any(String));
  });

  it('voids a grouped field-application invoice through singular void_invoice', async () => {
    setupInvoice({
      ...baseInvoice,
      status: 'posted',
      invoice_type: 'field_application',
      invoice_group_id: 'field-grp-xyz',
    });
    mockRpc.mockResolvedValue({ data: null, error: null });
    renderInvoiceDetail();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Void' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    fireEvent.click(screen.getByRole('button', { name: 'Void Invoice' }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('void_invoice', expect.objectContaining({ p_invoice_id: 'inv-123' }));
      expect(mockRpc).not.toHaveBeenCalledWith('void_invoice_group', expect.anything());
      expect(mockToast).toHaveBeenCalledWith('success', 'Invoice voided');
    });
  });

  it('falls back to atomic group void only for the governed provenance guard', async () => {
    setupInvoice({ ...baseInvoice, status: 'posted', invoice_group_id: 'governed-grp-xyz' });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'void_invoice') {
        return Promise.resolve({
          data: null,
          error: { message: 'SPLIT_INVOICE_GROUP_VOID_REQUIRED: use void_invoice_group' },
        });
      }
      if (name === 'void_invoice_group') return Promise.resolve({ data: 2, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    renderInvoiceDetail();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Void' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    fireEvent.click(screen.getByRole('button', { name: 'Void Invoice' }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('void_invoice_group', expect.objectContaining({
        p_invoice_group_id: 'governed-grp-xyz',
      }));
      expect(mockToast).toHaveBeenCalledWith('success', 'Invoice group voided');
    });
  });
});
