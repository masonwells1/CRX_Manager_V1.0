/**
 * JobDetail.staleLoad.test.tsx — cross-record stale-load contamination.
 *
 * ORIGINAL DEFECT: `jobs/:id` carried NO `key` prop, so changing only the id did NOT
 * remount JobDetail. The previous job's in-flight loads kept running after the operator
 * clicked into a different job, and their setters landed on the form now showing THAT job.
 * A save afterwards targeted the CURRENT route id while the form held the OLD record's
 * values — one job's data written onto another's row.
 *
 * IN PRODUCTION THE ROUTE IS NOW KEYED: `JobDetailRoute` renders `<JobDetail key={id} />`,
 * so a record change remounts. These tests mount JobDetail DIRECTLY and DELIBERATELY
 * WITHOUT that key, so they keep exercising the in-component guards the keyed route makes
 * redundant — that is what keeps them honest if the key is ever removed.
 * `JobDetailRoute.test.tsx` pins the key itself.
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

const { mockFrom, mockRpc, mockToast, mockNavigate, mockNotifyCreditLimit, dirtyStates } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  // The DURABLE half of the credit warning: notifyCreditLimitExceeded -> notifyAdmins writes
  // a notification row. A toast can be missed; this row is the record that the limit was
  // breached, so it is what the CRX-ENTITY-003 test actually asserts on.
  mockNotifyCreditLimit: vi.fn(),
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

// Spread the real module first: JobDetail imports hasRpcCode and RpcErrorCodes from here and
// uses them in its RPC error branches (the LICENSE_EXPIRED catch in handleStart, among
// others). A factory that omits them passes today only because no test in this file reaches
// those branches — the next one that does would fail on the mock, not on the behaviour.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await (importOriginal() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    supabase: { from: mockFrom, rpc: mockRpc, storage: { from: vi.fn() } },
    checkMutationResult: vi.fn(),
    assertRpcResult: vi.fn((d) => d),
    sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  };
});
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
// Spread the real module: JobDetail imports a dozen notify* helpers from here. Only the
// credit-limit one is replaced, so the rest keep their real behaviour.
vi.mock('../lib/notificationTriggers', async (importOriginal) => {
  const actual = await (importOriginal() as Promise<Record<string, unknown>>);
  return { ...actual, notifyCreditLimitExceeded: mockNotifyCreditLimit };
});
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
// Two loads of the SAME job, distinguishable only by which call fetched them.
const JOB_A_STALE = makeJob({ id: 'job-a', job_number: 'J-AAAA-STALE', job_date: '2026-03-01' });
const JOB_A_FRESH = makeJob({ id: 'job-a', job_number: 'J-AAAA-FRESH', job_date: '2026-04-02' });
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

    // The operator clicks into job B. No remount here: this file mounts JobDetail directly,
    // without the route's key, on purpose — see the header.
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

  /**
   * The case that proves the guard is gating the CALL and not the RECORD.
   *
   * The three tests above all switch between DIFFERENT jobs, so every one of them would
   * still pass against an `if (loadedId !== routeId) return` guard — which is exactly the
   * broken shape this bug class keeps attracting. Reopening the SAME job twice produces two
   * in-flight calls whose record ids are EQUAL: an id comparison passes for both and the
   * page adopts the older response anyway. Only call order separates them here, so this is
   * the test that can tell a real guard from one that reads as present but cannot fire.
   *
   * Mutation-checked 2026-09-05, against the id-only guard in its STRONGEST form — the
   * loaded record's id compared to a ref updated synchronously on route change, i.e. two
   * genuinely independent operands. That guard leaves tests 1-3 green and reddens ONLY
   * this one, which is the whole reason this case has to exist.
   *
   * (The weaker variant, comparing against `id` from fetchJob's own closure, reddens three
   * of the four — a superseded run closes over the OLD id, so it compares a stale value
   * against itself and can never fire. Two operands, one stale source, is a tautology.)
   */
  it('adopts the newest load when the SAME job is reopened and the first call lands last', async () => {
    const staleA = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        if (jobsCalls === 1) return buildGatedChain({ data: JOB_A_STALE, error: null }, staleA.promise);
        if (jobsCalls === 2) return buildChain({ data: JOB_B, error: null });
        return buildChain({ data: JOB_A_FRESH, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    const router = mountAt('/jobs/job-a');
    await waitFor(() => expect(jobsCalls).toBe(1));

    // Away and back to the SAME job. Both in-flight calls carry id 'job-a'.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });
    await act(async () => { await router.navigate('/jobs/job-a'); });
    await screen.findByRole('heading', { name: 'J-AAAA-FRESH' });

    // The FIRST call for job A finally answers, after the second one already landed.
    await act(async () => { staleA.release(); await staleA.promise; });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'J-AAAA-FRESH' })).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: 'J-AAAA-STALE' })).toBeNull();
  });

  /**
   * The case the ticket ALONE cannot catch, and the reason the guard has a second half.
   *
   * `handleStart` awaits `rpc('start_job', { p_job_id: id })` and then calls `fetchJob()`
   * from the closure of the render it started on. That call is issued AFTER the route has
   * already changed, so it reads the CURRENT ticket and mints it for the OLD job — a
   * ticket check alone would certify precisely the write it exists to reject. The same
   * shape sits in the save path and in `handleComplete`.
   *
   * Only the route is an independent witness to which job is on screen, which is why the
   * second half compares the id a fetch was STARTED for against `routeIdRef`.
   *
   * Mutation-checked 2026-09-05: dropping the `routeIdRef` clause reddens ONLY this test;
   * dropping the ticket clause reddens ONLY the A -> B -> A test above. Each half is
   * load-bearing on its own — neither covers for the other.
   */
  it('does not let a post-RPC refetch from a stale handler closure reload the old job', async () => {
    const startGate = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        if (jobsCalls === 1) return buildChain({ data: JOB_A, error: null });
        if (jobsCalls === 2) return buildChain({ data: JOB_B, error: null });
        return buildChain({ data: JOB_A, error: null }); // the stale handler's refetch
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((fn: string) => (fn === 'start_job'
      ? startGate.promise.then(() => ({ data: { ok: true }, error: null }))
      : Promise.resolve({ data: null, error: null })));

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });
    // Start Job is gated on a clean form, so wait for the baseline to be adopted.
    await waitFor(() => expect(dirtyStates.some((d) => d === false)).toBe(true));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start Job/ })); });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('start_job', expect.anything()));

    // The operator navigates away while start_job is still in flight.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });

    // The RPC lands; the handler resumes and refetches job A from its stale closure.
    await act(async () => { startGate.release(); await startGate.promise; });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'J-BBBB-2002' })).toBeTruthy();
    });
    expect(screen.queryByRole('heading', { name: 'J-AAAA-1001' })).toBeNull();

    // The heading alone is NOT enough. fetchJob's first two statements are synchronous:
    // it nulls baselineRef and raises baselineSettleGuardRef before its own await. A
    // stale call that only bails LATER has already disarmed job B's dirty engine on its
    // way in, and nothing lowers the guard again — B keeps rendering correctly while
    // isDirty is frozen at false. That is the silent half of the bug: the unsaved-changes
    // prompt stops firing and the "save before Start/Complete" gates wave edits through.
    // So edit B here and require the page to notice. (Codex CRX-SEC-001.)
    const editedFrom = dirtyStates.length;
    const jobDate = screen.getByLabelText(/Job Date/) as HTMLInputElement;
    await act(async () => { fireEvent.change(jobDate, { target: { value: '2026-11-03' } }); });
    await waitFor(() => {
      expect(dirtyStates.slice(editedFrom).some((d) => d === true)).toBe(true);
    });
  });

  /**
   * The guard above only decides which RESPONSE may be installed. It says nothing about
   * what the operator can do with the form in the meantime — and that window was wide
   * open. `loading` is seeded once, at mount (useState(!isNew)), so on a saved-job ->
   * saved-job navigation it stayed false for the whole load: the page kept rendering the
   * PREVIOUS job's values in a live, editable form with Save enabled, while `id` — which
   * handleSave writes to — had already flipped to the new job. Saving in that window
   * wrote one job's data onto another job's row with no race required at all, just a
   * fast click. Reported by the Codex GitHub App on 170c2d91d.
   */
  it('hides the previous job\'s editable form while the next job is still loading', async () => {
    const gateB = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        if (jobsCalls === 1) return buildChain({ data: JOB_A, error: null });
        return buildGatedChain({ data: JOB_B, error: null }, gateB.promise);
      }
      return buildChain({ data: [], error: null });
    });

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });
    // Job A is fully loaded and editable — this is the state the operator leaves.
    expect(screen.getByRole('button', { name: /Save Changes/ })).toBeTruthy();

    await act(async () => { await router.navigate('/jobs/job-b'); });

    // Job B has NOT answered yet. Nothing of job A may still be on screen or reachable:
    // a Save here would target job B while every field still holds job A's value.
    expect(screen.queryByRole('heading', { name: 'J-AAAA-1001' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save Changes/ })).toBeNull();
    expect(screen.queryByLabelText(/Job Date/)).toBeNull();

    await act(async () => { gateB.release(); await gateB.promise; });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });
  });

  /**
   * Two refetches on the SAME route, which the route-id operand cannot separate and the
   * ticket could not either while fetchJob merely READ the generation without claiming
   * one. Every post-save / post-start / post-cancel refetch then shared a single ticket,
   * so none superseded any other and an older response could land on top of a newer one.
   *
   * Reachable because each handler guards only ITSELF with an in-flight flag (`starting`,
   * `cancelling`, `saving`). The same handler cannot double-fire, but two DIFFERENT
   * handlers can overlap — Start Job's refetch still open when Cancel Job's begins.
   * (Codex round 2, finding 2.)
   */
  it('lets the newest same-route refetch win when two handlers overlap', async () => {
    const staleGate = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        if (jobsCalls === 1) return buildChain({ data: JOB_A, error: null });
        // Start Job's refetch — held open, and carrying the OLDER answer.
        if (jobsCalls === 2) return buildGatedChain({ data: JOB_A_STALE, error: null }, staleGate.promise);
        // #3 is handleCancelJob's own `.update()` on `jobs`, not a read.
        if (jobsCalls === 3) return buildChain({ data: [JOB_A], error: null });
        // Cancel Job's refetch — answers immediately, and is the NEWER answer.
        return buildChain({ data: JOB_A_FRESH, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });

    mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });
    // Start Job is gated on a clean form, so wait for the baseline to be adopted.
    await waitFor(() => expect(dirtyStates.some((d) => d === false)).toBe(true));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start Job/ })); });
    await waitFor(() => expect(jobsCalls).toBe(2));

    // Cancel Job carries its own flag, so it fires while Start's refetch is still open.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Cancel Job/ })); });
    const confirmButtons = screen.getAllByRole('button', { name: /Cancel Job/ });
    await act(async () => { fireEvent.click(confirmButtons[confirmButtons.length - 1]); });
    await waitFor(() => expect(jobsCalls).toBe(4));
    await screen.findByRole('heading', { name: 'J-AAAA-FRESH' });

    // The OLDER refetch lands last. It must install nothing.
    await act(async () => { staleGate.release(); await staleGate.promise; });
    expect(screen.queryByRole('heading', { name: 'J-AAAA-STALE' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'J-AAAA-FRESH' })).toBeTruthy();
  });

  /**
   * The handler-level half of the bug, which every test above misses.
   *
   * Those tests all police which RESPONSE may be installed. But the mutation handlers
   * write UI/form state BEFORE fetchJob is ever called — `setIsDirty(false)` at the save,
   * complete, cancel and transfer sites. A stale handler resuming after the operator moved
   * on marks the job now on screen clean; fetchJob then correctly rejects the reload, but
   * nothing restores the dirty flag, because the dirty effect only recomputes on
   * [formSnapshot, loading, baselineSettleTick] and none of those changed.
   *
   * The consequence is silent data loss: B's unsaved edits stop being protected, so
   * navigating away discards them with no prompt. The earlier stale-handler test could not
   * catch it because it uses Start Job, which is the one lifecycle handler that does NOT
   * clear isDirty. (Codex round 4.)
   */
  it('keeps job B dirty-protected when job A\'s cancel completes after the move', async () => {
    const cancelGate = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        if (jobsCalls === 1) return buildChain({ data: JOB_A, error: null });
        // #2 is A's cancel `.update()` — held open across the navigation.
        if (jobsCalls === 2) return buildGatedChain({ data: [JOB_A], error: null }, cancelGate.promise);
        return buildChain({ data: JOB_B, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });
    await waitFor(() => expect(dirtyStates.some((d) => d === false)).toBe(true));

    // Begin cancelling job A; its update is still in flight.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Cancel Job/ })); });
    const confirmButtons = screen.getAllByRole('button', { name: /Cancel Job/ });
    await act(async () => { fireEvent.click(confirmButtons[confirmButtons.length - 1]); });
    await waitFor(() => expect(jobsCalls).toBe(2));

    // The operator moves to job B and starts editing it.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });
    const jobDate = screen.getByLabelText(/Job Date/) as HTMLInputElement;
    await act(async () => { fireEvent.change(jobDate, { target: { value: '2026-12-24' } }); });
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(true));

    // NOW A's cancel lands. B must still be protected: B's edit is unsaved, and the only
    // thing standing between it and a silent discard is this flag.
    const resumedAt = dirtyStates.length;
    await act(async () => { cancelGate.release(); await cancelGate.promise; });

    expect(dirtyStates.slice(resumedAt).every((d) => d === true)).toBe(true);
    expect(dirtyStates[dirtyStates.length - 1]).toBe(true);
    // And B's own form is untouched — A's cancel must not have reloaded anything.
    expect(screen.getByRole('heading', { name: 'J-BBBB-2002' })).toBeTruthy();
    expect(jobDate.value).toBe('2026-12-24');
  });

  /*
   * DELIBERATELY NOT TESTED HERE: the pre-passive-effect window.
   *
   * React commits a render and only then runs passive effects. If route invalidation
   * lived in a `useEffect`, a job-A response settling between the commit and that effect
   * would read a `routeIdRef` still naming A, pass isCurrentLoad(), and install A's
   * values on B's route. JobDetail therefore invalidates in a LAYOUT effect, which runs
   * synchronously inside the commit, so no promise continuation can interleave.
   *
   * That change is NOT covered by a regression test, and the honest reason is that this
   * harness cannot produce the window: `act` flushes passive effects synchronously, so
   * inside `act` the invalidation has always already run by the time any awaited promise
   * resumes. An attempt to force the ordering — releasing the held response from a
   * sibling's layout effect during B's own commit, so it resolves as a microtask — was
   * built and measured, and it passed identically with the layout effect and with a
   * `useEffect` downgraded from it. It could not fail for the reason it named, so it was
   * removed rather than kept as a green check that tests less than its title claims.
   *
   * What IS established: downgrading `useLayoutEffect` to `useEffect` reddens nothing in
   * this file. Treat the layout effect as reasoned-and-strictly-earlier, not as proven.
   */
  /**
   * CRX-ENTITY-003 — a regression THIS PR introduced, caught by the gpt-5.6-sol review of
   * head 2b9c19c4c and rated High.
   *
   * An earlier round gated the WHOLE save-success block on stillOnThisJob(). For an UPDATE
   * that is purely protective. For a CREATE it is not: `save_job` runs with p_job_id NULL and
   * the row COMMITS regardless, so suppressing the acknowledgement traded a VISIBLE wrong
   * (the operator yanked onto the job they just made) for a SILENT one — a job exists and
   * nobody was told. useIdempotencyKey's map is component-local and dies on unmount, so the
   * operator's retry mints a FRESH key, the DB replay check cannot match, and the second
   * save_job writes a DUPLICATE job that can be completed, invoiced, or move inventory.
   *
   * Suppressed in the same arm: warnIfOverCreditLimit, which writes a durable admin
   * notification row. A credit control that leaves no trace is not a weakened control, it is
   * an absent one. Neither statement touches JobDetail state, so neither had anything to be
   * protected from — gating them could only subtract.
   *
   * Confirmed 2026-09-06 that this test FAILS against the fully-gated source (no success
   * toast, no check_customer_credit_limit call, no notification) and passes with the split.
   */
  it('still acknowledges a NEW job that commits after the operator has left, and still runs the credit check', async () => {
    const saveGate = deferred();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') {
        return buildChain({ data: [{ id: 'cust-1', farm_name: 'Farm Alpha', is_active: true }], error: null });
      }
      if (table === 'jobs') return buildChain({ data: JOB_B, error: null });
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'save_job') {
        return saveGate.promise.then(() => ({ data: { job_id: 'job-created-1' }, error: null }));
      }
      if (fn === 'check_customer_credit_limit') {
        return Promise.resolve({
          data: { exceeded: true, farm_name: 'Farm Alpha', outstanding_ar: 90000, credit_limit: 50000 },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const router = mountAt('/jobs/new');
    const option = await screen.findByRole('option', { name: 'Farm Alpha' });
    const customerSelect = option.closest('select') as HTMLSelectElement;
    await act(async () => { fireEvent.change(customerSelect, { target: { value: 'cust-1' } }); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Job/ })); });
    await waitFor(() => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true));

    // The operator leaves while save_job is still in flight. The row commits anyway.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });
    await act(async () => { saveGate.release(); await saveGate.promise; });

    // 1. The create receipt still reaches the operator — the ONLY evidence the job exists.
    //    It must also be ENTITY-SPECIFIC: this toast lands over an unrelated page and
    //    auto-dismisses in 4s (Toast.tsx:47), so a bare 'Job created' is a floating claim
    //    the operator cannot attach to anything. Naming the customer is what makes it a
    //    receipt rather than a notification, so that is what this pins.
    await waitFor(() => {
      expect(mockToast.mock.calls.some(
        (c) => c[0] === 'success'
          && String(c[1]).includes('Farm Alpha')
          && String(c[1]).includes('created'),
      )).toBe(true);
    });

    // 2. The credit control still runs on the committed row, and still leaves its record.
    await waitFor(() => {
      expect(mockRpc.mock.calls.some((c) => c[0] === 'check_customer_credit_limit')).toBe(true);
    });
    await waitFor(() => expect(mockNotifyCreditLimit).toHaveBeenCalled());

    // 3. And the page the operator is on NOW is untouched: no redirect onto the new job,
    //    which is the wrong this PR's guard exists to prevent. Both halves at once.
    expect(mockNavigate).not.toHaveBeenCalledWith('/jobs/job-created-1');
    expect(screen.getByRole('heading', { name: 'J-BBBB-2002' })).toBeTruthy();
  });
});
