/**
 * MonthEndClose — Month-end workflow page
 * Current period status, checklist, batch statement generation, "Roll the Month" button.
 *
 * Sprint 10: Month-End Close
 */
import { useEffect, useState, useCallback } from 'react';
import { Calendar, CheckCircle, AlertCircle, FileText, Download, Lock, RotateCcw } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { downloadBatchStatements } from '../lib/statementPdf';
import { downloadBatchYearEndSummaries } from '../lib/yearEndSummaryPdf';
import StatementPrintDialog from '../components/statements/StatementPrintDialog';
import YearEndSummaryDialog from '../components/reports/YearEndSummaryDialog';
import type { DetailedStatementData, StatementOptions, YearEndSummaryData } from '../types';
import type { YearEndSummaryOptions } from '../lib/yearEndSummaryPdf';

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

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function getCurrentPeriod(): { start: string; end: string; label: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const start = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const end = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const label = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { start, end, label };
}

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
  const [yeLoading, setYeLoading] = useState(false);

  const current = getCurrentPeriod();

  const fetchData = useCallback(async () => {
    setLoading(true);

    // Fetch existing periods
    const { data: periodData, error: periodError } = await supabase
      .from('accounting_periods')
      .select('*')
      .order('period_end', { ascending: false })
      .limit(12);
    if (periodError) {
      toast('error', 'Failed to load accounting periods');
    }
    setPeriods((periodData || []) as PeriodInfo[]);

    // Fetch monthly summary for current period
    const { data: summaryData, error } = await supabase.rpc('get_monthly_summary', {
      p_period_start: current.start,
      p_period_end: current.end,
    });
    if (!error && summaryData) {
      setSummary(assertRpcResult<MonthlySummary>(summaryData, 'get_monthly_summary'));
    }

    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.start, current.end]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
            : `${summary.invoices.posted_count} posted, ${summary.invoices.voided_count} voided`,
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
          label: 'Finance charges generated (optional)',
          done: true,
          detail: 'Generate from AR Aging page if needed — this step is optional',
        },
      ]
    : [];

  const allChecksPassed = checklist.every((c) => c.done);

  const handleClose = async () => {
    setClosing(true);
    try {
      const closeKey = closePeriodIdem.getKey();
      const { error } = await supabase.rpc('close_accounting_period', {
        p_period_end: current.end,
        p_performed_by: profile?.id,
        p_idempotency_key: closeKey,
      });
      if (error) throw error;
      closePeriodIdem.resetKey();
      logActivity({ event: 'close_accounting_period', description: `Closed accounting period: ${current.label}`, performedBy: profile?.id || '' });
      toast('success', `Period closed: ${current.label}`);
      setShowCloseModal(false);
      fetchData();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setClosing(false);
  };

  const handleReopen = async () => {
    if (!reopenTarget?.id) return;
    setReopening(true);
    try {
      const key = reopenPeriodIdem.getKey();
      const { error } = await supabase.rpc('reopen_accounting_period', {
        p_period_id: reopenTarget.id,
        p_reason: reopenReason,
        p_performed_by: profile?.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      reopenPeriodIdem.resetKey();
      logActivity({ event: 'reopen_accounting_period', description: `Reopened accounting period: ${reopenTarget.id}. Reason: ${reopenReason}`, performedBy: profile?.id || '' });
      toast('success', 'Accounting period reopened');
      setShowReopenModal(false);
      setReopenReason('');
      setReopenTarget(null);
      fetchData();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setReopening(false);
  };

  const handleGenerateStatements = async (options: StatementOptions) => {
    setShowStatementDialog(false);
    setGenerating(true);
    try {
      const stmtKey = generateStatementsIdem.getKey();
      const { data, error } = await supabase.rpc('generate_batch_statements', {
        p_as_of_date: options.as_of_date,
        p_performed_by: profile?.id,
        p_mode: options.mode,
        p_idempotency_key: stmtKey,
      });
      if (error) throw error;

      generateStatementsIdem.resetKey();
      const statements = assertRpcResult<DetailedStatementData[]>(data, 'generate_batch_statements');
      if (!statements || !Array.isArray(statements) || statements.length === 0) {
        toast('info', 'No customers have outstanding balances');
        setGenerating(false);
        return;
      }

      await downloadBatchStatements(statements, options);
      toast('success', `Generated ${statements.length} customer statement(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setGenerating(false);
  };

  const handleGenerateYearEnd = async (season: number, options: YearEndSummaryOptions) => {
    setYeLoading(true);
    try {
      // Get all customers with invoices for this season
      const { data: custIds, error: custErr } = await supabase
        .from('invoices')
        .select('customer_id')
        .eq('season', season)
        .in('status', ['posted', 'voided'])
        .is('deleted_at', null);
      if (custErr) throw custErr;

      const uniqueIds = [...new Set((custIds || []).map((r) => r.customer_id))];
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
        toast('error', 'Failed to generate year-end summaries: ' + batchError.message);
        setYeLoading(false);
        return;
      }
      const summaries = assertRpcResult<YearEndSummaryData[]>(batchResult, 'get_batch_year_end_summaries');
      await downloadBatchYearEndSummaries(summaries, options);
      toast('success', `Generated ${summaries.length} year-end summary PDF(s)`);
      setShowYeDialog(false);
    } catch (err: unknown) {
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Month-End Close</h2>
          <p className="text-sm text-secondary mt-1">Review and close accounting periods</p>
        </div>
        <div className="flex gap-2">
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
              disabled={!allChecksPassed}
            >
              Roll the Month
            </Button>
          )}
        </div>
      </div>

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
                <span className="text-secondary">Posted Invoices</span>
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
                        checked={item.reviewKey === 'payments' ? reviewedPayments : reviewedCommissions}
                        onChange={(e) => {
                          if (item.reviewKey === 'payments') setReviewedPayments(e.target.checked);
                          else setReviewedCommissions(e.target.checked);
                        }}
                      />
                      <span className="text-xs text-nav-dark">I have verified these {item.reviewKey} and they are correct</span>
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
