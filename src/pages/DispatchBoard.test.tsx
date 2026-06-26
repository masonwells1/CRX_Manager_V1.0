/**
 * DispatchBoard.test.tsx — Unit tests for the dark field/tablet Dispatch view
 * (field-app parity #35).
 *
 * Verifies the redesigned dispatch board renders: the two nav groups
 * (Jobs: View Map/List · Dispatch: Dispatch Jobs/View Dispatched List), the
 * OPTIONS menu, and — from mocked job data — the row format (job# + name,
 * applied-of-total 'X of Y ac', a PENDING/ACTIVE badge, and 'Assigned To: <name>'
 * on a dispatched job with none on an unassigned one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DispatchBoard from './DispatchBoard';

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'test-user-id', full_name: 'Test Admin', role: 'admin' },
    session: { user: { id: 'test-user-id' } },
  }),
}));

vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem-key', resetKey: vi.fn() }),
}));
// Stable toast object — a fresh { toast } each render would change fetchData's
// identity every render and re-fire its effect forever (skeleton never clears).
const { stableToast } = vi.hoisted(() => ({ stableToast: { toast: () => {} } }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => stableToast }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

// Mock the mapbox-backed map components (unavailable in jsdom).
vi.mock('../components/map/CRXMap', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="crx-map">{children}</div>
  ),
}));
vi.mock('../components/map/FieldBoundaryLayer', () => ({
  default: () => <div data-testid="field-boundary-layer" />,
}));

// ─── Supabase mock ─────────────────────────────────────────────────────
// The dispatch board fires three reads in one Promise.all:
//   jobs (select → is → [eq…] → order → limit), applicators (select → in → eq →
//   order), recipes (select → is → order); then a best-effort fields read
//   (select → eq). We build a chainable thenable per table so any order of the
//   optional .eq() server filters still resolves.

interface MockJob {
  id: string;
  job_number: string;
  status: string;
  total_acres: number | null;
  applied_acres: number;
  applicator_id: string | null;
  recipe_id: string | null;
  job_date: string;
  customer: { farm_name: string };
  job_fields: { field_id: string; field: { id: string; field_name: string } }[];
}

// Test data lives in a hoisted block so the (hoisted) vi.mock factory can close
// over it without a temporal-dead-zone error.
const { JOBS, APPLICATORS } = vi.hoisted(() => {
  const JOBS: MockJob[] = [
    {
      id: 'job-active', job_number: 'FJOB-002', status: 'in_progress',
      total_acres: 40, applied_acres: 55, applicator_id: 'app-bob', recipe_id: null,
      job_date: '2026-06-11', customer: { farm_name: 'Filter Farm Bravo' },
      job_fields: [{ field_id: 'f1', field: { id: 'f1', field_name: 'East 40' } }],
    },
    {
      id: 'job-pending', job_number: 'PUSE-IP', status: 'in_progress',
      total_acres: 100, applied_acres: 40, applicator_id: null, recipe_id: null,
      job_date: '2026-06-26', customer: { farm_name: 'Acme Acres' },
      job_fields: [],
    },
  ];
  const APPLICATORS = [
    { id: 'app-bob', full_name: 'Bob Applicator', role: 'applicator', is_active: true },
  ];
  return { JOBS, APPLICATORS };
});

vi.mock('../lib/db', () => {
  // A chainable query stub where every method returns the SAME chain object and the
  // chain is thenable, so `await supabase.from(t).select().is().eq().order().limit()`
  // resolves to { data, error } regardless of how many optional filters were chained.
  // Mirrors the proven makeFromMock pattern in FieldApplicationInvoice.test.tsx.
  // Plain functions (NOT vi.fn) so vi.clearAllMocks() in beforeEach can't strip the
  // chain's implementations between tests — that leak made later tests see undefined
  // from .select()/.order() and hang on the loading skeleton.
  const makeChain = (data: unknown[]) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ['select', 'is', 'eq', 'in', 'gte', 'lte', 'or', 'order', 'limit']) {
      chain[m] = self;
    }
    chain.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data, error: null });
    return chain;
  };
  const dataForTable = (table: string): unknown[] => {
    if (table === 'jobs') return JOBS;
    if (table === 'profile_public_view') return APPLICATORS;
    if (table === 'blend_recipes') return [{ id: 'rec-1', name: 'Test Mix A' }];
    return []; // fields + anything else
  };
  return {
    supabase: {
      from: (table: string) => makeChain(dataForTable(table)),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    assertRpcResult: vi.fn(),
    hasRpcCode: () => false,
    RpcErrorCodes: { LICENSE_EXPIRED: 'LICENSE_EXPIRED' },
  };
});

// ─── Helpers ───────────────────────────────────────────────────────────

function renderDispatchBoard() {
  render(
    <MemoryRouter initialEntries={['/dispatch']}>
      <DispatchBoard />
    </MemoryRouter>,
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('DispatchBoard (dark field/tablet view)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the two nav groups: Jobs (View Map / View List) and Dispatch (Dispatch Jobs / View Dispatched List)', async () => {
    renderDispatchBoard();
    expect(await screen.findByText('View Map')).toBeInTheDocument();
    expect(screen.getByText('View List')).toBeInTheDocument();
    expect(screen.getByText('Dispatch Jobs')).toBeInTheDocument();
    expect(screen.getByText('View Dispatched List')).toBeInTheDocument();
    // The group headers ("Jobs"/"Dispatch" also appear in the rail title/section
    // heading, so assert at least one of each rather than a unique match).
    expect(screen.getAllByText('Jobs').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Dispatch').length).toBeGreaterThanOrEqual(1);
  });

  it('renders a job row with job number, applied-of-total acres, and a status badge', async () => {
    renderDispatchBoard();
    expect(await screen.findByText('FJOB-002')).toBeInTheDocument();
    // applied-of-total acres (55 applied of 40 total — a real over-applied job)
    expect(screen.getByText('55 of 40 ac')).toBeInTheDocument();
    expect(screen.getByText('40 of 100 ac')).toBeInTheDocument();
    // status badge: in_progress -> ACTIVE
    expect(screen.getAllByText('ACTIVE').length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'Assigned To: <name>' on a dispatched job and nothing on an unassigned one", async () => {
    renderDispatchBoard();
    // FJOB-002 is assigned to Bob Applicator
    expect(await screen.findByText('Assigned To:')).toBeInTheDocument();
    expect(screen.getByText('Bob Applicator')).toBeInTheDocument();
    // Exactly ONE Assigned-To label (PUSE-IP is unassigned → no label)
    expect(screen.getAllByText('Assigned To:')).toHaveLength(1);
  });

  it('exposes an OPTIONS menu with the five required entries', async () => {
    renderDispatchBoard();
    const optionsBtn = await screen.findByRole('button', { name: /options/i });
    fireEvent.click(optionsBtn);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Filter Jobs By Recipe')).toBeInTheDocument();
    expect(within(menu).getByText('More Search Options')).toBeInTheDocument();
    expect(within(menu).getByText(/Switch View/)).toBeInTheDocument();
    expect(within(menu).getByText('Add New Job')).toBeInTheDocument();
    expect(within(menu).getByText('Reload List')).toBeInTheDocument();
  });

  it('renders the map container when the Map view is selected', async () => {
    renderDispatchBoard();
    // Map is mounted (kept alive, hidden) — the test mock renders it unconditionally.
    expect(await screen.findByTestId('crx-map')).toBeInTheDocument();
    // Switching to map keeps the page mounted (no crash / re-render to empty).
    fireEvent.click(screen.getByText('View Map'));
    expect(screen.getByTestId('crx-map')).toBeInTheDocument();
  });
});
