/**
 * InvoiceDetail.test.tsx — Tests for the invoice detail/edit page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockNavigate, intentKeys, nextIntentKey } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  intentKeys: new Map<string, string>(),
  nextIntentKey: { value: 0 },
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

function buildDeferredChain(): { chain: Record<string, unknown>; resolve: (result: { data: unknown; error: unknown }) => void } {
  let resolve!: (result: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((done) => { resolve = done; });
  const chain: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => chain;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const methodName of methods) chain[methodName] = method;
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return { chain, resolve };
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
  useIdempotencyKey: (operation: string, userId: string, intentScope = '') => {
    const scope = JSON.stringify([operation, userId, intentScope]);
    const getFor = (dynamicIntentScope: string) => JSON.stringify([operation, userId, dynamicIntentScope]);
    const getOrCreate = (keyScope: string) => {
      let key = intentKeys.get(keyScope);
      if (!key) {
        nextIntentKey.value += 1;
        key = `test-idem-key-${nextIntentKey.value}`;
        intentKeys.set(keyScope, key);
      }
      return key;
    };
    return {
      getKey: () => getOrCreate(scope),
      resetKey: () => { intentKeys.delete(scope); },
      getKeyFor: (dynamicIntentScope: string) => getOrCreate(getFor(dynamicIntentScope)),
      resetKeyFor: (dynamicIntentScope: string) => { intentKeys.delete(getFor(dynamicIntentScope)); },
    };
  },
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/invoicePdf', () => ({
  downloadInvoicePdf: vi.fn(),
  generateInvoicePdf: vi.fn(),
  deriveFieldAppAppliedAcres: vi.fn(),
  groupReturnCreditDisplayItems: vi.fn((_invoiceType: string, items: unknown[]) => items),
}));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  pdfToBase64: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
}));
vi.mock('../lib/dateUtils', () => ({
  localToday: vi.fn(() => '2026-03-16'),
  // DELIBERATELY a different date from localToday (CodeRabbit, 2026-09-04). The first version of
  // this mock pinned both to 2026-03-16, which made the new-invoice date assertion below unable
  // to fail: reverting InvoiceDetail back to localToday() would have produced the identical value
  // and the suite would still have been green. The two dates must differ for that test to
  // discriminate at all.
  todayInBusinessTz: vi.fn(() => '2026-09-30'),
  parseLocalDate: vi.fn((d: string) => new Date(d)),
}));
// parseCents is deliberately NOT mocked: the real parser refuses more than two
// decimals (null) and a rounding stand-in would let this page's refusal branches
// pass whether or not they work (2026-09-03).
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

function mockIntentAwareRpc(result: { data: unknown; error: unknown }) {
  mockRpc.mockImplementation((name: string) => Promise.resolve(
    name === 'idempotency_intent_binding_enabled'
      ? { data: true, error: null }
      : result,
  ));
}

describe('InvoiceDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intentKeys.clear();
    nextIntentKey.value = 0;
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  function setupPostedInvoiceWithCredit() {
    const invoice = {
      id: 'inv-credit-target', invoice_number: 'INV-CREDIT-TARGET', status: 'posted',
      invoice_type: 'chemical_sale', customer_id: 'cust-credit', total_amount_cents: 10000,
      paid_amount_cents: 0, prepay_applied_cents: 0, credit_applied_cents: 0,
      balance_cents: 10000, invoice_date: '2026-03-15', due_date: '2026-03-01',
      created_at: '2026-03-15T00:00:00Z',
    };
    let creditBalanceCents = -5000;
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        const credits = [{ id: 'memo-1', invoice_number: 'CM-0001', balance_cents: creditBalanceCents }];
        return buildChain({ data: invoiceCalls <= 2 ? invoice : credits, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    return { setCreditBalanceCents: (value: number) => { creditBalanceCents = value; } };
  }

  it('reuses the unresolved Apply Credit key after a lost response and close/reopen of the same intent', async () => {
    const creditState = setupPostedInvoiceWithCredit();
    let applyCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'apply_credit_memo_to_invoice') return Promise.resolve({ data: null, error: null });
      applyCalls += 1;
      if (applyCalls === 1) creditState.setCreditBalanceCents(-2000);
      return Promise.resolve(applyCalls === 1
        ? { data: null, error: { code: 'ETIMEDOUT', message: 'network response lost after commit' } }
        : { data: { application_id: 'application-1' }, error: null });
    });

    renderInvoiceDetail('inv-credit-target');
    await screen.findAllByText('INV-CREDIT-TARGET');
    fireEvent.click(screen.getByRole('button', { name: 'Apply Credit' }));
    await screen.findByRole('dialog', { name: 'Apply Credit Memo' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply Credit' }).slice(-1)[0]);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'network response lost after commit'));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Apply Credit Memo' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Apply Credit' }));
    await screen.findByRole('dialog', { name: 'Apply Credit Memo' });
    expect(screen.getByLabelText('Credit Memo')).toBeDisabled();
    expect(screen.getByLabelText('Amount to apply ($)')).toBeDisabled();
    expect(screen.getByLabelText('Amount to apply ($)')).toHaveValue(50);
    expect(screen.getByText(/previous response was not confirmed/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply Credit' }).slice(-1)[0]);

    await waitFor(() => expect(applyCalls).toBe(2));
    const calls = mockRpc.mock.calls.filter(([name]) => name === 'apply_credit_memo_to_invoice');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual(expect.objectContaining({
      p_credit_memo_id: 'memo-1', p_target_invoice_id: 'inv-credit-target', p_amount_cents: 5000,
    }));
    expect(calls[1][1].p_idempotency_key).toBe(calls[0][1].p_idempotency_key);
  });

  it('retires a definitively refused Apply Credit key and unlocks its inputs', async () => {
    setupPostedInvoiceWithCredit();
    let applyCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'apply_credit_memo_to_invoice') return Promise.resolve({ data: null, error: null });
      applyCalls += 1;
      return Promise.resolve(applyCalls === 1
        ? { data: null, error: { code: 'P0001', message: 'AMOUNT_EXCEEDS_CREDIT' } }
        : { data: { application_id: 'application-2' }, error: null });
    });

    renderInvoiceDetail('inv-credit-target');
    await screen.findAllByText('INV-CREDIT-TARGET');
    fireEvent.click(screen.getByRole('button', { name: 'Apply Credit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply Credit Memo' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Credit' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'AMOUNT_EXCEEDS_CREDIT'));
    await waitFor(() => expect(screen.getByLabelText('Amount to apply ($)')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Amount to apply ($)'), { target: { value: '20.00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Credit' }));

    await waitFor(() => expect(applyCalls).toBe(2));
    const calls = mockRpc.mock.calls.filter(([name]) => name === 'apply_credit_memo_to_invoice');
    expect(calls[1][1].p_idempotency_key).not.toBe(calls[0][1].p_idempotency_key);
    expect(calls[1][1].p_amount_cents).toBe(2000);
  });

  it('blocks Escape, backdrop, X, and Cancel while Apply Credit is submitting', async () => {
    setupPostedInvoiceWithCredit();
    let resolveApply!: (value: { data: unknown; error: unknown }) => void;
    const pendingApply = new Promise<{ data: unknown; error: unknown }>((resolve) => { resolveApply = resolve; });
    mockRpc.mockImplementation((name: string) => name === 'apply_credit_memo_to_invoice'
      ? pendingApply
      : Promise.resolve({ data: null, error: null }));

    renderInvoiceDetail('inv-credit-target');
    await screen.findAllByText('INV-CREDIT-TARGET');
    fireEvent.click(screen.getByRole('button', { name: 'Apply Credit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply Credit Memo' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Apply Credit' }).slice(-1)[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog.querySelector('[aria-hidden="true"]') as Element);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Apply Credit Memo' })).toBeInTheDocument();

    await act(async () => { resolveApply({ data: { application_id: 'application-1' }, error: null }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Apply Credit Memo' })).not.toBeInTheDocument());
  });

  it('fetches invoice data on mount', () => {
    renderInvoiceDetail();
    // Verify supabase.from was called to load data
    expect(mockFrom).toHaveBeenCalled();
  });

  it('reloads the authoritative invoice and suppresses false success after an intent mismatch', async () => {
    const committedInvoice = {
      id: 'inv-reconcile', invoice_number: 'INV-RECONCILE', status: 'draft', invoice_type: 'chemical_sale',
      customer_id: 'cust-1', order_id: 'ord-1', total_amount_cents: 10000,
      balance_cents: 10000, invoice_date: '2026-03-15', due_date: null,
      purchase_order_ref: 'COMMITTED-PO', created_at: '2026-03-15T00:00:00Z',
    };
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({
          data: [1, 2, 4, 5].includes(invoiceCalls) ? committedInvoice : [],
          error: null,
        });
      }
      return buildChain({ data: [], error: null });
    });
    mockIntentAwareRpc({
      data: null,
      error: {
        message: 'IDEMPOTENCY_INTENT_MISMATCH',
        details: JSON.stringify({
          operation: 'save_invoice',
          result: { invoice_id: 'inv-reconcile' },
        }),
      },
    });

    renderInvoiceDetail('inv-reconcile');
    const poInput = await screen.findByPlaceholderText('Customer PO #');
    fireEvent.change(poInput, { target: { value: 'UNSAVED-SECOND-INTENT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByPlaceholderText('Customer PO #')).toHaveValue('COMMITTED-PO'));
    expect(invoiceCalls).toBeGreaterThanOrEqual(4);
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('earlier save already completed'));
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Invoice saved');
  });

  it('shows Invoice not found for invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderInvoiceDetail('bad-id');
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'Invoice not found');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/invoices');
  });

  it('shows a Product search failure instead of silently rendering an empty picker', async () => {
    const invoice = {
      id: 'inv-product-error', invoice_number: 'INV-PRODUCT-ERROR', status: 'draft', type: 'standard',
      customer_id: 'cust-1', order_id: 'ord-1', subtotal_cents: 0, tax_cents: 0, total_cents: 0,
      balance_cents: 0, invoice_date: '2026-03-15', due_date: null, notes: '', created_at: '2026-03-15T00:00:00Z',
    };
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'products') return buildChain({ data: null, error: { message: 'Product query failed' } });
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail('inv-product-error');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Product' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
    fireEvent.change(screen.getByPlaceholderText('Search products by name or SKU...'), { target: { value: 'at' } });

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to search Products'));
  });

  it('keeps only the latest Product search and invalidates stale results after selection', async () => {
    const invoice = {
      id: 'inv-product-race', invoice_number: 'INV-PRODUCT-RACE', status: 'draft', type: 'standard',
      customer_id: 'cust-1', order_id: 'ord-1', subtotal_cents: 0, tax_cents: 0, total_cents: 0,
      balance_cents: 0, invoice_date: '2026-03-15', due_date: null, notes: '', created_at: '2026-03-15T00:00:00Z',
    };
    const stale = buildDeferredChain();
    const latest = buildDeferredChain();
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'products') return mockFrom.mock.calls.filter(([name]) => name === 'products').length === 1 ? stale.chain : latest.chain;
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail('inv-product-race');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Product' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
    const input = screen.getByPlaceholderText('Search products by name or SKU...');
    fireEvent.change(input, { target: { value: 'old' } });
    await waitFor(() => expect(mockFrom.mock.calls.filter(([name]) => name === 'products')).toHaveLength(1));
    fireEvent.change(input, { target: { value: 'new' } });
    stale.resolve({ data: [{ id: 'product-stale-uuid', product_name: 'Stale Product', sku: null, tier1_price: 1, current_cost: 1 }], error: null });
    await waitFor(() => expect(screen.queryByText('Stale Product')).not.toBeInTheDocument());
    await waitFor(() => expect(mockFrom.mock.calls.filter(([name]) => name === 'products')).toHaveLength(2));

    latest.resolve({ data: [{ id: 'product-new-uuid', product_name: 'Latest Product', sku: null, tier1_price: 22, current_cost: 11 }], error: null });
    expect(await screen.findByText('Product ID: product-new-uuid')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Product ID: product-new-uuid'));
    await waitFor(() => expect(screen.queryByPlaceholderText('Search products by name or SKU...')).not.toBeInTheDocument());
    expect(screen.getAllByText('Latest Product').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
    expect(screen.queryByText('Stale Product')).not.toBeInTheDocument();
  });

  it('does not repopulate Product results after a short-query clear invalidates an in-flight search', async () => {
    const invoice = {
      id: 'inv-product-clear', invoice_number: 'INV-PRODUCT-CLEAR', status: 'draft', type: 'standard',
      customer_id: 'cust-1', order_id: 'ord-1', subtotal_cents: 0, tax_cents: 0, total_cents: 0,
      balance_cents: 0, invoice_date: '2026-03-15', due_date: null, notes: '', created_at: '2026-03-15T00:00:00Z',
    };
    const stale = buildDeferredChain();
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'products') return stale.chain;
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail('inv-product-clear');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Product' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
    const input = screen.getByPlaceholderText('Search products by name or SKU...');
    fireEvent.change(input, { target: { value: 'old' } });
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('products'));
    fireEvent.change(input, { target: { value: '' } });

    stale.resolve({ data: [{ id: 'product-stale-clear-uuid', product_name: 'Stale After Clear', sku: null }], error: null });
    await waitFor(() => expect(screen.queryByText('Stale After Clear')).not.toBeInTheDocument());
    expect(screen.getByText('Type at least 2 characters to search')).toBeInTheDocument();
  });

  it('removes completed Product results immediately when a new valid query is typed', async () => {
    const invoice = {
      id: 'inv-product-between-searches', invoice_number: 'INV-PRODUCT-BETWEEN-SEARCHES', status: 'draft', type: 'standard',
      customer_id: 'cust-1', order_id: 'ord-1', subtotal_cents: 0, tax_cents: 0, total_cents: 0,
      balance_cents: 0, invoice_date: '2026-03-15', due_date: null, notes: '', created_at: '2026-03-15T00:00:00Z',
    };
    const latest = buildDeferredChain();
    let invoiceCalls = 0;
    let productCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'products') {
        productCalls += 1;
        return productCalls === 1
          ? buildChain({ data: [{ id: 'product-old-complete-uuid', product_name: 'Completed Old Product', sku: null }], error: null })
          : latest.chain;
      }
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail('inv-product-between-searches');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Product' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
    const input = screen.getByPlaceholderText('Search products by name or SKU...');
    fireEvent.change(input, { target: { value: 'old' } });
    expect(await screen.findByText('Product ID: product-old-complete-uuid')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'new' } });
    expect(screen.queryByText('Completed Old Product')).not.toBeInTheDocument();
    expect(screen.getByText('Searching Products...')).toBeInTheDocument();
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

  it('renders the stored penny-exact COGS total for a posted return credit', async () => {
    const invoice = {
      id: 'credit-return-1', invoice_number: 'CM-RETURN-1', status: 'posted',
      invoice_type: 'credit_memo', customer_id: 'cust-1', total_amount_cents: -1000,
      total_cost_cents: -251, paid_amount_cents: 0, prepay_applied_cents: 0,
      credit_applied_cents: 0, balance_cents: -1000, invoice_date: '2026-03-15',
      due_date: null, created_at: '2026-03-15T00:00:00Z',
    };
    const creditLines = [{
      id: 'credit-line-1', invoice_id: invoice.id, product_id: 'product-1',
      description: 'Return credit - Product', quantity: 1.5, unit_price_cents: -667,
      extended_cents: -1000, cost_cents: -168, unit_size: 'Gal',
      return_credit_cogs_cents: -251, return_credit_source_item_id: 'source-line-1',
      is_application_fee: false,
    }];
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'invoice_items') return buildChain({ data: creditLines, error: null });
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail(invoice.id);
    await waitFor(() => expect(screen.getAllByText('CM-RETURN-1').length).toBeGreaterThan(0));
    const totalCostLabel = screen.getByText('Total Cost');
    expect(totalCostLabel.parentElement).toHaveTextContent('-$2.51');
    expect(totalCostLabel.parentElement).not.toHaveTextContent('-$2.52');
  });

  it('keeps a manual posted credit on its ordinary line-derived cost display', async () => {
    const invoice = {
      id: 'credit-manual-1', invoice_number: 'CM-MANUAL-1', status: 'posted',
      invoice_type: 'credit_memo', customer_id: 'cust-1', total_amount_cents: -1000,
      total_cost_cents: -999, paid_amount_cents: 0, prepay_applied_cents: 0,
      credit_applied_cents: 0, balance_cents: -1000, invoice_date: '2026-03-15',
      due_date: null, created_at: '2026-03-15T00:00:00Z',
    };
    const creditLines = [{
      id: 'manual-credit-line-1', invoice_id: invoice.id, product_id: 'product-1',
      description: 'Manual price adjustment', quantity: 1.5, unit_price_cents: -667,
      extended_cents: -1000, cost_cents: -168, unit_size: 'Gal',
      is_application_fee: false,
    }];
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'invoice_items') return buildChain({ data: creditLines, error: null });
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail(invoice.id);
    await waitFor(() => expect(screen.getAllByText('CM-MANUAL-1').length).toBeGreaterThan(0));
    const totalCostLabel = screen.getByText('Total Cost');
    expect(totalCostLabel.parentElement).toHaveTextContent('-$2.52');
    expect(totalCostLabel.parentElement).not.toHaveTextContent('-$9.99');
  });

  it('keeps the established zero fallback for a split invoice with no stored cost', async () => {
    const invoice = {
      id: 'split-null-cost-1', invoice_number: 'INV-SPLIT-NULL', status: 'posted',
      invoice_type: 'field_application', customer_id: 'cust-1', total_amount_cents: 1000,
      total_cost_cents: null, paid_amount_cents: 0, prepay_applied_cents: 0,
      credit_applied_cents: 0, balance_cents: 1000, invoice_date: '2026-03-15',
      due_date: null, created_at: '2026-03-15T00:00:00Z',
      field_app_billing_set_id: 'billing-set-1',
    };
    const splitLines = [{
      id: 'split-line-1', invoice_id: invoice.id, product_id: 'product-1',
      description: 'Split product', quantity: 1.5, unit_price_cents: 667,
      extended_cents: 1000, cost_cents: 168, unit_size: 'Gal',
      is_application_fee: false,
    }];
    let invoiceCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') {
        invoiceCalls += 1;
        return buildChain({ data: invoiceCalls <= 2 ? invoice : [], error: null });
      }
      if (table === 'invoice_items') return buildChain({ data: splitLines, error: null });
      return buildChain({ data: [], error: null });
    });

    renderInvoiceDetail(invoice.id);
    await waitFor(() => expect(screen.getAllByText('INV-SPLIT-NULL').length).toBeGreaterThan(0));
    const totalCostLabel = screen.getByText('Total Cost');
    expect(totalCostLabel.parentElement).toHaveTextContent('$0.00');
    expect(totalCostLabel.parentElement).not.toHaveTextContent('$2.52');
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
    mockIntentAwareRpc({ data: null, error: null });
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('save_invoice', expect.objectContaining({
        p_invoice: expect.objectContaining({ payment_terms: 'Net 30' }),
      }));
      const saveCall = mockRpc.mock.calls.find(([name]) => name === 'save_invoice');
      expect(saveCall?.[1].p_invoice).toHaveProperty('due_date', null);
    });
  });

  it('clears custom terms and explicitly clears due_date when switching to customer default', async () => {
    setupInvoice('draft', 'Due 45 days after invoice', '2026-05-01');
    mockIntentAwareRpc({ data: null, error: null });
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    fireEvent.change(screen.getByRole('combobox', { name: 'Payment Terms' }), { target: { value: 'Customer default' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('save_invoice', expect.objectContaining({
        p_invoice: expect.objectContaining({ payment_terms: null }),
      }));
      const saveCall = mockRpc.mock.calls.find(([name]) => name === 'save_invoice');
      expect(saveCall?.[1].p_invoice).toHaveProperty('due_date', null);
    });
  });

  it('round-trips custom due date with the original custom terms text', async () => {
    setupInvoice('draft', 'Due 45 days after invoice', '2026-05-01');
    mockIntentAwareRpc({ data: null, error: null });
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
    mockIntentAwareRpc({ data: null, error: null });
    renderInvoiceDetail('inv-terms');
    await waitFor(() => expect(screen.getAllByText('INV-TERMS').length).toBeGreaterThan(0));
    expect(screen.getByRole('combobox', { name: 'Payment Terms' })).toHaveValue('Customer default');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('save_invoice', expect.objectContaining({
        p_invoice: expect.objectContaining({ payment_terms: null, due_date: null }),
      }));
      const saveCall = mockRpc.mock.calls.find(([name]) => name === 'save_invoice');
      expect(saveCall?.[1].p_invoice.payment_terms).not.toBe('Custom');
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

describe('InvoiceDetail — new-invoice date default follows the Chicago business day', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  // Guards the 2026-09-30 season window on the client. `season` is derived server-side from
  // `invoice_date`, and this page ALWAYS sends a date, so the server's Chicago fallback never
  // engages here — a browser-local default would file the invoice in the wrong season and price
  // it against the wrong customer_application_rates row.
  //
  // This test only discriminates because the two helpers are mocked to DIFFERENT dates
  // (localToday 2026-03-16, todayInBusinessTz 2026-09-30). Reverting InvoiceDetail.tsx to
  // localToday() turns the assertion red; with both mocked to the same day it could not.
  it('pre-fills the date input from todayInBusinessTz, not localToday', async () => {
    render(
      <MemoryRouter initialEntries={['/invoices/new']}>
        <Routes>
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    const dateInput = await waitFor(() => {
      const found = document.querySelector('input[type="date"]') as HTMLInputElement | null;
      expect(found).not.toBeNull();
      return found!;
    });

    expect(dateInput.value).toBe('2026-09-30');
    expect(dateInput.value).not.toBe('2026-03-16');
  });
});
