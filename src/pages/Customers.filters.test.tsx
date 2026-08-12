import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  mockFrom,
  mockRpc,
  mockToast,
  mockCheckMutationResult,
  mockGetAssignmentKey,
  mockResetAssignmentKey,
  mockAuth,
  capturedChains,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockCheckMutationResult: vi.fn(),
  mockGetAssignmentKey: vi.fn(),
  mockResetAssignmentKey: vi.fn(),
  mockAuth: { profile: { id: 'admin-1', role: 'admin' } as { id: string; role: string } | null },
  capturedChains: [] as Array<{ table: string; chain: Record<string, unknown> }>,
}));

type QueryResult = { data: unknown; error: { message: string } | null; count?: number | null };

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
  supabaseUntyped: { rpc: mockRpc },
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) throw new Error(`${rpcName} returned no data`);
    return data;
  },
  checkMutationResult: mockCheckMutationResult,
  RpcErrorCodes: {
    ASSIGNMENT_SALES_REP_INACTIVE: 'ASSIGNMENT_SALES_REP_INACTIVE',
    ASSIGNMENT_CUSTOMER_SET_CHANGED: 'ASSIGNMENT_CUSTOMER_SET_CHANGED',
    ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH: 'ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH',
  },
  hasRpcCode: (error: unknown, code: string) => {
    const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error ?? '');
    return message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `);
  },
}));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: mockGetAssignmentKey, resetKey: mockResetAssignmentKey }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/customers/BulkCustomerImport', () => ({ default: () => null }));

import Customers from './Customers';

const REP_A = '11111111-1111-4111-8111-111111111111';
const REP_B = '22222222-2222-4222-8222-222222222222';

function customer(overrides: Record<string, unknown>) {
  return {
    id: 'c-default', farm_name: 'Farm', contact_name: 'Contact', phone: '555-0000', email: null,
    crops: ['corn'], assigned_tier: 1, assigned_sales_rep: null, total_acres: 100, is_active: true,
    created_at: '2026-01-01T00:00:00Z', ...overrides,
  };
}

const book = [
  customer({ id: 'c-1', farm_name: 'Active Assigned Farm', assigned_sales_rep: REP_A }),
  customer({ id: 'c-2', farm_name: 'Active Unassigned Farm', assigned_sales_rep: null }),
  customer({ id: 'c-3', farm_name: 'Retired Farm', is_active: false, assigned_sales_rep: REP_B }),
];

// `count` is the TOTAL matching rows the server reports, which is independent of
// how many the capped page returned — that difference is the whole point of the
// truncation warning. Defaults to null, the "server did not report one" case, so
// every test that predates the count reads through the page-length fallback.
const profileRows = [
  { id: REP_A, full_name: 'Dana Rep', role: 'sales_rep', is_active: true },
  { id: REP_B, full_name: 'Sam Rep', role: 'sales_rep', is_active: false },
  { id: '33333333-3333-4333-8333-333333333333', full_name: 'Alex Admin', role: 'admin', is_active: true },
];

function mockTables(
  customers: unknown[],
  count: number | null = null,
  customerResults: QueryResult[] = [{ data: customers, error: null, count }],
  profileResults: QueryResult[] = [{ data: profileRows, error: null }],
) {
  const queues: Record<string, QueryResult[]> = {
    customers: [...customerResults],
    profile_public_view: [...profileResults],
  };
  mockFrom.mockImplementation((table: string) => {
    const queue = queues[table] ?? [{ data: [], error: null }];
    const result = queue.length > 1 ? queue.shift()! : queue[0];
    const chain = buildChain(result);
    capturedChains.push({ table, chain });
    return chain;
  });
}

function renderCustomers() {
  return render(<MemoryRouter><Customers /></MemoryRouter>);
}

async function selectCustomer(farmName: string) {
  const farm = await screen.findByText(farmName);
  const row = farm.closest('tr');
  const checkbox = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).toBeTruthy();
  fireEvent.click(checkbox!);
}

describe('Customers list filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedChains.splice(0);
    mockAuth.profile = { id: 'admin-1', role: 'admin' };
    mockGetAssignmentKey.mockReturnValue('assignment-key-1');
    mockCheckMutationResult.mockImplementation((result: QueryResult) => {
      if (result.error) throw result.error;
      if (result.data === null || result.data === undefined || (Array.isArray(result.data) && result.data.length === 0)) {
        throw new Error('Assign sales rep failed: no rows were affected. You may not have permission.');
      }
    });
    mockRpc.mockImplementation((_rpcName: string, args: { p_customer_ids: string[]; p_sales_rep_id: string }) => Promise.resolve({
      data: {
        success: true,
        assigned_count: args.p_customer_ids.length,
        customer_ids: [...args.p_customer_ids].sort(),
        sales_rep_id: args.p_sales_rep_id,
      },
      error: null,
    }));
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

  it('warns instead of silently truncating when there are more customers than the cap', async () => {
    const capped = Array.from({ length: 1000 }, (_, i) => customer({ id: `c-${i}`, farm_name: `Farm ${i}` }));
    mockTables(capped, 1500);
    renderCustomers();
    expect(await screen.findByText(/this list is truncated/)).toBeInTheDocument();
  });

  // A full page is not the same fact as a truncated one. A book of exactly the cap
  // returns every customer there is, so warning would tell Mason rows are hidden
  // when none are — the page-length test alone could not tell the two apart.
  it('does not warn when the book is exactly the cap and all of it is shown', async () => {
    const exact = Array.from({ length: 1000 }, (_, i) => customer({ id: `c-${i}`, farm_name: `Farm ${i}` }));
    mockTables(exact, 1000);
    renderCustomers();
    await screen.findByText('Farm 0');
    expect(screen.queryByText(/this list is truncated/)).not.toBeInTheDocument();
  });

  it('does not warn about truncation below the cap', async () => {
    renderCustomers();
    await screen.findByText('Active Assigned Farm');
    expect(screen.queryByText(/this list is truncated/)).not.toBeInTheDocument();
  });

  it('shows the bulk assignment action to admins only', async () => {
    mockAuth.profile = { id: REP_A, role: 'sales_rep' };
    renderCustomers();
    await selectCustomer('Active Assigned Farm');
    expect(screen.queryByRole('button', { name: 'Assign sales rep' })).not.toBeInTheDocument();
  });

  it('offers only active sales reps and confirms the selected count and target', async () => {
    renderCustomers();
    await selectCustomer('Active Assigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));

    const dialog = screen.getByRole('dialog', { name: 'Assign sales representative' });
    const repSelect = within(dialog).getByLabelText('Sales representative');
    expect(within(repSelect).getByRole('option', { name: 'Dana Rep' })).toBeInTheDocument();
    expect(within(repSelect).queryByRole('option', { name: /Sam Rep/ })).not.toBeInTheDocument();
    expect(within(repSelect).queryByRole('option', { name: 'Alex Admin' })).not.toBeInTheDocument();

    fireEvent.change(repSelect, { target: { value: REP_A } });
    expect(within(dialog).getByText('Assign 1 selected customer to Dana Rep?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Assign sales representative' })).not.toBeInTheDocument();
    expect(capturedChains
      .filter(({ table }) => table === 'customers')
      .some(({ chain }) => (chain.update as ReturnType<typeof vi.fn>).mock.calls.length > 0))
      .toBe(false);
  });

  it.each([
    ['query error', { data: null, error: { message: 'directory unavailable' } }],
    ['no-data response', { data: null, error: null }],
  ])('fails closed and retries when the active sales-rep directory returns a %s', async (_case, failedResult) => {
    mockTables(book, book.length, [{ data: book, error: null, count: book.length }], [
      failedResult,
      { data: profileRows, error: null },
    ]);
    renderCustomers();
    await selectCustomer('Active Assigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));

    const dialog = screen.getByRole('dialog', { name: 'Assign sales representative' });
    const repSelect = within(dialog).getByLabelText('Sales representative');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    expect(repSelect).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Assign customers' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry loading sales reps' }));

    await waitFor(() => expect(within(repSelect).getByRole('option', { name: 'Dana Rep' })).toBeInTheDocument());
    expect(repSelect).toBeEnabled();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('assigns the selected active customers, verifies the mutation, refetches, and clears selection', async () => {
    const assignedBook = book.map((row) => (
      row.id === 'c-2' ? { ...row, assigned_sales_rep: REP_A } : row
    ));
    mockTables(book, book.length, [
      { data: book, error: null, count: book.length },
      { data: assignedBook, error: null, count: assignedBook.length },
    ]);
    renderCustomers();
    await selectCustomer('Active Unassigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));
    fireEvent.change(screen.getByLabelText('Sales representative'), { target: { value: REP_A } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Assigned 1 customer to Dana Rep'));
    expect(mockRpc).toHaveBeenCalledWith('assign_customers_sales_rep', {
      p_customer_ids: ['c-2'],
      p_sales_rep_id: REP_A,
      p_idempotency_key: 'assignment-key-1',
    });
    const customerChains = capturedChains.filter(({ table }) => table === 'customers');
    expect(customerChains).toHaveLength(2);
    expect(mockCheckMutationResult).not.toHaveBeenCalled();
    expect(mockResetAssignmentKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('keeps the assignment retryable when the atomic RPC rejects an inactive rep', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'ASSIGNMENT_SALES_REP_INACTIVE' } });
    renderCustomers();
    await selectCustomer('Active Assigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));
    const repSelect = screen.getByLabelText('Sales representative');
    await waitFor(() => expect(within(repSelect).getByRole('option', { name: 'Dana Rep' })).toBeInTheDocument());
    fireEvent.change(repSelect, { target: { value: REP_A } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/no longer active/i)));
    expect(capturedChains.filter(({ table }) => table === 'customers')).toHaveLength(1);
    expect(mockResetAssignmentKey).not.toHaveBeenCalled();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Assign sales representative' })).toBeInTheDocument();
  });

  it('does not report success or leave stale ownership when the post-assignment refetch fails', async () => {
    mockTables(book, book.length, [
      { data: book, error: null, count: book.length },
      { data: null, error: { message: 'refresh failed' } },
    ]);
    renderCustomers();
    await selectCustomer('Active Unassigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));
    fireEvent.change(screen.getByLabelText('Sales representative'), { target: { value: REP_A } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/saved.*refresh/i)));
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.any(String));
    expect(within(screen.getByText('Active Unassigned Farm').closest('tr')!).getByText('Dana Rep')).toBeInTheDocument();
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(mockResetAssignmentKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty RPC response', { data: null, error: null }],
    ['network failure', { data: null, error: { message: 'network failed' } }],
  ])('keeps the selection retryable and never reports success after %s', async (_label, mutationResult) => {
    mockRpc.mockResolvedValue(mutationResult);
    renderCustomers();
    await selectCustomer('Active Assigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));
    fireEvent.change(screen.getByLabelText('Sales representative'), { target: { value: REP_A } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.any(String)));
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.any(String));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Assign sales representative' })).toBeInTheDocument();
    expect(capturedChains.filter(({ table }) => table === 'customers')).toHaveLength(1);
    expect(mockResetAssignmentKey).not.toHaveBeenCalled();
  });

  it('clears an ambiguous selection after an exact-set change so an inactive row cannot poison retries', async () => {
    const refreshedBook = book.map((row) => (
      row.id === 'c-2' ? { ...row, is_active: false } : row
    ));
    mockTables(book, book.length, [
      { data: book, error: null, count: book.length },
      { data: refreshedBook, error: null, count: refreshedBook.length },
    ]);
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'ASSIGNMENT_CUSTOMER_SET_CHANGED: 1 of 2 active customers matched; no assignments were saved' },
    });
    renderCustomers();
    await selectCustomer('Active Assigned Farm');
    await selectCustomer('Active Unassigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));
    fireEvent.change(screen.getByLabelText('Sales representative'), { target: { value: REP_A } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/nothing was assigned.*reselect active customers.*refreshed list/i),
    ));
    expect(mockRpc).toHaveBeenCalledWith('assign_customers_sales_rep', {
      p_customer_ids: ['c-1', 'c-2'],
      p_sales_rep_id: REP_A,
      p_idempotency_key: 'assignment-key-1',
    });
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.any(String));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Assign sales representative' })).not.toBeInTheDocument();
    expect(screen.queryByText('Active Unassigned Farm')).not.toBeInTheDocument();
    expect(capturedChains.filter(({ table }) => table === 'customers')).toHaveLength(2);
    expect(mockResetAssignmentKey).toHaveBeenCalledTimes(1);
  });

  it('reports a required reload instead of claiming a refreshed selection when set-change recovery fails', async () => {
    mockTables(book, book.length, [
      { data: book, error: null, count: book.length },
      { data: null, error: { message: 'refresh failed' } },
    ]);
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'ASSIGNMENT_CUSTOMER_SET_CHANGED: 1 of 2 active customers matched; no assignments were saved' },
    });
    renderCustomers();
    await selectCustomer('Active Assigned Farm');
    await selectCustomer('Active Unassigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));
    fireEvent.change(screen.getByLabelText('Sales representative'), { target: { value: REP_A } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/could not refresh.*reload/i),
    ));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringMatching(/reselect.*refreshed/i));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Assign sales representative' })).not.toBeInTheDocument();
    expect(capturedChains.filter(({ table }) => table === 'customers')).toHaveLength(2);
    expect(mockResetAssignmentKey).toHaveBeenCalledTimes(1);
  });

  it('rotates the rejected key after a replay-payload mismatch so the same intent can retry', async () => {
    const assignedBook = book.map((row) => (
      row.id === 'c-2' ? { ...row, assigned_sales_rep: REP_A } : row
    ));
    mockTables(book, book.length, [
      { data: book, error: null, count: book.length },
      { data: assignedBook, error: null, count: assignedBook.length },
    ]);
    mockGetAssignmentKey
      .mockReturnValueOnce('assignment-key-rejected')
      .mockReturnValue('assignment-key-retry');
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH: key belongs to another assignment' },
    });
    renderCustomers();
    await selectCustomer('Active Unassigned Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Assign sales rep' }));
    fireEvent.change(screen.getByLabelText('Sales representative'), { target: { value: REP_A } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/selection changed/i)));
    expect(mockResetAssignmentKey).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Assign customers' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Assigned 1 customer to Dana Rep'));
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'assign_customers_sales_rep', expect.objectContaining({
      p_idempotency_key: 'assignment-key-rejected',
    }));
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'assign_customers_sales_rep', expect.objectContaining({
      p_idempotency_key: 'assignment-key-retry',
    }));
    expect(mockResetAssignmentKey).toHaveBeenCalledTimes(2);
  });

  it('labels every core profile gap without implying compliance or credit checks', async () => {
    const readinessBook = [
      customer({ id: 'gap-rep', farm_name: 'Missing Rep Farm', assigned_sales_rep: null, email: 'rep@example.com' }),
      customer({ id: 'gap-phone', farm_name: 'Missing Phone Farm', assigned_sales_rep: REP_A, phone: null, email: 'phone@example.com' }),
      customer({ id: 'gap-email', farm_name: 'Missing Email Farm', assigned_sales_rep: REP_A, email: null }),
      customer({ id: 'gap-crops', farm_name: 'Missing Crops Farm', assigned_sales_rep: REP_A, email: 'crops@example.com', crops: [] }),
      customer({ id: 'ready', farm_name: 'Ready Farm', assigned_sales_rep: REP_A, email: 'ready@example.com' }),
    ];
    mockTables(readinessBook, readinessBook.length);
    renderCustomers();

    const expectations = [
      ['Missing Rep Farm', 'Missing rep'],
      ['Missing Phone Farm', 'Missing phone'],
      ['Missing Email Farm', 'Missing email'],
      ['Missing Crops Farm', 'Missing crops'],
      ['Ready Farm', 'Core profile ready'],
    ];
    for (const [farmName, label] of expectations) {
      const farm = await screen.findByText(farmName);
      expect(within(farm.closest('tr')!).getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/license|compliance|credit checked/i)).not.toBeInTheDocument();
  });

  it('filters independently for each core profile gap and ready records', async () => {
    const readinessBook = [
      customer({ id: 'gap-rep', farm_name: 'Missing Rep Farm', assigned_sales_rep: null, email: 'rep@example.com' }),
      customer({ id: 'gap-phone', farm_name: 'Missing Phone Farm', assigned_sales_rep: REP_A, phone: null, email: 'phone@example.com' }),
      customer({ id: 'gap-email', farm_name: 'Missing Email Farm', assigned_sales_rep: REP_A, email: null }),
      customer({ id: 'gap-crops', farm_name: 'Missing Crops Farm', assigned_sales_rep: REP_A, email: 'crops@example.com', crops: [] }),
      customer({ id: 'ready', farm_name: 'Ready Farm', assigned_sales_rep: REP_A, email: 'ready@example.com' }),
    ];
    mockTables(readinessBook, readinessBook.length);
    renderCustomers();
    await screen.findByText('Ready Farm');

    const needsFilter = screen.getByLabelText('Filter by profile needs');
    expect(needsFilter).toHaveClass('min-h-11');
    const cases = [
      ['missing-rep', 'Missing Rep Farm'],
      ['missing-phone', 'Missing Phone Farm'],
      ['missing-email', 'Missing Email Farm'],
      ['missing-crops', 'Missing Crops Farm'],
      ['ready', 'Ready Farm'],
    ];
    for (const [value, visibleFarm] of cases) {
      fireEvent.change(needsFilter, { target: { value } });
      expect(await screen.findByText(visibleFarm)).toBeInTheDocument();
      for (const [, otherFarm] of cases) {
        if (otherFarm !== visibleFarm) expect(screen.queryByText(otherFarm)).not.toBeInTheDocument();
      }
    }
  });
});
