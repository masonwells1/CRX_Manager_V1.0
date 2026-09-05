/**
 * JobDetail.staleLoad.test.tsx — cross-record stale-load contamination.
 *
 * The route `jobs/:id` in src/App.tsx carries NO `key` prop, so changing only the id
 * does NOT remount JobDetail. The previous job's in-flight loads therefore keep running
 * after the operator has clicked into a different job, and their setters land on the form
 * that is now showing THAT job. A save afterwards targets the CURRENT route id while the
 * form holds the OLD record's values — one job's data written onto another's row.
 *
 * Found by the exact-SHA gpt-5.6-sol review of PR #603 head 5dad64e2 (2026-09-05), rated
 * HIGH, pre-existing on main. Two sequences are covered here, one per open path:
 *
 *   1. /jobs/job-a -> /jobs/job-b with A's `jobs` read resolving LAST. Unguarded, fetchJob
 *      installs A's job number, status, dates and chemicals over B's loaded form.
 *   2. /jobs/new -> /jobs/job-b with the new-job run's lookups resolving LAST. Unguarded,
 *      the cancelled run continues past `await loadLookups()` into the `else` branch and
 *      clears B's grower-share names / vessel / tank capacity, then overwrites B's job
 *      number with the freshly minted next_job_number.
 *
 * Both gates are DEFERRED PROMISES, not timers: the ordering then holds on any machine at
 * any speed, rather than silently degrading into a test that proves nothing when the box
 * is slow. Confirmed 2026-09-05 that both tests FAIL against the unguarded source with the
 * production symptom (the heading shows the wrong job) and pass with the guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockNavigate, dirtyStates } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  // Every isDirty value the page has handed to useUnsavedChanges. The dirty engine
  // has no dedicated DOM of its own, so this is how the third test observes it.
  dirtyStates: [] as boolean[],
}));

const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
  'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
  'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
  'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];

function chainShell(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of CHAIN_METHODS) self[m] = method;
  return self;
}

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self = chainShell();
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

/**
 * A chain that does not answer until `gate` resolves. Resolution is LAZY (settled at await
 * time, not at construction) so the query can be issued long before the test releases it.
 */
function buildGatedChain(
  result: { data: unknown; error: unknown },
  gate: Promise<void>,
): Record<string, unknown> {
  const self = chainShell();
  const settle = () => gate.then(() => result);
  self.then = (onF: unknown, onR: unknown) => settle().then(onF as never, onR as never);
  self.catch = (onR: unknown) => settle().catch(onR as never);
  self.finally = (onF: unknown) => settle().finally(onF as never);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc, storage: { from: vi.fn() } },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: (dirty: boolean) => {
    dirtyStates.push(dirty);
    return { state: 'unblocked', reset: vi.fn(), proceed: vi.fn() };
  },
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: async ({ action, setLoading }: {
    action: () => Promise<void>; setLoading?: (v: boolean) => void;
  }) => { setLoading?.(true); try { await action(); } finally { setLoading?.(false); } },
}));
vi.mock('../lib/dateUtils', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, localToday: () => '2026-08-19' };
});

import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import JobDetail from './JobDetail';

/**
 * Two jobs whose every visible value differs, so a contaminated form is unambiguous:
 * the heading renders `jobNumber` for a saved job (JobDetail.tsx, the h1).
 */
function makeJob(overrides: Record<string, unknown>) {
  return {
    id: 'job-x',
    job_number: 'J-UNSET',
    job_date: '2026-08-19',
    customer_id: 'cust-1',
    applicator_id: null,
    status: 'scheduled',
    customer: { farm_name: 'Farm Alpha' },
    vehicle: null,
    quote: null,
    quote_section: null,
    job_fields: [],
    job_chemicals: [],
    job_field_shares: [],
    applied_info: null,
    ...overrides,
  };
}

const JOB_A = makeJob({ id: 'job-a', job_number: 'J-AAAA-1001', job_date: '2026-03-01', notes: 'A notes' });
const JOB_B = makeJob({ id: 'job-b', job_number: 'J-BBBB-2002', job_date: '2026-07-15', notes: 'B notes' });

