import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, dirtyStates } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  dirtyStates: [] as boolean[],
}));

type QueryResult = { data: unknown; error: unknown };

function query(result: QueryResult): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const self = (..._args: unknown[]) => chain;
  for (const name of ['eq', 'neq', 'is', 'in', 'order', 'limit', 'single', 'maybeSingle', 'insert', 'update', 'delete', 'select']) {
    chain[name] = self;
  }
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

function customerQuery(nextCustomer: () => typeof original | typeof newer): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  let result: QueryResult = { data: [], error: null };
  const self = (..._args: unknown[]) => chain;
  for (const name of ['eq', 'neq', 'is', 'in', 'order', 'limit', 'single', 'maybeSingle', 'insert', 'update', 'delete']) chain[name] = self;
  chain.select = (columns: unknown) => {
    if (columns === '*' || columns === 'row_version') {
      const current = nextCustomer();
      result = columns === '*' ? { data: current, error: null } : { data: { row_version: current.row_version }, error: null };
    } else {
      result = { data: [{ id: 'customer-1', farm_name: 'Original Farm' }], error: null };
    }
    return chain;
  };
  chain.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject: (reason: unknown) => unknown) => Promise.resolve(result).catch(reject);
  chain.finally = (callback: () => void) => Promise.resolve(result).finally(callback);
  return chain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: vi.fn((value) => value),
  checkMutationResult: vi.fn(),
  hasRpcCode: (error: { message?: string }, code: string) => error.message?.includes(code) ?? false,
  RpcErrorCodes: { CUSTOMER_STALE_WRITE: 'CUSTOMER_STALE_WRITE', QUOTE_STALE_WRITE: 'QUOTE_STALE_WRITE', COMMISSION_SPLIT_CONFLICT: 'COMMISSION_SPLIT_CONFLICT' },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin', full_name: 'Admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'customer-stale-key', resetKey: vi.fn() }) }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: (dirty: boolean) => { dirtyStates.push(dirty); return { state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }; } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/ui/CommissionSplitEditor', () => ({ default: () => <div /> }));
vi.mock('../components/field-app/ApplicationServicePicker', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerSummaryBar', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerContacts', () => ({ default: () => <div />, CustomerInteractionsHistory: () => <div /> }));
vi.mock('../components/customers/CustomerFacts', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerPrepCard', () => ({ default: () => <div /> }));
vi.mock('../components/customers/CustomerDocuments', () => ({ default: () => <div /> }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));

import CustomerDetail from './CustomerDetail';

const original = {
  id: 'customer-1', farm_name: 'Original Farm', contact_name: 'Original Contact', assigned_tier: 1,
  assigned_sales_rep: 'admin-1', is_active: true, default_commission_split: { splits: [] }, crops: [], row_version: 4,
};
const newer = { ...original, farm_name: 'Newer Farm', contact_name: 'Newer Contact', row_version: 5 };

function renderDetail() {
  return render(<MemoryRouter initialEntries={['/customers/customer-1']}><Routes><Route path="/customers/:id" element={<CustomerDetail />} /></Routes></MemoryRouter>);
}

describe('CustomerDetail stale whole-record save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dirtyStates.length = 0;
    let customerReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') {
        return customerQuery(() => {
          customerReads += 1;
          return customerReads <= 2 ? original : newer;
        });
      }
      return query({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'CUSTOMER_STALE_WRITE' } });
  });

  it('keeps unsaved input until an explicit Reload Customer installs the newer row and clears dirty navigation state', async () => {
    renderDetail();
    const farmName = await screen.findByDisplayValue('Original Farm');
    fireEvent.change(farmName, { target: { value: 'Unsaved Farm Edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await screen.findByRole('button', { name: 'Reload Customer' });
    expect(mockRpc).toHaveBeenCalledWith('save_customer', expect.objectContaining({
      p_customer_payload: expect.objectContaining({ row_version_expected: 4, farm_name: 'Unsaved Farm Edit' }),
    }));
    const readsBeforeKeepEditing = mockFrom.mock.calls.filter(([table]) => table === 'customers').length;
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Customer' })).not.toBeInTheDocument());
    expect((screen.getByDisplayValue('Unsaved Farm Edit') as HTMLInputElement).value).toBe('Unsaved Farm Edit');
    expect(mockFrom.mock.calls.filter(([table]) => table === 'customers')).toHaveLength(readsBeforeKeepEditing);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByRole('button', { name: 'Reload Customer' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload Customer' }));
    await waitFor(() => expect((screen.getByDisplayValue('Newer Farm') as HTMLInputElement).value).toBe('Newer Farm'));
    expect(screen.queryByRole('button', { name: 'Reload Customer' })).not.toBeInTheDocument();
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(false));
  });

  it('keeps the conflict dialog and local customer/address state when Reload cannot read addresses', async () => {
    let customerReads = 0;
    let addressReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') {
        return customerQuery(() => {
          customerReads += 1;
          return customerReads <= 2 ? original : newer;
        });
      }
      if (table === 'customer_addresses') {
        addressReads += 1;
        return query(addressReads === 1
          ? { data: [], error: null }
          : { data: null, error: { message: 'addresses unavailable' } });
      }
      return query({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'CUSTOMER_STALE_WRITE' } });

    renderDetail();
    const farmName = await screen.findByDisplayValue('Original Farm');
    fireEvent.change(farmName, { target: { value: 'Keep this customer edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByRole('button', { name: 'Reload Customer' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload Customer' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('current edits were kept')));
    expect(screen.getByRole('button', { name: 'Reload Customer' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this customer edit')).toBeInTheDocument();
  });

  it('keeps the conflict dialog and local customer when the header version changes during Reload', async () => {
    let customerReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') {
        return customerQuery(() => {
          customerReads += 1;
          if (customerReads <= 2) return original;
          if (customerReads === 3) return newer;
          return { ...newer, row_version: 6 };
        });
      }
      return query({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'CUSTOMER_STALE_WRITE' } });
    renderDetail();
    const farmName = await screen.findByDisplayValue('Original Farm');
    fireEvent.change(farmName, { target: { value: 'Keep this customer edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByRole('button', { name: 'Reload Customer' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload Customer' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('stable saved customer')));
    expect(screen.getByRole('button', { name: 'Reload Customer' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this customer edit')).toBeInTheDocument();
  });
});
