import { useEffect, useLayoutEffect, useRef, useState , useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Plus, Trash2, Search, MapPin, FileText, Truck, AlertTriangle, MessageSquarePlus, Copy, ClipboardList, Zap, SprayCan, PhoneCall } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import CommissionSplitEditor from '../components/ui/CommissionSplitEditor';
import ApplicationServicePicker from '../components/field-app/ApplicationServicePicker';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import RecordVersionConflictDialog from '../components/ui/RecordVersionConflictDialog';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { supabase, supabaseUntyped, assertRpcResult, checkMutationResult, hasRpcCode, RpcErrorCodes, sanitizeError } from '../lib/db';
import { isBelowCostApprovalHandledError, withBelowCostReason } from '../lib/belowCostApproval';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { parseLocalDate, localToday } from '../lib/dateUtils';
import QuickTaskModal from '../components/team/QuickTaskModal';
import RelatedNotes from '../components/team/RelatedNotes';
import type { Customer, CustomerAddress, CommissionSplit, Quote, Order, Delivery, DeliveryRemainder, Field, LinkedEntityType, ActivityFeedItem } from '../types';
import type { Json } from '../types/supabase';
import { Sentry } from '../lib/sentry';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../lib/parseCents';
import { formatUSD as fmt } from '../lib/money';
import { buildCommissionSplitPatch, nextLoadedSplitSnapshot } from '../lib/commissionSplitConcurrency';
import {
  buildRowVersionPatch,
  readRowVersion,
  resolveAuthoritativeSaveRowVersion,
  resolveDirectMutationRowVersion,
} from '../lib/recordVersionConcurrency';
import { ALLOWED_CROPS, type CropValue } from '../lib/crops';
import { logActivity } from '../lib/activityLogger';
import CustomerSummaryBar from '../components/customers/CustomerSummaryBar';
import YearEndSummaryDialog from '../components/reports/YearEndSummaryDialog';
import CustomerContacts, { CustomerInteractionsHistory } from '../components/customers/CustomerContacts';
import LogInteractionModal from '../components/customers/LogInteractionModal';
import CustomerFacts from '../components/customers/CustomerFacts';
import CustomerPrepCard from '../components/customers/CustomerPrepCard';
import CustomerDocuments from '../components/customers/CustomerDocuments';
import { downloadYearEndSummaryPdf } from '../lib/yearEndSummaryPdf';
import type { YearEndSummaryOptions } from '../lib/yearEndSummaryPdf';
import type { YearEndSummaryData } from '../types';

// P3 perf: lazy-load the heavy Mapbox map components so CustomerDetail (a
// high-traffic page) doesn't pull the ~1.68 MB vendor-mapbox chunk on initial
// load — only when the Field Locations card actually renders.
const MapContainer = lazy(() => import('../components/map/MapContainer'));
const FieldMarkers = lazy(() => import('../components/map/FieldMarkers'));

interface PurchaseHistoryItem {
  product_name: string;
  total_units: number;
  total_spent: number;
  total_delivered: number;
  order_count: number;
}

interface FieldGeoRow extends Field {
  customer_name?: string;
}

interface RemainderRow {
  id: string;
  product?: { product_name: string } | null;
  original_delivery?: { delivery_number: string } | null;
  [key: string]: unknown;
}

