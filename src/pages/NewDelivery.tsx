import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Minus, Plus } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase } from '../lib/db';
import { notifyDriverAssigned } from '../lib/notificationTriggers';
import type { Order, OrderItem, Customer, CustomerAddress, Profile } from '../types';

interface DeliveryItemDraft {
  order_item_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  max_quantity: number;
  unit_size: string;
}

export default function NewDelivery() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  const { toast } = useToast();

  const preselectedOrderId = searchParams.get('order') || '';

  const [orders, setOrders] = useState<(Order & { customer_name: string })[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState(preselectedOrderId);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [deliveryItems, setDeliveryItems] = useState<DeliveryItemDraft[]>([]);

  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().split('T')[0]);
  const [scheduledTime, setScheduledTime] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [selectedOrderId, selectedAddressId, selectedDriverId, scheduledDate, scheduledTime, deliveryNotes, deliveryItems]);

  useEffect(() => {
    fetchOrders();
    fetchDrivers();
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, []);

  useEffect(() => {
    if (selectedOrderId) {
      fetchOrderDetails(selectedOrderId);
    } else {
      setOrderItems([]);
      setCustomer(null);
      setAddresses([]);
      setDeliveryItems([]);
    }
  }, [selectedOrderId]);

  const fetchOrders = async () => {
    const { data } = await supabase
      .from('orders')
      .select('*, customer:customers(farm_name)')
      .in('status', ['confirmed', 'partially_fulfilled'])
      .order('order_date', { ascending: false });

    const rows = ((data || []) as Array<Order & { customer: { farm_name: string } | null }>).map((o) => ({
      ...o,
      customer_name: o.customer?.farm_name || 'Unknown',
    }));
    setOrders(rows);
    setLoadingOrders(false);
  };

  const fetchDrivers = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .in('role', ['driver', 'admin'])
      .eq('is_active', true)
      .order('full_name');
    setDrivers((data || []) as Profile[]);
  };

  const fetchOrderDetails = async (orderId: string) => {
    setLoadingDetails(true);
    const { data: orderData } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();

    if (!orderData) {
      setLoadingDetails(false);
      return;
    }

    const [custRes, itemsRes] = await Promise.all([
      supabase.from('customers').select('*').eq('id', orderData.customer_id).maybeSingle(),
      supabase.from('order_items').select('*').eq('order_id', orderId).order('section_name'),
    ]);

    const cust = custRes.data as Customer | null;
    setCustomer(cust);
    const items = (itemsRes.data || []) as OrderItem[];
    setOrderItems(items);

    if (cust) {
      const { data: addrData } = await supabase
        .from('customer_addresses')
        .select('*')
        .eq('customer_id', cust.id)
        .order('is_default', { ascending: false });
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
      }));
    setDeliveryItems(drafts);
    setLoadingDetails(false);
  };

  const updateItemQty = (orderItemId: string, qty: number) => {
    setDeliveryItems((prev) =>
      prev.map((item) =>
        item.order_item_id === orderItemId
          ? { ...item, quantity: Math.max(0, Math.min(qty, item.max_quantity)) }
          : item
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
    const today = new Date().toISOString().split('T')[0];
    if (scheduledDate < today) {
      toast('warning', 'Scheduled date is in the past — delivery will be created anyway');
    }

    // Guard: Ensure profile is loaded
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    setSaving(true);

    const order = orders.find((o) => o.id === selectedOrderId);
    if (!order) {
      toast('error', 'Order not found');
      setSaving(false);
      return;
    }

    const { count } = await supabase
      .from('deliveries')
      .select('*', { count: 'exact', head: true });
    const nextNum = (count || 0) + 1;
    const deliveryNumber = `DEL-${String(nextNum).padStart(5, '0')}`;

    const { data: delData, error: delError } = await supabase
      .from('deliveries')
      .insert({
        delivery_number: deliveryNumber,
        order_id: selectedOrderId,
        customer_id: order.customer_id,
        delivery_address_id: selectedAddressId || null,
        assigned_driver: selectedDriverId || null,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime || null,
        delivery_notes: deliveryNotes || null,
        status: 'scheduled',
        created_by: profile.id,
      })
      .select('id')
      .maybeSingle();

    if (delError || !delData) {
      toast('error', delError?.message || 'Failed to create delivery');
      setSaving(false);
      return;
    }

    const itemInserts = activeItems.map((item) => ({
      delivery_id: delData.id,
      order_item_id: item.order_item_id,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_size: item.unit_size || null,
    }));

    const { error: itemError } = await supabase
      .from('delivery_items')
      .insert(itemInserts);

    if (itemError) {
      toast('error', 'Delivery created but failed to add items');
      setSaving(false);
      navigate(`/deliveries/${delData.id}`);
      return;
    }

    setIsDirty(false);
    toast('success', `Delivery ${deliveryNumber} scheduled`);

    // GAP FIX #17: Notify the assigned driver
    if (selectedDriverId) {
      const custName = customer?.farm_name || 'customer';
      await notifyDriverAssigned(selectedDriverId, deliveryNumber, custName, scheduledDate, delData.id);
    }

    navigate(`/deliveries/${delData.id}`);
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

          <Input
            label="Delivery Notes (optional)"
            value={deliveryNotes}
            onChange={(e) => setDeliveryNotes(e.target.value)}
            placeholder="Special instructions, gate codes, etc."
          />
        </div>
      </Card>

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
                      onChange={(e) => updateItemQty(item.order_item_id, parseInt(e.target.value) || 0)}
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

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
