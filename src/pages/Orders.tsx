import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Download, FileText, Trash2, Users } from 'lucide-react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import BulkOrderImport from '../components/orders/BulkOrderImport';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import type { Order } from '../types';
import { getSeasonDates } from '../utils/season';

interface OrderWithFulfillment extends Order {
  fulfillment_pct: number;
  invoiced_pct: number;
  farm_group_name: string | null;
  customer_name: string;
}

export default function Orders() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role } = useAuth();
  const [orders, setOrders] = useState<OrderWithFulfillment[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  const fetchOrders = useCallback(async () => {
    const { start: seasonStart, end: seasonEnd } = getSeasonDates();
    const QUERY_LIMIT = 500;
    const { data: ordersData, error: ordersError } = await supabase
      .from('orders')
      .select('*, customer:customers(farm_name, parent_customer_id)')
      .gte('order_date', seasonStart)
      .lte('order_date', seasonEnd)
      .order('order_date', { ascending: false })
      .limit(QUERY_LIMIT);

    if (ordersError) {
      console.error('Failed to load orders:', ordersError.message);
      toast('error', 'Failed to load orders. Please try again.');
      setLoading(false);
      return;
    }

    if (ordersData && ordersData.length === QUERY_LIMIT) {
      toast('error', `Showing first ${QUERY_LIMIT} orders — some orders may be hidden. Contact admin if you need the full list.`);
    }

    const orderIds = (ordersData || []).map((o: Record<string, unknown>) => (o as { id: string }).id);
    const { data: itemsData, error: itemsError } = await supabase
      .from('order_items')
      .select('order_id, total_units_needed, quantity_delivered, price_per_unit')
      .in('order_id', orderIds.length > 0 ? orderIds : ['__none__']);

    if (itemsError) {
      console.error('Failed to load order items:', itemsError.message);
    }

    // H16: Use value-based fulfillment (weighted by price_per_unit) instead of item-count-based
    const itemsByOrder: Record<string, { neededValue: number; deliveredValue: number }> = {};
    (itemsData || []).forEach((item) => {
      if (!itemsByOrder[item.order_id]) {
        itemsByOrder[item.order_id] = { neededValue: 0, deliveredValue: 0 };
      }
      const price = Number(item.price_per_unit) || 0;
      itemsByOrder[item.order_id].neededValue += (Number(item.total_units_needed) || 0) * price;
      itemsByOrder[item.order_id].deliveredValue += (Number(item.quantity_delivered) || 0) * price;
    });

    // Fetch invoice totals per order for invoiced %
    const { data: invoiceData } = await supabase
      .from('invoices')
      .select('order_id, total_amount_cents')
      .not('status', 'in', '("voided","cancelled")');
    const invoicedByOrder: Record<string, number> = {};
    (invoiceData || []).forEach((inv: { order_id: string | null; total_amount_cents: number }) => {
      if (inv.order_id) {
        invoicedByOrder[inv.order_id] = (invoicedByOrder[inv.order_id] || 0) + (inv.total_amount_cents || 0);
      }
    });

    // Fetch parent customer names for farm group labels
    const parentIds = [...new Set(
      (ordersData || [])
        .map((o: Record<string, unknown>) => (o.customer as { parent_customer_id?: string })?.parent_customer_id)
        .filter(Boolean) as string[]
    )];
    const parentNameMap: Record<string, string> = {};
    if (parentIds.length > 0) {
      const { data: parents } = await supabase
        .from('customers')
        .select('id, farm_name')
        .in('id', parentIds);
      (parents || []).forEach((p) => { parentNameMap[p.id] = p.farm_name; });
    }

    const enriched = ((ordersData || []) as Order[]).map((o) => {
      const counts = itemsByOrder[o.id] || { neededValue: 0, deliveredValue: 0 };
      const pct = counts.neededValue > 0 ? Math.round((counts.deliveredValue / counts.neededValue) * 100) : 0;
      const orderCents = Math.round((o.total_price || 0) * 100);
      const invCents = invoicedByOrder[o.id] || 0;
      const invPct = orderCents > 0 ? Math.round((invCents / orderCents) * 100) : 0;
      const cust = o.customer as unknown as { farm_name: string; parent_customer_id: string | null } | null;
      const farmGroupName = cust?.parent_customer_id ? parentNameMap[cust.parent_customer_id] || null : null;
      const customerName = cust?.farm_name || '';
      return { ...o, fulfillment_pct: pct, invoiced_pct: Math.min(invPct, 100), farm_group_name: farmGroupName, customer_name: customerName };
    });

    setOrders(enriched);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const filtered = orders.filter((o) => {
    if (statusFilter && o.status !== statusFilter) return false;
    if (planFilter === 'planned' && !o.is_planned) return false;
    if (planFilter === 'committed' && o.is_planned) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: filtered, getId: (o) => o.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<OrderWithFulfillment>(selected, toggleSelect, (o) => o.id),
    [selected, toggleSelect]
  );

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'order_number', header: 'Order #' },
      { key: 'customer', header: 'Customer', format: (v) => (v as { farm_name: string })?.farm_name || '' },
      { key: 'status', header: 'Status' },
      { key: 'total_price', header: 'Total', format: (v) => fmtCSV(v) },
      { key: 'order_date', header: 'Order Date', format: (v) => fmtDateCSV(v) },
      { key: 'fulfillment_pct', header: 'Fulfillment %', format: (v) => `${v}%` },
      { key: 'invoiced_pct', header: 'Invoiced %', format: (v) => `${v}%` },
    ], 'orders');
    toast('success', `Exported ${selectedRows.length} order(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfData = selectedRows.map((o) => ({
        ...o,
        customer_name: (o.customer as unknown as { farm_name: string })?.farm_name || '',
      }));
      await downloadReportPdf({
        title: 'Orders',
        subtitle: `${selectedRows.length} order(s) selected`,
        columns: [
          { header: 'Order #', key: 'order_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Status', key: 'status' },
          { header: 'Total', key: 'total_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          { header: 'Date', key: 'order_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'Fulfillment', key: 'fulfillment_pct', align: 'right', format: (v) => `${v}%` },
          { header: 'Invoiced', key: 'invoiced_pct', align: 'right', format: (v) => `${v}%` },
        ],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} order(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      const ids = selectedRows.map((o) => o.id);
      const result = await supabase.from('orders').delete().in('id', ids).select();
      checkMutationResult(result, 'Delete orders');
      toast('success', `Deleted ${ids.length} order(s)`);
      clearSelection();
      fetchOrders();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<OrderWithFulfillment>[] = [
    {
      key: 'order_number',
      header: 'Order #',
      sortable: true,
      render: (row) => (
        <div>
          <span className="font-medium text-nav-dark">{row.order_number}</span>
          {row.order_name && (
            <p className="text-xs text-secondary mt-0.5">{row.order_name}</p>
          )}
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => {
        const name = (row.customer as unknown as { farm_name: string })?.farm_name || '-';
        return (
          <div>
            <span>{name}</span>
            {row.farm_group_name && (
              <div className="flex items-center gap-1 mt-0.5">
                <Users className="w-3 h-3 text-blue-500 flex-shrink-0" />
                <span className="text-xs text-blue-600">{row.farm_group_name}</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
            {row.status.replace('_', ' ')}
          </Badge>
          {row.is_planned && (
            <Badge variant="warning">Planned</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_price)}</span>,
    },
    {
      key: 'customer_po_number',
      header: 'Customer PO#',
      render: (row) => (row as Order & { customer_po_number?: string }).customer_po_number || '-',
    },
    {
      key: 'order_date',
      header: 'Order Date',
      sortable: true,
      render: (row) => new Date(row.order_date + 'T00:00:00').toLocaleDateString(),
    },
    {
      key: 'fulfillment_pct',
      header: 'Fulfillment',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-crx-green rounded-full transition-all"
              style={{ width: `${row.fulfillment_pct}%` }}
            />
          </div>
          <span className="text-xs text-secondary">{row.fulfillment_pct}%</span>
        </div>
      ),
    },
    {
      key: 'invoiced_pct',
      header: 'Invoiced',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${row.invoiced_pct}%` }}
            />
          </div>
          <span className="text-xs text-secondary">{row.invoiced_pct}%</span>
        </div>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex-1 flex items-center gap-3">
          <h2 className="text-2xl font-bold text-nav-dark">Orders</h2>
          {canBulkAction && (
            <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setShowImportModal(true)}>
            <Upload className="w-4 h-4" />
            Import Orders
          </Button>
          <Button onClick={() => navigate('/orders/new')}>
            <Plus className="w-4 h-4" />
            New Order
          </Button>
        </div>
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<OrderWithFulfillment>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search orders..."
            searchKeys={['order_number', 'farm_group_name', 'customer_name']}
            onRowClick={(row) => navigate(`/orders/${row.id}`)}
            emptyTitle="No orders yet"
            emptyDescription="Orders are created from accepted quotes"
            loading={loading}
            filters={
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by order status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="partially_fulfilled">Partially Fulfilled</option>
                  <option value="fulfilled">Fulfilled</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <select
                  value={planFilter}
                  onChange={(e) => setPlanFilter(e.target.value)}
                  aria-label="Filter by planned or committed"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Orders</option>
                  <option value="planned">Planned Only</option>
                  <option value="committed">Committed Only</option>
                </select>
                {canBulkAction && filtered.length > 0 && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </>
            }
          />
        </div>
      </Card>

      <BulkOrderImport
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={() => {
          setShowImportModal(false);
          fetchOrders();
        }}
      />

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="order"
        onConfirm={handleBulkDelete}
        loading={deleting}
      />
    </div>
  );
}
