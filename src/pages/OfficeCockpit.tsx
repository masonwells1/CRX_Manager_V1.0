/**
 * OfficeCockpit — §3 Beyond-Parity: Exception dashboard for the office team.
 *
 * ONE screen showing everything stuck or wrong across the field-app.
 * Replaces the old "run seven reports" ritual.
 *
 * Tiles:
 *   (a) Completed-but-unbilled jobs
 *   (b) Field-app invoices ready to post (draft/unposted) — §4 will populate this
 *   (b2) Chemical-sale drafts ready to post
 *   (b3) Completed deliveries with no active covering invoice
 *   (c) Active watchdog flags from §2 get_watchdog_flags RPC
 *   (d) Upcoming scheduled jobs in the next 7 days (no DB-stored weather-blocked
 *       state exists; weather risk is a UI overlay per Job Detail, not a stored flag)
 *   (e) Applicator licenses / buyer certs expiring within 30 days
 *   (f) Overdue field-app AR (posted invoices, balance > 0, due_date < today)
 *   (g) Inventory shortfalls — deferred follow-on (would require per-job-chemical
 *       x current-inventory join across many rows, i.e. N+1 risk; noted below tile)
 *
 * status-enum-check: exempt (TS) — this file queries THREE tables each with a status
 * column. The hook cannot track cross-table context. All values verified live:
 *   jobs.status: 'completed', 'scheduled' — both valid per CHECK constraint.
 *   deliveries.status: 'completed' — valid per CHECK constraint.
 *   invoices.status: 'draft', 'unposted', 'posted', 'overdue', 'voided',
 *   'cancelled' — all valid per CHECK constraint.
 *
 * RLS: each query inherits the caller's RLS context (direct table selects).
 * The watchdog RPC is SECURITY DEFINER but gates on role inside its body.
 * READ-ONLY — no mutations here.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Tractor,
  FileCheck,
  AlertTriangle,
  CalendarClock,
  ShieldAlert,
  DollarSign,
  PackageX,
  CheckCircle,
  ChevronRight,
  ArrowRight,
  Send,
  FileText,
  Truck,
  ShoppingCart,
  Package,
  Warehouse,
  ClipboardCheck,
  Plus,
  ClipboardList,
  PackageSearch,
  Zap,
  Inbox,
  CheckSquare,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { supabase, supabaseUntyped, assertRpcResult, describePostInvoiceBlock, sanitizeError } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { formatCents } from '../lib/money';
import { localToday, localDatePlusDays, parseLocalDate } from '../lib/dateUtils';
import { SkeletonCard } from '../components/ui/Skeleton';
import type { WatchdogFlag } from '../types';
import { useAuth } from '../contexts/AuthContext';
import FinanceSnapshotCard from '../components/dashboard/FinanceSnapshotCard';
import { activeInvoiceCoversDelivery, type DeliveryInvoiceCoverage } from '../lib/deliveryInvoiceCoverage';

// ── Types ─────────────────────────────────────────────────────────────────────

interface UnbilledJobRow {
  id: string;
  job_number: string;
  job_date: string;
  total_acres: number | null;
  total_price_cents: number | null;
  customer_name: string;
}

interface PostableInvoiceRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  status: string;
  total_amount_cents: number;
  customer_name: string;
  job_id: string | null;
  invoice_group_id: string | null;
  pricing_pending: boolean;
}

interface ChemicalDraftRow {
  id: string;
  invoice_number: string;
  status: string;
  total_amount_cents: number;
  customer_name: string;
}

interface DeliveredNotInvoicedRow {
  id: string;
  delivery_number: string;
  order_id: string;
  completed_at: string | null;
  customer_name: string;
}

interface UpcomingJobRow {
  id: string;
  job_number: string;
  job_date: string;
  total_acres: number | null;
  customer_name: string;
}

interface ExpiringLicenseRow {
  id: string;
  holder_name: string;
  license_type: string;
  expiry_date: string;
  customer_name: string | null;
  expired: boolean;
}

interface OverdueARRow {
  id: string;
  invoice_number: string;
  due_date: string;
  balance_cents: number;
  customer_name: string;
}

interface ShortfallRow {
  product_id: string;
  product_name: string;
  inventory_unit: string | null;
  needed_qty: number;
  available_free: number;
  shortfall_qty: number;
  job_count: number;
  job_numbers: string[];
}

interface PlannedBookingAttentionRow {
  hold_id?: string;
  quote_id: string;
  quote_number: string;
  product_id: string;
  product_name: string;
  quantity: number;
  expires_at: string;
  attention: 'lapsed' | 'expiring';
}

/** U13 (#15-21/#111): a SCHEDULED job with no active per-location dispatch. */
interface NeedsDispatchJobRow {
  id: string;
  job_number: string;
  job_date: string;
  customer_name: string;
}

interface CockpitData {
  unbilledJobs: UnbilledJobRow[];
  postableInvoices: PostableInvoiceRow[];
  chemicalDrafts: ChemicalDraftRow[];
  chemicalDraftsHitLimit: boolean;
  deliveredNotInvoiced: DeliveredNotInvoicedRow[];
  deliveredNotInvoicedLoadOk: boolean;
  deliveredNotInvoicedHitLimit: boolean;
  watchdogFlags: WatchdogFlag[];
  upcomingJobs: UpcomingJobRow[];
  /** U13: scheduled jobs with no active per-location dispatch. */
  needsDispatchJobs: NeedsDispatchJobRow[];
  expiringLicenses: ExpiringLicenseRow[];
  overdueAR: OverdueARRow[];
  // (g) Products short for upcoming (next 7 days) scheduled jobs vs today's free stock.
  shortfalls: ShortfallRow[];
  // False when the shortfall RPC failed/threw — the tile then shows 'unavailable', not
  // a false 'all clear'.
  shortfallsLoadOk: boolean;
  plannedBookingAttention: PlannedBookingAttentionRow[];
  plannedBookingAttentionLoadOk: boolean;
  // True only when get_watchdog_flags loaded cleanly. When false we CANNOT tell which
  // invoices are flagged, so bulk-posting is disabled (fail-safe — never post on unknown).
  watchdogLoadOk: boolean;
}

interface MorningSummaryRpc {
  active_orders_count: number | string;
  open_quotes_draft: number | string;
  open_quotes_sent: number | string;
  pending_deliveries_count: number | string;
  open_pos_count: number | string;
  inventory_available: number | string;
  inventory_prebooked: number | string;
  on_order_units: number | string;
  on_order_po_count: number | string;
  committed_units: number | string;
  committed_order_count: number | string;
}

interface MorningSummaryData {
  activeOrdersCount: number;
  openQuotesDraft: number;
  openQuotesSent: number;
  pendingDeliveriesCount: number;
  openPosCount: number;
  inventoryAvailable: number;
  inventoryPrebooked: number;
  onOrderUnits: number;
  onOrderPoCount: number;
  committedUnits: number;
  committedOrderCount: number;
  programCompletionPct: number | null;
}

type RawUnbilledJob = {
  id: string;
  job_number: string;
  job_date: string;
  total_acres: number | null;
  total_price_cents: number | null;
  customer: { farm_name: string } | null;
};

type RawPostableInvoice = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  status: string;
  total_amount_cents: number;
  job_id: string | null;
  invoice_group_id: string | null;
  pricing_pending: boolean | null;
  customer: { farm_name: string } | null;
};

type RawChemicalDraft = {
  id: string;
  invoice_number: string;
  status: string;
  total_amount_cents: number;
  customer: { farm_name: string } | null;
};

type RawCompletedDelivery = {
  id: string;
  delivery_number: string;
  order_id: string | null;
  completed_at: string | null;
  customer: { farm_name: string } | null;
};

type RawUpcomingJob = {
  id: string;
  job_number: string;
  job_date: string;
  total_acres: number | null;
  customer: { farm_name: string } | null;
};

