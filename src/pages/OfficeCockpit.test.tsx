import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mockNavigate = vi.fn();
const mockToast = vi.fn();

function emptyQuery(table: string) {
  const builder: Record<string, unknown> = {};
  let selection = '';
  const self = () => builder;
  builder.select = vi.fn((columns: string) => {
    selection = columns;
    return builder;
  });
  for (const method of ['eq', 'is', 'order', 'limit', 'in', 'gte', 'lte', 'lt', 'gt', 'not']) {
    builder[method] = vi.fn(self);
  }
  builder.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve({
      data: table === 'jobs' && selection.includes('total_price_cents')
        ? [{
            id: 'job-1',
            job_number: 'JOB-1',
            job_date: '2026-07-11',
            total_acres: 80,
            total_price_cents: 125000,
            customer: { farm_name: 'Test Farm' },
          }]
        : [],
      error: null,
    }).then(resolve)
  );
  return builder;
}

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { role: 'admin' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../lib/db', async () => ({
  supabase: {
    from: vi.fn((table: string) => emptyQuery(table)),
    rpc: vi.fn((functionName: string) => {
      if (functionName === 'operational_dashboard_summary') {
        return Promise.resolve({
          data: {
            active_orders_count: 7,
            open_quotes_draft: 2,
            open_quotes_sent: 3,
            pending_deliveries_count: 4,
            open_pos_count: 5,
            inventory_available: 1200,
            inventory_prebooked: 300,
            on_order_units: 450,
            on_order_po_count: 2,
            committed_units: 600,
            committed_order_count: 8,
          },
          error: null,
        });
      }
      if (functionName === 'financial_dashboard_summary') {
        return Promise.resolve({
          data: {
            open_ar_balance: 12345.67,
            total_profit: 5000,
            total_prepay_unallocated: 2000,
            po_unreceived_value: 1000,
            customers_over_credit_count: 0,
            ar_aging_buckets: { days_61_90: 0, days_90_plus: 0 },
          },
          error: null,
        });
      }
      if (functionName === 'get_program_completion') {
        return Promise.resolve({ data: [{ completion_pct: 75 }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
  },
  supabaseUntyped: {
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  },
  assertRpcResult: vi.fn((data: unknown) => data),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: { INVOICE_ALREADY_POSTED: 'INVOICE_ALREADY_POSTED' },
  // The REAL sanitizeError, never a stub. The previous stub returned the error
  // OBJECT rather than a string, so a screen that rendered its result would have
  // been asserted against a value the real function can never produce.
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  )).sanitizeError,
}));

vi.mock('../lib/idempotency', () => ({
  generateIdempotencyKey: vi.fn(() => 'key'),
}));

vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: vi.fn(),
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

import OfficeCockpit from './OfficeCockpit';

describe('OfficeCockpit morning screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the action queues before the KPI, money, and inventory summaries', async () => {
    render(<OfficeCockpit />);

    const snapshotHeading = await screen.findByRole('heading', { name: 'Morning Snapshot' });
    const queueHeading = screen.getByRole('heading', { name: /Unbilled Jobs/ });
    const inventoryHeading = screen.getByRole('heading', { name: 'Inventory Position' });
    const quickActionsHeading = screen.getByRole('heading', { name: /Quick\s*Actions/ });

    expect(queueHeading.compareDocumentPosition(snapshotHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(snapshotHeading.compareDocumentPosition(inventoryHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inventoryHeading.compareDocumentPosition(quickActionsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Active Orders')).toBeInTheDocument();
    expect(screen.getByText('Program Progress')).toBeInTheDocument();
    expect(screen.getByText('Floor Stock')).toBeInTheDocument();
    expect(await screen.findByText('$12,345.67')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('button', { name: /Active Orders/ }), { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/orders');
  });

  it('uses a one-column 375px layout and 44px queue targets', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    window.dispatchEvent(new Event('resize'));

    const { container } = render(<OfficeCockpit />);

    const queueRow = (await screen.findByText('#JOB-1')).closest('button');
    const snapshotGrid = screen.getByText('Active Orders').closest('[class*="grid-cols-1"]');
    const page = container.firstElementChild;

    expect(page).toHaveClass('min-w-0', 'p-4', 'sm:p-6');
    expect(queueRow).toHaveClass('min-h-[44px]');
    expect(snapshotGrid).toHaveClass('grid-cols-1', 'sm:grid-cols-2');
    expect(screen.getByText('Floor Stock').closest('[class*="grid-cols-1"]')).toHaveClass('grid-cols-1');
    expect(screen.getByText('Sell & Deliver Now').closest('[class*="grid-cols-1"]')).toHaveClass('grid-cols-1');
  });
});