/** Mounts the real page under a router whose location the test can drive. */
function mountAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/jobs/:id', element: <JobDetail /> }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function deferred() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = () => resolve(); });
  return { promise, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  dirtyStates.length = 0;
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('JobDetail cross-record stale-load guard', () => {
  it('does not let job A\'s late-resolving fetch overwrite job B\'s loaded form', async () => {
    // Job A's `jobs` read is held open; job B's answers immediately. That makes A the
    // LAST to resolve — the exact ordering that installs A's record over B's.
    const gateA = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        return jobsCalls === 1
          ? buildGatedChain({ data: JOB_A, error: null }, gateA.promise)
          : buildChain({ data: JOB_B, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    const router = mountAt('/jobs/job-a');
    // A is still in flight, so the page is still on its loading skeleton.
    await waitFor(() => expect(jobsCalls).toBe(1));
    expect(screen.queryByRole('heading', { name: 'J-AAAA-1001' })).toBeNull();

    // The operator clicks into job B. No remount — the route has no `key`.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });

    // Now A finally answers. Its setters must install nothing.
    await act(async () => { gateA.release(); await gateA.promise; });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'J-BBBB-2002' })).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: 'J-AAAA-1001' })).toBeNull();
    // A superseded run must not fire job A's "Job not found" redirect either.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not let the cancelled /jobs/new run clear or renumber job B\'s form', async () => {
    // The new-job run's lookups are held open, so it is still sitting on
    // `await loadLookups()` when the operator moves to job B. Unguarded, it then runs
    // the `else` branch against B's form and stamps B with a brand-new job number.
    const gateLookups = deferred();
    let customerCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') {
        customerCalls += 1;
        return customerCalls === 1
          ? buildGatedChain({ data: [], error: null }, gateLookups.promise)
          : buildChain({ data: [], error: null });
      }
      if (table === 'jobs') return buildChain({ data: JOB_B, error: null });
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((fn: string) => (fn === 'next_job_number'
      ? Promise.resolve({ data: 'J-NEWNEW-9999', error: null })
      : Promise.resolve({ data: null, error: null })));

    const router = mountAt('/jobs/new');
    await waitFor(() => expect(customerCalls).toBe(1));

    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });

    // The stale new-job run's lookups land last.
    await act(async () => { gateLookups.release(); await gateLookups.promise; });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'J-BBBB-2002' })).toBeTruthy();
    });
    // The cancelled run must never have reached its next_job_number mint.
    expect(mockRpc).not.toHaveBeenCalledWith('next_job_number');
    expect(screen.queryByRole('heading', { name: /J-NEWNEW-9999/ })).toBeNull();
  });

  /**
   * The reverse direction, and the two invariants the guard itself must not break.
   *
   * fetchJob raises baselineSettleGuardRef SYNCHRONOUSLY at entry and only lowers it on
   * its own completion paths, and `loading` is seeded once at mount (useState(!isNew)).
   * A bailed run therefore leaves BOTH latched — and the /jobs/new branch never calls
   * fetchJob, so nothing else clears them. Unowned, that is a stuck loading skeleton and
   * a dirty engine frozen at false, i.e. an unsaved-changes prompt that silently stops
   * protecting the new job. The mount effect resets both as it takes its ticket.
   */
  it('leaves /jobs/new usable and dirty-tracked after abandoning job A mid-load', async () => {
    const gateA = deferred();
    mockFrom.mockImplementation((table: string) => (table === 'jobs'
      ? buildGatedChain({ data: JOB_A, error: null }, gateA.promise)
      : buildChain({ data: [], error: null })));
    mockRpc.mockImplementation((fn: string) => (fn === 'next_job_number'
      ? Promise.resolve({ data: 'J-NEWNEW-9999', error: null })
      : Promise.resolve({ data: null, error: null })));

    const router = mountAt('/jobs/job-a');
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('jobs'));

    // The operator gives up on job A and starts a new job instead.
    await act(async () => { await router.navigate('/jobs/new'); });
    await act(async () => { gateA.release(); await gateA.promise; });

    // The skeleton must be gone and the new job's own number minted — not A's.
    await screen.findByRole('heading', { name: /J-NEWNEW-9999/ });
    expect(screen.queryByRole('heading', { name: 'J-AAAA-1001' })).toBeNull();

    // And the dirty engine must still be live: editing the form has to register.
    const jobDate = screen.getByLabelText(/Job Date/) as HTMLInputElement;
    expect(dirtyStates.some((d) => d === false)).toBe(true);
    await act(async () => { fireEvent.change(jobDate, { target: { value: '2026-10-02' } }); });
    await waitFor(() => expect(dirtyStates.some((d) => d === true)).toBe(true));
  });
});
