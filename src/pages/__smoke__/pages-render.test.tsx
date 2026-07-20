/**
 * pages-render.test.tsx — render-smoke test for every page (prevention control P4).
 *
 * Background: Field Mode 2026-06-14 shipped a production runtime crash (F1) — a page
 * called a `Record` as if it were a function (TS2349). The internal review swarm and
 * the build gate both missed it; only Codex caught it, after it shipped. This test is
 * the deterministic floor: it inventories EVERY page in `src/pages/` and mounts the
 * ratcheted supported set with a universal
 * mocked Supabase client (every query resolves `{ data: [], error: null }`), a mocked
 * auth/toast/router context, and asserts the page renders without throwing. It catches
 * "calls a non-function", "reads x of undefined", bad hooks order, etc. — the F1 class.
 *
 * It auto-discovers pages via import.meta.glob, so a NEW page fails closed until it
 * mounts cleanly or is explicitly dispositioned with a reason. Unsupported pages are
 * a fixed-size backlog, so skips cannot silently grow.
 *
 * See docs/audits/2026-06-14-field-mode-error-retrospective-and-prevention-spec.md (P4)
 * and ...-gauntlet-vs-fieldmode-controls-reconciliation.md.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { Component, Suspense, type ReactNode } from 'react';

// ─── Universal mocks (hoisted so vi.mock factories can use them) ───────────
const H = vi.hoisted(() => {
  const QUERY_RESULT = { data: [] as unknown[], error: null, count: 0 };
  const SINGLE_RESULT = { data: null, error: null };

  // A recursive, chainable, awaitable Supabase query-builder stub. Any method
  // returns the same proxy (so .select().eq().order().limit()… all chain);
  // awaiting it resolves to { data: [], error: null }; .single()/.maybeSingle()
  // resolve to { data: null, error: null }.
  function makeBuilder(): unknown {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop: string | symbol) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve(QUERY_RESULT);
        }
        if (prop === 'single' || prop === 'maybeSingle' || prop === 'csv') {
          return () => Promise.resolve(SINGLE_RESULT);
        }
        if (prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
        return () => proxy;
      },
      apply() {
        return proxy;
      },
    });
    return proxy;
  }

  const supabaseStub = {
    from: () => makeBuilder(),
    rpc: () => Promise.resolve({ data: [], error: null }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'u' } }, error: null }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: () => Promise.resolve({ error: null }),
    },
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: { path: '' }, error: null }),
        download: () => Promise.resolve({ data: null, error: null }),
        remove: () => Promise.resolve({ data: [], error: null }),
        list: () => Promise.resolve({ data: [], error: null }),
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
        createSignedUrl: () => Promise.resolve({ data: { signedUrl: '' }, error: null }),
      }),
    },
    channel: () => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = () => ch;
      ch.unsubscribe = () => {};
      return ch;
    },
    removeChannel: () => {},
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  };

  // Sentry stub: any method is a no-op fn.
  const sentryStub = new Proxy({}, { get: () => () => undefined });

  return { supabaseStub, sentryStub };
});

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    supabase: H.supabaseStub,
    checkMutationResult: vi.fn(),
    assertRpcResult: (d: unknown) => d,
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u', full_name: 'Smoke Admin', role: 'admin', is_active: true },
    session: { user: { id: 'u' } },
    user: { id: 'u' },
    loading: false,
    signOut: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

// The real useToast returns a stable `toast` function (context value memoized;
// addToast is useCallback-stable). This mock must honor that contract: pages
// put `toast` in effect deps, and the previous `() => ({ toast: vi.fn() })`
// stub minted a new identity per render, turning any load-then-toast path into
// an infinite render loop (reproducible 4GB worker OOM, 2026-07-16). The loop
// was a harness artifact, not a production behavior — Toast.loopguard.test.tsx
// pins the real provider.
const STABLE_TOAST_CONTEXT = { toast: vi.fn() };
vi.mock('../../components/ui/Toast', () => ({
  useToast: () => STABLE_TOAST_CONTEXT,
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

// Keep all of react-router real EXCEPT useBlocker — under test it demands a
// fully-initialized data router; the real app's blocker is inert until there
// are unsaved edits anyway, so a no-op "unblocked" blocker is faithful.
// NOTE: useUnsavedChanges imports useBlocker from 'react-router' (the v7 core
// package), not 'react-router-dom' — so the mock must target 'react-router'.
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useBlocker: () => ({ state: 'unblocked', proceed: () => {}, reset: () => {} }) };
});

vi.mock('../../lib/sentry', () => ({ Sentry: H.sentryStub }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));

// Map + native deps that don't work under jsdom.
vi.mock('../../components/map/CRXMap', () => ({
  default: ({ children }: { children?: ReactNode }) => <div data-testid="crx-map">{children}</div>,
}));
vi.mock('../../components/map/FieldBoundaryLayer', () => ({ default: () => <div /> }));
vi.mock('mapbox-gl', () => ({ default: {}, Map: class {}, Marker: class {}, Popup: class {} }));
// @fullcalendar + react-map-gl init real WebGL/DOM internals that hard-crash the
// jsdom worker. Stub them so calendar/map pages mount.
vi.mock('@fullcalendar/react', () => ({ default: () => <div data-testid="fullcalendar" /> }));
vi.mock('@fullcalendar/daygrid', () => ({ default: {} }));
vi.mock('@fullcalendar/interaction', () => ({ default: {} }));
vi.mock('react-map-gl/mapbox', () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'useMap') return () => ({ current: undefined });
    if (prop === '__esModule') return true;
    if (typeof prop === 'symbol') return undefined;
    return ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  },
}));
vi.mock('signature_pad', () => ({ default: class { on() {} off() {} clear() {} isEmpty() { return true; } toDataURL() { return ''; } } }));
// pdfjs-dist crashes during module evaluation under jsdom (no real DOM/worker).
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.resolve({ numPages: 0, getPage: () => Promise.resolve({}) }) }),
  version: '0',
}));
// documentOCR imports pdfjs-dist + its ?url worker bundle at module scope, which
// crashes under jsdom. Mock the module so consumers (BlendTicketDetail, etc.) load.
vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn().mockResolvedValue({ success: false, error: 'mock' }),
  isOCRSupported: () => false,
  isCSVFile: () => false,
}));

// ─── Error-capturing boundary (render crashes surface as a captured error) ──
class CaptureBoundary extends Component<{ children: ReactNode; onError: (e: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

// ─── Discover every page module ────────────────────────────────────────────
const modules = import.meta.glob('../*.tsx');
const pageEntries = Object.entries(modules)
  .filter(([p]) => !p.includes('.test.'))
  .map(([p, loader]) => [p.replace('../', '').replace('.tsx', ''), loader] as const)
  .sort(([a], [b]) => a.localeCompare(b));

// COVERED = pages confirmed to mount cleanly under the universal empty stub.
// This is an ALLOWLIST (not "everything minus a skip-list") on purpose: a handful
// of pages either pull native libs that HARD-CRASH the jsdom worker — which aborts
// the WHOLE suite, not just their own test (e.g. @fullcalendar in Jobs/JobDetail) —
// or fire async timers that crash the worker between tests. Running only the
// allowlist keeps this gate green + stable. Pages NOT in COVERED are reported as
// skipped (visible gaps), with the reasons below; GROW this list as pages are
// verified / their native deps get mocked.
//
const COVERED = new Set<string>([
  'ARaging',
  'AccountsPayable',
  'ApplicationRecords',
  'ApplicationServiceDetail',
  'ApplicationServices',
  'BlendRecipes',
  'BlendTickets',
  'BrandVsGeneric',
  'CallLists',
  'CommissionPayments',
  'Compliance',
  'CropPrograms',
  'CustomerDetail',
  'CustomerTransactionReview',
  'Customers',
  'CycleCounts',
  'Dashboard',
  'Deliveries',
  'DeliveryDetail',
  'DeliveryRemainders',
  'DispatchBoard',
  'FieldAppSplitInvoiceEditor',
  'FieldApplicationInvoice',
  'FieldSetup',
  'Fields',
  'FinancialDashboard',
  'GettingStarted',
  'Integrity',
  'InventoryPage',
  'InvoiceDetail',
  'Invoices',
  'OfflineWorkReview',
  'Orders',
  'Quotes',
]);

/**
 * Explicit, ratcheted backlog. A new page is NOT allowed to become an implicit
 * skip: the inventory test below fails until the page either mounts under this
 * harness or is added here with a concrete reason. Keep reasons honest and move
 * pages to COVERED as soon as their fixture/native dependency is supported.
 */
