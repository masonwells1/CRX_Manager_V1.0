/**
 * QuoteBuilder.test.tsx — Tests for the quote builder page
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter } from 'react-router-dom';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockFrom,
  mockRpc,
  mockToast,
  mockNavigate,
  dirtyStates,
  mockGenerateQuotePdf,
  mockSendEmail,
  mockNotifyLargeOrder,
  mockTrackBusinessEvent,
  mockSendOrderConfirmedEmail,
  mockResetIdempotencyKey,
  quoteIdempotencyState,
} = vi.hoisted(() => {
  const quoteIdempotencyState = { generation: 0 };
  return {
    mockFrom: vi.fn(),
    mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
    mockToast: vi.fn(),
    mockNavigate: vi.fn(),
    dirtyStates: [] as boolean[],
    mockGenerateQuotePdf: vi.fn(() => ({ output: () => new Blob(['quote']) })),
    mockSendEmail: vi.fn(),
    mockNotifyLargeOrder: vi.fn(),
    mockTrackBusinessEvent: vi.fn(),
    mockSendOrderConfirmedEmail: vi.fn(),
    mockResetIdempotencyKey: vi.fn(() => { quoteIdempotencyState.generation += 1; }),
    quoteIdempotencyState,
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

vi.mock('../lib/db', async () => {
  // Use the REAL sanitizeError. A hand-written stub shaped
  // `e instanceof Error ? e.message : …` re-implements the defect this PR fixes
  // and would stay green against a fully regressed screen; a stub that just
  // reads `.message` skips the redaction entirely, so schema-identifier leaks
  // could not be caught here either.
  const { sanitizeError } = await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  );
  const hasRpcCode = (error: { message?: string }, code: string) => (
    error.message === code
    || error.message?.startsWith(`${code}:`) === true
    || error.message?.startsWith(`${code} `) === true
  );
  return {
    supabase: { from: mockFrom, rpc: mockRpc },
    supabaseUntyped: { from: mockFrom, rpc: mockRpc },
    checkMutationResult: vi.fn(),
    assertRpcResult: vi.fn((d) => d),
    hasRpcCode,
    RpcErrorCodes: {
      AUTH_REQUIRED: 'AUTH_REQUIRED', ACTOR_MISMATCH: 'ACTOR_MISMATCH',
      INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE', BOOKING_QUANTITY_INVALID: 'BOOKING_QUANTITY_INVALID',
      BOOKING_PRODUCT_INVALID: 'BOOKING_PRODUCT_INVALID', BOOKING_OVERDRAWN: 'BOOKING_OVERDRAWN',
      BOOKING_CLOSED: 'BOOKING_CLOSED', EMPTY_DRAW: 'EMPTY_DRAW',
      BOOKED_PRICE_REQUIRED: 'BOOKED_PRICE_REQUIRED', COST_BASIS_REQUIRED: 'COST_BASIS_REQUIRED',
      DRAW_ALLOCATION_MISMATCH: 'DRAW_ALLOCATION_MISMATCH', QUOTE_STALE_WRITE: 'QUOTE_STALE_WRITE',
      CUSTOMER_STALE_WRITE: 'CUSTOMER_STALE_WRITE', COMMISSION_SPLIT_CONFLICT: 'COMMISSION_SPLIT_CONFLICT',
      IDEMPOTENCY_PAYLOAD_CONFLICT: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
      QUOTE_VERSION_LEGACY_UNTRUSTED: 'QUOTE_VERSION_LEGACY_UNTRUSTED',
    },
    rpcAuthErrorMessage: (error: { message?: string }) => (
      hasRpcCode(error, 'AUTH_REQUIRED') || hasRpcCode(error, 'ACTOR_MISMATCH')
        ? 'Your sign-in could not be verified. Refresh the page and try again.'
        : null
    ),
    sanitizeError,
  };
});

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
  useIdempotencyKey: () => ({
    getKey: () => `test-idem-key-${quoteIdempotencyState.generation}`,
    resetKey: mockResetIdempotencyKey,
  }),
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
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: mockNotifyLargeOrder, notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: mockTrackBusinessEvent }));
vi.mock('../lib/orderConfirmedEmail', () => ({ sendOrderConfirmedEmail: mockSendOrderConfirmedEmail }));
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

// A RECENT timestamp, not a literal. These fixtures once hardcoded
// a fixed created_at of 2026‑07‑25T00:00:00Z — a time bomb: useStaleQuoteCheck computes
// floor((Date.now() − created_at) / day) > 30, so on 2026-08-25T00:00:00Z (exactly
// created + 31 days) every conversion-path test silently detoured into the
// stale-quote guard and CI went permanently red on EVERY branch at midnight UTC.
// Five days old keeps the fixtures far from the staleness threshold forever, and a
// midnight-anchored ISO string keeps the rendered date deterministic within a run.
const RECENT_QUOTE_CREATED_AT = `${new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;

function makeQuoteFixture(status: 'draft' | 'sent' | 'accepted' = 'draft', rowVersion?: number) {
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
    created_at: RECENT_QUOTE_CREATED_AT,
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

function configureDrawDownFixture(
  drawError: { message: string; details?: string },
  { failRecoveryLoad = false }: { failRecoveryLoad?: boolean } = {},
) {
  const fixture = makeQuoteFixture('sent', 7);
  let quoteItemReads = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'quote_items') quoteItemReads += 1;
    if (table === 'quote_items' && failRecoveryLoad && quoteItemReads >= 3) {
      return buildChain({ data: null, error: { message: 'booking balance unavailable' } });
    }
    const data = table === 'quotes'
      ? fixture.quote
      : table === 'quote_sections'
        ? [fixture.section]
        : table === 'quote_items'
          ? [fixture.item]
          : table === 'customers'
            ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
            : table === 'products'
              ? [fixture.product]
              : [];
    return buildChain({ data, error: null });
  });
  mockRpc.mockImplementation((name: string) => Promise.resolve(
    name === 'draw_down_quote'
      ? { data: null, error: drawError }
      : { data: null, error: null },
  ));
  return { ...fixture, quoteItemReads: () => quoteItemReads };
}

async function submitOneUnitDraw(quoteId: string) {
  renderQuoteBuilder(quoteId);
  const createOrderButton = await screen.findByRole('button', { name: /Create Order/ });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
  fireEvent.click(createOrderButton);
  fireEvent.click(await screen.findByRole('menuitem', { name: /Draw part of booking/ }));
  expect(mockToast).not.toHaveBeenCalledWith('warning', 'Save the quote before drawing down the booking');
  const dialog = await screen.findByRole('dialog', { name: 'Create Order from Booking' });
  const quantity = await within(dialog).findByRole('spinbutton');
  fireEvent.change(quantity, { target: { value: '1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create Order' }));
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
    quoteIdempotencyState.generation = 0;
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

  it('opens the exact receipt-proven order after a changed draw intent', async () => {
    const priorOrderId = '99999999-9999-9999-9999-999999999999';
    const { quote } = configureDrawDownFixture({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({
        operation: 'draw_down_quote',
        result: { order_id: priorOrderId, order_number: 'O-EXISTING' },
      }),
    });

    await submitOneUnitDraw(quote.id);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(`/orders/${priorOrderId}`));
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('already created an order'),
    );
    expect(screen.queryByRole('dialog', { name: 'Create Order from Booking' })).not.toBeInTheDocument();
  });

  it('sends the operator to Orders when a changed-intent receipt cannot be opened', async () => {
    const fixture = configureDrawDownFixture({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({ operation: 'draw_down_quote', result: null }),
    });

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('prior outcome could not be opened'),
    ));
    expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Check Orders for this booking before drawing again'),
    );
    expect(mockToast).not.toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('booking balance was reloaded; try again'),
    );
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringMatching(/^\/orders\//));
    expect(screen.queryByRole('dialog', { name: 'Create Order from Booking' })).not.toBeInTheDocument();
  });

  it('maps a malformed draw product to a governed operator error', async () => {
    const fixture = configureDrawDownFixture({ message: 'BOOKING_PRODUCT_INVALID: draw product id must be a UUID' });

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'A draw line has an invalid product reference. Refresh the booking and try again.',
    ));
  });

  it('retires another actor retry and reloads the booking balance in the open modal', async () => {
    const fixture = configureDrawDownFixture({ message: 'IDEMPOTENCY_ACTOR_MISMATCH' });

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('belongs to another signed-in user'),
    ));
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(fixture.quoteItemReads()).toBeGreaterThanOrEqual(3);
    const dialog = screen.getByRole('dialog', { name: 'Create Order from Booking' });
    expect(within(dialog).getByRole('spinbutton')).toHaveValue(null);
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringMatching(/^\/orders\//));
  });

  it('does not claim the booking balance reloaded when mismatch recovery reads fail', async () => {
    const fixture = configureDrawDownFixture(
      { message: 'IDEMPOTENCY_ACTOR_MISMATCH' },
      { failRecoveryLoad: true },
    );

    await submitOneUnitDraw(fixture.quote.id);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('booking balance could not be reloaded'),
    ));
    expect(mockToast).not.toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('booking balance was reloaded'),
    );
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Create Order from Booking' })).not.toBeInTheDocument();
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
      created_at: RECENT_QUOTE_CREATED_AT,
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
    const quote = { id: 'quote-stale', quote_number: 'Q-stale', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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

  it('recovers a legacy cached save after the migration boundary and releases its unusable key', async () => {
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
    let saveAttempts = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      saveAttempts += 1;
      return Promise.resolve(saveAttempts === 1
        ? { data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } }
        : { data: { quote_id: quote.id, row_version: 8 }, error: null });
    });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByText('Save Draft'));

    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenLastCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: 'test-idem-key-0',
    }));
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: 'test-idem-key-1',
    })));
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
    const quote = { id: 'quote-direct-jump', quote_number: 'Q-direct-jump', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Keep this local note', footer_notes: '', status: 'sent', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-partial', quote_number: 'Q-partial', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-unstable-reload', quote_number: 'Q-unstable', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-reopen', quote_number: 'Q-reopen', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-jumped-token', quote_number: 'Q-jumped', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-reopen-read-fail', quote_number: 'Q-reopen-read-fail', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-freeze', quote_number: 'Q-freeze', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
    const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
    const section = { id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
    const item = { id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };
    let quoteReads = 0;
    let quoteSaves = 0;
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? (++quoteReads <= 2 ? quote : { row_version: 9 }) : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: ++quoteSaves === 1 ? 8 : 10 }, error: null }
      : { data: { version_number: 1, row_version: 9 }, error: null }));
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:quote'), revokeObjectURL: vi.fn() });
    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as Presented' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({
      p_expected_row_version: 8,
    })));
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
    mockRpc.mockImplementation(() => Promise.resolve({
      data: {
        version_number: 1,
        status: 'created',
        row_version: recoveryReadMode === 'refrozen' ? 10 : 8,
      },
      error: null,
    }));

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

  it('creates and confirms a new version before emailing an already-sent quote after remount', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const { product, section, item } = fixture;
    const quote = { ...fixture.quote, status: 'sent' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : { ...quote, row_version: 8 })
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
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'create_quote_version'
        ? { data: { version_number: 2, status: 'created', row_version: 8 }, error: null }
        : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to Grower' }));

    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({
      p_quote_id: quote.id,
      p_method: 'emailed',
      p_expected_row_version: 7,
    }));
    expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));
  });

  it('replays the same version key and original token after the snapshot succeeds but email delivery fails', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let createVersionCalls = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : { ...quote, status: 'sent', row_version: 8 })
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
    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_quote_version') {
        createVersionCalls += 1;
        return Promise.resolve({
          data: {
            version_number: 1,
            status: createVersionCalls === 1 ? 'created' : 'duplicate',
            row_version: 8,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockSendEmail
      .mockRejectedValueOnce(new Error('email transport failed'))
      .mockResolvedValueOnce({ deduplicated: false });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to Grower' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'email transport failed'));

    fireEvent.click(screen.getByRole('button', { name: 'Email to Grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(2));

    const versionCalls = mockRpc.mock.calls.filter(([name]) => name === 'create_quote_version');
    expect(versionCalls).toHaveLength(2);
    expect(versionCalls[0][1]).toEqual(expect.objectContaining({
      p_expected_row_version: 7,
    }));
    expect(versionCalls[1][1]).toEqual(expect.objectContaining({
      p_idempotency_key: versionCalls[0][1].p_idempotency_key,
      p_expected_row_version: 7,
    }));
    expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));
  });

  it('uses the cached post token when the first lifecycle response is lost', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let createVersionCalls = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : { ...quote, status: 'sent', row_version: 8 })
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
    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_quote_version') {
        createVersionCalls += 1;
        return Promise.resolve(createVersionCalls === 1
          ? { data: null, error: { message: 'network response lost' } }
          : {
              data: {
                version_number: 1,
                status: 'duplicate',
                row_version: 8,
              },
              error: null,
            });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to Grower' }));
    // ASSERTION DELIBERATELY CHANGED (H5 follow-up). This waited on the canned
    // literal 'Failed to email the quote', which only appeared because the
    // create_quote_version failure — a PLAIN OBJECT from a non-throwing rpc, so
    // `err instanceof Error` was false — had its real message discarded. The
    // subject of this test is the cached post token, not the toast text; it now
    // waits on the reason the server actually gave.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'network response lost'));
    expect(mockSendEmail).not.toHaveBeenCalled();
    // The message reaching the operator went through the REAL sanitizer, so a
    // raw schema identifier could never have been passed along with it.
    const shownHere = mockToast.mock.calls.map((c) => String(c[1])).join(' | ');
    expect(shownHere).not.toMatch(/permission denied for|schema cache|relation "/i);

    fireEvent.click(screen.getByRole('button', { name: 'Email to Grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));

    const versionCalls = mockRpc.mock.calls.filter(([name]) => name === 'create_quote_version');
    expect(versionCalls).toHaveLength(2);
    expect(versionCalls[1][1]).toEqual(expect.objectContaining({
      p_idempotency_key: versionCalls[0][1].p_idempotency_key,
      p_expected_row_version: 7,
    }));
    expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument();
  });

  it('holds a stale version action key until a stable reload, then retries with the refreshed quote token', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    let createVersionCalls = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2
            ? quote
            : { ...quote, row_version: quoteReads <= 4 ? 8 : 9 })
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
    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_quote_version') {
        createVersionCalls += 1;
        return Promise.resolve(createVersionCalls === 1
          ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } }
          : { data: { version_number: 2, status: 'created', row_version: 9 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Email to Grower' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reload Quote' })).toBeInTheDocument());
    expect(mockSendEmail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Email to Grower' }));
    expect(createVersionCalls).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument());
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Email to Grower' }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith('create_quote_version', expect.objectContaining({
      p_expected_row_version: 8,
    }));
  });

  it('stops on an unconfirmed accepted save and safely resumes conversion after reload', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const { product, section, item } = fixture;
    const quote = { ...fixture.quote, status: 'sent', created_at: new Date().toISOString() };
    let reloaded = false;
    let saveCalls = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (reloaded ? { ...quote, status: 'accepted', row_version: 9 } : quote)
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
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_quote') {
        saveCalls += 1;
        return Promise.resolve({
          data: { quote_id: quote.id, row_version: saveCalls === 1 ? 9 : 10 },
          error: null,
        });
      }
      if (name === 'convert_quote_to_order') {
        return Promise.resolve({
          data: { status: 'already_converted', order_id: 'order-1', warnings: [] },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    const createOrderOpener = await screen.findByRole('button', { name: 'Create Order ▾' });
    await waitFor(() => expect(createOrderOpener).toBeEnabled());
    fireEvent.click(createOrderOpener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const initialConvertDialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    const initialConvertButton = within(initialConvertDialog).getByRole('button', { name: 'Create Order' });
    await waitFor(() => expect(initialConvertButton).toBeEnabled());
    fireEvent.click(initialConvertButton);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('quote was saved'));
    expect(mockRpc).not.toHaveBeenCalledWith('convert_quote_to_order', expect.anything());

    reloaded = true;
    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Create Order ▾' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const resumedConvertDialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    fireEvent.click(within(resumedConvertDialog).getByRole('button', { name: 'Create Order' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(
      'convert_quote_to_order',
      expect.objectContaining({ p_quote_id: quote.id, p_expected_row_version: 9 }),
    ));
    expect(saveCalls).toBe(1);
    expect(mockToast).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('already converted'),
    );
    expect(mockTrackBusinessEvent).not.toHaveBeenCalled();
    expect(mockNotifyLargeOrder).not.toHaveBeenCalled();
    expect(mockSendOrderConfirmedEmail).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/orders/order-1');
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
          ? { data: { version_number: 1, status: 'created', row_version: 9 }, error: null }
          : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    await waitFor(() => {
      const bookAsOrderOpener = screen.getByRole('button', { name: 'Book as Order' });
      expect(bookAsOrderOpener).toBeEnabled();
      fireEvent.click(bookAsOrderOpener);
      expect(screen.getByRole('dialog', { name: 'Book as Order' })).toBeInTheDocument();
    });
    const initialBookDialog = screen.getByRole('dialog', { name: 'Book as Order' });
    fireEvent.click(within(initialBookDialog).getByRole('button', { name: 'Book as Order' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('save-protection version could not be confirmed'),
    ));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('quote was frozen'));
    fireEvent.click(screen.getByRole('button', { name: /Keep editing/i }));
    const retryBookDialog = await screen.findByRole('dialog', { name: 'Book as Order' });
    expect(within(retryBookDialog).getByText('Mark this quote as sent and convert it to an order now?')).toBeInTheDocument();
    fireEvent.click(within(retryBookDialog).getByRole('button', { name: 'Book as Order' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Reload the quote, then try Book as Order again'),
    ));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('quote was frozen'));
    expect(mockRpc).not.toHaveBeenCalledWith('convert_quote_to_order', expect.anything());
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.stringContaining('marked as presented'));
  });

  // ── Route changes must never save the quote the operator left ─────────────
  //
  // App.tsx routes both `quotes/new` and `quotes/:id` to one <QuoteBuilder />
  // with no `key`, so moving between two saved quotes re-runs the id effect on
  // the SAME mounted component: quoteId, the form contents and the save target
  // all survive the navigation. These tests drive a real data router the same
  // way, with deliberately delayed loads, and mount the real page.

  function openableGate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  }

  /**
   * A Supabase-like chain that decides its result LAZILY, when the query is
   * finally awaited. Every `.eq()` has landed by then, so the resolver can see
   * which quote is being requested and hold that quote's load open.
   */
  function buildLazyChain(
    resolveResult: (filters: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  ): Record<string, unknown> {
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {};
    const passthrough = (..._args: unknown[]) => self;
    const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'neq',
      'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
      'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
      'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
      'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
    for (const m of methods) self[m] = passthrough;
    self.eq = (column: unknown, value: unknown) => {
      filters[String(column)] = value;
      return self;
    };
    // Recorded so the resolver can tell a load's OPENING header read (the only
    // one that joins the customer) from the confirm-version read that follows
    // it. That is what lets one quote be loaded twice with different content.
    self.select = (columns: unknown) => {
      filters.__select = columns;
      return self;
    };
    let started: Promise<{ data: unknown; error: unknown }> | null = null;
    const run = () => {
      if (!started) started = resolveResult(filters);
      return started;
    };
    self.then = (...args: Parameters<Promise<unknown>['then']>) => run().then(...args);
    self.catch = (...args: Parameters<Promise<unknown>['catch']>) => run().catch(...args);
    self.finally = (...args: Parameters<Promise<unknown>['finally']>) => run().finally(...args);
    return self;
  }

  function makeSwitchFixture(id: string, quoteNumber: string) {
    const base = makeQuoteFixture('draft');
    const quote = { ...base.quote, id, quote_number: quoteNumber };
    const section = { ...base.section, id: `section-${id}`, quote_id: id };
    const item = { ...base.item, id: `item-${id}`, quote_id: id, section_id: section.id };
    return { quote, section, item, product: base.product };
  }

  /**
   * Per-load control for ONE quote id: entry `n` applies to the n-th load of
   * that quote. `wait` holds that load open; `quoteNumber` gives it distinct
   * content so the test can tell which of two loads of the SAME quote installed.
   */
  type QuoteLoadPlan = Record<string, { wait?: Promise<void>; quoteNumber?: string }[]>;

  function renderQuoteSwitch(
    fixtures: ReturnType<typeof makeSwitchFixture>[],
    gates: Record<string, Promise<void>>,
    options: { failSectionsFor?: string; loadPlan?: QuoteLoadPlan } = {},
  ) {
    const byId = new Map(fixtures.map((f) => [f.quote.id, f]));
    const loadCounts = new Map<string, number>();
    mockFrom.mockImplementation((table: string) => buildLazyChain(async (filters) => {
      const requestedId = String(filters.quote_id ?? filters.id ?? '');
      const fixture = byId.get(requestedId);
      // A load opens with the header read that joins the customer; the later
      // read of the same table is the confirm-version read within that load.
      const opensALoad = table === 'quotes'
        && String(filters.__select ?? '').includes('customer:customers');
      let step: { wait?: Promise<void>; quoteNumber?: string } | undefined;
      if (opensALoad) {
        const nth = loadCounts.get(requestedId) ?? 0;
        loadCounts.set(requestedId, nth + 1);
        step = options.loadPlan?.[requestedId]?.[nth];
      }
      if (step?.wait) await step.wait;
      const gate = gates[requestedId];
      if (fixture && gate) await gate;
      switch (table) {
        case 'quotes':
          if (!fixture) return { data: null, error: null };
          return {
            data: step?.quoteNumber
              ? { ...fixture.quote, quote_number: step.quoteNumber }
              : fixture.quote,
            error: null,
          };
        case 'quote_sections':
          return options.failSectionsFor === requestedId
            ? { data: null, error: { message: 'sections unavailable' } }
            : { data: fixture ? [fixture.section] : [], error: null };
        case 'quote_items':
          return { data: fixture ? [fixture.item] : [], error: null };
        case 'customers':
          return {
            data: [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }],
            error: null,
          };
        case 'products':
          return { data: [fixtures[0].product], error: null };
        default:
          return { data: [], error: null };
      }
    }));
    const router = createMemoryRouter(
      // `quotes/:id` is App.tsx's real pattern for a saved quote. Using it here
      // means both ids resolve to the SAME route, so React Router reuses the
      // element instead of remounting it — which is precisely the condition
      // these tests exist to cover.
      [{ path: '/quotes/:id', element: <QuoteBuilder /> }],
      { initialEntries: [`/quotes/${fixtures[0].quote.id}`] },
    );
    render(<RouterProvider router={router} />);
    return router;
  }

  async function goToQuote(router: ReturnType<typeof createMemoryRouter>, id: string) {
    await act(async () => { await router.navigate(`/quotes/${id}`); });
  }

  async function flushPendingWork() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it('stops presenting quote A once the route points at a quote B that has not loaded', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const gateB = openableGate();
    const router = renderQuoteSwitch([quoteA, quoteB], { 'quote-b': gateB.opened });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    await screen.findByRole('button', { name: /Save Draft/ });

    await goToQuote(router, 'quote-b');

    // The URL says quote B. Quote A's form must not still be sitting there
    // looking current, and its Save button must not still be live: the save
    // target is quoteId, which is still A until B installs.
    await waitFor(() => expect(screen.queryAllByText('Q-AAA-1')).toHaveLength(0));
    expect(screen.queryAllByText('Q-BBB-2')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Save Draft/ })).not.toBeInTheDocument();
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());

    gateB.open();
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
  });

  it('drops quote B late response after the operator has already moved on to quote C', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const quoteC = makeSwitchFixture('quote-c', 'Q-CCC-3');
    const gateB = openableGate();
    const router = renderQuoteSwitch([quoteA, quoteB, quoteC], { 'quote-b': gateB.opened });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);

    // A -> B (slow) -> C (fast). C wins the race and installs first.
    await goToQuote(router, 'quote-b');
    await goToQuote(router, 'quote-c');
    expect(await screen.findAllByText('Q-CCC-3')).not.toHaveLength(0);

    // B's reply finally arrives. It describes a quote the page left two
    // navigations ago, so it must install nothing.
    gateB.open();
    await flushPendingWork();

    expect(screen.getAllByText('Q-CCC-3')).not.toHaveLength(0);
    expect(screen.queryAllByText('Q-BBB-2')).toHaveLength(0);
  });

  // The next two tests exist to keep each HALF of the load guard load-bearing.
  // Every test above navigates between DIFFERENT quotes, where the route binding
  // alone is enough — so on those alone the call-order half could be deleted
  // with the suite still green, and vice versa. These two separate the halves.

  it('keeps the newer load of the SAME quote when the older one lands last', async () => {
    // A -> B -> A on ONE quote. Both loads are for quote A and the route ends on
    // quote A, so the route binding cannot tell them apart: only CALL ORDER can.
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-STALE');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const firstOpenOfA = openableGate();
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      loadPlan: {
        'quote-a': [
          { wait: firstOpenOfA.opened, quoteNumber: 'Q-AAA-STALE' },
          { quoteNumber: 'Q-AAA-FRESH' },
        ],
      },
    });

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    await goToQuote(router, 'quote-a');
    expect(await screen.findAllByText('Q-AAA-FRESH')).not.toHaveLength(0);

    // The very first open of quote A now replies, last. It is the same record
    // the URL names, but it is an OLDER read of it, so it must install nothing.
    firstOpenOfA.open();
    await flushPendingWork();

    expect(screen.getAllByText('Q-AAA-FRESH')).not.toHaveLength(0);
    expect(screen.queryAllByText('Q-AAA-STALE')).toHaveLength(0);
  });

  it('refuses a reload started from a stale closure even though it holds the newest load serial', async () => {
    // reloadAfterStaleSave calls fetchQuote with the quoteId captured in its
    // closure. Fired after the operator has moved on, that call MINTS THE
    // NEWEST serial for the quote they left - so call order cannot catch it and
    // would actively certify the stale snapshot. Only the route binding can.
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } }
        : { data: null, error: null },
    ));
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      failSectionsFor: 'quote-b',
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-RELOADED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);

    // Save quote A and lose the version race, which opens the reload dialog.
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await screen.findByRole('button', { name: /Reload Quote/i });

    // Move to quote B; its load fails, so `loading` clears and quote A's form -
    // and this still-open dialog - come back under quote B's address.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));

    fireEvent.click(await screen.findByRole('button', { name: /Reload Quote/i }));
    await flushPendingWork();

    // The reload was refused, so the dialog stays open and reports that it did
    // not finish - rather than silently installing quote A over quote B's route.
    expect(screen.getByRole('button', { name: /Reload Quote/i })).toBeInTheDocument();
    expect(screen.getByText(/Reload could not finish/)).toBeInTheDocument();
    expect(screen.queryAllByText('Q-AAA-RELOADED')).toHaveLength(0);
    // The reload never completed, so the key that may represent a committed
    // save must NOT have been rotated.
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();
  });

  // Raised by the exact-SHA gpt-5.6-sol review of `a9793c311`, as a P2. The save
  // guard reads the load serial, and the serial is a SHARED resource: a doomed load
  // that takes a number on its way to rejecting itself supersedes whatever is
  // legitimately in flight for the quote on screen. Refusing at the door is the
  // only place that cannot burn one.
  it('refuses a doomed reload at the door, without reading the database or taking a load serial', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: null, error: { message: 'QUOTE_STALE_WRITE' } }
        : { data: null, error: null },
    ));
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      failSectionsFor: 'quote-b',
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-RELOADED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await screen.findByRole('button', { name: /Reload Quote/i });

    // Move to quote B. The reload dialog's closure still names quote A, so firing
    // it now is a load for a quote the operator has left.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));

    const readsBeforeDoomedReload = mockFrom.mock.calls.filter((c) => c[0] === 'quotes').length;
    fireEvent.click(await screen.findByRole('button', { name: /Reload Quote/i }));
    await flushPendingWork();

    // The decisive check. The doomed load must turn round at the door: no read
    // issued, so no serial consumed, so nothing legitimately in flight for the
    // quote on screen can be superseded by it.
    expect(mockFrom.mock.calls.filter((c) => c[0] === 'quotes').length)
      .toBe(readsBeforeDoomedReload);
    // And it still must not install, which is what the sibling test above pins.
    expect(screen.queryAllByText('Q-AAA-RELOADED')).toHaveLength(0);
  });

  it('refuses the save when a failed switch leaves quote A on screen under quote B address', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const router = renderQuoteSwitch([quoteA, quoteB], {}, { failSectionsFor: 'quote-b' });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);

    // A load that fails part-way deliberately KEEPS the operator's current
    // edits rather than blanking them — which puts quote A's form, and a live
    // Save button, under quote B's URL.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));

    const saveDraft = await screen.findByRole('button', { name: /Save Draft/ });
    fireEvent.click(saveDraft);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('has not finished loading'),
    ));
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
  });

  // ── ...and neither may a save's REPLY ──────────────────────────────────────
  //
  // The refusal above runs before the request is sent, so it cannot cover state
  // written after the reply lands. `save_quote` installs the authoritative
  // row-version token, the commission baseline and (for a create) `quoteId`, and
  // its callers then clear dirty, toast and navigate. A route change during the
  // round trip puts all of that on the wrong quote.

  function withRowVersion(fixture: ReturnType<typeof makeSwitchFixture>, rowVersion: number) {
    return { ...fixture, quote: { ...fixture.quote, row_version: rowVersion } };
  }

  it('drops a late save_quote reply for quote A rather than installing its token on quote B', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      if (saveCalls === 1) {
        await saveReply.opened;
        // Quote A's own authoritative token, one past the 3 it loaded with.
        return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
      }
      return { data: { quote_id: 'quote-b', row_version: 12 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {});

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(saveCalls).toBe(1));

    // Leave for quote B while quote A's save is still in flight.
    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // Quote A's success is not quote B's.
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote saved as draft');

    // The decisive check. Quote B's own token must still be the one it saves
    // against — proving quote A's reply neither replaced it nor cleared it.
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-b',
      p_quote_payload: expect.objectContaining({ row_version_expected: 11 }),
      // Quote A's save COMMITTED, so its key had to rotate even though its reply
      // was dropped. Reusing it here would let quote B's save replay quote A's
      // committed result instead of writing quote B.
      p_idempotency_key: 'test-idem-key-1',
    })));
  });

  it('keeps quote A failed save off quote B, and says which quote failed', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      await saveReply.opened;
      return { data: null, error: { message: 'QUOTE_STALE_WRITE' } };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {});

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // Quote A's stale-write recovery dialog must not appear over quote B, whose
    // own record is untouched and has nothing to recover.
    expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument();
    // But the failure is not swallowed either: the operator left believing quote
    // A saved, and it did not. The toast names it, because the page they are
    // looking at is a different quote.
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Q-AAA-1'));
  });

  // Raised by the exact-SHA gpt-5.6-sol review of this branch, as CRX-1/High.
  // A route-only binding is not enough, because a route id is not unique over
  // time: leave quote A for B and come back, and the id matches again. The reply
  // would then be accepted into a DIFFERENT editing session of the same quote and
  // report edits saved that were never sent. The load serial separates the two
  // sessions, because returning to quote A re-runs its load.
  it('drops a late save_quote reply for quote A after the operator left and came BACK to quote A', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      if (saveCalls === 1) {
        await saveReply.opened;
        // Quote A's own authoritative token, one past the 3 its FIRST load held.
        return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
      }
      return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {}, {
      // The second load of quote A carries distinct content, so the test can tell
      // which of the two editing sessions of the SAME quote is on screen.
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-REOPENED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(saveCalls).toBe(1));

    // Leave quote A with its save still in flight, then come straight back to it.
    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
    await goToQuote(router, 'quote-a');
    expect(await screen.findAllByText('Q-AAA-REOPENED')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // The reply belongs to the session the operator abandoned, so it may not
    // report success over the freshly loaded one — that dirty-clear would mark
    // edits made after the return as saved when they were never sent.
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote saved as draft');

    // The decisive check. The reopened session loaded at version 3, so version 3
    // is what it must still save against — proving the abandoned save's token
    // was neither installed over it nor cleared.
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-a',
      p_quote_payload: expect.objectContaining({ row_version_expected: 3 }),
    })));
  });
});
