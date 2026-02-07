import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, PackageCheck } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { logActivity } from '../lib/activityLogger';
import type { PurchaseOrder, PurchaseOrderItem } from '../types';

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

  const openReceiveModal = () => {
    const initial: Record<string, string> = {};
    items.forEach((item) => {
      initial[item.id] = '0';
    });
    setReceiveQtys(initial);
    setReceiveOpen(true);
  };

  const handleReceive = async () => {
    setSaving(true);
    let hasError = false;

    for (const item of items) {
      const qty = parseInt(receiveQtys[item.id] || '0');
      if (qty <= 0) continue;
      const newReceived = item.quantity_received + qty;
      const { error } = await supabase
        .from('purchase_order_items')
        .update({ quantity_received: newReceived })
        .eq('id', item.id);
      if (error) { hasError = true; continue; }

      // === GAP FIX #4: Update inventory when receiving PO items ===
      const { data: inv } = await supabase
        .from('inventory')
        .select('id, quantity_available, quantity_on_order')
        .eq('product_id', item.product_id)
        .eq('location', 'Main Warehouse')
        .maybeSingle();

      if (inv) {
        await supabase
          .from('inventory')
          .update({
            quantity_available: (Number(inv.quantity_available) || 0) + qty,
            quantity_on_order: Math.max(0, (Number(inv.quantity_on_order) || 0) - qty),
            updated_at: new Date().toISOString(),
          })
          .eq('id', inv.id);
      } else {
        await supabase.from('inventory').insert({
          product_id: item.product_id,
          location: 'Main Warehouse',
          quantity_available: qty,
          quantity_on_order: 0,
          quantity_prebooked: 0,
          unit_size: item.unit_size,
        });
      }

      // Create inventory transaction audit record
      if (profile) {
        await supabase.from('inventory_transactions').insert({
          product_id: item.product_id,
          transaction_type: 'received',
          quantity: qty,
          to_location: 'Main Warehouse',
          purchase_order_id: id,
          performed_by: profile.id,
          notes: `Received ${qty} units via PO ${po?.po_number || ''}`,
        });
      }
    }

    // Auto-update PO status based on received quantities
    if (!hasError && po) {
      const { data: updatedItems } = await supabase
        .from('purchase_order_items')
        .select('quantity_ordered, quantity_received')
        .eq('purchase_order_id', id!);

      if (updatedItems) {
        const allReceived = updatedItems.every(
          (i: any) => Number(i.quantity_received) >= Number(i.quantity_ordered)
        );
        const someReceived = updatedItems.some(
          (i: any) => Number(i.quantity_received) > 0
        );
        const newStatus = allReceived ? 'fully_received' : someReceived ? 'partially_received' : po.status;

        if (newStatus !== po.status) {
          await supabase
            .from('purchase_orders')
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', id!);
        }
      }
    }

    if (hasError) {
      toast('error', 'Some items failed to update');
    } else {
      // === GAP FIX #5: Log activity ===
      if (profile) {
        await logActivity(
          'po_received',
          `Items received on PO ${po?.po_number || ''} — inventory updated`,
          profile.id,
          'purchase_order',
          id
        );
      }
      toast('success', 'Items received and inventory updated');
      setReceiveOpen(false);
      fetchPO();
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
        {isAdmin && po.status !== 'fully_received' && po.status !== 'cancelled' && (
          <Button icon={<PackageCheck className="w-4 h-4" />} onClick={openReceiveModal}>
            Receive Items
          </Button>
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
    </div>
  );
}
