/**
 * OrderDetail.tsx — View and edit orders after creation
 * GAP FIX #13: Edit Orders After Creation
 * Also shows payment/balance info (Gap #2 tie-in)
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Truck, Pencil, Save, X, Trash2, FileText } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { generateIdempotencyKey } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import { notifyOrderStatusChange } from '../lib/notificationTriggers';
import { supabase, checkMutationResult, sanitizeError } from '../lib/db';
import type { Order, OrderItem, Customer } from '../types';

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);

  // Related blend tickets
  const [relatedTickets, setRelatedTickets] = useState<{ id: string; ticket_number: string; ticket_date: string | null; order_link_status: string | null; payment_status: string | null }[]>([]);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editItems, setEditItems] = useState<OrderItem[]>([]);
  const [saving, setSaving] = useState(false);

  // Status change
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [newStatus, setNewStatus] = useState('');

  const isAdmin = role === 'admin';

  useEffect(() => {
    if (id) fetchOrder();
  }, [id]);

  const fetchOrder = async () => {
    const { data: orderData } = await supabase
      .from('orders')
      .select('*')
      .eq('id', id!)
      .maybeSingle();

    if (orderData) {
      setOrder(orderData as Order);
      const { data: custData } = await supabase
        .from('customers')
        .select('*')
        .eq('id', orderData.customer_id)
        .maybeSingle();
      setCustomer(custData as Customer | null);

      const { data: itemsData } = await supabase
        .from('order_items')
        .select('*')
        .eq('order_id', id!)
        .order('section_name');
      const itemsList = (itemsData || []) as OrderItem[];
      setItems(itemsList);
      setEditItems(itemsList.map((i) => ({ ...i })));

      // Load related blend tickets
      const { data: btLinks } = await supabase
        .from('blend_ticket_to_order_items')
        .select('blend_ticket_id, blend_ticket:blend_tickets(id, ticket_number, ticket_date, order_link_status, payment_status)')
        .eq('order_id', id!);
      // Deduplicate by blend_ticket_id
      const uniqueTickets = new Map<string, { id: string; ticket_number: string; ticket_date: string | null; order_link_status: string | null; payment_status: string | null }>();
      ((btLinks || []) as unknown as Array<{ blend_ticket_id: string; blend_ticket: { id: string; ticket_number: string; ticket_date: string | null; order_link_status: string | null; payment_status: string | null } | null }>).forEach((link) => {
        if (link.blend_ticket && !uniqueTickets.has(link.blend_ticket_id)) {
          uniqueTickets.set(link.blend_ticket_id, link.blend_ticket);
        }
      });
      setRelatedTickets(Array.from(uniqueTickets.values()));
    }
    setLoading(false);
  };

  const handleSaveEdits = async () => {
    if (!profile) return;
    setSaving(true);

    try {
      // Atomic RPC with idempotency: item updates + inventory adjustments + order total recalculation
      const itemsPayload = editItems.map((item) => ({
        id: item.id,
        price_per_unit: item.price_per_unit,
        total_units_needed: item.total_units_needed,
      }));

      const idemKey = generateIdempotencyKey('update_order_items', profile.id);
      const { error } = await supabase.rpc('update_order_items', {
        p_order_id: id!,
        p_items: itemsPayload,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;

      toast('success', 'Order updated');
      setEditing(false);
      fetchOrder();
    } catch (error: unknown) {
      console.error('Error saving edits:', error);
      toast('error', sanitizeError(error));
    }
    setSaving(false);
  };

  const handleStatusChange = async () => {
    if (!newStatus || !order || !profile) return;

    try {
      if (newStatus === 'cancelled' && order.status !== 'cancelled') {
        // Atomic RPC: cancellation + inventory release + cascade (void drafts, zero commissions, release holds)
        const { data: cancelResult, error } = await supabase.rpc('cancel_order', {
          p_order_id: id!,
          p_performed_by: profile.id,
        });
        if (error) throw error;
        // Show summary toast with cascade details
        if (cancelResult && cancelResult.success) {
          const parts: string[] = ['Order cancelled.'];
          if (cancelResult.holds_released > 0) parts.push(`${cancelResult.holds_released} hold(s) released.`);
          if (cancelResult.commissions_cancelled > 0) parts.push(`${cancelResult.commissions_cancelled} commission(s) zeroed.`);
          if (cancelResult.draft_invoices_voided > 0) parts.push(`${cancelResult.draft_invoices_voided} draft invoice(s) voided.`);
          if (cancelResult.posted_invoices_flagged > 0) parts.push(`Admin notified about ${cancelResult.posted_invoices_flagged} posted invoice(s) requiring manual void.`);
          if (cancelResult.paid_commissions_flagged > 0) parts.push(`Admin notified about ${cancelResult.paid_commissions_flagged} paid commission(s).`);
          toast('success', parts.join(' '));
        }
      } else {
        // Simple status change (no inventory impact)
        const statusResult = await supabase
          .from('orders')
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', id!)
          .select();
        checkMutationResult(statusResult, 'Update order status');
        toast('success', `Status changed to ${newStatus.replace('_', ' ')}`);
      }

      logActivity('order_status_changed', `Order ${order.order_number} status changed to ${newStatus}`, profile.id, 'order', order.id, order.customer_id);
      notifyOrderStatusChange(order.id, order.order_number, customer?.farm_name || 'customer', newStatus, order.created_by ?? undefined);
      setStatusModalOpen(false);
      fetchOrder();
    } catch (error: unknown) {
      console.error('Error changing status:', error);
      toast('error', sanitizeError(error));
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    setEditItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const updateEditItem = (itemId: string, field: string, value: number) => {
    setEditItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, [field]: value } : i))
    );
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-16">
        <p className="text-secondary">Order not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/orders')}>
          Back to Orders
        </Button>
      </div>
    );
  }

  const sections = [...new Set((editing ? editItems : items).map((i) => i.section_name || 'General'))];
  const displayItems = editing ? editItems : items;
  const totalPaid = Number(order.total_paid) || 0;
  const balanceDue = Number(order.balance_due) || (order.total_price - totalPaid);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('/orders')}
          className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Orders
        </button>
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button variant="ghost" icon={<X className="w-4 h-4" />} showChevron={false} onClick={() => { setEditing(false); setEditItems(items.map((i) => ({ ...i }))); }}>
                Cancel
              </Button>
              <Button icon={<Save className="w-4 h-4" />} onClick={handleSaveEdits} loading={saving}>
                Save Changes
              </Button>
            </>
          ) : (
            <>
              {isAdmin && (
                <Button
                  variant="secondary"
                  icon={<Pencil className="w-4 h-4" />}
                  showChevron={false}
                  onClick={() => setEditing(true)}
                >
                  Edit Order
                </Button>
              )}
              <Button
                icon={<Truck className="w-4 h-4" />}
                onClick={() => navigate(`/deliveries/new?order=${order.id}`)}
              >
                Schedule Delivery
              </Button>
            </>
          )}
        </div>
      </div>

      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">
              {order.order_number}
            </h2>
            <p className="text-sm text-secondary mt-1">
              {customer?.farm_name || 'Unknown Customer'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <button
                onClick={() => { setNewStatus(order.status); setStatusModalOpen(true); }}
                className="text-xs text-secondary hover:text-crx-green underline"
              >
                Change Status
              </button>
            )}
            <Badge variant={statusToBadgeVariant[order.status] || 'default'} size="md">
              {order.status.replace('_', ' ')}
            </Badge>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
          <div>
            <p className="text-xs text-secondary">Order Date</p>
            <p className="text-sm font-medium text-nav-dark">
              {new Date(order.order_date).toLocaleDateString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary">Total Price</p>
            <p className="text-sm font-medium text-nav-dark">{fmt(order.total_price)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Profit</p>
            <p className="text-sm font-medium text-crx-green">{fmt(order.total_profit)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Margin</p>
            <p className="text-sm font-medium text-nav-dark">
              {order.total_margin_pct.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Payment summary row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-100">
          <div>
            <p className="text-xs text-secondary">Amount Paid</p>
            <p className="text-sm font-medium text-crx-green">{fmt(totalPaid)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Balance Due</p>
            <p className={`text-sm font-semibold ${balanceDue > 0 ? 'text-red-600' : 'text-crx-green'}`}>
              {fmt(Math.max(0, balanceDue))}
            </p>
          </div>
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/payments')}
            >
              View Payments →
            </Button>
          </div>
        </div>
      </Card>

      {sections.map((section) => (
        <Card key={section} padding={false}>
          <div className="p-5">
            <CardHeader title={section} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Price/Unit</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Units Needed</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Delivered</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Remaining</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary w-40">Progress</th>
                    {editing && <th className="px-4 py-3 w-10"></th>}
                  </tr>
                </thead>
                <tbody>
                  {displayItems
                    .filter((i) => (i.section_name || 'General') === section)
                    .map((item) => {
                      const units = editing ? item.total_units_needed : item.total_units_needed;
                      const ppu = editing ? item.price_per_unit : item.price_per_unit;
                      const pct =
                        units > 0
                          ? Math.round((item.quantity_delivered / units) * 100)
                          : 0;
                      return (
                        <tr key={item.id} className="border-b border-gray-50">
                          <td className="px-4 py-3 font-medium text-nav-dark">
                            {item.product_name}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {editing ? (
                              <input
                                type="number"
                                value={ppu}
                                onChange={(e) => updateEditItem(item.id, 'price_per_unit', Number(e.target.value))}
                                className="w-24 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                                step="0.01"
                              />
                            ) : (
                              fmt(ppu)
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {editing ? (
                              <input
                                type="number"
                                value={units}
                                onChange={(e) => updateEditItem(item.id, 'total_units_needed', Number(e.target.value))}
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                              />
                            ) : (
                              units
                            )}
                          </td>
                          <td className="px-4 py-3">{item.quantity_delivered}</td>
                          <td className="px-4 py-3">{units - item.quantity_delivered}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-crx-green rounded-full transition-all"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs text-secondary w-8">{pct}%</span>
                            </div>
                          </td>
                          {editing && (
                            <td className="px-4 py-3">
                              <button
                                onClick={() => handleDeleteItem(item.id)}
                                className="text-red-400 hover:text-red-600"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                </tbody>
                {editing && (
                  <tfoot>
                    <tr className="border-t border-gray-200">
                      <td colSpan={2} className="px-4 py-3 font-medium text-nav-dark">
                        New Total:
                      </td>
                      <td colSpan={5} className="px-4 py-3 font-semibold text-nav-dark">
                        {fmt(editItems.reduce((s, i) => s + i.price_per_unit * i.total_units_needed, 0))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </Card>
      ))}

      {/* Related Blend Tickets */}
      {relatedTickets.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Related Blend Tickets</h3>
          </div>
          <div className="space-y-2">
            {relatedTickets.map((bt) => (
              <div key={bt.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <button
                  onClick={() => navigate(`/blend-tickets/${bt.id}`)}
                  className="text-crx-green hover:underline font-medium text-sm"
                >
                  {bt.ticket_number}
                </button>
                <div className="flex items-center gap-2">
                  {bt.ticket_date && (
                    <span className="text-xs text-gray-500">{new Date(bt.ticket_date).toLocaleDateString()}</span>
                  )}
                  <Badge variant={bt.payment_status === 'billed' ? 'success' : bt.payment_status === 'prepaid' ? 'info' : 'default'}>
                    {(bt.payment_status || 'unbilled').replace('_', ' ')}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Status Change Modal */}
      <Modal open={statusModalOpen} onClose={() => setStatusModalOpen(false)} title="Change Order Status">
        <div className="space-y-4">
          <select
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
          >
            <option value="confirmed">Confirmed</option>
            <option value="partially_fulfilled">Partially Fulfilled</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setStatusModalOpen(false)}>Cancel</Button>
            <Button onClick={handleStatusChange}>Update Status</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
