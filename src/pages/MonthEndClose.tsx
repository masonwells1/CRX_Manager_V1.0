/**
 * MonthEndClose — Month-end workflow page
 * Current period status, checklist, batch statement generation, "Roll the Month" button.
 *
 * Sprint 10: Month-End Close
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { Calendar, CheckCircle, AlertCircle, FileText, Download, Lock, RotateCcw } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { downloadBatchStatements } from '../lib/statementPdf';
import { downloadBatchYearEndSummaries } from '../lib/yearEndSummaryPdf';
import { formatCents as fmt } from '../lib/money';
import { todayInBusinessTz } from '../lib/dateUtils';
import StatementPrintDialog from '../components/statements/StatementPrintDialog';
import YearEndSummaryDialog from '../components/reports/YearEndSummaryDialog';
import type { DetailedStatementData, StatementOptions, YearEndSummaryData } from '../types';
import type { YearEndSummaryOptions } from '../lib/yearEndSummaryPdf';
import { getRecognizedInvoiceCustomerIds } from '../lib/recognizedInvoiceCustomers';

interface PeriodInfo {
  id?: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  closed_at?: string;
  closed_by?: string;
}

interface MonthlySummary {
  invoices: { posted_count: number; total_amount_cents: number; total_cost_cents: number; draft_count: number; voided_count: number };
  payments: { count: number; total_cents: number };
  orders: { count: number; total_cents: number };
  deliveries: { count: number; completed_count: number };
  applications: { count: number; total_acres: number };
  commissions: { earned_cents: number; paid_count: number };
  ar_balance_cents: number;
}


// A9: period for an arbitrary (year, month) so month-end can view/close ANY month,
// not just the current one. `month` is 0-indexed (JS Date convention).
function getPeriodForMonth(year: number, month: number): { start: string; end: string; label: string } {
  const start = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const end = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const label = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { start, end, label };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export default function MonthEndClose() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const { toast } = useToast();
  const closePeriodIdem = useIdempotencyKey('close_accounting_period', profile?.id || '');
  const generateStatementsIdem = useIdempotencyKey('generate_batch_statements', profile?.id || '');
  const reopenPeriodIdem = useIdempotencyKey('reopen_accounting_period', profile?.id || '');

  const [periods, setPeriods] = useState<PeriodInfo[]>([]);
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showReopenModal, setShowReopenModal] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<PeriodInfo | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);
  const [showStatementDialog, setShowStatementDialog] = useState(false);
  const [showYeDialog, setShowYeDialog] = useState(false);
  // M1/M2: explicit review confirmation for payments and commissions
  const [reviewedPayments, setReviewedPayments] = useState(false);
  const [reviewedCommissions, setReviewedCommissions] = useState(false);
  // Ship-now/price-later (#2 v3): unpriced rush orders are unbilled revenue.
  const [reviewedNeedsPricing, setReviewedNeedsPricing] = useState(false);
  const [needsPricingCount, setNeedsPricingCount] = useState(0);
  const [needsPricingError, setNeedsPricingError] = useState(false);
  const [yeLoading, setYeLoading] = useState(false);

  // A9: month/year picker — defaults to the current business-clock month.
  const [initialBusinessToday] = useState(() => todayInBusinessTz());
  const [selectedYear, setSelectedYear] = useState(() => Number(initialBusinessToday.slice(0, 4)));
  const [selectedMonth, setSelectedMonth] = useState(() => Number(initialBusinessToday.slice(5, 7)) - 1);
  const current = getPeriodForMonth(selectedYear, selectedMonth);
  const todayStr = todayInBusinessTz();
  const businessYear = Number(todayStr.slice(0, 4));
  // A9: a period may only be closed once it has ENDED (owner rule, 2026-07-10).
  // Compares the period's END (not its start) — the old `start > today` check let an
  // admin close the current, in-progress month.
  const periodHasEnded = current.end < todayStr;
  const closeableOn = new Date(selectedYear, selectedMonth + 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  // A9 (Codex P1): monotonic token to ignore stale in-flight fetch responses when the
  // admin switches period mid-load (a slower OLD-period response must not overwrite the
  // NEW period's state, or close would use another month's checklist).
  const fetchTokenRef = useRef(0);

  // A9 (Codex R4): change the selected period AND clear its period-scoped state in the SAME
  // synchronous update, so no render ever treats the prior period's checklist/summary as
  // valid for the newly selected month (closes the one-render-frame stale-state window).
  const changePeriod = (year: number, month: number) => {
    // A9 (Codex R5): invalidate any in-flight fetch for the OLD period SYNCHRONOUSLY, the
    // instant the period changes — otherwise a stale response resolving in the gap before
    // fetchData's own token bump could still set the old summary under the new period.
    fetchTokenRef.current++;
    setSelectedYear(year);
    setSelectedMonth(month);
    setLoading(true);       // show the spinner immediately — no flash of an empty checklist
    setSummary(null);
    setReviewedPayments(false);
    setReviewedCommissions(false);
    setReviewedNeedsPricing(false);
  };

  const fetchData = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    // A9 (Codex P1): reset the per-period review confirmations so a checkbox ticked for a
    // previously-viewed month never carries into the month being loaded now.
    setReviewedPayments(false);
    setReviewedCommissions(false);
    setReviewedNeedsPricing(false);

    // Fetch existing periods
    const { data: periodData, error: periodError } = await supabase
      .from('accounting_periods')
      .select('*')
      .order('period_end', { ascending: false })
      .limit(36);
    if (token !== fetchTokenRef.current) return;  // superseded by a newer period request
    if (periodError) {
      toast('error', 'Failed to load accounting periods');
    }
    setPeriods((periodData || []) as PeriodInfo[]);

    // Fetch monthly summary for current period
    const { data: summaryData, error } = await supabase.rpc('get_monthly_summary', {
      p_period_start: current.start,
      p_period_end: current.end,
    });
    if (token !== fetchTokenRef.current) return;  // superseded by a newer period request
    if (!error && summaryData) {
      setSummary(assertRpcResult<MonthlySummary>(summaryData, 'get_monthly_summary'));
    } else {
      // A9 (Codex P1): fail-closed — never leave the PRIOR period's summary driving the
      // checklist for the month now selected. No summary => allChecksPassed is false.
      setSummary(null);
      if (error) toast('error', 'Could not load the summary for this period — review before closing.');
    }

    // Ship-now/price-later (#2 v3): count unpriced rush orders dated on/before this
    // period's end — they're unbilled revenue and surface as a pre-close review item.
    const { count: npCount, error: npError } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('pricing_status', 'needs_pricing')
      .not('status', 'in', '("cancelled","voided")')  // Codex P2: terminal orders aren't unbilled revenue
      .is('deleted_at', null)
      .lte('order_date', current.end);
    if (token !== fetchTokenRef.current) return;  // superseded by a newer period request
    // Codex round-4 P1: FAIL CLOSED. If this query fails (permissions, connectivity,
    // migration/deploy mismatch), a `npCount || 0` would mark the checklist "no
    // unpriced orders" and let the period be closed over unbilled revenue. Surface
    // the error and flag it so the checklist item can only be satisfied by an
    // explicit manual review, never silently.
    if (npError) {
      setNeedsPricingError(true);
      toast('error', 'Could not verify unpriced rush orders — review manually before closing.');
    } else {
      setNeedsPricingError(false);
    }
    setNeedsPricingCount(npCount || 0);

    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.start, current.end]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // A9 (Codex P2): each selected period is a distinct close intent. Reset the close
  // idempotency key whenever the period changes, so a lost response after a successful
  // server-side close can't replay that prior result onto a different month.
  useEffect(() => {
    closePeriodIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.start, current.end]);

  const currentPeriodStatus = periods.find(
    (p) => p.period_start === current.start && p.period_end === current.end,
  );
  const isClosed = currentPeriodStatus?.status === 'closed';

  // Checklist items
  const checklist = summary
    ? [
        {
          label: 'All invoices posted or voided',
          done: summary.invoices.draft_count === 0,
          detail: summary.invoices.draft_count > 0
            ? `${summary.invoices.draft_count} unposted invoice(s) remain`
            : `${summary.invoices.posted_count} recognized, ${summary.invoices.voided_count} voided`,
        },
        {
          label: 'Payments reconciled',
          // M1: require explicit confirmation when payments exist (not trivially satisfied)
          done: summary.payments.count === 0 || reviewedPayments,
          detail: summary.payments.count === 0
            ? 'No payments this period'
            : `${summary.payments.count} payments totaling ${fmt(summary.payments.total_cents)} — verify and check box to confirm`,
          reviewKey: summary.payments.count > 0 ? 'payments' : undefined,
        },
        {
          label: 'Deliveries completed',
          done: summary.deliveries.count === summary.deliveries.completed_count || summary.deliveries.count === 0,
          detail: `${summary.deliveries.completed_count}/${summary.deliveries.count} deliveries completed`,
        },
        {
          label: 'Commissions reviewed',
          // M2: require explicit confirmation when commissions are earned (not trivially satisfied)
          done: summary.commissions.earned_cents === 0 || reviewedCommissions,
          detail: summary.commissions.earned_cents === 0
            ? 'No commissions this period'
            : `${fmt(summary.commissions.earned_cents)} earned, ${summary.commissions.paid_count} paid — verify and check box to confirm`,
          reviewKey: summary.commissions.earned_cents > 0 ? 'commissions' : undefined,
        },
        {
          label: 'Rush orders priced',
          // Codex round-4 P1: when the count query failed, the item is NOT done
          // unless an admin explicitly confirms — never auto-satisfied on a 0 that
          // really means "couldn't check".
          done: needsPricingError
            ? reviewedNeedsPricing
            : needsPricingCount === 0 || reviewedNeedsPricing,
          detail: needsPricingError
            ? 'Could not verify unpriced rush orders (query failed) — review manually and check the box to confirm'
            : needsPricingCount === 0
              ? 'No unpriced rush orders'
              : `${needsPricingCount} order(s) still need pricing (unbilled revenue) — price them or verify and check the box`,
          reviewKey: needsPricingError || needsPricingCount > 0 ? 'needs_pricing' : undefined,
        },
        {
          label: 'Finance charges generated (optional)',
          done: true,
          detail: 'Generate from AR Aging page if needed — this step is optional',
        },
      ]
    : [];

  // Fail-closed: never enable close without a loaded summary for THIS period
  // (an empty checklist otherwise makes .every() vacuously true — Codex P1).
  const allChecksPassed = summary !== null && checklist.every((c) => c.done);

  const handleClose = async () => {
    if (!profile) {
      toast('error', 'Cannot close period — profile not loaded. Please refresh.');
      return;
    }
    if (!periodHasEnded) {
      toast('error', 'Cannot close a period that has not ended yet.');
      return;
    }
    // A9 (Codex R4): self-guard so even a programmatic call can't close a period whose
    // checklist (for THIS selected period) isn't satisfied — not only the disabled button.
    if (!allChecksPassed) {
      toast('error', 'Complete the close checklist for this period before closing.');
      return;
    }
    setClosing(true);
    try {
      const closeKey = closePeriodIdem.getKey();
      const { data, error } = await supabase.rpc('close_accounting_period', {
        p_period_end: current.end,
        p_performed_by: profile.id,
        p_idempotency_key: closeKey,
      });
      if (error) throw error;
      assertRpcResult(data, 'close_accounting_period');
      closePeriodIdem.resetKey();
      logActivity({ event: 'close_accounting_period', description: `Closed accounting period: ${current.label}`, performedBy: profile.id });
      toast('success', `Period closed: ${current.label}`);
      setShowCloseModal(false);
      fetchData();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'close_accounting_period' } });
      toast('error', sanitizeError(err));
    }
    setClosing(false);
  };

  const handleReopen = async () => {
    if (!reopenTarget?.id) return;
    if (!profile) {
      toast('error', 'Cannot reopen period — profile not loaded. Please refresh.');
      return;
    }
    setReopening(true);
    try {
      const key = reopenPeriodIdem.getKey();
      const { data, error } = await supabase.rpc('reopen_accounting_period', {
        p_period_id: reopenTarget.id,
        p_reason: reopenReason,
        p_performed_by: profile.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult(data, 'reopen_accounting_period');
      reopenPeriodIdem.resetKey();
      logActivity({ event: 'reopen_accounting_period', description: `Reopened accounting period: ${reopenTarget.id}. Reason: ${reopenReason}`, performedBy: profile.id });
      toast('success', 'Accounting period reopened');
      setShowReopenModal(false);
      setReopenReason('');
      setReopenTarget(null);
      fetchData();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'reopen_accounting_period' } });
      toast('error', sanitizeError(err));
    }
    setReopening(false);
  };

  const handleGenerateStatements = async (options: StatementOptions) => {
    if (!profile) {
      toast('error', 'Cannot generate statements — profile not loaded. Please refresh.');
      return;
    }
    setShowStatementDialog(false);
    setGenerating(true);
    try {
      const stmtKey = generateStatementsIdem.getKey();
      const { data, error } = await supabase.rpc('generate_batch_statements', {
        p_as_of_date: options.as_of_date,
        p_performed_by: profile.id,
        p_mode: options.mode,
        p_idempotency_key: stmtKey,
      });
      if (error) throw error;

      const statements = assertRpcResult<DetailedStatementData[]>(data, 'generate_batch_statements');
      // assertRpcResult only rejects null/undefined, so the ARRAY check below is this
      // path's real validation of the reply — the key is retired after it, not before,
      // or a non-null non-array response would lose its replay key (Codex MEDIUM, F1).
      if (!statements || !Array.isArray(statements)) {
        // Ambiguous reply: the run may have committed server-side. KEEP the key so a
        // retry replays instead of generating a second batch.
        toast('error', 'generate_batch_statements returned an unexpected response — retry to reconcile it.');
        setGenerating(false);
        return;
      }
      generateStatementsIdem.resetKey();
      if (statements.length === 0) {
        toast('info', 'No customers have outstanding balances');
        setGenerating(false);
        return;
      }

      await downloadBatchStatements(statements, options);
      toast('success', `Generated ${statements.length} customer statement(s)`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'generate_batch_statements' } });
      toast('error', sanitizeError(err));
    }
    setGenerating(false);
  };

  const handleGenerateYearEnd = async (season: number, options: YearEndSummaryOptions) => {
    setYeLoading(true);
    try {
      // Page through every recognized invoice so the API row cap cannot
      // silently omit customers as the season grows.
      const uniqueIds = await getRecognizedInvoiceCustomerIds(season);
      if (uniqueIds.length === 0) {
        toast('info', `No customers have invoices for season ${season}`);
        setYeLoading(false);
        return;
      }

      toast('info', `Generating ${uniqueIds.length} year-end summary PDF(s)...`);

      // Batch RPC: single call replaces N individual calls
      const { data: batchResult, error: batchError } = await supabase.rpc('get_batch_year_end_summaries', {
        p_customer_ids: uniqueIds,
        p_season: season,
      });
      if (batchError) {
        toast('error', sanitizeError(batchError));
        setYeLoading(false);
        return;
      }
      const summaries = assertRpcResult<YearEndSummaryData[]>(batchResult, 'get_batch_year_end_summaries');
      await downloadBatchYearEndSummaries(summaries, options);
      toast('success', `Generated ${summaries.length} year-end summary PDF(s)`);
      setShowYeDialog(false);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'get_batch_year_end_summaries' } });
      toast('error', sanitizeError(err));
    }
    setYeLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Month-End Close"
        subtitle="Review and close accounting periods"
        actions={(
          <div className="flex gap-2 items-center">
          {/* A9 month/year picker — view/close any month. STRUCTURAL race guard (Codex R6):
              the selects are disabled while a fetch (loading) OR a close (closing) is in
              flight, so at most ONE is ever in play — no stale response / post-close refresh
              can land under a newly-selected period. This makes the whole period-switch race
              class impossible by construction; the reactive guards (token, fail-closed
              summary, per-period idempotency reset) are defense-in-depth backup. */}
          <select
            value={selectedMonth}
            onChange={(e) => changePeriod(selectedYear, Number(e.target.value))}
            disabled={loading || closing}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-crx-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Month to review"
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i}>{m}</option>
            ))}
          </select>
          <select
            value={selectedYear}
            onChange={(e) => changePeriod(Number(e.target.value), selectedMonth)}
            disabled={loading || closing}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-crx-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Year to review"
          >
            {Array.from({ length: 3 }, (_, k) => businessYear - 2 + k).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            onClick={() => setShowYeDialog(true)}
            loading={yeLoading}
          >
            Year-End Summaries
          </Button>
          <Button
            variant="secondary"
            icon={<FileText className="w-4 h-4" />}
            onClick={() => setShowStatementDialog(true)}
            loading={generating}
          >
            Generate Statements
          </Button>
          {!isClosed && (
            <Button
              icon={<Lock className="w-4 h-4" />}
              onClick={() => setShowCloseModal(true)}
              disabled={!allChecksPassed || !periodHasEnded}
            >
              Roll the Month
            </Button>
          )}
          </div>
        )}
      />

      {/* Current Period Status */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isClosed ? 'bg-crx-green-light' : 'bg-amber-50'}`}>
            <Calendar className={`w-5 h-5 ${isClosed ? 'text-crx-green' : 'text-amber-600'}`} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-nav-dark">{current.label}</h2>
            <p className="text-sm text-secondary">{current.start} to {current.end}</p>
          </div>
          <div className="ml-auto">
            <Badge variant={isClosed ? 'success' : 'warning'}>
              {isClosed ? 'Closed' : 'Open'}
            </Badge>
          </div>
        </div>

        {isClosed && currentPeriodStatus?.closed_at && (
          <p className="text-sm text-secondary">
            Closed on {new Date(currentPeriodStatus.closed_at).toLocaleString()}
          </p>
        )}
      </Card>

      {/* Summary + Checklist */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Period Summary */}
        {summary && (
          <Card>
            <h3 className="text-sm font-semibold text-nav-dark mb-4">Period Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Recognized Invoices</span>
                <span className="font-medium">{summary.invoices.posted_count} — {fmt(summary.invoices.total_amount_cents)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Cost of Goods</span>
                <span className="font-medium">{fmt(summary.invoices.total_cost_cents)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Gross Margin</span>
                <span className="font-medium text-crx-green">
                  {fmt(summary.invoices.total_amount_cents - summary.invoices.total_cost_cents)}
                </span>
              </div>
              <hr className="border-gray-100" />
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Payments Received</span>
                <span className="font-medium">{summary.payments.count} — {fmt(summary.payments.total_cents)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Orders</span>
                <span className="font-medium">{summary.orders.count} — {fmt(summary.orders.total_cents)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Deliveries</span>
                <span className="font-medium">{summary.deliveries.completed_count}/{summary.deliveries.count} completed</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Applications</span>
                <span className="font-medium">{summary.applications.count} — {summary.applications.total_acres?.toLocaleString() || 0} acres</span>
              </div>
              <hr className="border-gray-100" />
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Commissions Earned</span>
                <span className="font-medium">{fmt(summary.commissions.earned_cents)}</span>
              </div>
              <div className="flex justify-between text-sm font-semibold">
                <span>AR Balance</span>
                <span className={summary.ar_balance_cents > 0 ? 'text-red-600' : 'text-crx-green'}>
                  {fmt(summary.ar_balance_cents)}
                </span>
              </div>
            </div>
          </Card>
        )}

        {/* Checklist */}
        <Card>
          <h3 className="text-sm font-semibold text-nav-dark mb-4">Close Checklist</h3>
          <div className="space-y-3">
            {checklist.map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                {item.done ? (
                  <CheckCircle className="w-5 h-5 text-crx-green flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <p className={`text-sm font-medium ${item.done ? 'text-nav-dark' : 'text-amber-700'}`}>
                    {item.label}
                  </p>
                  <p className="text-xs text-secondary">{item.detail}</p>
                  {'reviewKey' in item && item.reviewKey && !item.done && (
                    <label className="mt-1.5 flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-crx-green"
                        checked={item.reviewKey === 'payments' ? reviewedPayments : item.reviewKey === 'commissions' ? reviewedCommissions : reviewedNeedsPricing}
                        onChange={(e) => {
                          if (item.reviewKey === 'payments') setReviewedPayments(e.target.checked);
                          else if (item.reviewKey === 'commissions') setReviewedCommissions(e.target.checked);
                          else setReviewedNeedsPricing(e.target.checked);
                        }}
                      />
                      <span className="text-xs text-nav-dark">I have reviewed this and confirm it is correct</span>
                    </label>
                  )}
                </div>
              </div>
            ))}

            {!allChecksPassed && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm text-amber-800">
                  Resolve all checklist items before closing the period.
                </p>
              </div>
            )}

            {!periodHasEnded && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm text-amber-800">
                  This month has not ended yet. It can be closed on {closeableOn}.
                </p>
              </div>
            )}

            {isClosed && (
              <div className="mt-4 p-3 bg-crx-green-light border border-crx-green/20 rounded-lg">
                <p className="text-sm text-crx-green font-medium">
                  This period has been closed. No new postings can be made to dates within this period.
                </p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Recent Period History */}
      {periods.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-nav-dark mb-4">Period History</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-secondary border-b border-gray-100">
                  <th className="pb-2 pr-4">Period</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Closed At</th>
                  {isAdmin && <th className="pb-2 w-24"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {periods.map((p) => (
                  <tr key={p.id || `${p.period_start}-${p.period_end}`}>
                    <td className="py-2 pr-4 font-medium text-nav-dark">
                      {new Date(p.period_start + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant={p.status === 'closed' ? 'success' : 'warning'}>
                        {p.status === 'closed' ? 'Closed' : 'Open'}
                      </Badge>
                    </td>
                    <td className="py-2 text-secondary">
                      {p.closed_at ? new Date(p.closed_at).toLocaleString() : '-'}
                    </td>
                    {isAdmin && (
                      <td className="py-2 text-right">
                        {p.status === 'closed' && p.id && (
                          <button
                            onClick={() => { setReopenTarget(p); setShowReopenModal(true); }}
                            className="flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 font-medium"
                          >
                            <RotateCcw className="w-3 h-3" />
                            Reopen
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Statement Print Dialog */}
      <StatementPrintDialog
        open={showStatementDialog}
        onClose={() => setShowStatementDialog(false)}
        onGenerate={handleGenerateStatements}
        loading={generating}
        defaultDate={current.end}
      />

      {/* Year-End Summary Dialog */}
      <YearEndSummaryDialog
        open={showYeDialog}
        onClose={() => setShowYeDialog(false)}
        onGenerate={handleGenerateYearEnd}
        loading={yeLoading}
        batchMode
      />

      {/* Reopen Period Modal (admin only) */}
      <Modal open={showReopenModal} onClose={() => { setShowReopenModal(false); setReopenReason(''); }} title="Reopen Accounting Period">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            You are about to reopen the accounting period for{' '}
            <strong>
              {reopenTarget && new Date(reopenTarget.period_start + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </strong>.
          </p>
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-800">
              Reopening allows new postings to dates within this period. This action is logged to the financial audit trail.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Reason <span className="text-red-500">*</span></label>
            <textarea
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="Explain why this period needs to be reopened..."
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crx-green"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => { setShowReopenModal(false); setReopenReason(''); }}>Cancel</Button>
            <Button
              variant="danger"
              onClick={handleReopen}
              loading={reopening}
              disabled={!reopenReason.trim()}
            >
              Reopen Period
            </Button>
          </div>
        </div>
      </Modal>

      {/* Close Confirmation Modal */}
      <Modal open={showCloseModal} onClose={() => setShowCloseModal(false)} title="Close Accounting Period">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            You are about to close the accounting period for <strong>{current.label}</strong>.
          </p>
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-800">
              After closing, no invoices can be posted or payments recorded for dates within this period.
              This action is not easily reversible.
            </p>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowCloseModal(false)}>Cancel</Button>
            <Button onClick={handleClose} loading={closing}>
              Close Period
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
