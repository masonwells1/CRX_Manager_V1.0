import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Upload, Search, CheckCircle, Clock, AlertCircle, XCircle, Plus, LinkIcon, Download, Trash2 } from 'lucide-react';
import { supabase, checkMutationResult } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
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
import { usePageMeta } from '../hooks/usePageMeta';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { useToast } from '../components/ui/Toast';
import { parseLocalDate } from '../lib/dateUtils';
import type { BlendTicket, Customer } from '../types';

export function BlendTickets() {
  usePageMeta();
  const { role } = useAuth();
  const { toast } = useToast();
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

  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const { isProcessing, processedCount } = useOCRProcessor(true);

  const loadData = useCallback(async () => {
    try {
      const [ticketsResult, customersResult] = await Promise.all([
        supabase
          .from('blend_tickets')
          .select(`
            *,
            uploader:profiles!blend_tickets_uploaded_by_fkey(id, full_name, email),
            reviewer:profiles!blend_tickets_reviewed_by_fkey(id, full_name, email),
            customer:customers(id, farm_name),
            field:fields(id, field_name),
            salesman:profiles!blend_tickets_salesman_id_fkey(id, full_name),
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

      setTickets(ticketsResult.data || []);
      setCustomers(customersResult.data || []);
    } catch (error) {
      console.error('Error loading data:', error);
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
    setDeleting(true);
    try {
      const ids = selectedRows.map((t) => t.id);
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
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete Tickets', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
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
        <Link
          to={`/blend-tickets/${ticket.id}`}
          className="text-blue-600 hover:text-blue-700 font-medium"
        >
          {ticket.ticket_number}
        </Link>
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
                ticket.ocr_confidence_score >= 70
                  ? 'bg-green-500'
                  : ticket.ocr_confidence_score >= 50
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
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex-1 flex items-center gap-3">
          <FileText className="h-8 w-8 text-gray-700" />
          <div>
            <h2 className="text-3xl font-bold text-gray-900">Blend Tickets</h2>
            <p className="text-gray-600 mt-1">
              Upload and manage blend ticket images with automatic OCR processing
            </p>
          </div>
          {canBulkAction && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
        </div>
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
      </div>

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
    </div>
  );
}
