import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

const { mockRpc, mockFrom, mockToast, mockAuth } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockAuth: {
    profile: { id: 'rep-1', role: 'sales_rep' } as { id: string; role: string } | null,
    role: 'sales_rep' as string | null,
  },
}));

type RpcResult = { data: unknown; error: { message: string } | null };
type RpcImplementation = (args: Record<string, unknown>) => Promise<RpcResult>;
type QueryResult = { data: unknown; error: { message: string } | null };
type QueryImplementation = () => Promise<QueryResult>;

let rpcRows: Record<string, unknown[]> = {};
let rpcImplementations: Record<string, RpcImplementation> = {};
let customerEnrichment: unknown[] = [];
let customerEnrichmentImplementation: QueryImplementation | null = null;
let profileOptionsImplementation: QueryImplementation | null = null;
let profileOptionsChain: Record<string, unknown> | null = null;

function buildChain(result: QueryResult | Promise<QueryResult>): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order']) self[method] = vi.fn(() => self);
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { rpc: mockRpc, from: mockFrom },
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) throw new Error(`${rpcName} returned no data`);
    return data;
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/customers/CustomerPrepCard', () => ({ default: ({ customerId }: { customerId: string }) => <div>Prep {customerId}</div> }));
vi.mock('../components/customers/LogInteractionModal', () => ({ default: () => <div role="dialog" aria-label="Log interaction" /> }));

import CallLists from './CallLists';

const REP_A = '11111111-1111-4111-8111-111111111111';
const REP_INACTIVE = '22222222-2222-4222-8222-222222222222';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    customer_id: 'customer-1',
    farm_name: 'North Farm',
    assigned_sales_rep: REP_A,
    primary_contact_name: 'Pat Grower',
    phone_display: '(555) 010-0200',
    phone_e164: '+15550100200',
    last_interaction_at: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

function payload(rows: unknown[]): RpcResult {
  return { data: { success: true, rows }, error: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function LocationControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="location-search">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>Test back</button>
      <button type="button" onClick={() => navigate(1)}>Test forward</button>
    </div>
  );
}

function renderCallLists(initialEntry = '/call-lists') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <CallLists />
      <LocationControls />
    </MemoryRouter>,
  );
}

function locationParams() {
  return new URLSearchParams(screen.getByTestId('location-search').textContent || '');
}

