/**
 * QuoteBuilder.test.tsx — Tests for the quote builder page
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// Fixtures already carry cost; the admin cost read (get_admin_cost_fields) passes rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
  withAdminNestedCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));

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
  // Quote history now comes from get_quote_versions (cost is admin-only, 20261019230000); the
  // fixtures still describe it as the quote_versions table, so serve the RPC from that table.
  const rpcWithQuoteVersions = (name: string, args?: unknown) => (name === 'get_quote_versions'
    ? Promise.resolve(mockFrom('quote_versions') as PromiseLike<{ data?: unknown; error?: unknown } | undefined>)
      .then((r) => ({ data: r?.data ?? [], error: r?.error ?? null }))
    : mockRpc(name, args));
  return {
    supabase: { from: mockFrom, rpc: rpcWithQuoteVersions },
    supabaseUntyped: { from: mockFrom, rpc: rpcWithQuoteVersions },
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
      QUOTE_RESEND_REQUIRED: 'QUOTE_RESEND_REQUIRED',
    },
    rpcCodeDetail: (error: { message?: string }, code: string) => (
      hasRpcCode(error, code) ? (error.message ?? '').slice(code.length + 1).trim() : null
    ),
    rpcAuthErrorMessage: (error: { message?: string }) => (
      hasRpcCode(error, 'AUTH_REQUIRED') || hasRpcCode(error, 'ACTOR_MISMATCH')
        ? 'Your sign-in could not be verified. Refresh the page and try again.'
        : null
    ),
    sanitizeError,
  };
});

// The signed-in role; a test may change it to re-run the reference load (a role change does).
const authState = vi.hoisted(() => ({ role: 'admin' }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: authState.role, full_name: 'Test Admin' }, role: authState.role }),
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
vi.mock('../lib/dateUtils', () => ({
  localDatePlusDays: vi.fn(() => '2026-04-15'),
  localToday: vi.fn(() => '2026-03-16'),
  todayInBusinessTz: vi.fn(() => '2026-03-16'),
  parseLocalDate: (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  },
}));
vi.mock('../lib/quotePdf', () => ({ downloadQuotePdf: vi.fn(), generateQuotePdf: mockGenerateQuotePdf }));
vi.mock('../lib/emailService', () => ({ sendEmail: mockSendEmail, pdfToBase64: vi.fn(), buildEmailHtml: vi.fn(() => '<p>test</p>') }));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: vi.fn().mockResolvedValue({ compliant: true, warnings: [], rupProductNames: [] }),
}));
vi.mock('../components/ui/CommissionSplitEditor', () => ({
  default: () => <div data-testid="commission-split-editor">CommissionSplitEditor</div>,
}));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));
// Has its own tests (LastChargedPrices.test.tsx); here a marker stands in, so its load and Retry stay
// out of these tests while who sees it is still checked.
vi.mock('../components/quotes/LastChargedPrices', () => ({ default: () => <div data-testid="last-charged-card" /> }));

import { preferredQuoteNotes } from '../lib/quoteNotes';
import QuoteBuilder from './QuoteBuilder';
import { PRODUCT_COLUMNS, QUOTE_ITEM_COLUMNS } from '../lib/costFields';
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

// The quote header read embeds its customer (customer:customers(*)); the page takes the customer's
// name and contact details from it, and refuses to save a quote whose customer did not load.
const QUOTE_FIXTURE_CUSTOMER = { id: 'customer-1', farm_name: 'Farm', email: 'grower@example.com', assigned_tier: 1, is_active: true };

function makeQuoteFixture(status: 'draft' | 'sent' | 'accepted' = 'draft', rowVersion?: number) {
  const quote = {
    id: `quote-${status}-${rowVersion ?? 'legacy'}`,
    quote_number: 'Q-version-test',
    customer_id: 'customer-1',
    customer: QUOTE_FIXTURE_CUSTOMER,
    tier: 1,
    valid_days: 30,
    header_notes: 'Version test header',
    footer_notes: '',
    status,
    is_planned: false,
    commission_split: { splits: [] },
    created_at: RECENT_QUOTE_CREATED_AT,
    // The expiry a send stores; the emailed PDF shows it (20261027040000).
    expires_at: '2026-11-25',
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

// The by-id read of a saved quote's section fields, held open until the test releases it.
function holdFieldReadById() {
  let release!: (result: { data: unknown; error: unknown }) => void;
  const read = new Promise<{ data: unknown; error: unknown }>((resolve) => { release = resolve; });
  let readsById = 0;
  const fieldsChain = () => {
    let byId = false;
    const self: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'range', 'ilike', 'is']) self[m] = () => self;
    self.in = () => { byId = true; readsById += 1; return self; };
    const settle = () => (byId ? read : Promise.resolve({ data: [], error: null }));
    self.then = (...args: Parameters<Promise<unknown>['then']>) => settle().then(...args);
    self.catch = (...args: Parameters<Promise<unknown>['catch']>) => settle().catch(...args);
    self.finally = (...args: Parameters<Promise<unknown>['finally']>) => settle().finally(...args);
    return self;
  };
  return { fieldsChain, release, read, readsById: () => readsById };
}

const FAR_FIELD_FARM = { id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true };
const HOME_QUARTER_OF_CUSTOMER_1 = { id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 80, measured_acres: null, override_acres: null };

// Picks Far Field Farm while the saved field is loading, then lets the field (the original
// customer's) arrive: the only path that clears a saved section field on open.
async function pickCustomerThenReleaseField(held: ReturnType<typeof holdFieldReadById>, afterPick?: () => void) {
  await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
  const customerBox = screen.getByRole('combobox', { name: 'Customer' });
  fireEvent.change(customerBox, { target: { value: 'Far' } });
  fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
  expect(customerBox).toHaveValue('Far Field Farm');
  afterPick?.();
  await act(async () => {
    held.release({ data: [HOME_QUARTER_OF_CUSTOMER_1], error: null });
    await held.read;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    authState.role = 'admin';
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
    mockSendEmail.mockResolvedValue({ deduplicated: false });
  });

  it('shows the Last Charged card to admins and sales reps, never in Customer View or to other roles', async () => {
    renderQuoteBuilder();
    expect(await screen.findByTestId('last-charged-card')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Customer View/ }));
    expect(screen.queryByTestId('last-charged-card')).not.toBeInTheDocument();
    cleanup();

    authState.role = 'sales_rep';
    renderQuoteBuilder();
    expect(await screen.findByTestId('last-charged-card')).toBeInTheDocument();
    cleanup();

    authState.role = 'driver';
    renderQuoteBuilder();
    expect(await screen.findByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(screen.queryByTestId('last-charged-card')).not.toBeInTheDocument();
  });

  it('prices from the searched customer\'s tier and clears a section field of another customer', async () => {
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'customers'
        ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
        : table === 'fields'
          ? [{ id: 'field-9', field_name: 'North Forty', customer_id: 'customer-9', total_acres: 40, measured_acres: null, override_acres: null }]
          : [],
      error: null,
    }));
    renderQuoteBuilder();

    const fieldBox = await screen.findByRole('combobox', { name: 'Field for Section 1' });
    fireEvent.change(fieldBox, { target: { value: 'No' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Forty/ }));
    expect(fieldBox).toHaveValue('North Forty');

    const customerBox = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));

    expect(customerBox).toHaveValue('Far Field Farm');
    expect(screen.getByDisplayValue('Tier 3')).toBeInTheDocument();
    // North Forty belongs to another customer, so the section no longer names it, and the
    // user is told to check that section's acres (Luna, #1017).
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining("Check those lines' acres"));
  });

  it('drops the acres a cleared section field filled in when the customer changes, and keeps typed acres', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const typedItem = { ...item, id: 'item-2', sort_order: 1, acres: 15 };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item, typedItem]
            : table === 'customers'
              ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
              : table === 'fields'
                ? [{ id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 80, measured_acres: 40, override_acres: null }]
                : table === 'products'
                  ? [product]
                  : [],
      error: null,
    }));
    renderQuoteBuilder(quote.id);

    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    // The second line's acres are typed by hand, and happen to equal the field's.
    await waitFor(() => expect(screen.getAllByLabelText('Acres')).toHaveLength(2));
    fireEvent.change(screen.getAllByLabelText('Acres')[1], { target: { value: '40' } });
    fireEvent.change(fieldBox, { target: { value: 'Ho' } });
    fireEvent.click(await screen.findByRole('option', { name: /Home Quarter/ }));
    // The pick fills the empty line's acres from the field (measured before total); typed acres stay.
    await waitFor(() => expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['40', '40']));

    const customerBox = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));

    // Home Quarter belongs to another customer: the section drops it and the acres it filled in.
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['', '40']);
  });

  it('drops the acres a field filled in when the field is cleared or replaced by hand, and keeps typed acres', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const typedItem = { ...item, id: 'item-2', sort_order: 1, acres: 15 };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item, typedItem]
            : table === 'fields'
              ? [
                { id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 40, measured_acres: null, override_acres: null },
                { id: 'field-2', field_name: 'North Eighty', customer_id: 'customer-1', total_acres: 80, measured_acres: null, override_acres: null },
              ]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    renderQuoteBuilder(quote.id);
    const acres = () => screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(acres()).toHaveLength(2));

    fireEvent.change(fieldBox, { target: { value: 'Ho' } });
    fireEvent.click(await screen.findByRole('option', { name: /Home Quarter/ }));
    await waitFor(() => expect(acres()).toEqual(['40', '15']));

    // Replacing the field swaps in the new field's acres; the typed line is untouched.
    fireEvent.change(fieldBox, { target: { value: 'No' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Eighty/ }));
    await waitFor(() => expect(acres()).toEqual(['80', '15']));

    // Clearing the field drops the acres it filled in.
    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(acres()).toEqual(['', '15']);
  });

  it('refuses to clear a saved field while it is still loading, then clears it once loaded, keeping saved acres', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [{ ...item, acres: 80 }]
            : table === 'products'
              ? [product]
              : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);
    const acres = () => screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value);
    await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    expect(mockToast).toHaveBeenCalledWith('error', "This section's field is still loading. Try again in a moment.");
    expect(acres()).toEqual(['80']);

    await act(async () => {
      held.release({ data: [{ ...HOME_QUARTER_OF_CUSTOMER_1, total_acres: 80 }], error: null });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const fieldBox = screen.getByRole('combobox', { name: /^Field for/ });
    expect(fieldBox).toHaveValue('Home Quarter');
    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    await waitFor(() => expect(fieldBox).toHaveValue(''));
    expect(acres()).toEqual(['80']);
  });

  it('keeps a saved field whose read failed locked, with its acres and the refresh warning', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [{ ...item, acres: 80 }]
            : table === 'products'
              ? [product]
              : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);
    await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
    await act(async () => {
      held.release({ data: null, error: { message: 'fields unavailable' } });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The read failed: the field cannot be cleared (its acres cannot be attributed, and clearing it
    // would drop the refresh-before-saving warning), and nothing changes.
    expect(screen.getByText("This quote's fields could not be loaded. Refresh the page before saving.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Clear field/ }));
    expect(mockToast).toHaveBeenCalledWith('error', "This section's field could not be loaded. Refresh the page before changing it.");
    expect(screen.getByRole('button', { name: /^Clear field/ })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(screen.getByText("This quote's fields could not be loaded. Refresh the page before saving.")).toBeInTheDocument();
  });

  it('keeps a saved line\'s acres when its field is replaced after reopening, even when they match the old field', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            // Typed by hand as 80, the same as the saved field's acres; the source is not stored.
            ? [{ ...item, acres: 80 }]
            : table === 'fields'
              ? [
                { id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-1', total_acres: 80, measured_acres: null, override_acres: null },
                { id: 'field-2', field_name: 'North Field', customer_id: 'customer-1', total_acres: 120, measured_acres: null, override_acres: null },
              ]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));
    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(fieldBox).toHaveValue('Home Quarter'));

    fireEvent.change(fieldBox, { target: { value: 'No' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Field/ }));
    await waitFor(() => expect(fieldBox).toHaveValue('North Field'));
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(mockToast).toHaveBeenCalledWith('warning', "This section's saved lines keep their acres. Check them against the new field.");
  });

  it('keeps a line\'s unit price when a late-loading foreign field is cleared', async () => {
    const { quote, product: baseProduct, section, item } = makeQuoteFixture('draft', 7);
    // Tier 3 differs from the tier-1 price the saved line starts at.
    const product = { ...baseProduct, tier3_price: 7 };
    const savedItem = { ...item, acres: 80, product };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [savedItem]
            : table === 'customers'
              ? [FAR_FIELD_FARM]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);

    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    // The customer pick re-prices the line for its tier; clearing the field afterwards must not
    // re-price it again.
    const unitPrice = () => (screen.getByLabelText('Price per unit') as HTMLInputElement).value;
    let priceAfterPick = '';
    await pickCustomerThenReleaseField(held, () => { priceAfterPick = unitPrice(); });
    expect(fieldBox).toHaveValue('');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(Number(priceAfterPick)).toBe(7);
    expect(unitPrice()).toBe(priceAfterPick);
  });

  it('keeps a saved rate line\'s acres and total when its foreign field is cleared, product or not', async () => {
    const { quote, section, item } = makeQuoteFixture('draft', 7);
    const unreadableItem = {
      ...item, product: null, calc_mode: 'rate_acres', actual_rate: 1, rate_unit: 'gal',
      acres: 80, total_units_needed: 80, total_price: 800, profit: 320,
    };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [{ ...section, field_id: 'field-1' }]
          : table === 'quote_items'
            ? [unreadableItem]
            : table === 'customers'
              ? [FAR_FIELD_FARM]
              : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);

    await screen.findByRole('combobox', { name: /^Field for/ });
    expect(screen.getAllByText('$800.00').length).toBeGreaterThan(0);
    await pickCustomerThenReleaseField(held);
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
    expect(screen.getAllByText('$800.00').length).toBeGreaterThan(0);
  });

  it('clears a saved section field of the original customer when it loads after another customer was picked', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const savedSection = { ...section, field_id: 'field-1' };
    // The saved line's acres came from its field; the second line's were typed.
    const fieldItem = { ...item, acres: 80 };
    const typedItem = { ...item, id: 'item-2', sort_order: 1, acres: 15 };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [fieldItem, typedItem]
            : table === 'customers'
              ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));

    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    // While the saved field is still loading, the user picks a different customer; the saved
    // field then arrives: it belongs to the ORIGINAL customer, so the section drops it.
    await pickCustomerThenReleaseField(held);
    expect(fieldBox).toHaveValue('');
    expect(screen.queryByDisplayValue('Home Quarter')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80', '15']);
  });

  it('does not clear quote B\'s saved field when a field read started for quote A lands after the switch', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    // B belongs to another customer but keeps the same saved field (it was moved after B was saved).
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header', customer_id: 'customer-2' };
    const savedSection = { ...section, field_id: 'field-1' };
    const savedItem = { ...item, acres: 80 };
    const held = holdFieldReadById();
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [savedItem]
            : table === 'products'
              ? [product]
              : [],
      error: null,
    })));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');

    // A's read lands while B is open: B was only opened, so its saved field and acres stay.
    await act(async () => {
      held.release({ data: [HOME_QUARTER_OF_CUSTOMER_1], error: null });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('combobox', { name: /^Field for/ })).toHaveValue('Home Quarter');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
  });

  it('clears a foreign saved field when the customer is picked away and back while the field loads', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const savedSection = { ...section, field_id: 'field-1' };
    const held = holdFieldReadById();
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [{ ...item, acres: 80 }]
            : table === 'customers'
              ? [FAR_FIELD_FARM, QUOTE_FIXTURE_CUSTOMER]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));
    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));

    // Far Field Farm is picked, then the quote's own customer again, before the field arrives.
    const customerBox = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    fireEvent.change(customerBox, { target: { value: 'Farm' } });
    fireEvent.click(await screen.findByRole('option', { name: /^Farm/ }));
    expect(customerBox).toHaveValue('Farm');

    // The field belongs to neither: the picks count, so the section drops it.
    await act(async () => {
      held.release({ data: [{ ...HOME_QUARTER_OF_CUSTOMER_1, customer_id: 'customer-elsewhere' }], error: null });
      await held.read;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fieldBox).toHaveValue('');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
  });

  it('clears quote B\'s foreign field when a customer is picked on B before quote A\'s field read lands', async () => {
    const { quote: quoteA, product, section, item } = makeQuoteFixture('draft', 7);
    const quoteB = { ...quoteA, id: 'quote-b', quote_number: 'Q-b', header_notes: 'Quote B header', customer_id: 'customer-2' };
    const savedSection = { ...section, field_id: 'field-1' };
    const savedItem = { ...item, acres: 80 };
    const held = holdFieldReadById();
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => (table === 'fields' ? held.fieldsChain() : buildChain({
      data: table === 'quotes'
        ? (quoteReads++ === 0 ? quoteA : quoteB)
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [savedItem]
            : table === 'customers'
              ? [FAR_FIELD_FARM]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    })));

    renderQuoteBuilderWithQuoteSwitch(quoteA.id, quoteB.id);
    await waitFor(() => expect(held.readsById()).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('link', { name: 'Jump to quote B' }));
    await screen.findByDisplayValue('Quote B header');

    // On B the user picks another customer; A's read then lands with the original customer's field.
    await pickCustomerThenReleaseField(held);
    expect(screen.getByRole('combobox', { name: /^Field for/ })).toHaveValue('');
    expect(screen.getAllByLabelText('Acres').map((el) => (el as HTMLInputElement).value)).toEqual(['80']);
  });

  it('keeps a saved section field that now belongs to another customer when the quote is only opened (CodeRabbit, #1017)', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const savedSection = { ...section, field_id: 'field-1' };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [savedSection]
          : table === 'quote_items'
            ? [item]
            : table === 'fields'
              // The field was moved to another customer after the quote was saved.
              ? [{ id: 'field-1', field_name: 'Home Quarter', customer_id: 'customer-elsewhere', total_acres: 80, measured_acres: null, override_acres: null }]
              : table === 'products'
                ? [product]
                : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);
    const fieldBox = await screen.findByRole('combobox', { name: /^Field for/ });
    await waitFor(() => expect(fieldBox).toHaveValue('Home Quarter'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fieldBox).toHaveValue('Home Quarter');
  });

  it('clears the product list and blocks new lines when a reload of the products fails', async () => {
    let productsFail = false;
    let failedReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'products') return buildChain({ data: [], error: null });
      if (!productsFail) {
        return buildChain({ data: [{ id: 'product-1', product_name: 'Alpha Herbicide', is_active: true }], error: null });
      }
      failedReads += 1;
      return buildChain({ data: null, error: { message: 'products unavailable' } });
    });
    const view = renderQuoteBuilder();
    expect(await screen.findByRole('button', { name: 'Add one' })).toBeInTheDocument();
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('products'));
    expect(screen.queryByText(/Products failed to load/)).not.toBeInTheDocument();

    // A role change re-runs the reference load; this time the product read fails.
    productsFail = true;
    authState.role = 'sales';
    view.rerender(
      <MemoryRouter initialEntries={['/quotes/new']}>
        <Routes>
          <Route path="/quotes/new" element={<QuoteBuilder />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Products failed to load\. Refresh the page before adding products or saving this quote\./)).toBeInTheDocument();
    expect(failedReads).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Add one' }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products failed to load. Refresh the page before adding products.');
    // No line was added: the section still offers its first line.
    expect(screen.getByRole('button', { name: 'Add one' })).toBeInTheDocument();
  });

  it('no line can be added or priced, and nothing saved, until the products and unit conversions finish loading', async () => {
    // The product read is held open until the test releases it; until then every unit
    // would convert at a factor of 1, so the page must refuse to add, price or save.
    let releaseProducts!: (result: { data: unknown; error: unknown }) => void;
    const productsRead = new Promise<{ data: unknown; error: unknown }>((resolve) => { releaseProducts = resolve; });
    const heldChain = () => {
      const self: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'range', 'in', 'is']) self[m] = () => self;
      self.then = (...args: Parameters<Promise<unknown>['then']>) => productsRead.then(...args);
      self.catch = (...args: Parameters<Promise<unknown>['catch']>) => productsRead.catch(...args);
      self.finally = (...args: Parameters<Promise<unknown>['finally']>) => productsRead.finally(...args);
      return self;
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'products') return heldChain();
      return buildChain({
        data: table === 'customers' ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }] : [],
        error: null,
      });
    });
    renderQuoteBuilder();

    const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    expect(customerBox).toHaveValue('Far Field Farm');

    // Adding a line is refused while the products load.
    fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
    expect(screen.getByRole('button', { name: 'Add one' })).toBeInTheDocument();

    // Saving is refused too, before any save reaches the server.
    mockToast.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.'));
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());

    // Once the products land, adding a line works.
    await act(async () => {
      releaseProducts({ data: [{ id: 'product-1', product_name: 'Alpha Herbicide', is_active: true }], error: null });
      await productsRead;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mockToast.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Add one' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add one' })).not.toBeInTheDocument());
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
  });

  it('refuses a customer, tier or section field change while saved lines exist and products are still loading, then allows it', async () => {
    // Repricing a saved line before unit conversions load would convert at a factor of 1.
    let releaseProducts!: (result: { data: unknown; error: unknown }) => void;
    const productsRead = new Promise<{ data: unknown; error: unknown }>((resolve) => { releaseProducts = resolve; });
    const heldChain = () => {
      const self: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'or', 'not', 'order', 'limit', 'range', 'in', 'is']) self[m] = () => self;
      self.then = (...args: Parameters<Promise<unknown>['then']>) => productsRead.then(...args);
      self.catch = (...args: Parameters<Promise<unknown>['catch']>) => productsRead.catch(...args);
      self.finally = (...args: Parameters<Promise<unknown>['finally']>) => productsRead.finally(...args);
      return self;
    };
    const product = { id: 'product-1', product_name: 'Alpha Herbicide', is_active: true, tier1_price: 10, tier2_price: 9, tier3_price: 8 };
    const quote = {
      id: 'quote-77', quote_number: 'Q-2026-0077', customer_id: null, tier: 1, valid_days: 30,
      header_notes: null, footer_notes: null, status: 'draft', is_planned: false, commission_split: null,
      created_at: RECENT_QUOTE_CREATED_AT,
    };
    const section = {
      id: 'section-1', quote_id: quote.id, section_name: 'Products', sort_order: 1, section_notes: null,
      section_header_notes: null, needed_by_date: null, field_id: null,
    };
    const item = {
      id: 'item-1', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 1, product,
      calc_mode: 'units_direct', total_units_needed: 1, price_per_unit: 10, price_override: null, suggested_rate: null,
      actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: null,
      total_price: 10, notes: null, price_unit: null,
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'products') return heldChain();
      const data = table === 'quotes' ? quote
        : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-3', farm_name: 'Far Field Farm', assigned_tier: 3, is_active: true }]
              : table === 'fields' ? [{ id: 'field-9', field_name: 'North Forty', customer_id: null, total_acres: 40, is_active: true }]
                : [];
      return buildChain({ data, error: null });
    });
    renderQuoteBuilder(quote.id);

    // A field's acres would reprice the saved line, so the field pick waits too (CodeRabbit, #1017).
    const fieldBox = await screen.findByRole('combobox', { name: 'Field for Products' });
    fireEvent.focus(fieldBox);
    fireEvent.change(fieldBox, { target: { value: 'North' } });
    fireEvent.click(await screen.findByRole('option', { name: /North Forty/ }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
    expect(fieldBox).toHaveValue('');
    mockToast.mockClear();

    const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
    fireEvent.focus(customerBox);
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
    expect(customerBox).toHaveValue('');
    const tierSelect = screen.getByDisplayValue('Tier 1');
    fireEvent.change(tierSelect, { target: { value: '2' } });
    expect(tierSelect).toHaveValue('1');

    await act(async () => {
      releaseProducts({ data: [product], error: null });
      await productsRead;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    mockToast.mockClear();
    fireEvent.focus(customerBox);
    fireEvent.change(customerBox, { target: { value: 'Far' } });
    fireEvent.click(await screen.findByRole('option', { name: /Far Field Farm/ }));
    expect(customerBox).toHaveValue('Far Field Farm');
    expect(screen.getByDisplayValue('Tier 3')).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Products are still loading. Try again in a moment.');
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

  it('keeps version history in saved order when a newer version is unreadable', async () => {
    // Codex on #592: the page rendered every readable version and then every unreadable one, so
    // a quote whose NEWEST version is unreadable displayed it underneath the older readable
    // ones — v2, v1, v3 — and the history claimed an order the data does not have.
    const { quote, product, section, item } = makeQuoteFixture('sent', 7);
    const versionRow = (
      id: string,
      versionNumber: number,
      sentAt: string,
      snapshotData: unknown,
    ) => ({
      id,
      quote_id: quote.id,
      version_number: versionNumber,
      sent_by: 'profile-1',
      sent_at: sentAt,
      sent_method: null,
      snapshot_data: snapshotData,
      pdf_url: null,
      notes: null,
      restore_trusted_at: null,
    });
    // The legacy shape the strict validator refuses: quote fields at the top level, no `quote` key.
    const unreadableSnapshot = {
      quote_number: 'Q-version-order',
      customer_id: 'customer-1',
      customer_name: 'Farm',
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      commission_split: null,
      totals: { total_price: 4321 },
      sections: [],
    };
    const readableSnapshot = (totalPrice: number) => ({
      quote: {
        quote_number: 'Q-version-order',
        customer_id: 'customer-1',
        tier: 1,
        status: 'sent',
        total_price: totalPrice,
        total_cost: 0,
        total_profit: totalPrice,
        total_margin_pct: 100,
        valid_days: 30,
        expires_at: null,
        header_notes: null,
        footer_notes: null,
        is_planned: false,
        commission_split: null,
      },
      sections: [],
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
                  // The server returns one version_number-descending sequence; the newest is the
                  // one this build cannot read.
                  ? [
                      versionRow('version-3', 3, '2026-03-16T15:44:00.000Z', unreadableSnapshot),
                      versionRow('version-2', 2, '2026-03-16T15:43:00.000Z', readableSnapshot(200)),
                      versionRow('version-1', 1, '2026-03-16T15:42:00.000Z', readableSnapshot(100)),
                    ]
                  : [],
      error: null,
    }));

    renderQuoteBuilder(quote.id);

    fireEvent.click(await screen.findByRole('button', { name: /Versions \(3\)/ }));

    // Guard the fixture: if all three landed in one bucket the ordering claim would be vacuous.
    expect(await screen.findByText(/Saved in an older format/)).toBeInTheDocument();
    expect(screen.getAllByText(/Saved in an older format/)).toHaveLength(1);

    expect(screen.getAllByText(/^v\d+$/).map((node) => node.textContent))
      .toEqual(['v3', 'v2', 'v1']);
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
    expect(quoteItemSelects).toContain(`${QUOTE_ITEM_COLUMNS}, product:products(${PRODUCT_COLUMNS}, product_family:product_families(name))`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves a stale edit until Reload Quote replaces it and sends the refreshed version on the next save', async () => {
    const quote = { id: 'quote-stale', quote_number: 'Q-stale', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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

  // save_quote refuses QUOTE_ITEM_AMBIGUOUS_COST when a saved quote holds two
  // lines of one product and the save does not say which line is which.
  it('names every saved line on each save so two lines of one product keep their own costs', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    const secondLine = { ...item, id: 'item-2', sort_order: 1, total_units_needed: 5, total_price: 50, profit: 20 };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? quote : table === 'quote_sections' ? [section] : table === 'quote_items' ? [item, secondLine] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [product] : [], error: null }));
    let saves = 0;
    mockRpc.mockImplementation((name: string, args: { p_sections?: Array<{ items: Array<{ client_key: string }> }> }) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      saves += 1;
      // Mint visibly new ids so the next save can only send them if the page installed this map.
      const itemIds = Object.fromEntries((args.p_sections ?? []).flatMap((s) => s.items)
        .map((line, index) => [line.client_key, `saved-${saves}-${index}`]));
      return Promise.resolve({ data: { status: 'saved', quote_id: quote.id, row_version: 7 + saves, item_ids: itemIds }, error: null });
    });
    const sentLines = (call: number) => (mockRpc.mock.calls.filter(([name]) => name === 'save_quote')[call][1] as {
      p_sections: Array<{ items: Array<{ id: string | null; client_key: string; product_id: string }> }>;
    }).p_sections.flatMap((s) => s.items);

    renderQuoteBuilder(quote.id);
    const header = await screen.findByDisplayValue('Version test header');
    fireEvent.change(header, { target: { value: 'First edit' } });
    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => expect(saves).toBe(1));
    const first = sentLines(0);
    expect(first.map((line) => line.id)).toEqual(['item-1', 'item-2']);
    expect(first.every((line) => line.product_id === product.id && line.client_key)).toBe(true);
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));

    fireEvent.change(screen.getByDisplayValue('First edit'), { target: { value: 'Second edit' } });
    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => expect(saves).toBe(2));
    expect(sentLines(1).map((line) => line.id)).toEqual(['saved-1-0', 'saved-1-1']);
  });

  it('stops naming a line as its saved line once it is switched to another product, even if switched back', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const alpha = { ...fixture.product, product_name: 'Alpha Chem' };
    const beta = { ...fixture.product, id: 'product-2', product_name: 'Beta Chem' };
    const first = { ...fixture.item, product: alpha };
    const second = { ...fixture.item, id: 'item-2', sort_order: 1, product: alpha };
    mockFrom.mockImplementation((table: string) => buildChain({ data: table === 'quotes' ? fixture.quote : table === 'quote_sections' ? [fixture.section] : table === 'quote_items' ? [first, second] : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }] : table === 'products' ? [alpha, beta] : [], error: null }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: fixture.quote.id, row_version: 8, item_ids: {} }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(fixture.quote.id);
    const pick = async (lineIndex: number, productName: string) => {
      fireEvent.click((await screen.findAllByRole('button', { name: /Alpha Chem|Beta Chem/ }))[lineIndex]);
      const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
      const dialog = picker.closest('[role="dialog"]') as HTMLElement;
      fireEvent.click(within(dialog).getByText(productName));
      await waitFor(() => expect(screen.queryByPlaceholderText('Search by name, SKU, category, or vendor...')).not.toBeInTheDocument());
    };
    await pick(0, 'Beta Chem');
    await pick(0, 'Alpha Chem');
    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    const lines = (mockRpc.mock.calls.find(([name]) => name === 'save_quote')![1] as {
      p_sections: Array<{ items: Array<{ id: string | null; product_id: string }> }>;
    }).p_sections.flatMap((s) => s.items);
    expect(lines.map((line) => [line.id, line.product_id])).toEqual([[null, 'product-1'], ['item-2', 'product-1']]);
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

  // Item 9 (Mason 2026-10-26/27): a booking runs to season end (Sept 30) unless the rep picks a
  // date. The database applies the pick at each send; the screen sends it with every save.
  describe('expiry: season end or a picked date', () => {
    function serveDraft(overrides: Record<string, unknown>) {
      const { quote, product, section, item } = makeQuoteFixture('draft', 7);
      const served = { ...quote, ...overrides };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? served
          : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
          : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
          : table === 'products' ? [product]
          : [],
        error: null,
      }));
      mockRpc.mockImplementation(() => Promise.resolve({ data: { quote_id: served.id, row_version: 8 }, error: null }));
      return served;
    }
    async function saveDraftPayload() {
      fireEvent.click(screen.getByText('Save Draft'));
      await waitFor(() => {
        expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote').length).toBe(1);
      });
      const [, args] = mockRpc.mock.calls.find(([name]) => name === 'save_quote')!;
      return (args as { p_quote_payload: Record<string, unknown> }).p_quote_payload;
    }

    it('keeps a picked date and sends it as the expiry', async () => {
      const quote = serveDraft({ chosen_expiry_date: '2026-12-15' });
      renderQuoteBuilder(quote.id);
      await screen.findByText('Save Draft');

      expect(screen.getByLabelText('Expires')).toHaveValue('date');
      expect(screen.getByLabelText('Expiry date')).toHaveValue('2026-12-15');
      const payload = await saveDraftPayload();
      expect(payload.chosen_expiry_date).toBe('2026-12-15');
      expect(payload.expires_at).toBe('2026-12-15');
    });

    it('switching to season end clears the pick and shows Sept 30', async () => {
      const quote = serveDraft({ chosen_expiry_date: '2026-12-15' });
      renderQuoteBuilder(quote.id);
      await screen.findByText('Save Draft');

      fireEvent.change(screen.getByLabelText('Expires'), { target: { value: 'season' } });
      expect(screen.queryByLabelText('Expiry date')).not.toBeInTheDocument();
      // "Today" is pinned to 2026-03-16 above: season 2026, which ends Sept 30, 2026.
      expect(screen.getByRole('option', { name: 'Sep 30, 2026 (season end)' })).toBeInTheDocument();
      const payload = await saveDraftPayload();
      expect(payload.chosen_expiry_date).toBeNull();
      expect(payload.expires_at).toBe('2026-09-30');
      expect(payload).not.toHaveProperty('valid_days');
    });

    it('a quote with no pick opens on season end', async () => {
      const quote = serveDraft({ chosen_expiry_date: null });
      renderQuoteBuilder(quote.id);
      await screen.findByText('Save Draft');

      expect(screen.getByLabelText('Expires')).toHaveValue('season');
      expect((await saveDraftPayload()).chosen_expiry_date).toBeNull();
    });
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
    const quote = { id: 'quote-decline-key', quote_number: 'Q-decline-key', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Local note', footer_notes: '', status: 'sent', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-direct-jump', quote_number: 'Q-direct-jump', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Keep this local note', footer_notes: '', status: 'sent', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-partial', quote_number: 'Q-partial', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-unstable-reload', quote_number: 'Q-unstable', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: 'Original header', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-reopen', quote_number: 'Q-reopen', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-jumped-token', quote_number: 'Q-jumped', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-reopen-read-fail', quote_number: 'Q-reopen-read-fail', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'accepted', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    const quote = { id: 'quote-freeze', quote_number: 'Q-freeze', customer_id: 'customer-1', customer: QUOTE_FIXTURE_CUSTOMER, tier: 1, valid_days: 30, header_notes: '', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: RECENT_QUOTE_CREATED_AT };
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
    // The PDF carries the expiry this send stored, read as a local date, not created_at + valid_days.
    expect(mockGenerateQuotePdf).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: new Date(2026, 10, 25).toISOString() }),
      expect.anything(),
    );
    expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('Quote emailed'));
  });

  it('does not email the quote when the expiry its send stored cannot be read', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const { product, section, item } = fixture;
    const quote = { ...fixture.quote, status: 'sent' };
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 2 ? quote : quoteReads === 3 ? { ...quote, row_version: 8 } : { ...quote, row_version: 8, expires_at: null })
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

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('expiry date could not be read')));
    expect(mockSendEmail).not.toHaveBeenCalled();
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

  it('converts a sent quote in one step, without saving it as accepted first (KI-12)', async () => {
    const fixture = makeQuoteFixture('sent', 7);
    const quote = { ...fixture.quote, created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'convert_quote_to_order'
      ? { data: { status: 'converted', order_id: 'order-1', order_number: 'O-1', warnings: [] }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create Order ▾' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create Order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-1'));
    // The RPC accepts the quote in the same transaction as the order, against the loaded token.
    expect(mockRpc).toHaveBeenCalledWith(
      'convert_quote_to_order',
      expect.objectContaining({ p_quote_id: quote.id, p_expected_row_version: 7 }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
  });

  it('leaves the quote status alone when the conversion fails', async () => {
    const fixture = makeQuoteFixture('sent', 7);
    const quote = { ...fixture.quote, created_at: new Date().toISOString() };
    const quoteUpdates: unknown[] = [];
    mockFrom.mockImplementation((table: string) => {
      const chain = buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      });
      if (table === 'quotes') {
        chain.update = (values: unknown) => {
          quoteUpdates.push(values);
          return chain;
        };
      }
      return chain;
    });
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'convert_quote_to_order'
      ? { data: null, error: { message: 'COST_BASIS_REQUIRED: a line has no cost' } }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create Order ▾' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create Order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('no recorded cost')));
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(quoteUpdates).toEqual([]);
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining('/orders/'));
  });

  // Item 11a / KI-82: after Save an admin sees the cost the database recorded for each saved line,
  // not the cost the page loaded with, and the just-saved quote is not marked as changed.
  it('shows each saved line’s recorded cost after Save, without marking the quote changed', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string, args?: unknown) => {
      if (name === 'save_quote') {
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string; price_per_unit: number }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: line.price_per_unit },
        }, error: null });
      }
      if (name === 'get_admin_cost_fields') {
        // The database recorded $7.00 for the saved line, today's cost for the product; the page
        // loaded both at $6.00.
        const table = (args as { p_table: string }).p_table;
        return Promise.resolve({ data: table === 'quote_items'
          ? { 'item-1': { current_cost: 7, profit: 6, net_margin: 30, cost_at_quote_cents: 700 } }
          : { 'product-1': { current_cost: 7 } }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    await screen.findByText('$6.00');
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
    fireEvent.click(screen.getByText('Save Draft'));

    expect(await screen.findByText('$7.00')).toBeInTheDocument();
    // Today's cost is re-read too, so the line never shows a stale "today" beside the recorded cost.
    expect(screen.queryByText(/today \$6\.00/)).not.toBeInTheDocument();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_admin_cost_fields', { p_table: 'products', p_ids: ['product-1'] }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_admin_cost_fields', { p_table: 'quote_items', p_ids: ['item-1'] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dirtyStates[dirtyStates.length - 1]).toBe(false);
  });

  describe('sent-price lock (To-Do 1.2)', () => {
    // A revised quote whose V1 was sent at 10.00; the catalog tier 1 price is 12.00 today.
    function configureLockedQuote() {
      const fixture = makeQuoteFixture('sent', 7);
      const quote = { ...fixture.quote, status: 'revised', created_at: new Date().toISOString() };
      const product = { ...fixture.product, tier1_price: 12 };
      const item = { ...fixture.item, product };
      const sentVersion = {
        id: 'version-1',
        quote_id: quote.id,
        version_number: 1,
        sent_by: 'user-1',
        sent_at: '2026-10-25T15:00:00.000Z',
        sent_method: 'presented',
        snapshot_data: {
          quote: {
            quote_number: quote.quote_number, customer_id: 'customer-1', tier: 1, status: 'sent',
            total_price: 20, total_cost: 12, total_profit: 8, total_margin_pct: 40, valid_days: 30,
            expires_at: null, header_notes: null, footer_notes: null, is_planned: false, commission_split: null,
          },
          sections: [{
            section_name: 'Products', sort_order: 0, section_notes: null, section_header_notes: null,
            needed_by_date: null,
            items: [{
              quote_item_id: 'item-1', price_override: null, product_id: 'product-1', product_name: 'Product',
              sku: null, sort_order: 0, notes: null, price_per_unit: 10, current_cost: 6, suggested_rate: null,
              actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null,
              total_units_needed: 2, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40,
              calc_mode: 'units_direct', price_unit: null,
            }],
          }],
        },
        pdf_url: null,
        notes: null,
        restore_trusted_at: '2026-10-25T15:00:00.000Z',
      };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [product]
                  : table === 'quote_versions' ? [sentVersion]
                    : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8, item_ids: { } }, error: null }
        : name === 'restore_quote_version'
          ? { data: { status: 'restored', restored_from_version: 1, quote_id: quote.id, row_version: 8 }, error: null }
          : { data: null, error: null }));
      return { quote, sentVersion };
    }
    const savedLine = () => (mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as {
      p_sections: Array<{ items: Array<{ id: string | null; price_per_unit: number; price_override: number | null; use_todays_price: boolean }> }>;
    }).p_sections[0].items[0];

    it('keeps the sent price through an edit after the catalog price rose', async () => {
      const { quote } = configureLockedQuote();
      renderQuoteBuilder(quote.id);
      expect(await screen.findByText(/Prices stay as sent in V1/)).toBeInTheDocument();
      const units = await screen.findByRole('spinbutton', { name: 'Units needed' });
      await waitFor(() => expect(units).toBeEnabled());
      fireEvent.change(units, { target: { value: '3' } });
      expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toHaveValue(10);
      fireEvent.click(screen.getByRole('button', { name: /Save Draft|Save Changes|Save/ }));

      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      expect(savedLine()).toMatchObject({ id: 'item-1', price_per_unit: 10, price_override: null, use_todays_price: false });
    });

    // Item 10b (Mason 2026-10-27, 20261029120000): a changed price applies without a re-send; a
    // higher one needs the rep's "grower agreed" tick. Until then (#1105) it needed a re-send.
    it('takes today\'s price on one line only when asked, with no re-send but the grower\'s OK', async () => {
      const { quote } = configureLockedQuote();
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Use today $12.00' }));

      expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toHaveValue(12);
      expect(screen.getByText('Sent at $10.00')).toBeInTheDocument();
      expect(screen.queryByText(/Prices or lines changed after V1 was sent/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' }));
      fireEvent.click(screen.getByRole('button', { name: /Save Draft|Save Changes|Save/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      expect(savedLine()).toMatchObject({ id: 'item-1', price_per_unit: 12, price_override: null, use_todays_price: true, grower_confirmed: true });
    });

    it('keeps the price the database stored at the last save, not the one loaded', async () => {
      const { quote } = configureLockedQuote();
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string; price_per_unit: number }> }> })
          .p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: line.price_per_unit },
        }, error: null });
      });
      renderQuoteBuilder(quote.id);
      const price = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(price).toBeEnabled());
      fireEvent.change(price, { target: { value: '11' } });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $11.00 (was $10.00)' }));
      fireEvent.click(screen.getByRole('button', { name: /Save Draft|Save Changes|Save/ }));
      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
      await waitFor(() => expect(screen.getByRole('button', { name: /Save Draft|Save Changes|Save/ })).toBeEnabled());

      // Clearing the manual price returns the line to what the database now holds (11), not 10.
      fireEvent.click(screen.getByRole('button', { name: 'Reset the manual price' }));
      expect(screen.getByRole('spinbutton', { name: 'Price per unit' })).toHaveValue(11);
    });

    it('names a line by the row id its save returned, not only the id it loaded with', async () => {
      const { quote, sentVersion } = configureLockedQuote();
      // The sent version names the row the next save returns (item-2), as for a line added and
      // saved since the page loaded: its local item never carries that id.
      sentVersion.snapshot_data.sections[0].items[0].quote_item_id = 'item-2';
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string; price_per_unit: number }> }> })
          .p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-2' },
          item_prices: { [line.client_key]: line.price_per_unit },
        }, error: null });
      });
      renderQuoteBuilder(quote.id);
      expect(await screen.findByText('New since V1')).toBeInTheDocument();
      const units = await screen.findByRole('spinbutton', { name: 'Units needed' });
      await waitFor(() => expect(units).toBeEnabled());
      fireEvent.change(units, { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: /Save Draft|Save Changes|Save/ }));

      await waitFor(() => expect(screen.queryByText('New since V1')).not.toBeInTheDocument());
      expect(screen.queryByText(/Prices or lines changed after V1 was sent/)).not.toBeInTheDocument();
    });

    it('asks for a reload when the database stored a different price than the screen shows', async () => {
      const { quote } = configureLockedQuote();
      // The catalog moved to 13.00 after the page loaded at 12.00: save_quote prices today's line at 13.
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: 13 },
        }, error: null });
      });
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Use today $12.00' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' }));
      fireEvent.click(screen.getByRole('button', { name: /Save Draft|Save Changes|Save/ }));

      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('Reload the quote to see the saved prices')));
      expect(await screen.findByRole('button', { name: 'Reload Quote' })).toBeInTheDocument();
    });

    it('opens a new quote whose create stored a different price, instead of a reload that cannot recover it', async () => {
      // On /quotes/new the reload dialog cannot load the quote (the route names none) and the next
      // save would send no quote id, creating a second quote. The create opens the saved quote.
      const product = { id: 'product-1', product_name: 'Product', is_active: true, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true,
          default_commission_split: { splits: [{ recipient: 'Rep', percentage: 100 }] } }]
          : table === 'products' ? [product]
            : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: 'quote-new', row_version: 1,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: 13 },
        }, error: null });
      });
      renderQuoteBuilder();
      const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
      fireEvent.change(customerBox, { target: { value: 'Farm' } });
      fireEvent.click(await screen.findByRole('option', { name: /Farm/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
      fireEvent.click(await screen.findByRole('button', { name: /Select Product/ }));
      const picker = await screen.findByRole('dialog');
      fireEvent.click(await within(picker).findByRole('button', { name: /T1 price/ }));
      fireEvent.change(await screen.findByRole('spinbutton', { name: 'Units needed' }), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/quotes/quote-new', { replace: true }));
      expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('Check the saved prices before sending it'));
      expect(screen.queryByRole('button', { name: 'Reload Quote' })).not.toBeInTheDocument();
    });

    it('does not mark the quote presented when its save stored a different price than the preview showed', async () => {
      const { quote } = configureLockedQuote();
      mockRpc.mockImplementation((name: string, args?: unknown) => {
        if (name !== 'save_quote') return Promise.resolve({ data: { version_number: 2, row_version: 9 }, error: null });
        const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
        return Promise.resolve({ data: {
          quote_id: quote.id, row_version: 8,
          item_ids: { [line.client_key]: 'item-1' },
          item_prices: { [line.client_key]: 13 },
        }, error: null });
      });
      vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:quote'), revokeObjectURL: vi.fn() });
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Use today $12.00' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Preview Quote' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Mark as Presented' }));

      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('Reload the quote to see the saved prices')));
      expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything());
      expect(mockRpc).not.toHaveBeenCalledWith('create_quote_version', expect.anything());
    });

    it('rewinds to the version last sent in one confirmed step', async () => {
      const { quote, sentVersion } = configureLockedQuote();
      // A line the customer was not sent still needs a re-send (a changed price no longer does).
      sentVersion.snapshot_data.sections[0].items[0].quote_item_id = 'item-2';
      renderQuoteBuilder(quote.id);
      fireEvent.click(await screen.findByRole('button', { name: 'Rewind to V1' }));
      const dialog = await screen.findByRole('dialog', { name: 'Rewind to V1' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rewind to V1' }));

      await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(
        'restore_quote_version',
        expect.objectContaining({ p_quote_id: quote.id, p_version_id: 'version-1' }),
      ));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Restored from V1'));
    });
  });

  // Item 10b (Mason 2026-10-27): a booked price on a sent booking changes straight away, with no
  // re-send. A higher price needs the rep's "grower agreed" tick; a lower one does not
  // (20261029120000 records each change).
  describe('changing a booked price on a sent booking', () => {
    async function openRevisedAndSetPrice(price: string) {
      const fixture = makeQuoteFixture('sent', 7);
      const quote = { ...fixture.quote, status: 'revised', created_at: new Date().toISOString() };
      mockFrom.mockImplementation((table: string) => buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      }));
      mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null }
        : { data: null, error: null }));
      renderQuoteBuilder(quote.id);
      const priceInput = await screen.findByRole('spinbutton', { name: 'Price per unit' });
      await waitFor(() => expect(priceInput).toBeEnabled());
      fireEvent.change(priceInput, { target: { value: price } });
      fireEvent.blur(priceInput);
    }
    const savedLine = () => {
      const call = mockRpc.mock.calls.find(([name]) => name === 'save_quote');
      return (call?.[1] as { p_sections: Array<{ items: Array<Record<string, unknown>> }> }).p_sections[0].items[0];
    };

    it('a higher price needs the "grower agreed" tick before it saves', async () => {
      await openRevisedAndSetPrice('12');
      const tick = await screen.findByRole('checkbox', { name: 'Grower agreed to $12.00 (was $10.00)' });
      fireEvent.click(screen.getByText('Save Draft'));
      await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Grower agreed')));
      expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote')).toHaveLength(0);

      fireEvent.click(tick);
      fireEvent.click(screen.getByText('Save Draft'));
      await waitFor(() => expect(savedLine()).toMatchObject({ price_override: 12, grower_confirmed: true }));
    });

    it('a lower price saves with no tick', async () => {
      await openRevisedAndSetPrice('9');
      expect(screen.queryByRole('checkbox', { name: /Grower agreed/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Save Draft'));
      await waitFor(() => expect(savedLine()).toMatchObject({ price_override: 9 }));
      expect(savedLine()).not.toHaveProperty('grower_confirmed');
    });
  });

  it('saves an edited revised quote as revised, then converts it with the new token', async () => {
    const fixture = makeQuoteFixture('sent', 7);
    const quote = { ...fixture.quote, status: 'revised', created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: 8, item_ids: { } }, error: null }
      : name === 'convert_quote_to_order'
        ? { data: { status: 'converted', order_id: 'order-3', order_number: 'O-3', warnings: [] }, error: null }
        : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const units = await screen.findByRole('spinbutton', { name: 'Units needed' });
    await waitFor(() => expect(units).toBeEnabled());
    fireEvent.change(units, { target: { value: '3' } });
    const opener = screen.getByRole('button', { name: 'Create Order ▾' });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create Order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-3'));
    const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_quote');
    expect(saves).toHaveLength(1);
    expect((saves[0][1] as { p_quote_payload: { status: string } }).p_quote_payload.status).toBe('revised');
    expect(mockRpc).toHaveBeenCalledWith(
      'convert_quote_to_order',
      expect.objectContaining({ p_quote_id: quote.id, p_expected_row_version: 8 }),
    );
  });

  it('resumes an accepted quote through convert without saving it', async () => {
    const fixture = makeQuoteFixture('accepted', 7);
    const quote = { ...fixture.quote, created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'convert_quote_to_order'
      ? { data: { status: 'already_converted', order_id: 'order-4', warnings: [] }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create Order ▾' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create Order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-4'));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('already converted'));
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(mockTrackBusinessEvent).not.toHaveBeenCalled();
    expect(mockSendOrderConfirmedEmail).not.toHaveBeenCalled();
  });

  it('Book as Order marks the draft sent, then converts it without an accepted save', async () => {
    const { quote, product, section, item } = makeQuoteFixture('draft', 7);
    let quoteReads = 0;
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes'
        ? (++quoteReads <= 3 ? quote : { ...quote, status: 'sent', row_version: 9 })
        : table === 'quote_sections' ? [section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'save_quote'
        ? { data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null }
        : name === 'create_quote_version'
          ? { data: { version_number: 1, status: 'created', row_version: 9 }, error: null }
          : name === 'convert_quote_to_order'
            ? { data: { status: 'converted', order_id: 'order-5', order_number: 'O-5', warnings: [] }, error: null }
            : { data: null, error: null },
    ));

    renderQuoteBuilder(quote.id);
    await waitFor(() => {
      const bookAsOrderOpener = screen.getByRole('button', { name: 'Book as Order' });
      expect(bookAsOrderOpener).toBeEnabled();
      fireEvent.click(bookAsOrderOpener);
      expect(screen.getByRole('dialog', { name: 'Book as Order' })).toBeInTheDocument();
    });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Book as Order' })).getByRole('button', { name: 'Book as Order' }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-5'));
    const saveStatuses = mockRpc.mock.calls
      .filter(([name]) => name === 'save_quote')
      .map(([, args]) => (args as { p_quote_payload: { status: string } }).p_quote_payload.status);
    expect(saveStatuses).toEqual(['draft']);
    expect(mockRpc).toHaveBeenCalledWith(
      'convert_quote_to_order',
      expect.objectContaining({ p_quote_id: quote.id, p_expected_row_version: 9 }),
    );
  });

  it('keeps a saved line at its quoted cost through an edit, and shows today\'s cost beside it', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    // The product costs 8.00 today; the line was quoted at 6.00.
    const product = { ...fixture.product, current_cost: 8 };
    const item = { ...fixture.item, product };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? fixture.quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: fixture.quote.id, row_version: 8, item_ids: {} }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(fixture.quote.id);
    expect(await screen.findByText('today $8.00 · up')).toBeInTheDocument();
    const units = await screen.findByRole('spinbutton', { name: 'Units needed' });
    await waitFor(() => expect(units).toBeEnabled());
    fireEvent.change(units, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    const saveArgs = mockRpc.mock.calls.find(([name]) => name === 'save_quote')?.[1] as {
      p_sections: Array<{ items: Array<{ id: string | null; current_cost: number; profit: number; total_units_needed: number }> }>;
    };
    const savedLine = saveArgs.p_sections[0].items[0];
    expect(savedLine.id).toBe('item-1');
    expect(savedLine.total_units_needed).toBe(3);
    expect(savedLine.current_cost).toBe(6);
    expect(savedLine.profit).toBe(12);
  });

  it('prices a replacement row at today\'s cost, not the cost recorded for the row it replaced', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    // The product costs 8.00 today; row item-1 was quoted at 6.00.
    const product = { ...fixture.product, current_cost: 8 };
    const item = { ...fixture.item, product };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? fixture.quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [product]
                : [],
      error: null,
    }));
    // The save stores this line as a new row (as after switching its product away and back),
    // which the server stamps at today's cost.
    let saves = 0;
    mockRpc.mockImplementation((name: string, args?: unknown) => {
      if (name !== 'save_quote') return Promise.resolve({ data: null, error: null });
      const line = (args as { p_sections: Array<{ items: Array<{ client_key: string }> }> }).p_sections[0].items[0];
      saves += 1;
      return Promise.resolve({ data: { quote_id: fixture.quote.id, row_version: 7 + saves, item_ids: { [line.client_key]: 'item-9' } }, error: null });
    });
    type SaveArgs = { p_sections: Array<{ items: Array<{ id: string | null; current_cost: number }> }> };
    const saveCalls = () => mockRpc.mock.calls.filter(([name]) => name === 'save_quote').map(([, a]) => (a as SaveArgs).p_sections[0].items[0]);

    renderQuoteBuilder(fixture.quote.id);
    const units = await screen.findByRole('spinbutton', { name: 'Units needed' });
    await waitFor(() => expect(units).toBeEnabled());
    fireEvent.change(units, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save Draft/ })).toBeEnabled());

    fireEvent.change(units, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));
    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    expect(saveCalls()[1]).toMatchObject({ id: 'item-9', current_cost: 8 });
  });

  it('locks the quote and the Cancel button while Convert checks for a recent order', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, status: 'sent', created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => (table === 'orders'
      // The recent-order lookup never answers, so the test sees the page mid-lookup.
      ? buildPendingChain()
      : buildChain({
        data: table === 'quotes' ? quote
          : table === 'quote_sections' ? [fixture.section]
            : table === 'quote_items' ? [fixture.item]
              : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
                : table === 'products' ? [fixture.product]
                  : [],
        error: null,
      })));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null }
      : { data: null, error: null }));

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create Order ▾' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create Order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);

    // Convert works from the quote as it was clicked, so it cannot be edited or cancelled now.
    await waitFor(() => expect(screen.getByDisplayValue(quote.header_notes)).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(mockRpc).not.toHaveBeenCalledWith('convert_quote_to_order', expect.anything());
  });

  it('locks the quote while it converts to an order, then opens the order', async () => {
    const fixture = makeQuoteFixture('draft', 7);
    const quote = { ...fixture.quote, status: 'sent', created_at: new Date().toISOString() };
    mockFrom.mockImplementation((table: string) => buildChain({
      data: table === 'quotes' ? quote
        : table === 'quote_sections' ? [fixture.section]
          : table === 'quote_items' ? [fixture.item]
            : table === 'customers' ? [{ id: 'customer-1', farm_name: 'Farm', assigned_tier: 1, is_active: true }]
              : table === 'products' ? [fixture.product]
                : [],
      error: null,
    }));
    let releaseConvert!: () => void;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_quote') {
        return Promise.resolve({ data: { quote_id: quote.id, row_version: 8, item_ids: {} }, error: null });
      }
      if (name === 'convert_quote_to_order') {
        return new Promise((resolve) => {
          releaseConvert = () => resolve({ data: { status: 'converted', order_id: 'order-2', order_number: 'O-2', warnings: [] }, error: null });
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderQuoteBuilder(quote.id);
    const opener = await screen.findByRole('button', { name: 'Create Order ▾' });
    await waitFor(() => expect(opener).toBeEnabled());
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert whole booking' }));
    const dialog = await screen.findByRole('dialog', { name: /Convert to.*Order/ });
    const convertButton = within(dialog).getByRole('button', { name: 'Create Order' });
    await waitFor(() => expect(convertButton).toBeEnabled());
    fireEvent.click(convertButton);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('convert_quote_to_order', expect.anything()));

    // An edit made now would not be in the order, and the page leaves for it afterwards.
    expect(screen.getByDisplayValue(quote.header_notes)).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Planned Program/ })).toBeDisabled();
    releaseConvert();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/orders/order-2'));
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

    // Move to quote B; its load fails. Quote A's form - and this still-open dialog -
    // no longer come back under quote B's address: the page says quote B could not be
    // loaded (To-Do 10.5), so the stale reload cannot even be fired.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));
    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reload Quote/i })).not.toBeInTheDocument();
    await flushPendingWork();
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

    // The failed switch shows quote B's failed state, so the reload dialog that
    // names quote A is gone: the doomed reload has no button to start it.
    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    const readsAfterFailedSwitch = mockFrom.mock.calls.filter((c) => c[0] === 'quotes').length;
    expect(screen.queryByRole('button', { name: /Reload Quote/i })).not.toBeInTheDocument();
    await flushPendingWork();

    // No read of quote A is issued afterwards, so no serial is consumed.
    expect(mockFrom.mock.calls.filter((c) => c[0] === 'quotes').length)
      .toBe(readsAfterFailedSwitch);
    expect(screen.queryAllByText('Q-AAA-RELOADED')).toHaveLength(0);
  });

  it('a failed switch shows quote B could not be loaded, with no Save, Close or Revert over quote A', async () => {
    const quoteA = makeSwitchFixture('quote-a', 'Q-AAA-1');
    const quoteB = makeSwitchFixture('quote-b', 'Q-BBB-2');
    const router = renderQuoteSwitch([quoteA, quoteB], {}, { failSectionsFor: 'quote-b' });

    expect(await screen.findAllByText('Q-AAA-1')).not.toHaveLength(0);

    // Quote A's form used to stay under quote B's URL, where Save was refused but
    // Close / Revert (which send the URL's quote B) were still offered from quote A's
    // status. The page now says quote B could not be loaded instead.
    await goToQuote(router, 'quote-b');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Could not load the complete quote'),
    ));

    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    expect(screen.queryAllByText('Q-AAA-1')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Save Draft/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close|Revert/ })).not.toBeInTheDocument();
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('revert_quote_status', expect.anything());
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
    // The dialog clears its reason in an effect when it opens. Under React 19
    // that effect can still be queued when the box first appears, and a reason
    // typed before it runs is wiped — Approve stays disabled and the click sends
    // nothing (CI, PR #930). The dialog moves focus inside itself only after that
    // effect has run (Modal focuses from a frame its own open effect schedules, and
    // nothing in the dialog uses autoFocus), so type once it has. The enabled check
    // turns any wipe this misses into a plain failure rather than a short count.
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    fireEvent.change(reasonBox, { target: { value: 'matched a competitor quote' } });
    const approve = screen.getByRole('button', { name: /Approve and Retry/i });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
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

// To-Do 10.5: a saved quote whose reads fail says so; it never shows an empty quote
// (whose Save would replace the real lines) or prices at a factor of 1.
describe('QuoteBuilder load failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quoteIdempotencyState.reset();
    quoteIdempotencyHandles.clear();
    dirtyStates.length = 0;
    authState.role = 'admin';
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  // Serves a saved quote; `fail` names a table whose read fails, and how.
  function serveQuote(
    fixture: ReturnType<typeof makeQuoteFixture>,
    fail: { table?: string; mode?: 'error' | 'nodata' } = {},
  ) {
    mockFrom.mockImplementation((table: string) => {
      if (table === fail.table) {
        return buildChain(fail.mode === 'nodata'
          ? { data: null, error: null }
          : { data: null, error: { message: 'connection reset' } });
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
  }

  it.each([
    ['quotes', 'error'],
    ['quote_sections', 'nodata'],
    ['quote_items', 'nodata'],
  ] as const)('a first load whose %s read fails (%s) says the quote could not be loaded, with no Save, and Try again opens it', async (table, mode) => {
    const fixture = makeQuoteFixture('draft', 3);
    serveQuote(fixture, { table, mode });
    renderQuoteBuilder(fixture.quote.id);

    expect(await screen.findByText('This quote could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Draft/ })).not.toBeInTheDocument();

    serveQuote(fixture);
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /Save Draft/ })).toBeInTheDocument();
    expect(screen.queryByText('This quote could not be loaded')).not.toBeInTheDocument();
    expect(screen.getAllByText('Q-version-test').length).toBeGreaterThan(0);
  });

  it('a unit-conversion read that answers with no list counts as failed, so lines are not priced at a factor of 1', async () => {
    const fixture = makeQuoteFixture('draft', 3);
    serveQuote(fixture, { table: 'unit_conversions', mode: 'nodata' });
    renderQuoteBuilder(fixture.quote.id);

    await screen.findByRole('button', { name: /Save Draft/ });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load unit conversions.'));
  });

  it('a failed booking settlement says so instead of hiding the booked / drawn / remaining card', async () => {
    const fixture = makeQuoteFixture('sent', 3);
    serveQuote(fixture);
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_booking_settlement'
      ? { data: null, error: { message: 'connection reset' } }
      : { data: null, error: null }));
    renderQuoteBuilder(fixture.quote.id);

    expect(await screen.findByText('The booking settlement could not be loaded')).toBeInTheDocument();

    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_booking_settlement'
      ? { data: { found: true, booked_cents: 12345, drawn_cents: 0, remaining_cents: 12345, prepay_remaining_cents: 0, prepay_earmarked_cents: 0, prepay_applied_cents: 0, lines: [] }, error: null }
      : { data: null, error: null }));
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Booked')).toBeInTheDocument();
    expect(screen.queryByText('The booking settlement could not be loaded')).not.toBeInTheDocument();
  });
});
