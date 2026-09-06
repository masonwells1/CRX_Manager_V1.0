/**
 * JobDetailRoute — the route element for `jobs/:id`.
 *
 * These tests cover the two defects that the in-component guards cannot reach, because both
 * happen with no race at all: the page was REUSED across records, so whatever it held outside
 * the fields it explicitly resets survived the change of record.
 *
 *   1. CRX-ENTITY-001 — a fully loaded job's values survived onto the blank `/jobs/new` form,
 *      where `save_job` INSERTs. Load a job, click New Job, Save: a brand-new job carrying
 *      another customer's data.
 *   2. CRX-ENTITY-002 — a Complete/Cancel/Transfer confirmation opened on job A stayed open
 *      across a job change, and its onConfirm ran the CURRENT render's handler, so confirming
 *      it acted on job B.
 *
 * They are exercised through JobDetailRoute — the component the router actually renders —
 * rather than through a key a test file added for itself. The last test pins App.tsx's wiring,
 * because the key is now the only thing standing between these two defects and production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of CHAIN_METHODS) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
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
vi.mock('./ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
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
import JobDetailRoute from './JobDetailRoute';

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

/** Mounts the ROUTE element, so the key under test is the one the router supplies. */
function mountAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/jobs/:id', element: <JobDetailRoute /> }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('JobDetailRoute remounts per record', () => {
  it('does not carry a fully loaded job onto the blank /jobs/new form', async () => {
    // No race: job A is allowed to load COMPLETELY, exactly as it would for an operator
    // reading it, before New Job is opened. The in-component ordering guard cannot help here
    // — nothing was abandoned mid-flight, the install was legitimate and already finished.
    mockFrom.mockImplementation((table: string) => (table === 'jobs'
      ? buildChain({ data: JOB_A, error: null })
      : buildChain({ data: [], error: null })));

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });
    // Positive control: job A's own date is really installed on the form, so there IS record
    // state here to leak. Without it the assertion below could pass on an empty page.
    await waitFor(() => {
      expect((screen.getByLabelText(/Job Date/) as HTMLInputElement).value).toBe('2026-03-01');
    });

    await act(async () => { await router.navigate('/jobs/new'); });

    await waitFor(() => {
      const jobDate = screen.getByLabelText(/Job Date/) as HTMLInputElement;
      expect(jobDate.value).toBe('2026-08-19');
    });
    expect((screen.getByLabelText(/Job Date/) as HTMLInputElement).value).not.toBe('2026-03-01');
  });

  it('does not leave a Complete confirmation standing over the next job', async () => {
    // The dialog's onConfirm calls handleComplete() from the CURRENT render, which reads the
    // CURRENT id — so a prompt opened on job A and confirmed on job B completes B, deducting
    // inventory and writing an application record against a job nobody asked to complete.
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

    const router = mountAt('/jobs/job-a');
    await screen.findByRole('heading', { name: 'J-AAAA-1001' });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete Job' })); });
    await screen.findByRole('dialog', { name: 'Complete Job' });

    await act(async () => { await router.navigate('/jobs/job-b'); });
    await screen.findByRole('heading', { name: 'J-BBBB-2002' });

    expect(screen.queryByRole('dialog', { name: 'Complete Job' })).toBeNull();
    expect(mockRpc).not.toHaveBeenCalledWith('complete_job', expect.anything());
  });

  it('is the element App.tsx routes jobs/:id through', () => {
    // The key inside JobDetailRoute is now the only thing standing between the two defects
    // above and production. The tests above would keep passing if App.tsx were quietly pointed
    // back at JobDetail, so pin the wiring itself rather than trusting a comment. App.tsx
    // builds its router at module scope, which is why this reads the source instead of
    // importing it.
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    const routeLine = app.split(/\r?\n/).find((l) => l.includes("path: 'jobs/:id'"));
    expect(routeLine, "App.tsx has no `jobs/:id` route line").toBeTruthy();
    expect(routeLine).toContain('<JobDetailRoute />');
    expect(routeLine).not.toContain('<JobDetail />');
  });
});
