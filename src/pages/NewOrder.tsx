import { useEffect, useState , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Plus,
  Trash2,
  Search,
  RotateCcw,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult, assertRpcResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useFormDraft } from '../hooks/useFormDraft';
import { useCreditLimitCheck } from '../hooks/useGuardrails';
import GuardrailBanner from '../components/ui/GuardrailBanner';
import { notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { trackBusinessEvent } from '../lib/metrics';
import { localToday, localDatePlusDays } from '../lib/dateUtils';
import type { Product, Customer } from '../types';

interface LocalItem {
  _key: string;
  product_id: string;
  product_name: string;
  quantity: number;
  price_per_unit: number;
  price_override: number | null;
  unit_cost: number;
  unit_size: string | null;
  notes: string | null;
  profit: number;
  net_margin: number;
  total_price: number;
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
    price_override: null,
    unit_cost: 0,
    unit_size: null,
    notes: null,
    profit: 0,
    net_margin: 0,
    total_price: 0,
  };
}

export default function NewOrder() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const createOrderIdem = useIdempotencyKey('create_direct_order', profile?.id || '');
  const { warning: creditWarning, check: checkCreditLimit, dismiss: dismissCreditWarning } = useCreditLimitCheck();

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

  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
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
      Sentry.captureException(customersRes.error, { tags: { source: 'fetch', action: 'load_customers' } });
      toast('error', 'Failed to load customers. Please refresh.');
    }
    if (productsRes.error) {
      Sentry.captureException(productsRes.error, { tags: { source: 'fetch', action: 'load_products' } });
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

  // Tier price lookup — cascades: tier3 → tier2 → tier1 fallback
  const getTierPrice = useCallback(
    (product: Product, tierNum: number): number => {
      const t1 = product.tier1_price || 0;
      if (tierNum === 1) return t1;
      if (tierNum === 2) return product.tier2_price || t1;
      return product.tier3_price || t1;
    },
    []
  );

  // Recalculate margin fields for a single item
  const recalcItem = useCallback(
    (item: LocalItem, tierNum: number): LocalItem => {
      const product = products.find((p) => p.id === item.product_id);
      if (!product) return item;

      const tierPrice = getTierPrice(product, tierNum);
      const pricePerUnit = item.price_override != null ? item.price_override : tierPrice;
      const qty = item.quantity || 0;
      const cost = product.current_cost || 0;

      const totalPrice = pricePerUnit * qty;
      const profit = (pricePerUnit - cost) * qty;
      const netMargin = totalPrice > 0 ? (profit / totalPrice) * 100 : 0;

      return {
        ...item,
        price_per_unit: pricePerUnit,
        unit_cost: cost,
        total_price: Math.round(totalPrice * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        net_margin: Math.round(netMargin * 100) / 100,
      };
    },
    [products, getTierPrice]
  );

  // Get current customer tier
  const customerTier = customers.find((c) => c.id === customerId)?.assigned_tier || 1;

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

  const updateItemFields = (key: string, updates: Partial<LocalItem>) => {
    setItems(
      items.map((item) => {
        if (item._key !== key) return item;
        const merged = { ...item, ...updates };
        return recalcItem(merged, customerTier);
      })
    );
  };

  // Legacy single-field update (for notes, unit_size, etc.)
  const updateItem = (key: string, field: keyof LocalItem, value: string | number | null) => {
    updateItemFields(key, { [field]: value });
  };

  const openProductModal = (itemKey: string) => {
    setSelectedItemKey(itemKey);
    setShowProductModal(true);
    setProductSearch('');
  };

  const selectProduct = (product: Product) => {
    if (!selectedItemKey) return;

    setItems(
      items.map((item) => {
        if (item._key !== selectedItemKey) return item;
        // Reset override when swapping product — fresh start with tier price
        const merged: LocalItem = {
          ...item,
          product_id: product.id,
          product_name: product.product_name,
          price_override: null,
          unit_cost: product.current_cost || 0,
          unit_size: product.unit_size || null,
        };
        return recalcItem(merged, customerTier);
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
      const sevenDaysAgo = localDatePlusDays(-7);
      const { data: recentOrders } = await supabase
        .from('orders')
        .select('order_number, order_date')
        .eq('customer_id', customerId)
        .is('deleted_at', null)
        .gte('order_date', sevenDaysAgo)
        .order('order_date', { ascending: false })
        .limit(1);
      if (recentOrders && recentOrders.length > 0) {
        const recent = recentOrders[0];
        const daysAgo = Math.ceil((Date.now() - new Date(recent.order_date + 'T00:00:00').getTime()) / 86400000);
        setDuplicateWarning(`This customer already has order ${recent.order_number} from ${daysAgo} day(s) ago. Create another?`);
        return;
      }
    } catch { /* ignore — don't block order creation if check fails */ }

    // Guardrail: check credit limit before creating order
    const totalCents = items.filter(i => i.product_id && i.quantity > 0)
      .reduce((sum, i) => sum + Math.round(i.total_price * 100), 0);
    const creditOk = await checkCreditLimit({ customerId, newAmountCents: totalCents });
    if (!creditOk && !creditWarning?.dismissed) return;

    await submitOrder();
  };

  const submitOrder = async () => {
    if (!profile) return;
    const validItems = items.filter((item) => item.product_id && item.quantity > 0);
    setSaving(true);

    await runCriticalAction({
      action: async () => {
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
        const result = assertRpcResult<{ order_id: string; warnings?: string[] }>(data, 'create_direct_order');
        const orderId = result.order_id;

        // Save customer PO# if provided
        if (customerPoNumber.trim() && orderId) {
          const poResult = await supabase.from('orders').update({ customer_po_number: customerPoNumber.trim() }).eq('id', orderId).select();
          checkMutationResult(poResult, 'Update customer PO number');
        }

        clearDraft();

        // Show inventory warnings (non-blocking)
        const warnings = result.warnings;
        if (warnings && warnings.length > 0) {
          for (const w of warnings) {
            toast('warning', 'Inventory: ' + w);
          }
        }
        trackBusinessEvent('order_created', {
          message: `Direct order created${orderName ? ` (${orderName})` : ''}`,
          data: { orderId, orderName: orderName || null, itemCount: items.filter((i) => i.product_id).length },
        });

        // Phase 3.3: Credit limit check — warn (not block) if exceeded
        if (customerId) {
          try {
            const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', {
              p_customer_id: customerId,
            });
            const cl = assertRpcResult<{ exceeded?: boolean; farm_name?: string; outstanding_ar?: number; credit_limit?: number } | null>(creditCheck, 'check_customer_credit_limit');
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
      },
      toast,
      successMessage: 'Order created successfully',
      setLoading: setSaving,
      sentryTag: 'create_order',
    });
  };

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.manufacturer?.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products;

  // Currency formatter
  const fmtUsd = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);

  // Order totals
  const validItems = items.filter((i) => i.product_id && i.quantity > 0);
  const orderTotal = validItems.reduce((sum, i) => sum + i.total_price, 0);
  const orderProfit = validItems.reduce((sum, i) => sum + i.profit, 0);
  const orderMargin = orderTotal > 0 ? (orderProfit / orderTotal) * 100 : 0;

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

      <GuardrailBanner warning={creditWarning} onDismiss={dismissCreditWarning} />

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
                onChange={(e) => {
                  const newId = e.target.value;
                  setCustomerId(newId);
                  // Recalc all items with new customer tier, clearing price overrides
                  const newTier = customers.find((c) => c.id === newId)?.assigned_tier || 1;
                  setItems((prev) =>
                    prev.map((item) => recalcItem({ ...item, price_override: null }, newTier))
                  );
                }}
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

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Price per Unit
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          step="any"
                          min={0}
                          value={item.price_per_unit || ''}
                          onChange={(e) => {
                            const val = e.target.value ? parseFloat(e.target.value) : 0;
                            const prod = products.find((p) => p.id === item.product_id);
                            const tierPrice = prod ? getTierPrice(prod, customerTier) : 0;
                            const isOverride = Math.abs(val - tierPrice) > 0.001;
                            updateItemFields(item._key, {
                              price_override: isOverride ? val : null,
                              price_per_unit: val,
                            });
                          }}
                          aria-label="Price per unit"
                          className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green ${
                            item.price_override != null
                              ? 'border-amber-400 bg-amber-50'
                              : 'border-gray-200'
                          }`}
                        />
                        {item.price_override != null && (
                          <button
                            onClick={() =>
                              updateItemFields(item._key, { price_override: null })
                            }
                            title={`Reset to tier ${customerTier} price: ${fmtUsd(
                              products.find((p) => p.id === item.product_id)
                                ? getTierPrice(products.find((p) => p.id === item.product_id)!, customerTier)
                                : 0
                            )}`}
                            className="p-1.5 rounded text-amber-500 hover:text-amber-700 hover:bg-amber-100 transition-colors flex-shrink-0"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}
                      </div>
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
                  </div>

                  {item.product_id && item.quantity > 0 && (
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <div className="flex flex-wrap gap-x-6 gap-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-secondary">Total:</span>
                          <span className="font-medium font-mono">
                            {fmtUsd(item.total_price)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-secondary">Profit:</span>
                          <span className={`font-medium font-mono ${item.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {fmtUsd(item.profit)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-secondary">Margin:</span>
                          <span className={`font-medium font-mono ${
                            item.net_margin >= 20 ? 'text-emerald-600' : item.net_margin >= 10 ? 'text-amber-600' : 'text-red-600'
                          }`}>
                            {item.net_margin.toFixed(1)}%
                          </span>
                        </div>
                        {item.price_override != null && (
                          <span className="text-xs text-amber-600 italic">price overridden</span>
                        )}
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

      {/* Order Totals Summary */}
      {validItems.length > 0 && (
        <Card>
          <div className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h3 className="text-sm font-medium text-secondary uppercase tracking-wider">Order Totals</h3>
              <div className="flex flex-wrap items-center gap-6 text-sm">
                <div>
                  <span className="text-secondary mr-2">Total:</span>
                  <span className="font-semibold font-mono text-nav-dark">{fmtUsd(orderTotal)}</span>
                </div>
                <div>
                  <span className="text-secondary mr-2">Profit:</span>
                  <span className={`font-semibold font-mono ${orderProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {fmtUsd(orderProfit)}
                  </span>
                </div>
                <div>
                  <span className="text-secondary mr-2">Margin:</span>
                  <span className={`font-semibold font-mono ${
                    orderMargin >= 20 ? 'text-emerald-600' : orderMargin >= 10 ? 'text-amber-600' : 'text-red-600'
                  }`}>
                    {orderMargin.toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      <ConfirmModal
        open={!!duplicateWarning}
        onClose={() => setDuplicateWarning(null)}
        onConfirm={() => {
          setDuplicateWarning(null);
          submitOrder();
        }}
        title="Duplicate Order Warning"
        message={duplicateWarning || ''}
        confirmLabel="Create Order"
        variant="warning"
      />

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
              const tierPrice = getTierPrice(product, customerTier);
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
