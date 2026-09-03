import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
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
import ReasonModal from '../components/ui/ReasonModal';
import PageHeader from '../components/ui/PageHeader';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult, sanitizeError, assertRpcResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { isDefinitiveRpcRejection } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import { ProductOptionDetails, normalizeReturnPolicy, productOptionLabel, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import { ReturnDetailItems } from '../components/returns/ReturnDetailItems';
import { mapReturnPolicyRpcError, RETURN_POLICY_NO_RETURN_CODE } from '../lib/returnPolicyError';
import type { Return, ReturnItem, Customer, Order, ReturnStatus, ReturnReason, ReturnItemCondition } from '../types';
import type { Json } from '../types/supabase';

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
  order_item_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  condition: ReturnItemCondition;
  restock: boolean;
  notes: string;
  max_quantity: number;
}

interface CreateReturnForm {
  customer_id: string;
  order_id: string;
  reason: ReturnReason;
  reason_notes: string;
  notes: string;
}

interface ReturnableOrderItem {
  id: string;
  product_id: string;
  product_name: string;
  price_per_unit: number;
  quantity_delivered: number;
  quantity_returnable: number;
  unit_size: string | null;
  section_name: string | null;
  product?: ProductOptionPresentationModel | null;
}

type DetailReturnItem = ReturnItem & { product?: ProductOptionPresentationModel | null };

function buildCreateReturnIntent(
  form: CreateReturnForm,
  items: EditItem[],
) {
  const returnPayload = {
    customer_id: form.customer_id,
    order_id: form.order_id || null,
    reason: form.reason,
    reason_notes: form.reason_notes || null,
    notes: form.notes || null,
  };
  const itemsPayload = items.map((item, idx) => ({
    order_item_id: item.order_item_id,
    product_id: item.product_id,
    product_name: item.product_name,
    quantity: item.quantity,
    unit: item.unit,
    unit_price_cents: item.unit_price_cents,
    condition: item.condition,
    restock: item.restock,
    sort_order: idx,
    notes: item.notes || null,
  }));

  return {
    returnPayload,
    itemsPayload,
    // JSON.stringify is deterministic for these fixed-key objects and preserves
    // item order, so the browser key rotates exactly when the RPC payload does.
    intentScope: JSON.stringify([returnPayload, itemsPayload]),
  };
}

function committedCreateResultFromIntentMismatch(error: unknown): Json | null {
  if (!error || typeof error !== 'object') return null;
  const rpcError = error as { message?: unknown; details?: unknown };
  if (typeof rpcError.message !== 'string' || !rpcError.message.includes('IDEMPOTENCY_INTENT_MISMATCH')) return null;
  try {
    const detail = typeof rpcError.details === 'string' ? JSON.parse(rpcError.details) : rpcError.details;
    if (!detail || typeof detail !== 'object') return null;
    return ((detail as { result?: Json }).result ?? null);
  } catch {
    return null;
  }
}