type RawLicense = {
  id: string;
  holder_name: string;
  license_type: string;
  expiry_date: string;
  customer: { farm_name: string } | null;
};

type RawOverdueAR = {
  id: string;
  invoice_number: string;
  due_date: string;
  balance_cents: number;
  customer: { farm_name: string } | null;
};

// Exact jsonb shape returned by get_expiring_planned_holds (planned_programs.sql).
type ExpiringPlannedHoldRpcRow = {
  hold_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  expires_at: string;
  needed_by_date: string | null;
  quote_id: string;
  quote_number: string;
};

type RawLapsedPlannedHold = {
  id: string;
  product_id: string;
  quantity: number;
  expires_at: string;
  source_id: string | null;
};

type RawQuoteNumber = {
  id: string;
  quote_number: string;
};

type RawProductName = {
  id: string;
  product_name: string;
};

const TILE_LIMIT = 50;

const emptyMorningSummary: MorningSummaryData = {
  activeOrdersCount: 0,
  openQuotesDraft: 0,
  openQuotesSent: 0,
  pendingDeliveriesCount: 0,
  openPosCount: 0,
  inventoryAvailable: 0,
  inventoryPrebooked: 0,
  onOrderUnits: 0,
  onOrderPoCount: 0,
  committedUnits: 0,
  committedOrderCount: 0,
  programCompletionPct: null,
};

// ── Helper components ─────────────────────────────────────────────────────────

function AllClear({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-3 text-sm text-gray-500">
      <CheckCircle className="w-4 h-4 text-crx-green flex-shrink-0" />
      <span>{label}</span>
    </div>
  );
}

