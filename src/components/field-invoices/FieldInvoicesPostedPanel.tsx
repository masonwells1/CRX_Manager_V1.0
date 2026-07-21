import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Printer, FileClock, Mail, Eye, Search, AlertTriangle, RotateCcw, ArrowLeft } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import MultiSelectDropdown, { type MultiSelectOption } from '../jobs/MultiSelectDropdown';
import { useToast } from '../ui/Toast';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { runCriticalAction } from '../../lib/criticalAction';
import { generateIdempotencyKey } from '../../lib/idempotency';
import ConfirmModal from '../ui/ConfirmModal';
import MobileCardList from '../ui/MobileCardList';
import {
  buildInvoicePdfDataFromRow,
  generateBatchInvoicePdf,
  generateInvoicePdf,
  downloadInvoicePdf,
} from '../../lib/invoicePdf';
import { downloadReportPdf } from '../../lib/reportPdf';
import { sendEmail, pdfToBase64, buildEmailHtml, isInvoiceEmailSuppressed } from '../../lib/emailService';
import { useAuth } from '../../contexts/AuthContext';
import { logActivity } from '../../lib/activityLogger';
import { formatCents as fmt } from '../../lib/money';
import { getSeasonDates } from '../../utils/season';
import { SkeletonTable } from '../ui/Skeleton';
import {
  mapFieldInvoiceRow,
  applyFieldInvoiceFilters,
  computeFieldInvoiceTotals,
  emptyFieldInvoiceFilters,
  STATUS_POSTED,
  deriveMonthBatches,
  applyPostedScope,
  spansMultipleBatches,
  defaultPostedScope,
  type RawFieldInvoiceRow,
  type FieldInvoiceListRow,
  type FieldInvoiceListFilters,
  type PostedScope,
} from '../../lib/fieldInvoiceList';

// Field-app parity #23: the dedicated "Posted Field Application Invoices" page
// (ChemMan's /#/invoices/posted "Posted Invoices"). Lists ONLY invoices already
// committed to the ledger (status posted|overdue|paid), so the owner can review
// what was billed without risk of accidental edits. Same column set + footer
// totals as the Unposted tray, PLUS a Season/Batch/Month-to-date scope selector,
// a posted-records warning banner, and a bottom action bar (Print All / Print
// Invoice Report / Unpost All). Posted invoices are committed — actions are
// view/print/email only; the editor opens read-only paths. Money is integer
// cents end-to-end (display via formatCents). Unpost is gated to #28 (no
// unpost_invoice RPC exists yet) — the button is present for parity but inert.

const QUERY_LIMIT = 2000;

// Same one-round-trip select as the Unposted list: invoice + customer + linked
// job number + engine-built per-location rows + line items (chemicals).
const LIST_SELECT = `
  *,
  customer:customers!invoices_customer_id_fkey(farm_name),
  job:jobs!invoices_job_id_fkey(job_number),
  field_app_locations(applied_acres, crop_type, field:fields!field_app_locations_field_id_fkey(field_name, crop_type)),
  invoice_items(is_application_fee, description, product:products(product_name))
`;

const chips = (values: string[]) => {
  if (values.length === 0) return <span className="text-gray-400">—</span>;
  const shown = values.slice(0, 3);
  const extra = values.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((v) => (
        <span key={v} className="inline-block px-1.5 py-0.5 text-[11px] rounded bg-gray-100 text-gray-700">
          {v}
        </span>
      ))}
      {extra > 0 && <span className="text-[11px] text-secondary">+{extra}</span>}
    </div>
  );
};

