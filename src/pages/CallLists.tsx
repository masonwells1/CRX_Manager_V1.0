import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CalendarClock, ChevronDown, ChevronUp, DollarSign, Phone, PhoneCall, RefreshCw, Search, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import CustomerPrepCard from '../components/customers/CustomerPrepCard';
import LogInteractionModal from '../components/customers/LogInteractionModal';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { assertRpcResult, supabase } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { formatCents } from '../lib/money';

type CallListKey = 'prepay' | 'no-recent-contact' | 'stale-quotes' | 'lapsed-products' | 'unassigned-accounts';

interface CallListBaseRow {
  customer_id: string;
  farm_name: string | null;
  assigned_sales_rep: string | null;
  primary_contact_name: string | null;
  phone_display: string | null;
  phone_e164: string | null;
  last_interaction_at: string | null;
}

interface PrepayProspectRow extends CallListBaseRow {
  prior_season_spend_cents: number;
  current_season_prepay_cents: number;
}

interface NoRecentContactRow extends CallListBaseRow {
  days_since_last_interaction: number | null;
}

interface StaleQuoteRow extends CallListBaseRow {
  quote_id: string;
  quote_number: string;
  quote_total_cents: number;
  quote_updated_at: string;
  quote_age_days: number;
}

interface LapsedProductRow extends CallListBaseRow {
  lapsed_count: number;
  top_lapsed_product_name: string | null;
  top_lapsed_product_prior_revenue_cents: number | null;
}

interface UnassignedAccountRow extends CallListBaseRow {
  account_created_at: string;
}

type CallListRow =
  | PrepayProspectRow
  | NoRecentContactRow
  | StaleQuoteRow
  | LapsedProductRow
  | UnassignedAccountRow;

interface CallListPayload<Row> {
  success: boolean;
  rows: Row[];
}

const DEFAULT_NO_CONTACT_DAYS = 30;
const DEFAULT_STALE_QUOTE_DAYS = 14;
const DEFAULT_MIN_PRIOR_SPEND_CENTS = 100000;

const CALL_LISTS: Array<{
  key: CallListKey;
  label: string;
  description: string;
  icon: typeof Users;
}> = [
  {
    key: 'prepay',
    label: 'Prepay prospects',
    description: 'Customers who spent over a threshold last season but have no current prepay balance.',
    icon: DollarSign,
  },
  {
    key: 'no-recent-contact',
    label: 'No recent contact',
    description: 'Active customers with no recorded interaction in the selected number of days.',
    icon: PhoneCall,
  },
  {
    key: 'stale-quotes',
    label: 'Stale quotes',
    description: 'Open quotes that have not been updated in the selected number of days.',
    icon: CalendarClock,
  },
  {
    key: 'lapsed-products',
    label: 'Lapsed products',
    description: 'Customers who bought products last season but have not bought them this season.',
    icon: RefreshCw,
  },
  {
    key: 'unassigned-accounts',
    label: 'Unassigned accounts',
    description: 'Active customer accounts that do not have a sales representative assigned.',
    icon: Users,
  },
];

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'We could not load this call list.';
};

function rowsOf<Row>(payload: CallListPayload<Row>, rpcName: string): Row[] {
  if (!Array.isArray(payload.rows)) throw new Error(`${rpcName} returned an invalid row list`);
  return payload.rows;
}

async function getCallListPrepayProspects(minPriorSpendCents: number, repId: string | null): Promise<PrepayProspectRow[]> {
  const { data, error } = await supabase.rpc('get_call_list_prepay_prospects', {
    p_min_prior_spend_cents: minPriorSpendCents,
    ...(repId ? { p_rep_id: repId } : {}),
  });
  if (error) throw error;
  return rowsOf(assertRpcResult<CallListPayload<PrepayProspectRow>>(data, 'get_call_list_prepay_prospects'), 'get_call_list_prepay_prospects');
}

async function getCallListNoRecentContact(days: number, repId: string | null): Promise<NoRecentContactRow[]> {
  const { data, error } = await supabase.rpc('get_call_list_no_recent_contact', {
    p_days: days,
    ...(repId ? { p_rep_id: repId } : {}),
  });
  if (error) throw error;
  return rowsOf(assertRpcResult<CallListPayload<NoRecentContactRow>>(data, 'get_call_list_no_recent_contact'), 'get_call_list_no_recent_contact');
}

