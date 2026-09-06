/**
 * QuoteBuilder.test.tsx — Tests for the quote builder page
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { Link, MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter, useParams } from 'react-router-dom';

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
  quoteIdempotencyHandles,
  sharedResetKeyFor,
} = vi.hoisted(() => {
  // Generations are PER SCOPE, mirroring the real hook's per-scope Map. A single
  // shared counter would let a reset on quote B change the key later handed back
  // for quote A, which the real hook never does — a test written against that
  // stub would be asserting a property of the mock, not of the page.
  const quoteIdempotencyState = {
    generations: new Map<string, number>(),
    generationFor(scope: string) { return this.generations.get(scope) ?? 0; },
    bump(scope: string) { this.generations.set(scope, this.generationFor(scope) + 1); },
    reset() { this.generations.clear(); },
  };
  // One handle per scope, created once — see the useIdempotencyKey mock below for
  // why identity stability is load-bearing rather than tidiness.
  const mockResetIdempotencyKey = vi.fn((scope: string = '') => { quoteIdempotencyState.bump(scope); });
  const sharedResetKeyFor = (scopeValue: string) => mockResetIdempotencyKey(scopeValue);
  const quoteIdempotencyHandles = new Map<string, {
    getKey: () => string;
    resetKey: () => void;
    resetKeyFor: (scopeValue: string) => void;
  }>();
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
    mockResetIdempotencyKey,
    quoteIdempotencyState,
    quoteIdempotencyHandles,
    sharedResetKeyFor,
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
  // Use the REAL assertRpcResult for the same reason. The stub `vi.fn((d) => d)` is a
  // passthrough that never throws, which DELETES the ambiguous-reply path — an empty
  // payload with no error — from every test in this file. That path is precisely what
  // the F1 ordering exists to handle, so under the stub a screen that retires its
  // idempotency key before checking the reply stays green. Import the real one so the
  // defect can be expressed here at all (aliased-reset sweep, 2026-09-05).
  const { assertRpcResult } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const hasRpcCode = (error: { message?: string }, code: string) => (
    error.message === code
    || error.message?.startsWith(`${code}:`) === true
    || error.message?.startsWith(`${code} `) === true
  );
  return {
    supabase: { from: mockFrom, rpc: mockRpc },
    supabaseUntyped: { from: mockFrom, rpc: mockRpc },
    checkMutationResult: vi.fn(),
    assertRpcResult,
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
  // The mock MUST honour intentScope. A scope-blind stub returns one key for every
  // quote, so a regression test for "quote B must not inherit A's unresolved key"
  // would pass against a completely unscoped hook — it would prove a property of
  // the mock rather than of the page. The real hook keys a Map by
  // [operation, userId, intentScope]; this mirrors the scope half of that.
  // The returned functions MUST be identity-stable per scope, as the real hook's
  // useCallback ones are. A fresh object literal per render looks harmless and is
  // not: `fetchQuote` takes `resetSaveQuoteIdempotencyKey` as a dependency, so an
  // unstable identity re-creates it every render, re-runs the load effect, and the
  // page loads forever — every test then sees only the skeleton. That is a defect
  // in the mock, not in the page, and it is exactly the shape a mock must not
  // introduce: it made a correct component look broken (#618 + #603 merge).
  useIdempotencyKey: (_operation: string, _userId: string, intentScope = '') => {
    const cached = quoteIdempotencyHandles.get(intentScope);
    if (cached) return cached;
    const handle = {
      getKey: () => `test-idem-key-${intentScope}-${quoteIdempotencyState.generationFor(intentScope)}`,
      resetKey: () => mockResetIdempotencyKey(intentScope),
      // Retires a NAMED scope rather than the rendered one, as the real hook does.
      // Without this the page could not retire the key of a quote it has left.
      //
      // Shared across every scope, because the real hook memoizes `resetKeyFor` on
      // [operation, userId] alone — it does NOT move when the scope changes. A
      // per-scope copy here would be stable within a scope and unstable across one,
      // which is precisely the identity change `fetchQuote` must not see.
      resetKeyFor: sharedResetKeyFor,
    };
    quoteIdempotencyHandles.set(intentScope, handle);
    return handle;
  },
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

const { mockSentryCaptureMessage, mockSentryCaptureException } = vi.hoisted(() => ({
  mockSentryCaptureMessage: vi.fn(),
  mockSentryCaptureException: vi.fn(),
}));
vi.mock('../lib/sentry', () => ({
  Sentry: { captureMessage: mockSentryCaptureMessage, captureException: mockSentryCaptureException },
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
// The REAL provider, not a stand-in. The hazard these tests cover is a property
// of the real one: it is mounted above the route, so its approval dialog — and
// the retry parked behind it — survive a navigation between quotes.
import { BelowCostApprovalProvider } from '../contexts/BelowCostApprovalContext';

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

/**
 * Jump from one quote to another WITHOUT unmounting QuoteBuilder — the same reused
 * instance production gets, because no `<x>/:id` route in src/App.tsx carries a
 * `key` prop. A `<Link>` is used rather than `useNavigate`, which this file mocks.
 */
