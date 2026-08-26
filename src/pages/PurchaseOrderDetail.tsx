import { useEffect, useState , useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PackageCheck, Pencil, Ban, Download, Send, RotateCcw, MessageSquarePlus } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUncertainMutationIntent } from '../hooks/useUncertainMutationIntent';
import {
  purchaseOrderCentsToDollars,
  purchaseOrderLineTotalCents,
} from '../lib/purchaseOrderMoney';
import { buildPurchaseOrderEditItemsPayload } from '../lib/purchaseOrderEditPayload';
import { notifyDamagedReceiving, notifyOverReceive } from '../lib/notificationTriggers';
import { logActivity } from '../lib/activityLogger';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { parseLocalDate } from '../lib/dateUtils';
import { formatUSD as fmt } from '../lib/money';
import QuickTaskModal from '../components/team/QuickTaskModal';
import RelatedNotes from '../components/team/RelatedNotes';
import HelpTip from '../components/ui/HelpTip';
import type { PurchaseOrder, PurchaseOrderItem, POStatus, ReceivingRecord, ReceivingCondition, LinkedEntityType } from '../types';
import { Sentry } from '../lib/sentry';
import { getIdempotencyMismatchResult } from '../lib/idempotency';
import { ProductOptionDetails, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import { ProductSearchResultRow } from '../components/products/ProductSearchResultRow';

type PickerProduct = ProductOptionPresentationModel & {
  unit_size?: string | null;
};

/* ─── Condition badge helpers ─── */
const conditionVariant = (c: string): 'success' | 'error' | 'warning' | 'default' => {
  if (c === 'good') return 'success';
  if (c === 'damaged' || c === 'wrong_product') return 'error';
  if (c === 'short' || c === 'mixed') return 'warning';
  return 'default';
};
const conditionLabel = (c: string) =>
  c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

/* ─── Per-item receive state ─── */
interface ReceiveItemState {
  qty: string;
  condition: ReceivingCondition;
  lot_number: string;
  notes: string;
}

interface ReceivePoIntent {
  itemsPayload: Array<{
    po_item_id: string;
    quantity: number;
    condition: ReceivingCondition;
    lot_number: string | null;
    notes: string | null;
    storage_location: string;
  }>;
  finalPayload: Array<{
    po_item_id: string;
    quantity: number;
    condition: ReceivingCondition;
    lot_number: string | null;
    notes: string | null;
    storage_location: string;
    over_receive_reason?: string;
  }>;
  allowOverReceive: boolean;
  storageLocation: string;
}

export default function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const receiveIdem = useIdempotencyKey('receive_po_items', profile?.id || '', id || '');
  const receiveIntent = useUncertainMutationIntent<ReceivePoIntent>();
  const { resolveIntent: resolveReceiveIntent } = receiveIntent;
  const savePOIdem = useIdempotencyKey('save_purchase_order', profile?.id || '');
  const {
    getKey: getSubmitPOKey,
    resetKey: resetSubmitPOKey,
  } = useIdempotencyKey('submit_purchase_order', `${profile?.id || ''}:${id || ''}`);
  const cancelPOIdem = useIdempotencyKey('cancel_purchase_order', profile?.id || '');
  const reverseIdem = useIdempotencyKey('reverse_receiving_record', profile?.id || '');
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);

  /* Receive modal state */
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveItems, setReceiveItems] = useState<Record<string, ReceiveItemState>>({});
  const [storageLocation, setStorageLocation] = useState('Main Warehouse');
  const [receiveStep, setReceiveStep] = useState<'fill' | 'review'>('fill');
  // Phase 21 — Cleanup G2: over-receive is now opt-in (admin-only) with a required reason.
  // The previous default `p_allow_over_receive: true` produced 15 actual over-receive
  // events in production by accepting whatever quantity was entered without a check.
  const [allowOverReceive, setAllowOverReceive] = useState(false);
  const [overReceiveReason, setOverReceiveReason] = useState('');

  // React Router can reuse this component when only the route parameter changes.
  // Never let a lost-response retry key from one PO replay a different PO's result.
  useEffect(() => {
    resetSubmitPOKey();
    resolveReceiveIntent();
  }, [id, resetSubmitPOKey, resolveReceiveIntent]);

  /* Edit modal state */
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [editForm, setEditForm] = useState({
    vendor: '',
    status: 'draft' as POStatus,
    submitted_date: '',
    expected_delivery_date: '',
    notes: '',
  });
  const [editItems, setEditItems] = useState<Array<{
    id: string;
    product_id: string;
    product_name: string;
    unit_size: string;
    quantity_ordered: string;
    unit_cost: string;
    quantity_received: number;
    product: PickerProduct | null;
  }>>([]);
  const [editProductSearch, setEditProductSearch] = useState<number | null>(null); // index of item being changed
  const [editProductQuery, setEditProductQuery] = useState('');
  const [editProductResults, setEditProductResults] = useState<PickerProduct[]>([]);

  /* Receiving history */
  const [receivingHistory, setReceivingHistory] = useState<ReceivingRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  /* Reverse receiving modal */
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseRecord, setReverseRecord] = useState<ReceivingRecord | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reversing, setReversing] = useState(false);

  const isAdmin = role === 'admin';
  const canManagePO = role === 'admin' || role === 'sales_rep';
  const canReceive = canManagePO;

  const fetchPO = useCallback(async () => {
    const { data: poData, error: poError } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', id!)
      .maybeSingle();

    if (poError) {
      Sentry.captureException(poError, { tags: { source: 'fetch', action: 'load_purchase_order' } });
      toast('error', 'Failed to load purchase order');
      setLoading(false);
      return;
    }
    if (poData) {
      setPo(poData as PurchaseOrder);
      const { data: itemsData, error: itemsError } = await supabase
        .from('purchase_order_items')
        .select('*, product:products(*, product_family:product_families(name))')
        .eq('purchase_order_id', id!);
      if (itemsError) {
        Sentry.captureException(itemsError, { tags: { source: 'fetch', action: 'load_purchase_order_items' } });
        toast('error', 'Failed to load purchase order products');
        setLoading(false);
        return;
      }
      setItems((itemsData || []) as unknown as PurchaseOrderItem[]);
    }
    setLoading(false);
  }, [id, toast]);

  const fetchReceivingHistory = useCallback(async () => {
    setHistoryLoading(true);
    // PR-07 follow-up: dropped receiver FK embed; resolved via profile_public_view.
    const { data, error } = await supabase
      .from('receiving_records')
      .select('*, product:products(product_name)')
      .eq('purchase_order_id', id!)
      .order('received_at', { ascending: false });

    if (error) {
      // Supabase RETURNS this error (doesn't throw) — surface it instead of
      // silently leaving the receiving history empty (Field Mode F6 class).
      toast('error', 'Could not load receiving history.');
    }
    if (!error && data) {
      const receiverIds = [...new Set(
        (data as Array<{ received_by?: string | null }>)
          .map((r) => r.received_by)
          .filter(Boolean) as string[]
      )];
      const receiverMap: Record<string, string> = {};
      if (receiverIds.length > 0) {
        const { data: receivers } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', receiverIds);
        (receivers || []).forEach((p: { id: string | null; full_name: string | null }) => { if (p.id) receiverMap[p.id] = p.full_name ?? ''; });
      }
      const rows = (data as Array<ReceivingRecord & { product?: { product_name: string }; received_by?: string | null }>).map((r) => ({
        ...r,
        product_name: r.product?.product_name || 'Unknown',
        received_by_name: r.received_by ? receiverMap[r.received_by] || 'Unknown' : 'Unknown',
      }));
      setReceivingHistory(rows as ReceivingRecord[]);
    }
    setHistoryLoading(false);
  }, [id, toast]);

  useEffect(() => {
    if (id) {
      fetchPO();
      fetchReceivingHistory();
    }
  }, [id, fetchPO, fetchReceivingHistory]);

  /* ─── Open receive modal ─── */
  const openReceiveModal = () => {
    if (receiveIntent.isIntentLocked) {
      setReceiveStep('review');
      setReceiveOpen(true);
      return;
    }
    const initial: Record<string, ReceiveItemState> = {};
    items.forEach((item) => {
      initial[item.id] = {
        qty: '0',
        condition: 'good',
        lot_number: '',
        notes: '',
      };
    });
    setReceiveItems(initial);
    setStorageLocation('Main Warehouse');
    setReceiveStep('fill');
    setAllowOverReceive(false);
    setOverReceiveReason('');
    setReceiveOpen(true);
  };

  const updateReceiveItem = (itemId: string, field: keyof ReceiveItemState, value: string) => {
    setReceiveItems((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], [field]: value },
    }));
  };

  /* ─── Submit receive ─── */
  const handleReceive = async () => {
    if (!profile) return;

    const itemsPayload = items
      .filter((item) => parseFloat(receiveItems[item.id]?.qty || '0') > 0)
      .map((item) => {
        const ri = receiveItems[item.id];
        return {
          po_item_id: item.id,
          quantity: parseFloat(ri.qty || '0'),
          condition: ri.condition,
          lot_number: ri.lot_number || null,
          notes: ri.notes || null,
          storage_location: storageLocation,
        };
      });

    if (itemsPayload.length === 0) {
      toast('error', 'Enter a quantity for at least one item');
      return;
    }

    // Compute whether any line would over-receive based on remaining-to-receive
    const wouldOverReceive = itemsPayload.some((ip) => {
      const poItem = items.find((i) => i.id === ip.po_item_id);
      if (!poItem) return false;
      const remaining = (poItem.quantity_ordered || 0) - (poItem.quantity_received || 0);
      return ip.quantity > remaining;
    });

    if (wouldOverReceive) {
      if (role !== 'admin') {
        toast('error', 'Over-receive requires admin role. Reduce the quantity to remaining-to-receive or fewer.');
        return;
      }
      if (!allowOverReceive) {
        toast('error', 'Quantity exceeds remaining-to-receive. Check the over-receive override and provide a reason.');
        return;
      }
      if (!overReceiveReason.trim()) {
        toast('error', 'Reason is required when over-receiving.');
        return;
      }
    }

    // Send the reason as a dedicated field. The RPC decides which locked line
    // is actually over-received and appends the audit marker server-side.
    const finalPayload = wouldOverReceive
      ? itemsPayload.map((ip) => ({
          ...ip,
          over_receive_reason: overReceiveReason.trim(),
        }))
      : itemsPayload;

    const request = receiveIntent.beginIntent({
      itemsPayload,
      finalPayload,
      allowOverReceive: wouldOverReceive && allowOverReceive,
      storageLocation,
    });

    await runCriticalAction({
      action: async () => {
        const idemKey = receiveIdem.getKey();
        const { data, error } = await supabase.rpc('receive_po_items', {
          p_items: request.finalPayload,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
          p_allow_over_receive: request.allowOverReceive,
        });
        let responseData: unknown;
        if (error) {
          const receipt = getIdempotencyMismatchResult(error, 'receive_po_items');
          const committedRecordIds = receipt?.receiving_record_ids;
          if (
            Array.isArray(committedRecordIds)
            && committedRecordIds.every((recordId) => typeof recordId === 'string')
          ) {
            responseData = receipt;
            toast('warning', 'The earlier receiving update already completed. The PO has been refreshed instead of receiving it twice.');
          } else if (receiveIntent.classifyFailure(error) === 'definitive') {
            receiveIdem.resetKey();
            throw error;
          } else {
            throw new Error('The receiving update may already be recorded. Retry the locked request unchanged to reconcile it.');
          }
        } else {
          responseData = assertRpcResult(data, 'receive_po_items');
        }
        receiveIdem.resetKey();
        receiveIntent.resolveIntent();

        // AUDIT 3.2: Notify admins about damaged/non-good items
        if (po) {
          const damagedItems = request.itemsPayload
            .filter((ip) => ip.condition && ip.condition !== 'good')
            .map((ip) => {
              const poItem = items.find((i) => i.id === ip.po_item_id);
              return {
                productName: (poItem?.product as unknown as { product_name: string } | undefined)?.product_name || 'Unknown',
                quantity: ip.quantity,
                condition: ip.condition,
              };
            });
          if (damagedItems.length > 0) {
            notifyDamagedReceiving(po.po_number, damagedItems, po.id);
          }

          // AUDIT: Notify admins about over-received items
          const overItems = request.itemsPayload
            .filter((ip) => {
              const poItem = items.find((i) => i.id === ip.po_item_id);
              if (!poItem) return false;
              const remaining = poItem.quantity_ordered - poItem.quantity_received;
              return ip.quantity > remaining;
            })
            .map((ip) => {
              const poItem = items.find((i) => i.id === ip.po_item_id);
              return {
                productName: (poItem?.product as unknown as { product_name: string } | undefined)?.product_name || 'Unknown',
                quantityOrdered: poItem?.quantity_ordered || 0,
                quantityReceived: ip.quantity,
              };
            });
          if (overItems.length > 0) {
            notifyOverReceive(po.po_number, overItems, po.id);
          }
        }

        // Offer PDF download
        const receivingRecordIds = (responseData as { receiving_record_ids?: string[] } | null)?.receiving_record_ids;
        if (receivingRecordIds && receivingRecordIds.length > 0 && po) {
          try {
            const { downloadReceivingPdf } = await import('../lib/receivingPdf');
            await downloadReceivingPdf({
              po_number: po.po_number,
              vendor: po.vendor,
              received_at: new Date().toISOString(),
              received_by_name: profile.full_name || 'Unknown',
              storage_location: request.storageLocation,
              items: request.itemsPayload.map((ip) => {
                const poItem = items.find((i) => i.id === ip.po_item_id);
                return {
                  product_name: (poItem?.product as unknown as { product_name: string } | undefined)?.product_name || 'Unknown',
                  quantity_received: ip.quantity,
                  condition: ip.condition,
                  lot_number: ip.lot_number || undefined,
                  unit_size: poItem?.unit_size || undefined,
                  notes: ip.notes || undefined,
                };
              }),
            });
          } catch {
            // PDF download is non-critical
          }
        }

        setReceiveOpen(false);
        fetchPO();
        fetchReceivingHistory();
      },
      toast,
      successMessage: 'Items received and inventory updated',
      setLoading: setSaving,
      sentryTag: 'receive_po_items',
    });
  };

  /* ─── Download receiving PDF for a history entry ─── */
  const handleDownloadHistoryPdf = async (record: ReceivingRecord) => {
    if (!po) return;
    try {
      const { downloadReceivingPdf } = await import('../lib/receivingPdf');
      await downloadReceivingPdf({
        po_number: po.po_number,
        vendor: po.vendor,
        received_at: record.received_at,
        received_by_name: record.received_by_name || 'Unknown',
        storage_location: record.storage_location,
        items: [{
          product_name: record.product_name || 'Unknown',
          quantity_received: record.quantity_received,
          condition: record.condition,
          lot_number: record.lot_number || undefined,
          unit_size: record.unit_size || undefined,
          notes: record.notes || undefined,
        }],
      });
      toast('success', 'Receiving receipt downloaded');
    } catch {
      toast('error', 'Failed to download receipt');
    }
  };

  const openReverseModal = (rec: ReceivingRecord) => {
    // Codex P2 fix: reset key per receiving-record target.
    reverseIdem.resetKey();
    setReverseRecord(rec);
    setReverseReason('');
    setReverseOpen(true);
  };

  const handleReverseReceiving = async () => {
    if (!reverseRecord || !profile) return;
    if (!reverseReason.trim()) {
      toast('error', 'Please provide a reason for the reversal');
      return;
    }
    setReversing(true);
    try {
      const reverseKey = reverseIdem.getKey();
      const { data, error } = await supabase.rpc('reverse_receiving_record', {
        p_record_id: reverseRecord.id,
        p_reason: reverseReason.trim(),
        p_performed_by: profile.id,
        p_idempotency_key: reverseKey,
      });
      if (error) throw error;
      assertRpcResult(data, 'reverse_receiving_record');
      reverseIdem.resetKey();
      await logActivity({ event: 'receiving_reversed', description: `Receiving record reversed for PO ${po?.po_number}: ${reverseReason.trim()}`, performedBy: profile.id, entityType: 'purchase_order', entityId: po?.id });
      toast('success', 'Receiving record reversed and inventory adjusted');
      setReverseOpen(false);
      setReverseRecord(null);
      fetchPO();
      fetchReceivingHistory();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setReversing(false);
  };

  const openEditModal = () => {
    // Codex P2 fix: reset key per edit-modal open (PO payload editable).
    savePOIdem.resetKey();
    if (!po) return;
    setEditForm({
      vendor: po.vendor,
      status: po.status,
      submitted_date: po.submitted_date || '',
      expected_delivery_date: po.expected_delivery_date || '',
      notes: po.notes || '',
    });
    setEditItems(items.map(item => ({
      id: item.id,
      product_id: item.product_id,
      product_name: (item.product as unknown as { product_name: string })?.product_name || 'Unknown',
      unit_size: item.unit_size || '',
      quantity_ordered: String(item.quantity_ordered),
      unit_cost: String(item.unit_cost),
      quantity_received: item.quantity_received,
      product: (item.product || null) as unknown as PickerProduct | null,
    })));
    setEditProductSearch(null);
    setEditProductQuery('');
    setEditOpen(true);
  };

  // Search products for swapping unreceived PO line items
  useEffect(() => {
    if (editProductSearch === null || editProductQuery.length < 2) {
      setEditProductResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, product_family:product_families(name)')
        .ilike('product_name', `%${editProductQuery}%`)
        .eq('is_active', true)
        .limit(8);
      if (error) {
        Sentry.captureException(error, { tags: { source: 'fetch', action: 'search_purchase_order_products' } });
        toast('error', 'Product search failed. Retry before changing this line.');
        setEditProductResults([]);
        return;
      }
      setEditProductResults((data || []) as unknown as PickerProduct[]);
    }, 250);
    return () => clearTimeout(timer);
  }, [editProductQuery, editProductSearch, toast]);

  const handleSaveEdit = async () => {
    if (!po || !profile) return;
    setSaving(true);

    try {
      // Keep received lines in-place and preserve the exact selected Product UUID
      // for editable lines when the RPC updates this PO atomically.
      const itemsPayload = buildPurchaseOrderEditItemsPayload(editItems);

      const savePOKey = savePOIdem.getKey();
      const { data, error } = await supabase.rpc('save_purchase_order', {
        p_po_id: id!,
        p_po_payload: {
          vendor: editForm.vendor,
          status: editForm.status,
          submitted_date: editForm.submitted_date || null,
          expected_delivery_date: editForm.expected_delivery_date || null,
          notes: editForm.notes || null,
        },
        p_items: itemsPayload,
        p_performed_by: profile.id,
        p_idempotency_key: savePOKey,
      });

      if (error) throw error;
      assertRpcResult(data, 'save_purchase_order');
      savePOIdem.resetKey();

      toast('success', 'Purchase order updated');
      setEditOpen(false);
      fetchPO();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSaving(false);
  };

  const handleSubmitPO = async () => {
    if (!po || !profile) return;
    if (po.status !== 'draft') {
      toast('error', `Cannot submit a PO in '${po.status}' status — must be draft`);
      return;
    }
    setSaving(true);
    try {
      // Submission is a separate intent from editing. Keep this key across a
      // lost-response retry so the RPC replays the committed submit instead of
      // applying a stale draft snapshot.
      const submitKey = getSubmitPOKey();
      const { data, error } = await supabase.rpc('submit_purchase_order', {
        p_po_id: id!,
        p_performed_by: profile.id,
        p_idempotency_key: submitKey,
      });
      if (error) throw error;
      assertRpcResult(data, 'submit_purchase_order');
      resetSubmitPOKey();
      toast('success', `Purchase order ${po.po_number} submitted`);
      fetchPO();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSaving(false);
  };

  const handleCancel = async () => {
    if (!po || !profile) return;
    setSaving(true);

    try {
      const cancelKey = cancelPOIdem.getKey();
      const { data, error } = await supabase.rpc('cancel_purchase_order', {
        p_po_id: id!,
        p_reason: cancelReason || 'Cancelled',
        p_performed_by: profile.id,
        p_idempotency_key: cancelKey,
      });

      if (error) throw error;
      assertRpcResult(data, 'cancel_purchase_order');
      cancelPOIdem.resetKey();

      toast('success', 'Purchase order cancelled');
      setCancelOpen(false);
      setCancelReason('');
      fetchPO();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (!po) {
    return (
      <div className="text-center py-16">
        <p className="text-secondary">Purchase order not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/purchase-orders')}>
          Back to Purchase Orders
        </Button>
      </div>
    );
  }

  /* Items with qty entered for review step */
  const reviewItems = items.filter((item) => parseFloat(receiveItems[item.id]?.qty || '0') > 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <Breadcrumbs items={[
        { label: 'Purchase Orders', href: '/purchase-orders' },
        { label: po.po_number || 'PO' },
      ]} />
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">
          {po.po_number}
          <HelpTip text="View and manage this PO. Click 'Receive Items' to record what arrived — enter quantities, conditions, and lot numbers. Items marked damaged trigger automatic notifications. Check receiving history below for a full audit trail." className="ml-1" />
        </h2>
        <div className="flex items-center gap-2">
          {canReceive && (po.status === 'submitted' || po.status === 'partially_received') && (
            <Button icon={<PackageCheck className="w-4 h-4" />} onClick={openReceiveModal}>
              Receive Items
            </Button>
          )}
          {canManagePO && po.status === 'draft' && (
            <Button icon={<Send className="w-4 h-4" />} onClick={handleSubmitPO} loading={saving}>
              Submit PO
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<MessageSquarePlus className="w-4 h-4" />}
            showChevron={false}
            onClick={() => setQuickTaskOpen(true)}
          >
            Create Task
          </Button>
          {canManagePO && po.status !== 'cancelled' && po.status !== 'fully_received' && (
            <>
              <Button variant="secondary" icon={<Pencil className="w-4 h-4" />} onClick={openEditModal}>
                Edit
              </Button>
              {canManagePO && (po.status === 'draft' || po.status === 'submitted') && (
                <Button variant="danger" icon={<Ban className="w-4 h-4" />} onClick={() => { cancelPOIdem.resetKey(); setCancelOpen(true); }}>
                  Cancel PO
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* PO Summary Card */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">{po.po_number}</h2>
            <p className="text-sm text-secondary mt-1">{po.vendor}</p>
          </div>
          <Badge variant={statusToBadgeVariant[po.status] || 'default'} size="md">
            {po.status.replace(/_/g, ' ')}
          </Badge>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
          <div>
            <p className="text-xs text-secondary">Submitted</p>
            <p className="text-sm font-medium text-nav-dark">
              {po.submitted_date ? parseLocalDate(po.submitted_date).toLocaleDateString() : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary">Expected Delivery</p>
            <p className="text-sm font-medium text-nav-dark">
              {po.expected_delivery_date
                ? parseLocalDate(po.expected_delivery_date).toLocaleDateString()
                : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary">Total Cost</p>
            <p className="text-sm font-medium text-nav-dark">{fmt(po.total_cost)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Status</p>
            <p className="text-sm font-medium text-nav-dark capitalize">
              {po.status.replace(/_/g, ' ')}
            </p>
          </div>
        </div>
      </Card>

      {/* Cancel Info Banner */}
      {po.status === 'cancelled' && po.cancelled_at && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm font-medium text-red-800">This purchase order was cancelled</p>
          <p className="text-xs text-red-600 mt-1">
            {new Date(po.cancelled_at).toLocaleDateString()} at{' '}
            {new Date(po.cancelled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {po.cancel_reason && <> &mdash; {po.cancel_reason}</>}
          </p>
        </div>
      )}

      {/* Line Items */}
      <Card padding={false}>
        <div className="p-5">
          <CardHeader title="Line" accent="Items" />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                  <th className="px-4 py-3 text-left font-medium text-secondary">Qty Ordered</th>
                  <th className="px-4 py-3 text-left font-medium text-secondary">Qty Received</th>
                  <th className="px-4 py-3 text-left font-medium text-secondary">Unit Cost</th>
                  <th className="px-4 py-3 text-left font-medium text-secondary">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 font-medium text-nav-dark">
                      {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                    </td>
                    <td className="px-4 py-3">{item.quantity_ordered}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          item.quantity_received >= item.quantity_ordered
                            ? 'text-emerald-600 font-medium'
                            : ''
                        }
                      >
                        {item.quantity_received}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono">{fmt(item.unit_cost)}</td>
                    <td className="px-4 py-3 font-mono">
                      {fmt(purchaseOrderCentsToDollars(
                        purchaseOrderLineTotalCents(item.quantity_ordered, item.unit_cost),
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {/* Related Notes */}
      <RelatedNotes
        entityType={'purchase_order' as LinkedEntityType}
        entityId={id!}
        onCreateTask={() => setQuickTaskOpen(true)}
      />

      {/* Receiving History */}
      <Card padding={false}>
        <div className="p-5">
          <CardHeader title="Receiving" accent="History" />
          {historyLoading ? (
            <div className="h-20 bg-gray-50 rounded-lg animate-pulse" />
          ) : receivingHistory.length === 0 ? (
            <p className="text-sm text-secondary py-4">No items have been received yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-4 py-3 text-left font-medium text-secondary">Date</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Qty</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Condition</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Lot #</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Location</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">By</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Notes</th>
                    <th className="px-4 py-3 w-10"></th>
                    <th className="px-4 py-3 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {receivingHistory.map((rec) => (
                    <tr key={rec.id} className="border-b border-gray-50">
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm">{new Date(rec.received_at).toLocaleDateString()}</p>
                          <p className="text-xs text-secondary">
                            {new Date(rec.received_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-nav-dark">{rec.product_name || '-'}</td>
                      <td className="px-4 py-3 font-mono">
                        {rec.quantity_received}
                        {rec.unit_size && <span className="text-xs text-secondary ml-1">({rec.unit_size})</span>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={conditionVariant(rec.condition)}>
                          {conditionLabel(rec.condition)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-secondary">{rec.lot_number || '-'}</td>
                      <td className="px-4 py-3 text-xs text-secondary">{rec.storage_location}</td>
                      <td className="px-4 py-3 text-xs">{rec.received_by_name || '-'}</td>
                      <td className="px-4 py-3 text-xs text-secondary max-w-[150px] truncate">{rec.notes || '-'}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleDownloadHistoryPdf(rec)}
                          className="text-crx-green hover:text-crx-green/80 transition-colors"
                          title="Download receipt"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin ? (
                          <button
                            onClick={() => openReverseModal(rec)}
                            className="text-red-400 hover:text-red-600 transition-colors"
                            title="Reverse this receiving entry"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            disabled
                            className="text-gray-300 cursor-not-allowed"
                            title="Ask an admin to reverse this receive."
                            aria-label="Ask an admin to reverse this receive"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Enhanced Receive Modal */}
      <Modal
        open={receiveOpen}
        onClose={() => {
          if (!receiveIntent.isIntentLocked) setReceiveOpen(false);
        }}
        title="Receive"
        accent="Items"
        size="large"
      >
        {receiveStep === 'fill' ? (
          <div className="space-y-4">
            {/* Storage location */}
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">Storage Location</label>
              <Select
                value={storageLocation}
                onChange={(e) => setStorageLocation(e.target.value)}
                options={[
                  { value: 'Main Warehouse', label: 'Main Warehouse' },
                  { value: 'Secondary Storage', label: 'Secondary Storage' },
                  { value: 'Cold Storage', label: 'Cold Storage' },
                  { value: 'Field Storage', label: 'Field Storage' },
                ]}
              />
            </div>

            <div className="border-t pt-4">
              <h4 className="text-sm font-medium text-nav-dark mb-3">Items to Receive</h4>
              <div className="space-y-4">
                {items.map((item) => {
                  const remaining = item.quantity_ordered - item.quantity_received;
                  const ri = receiveItems[item.id];
                  if (!ri) return null;
                  const enteredQty = parseFloat(ri.qty || '0');
                  const isOverReceive = enteredQty > 0 && enteredQty > remaining;

                  return (
                    <div
                      key={item.id}
                      className={`border rounded-xl p-4 space-y-3 ${isOverReceive ? 'border-orange-200 bg-orange-50/30' : 'border-gray-100'}`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-nav-dark">
                            {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                          </p>
                          <p className="text-xs text-secondary">
                            {remaining > 0 ? `${remaining} remaining` : 'Fully received'} of {item.quantity_ordered}
                            {item.unit_size && <span> ({item.unit_size})</span>}
                          </p>
                          {isOverReceive && (
                            <p className="text-xs text-orange-600 font-medium mt-0.5">
                              ⚠ Over-receive: {enteredQty - remaining} extra — admin will be notified
                            </p>
                          )}
                        </div>
                        <div className="w-24">
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            value={ri.qty}
                            onChange={(e) => updateReceiveItem(item.id, 'qty', e.target.value)}
                            placeholder="0"
                          />
                        </div>
                      </div>

                      {enteredQty > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pl-4 border-l-2 border-crx-green/30">
                          <div>
                            <label className="block text-xs text-secondary mb-1">Condition</label>
                            <Select
                              value={ri.condition}
                              onChange={(e) => updateReceiveItem(item.id, 'condition', e.target.value)}
                              options={[
                                { value: 'good', label: 'Good' },
                                { value: 'damaged', label: 'Damaged' },
                                { value: 'short', label: 'Short' },
                                { value: 'wrong_product', label: 'Wrong Product' },
                                { value: 'mixed', label: 'Mixed' },
                              ]}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-secondary mb-1">Lot Number</label>
                            <Input
                              value={ri.lot_number}
                              onChange={(e) => updateReceiveItem(item.id, 'lot_number', e.target.value)}
                              placeholder="Optional"
                            />
                          </div>
                          <div className="sm:col-span-1">
                            <label className="block text-xs text-secondary mb-1">Notes</label>
                            <Input
                              value={ri.notes}
                              onChange={(e) => updateReceiveItem(item.id, 'notes', e.target.value)}
                              placeholder="Any issues or notes"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setReceiveOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => setReceiveStep('review')}
                disabled={reviewItems.length === 0}
              >
                Review ({reviewItems.length} item{reviewItems.length !== 1 ? 's' : ''})
              </Button>
            </div>
          </div>
        ) : (
          /* Review Step */
          <div className="space-y-4">
            {receiveIntent.isIntentLocked && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                The last response was uncertain. This exact receiving request is locked so inventory cannot be received twice. Retry it unchanged to reconcile the result.
              </div>
            )}
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-secondary mb-2">STORAGE LOCATION</p>
              <p className="text-sm font-medium text-nav-dark">{storageLocation}</p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-3 py-2 text-left font-medium text-secondary">Product</th>
                    <th className="px-3 py-2 text-left font-medium text-secondary">Qty</th>
                    <th className="px-3 py-2 text-left font-medium text-secondary">Condition</th>
                    <th className="px-3 py-2 text-left font-medium text-secondary">Lot #</th>
                    <th className="px-3 py-2 text-left font-medium text-secondary">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewItems.map((item) => {
                    const ri = receiveItems[item.id];
                    const enteredQty = parseFloat(ri.qty || '0');
                    const remaining = item.quantity_ordered - item.quantity_received;
                    const isOver = enteredQty > remaining;
                    return (
                      <tr key={item.id} className="border-b border-gray-50">
                        <td className="px-3 py-2 font-medium text-nav-dark">
                          {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {ri.qty}
                          {isOver && (
                            <span className="text-xs text-orange-600 font-medium ml-1">⚠ over</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={conditionVariant(ri.condition)}>
                            {conditionLabel(ri.condition)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-xs font-mono">{ri.lot_number || '-'}</td>
                        <td className="px-3 py-2 text-xs text-secondary">{ri.notes || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Phase 21 — Over-receive override (admin-only). Surface only when
                at least one line exceeds the remaining-to-receive amount. */}
            {(() => {
              const wouldOver = reviewItems.some((item) => {
                const qty = parseFloat(receiveItems[item.id]?.qty || '0');
                const remaining = (item.quantity_ordered || 0) - (item.quantity_received || 0);
                return qty > remaining;
              });
              if (!wouldOver) return null;
              if (role !== 'admin') {
                return (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    One or more lines exceed the remaining-to-receive quantity. Only admins can record an over-receive. Reduce the quantity to continue, or ask an admin to record this.
                  </div>
                );
              }
              return (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-amber-900">
                    <input
                      type="checkbox"
                      checked={allowOverReceive}
                      onChange={(e) => setAllowOverReceive(e.target.checked)}
                      disabled={receiveIntent.isIntentLocked}
                      className="rounded border-amber-400"
                    />
                    Confirm over-receive (admin override)
                  </label>
                  <p className="text-xs text-amber-800 ml-6">
                    One or more lines have a received quantity greater than the remaining ordered quantity. This will record the actual amount delivered and exceed the PO total. A reason is required.
                  </p>
                  {allowOverReceive && (
                    <textarea
                      value={overReceiveReason}
                      onChange={(e) => setOverReceiveReason(e.target.value)}
                      placeholder="Reason (e.g. vendor over-shipped and we are keeping the extra)"
                      rows={2}
                      disabled={receiveIntent.isIntentLocked}
                      className="ml-6 w-[calc(100%-1.5rem)] rounded border border-amber-400 px-2 py-1 text-sm"
                    />
                  )}
                </div>
              );
            })()}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setReceiveStep('fill')} disabled={receiveIntent.isIntentLocked}>
                Back
              </Button>
              <Button variant="secondary" onClick={() => setReceiveOpen(false)} disabled={receiveIntent.isIntentLocked}>
                Cancel
              </Button>
              <Button onClick={handleReceive} loading={saving}>
                {receiveIntent.isIntentLocked ? 'Retry Exact Receiving' : 'Confirm & Receive'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Edit Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Purchase" accent="Order">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Vendor</label>
            <Input
              value={editForm.vendor}
              onChange={(e) => setEditForm(prev => ({ ...prev, vendor: e.target.value }))}
              placeholder="Vendor name"
            />
          </div>
          {/* Status is changed through workflow actions (Submit, Receive, Cancel), not manual dropdown */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">Submitted Date</label>
              <Input
                type="date"
                value={editForm.submitted_date}
                onChange={(e) => setEditForm(prev => ({ ...prev, submitted_date: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">Expected Delivery</label>
              <Input
                type="date"
                value={editForm.expected_delivery_date}
                onChange={(e) => setEditForm(prev => ({ ...prev, expected_delivery_date: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Notes</label>
            <Input
              value={editForm.notes}
              onChange={(e) => setEditForm(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Additional notes"
            />
          </div>

          <div className="border-t pt-4">
            <h4 className="text-sm font-medium text-nav-dark mb-3">Line Items</h4>
            <div className="space-y-3">
              {editItems.map((item, idx) => {
                const isReceived = item.quantity_received > 0;
                return (
                <div key={item.id || idx} className="grid grid-cols-[1fr,100px,100px] gap-2 items-start">
                  <div>
                    {isReceived ? (
                      <>
                        <p className="text-sm font-medium text-nav-dark">{item.product_name}</p>
                        {item.product && <ProductOptionDetails product={item.product} />}
                        <p className="text-xs text-amber-600">Received line locked · {item.quantity_received} received</p>
                      </>
                    ) : editProductSearch === idx ? (
                      <div className="relative">
                        <Input
                          value={editProductQuery}
                          onChange={(e) => setEditProductQuery(e.target.value)}
                          placeholder="Search products..."
                          // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in inline editor; user just clicked to edit a row
                          autoFocus
                        />
                        {editProductResults.length > 0 && (
                          <div className="absolute z-10 left-0 right-0 top-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                            {editProductResults.map((p) => (
                              <ProductSearchResultRow
                                key={p.id}
                                product={p}
                                trailing={null}
                                onClick={() => {
                                  const newItems = [...editItems];
                                  newItems[idx] = {
                                    ...newItems[idx],
                                    product_id: p.id,
                                    product_name: p.product_name || 'Unnamed product',
                                    unit_size: p.unit_size || '',
                                    product: p,
                                  };
                                  setEditItems(newItems);
                                  setEditProductSearch(null);
                                  setEditProductQuery('');
                                }}
                              />
                            ))}
                          </div>
                        )}
                        <button
                          type="button"
                          className="text-xs text-secondary hover:text-nav-dark mt-1"
                          onClick={() => { setEditProductSearch(null); setEditProductQuery(''); }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div>
                        <button
                          type="button"
                          className="text-sm font-medium text-nav-dark hover:text-crx-green text-left"
                          onClick={() => { setEditProductSearch(idx); setEditProductQuery(''); }}
                        >
                          {item.product_name}
                        </button>
                        {item.product && <ProductOptionDetails product={item.product} />}
                        <p className="text-xs text-crx-green">Click to change product</p>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-secondary mb-1">Qty</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.quantity_ordered}
                      disabled={item.quantity_received > 0}
                      onChange={(e) => {
                        const newItems = [...editItems];
                        newItems[idx].quantity_ordered = e.target.value;
                        setEditItems(newItems);
                      }}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-secondary mb-1">Cost</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unit_cost}
                      disabled={item.quantity_received > 0}
                      onChange={(e) => {
                        const newItems = [...editItems];
                        newItems[idx].unit_cost = e.target.value;
                        setEditItems(newItems);
                      }}
                    />
                  </div>
                </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} loading={saving}>
              Save Changes
            </Button>
          </div>
        </div>
      </Modal>

      {/* Reverse Receiving Modal (Admin only) */}
      <Modal open={reverseOpen} onClose={() => setReverseOpen(false)} title="Reverse Receiving" accent="Record">
        <div className="space-y-4">
          {reverseRecord && (
            <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-1">
              <p><span className="text-secondary">Product:</span> <span className="font-medium text-nav-dark">{reverseRecord.product_name}</span></p>
              <p><span className="text-secondary">Qty received:</span> <span className="font-mono font-medium">{reverseRecord.quantity_received}</span></p>
              <p><span className="text-secondary">Received on:</span> {new Date(reverseRecord.received_at).toLocaleString()}</p>
            </div>
          )}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
            <p className="text-sm text-amber-800">
              This will delete the receiving record and subtract the quantity from inventory. This cannot be undone.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Reason <span className="text-red-500">*</span></label>
            <Input
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="e.g. Wrong product, data entry error, etc."
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReverseOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleReverseReceiving} loading={reversing}>
              Reverse Record
            </Button>
          </div>
        </div>
      </Modal>

      {/* Cancel PO Modal */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel Purchase" accent="Order">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Are you sure you want to cancel <span className="font-medium text-nav-dark">{po.po_number}</span>?
            The PO will remain visible but marked as cancelled.
          </p>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Reason (optional)</label>
            <Input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="e.g. Duplicate order, vendor issue, etc."
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep PO
            </Button>
            <Button variant="danger" onClick={handleCancel} loading={saving}>
              Cancel PO
            </Button>
          </div>
        </div>
      </Modal>

      <QuickTaskModal
        open={quickTaskOpen}
        onClose={() => setQuickTaskOpen(false)}
        entityType={'purchase_order' as LinkedEntityType}
        entityId={id!}
        prefillTitle={`Follow up: ${po.po_number}`}
        prefillContent={`PO: ${po.po_number}`}
      />
    </div>
  );
}
