import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseLocalDate } from '../lib/dateUtils';
import {
  Plus,
  Upload,
  FileText,
  Clock,
  PackageCheck,
  CheckCircle2,
  Download,
  XCircle,
  Package,
  AlertTriangle,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import HelpTip from '../components/ui/HelpTip';
import PageHeader from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult } from '../lib/db';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { formatUSD as fmt } from '../lib/money';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { Sentry } from '../lib/sentry';
import BulkPOImport from '../components/purchase-orders/BulkPOImport';
import { SkeletonTable, SkeletonCard } from '../components/ui/Skeleton';
import type { PurchaseOrder } from '../types';

const CANCELLABLE = ['draft', 'submitted'];

/* ── Outstanding item shape (joined from PO items + PO header) ── */
interface OutstandingItem {
  id: string;
  purchase_order_id: string;
  po_number: string;
  vendor: string;
  po_status: string;
  product_id: string;
  product_name: string;
  quantity_ordered: number;
  quantity_received: number;
  quantity_remaining: number;
  unit_cost: number;
  unit_size: string | null;
  expected_delivery_date: string | null;
  outstanding_value: number;
}

export default function PurchaseOrders() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'outstanding'>('all');

  /* ── Outstanding items state ── */
  const [outstandingItems, setOutstandingItems] = useState<OutstandingItem[]>([]);
  const [outstandingLoading, setOutstandingLoading] = useState(false);
  const [vendorFilter, setVendorFilter] = useState('');

  const isAdmin = role === 'admin';
  const canBulkAction = role === 'admin' || role === 'sales_rep';

  const fetchPOs = useCallback(async () => {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_purchase_orders' } });
      toast('error', 'Failed to load purchase orders. Please try again.');
      setLoading(false);
      return;
    }
    setPos((data || []) as PurchaseOrder[]);
    setLoading(false);
  }, [toast]);

  const fetchOutstandingItems = useCallback(async () => {
    setOutstandingLoading(true);
    const { data, error } = await supabase
      .from('purchase_order_items')
      .select(`
        id,
        purchase_order_id,
        product_id,
        product_name,
        quantity_ordered,
        quantity_received,
        unit_cost,
        unit_size,
        product:products(product_name),
        purchase_orders!inner(po_number, vendor, status, expected_delivery_date)
      `)
      .not('purchase_orders.status', 'in', '("cancelled","fully_received")');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_outstanding_items' } });
      toast('error', 'Failed to load outstanding items.');
      setOutstandingLoading(false);
      return;
    }
    const items: OutstandingItem[] = ((data || []) as Record<string, unknown>[])
      .map((row) => {
        const po = row.purchase_orders as Record<string, unknown>;
        const ordered = row.quantity_ordered as number;
        const received = row.quantity_received as number;
        const remaining = ordered - received;
        return {
          id: row.id as string,
          purchase_order_id: row.purchase_order_id as string,
          po_number: po.po_number as string,
          vendor: po.vendor as string,
          po_status: po.status as string,
          product_id: row.product_id as string,
          product_name: (row.product as { product_name: string } | null)?.product_name || (row.product_name as string) || 'Unknown Product',
          quantity_ordered: ordered,
          quantity_received: received,
          quantity_remaining: remaining,
          unit_cost: row.unit_cost as number,
          unit_size: row.unit_size as string | null,
          expected_delivery_date: po.expected_delivery_date as string | null,
          outstanding_value: remaining * (row.unit_cost as number),
        };
      })
      .filter((item) => item.quantity_remaining > 0)
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.po_number.localeCompare(b.po_number));
    setOutstandingItems(items);
    setOutstandingLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchPOs();
  }, [fetchPOs]);

  useEffect(() => {
    if (activeTab === 'outstanding' && outstandingItems.length === 0 && !outstandingLoading) {
      fetchOutstandingItems();
    }
  }, [activeTab, outstandingItems.length, outstandingLoading, fetchOutstandingItems]);

  /* ─── Summary stats ─── */
  const counts = useMemo(() => {
    const draft = pos.filter((p) => p.status === 'draft').length;
    const submitted = pos.filter((p) => p.status === 'submitted').length;
    const partial = pos.filter((p) => p.status === 'partially_received').length;
    const full = pos.filter((p) => p.status === 'fully_received').length;
    return { draft, submitted, partial, full };
  }, [pos]);

  const filtered = pos.filter((p) => {
    if (statusFilter && p.status !== statusFilter) return false;
    return true;
  });

  /* ─── Outstanding items stats & filtering ─── */
  const outstandingVendors = useMemo(
    () => [...new Set(outstandingItems.map((i) => i.vendor))].sort(),
    [outstandingItems]
  );

  const filteredOutstanding = useMemo(
    () => vendorFilter ? outstandingItems.filter((i) => i.vendor === vendorFilter) : outstandingItems,
    [outstandingItems, vendorFilter]
  );

  const outstandingStats = useMemo(() => {
    const totalItems = filteredOutstanding.length;
    const totalQty = filteredOutstanding.reduce((s, i) => s + i.quantity_remaining, 0);
    const totalValue = filteredOutstanding.reduce((s, i) => s + i.outstanding_value, 0);
    const vendorCount = new Set(filteredOutstanding.map((i) => i.vendor)).size;
    const overdue = filteredOutstanding.filter((i) => {
      if (!i.expected_delivery_date) return false;
      return parseLocalDate(i.expected_delivery_date) < new Date();
    }).length;
    return { totalItems, totalQty, totalValue, vendorCount, overdue };
  }, [filteredOutstanding]);

  // ─── Row selection (PO list tab) ───
  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (p) => p.id,
      isSelectable: (p) => CANCELLABLE.includes(p.status),
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<PurchaseOrder>(selected, toggleSelect, (p) => p.id, (p) => CANCELLABLE.includes(p.status)),
    [selected, toggleSelect]
  );

  const dataColumns: Column<PurchaseOrder>[] = [
    {
      key: 'po_number',
      header: 'PO #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.po_number}</span>,
    },
    { key: 'vendor', header: 'Vendor', sortable: true },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
          {row.status.replace(/_/g, ' ')}
        </Badge>
      ),
    },
    {
      key: 'total_cost',
      header: 'Total Cost',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_cost)}</span>,
    },
    {
      key: 'submitted_date',
      header: 'Submitted',
      sortable: true,
      render: (row) =>
        row.submitted_date ? parseLocalDate(row.submitted_date).toLocaleDateString() : '-',
    },
    {
      key: 'expected_delivery_date',
      header: 'Expected Delivery',
      sortable: true,
      render: (row) =>
        row.expected_delivery_date
          ? parseLocalDate(row.expected_delivery_date).toLocaleDateString()
          : '-',
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  /* ── Outstanding items columns ── */
  const outstandingColumns: Column<OutstandingItem>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.vendor}</span>,
    },
    {
      key: 'po_number',
      header: 'PO #',
      sortable: true,
      render: (row) => <span className="text-blue-600 font-medium">{row.po_number}</span>,
    },
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
      render: (row) => (
        <div>
          <span className="font-medium">{row.product_name}</span>
          {row.unit_size && <span className="text-xs text-secondary ml-1">({row.unit_size})</span>}
        </div>
      ),
    },
    {
      key: 'quantity_ordered',
      header: 'Ordered',
      sortable: true,
      render: (row) => <span className="font-mono">{row.quantity_ordered}</span>,
    },
    {
      key: 'quantity_received',
      header: 'Received',
      sortable: true,
      render: (row) => <span className="font-mono text-crx-green">{row.quantity_received}</span>,
    },
    {
      key: 'quantity_remaining',
      header: 'Remaining',
      sortable: true,
      render: (row) => <span className="font-mono font-semibold text-amber-600">{row.quantity_remaining}</span>,
    },
    {
      key: 'outstanding_value',
      header: 'Value',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.outstanding_value)}</span>,
    },
    {
      key: 'po_status',
      header: 'PO Status',
      sortable: true,
      render: (row) => (
        <Badge variant={statusToBadgeVariant[row.po_status] || 'default'}>
          {row.po_status.replace(/_/g, ' ')}
        </Badge>
      ),
    },
    {
      key: 'expected_delivery_date',
      header: 'Expected',
      sortable: true,
      render: (row) => {
        if (!row.expected_delivery_date) return <span className="text-gray-300">—</span>;
        const d = parseLocalDate(row.expected_delivery_date);
        const isOverdue = d < new Date();
        return (
          <span className={isOverdue ? 'text-red-600 font-medium' : ''}>
            {d.toLocaleDateString()}
            {isOverdue && <AlertTriangle className="w-3 h-3 inline ml-1" />}
          </span>
        );
      },
    },
  ];

  // ─── Bulk action handlers ───────────────────────────────────
  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'po_number', header: 'PO #' },
      { key: 'vendor', header: 'Vendor' },
      { key: 'status', header: 'Status' },
      { key: 'total_cost', header: 'Total Cost', format: (v) => fmtCSV(v as number) },
      { key: 'submitted_date', header: 'Submitted', format: (v) => fmtDateCSV(v as string) },
      { key: 'expected_delivery_date', header: 'Expected Delivery', format: (v) => fmtDateCSV(v as string) },
    ], 'purchase_orders');
    toast('success', `Exported ${selectedRows.length} PO(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'PO #', key: 'po_number' },
        { header: 'Vendor', key: 'vendor' },
        { header: 'Status', key: 'status' },
        { header: 'Total Cost', key: 'total_cost', align: 'right', format: (v) => fmt(Number(v)) },
        { header: 'Submitted', key: 'submitted_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
        { header: 'Expected', key: 'expected_delivery_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
      ];
      await downloadReportPdf({
        title: 'Purchase Orders',
        subtitle: `${selectedRows.length} PO(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} PO(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleExportOutstandingCSV = () => {
    exportToCSV(filteredOutstanding as unknown as Record<string, unknown>[], [
      { key: 'vendor', header: 'Vendor' },
      { key: 'po_number', header: 'PO #' },
      { key: 'product_name', header: 'Product' },
      { key: 'unit_size', header: 'Unit Size' },
      { key: 'quantity_ordered', header: 'Qty Ordered' },
      { key: 'quantity_received', header: 'Qty Received' },
      { key: 'quantity_remaining', header: 'Qty Remaining' },
      { key: 'unit_cost', header: 'Unit Cost', format: (v) => fmtCSV(v as number) },
      { key: 'outstanding_value', header: 'Outstanding Value', format: (v) => fmtCSV(v as number) },
      { key: 'po_status', header: 'PO Status' },
      { key: 'expected_delivery_date', header: 'Expected Delivery', format: (v) => fmtDateCSV(v as string) },
    ], 'outstanding_po_items');
    toast('success', `Exported ${filteredOutstanding.length} outstanding item(s) to CSV`);
  };

  const handleExportOutstandingPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Vendor', key: 'vendor' },
        { header: 'PO #', key: 'po_number' },
        { header: 'Product', key: 'product_name' },
        { header: 'Ordered', key: 'quantity_ordered', align: 'right' },
        { header: 'Received', key: 'quantity_received', align: 'right' },
        { header: 'Remaining', key: 'quantity_remaining', align: 'right' },
        { header: 'Value', key: 'outstanding_value', align: 'right', format: (v) => fmt(Number(v)) },
        { header: 'Expected', key: 'expected_delivery_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
      ];
      await downloadReportPdf({
        title: 'Outstanding PO Items',
        subtitle: vendorFilter ? `Vendor: ${vendorFilter}` : 'All Vendors',
        columns: pdfCols,
        data: filteredOutstanding as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${filteredOutstanding.length} outstanding item(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleCancel = async () => {
    setCancelling(true);
    let cancelledCount = 0;
    for (const po of selectedRows) {
      if (po.status !== 'cancelled') {
        // Bulk loop: deterministic per-PO key (NOT crypto.randomUUID()) so a
        // retry of the same cancel batch reuses identical keys and the server
        // dedupes already-cancelled POs instead of double-executing.
        const { data, error } = await supabase.rpc('cancel_purchase_order', {
          p_po_id: po.id,
          p_performed_by: profile?.id,
          p_idempotency_key: `cancel_purchase_order:${profile?.id || 'anon'}:${po.id}`,
        });
        if (error) {
          toast('error', `Failed to cancel PO ${po.po_number}: ${error.message}`);
        } else {
          assertRpcResult(data, 'cancel_purchase_order');
          cancelledCount++;
        }
      }
    }
    if (cancelledCount > 0) {
      toast('success', `Cancelled ${cancelledCount} purchase order(s)`);
    }
    clearSelection();
    fetchPOs();
    setCancelling(false);
    setCancelModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'cancel', label: 'Cancel POs', icon: <XCircle className="w-4 h-4" />, onClick: () => setCancelModalOpen(true), variant: 'danger' as const },
  ];

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SkeletonCard />
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
        title="Purchase"
        accent="Orders"
        subtitle={<HelpTip text="Manage supplier purchase orders. Use the 'Outstanding Items' tab to see all products still awaiting delivery across all POs — no need to check each PO individually." />}
        actions={(
          <>
          {activeTab === 'all' && canBulkAction && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
        {isAdmin && activeTab === 'all' && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              icon={<Upload className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setImportOpen(true)}
            >
              Import from PDF
            </Button>
            <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/purchase-orders/new')}>
              New PO
            </Button>
          </div>
        )}
        {activeTab === 'outstanding' && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              icon={<Download className="w-4 h-4" />}
              showChevron={false}
              onClick={handleExportOutstandingCSV}
              disabled={filteredOutstanding.length === 0}
            >
              Export CSV
            </Button>
            <Button
              variant="secondary"
              icon={<FileText className="w-4 h-4" />}
              showChevron={false}
              onClick={handleExportOutstandingPDF}
              disabled={filteredOutstanding.length === 0 || exporting}
            >
              {exporting ? 'Generating...' : 'Download PDF'}
            </Button>
          </div>
        )}
          </>
        )}
      />

      {/* Tab Toggle */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setActiveTab('all')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'all'
              ? 'border-crx-green text-crx-green'
              : 'border-transparent text-secondary hover:text-nav-dark hover:border-gray-300'
          }`}
        >
          All POs
        </button>
        <button
          onClick={() => setActiveTab('outstanding')}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === 'outstanding'
              ? 'border-crx-green text-crx-green'
              : 'border-transparent text-secondary hover:text-nav-dark hover:border-gray-300'
          }`}
        >
          <Package className="w-4 h-4" />
          Outstanding Items
          {outstandingItems.length > 0 && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              activeTab === 'outstanding' ? 'bg-crx-green/10 text-crx-green' : 'bg-gray-100 text-secondary'
            }`}>
              {outstandingItems.length}
            </span>
          )}
        </button>
      </div>

      {/* ─── All POs Tab ─── */}
      {activeTab === 'all' && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <button onClick={() => setStatusFilter(statusFilter === 'draft' ? '' : 'draft')} className="text-left">
              <Card>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                    <FileText className="w-5 h-5 text-gray-500" />
                  </div>
                  <span className="text-sm text-secondary">Draft</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-gray-500">{counts.draft}</p>
              </Card>
            </button>
            <button onClick={() => setStatusFilter(statusFilter === 'submitted' ? '' : 'submitted')} className="text-left">
              <Card>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                    <Clock className="w-5 h-5 text-blue-600" />
                  </div>
                  <span className="text-sm text-secondary">Awaiting Receipt</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-blue-600">{counts.submitted}</p>
              </Card>
            </button>
            <button onClick={() => setStatusFilter(statusFilter === 'partially_received' ? '' : 'partially_received')} className="text-left">
              <Card>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                    <PackageCheck className="w-5 h-5 text-amber-600" />
                  </div>
                  <span className="text-sm text-secondary">Partially Received</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-amber-600">{counts.partial}</p>
              </Card>
            </button>
            <button onClick={() => setStatusFilter(statusFilter === 'fully_received' ? '' : 'fully_received')} className="text-left">
              <Card>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
                    <CheckCircle2 className="w-5 h-5 text-crx-green" />
                  </div>
                  <span className="text-sm text-secondary">Fully Received</span>
                </div>
                <p className="text-2xl font-semibold font-heading text-crx-green">{counts.full}</p>
              </Card>
            </button>
          </div>

          {/* Data Table */}
          <Card padding={false}>
            <div className="p-5">
              <DataTable<PurchaseOrder>
                data={filtered}
                columns={columns}
                searchable
                searchPlaceholder="Search purchase orders..."
                searchKeys={['po_number', 'vendor']}
                onRowClick={(row) => navigate(`/purchase-orders/${row.id}`)}
                emptyTitle="No purchase orders"
                emptyDescription="Create a PO to order products from vendors"
                emptyAction={
                  isAdmin ? (
                    <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/purchase-orders/new')}>
                      New PO
                    </Button>
                  ) : undefined
                }
                loading={loading}
                filters={
                  <div className="flex gap-2 items-center flex-wrap">
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      aria-label="Filter by PO status"
                      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                    >
                      <option value="">All Statuses</option>
                      <option value="draft">Draft</option>
                      <option value="submitted">Submitted</option>
                      <option value="partially_received">Partially Received</option>
                      <option value="fully_received">Fully Received</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                    {statusFilter && (
                      <button
                        onClick={() => setStatusFilter('')}
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
        </>
      )}

      {/* ─── Outstanding Items Tab ─── */}
      {activeTab === 'outstanding' && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                  <Package className="w-5 h-5 text-amber-600" />
                </div>
                <span className="text-sm text-secondary">Line Items</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-amber-600">{outstandingStats.totalItems}</p>
            </Card>
            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                  <PackageCheck className="w-5 h-5 text-blue-600" />
                </div>
                <span className="text-sm text-secondary">Total Qty</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-blue-600">
                {outstandingStats.totalQty.toLocaleString()}
              </p>
            </Card>
            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
                  <FileText className="w-5 h-5 text-crx-green" />
                </div>
                <span className="text-sm text-secondary">Outstanding Value</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(outstandingStats.totalValue)}</p>
            </Card>
            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                  <Clock className="w-5 h-5 text-gray-500" />
                </div>
                <span className="text-sm text-secondary">Vendors</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-gray-600">{outstandingStats.vendorCount}</p>
            </Card>
            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                </div>
                <span className="text-sm text-secondary">Overdue</span>
              </div>
              <p className="text-2xl font-semibold font-heading text-red-500">{outstandingStats.overdue}</p>
            </Card>
          </div>

          {/* Outstanding Items Table */}
          <Card padding={false}>
            <div className="p-5">
              <DataTable<OutstandingItem>
                data={filteredOutstanding}
                columns={outstandingColumns}
                searchable
                searchPlaceholder="Search by product, vendor, or PO#..."
                searchKeys={['product_name', 'vendor', 'po_number']}
                onRowClick={(row) => navigate(`/purchase-orders/${row.purchase_order_id}`)}
                emptyTitle="No outstanding items"
                emptyDescription="All PO items have been fully received"
                loading={outstandingLoading}
                filters={
                  <div className="flex gap-2 items-center flex-wrap">
                    <select
                      value={vendorFilter}
                      onChange={(e) => setVendorFilter(e.target.value)}
                      aria-label="Filter by vendor"
                      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                    >
                      <option value="">All Vendors</option>
                      {outstandingVendors.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    {vendorFilter && (
                      <button
                        onClick={() => setVendorFilter('')}
                        className="text-xs text-crx-green hover:underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                }
              />
            </div>
          </Card>
        </>
      )}

      <BulkPOImport
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSuccess={() => { setImportOpen(false); fetchPOs(); }}
      />

      <BulkDeleteConfirmModal
        open={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        count={selectedCount}
        entityName="purchase order"
        actionWord="cancel"
        onConfirm={handleCancel}
        loading={cancelling}
      />
    </div>
  );
}
