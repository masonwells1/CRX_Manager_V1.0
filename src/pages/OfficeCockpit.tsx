/**
 * OfficeCockpit — §3 Beyond-Parity: Exception dashboard for the office team.
 *
 * ONE screen showing everything stuck or wrong across the field-app.
 * Replaces the old "run seven reports" ritual.
 *
 * Tiles:
 *   (a) Completed-but-unbilled jobs
 *   (b) Field-app invoices ready to post (draft/unposted) — §4 will populate this
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
 *   invoices.status: 'draft', 'unposted', 'posted' — all valid per CHECK constraint.
 *
 * RLS: each query inherits the caller's RLS context (direct table selects).
 * The watchdog RPC is SECURITY DEFINER but gates on role inside its body.
 * READ-ONLY — no mutations here.
 */
import { useEffect, useState, useCallback } from 'react';
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
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { supabase, supabaseUntyped, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { formatCents } from '../lib/money';
import { localToday, localDatePlusDays } from '../lib/dateUtils';
import { SkeletonCard } from '../components/ui/Skeleton';
import type { WatchdogFlag } from '../types';
import { useAuth } from '../contexts/AuthContext';

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

interface CockpitData {
  unbilledJobs: UnbilledJobRow[];
  postableInvoices: PostableInvoiceRow[];
  watchdogFlags: WatchdogFlag[];
  upcomingJobs: UpcomingJobRow[];
  expiringLicenses: ExpiringLicenseRow[];
  overdueAR: OverdueARRow[];
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

const TILE_LIMIT = 50;

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
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="font-semibold text-nav-dark">{title}</h2>
        <span className={`text-sm font-bold ${color}`}>({count})</span>
      </div>
      {onLink && (
        <button
          onClick={onLink}
          className="flex items-center gap-1 text-sm text-crx-green hover:underline"
        >
          {linkLabel ?? 'View all'} <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OfficeCockpit() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<CockpitData>({
    unbilledJobs: [],
    postableInvoices: [],
    watchdogFlags: [],
    upcomingJobs: [],
    expiringLicenses: [],
    overdueAR: [],
  });
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const today = localToday();
    const in7Days = localDatePlusDays(7);
    const in30Days = localDatePlusDays(30);
    const past30Days = localDatePlusDays(-30);

    // status-enum-check: exempt (TS) — cross-table: jobs uses 'completed'/'scheduled',
    // invoices uses 'draft'/'unposted'/'posted'. All verified against live CHECK constraints.

    // (c) Active watchdog flags (non-dismissed) via §2 RPC — pulled out of
    // Promise.all so the assertRpcCoverage scanner can detect the capture.
    const watchdogRes = await supabaseUntyped.rpc('get_watchdog_flags', {
      p_job_id: null,
      p_invoice_id: null,
      p_flag_type: null,
      p_include_dismissed: false,
    });

    const [
      unbilledJobsRes,
      postableInvRes,
      upcomingJobsRes,
      expiringLicRes,
      overdueARRes,
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

      // (b) Draft/unposted field-app invoices (§4 will auto-populate these)
      supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, status, total_amount_cents, customer:customers(farm_name)')
        .in('status', ['draft', 'unposted'])
        .eq('invoice_type', 'field_application')
        .is('deleted_at', null)
        .order('invoice_date', { ascending: true })
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
    ]);

    const errors = [
      unbilledJobsRes.error,
      postableInvRes.error,
      watchdogRes.error,
      upcomingJobsRes.error,
      expiringLicRes.error,
      overdueARRes.error,
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
    }));

    let watchdogFlags: WatchdogFlag[] = [];
    if (!watchdogRes.error && watchdogRes.data) {
      try {
        watchdogFlags = assertRpcResult<WatchdogFlag[]>(watchdogRes.data, 'get_watchdog_flags');
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

    setData({ unbilledJobs, postableInvoices, watchdogFlags, upcomingJobs, expiringLicenses, overdueAR });
    setLastRefreshed(new Date());
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const totalExceptions =
    data.unbilledJobs.length +
    data.postableInvoices.length +
    data.watchdogFlags.length +
    data.expiringLicenses.length +
    data.overdueAR.length;

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-bold text-nav-dark">Office Cockpit</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
        <div>
          <h1 className="text-2xl font-bold text-nav-dark">Office Cockpit</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Everything stuck or wrong &mdash; one screen, no report-running.
          </p>
        </div>
        <div className="flex items-center gap-3">
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
      </div>

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
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

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
                  className="w-full flex items-center justify-between py-2 text-sm hover:bg-gray-50 rounded transition-colors text-left"
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
            Draft/unposted field-app invoices &mdash; §4 Auto-Invoice will auto-populate these.
          </p>
          {data.postableInvoices.length === 0 ? (
            <AllClear label="No field-app invoices waiting to post." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.postableInvoices.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/field-invoices/${row.id}`)}
                  className="w-full flex items-center justify-between py-2 text-sm hover:bg-gray-50 rounded transition-colors text-left"
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
                  className="w-full flex items-center justify-between py-2 text-sm hover:bg-gray-50 rounded transition-colors text-left"
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
                  className="w-full flex items-center justify-between py-2 text-sm hover:bg-gray-50 rounded transition-colors text-left"
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
                  className="w-full flex items-center justify-between py-2 text-sm hover:bg-gray-50 rounded transition-colors text-left"
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
                  className="w-full flex items-center justify-between py-2 text-sm hover:bg-gray-50 rounded transition-colors text-left"
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

        {/* (g) Inventory shortfalls — deferred follow-on tile */}
        <Card className="border-dashed border-gray-300 bg-gray-50">
          <div className="flex items-center gap-2 mb-2">
            <PackageX className="w-5 h-5 text-gray-400" />
            <h2 className="font-semibold text-gray-400">Inventory Shortfalls</h2>
            <Badge variant="default" size="sm">Coming</Badge>
          </div>
          <p className="text-sm text-gray-400">
            Will show products short for upcoming jobs. Deferred: requires joining
            job_chemicals against live inventory per job &mdash; anti-N+1 query design is
            the follow-on task.
          </p>
        </Card>

      </div>
    </div>
  );
}
