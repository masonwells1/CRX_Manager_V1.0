import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Check, Ban, Download, ClipboardCheck, Printer, FileClock, Mail, Layers, MoreHorizontal } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import DataTable, { type Column } from '../ui/DataTable';
import { useToast } from '../ui/Toast';
import { supabase, sanitizeError } from '../../lib/db';
import { assertInvoiceSendable } from '../../lib/invoiceSendDisposition';
import { Sentry } from '../../lib/sentry';
import { runCriticalAction } from '../../lib/criticalAction';
import { exportToCSV } from '../../lib/csvExport';
import { downloadReportPdf } from '../../lib/reportPdf';
import { buildInvoicePdfDataFromRow, generateBatchInvoicePdf, downloadInvoicePdf, generateInvoicePdf } from '../../lib/invoicePdf';
import { sendEmail, pdfToBase64, buildInvoiceEmailPayload, isInvoiceEmailSuppressed } from '../../lib/emailService';
import { logActivity } from '../../lib/activityLogger';
import { useAuth } from '../../contexts/AuthContext';
import {
  JOBS_LIST_KEY,
  defaultJobListSettings,
  mergeJobListSettings,
  isInvoiceColumnVisible,
  type JobListSettings,
} from '../jobs/jobListColumns';
import type { Invoice, InvoiceStatus } from '../../types';
import { formatCents as fmt } from '../../lib/money';
import { SkeletonTable, SkeletonCard } from '../ui/Skeleton';
import MobileCardList from '../ui/MobileCardList';
import { getSeasonDates } from '../../utils/season';

// Field / Application invoices are the SECOND, segregated sale type (the work CRX
// applies with its own sprayer), kept separate from Chemical Sales per Mason's
// "Chem Man segregates the two" requirement (2026-06-18). This page lists ONLY
// invoice_type = 'field_application'. It is intentionally additive and does NOT
// touch the Chemical Sales Invoices page (src/pages/Invoices.tsx). Posting,
// voiding, editing and printing happen on the shared invoice detail screen
// (/invoices/:id) — batch actions on this list are a deliberate follow-up.

type FieldInvoiceRow = Invoice & { customer_name: string };

const STATUS_OPTIONS: { value: InvoiceStatus | ''; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'unposted', label: 'Unposted' },
  { value: 'posted', label: 'Posted' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'voided', label: 'Voided' },
  { value: 'cancelled', label: 'Cancelled' },
];

const statusBadge = (status: InvoiceStatus) => {
  const map: Record<InvoiceStatus, { variant: 'default' | 'warning' | 'success' | 'error' | 'info'; label: string }> = {
    draft: { variant: 'default', label: 'Draft' },
    unposted: { variant: 'warning', label: 'Unposted' },
    posted: { variant: 'success', label: 'Posted' },
    paid: { variant: 'info', label: 'Paid' },
    overdue: { variant: 'error', label: 'Overdue' },
    voided: { variant: 'error', label: 'Voided' },
    cancelled: { variant: 'default', label: 'Cancelled' },
  };
  const s = map[status] || { variant: 'default' as const, label: status };
  return <Badge variant={s.variant}>{s.label}</Badge>;
};

const invoicePath = (row: FieldInvoiceRow): string =>
  !row.job_id && !row.blend_ticket_id && (row.status === 'draft' || row.status === 'unposted')
    ? `/invoices/field-app/${row.id}`
    : `/field-invoices/${row.id}`;