const UNCOVERED_WITH_REASON: Record<string, string> = {
  AccountsReceivable: 'not yet verified with the universal empty-data fixture',
  BlendTicketDetail: 'requires a populated blend-ticket fixture',
  DesignPreview: 'design-only page needs a purpose-built DOM fixture',
  FieldDashboard: 'requires populated field and map fixtures',
  FieldInvoices: 'not yet verified with the universal empty-data fixture',
  FieldRoute: 'requires a map and route fixture',
  FieldStop: 'requires a populated route-stop fixture',
  FieldView: 'requires populated field and map fixtures',
  JobDetail: 'requires populated job data and full calendar fixtures',
  Jobs: 'requires full calendar fixtures',
  LabelDataQuality: 'not yet verified with the universal empty-data fixture',
  LabelReview: 'requires a populated label fixture',
  LotTrace: 'not yet verified with the universal empty-data fixture',
  MonthEndClose: 'requires populated accounting-period fixtures',
  NewDelivery: 'requires populated customer and order fixtures',
  NewOrder: 'requires populated customer and inventory fixtures',
  NewPurchaseOrder: 'requires populated vendor and inventory fixtures',
  NewVendorBill: 'requires populated vendor fixtures',
  Notifications: 'not yet verified with the universal empty-data fixture',
  OfficeCockpit: 'not yet verified with the universal empty-data fixture',
  OrderDetail: 'requires a populated order fixture',
  PaymentAllocation: 'requires populated invoice and payment fixtures',
  PaymentHistory: 'not yet verified with the universal empty-data fixture',
  Prepay: 'requires populated customer and payment fixtures',
  ProductDetail: 'requires a populated product fixture',
  Products: 'not yet verified with the universal empty-data fixture',
  ProgramTracker: 'not yet verified with the universal empty-data fixture',
  PurchaseOrderDetail: 'requires a populated purchase-order fixture',
  PurchaseOrders: 'not yet verified with the universal empty-data fixture',
  QuoteBuilder: 'requires populated customer and product fixtures',
  Rebates: 'not yet verified with the universal empty-data fixture',
  Receiving: 'requires populated purchase-order fixtures',
  Reports: 'not yet verified with the universal empty-data fixture',
  Returns: 'requires populated order and inventory fixtures',
  SalesReports: 'not yet verified with the universal empty-data fixture',
  SettingsPage: 'not yet verified with the universal empty-data fixture',
  SupplierPricing: 'covered by dedicated supplier-pricing fixtures while its database migration remains parked',
  TeamBoard: 'not yet verified with the universal empty-data fixture',
  ToShip: 'not yet verified with the universal empty-data fixture',
  VehicleDetail: 'requires a populated vehicle fixture',
  Vehicles: 'not yet verified with the universal empty-data fixture',
  VendorBillDetail: 'requires a populated vendor-bill fixture',
  VendorBills: 'not yet verified with the universal empty-data fixture',
  Vendors: 'not yet verified with the universal empty-data fixture',
  WatchdogExceptions: 'not yet verified with the universal empty-data fixture',
};

