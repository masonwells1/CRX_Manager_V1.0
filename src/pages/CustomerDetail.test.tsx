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
  // Generations are PER SCOPE, mirroring the real hook's per-scope Map. One shared
  // counter would let a reset on customer B change the key later handed back for
  // customer A, which the real hook never does — an A → B → A test written against
  // that stub would assert a property of the mock, not of the page.
  const customerIdempotencyState = {
    generations: new Map<string, number>(),
    generationFor(scope: string) { return this.generations.get(scope) ?? 0; },
    bump(scope: string) { this.generations.set(scope, this.generationFor(scope) + 1); },
    reset() { this.generations.clear(); },
  };
  return {
    mockFrom: vi.fn(),
    mockRpc: vi.fn(),
    mockToast: vi.fn(),
    mockResetIdempotencyKey: vi.fn((scope: string = '') => { customerIdempotencyState.bump(scope); }),
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

vi.mock('../lib/db', async () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  // The REAL assertRpcResult, not a passthrough stub. `vi.fn((value) => value)` never
  // throws, which DELETES the ambiguous-reply path — an empty payload with no error —
  // from every test in this file. That path is exactly what the F1 reset ordering
  // exists to handle, so under the stub a screen that retires its idempotency key
  // before checking the reply stays green (aliased-reset sweep, 2026-09-05).
  assertRpcResult: (await vi.importActual<typeof import('../lib/db')>('../lib/db')).assertRpcResult,
  checkMutationResult: vi.fn(),
  // The REAL hasRpcCode, for the same reason as assertRpcResult above. The old stub
  // matched a code appearing ANYWHERE in the message, which is more permissive than
  // production: a message that merely mentions IDEMPOTENCY_PAYLOAD_CONFLICT in prose
  // would take the conflict-recovery path here and not on a live screen.
  hasRpcCode: (await vi.importActual<typeof import('../lib/db')>('../lib/db')).hasRpcCode,
  RpcErrorCodes: { CUSTOMER_STALE_WRITE: 'CUSTOMER_STALE_WRITE', QUOTE_STALE_WRITE: 'QUOTE_STALE_WRITE', COMMISSION_SPLIT_CONFLICT: 'COMMISSION_SPLIT_CONFLICT', IDEMPOTENCY_PAYLOAD_CONFLICT: 'IDEMPOTENCY_PAYLOAD_CONFLICT' },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin', full_name: 'Admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: (_operation: string, _userId: string, intentScope = '') => ({
    // The mock MUST honour intentScope. A scope-blind stub returns one key for every
    // customer, so a regression test for "customer B must not inherit A's key" would
    // pass against a completely unscoped hook — it would assert a property of the mock
    // rather than of the page (aliased-reset sweep, 2026-09-05).
    getKey: () => `customer-stale-key-${intentScope}-${customerIdempotencyState.generationFor(intentScope)}`,
    resetKey: () => mockResetIdempotencyKey(intentScope),
    // Retires a NAMED scope rather than the rendered one, as the real hook does.
    // Without this the page could not retire the key of a customer it has left.
    resetKeyFor: (scopeValue: string) => mockResetIdempotencyKey(scopeValue),
  }),
}));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: (dirty: boolean) => { dirtyStates.push(dirty); return { state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }; } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// Controlled, like the real editor: the create form seeds one split row with an
// empty recipient, and saving is blocked until it is filled. A `<div />` mock
// hides that, so the create-route tests below need a way to fill it in.
vi.mock('../components/ui/CommissionSplitEditor', () => ({
  default: ({ value, onChange }: { value?: { splits?: { recipient: string; percentage: number }[] }; onChange: (v: { splits: { recipient: string; percentage: number }[] }) => void }) => (
    <input
      aria-label="commission recipient"
      value={value?.splits?.[0]?.recipient ?? ''}
      onChange={(e) => onChange({ splits: [{ recipient: e.target.value, percentage: 100 }] })}
    />
  ),
}));
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

