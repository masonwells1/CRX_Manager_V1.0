import { useEffect, useState , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Plus,
  Trash2,
  Search,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useFormDraft } from '../hooks/useFormDraft';
import { notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { trackBusinessEvent } from '../lib/metrics';
import { localToday } from '../lib/dateUtils';
import type { Product, Customer } from '../types';

interface LocalItem {
  _key: string;
  product_id: string;
  product_name: string;
  quantity: number;
  price_per_unit: number;
  unit_cost: number;
  unit_size: string | null;
  notes: string | null;
}

let keyCounter = 0;
function nextKey() {
  return `_k${++keyCounter}`;
}

function makeEmptyItem(): LocalItem {
  return {
    _key: nextKey(),
    product_id: '',
    product_name: '',
    quantity: 0,
    price_per_unit: 0,
    unit_cost: 0,
    unit_size: null,
    notes: null,
  };
}

export default function NewOrder() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const createOrderIdem = useIdempotencyKey('create_direct_order', profile?.id || '');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [orderName, setOrderName] = useState('');
  const [orderDate, setOrderDate] = useState(localToday());
  const [customerPoNumber, setCustomerPoNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LocalItem[]>([makeEmptyItem()]);

  // Draft persistence: auto-saves form to sessionStorage so data survives
  // a PWA reload when the user switches away on mobile (e.g. to the calculator).
  const draftState = { customerId, orderName, orderDate, customerPoNumber, notes, items };
  const { draft, clearDraft } = useFormDraft<typeof draftState>('new-order', draftState);

  // Restore draft on mount (runs once after loading completes)
  const [draftRestored, setDraftRestored] = useState(false);
  useEffect(() => {
    if (!loading && !draftRestored && draft) {
      setCustomerId(draft.customerId || '');
      setOrderName(draft.orderName || '');
      setOrderDate(draft.orderDate || localToday());
      setCustomerPoNumber(draft.customerPoNumber || '');
      setNotes(draft.notes || '');
      if (draft.items && draft.items.length > 0) {
        // Re-key items to avoid stale React keys
        setItems(draft.items.map((item) => ({ ...item, _key: nextKey() })));
      }
      setDraftRestored(true);
      toast('info', 'Draft restored — your previous entries have been recovered.');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const [showProductModal, setShowProductModal] = useState(false);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<string, { available: number; prebooked: number; onOrder: number }>>({});

  const fetchData = useCallback(async () => {
    const [customersRes, productsRes, inventoryRes, poRes] = await Promise.all([
      supabase.from('customers').select('*').order('farm_name'),
      supabase.from('products').select('*').order('product_name'),
      supabase.from('inventory').select('product_id, quantity_available, quantity_prebooked'),
      supabase
        .from('purchase_order_items')
        .select('product_id, quantity_ordered, quantity_received, purchase_orders!inner(status)')
        .in('purchase_orders.status', ['submitted', 'partially_received']),
    ]);

    if (customersRes.error) {
      console.error('Failed to load customers:', customersRes.error);
      toast('error', 'Failed to load customers. Please refresh.');
    }
    if (productsRes.error) {
      console.error('Failed to load products:', productsRes.error);
      toast('error', 'Failed to load products. Please refresh.');
    }

    // Build inventory lookup by product_id
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

    setCustomers(customersRes.data || []);
    setProducts(productsRes.data || []);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const addItem = () => {
    setItems([...items, makeEmptyItem()]);
  };

  const removeItem = (key: string) => {
    if (items.length === 1) {
      toast('error', 'Cannot remove last item');
      return;
    }
    setItems(items.filter((item) => item._key !== key));
  };

  const updateItem = (key: string, field: keyof LocalItem, value: string | number | null) => {
    setItems(
      items.map((item) => {
        if (item._key !== key) return item;
        return { ...item, [field]: value };
      })
    );
  };

  const openProductModal = (itemKey: string) => {
    setSelectedItemKey(itemKey);
    setShowProductModal(true);
    setProductSearch('');
  };

  const selectProduct = (product: Product) => {
    if (!selectedItemKey) return;

    // Look up customer tier for price auto-fill
    const customer = customers.find((c) => c.id === customerId);
    const tierNum = customer?.assigned_tier || 1;
    const tierPrice =
      tierNum === 1
        ? product.tier1_price || 0
        : tierNum === 2
          ? product.tier2_price || 0
          : product.tier3_price || 0;

    setItems(
      items.map((item) => {
        if (item._key !== selectedItemKey) return item;
        return {
          ...item,
          product_id: product.id,
          product_name: product.product_name,
          price_per_unit: tierPrice,
          unit_cost: product.current_cost || 0,
          unit_size: product.unit_size || null,
        };
      })
    );

    setShowProductModal(false);
    setSelectedItemKey(null);
  };

  const handleSave = async () => {
    if (!customerId) {
      toast('error', 'Please select a customer');
      return;
    }

    const validItems = items.filter((item) => item.product_id && item.quantity > 0);
    if (validItems.length === 0) {
      toast('error', 'Please add at least one item with quantity');
      return;
    }

    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    // Duplicate order warning: check for recent orders for same customer
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const { data: recentOrders } = await supabase
        .from('orders')
        .select('order_number, order_date')
        .eq('customer_id', customerId)
        .gte('order_date', sevenDaysAgo)
        .order('order_date', { ascending: false })
        .limit(1);
      if (recentOrders && recentOrders.length > 0) {
        const recent = recentOrders[0];
        const daysAgo = Math.ceil((Date.now() - new Date(recent.order_date + 'T00:00:00').getTime()) / 86400000);
        const ok = confirm(`This customer already has order ${recent.order_number} from ${daysAgo} day(s) ago. Create another?`);
        if (!ok) return;
      }
    } catch { /* ignore — don't block order creation if check fails */ }

    setSaving(true);

    try {
      const idemKey = createOrderIdem.getKey();
      const rpcItems = validItems.map((item) => ({
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
        price_per_unit: item.price_per_unit,
        unit_cost: item.unit_cost,
        unit_size: item.unit_size,
      }));

      const { data, error } = await supabase.rpc('create_direct_order', {
        p_customer_id: customerId,
        p_order_date: orderDate,
        p_order_name: orderName || null,
        p_notes: notes || null,
        p_items: rpcItems,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;

      createOrderIdem.resetKey();
      const result = data as Record<string, unknown> | null;
      const orderId = result?.order_id as string | undefined;
      if (!orderId) {
        toast('error', 'Order creation failed — no order ID returned');
        setSaving(false);
        return;
      }

      // Save customer PO# if provided
      if (customerPoNumber.trim() && orderId) {
        const poResult = await supabase.from('orders').update({ customer_po_number: customerPoNumber.trim() }).eq('id', orderId).select();
        checkMutationResult(poResult, 'Update customer PO number');
      }

      clearDraft();
      toast('success', 'Order created successfully');

      // Show inventory warnings (non-blocking)
      const warnings = result?.warnings as string[] | undefined;
      if (warnings && warnings.length > 0) {
        for (const w of warnings) {
          toast('warning', 'Inventory: ' + w);
        }
      }
      trackBusinessEvent('order_created', {
        message: `Direct order created${orderName ? ` (${orderName})` : ''}`,
        data: { orderId: orderId!, orderName: orderName || null, itemCount: items.filter((i) => i.product_id).length },
      });

      // Phase 3.3: Credit limit check — warn (not block) if exceeded
      if (customerId) {
        try {
          const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', {
            p_customer_id: customerId,
          });
          const cl = creditCheck as { exceeded?: boolean; farm_name?: string; outstanding_ar?: number; credit_limit?: number } | null;
          if (cl && cl.exceeded) {
            const fmtUsd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
            toast('warning', `Credit limit warning: ${cl.farm_name} outstanding AR ${fmtUsd(cl.outstanding_ar ?? 0)} exceeds limit ${fmtUsd(cl.credit_limit ?? 0)}`);
            notifyCreditLimitExceeded(cl.farm_name ?? 'Unknown', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, customerId);
          }
        } catch {
          // Non-blocking — credit limit check failure should not prevent navigation
        }
      }

      navigate(`/orders/${orderId}`);
    } catch (err) {
      console.error('Error creating order:', err);
      const msg = err instanceof Error ? err.message : (err as Record<string, unknown>)?.message || String(err);
      toast('error', 'Failed to create order: ' + msg);
    } finally {
      setSaving(false);
    }
  };

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.manufacturer?.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/orders')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-nav-dark">New Order</h1>
            <p className="text-sm text-secondary">Create a direct order</p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="w-4 h-4" />
          {saving ? 'Creating...' : 'Create Order'}
        </Button>
      </div>

      <Card>
        <CardHeader title="Order Information" />
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">
                Customer *
              </label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Select customer...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.farm_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">
                Order Name
              </label>
              <Input
                value={orderName}
                onChange={(e) => setOrderName(e.target.value)}
                placeholder="e.g., Corn Burndown"
              />
              <p className="text-xs text-secondary mt-1">Optional — order number is auto-generated</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">
                Order Date
              </label>
              <Input
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">
                Customer PO#
              </label>
              <Input
                value={customerPoNumber}
                onChange={(e) => setCustomerPoNumber(e.target.value)}
                placeholder="e.g., PO-12345"
              />
              <p className="text-xs text-secondary mt-1">Optional — customer&apos;s purchase order reference</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
              placeholder="Additional notes..."
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Order Items"
          action={
            <Button variant="secondary" size="sm" onClick={addItem}>
              <Plus className="w-4 h-4" />
              Add Item
            </Button>
          }
        />
        <div className="p-5 space-y-3">
          {items.map((item) => (
            <div
              key={item._key}
              className="border border-gray-200 rounded-lg p-4 space-y-3"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Product *
                      </label>
                      <button
                        type="button"
                        onClick={() => openProductModal(item._key)}
                        className="w-full px-3 py-2 text-left border border-gray-200 rounded-lg hover:border-crx-green transition-colors focus:outline-none focus:ring-2 focus:ring-crx-green/20"
                      >
                        {item.product_name || (
                          <span className="text-secondary flex items-center gap-2">
                            <Search className="w-4 h-4" />
                            Select product...
                          </span>
                        )}
                      </button>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Quantity *
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.quantity || ''}
                        onChange={(e) =>
                          updateItem(item._key, 'quantity', parseFloat(e.target.value) || 0)
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Price per Unit
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.price_per_unit || ''}
                        onChange={(e) =>
                          updateItem(
                            item._key,
                            'price_per_unit',
                            parseFloat(e.target.value) || 0
                          )
                        }
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Unit Cost
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.unit_cost || ''}
                        onChange={(e) =>
                          updateItem(item._key, 'unit_cost', parseFloat(e.target.value) || 0)
                        }
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Unit Size
                      </label>
                      <Input
                        value={item.unit_size || ''}
                        onChange={(e) => updateItem(item._key, 'unit_size', e.target.value)}
                        placeholder="e.g., 2.5 gal"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-secondary mb-1">
                      Notes
                    </label>
                    <Input
                      value={item.notes || ''}
                      onChange={(e) => updateItem(item._key, 'notes', e.target.value)}
                      placeholder="Item notes..."
                    />
                  </div>

                  {item.product_id && item.quantity > 0 && (
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <div className="flex justify-between items-center">
                        <span className="text-secondary">Total:</span>
                        <span className="font-medium">
                          {new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                          }).format(item.quantity * item.price_per_unit)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  onClick={() => removeItem(item._key)}
                  className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title="Remove item"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Modal
        open={showProductModal}
        onClose={() => setShowProductModal(false)}
        title="Select Product"
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
              const customer = customers.find((c) => c.id === customerId);
              const tierNum = customer?.assigned_tier || 1;
              const tierPrice =
                tierNum === 1
                  ? product.tier1_price || 0
                  : tierNum === 2
                    ? product.tier2_price || 0
                    : product.tier3_price || 0;
              const inv = inventoryByProduct[product.id];
              const onFloor = inv ? inv.available : 0;
              const netPos = inv ? inv.onOrder + inv.available - inv.prebooked : 0;

              return (
              <button
                key={product.id}
                onClick={() => selectProduct(product)}
                className="w-full text-left p-3 border border-gray-200 rounded-lg hover:border-crx-green hover:bg-gray-50 transition-colors"
              >
                <div className="font-medium text-nav-dark">{product.product_name}</div>
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
    </div>
  );
}
