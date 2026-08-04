import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockFrom, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
}));

type QueryResult = { data: unknown; error: { message: string } | null };

function buildChain(result: QueryResult): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const method of ['select', 'update', 'eq', 'gt', 'is', 'in', 'order', 'limit']) {
    self[method] = vi.fn(() => self);
  }
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom },
  checkMutationResult: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/customers/BulkCustomerImport', () => ({ default: () => null }));

import Customers from './Customers';

const REP_A = '11111111-1111-4111-8111-111111111111';
const REP_B = '22222222-2222-4222-8222-222222222222';

function customer(overrides: Record<string, unknown>) {
  return {
    id: 'c-default', farm_name: 'Farm', contact_name: 'Contact', phone: '555-0000', email: null,
    assigned_tier: 1, assigned_sales_rep: null, total_acres: 100, is_active: true,
    created_at: '2026-01-01T00:00:00Z', ...overrides,
  };
}

const book = [
  customer({ id: 'c-1', farm_name: 'Active Assigned Farm', assigned_sales_rep: REP_A }),
  customer({ id: 'c-2', farm_name: 'Active Unassigned Farm', assigned_sales_rep: null }),
  customer({ id: 'c-3', farm_name: 'Retired Farm', is_active: false, assigned_sales_rep: REP_B }),
];

function mockTables(customers: unknown[]) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'customers') return buildChain({ data: customers, error: null });
    if (table === 'profile_public_view') {
      return buildChain({ data: [{ id: REP_A, full_name: 'Dana Rep' }, { id: REP_B, full_name: 'Sam Rep' }], error: null });
    }
    return buildChain({ data: [], error: null });
  });
}

function renderCustomers() {
  return render(<MemoryRouter><Customers /></MemoryRouter>);
}

describe('Customers list filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTables(book);
  });

  it('defaults to the active book and can switch to inactive and all', async () => {
    renderCustomers();
    expect(await screen.findByText('Active Assigned Farm')).toBeInTheDocument();
    // Deactivated customers used to stay mixed into the list forever.
    expect(screen.queryByText('Retired Farm')).not.toBeInTheDocument();

    const statusFilter = screen.getByLabelText('Filter by status');
    fireEvent.change(statusFilter, { target: { value: 'inactive' } });
    expect(await screen.findByText('Retired Farm')).toBeInTheDocument();
    expect(screen.queryByText('Active Assigned Farm')).not.toBeInTheDocument();

    fireEvent.change(statusFilter, { target: { value: 'all' } });
    expect(await screen.findByText('Retired Farm')).toBeInTheDocument();
    expect(screen.getByText('Active Assigned Farm')).toBeInTheDocument();
  });

  it('filters by assigned rep and by unassigned, resolving rep names in the column', async () => {
    renderCustomers();
    // Rendered twice on purpose: once as the row's resolved rep name, once as
    // the filter option for that rep.
    await waitFor(() => expect(screen.getAllByText('Dana Rep')).toHaveLength(2));

    const repFilter = screen.getByLabelText('Filter by sales rep');
    fireEvent.change(repFilter, { target: { value: REP_A } });
    expect(await screen.findByText('Active Assigned Farm')).toBeInTheDocument();
    expect(screen.queryByText('Active Unassigned Farm')).not.toBeInTheDocument();

    fireEvent.change(repFilter, { target: { value: '__unassigned__' } });
    expect(await screen.findByText('Active Unassigned Farm')).toBeInTheDocument();
    expect(screen.queryByText('Active Assigned Farm')).not.toBeInTheDocument();
  });

  it('surfaces active customers with no sales rep and jumps to them', async () => {
    renderCustomers();
    expect(await screen.findByText(/1 active customer has no assigned sales rep/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(screen.queryByText('Active Assigned Farm')).not.toBeInTheDocument());
    expect(screen.getByText('Active Unassigned Farm')).toBeInTheDocument();
  });

  it('warns instead of silently truncating when the fetch cap is hit', async () => {
    const capped = Array.from({ length: 1000 }, (_, i) => customer({ id: `c-${i}`, farm_name: `Farm ${i}` }));
    mockTables(capped);
    renderCustomers();
    expect(await screen.findByText(/this list is truncated/)).toBeInTheDocument();
  });

  it('does not warn about truncation below the cap', async () => {
    renderCustomers();
    await screen.findByText('Active Assigned Farm');
    expect(screen.queryByText(/this list is truncated/)).not.toBeInTheDocument();
  });
});
