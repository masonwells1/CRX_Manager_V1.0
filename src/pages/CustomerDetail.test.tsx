import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

const {
  mockFrom,
  mockRpc,
  mockToast,
  mockResetIdempotencyKey,
  customerIdempotencyState,
  dirtyStates,
} = vi.hoisted(() => {
  const customerIdempotencyState = { generation: 0 };
  return {
    mockFrom: vi.fn(),
    mockRpc: vi.fn(),
    mockToast: vi.fn(),
    mockResetIdempotencyKey: vi.fn(() => { customerIdempotencyState.generation += 1; }),
    customerIdempotencyState,
    dirtyStates: [] as boolean[],
  };
});

type QueryResult = { data: unknown; error: unknown };

function query(result: QueryResult): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const self = (..._args: unknown[]) => chain;
  for (const name of ['eq', 'neq', 'is', 'in', 'gt', 'order', 'limit', 'single', 'maybeSingle', 'insert', 'update', 'delete', 'select']) {
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
  let mutation = false;
  const self = (..._args: unknown[]) => chain;
  for (const name of ['eq', 'neq', 'is', 'in', 'order', 'limit', 'single', 'maybeSingle', 'insert', 'delete']) chain[name] = self;
  chain.update = (..._args: unknown[]) => {
    mutation = true;
    return chain;
  };
  chain.select = (columns: unknown) => {
    if (columns === '*' || columns === 'row_version') {
      const current = nextCustomer();
      result = columns === '*'
        ? { data: mutation ? [current] : current, error: null }
        : { data: { row_version: current.row_version }, error: null };
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
  RpcErrorCodes: { CUSTOMER_STALE_WRITE: 'CUSTOMER_STALE_WRITE', QUOTE_STALE_WRITE: 'QUOTE_STALE_WRITE', COMMISSION_SPLIT_CONFLICT: 'COMMISSION_SPLIT_CONFLICT', IDEMPOTENCY_PAYLOAD_CONFLICT: 'IDEMPOTENCY_PAYLOAD_CONFLICT' },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin', full_name: 'Admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKey: () => `customer-stale-key-${customerIdempotencyState.generation}`,
    resetKey: mockResetIdempotencyKey,
  }),
}));
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

/**
 * Jump to another customer WITHOUT unmounting CustomerDetail — exactly what the
 * command palette does from an open customer profile. The route element has no
 * key, so React Router keeps the same instance mounted across the :id change and
 * every per-customer cache inside it has to invalidate itself.
 */
function SwitchCustomerButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/customers/customer-2')}>Jump to customer 2</button>;
}

