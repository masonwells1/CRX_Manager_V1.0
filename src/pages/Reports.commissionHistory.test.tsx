import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type RpcResponse = { data: unknown; error: { message: string } | null };
type RpcHandler = (name: string, args: Record<string, unknown>) => Promise<RpcResponse>;

const H = vi.hoisted(() => ({
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  toast: vi.fn(),
  auth: { role: 'admin' as const, profile: { id: 'admin-1', role: 'admin' }, deniedPages: [] as string[] },
  rpcHandler: null as RpcHandler | null,
}));

type QueryBuilder = {
  select: () => QueryBuilder;
  eq: (...args: unknown[]) => QueryBuilder;
  order: (...args: unknown[]) => QueryBuilder;
  limit: (...args: unknown[]) => QueryBuilder;
  is: (...args: unknown[]) => QueryBuilder;
  in: (...args: unknown[]) => QueryBuilder;
  gte: (...args: unknown[]) => QueryBuilder;
  lte: (...args: unknown[]) => QueryBuilder;
  not: (...args: unknown[]) => QueryBuilder;
  then: (resolve: (value: unknown) => unknown) => unknown;
};

vi.mock('../lib/db', () => ({
  supabase: {
    from: () => {
      const builder: QueryBuilder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        is: () => builder,
        in: () => builder,
        gte: () => builder,
        lte: () => builder,
        not: () => builder,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return builder;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      H.rpc.push({ name, args });
      if (H.rpcHandler) return H.rpcHandler(name, args);
      return Promise.resolve({
        data: {
          as_of_date: String(args.p_as_of_date),
          balance_rows: [{
            recipient_id: 'recipient-1',
            recipient_name: 'Alex Farmer',
            total_earned: 1500,
            total_paid: 1234.56,
            outstanding_balance: 265.44,
            pending_count: 1,
            paid_count: 1,
          }],
          payment_detail_rows: [{
            commission_id: 'commission-1',
            commission_order_date: '2026-08-14',
            customer_name: 'Prairie View Farms',
            payment_date: '2026-08-20',
            payment_id: 'payment-1',
            payment_number: 'CP-2026-0042',
            recipient_id: 'recipient-1',
            recipient_name: 'Alex Farmer',
            settled_amount: 1234.56,
            source_number: 'INV-1042',
            source_type: 'Invoice',
          }],
        },
        error: null,
      });
    },
  },
  assertRpcResult: <T,>(data: T) => {
    if (data == null) throw new Error('RPC returned no data');
    return data;
  },
  sanitizeError: (error: unknown) => String(error),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => H.auth,
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: H.toast }),
}));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/csvExport', () => ({
  exportToCSV: vi.fn(),
  fmtCSV: vi.fn(),
  fmtDateCSV: vi.fn(),
  fmtDateOnlyCSV: vi.fn(),
}));
vi.mock('../lib/yearEndSummaryPdf', () => ({ downloadYearEndSummaryPdf: vi.fn(), downloadBatchYearEndSummaries: vi.fn() }));
vi.mock('../components/reports/LogbookReport', () => ({ default: () => <div>Logbook</div> }));
vi.mock('../components/reports/YearEndSummaryDialog', () => ({ default: () => null }));

import Reports from './Reports';
import { todayInBusinessTz } from '../lib/dateUtils';
import { exportToCSV } from '../lib/csvExport';

const renderReports = () => render(<MemoryRouter><Reports /></MemoryRouter>);