function pickComponent(mod: Record<string, unknown>): React.ComponentType | null {
  if (typeof mod.default === 'function') return mod.default as React.ComponentType;
  // Named-export pages (e.g. BlendTickets, BlendTicketDetail).
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === 'function' && /^[A-Z]/.test(k)) return mod[k] as React.ComponentType;
  }
  return null;
}

afterEach(() => cleanup());

describe('pages render-smoke (P4 — every page must mount without crashing)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has an explicit disposition for every discovered page (new pages fail closed)', () => {
    const discovered = pageEntries.map(([name]) => name).sort();
    const dispositioned = [...COVERED, ...Object.keys(UNCOVERED_WITH_REASON)].sort();
    const overlap = [...COVERED].filter((name) => name in UNCOVERED_WITH_REASON);

    expect(overlap, 'a page cannot be both covered and explicitly uncovered').toEqual([]);
    expect(dispositioned, 'new/deleted pages must update the smoke inventory').toEqual(discovered);
    expect(Object.values(UNCOVERED_WITH_REASON).every((reason) => reason.trim().length >= 20)).toBe(true);
    // Ratchet: adding another skip is a deliberate red change, not a silent expansion.
    expect(Object.keys(UNCOVERED_WITH_REASON)).toHaveLength(45);
  });

  for (const [name, loader] of pageEntries) {
    const testFn = COVERED.has(name) ? it : it.skip;
    const backlogSuffix = COVERED.has(name) ? '' : ` [backlog: ${UNCOVERED_WITH_REASON[name] ?? 'UNCLASSIFIED'}]`;
    testFn(`${name} mounts without throwing${backlogSuffix}`, async () => {
      const mod = (await loader()) as Record<string, unknown>;
      const Page = pickComponent(mod);
      expect(Page, `${name} has no component export`).toBeTruthy();
      const Comp = Page as React.ComponentType;

      let captured: Error | null = null;
      const asyncErrors: Error[] = [];
      const onWindowError = (event: ErrorEvent) => {
        asyncErrors.push(event.error instanceof Error ? event.error : new Error(event.message));
      };
      const onUnhandledRejection = (event: PromiseRejectionEvent) => {
        asyncErrors.push(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
      };
      window.addEventListener('error', onWindowError);
      window.addEventListener('unhandledrejection', onUnhandledRejection);
      // A DATA router (createMemoryRouter) — not the component <MemoryRouter> —
      // because several pages use useBlocker (unsaved-changes guard), which the
      // real app supports via createBrowserRouter. The :id param feeds detail
      // pages; the universal supabase stub returns empty data for every query.
      const router = createMemoryRouter(
        [
          {
            path: '/smoke/:id',
            element: (
              <CaptureBoundary onError={(e) => (captured = e)}>
                <Suspense fallback={null}>
                  <Comp />
                </Suspense>
              </CaptureBoundary>
            ),
          },
        ],
        { initialEntries: ['/smoke/test-id'] },
      );
      try {
        render(<RouterProvider router={router} />);

        // Observe both the immediate effect queue and follow-up promise work. We
        // deliberately do not preventDefault or install a process-wide rejection
        // listener: unhandled async failures remain visible to Vitest as failures.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (captured) {
          throw new Error(`${name} crashed on mount: ${(captured as Error).message}`);
        }
        if (asyncErrors.length > 0) {
          throw new Error(`${name} failed asynchronously on mount: ${asyncErrors[0].message}`);
        }
      } finally {
        window.removeEventListener('error', onWindowError);
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
      }
    }, 10000);
  }
});
