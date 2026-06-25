import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileText, Printer, FileClock, Mail, Pencil, X, Search, ClipboardCheck, ArrowLeft } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import ConfirmModal from '../components/ui/ConfirmModal';
import MultiSelectDropdown, { type MultiSelectOption } from '../components/jobs/MultiSelectDropdown';
import { useToast } from '../components/ui/Toast';
import { supabase, sanitizeError, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { runCriticalAction } from '../lib/criticalAction';
import { generateIdempotencyKey } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import {
  buildInvoicePdfDataFromRow,
  generateBatchInvoicePdf,
  generateInvoicePdf,
  downloadInvoicePdf,
} from '../lib/invoicePdf';
import { downloadReportPdf } from '../lib/reportPdf';
import { sendEmail, pdfToBase64, buildEmailHtml } from '../lib/emailService';
import { useAuth } from '../contexts/AuthContext';
import { formatCents as fmt } from '../lib/money';
import { getSeasonDates } from '../utils/season';
import { SkeletonTable } from '../components/ui/Skeleton';
import {
  mapFieldInvoiceRow,
  applyFieldInvoiceFilters,
  computeFieldInvoiceTotals,
  emptyFieldInvoiceFilters,
  type RawFieldInvoiceRow,
  type FieldInvoiceListRow,
  type FieldInvoiceListFilters,
} from '../lib/fieldInvoiceList';

// Field-app parity #22: the dedicated "Unposted Field Application Invoices"
// working tray (ChemMan's /#/invoices/unposted). Lists ONLY not-yet-posted
// field invoices (status draft|unposted), with the ChemMan filter bar,
// per-row print/email/edit, footer totals, and bottom bulk actions (Print All /
// Print Invoice Report / Post All). The combined status-filterable list stays at
// /field-invoices. Money is integer cents end-to-end (display via formatCents).

const QUERY_LIMIT = 2000;

// PostgREST select: the invoice + customer + linked job number + engine-built
// per-location rows (locations/crops/acres) + line items (chemicals). One round
// trip; everything else is derived client-side by mapFieldInvoiceRow.
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

export default function FieldInvoicesUnposted() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();

  const [rows, setRows] = useState<FieldInvoiceListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FieldInvoiceListFilters>(emptyFieldInvoiceFilters);
  const [busy, setBusy] = useState(false);
  const [showPostAll, setShowPostAll] = useState(false);
  // Per-row action guard so a double-click can't fire two prints/emails.
  const rowActionRef = useRef(false);
  // Per-invoice idempotency keys from a keyed ref cache so a network-retry
  // (post committed server-side but response lost) reuses the SAME key per
  // invoice and the server dedup matches instead of double-posting. Minted
  // once per invoice; cleared on a clean Post All run. (Mirrors OrderDetail's
  // postDraftKeysRef pattern; avoids the inline-generate double-execution class.)
  const postKeysRef = useRef<Record<string, string>>({});

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    const { start: seasonStart, end: seasonEnd } = getSeasonDates();
    // Window on invoice_date — it is what the 'Trans. Date' filter + column use
    // (ChemMan "Trans. Date" = the invoice/transaction date). Windowing on
    // created_at would silently drop an invoice whose invoice_date is in range
    // but whose created_at fell outside the season — hiding it from the list,
    // the footer totals, AND Post All.
    const { data, error } = await supabase
      .from('invoices')
      .select(LIST_SELECT)
      .eq('invoice_type', 'field_application')
      .in('status', ['draft', 'unposted'])
      .is('deleted_at', null)
      .gte('invoice_date', seasonStart)
      .lte('invoice_date', seasonEnd)
      .order('invoice_date', { ascending: false })
      .limit(QUERY_LIMIT);

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-invoices-unposted' } });
      toast('error', 'Failed to load unposted field invoices');
      setLoading(false);
      return;
    }

    if (data && data.length === QUERY_LIMIT) {
      toast('error', `Showing first ${QUERY_LIMIT} unposted field invoices — some may be hidden.`);
    }

    const raws = (data || []) as unknown as RawFieldInvoiceRow[];

    // GROUPED (split, multi-customer) invoices: the per-acre engine keys their
    // field_app_locations by invoice_group_id with invoice_id=NULL, so the
    // invoice_id-FK embed in LIST_SELECT comes back EMPTY for them. Fetch those
    // locations by group and inject them so Locations/Crops/Acres (and the PDF
    // application-detail header, which toPdfRow derives from these) populate.
    // (Mirrors the groupId ? eq('invoice_group_id') : eq('invoice_id') branch in
    // FieldApplicationInvoice.tsx.)
    const groupIds = [...new Set(
      raws.map((r) => r.invoice_group_id).filter((g): g is string => !!g)
    )];

    if (groupIds.length > 0) {
      const { data: groupLocs, error: groupErr } = await supabase
        .from('field_app_locations')
        .select('invoice_group_id, applied_acres, crop_type, field:fields!field_app_locations_field_id_fkey(field_name, crop_type)')
        .in('invoice_group_id', groupIds);

      if (groupErr) {
        Sentry.captureException(groupErr, { tags: { source: 'fetch_group_locations', page: 'field-invoices-unposted' } });
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
          // Use the group-matched locations for grouped invoices. Ungrouped rows
          // keep their embedded invoice_id-keyed field_app_locations untouched.
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

  // The SAME filtered list drives the table AND the footer totals.
  const visible = useMemo(() => applyFieldInvoiceFilters(rows, filters), [rows, filters]);
  const totals = useMemo(() => computeFieldInvoiceTotals(visible), [visible]);

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
    filters.search !== '';

  const clearFilters = () => setFilters(emptyFieldInvoiceFilters);

  // Open the field-invoice editor for a row. The generic field-invoice editor
  // (/field-invoices/:id) handles both engine-built per-acre and job-built
  // field invoices for edit; its own loader routes per-acre detail correctly.
  const editPath = (row: FieldInvoiceListRow): string => `/field-invoices/${row.id}`;

  // --- Per-row PRINT (current or legacy "Old Print" format, #30) ---
  const printRow = async (row: FieldInvoiceListRow, format: 'current' | 'legacy' = 'current') => {
    if (rowActionRef.current) return;
    rowActionRef.current = true;
    await runCriticalAction({
      action: async () => {
        // Money fields ride toPdfRow; the builder re-fetches lines/shares. The
        // format only switches the layout — Total/Balance Due are identical.
        const pdfData = await buildInvoicePdfDataFromRow(toPdfRow(row), {
          show_shares: true, show_price_per_acre: true, show_epa_registration: true, format,
        });
        await downloadInvoicePdf(pdfData);
      },
      toast,
      successMessage: `Printed ${row.invoice_number}`,
      setLoading: (v) => { setBusy(v); if (!v) rowActionRef.current = false; },
      sentryTag: 'field_invoice_print_row',
    });
    rowActionRef.current = false;
  };

  // --- Per-row EMAIL ---
  const emailRow = async (row: FieldInvoiceListRow) => {
    if (rowActionRef.current) return;
    if (!profile) { toast('error', 'Profile not loaded — please refresh.'); return; }
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
          description: `Field invoice ${row.invoice_number} emailed to ${email}`,
          performedBy: profile.id,
          entityType: 'invoice',
          entityId: row.id,
          customerId: row.customer_id,
        });
      },
      toast,
      successMessage: `Emailed ${row.invoice_number}`,
      setLoading: (v) => { setBusy(v); if (!v) rowActionRef.current = false; },
      sentryTag: 'field_invoice_email_row',
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
      sentryTag: format === 'legacy' ? 'field_invoice_old_print_all' : 'field_invoice_print_all',
    });
  };

  // --- PRINT INVOICE REPORT (one-page summary of the displayed list) ---
  const printReport = async () => {
    if (visible.length === 0) { toast('error', 'No invoices to report'); return; }
    await runCriticalAction({
      action: async () => {
        await downloadReportPdf({
          title: 'Unposted Field Application Invoices',
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
            { header: 'Date', key: 'invoice_date', format: (v) => (v ? new Date(String(v) + 'T00:00:00').toLocaleDateString() : '-') },
          ],
          data: visible as unknown as Record<string, unknown>[],
          orientation: 'landscape',
        });
      },
      toast,
      successMessage: 'Invoice report downloaded',
      setLoading: setBusy,
      sentryTag: 'field_invoice_print_report',
    });
  };

  // --- POST ALL (posts every displayed invoice, after confirm) ---
  const postAll = async () => {
    setShowPostAll(false);
    if (!profile) { toast('error', 'Profile not loaded — please refresh.'); return; }
    const targets = visible.map((r) => ({ id: r.id, invoice_number: r.invoice_number }));
    if (targets.length === 0) { toast('error', 'No invoices to post'); return; }
    await runCriticalAction({
      action: async () => {
        let posted = 0;
        const failures: string[] = [];
        for (const t of targets) {
          if (!postKeysRef.current[t.id]) {
            postKeysRef.current[t.id] = generateIdempotencyKey('post_invoice', `${profile.id}:${t.id}`);
          }
          try {
            // post_invoice RETURNS void — canonical void-RPC pattern is
            // .throwOnError() with no `=` capture (no result to assert).
            await supabase
              .rpc('post_invoice', {
                p_invoice_id: t.id,
                p_idempotency_key: postKeysRef.current[t.id],
              })
              .throwOnError();
            posted += 1;
          } catch (err: unknown) {
            // PRICING_INCOMPLETE is the common, expected reason a field invoice
            // can't post yet — show plain English instead of the raw code.
            // (Mirrors OrderDetail's Post-All handling.)
            if (hasRpcCode(err, RpcErrorCodes.PRICING_INCOMPLETE)) {
              failures.push(`${t.invoice_number}: needs pricing first`);
            } else {
              failures.push(`${t.invoice_number}: ${sanitizeError(err)}`);
            }
          }
        }
        await fetchInvoices();
        if (failures.length > 0) {
          // Surface partial outcome honestly — some posted, some did not. Keep
          // the keys for the failed ones so a retry reuses the same key.
          throw new Error(`Posted ${posted}/${targets.length}. Failed: ${failures.slice(0, 3).join(' | ')}${failures.length > 3 ? ' …' : ''}`);
        }
        // Clean run — clear the cache so a future Post All mints fresh keys.
        postKeysRef.current = {};
      },
      toast,
      successMessage: `Posted ${targets.length} invoice(s)`,
      setLoading: setBusy,
      sentryTag: 'field_invoice_post_all',
    });
  };

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
            <h2 className="text-xl font-semibold font-heading text-nav-dark">Unposted Field Application Invoices</h2>
            <p className="text-xs text-secondary mt-0.5">The working tray — field bills that have not yet been posted.</p>
          </div>
        </div>
        <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/invoices/field-app/new')}>
          Add Invoice
        </Button>
      </div>

      {/* Filter bar */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fi-invnum">Inv. Nbr</label>
            <input
              id="fi-invnum"
              type="text"
              value={filters.invoiceNumber}
              onChange={(e) => setFilters((f) => ({ ...f, invoiceNumber: e.target.value }))}
              placeholder="Invoice #"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg w-36 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
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
          <div>
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fi-from">Trans. Date From</label>
            <input
              id="fi-from"
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fi-to">Trans. Date To</label>
            <input
              id="fi-to"
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div className="flex-1 min-w-[12rem]">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="fi-search">Search</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                id="fi-search"
                type="text"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                placeholder="Search job, customer, location, crop, chemical…"
                className="pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" icon={<X className="w-4 h-4" />} onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
      </Card>

      {/* Table */}
      <Card padding={false}>
        <div className="overflow-x-auto">
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
                <th className="px-3 py-2 font-medium">Transaction</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-secondary">
                    No unposted field invoices{hasFilters ? ' match these filters' : ''}.
                  </td>
                </tr>
              ) : (
                visible.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-gray-50 hover:bg-gray-50/60 cursor-pointer"
                    onClick={() => navigate(editPath(row))}
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
                          onClick={(e) => { e.stopPropagation(); navigate(editPath(row)); }}
                          className="p-1.5 rounded hover:bg-gray-100 text-crx-green"
                          aria-label={`Edit ${row.invoice_number}`}
                          title="Edit"
                        >
                          <Pencil className="w-4 h-4" />
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
                  <td className="px-3 py-2" colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* Bottom bulk-action bar */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-secondary">
            Bulk actions apply to all {totals.count} invoice(s) currently shown.
          </p>
          <div className="flex flex-wrap gap-2 justify-end">
            <Button variant="secondary" size="sm" icon={<Printer className="w-4 h-4" />} onClick={() => printAll('current')} loading={busy} disabled={visible.length === 0}>
              Print All
            </Button>
            <Button variant="secondary" size="sm" icon={<FileClock className="w-4 h-4" />} onClick={() => printAll('legacy')} loading={busy} disabled={visible.length === 0}>
              Old Print All
            </Button>
            <Button variant="secondary" size="sm" icon={<FileText className="w-4 h-4" />} onClick={printReport} loading={busy} disabled={visible.length === 0}>
              Print Invoice Report
            </Button>
            <Button variant="primary" size="sm" icon={<ClipboardCheck className="w-4 h-4" />} onClick={() => setShowPostAll(true)} disabled={busy || visible.length === 0}>
              Post All
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmModal
        open={showPostAll}
        onClose={() => setShowPostAll(false)}
        onConfirm={postAll}
        title="Post all displayed invoices?"
        message={`This posts all ${totals.count} unposted field invoice(s) currently shown (${fmt(totals.totalAmountCents)}). Posting commits them to accounts receivable and is logged. Continue?`}
        confirmLabel={`Post ${totals.count}`}
        variant="info"
        icon={ClipboardCheck}
        loading={busy}
      />
    </div>
  );
}

// Map a list row into the snapshot shape buildInvoicePdfDataFromRow expects.
// The list row already carries the field/crop/applicator snapshot it needs;
// the builder re-fetches line items / shares / customer billing by id.
function toPdfRow(row: FieldInvoiceListRow) {
  return {
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
    // Carry the money fields so the PDF's Payments / Prepay lines and Balance
    // Due agree with the printed Total. Defaulting these to 0 would make a
    // posted invoice WITH payments print a full Total but a lower Balance Due
    // (they'd silently disagree) — this list is unposted today, but #23 Posted
    // reuses toPdfRow → buildInvoicePdfDataFromRow.
    total_cost_cents: row.total_cost_cents,
    paid_amount_cents: row.paid_amount_cents,
    prepay_applied_cents: row.prepay_applied_cents,
    write_off_cents: row.write_off_cents,
    balance_cents: row.balance_cents,
  };
}
