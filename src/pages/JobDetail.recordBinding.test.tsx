/**
 * JobDetail — cross-record binding regressions.
 *
 * These cover defects that the ticket/route-id guard in JobDetail.staleLoad.test.tsx
 * does NOT reach, because each one lives outside the load path that guard protects:
 *
 *   1. fetchJob installed the record onto the form and only THEN awaited two more reads, so
 *      a route change inside that window left one job's customer, date, notes and fields on
 *      the blank /jobs/new form — and saving INSERTED a new job carrying them.
 *   2. performSave's LICENSE_EXPIRED catch raised the administrative override prompt with no
 *      staleness check, so a rejection landing after the operator moved on offered "Assign
 *      Anyway" over a different job.
 *   3. routeEpochRef was bumped only when the route COMMITTED to another job, never on
 *      unmount, so work still in flight after leaving the page entirely believed it was
 *      still on its job and could navigate the operator back.
 *   4. handleStart alone among the four job-action handlers carried no staleness gate, so
 *      starting a job and moving on announced the start over another job and refetched the
 *      started job's server state over that job's form.
 *
 * The mock keeps the REAL hasRpcCode/RpcErrorCodes from ../lib/db. Stubbing those would
 * delete the very error path test 2 exists to exercise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
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

/** Answers only once `gate` resolves; resolution is lazy so the query can be issued early. */
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

vi.mock('../lib/db', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
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
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() } }));
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

/** Job A carries a field, so fetchJob's field_billing_defaults reads actually run. */
const JOB_A = makeJob({
  id: 'job-a',
  job_number: 'J-AAAA-1001',
  job_date: '2026-03-01',
  notes: 'A notes',
  job_fields: [{
    field_id: 'field-1',
    field: { field_name: 'North 40' },
    acres_to_treat: 10,
    planted_acres: 10,
    crop: 'corn',
    strip: '',
    pests: '',
    sort_order: 0,
  }],
});
const JOB_B = makeJob({ id: 'job-b', job_number: 'J-BBBB-2002', job_date: '2026-07-15', notes: 'B notes' });

const LICENSE_EXPIRED_ERROR = {
  code: 'P0001',
  message: 'LICENSE_EXPIRED: applicator license expired 2020-01-01',
  details: null,
  hint: null,
};

