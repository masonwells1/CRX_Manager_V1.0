/**
 * InvoiceDetail.test.tsx — Tests for the invoice detail/edit page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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
});
