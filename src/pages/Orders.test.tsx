import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  mockFrom,
  mockToast,
  mockCheckMutationResult,
  mockClearSelection,
  selectedOrder,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockCheckMutationResult: vi.fn(),
  mockClearSelection: vi.fn(),
  selectedOrder: {
    id: 'order-1',
    order_number: 'ORD-DELETE-1',
    customer_id: 'customer-1',
    status: 'confirmed' as 'confirmed' | 'cancelled' | 'voided',
  },
}));

type QueryResult = { data: unknown; error: { message: string } | null };
type QueryChain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<QueryResult>;

function buildChain(result: QueryResult): QueryChain {
  const self: Record<string, unknown> = {};
  for (const method of [
    'select', 'update', 'eq', 'gte', 'lte', 'is', 'in', 'not', 'order', 'limit',
  ]) {
    self[method] = vi.fn(() => self);
  }
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  return self as QueryChain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom },
  checkMutationResult: mockCheckMutationResult,
  sanitizeError: (error: unknown) => error instanceof Error ? error.message : 'Request failed',
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', deniedPages: [] }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useRowSelection', () => ({
  useRowSelection: () => ({
    selected: new Set(['order-1']),
    toggleSelect: vi.fn(),
    toggleAll: vi.fn(),
    clearSelection: mockClearSelection,
    selectedCount: 1,
    selectedRows: [selectedOrder],
    allSelected: true,
  }),
  createCheckboxColumn: () => ({ key: 'select', header: '' }),
}));

vi.mock('../components/ui/PageHeader', () => ({
  default: ({ actions }: { actions?: ReactNode }) => <div>{actions}</div>,
}));
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data }: { data: Array<{ id: string; invoiced_pct: number }> }) => (
    <div>
      orders table
      {data.map((row) => <span key={row.id}>Invoiced {row.invoiced_pct}%</span>)}
    </div>
  ),
}));
vi.mock('../components/ui/BulkDeleteConfirmModal', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open
    ? <button onClick={onConfirm}>Confirm order delete</button>
    : null,
}));
vi.mock('../components/orders/BulkOrderImport', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerDrawer', () => ({ default: () => null }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import Orders from './Orders';

function renderPage() {
  return render(<MemoryRouter><Orders /></MemoryRouter>);
}

describe('Orders bulk-delete lifecycle guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedOrder.status = 'confirmed';
    mockCheckMutationResult.mockImplementation((result: QueryResult) => {
      if (result.error) throw new Error(result.error.message);
    });
  });

  function arrange(mutationResult: QueryResult) {
    const load = buildChain({ data: [], error: null });
    const mutation = buildChain(mutationResult);
    let orderCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        orderCalls += 1;
        return orderCalls === 2 ? mutation : load;
      }
      return buildChain({ data: [], error: null });
    });
    return mutation;
  }

  it('refuses an active selected order before opening confirmation', async () => {
    const mutation = arrange({ data: [{ id: 'order-1' }], error: null });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 selected order(s) are still active. Cancel or void them first, then delete them.',
    );
    expect(screen.queryByRole('button', { name: 'Confirm order delete' })).not.toBeInTheDocument();
    expect(mutation.update).not.toHaveBeenCalled();
  });

  it('soft-deletes a terminal selected order after confirmation', async () => {
    selectedOrder.status = 'cancelled';
    const mutation = arrange({ data: [{ id: 'order-1' }], error: null });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order delete' }));

    await waitFor(() => {
      expect(mutation.update).toHaveBeenCalledWith({ deleted_at: expect.any(String) });
      expect(mutation.in).toHaveBeenCalledWith('id', ['order-1']);
      expect(mockToast).toHaveBeenCalledWith('success', 'Deleted 1 order(s)');
    });
  });

  it('translates the database race guard into plain English', async () => {
    selectedOrder.status = 'voided';
    arrange({
      data: null,
      error: { message: 'ORDER_MUST_BE_TERMINAL_BEFORE_DELETE' },
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order delete' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        'An order became active before deletion. Refresh the list, then cancel or void it first.',
      );
    });
    expect(mockCheckMutationResult).not.toHaveBeenCalled();
  });

  it('calculates invoiced percent from active sale invoices only', async () => {
    const invoiceQuery = buildChain({
      data: [
        { order_id: 'order-1', total_amount_cents: 60000, invoice_type: 'chemical_sale', status: 'posted', deleted_at: null },
        { order_id: 'order-1', total_amount_cents: -15000, invoice_type: 'credit_memo', status: 'posted', deleted_at: null },
        { order_id: 'order-1', total_amount_cents: 40000, invoice_type: 'chemical_sale', status: 'posted', deleted_at: '2026-08-26T12:00:00Z' },
      ],
      error: null,
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        return buildChain({
          data: [{
            id: 'order-1', order_number: 'ORD-1', customer_id: 'customer-1',
            status: 'confirmed', order_date: '2026-04-01', total_price: 1000,
            customer: { farm_name: 'Test Farm', parent_customer_id: null },
          }],
          error: null,
        });
      }
      if (table === 'invoices') return invoiceQuery;
      return buildChain({ data: [], error: null });
    });

    renderPage();

    expect(await screen.findByText('Invoiced 60%')).toBeInTheDocument();
    expect(invoiceQuery.in).toHaveBeenCalledWith('order_id', ['order-1']);
  });
});