/** Routes include a non-JobDetail page so a test can UNMOUNT the page, not just re-route it. */
function mountAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/jobs/:id', element: <JobDetail /> },
      { path: '/other', element: <div>Somewhere else entirely</div> },
    ],
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
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('JobDetail cross-record binding', () => {
  it('does not strand job A\'s values on the blank /jobs/new form', async () => {
    // The `jobs` read answers immediately, so the OLD ordering had already installed job A
    // onto the form. The follow-up field_billing_defaults read is held open, which is the
    // window the operator navigates inside. The new-job branch resets only four pieces of
    // state, so anything installed before this point survives onto the blank form and is
    // INSERTED as a new job on the next save.
    const gateDefaults = deferred();
    let defaultsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') return buildChain({ data: JOB_A, error: null });
      if (table === 'field_billing_defaults') {
        defaultsCalls += 1;
        return defaultsCalls === 1
          ? buildGatedChain({ data: [], error: null }, gateDefaults.promise)
          : buildChain({ data: [], error: null });
      }
      return buildChain({ data: [], error: null });
    });

    const router = mountAt('/jobs/job-a');
    await waitFor(() => expect(defaultsCalls).toBe(1));

    // Navigate to a brand-new job while that second read is still outstanding.
    await act(async () => { await router.navigate('/jobs/new'); });
    await act(async () => { gateDefaults.release(); await gateDefaults.promise; });

    // The blank form must carry TODAY's date, not job A's.
    await waitFor(() => {
      const jobDate = screen.getByLabelText(/Job Date/) as HTMLInputElement;
      expect(jobDate.value).toBe('2026-08-19');
    });
    expect((screen.getByLabelText(/Job Date/) as HTMLInputElement).value).not.toBe('2026-03-01');
    expect(screen.queryByDisplayValue('A notes')).toBeNull();
  });

  it('does not offer the license override on a job the operator has moved on from', async () => {
    // save_job rejects job A with LICENSE_EXPIRED, but only AFTER the operator has opened
    // job B. Confirming that prompt calls performSave(true) from the CURRENT render, so an
    // unguarded prompt saves job B through the administrative override path and writes an
    // override audit against a job nobody overrode.
    const saveGate = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        return jobsCalls === 1
          ? buildChain({ data: JOB_A, error: null })
          : buildChain({ data: JOB_B, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((fn: string) => (fn === 'save_job'
      ? saveGate.promise.then(() => ({ data: null, error: LICENSE_EXPIRED_ERROR }))
      : Promise.resolve({ data: null, error: null })));

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_job', expect.anything()));

    // The operator opens job B while job A's save is still in flight.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });

    // Job A's rejection lands now.
    await act(async () => { saveGate.release(); await saveGate.promise; });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'J-BBBB-2002' })).toBeTruthy();
    });
    expect(screen.queryByText('Applicator License Expired')).toBeNull();
    expect(screen.queryByRole('button', { name: /Assign Anyway/ })).toBeNull();
  });

  it('closes an already-open license override prompt when the operator changes job', async () => {
    // The companion to the test above. There the rejection lands LATE and must not raise the
    // prompt at all; here it lands while the operator is still on job A, so the prompt opens
    // legitimately — and must not then survive onto job B, where "Assign Anyway" would save
    // the wrong record. The catch's staleness gate cannot cover this case: it already ran,
    // correctly, before the operator moved.
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        return jobsCalls === 1
          ? buildChain({ data: JOB_A, error: null })
          : buildChain({ data: JOB_B, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((fn: string) => Promise.resolve(fn === 'save_job'
      ? { data: null, error: LICENSE_EXPIRED_ERROR }
      : { data: null, error: null }));

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });

    // The save fails while the operator is still on job A: the prompt is correct here.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    await screen.findByText('Applicator License Expired');

    // Moving to another job must take the prompt with it.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });

    expect(screen.queryByText('Applicator License Expired')).toBeNull();
    expect(screen.queryByRole('button', { name: /Assign Anyway/ })).toBeNull();
  });

  it('does not act on a save that lands after the page has been left entirely', async () => {
    // routeEpochRef was bumped only by the layout effect, which does not run when the page
    // unmounts — so after leaving JobDetail the in-flight save still believed it was on its
    // job. Everything the success block does is then done on behalf of a page that is gone:
    // a success toast over an unrelated screen, the dirty flag cleared, and a refetch of the
    // abandoned job. The passive effect's cleanup already covered its own ticket, which is
    // exactly why the ticket was guarded here and the epoch was not.
    const saveGate = deferred();
    mockFrom.mockImplementation((table: string) => (table === 'jobs'
      ? buildChain({ data: JOB_A, error: null })
      : buildChain({ data: [], error: null })));
    mockRpc.mockImplementation((fn: string) => (fn === 'save_job'
      ? saveGate.promise.then(() => ({ data: { job_id: 'job-a' }, error: null }))
      : Promise.resolve({ data: null, error: null })));

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });


    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save Changes/ })); });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_job', expect.anything()));

    // Leave JobDetail altogether — this UNMOUNTS the page rather than re-routing it.
    await act(async () => { await router.navigate('/other'); });
    await screen.findByText('Somewhere else entirely');

    // The save lands with the page gone.
    await act(async () => { saveGate.release(); await saveGate.promise; });

    // toast('success', ...) is the FIRST statement inside `if (stillOnThisJob())`, so it is
    // the cleanest single witness that the whole block was skipped. A jobs-read count is not
    // usable here: performSave also issues a direct `jobs` UPDATE for the loader fields, so
    // the table is touched again on the success path either way.
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
    expect(screen.getByText('Somewhere else entirely')).toBeTruthy();
  });

  it('does not announce a job start over the job the operator moved to', async () => {
    // handleStart was the one job-action handler with no staleness gate at all, while its
    // three neighbours (Complete, Cancel, Transfer) each opened with captureRouteEpoch().
    // start_job commits against job A correctly; what must not follow the operator is the
    // "Job started" confirmation over job B, and the refetch behind it that reinstalls job
    // A's server state over the form — discarding whatever the operator had typed on B.
    const startGate = deferred();
    let jobsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobsCalls += 1;
        return jobsCalls === 1
          ? buildChain({ data: JOB_A, error: null })
          : buildChain({ data: JOB_B, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((fn: string) => (fn === 'start_job'
      ? startGate.promise.then(() => ({ data: { ok: true }, error: null }))
      : Promise.resolve({ data: null, error: null })));

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start Job/ })); });
    // Positive control: if the click were swallowed (e.g. by the unsaved-changes guard on
    // the button) the assertions below would pass without the gate ever being exercised.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('start_job', expect.anything()));

    // The operator opens job B while job A's start is still in flight.
    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });

    // Job A's start commits now.
    await act(async () => { startGate.release(); await startGate.promise; });

    // toast('success', 'Job started') is the first statement inside `if (stillOnThisJob())`,
    // so it witnesses the whole block. A jobs-read count cannot be used: navigating to job B
    // issues its own jobs read either way.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'J-BBBB-2002' })).toBeTruthy());
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Job started');
  });
});