async function getCallListStaleQuotes(days: number, repId: string | null): Promise<StaleQuoteRow[]> {
  const { data, error } = await supabase.rpc('get_call_list_stale_quotes', {
    p_days: days,
    ...(repId ? { p_rep_id: repId } : {}),
  });
  if (error) throw error;
  return rowsOf(assertRpcResult<CallListPayload<StaleQuoteRow>>(data, 'get_call_list_stale_quotes'), 'get_call_list_stale_quotes');
}

async function getCallListLapsedProducts(repId: string | null): Promise<LapsedProductRow[]> {
  const { data, error } = await supabase.rpc('get_call_list_lapsed_products', repId ? { p_rep_id: repId } : {});
  if (error) throw error;
  return rowsOf(assertRpcResult<CallListPayload<LapsedProductRow>>(data, 'get_call_list_lapsed_products'), 'get_call_list_lapsed_products');
}

async function getCallListUnassignedAccounts(): Promise<UnassignedAccountRow[]> {
  // p_rep_id is omitted (SQL default NULL) — admins must NOT send a value here; a non-NULL rep id silently returns no rows.
  const { data, error } = await supabase.rpc('get_call_list_unassigned_accounts', {});
  if (error) throw error;
  return rowsOf(assertRpcResult<CallListPayload<UnassignedAccountRow>>(data, 'get_call_list_unassigned_accounts'), 'get_call_list_unassigned_accounts');
}

