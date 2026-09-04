import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, CalendarClock, ChevronDown, ChevronUp, DollarSign, Phone, PhoneCall, RefreshCw, Search, Users } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../lib/parseCents';
import { ALLOWED_CROPS, type CropValue } from '../lib/crops';

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
// Call-list day lookbacks feed PostgreSQL timestamp arithmetic. Although the
// RPC parameter is int32, extreme int32 values can still underflow a timestamp
// when make_interval() is subtracted from now(). Ten years is already far past
// the useful sales horizon and keeps the database calculation safely bounded.
const MAX_CALL_LIST_DAYS = 3_650;
const CALL_LIST_QUERY_KEYS = {
  list: 'list',
  minPriorSpend: 'min_prior_spend_cents',
  noContactDays: 'no_contact_days',
  staleQuoteDays: 'stale_quote_days',
  rep: 'rep',
  tier: 'tier',
  crop: 'crop',
  search: 'search',
} as const;

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

const CALL_LIST_KEYS = new Set<CallListKey>(CALL_LISTS.map((definition) => definition.key));
const CUSTOMER_TIER_OPTIONS = [1, 2, 3] as const;

function parseNonNegativeInteger(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback;
}

function parseCallListKey(value: string | null, isAdmin: boolean): CallListKey {
  const candidate = value && CALL_LIST_KEYS.has(value as CallListKey) ? value as CallListKey : 'prepay';
  return candidate === 'unassigned-accounts' && !isAdmin ? 'prepay' : candidate;
}

function parseTier(value: string | null): string {
  return value === '1' || value === '2' || value === '3' ? value : '';
}

function parseCrop(value: string | null): CropValue | '' {
  return ALLOWED_CROPS.some((crop) => crop.value === value) ? value as CropValue : '';
}

function parseSearch(value: string | null): string {
  return value && value.length <= 100 ? value : '';
}

function centsToDraftDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function whyNowText(listKey: CallListKey, row: CallListRow): string {
  if (listKey === 'prepay' && 'prior_season_spend_cents' in row) {
    return isFiniteNumber(row.prior_season_spend_cents)
      ? `Why now: This customer spent ${formatCents(row.prior_season_spend_cents)} last season and has no current prepay.`
      : 'Why now: Prior-season spend is unavailable, and no current prepay is recorded.';
  }
  if (listKey === 'no-recent-contact' && 'days_since_last_interaction' in row) {
    return isFiniteNumber(row.days_since_last_interaction)
      ? `Why now: It has been ${row.days_since_last_interaction} days since the last recorded conversation.`
      : 'Why now: No recorded conversation is on file.';
  }
  if (listKey === 'stale-quotes' && 'quote_number' in row) {
    const quote = row.quote_number?.trim() ? `Quote ${row.quote_number}` : 'An open quote';
    const value = isFiniteNumber(row.quote_total_cents) ? `worth ${formatCents(row.quote_total_cents)}` : 'with value unavailable';
    const age = isFiniteNumber(row.quote_age_days) ? `has been untouched for ${row.quote_age_days} days` : 'has an unknown age';
    return `Why now: ${quote} ${value} ${age}.`;
  }
  if (listKey === 'lapsed-products' && 'lapsed_count' in row) {
    const count = isFiniteNumber(row.lapsed_count) && row.lapsed_count > 0 ? row.lapsed_count : 1;
    if (row.top_lapsed_product_name?.trim()) {
      const topProduct = row.top_lapsed_product_name.trim();
      const otherProducts = count > 1
        ? `; ${count - 1} other product${count - 1 === 1 ? '' : 's'} also lapsed`
        : '';
      return isFiniteNumber(row.top_lapsed_product_prior_revenue_cents)
        ? `Why now: ${topProduct} lapsed after ${formatCents(row.top_lapsed_product_prior_revenue_cents)} in prior revenue${otherProducts}.`
        : `Why now: ${topProduct} lapsed${otherProducts}; prior revenue is unavailable.`;
    }
    return isFiniteNumber(row.top_lapsed_product_prior_revenue_cents)
      ? `Why now: ${count} prior-season product${count === 1 ? ' has' : 's have'} not been purchased this season; the top product had ${formatCents(row.top_lapsed_product_prior_revenue_cents)} in prior revenue.`
      : `Why now: ${count} prior-season product${count === 1 ? ' has' : 's have'} not been purchased this season; prior revenue is unavailable.`;
  }
  return 'Why now: This customer has no assigned sales representative.';
}

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
  return Number.isSafeInteger(parsed) && parsed <= MAX_CALL_LIST_DAYS ? parsed : fallback;
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
        <Metric label="Prior season spend" value={isFiniteNumber(row.prior_season_spend_cents) ? formatCents(row.prior_season_spend_cents) : 'Unavailable'} />
        <Metric label="Current prepay" value={isFiniteNumber(row.current_season_prepay_cents) ? formatCents(row.current_season_prepay_cents) : 'Unavailable'} />
      </>
    );
  }
  if (listKey === 'no-recent-contact' && 'days_since_last_interaction' in row) {
    return <Metric label="Days since contact" value={isFiniteNumber(row.days_since_last_interaction) ? `${row.days_since_last_interaction} days` : 'Never'} />;
  }
  if (listKey === 'stale-quotes' && 'quote_number' in row) {
    return (
      <>
        <Metric label="Quote" value={row.quote_number || 'Quote number unavailable'} />
        <Metric label="Quote total" value={isFiniteNumber(row.quote_total_cents) ? formatCents(row.quote_total_cents) : 'Unavailable'} />
        <Metric label="Quote age" value={isFiniteNumber(row.quote_age_days) ? `${row.quote_age_days} days` : 'Unknown'} />
      </>
    );
  }
  if (listKey === 'lapsed-products' && 'lapsed_count' in row) {
    return (
      <>
        <Metric label="Lapsed products" value={isFiniteNumber(row.lapsed_count) ? String(row.lapsed_count) : 'Unknown'} />
        <Metric label="Top product" value={row.top_lapsed_product_name || 'Unknown product'} />
        <Metric label="Prior revenue" value={isFiniteNumber(row.top_lapsed_product_prior_revenue_cents) ? formatCents(row.top_lapsed_product_prior_revenue_cents) : 'Unavailable'} />
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
  const [searchParams, setSearchParams] = useSearchParams();
  const querySignature = searchParams.toString();
  const [reps, setReps] = useState<Array<{ id: string; full_name: string; is_active: boolean }>>([]);
  const [repsError, setRepsError] = useState(false);
  const [repsReady, setRepsReady] = useState(!isAdmin);
  const [repsLoadNonce, setRepsLoadNonce] = useState(0);

  const selectedList = parseCallListKey(searchParams.get(CALL_LIST_QUERY_KEYS.list), isAdmin);
  const applied = {
    noRecentDays: parseNonNegativeInteger(searchParams.get(CALL_LIST_QUERY_KEYS.noContactDays), DEFAULT_NO_CONTACT_DAYS, MAX_CALL_LIST_DAYS),
    staleQuoteDays: parseNonNegativeInteger(searchParams.get(CALL_LIST_QUERY_KEYS.staleQuoteDays), DEFAULT_STALE_QUOTE_DAYS, MAX_CALL_LIST_DAYS),
    minPriorSpendCents: parseNonNegativeInteger(searchParams.get(CALL_LIST_QUERY_KEYS.minPriorSpend), DEFAULT_MIN_PRIOR_SPEND_CENTS),
  };
  const requestedRepFilter = isAdmin ? searchParams.get(CALL_LIST_QUERY_KEYS.rep) || '' : '';
  const repFilter = isAdmin && reps.some((rep) => rep.id === requestedRepFilter) ? requestedRepFilter : '';
  const repValidationPending = isAdmin && requestedRepFilter !== '' && !repsReady;
  const search = parseSearch(searchParams.get(CALL_LIST_QUERY_KEYS.search));
  const tierFilter = parseTier(searchParams.get(CALL_LIST_QUERY_KEYS.tier));
  const cropFilter = parseCrop(searchParams.get(CALL_LIST_QUERY_KEYS.crop));

  // Draft inputs (free typing) vs applied criteria (what the loader uses) —
  // keystrokes must not fire RPCs; Apply commits the draft.
  const [days, setDays] = useState({
    noRecent: String(applied.noRecentDays),
    staleQuotes: String(applied.staleQuoteDays),
  });
  const [minPriorSpend, setMinPriorSpend] = useState(centsToDraftDollars(applied.minPriorSpendCents));
  const [tiersByCustomer, setTiersByCustomer] = useState<Record<string, number | null>>({});
  const [tiersError, setTiersError] = useState(false);
  const [tiersLoadNonce, setTiersLoadNonce] = useState(0);
  const [cropsByCustomer, setCropsByCustomer] = useState<Record<string, CropValue[]>>({});
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  const [rows, setRows] = useState<CallListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [logCustomer, setLogCustomer] = useState<CallListRow | null>(null);
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const updateQuery = useCallback((changes: Partial<Record<keyof typeof CALL_LIST_QUERY_KEYS, string | null>>, replace = false) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes) as Array<[keyof typeof CALL_LIST_QUERY_KEYS, string | null]>) {
        const queryKey = CALL_LIST_QUERY_KEYS[key];
        if (value === null || value === '') next.delete(queryKey);
        else next.set(queryKey, value);
      }
      return next;
    }, { replace });
  }, [setSearchParams]);

  // Unassigned accounts is admin-only by construction (the RPC returns no rows
  // to reps) — hide the picker card instead of showing a falsely "clear" list.
  const visibleLists = useMemo(
    () => CALL_LISTS.filter((definition) => definition.key !== 'unassigned-accounts' || isAdmin),
    [isAdmin],
  );

  const selectedDefinition = useMemo(
    () => visibleLists.find((definition) => definition.key === selectedList) || visibleLists[0],
    [selectedList, visibleLists],
  );

  // Canonicalize all persisted state. This strips invalid and role-forbidden
  // values instead of leaving a misleading URL that the page did not honor.
  useEffect(() => {
    if (repValidationPending) return;
    const next = new URLSearchParams();
    next.set(CALL_LIST_QUERY_KEYS.list, selectedList);
    next.set(CALL_LIST_QUERY_KEYS.minPriorSpend, String(applied.minPriorSpendCents));
    next.set(CALL_LIST_QUERY_KEYS.noContactDays, String(applied.noRecentDays));
    next.set(CALL_LIST_QUERY_KEYS.staleQuoteDays, String(applied.staleQuoteDays));
    if (repFilter) next.set(CALL_LIST_QUERY_KEYS.rep, repFilter);
    if (tierFilter) next.set(CALL_LIST_QUERY_KEYS.tier, tierFilter);
    if (cropFilter) next.set(CALL_LIST_QUERY_KEYS.crop, cropFilter);
    if (search) next.set(CALL_LIST_QUERY_KEYS.search, search);
    if (next.toString() !== querySignature) setSearchParams(next, { replace: true });
  }, [applied.minPriorSpendCents, applied.noRecentDays, applied.staleQuoteDays, cropFilter, querySignature, repFilter, repValidationPending, search, selectedList, setSearchParams, tierFilter]);

  // Back/forward and refresh restore the applied values into the editable
  // drafts without turning ordinary keystrokes into server requests.
  useEffect(() => {
    setDays({ noRecent: String(applied.noRecentDays), staleQuotes: String(applied.staleQuoteDays) });
    setMinPriorSpend(centsToDraftDollars(applied.minPriorSpendCents));
  }, [applied.minPriorSpendCents, applied.noRecentDays, applied.staleQuoteDays, selectedList]);

  useEffect(() => {
    if (!isAdmin) {
      setReps([]);
      setRepsError(false);
      setRepsReady(true);
      return;
    }
    let cancelled = false;
    setRepsReady(false);
    void (async () => {
      const { data, error } = await supabase
        .from('profile_public_view')
        .select('id, full_name, is_active')
        .eq('role', 'sales_rep')
        .order('full_name');
      if (cancelled) return;
      if (error || !data) {
        setRepsError(true);
        // A requested rep cannot be validated while the option lookup is
        // unavailable. Stay pending so canonicalization preserves `rep=` and
        // the list loader cannot silently broaden to every representative.
        setRepsReady(false);
        Sentry.captureException(new Error(error ? error.message : 'rep options returned no data'), { extra: { context: 'CallLists.reps' } });
        return;
      }
      setRepsError(false);
      setReps(data.flatMap((rep) => (rep.id ? [{
        id: rep.id,
        full_name: rep.full_name || 'Unnamed rep',
        is_active: rep.is_active === true,
      }] : [])));
      setRepsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, repsLoadNonce]);

  const load = useCallback(async () => {
    if (repValidationPending) return;
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
      setEnrichmentLoading(nextRows.length > 0);
    } catch (error: unknown) {
      if (seq !== requestSeq.current) return;
      setRows([]);
      setEnrichmentLoading(false);
      setLoadError(true);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'CallLists.load', list: selectedList } });
      toast('error', 'We could not load this call list. Please retry.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [applied.minPriorSpendCents, applied.noRecentDays, applied.staleQuoteDays, isAdmin, repFilter, repValidationPending, selectedList, toast]);

  useEffect(() => {
    if (!repValidationPending) void load();
  }, [load, repValidationPending]);

  const loadIdentity = `${selectedList}|${applied.minPriorSpendCents}|${applied.noRecentDays}|${applied.staleQuoteDays}|${repValidationPending ? 'pending' : repFilter}`;
  const previousLoadIdentity = useRef(loadIdentity);
  useLayoutEffect(() => {
    if (previousLoadIdentity.current === loadIdentity) return;
    previousLoadIdentity.current = loadIdentity;
    requestSeq.current += 1;
    setRows([]);
    setPeekKey(null);
    setLoading(true);
  }, [loadIdentity]);

  // Rows are cleared synchronously in these handlers (not just in the load
  // effect) so a stale list can never render under a newly selected list or
  // criteria; bumping the sequence also invalidates any in-flight response.
  const selectList = (key: CallListKey) => {
    if (key === selectedList || !visibleLists.some((definition) => definition.key === key)) return;
    requestSeq.current += 1;
    setRows([]);
    setPeekKey(null);
    setLoading(true);
    updateQuery({ list: key, tier: null, crop: null });
  };

  // Only the SELECTED list's criterion is committed — a draft typed on another
  // list must not silently activate when that list is opened later (Sol 3.G r2).
  const applyCriteria = () => {
    // Validate the prepay threshold BEFORE any state is cleared (Codex P2 on PR #588):
    // a refused value must leave the currently applied list on screen. Clearing the
    // rows first rendered "This call list is clear" for a list that was never re-queried.
    // Blank falls back to the default; an explicit "0" is a legitimate show-everyone
    // threshold and must NOT be coerced to the default. A threshold with more than two
    // decimals is refused (null); it must not fall through to 0 either.
    let prepayThresholdCents: number | null = null;
    if (selectedList === 'prepay') {
      const parsedThreshold = minPriorSpend.trim() === '' ? DEFAULT_MIN_PRIOR_SPEND_CENTS : parseDollarsToCents(minPriorSpend);
      if (parsedThreshold === null) { toast('error', `Minimum prior spend: ${MONEY_PRECISION_MESSAGE}`); return; }
      prepayThresholdCents = Math.max(0, parsedThreshold);
    }
    requestSeq.current += 1;
    setRows([]);
    setPeekKey(null);
    setLoading(true);
    if (selectedList === 'prepay') {
      const cents = prepayThresholdCents ?? DEFAULT_MIN_PRIOR_SPEND_CENTS;
      if (cents === applied.minPriorSpendCents) void load();
      else updateQuery({ minPriorSpend: String(cents) });
    } else if (selectedList === 'no-recent-contact') {
      const nextDays = parseDays(days.noRecent, DEFAULT_NO_CONTACT_DAYS);
      if (nextDays === applied.noRecentDays) void load();
      else updateQuery({ noContactDays: String(nextDays) });
    } else if (selectedList === 'stale-quotes') {
      const nextDays = parseDays(days.staleQuotes, DEFAULT_STALE_QUOTE_DAYS);
      if (nextDays === applied.staleQuoteDays) void load();
      else updateQuery({ staleQuoteDays: String(nextDays) });
    } else {
      void load();
    }
  };

  const changeRepFilter = (nextRep: string) => {
    requestSeq.current += 1;
    setRows([]);
    setPeekKey(null);
    setLoading(true);
    updateQuery({ rep: nextRep || null });
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % visibleLists.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + visibleLists.length) % visibleLists.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = visibleLists.length - 1;
    const target = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex];
    target?.focus();
    selectList(visibleLists[nextIndex].key);
  };

  // Stale-quotes can return several quotes for one customer — customer_id
  // alone would collide as a React key.
  const rowKey = (row: CallListRow) => ('quote_id' in row ? row.quote_id : row.customer_id);

  // Tier and crops are not part of the RPC payloads — look them up client-side
  // for the loaded rows in one shared query so neither filter needs a schema
  // change to the call-list RPCs themselves.
  useEffect(() => {
    const ids = [...new Set(rows.map((row) => row.customer_id))];
    if (ids.length === 0) {
      setTiersByCustomer({});
      setCropsByCustomer({});
      setTiersError(false);
      setEnrichmentLoading(false);
      return;
    }
    let cancelled = false;
    setEnrichmentLoading(true);
    void (async () => {
      const { data, error } = await supabase.from('customers').select('id, assigned_tier, crops').in('id', ids);
      if (cancelled) return;
      if (error || !data) {
        // Fail SAFE: clear tier/crop data and force both filters off so a
        // partial lookup can never silently hide rows — the selects are
        // replaced by a retry button until the lookup succeeds (Sol 3.G r3).
        setTiersByCustomer({});
        setCropsByCustomer({});
        updateQuery({ tier: null, crop: null }, true);
        setTiersError(true);
        setEnrichmentLoading(false);
        Sentry.captureException(new Error(error ? error.message : 'tier lookup returned no data'), { extra: { context: 'CallLists.tiers' } });
        return;
      }
      setTiersError(false);
      setTiersByCustomer(Object.fromEntries(data.map((customer) => [customer.id, customer.assigned_tier])));
      setCropsByCustomer(Object.fromEntries(data.map((customer) => [customer.id, (customer.crops ?? []) as CropValue[]])));
      setEnrichmentLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, tiersLoadNonce, updateQuery]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (normalizedSearch && !(row.farm_name || '').toLowerCase().includes(normalizedSearch)) return false;
      if (tierFilter !== '' && String(tiersByCustomer[row.customer_id] ?? '') !== tierFilter) return false;
      if (cropFilter !== '' && !(cropsByCustomer[row.customer_id] || []).includes(cropFilter)) return false;
      return true;
    });
  }, [rows, search, tierFilter, tiersByCustomer, cropFilter, cropsByCustomer]);
  const requiredEnrichmentPending = enrichmentLoading && (tierFilter !== '' || cropFilter !== '');

  return (
    <div className="min-h-full bg-gray-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 lg:px-8">
        <div className="mb-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-crx-green">Relationship intelligence</p>
          <h1 className="mt-1 font-heading text-2xl font-bold text-nav-dark sm:text-3xl">Call Lists</h1>
          <p className="mt-2 max-w-2xl text-sm text-secondary">Choose a reason to reach out, review the customers who need attention, and log the conversation when you are done.</p>
        </div>

        <div
          role="tablist"
          aria-label="Call list reason"
          className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0 sm:pb-0 lg:grid-cols-5"
        >
          {visibleLists.map((definition, index) => {
            const Icon = definition.icon;
            const active = definition.key === selectedList;
            return (
              <button
                key={definition.key}
                type="button"
                id={`call-list-tab-${definition.key}`}
                role="tab"
                aria-label={definition.label}
                aria-selected={active}
                aria-controls="call-list-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => selectList(definition.key)}
                onKeyDown={(event) => handleListKeyDown(event, index)}
                className={`min-h-11 min-w-[10rem] snap-start rounded-xl border px-3 py-2 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-crx-green sm:min-h-[92px] sm:min-w-0 sm:p-4 ${active ? 'border-crx-green bg-crx-green/5 ring-2 ring-crx-green/20' : 'border-gray-200 bg-white hover:border-gray-300'}`}
              >
                <span className="flex items-center gap-2 sm:block">
                  <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-crx-green' : 'text-secondary'}`} />
                  <span className="block text-sm font-semibold text-nav-dark sm:mt-2">{definition.label}</span>
                </span>
                <span className="mt-1 hidden text-xs leading-4 text-secondary sm:block">{definition.description}</span>
              </button>
            );
          })}
        </div>

        <div id="call-list-panel" role="tabpanel" aria-labelledby={`call-list-tab-${selectedList}`}>
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
                  <Button type="button" variant="secondary" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => { setRepsReady(false); setRepsLoadNonce((nonce) => nonce + 1); }}>Rep filter failed — retry</Button>
                  </div>
                ) : (
                  <label className="text-sm font-medium text-secondary">Sales rep
                    <select aria-label="Filter by sales rep" value={repFilter} onChange={(event) => changeRepFilter(event.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-nav-dark sm:w-48">
                      <option value="">All reps</option>
                      {reps.map((rep) => (
                        <option key={rep.id} value={rep.id}>
                          {rep.full_name}{rep.is_active ? '' : ' (inactive)'}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              )}
              {tiersError ? (
                <div className="flex items-end">
                  <Button type="button" variant="secondary" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => setTiersLoadNonce((nonce) => nonce + 1)}>Tier/crop filter failed — retry</Button>
                </div>
              ) : (
                <>
                  <label className="text-sm font-medium text-secondary">Tier
                    <select aria-label="Filter by customer tier" value={tierFilter} onChange={(event) => updateQuery({ tier: event.target.value || null })} className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-nav-dark sm:w-32">
                      <option value="">All tiers</option>
                      {CUSTOMER_TIER_OPTIONS.map((tier) => <option key={tier} value={String(tier)}>Tier {tier}</option>)}
                    </select>
                  </label>
                  <label className="text-sm font-medium text-secondary">Crop
                    <select aria-label="Filter by customer crop" value={cropFilter} onChange={(event) => updateQuery({ crop: event.target.value || null })} className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-nav-dark sm:w-36">
                      <option value="">All crops</option>
                      {ALLOWED_CROPS.map((crop) => <option key={crop.value} value={crop.value}>{crop.label}</option>)}
                    </select>
                  </label>
                </>
              )}
              <Button type="button" variant="secondary" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} loading={loading} onClick={applyCriteria}>Apply and refresh</Button>
            </div>
          </div>
        </Card>

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
            <input aria-label="Search call list by farm name" value={search} maxLength={100} onChange={(event) => updateQuery({ search: event.target.value || null }, true)} placeholder="Search farm name" className="min-h-11 w-full rounded-lg border border-gray-300 bg-white pl-10 pr-3 text-sm text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20" />
          </div>
          {!loading && !requiredEnrichmentPending && !loadError && <p className="text-sm text-secondary">Showing {filteredRows.length} of {rows.length} customers</p>}
        </div>

        <div className="mt-4">
          {loading || requiredEnrichmentPending ? <LoadingRows /> : loadError ? (
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
                        <p className="mt-3 rounded-lg border border-crx-green/20 bg-crx-green/5 px-3 py-2 text-sm font-medium leading-5 text-nav-dark">
                          {whyNowText(selectedList, row)}
                        </p>
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