/** Same reused-instance jump, but to the CREATE route (`:id` === 'new'). */
function NewCustomerButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/customers/new')}>New customer</button>;
}

function renderDetailWithNewCustomerJump() {
  return render(
    <MemoryRouter initialEntries={['/customers/customer-1']}>
      <NewCustomerButton />
      <Routes><Route path="/customers/:id" element={<CustomerDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('CustomerDetail stale whole-record save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customerIdempotencyState.reset();
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
      p_idempotency_key: 'customer-stale-key-customer-1-0',
    }));
    expect(mockResetIdempotencyKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload Customer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload Customer' })).not.toBeInTheDocument());
    expect(mockResetIdempotencyKey).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('save_customer', expect.objectContaining({
      p_idempotency_key: 'customer-stale-key-customer-1-1',
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

  /**
   * F1, ALIASED-RESET CLASS — driven through the real save handler.
   *
   * `save_customer` answering `{ data: null, error: null }` is the AMBIGUOUS reply:
   * nothing failed, but the payload is empty, so this tab cannot tell whether the
   * customer committed. Retiring the key before assertRpcResult has accepted the reply
   * — which is what main did, through a destructured rename the literal `resetKey()`
   * sweep could not see — sends the retry under a BRAND-NEW key that the server has
   * never seen and therefore cannot replay, writing the customer twice.
   */
  it('keeps the save_customer key when the reply is empty, so the retry replays instead of double-writing', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    renderDetail();
    fireEvent.change(await screen.findByDisplayValue('Original Farm'), { target: { value: 'Edited farm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_customer', expect.objectContaining({
      p_idempotency_key: 'customer-stale-key-customer-1-0',
    })));
    expect(
      mockResetIdempotencyKey,
      'an empty save_customer reply is ambiguous — the key must survive it so a retry can replay',
    ).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_customer');
      expect(saves.length).toBeGreaterThan(1);
    });
    const saveKeys = mockRpc.mock.calls
      .filter(([name]) => name === 'save_customer')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);
    expect(
      new Set(saveKeys),
      'every retry of an unresolved save must carry the SAME key, or the server writes the customer twice',
    ).toEqual(new Set(['customer-stale-key-customer-1-0']));
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

  /**
   * The cost of F1 retention, paid for by scoping — raised by the gpt-5.6-sol review of
   * this change (LOW) and fixed here rather than deferred.
   *
   * Keeping the key across an ambiguous reply is the whole point of F1. But this page
   * does NOT remount when only `:id` changes, so an UNSCOPED retained key would be
   * handed to the next customer: B's save would travel under A's unresolved key, the
   * server would fingerprint a different payload against it and answer
   * IDEMPOTENCY_PAYLOAD_CONFLICT. It fails closed — no cross-customer write — but B
   * gets a conflict dialog it did nothing to earn.
   *
   * The key is now scoped by route id, which is sound HERE because the RPC targets the
   * route record (`p_customer_id: (isNew ? null : id)`).
   */
  it('does not hand customer B the unresolved key minted for customer A', async () => {
    // A's save comes back ambiguous — no error, empty payload — so A's key is RETAINED.
    mockRpc.mockResolvedValue({ data: null, error: null });

    const record = (customerId: string) => (customerId === 'customer-2'
      ? { id: 'customer-2', farm_name: 'Second Farm', row_version: 3, crops: [], default_commission_split: null }
      : { id: 'customer-1', farm_name: 'Original Farm', row_version: 1, crops: [], default_commission_split: null });
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'customers') return query({ data: [], error: null });
      const chain: Record<string, unknown> = {};
      let requested = 'customer-1';
      const self = (..._args: unknown[]) => chain;
      for (const name of ['neq', 'is', 'in', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'select']) chain[name] = self;
      chain.eq = (_column: unknown, value: unknown) => { requested = String(value); return chain; };
      const settle = async (): Promise<QueryResult> => ({ data: record(requested), error: null });
      chain.maybeSingle = () => settle();
      chain.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => settle().then(resolve, reject);
      chain.catch = (reject: (reason: unknown) => unknown) => settle().catch(reject);
      chain.finally = (callback: () => void) => settle().finally(callback);
      return chain;
    });

    renderDetailWithCustomerSwitch();
    fireEvent.change(await screen.findByDisplayValue('Original Farm'), { target: { value: 'Edited A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_customer', expect.objectContaining({
      p_idempotency_key: 'customer-stale-key-customer-1-0',
    })));
    expect(mockResetIdempotencyKey, "A's key must survive its ambiguous reply").not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Jump to customer 2'));
    await waitFor(() => expect(screen.queryByDisplayValue('Edited A')).not.toBeInTheDocument());

    fireEvent.change(await screen.findByDisplayValue('Second Farm'), { target: { value: 'Edited B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      const saves = mockRpc.mock.calls.filter(([name]) => name === 'save_customer');
      expect(saves.length).toBeGreaterThan(1);
    });
    const lastSave = [...mockRpc.mock.calls].reverse().find(([name]) => name === 'save_customer');
    expect(
      (lastSave?.[1] as { p_idempotency_key: string }).p_idempotency_key,
      "customer B must mint its OWN key — inheriting A's unresolved key earns B a conflict dialog it did not cause",
    ).toBe('customer-stale-key-customer-2-0');
  });

  /**
   * The SECOND-ORDER cost of that scoping, and the mirror of a defect already fixed in
   * QuoteBuilder. Flagged by the Codex GitHub App at head 0cd47568 — the same reviewer
   * that named the quote instance, on the file where the scoping was introduced FIRST.
   *
   * `reloadAfterStaleSave` releases the CURRENT render's scope. While one page-wide key
   * existed that was always the right one. Once scoped, an operator whose save on
   * customer A is rejected, who navigates to B with the dialog still open and clicks
   * Reload, retires B's key and strands A's rejected one — so returning to A replays
   * the rejected key and re-opens the same conflict.
   */
  it('retires neither customer\'s key when A\'s conflict dialog is recovered after a route change', async () => {
    // A's save is REJECTED, so A's dialog opens and A's key is permanently unusable.
    mockRpc.mockResolvedValue({ data: null, error: { message: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } });

    const record = (customerId: string) => (customerId === 'customer-2'
      ? { id: 'customer-2', farm_name: 'Second Farm', row_version: 3, crops: [], default_commission_split: null }
      : { id: 'customer-1', farm_name: 'Original Farm', row_version: 1, crops: [], default_commission_split: null });
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'customers') return query({ data: [], error: null });
      const chain: Record<string, unknown> = {};
      let requested = 'customer-1';
      const self = (..._args: unknown[]) => chain;
      for (const name of ['neq', 'is', 'in', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'select']) chain[name] = self;
      chain.eq = (_column: unknown, value: unknown) => { requested = String(value); return chain; };
      const settle = async (): Promise<QueryResult> => ({ data: record(requested), error: null });
      chain.maybeSingle = () => settle();
      chain.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => settle().then(resolve, reject);
      chain.catch = (reject: (reason: unknown) => unknown) => settle().catch(reject);
      chain.finally = (callback: () => void) => settle().finally(callback);
      return chain;
    });

    renderDetailWithCustomerSwitch();
    fireEvent.change(await screen.findByDisplayValue('Original Farm'), { target: { value: 'Edited A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    // A's recovery dialog opens.
    expect(await screen.findByText('Reload Customer')).toBeInTheDocument();

    // The operator navigates to B with that dialog still open, then recovers it.
    fireEvent.click(screen.getByText('Jump to customer 2'));
    await screen.findByDisplayValue('Second Farm');
    fireEvent.click(screen.getByText('Reload Customer'));
    await waitFor(() => expect(screen.queryByText('Reload Customer')).not.toBeInTheDocument());

    expect(
      mockResetIdempotencyKey,
      "recovering A's conflict must not retire customer B's key — B never had an unresolved save",
    ).not.toHaveBeenCalledWith('customer-2');
    // And it must not retire A's key either, even though A's dialog is what closed.
    //
    // An earlier revision did retire it, on the reasoning that a payload-rejected key
    // can only ever be rejected again. That was a duplicate-write hazard: the key
    // rejects the CHANGED payload, but replaying the ORIGINAL one returns the server's
    // cached receipt, which on a create is the only way to learn the id of a row that
    // may already have committed. Retiring it lets a later retry insert twice.
    //
    // Retaining costs one unearned conflict dialog on returning to A, which self-heals
    // on A's own reload. That is the cheaper side of the trade, so this asserts the
    // key survives.
    expect(
      mockResetIdempotencyKey,
      "A's key is the receipt handle for a create that may have committed — recovery on another customer must not retire it",
    ).not.toHaveBeenCalledWith('customer-1');
  });

  it('ignores a slow snapshot for the previous customer that lands after the route moved on', async () => {
    // The tab loader was sequence-guarded, but the PRIMARY record was not. Customer
    // 1's reads are held open here until customer 2 is already on screen, which is
    // what a slow connection does on its own. Without the guard, customer 1's
    // record, addresses and row version install over customer 2 — and the next save
    // writes customer 1's fields to customer 2's id under customer 1's row version.
    let releaseFirstCustomer!: () => void;
    const firstCustomerGate = new Promise<void>((resolve) => { releaseFirstCustomer = resolve; });
    const record = (customerId: string) => (customerId === 'customer-2'
      ? { id: 'customer-2', farm_name: 'Second Farm', row_version: 3, crops: [], default_commission_split: null }
      : { id: 'customer-1', farm_name: 'Original Farm', row_version: 1, crops: [], default_commission_split: null });

    mockFrom.mockImplementation((table: string) => {
      if (table !== 'customers') return query({ data: [], error: null });
      const chain: Record<string, unknown> = {};
      let requested = 'customer-1';
      const self = (..._args: unknown[]) => chain;
      for (const name of ['neq', 'is', 'in', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'select']) chain[name] = self;
      chain.eq = (_column: unknown, value: unknown) => { requested = String(value); return chain; };
      const settle = async (): Promise<QueryResult> => {
        if (requested === 'customer-1') await firstCustomerGate;
        return { data: record(requested), error: null };
      };
      chain.maybeSingle = () => settle();
      chain.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => settle().then(resolve, reject);
      chain.catch = (reject: (reason: unknown) => unknown) => settle().catch(reject);
      chain.finally = (callback: () => void) => settle().finally(callback);
      return chain;
    });

    renderDetailWithCustomerSwitch();
    // Customer 1 is still in flight — jump away before it can land.
    fireEvent.click(screen.getByRole('button', { name: 'Jump to customer 2' }));
    expect(await screen.findByDisplayValue('Second Farm')).toBeInTheDocument();

    releaseFirstCustomer();
    await waitFor(() => expect(screen.getByDisplayValue('Second Farm')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('Original Farm')).not.toBeInTheDocument();
  });

  it('does not land a save for the previous customer on the one now open', async () => {
    // Saving customer 1 and navigating to customer 2 before the RPC answers. Every
    // post-save step belongs to customer 1 — its row version, its success toast,
    // its address reload — so none of it may apply to customer 2's session.
    let releaseSave!: (value: { data: unknown; error: unknown }) => void;
    const savePending = new Promise<{ data: unknown; error: unknown }>((resolve) => { releaseSave = resolve; });
    const record = (customerId: string) => (customerId === 'customer-2'
      ? { id: 'customer-2', farm_name: 'Second Farm', row_version: 3, crops: [], default_commission_split: null }
      : { ...original, id: 'customer-1' });

    mockFrom.mockImplementation((table: string) => {
      if (table !== 'customers') return query({ data: [], error: null });
      const chain: Record<string, unknown> = {};
      let requested = 'customer-1';
      const self = (..._args: unknown[]) => chain;
      for (const name of ['neq', 'is', 'in', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'select']) chain[name] = self;
      chain.eq = (_column: unknown, value: unknown) => { requested = String(value); return chain; };
      const result = () => Promise.resolve({ data: record(requested), error: null });
      chain.maybeSingle = () => result();
      chain.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => result().then(resolve, reject);
      chain.catch = (reject: (reason: unknown) => unknown) => result().catch(reject);
      chain.finally = (callback: () => void) => result().finally(callback);
      return chain;
    });
    mockRpc.mockImplementation(() => savePending);

    renderDetailWithCustomerSwitch();
    const farmName = await screen.findByDisplayValue('Original Farm');
    fireEvent.change(farmName, { target: { value: 'Edited While Leaving' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    fireEvent.click(screen.getByRole('button', { name: 'Jump to customer 2' }));
    expect(await screen.findByDisplayValue('Second Farm')).toBeInTheDocument();

    releaseSave({ data: { customer_id: 'customer-1', row_version: 5 }, error: null });

    await waitFor(() => expect(screen.getByDisplayValue('Second Farm')).toBeInTheDocument());
    // The strongest signal: customer 1's row version is gone with its session, so
    // ungated post-save handling resolves the returned token against nothing,
    // decides it cannot prove ownership, and raises customer 1's stale-save
    // conflict dialog over customer 2 — demanding a Reload of a record that was
    // never touched. Neither that dialog nor its warning belongs here.
    expect(screen.queryByRole('button', { name: 'Reload Customer' })).not.toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Customer updated');
    expect(mockToast).not.toHaveBeenCalledWith(
      'warning',
      'Customer saved, but its save-protection version could not be confirmed. Reload before editing or saving it again.',
    );
    expect(screen.queryByDisplayValue('Edited While Leaving')).not.toBeInTheDocument();
    // Save must be usable again on customer 2 rather than stuck from customer 1's run.
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });

  it('does not install the previous customer\'s addresses after navigating away', async () => {
    // The save guard runs when the RPC answers, but the post-save address reload
    // it starts outlives it. Customer 1's save completes, its address read is
    // still in flight when the route moves to customer 2, and those rows would
    // land in customer 2's address editor — a leak the save guard cannot catch
    // because it has already passed by then.
    let releaseAddresses!: () => void;
    const addressGate = new Promise<void>((resolve) => { releaseAddresses = resolve; });
    let customerOneAddressReads = 0;
    const addressRow = (customerId: string) => ({
      id: `${customerId}-addr`, customer_id: customerId, label: 'Main',
      address_line: customerId === 'customer-2' ? 'Second Street' : 'Original Street',
      city: 'Town', state: 'IA', zip: '50000', delivery_notes: '', is_default: true,
    });
    const record = (customerId: string) => (customerId === 'customer-2'
      ? { id: 'customer-2', farm_name: 'Second Farm', row_version: 9, crops: [], default_commission_split: { splits: [] } }
      : original);

    mockFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      let requested = 'customer-1';
      const self = (..._args: unknown[]) => chain;
      for (const name of ['neq', 'is', 'in', 'order', 'limit', 'single', 'insert', 'update', 'delete', 'select']) chain[name] = self;
      chain.eq = (_column: unknown, value: unknown) => { requested = String(value); return chain; };

      const settle = async (): Promise<QueryResult> => {
        if (table === 'customer_addresses') {
          // Customer 1's FIRST read is its initial snapshot and must land; the
          // second is the post-save reload, and that is the one held open.
          if (requested === 'customer-1') {
            customerOneAddressReads += 1;
            if (customerOneAddressReads > 1) await addressGate;
          }
          return { data: [addressRow(requested)], error: null };
        }
        if (table === 'customers') return { data: record(requested), error: null };
        return { data: [], error: null };
      };
      chain.maybeSingle = () => settle();
      chain.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) => settle().then(resolve, reject);
      chain.catch = (reject: (reason: unknown) => unknown) => settle().catch(reject);
      chain.finally = (callback: () => void) => settle().finally(callback);
      return chain;
    });
    mockRpc.mockResolvedValue({ data: { customer_id: 'customer-1', row_version: 5 }, error: null });

    renderDetailWithCustomerSwitch();
    expect(await screen.findByDisplayValue('Original Street')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Original Farm'), { target: { value: 'Edited Farm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_customer', expect.anything()));

    fireEvent.click(screen.getByRole('button', { name: 'Jump to customer 2' }));
    expect(await screen.findByDisplayValue('Second Street')).toBeInTheDocument();

    releaseAddresses();
    await waitFor(() => expect(screen.getByDisplayValue('Second Street')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('Original Street')).not.toBeInTheDocument();
  });

  it('clears the open customer when the route jumps to the create form', async () => {
    // `/customers/new` reuses this component, so a jump to it from an open
    // customer does not remount. The route-change effect used to return early
    // when `isNew` — "a blank form needs no invalidation" — which is only true
    // when the create form is opened fresh. Coming FROM a customer it left that
    // customer's name, fields, addresses and row version on screen behind a
    // "Create Customer" button, and saving sent the stale payload with
    // `p_customer_id: null`, duplicating the old record. (Codex, PR #313.)
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return customerQuery(() => original);
      return query({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: { customer_id: 'created-1', row_version: 1 }, error: null });

    renderDetailWithNewCustomerJump();
    await screen.findByDisplayValue('Original Farm');

    fireEvent.click(screen.getByRole('button', { name: 'New customer' }));

    // The create form is on screen AND the previous customer is gone from it.
    expect(await screen.findByRole('button', { name: 'Create Customer' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Original Farm')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Original Contact')).not.toBeInTheDocument();

    // And the create it sends carries none of the old record either — the half
    // that actually wrote a duplicate customer. The farm name has to be typed
    // in: the cleared form fails the required-field check, which is itself the
    // proof that nothing carried over.
    mockRpc.mockClear();
    fireEvent.change(screen.getByLabelText(/farm name/i), { target: { value: 'Brand New Farm' } });
    fireEvent.change(screen.getByLabelText('commission recipient'), { target: { value: 'Admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Customer' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_customer', expect.anything()));
    const payload = mockRpc.mock.calls.find(([name]) => name === 'save_customer')?.[1] as Record<string, unknown>;
    expect(payload.p_customer_id).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('Original Farm');
  });

  it('restores the create-form defaults on that jump, not an empty form', async () => {
    // The clear above went too far in its first revision: it reset to `{}`, which
    // drops the defaults `useState` seeds a fresh /customers/new with. The form
    // LOOKS right — those fields are not typed in — but the create payload then
    // omits `assigned_sales_rep`, and `save_customer` requires a rep to
    // self-assign, so creating from the normal route fails for reps and silently
    // produces unassigned, untiered customers for admins. (Codex, PR #313.)
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return customerQuery(() => original);
      return query({ data: [], error: null });
    });
    mockRpc.mockResolvedValue({ data: { customer_id: 'created-1', row_version: 1 }, error: null });

    renderDetailWithNewCustomerJump();
    await screen.findByDisplayValue('Original Farm');
    fireEvent.click(screen.getByRole('button', { name: 'New customer' }));
    await screen.findByRole('button', { name: 'Create Customer' });

    mockRpc.mockClear();
    fireEvent.change(screen.getByLabelText(/farm name/i), { target: { value: 'Brand New Farm' } });
    // The one create field that IS seeded blank by design; everything asserted
    // below is a default the reset has to put back on its own.
    fireEvent.change(screen.getByLabelText('commission recipient'), { target: { value: 'Admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Customer' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_customer', expect.anything()));

    const payload = mockRpc.mock.calls.find(([name]) => name === 'save_customer')?.[1] as Record<string, unknown>;
    expect(payload.p_customer_id).toBeNull();
    expect(payload.p_customer_payload).toEqual(expect.objectContaining({
      farm_name: 'Brand New Farm',
      assigned_sales_rep: 'admin-1',
      assigned_tier: 1,
      is_active: true,
    }));
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