export default function FieldInvoicesListPanel() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [invoices, setInvoices] = useState<FieldInvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [cardFilter, setCardFilter] = useState<'unposted' | 'posted' | 'outstanding' | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [manualInvoiceMenuOpen, setManualInvoiceMenuOpen] = useState(false);
  // Per-row action guard so a double-click can't fire two prints/emails.
  const rowActionRef = useRef(false);
  const manualInvoiceMenuRef = useRef<HTMLDivElement>(null);
  // Field-app parity #8: the SHARED column toggles (Customers / Applicators /
  // Total Acres) are governed by the same per-user list settings as the job
  // list, so the choice carries over to this list (acceptance criterion #5).
  const [listSettings, setListSettings] = useState<JobListSettings>(defaultJobListSettings);

  useEffect(() => {
    if (!profile?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('user_list_settings')
        .select('settings')
        .eq('user_id', profile.id)
        .eq('list_key', JOBS_LIST_KEY)
        .maybeSingle();
      if (error) {
        Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-invoices', action: 'load_list_settings' } });
      }
      if (!cancelled) setListSettings(mergeJobListSettings(data?.settings));
    })();
    return () => { cancelled = true; };
  }, [profile?.id]);

  useEffect(() => {
    if (!manualInvoiceMenuOpen) return;

    const closeMenuOnOutsideClick = (event: MouseEvent) => {
      if (!manualInvoiceMenuRef.current?.contains(event.target as Node)) {
        setManualInvoiceMenuOpen(false);
      }
    };
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setManualInvoiceMenuOpen(false);
    };

    document.addEventListener('mousedown', closeMenuOnOutsideClick);
    document.addEventListener('keydown', closeMenuOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenuOnOutsideClick);
      document.removeEventListener('keydown', closeMenuOnEscape);
    };
  }, [manualInvoiceMenuOpen]);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    const { start: seasonStart, end: seasonEnd } = getSeasonDates();
    const QUERY_LIMIT = 2000;
    const { data, error } = await supabase
      .from('invoices')
      .select('*, customer:customers!invoices_customer_id_fkey(farm_name)')
      .eq('invoice_type', 'field_application')
      .is('deleted_at', null)
      .gte('created_at', seasonStart)
      .lte('created_at', seasonEnd + 'T23:59:59')
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMIT);

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-invoices' } });
      toast('error', 'Failed to load field invoices');
      setLoading(false);
      return;
    }

    if (data && data.length === QUERY_LIMIT) {
      toast('error', `Showing first ${QUERY_LIMIT} field invoices — some may be hidden. Contact admin if you need the full list.`);
    }

    const rows = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name: string } }>).map((inv) => ({
      ...inv,
      customer_name: inv.customer?.farm_name || 'Unknown',
    })) as unknown as FieldInvoiceRow[];
    setInvoices(rows);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  const filtered = invoices.filter((inv) => {
    if (statusFilter && inv.status !== statusFilter) return false;
    if (cardFilter === 'unposted' && !(inv.status === 'draft' || inv.status === 'unposted')) return false;
    if (cardFilter === 'posted' && !(inv.status === 'posted' || inv.status === 'overdue')) return false;
    if (cardFilter === 'outstanding' && !((inv.status === 'posted' || inv.status === 'overdue') && inv.balance_cents > 0)) return false;
    return true;
  });

  // Summary stats (scoped to field invoices only).
  // "Posted-like" = posted OR overdue: mark_overdue_invoices flips a posted
  // invoice to overdue as it ages, but both remain posted receivables — CRX
  // treats them the same for AR, so they count toward Posted Total + Outstanding.
  const isPostedLike = (s: string) => s === 'posted' || s === 'overdue';
  const unpostedCount = invoices.filter((i) => i.status === 'draft' || i.status === 'unposted').length;
  const postedCount = invoices.filter((i) => isPostedLike(i.status)).length;
  const postedTotal = invoices
    .filter((i) => isPostedLike(i.status))
    .reduce((s, i) => s + i.total_amount_cents, 0);
  const outstandingBalance = invoices
    .filter((i) => isPostedLike(i.status) && i.balance_cents > 0)
    .reduce((s, i) => s + i.balance_cents, 0);

  const handleExportPDF = async () => {
    setExportingPdf(true);
    try {
      await downloadReportPdf({
        title: 'Field / Application Invoices',
        subtitle: `${filtered.length} invoice(s)`,
        columns: [
          { header: 'Invoice #', key: 'invoice_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Applicator', key: 'applicator_name', format: (v) => String(v || '-') },
          { header: 'Acres', key: 'total_acres', align: 'right', format: (v) => (v != null ? String(v) : '-') },
          { header: 'Date', key: 'invoice_date', format: (v) => (v ? new Date(String(v)).toLocaleDateString() : '-') },
          { header: 'Total', key: 'total_amount_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
          { header: 'Balance', key: 'balance_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
          { header: 'Status', key: 'status' },
        ],
        data: filtered as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${filtered.length} field invoice(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExportingPdf(false);
  };

  // #30: map a combined-list row into the snapshot shape buildInvoicePdfDataFromRow
  // expects. The builder re-fetches line items / shares / customer billing by id;
  // we carry the money fields so a posted invoice WITH payments prints a Balance
  // Due that reconciles with its Total (Total − Payments − Prepay = Balance).
  const toPdfRow = (row: FieldInvoiceRow) => ({
    id: row.id,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    invoice_type: 'field_application',
    status: row.status,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    // salesman_name intentionally omitted — the list row has no resolved
    // salesman name (only salesman_id), and the builder doesn't fetch it. Do
    // NOT map applicator_name here (that's the applicator, not the salesman).
    crop_type: row.crop_type ?? null,
    field_names: row.field_names ?? null,
    total_acres: row.total_acres ?? null,
    applicator_name: row.applicator_name ?? null,
    total_amount_cents: row.total_amount_cents,
    total_cost_cents: row.total_cost_cents ?? 0,
    paid_amount_cents: row.paid_amount_cents ?? 0,
    prepay_applied_cents: row.prepay_applied_cents ?? 0,
    write_off_cents: row.write_off_cents ?? 0,
    balance_cents: row.balance_cents,
  });

  // #30: per-row Print / Old Print on the combined field-invoice list.
  const printRow = async (row: FieldInvoiceRow, format: 'current' | 'legacy') => {
    if (rowActionRef.current) return;
    rowActionRef.current = true;
    await runCriticalAction({
      action: async () => {
        const pdfData = await buildInvoicePdfDataFromRow(toPdfRow(row), {
          show_shares: true, show_price_per_acre: true, show_epa_registration: true, format,
        });
        await downloadInvoicePdf(pdfData);
      },
      toast,
      successMessage: `Printed ${row.invoice_number}`,
      setLoading: (v) => { setPrinting(v); if (!v) rowActionRef.current = false; },
      sentryTag: format === 'legacy' ? 'field_invoice_combined_old_print_row' : 'field_invoice_combined_print_row',
    });
    rowActionRef.current = false;
  };

  // #31: per-row EMAIL — send the field invoice (current-format PDF attached) to
  // the customer's billing email. Recipient is resolved from the invoice's OWN
  // customer (re-fetched by row.customer_id so we never trust a stale list field),
  // and a missing email gives an honest error instead of a blank/wrong send. The
  // send is idempotent (per invoice + timestamp) and logged via invoice_emailed.
  // Mirrors the Unposted/Posted list emailRow handlers exactly.
  const emailRow = async (row: FieldInvoiceRow) => {
    if (rowActionRef.current) return;
    if (!profile) { toast('error', 'Profile not loaded — please refresh.'); return; }
    if (isInvoiceEmailSuppressed(row)) {
      toast('info', 'This $0 invoice is recorded and shown in the account summary, but is not emailed.');
      return;
    }
    rowActionRef.current = true;
    await runCriticalAction({
      action: async () => {
        const { data: cust } = await supabase
          .from('customers')
          .select('email')
          .eq('id', row.customer_id)
          .maybeSingle();
        const email = (cust as { email?: string | null } | null)?.email;

        const pdfData = await buildInvoicePdfDataFromRow(toPdfRow(row));
        const doc = await generateInvoicePdf(pdfData);
        const base64 = pdfToBase64(doc);

        // buildInvoiceEmailPayload throws the honest "no email on file" error
        // before any send, so a missing email never results in a blank/wrong send.
        const payload = buildInvoiceEmailPayload({
          customerEmail: email,
          customerId: row.customer_id,
          invoiceId: row.id,
          invoiceNumber: row.invoice_number,
          invoiceDate: row.invoice_date,
          balanceCents: row.balance_cents,
          attachmentBase64: base64,
        });
        await assertInvoiceSendable(row.id);
        const result = await sendEmail(payload);
        if (!result.success) throw new Error(result.error || 'Email failed to send');

        logActivity({
          event: 'invoice_emailed',
          description: `Field invoice ${row.invoice_number} emailed to ${payload.to}`,
          performedBy: profile.id,
          entityType: 'invoice',
          entityId: row.id,
          customerId: row.customer_id,
        });
      },
      toast,
      successMessage: `Emailed ${row.invoice_number}`,
      setLoading: (v) => { setEmailing(v); if (!v) rowActionRef.current = false; },
      sentryTag: 'field_invoice_combined_email_row',
    });
    rowActionRef.current = false;
  };

  // #30: bulk Print All / Old Print All over the filtered list (one PDF each).
  const printAll = async (format: 'current' | 'legacy') => {
    if (filtered.length === 0) { toast('error', 'No invoices to print'); return; }
    await runCriticalAction({
      action: async () => {
        const list = await Promise.all(
          filtered.map((row) => buildInvoicePdfDataFromRow(toPdfRow(row), {
            show_shares: true, show_price_per_acre: true, show_epa_registration: true, format,
          }))
        );
        await generateBatchInvoicePdf(list);
      },
      toast,
      successMessage: `Printed ${filtered.length} invoice(s)`,
      setLoading: setPrinting,
      sentryTag: format === 'legacy' ? 'field_invoice_combined_old_print_all' : 'field_invoice_combined_print_all',
    });
  };

  const columns: Column<FieldInvoiceRow>[] = [
    {
      key: 'invoice_number',
      header: 'Invoice #',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-crx-green flex-shrink-0" />
          <span className="font-medium text-nav-dark">{row.invoice_number}</span>
        </div>
      ),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/customers/${row.customer_id}`);
          }}
          className="text-crx-green hover:underline"
        >
          {row.customer_name}
        </button>
      ),
    },
    {
      key: 'applicator_name',
      header: 'Applicator',
      sortable: true,
      render: (row) => row.applicator_name || '-',
    },
    {
      key: 'total_acres',
      header: 'Acres',
      sortable: true,
      render: (row) => (row.total_acres != null ? row.total_acres : '-'),
    },
    {
      key: 'invoice_date',
      header: 'Date',
      sortable: true,
      render: (row) => new Date(row.invoice_date + 'T00:00:00').toLocaleDateString(),
    },
    {
      key: 'total_amount_cents',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-medium">{fmt(row.total_amount_cents)}</span>,
    },
    {
      key: 'balance_cents',
      header: 'Balance',
      sortable: true,
      render: (row) => (
        <span className={row.balance_cents > 0 ? 'text-red-600 font-semibold' : 'text-crx-green'}>
          {fmt(row.balance_cents)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => statusBadge(row.status),
    },
    {
      key: 'id',
      header: 'Actions',
      render: (row) => (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void printRow(row, 'current'); }}
            disabled={printing}
            className="p-1.5 rounded hover:bg-gray-100 text-secondary disabled:opacity-40"
            aria-label={`Print ${row.invoice_number}`}
            title="Print (current format)"
          >
            <Printer className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void printRow(row, 'legacy'); }}
            disabled={printing}
            className="p-1.5 rounded hover:bg-gray-100 text-secondary disabled:opacity-40"
            aria-label={`Old Print ${row.invoice_number}`}
            title="Old Print (legacy format)"
          >
            <FileClock className="w-4 h-4" />
          </button>
          {/* #31: Email this invoice to the customer (current-format PDF attached). */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void emailRow(row); }}
            disabled={emailing}
            className="p-1.5 rounded hover:bg-gray-100 text-secondary disabled:opacity-40"
            aria-label={`Email ${row.invoice_number}`}
            title="Email to customer"
          >
            <Mail className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {/* Header */}
      <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Field Invoices</h2>
          <p className="text-xs text-secondary mt-0.5">Application sales — work applied with CRX equipment. Separate from Chemical Sales.</p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              exportToCSV(
                filtered as unknown as Record<string, unknown>[],
                [
                  { key: 'invoice_number', header: 'Invoice #' },
                  { key: 'customer_name', header: 'Customer' },
                  { key: 'applicator_name', header: 'Applicator' },
                  { key: 'total_acres', header: 'Acres' },
                  { key: 'invoice_date', header: 'Date' },
                  { key: 'total_amount_cents', header: 'Total ($)', format: (v: unknown) => ((Number(v) || 0) / 100).toFixed(2) },
                  { key: 'balance_cents', header: 'Balance ($)', format: (v: unknown) => ((Number(v) || 0) / 100).toFixed(2) },
                  { key: 'status', header: 'Status' },
                ],
                'field-invoices'
              )
            }
          >
            Export CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
            onClick={handleExportPDF}
            loading={exportingPdf}
          >
            Download PDF
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Printer className="w-4 h-4" />}
            onClick={() => printAll('current')}
            loading={printing}
            disabled={printing || filtered.length === 0}
          >
            Print All
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileClock className="w-4 h-4" />}
            onClick={() => printAll('legacy')}
            loading={printing}
            disabled={printing || filtered.length === 0}
          >
            Old Print All
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="w-4 h-4" />}
            onClick={() => navigate('/field-invoices/unposted')}
          >
            Unposted List
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Check className="w-4 h-4" />}
            onClick={() => navigate('/field-invoices/posted')}
          >
            Posted List
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<ClipboardCheck className="w-4 h-4" />}
            onClick={() => navigate('/field-invoices/unbilled')}
          >
            Unbilled
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Layers className="w-4 h-4" />}
            onClick={() => navigate('/field-invoices/summary')}
          >
            Customer Summary
          </Button>
          <div
            className="relative"
            ref={manualInvoiceMenuRef}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setManualInvoiceMenuOpen(false);
              }
            }}
          >
            <button
              type="button"
              onClick={() => setManualInvoiceMenuOpen((open) => !open)}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={manualInvoiceMenuOpen}
              className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white p-2 text-nav-dark hover:bg-gray-50"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {manualInvoiceMenuOpen && (
              <div role="menu" className="absolute right-0 z-20 mt-2 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    navigate('/invoices/field-app/new');
                    setManualInvoiceMenuOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-nav-dark hover:bg-gray-50"
                >
                  Manual Invoice (no job)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => { setCardFilter(cardFilter === 'unposted' ? null : 'unposted'); setStatusFilter(''); }}
          aria-pressed={cardFilter === 'unposted'}
          className={`text-left rounded-xl transition ${cardFilter === 'unposted' ? 'ring-2 ring-crx-green' : 'hover:ring-1 hover:ring-gray-200'}`}
        >
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <FileText className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-secondary">Unposted</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-amber-600">{unpostedCount}</p>
          <p className="text-xs text-secondary mt-1">field invoices awaiting review</p>
        </Card>
        </button>
        <button
          type="button"
          onClick={() => { setCardFilter(cardFilter === 'posted' ? null : 'posted'); setStatusFilter(''); }}
          aria-pressed={cardFilter === 'posted'}
          className={`text-left rounded-xl transition ${cardFilter === 'posted' ? 'ring-2 ring-crx-green' : 'hover:ring-1 hover:ring-gray-200'}`}
        >
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <Check className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Posted Total</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(postedTotal)}</p>
          <p className="text-xs text-secondary mt-1">
            {postedCount} posted &amp; overdue field invoices
          </p>
        </Card>
        </button>
        <button
          type="button"
          onClick={() => { setCardFilter(cardFilter === 'outstanding' ? null : 'outstanding'); setStatusFilter(''); }}
          aria-pressed={cardFilter === 'outstanding'}
          className={`text-left rounded-xl transition ${cardFilter === 'outstanding' ? 'ring-2 ring-crx-green' : 'hover:ring-1 hover:ring-gray-200'}`}
        >
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <Ban className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-secondary">Outstanding</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-600">{fmt(outstandingBalance)}</p>
          <p className="text-xs text-secondary mt-1">unpaid balance on posted &amp; overdue field invoices</p>
        </Card>
        </button>
      </div>

      <p className="text-xs text-secondary -mt-1">
        Showing this season's field invoices (Oct 1 to Sep 30). Tap a card above to filter, or use the status menu.
      </p>

      {/* Data Table */}
      <Card padding={false}>
        {filtered.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-secondary md:hidden">No field invoices match this view.</p>
        )}
        <MobileCardList
          rows={filtered}
          getRowKey={(row) => row.id}
          getRowLabel={(row) => `Open invoice ${row.invoice_number} for ${row.customer_name}`}
          onRowClick={(row) => navigate(invoicePath(row))}
          className="p-3"
          renderCard={(row) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-nav-dark">{row.customer_name}</p>
                <p className="mt-1 text-xs text-secondary">#{row.invoice_number} · {new Date(row.invoice_date + 'T00:00:00').toLocaleDateString()}</p>
                <div className="mt-2">{statusBadge(row.status)}</div>
              </div>
              <div className="flex-shrink-0 text-right">
                <p className="font-semibold text-nav-dark">{fmt(row.total_amount_cents)}</p>
                <p className={row.balance_cents > 0 ? 'mt-1 text-xs font-semibold text-red-600' : 'mt-1 text-xs text-crx-green'}>
                  {fmt(row.balance_cents)} due
                </p>
                <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-crx-green">
                  Open <FileText className="h-3.5 w-3.5" />
                </span>
              </div>
            </div>
          )}
          desktop={<div className="p-5">
          <DataTable<FieldInvoiceRow>
            data={filtered}
            columns={columns.filter((c) => isInvoiceColumnVisible(listSettings, c.key))}
            searchable
            searchPlaceholder="Search field invoices..."
            searchKeys={['invoice_number', 'customer_name', 'applicator_name']}
            onRowClick={(row) =>
              navigate(
                // Two kinds of field invoice need two editors (#3 edit-path):
                //  • ENGINE-built (NEITHER job_id NOR blend_ticket_id) + still
                //    editable -> the per-acre field-app editor (it has
                //    field_app_locations / shares / applied-info RPCs).
                //  • JOB-built (job_id) OR BLEND-TICKET-built (blend_ticket_id):
                //    quantity-based lines, NO field_app_locations -> the generic
                //    invoice detail on a /field-invoices/:id route gated by the
                //    field-invoices permission (save_invoice is field-app aware).
                //    Also any posted field invoice. A blend-ticket field invoice has
                //    job_id NULL but blend_ticket_id set; routing it to the per-acre
                //    editor would load zero locations and fail to save. (Codex r13)
                invoicePath(row)
              )
            }
            emptyTitle="No field invoices yet"
            emptyDescription="Field invoices come from a completed spray job. To add a manual invoice without a job, use More actions."
            loading={loading}
            filters={
              <div className="flex gap-2 items-center">
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setCardFilter(null); }}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            }
          />
        </div>}
        />
      </Card>
    </div>
  );
}
