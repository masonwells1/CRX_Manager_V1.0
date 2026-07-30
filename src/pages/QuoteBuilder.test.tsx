/**
 * QuoteBuilder.test.tsx — Tests for the quote builder page
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockFrom, mockRpc, mockToast, mockNavigate, dirtyStates, mockGenerateQuotePdf, mockSendEmail } = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
    mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
    mockToast: vi.fn(),
    mockNavigate: vi.fn(),
    dirtyStates: [] as boolean[],
    mockGenerateQuotePdf: vi.fn(() => ({ output: () => new Blob(['quote']) })),
    mockSendEmail: vi.fn(),
  };
});

/**
 * Build a Supabase-like chain mock using real Promises.
 * Every chained method returns `self`, and `.then()` resolves with `result`.
 */
function buildChain(
  result: { data: unknown; error: unknown },
  onSelect?: (columns: unknown) => void,
): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) {
    self[m] = method;
  }
  self.select = (columns: unknown) => {
    onSelect?.(columns);
    return self;
  };
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

function buildPendingChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) {
    self[m] = method;
  }
  const promise = new Promise(() => {});
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

function buildUpdateChain(
  readResult: { data: unknown; error: unknown },
  updateResult: { data: unknown; error: unknown },
): Record<string, unknown> {
  let updated = false;
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['insert', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  self.update = (..._args: unknown[]) => {
    updated = true;
    return self;
  };
  self.select = (..._args: unknown[]) => self;
  const resolve = () => Promise.resolve(updated ? updateResult : readResult);
  self.then = (...args: Parameters<Promise<unknown>['then']>) => resolve().then(...args);
  self.catch = (...args: Parameters<Promise<unknown>['catch']>) => resolve().catch(...args);
  self.finally = (...args: Parameters<Promise<unknown>['finally']>) => resolve().finally(...args);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  supabaseUntyped: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  hasRpcCode: (error: { message?: string }, code: string) => error.message?.includes(code) ?? false,
  RpcErrorCodes: { QUOTE_STALE_WRITE: 'QUOTE_STALE_WRITE', CUSTOMER_STALE_WRITE: 'CUSTOMER_STALE_WRITE', COMMISSION_SPLIT_CONFLICT: 'COMMISSION_SPLIT_CONFLICT' },
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

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: (dirty: boolean) => {
    dirtyStates.push(dirty);
    return ({
    setDirty: vi.fn(),
    confirmNavigation: vi.fn(() => true),
    showModal: false,
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
    });
  },
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: vi.fn(), notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: vi.fn() }));
vi.mock('../lib/dateUtils', () => ({ localDatePlusDays: vi.fn(() => '2026-04-15'), localToday: vi.fn(() => '2026-03-16') }));
vi.mock('../lib/quotePdf', () => ({ downloadQuotePdf: vi.fn(), generateQuotePdf: mockGenerateQuotePdf }));
vi.mock('../lib/emailService', () => ({ sendEmail: mockSendEmail, pdfToBase64: vi.fn(), buildEmailHtml: vi.fn(() => '<p>test</p>') }));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: vi.fn().mockResolvedValue({ compliant: true, warnings: [], rupProductNames: [] }),
}));
vi.mock('../components/ui/CommissionSplitEditor', () => ({
  default: () => <div data-testid="commission-split-editor">CommissionSplitEditor</div>,
}));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));

import { preferredQuoteNotes } from '../lib/quoteNotes';
import QuoteBuilder from './QuoteBuilder';

