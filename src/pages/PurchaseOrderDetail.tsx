import { useEffect, useState , useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PackageCheck, Pencil, Ban, Download, Send } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { notifyDamagedReceiving } from '../lib/notificationTriggers';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import type { PurchaseOrder, PurchaseOrderItem, POStatus, ReceivingRecord, ReceivingCondition } from '../types';

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

export default function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const receiveIdem = useIdempotencyKey('receive_po_items', profile?.id || '');
  const savePOIdem = useIdempotencyKey('save_purchase_order', profile?.id || '');
  const cancelPOIdem = useIdempotencyKey('cancel_purchase_order', profile?.id || '');
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  /* Receive modal state */
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveItems, setReceiveItems] = useState<Record<string, ReceiveItemState>>({});
  const [storageLocation, setStorageLocation] = useState('Main Warehouse');
  const [receiveStep, setReceiveStep] = useState<'fill' | 'review'>('fill');

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
    quantity_ordered: string;
    unit_cost: string;
    quantity_received: number;
  }>>([]);

  /* Receiving history */
  const [receivingHistory, setReceivingHistory] = useState<ReceivingRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const isAdmin = role === 'admin';
  const canReceive = role === 'admin' || role === 'sales_rep';

  const fetchPO = useCallback(async () => {
    const { data: poData } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', id!)
      .maybeSingle();

    if (poData) {
      setPo(poData as PurchaseOrder);
      const { data: itemsData } = await supabase
        .from('purchase_order_items')
        .select('*, product:products(product_name)')
        .eq('purchase_order_id', id!);
      setItems((itemsData || []) as PurchaseOrderItem[]);
    }
    setLoading(false);
  }, [id]);

  const fetchReceivingHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data, error } = await supabase
      .from('receiving_records')
      .select('*, product:products(product_name), receiver:profiles!receiving_records_received_by_fkey(full_name)')
      .eq('purchase_order_id', id!)
      .order('received_at', { ascending: false });

    if (!error && data) {
      const rows = (data as Array<ReceivingRecord & { product?: { product_name: string }; receiver?: { full_name: string } }>).map((r) => ({
        ...r,
        product_name: r.product?.product_name || 'Unknown',
        received_by_name: r.receiver?.full_name || 'Unknown',
      }));
      setReceivingHistory(rows as ReceivingRecord[]);
    }
    setHistoryLoading(false);
  }, [id]);

  useEffect(() => {
    if (id) {
      fetchPO();
      fetchReceivingHistory();
    }
  }, [id, fetchPO, fetchReceivingHistory]);

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  /* ─── Open receive modal ─── */
  const openReceiveModal = () => {
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

    setSaving(true);
    try {
      const idemKey = receiveIdem.getKey();
      const { data, error } = await supabase.rpc('receive_po_items', {
        p_items: itemsPayload,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      receiveIdem.resetKey();

      toast('success', 'Items received and inventory updated');

      // AUDIT 3.2: Notify admins about damaged/non-good items
      if (po) {
        const damagedItems = itemsPayload
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
      }

      // Offer PDF download
      const receivingRecordIds = (data as { receiving_record_ids?: string[] } | null)?.receiving_record_ids;
      if (receivingRecordIds && receivingRecordIds.length > 0 && po) {
        try {
          const { downloadReceivingPdf } = await import('../lib/receivingPdf');
          await downloadReceivingPdf({
            po_number: po.po_number,
            vendor: po.vendor,
            received_at: new Date().toISOString(),
            received_by_name: profile.full_name || 'Unknown',
            storage_location: storageLocation,
            items: itemsPayload.map((ip) => {
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
    } catch (error: unknown) {
      console.error('Error receiving items:', error);
      toast('error', sanitizeError(error));
    }
    setSaving(false);
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

  const openEditModal = () => {
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
      quantity_ordered: String(item.quantity_ordered),
      unit_cost: String(item.unit_cost),
      quantity_received: item.quantity_received,
    })));
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!po || !profile) return;
    setSaving(true);

    try {
      const itemsPayload = editItems.map((item) => ({
        product_id: item.product_id,
        product_name: item.product_name,
        unit_size: (item as unknown as { unit_size?: string }).unit_size,
        quantity_ordered: parseFloat(item.quantity_ordered),
        unit_cost: parseFloat(item.unit_cost),
        quantity_received: item.quantity_received || 0,
      }));

      const savePOKey = savePOIdem.getKey();
      const { error } = await supabase.rpc('save_purchase_order', {
        p_po_id: id,
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
    setSaving(true);
    try {
      const result = await supabase
        .from('purchase_orders')
        .update({ status: 'submitted', submitted_date: new Date().toISOString().split('T')[0] })
        .eq('id', id)
        .select();
      checkMutationResult(result, 'Submit purchase order');
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
      const { error } = await supabase.rpc('cancel_purchase_order', {
        p_po_id: id,
        p_reason: cancelReason || 'Cancelled',
        p_performed_by: profile.id,
        p_idempotency_key: cancelKey,
      });

      if (error) throw error;
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
        <h2 className="text-xl font-semibold font-heading text-nav-dark">{po.po_number}</h2>
        <div className="flex items-center gap-2">
          {canReceive && (po.status === 'submitted' || po.status === 'partially_received') && (
            <Button icon={<PackageCheck className="w-4 h-4" />} onClick={openReceiveModal}>
              Receive Items
            </Button>
          )}
          {canReceive && po.status === 'draft' && (
            <Button icon={<Send className="w-4 h-4" />} onClick={handleSubmitPO} loading={saving}>
              Submit PO
            </Button>
          )}
          {canReceive && po.status !== 'cancelled' && (
            <>
              <Button variant="secondary" icon={<Pencil className="w-4 h-4" />} onClick={openEditModal}>
                Edit
              </Button>
              {isAdmin && (po.status === 'draft' || po.status === 'submitted') && (
                <Button variant="danger" icon={<Ban className="w-4 h-4" />} onClick={() => setCancelOpen(true)}>
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
              {po.submitted_date ? new Date(po.submitted_date).toLocaleDateString() : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary">Expected Delivery</p>
            <p className="text-sm font-medium text-nav-dark">
              {po.expected_delivery_date
                ? new Date(po.expected_delivery_date).toLocaleDateString()
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
                      {fmt(item.quantity_ordered * item.unit_cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

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
        onClose={() => setReceiveOpen(false)}
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
                  if (remaining <= 0) return null;
                  const ri = receiveItems[item.id];
                  if (!ri) return null;

                  return (
                    <div key={item.id} className="border border-gray-100 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-nav-dark">
                            {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                          </p>
                          <p className="text-xs text-secondary">
                            {remaining} remaining of {item.quantity_ordered}
                            {item.unit_size && <span> ({item.unit_size})</span>}
                          </p>
                        </div>
                        <div className="w-24">
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            max={String(remaining)}
                            value={ri.qty}
                            onChange={(e) => updateReceiveItem(item.id, 'qty', e.target.value)}
                            placeholder="0"
                          />
                        </div>
                      </div>

                      {parseFloat(ri.qty || '0') > 0 && (
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
                    return (
                      <tr key={item.id} className="border-b border-gray-50">
                        <td className="px-3 py-2 font-medium text-nav-dark">
                          {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                        </td>
                        <td className="px-3 py-2 font-mono">{ri.qty}</td>
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

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setReceiveStep('fill')}>
                Back
              </Button>
              <Button variant="secondary" onClick={() => setReceiveOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleReceive} loading={saving}>
                Confirm & Receive
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
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Status</label>
            <Select
              value={editForm.status}
              onChange={(e) => setEditForm(prev => ({ ...prev, status: e.target.value as POStatus }))}
              options={[
                { value: 'draft', label: 'Draft' },
                { value: 'submitted', label: 'Submitted' },
                { value: 'partially_received', label: 'Partially Received' },
                { value: 'fully_received', label: 'Fully Received' },
                { value: 'cancelled', label: 'Cancelled' },
              ]}
            />
          </div>
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
              {editItems.map((item, idx) => (
                <div key={item.id} className="grid grid-cols-[1fr,100px,100px] gap-2 items-start">
                  <div>
                    <p className="text-sm font-medium text-nav-dark">{item.product_name}</p>
                    <p className="text-xs text-secondary">Received: {item.quantity_received}</p>
                  </div>
                  <div>
                    <label className="block text-xs text-secondary mb-1">Qty</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.quantity_ordered}
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
                      onChange={(e) => {
                        const newItems = [...editItems];
                        newItems[idx].unit_cost = e.target.value;
                        setEditItems(newItems);
                      }}
                    />
                  </div>
                </div>
              ))}
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
    </div>
  );
}
