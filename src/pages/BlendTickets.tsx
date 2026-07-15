import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Upload, Search, CheckCircle, Clock, AlertCircle, XCircle, X, Plus, LinkIcon, Download, Trash2 } from 'lucide-react';
import { supabase, checkMutationResult, assertRpcResult } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { logActivity } from '../lib/activityLogger';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useOCRProcessor } from '../hooks/useOCRProcessor';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import { BulkTicketUpload } from '../components/blendtickets/BulkTicketUpload';
import { ManualTicketCreate } from '../components/blendtickets/ManualTicketCreate';
import DataTable, { type Column } from '../components/ui/DataTable';
import PageHeader from '../components/ui/PageHeader';
import { usePageMeta } from '../hooks/usePageMeta';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { Sentry } from '../lib/sentry';
import { useToast } from '../components/ui/Toast';
import { parseLocalDate } from '../lib/dateUtils';
import { useOCRThresholds } from '../hooks/useOCRThresholds';
import type { BlendTicket, Customer } from '../types';

export function BlendTickets() {
  usePageMeta();
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const ocrThresholds = useOCRThresholds();
  const [tickets, setTickets] = useState<BlendTicket[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [showManualCreate, setShowManualCreate] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [reviewFilter, setReviewFilter] = useState<string>('all');
  const [linkFilter, setLinkFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<string>('all');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [batchApproveModalOpen, setBatchApproveModalOpen] = useState(false);
  const [batchApproving, setBatchApproving] = useState(false);
  const [batchRejectModalOpen, setBatchRejectModalOpen] = useState(false);
  const [batchRejecting, setBatchRejecting] = useState(false);

  const batchApproveIdem = useIdempotencyKey('batch_approve_blend_tickets', profile?.id || '');
  const batchRejectIdem = useIdempotencyKey('batch_reject_blend_tickets', profile?.id || '');

  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const { isProcessing, processedCount } = useOCRProcessor(true);

  const loadData = useCallback(async () => {
    try {
      const [ticketsResult, customersResult] = await Promise.all([
        // PR-07 follow-up: dropped uploader/reviewer/salesman FK embeds;
        // also dropped the email field — UI only renders uploader.full_name
        // (line ~437) so PII is unused on this page. Resolved via
        // profile_public_view post-fetch below.
        supabase
          .from('blend_tickets')
          .select(`
            *,
            customer:customers(id, farm_name),
            field:fields(id, field_name),
            images:blend_ticket_images(count)
          `)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('customers')
          .select('*')
          .eq('is_active', true)
          .order('farm_name')
          .limit(500)
      ]);

      if (ticketsResult.error) throw ticketsResult.error;
      if (customersResult.error) throw customersResult.error;

      const ticketRows = (ticketsResult.data || []) as Array<
        Omit<BlendTicket, 'customer' | 'field' | 'images'> & {
          uploaded_by?: string | null;
          reviewed_by?: string | null;
          salesman_id?: string | null;
          customer?: { id: string; farm_name: string } | null;
          field?: { id: string; field_name: string } | null;
          images?: { count: number }[];
        }
      >;
      const profIds = [...new Set([
        ...ticketRows.map((t) => t.uploaded_by),
        ...ticketRows.map((t) => t.reviewed_by),
        ...ticketRows.map((t) => t.salesman_id),
      ].filter(Boolean) as string[])];
      const profMap: Record<string, { id: string; full_name: string }> = {};
      if (profIds.length > 0) {
        const { data: profRows } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', profIds);
        ((profRows || []) as { id: string; full_name: string }[]).forEach((p) => {
          profMap[p.id] = p;
        });
      }
      const enriched: BlendTicket[] = ticketRows.map((t) => ({
        ...t,
        uploader: t.uploaded_by ? profMap[t.uploaded_by] || null : null,
        reviewer: t.reviewed_by ? profMap[t.reviewed_by] || null : null,
        salesman: t.salesman_id ? profMap[t.salesman_id] || null : null,
      })) as BlendTicket[];

      setTickets(enriched);
      setCustomers((customersResult.data || []) as Customer[]);
    } catch (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_blend_tickets' } });
      toast('error', 'Failed to load blend tickets. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [processedCount, loadData]);

  const filteredTickets = tickets.filter(ticket => {
    const matchesSearch =
      ticket.ticket_number.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ticket.customer?.farm_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ticket.driver_name?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' || ticket.status === statusFilter;
    const matchesReview = reviewFilter === 'all' || ticket.review_status === reviewFilter;
    const matchesLink = linkFilter === 'all' || ticket.order_link_status === linkFilter;
    const matchesPayment = paymentFilter === 'all' || ticket.payment_status === paymentFilter;

    return matchesSearch && matchesStatus && matchesReview && matchesLink && matchesPayment;
  });

  // E6: Detect duplicate ticket numbers across all tickets
  const duplicateTicketNumbers = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tickets) {
      if (t.ticket_number) counts[t.ticket_number] = (counts[t.ticket_number] || 0) + 1;
    }
    return new Set(Object.entries(counts).filter(([, c]) => c > 1).map(([num]) => num));
  }, [tickets]);

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filteredTickets,
      getId: (t) => t.id,
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<BlendTicket>(selected, toggleSelect, (t) => t.id),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'ticket_number', header: 'Ticket #' },
      { key: 'customer', header: 'Customer', format: (v) => {
        const c = v as { farm_name?: string } | undefined;
        return c?.farm_name || '-';
      }},
      { key: 'ticket_date', header: 'Date', format: (v) => fmtDateCSV(v as string) },
      { key: 'driver_name', header: 'Driver' },
      { key: 'status', header: 'Status' },
      { key: 'review_status', header: 'Review' },
      { key: 'order_link_status', header: 'Order Link' },
      { key: 'payment_status', header: 'Payment' },
      { key: 'ocr_confidence_score', header: 'Confidence %' },
    ], 'blend_tickets');
    toast('success', `Exported ${selectedRows.length} ticket(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Ticket #', key: 'ticket_number' },
        { header: 'Customer', key: 'customer', format: (v) => {
          const c = v as { farm_name?: string } | undefined;
          return c?.farm_name || '-';
        }},
        { header: 'Date', key: 'ticket_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
        { header: 'Driver', key: 'driver_name', format: (v) => String(v || '-') },
        { header: 'Status', key: 'status' },
        { header: 'Review', key: 'review_status' },
        { header: 'Payment', key: 'payment_status' },
        { header: 'Confidence', key: 'ocr_confidence_score', align: 'right', format: (v) => `${v}%` },
      ];
      await downloadReportPdf({
        title: 'Blend Tickets',
        subtitle: `${selectedRows.length} ticket(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} ticket(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDelete = async () => {
    const lifecycleLocked = selectedRows.filter((ticket) =>
      ticket.order_link_status === 'linked' ||
      ticket.payment_status === 'billed' ||
      ticket.status === 'pending' ||
      ticket.status === 'processing'
    );
    if (lifecycleLocked.length > 0) {
      toast('error', 'Unlink, unbill, and finish OCR before deleting the selected blend tickets.');
      setDeleteModalOpen(false);
      return;
    }
    setDeleting(true);
    try {
      const ids = selectedRows.map((t) => t.id);
      const { data: applicationRecords, error: applicationRecordsError } = await supabase
        .from('application_records')
        .select('source_id')
        .eq('source_type', 'blend_ticket')
        .in('source_id', ids)
        .limit(1);
      if (applicationRecordsError) throw applicationRecordsError;
      if (applicationRecords?.length) {
        toast(
          'error',
          'Reverse the application records linked to the selected blend tickets before deleting them.'
        );
        return;
      }

      const result = await supabase
        .from('blend_tickets')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids)
        .select();
      checkMutationResult(result, 'Delete blend tickets');
      toast('success', `Deleted ${ids.length} ticket(s)`);
      clearSelection();
      loadData();
    } catch (err) {
      toast('error', sanitizeError(err));
    } finally {
      setDeleting(false);
      setDeleteModalOpen(false);
    }
  };

  // Only tickets that are completed + unreviewed are eligible for batch approve
  const approvableIds = selectedRows
    .filter((t) => t.status === 'completed' && t.review_status === 'unreviewed')
    .map((t) => t.id);
  const hasLifecycleLockedDelete = selectedRows.some((ticket) =>
    ticket.order_link_status === 'linked' ||
    ticket.payment_status === 'billed' ||
    ticket.status === 'pending' ||
    ticket.status === 'processing'
  );

  // Codex P2 fix (PR #59, 2026-05-16): reset batch idempotency keys when the
  // approvable selection changes. Page-scoped keys would otherwise carry over
  // across submits — if batch-approve A succeeded but the response was lost,
  // the next batch-approve with a different selection would replay A's
  // cached success without approving the new tickets. Hashing the sorted
  // IDs detects intent changes; identical retries still reuse the key.
  const approvableKey = approvableIds.slice().sort().join(',');
  useEffect(() => {
    batchApproveIdem.resetKey();
    batchRejectIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvableKey]);

  const handleBatchApprove = async () => {
    if (!profile?.id || approvableIds.length === 0) return;
    setBatchApproving(true);
    try {
      const key = batchApproveIdem.getKey();
      const { data, error } = await supabase.rpc('batch_approve_blend_tickets', {
        p_ticket_ids: approvableIds,
        p_approved_by: profile.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      const approved = assertRpcResult<{ approved_count?: number }>(data, 'batch_approve_blend_tickets');
      const approvedCount = approved?.approved_count ?? approvableIds.length;
      batchApproveIdem.resetKey();
      toast('success', `Approved ${approvedCount} blend ticket(s)`);
      await logActivity({
        event: 'blend_ticket_batch_approved',
        description: `Batch approved ${approvedCount} blend tickets`,
        performedBy: profile.id,
        entityType: 'blend_ticket',
      });
      clearSelection();
      loadData();
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'action', action: 'batch_approve_blend_tickets' } });
      toast('error', sanitizeError(err));
    }
    setBatchApproving(false);
    setBatchApproveModalOpen(false);
  };

  const handleBatchReject = async () => {
    if (!profile?.id || approvableIds.length === 0) return;
    setBatchRejecting(true);
    try {
      const key = batchRejectIdem.getKey();
      const { data, error } = await supabase.rpc('batch_reject_blend_tickets', {
        p_ticket_ids: approvableIds,
        p_rejected_by: profile.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      const rejected = assertRpcResult<{ rejected_count?: number }>(data, 'batch_reject_blend_tickets');
      const rejectedCount = rejected?.rejected_count ?? approvableIds.length;
      batchRejectIdem.resetKey();
      toast('success', `Rejected ${rejectedCount} blend ticket(s)`);
      await logActivity({
        event: 'blend_ticket_batch_rejected',
        description: `Batch rejected ${rejectedCount} blend tickets`,
        performedBy: profile.id,
        entityType: 'blend_ticket',
      });
      clearSelection();
      loadData();
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'action', action: 'batch_reject_blend_tickets' } });
      toast('error', sanitizeError(err));
    }
    setBatchRejecting(false);
    setBatchRejectModalOpen(false);
  };

  const bulkActions = [
    ...(approvableIds.length > 0
      ? [
          {
            key: 'batch-approve',
            label: `Batch Approve (${approvableIds.length})`,
            icon: <CheckCircle className="w-4 h-4" />,
            onClick: () => setBatchApproveModalOpen(true),
            loading: batchApproving,
          },
          {
            key: 'batch-reject',
            label: `Batch Reject (${approvableIds.length})`,
            icon: <XCircle className="w-4 h-4" />,
            onClick: () => setBatchRejectModalOpen(true),
            loading: batchRejecting,
            variant: 'danger' as const,
          },
        ]
      : []),
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    {
      key: 'delete',
      label: 'Delete Tickets',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setDeleteModalOpen(true),
      variant: 'danger' as const,
      disabled: hasLifecycleLockedDelete,
    },
  ];

  function getStatusBadge(status: string) {
    const variants: Record<string, { variant: 'default' | 'warning' | 'success' | 'error'; icon: typeof Clock }> = {
      pending: { variant: 'default', icon: Clock },
      processing: { variant: 'warning', icon: Clock },
      completed: { variant: 'success', icon: CheckCircle },
      failed: { variant: 'error', icon: XCircle },
      needs_review: { variant: 'warning', icon: AlertCircle },
    };

    const config = variants[status] || variants.pending;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant}>
        <Icon className="h-3 w-3" />
        {status.replace('_', ' ')}
      </Badge>
    );
  }

  function getReviewBadge(reviewStatus: string) {
    const variants: Record<string, 'default' | 'success' | 'error'> = {
      unreviewed: 'default',
      approved: 'success',
      rejected: 'error',
    };

    return (
      <Badge variant={variants[reviewStatus] || 'default'}>
        {reviewStatus}
      </Badge>
    );
  }

  const dataColumns: Column<BlendTicket>[] = [
    {
      key: 'ticket_number',
      header: 'Ticket #',
      render: (ticket: BlendTicket) => (
        <span className="flex items-center gap-1.5">
          <Link
            to={`/blend-tickets/${ticket.id}`}
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            {ticket.ticket_number}
          </Link>
          {duplicateTicketNumbers.has(ticket.ticket_number) && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded bg-yellow-100 text-yellow-700" title="Duplicate ticket number detected">
              Dup
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (ticket: BlendTicket) => (
        <span>{ticket.customer?.farm_name || '-'}</span>
      ),
    },
    {
      key: 'ticket_date',
      header: 'Date',
      render: (ticket: BlendTicket) => (
        <span>
          {ticket.ticket_date
            ? parseLocalDate(ticket.ticket_date).toLocaleDateString()
            : '-'}
        </span>
      ),
    },
    {
      key: 'driver_name',
      header: 'Driver',
      render: (ticket: BlendTicket) => (
        <span>{ticket.driver_name || '-'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (ticket: BlendTicket) => getStatusBadge(ticket.status),
    },
    {
      key: 'review_status',
      header: 'Review',
      render: (ticket: BlendTicket) => getReviewBadge(ticket.review_status),
    },
    {
      key: 'order_link_status',
      header: 'Order Link',
      render: (ticket: BlendTicket) => (
        <Badge variant={ticket.order_link_status === 'linked' ? 'success' : 'default'}>
          {ticket.order_link_status === 'linked' ? (
            <><LinkIcon className="h-3 w-3" /> Linked</>
          ) : (
            'Unlinked'
          )}
        </Badge>
      ),
    },
    {
      key: 'payment_status',
      header: 'Payment',
      render: (ticket: BlendTicket) => {
        const map: Record<string, { variant: 'default' | 'success' | 'info' | 'warning'; label: string }> = {
          unbilled: { variant: 'default', label: 'Unbilled' },
          billed: { variant: 'success', label: 'Billed' },
          prepaid: { variant: 'info', label: 'Prepaid' },
          no_charge: { variant: 'warning', label: 'No Charge' },
        };
        const cfg = map[ticket.payment_status] || map.unbilled;
        return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
      },
    },
    {
      key: 'ocr_confidence_score',
      header: 'Confidence',
      render: (ticket: BlendTicket) => (
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-gray-200 rounded-full h-2 max-w-[80px]">
            <div
              className={`h-2 rounded-full ${
                ticket.ocr_confidence_score >= ocrThresholds.auto_approve
                  ? 'bg-green-500'
                  : ticket.ocr_confidence_score >= ocrThresholds.needs_review
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
              }`}
              style={{ width: `${ticket.ocr_confidence_score}%` }}
            />
          </div>
          <span className="text-sm text-gray-600 min-w-[40px]">
            {ticket.ocr_confidence_score}%
          </span>
        </div>
      ),
    },
    {
      key: 'uploaded_by',
      header: 'Uploaded By',
      render: (ticket: BlendTicket) => (
        <span className="text-sm">{ticket.uploader?.full_name || '-'}</span>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Blend"
        accent="Tickets"
        subtitle="Upload and manage blend ticket images with automatic OCR processing"
        actions={(
          <>
          {canBulkAction && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
          <div className="flex items-center gap-3">
          {isProcessing && (
            <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 px-3 py-2 rounded-lg">
              <Clock className="h-4 w-4 animate-spin" />
              Processing tickets...
            </div>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setShowManualCreate(!showManualCreate);
              if (!showManualCreate) setShowUpload(false);
            }}
          >
            <Plus className="h-4 w-4" />
            {showManualCreate ? 'Hide Manual' : 'Create Manual'}
          </Button>
          <Button
            onClick={() => {
              setShowUpload(!showUpload);
              if (!showUpload) setShowManualCreate(false);
            }}
          >
            <Upload className="h-4 w-4" />
            {showUpload ? 'Hide Upload' : 'Upload Tickets'}
          </Button>
          </div>
          </>
        )}
      />

      {showUpload && (
        <BulkTicketUpload
          customers={customers}
          onUploadComplete={() => {
            setShowUpload(false);
            loadData();
          }}
        />
      )}

      {showManualCreate && (
        <ManualTicketCreate
          customers={customers}
          onComplete={() => {
            setShowManualCreate(false);
            loadData();
          }}
        />
      )}

      {/* E9: Quick filter chips */}
      <div className="flex flex-wrap gap-2">
        {(() => {
          const needsReviewCount = tickets.filter(t => t.status === 'completed' && t.review_status === 'unreviewed').length;
          const lowConfidenceCount = tickets.filter(t => t.ocr_confidence_score > 0 && t.ocr_confidence_score < ocrThresholds.needs_review).length;
          const dupeCount = tickets.filter(t => duplicateTicketNumbers.has(t.ticket_number)).length;
          return (
            <>
              {needsReviewCount > 0 && (
                <button
                  onClick={() => { setStatusFilter('completed'); setReviewFilter('unreviewed'); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                    statusFilter === 'completed' && reviewFilter === 'unreviewed'
                      ? 'bg-amber-200 text-amber-900'
                      : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                  }`}
                >
                  <AlertCircle className="w-3 h-3" />
                  Needs Review ({needsReviewCount})
                </button>
              )}
              {lowConfidenceCount > 0 && (
                <button
                  onClick={() => { setStatusFilter('all'); setReviewFilter('all'); setSearchTerm(''); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
                  title="Tickets with OCR confidence below review threshold"
                >
                  Low Confidence ({lowConfidenceCount})
                </button>
              )}
              {dupeCount > 0 && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-yellow-50 text-yellow-700 hover:bg-yellow-100 transition-colors"
                  title="Tickets with duplicate ticket numbers"
                >
                  Duplicates ({dupeCount})
                </button>
              )}
              {(statusFilter !== 'all' || reviewFilter !== 'all' || linkFilter !== 'all' || paymentFilter !== 'all') && (
                <button
                  onClick={() => { setStatusFilter('all'); setReviewFilter('all'); setLinkFilter('all'); setPaymentFilter('all'); setSearchTerm(''); }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium text-gray-500 hover:bg-gray-100 transition-colors"
                >
                  <X className="w-3 h-3" />
                  Clear Filters
                </button>
              )}
            </>
          );
        })()}
      </div>

      <Card className="p-6">
        <div className="mb-6 space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Search tickets..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="w-48">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by status"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
                <option value="needs_review">Needs Review</option>
                <option value="failed">Failed</option>
              </select>
            </div>

            <div className="w-48">
              <select
                value={reviewFilter}
                onChange={(e) => setReviewFilter(e.target.value)}
                aria-label="Filter by review status"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Reviews</option>
                <option value="unreviewed">Unreviewed</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>

            <div className="w-48">
              <select
                value={linkFilter}
                onChange={(e) => setLinkFilter(e.target.value)}
                aria-label="Filter by order link status"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Link Status</option>
                <option value="unlinked">Unlinked</option>
                <option value="linked">Linked</option>
              </select>
            </div>

            <div className="w-48">
              <select
                value={paymentFilter}
                onChange={(e) => setPaymentFilter(e.target.value)}
                aria-label="Filter by payment status"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Payments</option>
                <option value="unbilled">Unbilled</option>
                <option value="billed">Billed</option>
                <option value="prepaid">Prepaid</option>
                <option value="no_charge">No Charge</option>
              </select>
            </div>

            {canBulkAction && filteredTickets.length > 0 && (
              <button
                onClick={toggleAll}
                className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
              >
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            )}
          </div>
        </div>

        {filteredTickets.length === 0 ? (
          <EmptyState
            icon={<FileText className="w-6 h-6 text-gray-400" />}
            title="No blend tickets found"
            description={
              tickets.length === 0
                ? "Upload your first blend ticket to get started"
                : "No tickets match your current filters"
            }
            action={
              tickets.length === 0 ? (
                <Button onClick={() => setShowUpload(true)}>
                  <Upload className="h-4 w-4" />
                  Upload Tickets
                </Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable<BlendTicket>
            columns={columns}
            data={filteredTickets}
          />
        )}
      </Card>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="blend ticket"
        onConfirm={handleDelete}
        loading={deleting}
      />

      <ConfirmModal
        open={batchApproveModalOpen}
        onClose={() => setBatchApproveModalOpen(false)}
        onConfirm={handleBatchApprove}
        title="Batch Approve Blend Tickets"
        message={`Are you sure you want to approve ${approvableIds.length} blend ticket(s)? Only completed, unreviewed tickets will be approved.`}
        confirmLabel="Approve"
        variant="info"
        icon={CheckCircle}
        loading={batchApproving}
      />

      <ConfirmModal
        open={batchRejectModalOpen}
        onClose={() => setBatchRejectModalOpen(false)}
        onConfirm={handleBatchReject}
        title="Batch Reject Blend Tickets"
        message={`Are you sure you want to reject ${approvableIds.length} blend ticket(s)? This cannot be undone.`}
        confirmLabel="Reject"
        variant="danger"
        icon={XCircle}
        loading={batchRejecting}
      />
    </div>
  );
}