// The create-form defaults, shared by the initial mount and the per-route reset
// below. They have to be the same object shape in both places: /customers/new
// reached by navigating FROM an existing customer reuses this component and runs
// the reset, so resetting to `{}` there would drop `assigned_sales_rep`,
// `assigned_tier`, `is_active` and the default split that a fresh visit gets —
// and `save_customer` rejects a rep who has not self-assigned. (Codex, PR #313.)
const makeBlankCustomer = (salesRepId: string | undefined): Partial<Customer> => ({
  farm_name: '',
  contact_name: '',
  phone: '',
  email: '',
  billing_address: '',
  assigned_tier: 1,
  assigned_sales_rep: salesRepId,
  total_acres: undefined,
  corn_acres: undefined,
  soybean_acres: undefined,
  other_acres: undefined,
  payment_terms: '',
  notes: '',
  is_active: true,
  default_commission_split: { splits: [{ recipient: '', percentage: 100 }] },
  default_application_service_id: null,
});

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const duplicateQuoteIdem = useIdempotencyKey('duplicate_quote', profile?.id || '');
  // Scoped by the ROUTE ID because F1 makes this key OUTLIVE an ambiguous reply, and
  // this page does not remount when only `:id` changes (no `<x>/:id` route in
  // src/App.tsx carries a `key` prop). Unscoped, customer B would inherit customer A's
  // unresolved key and its save would come back IDEMPOTENCY_PAYLOAD_CONFLICT — the
  // server fails closed, so no cross-customer write, but B gets a conflict dialog it
  // did nothing to earn. Route-id scoping is sound HERE specifically because the RPC
  // targets the route record: it sends `p_customer_id: (isNew ? null : id)`.
  //
  // RESIDUAL, stated rather than implied: two consecutive CREATES both scope to 'new',
  // so an unresolved create can still be inherited by the next one. Binding that needs
  // the request payload (PR #535's fingerprintIntentPayload), not the URL.
  const saveCustomerIntentScope = id ?? '';
  const {
    getKey: getSaveCustomerIdempotencyKey,
    resetKey: resetSaveCustomerIdempotencyKey,
    resetKeyFor: resetSaveCustomerIdempotencyKeyFor,
  } = useIdempotencyKey('save_customer', profile?.id || '', saveCustomerIntentScope);
  // Which scope produced the conflict the stale-save dialog is currently offering to
  // recover. Scoping the key made this necessary: the dialog stays open across a route
  // change, and `reloadAfterStaleSave` releases the CURRENT render's scope, so an
  // operator who navigates A -> B with A's dialog open and then clicks Reload would
  // release B's key and strand A's rejected one — returning to A would replay it and
  // re-open the same conflict. Recorded when the conflict opens, checked before
  // anything is released. Same defect and same fix as QuoteBuilder's.
  // `payloadRejected` records WHY the dialog opened, because the two reasons have
  // opposite safe directions once the route has moved on. See the recovery below.
  const staleSaveConflictScopeRef = useRef<{ scope: string; payloadRejected: boolean } | null>(null);
  const isNew = id === 'new';

  const [customer, setCustomer] = useState<Partial<Customer>>(() => makeBlankCustomer(profile?.id));
  // Read by the route-change reset, which must not re-run when the profile
  // resolves — that would clobber an already-loaded customer.
  const salesRepIdRef = useRef(profile?.id);
  salesRepIdRef.current = profile?.id;
  const [addresses, setAddresses] = useState<Partial<CustomerAddress>[]>([]);
  // Lost-update guard: split as loaded from the DB, and whether the user has
  // changed it this session (see src/lib/commissionSplitConcurrency.ts).
  const loadedDefaultSplitRef = useRef<Customer['default_commission_split'] | null>(null);
  const defaultSplitTouchedRef = useRef(false);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  // Narrow local structural state: generated types are refreshed only after apply.
  const customerRowVersionRef = useRef<number | null>(null);
  const [staleSaveOpen, setStaleSaveOpen] = useState(false);
  const [tab, setTab] = useState<'info' | 'contacts' | 'knowledge' | 'documents' | 'timeline' | 'fields' | 'quotes' | 'orders' | 'deliveries' | 'financials' | 'history'>('info');
  const [timeline, setTimeline] = useState<ActivityFeedItem[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [orders, setOrders] = useState<(Order & { fulfillment_pct: number })[]>([]);
  const [deliveries, setDeliveries] = useState<(Delivery & { driver_name: string })[]>([]);
  const [fields, setFields] = useState<(Field & { customer_name: string })[]>([]);
  const [history, setHistory] = useState<PurchaseHistoryItem[]>([]);
  const [customerRemainders, setCustomerRemainders] = useState<DeliveryRemainder[]>([]);
  const [tabLoading, setTabLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [showSummaryDialog, setShowSummaryDialog] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);
  const [logInteractionOpen, setLogInteractionOpen] = useState(false);
  const [interactionRefresh, setInteractionRefresh] = useState(0);
  const [quotePlannedFilter, setQuotePlannedFilter] = useState(false);

  // Crops chips save immediately on tap (direct update, not part of the
  // save_customer RPC payload/handleSave flow) — cropSaving tracks which
  // chip is in flight so it can show a busy state without blocking the rest
  // of the form.
  const [crops, setCrops] = useState<CropValue[]>([]);
  const [cropSaving, setCropSaving] = useState<CropValue | null>(null);

  // Financials tab state
  interface AgingRow { customer_id: string; farm_name: string; current_amount: number; days_30: number; days_60: number; days_90: number; over_90: number; total_outstanding: number; open_credit_cents?: number | null }
  interface TxnRow { transaction_date: string; transaction_type: string; reference_number: string; amount_cents: number; running_balance: number }
  interface PrepayRow { id: string; bucket_label: string; original_amount_cents: number; balance_cents: number }
  const [aging, setAging] = useState<AgingRow | null>(null);
  const [transactions, setTransactions] = useState<TxnRow[]>([]);
  const [prepayCredits, setPrepayCredits] = useState<PrepayRow[]>([]);
  const [financialsLoading, setFinancialsLoading] = useState(false);
  const financialsFetched = useRef(false);

  // Parent customer search
  const [allCustomers, setAllCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [parentSearch, setParentSearch] = useState('');
  const [showParentDropdown, setShowParentDropdown] = useState(false);
  const [parentName, setParentName] = useState('');

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const suppressDirtyUntilReloadSettlesRef = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  // The tab loader below guards its writes with a sequence number, but the PRIMARY
  // record needs the same discipline and did not have it. The per-customer reads
  // below are recreated per route id, so the `id` each closes over names the
  // customer it was started FOR, while this ref always holds the one the route is
  // on NOW. Navigating A -> B while A's reads are in flight would otherwise let A
  // install its customer, addresses and row version over B — and the next save
  // would then write A's form payload to B's id under A's row version.
  //
  // Written in a layout effect, never during render: React may replay or discard
  // a render, and a discarded render's write would publish a customer id that was
  // never committed — leaving in-flight reads comparing against a route the user
  // is not on. A layout effect runs on commit and before the data-loading passive
  // effects below, so the ref is always the committed route by the time any fetch
  // that reads it starts.
  const currentIdRef = useRef(id);
  useLayoutEffect(() => {
    currentIdRef.current = id;
  }, [id]);

  const fetchAddresses = useCallback(async () => {
    const { data, error } = await supabase.from('customer_addresses').select('*').eq('customer_id', id!).order('created_at');
    // Reached from the post-save reload as well as the snapshot, so it outlives
    // both. A save for customer A that finishes just before the route changes
    // starts THIS read against A; without the guard its rows land in customer B's
    // form, and the save guard cannot help — it has already run by then.
    if (currentIdRef.current !== id) return false;
    if (error) {
      Sentry.captureException(error, { tags: { source: 'read', action: 'load_customer_addresses' } });
      toast('error', 'Failed to load addresses');
      return false;
    }
    setAddresses((data || []) as Partial<CustomerAddress>[]);
    return true;
  }, [id, toast]);

  const fetchCustomerSnapshot = useCallback(async (requireStableRowVersion = false): Promise<boolean> => {
    if (!id) return false;
    // Silent by design: a superseded load is not a failure the user needs to see,
    // and it must not clear loading state or toast over the customer now on screen.
    const isSuperseded = () => currentIdRef.current !== id;
    const customerRes = await supabase.from('customers').select('*').eq('id', id).maybeSingle();
    if (isSuperseded()) return false;

    // Do not install either half until both required reads succeeded. This is
    // especially important after a stale-save conflict: the user must retain
    // every local field/address edit if Reload cannot build a complete snapshot.
    if (customerRes.error || !customerRes.data) {
      if (customerRes.error) Sentry.captureException(customerRes.error, { tags: { source: 'read', action: 'load_customer_snapshot' } });
      toast('error', 'Could not load the complete customer record. Your current edits were kept; try Reload again or refresh the page.');
      setLoading(false);
      return false;
    }

    const loadedCustomer = customerRes.data as Customer;
    const initialRowVersion = readRowVersion((loadedCustomer as Customer & { row_version?: unknown }).row_version);
    const addressesRes = await supabase
      .from('customer_addresses')
      .select('*')
      .eq('customer_id', id)
      .order('created_at');
    if (isSuperseded()) return false;
    if (addressesRes.error) {
      Sentry.captureException(addressesRes.error, { tags: { source: 'read', action: 'load_customer_addresses_snapshot' } });
      toast('error', 'Could not load the complete customer record. Your current edits were kept; try Reload again or refresh the page.');
      setLoading(false);
      return false;
    }

    const { data: finalHeader, error: finalHeaderError } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (isSuperseded()) return false;
    const finalRowVersion = readRowVersion((finalHeader as { row_version?: unknown } | null)?.row_version);
    const stableVersion = initialRowVersion === finalRowVersion
      && (initialRowVersion !== null || !requireStableRowVersion);
    if (finalHeaderError || !finalHeader || !stableVersion) {
      if (finalHeaderError) Sentry.captureException(finalHeaderError, { tags: { source: 'read', action: 'confirm_customer_snapshot_version' } });
      toast('error', 'Could not confirm a stable saved customer. Your current edits were kept; try Reload again or refresh the page.');
      setLoading(false);
      return false;
    }

    const loadedAddresses = (addressesRes.data || []) as Partial<CustomerAddress>[];
    // Install the complete, validated snapshot atomically from React's event
    // batch. There is no intermediate empty-address or partially-updated form.
    setCustomer(loadedCustomer);
    customerRowVersionRef.current = finalRowVersion;
    loadedDefaultSplitRef.current = loadedCustomer.default_commission_split ?? null;
    defaultSplitTouchedRef.current = false;
    setCrops((loadedCustomer.crops ?? []) as CropValue[]);
    setAddresses(loadedAddresses);
    setParentName('');
    setLoading(false);
    // Superseded-guarded like every other deferred write in this loader. The
    // flag is deliberately set a macrotask late, so a route change can land in
    // the gap: without this check, customer A's timer re-arms the flag after
    // the route-change effect cleared it, and customer B's freshly loaded
    // snapshot is then marked dirty — an unsaved-changes prompt on a record
    // nobody edited. (CodeRabbit, PR #313.)
    setTimeout(() => {
      if (isSuperseded()) return;
      initialLoadDone.current = true;
    }, 0);

    // Parent display text is auxiliary to the editable customer/address
    // snapshot, so a parent lookup failure cannot discard this complete reload.
    if (loadedCustomer.parent_customer_id) {
      void supabase
        .from('customers')
        .select('farm_name')
        .eq('id', loadedCustomer.parent_customer_id)
        .maybeSingle()
        .then(({ data: parent, error: parentError }) => {
          // Outlives the snapshot it belongs to, so it needs the same guard.
          if (isSuperseded()) return;
          if (parentError) {
            Sentry.captureException(parentError, { tags: { source: 'read', action: 'load_parent_customer_name' } });
            toast('warning', 'Customer loaded, but the parent customer name could not be refreshed.');
          } else if (parent) {
            setParentName(parent.farm_name);
          }
        });
    }

    return true;
  }, [id, toast]);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    if (suppressDirtyUntilReloadSettlesRef.current) return;
    setIsDirty(true);
  }, [customer, addresses]);

  const reloadAfterStaleSave = useCallback(async () => {
    suppressDirtyUntilReloadSettlesRef.current = true;
    let installedSnapshot = false;
    try {
      // Before the migration lands, a live commission-split conflict can still
      // open this dialog while the record has no row_version. Preserve the
      // legacy double-read reload in that window; require a numeric stability
      // token as soon as this page has ever loaded one.
      installedSnapshot = await fetchCustomerSnapshot(customerRowVersionRef.current !== null);
      if (installedSnapshot) {
        // The rejected key may represent a committed save whose response was
        // lost. Rotate it only after a complete authoritative reload succeeds —
        // and only when that reload is for the SAME customer that produced the
        // conflict. Releasing here after a route change would retire the wrong
        // scope's key and strand the rejected one; leaving it retained is the
        // safe direction, because a retained key can still replay.
        const conflictOrigin = staleSaveConflictScopeRef.current;
        if (conflictOrigin === null || conflictOrigin.scope === saveCustomerIntentScope) {
          resetSaveCustomerIdempotencyKey();
          staleSaveConflictScopeRef.current = null;
        } else if (conflictOrigin.payloadRejected) {
          // The route moved on, so this reload installed a DIFFERENT customer and the
          // rule above correctly refuses to release the current scope's key. But the
          // dialog closes here, so the originating customer's key must not be left in
          // the map: returning to that customer would replay it and earn the same
          // conflict again.
          //
          // Safe only for a payload conflict, where the server has already proven the
          // key is bound to a different payload and can only ever reject it again. A
          // stale-row or commission-split refusal is the opposite case: that key may
          // still be the replay handle for an earlier save whose response was lost, so
          // it stays retained until its own customer is reloaded.
          resetSaveCustomerIdempotencyKeyFor(conflictOrigin.scope);
          staleSaveConflictScopeRef.current = null;
        }
        setIsDirty(false);
        setStaleSaveOpen(false);
      }
    } finally {
      let released = false;
      const releaseDirtySuppression = () => {
        if (released) return;
        released = true;
        suppressDirtyUntilReloadSettlesRef.current = false;
        if (installedSnapshot) setIsDirty(false);
      };
      const fallback = window.setTimeout(releaseDirtySuppression, 250);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        releaseDirtySuppression();
      }));
    }
    return installedSnapshot;
    // saveCustomerIntentScope is required, not cosmetic: without it this callback
    // compares the conflict's recorded scope against a STALE one, which is the exact
    // confusion the check exists to prevent.
  }, [fetchCustomerSnapshot, resetSaveCustomerIdempotencyKey, resetSaveCustomerIdempotencyKeyFor, saveCustomerIntentScope]);

  useEffect(() => {
    // Fetch all customers for parent selector
    void supabase.from('customers').select('id, farm_name').eq('is_active', true).order('farm_name').limit(500)
      .then(({ data, error }) => {
        if (error) { toast('error', 'Failed to load customer list'); return; }
        setAllCustomers((data || []) as { id: string; farm_name: string }[]);
    });

    if (!isNew && id) {
      void fetchCustomerSnapshot();
    } else {
      // New customer — mark ready immediately. Same deferred-flag hazard as the
      // snapshot loader above: navigating from /customers/new to an existing
      // customer while this timer is pending would otherwise re-arm the flag
      // and mark that customer's loaded snapshot dirty.
      setTimeout(() => {
        if (currentIdRef.current !== id) return;
        initialLoadDone.current = true;
      }, 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew, fetchCustomerSnapshot]);

  // CustomerDetail is NOT remounted when only :id changes (the route element has
  // no key), so every per-customer tab cache below must be invalidated by hand.
  // Same discipline the CRM child components got via `key={id}` (Sol 2.G r2):
  // an in-flight tab load for customer A must never write into customer B's
  // view, and B must never render A's leftover rows while its own load runs.
  const tabRequestSeq = useRef(0);

  useEffect(() => {
    tabRequestSeq.current += 1;
    setQuotes([]);
    setOrders([]);
    setDeliveries([]);
    setFields([]);
    setHistory([]);
    setCustomerRemainders([]);
    setTimeline([]);
    setAging(null);
    setTransactions([]);
    setPrepayCredits([]);
    // Without this reset the financials tab short-circuits on the cached flag and
    // renders the PREVIOUS customer's AR aging, statement and prepay credits.
    financialsFetched.current = false;

    // The PRIMARY record needs the same invalidation, not just the tabs. Guarding
    // the in-flight writes stops the previous customer being installed over this
    // one, but on its own it still leaves that customer on screen — name, form
    // fields, addresses, row version — until the new snapshot lands. Editing then
    // looks like editing this customer while every field belongs to the last one.
    // Drop it and show the loading skeleton until the real record arrives.
    //
    // `isNew` is NOT exempt, though an earlier version of this returned early on
    // the reasoning that a blank form needs no invalidation. That only holds when
    // /customers/new is opened fresh. Navigating to it FROM an existing customer
    // reuses this component, so the early return left that customer's name, form
    // fields, addresses and row version on screen behind a "Create Customer"
    // button — and saving sent the stale payload with `p_customer_id: null`,
    // duplicating the old record as a new customer. (Codex, PR #313.)
    //
    // So the clears always run; only the skeleton is conditional, because a new
    // customer genuinely has nothing to fetch. The reset goes back to the create
    // defaults rather than `{}` — on /customers/new they ARE the form, and an
    // existing customer overwrites them wholesale when its snapshot lands.
    setCustomer(makeBlankCustomer(salesRepIdRef.current));
    setAddresses([]);
    setCrops([]);
    setParentName('');
    customerRowVersionRef.current = null;
    loadedDefaultSplitRef.current = null;
    defaultSplitTouchedRef.current = false;
    initialLoadDone.current = false;
    setIsDirty(false);
    setLoading(!isNew);
  }, [id, isNew]);

  const fetchTabData = useCallback(async (selectedTab: string) => {
    const seq = ++tabRequestSeq.current;
    const isStale = () => seq !== tabRequestSeq.current;
    setTabLoading(true);
    if (selectedTab === 'fields') {
      const { data, error: fieldError } = await supabase.rpc('get_fields_with_geojson', { p_customer_id: id });
      if (fieldError) {
        Sentry.captureException(fieldError, { tags: { source: 'fetch', action: 'load_customer_fields' } });
        toast('error', 'Failed to load fields');
      }
      const rows = (assertRpcResult<FieldGeoRow[]>(data, 'get_fields_with_geojson')).map((f) => ({
        ...f,
        customer_name: f.customer_name || '',
      }));
      if (isStale()) return;
      setFields(rows);
    } else if (selectedTab === 'quotes') {
      const { data } = await supabase
        .from('quotes')
        .select('*')
        .eq('customer_id', id!)
        .order('created_at', { ascending: false });
      if (isStale()) return;
      setQuotes((data || []) as Quote[]);
    } else if (selectedTab === 'orders') {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('customer_id', id!)
        .is('deleted_at', null)
        .order('order_date', { ascending: false });
      const rows = ((data || []) as Order[]).map((o) => {
        return { ...o, fulfillment_pct: 0 };
      });
      if (isStale()) return;
      setOrders(rows);

      const orderIds = rows.map((o) => o.id);
      if (orderIds.length > 0) {
        const { data: itemsData } = await supabase
          .from('order_items')
          .select('order_id, total_units_needed, quantity_delivered')
          .in('order_id', orderIds);
        const byOrder: Record<string, { needed: number; delivered: number }> = {};
        (itemsData || []).forEach((item) => {
          if (!byOrder[item.order_id]) byOrder[item.order_id] = { needed: 0, delivered: 0 };
          byOrder[item.order_id].needed += item.total_units_needed || 0;
          byOrder[item.order_id].delivered += item.quantity_delivered || 0;
        });
        if (isStale()) return;
        setOrders((prev) =>
          prev.map((o) => {
            const stats = byOrder[o.id];
            return {
              ...o,
              fulfillment_pct: stats && stats.needed > 0 ? Math.round((stats.delivered / stats.needed) * 100) : 0,
            };
          })
        );
      }
    } else if (selectedTab === 'deliveries') {
      // PR-07 follow-up: dropped driver FK embed; resolve via profile_public_view.
      const { data } = await supabase
        .from('deliveries')
        .select('*')
        .eq('customer_id', id!)
        .order('scheduled_date', { ascending: false });
      const driverIds = [...new Set(
        ((data || []) as Delivery[])
          .map((d) => d.assigned_driver)
          .filter(Boolean) as string[]
      )];
      const driverMap: Record<string, string> = {};
      if (driverIds.length > 0) {
        const { data: driverData } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', driverIds);
        (driverData || []).forEach((p: { id: string | null; full_name: string | null }) => { if (p.id) driverMap[p.id] = p.full_name ?? ''; });
      }
      const rows = ((data || []) as Delivery[]).map((d) => ({
        ...d,
        driver_name: d.assigned_driver ? driverMap[d.assigned_driver] || 'Unassigned' : 'Unassigned',
      }));
      if (isStale()) return;
      setDeliveries(rows);

      // Fetch pending remainders for this customer
      const { data: remData } = await supabase
        .from('delivery_remainders')
        .select('*, product:products(product_name), original_delivery:deliveries!delivery_remainders_original_delivery_id_fkey(delivery_number)')
        .eq('customer_id', id!)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      const remainders = ((remData || []) as RemainderRow[]).map((r) => ({
        ...r,
        product_name: r.product?.product_name || 'Unknown',
        original_delivery_number: r.original_delivery?.delivery_number || '-',
      }));
      if (isStale()) return;
      setCustomerRemainders(remainders as unknown as DeliveryRemainder[]);
    } else if (selectedTab === 'financials') {
      if (financialsFetched.current) { setTabLoading(false); return; }
      setFinancialsLoading(true);
      try {
        const today = localToday();
        const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        // Sequential awaits (not Promise.all) per the assertRpcResult coverage
        // convention documented in src/lib/assertRpcCoverage.test.ts:76-79 — the
        // regex requires `= await supabase.rpc(...)` immediately, which
        // Promise.all array elements don't match. The prior Promise.all
        // restoration (audit finding B2) traded the test's 0-debt baseline for
        // parallelism; the parallel-session audit (2026-05-26 §10.8) reverted
        // it to honor the codebase convention. ~2× slower on this tab only.
        const { data: agingData, error: agingError } = await supabase.rpc('get_ar_aging', { p_as_of_date: today });
        if (agingError) throw agingError;
        const allAging = assertRpcResult<AgingRow[]>(agingData, 'get_ar_aging');
        const myAging = allAging.find((a) => a.customer_id === id) || null;
        if (isStale()) return;
        setAging(myAging);

        const { data: txnData, error: txnError } = await supabase.rpc('get_customer_statement', { p_customer_id: id!, p_start_date: ninetyDaysAgo, p_end_date: today });
        if (txnError) throw txnError;
        const txnRows = assertRpcResult<TxnRow[]>(txnData, 'get_customer_statement');
        if (isStale()) return;
        setTransactions(txnRows);

        const { data: prepayData, error: prepayError } = await supabase.from('prepay_credits').select('*').eq('customer_id', id!).gt('balance_cents', 0);
        if (prepayError) throw prepayError;
        if (isStale()) return;
        setPrepayCredits((prepayData || []) as PrepayRow[]);
        financialsFetched.current = true;
      } catch (err: unknown) {
        if (isStale()) return;
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'customer_financials_tab' } });
        toast('error', 'Failed to load financials');
      } finally {
        if (!isStale()) setFinancialsLoading(false);
      }
    } else if (selectedTab === 'timeline') {
      setTimelineLoading(true);
      try {
        const { data: tlData, error: tlError } = await supabase
          .from('activity_feed')
          .select('*')
          .eq('customer_id', id!)
          .order('created_at', { ascending: false })
          .limit(50);
        if (tlError) toast('error', 'Failed to load timeline');

        // PR-07 follow-up: resolve performer names via profile_public_view (safe
        // columns only) so non-admin users still see actor names after
        // profiles_select tightens to admin-or-self. The timeline UI only reads
        // performer.full_name (CustomerDetail.tsx ~line 796), so partial Profile
        // shape via a cast is intentional here.
        const rows = (tlData || []) as ActivityFeedItem[];
        const performerIds = [...new Set(rows.map((r) => r.performed_by).filter(Boolean))];
        const performerMap: Record<string, { id: string; full_name: string; role: string }> = {};
        if (performerIds.length > 0) {
          const { data: perfData } = await supabase
            .from('profile_public_view')
            .select('id, full_name, role')
            .in('id', performerIds);
          (perfData || []).forEach((p: { id: string | null; full_name: string | null; role: string | null }) => {
            if (p.id) performerMap[p.id] = { id: p.id, full_name: p.full_name ?? '', role: p.role ?? '' };
          });
        }
        if (isStale()) return;
        setTimeline(
          rows.map((r) => ({
            ...r,
            performer: performerMap[r.performed_by] as unknown as ActivityFeedItem['performer'],
          })),
        );
      } finally {
        if (!isStale()) setTimelineLoading(false);
      }
    } else if (selectedTab === 'history') {
      // GAP FIX #15: Fetch purchase history — all products this customer has ordered
      const { data: orderIds, error: orderIdsError } = await supabase
        .from('orders')
        .select('id')
        .eq('customer_id', id!)
        .is('deleted_at', null);
      if (orderIdsError) toast('error', 'Failed to load order history');
      if (orderIds && orderIds.length > 0) {
        const { data: allItems, error: allItemsError } = await supabase
          .from('order_items')
          .select('product_name, price_per_unit, total_units_needed, total_price, quantity_delivered, section_name, order_id')
          .in('order_id', orderIds.map((o: { id: string }) => o.id));
        if (allItemsError) toast('error', 'Failed to load purchase history');
        // Aggregate by product
        const productMap: Record<string, PurchaseHistoryItem> = {};
        (allItems || []).forEach((item: { product_name: string; total_units_needed: number | null; total_price: number | null; quantity_delivered: number | null }) => {
          const key = item.product_name;
          if (!productMap[key]) {
            productMap[key] = { product_name: key, total_units: 0, total_spent: 0, total_delivered: 0, order_count: 0 };
          }
          productMap[key].total_units += Number(item.total_units_needed) || 0;
          productMap[key].total_spent += Number(item.total_price) || 0;
          productMap[key].total_delivered += Number(item.quantity_delivered) || 0;
          productMap[key].order_count += 1;
        });
        if (isStale()) return;
        setHistory(Object.values(productMap).sort((a, b) => b.total_spent - a.total_spent));
      } else {
        if (isStale()) return;
        setHistory([]);
      }
    }
    if (isStale()) return;
    setTabLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!isNew && id && tab !== 'info') {
      fetchTabData(tab);
    }
  }, [tab, id, isNew, fetchTabData]);

  const handleSave = async () => {
    if (saving) return;
    // The save writes the CURRENT route id, so it must never carry a form that
    // belongs to a previously-viewed customer. `fetchCustomerSnapshot` is guarded
    // against installing a stale snapshot, which leaves exactly one window: a save
    // fired after the route changed but before the new snapshot landed. Here the
    // loaded record and the route disagree, and saving would write the old
    // customer's fields — under the old row version — onto the new customer's row.
    if (!isNew && customer.id && customer.id !== id) {
      toast('error', 'This customer is still loading. Wait for it to finish, then save again.');
      return;
    }
    if (!customer.farm_name) {
      toast('error', 'Farm name is required');
      return;
    }

    // Email format validation
    if (customer.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(customer.email)) {
        setEmailError('Invalid email format');
        toast('error', 'Please enter a valid email address');
        return;
      }
    }
    setEmailError('');

    // Phone format validation (digits, dashes, spaces, parens, plus)
    if (customer.phone) {
      const phoneRegex = /^[+\d\s()-]{7,20}$/;
      if (!phoneRegex.test(customer.phone)) {
        setPhoneError('Invalid phone format');
        toast('error', 'Please enter a valid phone number');
        return;
      }
    }
    setPhoneError('');

    // Acreage must be non-negative
    const acreFields: Array<keyof Customer> = ['total_acres', 'corn_acres', 'soybean_acres', 'other_acres'];
    for (const field of acreFields) {
      const val = customer[field];
      if (val != null && typeof val === 'number' && val < 0) {
        toast('error', `${field.replace(/_/g, ' ')} cannot be negative`);
        return;
      }
    }

    // Commission split validation - mirrors the server-side RPC guard.
    if (customer.default_commission_split?.splits?.length) {
      const seenRecipients = new Set<string>();
      let splitTotal = 0;
      for (const split of customer.default_commission_split.splits) {
        const recipient = split.recipient.trim();
        if (!recipient) {
          toast('error', 'Every commission split needs a recipient');
          return;
        }
        const recipientKey = recipient.toLowerCase();
        if (seenRecipients.has(recipientKey)) {
          toast('error', `Commission recipient "${recipient}" is listed more than once`);
          return;
        }
        seenRecipients.add(recipientKey);
        if (!Number.isFinite(split.percentage) || split.percentage <= 0 || split.percentage > 100) {
          toast('error', `Commission percentage for ${recipient} must be between 0 and 100`);
          return;
        }
        splitTotal += split.percentage;
      }
      if (Math.abs(splitTotal - 100) >= 0.01) {
        toast('error', `Commission splits must total 100% (currently ${splitTotal.toFixed(1)}%)`);
        return;
      }
    }

    setSaving(true);
    try {
      const customerPayload = {
        farm_name: customer.farm_name,
        contact_name: customer.contact_name,
        phone: customer.phone,
        email: customer.email,
        billing_address: customer.billing_address,
        assigned_tier: customer.assigned_tier,
        assigned_sales_rep: customer.assigned_sales_rep,
        parent_customer_id: customer.parent_customer_id || null,
        total_acres: customer.total_acres,
        corn_acres: customer.corn_acres,
        soybean_acres: customer.soybean_acres,
        other_acres: customer.other_acres,
        payment_terms: customer.payment_terms,
        ...buildCommissionSplitPatch({
          isUpdate: !isNew,
          touched: defaultSplitTouchedRef.current,
          key: 'default_commission_split',
          value: customer.default_commission_split ?? null,
          loaded: loadedDefaultSplitRef.current,
        }),
        ...buildRowVersionPatch(!isNew, customerRowVersionRef.current),
        credit_limit_cents: customer.credit_limit_cents || 0,
        finance_charge_rate: customer.finance_charge_rate || 0,
        finance_charge_enabled: customer.finance_charge_enabled ?? true,
        finance_charge_grace_days: customer.finance_charge_grace_days ?? 0,
        notes: customer.notes,
        is_active: customer.is_active,
        default_application_service_id: customer.default_application_service_id || null,
      };

      const addressesPayload = addresses.map((addr) => ({
        id: addr.id || undefined,
        label: addr.label,
        address_line: addr.address_line,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
        delivery_notes: addr.delivery_notes,
        is_default: addr.is_default,
      }));

      const idemKey = getSaveCustomerIdempotencyKey();
      const { data, error } = await supabase.rpc('save_customer', {
        // save_customer accepts NULL p_customer_id to create a new customer
        // (live signature is nullable; generated type narrows it to string).
        p_customer_id: (isNew ? null : id) as string,
        p_customer_payload: customerPayload as Json,
        p_addresses: addressesPayload as Json,
        p_performed_by: profile?.id as string,
        p_idempotency_key: idemKey,
      });

      // The route can change while this RPC is in flight. Everything below belongs
      // to the customer that was saved — its row version, dirty flag, conflict
      // dialog, success toast and the address reload that would pull ITS addresses
      // into whatever is on screen now. None of it may land on a different
      // customer's session. Two things still run, because they describe this
      // component rather than that customer: the idempotency key is released and
      // `saving` clears (leaving it set would wedge the Save button for good).
      //
      // F1: `!error` alone does NOT prove the save committed — save_customer can
      // answer with an empty payload and no error, which is exactly the ambiguous
      // reply assertRpcResult exists to reject. This branch cannot assert (it must
      // return quietly rather than throw into a customer that is no longer on
      // screen), so it applies the same emptiness test inline: release the key only
      // for a reply that is both error-free and non-empty. An ambiguous reply keeps
      // its key, so a retry can still replay instead of writing the customer twice.
      if (currentIdRef.current !== id) {
        if (!error && data != null) resetSaveCustomerIdempotencyKey();
        setSaving(false);
        return;
      }

      if (error) {
        if (hasRpcCode(error, RpcErrorCodes.CUSTOMER_STALE_WRITE)
          || hasRpcCode(error, RpcErrorCodes.COMMISSION_SPLIT_CONFLICT)
          || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
          // Bind the dialog to the customer that produced it, so the recovery cannot
          // release a different customer's key if the route changes while it is open.
          staleSaveConflictScopeRef.current = {
            scope: saveCustomerIntentScope,
            payloadRejected: hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT),
          };
          setStaleSaveOpen(true);
        } else {
          toast('error', error.message);
        }
      } else {
        // F1: verify the reply before retiring the key. An empty payload with no
        // error is ambiguous — the customer may already be saved — so a key retired
        // here would send the retry under a fresh key the server cannot replay.
        const result = assertRpcResult<{ customer_id: string; default_commission_split?: Customer['default_commission_split'] | null; row_version?: unknown }>(data, 'save_customer');
        resetSaveCustomerIdempotencyKey();
        const rowVersionResult = resolveAuthoritativeSaveRowVersion(
          customerRowVersionRef.current,
          result.row_version,
        );
        customerRowVersionRef.current = rowVersionResult.rowVersion;
        if (rowVersionResult.kind === 'recovery') {
          // The save succeeded and its key was retired on the line above, so there is
          // no rejected key here to retire a second time.
          staleSaveConflictScopeRef.current = { scope: saveCustomerIntentScope, payloadRejected: false };
          setStaleSaveOpen(true);
          toast('warning', 'Customer saved, but its save-protection version could not be confirmed. Reload before editing or saving it again.');
        }
        // Advance the baseline snapshot ONLY when THIS tab saved its own split edit
        // (see QuoteBuilder / nextLoadedSplitSnapshot for the multi-tab rationale).
        loadedDefaultSplitRef.current = nextLoadedSplitSnapshot({
          touched: defaultSplitTouchedRef.current,
          prevLoaded: loadedDefaultSplitRef.current,
          echoed: result.default_commission_split,
          currentValue: customer.default_commission_split ?? null,
        });
        defaultSplitTouchedRef.current = false;
        setIsDirty(false);
        if (isNew) {
          if (rowVersionResult.kind !== 'recovery') toast('success', 'Customer created');
          navigate(`/customers/${result.customer_id ?? data}`, { replace: true });
        } else {
          if (rowVersionResult.kind !== 'recovery') toast('success', 'Customer updated');
          fetchAddresses();
        }
      }
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_customer' } });
      toast('error', err instanceof Error ? err.message : 'Failed to save customer');
    }
    setSaving(false);
  };

  const update = (field: string, value: unknown) => setCustomer((c) => ({ ...c, [field]: value }));

  // Crops save immediately via a direct table update (RLS governs authorization) —
  // deliberately bypassing save_customer, which a parallel session is modifying.
  const toggleCrop = async (crop: CropValue) => {
    if (!id || isNew || cropSaving) return;
    const previousCrops = crops;
    const nextCrops = previousCrops.includes(crop)
      ? previousCrops.filter((c) => c !== crop)
      : [...previousCrops, crop];
    setCrops(nextCrops);
    setCropSaving(crop);
    try {
      const previousRowVersion = customerRowVersionRef.current;
      const result = await supabase
        .from('customers')
        .update({ crops: nextCrops })
        .eq('id', id)
        .select('*');
      checkMutationResult(result, 'update customer crops');
      const nextRowVersion = (result.data as Array<{ row_version?: unknown }>)[0]?.row_version;
      const rowVersionResult = resolveDirectMutationRowVersion(previousRowVersion, nextRowVersion);
      customerRowVersionRef.current = rowVersionResult.rowVersion;
      if (rowVersionResult.kind === 'recovery') {
        // The crop change committed, but this tab cannot prove the returned token
        // belongs to this write. Keep the visible crop state and any form edits;
        // a later whole-record save must reload instead of overwriting unseen work.
        // A direct crop mutation, not a save_customer call — no idempotency key of
        // that operation is outstanding, so there is nothing to retire on recovery.
        staleSaveConflictScopeRef.current = { scope: saveCustomerIntentScope, payloadRejected: false };
        setStaleSaveOpen(true);
        toast('warning', 'Crops were updated, but another customer edit may have completed at the same time. Your current edits were kept; reload before saving other customer changes.');
      }
      if (profile?.id) {
        await logActivity({
          event: 'crops_updated',
          description: `Updated crops: ${nextCrops.length ? nextCrops.join(', ') : 'none'}`,
          performedBy: profile.id,
          entityType: 'customer',
          customerId: id,
        });
      }
    } catch (error: unknown) {
      setCrops(previousCrops);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'CustomerDetail.toggleCrop' } });
      toast('error', sanitizeError(error));
    } finally {
      setCropSaving(null);
    }
  };

  if (loading) {
    return <div className="animate-pulse"><div className="h-64 bg-gray-200 rounded" /></div>;
  }

  if (!isNew && !customer.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <p className="text-secondary text-lg">Customer not found</p>
        <Button variant="secondary" onClick={() => navigate('/customers')}>Back to Customers</Button>
      </div>
    );
  }

  const tabs = ['info', 'contacts', 'knowledge', 'documents', 'timeline', 'fields', 'quotes', 'orders', 'deliveries', 'financials', 'history'] as const;

  const handleGenerateSummary = async (season: number, options: YearEndSummaryOptions) => {
    if (!id || isNew) return;
    setSummaryLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_customer_year_end_summary', {
        p_customer_id: id,
        p_season: season,
      });
      if (error) throw error;
      await downloadYearEndSummaryPdf(assertRpcResult<YearEndSummaryData>(data, 'get_customer_year_end_summary'), options);
      toast('success', `Season ${season} summary generated`);
      setShowSummaryDialog(false);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'generate_customer_year_end_summary' } });
      toast('error', sanitizeError(err));
    }
    setSummaryLoading(false);
  };

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[
        { label: 'Customers', href: '/customers' },
        { label: isNew ? 'New Customer' : (customer.farm_name || 'Customer') },
      ]} />
      <RecordVersionConflictDialog
        open={staleSaveOpen}
        entityLabel="customer"
        onKeepEditing={() => setStaleSaveOpen(false)}
        onReload={reloadAfterStaleSave}
      />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold font-heading text-nav-dark">
          {isNew ? 'New Customer' : customer.farm_name}
        </h2>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!isNew && (
            <Button variant="secondary" size="sm" icon={<PhoneCall className="w-4 h-4" />} showChevron={false} onClick={() => setLogInteractionOpen(true)}>
              Log Call
            </Button>
          )}
          {!isNew && (
            <Button
              variant="secondary"
              size="sm"
              icon={<MessageSquarePlus className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setQuickTaskOpen(true)}
            >
              Create Task
            </Button>
          )}
          {!isNew && (profile?.role === 'admin' || profile?.role === 'sales_rep') && (
            <>
              <Button variant="secondary" size="sm" icon={<FileText className="w-4 h-4" />} onClick={() => navigate(`/quotes/new?customer_id=${id}`)}>
                New Quote
              </Button>
              <Button variant="secondary" size="sm" icon={<ClipboardList className="w-4 h-4" />} onClick={() => navigate(`/orders/new?customer_id=${id}`)}>
                New Order
              </Button>
              <Button variant="secondary" size="sm" icon={<Truck className="w-4 h-4" />} onClick={() => navigate(`/deliveries/new?customer_id=${id}`)}>
                Sched. Delivery
              </Button>
              <Button variant="secondary" size="sm" icon={<Zap className="w-4 h-4" />} onClick={() => navigate(`/deliveries?quickDeliver=1&customer_id=${id}`)}>
                Sell &amp; Deliver Now
              </Button>
              <Button variant="secondary" size="sm" icon={<SprayCan className="w-4 h-4" />} onClick={() => navigate(`/jobs/new?customer_id=${id}`)}>
                New Job
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<FileText className="w-4 h-4" />}
                onClick={() => setShowSummaryDialog(true)}
              >
                Season Summary
              </Button>
            </>
          )}
        </div>
      </div>

      {!isNew && id && <CustomerSummaryBar customerId={id} onCardClick={(t) => setTab(t as typeof tab)} />}

      {!isNew && (
        <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? 'text-crx-green border-b-2 border-crx-green'
                  : 'text-secondary hover:text-nav-dark'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {(tab === 'info' || isNew) && (
        <div className="space-y-4">
          {/* key remounts on customer switch — in-flight loads/mutations from the previous customer must never write into this one's view (Sol 2.G r2) */}
          {/* interactionRefresh in the key: logging a call remounts the prep card so "Last conversation" is never stale (Sol final gauntlet) */}
          {!isNew && id && <CustomerPrepCard key={`${id}:${interactionRefresh}`} customerId={id} />}
          <Card>
            <CardHeader title="Contact" accent="Information" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Farm Name" required value={customer.farm_name || ''} onChange={(e) => update('farm_name', e.target.value)} />
              <Input label="Contact Name" value={customer.contact_name || ''} onChange={(e) => update('contact_name', e.target.value)} />
              <Input label="Phone" value={customer.phone || ''} onChange={(e) => { update('phone', e.target.value); setPhoneError(''); }} error={phoneError} />
              <Input label="Email" type="email" value={customer.email || ''} onChange={(e) => { update('email', e.target.value); setEmailError(''); }} error={emailError} />
              <Input label="Billing Address" value={customer.billing_address || ''} onChange={(e) => update('billing_address', e.target.value)} />
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Pricing Tier</label>
                <select
                  value={customer.assigned_tier}
                  onChange={(e) => update('assigned_tier', parseInt(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value={1}>Tier 1</option>
                  <option value={2}>Tier 2</option>
                  <option value={3}>Tier 3</option>
                </select>
              </div>
              <Input label="Payment Terms" value={customer.payment_terms || ''} onChange={(e) => update('payment_terms', e.target.value)} />
              <Input
                label="Credit Limit ($)"
                type="number"
                min={0}
                step={100}
                value={customer.credit_limit_cents != null ? (customer.credit_limit_cents as number) / 100 : ''}
                onChange={(e) => {
                  const cents = e.target.value ? parseDollarsToCents(e.target.value) : 0;
                  // null = more than two decimals typed. Refuse the keystroke rather than
                  // store 0: a $0 credit limit disables the credit check on quick deliveries.
                  if (cents === null) { toast('error', MONEY_PRECISION_MESSAGE); return; }
                  update('credit_limit_cents', cents);
                }}
              />
              <Input
                label="Finance Charge Rate (%)"
                type="number"
                min={0}
                step={0.5}
                value={customer.finance_charge_rate ?? ''}
                onChange={(e) => update('finance_charge_rate', e.target.value ? parseFloat(e.target.value) : 0)}
              />
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Finance Charges</label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => update('finance_charge_enabled', !(customer.finance_charge_enabled ?? true))}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      (customer.finance_charge_enabled ?? true) ? 'bg-crx-green' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        (customer.finance_charge_enabled ?? true) ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <span className="text-sm text-secondary">
                    {(customer.finance_charge_enabled ?? true) ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>
              <Input
                label="Grace Period (days)"
                type="number"
                min={0}
                step={1}
                value={customer.finance_charge_grace_days ?? 0}
                onChange={(e) => update('finance_charge_grace_days', e.target.value ? parseInt(e.target.value) : 0)}
              />

              {/* Parent Customer (Farm Group) selector */}
              <div className="relative">
                <label className="block text-sm font-medium text-secondary mb-1">Parent Customer</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={showParentDropdown ? parentSearch : parentName}
                    onChange={(e) => {
                      setParentSearch(e.target.value);
                      setShowParentDropdown(true);
                    }}
                    onFocus={() => {
                      setParentSearch('');
                      setShowParentDropdown(true);
                    }}
                    onBlur={() => setTimeout(() => setShowParentDropdown(false), 200)}
                    placeholder="Search parent customer..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                </div>
                {customer.parent_customer_id && (
                  <button
                    type="button"
                    onClick={() => { update('parent_customer_id', null); setParentName(''); }}
                    className="absolute right-2 top-8 text-xs text-gray-400 hover:text-red-500"
                  >
                    Clear
                  </button>
                )}
                {showParentDropdown && (
                  <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {allCustomers
                      .filter((c) => c.id !== id && c.farm_name.toLowerCase().includes(parentSearch.toLowerCase()))
                      .slice(0, 20)
                      .map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            update('parent_customer_id', c.id);
                            setParentName(c.farm_name);
                            setShowParentDropdown(false);
                          }}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-crx-green-tint transition-colors"
                        >
                          {c.farm_name}
                        </button>
                      ))}
                  </div>
                )}
                <p className="text-xs text-secondary mt-1">Link this customer to a parent farm group</p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Farm" accent="Acreage" />
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <Input label="Total Acres" type="number" value={customer.total_acres ?? ''} onChange={(e) => update('total_acres', e.target.value ? parseFloat(e.target.value) : null)} />
              <Input label="Corn Acres" type="number" value={customer.corn_acres ?? ''} onChange={(e) => update('corn_acres', e.target.value ? parseFloat(e.target.value) : null)} />
              <Input label="Soybean Acres" type="number" value={customer.soybean_acres ?? ''} onChange={(e) => update('soybean_acres', e.target.value ? parseFloat(e.target.value) : null)} />
              <Input label="Other Acres" type="number" value={customer.other_acres ?? ''} onChange={(e) => update('other_acres', e.target.value ? parseFloat(e.target.value) : null)} />
            </div>
          </Card>

          {!isNew && id && (
            <Card>
              <CardHeader title="Farm" accent="Crops" />
              <p className="text-xs text-secondary mb-2">Tap to toggle — saves immediately, no need to hit Save Changes.</p>
              <div className="flex flex-wrap gap-2">
                {ALLOWED_CROPS.map((option) => {
                  const selected = crops.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      disabled={cropSaving === option.value}
                      onClick={() => void toggleCrop(option.value)}
                      className={`min-h-11 rounded-full border px-4 text-sm font-medium transition-colors disabled:opacity-60 ${
                        selected
                          ? 'border-crx-green bg-crx-green/10 text-crx-green'
                          : 'border-gray-200 bg-white text-secondary hover:border-gray-300'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Delivery"
              accent="Addresses"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Plus className="w-3 h-3" />}
                  showChevron={false}
                  onClick={() => setAddresses((a) => [...a, { label: '', address_line: '', city: '', state: '', zip: '', delivery_notes: '', is_default: false }])}
                >
                  Add Address
                </Button>
              }
            />
            {addresses.length === 0 ? (
              <p className="text-sm text-secondary">No delivery addresses added</p>
            ) : (
              <div className="space-y-4">
                {addresses.map((addr, idx) => (
                  <div key={addr.id || idx} className="p-4 border border-gray-100 rounded-lg space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-secondary">Address {idx + 1}</span>
                      <button onClick={() => setAddresses((a) => a.filter((_, i) => i !== idx))} className="text-gray-400 hover:text-red-500">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input label="Label" value={addr.label || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], label: e.target.value }; setAddresses(a); }} placeholder="e.g. East Farm" />
                      <Input label="Address" value={addr.address_line || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], address_line: e.target.value }; setAddresses(a); }} />
                      <Input label="City" value={addr.city || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], city: e.target.value }; setAddresses(a); }} />
                      <div className="grid grid-cols-2 gap-3">
                        <Input label="State" value={addr.state || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], state: e.target.value }; setAddresses(a); }} />
                        <Input label="ZIP" value={addr.zip || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], zip: e.target.value }; setAddresses(a); }} />
                      </div>
                    </div>
                    <Input label="Delivery Notes" value={addr.delivery_notes || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], delivery_notes: e.target.value }; setAddresses(a); }} placeholder="Gate code, directions, etc." />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Default" accent="Commission Split" />
            <CommissionSplitEditor
              value={(customer.default_commission_split as CommissionSplit) || { splits: [{ recipient: '', percentage: 100 }] }}
              onChange={(val) => {
                defaultSplitTouchedRef.current = true;
                update('default_commission_split', val);
              }}
              label=""
            />
            <p className="text-xs text-secondary mt-2">
              This default split is applied to new quotes for this customer.
            </p>
          </Card>

          <Card>
            <CardHeader title="Default" accent="Application Service" />
            <ApplicationServicePicker
              value={customer.default_application_service_id ?? null}
              onChange={(val) => update('default_application_service_id', val)}
            />
            <p className="text-xs text-secondary mt-2">
              Pre-fills the application service on new jobs created for this customer.
            </p>
          </Card>

          <Card>
            <CardHeader title="Notes" accent="" />
            <textarea
              value={customer.notes || ''}
              onChange={(e) => update('notes', e.target.value)}
              rows={4}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="General notes about this customer..."
            />
          </Card>

          <div className="flex justify-end">
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
              {isNew ? 'Create Customer' : 'Save Changes'}
            </Button>
          </div>

          {/* Related Notes */}
          {!isNew && id && (
            <RelatedNotes
              entityType={'customer' as LinkedEntityType}
              entityId={id}
              onCreateTask={() => setQuickTaskOpen(true)}
            />
          )}
        </div>
      )}

      {tab === 'contacts' && !isNew && id && profile && (
        <CustomerContacts key={id} customerId={id} performedBy={profile.id} />
      )}

      {/* key remounts on customer switch — see the CustomerPrepCard note above */}
      {tab === 'knowledge' && !isNew && id && profile && (
        <CustomerFacts key={id} customerId={id} userId={profile.id} />
      )}

      {/* key remounts on customer switch — see the CustomerPrepCard note above */}
      {tab === 'documents' && !isNew && id && profile && (
        <CustomerDocuments key={id} customerId={id} userId={profile.id} />
      )}

      {tab === 'timeline' && !isNew && (
        <div className="space-y-4">
          {timelineLoading || tabLoading ? (
            <div className="text-center py-8 text-sm text-gray-400">Loading timeline...</div>
          ) : timeline.length === 0 ? (
            <div className="text-center py-8 text-sm text-gray-400">No activity recorded yet</div>
          ) : (
            <div className="relative pl-6 space-y-4">
              <div className="absolute left-2.5 top-2 bottom-2 w-px bg-gray-200" />
              {timeline.map((item) => (
                <div key={item.id} className="relative">
                  <div className="absolute -left-6 top-1.5 w-5 h-5 rounded-full bg-crx-green/10 border-2 border-crx-green flex items-center justify-center">
                    <div className="w-2 h-2 rounded-full bg-crx-green" />
                  </div>
                  <div className="bg-white rounded-lg border border-gray-100 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-nav-dark">{item.description}</span>
                      <span className="text-xs text-gray-400">
                        {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-secondary">
                      {item.performer?.full_name && <span>{item.performer.full_name}</span>}
                      {item.event_type && <span className="px-1.5 py-0.5 bg-gray-100 rounded">{item.event_type.replace(/_/g, ' ')}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {id && <CustomerInteractionsHistory key={interactionRefresh} customerId={id} />}
        </div>
      )}

      {tab === 'fields' && !isNew && (
        <>
          {/* Mini map showing this customer's fields */}
          {!tabLoading && fields.some((f) => f.centroid_geojson) && (
            <Card>
              <CardHeader title="Field" accent="Locations" />
              <Suspense fallback={<div className="h-[250px] w-full rounded-lg bg-gray-50 flex items-center justify-center text-sm text-gray-400">Loading map…</div>}>
                <MapContainer className="h-[250px] w-full rounded-lg overflow-hidden">
                  <FieldMarkers
                    fields={fields as Field[]}
                    onFieldClick={(fieldId) => navigate(`/fields/${fieldId}`)}
                  />
                </MapContainer>
              </Suspense>
            </Card>
          )}

          <Card padding={false}>
            <div className="p-5">
              <CardHeader
                title="Customer"
                accent="Fields"
                action={
                  <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} showChevron={false} onClick={() => navigate('/fields/new')}>
                    Add Field
                  </Button>
                }
              />
            </div>
            {tabLoading ? (
              <div className="px-5 pb-5 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : fields.length === 0 ? (
              <div className="px-5 pb-5">
                <p className="text-sm text-secondary">No fields for this customer yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-t border-b border-gray-100">
                      <th className="px-5 py-3 text-left font-medium text-secondary">Field Name</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Acres</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Crop</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">County</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Legal Desc.</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((f) => (
                      <tr
                        key={f.id}
                        onClick={() => navigate(`/fields/${f.id}`)}
                        className="border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors"
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <MapPin className="w-4 h-4 text-crx-green flex-shrink-0" />
                            <span className="font-medium text-nav-dark">{f.field_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">{f.total_acres?.toLocaleString() || '-'}</td>
                        <td className="px-4 py-3">
                          {f.crop_type ? (
                            <Badge variant="info">{f.crop_type}</Badge>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-secondary">{f.county || '-'}</td>
                        <td className="px-4 py-3 text-secondary text-xs truncate max-w-[200px]">
                          {f.legal_description || '-'}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={f.is_active ? 'success' : 'default'}>
                            {f.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'quotes' && !isNew && (() => {
        const filteredQuotes = quotePlannedFilter ? quotes.filter((q) => q.is_planned) : quotes;
        return (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader
              title="Customer"
              accent="Quotes"
              action={
                <div className="flex gap-2 items-center">
                  <button
                    onClick={() => setQuotePlannedFilter(!quotePlannedFilter)}
                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${quotePlannedFilter ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'border border-gray-200 text-secondary hover:bg-gray-50'}`}
                  >
                    Planned Programs
                  </button>
                  {quotes.length > 0 && (
                    <button
                      onClick={async () => {
                        try {
                          const lastQuote = quotes[0];
                          const idemKey = duplicateQuoteIdem.getKey();
                          const { data, error } = await runWithBelowCostApproval((reason) => supabaseUntyped.rpc('duplicate_quote', withBelowCostReason('duplicate_quote', {
                            p_source_quote_id: lastQuote.id,
                            p_performed_by: profile?.id as string,
                            p_idempotency_key: idemKey,
                          }, reason)));
                          if (error) { toast('error', 'Failed to duplicate quote'); return; }
                          const result = assertRpcResult<{ quote_id: string }>(data, 'duplicate_quote');
                          duplicateQuoteIdem.resetKey();
                          navigate(`/quotes/${result.quote_id}`);
                        } catch (error: unknown) {
                          if (!isBelowCostApprovalHandledError(error)) toast('error', 'Failed to duplicate quote');
                        }
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-crx-green text-crx-green rounded-lg hover:bg-crx-green-tint"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      New from Last
                    </button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/quotes/new?customer_id=${id}`)}>
                    New Quote
                  </Button>
                </div>
              }
            />
          </div>
          {tabLoading ? (
            <div className="px-5 pb-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : filteredQuotes.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">{quotePlannedFilter ? 'No planned programs for this customer.' : 'No quotes for this customer yet.'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-t border-b border-gray-100">
                    <th className="px-5 py-3 text-left font-medium text-secondary">Quote #</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Tier</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Margin</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredQuotes.map((q) => (
                    <tr
                      key={q.id}
                      onClick={() => navigate(`/quotes/${q.id}`)}
                      className="border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors"
                    >
                      <td className="px-5 py-3 font-medium text-nav-dark">{q.quote_number}</td>
                      <td className="px-4 py-3">
                        <>
                          <Badge variant={statusToBadgeVariant[q.status] || 'default'}>
                            {q.status === 'closed_by_application' ? 'Fulfilled (Applied)' : q.status === 'closed_short' ? 'Closed — Short' : q.status}
                          </Badge>
                          {q.is_planned && (
                            <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 rounded">
                              Planned
                            </span>
                          )}
                        </>
                      </td>
                      <td className="px-4 py-3">T{q.tier}</td>
                      <td className="px-4 py-3 font-mono">{fmt(q.total_price)}</td>
                      <td className="px-4 py-3 font-mono text-emerald-600">{q.total_margin_pct.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-secondary">
                        {new Date(q.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        );
      })()}

      {tab === 'orders' && !isNew && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Customer" accent="Orders" />
          </div>
          {tabLoading ? (
            <div className="px-5 pb-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : orders.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No orders for this customer yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-t border-b border-gray-100">
                    <th className="px-5 py-3 text-left font-medium text-secondary">Order #</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Profit</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Date</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary w-40">Fulfillment</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      onClick={() => navigate(`/orders/${o.id}`)}
                      className="border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors"
                    >
                      <td className="px-5 py-3 font-medium text-nav-dark">{o.order_number}</td>
                      <td className="px-4 py-3">
                        <Badge variant={statusToBadgeVariant[o.status] || 'default'}>
                          {o.status.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono">{fmt(o.total_price)}</td>
                      <td className="px-4 py-3 font-mono text-emerald-600">{fmt(o.total_profit)}</td>
                      <td className="px-4 py-3 text-secondary">
                        {new Date(o.order_date + 'T00:00:00').toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-crx-green rounded-full transition-all"
                              style={{ width: `${o.fulfillment_pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-secondary w-8">{o.fulfillment_pct}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'deliveries' && !isNew && (
        <div className="space-y-4">
          <Card padding={false}>
            <div className="p-5">
              <CardHeader title="Customer" accent="Deliveries" />
            </div>
            {tabLoading ? (
              <div className="px-5 pb-5 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : deliveries.length === 0 ? (
              <div className="px-5 pb-5">
                <p className="text-sm text-secondary">No deliveries for this customer yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-t border-b border-gray-100">
                      <th className="px-5 py-3 text-left font-medium text-secondary">Delivery #</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Driver</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Scheduled</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Completed</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Signature</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => {
                      const isPartial = d.status === 'completed' && d.issue_type && d.issue_type !== 'none';
                      return (
                        <tr
                          key={d.id}
                          onClick={() => navigate(`/deliveries/${d.id}`)}
                          className={`border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors ${
                            isPartial ? 'bg-amber-50/50' : ''
                          }`}
                        >
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <Truck className="w-4 h-4 text-crx-green flex-shrink-0" />
                              <span className="font-medium text-nav-dark">{d.delivery_number}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant={statusToBadgeVariant[d.status] || 'default'}>
                              {d.status.replace('_', ' ')}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">{d.driver_name}</td>
                          <td className="px-4 py-3 text-secondary">
                            {parseLocalDate(d.scheduled_date).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3 text-secondary">
                            {d.completed_at ? new Date(d.completed_at).toLocaleDateString() : '-'}
                          </td>
                          <td className="px-4 py-3">
                            {d.signed_by ? (
                              <Badge variant="success">Signed</Badge>
                            ) : d.status === 'completed' ? (
                              <Badge variant="warning">No Sig</Badge>
                            ) : (
                              <span className="text-secondary">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Pending Remainders for this customer */}
          {!tabLoading && customerRemainders.length > 0 && (
            <Card>
              <CardHeader
                title="Pending"
                accent="Remainders"
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<AlertTriangle className="w-3 h-3" />}
                    showChevron={false}
                    onClick={() => navigate('/delivery-remainders')}
                  >
                    View All
                  </Button>
                }
              />
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-2 text-left font-medium text-secondary">Product</th>
                      <th className="px-4 py-2 text-left font-medium text-secondary">Qty Remaining</th>
                      <th className="px-4 py-2 text-left font-medium text-secondary">Unit</th>
                      <th className="px-4 py-2 text-left font-medium text-secondary">Original Delivery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerRemainders.map((r) => (
                      <tr key={r.id} className="border-b border-gray-50">
                        <td className="px-4 py-2 font-medium text-nav-dark">{r.product_name || 'Unknown'}</td>
                        <td className="px-4 py-2 text-amber-600 font-semibold">{r.quantity_remaining}</td>
                        <td className="px-4 py-2 text-secondary">{r.unit_size || '-'}</td>
                        <td className="px-4 py-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/deliveries/${r.original_delivery_id}`);
                            }}
                            className="text-crx-green hover:underline text-xs"
                          >
                            {r.original_delivery_number || r.original_delivery_id?.slice(0, 8)}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Financials Tab — Customer 360 */}
      {tab === 'financials' && !isNew && (
        <div className="space-y-4">
          {financialsLoading || tabLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              {/* Section A: AR Summary */}
              <Card>
                <CardHeader title="AR" accent="Summary" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
                  <div>
                    <p className="text-xs text-secondary">Outstanding</p>
                    <p className="text-lg font-semibold text-nav-dark">{fmt(aging?.total_outstanding || 0)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">Credit Limit</p>
                    <p className="text-lg font-semibold text-nav-dark">{fmt((customer.credit_limit_cents || 0) / 100)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">Prepay Balance</p>
                    <p className="text-lg font-semibold text-crx-green">{fmt(prepayCredits.reduce((s, c) => s + c.balance_cents, 0) / 100)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">Payment Terms</p>
                    <p className="text-lg font-semibold text-nav-dark">{customer.payment_terms || 'N/A'}</p>
                  </div>
                </div>
                {/* Credit utilization bar */}
                {(customer.credit_limit_cents || 0) > 0 && (() => {
                  const limitDollars = (customer.credit_limit_cents || 0) / 100;
                  const outstandingDollars = aging?.total_outstanding || 0;
                  const pct = Math.min((outstandingDollars / limitDollars) * 100, 100);
                  const color = pct < 80 ? 'bg-green-500' : pct < 100 ? 'bg-amber-500' : 'bg-red-500';
                  return (
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-secondary mb-1">
                        <span>Credit Utilization</span>
                        <span>{Math.round(pct)}%</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </Card>

              {/* Section B: Aging Buckets */}
              {aging && aging.total_outstanding > 0 && (
                <Card>
                  <CardHeader title="Aging" accent="Buckets" />
                  {(() => {
                    const buckets = [
                      { label: 'Current', value: aging.current_amount, color: 'bg-green-500' },
                      { label: '1-30', value: aging.days_30, color: 'bg-blue-500' },
                      { label: '31-60', value: aging.days_60, color: 'bg-amber-500' },
                      { label: '61-90', value: aging.days_90, color: 'bg-orange-500' },
                      { label: '90+', value: aging.over_90, color: 'bg-red-500' },
                    ];
                    const total = aging.total_outstanding;
                    return (
                      <div className="mt-3">
                        <div className="flex h-4 rounded-full overflow-hidden bg-gray-100">
                          {buckets.map((b) => b.value > 0 && (
                            <div key={b.label} className={`${b.color} transition-all`} style={{ width: `${(b.value / total) * 100}%` }} title={`${b.label}: ${fmt(b.value)}`} />
                          ))}
                        </div>
                        <div className="flex justify-between mt-2 text-xs text-secondary">
                          {buckets.map((b) => (
                            <div key={b.label} className="text-center">
                              <span className={`inline-block w-2 h-2 rounded-full ${b.color} mr-1`} />
                              {b.label}<br />{fmt(b.value)}
                            </div>
                          ))}
                        </div>
                        {(aging.open_credit_cents ?? 0) > 0 && (
                          <p className="text-xs text-amber-600 mt-2">
                            Credit on file: {fmt((aging.open_credit_cents ?? 0) / 100)} in unapplied credit memos — apply before dunning or finance charges
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </Card>
              )}

              {/* Section C: Recent Transactions */}
              <Card padding={false}>
                <div className="p-5">
                  <CardHeader title="Recent" accent="Transactions" />
                  <p className="text-xs text-secondary mt-1">Last 90 days</p>
                </div>
                {transactions.length === 0 ? (
                  <div className="px-5 pb-5"><p className="text-sm text-secondary">No transactions in the last 90 days.</p></div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-t border-b border-gray-100">
                          <th className="px-5 py-3 text-left font-medium text-secondary">Date</th>
                          <th className="px-4 py-3 text-left font-medium text-secondary">Type</th>
                          <th className="px-4 py-3 text-left font-medium text-secondary">Reference</th>
                          <th className="px-4 py-3 text-right font-medium text-secondary">Amount</th>
                          <th className="px-4 py-3 text-right font-medium text-secondary">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.slice(0, 50).map((txn, idx) => (
                          <tr key={idx} className="border-b border-gray-50">
                            <td className="px-5 py-3">{parseLocalDate(txn.transaction_date).toLocaleDateString()}</td>
                            <td className="px-4 py-3 capitalize">{txn.transaction_type}</td>
                            <td className="px-4 py-3 font-mono text-xs">{txn.reference_number}</td>
                            <td className={`px-4 py-3 text-right ${txn.amount_cents < 0 ? 'text-red-600' : 'text-nav-dark'}`}>
                              {fmt(txn.amount_cents / 100)}
                            </td>
                            <td className="px-4 py-3 text-right">{fmt(txn.running_balance / 100)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              {/* Section D: Prepay Credits */}
              {prepayCredits.length > 0 && (
                <Card padding={false}>
                  <div className="p-5">
                    <CardHeader title="Prepay" accent="Credits" />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-t border-b border-gray-100">
                          <th className="px-5 py-3 text-left font-medium text-secondary">Bucket</th>
                          <th className="px-4 py-3 text-right font-medium text-secondary">Original</th>
                          <th className="px-4 py-3 text-right font-medium text-secondary">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {prepayCredits.map((c) => (
                          <tr key={c.id} className="border-b border-gray-50">
                            <td className="px-5 py-3 font-medium text-nav-dark">{c.bucket_label}</td>
                            <td className="px-4 py-3 text-right">{fmt(c.original_amount_cents / 100)}</td>
                            <td className="px-4 py-3 text-right text-crx-green font-medium">{fmt(c.balance_cents / 100)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* GAP FIX #15: Purchase History Tab */}
      {tab === 'history' && !isNew && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Purchase" accent="History" />
            <p className="text-xs text-secondary mt-1">Products ordered by this customer, aggregated across all orders</p>
          </div>
          {tabLoading ? (
            <div className="px-5 pb-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No purchase history yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-t border-b border-gray-100">
                    <th className="px-5 py-3 text-left font-medium text-secondary">Product</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Times Ordered</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total Units</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Units Delivered</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, idx) => (
                    <tr key={idx} className="border-b border-gray-50">
                      <td className="px-5 py-3 font-medium text-nav-dark">{h.product_name}</td>
                      <td className="px-4 py-3">{h.order_count}</td>
                      <td className="px-4 py-3">{h.total_units.toLocaleString()}</td>
                      <td className="px-4 py-3">{h.total_delivered.toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-crx-green">
                        {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(h.total_spent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-200 bg-gray-50">
                    <td className="px-5 py-3 font-semibold text-nav-dark">Total</td>
                    <td className="px-4 py-3 font-semibold">{history.reduce((s: number, h: PurchaseHistoryItem) => s + h.order_count, 0)}</td>
                    <td className="px-4 py-3 font-semibold">{history.reduce((s: number, h: PurchaseHistoryItem) => s + h.total_units, 0).toLocaleString()}</td>
                    <td className="px-4 py-3 font-semibold">{history.reduce((s: number, h: PurchaseHistoryItem) => s + h.total_delivered, 0).toLocaleString()}</td>
                    <td className="px-4 py-3 font-semibold font-mono text-crx-green">
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(history.reduce((s: number, h: PurchaseHistoryItem) => s + h.total_spent, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      )}

      <YearEndSummaryDialog
        open={showSummaryDialog}
        onClose={() => setShowSummaryDialog(false)}
        onGenerate={handleGenerateSummary}
        loading={summaryLoading}
        customerName={customer.farm_name || ''}
      />

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      {!isNew && id && profile && (
        <LogInteractionModal open={logInteractionOpen} onClose={() => setLogInteractionOpen(false)} customerId={id} userId={profile.id} customerName={customer.farm_name || 'customer'} onLogged={() => { setInteractionRefresh((k) => k + 1); if (tab === 'timeline') void fetchTabData('timeline'); }} />
      )}

      {!isNew && id && (
        <QuickTaskModal
          open={quickTaskOpen}
          onClose={() => setQuickTaskOpen(false)}
          entityType={'customer' as LinkedEntityType}
          entityId={id}
          prefillTitle={`Note: ${customer.farm_name || ''}`}
          prefillContent={`Customer: ${customer.farm_name || ''}`}
        />
      )}
    </div>
  );
}
