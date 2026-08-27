import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileText, Check, Send, Ban, Printer, Mail, Zap, Trash2, Download, PanelRightOpen } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult, describePostInvoiceBlock } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import BatchVoidModal from '../components/invoices/BatchVoidModal';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import InvoicePrintDialog from '../components/invoices/InvoicePrintDialog';
import CustomerDrawer from '../components/customers/CustomerDrawer';
import { hasPageAccess } from '../lib/pagePermissions';
import type { Invoice, InvoiceStatus, InvoicePrintOptions } from '../types';
import {
  generateBatchInvoicePdf,
  groupReturnCreditDisplayItems,
  type InvoicePdfData,
  type InvoicePdfItem,
} from '../lib/invoicePdf';
import { formatCents as fmt } from '../lib/money';
import { SkeletonTable, SkeletonCard } from '../components/ui/Skeleton';
import { getSeasonDates } from '../utils/season';
import { generateIdempotencyKey } from '../lib/idempotency';
import { buildInvoicePostTargets, describeInvoicePostScope } from '../lib/invoiceBatchPosting';
import PageHeader from '../components/ui/PageHeader';

type InvoiceRow = Invoice & { customer_name: string; salesman_name: string | null; order_number: string | null };

type InvoiceStatusFilter = InvoiceStatus | '' | 'ready_to_post';

const STATUS_OPTIONS: { value: InvoiceStatusFilter; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'ready_to_post', label: 'Ready to Post (draft + unposted)' },
  { value: 'draft', label: 'Draft' },
  { value: 'unposted', label: 'Unposted' },
  { value: 'posted', label: 'Posted' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'voided', label: 'Voided' },
  { value: 'cancelled', label: 'Cancelled' },
];

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Types' },
  { value: 'chemical_sale', label: 'Chemical Sale' },
  // 'field_application' intentionally omitted — field invoices are filtered out
  // of this Chemical Sales list (see fetch .neq). They live at /field-invoices.
  { value: 'misc_charge', label: 'Misc Charge' },
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

const typeBadge = (t: string) => {
  const map: Record<string, string> = {
    chemical_sale: 'Chemical',
    field_application: 'Application',
    misc_charge: 'Misc',
  };
  return <Badge variant="info">{map[t] || t}</Badge>;
};