function parseDays(value: string, fallback: number): number {
  if (!/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseDollarsToCents(value: string, fallback: number): number {
  const normalized = value.trim().replace(/[$,]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return fallback;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : fallback;
}

function formatListDate(value: string | null): string {
  if (!value) return 'Never recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString();
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-nav-dark">{value}</dd>
    </div>
  );
}

function ListMetrics({ listKey, row }: { listKey: CallListKey; row: CallListRow }) {
  if (listKey === 'prepay' && 'prior_season_spend_cents' in row) {
    return (
      <>
        <Metric label="Prior season spend" value={formatCents(row.prior_season_spend_cents)} />
        <Metric label="Current prepay" value={formatCents(row.current_season_prepay_cents)} />
      </>
    );
  }
  if (listKey === 'no-recent-contact' && 'days_since_last_interaction' in row) {
    return <Metric label="Days since contact" value={row.days_since_last_interaction === null ? 'Never' : `${row.days_since_last_interaction} days`} />;
  }
  if (listKey === 'stale-quotes' && 'quote_number' in row) {
    return (
      <>
        <Metric label="Quote" value={row.quote_number} />
        <Metric label="Quote total" value={formatCents(row.quote_total_cents)} />
        <Metric label="Quote age" value={`${row.quote_age_days} days`} />
      </>
    );
  }
  if (listKey === 'lapsed-products' && 'lapsed_count' in row) {
    return (
      <>
        <Metric label="Lapsed products" value={String(row.lapsed_count)} />
        <Metric label="Top product" value={row.top_lapsed_product_name || 'Unknown product'} />
        <Metric label="Prior revenue" value={formatCents(row.top_lapsed_product_prior_revenue_cents || 0)} />
      </>
    );
  }
  if (listKey === 'unassigned-accounts' && 'account_created_at' in row) {
    return <Metric label="Account created" value={formatListDate(row.account_created_at)} />;
  }
  return null;
}

function LoadingRows() {
  return (
    <div className="space-y-3" aria-label="Loading call list" aria-busy="true">
      {[1, 2, 3].map((item) => (
        <Card key={item} className="animate-pulse">
          <div className="h-5 w-2/3 rounded bg-gray-200" />
          <div className="mt-3 h-4 w-1/2 rounded bg-gray-100" />
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="h-10 rounded bg-gray-100" />
            <div className="h-10 rounded bg-gray-100" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function CallLists() {
  const navigate = useNavigate();
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const isAdmin = role === 'admin';
  const [selectedList, setSelectedList] = useState<CallListKey>('prepay');
  // Draft inputs (free typing) vs applied criteria (what the loader uses) —
  // keystrokes must not fire RPCs; Apply commits the draft.
  const [days, setDays] = useState({ noRecent: String(DEFAULT_NO_CONTACT_DAYS), staleQuotes: String(DEFAULT_STALE_QUOTE_DAYS) });
  const [minPriorSpend, setMinPriorSpend] = useState('1000');
  const [applied, setApplied] = useState({
    noRecentDays: DEFAULT_NO_CONTACT_DAYS,
    staleQuoteDays: DEFAULT_STALE_QUOTE_DAYS,
    minPriorSpendCents: DEFAULT_MIN_PRIOR_SPEND_CENTS,
  });
  const [repFilter, setRepFilter] = useState('');
  const [reps, setReps] = useState<Array<{ id: string; full_name: string }>>([]);
  const [repsError, setRepsError] = useState(false);
  const [repsLoadNonce, setRepsLoadNonce] = useState(0);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [tiersByCustomer, setTiersByCustomer] = useState<Record<string, number | null>>({});
  const [rows, setRows] = useState<CallListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [logCustomer, setLogCustomer] = useState<CallListRow | null>(null);
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const requestSeq = useRef(0);

  // Unassigned accounts is admin-only by construction (the RPC returns no rows
  // to reps) — hide the picker card instead of showing a falsely "clear" list.
  const visibleLists = useMemo(
    () => CALL_LISTS.filter((definition) => definition.key !== 'unassigned-accounts' || isAdmin),
    [isAdmin],
  );

  const selectedDefinition = useMemo(
    () => CALL_LISTS.find((definition) => definition.key === selectedList) || CALL_LISTS[0],
    [selectedList],
  );

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .eq('role', 'sales_rep')
        .eq('is_active', true)
        .order('full_name');
      if (cancelled) return;
      if (error || !data) {
        setRepsError(true);
        Sentry.captureException(new Error(error ? error.message : 'rep options returned no data'), { extra: { context: 'CallLists.reps' } });
        return;
      }
      setRepsError(false);
      setReps(data.flatMap((rep) => (rep.id ? [{ id: rep.id, full_name: rep.full_name || 'Unnamed rep' }] : [])));
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, repsLoadNonce]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(false);
    try {
      const repId = isAdmin && repFilter ? repFilter : null;
      let nextRows: CallListRow[];
      if (selectedList === 'prepay') {
        nextRows = await getCallListPrepayProspects(applied.minPriorSpendCents, repId);
      } else if (selectedList === 'no-recent-contact') {
        nextRows = await getCallListNoRecentContact(applied.noRecentDays, repId);
      } else if (selectedList === 'stale-quotes') {
        nextRows = await getCallListStaleQuotes(applied.staleQuoteDays, repId);
      } else if (selectedList === 'lapsed-products') {
        nextRows = await getCallListLapsedProducts(repId);
      } else {
        nextRows = await getCallListUnassignedAccounts();
      }
      if (seq !== requestSeq.current) return;
      setRows(nextRows);
    } catch (error: unknown) {
      if (seq !== requestSeq.current) return;
      setRows([]);
      setLoadError(true);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'CallLists.load', list: selectedList } });
      toast('error', errorMessage(error));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [applied, isAdmin, repFilter, selectedList, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Rows are cleared synchronously in these handlers (not just in the load
  // effect) so a stale list can never render under a newly selected list or
  // criteria; bumping the sequence also invalidates any in-flight response.
  const selectList = (key: CallListKey) => {
    if (key === selectedList) return;
    requestSeq.current += 1;
    setRows([]);
    setPeekKey(null);
    setTierFilter('');
    setSelectedList(key);
  };

  // Only the SELECTED list's criterion is committed — a draft typed on another
  // list must not silently activate when that list is opened later (Sol 3.G r2).
  const applyCriteria = () => {
    requestSeq.current += 1;
    setRows([]);
    setPeekKey(null);
    setApplied((current) => {
      if (selectedList === 'prepay') return { ...current, minPriorSpendCents: parseDollarsToCents(minPriorSpend, DEFAULT_MIN_PRIOR_SPEND_CENTS) };
      if (selectedList === 'no-recent-contact') return { ...current, noRecentDays: parseDays(days.noRecent, DEFAULT_NO_CONTACT_DAYS) };
      if (selectedList === 'stale-quotes') return { ...current, staleQuoteDays: parseDays(days.staleQuotes, DEFAULT_STALE_QUOTE_DAYS) };
      return { ...current };
    });
  };

  const changeRepFilter = (nextRep: string) => {
    requestSeq.current += 1;
    setRows([]);
    setPeekKey(null);
    setRepFilter(nextRep);
  };

  // Stale-quotes can return several quotes for one customer — customer_id
  // alone would collide as a React key.
  const rowKey = (row: CallListRow) => ('quote_id' in row ? row.quote_id : row.customer_id);

  // Tier is not part of the RPC payloads — look it up client-side for the
  // loaded rows so the tier filter needs no schema change.
  useEffect(() => {
    const ids = [...new Set(rows.map((row) => row.customer_id))];
    if (ids.length === 0) {
      setTiersByCustomer({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from('customers').select('id, assigned_tier').in('id', ids);
      if (cancelled || error || !data) return;
      setTiersByCustomer(Object.fromEntries(data.map((customer) => [customer.id, customer.assigned_tier])));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const tierOptions = useMemo(
    () => [...new Set(Object.values(tiersByCustomer).filter((tier): tier is number => tier !== null))].sort((a, b) => a - b),
    [tiersByCustomer],
  );

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (normalizedSearch && !(row.farm_name || '').toLowerCase().includes(normalizedSearch)) return false;
      if (tierFilter !== '' && String(tiersByCustomer[row.customer_id] ?? '') !== tierFilter) return false;
      return true;
    });
  }, [rows, search, tierFilter, tiersByCustomer]);

  return (
    <div className="min-h-full bg-gray-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 lg:px-8">
        <div className="mb-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-crx-green">Relationship intelligence</p>
          <h1 className="mt-1 font-heading text-2xl font-bold text-nav-dark sm:text-3xl">Call Lists</h1>
          <p className="mt-2 max-w-2xl text-sm text-secondary">Choose a reason to reach out, review the customers who need attention, and log the conversation when you are done.</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {visibleLists.map((definition) => {
            const Icon = definition.icon;
            const active = definition.key === selectedList;
            return (
              <button
                key={definition.key}
                type="button"
                aria-pressed={active}
                onClick={() => selectList(definition.key)}
                className={`min-h-[92px] rounded-xl border p-4 text-left transition-colors ${active ? 'border-crx-green bg-crx-green/5 ring-2 ring-crx-green/20' : 'border-gray-200 bg-white hover:border-gray-300'}`}
              >
                <Icon className={`h-5 w-5 ${active ? 'text-crx-green' : 'text-secondary'}`} />
                <span className="mt-2 block text-sm font-semibold text-nav-dark">{definition.label}</span>
                <span className="mt-1 block text-xs leading-4 text-secondary">{definition.description}</span>
              </button>
            );
          })}
        </div>

        <Card className="mt-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-lg font-semibold text-nav-dark">{selectedDefinition.label}</h2>
              <p className="mt-1 text-sm text-secondary">{selectedDefinition.description}</p>
            </div>
            <div className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto">
              {selectedList === 'prepay' && (
                <Input label="Minimum prior spend ($)" type="number" min="0" step="0.01" inputMode="decimal" value={minPriorSpend} onChange={(event) => setMinPriorSpend(event.target.value)} className="min-h-11 sm:w-52" />
              )}
              {selectedList === 'no-recent-contact' && (
                <Input label="No contact for (days)" type="number" min="0" step="1" inputMode="numeric" value={days.noRecent} onChange={(event) => setDays((current) => ({ ...current, noRecent: event.target.value }))} className="min-h-11 sm:w-48" />
              )}
              {selectedList === 'stale-quotes' && (
                <Input label="Quote untouched for (days)" type="number" min="0" step="1" inputMode="numeric" value={days.staleQuotes} onChange={(event) => setDays((current) => ({ ...current, staleQuotes: event.target.value }))} className="min-h-11 sm:w-52" />
              )}
              {isAdmin && selectedList !== 'unassigned-accounts' && (
                repsError ? (
                  <div className="flex items-end">
                    <Button type="button" variant="secondary" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => setRepsLoadNonce((nonce) => nonce + 1)}>Rep filter failed — retry</Button>
                  </div>
                ) : (
                  <label className="text-sm font-medium text-secondary">Sales rep
                    <select aria-label="Filter by sales rep" value={repFilter} onChange={(event) => changeRepFilter(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-nav-dark sm:w-48">
                      <option value="">All reps</option>
                      {reps.map((rep) => <option key={rep.id} value={rep.id}>{rep.full_name}</option>)}
                    </select>
                  </label>
                )
              )}
              <label className="text-sm font-medium text-secondary">Tier
                <select aria-label="Filter by customer tier" value={tierFilter} onChange={(event) => setTierFilter(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-nav-dark sm:w-32">
                  <option value="">All tiers</option>
                  {tierOptions.map((tier) => <option key={tier} value={String(tier)}>Tier {tier}</option>)}
                </select>
              </label>
              <Button type="button" variant="secondary" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} loading={loading} onClick={applyCriteria}>Apply and refresh</Button>
            </div>
          </div>
        </Card>

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
            <input aria-label="Search call list by farm name" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search farm name" className="min-h-11 w-full rounded-lg border border-gray-300 bg-white pl-10 pr-3 text-sm text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20" />
          </div>
          {!loading && !loadError && <p className="text-sm text-secondary">Showing {filteredRows.length} of {rows.length} customers</p>}
        </div>

        <div className="mt-4">
          {loading ? <LoadingRows /> : loadError ? (
            <Card>
              <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold text-nav-dark">This list could not be loaded</h2>
                  <p className="mt-1 text-sm text-secondary">Check your connection and try again.</p>
                </div>
                <Button type="button" variant="secondary" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => void load()}>Try again</Button>
              </div>
            </Card>
          ) : filteredRows.length === 0 ? (
            <Card>
              <div className="flex flex-col items-center px-3 py-8 text-center">
                <Users className="h-10 w-10 text-gray-300" />
                <h2 className="mt-3 font-semibold text-nav-dark">{search ? 'No farms match that search' : 'This call list is clear'}</h2>
                <p className="mt-1 max-w-md text-sm text-secondary">{search ? 'Try a different farm name.' : 'There are no customers meeting this list’s criteria right now.'}</p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredRows.map((row) => {
                const key = rowKey(row);
                const peeking = peekKey === key;
                return (
                  <Card key={key}>
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <h2 className="truncate text-base font-semibold text-nav-dark">{row.farm_name || 'Unnamed farm'}</h2>
                        <div className="mt-2 flex flex-col gap-1 text-sm text-secondary sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
                          <span>{row.primary_contact_name || 'Primary contact not named'}</span>
                          {row.phone_e164 ? <a className="inline-flex min-h-11 items-center gap-1 self-start text-crx-green hover:underline" href={`tel:${row.phone_e164}`}><Phone className="h-4 w-4" />{row.phone_display || row.phone_e164}</a> : <span>{row.phone_display || 'No phone on file'}</span>}
                        </div>
                        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                          <Metric label="Last contact" value={formatListDate(row.last_interaction_at)} />
                          <ListMetrics listKey={selectedList} row={row} />
                        </dl>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row lg:flex-col lg:min-w-[132px]">
                        <Button type="button" variant="secondary" className="min-h-11 w-full" icon={peeking ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} showChevron={false} aria-expanded={peeking} onClick={() => setPeekKey(peeking ? null : key)}>Call prep</Button>
                        <Button type="button" variant="secondary" className="min-h-11 w-full" icon={<ArrowUpRight className="h-4 w-4" />} showChevron={false} onClick={() => navigate(`/customers/${row.customer_id}`)}>Open</Button>
                        <Button type="button" variant="primary" className="min-h-11 w-full" icon={<PhoneCall className="h-4 w-4" />} showChevron={false} disabled={!profile?.id} onClick={() => setLogCustomer(row)}>Log call</Button>
                      </div>
                    </div>
                    {peeking && (
                      <div className="mt-4 border-t border-gray-100 pt-4">
                        <CustomerPrepCard key={row.customer_id} customerId={row.customer_id} />
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {logCustomer && profile && (
        <LogInteractionModal
          open
          onClose={() => setLogCustomer(null)}
          customerId={logCustomer.customer_id}
          userId={profile.id}
          customerName={logCustomer.farm_name || 'customer'}
          onLogged={() => void load()}
        />
      )}
    </div>
  );
}
