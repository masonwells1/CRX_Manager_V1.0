import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Tractor, ClipboardCheck, ArrowRight, CheckCircle2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { Sentry } from '../lib/sentry';
import { SkeletonCard } from '../components/ui/Skeleton';
import { formatCents as fmt } from '../lib/money';

// Phase 2 of the As-Applied / Field-Invoice build (read-only reconciliation).
// Surfaces the TWO reliable, actionable "applied but not yet billed" backlogs so
// nothing sprayed slips through unbilled:
//   1. Completed jobs with no invoice yet (jobs.status='completed', invoice_id NULL)
//   2. Approved blend tickets not yet billed (review_status='approved',
//      payment_status='unbilled')
//
// NOTE (Codex Phase-2 review): we deliberately do NOT add a third
// "application_records WHERE invoice_id IS NULL" section. application_records are
// DERIVED rows (source_type is only 'job' or 'blend_ticket'), so they would
// double-count the two backlogs above; worse, the blend-ticket billing rail
// updates blend_tickets.payment_status rather than reliably filling
// application_records.invoice_id, so billed/no-charge work could still show as
// "unbilled". The two source-of-truth backlogs above are the correct view.
//
// Job rows can be billed here through the same guarded RPC as JobDetail. Blend-ticket
// rows remain navigate-only because that billing path has a parked commission follow-up.
// (Lives under /field-invoices/* so it inherits the Field Invoices permission.)

const QUERY_LIMIT = 500;

interface UnbilledRow {
  id: string;
  ref: string;        // job_number / ticket_number
  date: string | null;
  acres: number | null;
  amount_cents: number | null;   // estimated bill value (jobs only; blend tickets aren't priced until billed)
  customer_name: string;
}

interface Section {
  key: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  rows: UnbilledRow[];
  refLabel: string;
  parentPath: string;   // where "View all" goes (the list)
  rowPath: (id: string) => string;   // where a row click goes (the specific record)
}

interface TransferJobInvoiceResult {
  invoice_id: string;
  invoice_number?: string;
  invoice_count?: number;
  split?: boolean;
}

interface JobInvoiceKeyControls {
  getKey: () => string;
  resetKey: () => void;
}

interface PendingJobInvoice extends JobInvoiceKeyControls {
  row: UnbilledRow;
}

type RawRow = Record<string, unknown> & { customer?: { farm_name?: string } | null };

function mapRows(data: RawRow[] | null, refKey: string, dateKey: string, amountKey?: string): UnbilledRow[] {
  return (data || []).map((r) => ({
    id: r.id as string,
    ref: (r[refKey] as string) || '—',
    date: (r[dateKey] as string | null) ?? null,
    acres: (r.total_acres as number | null) ?? null,
    amount_cents: amountKey ? ((r[amountKey] as number | null) ?? null) : null,
    customer_name: r.customer?.farm_name || 'Unknown',
  }));
}

function CreateJobInvoiceButton({
  row,
  profileId,
  disabled,
  onRequest,
  onRegister,
}: {
  row: UnbilledRow;
  profileId: string;
  disabled: boolean;
  onRequest: (intent: PendingJobInvoice) => void;
  onRegister: (jobId: string, controls: JobInvoiceKeyControls | null) => void;
}) {
  const { getKey, resetKey } = useIdempotencyKey('transfer_job_to_invoice', profileId);

  useEffect(() => {
    onRegister(row.id, { getKey, resetKey });
    return () => onRegister(row.id, null);
  }, [getKey, onRegister, resetKey, row.id]);

  return (
    <Button
      size="sm"
      showChevron={false}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onRequest({ row, getKey, resetKey });
      }}
    >
      Create Invoice
    </Button>
  );
}