export default function FieldInvoicesPostedPanel() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();

  const [rows, setRows] = useState<FieldInvoiceListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FieldInvoiceListFilters>(emptyFieldInvoiceFilters);
  const [scope, setScope] = useState<PostedScope>(defaultPostedScope);
  const [busy, setBusy] = useState(false);
  // #28: bulk Unpost All — confirm gate + in-flight guard.
  const [showUnpostConfirm, setShowUnpostConfirm] = useState(false);
  const [unposting, setUnposting] = useState(false);
  // #28: per-invoice idempotency key cache (keyed by invoice id), so a retry after a
  // timeout reuses the SAME key and the server dedup matches — never a double unpost.
  // Mirrors the Unposted list's Post All (postKeysRef). Cleared on a clean run.
  const unpostKeysRef = useRef<Record<string, string>>({});
  // Per-row action guard so a double-click can't fire two prints/emails.
  const rowActionRef = useRef(false);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    const { start: seasonStart, end: seasonEnd } = getSeasonDates();
    // Window on invoice_date — the same field the Trans. Date filter/column and
    // the monthly batch (date_trunc('month', invoice_date)) key off. Windowing
    // on created_at would drop an invoice whose invoice_date is in range but
    // created_at fell outside the season.
    const { data, error } = await supabase
      .from('invoices')
      .select(LIST_SELECT)
      .eq('invoice_type', 'field_application')
      .in('status', [...STATUS_POSTED])
      .is('deleted_at', null)
      .gte('invoice_date', seasonStart)
      .lte('invoice_date', seasonEnd)
      .order('invoice_date', { ascending: false })
      .limit(QUERY_LIMIT);

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-invoices-posted' } });
      toast('error', 'Failed to load posted field invoices');
      setLoading(false);
      return;
    }

    if (data && data.length === QUERY_LIMIT) {
      toast('error', `Showing first ${QUERY_LIMIT} posted field invoices — some may be hidden.`);
    }

    const raws = (data || []) as unknown as RawFieldInvoiceRow[];

    // GROUPED (split, multi-customer) invoices: the per-acre engine keys their
    // field_app_locations by invoice_group_id with invoice_id=NULL, so the
    // invoice_id-FK embed in LIST_SELECT comes back EMPTY for them. Fetch those
    // locations by group and inject them so Locations/Crops/Acres (and the PDF
    // application-detail header) populate for split posted invoices.
    const groupIds = [...new Set(
      raws.map((r) => r.invoice_group_id).filter((g): g is string => !!g)
    )];

    if (groupIds.length > 0) {
      const { data: groupLocs, error: groupErr } = await supabase
        .from('field_app_locations')
        .select('invoice_group_id, applied_acres, crop_type, field:fields!field_app_locations_field_id_fkey(field_name, crop_type)')
        .in('invoice_group_id', groupIds);

      if (groupErr) {
        Sentry.captureException(groupErr, { tags: { source: 'fetch_group_locations', page: 'field-invoices-posted' } });
        toast('error', 'Failed to load split-invoice locations');
        setLoading(false);
        return;
      }

      const byGroup = new Map<string, RawFieldInvoiceRow['field_app_locations']>();
      for (const loc of (groupLocs || []) as NonNullable<RawFieldInvoiceRow['field_app_locations']>) {
        const gid = (loc as { invoice_group_id?: string | null }).invoice_group_id;
        if (!gid) continue;
        const list = byGroup.get(gid) ?? [];
        list!.push(loc);
        byGroup.set(gid, list);
      }

      for (const r of raws) {
        if (r.invoice_group_id) {
          r.field_app_locations = byGroup.get(r.invoice_group_id) ?? [];
        }
      }
    }

    setRows(raws.map(mapFieldInvoiceRow));
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  // The named filter bar narrows first; then the scope (season/MTD/batch) narrows
  // by month. The SAME final list drives the table AND the footer totals.
  const filtered = useMemo(() => applyFieldInvoiceFilters(rows, filters), [rows, filters]);
  const visible = useMemo(() => applyPostedScope(filtered, scope), [filtered, scope]);
  const totals = useMemo(() => computeFieldInvoiceTotals(visible), [visible]);

  // Monthly batches available for the scope dropdown (derived from the loaded,
  // named-filtered rows so the option list tracks the current filter bar).
  const monthBatches = useMemo(() => deriveMonthBatches(filtered), [filtered]);
  // The displayed set crosses more than one month-end batch — an Unpost All here
  // would touch multiple batch totals (each must be re-reconciled / reprinted).
  const crossesBatches = useMemo(() => spansMultipleBatches(visible), [visible]);

  const customerOptions: MultiSelectOption[] = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of rows) byId.set(r.customer_id, r.customer_name);
    return [...byId.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const hasFilters =
    filters.invoiceNumber !== '' ||
    filters.customerIds.length > 0 ||
    filters.dateFrom !== '' ||
    filters.dateTo !== '' ||
    filters.search !== '' ||
    scope.kind !== 'season';

  const clearFilters = () => { setFilters(emptyFieldInvoiceFilters); setScope(defaultPostedScope); };

  // Encode/decode the scope <select> value. 'season' | 'mtd' | a YYYY-MM month.
  const scopeValue = scope.kind === 'batch' ? scope.month : scope.kind;
  const onScopeChange = (value: string) => {
    if (value === 'season') setScope({ kind: 'season' });
    else if (value === 'mtd') setScope({ kind: 'mtd' });
    else setScope({ kind: 'batch', month: value });
  };

  // Open the read-only field-invoice detail for a row. Posted invoices are
  // committed — the generic field-invoice editor (/field-invoices/:id) opens
  // them in the appropriate (non-per-acre) path and enforces the lifecycle.
  const viewPath = (row: FieldInvoiceListRow): string => `/field-invoices/${row.id}`;

  // Map a list row into the snapshot shape buildInvoicePdfDataFromRow expects.
  // Carries the money fields so a posted invoice WITH payments prints a Balance
  // Due that reconciles with its Total (Total − Payments − Prepay = Balance).
  const toPdfRow = (row: FieldInvoiceListRow) => ({
    id: row.id,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    invoice_type: 'field_application',
    status: row.status,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    crop_type: row.crops[0] ?? null,
    field_names: row.locations.length > 0 ? row.locations : null,
    total_acres: row.total_acres || null,
    applicator_name: row.applicators[0] ?? null,
    total_amount_cents: row.total_amount_cents,
    total_cost_cents: row.total_cost_cents,
    paid_amount_cents: row.paid_amount_cents,
    prepay_applied_cents: row.prepay_applied_cents,
    write_off_cents: row.write_off_cents,
    balance_cents: row.balance_cents,
  });

  // --- Per-row PRINT (current or legacy "Old Print" format, #30) ---
  const printRow = async (row: FieldInvoiceListRow, format: 'current' | 'legacy' = 'current') => {
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
      setLoading: (v) => { setBusy(v); if (!v) rowActionRef.current = false; },
      sentryTag: 'field_invoice_posted_print_row',
    });
    rowActionRef.current = false;
  };

  // --- Per-row EMAIL ---
  const emailRow = async (row: FieldInvoiceListRow) => {
    if (rowActionRef.current) return;
    if (!profile) { toast('error', 'Profile not loaded — please refresh.'); return; }
    // FieldInvoiceListRow doesn't yet declare send_disposition (added when the
    // split-billing migration + list query land); cast to the helper's shape.
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
        if (!email) throw new Error('Customer does not have an email address on file');

        const pdfData = await buildInvoicePdfDataFromRow(toPdfRow(row));
        const doc = await generateInvoicePdf(pdfData);
        const base64 = pdfToBase64(doc);

        const amountStr = (row.balance_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
        const html = buildEmailHtml(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:18px;">Field Application Invoice ${row.invoice_number}</h2>
          <p style="margin:0 0 8px;color:#374151;">Amount Due: <strong>${amountStr}</strong></p>
          <p style="margin:0 0 8px;color:#374151;">Invoice Date: ${row.invoice_date}</p>
          <p style="margin:16px 0 0;color:#374151;">Please find your invoice attached to this email.</p>
        `);

        const result = await sendEmail({
          to: email,
          subject: `Invoice ${row.invoice_number} from Crop RX Solutions`,
          html,
          email_type: 'invoice',
          customer_id: row.customer_id,
          resource_type: 'invoice',
          resource_id: row.id,
          idempotency_key: `invoice-email-${row.id}-${Date.now()}`,
          attachments: [{ filename: `Invoice-${row.invoice_number}.pdf`, content: base64 }],
        });
        if (!result.success) throw new Error(result.error || 'Email failed to send');

        logActivity({
          event: 'invoice_emailed',
          description: `Posted field invoice ${row.invoice_number} emailed to ${email}`,
          performedBy: profile.id,
          entityType: 'invoice',
          entityId: row.id,
          customerId: row.customer_id,
        });
      },
      toast,
      successMessage: `Emailed ${row.invoice_number}`,
      setLoading: (v) => { setBusy(v); if (!v) rowActionRef.current = false; },
      sentryTag: 'field_invoice_posted_email_row',
    });
    rowActionRef.current = false;
  };

  // --- PRINT ALL / OLD PRINT ALL (one PDF per displayed invoice, #30) ---
  const printAll = async (format: 'current' | 'legacy' = 'current') => {
    if (visible.length === 0) { toast('error', 'No invoices to print'); return; }
    await runCriticalAction({
      action: async () => {
        const list = await Promise.all(
          visible.map((row) => buildInvoicePdfDataFromRow(toPdfRow(row), {
            show_shares: true, show_price_per_acre: true, show_epa_registration: true, format,
          }))
        );
        await generateBatchInvoicePdf(list);
      },
      toast,
      successMessage: `Printed ${visible.length} invoice(s)`,
      setLoading: setBusy,
      sentryTag: format === 'legacy' ? 'field_invoice_posted_old_print_all' : 'field_invoice_posted_print_all',
    });
  };

  // --- PRINT INVOICE REPORT (one-page summary of the displayed list) ---
  const printReport = async () => {
    if (visible.length === 0) { toast('error', 'No invoices to report'); return; }
    await runCriticalAction({
      action: async () => {
        await downloadReportPdf({
          title: 'Posted Field Application Invoices',
          subtitle: `${totals.count} invoice(s) — ${totals.totalAcres.toLocaleString()} acres — ${fmt(totals.totalAmountCents)}`,
          columns: [
            { header: 'Job #', key: 'job_number', format: (v) => String(v || '-') },
            { header: 'Invoice #', key: 'invoice_number' },
            { header: 'Customer', key: 'customer_name' },
            { header: 'Locations', key: 'locations', format: (v) => (Array.isArray(v) ? v.join(', ') : '-') },
            { header: 'Crops', key: 'crops', format: (v) => (Array.isArray(v) ? v.join(', ') : '-') },
            { header: 'Applicators', key: 'applicators', format: (v) => (Array.isArray(v) ? v.join(', ') : '-') },
            { header: 'Chemicals', key: 'chemicals', format: (v) => (Array.isArray(v) ? v.join(', ') : '-') },
            { header: 'Acres', key: 'total_acres', align: 'right', format: (v) => (v != null ? String(v) : '-') },
            { header: 'Total', key: 'total_amount_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
            { header: 'Balance', key: 'balance_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
            { header: 'Date', key: 'invoice_date', format: (v) => (v ? new Date(String(v) + 'T00:00:00').toLocaleDateString() : '-') },
          ],
          data: visible as unknown as Record<string, unknown>[],
          orientation: 'landscape',
        });
      },
      toast,
      successMessage: 'Invoice report downloaded',
      setLoading: setBusy,
      sentryTag: 'field_invoice_posted_print_report',
    });
  };

  // --- UNPOST ALL (#28) ---
  // Real bulk unpost: reverse every UNPAID posted/overdue invoice in the shown
  // set back to the Unposted list, one at a time through the gated unpost_invoice
  // RPC (per-invoice idempotency key, .throwOnError() + assertRpcResult). A 'paid'
  // invoice can't be unposted (money applied) — it is skipped, not failed. Each
  // call respects the closed-period and money guards in the RPC; if one fails the
  // others still process and we report a clear per-invoice failure summary.
  // The button is gated behind a ConfirmModal (openable below), then refreshes.
  const candidates = useMemo(
    () => visible.filter((r) => r.status === 'posted' || r.status === 'overdue'),
    [visible],
  );

  const runUnpostAll = async () => {
    setShowUnpostConfirm(false);
    if (!profile) { toast('error', 'Profile not loaded — please refresh.'); return; }
    if (candidates.length === 0) { toast('error', 'No unpostable invoices in view (paid invoices cannot be unposted).'); return; }
    setUnposting(true);
    let ok = 0;
    const failures: string[] = [];
    try {
      for (const row of candidates) {
        // Reuse a cached per-invoice key on retry so the server dedup matches.
        if (!unpostKeysRef.current[row.id]) {
          unpostKeysRef.current[row.id] = generateIdempotencyKey('unpost_invoice', `${profile.id}:${row.id}`);
        }
        try {
          const { data, error } = await supabase.rpc('unpost_invoice', {
            p_invoice_id: row.id,
            p_performed_by: profile.id,
            p_idempotency_key: unpostKeysRef.current[row.id],
          });
          if (error) throw error;
          assertRpcResult(data, 'unpost_invoice');
          ok += 1;
          // Succeeded — drop this invoice's key so a later run mints a fresh one.
          delete unpostKeysRef.current[row.id];
        } catch (err) {
          Sentry.captureException(err, { tags: { rpc: 'unpost_invoice', page: 'field-invoices-posted' } });
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`${row.invoice_number}: ${msg}`);
          // Keep the failed invoice's key cached so a retry reuses it.
        }
      }

      if (failures.length === 0) {
        toast('success', `Unposted ${ok} invoice(s) — returned to the Unposted list.`);
      } else if (ok > 0) {
        toast('error', `Unposted ${ok}, but ${failures.length} could not be unposted. ${failures[0]}`);
      } else {
        toast('error', `Could not unpost. ${failures[0]}`);
      }

      if (ok > 0) {
        logActivity({
          event: 'invoices_bulk_unposted',
          description: `Bulk unposted ${ok} field invoice(s) from the Posted list`,
          performedBy: profile.id,
          entityType: 'invoice',
          entityId: candidates[0].id,
        });
      }

      await fetchInvoices();
    } finally {
      setUnposting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/field-invoices')}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-secondary"
            aria-label="Back to field invoices"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">Posted Field Application Invoices</h2>
            <p className="text-xs text-secondary mt-0.5">Committed field bills — already counted in the books for their month-end batch.</p>
          </div>
        </div>
      </div>

      {/* Posted-records warning banner (always on) */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <p>
          Posted records are from the most recent month roll. Modifying a posted invoice will cause the
          previous batch totals to update, and any applicable reports will need to be reprinted.
        </p>
      </div>

      {/* Dynamic month-batch span warning (only when the shown set crosses batches) */}
      {crossesBatches && (
        <div className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <p>
            The invoices shown span more than one month-end batch. A bulk action here would affect
            multiple batch totals — narrow the scope to a single batch (below) to act on one batch at a time.
          </p>
        </div>
      )}

      {/* Filter bar */}
      <Card>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fip-scope">Scope</label>
            <select
              id="fip-scope"
              value={scopeValue}
              onChange={(e) => onScopeChange(e.target.value)}
              aria-label="Posting scope"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 sm:w-auto"
            >
              <option value="season">This Season</option>
              <option value="mtd">Month-to-date</option>
              {monthBatches.length > 0 && (
                <optgroup label="Monthly batches">
                  {monthBatches.map((b) => (
                    <option key={b.month} value={b.month}>{b.label} ({b.count})</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fip-invnum">Inv. Nbr</label>
            <input
              id="fip-invnum"
              type="text"
              value={filters.invoiceNumber}
              onChange={(e) => setFilters((f) => ({ ...f, invoiceNumber: e.target.value }))}
              placeholder="Invoice #"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 sm:w-36"
            />
          </div>
          <MultiSelectDropdown
            label="Customers"
            options={customerOptions}
            selected={filters.customerIds}
            onChange={(next) => setFilters((f) => ({ ...f, customerIds: next }))}
            placeholder="All customers"
            emptyText="No customers"
          />
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fip-from">Trans. Date From</label>
            <input
              id="fip-from"
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 sm:w-auto"
            />
          </div>
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fip-to">Trans. Date To</label>
            <input
              id="fip-to"
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 sm:w-auto"
            />
          </div>
          <div className="w-full min-w-0 flex-1 sm:min-w-[12rem]">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fip-search">Search</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                id="fip-search"
                type="text"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                placeholder="Search job, customer, location, crop, chemical…"
                className="pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" icon={<RotateCcw className="w-4 h-4" />} onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
      </Card>

      {/* Table */}
      <Card padding={false}>
        {visible.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-secondary md:hidden">
            No posted field invoices{hasFilters ? ' match these filters' : ''}.
          </p>
        )}
        <MobileCardList
          rows={visible}
          getRowKey={(row) => row.id}
          getRowLabel={(row) => `View invoice ${row.invoice_number} for ${row.customer_name}`}
          onRowClick={(row) => navigate(viewPath(row))}
          className="p-3"
          renderCard={(row) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-nav-dark">{row.customer_name}</p>
                <p className="mt-1 text-xs text-secondary">
                  #{row.invoice_number}{row.job_number ? ` · Job ${row.job_number}` : ''}
                </p>
                <p className="mt-1 text-xs text-secondary">
                  {new Date(row.invoice_date + 'T00:00:00').toLocaleDateString()} · {row.total_acres.toLocaleString()} ac
                </p>
              </div>
              <div className="flex-shrink-0 text-right">
                <p className="font-semibold text-nav-dark">{fmt(row.total_amount_cents)}</p>
                <p className={row.balance_cents > 0 ? 'mt-1 text-xs font-semibold text-red-600' : 'mt-1 text-xs text-crx-green'}>
                  {fmt(row.balance_cents)} due
                </p>
                <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-crx-green">
                  View <Eye className="h-3.5 w-3.5" />
                </span>
              </div>
            </div>
          )}
          desktop={<div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-secondary uppercase tracking-wide">
                <th className="px-3 py-2 font-medium">Job #</th>
                <th className="px-3 py-2 font-medium">Invoice #</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Locations</th>
                <th className="px-3 py-2 font-medium">Crops</th>
                <th className="px-3 py-2 font-medium">Applicators</th>
                <th className="px-3 py-2 font-medium">Chemicals</th>
                <th className="px-3 py-2 font-medium text-right">Acres</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
                <th className="px-3 py-2 font-medium text-right">Balance</th>
                <th className="px-3 py-2 font-medium">Transaction</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-3 py-10 text-center text-secondary">
                    No posted field invoices{hasFilters ? ' match these filters' : ''}.
                  </td>
                </tr>
              ) : (
                visible.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-gray-50 hover:bg-gray-50/60 cursor-pointer"
                    onClick={() => navigate(viewPath(row))}
                  >
                    <td className="px-3 py-2 text-gray-700">{row.job_number || '—'}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 font-medium text-nav-dark">
                        <FileText className="w-3.5 h-3.5 text-crx-green flex-shrink-0" />
                        {row.invoice_number}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-700">{row.customer_name}</td>
                    <td className="px-3 py-2">{chips(row.locations)}</td>
                    <td className="px-3 py-2">{chips(row.crops)}</td>
                    <td className="px-3 py-2">{chips(row.applicators)}</td>
                    <td className="px-3 py-2">{chips(row.chemicals)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{row.total_acres.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(row.total_amount_cents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className={row.balance_cents > 0 ? 'text-red-600 font-semibold' : 'text-crx-green'}>
                        {fmt(row.balance_cents)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                      {new Date(row.invoice_date + 'T00:00:00').toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void printRow(row, 'current'); }}
                          disabled={busy}
                          className="p-1.5 rounded hover:bg-gray-100 text-secondary disabled:opacity-40"
                          aria-label={`Print ${row.invoice_number}`}
                          title="Print (current format)"
                        >
                          <Printer className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void printRow(row, 'legacy'); }}
                          disabled={busy}
                          className="p-1.5 rounded hover:bg-gray-100 text-secondary disabled:opacity-40"
                          aria-label={`Old Print ${row.invoice_number}`}
                          title="Old Print (legacy format)"
                        >
                          <FileClock className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void emailRow(row); }}
                          disabled={busy}
                          className="p-1.5 rounded hover:bg-gray-100 text-secondary disabled:opacity-40"
                          aria-label={`Email ${row.invoice_number}`}
                          title="Email"
                        >
                          <Mail className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); navigate(viewPath(row)); }}
                          className="p-1.5 rounded hover:bg-gray-100 text-crx-green"
                          aria-label={`View ${row.invoice_number}`}
                          title="View"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {/* Footer totals */}
            {visible.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50/60 font-semibold text-nav-dark">
                  <td className="px-3 py-2" colSpan={7}>
                    Invoices Displayed: {totals.count}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{totals.totalAcres.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.totalAmountCents)}</td>
                  <td className="px-3 py-2" colSpan={3}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>}
        />
      </Card>

      {/* Bottom bulk-action bar */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-secondary">
            Bulk actions apply to all {totals.count} invoice(s) currently shown.
          </p>
          <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            <Button variant="secondary" size="sm" icon={<Printer className="w-4 h-4" />} onClick={() => printAll('current')} loading={busy} disabled={visible.length === 0}>
              Print All
            </Button>
            <Button variant="secondary" size="sm" icon={<FileClock className="w-4 h-4" />} onClick={() => printAll('legacy')} loading={busy} disabled={visible.length === 0}>
              Old Print All
            </Button>
            <Button variant="secondary" size="sm" icon={<FileText className="w-4 h-4" />} onClick={printReport} loading={busy} disabled={visible.length === 0}>
              Print Invoice Report
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCcw className="w-4 h-4" />}
              onClick={() => setShowUnpostConfirm(true)}
              loading={unposting}
              disabled={unposting || candidates.length === 0}
              title="Return every unpaid posted invoice in view to the Unposted list"
            >
              Unpost All{candidates.length > 0 ? ` (${candidates.length})` : ''}
            </Button>
          </div>
        </div>
      </Card>

      {/* #28: bulk Unpost All confirm. Reverses every unpaid posted/overdue invoice
          shown back to the Unposted list (paid invoices are skipped). */}
      <ConfirmModal
        open={showUnpostConfirm}
        onClose={() => setShowUnpostConfirm(false)}
        onConfirm={runUnpostAll}
        title="Unpost All Shown Invoices"
        message={
          `Return ${candidates.length} posted invoice(s) to the Unposted list? ` +
          `This reverses their posting so they become editable again and updates the ` +
          `affected month-end batch totals. Paid invoices are skipped. Invoices in a ` +
          `closed accounting period cannot be unposted.`
        }
        confirmLabel={`Unpost ${candidates.length}`}
        variant="warning"
        loading={unposting}
      />
    </div>
  );
}