beforeEach(() => {
  cleanup();
  H.rpc = [];
  H.toast.mockReset();
  H.rpcHandler = null;
  vi.mocked(exportToCSV).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Reports commission history', () => {
  it('calls one snapshot RPC and renders both balance and payment-detail fields', async () => {
    renderReports();

    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));

    await waitFor(() => {
      expect(H.rpc.filter(({ name }) => name === 'get_commission_history_report')).toHaveLength(1);
      expect(H.rpc.some(({ name }) => name === 'get_commission_balance_report')).toBe(false);
      expect(H.rpc.some(({ name }) => name === 'get_commission_payment_detail_report')).toBe(false);
      expect(screen.getByText('CP-2026-0042')).toBeInTheDocument();
    });

    expect(screen.getByText(/8\/20\/2026/)).toBeInTheDocument();
    expect(screen.getAllByText('Alex Farmer').length).toBeGreaterThan(0);
    expect(screen.getByText('Invoice: INV-1042')).toBeInTheDocument();
    expect(screen.getByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.getByText(/8\/14\/2026/)).toBeInTheDocument();
    expect(screen.getAllByText('$1,234.56').length).toBeGreaterThan(0);
  });

  it('clamps a future This Season end to Chicago today for the snapshot RPC', async () => {
    const businessToday = todayInBusinessTz();
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));

    await waitFor(() => expect(H.rpc.some(({ name }) => name === 'get_commission_history_report')).toBe(true));
    H.rpc = [];

    fireEvent.click(screen.getByRole('button', { name: 'This Season' }));

    await waitFor(() => {
      const snapshot = H.rpc.find(({ name }) => name === 'get_commission_history_report');
      expect(snapshot?.args.p_as_of_date).toBe(businessToday);
    });
  });

  it('keeps the last successful report and labels a failed refresh as unconfirmed', async () => {
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));
    await screen.findByText('CP-2026-0042');
    const successfulBanner = screen.getByText(/Balance and payout detail shown through/).textContent;

    H.rpcHandler = () => Promise.resolve({
      data: null,
      error: { message: 'network unavailable' },
    });

    const endDateInput = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1];
    expect(endDateInput).toBeDefined();
    fireEvent.change(endDateInput, { target: { value: '2026-08-20' } });

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('empty tables are not a confirmed zero');
    expect(screen.getByText(/Balance and payout detail shown through/)).toHaveTextContent(successfulBanner || '');
    expect(screen.getByText('CP-2026-0042')).toBeInTheDocument();
    expect(screen.getAllByText('Alex Farmer').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Balance and payout detail shown through 8\/20\/2026/)).not.toBeInTheDocument();
  });

  it('treats a silent-null RPC response as a visible failure instead of a zero report', async () => {
    H.rpcHandler = () => Promise.resolve({ data: null, error: null });

    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('empty tables are not a confirmed zero');
    expect(screen.queryByText(/Balance and payout detail shown through/)).not.toBeInTheDocument();
    expect(await screen.findByText('No commission data')).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('RPC returned no data'));
  });

  it('rejects a partial snapshot payload instead of publishing mismatched sections', async () => {
    H.rpcHandler = (_name, args) => Promise.resolve({
      data: {
        as_of_date: args.p_as_of_date,
        balance_rows: [],
      },
      error: null,
    });

    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('empty tables are not a confirmed zero');
    expect(screen.queryByText(/Balance and payout detail shown through/)).not.toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('invalid payload'));
  });

  it('ignores an older response that finishes after a newer cutoff', async () => {
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));
    await screen.findByText('CP-2026-0042');

    let resolveOlder!: (value: RpcResponse) => void;
    let resolveNewer!: (value: RpcResponse) => void;
    const older = new Promise<RpcResponse>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<RpcResponse>((resolve) => { resolveNewer = resolve; });

    H.rpc = [];
    H.rpcHandler = (name, args) => {
      const asOf = args.p_as_of_date;
      if (name === 'get_commission_history_report' && asOf === '2026-08-20') return older;
      if (name === 'get_commission_history_report' && asOf === '2026-08-21') return newer;
      return Promise.resolve({ data: null, error: { message: `Unexpected RPC ${name}` } });
    };

    const endDateInput = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1];
    expect(endDateInput).toBeDefined();
    fireEvent.change(endDateInput, { target: { value: '2026-08-20' } });
    await waitFor(() => expect(H.rpc.some(({ name, args }) => name === 'get_commission_history_report' && args.p_as_of_date === '2026-08-20')).toBe(true));

    fireEvent.change(endDateInput, { target: { value: '2026-08-21' } });
    await waitFor(() => expect(H.rpc.some(({ name, args }) => name === 'get_commission_history_report' && args.p_as_of_date === '2026-08-21')).toBe(true));

    await act(async () => {
      resolveNewer({
        data: {
          as_of_date: '2026-08-21',
          balance_rows: [{
            recipient_id: 'recipient-new',
            recipient_name: 'Newer Recipient',
            total_earned: 21.25,
            total_paid: 21.25,
            outstanding_balance: 0,
            pending_count: 0,
            paid_count: 1,
          }],
          payment_detail_rows: [{
            commission_id: 'commission-new',
            commission_order_date: '2026-08-18',
            customer_name: 'Newer Customer',
            payment_date: '2026-08-21',
            payment_id: 'payment-new',
            payment_number: 'CP-NEWER',
            recipient_id: 'recipient-new',
            recipient_name: 'Newer Recipient',
            settled_amount: 21.25,
            source_number: 'ORDER-NEW',
            source_type: 'Order',
          }],
        },
        error: null,
      });
    });
    await screen.findByText('CP-NEWER');

    await act(async () => {
      resolveOlder({
        data: {
          as_of_date: '2026-08-20',
          balance_rows: [{
            recipient_id: 'recipient-old',
            recipient_name: 'Older Recipient',
            total_earned: 20,
            total_paid: 0,
            outstanding_balance: 20,
            pending_count: 1,
            paid_count: 0,
          }],
          payment_detail_rows: [],
        },
        error: null,
      });
    });

    expect(screen.getAllByText('Newer Recipient').length).toBeGreaterThan(0);
    expect(screen.queryByText('Older Recipient')).not.toBeInTheDocument();
    expect(screen.getByText(/Balance and payout detail shown through 8\/21\/2026/)).toBeInTheDocument();
  });

  it('keeps exports disabled when an older same-cutoff refresh finishes before the latest one', async () => {
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));
    await screen.findByText('CP-2026-0042');

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export Payment Detail' })).toBeEnabled();
    vi.mocked(exportToCSV).mockClear();

    const pending: Array<{
      asOf: string;
      resolve: (value: RpcResponse) => void;
    }> = [];
    H.rpcHandler = (name, args) => {
      if (name !== 'get_commission_history_report') {
        return Promise.resolve({ data: null, error: { message: `Unexpected RPC ${name}` } });
      }
      return new Promise<RpcResponse>((resolve) => {
        pending.push({ asOf: String(args.p_as_of_date), resolve });
      });
    };

    // Both future dates clamp to Chicago-today. The old rows therefore have the
    // same cutoff as both in-flight requests, which is the race that a shared
    // page-level loading flag cannot distinguish.
    const endDateInput = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1];
    fireEvent.change(endDateInput, { target: { value: '2099-12-30' } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(endDateInput, { target: { value: '2099-12-31' } });
    await waitFor(() => expect(pending).toHaveLength(2));

    const makeReport = (asOf: string, paymentNumber: string): RpcResponse => ({
      data: {
        as_of_date: asOf,
        balance_rows: [{
          recipient_id: 'recipient-race',
          recipient_name: 'Race Proof Recipient',
          total_earned: 25,
          total_paid: 25,
          outstanding_balance: 0,
          pending_count: 0,
          paid_count: 1,
        }],
        payment_detail_rows: [{
          commission_id: 'commission-race',
          commission_order_date: asOf,
          customer_name: 'Race Proof Farm',
          payment_date: asOf,
          payment_id: 'payment-race',
          payment_number: paymentNumber,
          recipient_id: 'recipient-race',
          recipient_name: 'Race Proof Recipient',
          settled_amount: 25,
          source_number: 'ORDER-RACE',
          source_type: 'Order',
        }],
      },
      error: null,
    });

    await act(async () => {
      pending[0].resolve(makeReport(pending[0].asOf, 'CP-STALE-RACE'));
    });

    // The older fetchFinancial invocation has now cleared the shared `loading`
    // flag. Export integrity must still follow the latest commission request.
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Payment Detail' })).toBeDisabled();
    expect(exportToCSV).not.toHaveBeenCalled();

    await act(async () => {
      pending[1].resolve(makeReport(pending[1].asOf, 'CP-LATEST-RACE'));
    });
    await screen.findByText('CP-LATEST-RACE');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Export Payment Detail' })).toBeEnabled();
    });
  });

  it('stamps both commission exports with the as-of date that was actually loaded', async () => {
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));
    await screen.findByText('CP-2026-0042');

    const businessToday = todayInBusinessTz();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Payment Detail' }));

    expect(exportToCSV).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      `commission_balance_as_of_${businessToday}`,
    );
    expect(exportToCSV).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      `commission_payment_detail_as_of_${businessToday}`,
    );

    const balanceExport = vi.mocked(exportToCSV).mock.calls.find((call) => (
      call[2] === `commission_balance_as_of_${businessToday}`
    ));
    const paymentExport = vi.mocked(exportToCSV).mock.calls.find((call) => (
      call[2] === `commission_payment_detail_as_of_${businessToday}`
    ));
    const earnedFormatter = balanceExport?.[1].find((column) => column.key === 'total_earned')?.format;
    const settledFormatter = paymentExport?.[1].find((column) => column.key === 'settled_amount')?.format;

    expect(earnedFormatter?.(1.01, {})).toBe('$1.01');
    expect(settledFormatter?.(2.05, {})).toBe('$2.05');
    expect(settledFormatter?.(-12.34, {})).toBe('-$12.34');
    expect(settledFormatter?.(1.005, {})).toBe('Invalid amount');
    expect(settledFormatter?.(JSON.parse('90071992547409.93'), {})).toBe('Invalid amount');
  });

  it('refuses to export the previous cutoff after a failed refresh', async () => {
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));
    await screen.findByText('CP-2026-0042');

    // The first load succeeded, so exporting is legitimate at this point.
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Export Payment Detail' })).toBeEnabled();
    vi.mocked(exportToCSV).mockClear();

    H.rpcHandler = () => Promise.resolve({ data: null, error: { message: 'network unavailable' } });
    const endDateInput = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1];
    fireEvent.change(endDateInput, { target: { value: '2026-08-20' } });
    await screen.findByRole('alert');

    // The stale rows are still on screen behind the warning banner, but a CSV
    // would carry neither the banner nor the cutoff they belong to.
    expect(screen.getByText('CP-2026-0042')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Payment Detail' })).toBeDisabled();
    expect(exportToCSV).not.toHaveBeenCalled();
  });

  it('refuses to export a cutoff whose report has not loaded yet', async () => {
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));
    await screen.findByText('CP-2026-0042');
    vi.mocked(exportToCSV).mockClear();

    // Hold the next refresh open so the component stays mid-load.
    let releaseRefresh: (() => void) | null = null;
    H.rpcHandler = () => new Promise<{ data: unknown; error: { message: string } | null }>((resolve) => {
      releaseRefresh = () => resolve({ data: null, error: { message: 'cancelled' } });
    });

    const endDateInput = document.querySelectorAll<HTMLInputElement>('input[type="date"]')[1];
    fireEvent.change(endDateInput, { target: { value: '2026-08-20' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Export Payment Detail' })).toBeDisabled();
    expect(exportToCSV).not.toHaveBeenCalled();

    await act(async () => { releaseRefresh?.(); });
  });
});
