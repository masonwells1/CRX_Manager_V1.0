/**
 * OrderDetail.tsx — View and edit orders after creation
 * GAP FIX #13: Edit Orders After Creation
 * AR derived from linked invoices (single source of truth).
 */
import { useEffect, useState , useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Truck, Pencil, Save, X, Trash2, FileText, Users, Plus } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { notifyOrderStatusChange } from '../lib/notificationTriggers';
import { supabase, checkMutationResult, sanitizeError } from '../lib/db';
import { sendEmail, buildEmailHtml } from '../lib/emailService';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import type { Order, OrderItem, OrderShare, Customer, Invoice, Delivery } from '../types';

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const updateOrderIdem = useIdempotencyKey('update_order_items', profile?.id || '');
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [deliveries, setDeliveries] = useState<(Delivery & { driver_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);

  // Related blend tickets
  const [relatedTickets, setRelatedTickets] = useState<{ id: string; ticket_number: string; ticket_date: string | null; order_link_status: string | null; payment_status: string | null }[]>([]);

  // Shares state
  const [shares, setShares] = useState<OrderShare[]>([]);
  const [showShareEditor, setShowShareEditor] = useState(false);
  const [shareCustomers, setShareCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [newShareCustomerId, setNewShareCustomerId] = useState('');
  const [newSharePct, setNewSharePct] = useState('');
  const [savingShares, setSavingShares] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editItems, setEditItems] = useState<OrderItem[]>([]);
  const [saving, setSaving] = useState(false);

  // Create invoice
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  // Status change
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [newStatus, setNewStatus] = useState('');

  const isAdmin = role === 'admin';
  const canEdit = (role === 'admin' || role === 'sales_rep') && order?.status !== 'fulfilled' && order?.status !== 'cancelled';

  const fetchOrder = useCallback(async () => {
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

      // Load linked deliveries
      const { data: deliveryData } = await supabase
        .from('deliveries')
        .select('*, driver:profiles!deliveries_assigned_driver_fkey(full_name)')
        .eq('order_id', id!)
        .order('scheduled_date');
      setDeliveries(
        (deliveryData || []).map((d: Delivery & { driver?: { full_name: string } | null }) => ({
          ...d,
          driver_name: d.driver?.full_name || undefined,
        }))
      );

      // Load linked invoices (AR single source of truth)
      const { data: invoiceData } = await supabase
        .from('invoices')
        .select('*')
        .eq('order_id', id!)
        .not('status', 'in', '("voided","cancelled")')
        .order('invoice_number');
      setInvoices(invoiceData || []);

      // Load order shares
      const { data: shareData } = await supabase
        .from('order_shares')
        .select('*')
        .eq('order_id', id!)
        .order('sort_order');
      setShares((shareData || []) as OrderShare[]);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (id) fetchOrder();
  }, [id, fetchOrder]);

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

      const idemKey = updateOrderIdem.getKey();
      const { error } = await supabase.rpc('update_order_items', {
        p_order_id: id!,
        p_items: itemsPayload,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;

      updateOrderIdem.resetKey();
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
        // Simple status change (no inventory impact) — validate allowed transitions
        const validTransitions: Record<string, string[]> = {
          confirmed: ['partially_fulfilled', 'fulfilled', 'cancelled'],
          partially_fulfilled: ['fulfilled', 'cancelled'],
        };
        const allowed = validTransitions[order.status] || [];
        if (!allowed.includes(newStatus)) {
          toast('error', `Cannot change status from '${order.status}' to '${newStatus}'`);
          setStatusModalOpen(false);
          return;
        }
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

      // === Email customer when order is confirmed ===
      if (newStatus === 'confirmed' && customer?.email) {
        try {
          const itemSummary = items
            .slice(0, 10)
            .map((i) => `<tr>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${i.product_name}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${i.total_units_needed}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${fmt(i.price_per_unit)}</td>
            </tr>`)
            .join('');
          const moreItems = items.length > 10 ? `<p style="color:#64748b;font-size:12px;">...and ${items.length - 10} more item(s)</p>` : '';

          const html = buildEmailHtml(`
            <h2 style="color:#1e293b;margin:0 0 12px;">Order Confirmed</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Hi${customer.contact_name ? ` ${customer.contact_name}` : ''},
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Your order <strong>${order.order_number}</strong> has been confirmed and is being processed.
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;color:#166534;">Order Number</td>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;font-weight:600;color:#166534;">${order.order_number}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Order Date</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${new Date(order.order_date).toLocaleDateString()}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Total</td>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${fmt(order.total_price)}</td>
              </tr>
            </table>
            <h3 style="color:#1e293b;font-size:14px;margin:16px 0 8px;">Items</h3>
            <table style="width:100%;border-collapse:collapse;">
              <tr style="background:#f8fafc;">
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Product</th>
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Qty</th>
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Price/Unit</th>
              </tr>
              ${itemSummary}
            </table>
            ${moreItems}
            <p style="color:#475569;font-size:14px;line-height:1.6;margin-top:16px;">
              We'll notify you when deliveries are scheduled. Thank you for your business!
            </p>
          `);

          const emailResult = await sendEmail({
            to: customer.email,
            subject: `Order ${order.order_number} Confirmed — Crop RX Solutions`,
            html,
            email_type: 'order_confirmed',
            customer_id: order.customer_id,
            idempotency_key: `order-confirmed-${order.id}-${Date.now()}`,
          });

          if (emailResult.success) {
            toast('success', `Order confirmed and confirmation emailed to ${customer.email}`);
          }
          // If email fails, the status toast above already showed success
        } catch (emailErr) {
          console.warn('Order confirmation email failed:', emailErr);
          // Status change already succeeded — don't show error for email
        }
      }

      setStatusModalOpen(false);
      fetchOrder();
    } catch (error: unknown) {
      console.error('Error changing status:', error);
      toast('error', sanitizeError(error));
    }
  };

  // ── Share management ──────────────────────────────────────────────────
  const openShareEditor = async () => {
    // Load customers for dropdown
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .is('deleted_at', null)
      .order('farm_name')
      .limit(500);
    setShareCustomers((data || []) as { id: string; farm_name: string }[]);
    setNewShareCustomerId('');
    setNewSharePct('');
    setShowShareEditor(true);
  };

  const handleAddShare = async () => {
    if (!order || !newShareCustomerId || !newSharePct) return;
    const pct = parseFloat(newSharePct);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      toast('error', 'Percentage must be between 0 and 100');
      return;
    }
    const totalExisting = shares.reduce((s, sh) => s + sh.split_percentage, 0);
    if (totalExisting + pct > 100) {
      toast('error', `Total split would exceed 100% (currently ${totalExisting}%)`);
      return;
    }
    const selectedCust = shareCustomers.find((c) => c.id === newShareCustomerId);
    if (!selectedCust) return;

    setSavingShares(true);
    try {
      const amountCents = Math.round((order.total_price * 100 * pct) / 100);
      const result = await supabase.from('order_shares').insert({
        order_id: order.id,
        customer_id: newShareCustomerId,
        customer_name: selectedCust.farm_name,
        split_percentage: pct,
        amount_cents: amountCents,
        is_primary: shares.length === 0,
        sort_order: shares.length + 1,
      }).select();
      checkMutationResult(result, 'Add order share');
      toast('success', `Added ${selectedCust.farm_name} at ${pct}%`);
      setNewShareCustomerId('');
      setNewSharePct('');
      fetchOrder();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingShares(false);
  };

  const handleRemoveShare = async (shareId: string) => {
    setSavingShares(true);
    try {
      const result = await supabase.from('order_shares').delete().eq('id', shareId).select();
      checkMutationResult(result, 'Remove order share');
      toast('success', 'Share removed');
      fetchOrder();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSavingShares(false);
  };

  const handleDeleteItem = async (itemId: string) => {
    setEditItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const updateEditItem = (itemId: string, field: string, value: number) => {
    setEditItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, [field]: value } : i))
    );
  };

  const handleCreateInvoice = async () => {
    if (!profile || !id) return;
    setCreatingInvoice(true);
    try {
      const { data, error } = await supabase.rpc('create_invoice_from_order', {
        p_order_id: id,
        p_salesman_id: profile.id,
      });
      if (error) throw error;
      const invoiceId = data as string;
      toast('success', 'Draft invoice created');
      navigate(`/invoices/${invoiceId}`);
    } catch (error: unknown) {
      console.error('Error creating invoice:', error);
      toast('error', sanitizeError(error));
    }
    setCreatingInvoice(false);
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
  // AR derived from invoices (single source of truth — never use order.total_paid / balance_due)
  const totalInvoicedCents = invoices.reduce((sum, inv) => sum + (inv.total_amount_cents || 0), 0);
  const totalPaidCents = invoices.reduce((sum, inv) => sum + (inv.paid_amount_cents || 0) + (inv.prepay_applied_cents || 0), 0);
  const balanceCents = invoices.reduce((sum, inv) => sum + (inv.balance_cents || 0), 0);
  const totalInvoiced = totalInvoicedCents / 100;
  const totalPaid = totalPaidCents / 100;
  const balanceDue = balanceCents / 100;

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[
        { label: 'Orders', href: '/orders' },
        { label: order?.order_number || 'Order' },
      ]} />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">{order?.order_number || 'Order'}</h2>
        <div className="flex gap-2 flex-wrap">
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
              {canEdit && (
                <Button
                  variant="secondary"
                  icon={<Pencil className="w-4 h-4" />}
                  showChevron={false}
                  onClick={() => setEditing(true)}
                >
                  Edit Order
                </Button>
              )}
              {order.status !== 'cancelled' && order.status !== 'fulfilled' && (
                <Button
                  variant="secondary"
                  icon={<FileText className="w-4 h-4" />}
                  showChevron={false}
                  onClick={handleCreateInvoice}
                  loading={creatingInvoice}
                >
                  Create Invoice
                </Button>
              )}
              {order.status !== 'cancelled' && order.status !== 'fulfilled' && (
                <Button
                  icon={<Truck className="w-4 h-4" />}
                  onClick={() => navigate(`/deliveries/new?order=${order.id}`)}
                >
                  Schedule Delivery
                </Button>
              )}
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
          {order.customer_po_number && (
            <div>
              <p className="text-xs text-secondary">Customer PO#</p>
              <p className="text-sm font-medium text-nav-dark">
                {order.customer_po_number}
              </p>
            </div>
          )}
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

        {/* AR summary — derived from linked invoices (single source of truth) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t border-gray-100">
          <div>
            <p className="text-xs text-secondary">Total Invoiced</p>
            <p className="text-sm font-medium text-nav-dark">{fmt(totalInvoiced)}</p>
          </div>
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
          <div className="flex items-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/payments')}
            >
              Record Payment →
            </Button>
          </div>
        </div>
      </Card>

      {/* Linked Deliveries */}
      {deliveries.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Truck className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Linked Deliveries</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left font-medium text-secondary">Delivery #</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Driver</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((del) => (
                  <tr key={del.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => navigate(`/deliveries/${del.id}`)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        {del.delivery_number}
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={statusToBadgeVariant[del.status] || 'default'} size="sm">
                        {del.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {del.driver_name || 'Unassigned'}
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {new Date(del.scheduled_date).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Linked Invoices */}
      {invoices.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Linked Invoices</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left font-medium text-secondary">Invoice #</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Type</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Status</th>
                  <th className="px-4 py-2 text-right font-medium text-secondary">Total</th>
                  <th className="px-4 py-2 text-right font-medium text-secondary">Paid</th>
                  <th className="px-4 py-2 text-right font-medium text-secondary">Balance</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => navigate(`/invoices/${inv.id}`)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        {inv.invoice_number}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-secondary capitalize">
                      {inv.invoice_type.replace('_', ' ')}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={inv.status === 'posted' ? 'success' : inv.status === 'draft' ? 'default' : 'warning'} size="sm">
                        {inv.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{fmt(inv.total_amount_cents / 100)}</td>
                    <td className="px-4 py-2 text-right font-mono text-crx-green">
                      {fmt((inv.paid_amount_cents + inv.prepay_applied_cents) / 100)}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono font-semibold ${inv.balance_cents > 0 ? 'text-red-600' : 'text-crx-green'}`}>
                      {fmt(inv.balance_cents / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

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

      {/* Order Shares (Bill Splitting) */}
      {(shares.length > 0 || canEdit) && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-500" />
              <h3 className="font-semibold text-nav-dark">Bill Split</h3>
              {shares.length > 0 && (
                <span className="text-xs text-secondary">({shares.length} customer{shares.length !== 1 ? 's' : ''})</span>
              )}
            </div>
            {canEdit && !showShareEditor && (
              <Button variant="secondary" size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={openShareEditor}>
                Add Split
              </Button>
            )}
          </div>

          {shares.length === 0 && !showShareEditor && (
            <p className="text-sm text-secondary text-center py-4">No bill splits — 100% billed to primary customer</p>
          )}

          {shares.length > 0 && (
            <div className="space-y-2 mb-3">
              {shares.map((share) => (
                <div key={share.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                      <Users className="w-4 h-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-nav-dark">{share.customer_name}</p>
                      <p className="text-xs text-secondary">{fmt(share.amount_cents / 100)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-blue-600">{share.split_percentage}%</span>
                    {canEdit && (
                      <button onClick={() => handleRemoveShare(share.id)} className="text-red-400 hover:text-red-600 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between px-3 py-2 bg-blue-50 rounded-lg">
                <span className="text-xs font-medium text-blue-700">Total Allocated</span>
                <span className="text-xs font-semibold text-blue-700">
                  {shares.reduce((s, sh) => s + sh.split_percentage, 0)}%
                  {shares.reduce((s, sh) => s + sh.split_percentage, 0) < 100 && (
                    <span className="text-amber-600 ml-2">
                      ({100 - shares.reduce((s, sh) => s + sh.split_percentage, 0)}% unallocated)
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}

          {showShareEditor && (
            <div className="border border-blue-200 rounded-lg p-4 bg-blue-50/50 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="text-xs font-medium text-secondary mb-1 block">Customer</label>
                  <select
                    value={newShareCustomerId}
                    onChange={(e) => setNewShareCustomerId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Select customer...</option>
                    {shareCustomers.map((c) => (
                      <option key={c.id} value={c.id}>{c.farm_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">Split %</label>
                  <input
                    type="number"
                    value={newSharePct}
                    onChange={(e) => setNewSharePct(e.target.value)}
                    placeholder="e.g. 35"
                    min="0.01"
                    max="100"
                    step="0.01"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowShareEditor(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAddShare} loading={savingShares} disabled={!newShareCustomerId || !newSharePct}>
                  Add Share
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

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