export default function Returns() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({
    customer_id: '',
    order_id: '',
    reason: 'defective' as ReturnReason,
    reason_notes: '',
    notes: '',
  });
  const [newItems, setNewItems] = useState<EditItem[]>([]);
  const [unresolvedCreateIntent, setUnresolvedCreateIntent] = useState<{
    form: CreateReturnForm;
    items: EditItem[];
    intent: ReturnType<typeof buildCreateReturnIntent>;
  } | null>(null);
  const [customerOrders, setCustomerOrders] = useState<Order[]>([]);
  const [orderItems, setOrderItems] = useState<ReturnableOrderItem[]>([]);
  const customerOrdersRequestRef = useRef(0);
  const orderItemsRequestRef = useRef(0);

  // Detail modal
  const [showDetail, setShowDetail] = useState(false);
  const [activeReturn, setActiveReturn] = useState<ReturnRow | null>(null);
  const [detailItems, setDetailItems] = useState<DetailReturnItem[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const returnDetailRequestRef = useRef(0);

  const isAdmin = role === 'admin';
  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'approve' | 'reject'; title: string; message: string } | null>(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const createIntent = buildCreateReturnIntent(newForm, newItems);
  const createPayloadLocked = creating || Boolean(unresolvedCreateIntent);
  const returnIntentScope = activeReturn?.id || '';
  const approveIdem = useIdempotencyKey('approve_return', profile?.id || '', returnIntentScope);
  const receiveIdem = useIdempotencyKey('receive_return', profile?.id || '', returnIntentScope);
  const creditIdem = useIdempotencyKey('issue_return_credit', profile?.id || '', returnIntentScope);
  const cancelIdem = useIdempotencyKey('cancel_return', profile?.id || '', returnIntentScope);
  const rejectIdem = useIdempotencyKey('reject_return', profile?.id || '', returnIntentScope);
  const effectiveCreateIntentScope = unresolvedCreateIntent?.intent.intentScope ?? createIntent.intentScope;
  const createIdem = useIdempotencyKey('create_return', profile?.id || '', effectiveCreateIntentScope);

  const fetchReturns = useCallback(async () => {
    setLoading(true);
    // PR-07 follow-up: dropped requester FK embed; resolved via profile_public_view.
    const { data, error } = await supabase
      .from('returns')
      .select(`
        *,
        customer:customers(farm_name),
        order:orders(order_number),
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

    const requesterIds = [...new Set(
      ((data || []) as Array<{ requested_by?: string | null }>)
        .map((r) => r.requested_by)
        .filter(Boolean) as string[]
    )];
    const requesterMap: Record<string, string> = {};
    if (requesterIds.length > 0) {
      const { data: requesters } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', requesterIds);
      (requesters || []).forEach((p: { id: string | null; full_name: string | null }) => { if (p.id) requesterMap[p.id] = p.full_name || 'Unknown'; });
    }

    const rows = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name: string }; order?: { order_number: string }; requested_by?: string | null; items?: unknown[] }>).map((r) => ({
      ...r,
      customer_name: r.customer?.farm_name || 'Unknown',
      order_number: r.order?.order_number || null,
      requester_name: r.requested_by ? requesterMap[r.requested_by as string] || 'Unknown' : 'Unknown',
      item_count: r.items?.length || 0,
    })) as unknown as ReturnRow[];
    setReturns(rows);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchReturns();
  }, [fetchReturns]);

  const loadCreateData = async () => {
    const custRes = await supabase.from('customers').select('id, farm_name, assigned_tier').eq('is_active', true).order('farm_name');
    setCustomers((custRes.data || []) as unknown as Customer[]);
  };

  const loadOrderItems = async (orderId: string, preserveDraftItems = false) => {
    const requestId = ++orderItemsRequestRef.current;
    if (!preserveDraftItems) setNewItems([]);
    if (!orderId) { setOrderItems([]); return; }
    const [itemsResult, priorReturnsResult] = await Promise.all([
      supabase
        .from('order_items')
        .select('id, product_id, product_name, price_per_unit, quantity_delivered, unit_size, section_name, product:products(id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, product_family:product_families(name))')
        .eq('order_id', orderId)
        .gt('quantity_delivered', 0)
        .order('sort_order'),
      supabase
        .from('returns')
        .select('items:return_items(order_item_id, quantity)')
        .eq('order_id', orderId)
        .is('deleted_at', null)
        .not('status', 'in', '("rejected","cancelled")'),
    ]);
    // A slower response for the previously selected order must not overwrite the
    // product list for the order currently shown in the form.
    if (requestId !== orderItemsRequestRef.current) return;
    if (itemsResult.error || priorReturnsResult.error) {
      toast('error', 'Could not determine the remaining returnable quantities');
      setOrderItems([]);
      return;
    }
    const priorQuantityByOrderItem = new Map<string, number>();
    const priorReturns = (priorReturnsResult.data || []) as unknown as Array<{
      items: Array<{ order_item_id: string | null; quantity: number }> | null;
    }>;
    for (const priorReturn of priorReturns) {
      for (const item of priorReturn.items || []) {
        if (!item.order_item_id) continue;
        priorQuantityByOrderItem.set(
          item.order_item_id,
          (priorQuantityByOrderItem.get(item.order_item_id) || 0) + Number(item.quantity),
        );
      }
    }
    const returnableItems = ((itemsResult.data || []) as Omit<ReturnableOrderItem, 'quantity_returnable'>[])
      .map((item) => ({
        ...item,
        quantity_returnable: Math.max(0, Number(item.quantity_delivered) - (priorQuantityByOrderItem.get(item.id) || 0)),
      }))
      .filter((item) => item.quantity_returnable > 0);
    setOrderItems(returnableItems);
  };

  const loadCustomerOrders = async (customerId: string) => {
    const requestId = ++customerOrdersRequestRef.current;
    if (!customerId) {
      setCustomerOrders([]);
      return;
    }
    const { data } = await supabase
      .from('orders')
      .select('id, order_number, order_date')
      .eq('customer_id', customerId)
      .in('status', ['confirmed', 'partially_fulfilled', 'fulfilled'])
      .is('deleted_at', null)
      .order('order_date', { ascending: false });
    if (requestId !== customerOrdersRequestRef.current) return;
    setCustomerOrders((data || []) as Order[]);
  };

  const openCreate = () => {
    customerOrdersRequestRef.current += 1;
    orderItemsRequestRef.current += 1;
    loadCreateData();
    if (unresolvedCreateIntent) {
      setNewForm({ ...unresolvedCreateIntent.form });
      setNewItems(unresolvedCreateIntent.items.map((item) => ({ ...item })));
      setCustomerOrders([]);
      setOrderItems([]);
      void loadCustomerOrders(unresolvedCreateIntent.form.customer_id);
      void loadOrderItems(unresolvedCreateIntent.form.order_id, true);
      setShowCreate(true);
      return;
    }
    setNewForm({ customer_id: '', order_id: '', reason: 'defective', reason_notes: '', notes: '' });
    setNewItems([]);
    setCustomerOrders([]);
    setOrderItems([]);
    setShowCreate(true);
  };

  const closeCreate = () => {
    if (creating) return;
    customerOrdersRequestRef.current += 1;
    orderItemsRequestRef.current += 1;
    setShowCreate(false);
  };

  const addItem = () => {
    setNewItems([
      ...newItems,
      { order_item_id: '', product_id: '', product_name: '', quantity: 1, unit: 'ea', unit_price_cents: 0, condition: 'unopened', restock: true, notes: '', max_quantity: 0 },
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
    if (!newForm.order_id) {
      toast('error', 'Select the original order so quantities and credit prices can be verified');
      return;
    }
    if (newItems.length === 0) {
      toast('error', 'Add at least one return item');
      return;
    }

    // Validate all items have a product selected (prevent empty UUID)
    const invalidItems = newItems.filter(item => !item.order_item_id || !item.product_id || item.quantity <= 0 || item.quantity > item.max_quantity);
    if (invalidItems.length > 0) {
      toast('error', `Please select a product for all ${invalidItems.length} item(s)`);
      return;
    }
    const selectedOrderItemIds = newItems.map((item) => item.order_item_id);
    if (new Set(selectedOrderItemIds).size !== selectedOrderItemIds.length) {
      toast('error', 'Each delivered order item can only be returned once per return');
      return;
    }
    const requestIntent = unresolvedCreateIntent?.intent || createIntent;
    if (!unresolvedCreateIntent) {
      setUnresolvedCreateIntent({
        form: { ...newForm },
        items: newItems.map((item) => ({ ...item })),
        intent: requestIntent,
      });
    }

    await runCriticalAction({
      action: async () => {
        // Atomic + idempotent creation via create_return RPC (returns_rpc_gating,
        // PARKED-004): replaces the prior next_return_number + two direct inserts.
        const createKey = createIdem.getKey();
        let { data, error } = await supabase.rpc('create_return', {
          p_return: requestIntent.returnPayload,
          p_items: requestIntent.itemsPayload,
          p_idempotency_key: createKey,
        });
        if (error) {
          const committedResult = committedCreateResultFromIntentMismatch(error);
          if (committedResult === null) {
            if (isDefinitiveRpcRejection(error)) {
              createIdem.resetKey();
              setUnresolvedCreateIntent(null);
            }
            throw mapReturnPolicyRpcError(error);
          }
          data = committedResult;
          error = null;
        }
        assertRpcResult<{ return_id: string; return_number: string; item_count: number }>(data, 'create_return');
        createIdem.resetKey();
        setUnresolvedCreateIntent(null);
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
    const requestId = ++returnDetailRequestRef.current;
    setActiveReturn(ret);
    setShowDetail(true);
    setDetailItems([]);
    setLoadingDetail(true);

    try {
      const { data, error } = await supabase
        .from('return_items')
        .select('*, product:products(id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, product_family:product_families(name))')
        .eq('return_id', ret.id)
        .order('sort_order');

      if (requestId !== returnDetailRequestRef.current) return;
      if (error) {
        Sentry.captureException(error, { extra: { context: 'load_return_detail_items', returnId: ret.id } });
        toast('error', 'Failed to load return item details');
        setDetailItems([]);
      } else {
        setDetailItems((data || []) as unknown as DetailReturnItem[]);
      }
    } catch (error) {
      if (requestId !== returnDetailRequestRef.current) return;
      Sentry.captureException(error, { extra: { context: 'load_return_detail_items', returnId: ret.id } });
      toast('error', 'Failed to load return item details');
      setDetailItems([]);
    } finally {
      if (requestId === returnDetailRequestRef.current) setLoadingDetail(false);
    }
  };

  const closeDetail = () => {
    returnDetailRequestRef.current += 1;
    setShowDetail(false);
    setLoadingDetail(false);
    setDetailItems([]);
  };

  // Workflow actions
  const handleApprove = async () => {
    if (!activeReturn || !profile) return;
    await runCriticalAction({
      action: async () => {
        const approveKey = approveIdem.getKey();
        const { data, error } = await supabase.rpc('approve_return', {
          p_return_id: activeReturn.id,
          p_approved_by: profile.id,
          p_idempotency_key: approveKey,
        });
        if (error) throw mapReturnPolicyRpcError(error);
        assertRpcResult(data, 'approve_return');

        approveIdem.resetKey();
        await logActivity({ event: 'return_approved', description: `Return ${activeReturn.return_number} approved`, performedBy: profile.id, entityType: 'return', entityId: activeReturn.id });
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
        const rejectKey = rejectIdem.getKey();
        const { data, error } = await supabase.rpc('reject_return', {
          p_return_id: activeReturn.id,
          p_rejected_by: profile.id,
          p_idempotency_key: rejectKey,
        });
        if (error) throw mapReturnPolicyRpcError(error);
        assertRpcResult(data, 'reject_return');
        rejectIdem.resetKey();

        await logActivity({ event: 'return_rejected', description: `Return ${activeReturn.return_number} rejected`, performedBy: profile.id, entityType: 'return', entityId: activeReturn.id });
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

  const handleCancel = async (reason: string) => {
    if (!activeReturn || !profile) return;
    // Only requested/approved/received returns can be cancelled (not credited or rejected)
    const cancellableStatuses = ['requested', 'approved', 'received'];
    if (!cancellableStatuses.includes(activeReturn.status)) {
      toast('error', `Cannot cancel a return in '${activeReturn.status}' status`);
      return;
    }
    await runCriticalAction({
      action: async () => {
        const cancelScope = JSON.stringify([activeReturn.id, reason.trim()]);
        const cancelKey = cancelIdem.getKeyFor(cancelScope);
        const { data, error } = await supabase.rpc('cancel_return', {
          p_return_id: activeReturn.id,
          p_reason: reason,
          p_performed_by: profile.id,
          p_idempotency_key: cancelKey,
        });
        if (error) throw mapReturnPolicyRpcError(error);
        cancelIdem.resetKeyFor(cancelScope);
        const result = assertRpcResult<{ was_received: boolean; reversed_count: number; skipped_count: number }>(data, 'cancel_return');
        if (result.was_received && result.reversed_count > 0) {
          toast('info', `Inventory restock reversed for ${result.reversed_count} item(s).`);
        }
        if (result.was_received && result.skipped_count > 0) {
          // Wave B audit B-2: surface the skipped-reversal case so the
          // admin knows to reconcile manually.
          toast('warning', `${result.skipped_count} item(s) had a missing inventory row at cancel time — restock could not be reversed automatically. Reconcile manually.`);
        }
        await logActivity({ event: 'return_cancelled', description: `Return ${activeReturn.return_number} cancelled: ${reason}`, performedBy: profile.id, entityType: 'return', entityId: activeReturn.id });
      },
      toast,
      successMessage: 'Return cancelled',
      setLoading: setCancelling,
      sentryTag: 'cancel_return',
      onSuccess: () => {
        setCancelModalOpen(false);
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
        const { data, error } = await supabase.rpc('receive_return', {
          p_return_id: activeReturn.id,
          p_received_by: profile.id,
          p_idempotency_key: receiveKey,
        });
        if (error) throw mapReturnPolicyRpcError(error);
        assertRpcResult(data, 'receive_return');

        receiveIdem.resetKey();
        await logActivity({ event: 'return_received', description: `Return ${activeReturn.return_number} received, inventory restocked`, performedBy: profile.id, entityType: 'return', entityId: activeReturn.id });
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
        const { data, error } = await supabase.rpc('issue_return_credit', {
          p_return_id: activeReturn.id,
          p_actor_id: profile.id,
          p_idempotency_key: creditKey,
        });
        if (error) throw mapReturnPolicyRpcError(error);
        assertRpcResult(data, 'issue_return_credit');

        creditIdem.resetKey();
        await logActivity({ event: 'return_credited', description: `Credit issued for return ${activeReturn.return_number}`, performedBy: profile.id, entityType: 'return', entityId: activeReturn.id });
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
      { key: 'total_credit_cents', header: 'Credit ($)', format: (v: unknown) => ((Number(v) || 0) / 100).toFixed(2) },
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
      <PageHeader
        title="Returns"
        accent="/ RMA"
        actions={(
          <>
          {canBulkAction && <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />}
          <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
            New Return
          </Button>
          </>
        )}
      />

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
      <Modal
        open={showCreate}
        onClose={closeCreate}
        title="New Return / RMA"
        size="large"
        closeDisabled={creating}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer *</label>
              <select
                aria-label="Customer"
                value={newForm.customer_id}
                disabled={createPayloadLocked}
                onChange={(e) => {
                  setNewForm({ ...newForm, customer_id: e.target.value, order_id: '' });
                  orderItemsRequestRef.current += 1;
                  setNewItems([]);
                  setOrderItems([]);
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Original Order *</label>
              <select
                aria-label="Original Order"
                value={newForm.order_id}
                disabled={createPayloadLocked}
                onChange={(e) => {
                  setNewForm({ ...newForm, order_id: e.target.value });
                  loadOrderItems(e.target.value);
                }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Select Order</option>
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
                aria-label="Reason"
                value={newForm.reason}
                disabled={createPayloadLocked}
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
                disabled={createPayloadLocked}
                onChange={(e) => setNewForm({ ...newForm, reason_notes: e.target.value })}
                placeholder="Additional details..."
              />
            </div>
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Return Items</label>
              <Button size="sm" variant="secondary" onClick={addItem} disabled={!newForm.order_id || createPayloadLocked}>
                <Plus className="w-3 h-3" /> Add Item
              </Button>
            </div>
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {orderItems.some((p) => normalizeReturnPolicy(p.product?.return_policy) === 'no_return') && (
                <p className="w-full min-w-0 text-xs font-medium text-red-700">
                  Products marked no return are disabled. The server also refuses them with {RETURN_POLICY_NO_RETURN_CODE}.
                </p>
              )}
              {newItems.map((item, idx) => {
                const selectedOrderItem = orderItems.find((p) => p.id === item.order_item_id);
                return (
                  <div key={idx} className="flex min-w-0 flex-col gap-2 rounded-lg bg-gray-50 p-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <select
                    aria-label={`Return product ${idx + 1}`}
                    value={item.order_item_id}
                    disabled={createPayloadLocked}
                    onChange={(e) => {
                      const p = orderItems.find((orderItem) => orderItem.id === e.target.value);
                      const updated = [...newItems];
                      updated[idx] = {
                        ...updated[idx],
                        order_item_id: e.target.value,
                        product_id: p?.product_id || '',
                        product_name: p?.product_name || '',
                        unit: p?.unit_size || 'ea',
                        unit_price_cents: p ? Math.round(Number(p.price_per_unit) * 100) : 0,
                        max_quantity: p ? p.quantity_returnable : 0,
                      };
                      setNewItems(updated);
                    }}
                    className="w-full min-w-0 flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  >
                    <option value="">Select Product</option>
                    {orderItems
                      .filter((p) => (
                        p.id === item.order_item_id
                        || !newItems.some((other, otherIdx) => otherIdx !== idx && other.order_item_id === p.id)
                      ))
                      .map((p) => (
                      <option key={p.id} value={p.id} disabled={normalizeReturnPolicy(p.product?.return_policy) === 'no_return'}>
                        {productOptionLabel({ id: p.product_id, product_name: p.product_name, unit_size: p.unit_size, ...p.product })} — {p.section_name || 'No section'} — ${Number(p.price_per_unit).toFixed(2)}/{p.unit_size || 'ea'} (returnable {p.quantity_returnable} of {p.quantity_delivered})
                      </option>
                      ))}
                  </select>
                  {selectedOrderItem?.product && (
                    <div className="min-w-0 flex-1">
                      <ProductOptionDetails product={selectedOrderItem.product} />
                      {normalizeReturnPolicy(selectedOrderItem.product.return_policy) === 'no_return' && <p className="mt-1 text-xs font-medium text-red-700">This Product is no return and cannot be added to a return.</p>}
                    </div>
                  )}
                  <input
                    aria-label={`Return quantity ${idx + 1}`}
                    type="number"
                    step="0.01"
                    min="0"
                    max={item.max_quantity || undefined}
                    value={item.quantity || ''}
                    disabled={createPayloadLocked}
                    onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)}
                    placeholder="Qty"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green sm:w-20"
                  />
                  <select
                    aria-label={`Return condition ${idx + 1}`}
                    value={item.condition}
                    disabled={createPayloadLocked}
                    onChange={(e) => updateItem(idx, 'condition', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green sm:w-28"
                  >
                    <option value="unopened">Unopened</option>
                    <option value="opened">Opened</option>
                    <option value="damaged">Damaged</option>
                    <option value="expired">Expired</option>
                  </select>
                  <label className="flex w-full items-center gap-1 text-xs text-gray-600 sm:w-auto whitespace-nowrap">
                    <input
                      aria-label={`Restock return item ${idx + 1}`}
                      type="checkbox"
                      checked={item.restock}
                      disabled={createPayloadLocked}
                      onChange={(e) => updateItem(idx, 'restock', e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    Restock
                  </label>
                  <button aria-label={`Remove return item ${idx + 1}`} onClick={() => removeItem(idx)} disabled={createPayloadLocked} className="self-end text-red-400 hover:text-red-600 p-1 disabled:opacity-50 sm:self-auto">
                    <XCircle className="w-4 h-4" />
                  </button>
                  </div>
                );
              })}
              {newItems.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">No items added</p>
              )}
            </div>
          </div>

          <Input
            label="Notes (Optional)"
            value={newForm.notes}
            disabled={createPayloadLocked}
            onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })}
            placeholder="Additional notes for this return..."
          />

          {unresolvedCreateIntent && (
            <p className="text-xs text-amber-700">
              The previous response was not confirmed. Retry this exact return so the server can replay or reconcile the committed receipt safely.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="secondary" onClick={closeCreate} disabled={creating}>Cancel</Button>
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
        open={!!confirmAction && (confirmAction.type === 'approve' || confirmAction.type === 'reject')}
        onClose={() => setConfirmAction(null)}
        onConfirm={async () => {
          if (!confirmAction) return;
          setConfirmAction(null);
          if (confirmAction.type === 'approve') await handleApprove();
          else if (confirmAction.type === 'reject') await handleReject();
        }}
        title={confirmAction?.title || ''}
        message={confirmAction?.message || ''}
        confirmLabel={confirmAction?.type === 'approve' ? 'Approve' : 'Reject'}
        variant={confirmAction?.type === 'approve' ? 'info' : 'danger'}
      />

      <ReasonModal
        open={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        onConfirm={(reason) => handleCancel(reason)}
        title="Cancel Return"
        message={
          activeReturn?.status === 'received'
            ? 'This return has already been received and inventory was restocked. Cancelling will REVERSE the restock (decrement inventory back).'
            : 'This will cancel the return. This cannot be undone.'
        }
        confirmLabel="Cancel Return"
        variant="danger"
        loading={cancelling}
        placeholder="Why is this return being cancelled?"
      />

      {/* Return Detail Modal */}
      <Modal
        open={showDetail}
        onClose={closeDetail}
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
              <ReturnDetailItems items={detailItems} formatCents={formatCents} />
            )}

            {activeReturn.notes && (
              <p className="text-sm text-gray-600"><span className="font-medium">Notes:</span> {activeReturn.notes}</p>
            )}

            {/* Workflow Actions */}
            {isAdmin && (
              <div className="flex flex-col gap-3 pt-2 border-t sm:flex-row sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  {activeReturn.status === 'requested' && (
                    <Button variant="secondary" onClick={() => setConfirmAction({ type: 'reject', title: 'Reject Return', message: 'Are you sure you want to reject this return? This cannot be undone.' })} icon={<XCircle className="w-4 h-4" />}>
                      Reject
                    </Button>
                  )}
                  {(activeReturn.status === 'requested' || activeReturn.status === 'approved' || activeReturn.status === 'received') && (
                    <Button variant="danger" onClick={() => setCancelModalOpen(true)} icon={<Ban className="w-4 h-4" />}>
                      Cancel
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
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