export default function UnbilledApplications() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<UnbilledRow[]>([]);
  const [tickets, setTickets] = useState<UnbilledRow[]>([]);
  const [pendingJobInvoice, setPendingJobInvoice] = useState<PendingJobInvoice | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [lastCreatedMessage, setLastCreatedMessage] = useState<string | null>(null);
  const [billNextReady, setBillNextReady] = useState(false);
  const jobInvoiceKeysRef = useRef<Map<string, JobInvoiceKeyControls>>(new Map());

  const registerJobInvoiceKeys = useCallback((jobId: string, controls: JobInvoiceKeyControls | null) => {
    if (controls) {
      jobInvoiceKeysRef.current.set(jobId, controls);
    } else {
      jobInvoiceKeysRef.current.delete(jobId);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);

    const [jobsRes, ticketsRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('id, job_number, job_date, total_acres, total_price_cents, customer:customers(farm_name)')
        .eq('status', 'completed')
        .is('invoice_id', null)
        .is('deleted_at', null)
        .order('job_date', { ascending: true })
        .limit(QUERY_LIMIT),
      supabase
        .from('blend_tickets')
        .select('id, ticket_number, ticket_date, total_acres, customer:customers(farm_name)')
        .eq('review_status', 'approved')
        .eq('payment_status', 'unbilled')
        .is('deleted_at', null)
        .order('ticket_date', { ascending: true })
        .limit(QUERY_LIMIT),
    ]);

    const firstError = jobsRes.error || ticketsRes.error;
    if (firstError) {
      Sentry.captureException(firstError, { tags: { source: 'fetch', page: 'unbilled-applications' } });
      toast('error', 'Failed to load unbilled applications');
      setLoading(false);
      return;
    }

    setJobs(mapRows(jobsRes.data as RawRow[], 'job_number', 'job_date', 'total_price_cents'));
    setTickets(mapRows(ticketsRes.data as RawRow[], 'ticket_number', 'ticket_date'));
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleCreateInvoice = async () => {
    if (!profile || !pendingJobInvoice) return;
    setCreatingInvoice(true);

    try {
      const { data, error } = await supabase.rpc('transfer_job_to_invoice', {
        p_job_id: pendingJobInvoice.row.id,
        p_performed_by: profile.id,
        p_idempotency_key: pendingJobInvoice.getKey(),
      });
      if (error) throw error;

      const result = assertRpcResult<TransferJobInvoiceResult>(data, 'transfer_job_to_invoice');
      pendingJobInvoice.resetKey();

      const remainingJobs = jobs.filter((job) => job.id !== pendingJobInvoice.row.id);
      const successMessage = result.invoice_number
        ? `Invoice ${result.invoice_number} created`
        : result.split && (result.invoice_count ?? 0) > 1
          ? `${result.invoice_count} split invoices created`
          : 'Invoice created';

      setJobs(remainingJobs);
      setPendingJobInvoice(null);
      setLastCreatedMessage(successMessage);
      setBillNextReady(remainingJobs.length > 0);
      toast('success', successMessage);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: 'transfer_job_to_invoice', jobId: pendingJobInvoice.row.id },
      });
      toast('error', sanitizeError(err));
    } finally {
      setCreatingInvoice(false);
    }
  };

  const handleBillNext = () => {
    const nextJob = jobs[0];
    if (!nextJob) {
      setBillNextReady(false);
      return;
    }

    const keyControls = jobInvoiceKeysRef.current.get(nextJob.id);
    if (!keyControls) {
      toast('error', 'The next job is still loading. Please try again.');
      return;
    }

    setPendingJobInvoice({ row: nextJob, ...keyControls });
  };

  const sections: Section[] = [
    {
      key: 'jobs',
      title: 'Completed jobs — not billed',
      subtitle: 'Spray jobs finished but no field invoice created yet',
      icon: <Tractor className="w-5 h-5 text-crx-green" />,
      rows: jobs,
      refLabel: 'Job #',
      parentPath: '/jobs',
      rowPath: (id: string) => `/jobs/${id}`,
    },
    {
      key: 'tickets',
      title: 'Approved blend tickets — not billed',
      subtitle: 'Approved tickets still marked unbilled',
      icon: <ClipboardCheck className="w-5 h-5 text-crx-green" />,
      rows: tickets,
      refLabel: 'Ticket #',
      parentPath: '/blend-tickets',
      rowPath: (id: string) => `/blend-tickets/${id}`,
    },
  ];

  const totalUnbilled = jobs.length + tickets.length;

  const daysWaiting = (d: string | null): string => {
    if (!d) return '—';
    const days = Math.floor((Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000);
    return days <= 0 ? 'today' : `${days}d`;
  };

  const fmtDate = (d: string | null) =>
    d ? new Date(d + 'T00:00:00').toLocaleDateString() : '—';

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Unbilled Applications</h2>
          <p className="text-xs text-secondary mt-0.5">
            Applied work that has not been turned into a field invoice yet — {totalUnbilled} item(s) across 2 billing backlogs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate('/field-invoices')}>
            Field Invoices
          </Button>
          <Button variant="secondary" size="sm" icon={<RefreshCw className="w-4 h-4" />} onClick={fetchAll}>
            Refresh
          </Button>
        </div>
      </div>

      {lastCreatedMessage && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-800">
            <CheckCircle2 className="w-5 h-5 text-crx-green flex-shrink-0" />
            <span>{lastCreatedMessage}</span>
          </div>
          {billNextReady && jobs.length > 0 && (
            <Button size="sm" showChevron={false} onClick={handleBillNext}>
              Bill next ({jobs.length} left)
            </Button>
          )}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sections.map((s) => (
          <Card key={`card-${s.key}`}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">{s.icon}</div>
              <span className="text-sm text-secondary">{s.title}</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{s.rows.length}</p>
          </Card>
        ))}
      </div>

      {/* Sections */}
      {sections.map((s) => (
        <Card key={`section-${s.key}`} padding={false}>
          <div className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-nav-dark">{s.title}</h3>
                <p className="text-xs text-secondary">{s.subtitle}</p>
              </div>
              <button
                onClick={() => navigate(s.parentPath)}
                className="text-xs text-crx-green hover:underline flex items-center gap-1"
              >
                View all <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {s.rows.length === 0 ? (
              <p className="text-sm text-secondary py-6 text-center">Nothing unbilled here — all caught up.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-secondary border-b border-gray-100">
                      <th className="py-2 pr-4 font-medium">{s.refLabel}</th>
                      <th className="py-2 pr-4 font-medium">Customer</th>
                      <th className="py-2 pr-4 font-medium">Date</th>
                      <th className="py-2 pr-4 font-medium text-right">Acres</th>
                      <th className="py-2 pr-4 font-medium text-right">Est. $</th>
                      <th className="py-2 pr-4 font-medium text-right">Waiting</th>
                      {s.key === 'jobs' && profile && (
                        <th className="py-2 font-medium text-right">Action</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {s.rows.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => navigate(s.rowPath(row.id))}
                        className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                      >
                        <td className="py-2 pr-4 font-medium text-nav-dark">{row.ref}</td>
                        <td className="py-2 pr-4">{row.customer_name}</td>
                        <td className="py-2 pr-4">{fmtDate(row.date)}</td>
                        <td className="py-2 pr-4 text-right">{row.acres != null ? row.acres : '—'}</td>
                        <td className="py-2 pr-4 text-right">{row.amount_cents != null ? fmt(row.amount_cents) : '—'}</td>
                        <td className="py-2 pr-4 text-right text-secondary">{daysWaiting(row.date)}</td>
                        {s.key === 'jobs' && profile && (
                          <td className="py-2 text-right">
                            <CreateJobInvoiceButton
                              row={row}
                              profileId={profile.id}
                              disabled={creatingInvoice}
                              onRequest={setPendingJobInvoice}
                              onRegister={registerJobInvoiceKeys}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {s.rows.length === QUERY_LIMIT && (
                  <p className="text-xs text-secondary mt-2">
                    Showing the first {QUERY_LIMIT} — open “View all” for the full list.
                  </p>
                )}
              </div>
            )}
          </div>
        </Card>
      ))}

      <ConfirmModal
        open={pendingJobInvoice !== null}
        onClose={() => {
          if (!creatingInvoice) setPendingJobInvoice(null);
        }}
        onConfirm={() => { void handleCreateInvoice(); }}
        title="Create Invoice"
        message={pendingJobInvoice
          ? `Create the invoice for job ${pendingJobInvoice.row.ref}? This bills the job's chemicals + application fee.`
          : ''}
        confirmLabel="Create Invoice"
        variant="info"
        loading={creatingInvoice}
      />
    </div>
  );
}
