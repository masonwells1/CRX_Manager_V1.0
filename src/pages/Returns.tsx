import { useEffect, useState, useMemo , useCallback } from 'react';
import { Plus, CheckCircle, XCircle, ArrowDownToLine, DollarSign, Download, FileText, Trash2, Ban } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import DataTable, { type Column } from '../components/ui/DataTable';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult, sanitizeError } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import type { Return, ReturnItem, Customer, Product, Order, ReturnStatus, ReturnReason, ReturnItemCondition } from '../types';

type ReturnRow = Return & {
  customer_name: string;
  order_number: string | null;
  requester_name: string;
  item_count: number;
};

const REASON_LABELS: Record<ReturnReason, string> = {
  defective: 'Defective',
  damaged: 'Damaged',
  wrong_product: 'Wrong Product',
  overstock: 'Overstock',
  expired: 'Expired',
  other: 'Other',
};

const STATUS_BADGE: Record<ReturnStatus, { variant: 'info' | 'warning' | 'success' | 'default' | 'danger'; label: string }> = {
  requested: { variant: 'warning', label: 'Requested' },
  approved: { variant: 'info', label: 'Approved' },
  received: { variant: 'info', label: 'Received' },
  credited: { variant: 'success', label: 'Credited' },
  rejected: { variant: 'danger', label: 'Rejected' },
  cancelled: { variant: 'default', label: 'Cancelled' },
};

interface EditItem {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  condition: ReturnItemCondition;
  restock: boolean;
  notes: string;
}

