import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  toast: vi.fn(),
  auth: { role: 'admin' as const, profile: { id: 'admin-1', role: 'admin' }, deniedPages: [] as string[] },
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
      if (name === 'get_commission_payment_detail_report') {
        return Promise.resolve({
          data: [{
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
          error: null,
        });
      }
      return Promise.resolve({
        data: [{
          recipient_id: 'recipient-1',
          recipient_name: 'Alex Farmer',
          total_earned: 1500,
          total_paid: 1234.56,
          outstanding_balance: 265.44,
          pending_count: 1,
          paid_count: 1,
        }],
        error: null,
      });
    },
  },
  assertRpcResult: <T,>(data: T) => data,
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
vi.mock('../lib/csvExport', () => ({ exportToCSV: vi.fn(), fmtCSV: vi.fn(), fmtDateCSV: vi.fn() }));
vi.mock('../lib/yearEndSummaryPdf', () => ({ downloadYearEndSummaryPdf: vi.fn(), downloadBatchYearEndSummaries: vi.fn() }));
vi.mock('../components/reports/LogbookReport', () => ({ default: () => <div>Logbook</div> }));
vi.mock('../components/reports/YearEndSummaryDialog', () => ({ default: () => null }));

import Reports from './Reports';
import { todayInBusinessTz } from '../lib/dateUtils';

const renderReports = () => render(<MemoryRouter><Reports /></MemoryRouter>);

beforeEach(() => {
  cleanup();
  H.rpc = [];
  H.toast.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('Reports commission history', () => {
  it('calls both commission report RPCs and renders payment detail fields', async () => {
    renderReports();

    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));

    await waitFor(() => {
      expect(H.rpc.filter(({ name }) => name === 'get_commission_balance_report')).not.toHaveLength(0);
      expect(H.rpc.filter(({ name }) => name === 'get_commission_payment_detail_report')).not.toHaveLength(0);
      expect(screen.getByText('CP-2026-0042')).toBeInTheDocument();
    });

    expect(screen.getByText(/8\/20\/2026/)).toBeInTheDocument();
    expect(screen.getAllByText('Alex Farmer').length).toBeGreaterThan(0);
    expect(screen.getByText('Invoice: INV-1042')).toBeInTheDocument();
    expect(screen.getByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.getByText(/8\/14\/2026/)).toBeInTheDocument();
    expect(screen.getAllByText('$1,234.56').length).toBeGreaterThan(0);
  });

  it('clamps a future This Season end to Chicago today for both RPCs', async () => {
    const businessToday = todayInBusinessTz();
    renderReports();
    fireEvent.click(screen.getByRole('button', { name: 'Financial' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commission Balance' }));

    await waitFor(() => expect(H.rpc.some(({ name }) => name === 'get_commission_payment_detail_report')).toBe(true));
    H.rpc = [];

    fireEvent.click(screen.getByRole('button', { name: 'This Season' }));

    await waitFor(() => {
      const balance = H.rpc.find(({ name }) => name === 'get_commission_balance_report');
      const detail = H.rpc.find(({ name }) => name === 'get_commission_payment_detail_report');
      expect(balance?.args.p_as_of_date).toBe(businessToday);
      expect(detail?.args.p_as_of_date).toBe(businessToday);
    });
  });
});