function renderQuoteBuilderWithQuoteSwitch(fromId: string, toId: string) {
  return render(
    <MemoryRouter initialEntries={[`/quotes/${fromId}/edit`]}>
      <Link to={`/quotes/${toId}/edit`}>Jump to quote B</Link>
      <Routes>
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
    quoteIdempotencyState.reset();
    quoteIdempotencyHandles.clear();
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

  it('lists legacy-format saved versions instead of hiding the quote history', async () => {
    const { quote, product, section, item } = makeQuoteFixture('sent', 7);
    // The exact shape of the rows that exist in production: written by the original frontend
    // writer, with the quote fields at the top level and no `quote` key. The strict snapshot
    // validator cannot read these, and dropping them used to remove the Versions button
    // entirely from any quote whose saved versions were all in this shape.
    const legacySnapshot = {
      quote_number: 'Q-version-test',
      customer_id: 'customer-1',
      customer_name: 'Farm',
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      commission_split: null,
      totals: { total_price: 1234 },
      sections: [],
    };
    const legacyRow = (id: string, versionNumber: number, sentAt: string) => ({
      id,
      quote_id: quote.id,
      version_number: versionNumber,
      sent_by: 'profile-1',
      sent_at: sentAt,
      sent_method: null,
      snapshot_data: legacySnapshot,
      pdf_url: null,
      notes: null,
      restore_trusted_at: null,
    });
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : table === 'quote_versions'
                  ? [
                      legacyRow('version-2', 2, '2026-03-16T15:43:15.915Z'),
                      legacyRow('version-1', 1, '2026-03-16T15:42:47.023Z'),
                    ]
                  : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);

    fireEvent.click(await screen.findByRole('button', { name: /Versions \(2\)/ }));

    // Both rows are listed, and neither claims an item count or a total — those could only
    // come from a snapshot this build has already refused to read.
    expect(await screen.findAllByText(/Saved in an older format/)).toHaveLength(2);
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();

    // The old behaviour warned the operator on every single load and reported to Sentry.
    // A legacy snapshot is expected historical data, not an incident.
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.stringContaining('could not be displayed'));
    expect(mockSentryCaptureMessage).not.toHaveBeenCalled();

    // Listing a row must not make it actionable: an unreadable snapshot can reach neither the
    // compare view nor restore. Without this, adding an onClick to the row would still pass.
    const legacyRowNode = screen.getAllByText(/Saved in an older format/)[0].closest('div')?.parentElement;
    expect(legacyRowNode).toBeTruthy();
    expect(legacyRowNode).not.toHaveAttribute('role');
    expect(legacyRowNode).not.toHaveAttribute('tabindex');
    fireEvent.click(legacyRowNode!);
    expect(screen.queryByRole('button', { name: /Restore/i })).not.toBeInTheDocument();
  });

  it('reports an unreadable version the server stamped as restorable instead of calling it old', async () => {
    // restore_trusted_at is set only by the current writer, so a row carrying it should always
    // parse. One that does not is corruption or writer/validator drift — the user sees the same
    // "unavailable" either way, so the alarm has to fire on our side.
    const { quote, product, section, item } = makeQuoteFixture('sent', 7);
    const unreadableTrustedRow = {
      id: 'version-9',
      quote_id: quote.id,
      version_number: 9,
      sent_by: 'profile-1',
      sent_at: '2026-09-06T10:00:00.000Z',
      sent_method: null,
      snapshot_data: { quote_number: 'Q-drift', totals: { total_price: 10 }, sections: [] },
      pdf_url: null,
      notes: null,
      restore_trusted_at: '2026-09-06T10:00:01.000Z',
    };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'customers'
              ? [{ id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true }]
              : table === 'products'
                ? [product]
                : table === 'quote_versions'
                  ? [unreadableTrustedRow]
                  : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);

    fireEvent.click(await screen.findByRole('button', { name: /Versions \(1\)/ }));

    expect(await screen.findByText('Details unavailable')).toBeInTheDocument();
    // Calling it an older format would be a guess: the server says this row is current.
    expect(screen.queryByText(/Saved in an older format/)).not.toBeInTheDocument();
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith(
      'server-trusted quote version failed snapshot validation',
      expect.objectContaining({ level: 'error' }),
    );
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

  /**
   * F1, ALIASED-RESET CLASS — driven through the real save handler rather than read
   * off the source.
   *
   * `save_quote` answering `{ data: null, error: null }` is the AMBIGUOUS reply: no
   * error came back, but the payload is empty, so this tab cannot tell whether the
   * quote committed. assertRpcResult exists to reject exactly that. Retiring the key
   * before that check — which is what main did, through the destructured rename the
   * literal `resetKey()` sweep could not see — sends the operator's retry under a
   * BRAND-NEW key. The server cannot recognise a key it has never seen, so it writes
   * the quote a second time.
   *
   * The two assertions bind the PAIR: the key is not retired, AND the retry actually
   * travels under the original key. Asserting only the first would still pass if the
   * retry minted a fresh key some other way.
   */
  it('keeps the save_quote key when the reply is empty, so the retry replays instead of double-writing', async () => {
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
    // An empty success envelope on every attempt: the reply stays ambiguous, so the
    // key must stay put no matter how many times the operator presses Save.
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByText('Save Draft'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quote.id}-0`,
    })));
    expect(
      mockResetIdempotencyKey,
      'an empty save_quote reply is ambiguous — the key must survive it so a retry can replay',
    ).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(saves.length).toBeGreaterThan(1);
    });
    const saveKeys = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    expect(
      new Set(saveKeys),
      'every retry of an unresolved save must carry the SAME key, or the server writes the quote twice',
    ).toEqual(new Set([`test-idem-key-${quote.id}-0`]));
  });

  /**
   * The half of the ambiguous-reply space the test above does NOT cover.
   *
   * `{ data: null }` is rejected by assertRpcResult, which throws before the key is
   * ever retired — so that test passes even against code that retires first and
   * checks later. `{ data: {} }` is the reply that actually gets through:
   * assertRpcResult rejects only a MISSING reply, so an empty object reaches the
   * caller looking like a success that simply has no id in it.
   *
   * On an edit route the old code then read `result.quote_id || quoteId` and took the
   * id straight off the URL, so the unverified save reported itself as confirmed AND
   * its key was gone. On a create there is no URL id to borrow, so the retry minted a
   * fresh key the server could not recognise and wrote the quote a second time.
   */
  it('keeps the save_quote key when the reply is an empty OBJECT, not just when it is missing', async () => {
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
    mockRpc.mockImplementation(() => Promise.resolve({ data: {}, error: null }));

    renderQuoteBuilder(quote.id);
    fireEvent.click(await screen.findByText('Save Draft'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quote.id}-0`,
    })));
    expect(
      mockResetIdempotencyKey,
      'an empty save_quote OBJECT is ambiguous — retiring the key here is what writes the quote twice',
    ).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('came back without an ID'));

    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(saves.length).toBeGreaterThan(1);
    });
    const saveKeys = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    expect(new Set(saveKeys)).toEqual(new Set([`test-idem-key-${quote.id}-0`]));
  });

  /**
   * Retaining the key is only half a retry. The server fingerprints the WHOLE request
   * — `md5(quote_id || quote_payload || sections || performed_by)` in
   * 20260812115236_quote_items_cost_at_quote_snapshot.sql:348 — and answers a replay
   * whose fingerprint differs with IDEMPOTENCY_PAYLOAD_CONFLICT rather than the cached
   * result. `expires_at` was built from `Date.now()` on every save, so the retry this
   * page instructs the operator to perform sent a different millisecond every time and
   * could never redeem the key it had just been told to keep.
   *
   * `Date.now` is forced to advance here on purpose. Two clicks in a real test run can
   * land inside the same millisecond, and this test would then pass against the very
   * bug it exists to catch.
   *
   * Covered on the EDIT path. The create path builds its payload from the same lines
   * with the same frozen clock and differs only in the scope string (`'new'`), but
   * driving a create to a save through this harness needs a customer and an item
   * selected in the UI, so create is reasoned, not executed, here.
   */
  it('sends a byte-identical payload on the retry, not just an identical key', async () => {
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
    // First attempt is ambiguous, so the key is retained. Second attempt is the retry.
    mockRpc
      .mockImplementationOnce(() => Promise.resolve({ data: {}, error: null }))
      .mockImplementation(() => Promise.resolve({
        data: { quote_id: quote.id, row_version: 8 },
        error: null,
      }));

    renderQuoteBuilder(quote.id);
    await screen.findByText('Save Draft');

    let clock = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 60_000;
      return clock;
    });

    try {
      fireEvent.click(screen.getByText('Save Draft'));
      await waitFor(() => {
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote').length).toBe(1);
      });
      expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('Save Draft'));
      await waitFor(() => {
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote').length).toBe(2);
      });

      const saves = mockRpc.mock.calls
        .filter(([name]) => name === 'save_quote')
        .map(([, args]) => args as {
          p_idempotency_key: string;
          p_quote_payload: Record<string, unknown>;
          p_sections: unknown;
        });

      expect(saves[1].p_idempotency_key).toBe(saves[0].p_idempotency_key);
      expect(
        saves[1].p_quote_payload.expires_at,
        'expires_at moved between attempts, so the server fingerprint cannot match',
      ).toBe(saves[0].p_quote_payload.expires_at);
      // Everything the server hashes, not only the field that regressed.
      expect(saves[1].p_quote_payload).toEqual(saves[0].p_quote_payload);
      expect(saves[1].p_sections).toEqual(saves[0].p_sections);

      // The retry redeemed the receipt, so the key is finally retired.
      await waitFor(() => expect(mockResetIdempotencyKey).toHaveBeenCalled());
    } finally {
      nowSpy.mockRestore();
    }
  });

  /**
   * Only ONE of this page's eleven dialog openers is a save_quote conflict.
   *
   * The other ten are lifecycle actions — decline, email, version restore, convert,
   * book-as-order — that own no save_quote key at all. Recording the save scope at
   * those sites made the dialog claim an origin it did not have, so the reload it
   * offered retired a save_quote receipt whose own reply had never been validated.
   */
  it('does not let a decline-originated recovery reload release the save_quote key', async () => {
    const quote = { id: 'quote-decline-key', quote_number: 'Q-decline-key', customer_id: 'customer-1', tier: 1, valid_days: 30, header_notes: 'Local note', footer_notes: '', status: 'sent', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    await screen.findByDisplayValue('Local note');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline Quote' }));

    fireEvent.click(await screen.findByText('Reload Quote'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());

    expect(
      mockResetIdempotencyKey,
      'a decline owns no save_quote key, so the recovery reload it opens must retire none',
    ).not.toHaveBeenCalled();
  });

  /**
   * The cost of F1 retention, paid for by scoping — raised by the gpt-5.6-sol review
   * of dff631f1 as the QuoteBuilder mirror of a finding already fixed in
   * CustomerDetail.
   *
   * Retaining the key past an ambiguous reply is the whole point of F1, but a
   * page-wide key then OUTLIVES the quote it was minted for. QuoteBuilder does not
   * remount when only `:id` changes, so quote B's save would go out under quote A's
   * unresolved key. The server fingerprints the payload against the cached key and
   * answers IDEMPOTENCY_PAYLOAD_CONFLICT — it fails closed, so there is no
   * cross-quote write — but B gets a conflict dialog it did nothing to earn.
   *
   * The fix scopes the key to the quote the RPC actually targets. This test binds
   * that: it deliberately reads the key OFF THE WIRE for B, so it fails if the scope
   * argument is dropped (both quotes would then share `test-idem-key--0`).
   */
  it('does not hand quote B the unresolved key minted for quote A', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
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
    // Ambiguous on every attempt, so A's key is still outstanding when B is opened.
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    fireEvent.click(await screen.findByText('Save Draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quoteA.id}-0`,
    })));
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');

    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
      expect(saves.length).toBeGreaterThan(1);
    });
    const saveKeys = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    const lastSaveKey = saveKeys[saveKeys.length - 1];
    expect(
      lastSaveKey,
      "quote B must mint its OWN key — inheriting A's unresolved key earns B a conflict dialog it did not cause",
    ).toBe(`test-idem-key-${quoteB.id}-0`);
  });

  /**
   * The second-order cost of scoping the key, raised by the gpt-5.6-sol review of
   * 5dad64e2 as a NEW interaction the scoping itself created.
   *
   * `reloadAfterStaleSave` releases the CURRENT render's scope. While one page-wide key
   * existed that was always the right one. Once the key is scoped, the stale-save dialog
   * — which stays open across a route change — can be recovered on a DIFFERENT quote:
   * clicking Reload would then retire quote B's key and strand quote A's rejected one,
   * so returning to A replays the same rejected key and re-opens the same conflict.
   *
   * The recovery is now bound to the quote that produced it. Retaining A's key is the
   * safe direction: a retained key can still replay, a wrongly retired one cannot.
   */
  it('retires neither quote\'s key when A\'s conflict dialog is recovered after a route change', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
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
        ? { data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } }
        : { data: null, error: null },
    ));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    fireEvent.click(await screen.findByText('Save Draft'));
    // A's save is rejected, so A's recovery dialog opens.
    expect(await screen.findByText('Reload Quote')).toBeInTheDocument();

    // The operator navigates to B with that dialog still open, then recovers it.
    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());

    expect(
      mockResetIdempotencyKey,
      "recovering A's conflict must not retire quote B's key — B never had an unresolved save",
    ).not.toHaveBeenCalledWith(quoteB.id);
    // And it must not retire A's key either, even though A's dialog is what closed.
    //
    // An earlier revision did retire it, on the reasoning that a payload-rejected key
    // can only ever be rejected again. That was a duplicate-write hazard: the key
    // rejects the CHANGED payload, but replaying the ORIGINAL one returns the server's
    // cached receipt, which on a create is the only way to learn the id of a row that
    // may already have committed. Retiring it lets a later retry insert twice.
    //
    // Retaining costs one unearned conflict dialog on returning to A, which self-heals
    // on A's own reload. That is the cheaper side of the trade, so this asserts the
    // key survives.
    expect(
      mockResetIdempotencyKey,
      "A's key is the receipt handle for a create that may have committed — recovery on another quote must not retire it",
    ).not.toHaveBeenCalledWith(quoteA.id);
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
      p_idempotency_key: `test-idem-key-${quote.id}-0`,
    }));
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Reload Quote'));
    await waitFor(() => expect(screen.queryByText('Reload Quote')).not.toBeInTheDocument());
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('save_quote', expect.objectContaining({
      p_idempotency_key: `test-idem-key-${quote.id}-1`,
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
    // ONE release, not two. The version-action key is retired, because this reload is
    // that action's own recovery. The save_quote key is NOT, because no save_quote
    // conflict happened here — an email/version failure opened this dialog. The
    // second release this once expected was the coupling CodeRabbit flagged at
    // CustomerDetail:964: a lifecycle recovery retiring a whole-record save receipt
    // whose own reply was never validated.
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);

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

  /**
   * Suspends forever when the route names `on`. Rendered AFTER <QuoteBuilder/>
   * inside a Suspense boundary, so QuoteBuilder's render for the new id has
   * already run by the time this unwinds and React throws the attempt away.
   */
  const foreverPending = new Promise(() => {});
  function SuspendForever({ on }: { on: string }) {
    const { id } = useParams();
    if (id === on) throw foreverPending;
    return null;
  }

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
    options: {
      failSectionsFor?: string;
      loadPlan?: QuoteLoadPlan;
      belowCostApproval?: boolean;
      suspendOn?: string;
    } = {},
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
    // A render React BEGINS and then throws away. `suspendOn` names the quote id
    // whose render suspends and never resolves: QuoteBuilder is rendered first
    // with the new id, then the sibling below suspends, so React discards the
    // whole attempt and the PREVIOUS quote stays committed on screen. Production
    // discards renders for its own reasons — an interrupted transition, an error
    // retry — and this is the deterministic way to reproduce one. The scaffold
    // creates the interruption; it never touches the ref under test.
    const routeElement = options.suspendOn
      ? (
        <Suspense fallback={<div>route suspended</div>}>
          <QuoteBuilder />
          <SuspendForever on={options.suspendOn} />
        </Suspense>
      )
      : <QuoteBuilder />;
    const router = createMemoryRouter(
      // `quotes/:id` is App.tsx's real pattern for a saved quote. Using it here
      // means both ids resolve to the SAME route, so React Router reuses the
      // element instead of remounting it — which is precisely the condition
      // these tests exist to cover.
      [{ path: '/quotes/:id', element: routeElement }],
      { initialEntries: [`/quotes/${fixtures[0].quote.id}`] },
    );
    // Mounted OUTSIDE the router, mirroring App.tsx's RootLayout: the provider
    // sits above the route, so navigating between quotes neither unmounts the
    // approval dialog nor abandons the retry waiting on it.
    render(options.belowCostApproval
      ? <BelowCostApprovalProvider><RouterProvider router={router} /></BelowCostApprovalProvider>
      : <RouterProvider router={router} />);
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

  /**
   * The empty-reply branch sits ABOVE `editingSessionChanged()`, so it needed its own
   * session check — raised as a P2 by the exact-SHA gpt-5.6-sol review of `451727ee9`.
   *
   * An ambiguous `{}` reply for quote A that lands after the operator has moved to
   * quote B must still retain A's key, but it must not SAY anything: an unqualified
   * "the save came back without an ID" toast over quote B reads as a failure of the
   * quote on screen, which is the same route-reply leak the guard below exists to
   * stop. Silence plus retention is the correct pair here.
   */
  it('stays silent about quote A empty reply once the operator has moved to quote B', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      if (saveCalls === 1) {
        await saveReply.opened;
        // The ambiguous reply: no error, and no receipt in it.
        return { data: {}, error: null };
      }
      return { data: { quote_id: 'quote-b', row_version: 12 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {});

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(saveCalls).toBe(1));

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    expect(
      mockToast.mock.calls.map((c) => String(c[1])).join(' | '),
      "quote A's ambiguous reply must not report a failure over quote B",
    ).not.toMatch(/came back without an ID/);

    // Retention is the other half of the pair: A's key must survive, unretired.
    expect(mockResetIdempotencyKey).not.toHaveBeenCalledWith('quote-a');
  });

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
      // Generation 0 for quote B's OWN scope, not 1 for a shared one. #618 wrote
      // this as `test-idem-key-1` because a page-wide key had to ROTATE off quote
      // A's committed save before B could safely use it. #603 scopes the key per
      // quote, so B never held A's key to begin with and there is nothing for A's
      // save to rotate away from B. The hazard #618 was guarding against is gone
      // rather than merely re-checked — but the assertion still binds it, because
      // a regression to a page-wide key would hand B `test-idem-key--1` here.
      p_idempotency_key: 'test-idem-key-quote-b-0',
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
    // ...and it must not claim a rollback it cannot know about. A reply lost in
    // transit after PostgreSQL committed arrives through this same error branch,
    // which is exactly why the retry key is retained. Raised as a P2 on this branch.
    const [, failureMessage] = mockToast.mock.calls.find(
      (call) => call[0] === 'error' && String(call[1]).includes('Q-AAA-1'),
    )!;
    expect(failureMessage).not.toMatch(/were not stored|was not saved|no changes were/i);
    expect(failureMessage).toMatch(/could not be confirmed/i);
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

  // Raised by the exact-SHA gpt-5.6-sol review of `e403d00a3`, as a P2 — the
  // shadow of this branch's own guard. `routeQuoteIdRef` was written DURING
  // RENDER, so a render React began and then discarded moved it even though the
  // previous quote was still the committed screen. The save guard reads that ref,
  // so it would drop a VALID reply after the database had committed: the save
  // succeeds, the data is right, and only the confirmation is suppressed — the
  // operator saves again and lands in stale-write recovery on a money document.
  it('accepts quote A save reply when a render for quote B was discarded before commit', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveReply = openableGate();
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      await saveReply.opened;
      return { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {}, { suspendOn: 'quote-b' });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));

    // Begin a navigation to quote B whose render never completes. Quote A is
    // still what the operator is looking at, and its load never got superseded:
    // passive effects do not run for a discarded render, so the load serial has
    // not moved either. Only a render-time route write could have moved.
    await goToQuote(router, 'quote-b');
    expect(screen.getAllByText('Q-AAA-1')).not.toHaveLength(0);

    saveReply.open();
    await flushPendingWork();

    // The decisive check. This save belongs to the quote still on screen, so its
    // reply must be installed and confirmed, not discarded.
    expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
    // ...and the authoritative token it carried must be what the next save uses.
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-a',
      p_quote_payload: expect.objectContaining({ row_version_expected: 4 }),
    })));
  });

  // Raised by the exact-SHA gpt-5.6-sol review of `d6b12058b`, as a P2. A payload
  // conflict is not merely "unconfirmed": the server has bound this key to a
  // DIFFERENT payload and can never accept the current one under it again. The
  // in-route branch recovers through the reload dialog, which rotates the key —
  // but that dialog cannot be shown for a quote the operator has left, so the
  // moved-session return used to strand the key poisoned for the life of the
  // component. The key is scoped by operation and user, not by record, so every
  // later save of ANY quote repeated the same conflict.
  it('retires a payload-conflicted key on the reopen, not on the conflict, and not on another quote', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const quoteC = withRowVersion(makeSwitchFixture('quote-c', 'Q-CCC-3'), 7);
    const saveReply = openableGate();
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      await saveReply.opened;
      return { data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } };
    });
    const router = renderQuoteSwitch([quoteA, quoteB, quoteC], {}, {
      loadPlan: { 'quote-a': [{}, { quoteNumber: 'Q-AAA-REOPENED' }] },
    });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));

    // Leave quote A, then let its conflict reply land.
    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
    saveReply.open();
    await flushPendingWork();

    // Quote A's recovery dialog still may not open over quote B.
    expect(screen.queryByRole('button', { name: /Reload Quote/i })).not.toBeInTheDocument();
    // And the key is a RECEIPT as well as a retry token — it may stand for a save
    // that committed and lost its reply — so the conflict alone must not retire
    // it. #603 shipped that shortcut and reverted it the same day.
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

    // A complete authoritative load of a DIFFERENT quote must not count either:
    // it resolves nothing about what happened to quote A. This step exists because
    // without it the scoping half of the check is unprovable — the conflict lands
    // after quote B has already finished loading, so quote B alone can never
    // exercise it.
    await goToQuote(router, 'quote-c');
    expect(await screen.findAllByText('Q-CCC-3')).not.toHaveLength(0);
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();

    // Reopening quote A IS the authoritative reload the receipt was waiting for.
    await goToQuote(router, 'quote-a');
    expect(await screen.findAllByText('Q-AAA-REOPENED')).not.toHaveLength(0);
    expect(mockResetIdempotencyKey).toHaveBeenCalled();

    // The decisive check: the next save carries a FRESH key, so it is no longer
    // rejected by a key the server bound to an earlier payload.
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: 'quote-a',
      // Generation 1 within quote A's OWN scope: the reopen retired A's key, and
      // only A's. Scoped by #603, so the spelling carries the quote id.
      p_idempotency_key: 'test-idem-key-quote-a-1',
    })));
  });

  // ── ...and neither may an approval given while looking at another quote ────
  //
  // Raised by the exact-SHA gpt-5.6-sol review of `d6b12058b`, as a High. The
  // below-cost dialog is GLOBAL and mounted above the route, so the send it is
  // holding survives a navigation — and it names the product, never the quote.
  // The operator can therefore be shown "approve this below-cost price" while
  // looking at quote B and, by approving, write quote A.
  const BELOW_COST_ERROR = {
    message: 'BELOW_COST_REASON_REQUIRED: {"operation":"save_quote","product_name":"Roundup PowerMAX"}',
  };

  async function approveBelowCost() {
    const reasonBox = await screen.findByLabelText(/Approval reason/i);
    fireEvent.change(reasonBox, { target: { value: 'matched a competitor quote' } });
    fireEvent.click(screen.getByRole('button', { name: /Approve and Retry/i }));
    await flushPendingWork();
  }

  // The positive control for the test below. Without it, a broken dialog harness
  // — no retry ever sent — would satisfy the refusal assertions perfectly.
  it('sends the below-cost retry when the operator is still on the quote being approved', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    const saveArgs: unknown[] = [];
    mockRpc.mockImplementation(async (name: string, args: unknown) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveArgs.push(args);
      return saveArgs.length === 1
        ? { data: null, error: BELOW_COST_ERROR }
        : { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    renderQuoteSwitch([quoteA, quoteB], {}, { belowCostApproval: true });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));

    await approveBelowCost();

    expect(saveArgs).toHaveLength(2);
    expect(saveArgs[1]).toEqual(expect.objectContaining({ p_quote_id: 'quote-a' }));
    expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
  });

  it('refuses the below-cost retry for quote A once the operator has moved to quote B', async () => {
    const quoteA = withRowVersion(makeSwitchFixture('quote-a', 'Q-AAA-1'), 3);
    const quoteB = withRowVersion(makeSwitchFixture('quote-b', 'Q-BBB-2'), 11);
    let saveCalls = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'save_quote') return { data: null, error: null };
      saveCalls += 1;
      return saveCalls === 1
        ? { data: null, error: BELOW_COST_ERROR }
        : { data: { quote_id: 'quote-a', row_version: 4 }, error: null };
    });
    const router = renderQuoteSwitch([quoteA, quoteB], {}, { belowCostApproval: true });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    // Quote A's save is now parked on the dialog rather than on the network.
    await screen.findByLabelText(/Approval reason/i);

    await goToQuote(router, 'quote-b');
    expect(await screen.findAllByText('Q-BBB-2')).not.toHaveLength(0);
    // The dialog is still up, over quote B, and nothing on it says quote A —
    // which is exactly why the approval it collects cannot be trusted to mean
    // quote A. It names a product and a shortfall, and no record at all.
    expect(screen.getByRole('button', { name: /Approve and Retry/i })).toBeInTheDocument();
    expect(screen.queryAllByText(/Q-AAA-1/)).toHaveLength(0);

    await approveBelowCost();

    // The decisive check. The retry is never sent, so quote A is not written
    // from consent the operator gave while looking at a different quote.
    expect(saveCalls).toBe(1);
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Quote saved as draft');
    // Not silent, either: they approved something, so they are told it did not
    // apply and to which quote. Nothing was written on this path — the first
    // attempt was rejected by PostgreSQL — so unlike the lost-reply message this
    // one is entitled to say the quote was not saved.
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Q-AAA-1'));
    const [, refusalMessage] = mockToast.mock.calls.find(
      (call) => call[0] === 'error' && String(call[1]).includes('Q-AAA-1'),
    )!;
    expect(refusalMessage).toMatch(/was not saved/i);
  });
});
