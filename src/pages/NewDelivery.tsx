import { useEffect, useRef, useState , useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Minus, Plus, AlertTriangle } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';

import { logActivity } from '../lib/activityLogger';
import { useOverloadedDriverCheck } from '../hooks/useGuardrails';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import GuardrailBanner from '../components/ui/GuardrailBanner';
import { notifyDriverAssigned } from '../lib/notificationTriggers';
import { checkRUPCompliance } from '../lib/rupCompliance';
import { localToday } from '../lib/dateUtils';
import { sumNeedByProduct } from '../lib/inventoryShortage';
import type { Order, OrderItem, Customer, CustomerAddress, Profile } from '../types';

interface DeliveryItemDraft {
  order_item_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  max_quantity: number;
  unit_size: string;
  tote_number: string;
  notes: string | null;
}

function isValidDateParam(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime())
    && parsed.getFullYear() === Number(value.slice(0, 4))
    && parsed.getMonth() + 1 === Number(value.slice(5, 7))
    && parsed.getDate() === Number(value.slice(8, 10));
}

export default function NewDelivery() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  const { toast } = useToast();
  // Idempotency key for create_delivery_with_items (audit #10): the RPC writes
  // both the delivery and its items atomically; the key prevents double-insert
  // on retry/double-submit.
  const createDeliveryKey = useIdempotencyKey('create_delivery_with_items', profile?.id || 'anon');
  // Codex P2 fix (PR #59, 2026-05-16): reset the key when form intent changes.
  // The page stays mounted across submissions — if create A succeeded but the
  // response was lost, the user can edit the form (different order/items/date)
  // and resubmit, and the persisted key would replay A's cached result without
  // creating B. Hashing the submission-affecting inputs detects intent
  // changes; identical retries (form unchanged) still reuse the key.
  // See useEffect below — needs to fire AFTER state declarations.
  const { warning: driverWarning, check: checkDriverLoad, dismiss: dismissDriverWarning } = useOverloadedDriverCheck();

  const preselectedOrderId = searchParams.get('order') || '';
  const customerIdParam = searchParams.get('customer_id') || '';
  const scheduledDateParam = searchParams.get('date');

  const [orders, setOrders] = useState<(Order & { customer_name: string })[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState(preselectedOrderId);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [deliveryItems, setDeliveryItems] = useState<DeliveryItemDraft[]>([]);

  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [scheduledDate, setScheduledDate] = useState(() => (
    isValidDateParam(scheduledDateParam) ? scheduledDateParam : localToday()
  ));
  const [scheduledTime, setScheduledTime] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');

  // Codex P2 fix (PR #59, 2026-05-16): reset the createDeliveryKey when the
  // form intent (order/items/date/driver) changes. Stable form = same key
  // = idempotent retry. Changed form = fresh key = new intent.
  // Hash MUST cover EVERY submitted field — Codex 2026-05-16 follow-up flagged
  // that omitting any field (notes, per-item unit_size/tote_number/notes) lets
  // a same-key replay return success while silently dropping the edited data.
  const intentHash = [
    selectedOrderId, scheduledDate, scheduledTime, selectedDriverId,
    selectedAddressId, deliveryNotes,
    deliveryItems
      .map((i) => `${i.order_item_id}:${i.product_id}:${i.quantity}:${i.unit_size || ''}:${i.tote_number || ''}:${i.notes || ''}`)
      .sort()
      .join(','),
  ].join('|');
  useEffect(() => {
    createDeliveryKey.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentHash]);

  const [saving, setSaving] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [rupWarnings, setRupWarnings] = useState<string[]>([]);
  const [inventoryWarnings, setInventoryWarnings] = useState<string[]>([]);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  const fetchOrders = useCallback(async () => {
    let orderQuery = supabase
      .from('orders')
      .select('*, customer:customers(farm_name)')
      .in('status', ['confirmed', 'partially_fulfilled'])
      .is('deleted_at', null);

    if (customerIdParam) {
      orderQuery = orderQuery.eq('customer_id', customerIdParam);
    }

    const { data, error } = await orderQuery.order('order_date', { ascending: false });

    if (error) {
      toast('error', 'Failed to load orders: ' + error.message);
      setLoadingOrders(false);
      return;
    }

    const rows = ((data || []) as Array<Omit<Order, 'customer'> & { customer: { farm_name: string } | null }>).map((o) => ({
      ...o,
      customer_name: o.customer?.farm_name || 'Unknown',
    }));
    setOrders(rows as (Order & { customer_name: string })[]);
    setLoadingOrders(false);
  }, [customerIdParam, toast]);

  const fetchDrivers = useCallback(async () => {
    // PR-07 follow-up: driver picker only uses d.id + d.full_name + d.role; safe via view.
    const { data, error } = await supabase
      .from('profile_public_view')
      .select('id, full_name, role, is_active')
      .in('role', ['driver', 'admin', 'sales_rep'])
      .eq('is_active', true)
      .order('full_name');
    if (error) {
      toast('error', 'Failed to load drivers: ' + error.message);
      return;
    }
    setDrivers((data || []) as Profile[]);
  }, [toast]);

  const fetchOrderDetails = useCallback(async (orderId: string) => {
    setLoadingDetails(true);
    const { data: orderData, error: orderErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();

    if (orderErr) {
      toast('error', 'Failed to load order: ' + orderErr.message);
      setLoadingDetails(false);
      return;
    }

    if (!orderData) {
      setLoadingDetails(false);
      return;
    }

    const [custRes, itemsRes] = await Promise.all([
      supabase.from('customers').select('*').eq('id', orderData.customer_id).maybeSingle(),
      supabase.from('order_items').select('*').eq('order_id', orderId).order('section_name'),
    ]);

    if (custRes.error) {
      Sentry.captureException(custRes.error, { tags: { source: 'fetch', action: 'load_customer' } });
      toast('error', 'Failed to load customer details.');
    }
    if (itemsRes.error) {
      Sentry.captureException(itemsRes.error, { tags: { source: 'fetch', action: 'load_order_items' } });
      toast('error', 'Failed to load order items.');
    }

    const cust = custRes.data as Customer | null;
    setCustomer(cust);
    const items = (itemsRes.data || []) as OrderItem[];
    setOrderItems(items);

    if (cust) {
      const { data: addrData, error: addrErr } = await supabase
        .from('customer_addresses')
        .select('*')
        .eq('customer_id', cust.id)
        .order('is_default', { ascending: false });
      if (addrErr) {
        Sentry.captureException(addrErr, { tags: { source: 'fetch', action: 'load_addresses' } });
      }
      const addrs = (addrData || []) as CustomerAddress[];
      setAddresses(addrs);
      const defaultAddr = addrs.find((a) => a.is_default);
      if (defaultAddr) setSelectedAddressId(defaultAddr.id);
    }

    const drafts: DeliveryItemDraft[] = items
      .filter((item) => item.quantity_remaining > 0)
      .map((item) => ({
        order_item_id: item.id,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity_remaining,
        max_quantity: item.quantity_remaining,
        unit_size: item.unit_size || '',
        tote_number: '',
        notes: item.notes || null,
      }));
    setDeliveryItems(drafts);
    setLoadingDetails(false);
  }, [toast]);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [selectedOrderId, selectedAddressId, selectedDriverId, scheduledDate, scheduledTime, deliveryNotes, deliveryItems]);

  useEffect(() => {
    fetchOrders();
    fetchDrivers();
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [fetchOrders, fetchDrivers]);

  useEffect(() => {
    if (selectedOrderId) {
      fetchOrderDetails(selectedOrderId);
    } else {
      setOrderItems([]);
      setCustomer(null);
      setAddresses([]);
      setDeliveryItems([]);
    }
  }, [selectedOrderId, fetchOrderDetails]);

  // RUP compliance check
  useEffect(() => {
    if (!customer || !deliveryItems.length) { setRupWarnings([]); return; }
    const productIds = deliveryItems.map((i) => i.product_id).filter(Boolean);
    if (!productIds.length) { setRupWarnings([]); return; }
    let cancelled = false;
    checkRUPCompliance(customer.id, productIds).then((res) => {
      if (!cancelled) {
        setRupWarnings(res.warnings);
        if (res.warnings.length > 0 && profile?.id) {
          logActivity({ event: 'rup_compliance_warning', description: `RUP products (${res.rupProductNames.join(', ')}) on delivery for customer without valid license`, performedBy: profile.id, entityType: 'customer', entityId: customer.id, customerId: customer.id });
        }
      }
    });
    return () => { cancelled = true; };
  }, [customer, deliveryItems, profile?.id]);

  // Guardrail: check if driver is overloaded when driver or date changes.
  // `drivers` MUST stay in the deps array — if it's dropped, the guardrail
  // can run with `driverName: undefined` when the drivers list hasn't resolved
  // yet. See NewDelivery.driver-guardrail.test.tsx and the 2026-04-10 audit.
  useEffect(() => {
    if (selectedDriverId && scheduledDate) {
      const driver = drivers.find(d => d.id === selectedDriverId);
      checkDriverLoad({ driverId: selectedDriverId, scheduledDate, driverName: driver?.full_name });
    }
  }, [selectedDriverId, scheduledDate, drivers, checkDriverLoad]);

  // Inventory availability check — warn (don't block) if stock is low
  useEffect(() => {
    if (!deliveryItems.length) { setInventoryWarnings([]); return; }
    const productIds = [...new Set(deliveryItems.map((i) => i.product_id).filter(Boolean))];
    if (!productIds.length) { setInventoryWarnings([]); return; }
    let cancelled = false;

    (async () => {
      const { data: invData, error: invErr } = await supabase
        .from('inventory')
        .select('product_id, location, quantity_available, quantity_prebooked')
        .in('product_id', productIds);

      if (cancelled || invErr) return;

      // Group by product, then by location, so warnings can show where stock physically sits.
      // This is informational only — the operator decides if stock at another warehouse is usable.
      const invMap: Record<string, Record<string, { available: number; prebooked: number }>> = {};
      for (const row of (invData || []) as Array<{ product_id: string; location: string | null; quantity_available: number; quantity_prebooked: number }>) {
        const pid = row.product_id;
        const loc = row.location || 'Unknown';
        if (!invMap[pid]) invMap[pid] = {};
        if (!invMap[pid][loc]) invMap[pid][loc] = { available: 0, prebooked: 0 };
        invMap[pid][loc].available += Number(row.quantity_available);
        invMap[pid][loc].prebooked += Number(row.quantity_prebooked);
      }

      // Sum the need per PRODUCT before comparing — a tier-split booking puts
      // the same product on several lines. See src/lib/inventoryShortage.ts.
      const warnings: string[] = [];
      for (const need of sumNeedByProduct(
        deliveryItems.map((item) => ({
          productId: item.product_id,
          label: item.product_name,
          quantity: item.quantity,
        }))
      )) {
        const byLocation = invMap[need.productId] || {};
        const locations = Object.entries(byLocation);
        const totalNet = locations.reduce((sum, [, v]) => sum + (v.available - v.prebooked), 0);
        if (totalNet < need.quantity) {
          const breakdown = locations.length
            ? locations.map(([loc, v]) => `${loc}: ${v.available - v.prebooked}`).join(', ')
            : 'no inventory records';
          warnings.push(
            `${need.label}: need ${need.quantity}, only ${totalNet} net available (${breakdown})`
          );
        }
      }
      if (!cancelled) setInventoryWarnings(warnings);
    })();

    return () => { cancelled = true; };
  }, [deliveryItems]);

  const updateItemQty = (orderItemId: string, qty: number) => {
    setDeliveryItems((prev) =>
      prev.map((item) =>
        item.order_item_id === orderItemId
          ? { ...item, quantity: Math.max(0, Math.min(qty, item.max_quantity)) }
          : item
      )
    );
  };

  const updateItemTote = (orderItemId: string, tote: string) => {
    setDeliveryItems((prev) =>
      prev.map((item) =>
        item.order_item_id === orderItemId ? { ...item, tote_number: tote } : item
      )
    );
  };

  const removeItem = (orderItemId: string) => {
    setDeliveryItems((prev) => prev.filter((item) => item.order_item_id !== orderItemId));
  };

  const handleSave = async () => {
    if (!selectedOrderId) {
      toast('error', 'Please select an order');
      return;
    }
    const activeItems = deliveryItems.filter((item) => item.quantity > 0);
    if (activeItems.length === 0) {
      toast('error', 'Add at least one item with quantity > 0');
      return;
    }
    if (!scheduledDate) {
      toast('error', 'Please set a delivery date');
      return;
    }

    // Warn if scheduled date is in the past
    const today = localToday();
    if (scheduledDate < today) {
      toast('warning', 'Scheduled date is in the past — delivery will be created anyway');
    }

    // Guard: Ensure profile is loaded
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    // Check for duplicate deliveries on same order
    const { data: existingDels, error: dupCheckErr } = await supabase
      .from('deliveries')
      .select('delivery_number, status')
      .eq('order_id', selectedOrderId)
      .in('status', ['scheduled', 'in_progress']);

    if (dupCheckErr) {
      toast('error', 'Failed to check for existing deliveries');
      return;
    }

    if (existingDels && existingDels.length > 0) {
      const delList = existingDels.map(d => `${d.delivery_number} (${d.status.replace('_', ' ')})`).join(', ');
      setDuplicateWarning(
        `This order already has ${existingDels.length} active delivery(ies): ${delList}. Create another delivery for this order?`
      );
      return;
    }

    await submitDelivery();
  };

  const submitDelivery = async () => {
    if (!profile) return;
    const activeItems = deliveryItems.filter((item) => item.quantity > 0);
    setSaving(true);
    // No idempotency key — see comment at top of component

    const order = orders.find((o) => o.id === selectedOrderId);
    if (!order) {
      toast('error', 'Order not found');
      setSaving(false);
      return;
    }

    // Audit #10: atomic create — delivery + items in one transaction. If items
    // fail, the delivery is rolled back too (no orphaned delivery rows).
    const { data, error } = await supabase.rpc('create_delivery_with_items', {
      p_order_id: selectedOrderId,
      p_customer_id: order.customer_id,
      p_scheduled_date: scheduledDate,
      p_items: activeItems.map((item) => ({
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_size: item.unit_size || null,
        tote_number: item.tote_number || null,
        notes: item.notes || null,
      })),
      p_delivery_address_id: selectedAddressId || undefined,
      p_assigned_driver: selectedDriverId || undefined,
      p_scheduled_time: scheduledTime || undefined,
      p_delivery_notes: deliveryNotes || undefined,
      p_idempotency_key: createDeliveryKey.getKey(),
    });

    if (error) {
      toast('error', error.message || 'Failed to create delivery');
      Sentry.captureException(error, { extra: { context: 'create_delivery_with_items' } });
      setSaving(false);
      return;
    }

    const result = assertRpcResult<{ delivery_id: string; delivery_number: string }>(data, 'create_delivery_with_items');
    const deliveryNumber = result.delivery_number;
    const deliveryId = result.delivery_id;

    setIsDirty(false);
    createDeliveryKey.resetKey();
    toast('success', `Delivery ${deliveryNumber} scheduled`);
    logActivity({ event: 'delivery_created', description: `Delivery ${deliveryNumber} created for order ${order.order_number}`, performedBy: profile.id, entityType: 'delivery', entityId: deliveryId, customerId: order.customer_id });

    // GAP FIX #17: Notify the assigned driver
    if (selectedDriverId) {
      const custName = customer?.farm_name || 'customer';
      await notifyDriverAssigned(selectedDriverId, deliveryNumber, custName, scheduledDate, deliveryId);
    }

    navigate(`/deliveries/${deliveryId}`);
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/deliveries')}
        className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Deliveries
      </button>

      <Card>
        <h2 className="text-xl font-semibold font-heading text-nav-dark mb-6">
          Schedule Delivery
        </h2>

        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Order</label>
            {loadingOrders ? (
              <div className="h-10 bg-gray-100 rounded-lg animate-pulse" />
            ) : (
              <select
                value={selectedOrderId}
                onChange={(e) => setSelectedOrderId(e.target.value)}
                className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Select an order...</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.order_number} - {o.customer_name} ({o.status.replace('_', ' ')})
                  </option>
                ))}
              </select>
            )}
          </div>

          {customer && (
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm font-medium text-nav-dark">{customer.farm_name}</p>
              {customer.contact_name && (
                <p className="text-sm text-secondary">{customer.contact_name}</p>
              )}
              {customer.phone && (
                <p className="text-sm text-secondary">{customer.phone}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Delivery Address</label>
              <select
                value={selectedAddressId}
                onChange={(e) => setSelectedAddressId(e.target.value)}
                className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Use billing address</option>
                {addresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} - {[a.address_line, a.city, a.state].filter(Boolean).join(', ')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Assigned Driver</label>
              <select
                value={selectedDriverId}
                onChange={(e) => setSelectedDriverId(e.target.value)}
                className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Unassigned</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.full_name} ({d.role})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Scheduled Date"
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
            />
            <Input
              label="Scheduled Time (optional)"
              type="time"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
            />
          </div>

          <GuardrailBanner warning={driverWarning} onDismiss={dismissDriverWarning} />

          <Input
            label="Delivery Notes (optional)"
            value={deliveryNotes}
            onChange={(e) => setDeliveryNotes(e.target.value)}
            placeholder="Special instructions, gate codes, etc."
          />
        </div>
      </Card>

      {rupWarnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          </div>
        </div>
      )}

      {inventoryWarnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Low Inventory Warning</p>
              <div className="text-sm text-amber-700 mt-1">
                {inventoryWarnings.map((w, i) => <p key={i}>{w}</p>)}
              </div>
              <p className="text-xs text-amber-600 mt-1">Delivery can still be scheduled — verify physical stock.</p>
            </div>
          </div>
        </div>
      )}

      {selectedOrderId && (
        <Card>
          <h3 className="text-lg font-semibold font-heading text-nav-dark mb-4">
            Delivery Items
          </h3>
          {loadingDetails ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : deliveryItems.length === 0 ? (
            <p className="text-sm text-secondary py-4 text-center">
              {orderItems.length === 0
                ? 'No items found on this order'
                : 'All items have been fully delivered'}
            </p>
          ) : (
            <div className="space-y-3">
              {deliveryItems.map((item) => (
                <div
                  key={item.order_item_id}
                  className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-nav-dark truncate">
                      {item.product_name}
                    </p>
                    <p className="text-xs text-secondary">
                      Remaining: {item.max_quantity} {item.unit_size || 'units'}
                    </p>
                  </div>
                  <input
                    type="text"
                    placeholder="Tote #"
                    value={item.tote_number}
                    onChange={(e) => updateItemTote(item.order_item_id, e.target.value)}
                    className="w-28 px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateItemQty(item.order_item_id, item.quantity - 1)}
                      className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                    >
                      <Minus className="w-3.5 h-3.5 text-secondary" />
                    </button>
                    <input
                      type="number"
                      value={item.quantity}
                      onChange={(e) => updateItemQty(item.order_item_id, parseFloat(e.target.value) || 0)}
                      className="w-20 text-center px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                      min="0"
                      max={item.max_quantity}
                    />
                    <button
                      onClick={() => updateItemQty(item.order_item_id, item.quantity + 1)}
                      className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5 text-secondary" />
                    </button>
                    <button
                      onClick={() => removeItem(item.order_item_id)}
                      className="ml-2 text-xs text-red-500 hover:text-red-700 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={() => navigate('/deliveries')}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || !selectedOrderId}>
          {saving ? 'Scheduling...' : 'Schedule Delivery'}
        </Button>
      </div>

      <ConfirmModal
        open={!!duplicateWarning}
        onClose={() => setDuplicateWarning(null)}
        onConfirm={() => {
          setDuplicateWarning(null);
          submitDelivery();
        }}
        title="Duplicate Delivery Warning"
        message={duplicateWarning || ''}
        confirmLabel="Create Delivery"
        variant="warning"
      />

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