function TileHeader({
  icon,
  title,
  count,
  countColor,
  linkLabel,
  onLink,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  countColor?: string;
  linkLabel?: string;
  onLink?: () => void;
}) {
  const color = count === 0 ? 'text-gray-400' : (countColor ?? 'text-red-600');
  return (
    <div className="flex items-start justify-between gap-2 mb-3">
      <div className="flex min-w-0 items-start gap-2">
        {icon}
        <h2 className="font-semibold text-nav-dark">{title}</h2>
        <span className={`text-sm font-bold ${color}`}>({count})</span>
      </div>
      {onLink && (
        <button
          onClick={onLink}
          className="flex min-h-[44px] flex-shrink-0 items-center gap-1 text-sm text-crx-green hover:underline sm:min-h-0"
        >
          {linkLabel ?? 'View all'} <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function LinkedCard({ to, children }: { to: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  const open = () => navigate(to);

  return (
    <Card
      hover
      role="button"
      tabIndex={0}
      className="min-w-0 cursor-pointer"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
    >
      {children}
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OfficeCockpit() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [loading, setLoading] = useState(true);
  const [morningSummary, setMorningSummary] = useState<MorningSummaryData>(emptyMorningSummary);
  const [morningSummaryLoadOk, setMorningSummaryLoadOk] = useState(false);
  const [data, setData] = useState<CockpitData>({
    unbilledJobs: [],
    postableInvoices: [],
    chemicalDrafts: [],
    chemicalDraftsHitLimit: false,
    deliveredNotInvoiced: [],
    deliveredNotInvoicedLoadOk: false,
    deliveredNotInvoicedHitLimit: false,
    watchdogFlags: [],
    upcomingJobs: [],
    needsDispatchJobs: [],
    expiringLicenses: [],
    overdueAR: [],
    shortfalls: [],
    shortfallsLoadOk: false,
    plannedBookingAttention: [],
    plannedBookingAttentionLoadOk: false,
    watchdogLoadOk: false,
  });
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  // §4 Post-all-clean state.
  const [postAllOpen, setPostAllOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  // Idempotency keys keyed by invoice id (group keyed by 'grp:<id>') so a retry of
  // a failed item reuses the SAME key (no risk of double-posting on retry).
  const postKeysRef = useRef<Record<string, string>>({});

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const today = localToday();
    const in7Days = localDatePlusDays(7);
    const in30Days = localDatePlusDays(30);
    const past30Days = localDatePlusDays(-30);

    // status-enum-check: exempt (TS) — cross-table: jobs uses 'completed'/'scheduled',
    // deliveries uses 'completed', and invoices uses the posting/void statuses above.

    // (c) Active watchdog flags (non-dismissed) via §2 RPC — pulled out of
    // Promise.all so the assertRpcCoverage scanner can detect the capture.
    const watchdogRes = await supabaseUntyped.rpc('get_watchdog_flags', {
      p_job_id: null,
      p_invoice_id: null,
      p_flag_type: null,
      p_include_dismissed: false,
    });

    // (g) Inventory shortfalls — products short for the next 7 days of scheduled jobs
    // vs today's free stock (available − prebooked − active holds). Read-only RPC pulled
    // out of Promise.all so the assertRpcCoverage scanner can detect the capture.
    const shortfallsRes = await supabaseUntyped.rpc('get_job_inventory_shortfalls', {
      p_days_ahead: 7,
    });

    // Planned holds expiring soon. The RPC deliberately excludes already-lapsed holds,
    // which are loaded directly below so the booking tile shows both conditions.
    const expiringPlannedHoldsRes = await supabaseUntyped.rpc('get_expiring_planned_holds', {
      p_days_ahead: 7,
    });

    const [
      unbilledJobsRes,
      postableInvRes,
      chemicalDraftsRes,
      completedDeliveriesRes,
      upcomingJobsRes,
      expiringLicRes,
      overdueARRes,
      needsDispatchRes,
      lapsedPlannedHoldsRes,
    ] = await Promise.all([
      // (a) Completed jobs with no invoice
      supabase
        .from('jobs')
        .select('id, job_number, job_date, total_acres, total_price_cents, customer:customers(farm_name)')
        .eq('status', 'completed')
        .is('invoice_id', null)
        .is('deleted_at', null)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (b) Draft/unposted field-app invoices (§4 auto-populates these)
      supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, status, total_amount_cents, job_id, invoice_group_id, pricing_pending, customer:customers(farm_name)')
        .in('status', ['draft', 'unposted'])
        .eq('invoice_type', 'field_application')
        .is('deleted_at', null)
        .order('invoice_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (b2) Draft/unposted chemical-sale invoices are a separate posting queue.
      // Do not mix these into the field-app "Post all clean" action above.
      supabase
        .from('invoices')
        .select('id, invoice_number, status, total_amount_cents, customer:customers(farm_name)')
        .eq('invoice_type', 'chemical_sale')
        .in('status', ['draft', 'unposted'])
        .is('deleted_at', null)
        .order('invoice_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (b3) Candidate completed deliveries. Active invoice coverage is checked
      // in one follow-up invoices query after these order IDs are known.
      supabase
        .from('deliveries')
        .select('id, delivery_number, order_id, completed_at, customer:customers(farm_name)')
        .eq('status', 'completed')
        .is('deleted_at', null)
        .order('completed_at', { ascending: false })
        .limit(TILE_LIMIT),

      // (d) Upcoming scheduled jobs (next 7 days) — proxy for weather-at-risk
      supabase
        .from('jobs')
        .select('id, job_number, job_date, total_acres, customer:customers(farm_name)')
        .eq('status', 'scheduled')
        .is('deleted_at', null)
        .gte('job_date', today)
        .lte('job_date', in7Days)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (e) Expiring applicator licenses / buyer certs within 30 days
      supabase
        .from('applicator_licenses')
        .select('id, holder_name, license_type, expiry_date, customer:customers(farm_name)')
        .eq('is_active', true)
        .gte('expiry_date', past30Days)
        .lte('expiry_date', in30Days)
        .order('expiry_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (f) Overdue field-app AR: balance > 0, past due_date. Include BOTH 'posted'
      // (past due but not yet swept) AND 'overdue' (already marked by mark_overdue_invoices)
      // — filtering to 'posted' alone hides the invoices that are actually overdue.
      supabase
        .from('invoices')
        .select('id, invoice_number, due_date, balance_cents, customer:customers(farm_name)')
        .eq('invoice_type', 'field_application')
        .in('status', ['posted', 'overdue'])
        .lt('due_date', today)
        .gt('balance_cents', 0)
        .is('deleted_at', null)
        .order('due_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (h) U13 (#15-21/#111, Codex R1 #1): scheduled jobs with NO active
      // per-location dispatch AND no legacy whole-job applicator (a job-level
      // applicator_id counts as assigned — matches the migration's
      // unassigned_jobs rule and the Jobs list's needs_dispatch flag). The
      // "no active dispatch" predicate runs SERVER-side via the PostgREST
      // anti-join pattern (left-embed filtered to dispatch_status='dispatched',
      // then keep only rows whose embed came back EMPTY via .is(..., null)) —
      // a client-side filter over the first TILE_LIMIT rows would hide real
      // needs-dispatch jobs whenever that first page was fully dispatched.
      supabase
        .from('jobs')
        .select('id, job_number, job_date, customer:customers(farm_name), job_location_dispatches!left(id)')
        .eq('status', 'scheduled')
        .is('deleted_at', null)
        .is('applicator_id', null)
        .eq('job_location_dispatches.dispatch_status', 'dispatched')
        .is('job_location_dispatches', null)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),

      // Already-lapsed planned holds are intentionally not returned by the
      // expiring-holds RPC, so query them separately.
      supabase
        .from('inventory_holds')
        .select('id, product_id, quantity, expires_at, source_id')
        .eq('hold_type', 'crop_program')
        .eq('is_active', true)
        // Include today to close the live RPC's strict `expires_at > CURRENT_DATE` gap; it is unchangeable here.
        .lte('expires_at', today)
        .order('expires_at', { ascending: true }),
    ]);

    // Kept OUT of Promise.all: the assertRpcResult coverage checker only
    // counts `= await supabase.rpc(...)` captures (see assertRpcCoverage.test.ts).
    const morningSummaryRes = await supabase.rpc('operational_dashboard_summary');
    const programCompletionRes = await supabase.rpc('get_program_completion');

    const rawCompletedDeliveries = (completedDeliveriesRes.data || []) as RawCompletedDelivery[];
    const completedDeliveryCandidates = rawCompletedDeliveries.filter(
      (row): row is RawCompletedDelivery & { order_id: string } => row.order_id != null
    );
    const deliveryOrderIds = [...new Set(completedDeliveryCandidates.map((row) => row.order_id))];
    let deliveryInvoiceError: { message?: string } | null = null;
    let activeDeliveryInvoices: DeliveryInvoiceCoverage[] = [];

    if (deliveryOrderIds.length > 0) {
      const invoiceCoverageRes = await supabase
        .from('invoices')
        .select('order_id, delivery_id, invoice_type, status, deleted_at')
        .in('order_id', deliveryOrderIds)
        .not('status', 'in', '("voided","cancelled")')
        .is('deleted_at', null);
      deliveryInvoiceError = invoiceCoverageRes.error;
      activeDeliveryInvoices = (invoiceCoverageRes.data || []) as DeliveryInvoiceCoverage[];
    }

    const rawLapsedPlannedHolds = (lapsedPlannedHoldsRes.data || []) as RawLapsedPlannedHold[];
    const lapsedSourceIds = [...new Set(
      rawLapsedPlannedHolds
        .map((hold) => hold.source_id)
        .filter((sourceId): sourceId is string => sourceId != null)
    )];
    const lapsedProductIds = [...new Set(rawLapsedPlannedHolds.map((hold) => hold.product_id))];
    let lapsedQuotes: RawQuoteNumber[] = [];
    let lapsedProducts: RawProductName[] = [];
    let lapsedQuotesError: { message?: string } | null = null;
    let lapsedProductsError: { message?: string } | null = null;

    if (lapsedSourceIds.length > 0 || lapsedProductIds.length > 0) {
      const [lapsedQuotesRes, lapsedProductsRes] = await Promise.all([
        lapsedSourceIds.length > 0
          ? supabase.from('quotes').select('id, quote_number').in('id', lapsedSourceIds)
          : Promise.resolve({ data: [], error: null }),
        lapsedProductIds.length > 0
          ? supabase.from('products').select('id, product_name').in('id', lapsedProductIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      lapsedQuotes = (lapsedQuotesRes.data || []) as RawQuoteNumber[];
      lapsedProducts = (lapsedProductsRes.data || []) as RawProductName[];
      lapsedQuotesError = lapsedQuotesRes.error;
      lapsedProductsError = lapsedProductsRes.error;
    }

    let expiringPlannedHolds: ExpiringPlannedHoldRpcRow[] = [];
    let expiringPlannedHoldsValidationError: Error | null = null;
    if (!expiringPlannedHoldsRes.error) {
      try {
        expiringPlannedHolds = assertRpcResult<ExpiringPlannedHoldRpcRow[]>(
          expiringPlannedHoldsRes.data,
          'get_expiring_planned_holds'
        );
      } catch (error) {
        expiringPlannedHoldsValidationError = error instanceof Error
          ? error
          : new Error('Invalid get_expiring_planned_holds response');
      }
    }

    let morningSummaryValidationError: Error | null = null;
    let programCompletionValidationError: Error | null = null;
    let programCompletionPct: number | null = null;
    if (!programCompletionRes.error && programCompletionRes.data) {
      try {
        const programs = assertRpcResult<Array<{ completion_pct: number | string }>>(
          programCompletionRes.data,
          'get_program_completion'
        );
        if (programs.length > 0) {
          const totalPct = programs.reduce((sum, program) => sum + (Number(program.completion_pct) || 0), 0);
          programCompletionPct = Math.round(totalPct / programs.length);
        } else {
          programCompletionPct = 0;
        }
      } catch (error) {
        programCompletionValidationError = error instanceof Error
          ? error
          : new Error('Invalid get_program_completion response');
      }
    }
    let nextMorningSummary = emptyMorningSummary;
    let nextMorningSummaryLoadOk = false;
    if (!morningSummaryRes.error && morningSummaryRes.data) {
      try {
        const summary = assertRpcResult<MorningSummaryRpc>(
          morningSummaryRes.data,
          'operational_dashboard_summary'
        );
        nextMorningSummary = {
          activeOrdersCount: Number(summary.active_orders_count) || 0,
          openQuotesDraft: Number(summary.open_quotes_draft) || 0,
          openQuotesSent: Number(summary.open_quotes_sent) || 0,
          pendingDeliveriesCount: Number(summary.pending_deliveries_count) || 0,
          openPosCount: Number(summary.open_pos_count) || 0,
          inventoryAvailable: Number(summary.inventory_available) || 0,
          inventoryPrebooked: Number(summary.inventory_prebooked) || 0,
          onOrderUnits: Number(summary.on_order_units) || 0,
          onOrderPoCount: Number(summary.on_order_po_count) || 0,
          committedUnits: Number(summary.committed_units) || 0,
          committedOrderCount: Number(summary.committed_order_count) || 0,
          programCompletionPct,
        };
        nextMorningSummaryLoadOk = true;
      } catch (error) {
        morningSummaryValidationError = error instanceof Error
          ? error
          : new Error('Invalid operational_dashboard_summary response');
      }
    }

    const errors = [
      unbilledJobsRes.error,
      postableInvRes.error,
      chemicalDraftsRes.error,
      completedDeliveriesRes.error,
      deliveryInvoiceError,
      watchdogRes.error,
      shortfallsRes.error,
      expiringPlannedHoldsRes.error,
      expiringPlannedHoldsValidationError,
      lapsedPlannedHoldsRes.error,
      lapsedQuotesError,
      lapsedProductsError,
      upcomingJobsRes.error,
      expiringLicRes.error,
      overdueARRes.error,
      needsDispatchRes.error,
      morningSummaryRes.error,
      morningSummaryValidationError,
      programCompletionRes.error,
      programCompletionValidationError,
    ].filter(Boolean);

    if (errors.length > 0) {
      const firstErr = errors[0] as { message?: string };
      Sentry.captureException(firstErr, { tags: { page: 'office-cockpit' } });
      toast('error', `Failed to load some cockpit data: ${firstErr?.message ?? 'Unknown error'}`);
    }

    const unbilledJobs: UnbilledJobRow[] = ((unbilledJobsRes.data || []) as RawUnbilledJob[]).map((r) => ({
      id: r.id,
      job_number: r.job_number,
      job_date: r.job_date,
      total_acres: r.total_acres,
      total_price_cents: r.total_price_cents,
      customer_name: r.customer?.farm_name ?? 'Unknown',
    }));

    const postableInvoices: PostableInvoiceRow[] = ((postableInvRes.data || []) as RawPostableInvoice[]).map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      status: r.status,
      total_amount_cents: r.total_amount_cents,
      customer_name: r.customer?.farm_name ?? 'Unknown',
      job_id: r.job_id,
      invoice_group_id: r.invoice_group_id,
      pricing_pending: r.pricing_pending === true,
    }));

    const chemicalDrafts: ChemicalDraftRow[] = ((chemicalDraftsRes.data || []) as RawChemicalDraft[]).map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      status: r.status,
      total_amount_cents: r.total_amount_cents,
      customer_name: r.customer?.farm_name ?? 'Unknown',
    }));
    const chemicalDraftsHitLimit = (chemicalDraftsRes.data || []).length === TILE_LIMIT;

    const deliveredNotInvoicedLoadOk = !completedDeliveriesRes.error && !deliveryInvoiceError;
    const deliveredNotInvoicedHitLimit = rawCompletedDeliveries.length === TILE_LIMIT;
    // Mirrors create_invoice_for_unbilled_delivery's own precondition: an invoice
    // covers this delivery when it is not a credit memo and targets this delivery
    // or the whole parent order.
    // The guarded fix action lives on DeliveryDetail, where the RPC is confirmed.
    const deliveredNotInvoiced: DeliveredNotInvoicedRow[] = deliveredNotInvoicedLoadOk
      ? completedDeliveryCandidates
        .filter((deliveryRow) => !activeDeliveryInvoices.some((invoiceRow) =>
          activeInvoiceCoversDelivery(invoiceRow, deliveryRow.id, deliveryRow.order_id)
        ))
        .map((deliveryRow) => ({
          id: deliveryRow.id,
          delivery_number: deliveryRow.delivery_number,
          order_id: deliveryRow.order_id,
          completed_at: deliveryRow.completed_at,
          customer_name: deliveryRow.customer?.farm_name ?? 'Unknown',
        }))
      : [];

    let watchdogFlags: WatchdogFlag[] = [];
    let watchdogLoadOk = false;
    if (!watchdogRes.error && watchdogRes.data) {
      try {
        watchdogFlags = assertRpcResult<WatchdogFlag[]>(watchdogRes.data, 'get_watchdog_flags');
        watchdogLoadOk = true;
      } catch (e) {
        Sentry.captureException(e, { tags: { page: 'office-cockpit', tile: 'watchdog' } });
      }
    }

    const upcomingJobs: UpcomingJobRow[] = ((upcomingJobsRes.data || []) as RawUpcomingJob[]).map((r) => ({
      id: r.id,
      job_number: r.job_number,
      job_date: r.job_date,
      total_acres: r.total_acres,
      customer_name: r.customer?.farm_name ?? 'Unknown',
    }));

    const expiringLicenses: ExpiringLicenseRow[] = ((expiringLicRes.data || []) as RawLicense[]).map((r) => ({
      id: r.id,
      holder_name: r.holder_name,
      license_type: r.license_type,
      expiry_date: r.expiry_date,
      customer_name: r.customer?.farm_name ?? null,
      expired: r.expiry_date < today,
    }));

    const overdueAR: OverdueARRow[] = ((overdueARRes.data || []) as RawOverdueAR[]).map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      due_date: r.due_date,
      balance_cents: r.balance_cents,
      customer_name: r.customer?.farm_name ?? 'Unknown',
    }));

    // U13 (Codex R1 #1): the anti-join + .is('applicator_id', null) above
    // already excluded dispatched/legacy-assigned jobs SERVER-side, so every
    // returned row qualifies — just map it.
    type RawNeedsDispatch = {
      id: string; job_number: string; job_date: string;
      customer?: { farm_name?: string } | null;
    };
    const needsDispatchJobs: NeedsDispatchJobRow[] = ((needsDispatchRes.data || []) as RawNeedsDispatch[])
      .map((r) => ({
        id: r.id,
        job_number: r.job_number,
        job_date: r.job_date,
        customer_name: r.customer?.farm_name ?? 'Unknown',
      }));

    let shortfalls: ShortfallRow[] = [];
    let shortfallsLoadOk = false;
    if (!shortfallsRes.error && shortfallsRes.data) {
      try {
        shortfalls = assertRpcResult<ShortfallRow[]>(shortfallsRes.data, 'get_job_inventory_shortfalls');
        shortfallsLoadOk = true;
      } catch (e) {
        Sentry.captureException(e, { tags: { page: 'office-cockpit', tile: 'shortfalls' } });
      }
    }

    const plannedBookingAttentionLoadOk = !expiringPlannedHoldsRes.error &&
      !expiringPlannedHoldsValidationError &&
      !lapsedPlannedHoldsRes.error &&
      !lapsedQuotesError &&
      !lapsedProductsError;
    const lapsedQuoteNumbers = new Map(lapsedQuotes.map((quote) => [quote.id, quote.quote_number]));
    const lapsedProductNames = new Map(lapsedProducts.map((product) => [product.id, product.product_name]));
    const plannedBookingAttention: PlannedBookingAttentionRow[] = plannedBookingAttentionLoadOk
      ? [
        ...rawLapsedPlannedHolds
          .filter((hold): hold is RawLapsedPlannedHold & { source_id: string } => hold.source_id != null)
          .map((hold) => ({
            hold_id: hold.id,
            quote_id: hold.source_id,
            quote_number: lapsedQuoteNumbers.get(hold.source_id) ?? 'Unknown',
            product_id: hold.product_id,
            product_name: lapsedProductNames.get(hold.product_id) ?? 'Unknown product',
            quantity: Number(hold.quantity),
            expires_at: hold.expires_at,
            attention: 'lapsed' as const,
          })),
        ...expiringPlannedHolds.map((hold) => ({
          hold_id: hold.hold_id,
          quote_id: hold.quote_id,
          quote_number: hold.quote_number,
          product_id: hold.product_id,
          product_name: hold.product_name,
          quantity: Number(hold.quantity),
          expires_at: hold.expires_at,
          attention: 'expiring' as const,
        })),
      ]
      : [];

    setData({
      unbilledJobs,
      postableInvoices,
      chemicalDrafts,
      chemicalDraftsHitLimit,
      deliveredNotInvoiced,
      deliveredNotInvoicedLoadOk,
      deliveredNotInvoicedHitLimit,
      watchdogFlags,
      upcomingJobs,
      needsDispatchJobs,
      expiringLicenses,
      overdueAR,
      shortfalls,
      shortfallsLoadOk,
      plannedBookingAttention,
      plannedBookingAttentionLoadOk,
      watchdogLoadOk,
    });
    setMorningSummary(nextMorningSummary);
    setMorningSummaryLoadOk(nextMorningSummaryLoadOk);
    setLastRefreshed(new Date());
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const totalExceptions =
    data.unbilledJobs.length +
    data.postableInvoices.length +
    data.chemicalDrafts.length +
    data.deliveredNotInvoiced.length +
    data.watchdogFlags.length +
    data.expiringLicenses.length +
    data.overdueAR.length +
    data.shortfalls.length +
    data.needsDispatchJobs.length +
    data.plannedBookingAttention.length;

  // §4 Post-all-clean gating. A draft is "clean" (safe to auto-post in bulk) only when:
  //   (a) it passes validation — pricing is NOT pending (the same gate post_invoice_group
  //       / post_invoice enforce; we pre-filter so the bulk action only attempts postable
  //       ones), AND
  //   (b) it has NO open §2 watchdog flag on the invoice itself OR on its source job
  //       (acre-divergence / REI flags attach to the job, double-bill/rate flags to the
  //       invoice). Any open flag means a human must look before posting — never bulk-post it.
  // The DB still enforces both gates inside post_invoice — this is defense-in-depth + UX.
  const flaggedInvoiceIds = new Set(
    data.watchdogFlags.map((f) => f.invoice_id).filter((x): x is string => !!x)
  );
  const flaggedJobIds = new Set(
    data.watchdogFlags.map((f) => f.job_id).filter((x): x is string => !!x)
  );
  // Per-invoice cleanliness: pricing resolved AND no open flag on the invoice or its source job.
  const isInvoiceCleanBase = (inv: PostableInvoiceRow): boolean => {
    if (inv.pricing_pending) return false;
    if (flaggedInvoiceIds.has(inv.id)) return false;
    if (inv.job_id && flaggedJobIds.has(inv.job_id)) return false;
    return true;
  };
  // SPLIT GROUPS: post_invoice_group posts EVERY member atomically, but this tile only loads up
  // to TILE_LIMIT invoices — a group could have a flagged/pricing-pending member OUTSIDE that
  // window we can't see here. So bulk "post all clean" NEVER posts a grouped invoice; split-group
  // invoices are left for a human to post deliberately from the invoice/group detail (where the
  // whole group is visible). Only standalone (non-grouped) clean drafts are bulk-postable.
  const isInvoiceClean = (inv: PostableInvoiceRow): boolean =>
    isInvoiceCleanBase(inv) && inv.invoice_group_id == null;
  // FAIL-SAFE: if get_watchdog_flags did NOT load, we cannot know which invoices are flagged,
  // so NOTHING is bulk-postable (post individually instead). Never fail open on money.
  const cleanInvoices = data.watchdogLoadOk ? data.postableInvoices.filter(isInvoiceClean) : [];
  const blockedInvoices = data.postableInvoices.filter((inv) => !cleanInvoices.includes(inv));

  // Post ONLY the clean drafts. Group → post_invoice_group; single → post_invoice
  // (the canonical branch used by InvoiceDetail/FieldInvoicesUnposted). A HUMAN clicked
  // this, so posting is allowed here — but we NEVER touch a flagged/pricing-pending one.
  const runPostAllClean = async () => {
    setPostAllOpen(false);
    if (!profile) {
      toast('error', 'Profile not loaded — please refresh.');
      return;
    }
    if (cleanInvoices.length === 0) {
      toast('info', 'No clean invoices to post.');
      return;
    }
    await runCriticalAction({
      action: async () => {
        // FRESHNESS GUARD (Codex go-live P2): `cleanInvoices` was derived from the LAST
        // persisted watchdog sweep, which can be STALE if jobs/invoices changed since the
        // cockpit loaded. Before posting real money, RECOMPUTE the sweep and re-derive
        // "clean" from fresh flags. Fail CLOSED — if we can't confirm freshness, post NOTHING.
        let freshFlags: WatchdogFlag[];
        try {
          // refresh_watchdog_flags RETURNS jsonb (sweep counts); we only need it to have run.
          await supabaseUntyped.rpc('refresh_watchdog_flags', {}).throwOnError();
          const freshRes = await supabaseUntyped.rpc('get_watchdog_flags', {
            p_job_id: null,
            p_invoice_id: null,
            p_flag_type: null,
            p_include_dismissed: false,
          });
          if (freshRes.error) throw freshRes.error;
          freshFlags = assertRpcResult<WatchdogFlag[]>(freshRes.data, 'get_watchdog_flags');
        } catch (err: unknown) {
          await fetchAll(); // resync the tiles to whatever the fresh sweep produced
          throw new Error(
            `Could not confirm the invoices are still clean (watchdog refresh failed) — nothing was posted. ${sanitizeError(err)}`
          );
        }

        const freshFlaggedInv = new Set(
          freshFlags.map((f) => f.invoice_id).filter((x): x is string => !!x)
        );
        const freshFlaggedJob = new Set(
          freshFlags.map((f) => f.job_id).filter((x): x is string => !!x)
        );
        // Re-derive the still-clean set from FRESH flags (standalone + priced + no open flag).
        const toPost = cleanInvoices.filter(
          (inv) =>
            !inv.pricing_pending &&
            inv.invoice_group_id == null &&
            !freshFlaggedInv.has(inv.id) &&
            !(inv.job_id != null && freshFlaggedJob.has(inv.job_id))
        );
        const heldBack = cleanInvoices.length - toPost.length;

        if (toPost.length === 0) {
          await fetchAll();
          throw new Error(
            `After refreshing the watchdog, none of the ${cleanInvoices.length} invoice(s) are still clean — review the new flags before posting.`
          );
        }

        let posted = 0;
        const failures: string[] = [];
        // toPost holds only NON-grouped, still-clean drafts, so each posts singly via
        // post_invoice — we never call post_invoice_group here.
        for (const inv of toPost) {
          try {
            if (!postKeysRef.current[inv.id]) {
              postKeysRef.current[inv.id] = generateIdempotencyKey('post_invoice', `${profile.id}:${inv.id}`);
            }
            // post_invoice RETURNS void — .throwOnError(), no result to assert.
            await supabase
              .rpc('post_invoice', {
                p_invoice_id: inv.id,
                p_idempotency_key: postKeysRef.current[inv.id],
              })
              .throwOnError();
            posted += 1;
          } catch (err: unknown) {
            const blocked = describePostInvoiceBlock(err);
            if (blocked) {
              failures.push(`${inv.invoice_number}: ${blocked}`);
            } else {
              failures.push(`${inv.invoice_number}: ${sanitizeError(err)}`);
            }
          }
        }
        await fetchAll();
        if (failures.length > 0 || heldBack > 0) {
          // Honest partial outcome; keep failed keys so a retry reuses them.
          const heldMsg = heldBack > 0 ? ` ${heldBack} held back (new watchdog flag since load).` : '';
          throw new Error(
            `Posted ${posted}/${toPost.length}.${heldMsg}` +
            (failures.length > 0
              ? ` Failed: ${failures.slice(0, 3).join(' | ')}${failures.length > 3 ? ' …' : ''}`
              : '')
          );
        }
        postKeysRef.current = {};
      },
      toast,
      successMessage: `Posted ${cleanInvoices.length} clean invoice(s)`,
      setLoading: setPosting,
      sentryTag: 'cockpit_post_all_clean',
    });
  };

  if (loading) {
    return (
      <div className="min-w-0 space-y-4 p-4 sm:p-6">
        <PageHeader title="Office" accent="Cockpit" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4 p-4 sm:p-6">
      <PageHeader
        title="Office"
        accent="Cockpit"
        subtitle={<>Everything stuck or wrong &mdash; one screen, no report-running.</>}
        actions={
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
            <Button
              onClick={() => navigate('/payments')}
              variant="ghost"
              size="sm"
            >
              Record payments &rarr;
            </Button>
            {lastRefreshed && (
              <span className="text-xs text-gray-400">
                Updated {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
            <Button
              onClick={() => { void fetchAll(); }}
              variant="secondary"
              size="sm"
              className="flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
          </div>
        }
      />

      {/* All-clear banner when nothing is wrong */}
      {totalExceptions === 0 && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4">
          <CheckCircle className="w-6 h-6 text-crx-green flex-shrink-0" />
          <div>
            <p className="font-semibold text-emerald-800">All clear!</p>
            <p className="text-sm text-emerald-600">No exceptions found across any category.</p>
          </div>
        </div>
      )}

      {/* Tile grid — 3-column on large screens */}
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">

        {/* (a) Completed-but-unbilled jobs */}
        <Card>
          <TileHeader
            icon={<Tractor className="w-5 h-5 text-orange-500" />}
            title="Unbilled Jobs"
            count={data.unbilledJobs.length}
            countColor="text-orange-600"
            linkLabel="View all"
            onLink={() => navigate('/field-invoices/unbilled')}
          />
          {data.unbilledJobs.length === 0 ? (
            <AllClear label="No completed jobs without an invoice." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.unbilledJobs.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/jobs/${row.id}`)}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.job_number}</span>
                    {row.total_acres != null && (
                      <span className="ml-2 text-gray-400">{row.total_acres} ac</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-gray-400 flex-shrink-0">
                    <span>{row.job_date}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </button>
              ))}
              {data.unbilledJobs.length > 6 && (
                <button
                  onClick={() => navigate('/field-invoices/unbilled')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.unbilledJobs.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

        {/* (h) U13 (#15-21/#111): scheduled jobs with no active dispatch */}
        <Card>
          <TileHeader
            icon={<Send className="w-5 h-5 text-sky-500" />}
            title="Needs Dispatch"
            count={data.needsDispatchJobs.length}
            countColor="text-sky-600"
            linkLabel="View all"
            onLink={() => navigate('/jobs')}
          />
          {data.needsDispatchJobs.length === 0 ? (
            <AllClear label="No scheduled jobs without a dispatched applicator or crew." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.needsDispatchJobs.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/jobs/${row.id}`)}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.job_number}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Planned-booking holds that have lapsed or need attention in the next seven days. */}
        <Card>
          <TileHeader
            icon={<AlertTriangle className={`w-5 h-5 ${data.plannedBookingAttention.length === 0 ? 'text-gray-400' : 'text-red-500'}`} />}
            title="Planned bookings needing attention"
            count={data.plannedBookingAttention.length}
            countColor="text-red-600"
            linkLabel="Quotes"
            onLink={() => navigate('/quotes')}
          />
          {!data.plannedBookingAttentionLoadOk ? (
            <p className="py-2 text-sm text-gray-400">Planned-booking hold check unavailable right now.</p>
          ) : data.plannedBookingAttention.length === 0 ? (
            <AllClear label="No planned bookings have lapsed or are expiring soon." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.plannedBookingAttention.slice(0, 6).map((row, index) => (
                <button
                  key={row.hold_id ?? `${row.quote_id}-${row.product_id}-${row.expires_at}-${index}`}
                  onClick={() => navigate(`/quotes/${row.quote_id}`)}
                  className="min-h-[44px] w-full rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0"
                >
                  <span className={row.attention === 'lapsed' ? 'font-medium text-red-600' : 'font-medium text-nav-dark'}>Quote {row.quote_number}</span>
                  <span className={row.attention === 'lapsed' ? 'text-red-600' : 'text-gray-500'}> &mdash; {row.product_name} &middot; {row.quantity} &middot; </span>
                  <span className={row.attention === 'lapsed' ? 'text-red-600 font-medium' : 'text-orange-600 font-medium'}>
                    {row.attention === 'lapsed' ? 'lapsed' : 'expires'} {parseLocalDate(row.expires_at).toLocaleDateString()}
                  </span>
                </button>
              ))}
              {data.plannedBookingAttention.length > 6 && (
                <button
                  onClick={() => navigate('/quotes')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.plannedBookingAttention.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

        {/* (b) Field-app invoices ready to post */}
        <Card>
          <TileHeader
            icon={<FileCheck className="w-5 h-5 text-blue-500" />}
            title="Ready to Post"
            count={data.postableInvoices.length}
            countColor="text-blue-600"
            linkLabel="Field Invoices"
            onLink={() => navigate('/field-invoices/unposted')}
          />
          <p className="text-xs text-gray-400 mb-2">
            Draft/unposted field-app invoices &mdash; §4 Auto-Invoice auto-populates these.
          </p>
          {!data.watchdogLoadOk && data.postableInvoices.length > 0 && (
            <p className="text-xs text-amber-700 mb-2 flex items-start gap-1">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Watchdog flags couldn&apos;t be loaded &mdash; bulk posting is off (post individually so a flagged invoice can&apos;t slip through). Refresh to retry.
            </p>
          )}
          {data.postableInvoices.length > 0 && (
            <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-gray-100">
              <span className="text-xs text-gray-500">
                {cleanInvoices.length} clean
                {blockedInvoices.length > 0 && (
                  <span className="text-amber-600">
                    {' '}&middot; {blockedInvoices.length} need review
                  </span>
                )}
              </span>
              <Button
                size="sm"
                variant="primary"
                onClick={() => setPostAllOpen(true)}
                disabled={cleanInvoices.length === 0 || posting}
                loading={posting}
                className="flex items-center gap-1"
              >
                <FileCheck className="w-3.5 h-3.5" />
                Post all clean
              </Button>
            </div>
          )}
          {data.postableInvoices.length === 0 ? (
            <AllClear label="No field-app invoices waiting to post." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.postableInvoices.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/field-invoices/${row.id}`)}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.invoice_number}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Badge variant={row.status === 'unposted' ? 'info' : 'draft'} size="sm">
                      {row.status}
                    </Badge>
                    <span className="text-gray-600 text-xs">{formatCents(row.total_amount_cents)}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                  </div>
                </button>
              ))}
              {data.postableInvoices.length > 6 && (
                <button
                  onClick={() => navigate('/field-invoices/unposted')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.postableInvoices.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

        {/* (b2) Chemical-sale invoices ready to post — intentionally read-only here */}
        <Card>
          <TileHeader
            icon={<FileText className="w-5 h-5 text-violet-500" />}
            title="Chemical drafts to post"
            count={data.chemicalDrafts.length}
            countColor="text-violet-600"
            linkLabel="Invoices"
            onLink={() => navigate('/invoices')}
          />
          {data.chemicalDrafts.length === 0 ? (
            <AllClear label="No chemical-sale drafts waiting to post." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.chemicalDrafts.slice(0, 5).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/invoices/${row.id}`)}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.invoice_number}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Badge variant={row.status === 'unposted' ? 'info' : 'draft'} size="sm">
                      {row.status}
                    </Badge>
                    <span className="text-gray-600 text-xs">{formatCents(row.total_amount_cents)}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                  </div>
                </button>
              ))}
              {data.chemicalDrafts.length > 5 && (
                <button
                  onClick={() => navigate('/invoices')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.chemicalDrafts.length - 5} more
                </button>
              )}
            </div>
          )}
          {data.chemicalDraftsHitLimit && (
            <p className="mt-2 text-xs text-gray-400">
              Showing the first 50 &mdash; open Invoices for the full list.
            </p>
          )}
        </Card>

        {/* (b3) Completed deliveries with no active covering invoice */}
        <Card>
          <TileHeader
            icon={<Truck className="w-5 h-5 text-teal-500" />}
            title="Delivered, not invoiced"
            count={data.deliveredNotInvoiced.length}
            countColor="text-teal-600"
            linkLabel="Deliveries"
            onLink={() => navigate('/deliveries')}
          />
          {!data.deliveredNotInvoicedLoadOk ? (
            <p className="py-2 text-sm text-gray-400">Invoice coverage check unavailable right now.</p>
          ) : data.deliveredNotInvoiced.length === 0 ? (
            <AllClear label="Every completed delivery has an active invoice." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.deliveredNotInvoiced.slice(0, 5).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/deliveries/${row.id}`)}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.delivery_number}</span>
                  </div>
                  <div className="flex items-center gap-1 text-gray-400 flex-shrink-0">
                    <span className="text-xs">
                      {row.completed_at ? new Date(row.completed_at).toLocaleDateString() : 'Completed'}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </button>
              ))}
              {data.deliveredNotInvoiced.length > 5 && (
                <button
                  onClick={() => navigate('/deliveries')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.deliveredNotInvoiced.length - 5} more
                </button>
              )}
            </div>
          )}
          {data.deliveredNotInvoicedLoadOk && data.deliveredNotInvoicedHitLimit && (
            <p className="mt-2 text-xs text-gray-400">
              Coverage checked for the newest 50 completed deliveries.
            </p>
          )}
        </Card>

        {/* (c) Active watchdog flags from §2 */}
        <Card>
          <TileHeader
            icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
            title="Watchdog Flags"
            count={data.watchdogFlags.length}
            countColor="text-red-600"
            linkLabel="Manage"
            onLink={() => navigate('/watchdog')}
          />
          {data.watchdogFlags.length === 0 ? (
            <AllClear label="No active watchdog flags." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.watchdogFlags.slice(0, 6).map((flag) => (
                <button
                  key={flag.id}
                  onClick={() => {
                    if (flag.job_id) navigate(`/jobs/${flag.job_id}`);
                    else if (flag.invoice_id) navigate(`/field-invoices/${flag.invoice_id}`);
                    else navigate('/watchdog');
                  }}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={flag.severity === 'warning' ? 'warning' : 'error'} size="sm">
                      {flag.flag_type.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-gray-500 truncate">{flag.message}</span>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                </button>
              ))}
              {data.watchdogFlags.length > 6 && (
                <button
                  onClick={() => navigate('/watchdog')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.watchdogFlags.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

        {/* (d) Upcoming scheduled jobs — next 7 days */}
        <Card>
          <TileHeader
            icon={<CalendarClock className="w-5 h-5 text-indigo-500" />}
            title="Upcoming Jobs (7 days)"
            count={data.upcomingJobs.length}
            countColor="text-indigo-600"
            linkLabel="Schedule"
            onLink={() => navigate('/jobs')}
          />
          <p className="text-xs text-gray-400 mb-2">
            Scheduled jobs in the next 7 days. Weather risk is checked live in Job Detail
            (no stored weather-blocked flag exists in the DB).
          </p>
          {data.upcomingJobs.length === 0 ? (
            <AllClear label="No scheduled jobs in the next 7 days." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.upcomingJobs.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/jobs/${row.id}`)}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.job_number}</span>
                    {row.total_acres != null && (
                      <span className="ml-2 text-gray-400">{row.total_acres} ac</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-gray-400 flex-shrink-0">
                    <span>{row.job_date}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </button>
              ))}
              {data.upcomingJobs.length > 6 && (
                <button
                  onClick={() => navigate('/jobs')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.upcomingJobs.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

        {/* (e) Expiring applicator licenses / buyer certs */}
        <Card>
          <TileHeader
            icon={<ShieldAlert className="w-5 h-5 text-yellow-500" />}
            title="Expiring Licenses"
            count={data.expiringLicenses.length}
            countColor="text-yellow-600"
            linkLabel="Compliance"
            onLink={() => navigate('/compliance')}
          />
          {data.expiringLicenses.length === 0 ? (
            <AllClear label="No licenses or certs expiring within 30 days." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.expiringLicenses.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate('/compliance')}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.holder_name}</span>
                    {row.customer_name && (
                      <span className="ml-2 text-gray-400">{row.customer_name}</span>
                    )}
                    <span className="ml-2 text-gray-500">{row.license_type}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className={`text-xs font-medium ${row.expired ? 'text-red-600' : 'text-yellow-600'}`}>
                      {row.expired ? 'Expired' : 'Expires'} {row.expiry_date}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                  </div>
                </button>
              ))}
              {data.expiringLicenses.length > 6 && (
                <button
                  onClick={() => navigate('/compliance')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.expiringLicenses.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

        {/* (f) Overdue field-app AR */}
        <Card>
          <TileHeader
            icon={<DollarSign className="w-5 h-5 text-red-500" />}
            title="Overdue Field-App AR"
            count={data.overdueAR.length}
            countColor="text-red-600"
            linkLabel={isAdmin ? 'AR Aging' : undefined}
            onLink={isAdmin ? () => navigate('/ar-aging') : undefined}
          />
          {data.overdueAR.length === 0 ? (
            <AllClear label="No overdue field-app receivables." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.overdueAR.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/field-invoices/${row.id}`)}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.invoice_number}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-red-600 font-medium text-xs">{formatCents(row.balance_cents)}</span>
                    <span className="text-gray-400 text-xs">due {row.due_date}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                  </div>
                </button>
              ))}
              {data.overdueAR.length > 6 && (
                <button
                  onClick={() => navigate('/ar-aging')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.overdueAR.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

        {/* (g) Inventory shortfalls — products short for the next 7 days of scheduled jobs */}
        <Card>
          <TileHeader
            icon={<PackageX className={`w-5 h-5 ${data.shortfalls.length === 0 ? 'text-gray-400' : 'text-red-500'}`} />}
            title="Inventory Shortfalls"
            count={data.shortfalls.length}
            countColor="text-red-600"
            linkLabel="Inventory"
            onLink={() => navigate('/inventory')}
          />
          {!data.shortfallsLoadOk ? (
            <p className="py-2 text-sm text-gray-400">Shortfall check unavailable right now.</p>
          ) : data.shortfalls.length === 0 ? (
            <AllClear label="Enough stock for the next 7 days of scheduled jobs." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.shortfalls.slice(0, 6).map((row) => (
                <button
                  key={row.product_id}
                  onClick={() => navigate('/inventory')}
                  className="flex min-h-[44px] w-full flex-col items-start justify-between gap-2 rounded py-2 text-left text-sm transition-colors hover:bg-gray-50 sm:min-h-0 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-nav-dark">{row.product_name}</span>
                    <span className="ml-2 text-gray-500 text-xs">
                      {row.job_count} job{row.job_count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-red-600 font-medium text-xs">
                      short {row.shortfall_qty.toLocaleString(undefined, { maximumFractionDigits: 1 })}{row.inventory_unit ? ` ${row.inventory_unit}` : ''}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                  </div>
                </button>
              ))}
              {data.shortfalls.length > 6 && (
                <button
                  onClick={() => navigate('/inventory')}
                  className="w-full text-center py-2 text-sm text-crx-green hover:underline"
                >
                  +{data.shortfalls.length - 6} more
                </button>
              )}
            </div>
          )}
        </Card>

      </div>

      {/* The owner-approved morning sequence keeps exception queues first. */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Morning Snapshot</h2>
          {!morningSummaryLoadOk ? (
            <Card>
              <p className="text-sm text-gray-400">Operational KPI summary is unavailable right now. Refresh to retry.</p>
            </Card>
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5 [&>*]:min-w-0">
              <LinkedCard to="/orders">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                    <ShoppingCart className="w-4 h-4 text-blue-600" />
                  </div>
                  <span className="text-sm text-secondary">Active Orders</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-nav-dark">{morningSummary.activeOrdersCount}</p>
              </LinkedCard>

              <LinkedCard to="/quotes">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center">
                    <FileText className="w-4 h-4 text-purple-600" />
                  </div>
                  <span className="text-sm text-secondary">Open Quotes</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-nav-dark">
                  {morningSummary.openQuotesDraft + morningSummary.openQuotesSent}
                </p>
                <div className="flex gap-2 mt-1">
                  <Badge variant="draft" size="sm">{morningSummary.openQuotesDraft} draft</Badge>
                  <Badge variant="sent" size="sm">{morningSummary.openQuotesSent} sent</Badge>
                </div>
              </LinkedCard>

              <LinkedCard to="/deliveries">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">
                    <Truck className="w-4 h-4 text-green-600" />
                  </div>
                  <span className="text-sm text-secondary">Pending Deliveries</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-nav-dark">{morningSummary.pendingDeliveriesCount}</p>
              </LinkedCard>

              <LinkedCard to="/purchase-orders">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-teal-50 flex items-center justify-center">
                    <Package className="w-4 h-4 text-teal-600" />
                  </div>
                  <span className="text-sm text-secondary">Open POs</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-nav-dark">{morningSummary.openPosCount}</p>
              </LinkedCard>

              <LinkedCard to="/program-tracker">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                    <CheckSquare className="w-4 h-4 text-emerald-600" />
                  </div>
                  <span className="text-sm text-secondary">Program Progress</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-nav-dark">
                  {morningSummary.programCompletionPct === null ? '—' : `${morningSummary.programCompletionPct}%`}
                </p>
              </LinkedCard>
            </div>
          )}
        </div>

        {isAdmin && <FinanceSnapshotCard />}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Inventory Position</h2>
        {!morningSummaryLoadOk ? (
          <Card>
            <p className="text-sm text-gray-400">Inventory position is unavailable until the operational summary loads.</p>
          </Card>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3 [&>*]:min-w-0">
            <LinkedCard to="/inventory">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                  <Warehouse className="w-5 h-5 text-amber-600" />
                </div>
                <span className="text-sm text-secondary">Floor Stock</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">
                {morningSummary.inventoryAvailable.toLocaleString()} <span className="text-sm font-normal text-secondary">units</span>
              </p>
              <div className="flex gap-3 mt-1">
                <span className="text-xs text-crx-green">{(morningSummary.inventoryAvailable - morningSummary.inventoryPrebooked).toLocaleString()} free</span>
                <span className="text-xs text-amber-600">{morningSummary.inventoryPrebooked.toLocaleString()} pre-booked</span>
              </div>
            </LinkedCard>

            <LinkedCard to="/purchase-orders">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-sky-50 flex items-center justify-center">
                  <Package className="w-5 h-5 text-sky-600" />
                </div>
                <span className="text-sm text-secondary">On Order</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">
                {morningSummary.onOrderUnits.toLocaleString()} <span className="text-sm font-normal text-secondary">units</span>
              </p>
              <p className="text-xs text-secondary mt-1">Across {morningSummary.onOrderPoCount} open PO(s)</p>
            </LinkedCard>

            <LinkedCard to="/orders">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-violet-50 flex items-center justify-center">
                  <ClipboardCheck className="w-5 h-5 text-violet-600" />
                </div>
                <span className="text-sm text-secondary">Committed</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-nav-dark">
                {morningSummary.committedUnits.toLocaleString()} <span className="text-sm font-normal text-secondary">units</span>
              </p>
              <p className="text-xs text-secondary mt-1">Across {morningSummary.committedOrderCount} active order(s)</p>
            </LinkedCard>
          </div>
        )}
      </section>

      {(isAdmin || profile?.role === 'sales_rep') && (
        <Card>
          <CardHeader title="Quick" accent="Actions" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <button
              onClick={() => navigate('/deliveries?quickDeliver=1')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-crx-green/10 group-hover:bg-crx-green/20 flex items-center justify-center transition-colors">
                <Zap className="w-5 h-5 text-crx-green" />
              </div>
              <span className="text-sm font-medium text-nav-dark">Sell &amp; Deliver Now</span>
            </button>
            <button
              onClick={() => navigate('/quotes/new')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-purple-50 group-hover:bg-purple-100 flex items-center justify-center transition-colors">
                <FileText className="w-5 h-5 text-purple-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">New Quote</span>
            </button>
            <button
              onClick={() => navigate('/jobs/new')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-sky-50 group-hover:bg-sky-100 flex items-center justify-center transition-colors">
                <ClipboardList className="w-5 h-5 text-sky-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">New Job</span>
            </button>
            <button
              onClick={() => navigate('/orders/new')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-blue-50 group-hover:bg-blue-100 flex items-center justify-center transition-colors">
                <Plus className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm font-medium text-nav-dark">New Order</span>
            </button>
            <button
              onClick={() => navigate('/to-ship')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-crx-green/30 bg-crx-green-tint hover:bg-crx-green/10 hover:border-crx-green/40 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-crx-green/10 group-hover:bg-crx-green/20 flex items-center justify-center transition-colors">
                <PackageSearch className="w-5 h-5 text-crx-green" />
              </div>
              <span className="text-sm font-medium text-nav-dark">To-Ship</span>
            </button>
          </div>
          <div className="mt-4 border-t border-gray-100 pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <button
                onClick={() => navigate('/deliveries/new')}
                className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-gray-50/60 hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
              >
                <div className="w-10 h-10 rounded-lg bg-green-50 group-hover:bg-green-100 flex items-center justify-center transition-colors">
                  <Truck className="w-5 h-5 text-green-600" />
                </div>
                <span className="text-sm font-medium text-nav-dark">Schedule Delivery</span>
              </button>
              <button
                onClick={() => navigate('/purchase-orders/new')}
                className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-gray-50/60 hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
              >
                <div className="w-10 h-10 rounded-lg bg-teal-50 group-hover:bg-teal-100 flex items-center justify-center transition-colors">
                  <Package className="w-5 h-5 text-teal-600" />
                </div>
                <span className="text-sm font-medium text-nav-dark">New PO</span>
              </button>
              <button
                onClick={() => navigate('/inventory')}
                className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-gray-50/60 hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
              >
                <div className="w-10 h-10 rounded-lg bg-amber-50 group-hover:bg-amber-100 flex items-center justify-center transition-colors">
                  <Warehouse className="w-5 h-5 text-amber-600" />
                </div>
                <span className="text-sm font-medium text-nav-dark">Inventory</span>
              </button>
              <button
                onClick={() => navigate('/receiving')}
                className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-gray-50/60 hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
              >
                <div className="w-10 h-10 rounded-lg bg-indigo-50 group-hover:bg-indigo-100 flex items-center justify-center transition-colors">
                  <Inbox className="w-5 h-5 text-indigo-600" />
                </div>
                <span className="text-sm font-medium text-nav-dark">Receiving</span>
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* §4: Post-all-clean confirmation — in-app modal (no confirm()/alert()). */}
      <Modal
        open={postAllOpen}
        onClose={() => setPostAllOpen(false)}
        title="Post"
        accent="all clean"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            This will <strong>post</strong> the {cleanInvoices.length} field-application
            invoice(s) below. Posting locks an invoice and records it in the books &mdash;
            this is the human step in billing.
          </p>

          {cleanInvoices.length > 0 && (
            <div className="rounded-lg border border-gray-100 divide-y divide-gray-100 max-h-48 overflow-y-auto">
              {cleanInvoices.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium text-nav-dark">{inv.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{inv.invoice_number}</span>
                  </span>
                  <span className="text-gray-600">{formatCents(inv.total_amount_cents)}</span>
                </div>
              ))}
            </div>
          )}

          {blockedInvoices.length > 0 && (
            <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
              <p className="text-sm font-medium text-amber-800 mb-1">
                {blockedInvoices.length} invoice(s) will be skipped (need review):
              </p>
              <ul className="text-xs text-amber-700 list-disc list-inside space-y-0.5">
                {blockedInvoices.slice(0, 6).map((inv) => (
                  <li key={inv.id}>
                    #{inv.invoice_number} &mdash; {inv.customer_name}
                    {inv.pricing_pending ? ' (pricing incomplete)' : ' (open watchdog flag)'}
                  </li>
                ))}
                {blockedInvoices.length > 6 && <li>+{blockedInvoices.length - 6} more</li>}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setPostAllOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => { void runPostAllClean(); }}
              disabled={cleanInvoices.length === 0}
            >
              Post {cleanInvoices.length} invoice(s)
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
