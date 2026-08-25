import { useEffect, useState, useMemo , useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { parseLocalDate, localDatePlusDays, localToday } from '../lib/dateUtils';
import { Plus, Upload, Copy, Download, FileText, Trash2, Layers, ChevronDown, ChevronUp, PackageCheck, AlertTriangle } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import BulkQuoteImport from '../components/quotes/BulkQuoteImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { supabase, supabaseUntyped, assertRpcResult, checkMutationResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { convertQuoteToOrderWithRowVersion } from '../lib/quoteLifecycleRpc';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { formatUSD as fmt } from '../lib/money';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { isBelowCostApprovalHandledError, withBelowCostReason } from '../lib/belowCostApproval';
import { Sentry } from '../lib/sentry';
import { SkeletonTable } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import PageHeader from '../components/ui/PageHeader';
import { notifyLargeOrder, notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { sendOrderConfirmedEmail } from '../lib/orderConfirmedEmail';
import { trackBusinessEvent } from '../lib/metrics';
import type { Quote, BookingRolloverRow } from '../types';

const DELETABLE = ['draft', 'sent', 'revised'];

// Row shape with denormalized, searchable strings (F1: search by product/customer).
interface QuoteRow extends Quote {
  customer_name: string;
  product_names: string;
}

export default function Quotes() {
  const navigate = useNavigate();
  const location = useLocation();
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [plannedFilter, setPlannedFilter] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const { toast } = useToast();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const duplicateQuoteIdem = useIdempotencyKey('duplicate_quote', profile?.id || '');
  // F3 act-from-list: convert a sent/revised quote to an order in place (confirm popup).
  const convertQuoteIdem = useIdempotencyKey('convert_quote_to_order', profile?.id || '');
  const [convertTarget, setConvertTarget] = useState<QuoteRow | null>(null);
  const [converting, setConverting] = useState(false);
  // F3 guardrail parity with QuoteBuilder: warn (not block) before the one-click
  // convert if the quote is stale (>30d) or the customer already ordered recently.
  const [convertStaleMsg, setConvertStaleMsg] = useState<string | null>(null);
  const [convertDupMsg, setConvertDupMsg] = useState<string | null>(null);
  // True while the async duplicate-order guard is still running — the modal's
  // Convert button stays disabled until it resolves so a fast click can't bypass
  // the warning before it renders (Codex P2 race).
  const [convertChecking, setConvertChecking] = useState(false);
  // Fire the non-idempotent post-conversion side effects (email/notifications) at
  // most once per order. convert_quote_to_order is idempotent but returns no replay
  // marker, so a same-key retry after a lost response replays status:'created' — the
  // stable order_id is how we avoid duplicate alerts/emails on that replay (Codex P2).
  const firedConvertSideEffects = useRef<Set<string>>(new Set());
  // Monotonic token so an in-flight duplicate-order check from a previous
  // open/close is discarded if the modal is reopened for another quote before it
  // resolves — prevents quote A's warning landing on quote B (Codex P3 stale race).
  const convertReqId = useRef(0);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = profile?.role === 'admin' || profile?.role === 'sales_rep';

  // #6(d-UI): open-booking rollover (season-end roll-up). Lazy-loaded on expand.
  const [showRollover, setShowRollover] = useState(false);
  const [rolloverRows, setRolloverRows] = useState<BookingRolloverRow[]>([]);
  const [rolloverLoading, setRolloverLoading] = useState(false);
  const [rolloverLoaded, setRolloverLoaded] = useState(false);

  const loadRollover = useCallback(async () => {
    setRolloverLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_open_booking_rollover', { p_customer_id: undefined, p_season: undefined });
      if (error) throw error;
      const result = assertRpcResult<{ success: boolean; bookings: BookingRolloverRow[] }>(data, 'get_open_booking_rollover');
      setRolloverRows(result.bookings || []);
      setRolloverLoaded(true);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'get_open_booking_rollover' } });
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) toast('error', 'Only admin or sales can view the booking rollover.');
      else toast('error', sanitizeError(err));
    } finally {
      setRolloverLoading(false);
    }
  }, [toast]);

  const toggleRollover = () => {
    const next = !showRollover;
    setShowRollover(next);
    if (next && !rolloverLoaded) loadRollover();
  };

  // === GAP FIX #7: Duplicate a quote ===
  const handleDuplicate = async (quoteId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const key = duplicateQuoteIdem.getKey();
      const { data: result, error } = await runWithBelowCostApproval((reason) => supabaseUntyped.rpc('duplicate_quote', withBelowCostReason('duplicate_quote', {
        p_source_quote_id: quoteId,
        p_performed_by: profile!.id,
        p_idempotency_key: key,
      }, reason)));
      if (error) {
        toast('error', `Failed to duplicate quote: ${error.message}`);
        return;
      }
      duplicateQuoteIdem.resetKey();
      const dupResult = assertRpcResult<{ quote_id: string; quote_number: string }>(result, 'duplicate_quote');
      toast('success', `Quote duplicated as ${dupResult.quote_number}`);
      navigate(`/quotes/${dupResult.quote_id}`);
    } catch (err: unknown) {
      if (isBelowCostApprovalHandledError(err)) return;
      toast('error', `Failed to duplicate quote: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Open the convert confirm modal, computing QuoteBuilder's two pre-conversion
  // guardrails so they show INSIDE the dialog (warn, don't block — one informed
  // click acknowledges them). The third QuoteBuilder guard (partial draw-down) is
  // already covered server-side: convert_quote_to_order raises BOOKING_PARTIALLY_DRAWN
  // which handleConvertConfirm catches.
  const openConvert = async (row: QuoteRow) => {
    const reqId = ++convertReqId.current;
    convertQuoteIdem.resetKey();
    setConvertTarget(row);
    setConvertChecking(true);
    // Stale-price guard — same 30-day threshold as useStaleQuoteCheck (pure).
    const ageDays = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86_400_000);
    setConvertStaleMsg(ageDays > 30 ? `This quote is ${ageDays} days old - product prices may have changed since it was created.` : null);
    // Duplicate-order guard — same query QuoteBuilder runs (last 7 days, same customer).
    setConvertDupMsg(null);
    try {
      const { data: recent } = await supabase
        .from('orders')
        .select('order_number, order_date')
        .eq('customer_id', row.customer_id)
        .is('deleted_at', null)
        .gte('order_date', localDatePlusDays(-7))
        .order('order_date', { ascending: false })
        .limit(1);
      // Discard if a newer open/close superseded this check (stale-result race).
      if (convertReqId.current !== reqId) return;
      if (recent && recent.length > 0) {
        const daysAgo = Math.max(0, Math.ceil((Date.now() - new Date(recent[0].order_date + 'T00:00:00').getTime()) / 86_400_000));
        setConvertDupMsg(`${row.customer_name || 'This customer'} already has order ${recent[0].order_number} from ${daysAgo} day(s) ago - this would create another.`);
      }
    } catch {
      // Non-blocking — a failed duplicate check must not stop conversion.
    } finally {
      // Only clear the in-flight flag if this is still the active request.
      if (convertReqId.current === reqId) setConvertChecking(false);
    }
  };

  const closeConvert = () => {
    convertReqId.current++; // invalidate any in-flight duplicate-order check
    setConvertTarget(null);
    setConvertStaleMsg(null);
    setConvertDupMsg(null);
    setConvertChecking(false);
  };

  // F3 act-from-list: convert a sent/revised quote to a confirmed order in place.
  // Uses the same atomic RPC QuoteBuilder calls (order + items + prebooking +
  // commissions); the RPC is idempotent + actor-bound and accepts sent/revised
  // directly (status guard allows 'sent','revised','accepted').
  const handleConvertConfirm = async () => {
    if (!convertTarget || !profile) return;
    setConverting(true);
    try {
      const idemKey = convertQuoteIdem.getKey();
      const { data, error } = await runWithBelowCostApproval((reason) => convertQuoteToOrderWithRowVersion(
        withBelowCostReason('convert_quote_to_order', {
          p_quote_id: convertTarget.id,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
          p_expected_row_version: convertTarget.row_version ?? null,
        }, reason),
      ));
      if (error) throw error;
      convertQuoteIdem.resetKey();
      const result = data;
      if (result.status === 'already_converted') {
        toast('info', 'This booking was already converted — opening the order.');
      } else {
        toast('success', `Order ${result.order_number || ''} created`);
      }
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => toast('warning', `Inventory: ${w}`));
      }
      // Mirror QuoteBuilder's post-conversion side effects (Codex P2): orders are
      // born 'confirmed' with no later transition to gate on, so the creation site
      // is the ONLY place these fire. Run once per order_id — skips both an
      // 'already_converted' result AND a same-key idempotency replay (which returns
      // the cached status:'created' for the same order_id).
      if (result.status !== 'already_converted' && result.order_id && !firedConvertSideEffects.current.has(result.order_id)) {
        firedConvertSideEffects.current.add(result.order_id);
        trackBusinessEvent('quote_converted_to_order', {
          message: `Quote converted → Order ${result.order_number || ''}`,
          data: { orderId: result.order_id, orderNumber: result.order_number ?? '', quoteId: convertTarget.id },
        });
        // Customer "Order Confirmed" email — fire-and-forget, swallows its own errors.
        sendOrderConfirmedEmail(result.order_id);
        // Large-order admin alert (self-guards under its $50k threshold).
        notifyLargeOrder(result.order_id, result.order_number || '', convertTarget.customer_name || 'customer', convertTarget.total_price || 0);
        // Credit-limit warning — non-blocking, must not prevent navigation.
        try {
          const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', { p_customer_id: convertTarget.customer_id });
          const cl = assertRpcResult<{ exceeded?: boolean; outstanding_ar?: number; credit_limit?: number } | null>(creditCheck, 'check_customer_credit_limit');
          if (cl && cl.exceeded) {
            const fmtCl = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
            toast('warning', `Credit limit warning: ${convertTarget.customer_name || 'Customer'} outstanding AR ${fmtCl(cl.outstanding_ar ?? 0)} exceeds limit ${fmtCl(cl.credit_limit ?? 0)}`);
            notifyCreditLimitExceeded(convertTarget.customer_name || 'Customer', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, convertTarget.customer_id);
          }
        } catch {
          // Non-blocking — credit limit check should not prevent navigation.
        }
      }
      closeConvert();
      if (result.order_id) navigate(`/orders/${result.order_id}`);
      else fetchQuotes();
    } catch (err: unknown) {
      if (isBelowCostApprovalHandledError(err)) return;
      if (hasRpcCode(err, RpcErrorCodes.BOOKING_PARTIALLY_DRAWN)) {
        toast('warning', 'This booking has partial draw-downs — draw the remaining balance from the quote instead of converting.');
      } else if (hasRpcCode(err, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('error', 'This booking is closed — only sent or revised quotes can be converted.');
      } else if (hasRpcCode(err, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        convertQuoteIdem.resetKey();
        closeConvert();
        await fetchQuotes();
        toast('warning', 'This quote changed before conversion. Review the refreshed quote before trying again.');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'convert_quote_to_order' } });
        toast('error', sanitizeError(err));
      }
    } finally {
      setConverting(false);
    }
  };

  const fetchQuotes = useCallback(async () => {
    const { data, error } = await supabase
      .from('quotes')
      .select('*, customer:customers(farm_name)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_quotes' } });
      toast('error', 'Failed to load quotes. Please try again.');
      setLoading(false);
      return;
    }

    // Seed rows with searchable strings; customer name is denormalized off the join.
    const quoteList: QuoteRow[] = (data || []).map((q) => ({
      ...(q as Quote),
      customer_name: (q as { customer?: { farm_name?: string } | null }).customer?.farm_name || '',
      product_names: '',
    }));

    // quote_items only carries product_id, so join through products for the name (F1: search by product).
    const quoteIds = quoteList.map((q) => q.id);
    if (quoteIds.length > 0) {
      const { data: itemRows, error: itemErr } = await supabase
        .from('quote_items')
        .select('quote_id, product_id')
        .in('quote_id', quoteIds);
      if (itemErr) {
        Sentry.captureException(itemErr, { tags: { source: 'fetch', action: 'load_quote_items' } });
      } else if (itemRows && itemRows.length > 0) {
        const productIds = [...new Set(itemRows.map((r) => r.product_id).filter(Boolean) as string[])];
        const { data: prodRows } = await supabase
          .from('products')
          .select('id, product_name')
          .in('id', productIds.length > 0 ? productIds : ['__none__']);
        const nameById: Record<string, string> = {};
        (prodRows || []).forEach((p) => { nameById[p.id] = p.product_name; });
        const namesByQuote: Record<string, Set<string>> = {};
        itemRows.forEach((r) => {
          const nm = r.product_id ? nameById[r.product_id] : undefined;
          if (nm) (namesByQuote[r.quote_id] ??= new Set()).add(nm);
        });
        quoteList.forEach((q) => {
          q.product_names = Array.from(namesByQuote[q.id] || []).join(', ');
        });
      }
    }

    setQuotes(quoteList);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchQuotes();
    // Support ?filter=planned from dashboard alert link
    const params = new URLSearchParams(location.search);
    if (params.get('filter') === 'planned') setPlannedFilter(true);
  }, [fetchQuotes, location.search]);

  const filtered = quotes.filter((q) => {
    if (plannedFilter && !q.is_planned) return false;
    if (statusFilter && q.status !== statusFilter) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (q) => q.id,
      isSelectable: (q) => DELETABLE.includes(q.status),
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<QuoteRow>(selected, toggleSelect, (q) => q.id, (q) => DELETABLE.includes(q.status)),
    [selected, toggleSelect]
  );

  // ─── Bulk action handlers ───────────────────────────────────
  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'quote_number', header: 'Quote #' },
      { key: 'customer', header: 'Customer', format: (v) => {
        const c = v as { farm_name?: string } | undefined;
        return c?.farm_name || '-';
      }},
      { key: 'status', header: 'Status' },
      { key: 'tier', header: 'Tier' },
      { key: 'total_price', header: 'Total', format: (v) => fmtCSV(v as number) },
      { key: 'created_at', header: 'Created', format: (v) => fmtDateCSV(v as string) },
      { key: 'expires_at', header: 'Expires', format: (v) => fmtDateCSV(v as string) },
    ], 'quotes');
    toast('success', `Exported ${selectedRows.length} quote(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Quote #', key: 'quote_number' },
        { header: 'Customer', key: 'customer', format: (v) => {
          const c = v as { farm_name?: string } | undefined;
          return c?.farm_name || '-';
        }},
        { header: 'Status', key: 'status' },
        { header: 'Tier', key: 'tier', format: (v) => `Tier ${v}` },
        { header: 'Total', key: 'total_price', align: 'right', format: (v) => fmt(Number(v)) },
        { header: 'Created', key: 'created_at', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
        { header: 'Expires', key: 'expires_at', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
      ];
      await downloadReportPdf({
        title: 'Quotes',
        subtitle: `${selectedRows.length} quote(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} quote(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      let ids = selectedRows.map((q) => q.id);
      // Open bookings with partial draw-downs must not be soft-deleted:
      // deletion changes no status, so the hold-release trigger never fires —
      // the booking's reserved inventory would stay held on a hidden quote.
      // Layer 2 (§6.5 / Codex round-5 P2): a job reservation is a SECOND draw ledger
      // (job_product_draws) and the FK only cascades on HARD deletes, so a quote with
      // a live job draw must be skipped here too — else it's hidden while its booking
      // stays consumed by a schedulable/invoiceable job.
      const [orderDrawnRes, jobDrawnRes] = await Promise.all([
        supabase.from('quote_product_draws').select('quote_id').in('quote_id', ids).gt('quantity_drawn', 0),
        supabaseUntyped.from('job_product_draws').select('quote_id').in('quote_id', ids).gt('quantity_drawn', 0),
      ]);
      if (orderDrawnRes.error) throw orderDrawnRes.error;
      if (jobDrawnRes.error) throw jobDrawnRes.error;
      const drawnIds = new Set<string>([
        ...(orderDrawnRes.data || []).map((d) => d.quote_id),
        ...(jobDrawnRes.data || []).map((d: { quote_id: string }) => d.quote_id),
      ]);
      if (drawnIds.size > 0) {
        const blocked = selectedRows.filter((q) => drawnIds.has(q.id));
        toast('warning', `${blocked.length} booking(s) with draw-downs or job reservations skipped — close the booking (draw/cancel the remainder or the job) before deleting: ${blocked.map((q) => q.quote_number).join(', ')}`);
        ids = ids.filter((id) => !drawnIds.has(id));
        if (ids.length === 0) {
          setDeleting(false);
          setDeleteModalOpen(false);
          return;
        }
      }
      const result = await supabase
        .from('quotes')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids)
        .select();
      checkMutationResult(result, 'Delete quotes');
      toast('success', `Deleted ${ids.length} quote(s)`);
      clearSelection();
      fetchQuotes();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete Quotes', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<QuoteRow>[] = [
    {
      key: 'quote_number',
      header: 'Quote #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.quote_number}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (row.customer as unknown as { farm_name: string })?.farm_name || '-',
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <>
          <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
            {row.status === 'closed_by_application' ? 'Fulfilled (Applied)' : row.status === 'closed_short' ? 'Closed — Short' : row.status.replace('_', ' ')}
          </Badge>
          {row.is_planned && (
            <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 rounded">
              Planned
            </span>
          )}
        </>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortable: true,
      render: (row) => <span>Tier {row.tier}</span>,
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_price)}</span>,
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (row) => new Date(row.created_at).toLocaleDateString(),
    },
    {
      key: 'expires_at',
      header: 'Expires',
      sortable: true,
      render: (row) => {
        if (!row.expires_at) return '-';
        const isPastDue = (row.status === 'sent' || row.status === 'revised') && row.expires_at.slice(0, 10) < localToday();
        const date = parseLocalDate(row.expires_at).toLocaleDateString();
        return isPastDue ? (
          <span className="text-red-600 font-medium">{date} (past due)</span>
        ) : date;
      },
    },
    {
      key: 'id',
      header: '',
      render: (row) => (
        <div className="flex items-center gap-1">
          {(row.status === 'sent' || row.status === 'revised') && (
            <button
              onClick={(e) => { e.stopPropagation(); openConvert(row); }}
              className="p-1.5 rounded-lg text-gray-400 hover:text-crx-green hover:bg-crx-green-light transition-colors"
              title="Convert to order"
              aria-label={`Convert quote ${row.quote_number} to an order`}
            >
              <PackageCheck className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => handleDuplicate(row.id, e)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-crx-green hover:bg-crx-green-light transition-colors"
            title="Duplicate this quote"
            aria-label="Duplicate this quote"
          >
            <Copy className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quotes"
        actions={
          <>
            {canBulkAction && (
              <BulkActionBar
                selectedCount={selectedCount}
                actions={bulkActions}
                onDeselectAll={clearSelection}
              />
            )}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                icon={<Upload className="w-4 h-4" />}
                onClick={() => setImportModalOpen(true)}
              >
                Bulk Import
              </Button>
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                New Quote
              </Button>
            </div>
          </>
        }
      />

      <BulkQuoteImport
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchQuotes}
      />

      {canBulkAction && (
        <Card padding={false}>
          <div className="p-5">
            <button onClick={toggleRollover} className="w-full flex items-center justify-between text-left">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5 text-crx-green" />
                <h3 className="font-semibold text-nav-dark">Open booking rollover</h3>
                <HelpTip text="Every open booking (sent/revised quote) with its booked / drawn / remaining value. Use it at season-end to see what's still outstanding. (Prepay-earmarked columns return when the booking-prepay engine ships.)" className="ml-1" />
              </div>
              {showRollover ? <ChevronUp className="w-4 h-4 text-secondary" /> : <ChevronDown className="w-4 h-4 text-secondary" />}
            </button>
            {showRollover && (
              <div className="mt-4 overflow-x-auto">
                {rolloverLoading ? (
                  <p className="text-sm text-secondary">Loading…</p>
                ) : rolloverRows.length === 0 ? (
                  <p className="text-sm text-secondary">No open bookings.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-secondary">
                        <th className="px-3 py-2 text-left font-medium">Customer</th>
                        <th className="px-3 py-2 text-left font-medium">Booking</th>
                        <th className="px-3 py-2 text-right font-medium">Booked</th>
                        <th className="px-3 py-2 text-right font-medium">Drawn</th>
                        <th className="px-3 py-2 text-right font-medium">Remaining</th>
                        {/* Prepaid column hidden while no booking has earmarked prepay — the
                            earmark engine is shelved (docs/roadmap/shelved-earmark-engine/),
                            so this is 0 for now and returns automatically when the engine ships. */}
                        {rolloverRows.some((b) => (b.prepay_remaining_cents ?? 0) > 0 || (b.prepay_earmarked_cents ?? 0) > 0) && (
                          <th className="px-3 py-2 text-right font-medium">Prepaid left</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {rolloverRows.map((b) => (
                        <tr
                          key={b.quote_id}
                          className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer"
                          onClick={() => navigate(`/quotes/${b.quote_id}`)}
                        >
                          <td className="px-3 py-2">{b.customer_name || '—'}</td>
                          <td className="px-3 py-2 font-medium text-crx-green">{b.quote_number}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmt(b.booked_cents / 100)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmt(b.drawn_cents / 100)}</td>
                          <td className="px-3 py-2 text-right font-mono">{fmt(b.remaining_cents / 100)}</td>
                          {rolloverRows.some((r) => (r.prepay_remaining_cents ?? 0) > 0 || (r.prepay_earmarked_cents ?? 0) > 0) && (
                            <td className="px-3 py-2 text-right font-mono text-crx-green">{fmt(b.prepay_remaining_cents / 100)}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      <Card padding={false}>
        <div className="p-5">
          <DataTable<QuoteRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search quotes, customers, or products…"
            searchKeys={['quote_number', 'customer_name', 'product_names']}
            onRowClick={(row) => navigate(`/quotes/${row.id}`)}
            emptyTitle="No quotes yet"
            emptyDescription="Quotes are the first step — build a quote, send it to your customer, then convert it to an order."
            emptyAction={
              <Button icon={<FileText className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                Create Your First Quote
              </Button>
            }
            loading={loading}
            filters={
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by quote status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="draft">Draft</option>
                  <option value="sent">Sent</option>
                  <option value="revised">Revised</option>
                  <option value="accepted">Accepted</option>
                  <option value="declined">Declined</option>
                  <option value="expired">Expired</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="closed_by_application">Fulfilled (Applied)</option>
                  <option value="closed_short">{'Closed — Short'}</option>
                </select>
                <button
                  onClick={() => setPlannedFilter(!plannedFilter)}
                  className={`px-3 py-2 text-sm rounded-lg transition-colors ${plannedFilter ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'border border-gray-200 text-secondary hover:bg-gray-50'}`}
                >
                  Planned Programs
                </button>
                <HelpTip text="Planned quotes reserve inventory but aren't committed orders yet. Use the Planned Programs filter to see all of them." className="ml-1" />
                {(statusFilter || plannedFilter) && (
                  <button
                    onClick={() => { setStatusFilter(''); setPlannedFilter(false); }}
                    className="text-xs text-crx-green hover:underline"
                  >
                    Clear
                  </button>
                )}
                {canBulkAction && filtered.length > 0 && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="quote"
        onConfirm={handleDelete}
        loading={deleting}
      />

      <ConfirmModal
        open={!!convertTarget}
        onClose={closeConvert}
        onConfirm={handleConvertConfirm}
        title="Convert to Order?"
        message={
          convertTarget
            ? [
                `Create a confirmed order from quote ${convertTarget.quote_number} for ${convertTarget.customer_name || 'this customer'}? This reserves inventory (holds → prebooked) and can't be undone from here.`,
                convertStaleMsg ? `Heads up: ${convertStaleMsg}` : '',
                convertDupMsg ? `Heads up: ${convertDupMsg}` : '',
              ].filter(Boolean).join('  ')
            : ''
        }
        confirmLabel={convertChecking ? 'Checking...' : (convertStaleMsg || convertDupMsg ? 'Convert Anyway' : 'Convert to Order')}
        variant={convertStaleMsg || convertDupMsg ? 'warning' : 'info'}
        icon={convertStaleMsg || convertDupMsg ? AlertTriangle : PackageCheck}
        loading={converting || convertChecking}
      />
    </div>
  );
}