describe('Call Lists adoption workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.profile = { id: 'rep-1', role: 'sales_rep' };
    mockAuth.role = 'sales_rep';
    rpcRows = {};
    rpcImplementations = {};
    customerEnrichment = [{ id: 'customer-1', assigned_tier: 2, crops: ['corn'] }];
    customerEnrichmentImplementation = null;
    profileOptionsImplementation = null;
    profileOptionsChain = null;
    mockRpc.mockImplementation((rpcName: string, args: Record<string, unknown>) => {
      const implementation = rpcImplementations[rpcName];
      return implementation ? implementation(args) : Promise.resolve(payload(rpcRows[rpcName] || []));
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profile_public_view') {
        profileOptionsChain = buildChain(profileOptionsImplementation
          ? profileOptionsImplementation()
          : { data: [{ id: REP_A, full_name: 'Dana Rep', is_active: true }], error: null });
        return profileOptionsChain;
      }
      if (table === 'customers') {
        return buildChain(customerEnrichmentImplementation
          ? customerEnrichmentImplementation()
          : { data: customerEnrichment, error: null });
      }
      return buildChain({ data: [], error: null });
    });
  });

  it.each([
    [
      'prepay',
      'get_call_list_prepay_prospects',
      baseRow({ prior_season_spend_cents: 245000, current_season_prepay_cents: 0 }),
      'Why now: This customer spent $2,450.00 last season and has no current prepay.',
    ],
    [
      'no-recent-contact',
      'get_call_list_no_recent_contact',
      baseRow({ days_since_last_interaction: 43 }),
      'Why now: It has been 43 days since the last recorded conversation.',
    ],
    [
      'stale-quotes',
      'get_call_list_stale_quotes',
      baseRow({ quote_id: 'quote-1', quote_number: 'Q-1042', quote_total_cents: 187500, quote_updated_at: '2026-07-01T00:00:00Z', quote_age_days: 22 }),
      'Why now: Quote Q-1042 worth $1,875.00 has been untouched for 22 days.',
    ],
    [
      'lapsed-products',
      'get_call_list_lapsed_products',
      baseRow({ lapsed_count: 3, top_lapsed_product_name: 'Atrazine', top_lapsed_product_prior_revenue_cents: 92500 }),
      'Why now: Atrazine lapsed after $925.00 in prior revenue; 2 other products also lapsed.',
    ],
    [
      'unassigned-accounts',
      'get_call_list_unassigned_accounts',
      baseRow({ assigned_sales_rep: null, account_created_at: '2026-01-01T00:00:00Z' }),
      'Why now: This customer has no assigned sales representative.',
    ],
  ])('renders the plain-English reason for %s', async (list, rpcName, row, reason) => {
    if (list === 'unassigned-accounts') {
      mockAuth.profile = { id: 'admin-1', role: 'admin' };
      mockAuth.role = 'admin';
    }
    rpcRows[rpcName] = [row];
    renderCallLists(`/call-lists?list=${list}`);
    expect(await screen.findByText(reason)).toBeInTheDocument();
  });

  it.each([
    [
      'no recorded conversation',
      'no-recent-contact',
      'get_call_list_no_recent_contact',
      baseRow({ last_interaction_at: null, days_since_last_interaction: null }),
      'Why now: No recorded conversation is on file.',
    ],
    [
      'incomplete stale quote data',
      'stale-quotes',
      'get_call_list_stale_quotes',
      baseRow({ quote_id: 'quote-2', quote_number: '', quote_total_cents: null, quote_updated_at: '', quote_age_days: null }),
      'Why now: An open quote with value unavailable has an unknown age.',
    ],
    [
      'missing lapsed-product detail',
      'lapsed-products',
      'get_call_list_lapsed_products',
      baseRow({ lapsed_count: 2, top_lapsed_product_name: null, top_lapsed_product_prior_revenue_cents: null }),
      'Why now: 2 prior-season products have not been purchased this season; prior revenue is unavailable.',
    ],
  ])('uses a safe fallback for %s', async (_case, list, rpcName, row, reason) => {
    rpcRows[rpcName] = [row];
    renderCallLists(`/call-lists?list=${list}`);
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/undefined|NaN|Invalid Date/)).not.toBeInTheDocument();
  });

  it('uses a compact accessible selector with keyboard selection and touch-sized controls', async () => {
    renderCallLists();
    const selector = screen.getByRole('tablist', { name: 'Call list reason' });
    expect(selector).toHaveClass('overflow-x-auto');
    const prepay = within(selector).getByRole('tab', { name: 'Prepay prospects' });
    const noContact = within(selector).getByRole('tab', { name: 'No recent contact' });
    expect(prepay).toHaveAttribute('aria-selected', 'true');
    expect(prepay).toHaveClass('min-h-11');

    fireEvent.keyDown(prepay, { key: 'ArrowRight' });
    await waitFor(() => expect(noContact).toHaveAttribute('aria-selected', 'true'));
    expect(noContact).toHaveFocus();
  });

  it('restores validated applied criteria and filters from the URL', async () => {
    mockAuth.profile = { id: 'admin-1', role: 'admin' };
    mockAuth.role = 'admin';
    rpcRows.get_call_list_stale_quotes = [baseRow({
      farm_name: 'North Farm',
      quote_id: 'quote-1',
      quote_number: 'Q-1',
      quote_total_cents: 50000,
      quote_updated_at: '2026-07-01T00:00:00Z',
      quote_age_days: 21,
    })];
    renderCallLists(`/call-lists?list=stale-quotes&min_prior_spend_cents=250000&no_contact_days=45&stale_quote_days=21&rep=${REP_A}&tier=2&crop=corn&search=North`);

    expect(await screen.findByText('North Farm')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_call_list_stale_quotes', { p_days: 21, p_rep_id: REP_A });
    expect(screen.getByLabelText('Quote untouched for (days)')).toHaveValue(21);
    expect(screen.getByLabelText('Filter by sales rep')).toHaveValue(REP_A);
    expect(screen.getByLabelText('Filter by customer tier')).toHaveValue('2');
    expect(screen.getByLabelText('Filter by customer crop')).toHaveValue('corn');
    expect(screen.getByLabelText('Search call list by farm name')).toHaveValue('North');
    expect(screen.getByLabelText('Search call list by farm name')).toHaveAttribute('maxLength', '100');
  });

  it('keeps a restored tier visibly selectable when no returned customer uses that tier', async () => {
    rpcRows.get_call_list_prepay_prospects = [baseRow({
      prior_season_spend_cents: 100000,
      current_season_prepay_cents: 0,
    })];
    customerEnrichment = [{ id: 'customer-1', assigned_tier: 2, crops: ['corn'] }];

    renderCallLists('/call-lists?list=prepay&tier=3');

    const tierSelect = await screen.findByLabelText('Filter by customer tier');
    expect(tierSelect).toHaveValue('3');
    expect(within(tierSelect).getByRole('option', { name: 'Tier 3' })).toBeInTheDocument();
    expect(await screen.findByText('This call list is clear')).toBeInTheDocument();
  });

  it('preserves and blocks a requested rep filter until failed option validation succeeds', async () => {
    mockAuth.profile = { id: 'admin-1', role: 'admin' };
    mockAuth.role = 'admin';
    rpcRows.get_call_list_prepay_prospects = [baseRow({
      prior_season_spend_cents: 100000,
      current_season_prepay_cents: 0,
    })];
    let profileCalls = 0;
    profileOptionsImplementation = async () => {
      profileCalls += 1;
      return profileCalls === 1
        ? { data: null, error: { message: 'rep lookup failed' } }
        : { data: [{ id: REP_A, full_name: 'Dana Rep', is_active: true }], error: null };
    };

    renderCallLists(`/call-lists?list=prepay&rep=${REP_A}`);

    const retry = await screen.findByRole('button', { name: 'Rep filter failed — retry' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(locationParams().get('rep')).toBe(REP_A);
    expect(screen.getByLabelText('Loading call list')).toBeInTheDocument();

    fireEvent.click(retry);

    expect(await screen.findByText('North Farm')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_call_list_prepay_prospects', {
      p_min_prior_spend_cents: 100000,
      p_rep_id: REP_A,
    });
    expect(locationParams().get('rep')).toBe(REP_A);
    expect(screen.getByLabelText('Filter by sales rep')).toHaveValue(REP_A);
  });

  it('preserves an inactive rep bookmark and keeps the RPC scoped to that rep', async () => {
    mockAuth.profile = { id: 'admin-1', role: 'admin' };
    mockAuth.role = 'admin';
    profileOptionsImplementation = async () => ({
      data: [
        { id: REP_A, full_name: 'Dana Rep', is_active: true },
        { id: REP_INACTIVE, full_name: 'Former Rep', is_active: false },
      ],
      error: null,
    });
    rpcRows.get_call_list_prepay_prospects = [baseRow({
      assigned_sales_rep: REP_INACTIVE,
      prior_season_spend_cents: 100000,
      current_season_prepay_cents: 0,
    })];

    renderCallLists(`/call-lists?list=prepay&rep=${REP_INACTIVE}`);

    expect(await screen.findByText('North Farm')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_call_list_prepay_prospects', {
      p_min_prior_spend_cents: 100000,
      p_rep_id: REP_INACTIVE,
    });
    const repSelect = screen.getByLabelText('Filter by sales rep');
    expect(repSelect).toHaveValue(REP_INACTIVE);
    expect(within(repSelect).getByRole('option', { name: 'Former Rep (inactive)' })).toBeInTheDocument();
    expect(locationParams().get('rep')).toBe(REP_INACTIVE);
    expect(profileOptionsChain).not.toBeNull();
    expect(profileOptionsChain!.select).toHaveBeenCalledWith('id, full_name, is_active');
    expect(profileOptionsChain!.eq).toHaveBeenCalledWith('role', 'sales_rep');
    expect(profileOptionsChain!.eq).not.toHaveBeenCalledWith('is_active', true);
  });

  it('falls back safely from invalid and role-forbidden query values', async () => {
    rpcRows.get_call_list_prepay_prospects = [baseRow({ prior_season_spend_cents: 100000, current_season_prepay_cents: 0 })];
    renderCallLists(`/call-lists?list=unassigned-accounts&min_prior_spend_cents=-5&no_contact_days=not-a-number&stale_quote_days=999999999999999999999&rep=${REP_A}&tier=9&crop=not-a-crop`);

    expect(await screen.findByText('North Farm')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_call_list_prepay_prospects', { p_min_prior_spend_cents: 100000 });
    expect(mockRpc).not.toHaveBeenCalledWith('get_call_list_unassigned_accounts', expect.anything());
    await waitFor(() => {
      const params = locationParams();
      expect(params.get('list')).toBe('prepay');
      expect(params.get('rep')).toBeNull();
      expect(params.get('tier')).toBeNull();
      expect(params.get('crop')).toBeNull();
      expect(params.get('min_prior_spend_cents')).toBe('100000');
      expect(params.get('no_contact_days')).toBe('30');
      expect(params.get('stale_quote_days')).toBe('14');
    });
  });

  it('rejects day criteria beyond the safe call-list lookback horizon', async () => {
    rpcRows.get_call_list_no_recent_contact = [baseRow({ days_since_last_interaction: 35 })];
    renderCallLists('/call-lists?list=no-recent-contact&no_contact_days=2147483647&stale_quote_days=3651');

    expect(await screen.findByText('North Farm')).toBeInTheDocument();
    expect(mockRpc).toHaveBeenCalledWith('get_call_list_no_recent_contact', { p_days: 30 });
    await waitFor(() => {
      const params = locationParams();
      expect(params.get('no_contact_days')).toBe('30');
      expect(params.get('stale_quote_days')).toBe('14');
    });

    fireEvent.change(screen.getByLabelText('No contact for (days)'), { target: { value: '2147483647' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply and refresh' }));
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_call_list_no_recent_contact', { p_days: 30 }));

    fireEvent.change(screen.getByLabelText('No contact for (days)'), { target: { value: '3650' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply and refresh' }));
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_call_list_no_recent_contact', { p_days: 3650 }));

    fireEvent.change(screen.getByLabelText('No contact for (days)'), { target: { value: '3651' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply and refresh' }));
    await waitFor(() => expect(mockRpc).toHaveBeenLastCalledWith('get_call_list_no_recent_contact', { p_days: 30 }));
  });

  it('keeps a restored tier or crop filter loading until customer enrichment finishes', async () => {
    const enrichment = deferred<QueryResult>();
    customerEnrichmentImplementation = async () => enrichment.promise;
    rpcRows.get_call_list_prepay_prospects = [baseRow({ prior_season_spend_cents: 100000, current_season_prepay_cents: 0 })];
    renderCallLists('/call-lists?list=prepay&tier=2&crop=corn');

    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('customers'));
    expect(screen.getByLabelText('Loading call list')).toBeInTheDocument();
    expect(screen.queryByText('This call list is clear')).not.toBeInTheDocument();

    await act(async () => enrichment.resolve({ data: [{ id: 'customer-1', assigned_tier: 2, crops: ['corn'] }], error: null }));
    expect(await screen.findByText('North Farm')).toBeInTheDocument();
  });

  it('keeps database details out of a failed-list toast while offering a retry', async () => {
    rpcImplementations.get_call_list_prepay_prospects = async () => ({
      data: null,
      error: { message: 'relation private_internal_table does not exist' },
    });

    renderCallLists();

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('error', 'We could not load this call list. Please retry.');
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('private_internal_table'));
  });

  it('restores the visible criterion draft when browser history changes the selected list', async () => {
    rpcRows.get_call_list_prepay_prospects = [baseRow({ prior_season_spend_cents: 100000, current_season_prepay_cents: 0 })];
    rpcRows.get_call_list_no_recent_contact = [baseRow({ days_since_last_interaction: 35 })];
    renderCallLists();
    await screen.findByText('North Farm');

    fireEvent.change(screen.getByLabelText('Minimum prior spend ($)'), { target: { value: '777' } });
    fireEvent.click(screen.getByRole('tab', { name: 'No recent contact' }));
    await screen.findByText('North Farm');
    fireEvent.click(screen.getByRole('button', { name: 'Test back' }));

    await waitFor(() => expect(screen.getByLabelText('Minimum prior spend ($)')).toHaveValue(1000));
  });

  it('clears old rows immediately for list and applied-criteria transitions', async () => {
    rpcRows.get_call_list_prepay_prospects = [baseRow({ farm_name: 'Old Farm', prior_season_spend_cents: 100000, current_season_prepay_cents: 0 })];
    const nextList = deferred<RpcResult>();
    const refreshedList = deferred<RpcResult>();
    let noContactCalls = 0;
    rpcImplementations.get_call_list_no_recent_contact = async () => {
      noContactCalls += 1;
      return noContactCalls === 1 ? nextList.promise : refreshedList.promise;
    };
    renderCallLists();
    expect(await screen.findByText('Old Farm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'No recent contact' }));
    expect(screen.queryByText('Old Farm')).not.toBeInTheDocument();
    await act(async () => nextList.resolve(payload([baseRow({ farm_name: 'Current Farm', days_since_last_interaction: 40 })])));
    expect(await screen.findByText('Current Farm')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('No contact for (days)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply and refresh' }));
    expect(screen.queryByText('Current Farm')).not.toBeInTheDocument();
    await act(async () => refreshedList.resolve(payload([baseRow({ farm_name: 'Refreshed Farm', days_since_last_interaction: 65 })])));
    expect(await screen.findByText('Refreshed Farm')).toBeInTheDocument();
  });

  it('keeps the applied prepay list on screen when a refused threshold is applied', async () => {
    rpcRows.get_call_list_prepay_prospects = [baseRow({ farm_name: 'Old Farm', prior_season_spend_cents: 100000, current_season_prepay_cents: 0 })];
    renderCallLists();
    expect(await screen.findByText('Old Farm')).toBeInTheDocument();
    const rpcCallsBefore = mockRpc.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Minimum prior spend ($)'), { target: { value: '12.345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply and refresh' }));

    expect(mockToast).toHaveBeenCalledWith('error', 'Minimum prior spend: Enter an amount with no more than two decimal places.');
    // A refused threshold must leave the still-applied list alone: before the fix the rows
    // were cleared first, so the page said "This call list is clear" for a list that was
    // never re-queried (Codex P2 on PR #588).
    expect(screen.getByText('Old Farm')).toBeInTheDocument();
    expect(screen.queryByText(/call list is clear/i)).not.toBeInTheDocument();
    expect(mockRpc.mock.calls.length).toBe(rpcCallsBefore);
  });

  it('ignores an obsolete in-flight response after the selected list changes', async () => {
    const oldResponse = deferred<RpcResult>();
    const currentResponse = deferred<RpcResult>();
    rpcImplementations.get_call_list_prepay_prospects = async () => oldResponse.promise;
    rpcImplementations.get_call_list_no_recent_contact = async () => currentResponse.promise;
    renderCallLists();

    fireEvent.click(screen.getByRole('tab', { name: 'No recent contact' }));
    await act(async () => oldResponse.resolve(payload([baseRow({ farm_name: 'Obsolete Farm', prior_season_spend_cents: 100000, current_season_prepay_cents: 0 })])));
    expect(screen.queryByText('Obsolete Farm')).not.toBeInTheDocument();
    await act(async () => currentResponse.resolve(payload([baseRow({ farm_name: 'Current Farm', days_since_last_interaction: 35 })])));
    expect(await screen.findByText('Current Farm')).toBeInTheDocument();
  });

  it('restores the correct safe list through browser back and forward', async () => {
    rpcRows.get_call_list_prepay_prospects = [baseRow({ farm_name: 'Prepay Farm', prior_season_spend_cents: 100000, current_season_prepay_cents: 0 })];
    rpcRows.get_call_list_stale_quotes = [baseRow({ farm_name: 'Quote Farm', quote_id: 'quote-1', quote_number: 'Q-1', quote_total_cents: 50000, quote_updated_at: '2026-07-01T00:00:00Z', quote_age_days: 20 })];
    renderCallLists();
    expect(await screen.findByText('Prepay Farm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Stale quotes' }));
    expect(await screen.findByText('Quote Farm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test back' }));
    expect(await screen.findByText('Prepay Farm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test forward' }));
    expect(await screen.findByText('Quote Farm')).toBeInTheDocument();
  });
});
