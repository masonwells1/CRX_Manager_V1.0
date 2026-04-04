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
        // First call: fetch invoice (single), subsequent: sibling invoices (array)
        if (invoiceCallCount === 1) {
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
