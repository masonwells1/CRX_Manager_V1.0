/**
 * MonthEndClose.test.tsx — Tests for the month-end close page
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
}));

interface ChainResult {
  data: unknown;
  error: unknown;
  count?: number | null;
}

interface SummaryFixture {
  invoices: {
    posted_count: number;
    total_amount_cents: number;
    total_cost_cents: number;
    draft_count: number;
    voided_count: number;
  };
  payments: { count: number; total_cents: number };
  orders: { count: number; total_cents: number };
  deliveries: { count: number; completed_count: number };
  applications: { count: number; total_acres: number };
  commissions: { earned_cents: number; paid_count: number };
  ar_balance_cents: number;
}

function buildChain(result: ChainResult): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

function cleanSummary(): SummaryFixture {
  return {
    invoices: {
      posted_count: 1,
      total_amount_cents: 1000,
      total_cost_cents: 500,
      draft_count: 0,
      voided_count: 0,
    },
    payments: { count: 0, total_cents: 0 },
    orders: { count: 0, total_cents: 0 },
    deliveries: { count: 0, completed_count: 0 },
    applications: { count: 0, total_acres: 0 },
    commissions: { earned_cents: 0, paid_count: 0 },
    ar_balance_cents: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockCleanCloseableSummary() {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'get_monthly_summary') {
      return Promise.resolve({ data: cleanSummary(), error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

async function switchToMonth(monthIndex: number) {
  const monthSelect = await screen.findByLabelText('Month to review');
  fireEvent.change(monthSelect, { target: { value: String(monthIndex) } });
  await waitFor(() => {
    expect(screen.getByLabelText('Month to review')).toHaveValue(String(monthIndex));
  });
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../lib/statementPdf', () => ({
  downloadBatchStatements: vi.fn(),
}));

vi.mock('../lib/yearEndSummaryPdf', () => ({
  downloadBatchYearEndSummaries: vi.fn(),
}));

vi.mock('../components/statements/StatementPrintDialog', () => ({ default: () => null }));
vi.mock('../components/reports/YearEndSummaryDialog', () => ({
  default: ({ open, onGenerate }: { open: boolean; onGenerate: (season: number, options: Record<string, boolean>) => void }) => (
    open ? <button onClick={() => onGenerate(2026, {})}>Run year-end test</button> : null
  ),
}));

import MonthEndClose from './MonthEndClose';

function renderMonthEnd() {
  return render(
    <MemoryRouter initialEntries={['/month-end']}>
      <Routes>
        <Route path="/month-end" element={<MonthEndClose />} />
      </Routes>
    </MemoryRouter>,
  );
}

type SelectChangeHandler = (event: { target: { value: string } }) => void;

function getReactSelectChangeHandler(element: HTMLElement): SelectChangeHandler {
  const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  if (!propsKey) throw new Error('React props not found for select');
  const props = (element as unknown as Record<string, unknown>)[propsKey];
  if (!props || typeof props !== 'object') throw new Error('React props are not an object');
  const onChange = (props as { onChange?: unknown }).onChange;
  if (typeof onChange !== 'function') throw new Error('React onChange handler not found');
  return onChange as SelectChangeHandler;
}

describe('MonthEndClose', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-10T12:00:00Z'));
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: [], count: 0, error: null });
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders Month-End Close heading', async () => {
    renderMonthEnd();
    await waitFor(() => {
      expect(screen.getByText('Month-End Close')).toBeInTheDocument();
    });
  });

  it('shows current period label', async () => {
    renderMonthEnd();
    await waitFor(() => {
      expect(screen.getByText('July 2026')).toBeInTheDocument();
    });
  });

  it('renders the checklist section', async () => {
    renderMonthEnd();
    await waitFor(() => {
      // Target the section heading specifically. With no summary loaded (mock returns
      // null), the page also renders a "Resolve all checklist items…" fail-closed note
      // (A9 Codex P1), so a broad /checklist/i now matches two elements.
      expect(screen.getByText('Close Checklist')).toBeInTheDocument();
    });
  });

  it('keeps "Roll the Month" unavailable when no summary loaded (fail-closed)', async () => {
    renderMonthEnd();
    await waitFor(() => {
      expect(screen.getByText('Close Checklist')).toBeInTheDocument();
    });
    // With get_monthly_summary returning null, the period cannot be closed: the
    // fail-closed note is shown and the "Roll the Month" button is disabled.
    expect(screen.getByText(/Resolve all checklist items/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Roll the Month/i })).toBeDisabled();
  });

  it('renders statements section', async () => {
    renderMonthEnd();
    await waitFor(() => {
      expect(screen.getByText(/statement/i)).toBeInTheDocument();
    });
  });

  it('surfaces a batch year-end RPC guard error through the sanitizer', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invoices') return buildChain({ data: [{ customer_id: 'customer-1' }], error: null });
      if (table === 'orders') return buildChain({ data: [], count: 0, error: null });
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_batch_year_end_summaries') {
        return Promise.resolve({ data: null, error: { message: 'CUSTOMER_SCOPE_DENIED' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderMonthEnd();
    fireEvent.click(await screen.findByRole('button', { name: 'Year-End Summaries' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run year-end test' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'CUSTOMER_SCOPE_DENIED');
    });
  });

  it('keeps the current in-progress month from being closeable', async () => {
    mockCleanCloseableSummary();

    renderMonthEnd();

    await screen.findByText('July 2026');
    await waitFor(() => {
      expect(screen.getByText('No unpriced rush orders')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Roll the Month/i })).toBeDisabled();
    expect(screen.getByText(/month has not ended yet/i)).toBeInTheDocument();
  });

  // NOTE (Codex gate P3): this test only DISCRIMINATES on a host whose timezone differs from
  // America/Chicago (e.g. a UTC CI box) — on a Central workstation the browser clock and the
  // business clock coincide, so a browser-clock regression would still pass here. The
  // host-independent guard is src/lib/dateUtils.test.ts, which pins Intl to America/Chicago.
  it('treats the last evening of the month as still in-progress (Central, not UTC)', async () => {
    vi.setSystemTime(new Date('2026-08-01T02:00:00Z'));
    mockCleanCloseableSummary();

    renderMonthEnd();

    // 02:00Z on Aug 1 is 21:00 Central on Jul 31. The page must default to JULY, not
    // August: the default period is derived from the business clock, not the browser's.
    // (Under TZ=UTC a browser-clock implementation would land on August and fail here.)
    const monthSelect = await screen.findByLabelText('Month to review');
    const yearSelect = await screen.findByLabelText('Year to review');
    expect(monthSelect).toHaveValue('6');
    expect(yearSelect).toHaveValue('2026');

    await screen.findByText('July 2026');
    await waitFor(() => {
      expect(screen.getByText('No unpriced rush orders')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Roll the Month/i })).toBeDisabled();
    expect(screen.getByText(/month has not ended yet/i)).toBeInTheDocument();
  });

  it('keeps an ended month closeable when the checklist is clean', async () => {
    mockCleanCloseableSummary();

    renderMonthEnd();
    await switchToMonth(5);

    await screen.findByText('June 2026');
    await waitFor(() => {
      expect(screen.getByText('No unpriced rush orders')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Roll the Month/i })).not.toBeDisabled();
  });

  it('keeps a newly-selected period fail-closed when an older summary response resolves late', async () => {
    const slowSummary = deferred<{ data: SummaryFixture; error: null }>();
    let summaryCalls = 0;

    mockRpc.mockImplementation((name: string) => {
      if (name !== 'get_monthly_summary') return Promise.resolve({ data: null, error: null });
      summaryCalls += 1;
      if (summaryCalls === 1) return Promise.resolve({ data: cleanSummary(), error: null });
      if (summaryCalls === 2) return slowSummary.promise;
      return Promise.resolve({ data: null, error: { message: 'summary failed' } });
    });

    renderMonthEnd();
    await screen.findByText('July 2026');

    const monthSelect = await screen.findByLabelText('Month to review');
    const changeMonth = getReactSelectChangeHandler(monthSelect);

    act(() => {
      changeMonth({ target: { value: '5' } });
    });
    await waitFor(() => expect(summaryCalls).toBe(2));

    act(() => {
      changeMonth({ target: { value: '4' } });
    });
    await waitFor(() => expect(summaryCalls).toBe(3));
    await waitFor(() => {
      expect(screen.getByText(/Resolve all checklist items/i)).toBeInTheDocument();
    });

    await act(async () => {
      slowSummary.resolve({ data: cleanSummary(), error: null });
      await slowSummary.promise;
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Roll the Month/i })).toBeDisabled();
    });
    expect(screen.getByText(/Resolve all checklist items/i)).toBeInTheDocument();
  });

  it('clears ticked review boxes when switching periods', async () => {
    const paymentSummary = cleanSummary();
    paymentSummary.payments = { count: 2, total_cents: 2500 };
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_monthly_summary') {
        return Promise.resolve({ data: paymentSummary, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderMonthEnd();

    const checkbox = await screen.findByRole('checkbox', {
      name: /I have reviewed this and confirm it is correct/i,
    });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    await switchToMonth(5);

    const newCheckbox = await screen.findByRole('checkbox', {
      name: /I have reviewed this and confirm it is correct/i,
    });
    expect(newCheckbox).not.toBeChecked();
  });

  it('fails closed when the monthly summary cannot load', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_monthly_summary') {
        return Promise.resolve({ data: null, error: { message: 'summary failed' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    renderMonthEnd();

    await waitFor(() => {
      expect(screen.getByText(/Resolve all checklist items/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Roll the Month/i })).toBeDisabled();
  });

  it('requires manual confirmation when the unpriced rush-order count query fails', async () => {
    mockCleanCloseableSummary();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        return buildChain({ data: [], count: null, error: { message: 'count failed' } });
      }
      return buildChain({ data: [], error: null });
    });

    renderMonthEnd();

    await screen.findByText('Rush orders priced');
    expect(screen.getByText(/Could not verify unpriced rush orders/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', {
      name: /I have reviewed this and confirm it is correct/i,
    })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Roll the Month/i })).toBeDisabled();
  });

  it('disables the month/year selects while a close is in flight (Codex R6 structural guard)', async () => {
    // A closeable period (all checklist items pass) + a close RPC that never resolves,
    // so `closing` stays true. The period selects must be disabled while closing, so an
    // admin can't switch months mid-close and have the post-close refresh clobber the
    // newly-selected period.
    const validSummary = {
      invoices: { posted_count: 1, total_amount_cents: 1000, total_cost_cents: 500, draft_count: 0, voided_count: 0 },
      payments: { count: 0, total_cents: 0 },
      orders: { count: 0, total_cents: 0 },
      deliveries: { count: 0, completed_count: 0 },
      applications: { count: 0, total_acres: 0 },
      commissions: { earned_cents: 0, paid_count: 0 },
      ar_balance_cents: 0,
    };
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_monthly_summary') return Promise.resolve({ data: validSummary, error: null });
      if (name === 'close_accounting_period') return new Promise(() => {}); // pending forever -> closing stays true
      return Promise.resolve({ data: null, error: null });
    });

    renderMonthEnd();

    await switchToMonth(5);
    await screen.findByText('June 2026');

    // Period is closeable -> selects enabled, "Roll the Month" enabled.
    const rollBtn = await screen.findByRole('button', { name: /Roll the Month/i });
    await waitFor(() => expect(rollBtn).not.toBeDisabled());
    expect(screen.getByLabelText('Month to review')).not.toBeDisabled();

    // Open the confirm modal and start the (never-resolving) close.
    fireEvent.click(rollBtn);
    const confirmBtn = await screen.findByRole('button', { name: /^Close Period$/i });
    fireEvent.click(confirmBtn);

    // Now closing is in flight -> both period selects are disabled.
    await waitFor(() => {
      expect(screen.getByLabelText('Month to review')).toBeDisabled();
      expect(screen.getByLabelText('Year to review')).toBeDisabled();
    });
  });
});