function renderQuoteBuilder(id?: string) {
  const path = id ? `/quotes/${id}/edit` : '/quotes/new';
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/quotes/new" element={<QuoteBuilder />} />
        <Route path="/quotes/:id/edit" element={<QuoteBuilder />} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeQuoteFixture(status: 'draft' | 'accepted' = 'draft', rowVersion?: number) {
  const quote = {
    id: `quote-${status}-${rowVersion ?? 'legacy'}`,
    quote_number: 'Q-version-test',
    customer_id: 'customer-1',
    tier: 1,
    valid_days: 30,
    header_notes: 'Version test header',
    footer_notes: '',
    status,
    is_planned: false,
    commission_split: { splits: [] },
    created_at: '2026-07-25T00:00:00.000Z',
    ...(rowVersion === undefined ? {} : { row_version: rowVersion }),
  };
  const product = {
    id: 'product-1',
    product_name: 'Product',
    is_active: true,
    current_cost: 6,
    tier1_price: 10,
    unit_size: 'gal',
    inventory_unit: 'gal',
  };
  const section = {
    id: 'section-1',
    quote_id: quote.id,
    section_name: 'Products',
    sort_order: 0,
    section_notes: null,
    section_header_notes: null,
    needed_by_date: null,
    field_id: null,
  };
  const item = {
    id: 'item-1',
    quote_id: quote.id,
    section_id: section.id,
    product_id: product.id,
    sort_order: 0,
    product,
    calc_mode: 'units_direct',
    total_units_needed: 2,
    price_per_unit: 10,
    price_override: null,
    current_cost: 6,
    suggested_rate: null,
    actual_rate: null,
    rate_unit: null,
    oz_per_acre: null,
    price_per_acre: null,
    acres: null,
    unit_size: 'gal',
    profit: 8,
    total_price: 20,
    net_margin: 40,
    notes: null,
    price_unit: null,
  };
  return { quote, product, section, item };
}

describe('QuoteBuilder', () => {
  it('prefers customer-facing quoting guidance and falls back to the grower description', () => {
    expect(preferredQuoteNotes({ quoting_notes: 'Customer quote guidance', notes: 'Grower copy' }))
      .toBe('Customer quote guidance');
    expect(preferredQuoteNotes({ quoting_notes: null, notes: 'Grower copy' }))
      .toBe('Grower copy');
    expect(preferredQuoteNotes({ quoting_notes: '   ', notes: '  Grower copy  ' }))
      .toBe('Grower copy');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dirtyStates.length = 0;
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
    mockSendEmail.mockResolvedValue({ deduplicated: false });
  });

  it('renders the Quote Builder heading for a new quote', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Builder')).toBeInTheDocument();
    });
  });

  it('shows loading skeleton while fetching data for existing quote', () => {
    mockFrom.mockImplementation(() => buildPendingChain());
    mockRpc.mockImplementation(() => new Promise(() => {}));
    renderQuoteBuilder('quote-123');
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders customer select dropdown', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Select a customer...')).toBeInTheDocument();
    });
  });

  it('shows Save Draft button', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Save Draft')).toBeInTheDocument();
    });
  });

  it('renders breadcrumbs with Quotes link and New Quote', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Quotes')).toBeInTheDocument();
      expect(screen.getByText('New Quote')).toBeInTheDocument();
    });
  });

  it('handles quote not found gracefully when editing invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderQuoteBuilder('nonexistent-id');
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'Quote not found');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/quotes');
  });

  it('renders the commission split editor', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByTestId('commission-split-editor')).toBeInTheDocument();
    });
  });

  it('loads and renders the real Product family on a persisted quote row', async () => {
    const product = {
      id: '11111111-1111-4111-8111-111111111111',
      product_name: 'Exact Product',
      sku: 'SKU-EXACT',
      is_active: true,
      inventory_unit: 'gal',
      packaging_variant: '2 x 2.5 gal',
      return_policy: 'returnable',
      is_full_tote_only: false,
      product_family: { name: 'Family Alpha' },
    };
    const quote = {
      id: 'quote-123',
      quote_number: 'Q-2026-0123',
      customer_id: null,
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      status: 'draft',
      is_planned: false,
      commission_split: null,
      created_at: '2026-07-25T00:00:00.000Z',
    };
    const section = {
      id: 'section-1',
      quote_id: quote.id,
      section_name: 'Products',
      sort_order: 1,
      section_notes: null,
      section_header_notes: null,
      needed_by_date: null,
      field_id: null,
    };
    const item = {
      id: 'item-1',
      quote_id: quote.id,
      section_id: section.id,
      product_id: product.id,
      sort_order: 1,
      product,
      calc_mode: 'units_direct',
      total_units_needed: 1,
      price_per_unit: 1000,
      price_override: null,
      current_cost: 700,
      suggested_rate: null,
      actual_rate: null,
      rate_unit: null,
      oz_per_acre: null,
      price_per_acre: null,
      acres: null,
      unit_size: null,
      profit: 300,
      total_price: 1000,
      net_margin: 30,
      notes: null,
      price_unit: null,
    };
    const quoteItemSelects: unknown[] = [];

    mockFrom.mockImplementation((table: string) => {
      const data = table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'products'
              ? [product]
              : [];
      return buildChain(
        { data, error: null },
        table === 'quote_items' ? (columns) => quoteItemSelects.push(columns) : undefined,
      );
    });

    renderQuoteBuilder(quote.id);

    expect(await screen.findByText('Family: Family Alpha')).toBeInTheDocument();
    expect(screen.getAllByText('SKU: SKU-EXACT')).toHaveLength(1);
    expect(quoteItemSelects).toContain('*, product:products(*, product_family:product_families(name))');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves a stale edit until Reload Quote replaces it and sends the refreshed version on the next save', async () => {
    const quote = { id: 'quote-stale', quote_number: 'Q-stale', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    const reloadedQuote = { ...quote, header_notes: 'Newer header', row_version: 8 };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : reloadedQuote) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote' ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } } : { data: null, error: null }));
    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Original header');
    fireEvent.change(header, { target: { value: 'Unsaved header edit' } });
    fireEvent.click(screen.getByText('Save Draft'));
    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 7, header_notes: 'Unsaved header edit' }),
    }));
    const readsBeforeKeepEditing = quoteReads;
    fireEvent.click(screen.getByText('Keep editing'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());
    expect((screen.getByDisplayValue('Unsaved header edit') as HTMLTextAreaElement).value).toBe('Unsaved header edit');
    expect(quoteReads).toBe(readsBeforeKeepEditing);

    fireEvent.click(screen.getByText('Save Draft'));
    await screen.findByText('Reload Quote');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect((screen.getByDisplayValue('Newer header') as HTMLTextAreaElement).value).toBe('Newer header'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 8, header_notes: 'Newer header' }),
    })));
  });

  it('shows Reload/review for a stale draft save after another tab sent the quote', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? {
          data: null,
          error: {
            code: 'P0001',
            message: 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving',
          },
        }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue(quote.header_notes);
    fireEvent.change(header, { target: { value: 'Keep stale draft edit for review' } });
    fireEvent.click(screen.getByText('Save Draft'));

    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep stale draft edit for review')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({
        status: 'draft',
        row_version_expected: 7,
        header_notes: 'Keep stale draft edit for review',
      }),
    }));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('keeps a pre-migration existing Quote save compatible when both tokens are absent', async () => {
    const { quote, product, section, item } = makeQuoteFixture();
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByText('Save Draft'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: null }),
    })));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('reloads a pre-migration Quote after a commission-split conflict without requiring a row-version token', async () => {
    const { quote, product, section, item } = makeQuoteFixture();
    const reloadedQuote = {
      ...quote,
      header_notes: 'Saved by the other workflow',
      commission_split: { splits: [{ sales_rep_id: 'admin-1', percentage: 100 }] },
    };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : reloadedQuote)
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: null, error: { code: 'P0001', message: 'COMMISSION_SPLIT_CONFLICT: changed elsewhere' } }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue(quote.header_notes);
    fireEvent.change(header, { target: { value: 'Unsaved local edit' } });
    fireEvent.click(screen.getByText('Save Draft'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload Quote' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('Saved by the other workflow')).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('stable saved quote'));
  });

  it('adopts an exact N+1 save token and sends it on the next same-page save', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    let saveCalls = 0;
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: ++saveCalls === 1 ? 8 : 9 }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByText('Save Draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 7 }),
    })));
    await waitFor(() => expect(screen.getByText('Save Draft')).not.toBeDisabled());

    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => {
      const quoteSaves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(quoteSaves).toHaveLength(2);
      expect(quoteSaves[1][1]).toEqual(expect.objectContaining({
        p_quote_payload: expect.objectContaining({ row_version_expected: 8 }),
      }));
    });
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('rejects a missing authoritative save token after a numeric Quote token was loaded', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByText('Save Draft'));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 7 }),
    }));
  });

  it('keeps a pre-migration same-page reopen compatible when its reread remains tokenless', async () => {
    const { quote, product, section, item } = makeQuoteFixture('accepted');
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : name === 'save_quote'
        ? { data: { quote_id: quote.id }, error: null }
        : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), {
      target: { value: 'Corrected customer request' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Un-accept' })[1]);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Quote reopened to sent.'));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    fireEvent.click(await screen.findByRole('button', { name: 'Revise Quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: null }),
    })));
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version'));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('keeps a committed direct decline visible and opens recovery when its returned version jumps from 7 to 9', async () => {
    const quote = { id: 'quote-direct-jump', quote_number: 'Q-direct-jump', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Keep this local note', footer_notes: '', status: 'sent', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quotes') {
        return buildUpdateChain(
          { data: quote, error: null },
          { data: [{ ...quote, status: 'declined', row_version: 9 }], error: null },
        );
      }
      const data = table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [];
      return buildChain({ data, error: null });
    });

    renderQuoteBuilder(quote.id);
    fireEvent.change(await screen.findByDisplayValue('Keep this local note'), { target: { value: 'Keep this local edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline Quote' }));

    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getAllByText('declined')).not.toHaveLength(0);
    expect(screen.getByDisplayValue('Keep this local edit')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('another edit may have completed'));
  });

  it('keeps the conflict dialog and every local quote edit when Reload cannot read sections', async () => {
    const quote = { id: 'quote-partial', quote_number: 'Q-partial', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let sectionReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quote_sections' && ++sectionReads > 1) return buildChain({ data: null, error: { message: 'sections unavailable' } });
      const data = table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [];
      return buildChain({ data, error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'QUOTE_STALE_WRITE' } });
    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Original header');
    fireEvent.change(header, { target: { value: 'Keep this quote edit' } });
    fireEvent.click(screen.getByText('Save Draft'));
    await screen.findByText('Reload Quote');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('current edits were kept')));
    expect(screen.getByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this quote edit')).toBeInTheDocument();
  });

  it('keeps the conflict dialog and local quote when the header version changes during Reload', async () => {
    const quote = { id: 'quote-unstable-reload', quote_number: 'Q-unstable', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    const changedQuote = { ...quote, header_notes: 'Other writer header', row_version: 8 };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => {
      const quoteData = table === 'quotes'
        ? (++quoteReads <= 2 ? quote : quoteReads === 3 ? changedQuote : { row_version: 9 })
        : null;
      return buildChain({ data: table === 'quotes' ? quoteData : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'QUOTE_STALE_WRITE' } });
    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Original header');
    fireEvent.change(header, { target: { value: 'Keep this quote edit' } });
    fireEvent.click(screen.getByText('Save Draft'));
    await screen.findByText('Reload Quote');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('stable saved quote')));
    expect(screen.getByText('Reload Quote')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this quote edit')).toBeInTheDocument();
  });

  it('uses the reread token after reopening before the next revise/save', async () => {
    const quote = { id: 'quote-reopen', quote_number: 'Q-reopen', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : { row_version: 8 }) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : { data: { quote_id: quote.id, row_version: 9 }, error: null }));
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), { target: { value: 'Corrected customer request' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Un-accept' })[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Revise Quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 8 }),
    })));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('fails closed instead of adopting a jumped post-reopen token', async () => {
    const quote = { id: 'quote-jumped-token', quote_number: 'Q-jumped', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : { row_version: 9 }) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : { data: { quote_id: quote.id, row_version: 10 }, error: null }));
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), { target: { value: 'Corrected customer request' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Un-accept' })[1]);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('save-protection version could not be confirmed')));
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote reopened to sent.');
    fireEvent.click(await screen.findByRole('button', { name: 'Revise Quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: null }),
    })));
  });

  it('keeps the committed reopened status and gives refresh guidance when its token reread fails', async () => {
    const quote = { id: 'quote-reopen-read-fail', quote_number: 'Q-reopen-read-fail', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'quotes') {
        quoteReads += 1;
        return buildChain(quoteReads <= 2 ? { data: quote, error: null } : { data: null, error: { message: 'row version read failed' } });
      }
      return buildChain({ data: table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : [], error: null });
    });
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'revert_quote_status'
      ? { data: { success: true, old_status: 'accepted', new_status: 'sent' }, error: null }
      : { data: null, error: null }));
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Un-accept' }));
    fireEvent.change(screen.getByPlaceholderText('Why is this quote being reopened?'), { target: { value: 'Corrected customer request' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Un-accept' })[1]);
    await waitFor(() => expect(screen.getByText('sent')).toBeInTheDocument());
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('was reopened'));
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote reopened to sent.');
  });

  it('uses the reread token after freezing a quote before the next revise/save', async () => {
    const quote = { id: 'quote-freeze', quote_number: 'Q-freeze', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-25T00:00:00.000Z' };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    let quoteSaves = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : { row_version: 9 }) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: ++quoteSaves === 1 ? 8 : 10 }, error: null }
      : { data: { version_number: 1 }, error: null }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:quote'), revokeObjectURL: vi.fn() });
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as Presented' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.anything()));
    await waitFor(() => expect(screen.getByText('sent')).toBeInTheDocument());
    fireEvent.click(await screen.findByRole('button', { name: 'Revise Quote' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_payload: expect.objectContaining({ row_version_expected: 9 }),
    })));
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
  });

  it('requires a numeric reload and a new confirmed freeze before retrying an aborted email', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let recoveryReadMode: 'jumped' | 'tokenless' | 'stable' | 'refrozen' = 'jumped';
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2
            ? quote
            : recoveryReadMode === 'tokenless'
              ? { ...quote, status: 'sent', row_version: undefined }
              : { ...quote, status: 'sent', row_version: recoveryReadMode === 'refrozen' ? 10 : 9 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockResolvedValue({ data: { version_number: 1, status: 'created' }, error: null });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to Grower' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('email was NOT sent'),
    );
    fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Email to Grower' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('email was NOT sent'),
    ));
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));

    recoveryReadMode = 'tokenless';
    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('stable saved quote'),
    ));
    expect(screen.getByText('Reload Quote')).toBeInTheDocument();
    expect(mockSendEmail).not.toHaveBeenCalled();

    recoveryReadMode = 'stable';
    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());
    recoveryReadMode = 'refrozen';
    fireEvent.click(screen.getByRole('button', { name: 'Email to Grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'create_quote_version')).toHaveLength(2);
  });

  it('stops Book as Order when mark-presented cannot confirm the frozen quote token', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 3 ? quote : { row_version: 10 })
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8 }, error: null }
        : name === 'create_quote_version'
          ? { data: { version_number: 1, status: 'created' }, error: null }
          : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Book as Order' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Book as Order' })[1]);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('order was not created'),
    );
    fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    const retryBookButtons = screen.getAllByRole('button', { name: 'Book as Order' });
    fireEvent.click(retryBookButtons[retryBookButtons.length - 1]);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('order was not created'),
    ));
    expect(mockRpc).not.toHaveBeenCalledWith('convert_quote_to_order', expect.anything());
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.stringContaining('marked as presented'));
  });
});
