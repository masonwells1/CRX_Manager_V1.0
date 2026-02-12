import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { logActivity } from '../lib/activityLogger';
import { generateIdempotencyKey } from '../lib/idempotency';
import type { PurchaseOrder, PurchaseOrderItem, POStatus } from '../types';

export default function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [items, setItems] = useState<PurchaseOrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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

  const isAdmin = role === 'admin';

  useEffect(() => {
    if (id) fetchPO();
  }, [id]);

  const fetchPO = async () => {
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
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const handleReceive = async () => {
    if (!profile) return;
    // Build items payload — only include items with qty > 0
    const itemsPayload = items
      .filter((item) => parseInt(receiveQtys[item.id] || '0') > 0)
      .map((item) => ({
        po_item_id: item.id,
        quantity: parseInt(receiveQtys[item.id] || '0'),
      }));

    if (itemsPayload.length === 0) {
      toast('error', 'Enter a quantity for at least one item');
      return;
    }

    setSaving(true);
    try {
      const idemKey = generateIdempotencyKey('receive_po_items', profile.id);
      const { error } = await supabase.rpc('receive_po_items', {
        p_items: itemsPayload,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      toast('success', 'Items received and inventory updated');
      setReceiveOpen(false);
      fetchPO();
    } catch (error: any) {
      console.error('Error receiving items:', error);
      toast('error', error.message || 'Failed to receive items');
    }
    setSaving(false);
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
        unit_size: item.unit_size,
        quantity_ordered: parseFloat(item.quantity_ordered),
        unit_cost: parseFloat(item.unit_cost),
        quantity_received: item.quantity_received || 0,
      }));

      const { data, error } = await supabase.rpc('save_purchase_order', {
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
      });

      if (error) throw error;

      toast('success', 'Purchase order updated');
      setEditOpen(false);
      fetchPO();
    } catch (err: any) {
      toast('error', err.message || 'Failed to update purchase order');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!po || !profile) return;
    setSaving(true);

    try {
      const { data, error } = await supabase.rpc('delete_purchase_order', {
        p_po_id: id,
        p_performed_by: profile.id,
      });

      if (error) throw error;

      toast('success', 'Purchase order deleted');
      navigate('/purchase-orders');
    } catch (err: any) {
      toast('error', err.message || 'Failed to delete purchase order');
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('/purchase-orders')}
          className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Purchase Orders
        </button>
        {isAdmin && (
          <div className="flex items-center gap-2">
            {/* Receiving is done from the Inventory Management page */}
            <Button variant="secondary" icon={<Pencil className="w-4 h-4" />} onClick={openEditModal}>
              Edit
            </Button>
            {(po.status === 'draft' || po.status === 'submitted') && (
              <Button variant="danger" icon={<Trash2 className="w-4 h-4" />} onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            )}
          </div>
        )}
      </div>

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

      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Receive" accent="Items">
        <div className="space-y-4">
          {items.map((item) => {
            const remaining = item.quantity_ordered - item.quantity_received;
            return (
              <div key={item.id} className="flex items-center gap-4">
                <div className="flex-1">
                  <p className="text-sm font-medium text-nav-dark">
                    {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                  </p>
                  <p className="text-xs text-secondary">
                    {remaining} remaining of {item.quantity_ordered}
                  </p>
                </div>
                <div className="w-24">
                  <Input
                    type="number"
                    min="0"
                    max={String(remaining)}
                    value={receiveQtys[item.id] || '0'}
                    onChange={(e) =>
                      setReceiveQtys((prev) => ({ ...prev, [item.id]: e.target.value }))
                    }
                  />
                </div>
              </div>
            );
          })}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setReceiveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReceive} loading={saving}>
              Receive
            </Button>
          </div>
        </div>
      </Modal>

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

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Purchase" accent="Order">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Are you sure you want to delete <span className="font-medium text-nav-dark">{po.po_number}</span>?
            This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={saving}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