export default function Invoices() {
  const navigate = useNavigate();
  const { profile, role, deniedPages } = useAuth();
  // Customer 360 peek exposes AR balance + credit tier — gate with the canonical
  // customers-page permission (blocks a rep denied /customers — Codex P2).
  const canPeekCustomer = hasPageAccess(role, deniedPages, 'customers');
  const { toast } = useToast();
  const batchVoidIdem = useIdempotencyKey('batch_void_invoices', profile?.id || '');
  const batchDeleteIdem = useIdempotencyKey('delete_invoices', profile?.id || '');
  const canPostInvoices = profile?.role === 'admin' || profile?.role === 'sales_rep';
  const isAdmin = profile?.role === 'admin';
  // Keep one stable key per standalone invoice or split group across a
  // failed/network-lost retry, and clear only that action's key on success.
  const postKeysRef = useRef<Record<string, string>>({});
  // Reset the remaining batch keys whenever the selected set changes (Codex P2 fix).
  // See the `selectedKey` derivation + useEffect below.
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatusFilter>('');
  const [typeFilter, setTypeFilter] = useState('');
  const [quickDeliveryOnly, setQuickDeliveryOnly] = useState(false);
  const [balanceOnly, setBalanceOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  const [showPostModal, setShowPostModal] = useState(false);

  // Codex P2 fix (PR #59, 2026-05-16): reset batch idempotency keys when the
  // user changes their selection. Otherwise the page-scoped keys would carry
  // over — batch-post A succeeds, response lost, user picks different invoices
  // and clicks Post → server replays A's cached success without posting B.
  // Hashing the sorted selected IDs detects intent changes; identical retries
  // still reuse the key for safe retry-on-network-error.
  const selectedKey = Array.from(selected).sort().join(',');
  useEffect(() => {
    batchVoidIdem.resetKey();
    batchDeleteIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);
  const [voiding, setVoiding] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [showBatchPrintDialog, setShowBatchPrintDialog] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  // Customer 360 peek drawer (F2) — view a customer's numbers without leaving the list.
  const [drawerCustomer, setDrawerCustomer] = useState<{ id: string; name: string } | null>(null);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    const { start: seasonStart, end: seasonEnd } = getSeasonDates();
    const QUERY_LIMIT = 2000;
    // PR-07 follow-up: dropped salesman FK embed; resolve via profile_public_view.
    const { data, error } = await supabase
      .from('invoices')
      .select('*, customer:customers!invoices_customer_id_fkey(farm_name)')
      .is('deleted_at', null)
      // Segregation (Mason 2026-06-19): field-application invoices live in their
      // own area (/field-invoices). This Chemical Sales list excludes them so a
      // field invoice no longer shows in BOTH lists.
      .neq('invoice_type', 'field_application')
      .gte('created_at', seasonStart)
      .lte('created_at', seasonEnd + 'T23:59:59')
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMIT);

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'invoices' } });
      toast('error', 'Failed to load invoices');
      setLoading(false);
      return;
    }

    if (data && data.length === QUERY_LIMIT) {
      toast('error', `Showing first ${QUERY_LIMIT} invoices — some invoices may be hidden. Contact admin if you need the full list.`);
    }

    const salesmanIds = [...new Set(
      ((data || []) as Array<{ salesman_id?: string | null }>)
        .map((inv) => inv.salesman_id)
        .filter(Boolean) as string[]
    )];
    const salesmanMap: Record<string, string> = {};
    if (salesmanIds.length > 0) {
      const { data: salesmen } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', salesmanIds);
      ((salesmen || []) as { id: string; full_name: string }[]).forEach((s) => { salesmanMap[s.id] = s.full_name; });
    }

    // F7: resolve the source order number so the list can show + link to it.
    const orderIds = [...new Set(
      ((data || []) as Array<{ order_id?: string | null }>).map((inv) => inv.order_id).filter(Boolean) as string[]
    )];
    const orderMap: Record<string, string> = {};
    if (orderIds.length > 0) {
      const { data: ords } = await supabase.from('orders').select('id, order_number').in('id', orderIds);
      ((ords || []) as { id: string; order_number: string }[]).forEach((o) => { orderMap[o.id] = o.order_number; });
    }

    const rows = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name: string }; salesman_id?: string | null; order_id?: string | null }>).map((inv) => ({
      ...inv,
      customer_name: inv.customer?.farm_name || 'Unknown',
      salesman_name: inv.salesman_id ? salesmanMap[inv.salesman_id] || null : null,
      order_number: inv.order_id ? orderMap[inv.order_id] || null : null,
    })) as unknown as InvoiceRow[];
    setInvoices(rows);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  const filtered = invoices.filter((inv) => {
    if (statusFilter === 'ready_to_post' && !['draft', 'unposted'].includes(inv.status)) return false;
    if (statusFilter && statusFilter !== 'ready_to_post' && inv.status !== statusFilter) return false;
    if (typeFilter && inv.invoice_type !== typeFilter) return false;
    if (quickDeliveryOnly && !inv.is_quick_delivery) return false;
    if (balanceOnly && !(inv.balance_cents > 0)) return false;
    return true;
  });

  // Summary stats
  const unpostedCount = invoices.filter((i) => i.status === 'draft' || i.status === 'unposted').length;
  const postedTotal = invoices
    .filter((i) => i.status === 'posted')
    .reduce((s, i) => s + i.total_amount_cents, 0);
  const outstandingBalance = invoices
    .filter((i) => i.status === 'posted' && i.balance_cents > 0)
    .reduce((s, i) => s + i.balance_cents, 0);

  // Determine what's selected for action buttons
  const selectedInvoices = invoices.filter((i) => selected.has(i.id));
  const selectedPostable = selectedInvoices.filter((i) => ['draft', 'unposted'].includes(i.status));
  const postConfirmation = describeInvoicePostScope(selectedPostable);
  const selectedVoidable = selectedInvoices.filter((i) => ['posted', 'overdue'].includes(i.status));
  const selectedDeletable = selectedInvoices.filter((i) => ['draft', 'voided'].includes(i.status));
  const selectableStatuses = ['draft', 'unposted', 'posted', 'voided'];

  // Batch post — standalone invoices post independently, while split invoices
  // are deduplicated by group and posted atomically through post_invoice_group.
  // This preserves partial success across unrelated actions without allowing a
  // single group member to bypass the server's GROUP_POST_REQUIRED guard.
  const handleBatchPost = async () => {
    setShowPostModal(false);
    if (!profile || !canPostInvoices) {
      toast('error', 'Admin or sales access is required to post invoices');
      return;
    }
    const targets = buildInvoicePostTargets(selectedPostable);
    if (targets.length === 0) {
      toast('error', 'No postable invoices selected');
      return;
    }
    await runCriticalAction({
      action: async () => {
        let completedActions = 0;
        const failures: string[] = [];
        const failedIds: string[] = [];
        for (const target of targets) {
          if (!postKeysRef.current[target.key]) {
            postKeysRef.current[target.key] = generateIdempotencyKey(
              target.operation,
              `${profile.id}:${target.scopeId}`,
            );
          }
          try {
            if (target.operation === 'post_invoice_group') {
              const { data, error } = await supabase.rpc('post_invoice_group', {
                p_invoice_group_id: target.invoiceGroupId!,
                p_performed_by: profile.id,
                p_idempotency_key: postKeysRef.current[target.key],
              });
              if (error) throw error;
              assertRpcResult(data, 'post_invoice_group');
            } else {
              // post_invoice RETURNS void — the canonical void-RPC pattern is
              // .throwOnError() with no result capture.
              await supabase.rpc('post_invoice', {
                p_invoice_id: target.invoiceId!,
                p_idempotency_key: postKeysRef.current[target.key],
              }).throwOnError();
            }
            completedActions++;
            delete postKeysRef.current[target.key];
          } catch (err: unknown) {
            failedIds.push(...target.selectedIds);
            const blocked = describePostInvoiceBlock(err);
            if (blocked) {
              failures.push(`${target.label}: ${blocked}`);
            } else {
              failures.push(`${target.label}: ${sanitizeError(err)}`);
            }
          }
        }

        await fetchInvoices();
        if (failures.length > 0) {
          // Leave only failed invoices selected so the next retry is focused and
          // reuses their existing per-invoice idempotency keys.
          setSelected(new Set(failedIds));
          const shown = failures.slice(0, 3).join(' | ');
          const extra = failures.length > 3 ? ` | +${failures.length - 3} more` : '';
          throw new Error(`Completed ${completedActions}/${targets.length} posting action(s). Failed: ${shown}${extra}`);
        }
        setSelected(new Set());
      },
      toast,
      successMessage: 'Posting completed for the selected invoices and full split groups',
      setLoading: setPosting,
      sentryTag: 'batch_post_invoices_client_loop',
    });
  };

  // Batch void
  const handleBatchVoid = async (reason: string) => {
    const ids = selectedVoidable.map((i) => i.id);
    if (ids.length === 0) {
      toast('error', 'No posted invoices selected to void');
      return;
    }

    await runCriticalAction({
      action: async () => {
        const voidKey = batchVoidIdem.getKey();
        const { data, error } = await supabase.rpc('batch_void_invoices', {
          p_invoice_ids: ids,
          p_void_reason: reason,
          p_performed_by: profile?.id,
          p_idempotency_key: voidKey,
        });
        if (error) throw error;
        batchVoidIdem.resetKey();
        return assertRpcResult(data, 'batch_void_invoices');
      },
      toast,
      successMessage: `Voided ${ids.length} invoice(s)`,
      setLoading: setVoiding,
      sentryTag: 'batch_void_invoices',
      onSuccess: () => {
        setSelected(new Set());
        fetchInvoices();
      },
    });
    setShowVoidModal(false);
  };

  // Batch print
  const handleBatchPrint = async (options: InvoicePrintOptions) => {
    setShowBatchPrintDialog(false);
    await runCriticalAction({
      action: async () => {
        // Fetch full data for each selected invoice
        const pdfDataList: InvoicePdfData[] = [];

        for (const inv of selectedInvoices) {
          // Fetch customer details
          const { data: cust, error: custError } = await supabase
            .from('customers')
            .select('billing_address, city, state, zip, account_number, payment_terms')
            .eq('id', inv.customer_id)
            .single();
          if (custError) {
            Sentry.captureException(new Error(`Customer ${inv.customer_id} not found for invoice ${inv.invoice_number}`), { level: 'warning', extra: { context: 'Using defaults for batch statement generation' } });
          }

          // Fetch items with product details
          const { data: items } = await supabase
            .from('invoice_items')
            .select('*, product:products(product_name, epa_registration, product_form)')
            .eq('invoice_id', inv.id)
            .order('sort_order');

          // Fetch shares
          const { data: shares } = await supabase
            .from('invoice_shares')
            .select('*, customer:customers!invoice_shares_customer_id_fkey(farm_name)')
            .eq('invoice_id', inv.id);

          const pdfData: InvoicePdfData = {
            invoice_number: inv.invoice_number,
            invoice_date: inv.invoice_date,
            due_date: inv.due_date || undefined,
            invoice_type: inv.invoice_type || 'chemical_sale',
            status: inv.status || 'draft',
            customer_name: inv.customer_name,
            customer_address: cust?.billing_address || undefined,
            customer_city: cust?.city || undefined,
            customer_state: cust?.state || undefined,
            customer_zip: cust?.zip || undefined,
            account_number: cust?.account_number || undefined,
            payment_terms: inv.payment_terms || cust?.payment_terms || undefined,
            salesman_name: inv.salesman_name || undefined,
            purchase_order_ref: inv.purchase_order_ref || undefined,
            header_notes: inv.header_notes || undefined,
            footer_notes: inv.footer_notes || undefined,
            crop_type: inv.crop_type || undefined,
            field_names: inv.field_names || undefined,
            total_acres: inv.total_acres || undefined,
            applicator_name: inv.applicator_name || undefined,
            vehicle_name: inv.vehicle_name || undefined,
            application_date: inv.application_date || undefined,
            shares: (shares || []).length > 0 ? (shares as Array<{ customer?: { farm_name: string }; split_percentage: number; acres: number; amount_cents: number; price_per_acre_cents: number | null; pricing_note: string | null }>).map(s => ({
              customer_name: s.customer?.farm_name || 'Unknown',
              split_percentage: s.split_percentage,
              acres: s.acres,
              amount_cents: s.amount_cents,
              price_per_acre_cents: s.price_per_acre_cents || null,
              pricing_note: s.pricing_note || null,
            })) : undefined,
            items: groupReturnCreditDisplayItems(inv.invoice_type, ((items || []) as Array<Record<string, unknown> & { product?: { product_name: string; epa_registration?: string | null; product_form?: string | null }; description?: string; quantity?: number; unit_size?: string; unit_price_cents?: number; extended_cents?: number; cost_cents?: number; rate_per_acre?: number | null }>).map((it) => ({
              order_item_id: (it.order_item_id as string) || null,
              product_id: (it.product_id as string) || null,
              description: it.description,
              product_name: it.product?.product_name || it.description,
              quantity: Number(it.quantity),
              unit_size: it.unit_size || undefined,
              unit_price_cents: it.unit_price_cents,
              extended_cents: it.extended_cents,
              cost_cents: it.cost_cents,
              rate_per_acre: it.rate_per_acre ? Number(it.rate_per_acre) : null,
              rate_unit: it.rate_unit || null,
              total_applied: it.total_applied ? Number(it.total_applied) : null,
              total_applied_unit: it.total_applied_unit || null,
              total_applied_gl_lb: it.total_applied_gl_lb ? Number(it.total_applied_gl_lb) : null,
              gl_lb_unit: it.gl_lb_unit || null,
              epa_registration: it.epa_registration || it.product?.epa_registration || null,
              is_application_fee: it.is_application_fee || false,
              product_form: it.product_form || it.product?.product_form || null,
            })) as InvoicePdfItem[]),
            total_amount_cents: inv.total_amount_cents || 0,
            total_cost_cents: inv.total_cost_cents || 0,
            paid_amount_cents: inv.paid_amount_cents || 0,
            prepay_applied_cents: inv.prepay_applied_cents || 0,
            balance_cents: inv.balance_cents || 0,
            options,
          };
          pdfDataList.push(pdfData);
        }

        if (pdfDataList.length === 0) {
          throw new Error('No invoices to print');
        }

        await generateBatchInvoicePdf(pdfDataList);
      },
      toast,
      successMessage: `Printed invoice(s) to PDF`,
      setLoading: setPrinting,
      sentryTag: 'batch_print_invoices',
    });
  };

  const handleBatchDelete = async () => {
    const ids = selectedDeletable.map((i) => i.id);
    if (ids.length === 0) return;
    await runCriticalAction({
      action: async () => {
        // Route through the guarded RPC (admin-only, audited, idempotent) instead
        // of a raw .update({ deleted_at }). See migration delete_invoices.
        const deleteKey = batchDeleteIdem.getKey();
        const { data, error } = await supabase.rpc('delete_invoices', {
          p_invoice_ids: ids,
          p_performed_by: profile?.id,
          p_idempotency_key: deleteKey,
        });
        if (error) throw error;
        batchDeleteIdem.resetKey();
        return assertRpcResult<number>(data, 'delete_invoices');
      },
      toast,
      setLoading: setDeleting,
      sentryTag: 'delete_invoices',
      onSuccess: (deleted) => {
        // delete_invoices skips rows that are no longer deletable (e.g. posted in
        // another tab after this list loaded), returning a smaller count — report
        // the ACTUAL deleted count, not the requested count (Codex P2).
        if (deleted < ids.length) {
          toast('warning', `Deleted ${deleted} of ${ids.length} invoice(s) — the rest were no longer deletable (status changed).`);
        } else {
          toast('success', `Deleted ${deleted} invoice(s)`);
        }
        setSelected(new Set());
        fetchInvoices();
      },
    });
    setShowDeleteModal(false);
  };

  const handleExportPDF = async () => {
    setExportingPdf(true);
    try {
      const rows = selected.size > 0 ? selectedInvoices : filtered;
      await downloadReportPdf({
        title: 'Invoices',
        subtitle: `${rows.length} invoice(s)`,
        columns: [
          { header: 'Invoice #', key: 'invoice_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Type', key: 'invoice_type', format: (v) => {
            const map: Record<string, string> = { chemical_sale: 'Chemical', field_application: 'Application', misc_charge: 'Misc' };
            return map[String(v)] || String(v || '-');
          }},
          { header: 'Date', key: 'invoice_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'Total', key: 'total_amount_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
          { header: 'Balance', key: 'balance_cents', align: 'right', format: (v) => fmt(Number(v) || 0) },
          { header: 'Status', key: 'status' },
        ],
        data: rows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${rows.length} invoice(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExportingPdf(false);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const selectable = filtered.filter((i) => selectableStatuses.includes(i.status));
    if (selected.size === selectable.length && selectable.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((i) => i.id)));
    }
  };

  const columns: Column<InvoiceRow>[] = [
    {
      key: 'id',
      header: '',
      className: 'w-10',
      render: (row) =>
        selectableStatuses.includes(row.status) ? (
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelect(row.id);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
          />
        ) : null,
    },
    {
      key: 'invoice_number',
      header: 'Invoice #',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-crx-green flex-shrink-0" />
          <span className="font-medium text-nav-dark">{row.invoice_number}</span>
          {row.is_quick_delivery && (
            <span title="Quick Delivery"><Zap className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" /></span>
          )}
        </div>
      ),
    },
    {
      key: 'order_number',
      header: 'Order #',
      sortable: true,
      render: (row) =>
        row.order_number && row.order_id ? (
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/orders/${row.order_id}`); }}
            className="text-crx-green hover:underline font-medium"
            title="Open the source order"
          >
            {row.order_number}
          </button>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/customers/${row.customer_id}`);
            }}
            className="text-crx-green hover:underline"
          >
            {row.customer_name}
          </button>
          {row.customer_id && canPeekCustomer && (
            <button
              onClick={(e) => { e.stopPropagation(); setDrawerCustomer({ id: row.customer_id, name: row.customer_name }); }}
              title="Peek customer"
              aria-label={`Peek ${row.customer_name}`}
              className="p-0.5 rounded text-gray-300 hover:text-crx-green hover:bg-crx-green-light transition-colors"
            >
              <PanelRightOpen className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'invoice_type',
      header: 'Type',
      sortable: true,
      render: (row) => typeBadge(row.invoice_type),
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
      key: 'salesman_name',
      header: 'Salesman',
      render: (row) => row.salesman_name || '-',
    },
  ];

  // Determine if batch print dialog needs any shares info
  const anySelectedHasShares = selectedInvoices.some(
    (i) => i.invoice_type === 'field_application'
  );
  // Identical predicate to anySelectedHasShares — reuse the computed value
  // instead of scanning the selection a second time.
  const anySelectedIsFieldApp = anySelectedHasShares;

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
    <div className="space-y-4">
      <PageHeader
        title="Invoices"
        actions={
          <div className="flex gap-2 flex-wrap justify-end">
            {selected.size > 0 && canPostInvoices && (
              <>
                {selectedPostable.length > 0 && (
                  <Button
                    variant="secondary"
                    icon={<Send className="w-4 h-4" />}
                    onClick={() => setShowPostModal(true)}
                    loading={posting}
                  >
                    Post {selectedPostable.length} Selected
                  </Button>
                )}
                {isAdmin && selectedVoidable.length > 0 && (
                  <Button
                    variant="danger"
                    icon={<Ban className="w-4 h-4" />}
                    onClick={() => setShowVoidModal(true)}
                  >
                    Void {selectedVoidable.length} Selected
                  </Button>
                )}
                <Button
                  variant="secondary"
                  icon={<Printer className="w-4 h-4" />}
                  onClick={() => setShowBatchPrintDialog(true)}
                  loading={printing}
                >
                  Print {selected.size} Selected
                </Button>
                <Button
                  variant="secondary"
                  icon={<Mail className="w-4 h-4" />}
                  disabled
                  title="Coming soon — requires email integration"
                >
                  Email
                </Button>
                {isAdmin && selectedDeletable.length > 0 && (
                  <Button
                    variant="danger"
                    icon={<Trash2 className="w-4 h-4" />}
                    onClick={() => setShowDeleteModal(true)}
                  >
                    Delete {selectedDeletable.length}
                  </Button>
                )}
              </>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                exportToCSV(
                  filtered as unknown as Record<string, unknown>[],
                  [
                    { key: 'invoice_number', header: 'Invoice #' },
                    { key: 'customer_name', header: 'Customer' },
                    { key: 'invoice_type', header: 'Type' },
                    { key: 'invoice_date', header: 'Date' },
                    { key: 'total_amount_cents', header: 'Total ($)', format: (v: unknown) => ((Number(v) || 0) / 100).toFixed(2) },
                    { key: 'balance_cents', header: 'Balance ($)', format: (v: unknown) => ((Number(v) || 0) / 100).toFixed(2) },
                    { key: 'status', header: 'Status' },
                  ],
                  'invoices'
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
            <Button variant="secondary" onClick={() => navigate('/invoices/new?type=misc_charge')}>
              Misc Charge
            </Button>
          </div>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          type="button"
          className="w-full text-left"
          onClick={() => setStatusFilter('ready_to_post')}
          aria-label="Show invoices ready to post"
        >
          <Card hover className={statusFilter === 'ready_to_post' ? 'border-amber-400 ring-2 ring-amber-100' : ''}>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                <FileText className="w-5 h-5 text-amber-600" />
              </div>
              <span className="text-sm text-secondary">Unposted</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-amber-600">{unpostedCount}</p>
            <p className="text-xs text-secondary mt-1">invoices awaiting review</p>
          </Card>
        </button>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <Check className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Posted Total</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(postedTotal)}</p>
          <p className="text-xs text-secondary mt-1">
            {invoices.filter((i) => i.status === 'posted').length} posted invoices
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <Ban className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-secondary">Outstanding</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-600">{fmt(outstandingBalance)}</p>
          <p className="text-xs text-secondary mt-1">unpaid balance on posted invoices</p>
        </Card>
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable<InvoiceRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search invoices..."
            searchKeys={['invoice_number', 'customer_name', 'salesman_name']}
            onRowClick={(row) => navigate(`/invoices/${row.id}`)}
            emptyTitle="No invoices yet"
            emptyDescription="Invoices are created from orders or blend tickets — open one to bill."
            emptyAction={
              <Button variant="secondary" icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/orders')}>
                Go to Orders
              </Button>
            }
            loading={loading}
            filters={
              <div className="flex gap-2 items-center">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as InvoiceStatusFilter)}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  aria-label="Filter by type"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setQuickDeliveryOnly((v) => !v)}
                  className={`flex items-center gap-1 px-3 py-2 text-sm border rounded-lg transition-colors ${
                    quickDeliveryOnly
                      ? 'border-amber-400 bg-amber-50 text-amber-700'
                      : 'border-gray-200 text-secondary hover:border-gray-300'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5" />
                  Quick Deliveries
                </button>
                <button
                  onClick={() => setBalanceOnly((v) => !v)}
                  className={`flex items-center gap-1 px-3 py-2 text-sm border rounded-lg transition-colors ${
                    balanceOnly
                      ? 'border-crx-green/50 bg-crx-green-tint text-crx-green'
                      : 'border-gray-200 text-secondary hover:border-gray-300'
                  }`}
                  title="Show only invoices with money still owed"
                >
                  Has a balance
                </button>
                {filtered.some((i) => selectableStatuses.includes(i.status)) && (
                  <button
                    onClick={toggleAll}
                    className="text-xs text-crx-green hover:underline ml-2"
                  >
                    {selected.size > 0 ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>

      {/* Batch Void Modal */}
      <BatchVoidModal
        open={showVoidModal}
        onClose={() => setShowVoidModal(false)}
        count={selectedVoidable.length}
        onConfirm={handleBatchVoid}
        loading={voiding}
      />

      <ConfirmModal
        open={showPostModal}
        onClose={() => setShowPostModal(false)}
        onConfirm={handleBatchPost}
        title="Post Selected Invoices"
        message={postConfirmation.message}
        confirmLabel={postConfirmation.confirmLabel}
        variant="info"
        icon={Send}
        loading={posting}
      />

      {/* Batch Print Dialog */}
      <InvoicePrintDialog
        open={showBatchPrintDialog}
        onClose={() => setShowBatchPrintDialog(false)}
        invoiceType={anySelectedIsFieldApp ? 'field_application' : 'chemical_sale'}
        hasShares={anySelectedHasShares}
        onPrint={handleBatchPrint}
        loading={printing}
      />

      {/* Batch Delete Modal */}
      <BulkDeleteConfirmModal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        count={selectedDeletable.length}
        entityName="invoice"
        onConfirm={handleBatchDelete}
        loading={deleting}
      />

      <CustomerDrawer
        open={canPeekCustomer && !!drawerCustomer}
        customerId={drawerCustomer?.id ?? ''}
        customerName={drawerCustomer?.name ?? ''}
        onClose={() => setDrawerCustomer(null)}
      />
    </div>
  );
}
