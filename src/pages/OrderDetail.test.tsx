/**
 * OrderDetail.test.tsx — Tests for the order detail page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
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

function buildPendingChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = new Promise(() => {});
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
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

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: vi.fn() }));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
}));
vi.mock('../lib/dateUtils', () => ({
  parseLocalDate: vi.fn((d: string) => new Date(d)),
}));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));

import OrderDetail from './OrderDetail';

function renderOrderDetail(id = 'ord-123') {
  return render(
    <MemoryRouter initialEntries={[`/orders/${id}`]}>
      <Routes>
        <Route path="/orders/:id" element={<OrderDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrderDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('shows loading skeleton while fetching', () => {
    mockFrom.mockImplementation(() => buildPendingChain());
    renderOrderDetail();
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows order not found for invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderOrderDetail('bad-id');
    await waitFor(() => {
      expect(screen.getByText('Order not found')).toBeInTheDocument();
    });
  });

  it('renders order detail when data loads', async () => {
    const orderData = {
      id: 'ord-123',
      order_number: 'ORD-0099',
      status: 'confirmed',
      customer_id: 'cust-1',
      order_date: '2026-03-15',
      total_cents: 50000,
      total_cost: 30000,
      total_price: 50000,
      total_profit: 20000,
      total_margin_pct: 40.0,
      order_name: 'Spring Order',
      notes: '',
      created_at: '2026-03-15T00:00:00Z',
      delivery_priority: 'normal',
      po_number: null,
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        return buildChain({ data: orderData, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderOrderDetail();
    await waitFor(() => {
      const matches = screen.getAllByText('ORD-0099');
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('#67: shows a plain Cancel Order action on a confirmed order, not the old dead-option Change Status dropdown', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    mockFrom.mockImplementation((table: string) =>
      table === 'orders' ? buildChain({ data: orderData, error: null }) : buildChain({ data: [], error: null }),
    );
    renderOrderDetail();
    // The only manual status transition the handler allows is → cancelled, so #67
    // replaced the dropdown (whose fulfilled/partially_fulfilled options always
    // errored) with one honest Cancel Order action.
    await waitFor(() => expect(screen.getByText('Cancel Order')).toBeInTheDocument());
    expect(screen.queryByText('Change Status')).not.toBeInTheDocument();
  });
});