function renderDetailWithCustomerSwitch() {
  return render(
    <MemoryRouter initialEntries={['/customers/customer-1']}>
      <SwitchCustomerButton />
      <Routes><Route path="/customers/:id" element={<CustomerDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('CustomerDetail stale whole-record save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customerIdempotencyState.generation = 0;
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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('reloads a pre-migration Customer after a commission-split conflict without requiring a row-version token', async () => {
    const legacyOriginal = { ...original, row_version: undefined } as unknown as typeof original;
    const legacyNewer = { ...newer, row_version: undefined } as unknown as typeof original;
    let customerReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') {
        return customerQuery(() => {
          customerReads += 1;
          return customerReads <= 2 ? legacyOriginal : legacyNewer;
        });
      }
      return query({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'COMMISSION_SPLIT_CONFLICT: changed elsewhere' } });

    renderDetail();
    fireEvent.change(await screen.findByDisplayValue('Original Farm'), { target: { value: 'Unsaved legacy edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload Customer' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Customer' })).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('Newer Farm')).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('stable saved customer'));
  });

  it('recovers a legacy cached save after the migration boundary and releases its unusable key', async () => {
    let saveAttempts = 0;
    mockRpc.mockImplementation(() => {
      saveAttempts += 1;
      return Promise.resolve(saveAttempts === 1
        ? { data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } }
        : { data: { customer_id: original.id, row_version: 6 }, error: null });
    });

    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('button', { name: 'Reload Customer' })).toBeInTheDocument();
    expect(mockRpc).toHaveBeenLastCalledWith('save_customer', expect.objectContaining({
      p_idempotency_key: 'customer-stale-key-0',
    }));
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload Customer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Customer' })).not.toBeInTheDocument());
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('save_customer', expect.objectContaining({
      p_idempotency_key: 'customer-stale-key-1',
    })));
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

  it('releases dirty suppression even when animation frames do not run', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    renderDetail();
    fireEvent.change(await screen.findByDisplayValue('Original Farm'), { target: { value: 'Unsaved Farm Edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload Customer' }));
    await screen.findByDisplayValue('Newer Farm');

    await new Promise((resolve) => window.setTimeout(resolve, 300));
    fireEvent.change(screen.getByDisplayValue('Newer Farm'), { target: { value: 'Edit after reload settled' } });
    await waitFor(() => expect(dirtyStates[dirtyStates.length - 1]).toBe(true));
  });

  it('rejects a jumped token returned by save_customer and fails the next save closed', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { customer_id: original.id, row_version: 6 }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'CUSTOMER_STALE_WRITE' } });

    renderDetail();
    fireEvent.change(await screen.findByDisplayValue('Original Farm'), { target: { value: 'First saved edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('button', { name: 'Reload Customer' })).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('version could not be confirmed'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.change(screen.getByDisplayValue('First saved edit'), { target: { value: 'Second edit after uncertain save' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('save_customer', expect.objectContaining({
      p_customer_payload: expect.objectContaining({
        row_version_expected: null,
        farm_name: 'Second edit after uncertain save',
      }),
    })));
  });

  it('reloads the financials tab when the route switches customers without remounting the page', async () => {
    // The financials tab caches its fetch in a ref. CustomerDetail is not
    // remounted when only :id changes, so before this guard existed the tab
    // short-circuited on the cached flag and rendered the PREVIOUS customer's
    // AR aging, statement and prepay credits under the new customer's name.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return customerQuery(() => original);
      return query({ data: [], error: null });
    });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_ar_aging') {
        return Promise.resolve({
          data: [
            { customer_id: 'customer-1', farm_name: 'Original Farm', current_amount: 1234, days_30: 0, days_60: 0, days_90: 0, over_90: 0, total_outstanding: 1234 },
            { customer_id: 'customer-2', farm_name: 'Second Farm', current_amount: 5678, days_30: 0, days_60: 0, days_90: 0, over_90: 0, total_outstanding: 5678 },
          ],
          error: null,
        });
      }
      if (name === 'get_customer_statement') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    });

    renderDetailWithCustomerSwitch();
    await screen.findByDisplayValue('Original Farm');
    fireEvent.click(screen.getByRole('button', { name: 'financials' }));
    expect(await screen.findByText('$1,234.00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Jump to customer 2' }));

    expect(await screen.findByText('$5,678.00')).toBeInTheDocument();
    expect(screen.queryByText('$1,234.00')).not.toBeInTheDocument();
  });

  it('keeps the committed crop but clears a jumped 4-to-6 token and requires recovery before a whole-record save', async () => {
    let customerReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') {
        return customerQuery(() => {
          customerReads += 1;
          return customerReads <= 2
            ? original
            : ({ ...original, crops: ['corn'], row_version: 6 } as unknown as typeof original);
        });
      }
      return query({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'CUSTOMER_STALE_WRITE' } });

    renderDetail();
    await screen.findByDisplayValue('Original Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Corn' }));

    expect(await screen.findByRole('button', { name: 'Reload Customer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Corn' })).toHaveAttribute('aria-pressed', 'true');
    expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('Crops were updated'));

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.change(screen.getByDisplayValue('Original Farm'), { target: { value: 'Local edit after crop update' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_customer', expect.objectContaining({
      p_customer_payload: expect.objectContaining({ row_version_expected: null, farm_name: 'Local edit after crop update' }),
    })));
  });
});