export default function Returns() {
  const { profile, role } = useAuth();
  const approveIdem = useIdempotencyKey('approve_return', profile?.id || '');
  const receiveIdem = useIdempotencyKey('receive_return', profile?.id || '');
  const creditIdem = useIdempotencyKey('issue_return_credit', profile?.id || '');
  const { toast } = useToast();
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({
    customer_id: '',
    order_id: '',
    reason: 'defective' as ReturnReason,
    reason_notes: '',
    notes: '',
  });
  const [newItems, setNewItems] = useState<EditItem[]>([]);
  const [customerOrders, setCustomerOrders] = useState<Order[]>([]);

  // Detail modal
  const [showDetail, setShowDetail] = useState(false);
  const [activeReturn, setActiveReturn] = useState<ReturnRow | null>(null);
  const [detailItems, setDetailItems] = useState<ReturnItem[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const isAdmin = role === 'admin';
  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'approve' | 'reject' | 'cancel'; title: string; message: string } | null>(null);

  const fetchReturns = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('returns')
      .select(`
        *,
        customer:customers(farm_name),
        order:orders(order_number),
        requester:profiles!returns_requested_by_fkey(full_name),
        items:return_items(id)
      `)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to load returns');
      setLoading(false);
      return;
    }

    const rows = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name: string }; order?: { order_number: string }; requester?: { full_name: string }; items?: unknown[] }>).map((r) => ({
      ...r,
      customer_name: r.customer?.farm_name || 'Unknown',
      order_number: r.order?.order_number || null,
      requester_name: r.requester?.full_name || 'Unknown',
      item_count: r.items?.length || 0,
    })) as unknown as ReturnRow[];
    setReturns(rows);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchReturns();
  }, [fetchReturns]);

  const loadCreateData = async () => {
    const [custRes, prodRes] = await Promise.all([
      supabase.from('customers').select('id, farm_name, assigned_tier').eq('is_active', true).order('farm_name'),
      supabase.from('products').select('*').eq('is_active', true).order('product_name'),
    ]);
    setCustomers((custRes.data || []) as unknown as Customer[]);
    setProducts((prodRes.data || []) as Product[]);
  };

  const loadCustomerOrders = async (customerId: string) => {
    if (!customerId) {
      setCustomerOrders([]);
      return;
    }
    const { data } = await supabase
      .from('orders')
      .select('id, order_number, order_date')
      .eq('customer_id', customerId)
      .in('status', ['confirmed', 'partially_fulfilled', 'fulfilled'])
      .order('order_date', { ascending: false });
    setCustomerOrders((data || []) as Order[]);
  };

  const openCreate = () => {
    loadCreateData();
    setNewForm({ customer_id: '', order_id: '', reason: 'defective', reason_notes: '', notes: '' });
    setNewItems([]);
    setCustomerOrders([]);
    setShowCreate(true);
  };

  const addItem = () => {
    setNewItems([
      ...newItems,
      { product_id: '', product_name: '', quantity: 1, unit: 'ea', unit_price_cents: 0, condition: 'unopened', restock: true, notes: '' },
    ]);
  };

  const updateItem = (idx: number, field: keyof EditItem, value: EditItem[keyof EditItem]) => {
    const updated = [...newItems];
    updated[idx] = { ...updated[idx], [field]: value };
    setNewItems(updated);
  };

  const removeItem = (idx: number) => {
    setNewItems(newItems.filter((_, i) => i !== idx));
  };

  const handleCreate = async () => {
    if (!profile) return;
    if (!newForm.customer_id) {
      toast('error', 'Please select a customer');
      return;
    }
    if (newItems.length === 0) {
      toast('error', 'Add at least one return item');
      return;
    }

    // Validate all items have a product selected (prevent empty UUID)
    const invalidItems = newItems.filter(item => !item.product_id);
    if (invalidItems.length > 0) {
      toast('error', `Please select a product for all ${invalidItems.length} item(s)`);
      return;
    }

    await runCriticalAction({
      action: async () => {
        // Use sequential RPC instead of timestamp-based number
        const { data: rpcNum, error: rpcError } = await supabase.rpc('next_return_number');
        if (rpcError || !rpcNum) {
          throw new Error(rpcError?.message || 'Failed to generate return number');
        }
        const returnNum = rpcNum as string;

        const { data: ret, error: retError } = await supabase
          .from('returns')
          .insert({
            return_number: returnNum,
            customer_id: newForm.customer_id,
            order_id: newForm.order_id || null,
            reason: newForm.reason,
            reason_notes: newForm.reason_notes || null,
            notes: newForm.notes || null,
          })
          .select()
          .single();

        if (retError) throw retError;

        const itemsPayload = newItems.map((item, idx) => ({
          return_id: ret.id,
          product_id: item.product_id,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit,
          unit_price_cents: item.unit_price_cents,
          extended_cents: Math.round(item.quantity * item.unit_price_cents),
          condition: item.condition,
          restock: item.restock,
          sort_order: idx,
          notes: item.notes || null,
        }));

        const returnItemsResult = await supabase.from('return_items').insert(itemsPayload);
        if (returnItemsResult.error) throw returnItemsResult.error;
        checkMutationResult(returnItemsResult, 'Insert return items');

        await logActivity(
          'return_requested',
          `Return ${returnNum} requested for ${newItems.length} product(s)`,
          profile.id,
          'return',
          ret.id,
          newForm.customer_id
        );
      },
      toast,
      setLoading: setCreating,
      successMessage: 'Return created',
      sentryTag: 'create_return',
      onSuccess: () => {
        setShowCreate(false);
        fetchReturns();
      },
    });
  };

  const openDetail = async (ret: ReturnRow) => {
    setActiveReturn(ret);
    setShowDetail(true);
    setLoadingDetail(true);

    const { data, error } = await supabase
      .from('return_items')
      .select('*, product:products(product_name)')
      .eq('return_id', ret.id)
      .order('sort_order');

    if (error) Sentry.captureException(error);
    setDetailItems((data || []) as ReturnItem[]);
    setLoadingDetail(false);
  };

  // Workflow actions
  const handleApprove = async () => {
    if (!activeReturn || !profile) return;
    await runCriticalAction({
      action: async () => {
        const approveKey = approveIdem.getKey();
        const { error } = await supabase.rpc('approve_return', {
          p_return_id: activeReturn.id,
          p_approved_by: profile.id,
          p_idempotency_key: approveKey,
        });
        if (error) throw error;

        approveIdem.resetKey();
        await logActivity('return_approved', `Return ${activeReturn.return_number} approved`, profile.id, 'return', activeReturn.id);
      },
      toast,
      successMessage: 'Return approved',
      sentryTag: 'approve_return',
      onSuccess: () => {
        setShowDetail(false);
        fetchReturns();
      },
    });
  };

  const handleReject = async () => {
    if (!activeReturn || !profile) return;
    if (activeReturn.status !== 'requested') {
      toast('error', `Cannot reject a return in '${activeReturn.status}' status`);
      return;
    }
    await runCriticalAction({
      action: async () => {
        const result = await supabase
          .from('returns')
          .update({ status: 'rejected', updated_at: new Date().toISOString() })
          .eq('id', activeReturn.id)
          .select();
        checkMutationResult(result, 'Reject return');

        await logActivity('return_rejected', `Return ${activeReturn.return_number} rejected`, profile.id, 'return', activeReturn.id);
      },
      toast,
      successMessage: 'Return rejected',
      sentryTag: 'reject_return',
      onSuccess: () => {
        setShowDetail(false);
        fetchReturns();
      },
    });
  };

  const handleCancel = async () => {
    if (!activeReturn || !profile) return;
    // Only approved or received returns can be cancelled (not requested, credited, or rejected)
    const cancellableStatuses = ['approved', 'received'];
    if (!cancellableStatuses.includes(activeReturn.status)) {
      toast('error', `Cannot cancel a return in '${activeReturn.status}' status`);
      return;
    }
    await runCriticalAction({
      action: async () => {
        const result = await supabase
          .from('returns')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', activeReturn.id)
          .select();
        checkMutationResult(result, 'Cancel return');
        await logActivity('return_cancelled', `Return ${activeReturn.return_number} cancelled`, profile.id, 'return', activeReturn.id);
      },
      toast,
      successMessage: 'Return cancelled',
      sentryTag: 'cancel_return',
      onSuccess: () => {
        setShowDetail(false);
        fetchReturns();
      },
    });
  };

  const handleReceive = async () => {
    if (!activeReturn || !profile) return;
    await runCriticalAction({
      action: async () => {
        const receiveKey = receiveIdem.getKey();
        const { error } = await supabase.rpc('receive_return', {
          p_return_id: activeReturn.id,
          p_received_by: profile.id,
          p_idempotency_key: receiveKey,
        });
        if (error) throw error;

        receiveIdem.resetKey();
        await logActivity('return_received', `Return ${activeReturn.return_number} received, inventory restocked`, profile.id, 'return', activeReturn.id);
      },
      toast,
      successMessage: 'Return received and inventory restocked',
      sentryTag: 'receive_return',
      onSuccess: () => {
        setShowDetail(false);
        fetchReturns();
      },
    });
  };

  const handleIssueCredit = async () => {
    if (!activeReturn || !profile) return;
    await runCriticalAction({
      action: async () => {
        const creditKey = creditIdem.getKey();
        const { error } = await supabase.rpc('issue_return_credit', {
          p_return_id: activeReturn.id,
          p_actor_id: profile.id,
          p_idempotency_key: creditKey,
        });
        if (error) throw error;

        creditIdem.resetKey();
        await logActivity('return_credited', `Credit issued for return ${activeReturn.return_number}`, profile.id, 'return', activeReturn.id);
      },
      toast,
      successMessage: 'Credit issued',
      sentryTag: 'issue_return_credit',
      onSuccess: () => {
        setShowDetail(false);
        fetchReturns();
      },
    });
  };

  const filtered = returns.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: filtered, getId: (r) => r.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<ReturnRow>(selected, toggleSelect, (r) => r.id),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'return_number', header: 'Return #' },
      { key: 'customer_name', header: 'Customer' },
      { key: 'order_number', header: 'Order' },
      { key: 'status', header: 'Status' },
      { key: 'reason', header: 'Reason' },
      { key: 'total_credit_cents', header: 'Credit (cents)' },
      { key: 'requested_at', header: 'Requested' },
    ], 'returns');
    toast('success', `Exported ${selectedRows.length} return(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      await downloadReportPdf({
        title: 'Returns',
        subtitle: `${selectedRows.length} return(s) selected`,
        columns: [
          { header: 'Return #', key: 'return_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Order', key: 'order_number', format: (v) => v ? String(v) : '-' },
          { header: 'Status', key: 'status' },
          { header: 'Reason', key: 'reason' },
          { header: 'Credit', key: 'total_credit_cents', align: 'right', format: (v) => v ? `$${(Number(v) / 100).toFixed(2)}` : '-' },
        ],
        data: selectedRows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} return(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkDelete = async () => {
    // Only allow deleting returns in 'requested' or 'rejected' status
    const nonDeletable = selectedRows.filter((r) => !['requested', 'rejected', 'cancelled'].includes(r.status));
    if (nonDeletable.length > 0) {
      toast('error', `Cannot delete returns in active statuses (approved/received/credited)`);
      setDeleteModalOpen(false);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const ids = selectedRows.map((r) => r.id);
        // Soft delete via deleted_at timestamp
        const result = await supabase
          .from('returns')
          .update({ deleted_at: new Date().toISOString() })
          .in('id', ids)
          .select();
        checkMutationResult(result, 'Delete returns');
      },
      toast,
      setLoading: setDeleting,
      successMessage: `Deleted ${selectedRows.length} return(s)`,
      sentryTag: 'bulk_delete_returns',
      onSuccess: () => {
        clearSelection();
        fetchReturns();
        setDeleteModalOpen(false);
      },
    });
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const formatCents = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const dataColumns: Column<ReturnRow>[] = [
    {
      key: 'return_number',
      header: 'Return #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.return_number}</span>,
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (row) => <span>{row.customer_name}</span>,
    },
    {
      key: 'order_number',
      header: 'Order',
      render: (row) => (row.order_number ? <span className="text-sm">{row.order_number}</span> : <span className="text-gray-400">-</span>),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => {
        const s = STATUS_BADGE[row.status as ReturnStatus] || { variant: 'default' as const, label: row.status };
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => <span className="capitalize text-sm">{REASON_LABELS[row.reason as ReturnReason] || row.reason}</span>,
    },
    {
      key: 'item_count',
      header: 'Items',
      render: (row) => <span>{row.item_count}</span>,
    },
    {
      key: 'total_credit_cents',
      header: 'Credit',
      sortable: true,
      render: (row) => (
        <span className={row.total_credit_cents > 0 ? 'text-emerald-600 font-medium' : 'text-gray-400'}>
          {row.total_credit_cents > 0 ? formatCents(row.total_credit_cents) : '-'}
        </span>
      ),
    },
    {
      key: 'requested_at',
      header: 'Requested',
      sortable: true,
      render: (row) => <span className="text-sm text-gray-500">{new Date(row.requested_at).toLocaleDateString()}</span>,
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Returns / RMA</h2>
          {canBulkAction && <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />}
        </div>
        <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
          New Return
        </Button>
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<ReturnRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search returns..."
            searchKeys={['return_number', 'customer_name', 'order_number']}
            onRowClick={(row) => openDetail(row)}
            emptyTitle="No returns yet"
            emptyDescription="Create a return when products need to come back"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
                New Return
              </Button>
            }
            loading={loading}
            filters={
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="requested">Requested</option>
                  <option value="approved">Approved</option>
                  <option value="received">Received</option>
                  <option value="credited">Credited</option>
                  <option value="rejected">Rejected</option>
                  <option value="cancelled">Cancelled</option>
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

      {/* Create Return Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New Return / RMA" size="large">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer *</label>
              <select
                value={newForm.customer_id}
                onChange={(e) => {
                  setNewForm({ ...newForm, customer_id: e.target.value, order_id: '' });
                  loadCustomerOrders(e.target.value);
                }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Select Customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.farm_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Related Order (Optional)</label>
              <select
                value={newForm.order_id}
                onChange={(e) => setNewForm({ ...newForm, order_id: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">No linked order</option>
                {customerOrders.map((o) => (
                  <option key={o.id} value={o.id}>{o.order_number} ({new Date(o.order_date + 'T00:00:00').toLocaleDateString()})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason *</label>
              <select
                value={newForm.reason}
                onChange={(e) => setNewForm({ ...newForm, reason: e.target.value as ReturnReason })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                {Object.entries(REASON_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <Input
                label="Reason Details"
                value={newForm.reason_notes}
                onChange={(e) => setNewForm({ ...newForm, reason_notes: e.target.value })}
                placeholder="Additional details..."
              />
            </div>
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Return Items</label>
              <Button size="sm" variant="secondary" onClick={addItem}>
                <Plus className="w-3 h-3" /> Add Item
              </Button>
            </div>
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {newItems.map((item, idx) => (
                <div key={idx} className="flex gap-2 items-center p-2 bg-gray-50 rounded-lg">
                  <select
                    value={item.product_id}
                    onChange={(e) => {
                      const p = products.find((pr) => pr.id === e.target.value);
                      updateItem(idx, 'product_id', e.target.value);
                      if (p) {
                        updateItem(idx, 'product_name', p.product_name);
                        // Use correct tier price based on customer's assigned tier
                        const selectedCust = customers.find((c) => c.id === newForm.customer_id);
                        const tier = selectedCust?.assigned_tier || 1;
                        const tierPrice = tier === 3 ? p.tier3_price : tier === 2 ? p.tier2_price : p.tier1_price;
                        updateItem(idx, 'unit_price_cents', Math.round((tierPrice || p.tier1_price || 0) * 100));
                      }
                    }}
                    className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  >
                    <option value="">Select Product</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.product_name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={item.quantity || ''}
                    onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)}
                    placeholder="Qty"
                    className="w-16 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  />
                  <select
                    value={item.condition}
                    onChange={(e) => updateItem(idx, 'condition', e.target.value)}
                    className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  >
                    <option value="unopened">Unopened</option>
                    <option value="opened">Opened</option>
                    <option value="damaged">Damaged</option>
                    <option value="expired">Expired</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs text-gray-600 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={item.restock}
                      onChange={(e) => updateItem(idx, 'restock', e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    Restock
                  </label>
                  <button onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-600 p-1">
                    <XCircle className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {newItems.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">No items added</p>
              )}
            </div>
          </div>

          <Input
            label="Notes (Optional)"
            value={newForm.notes}
            onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })}
            placeholder="Additional notes for this return..."
          />

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} loading={creating}>Create Return</Button>
          </div>
        </div>
      </Modal>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="return"
        onConfirm={handleBulkDelete}
        loading={deleting}
      />

      <ConfirmModal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={async () => {
          if (!confirmAction) return;
          setConfirmAction(null);
          if (confirmAction.type === 'approve') await handleApprove();
          else if (confirmAction.type === 'reject') await handleReject();
          else if (confirmAction.type === 'cancel') await handleCancel();
        }}
        title={confirmAction?.title || ''}
        message={confirmAction?.message || ''}
        confirmLabel={confirmAction?.type === 'approve' ? 'Approve' : confirmAction?.type === 'reject' ? 'Reject' : 'Cancel Return'}
        variant={confirmAction?.type === 'approve' ? 'info' : 'danger'}
      />

      {/* Return Detail Modal */}
      <Modal
        open={showDetail}
        onClose={() => setShowDetail(false)}
        title={activeReturn ? `Return: ${activeReturn.return_number}` : 'Return Detail'}
        size="large"
      >
        {activeReturn && (
          <div className="space-y-4">
            {/* Info Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-gray-500 block">Customer</span>
                <span className="font-medium">{activeReturn.customer_name}</span>
              </div>
              <div>
                <span className="text-gray-500 block">Order</span>
                <span className="font-medium">{activeReturn.order_number || '-'}</span>
              </div>
              <div>
                <span className="text-gray-500 block">Status</span>
                {(() => {
                  const s = STATUS_BADGE[activeReturn.status as ReturnStatus];
                  return <Badge variant={s.variant}>{s.label}</Badge>;
                })()}
              </div>
              <div>
                <span className="text-gray-500 block">Reason</span>
                <span className="capitalize">{REASON_LABELS[activeReturn.reason as ReturnReason]}</span>
              </div>
            </div>

            {activeReturn.reason_notes && (
              <p className="text-sm text-gray-600 bg-gray-50 p-2 rounded">{activeReturn.reason_notes}</p>
            )}

            {/* Items */}
            {loadingDetail ? (
              <div className="flex items-center justify-center py-6">
                <div className="w-6 h-6 border-2 border-crx-green border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium text-gray-600">Product</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600">Qty</th>
                      <th className="text-left py-2 px-3 font-medium text-gray-600">Condition</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600">Credit</th>
                      <th className="text-center py-2 px-3 font-medium text-gray-600">Restock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailItems.map((item) => (
                      <tr key={item.id} className="border-t border-gray-100">
                        <td className="py-2 px-3 font-medium">{item.product_name || item.product?.product_name}</td>
                        <td className="py-2 px-3 text-right">{item.quantity} {item.unit}</td>
                        <td className="py-2 px-3 capitalize">{item.condition}</td>
                        <td className="py-2 px-3 text-right text-emerald-600">{formatCents(item.extended_cents)}</td>
                        <td className="py-2 px-3 text-center">
                          {item.restock ? (
                            item.restocked ? (
                              <Badge variant="success">Restocked</Badge>
                            ) : (
                              <span className="text-gray-500">Pending</span>
                            )
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50">
                    <tr className="border-t">
                      <td colSpan={3} className="py-2 px-3 text-right font-medium">Total Credit:</td>
                      <td className="py-2 px-3 text-right font-semibold text-emerald-600">
                        {formatCents(detailItems.reduce((s, i) => s + i.extended_cents, 0))}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {activeReturn.notes && (
              <p className="text-sm text-gray-600"><span className="font-medium">Notes:</span> {activeReturn.notes}</p>
            )}

            {/* Workflow Actions */}
            {isAdmin && (
              <div className="flex justify-between pt-2 border-t">
                <div className="flex gap-2">
                  {activeReturn.status === 'requested' && (
                    <Button variant="secondary" onClick={() => setConfirmAction({ type: 'reject', title: 'Reject Return', message: 'Are you sure you want to reject this return? This cannot be undone.' })} icon={<XCircle className="w-4 h-4" />}>
                      Reject
                    </Button>
                  )}
                  {(activeReturn.status === 'requested' || activeReturn.status === 'approved') && (
                    <Button variant="danger" onClick={() => setConfirmAction({ type: 'cancel', title: 'Cancel Return', message: 'Are you sure you want to cancel this return? This cannot be undone.' })} icon={<Ban className="w-4 h-4" />}>
                      Cancel
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  {activeReturn.status === 'requested' && (
                    <Button onClick={() => setConfirmAction({ type: 'approve', title: 'Approve Return', message: 'Are you sure you want to approve this return?' })} icon={<CheckCircle className="w-4 h-4" />}>
                      Approve
                    </Button>
                  )}
                  {activeReturn.status === 'approved' && (
                    <Button onClick={handleReceive} icon={<ArrowDownToLine className="w-4 h-4" />}>
                      Receive &amp; Restock
                    </Button>
                  )}
                  {activeReturn.status === 'received' && (
                    <Button onClick={handleIssueCredit} icon={<DollarSign className="w-4 h-4" />}>
                      Issue Credit
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
