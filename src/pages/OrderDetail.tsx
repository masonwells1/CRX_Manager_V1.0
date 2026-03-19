/**
 * OrderDetail.tsx — View and edit orders after creation
 * GAP FIX #13: Edit Orders After Creation
 * AR derived from linked invoices (single source of truth).
 */
import { useEffect, useState , useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Truck, Pencil, Save, X, Trash2, FileText, Users, Plus, AlertTriangle, MessageSquarePlus } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { notifyOrderStatusChange } from '../lib/notificationTriggers';
import { supabase, checkMutationResult, sanitizeError, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { sendEmail, buildEmailHtml } from '../lib/emailService';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { runCriticalAction } from '../lib/criticalAction';
import { parseLocalDate } from '../lib/dateUtils';
import QuickTaskModal from '../components/team/QuickTaskModal';
import RelatedNotes from '../components/team/RelatedNotes';
import type { Order, OrderItem, OrderShare, Customer, Invoice, Delivery, Product, LinkedEntityType } from '../types';

/** Temporary new item (not yet saved to DB — has no real id) */
interface NewOrderItem {
  _tempKey: string;
  product_id: string;
  product_name: string;
  price_per_unit: number;
  cost_per_unit: number;
  total_units_needed: number;
  unit_size: string | null;
  section_name: string | null;
}

let _editKeyCounter = 0;
function nextEditKey() { return `_new_${++_editKeyCounter}`; }

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const updateOrderIdem = useIdempotencyKey('update_order_items', profile?.id || '');
  const voidOrderIdem = useIdempotencyKey('void_order', profile?.id || '');
  const cancelOrderIdem = useIdempotencyKey('cancel_order', profile?.id || '');
  const createInvoiceIdem = useIdempotencyKey('create_invoice_from_order', profile?.id || '');
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [deliveries, setDeliveries] = useState<(Delivery & { driver_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);

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
  const [newItems, setNewItems] = useState<NewOrderItem[]>([]);
  const [saving, setSaving] = useState(false);

  // Add-product modal state
  const [products, setProducts] = useState<Product[]>([]);
  const [showProductModal, setShowProductModal] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<string, { available: number; prebooked: number; onOrder: number }>>({});

  // Create invoice
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  // Status change
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string>('');

  // Void order (fulfilled → voided, admin-only)
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Planned/Committed toggle
  const [togglingPlanned, setTogglingPlanned] = useState(false);

  const isAdmin = role === 'admin';
  const canEdit = (role === 'admin' || role === 'sales_rep') && order?.status !== 'fulfilled' && order?.status !== 'cancelled' && order?.status !== 'partially_fulfilled';

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

  // Fetch products + inventory when entering edit mode (lazy load — only when needed)
  const fetchProducts = useCallback(async () => {
    const [productsRes, inventoryRes, poRes] = await Promise.all([
      supabase.from('products').select('*').order('product_name'),
      supabase.from('inventory').select('product_id, quantity_available, quantity_prebooked'),
      supabase
        .from('purchase_order_items')
        .select('product_id, quantity_ordered, quantity_received, purchase_orders!inner(status)')
        .in('purchase_orders.status', ['submitted', 'partially_received']),
    ]);

    setProducts(productsRes.data || []);

    const invMap: Record<string, { available: number; prebooked: number; onOrder: number }> = {};
    for (const row of inventoryRes.data || []) {
      const pid = row.product_id;
      if (!invMap[pid]) invMap[pid] = { available: 0, prebooked: 0, onOrder: 0 };
      invMap[pid].available += Number(row.quantity_available);
      invMap[pid].prebooked += Number(row.quantity_prebooked);
    }
    for (const poi of (poRes.data || []) as Array<{ product_id: string; quantity_ordered: number; quantity_received: number }>) {
      const pid = poi.product_id;
      if (!invMap[pid]) invMap[pid] = { available: 0, prebooked: 0, onOrder: 0 };
      invMap[pid].onOrder += Number(poi.quantity_ordered) - Number(poi.quantity_received);
    }
    setInventoryByProduct(invMap);
  }, []);

  // Load products when edit mode is activated
  useEffect(() => {
    if (editing && products.length === 0) {
      fetchProducts();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const handleAddProduct = (product: Product) => {
    const tierNum = customer?.assigned_tier || 1;
    // Cascade: tier3 → tier2 → tier1 fallback (same logic as quoteCalc.getTierPrice)
    const t1 = product.tier1_price || 0;
    const tierPrice =
      tierNum === 1 ? t1
        : tierNum === 2 ? product.tier2_price || t1
          : product.tier3_price || t1;

    const item: NewOrderItem = {
      _tempKey: nextEditKey(),
      product_id: product.id,
      product_name: product.product_name,
      price_per_unit: tierPrice,
      cost_per_unit: product.current_cost || 0,
      total_units_needed: 0,
      unit_size: product.unit_size || null,
      section_name: null,
    };
    setNewItems((prev) => [...prev, item]);
    setShowProductModal(false);
    setProductSearch('');
  };

  const updateNewItem = (key: string, field: keyof NewOrderItem, value: number | string | null) => {
    setNewItems((prev) =>
      prev.map((i) => (i._tempKey === key ? { ...i, [field]: value } : i))
    );
  };

  const removeNewItem = (key: string) => {
    setNewItems((prev) => prev.filter((i) => i._tempKey !== key));
  };

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.manufacturer?.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products;

  const handleSaveEdits = async () => {
    if (!profile) return;
    await runCriticalAction({
      action: async () => {
        // Build payload: existing items (with id) + new items (without id)
        const existingPayload = editItems.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_name: item.product_name,
          unit_size: item.unit_size,
          cost_per_unit: item.cost_per_unit,
          price_per_unit: item.price_per_unit,
          total_units_needed: item.total_units_needed,
        }));

        const newPayload = newItems
          .filter((item) => item.product_id && item.total_units_needed > 0)
          .map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            price_per_unit: item.price_per_unit,
            cost_per_unit: item.cost_per_unit,
            total_units_needed: item.total_units_needed,
            unit_size: item.unit_size,
            section_name: item.section_name,
          }));

        const itemsPayload = [...existingPayload, ...newPayload];

        const idemKey = updateOrderIdem.getKey();
        const { error } = await supabase.rpc('update_order_items', {
          p_order_id: id!,
          p_items: itemsPayload,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
        });

        if (error) throw error;

        updateOrderIdem.resetKey();
        const addedCount = newPayload.length;
        toast('success', addedCount > 0 ? `Order updated — ${addedCount} product(s) added` : 'Order updated');
        setEditing(false);
        setNewItems([]);
        fetchOrder();
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'save_order_edits',
    });
  };

  const handleTogglePlanned = async () => {
    if (!order || !profile) return;
    setTogglingPlanned(true);
    try {
      const newValue = !order.is_planned;
      const result = await supabase
        .from('orders')
        .update({ is_planned: newValue, updated_at: new Date().toISOString() })
        .eq('id', order.id)
        .select();
      checkMutationResult(result, 'Toggle planned status');
      setOrder({ ...order, is_planned: newValue });
      toast('success', newValue ? 'Order marked as Planned' : 'Order marked as Committed');
      logActivity({ event: 'order_updated', description: `Order ${order.order_number} marked as ${newValue ? 'planned' : 'committed'}`, performedBy: profile.id, entityType: 'order', entityId: order.id, customerId: order.customer_id });
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setTogglingPlanned(false);
  };

  const handleStatusChange = () => {
    if (!newStatus || !order || !profile) return;
    setPendingStatus(newStatus);
    setStatusConfirmOpen(true);
  };

  const executeStatusChange = async () => {
    if (!pendingStatus || !order || !profile) return;
    setStatusConfirmOpen(false);
    const targetStatus = pendingStatus;

    await runCriticalAction({
      action: async () => {
        if (targetStatus === 'cancelled' && order.status !== 'cancelled') {
          // Atomic RPC: cancellation + inventory release + cascade (void drafts, zero commissions, release holds)
          const cancelKey = cancelOrderIdem.getKey();
          const { data: cancelResult, error } = await supabase.rpc('cancel_order', {
            p_order_id: id!,
            p_performed_by: profile.id,
            p_idempotency_key: cancelKey,
          });
          if (error) throw error;
          cancelOrderIdem.resetKey();
          const result = assertRpcResult<{ success: boolean; holds_released: number; commissions_cancelled: number; draft_invoices_cancelled: number; posted_invoices_flagged: number; paid_commissions_flagged: number }>(cancelResult, 'cancel_order');
          // Show summary toast with cascade details
          if (result && result.success) {
            const parts: string[] = ['Order cancelled.'];
            if (result.holds_released > 0) parts.push(`${result.holds_released} hold(s) released.`);
            if (result.commissions_cancelled > 0) parts.push(`${result.commissions_cancelled} commission(s) zeroed.`);
            if (result.draft_invoices_cancelled > 0) parts.push(`${result.draft_invoices_cancelled} draft invoice(s) cancelled.`);
            if (result.posted_invoices_flagged > 0) parts.push(`Admin notified about ${result.posted_invoices_flagged} posted invoice(s) requiring manual void.`);
            if (result.paid_commissions_flagged > 0) parts.push(`Admin notified about ${result.paid_commissions_flagged} paid commission(s).`);
            toast('success', parts.join(' '));
          }
        } else {
          // Simple status change (no inventory impact) — validate allowed transitions
          // Manual status changes — partially_fulfilled/fulfilled happen via delivery RPCs, not manual update
          const validTransitions: Record<string, string[]> = {
            confirmed: ['cancelled'],
            partially_fulfilled: ['cancelled'],
          };
          const allowed = validTransitions[order.status] || [];
          if (!allowed.includes(targetStatus)) {
            toast('error', `Cannot change status from '${order.status}' to '${targetStatus}'`);
            setStatusModalOpen(false);
            return;
          }
          const statusResult = await supabase
            .from('orders')
            .update({ status: targetStatus, updated_at: new Date().toISOString() })
            .eq('id', id!)
            .select();
          checkMutationResult(statusResult, 'Update order status');
          toast('success', `Status changed to ${targetStatus.replace('_', ' ')}`);
        }

        logActivity({ event: 'order_status_changed', description: `Order ${order.order_number} status changed to ${targetStatus}`, performedBy: profile.id, entityType: 'order', entityId: order.id, customerId: order.customer_id });
        notifyOrderStatusChange(order.id, order.order_number, customer?.farm_name || 'customer', targetStatus, order.created_by ?? undefined);

        // === Email customer when order is confirmed ===
        if (targetStatus === 'confirmed' && customer?.email) {
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
                  <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${new Date(order.order_date + 'T00:00:00').toLocaleDateString()}</td>
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
            Sentry.captureException(emailErr instanceof Error ? emailErr : new Error(String(emailErr)), { level: 'warning', extra: { context: 'Order confirmation email failed — status change already succeeded' } });
            // Status change already succeeded — don't show error for email
          }
        }

        setStatusModalOpen(false);
        fetchOrder();
      },
      toast,
      setLoading: setChangingStatus,
      sentryTag: 'change_order_status',
    });
  };

  // ── Void Order (fulfilled → voided, admin-only) ───────────────────────
  const handleVoidOrder = async () => {
    if (!order || !profile) return;
    setVoiding(true);
    try {
      const idemKey = voidOrderIdem.getKey();
      const { data: voidResult, error } = await supabase.rpc('void_order', {
        p_order_id: order.id,
        p_performed_by: profile.id,
        p_reason: voidReason.trim() || 'Voided by admin',
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      voidOrderIdem.resetKey();
      assertRpcResult(voidResult, 'void_order');

      const parts: string[] = ['Order voided.'];
      if (voidResult?.inventory_products_restored > 0)
        parts.push(`Inventory restored for ${voidResult.inventory_products_restored} product(s).`);
      if (voidResult?.commissions_cancelled > 0)
        parts.push(`${voidResult.commissions_cancelled} commission(s) cancelled.`);
      if (voidResult?.draft_invoices_voided > 0)
        parts.push(`${voidResult.draft_invoices_voided} draft invoice(s) voided.`);
      if (voidResult?.posted_invoices_flagged > 0)
        parts.push(`Admin notified about ${voidResult.posted_invoices_flagged} posted invoice(s).`);
      if (voidResult?.paid_commissions_flagged > 0)
        parts.push(`Admin notified about ${voidResult.paid_commissions_flagged} paid commission(s).`);

      toast('success', parts.join(' '));
      setVoidModalOpen(false);
      setVoidReason('');
      fetchOrder();
    } catch (error: unknown) {
      toast('error', sanitizeError(error));
    } finally {
      setVoiding(false);
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
      const amountCents = Math.round(order.total_price * 100 * (pct / 100));
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
    await runCriticalAction({
      action: async () => {
        const invoiceKey = createInvoiceIdem.getKey();
        const { data, error } = await supabase.rpc('create_invoice_from_order', {
          p_order_id: id,
          p_salesman_id: profile.id,
          p_idempotency_key: invoiceKey,
        });
        if (error) throw error;
        createInvoiceIdem.resetKey();
        const invoiceId = assertRpcResult<string>(data, 'create_invoice_from_order');
        navigate(`/invoices/${invoiceId}`);
      },
      toast,
      successMessage: 'Draft invoice created',
      setLoading: setCreatingInvoice,
      sentryTag: 'create_invoice_from_order',
    });
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
              <Button variant="ghost" icon={<X className="w-4 h-4" />} showChevron={false} onClick={() => { setEditing(false); setEditItems(items.map((i) => ({ ...i }))); setNewItems([]); }}>
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
              <Button
                variant="secondary"
                icon={<MessageSquarePlus className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setQuickTaskOpen(true)}
              >
                Create Task
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Active delivery banner — shows when scheduled/in_progress deliveries exist */}
      {(() => {
        const activeDeliveries = deliveries.filter((d) => d.status === 'scheduled' || d.status === 'in_progress');
        if (activeDeliveries.length === 0) return null;
        const scheduledCount = activeDeliveries.filter((d) => d.status === 'scheduled').length;
        const inProgressCount = activeDeliveries.filter((d) => d.status === 'in_progress').length;
        const parts: string[] = [];
        if (scheduledCount > 0) parts.push(`${scheduledCount} scheduled`);
        if (inProgressCount > 0) parts.push(`${inProgressCount} in progress`);
        return (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-blue-50 border border-blue-200">
            <Truck className="w-5 h-5 text-blue-600 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-800">
                {activeDeliveries.length} active {activeDeliveries.length === 1 ? 'delivery' : 'deliveries'} — {parts.join(', ')}
              </p>
              <div className="flex flex-wrap gap-2 mt-1">
                {activeDeliveries.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => navigate(`/deliveries/${d.id}`)}
                    className="text-xs text-blue-700 hover:text-blue-900 underline"
                  >
                    {d.delivery_number} — {parseLocalDate(d.scheduled_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {d.driver_name ? ` (${d.driver_name})` : ''}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">
              {order.order_number}
            </h2>
            {order.order_name && (
              <p className="text-base font-medium text-nav-dark mt-0.5">{order.order_name}</p>
            )}
            <p className="text-sm text-secondary mt-1">
              {customer?.farm_name || 'Unknown Customer'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && order.status !== 'voided' && order.status !== 'cancelled' && (
              <button
                onClick={() => { setNewStatus(order.status); setStatusModalOpen(true); }}
                className="text-xs text-secondary hover:text-crx-green underline"
              >
                Change Status
              </button>
            )}
            {isAdmin && order.status === 'fulfilled' && (
              <button
                onClick={() => setVoidModalOpen(true)}
                className="text-xs text-red-500 hover:text-red-700 underline font-medium"
              >
                Void Order
              </button>
            )}
            <button
              onClick={handleTogglePlanned}
              disabled={togglingPlanned}
              title={order.is_planned ? 'Click to mark as Committed' : 'Click to mark as Planned'}
              className="cursor-pointer disabled:opacity-50"
            >
              <Badge variant={order.is_planned ? 'warning' : 'success'} size="md">
                {togglingPlanned ? '...' : order.is_planned ? 'Planned' : 'Committed'}
              </Badge>
            </button>
            <Badge variant={statusToBadgeVariant[order.status] || 'default'} size="md">
              {order.status.replace('_', ' ')}
            </Badge>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
          <div>
            <p className="text-xs text-secondary">Order Date</p>
            <p className="text-sm font-medium text-nav-dark">
              {new Date(order.order_date + 'T00:00:00').toLocaleDateString()}
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

      {order.notes && (
        <Card>
          <div className="flex items-start gap-3">
            <FileText className="w-4 h-4 text-secondary mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-secondary font-medium mb-1">Order Notes</p>
              <p className="text-sm text-nav-dark whitespace-pre-wrap">{order.notes}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Related Notes */}
      <RelatedNotes
        entityType={'order' as LinkedEntityType}
        entityId={id!}
        onCreateTask={() => setQuickTaskOpen(true)}
      />

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
                      {parseLocalDate(del.scheduled_date).toLocaleDateString()}
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
                      <Badge variant={inv.status === 'posted' ? 'success' : inv.status === 'draft' || inv.status === 'unposted' ? 'default' : inv.status === 'voided' || inv.status === 'cancelled' ? 'error' : 'warning'} size="sm">
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
                    {/* New items being added */}
                    {newItems.map((ni) => (
                      <tr key={ni._tempKey} className="border-b border-green-100 bg-green-50/40">
                        <td className="px-4 py-3 font-medium text-nav-dark">
                          <div className="flex items-center gap-1">
                            <Plus className="w-3 h-3 text-crx-green" />
                            {ni.product_name}
                            <span className="text-xs text-crx-green font-normal">(new)</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono">
                          <input
                            type="number"
                            value={ni.price_per_unit}
                            onChange={(e) => updateNewItem(ni._tempKey, 'price_per_unit', Number(e.target.value))}
                            className="w-24 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                            step="0.01"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={ni.total_units_needed || ''}
                            onChange={(e) => updateNewItem(ni._tempKey, 'total_units_needed', Number(e.target.value))}
                            className="w-20 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                            placeholder="Qty"
                          />
                        </td>
                        <td className="px-4 py-3 text-secondary">0</td>
                        <td className="px-4 py-3 text-secondary">{ni.total_units_needed || 0}</td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-secondary">—</span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => removeNewItem(ni._tempKey)}
                            className="text-red-400 hover:text-red-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {/* Add Product button */}
                    <tr className="border-t border-dashed border-gray-300">
                      <td colSpan={7} className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => { setShowProductModal(true); setProductSearch(''); }}
                          className="flex items-center gap-2 text-sm text-crx-green hover:text-crx-green/80 font-medium transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                          Add Product
                        </button>
                      </td>
                    </tr>
                    {/* New total */}
                    <tr className="border-t border-gray-200">
                      <td colSpan={2} className="px-4 py-3 font-medium text-nav-dark">
                        New Total:
                      </td>
                      <td colSpan={5} className="px-4 py-3 font-semibold text-nav-dark">
                        {fmt(
                          editItems.reduce((s, i) => s + i.price_per_unit * i.total_units_needed, 0) +
                          newItems.reduce((s, i) => s + i.price_per_unit * i.total_units_needed, 0)
                        )}
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
                    <span className="text-xs text-gray-500">{parseLocalDate(bt.ticket_date).toLocaleDateString()}</span>
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
            <option value={order?.status}>{(order?.status || '').replace('_', ' ')}</option>
            {(({ confirmed: ['partially_fulfilled', 'fulfilled', 'cancelled'], partially_fulfilled: ['fulfilled', 'cancelled'] } as Record<string, string[]>)[order?.status || ''] || [])
              .filter(s => s !== 'cancelled' || isAdmin)
              .map(s => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setStatusModalOpen(false)}>Cancel</Button>
            <Button onClick={handleStatusChange} loading={changingStatus} disabled={changingStatus}>Update Status</Button>
          </div>
        </div>
      </Modal>

      {/* Void Order Modal */}
      <Modal open={voidModalOpen} onClose={() => { setVoidModalOpen(false); setVoidReason(''); }} title="Void Order">
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-red-50 rounded-lg border border-red-200">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-700 space-y-1">
              <p className="font-semibold">This action cannot be undone.</p>
              <ul className="list-disc list-inside space-y-0.5 text-red-600">
                <li>Inventory will be restored for all delivered items</li>
                <li>Draft invoices will be voided</li>
                <li>Pending commissions will be cancelled</li>
                <li>Posted invoices and paid commissions require manual review</li>
              </ul>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">
              Reason <span className="text-secondary font-normal">(optional)</span>
            </label>
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. Customer cancelled, duplicate order, data entry error..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-400 resize-none"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => { setVoidModalOpen(false); setVoidReason(''); }} disabled={voiding}>
              Cancel
            </Button>
            <Button
              onClick={handleVoidOrder}
              loading={voiding}
              disabled={voiding}
              className="bg-red-600 hover:bg-red-700 text-white border-red-600 hover:border-red-700"
            >
              Void Order
            </Button>
          </div>
        </div>
      </Modal>

      {/* Add Product to Order Modal */}
      <Modal
        open={showProductModal}
        onClose={() => setShowProductModal(false)}
        title="Add Product to Order"
        size="large"
      >
        <div className="space-y-4">
          <Input
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder="Search products..."
          />

          <div className="max-h-96 overflow-y-auto space-y-2">
            {filteredProducts.map((product) => {
              const tierNum = customer?.assigned_tier || 1;
              // Cascade: tier3 → tier2 → tier1 fallback
              const t1 = product.tier1_price || 0;
              const tierPrice =
                tierNum === 1
                  ? t1
                  : tierNum === 2
                    ? product.tier2_price || t1
                    : product.tier3_price || t1;
              const inv = inventoryByProduct[product.id];
              const onFloor = inv ? inv.available : 0;
              const netPos = inv ? inv.onOrder + inv.available - inv.prebooked : 0;

              // Check if product is already in order (existing or newly added)
              const alreadyInOrder = editItems.some((ei) => ei.product_id === product.id) ||
                newItems.some((ni) => ni.product_id === product.id);

              return (
                <button
                  key={product.id}
                  onClick={() => handleAddProduct(product)}
                  disabled={alreadyInOrder}
                  className={`w-full text-left p-3 border rounded-lg transition-colors ${
                    alreadyInOrder
                      ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                      : 'border-gray-200 hover:border-crx-green hover:bg-gray-50'
                  }`}
                >
                  <div className="font-medium text-nav-dark">
                    {product.product_name}
                    {alreadyInOrder && (
                      <span className="text-xs text-secondary ml-2">(already in order)</span>
                    )}
                  </div>
                  {product.manufacturer && (
                    <div className="text-xs text-secondary mt-1">{product.manufacturer}</div>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-secondary">
                    {product.unit_size && <span>Size: {product.unit_size}</span>}
                    {tierPrice > 0 && (
                      <span className="text-crx-green font-medium">
                        Price:{' '}
                        {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        }).format(tierPrice)}
                      </span>
                    )}
                    <span className={onFloor > 0 ? 'text-blue-600' : 'text-gray-400'}>
                      On Floor: {onFloor.toLocaleString()}
                    </span>
                    <span className={netPos > 0 ? 'text-emerald-600' : netPos < 0 ? 'text-red-600' : 'text-gray-400'}>
                      Net: {netPos.toLocaleString()}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {filteredProducts.length === 0 && (
            <div className="text-center py-8 text-secondary">No products found</div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={statusConfirmOpen}
        onClose={() => setStatusConfirmOpen(false)}
        onConfirm={executeStatusChange}
        title="Change Order Status"
        message={`Change order status to ${pendingStatus.replace('_', ' ')}?`}
        variant="warning"
        confirmLabel="Change Status"
        loading={changingStatus}
      />

      <QuickTaskModal
        open={quickTaskOpen}
        onClose={() => setQuickTaskOpen(false)}
        entityType={'order' as LinkedEntityType}
        entityId={id!}
        prefillTitle={`Follow up: ${order.order_number}`}
        prefillContent={`Customer: ${customer?.farm_name || 'Unknown'}`}
      />

    </div>
  );
}
