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
import { supabase } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import { notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { trackBusinessEvent } from '../lib/metrics';
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

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LocalItem[]>([makeEmptyItem()]);

  const [showProductModal, setShowProductModal] = useState(false);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState('');

  const fetchData = useCallback(async () => {
    const [customersRes, productsRes] = await Promise.all([
      supabase.from('customers').select('*').order('farm_name'),
      supabase.from('products').select('*').order('product_name'),
    ]);

    if (customersRes.error) {
      console.error('Failed to load customers:', customersRes.error);
      toast('error', 'Failed to load customers. Please refresh.');
    }
    if (productsRes.error) {
      console.error('Failed to load products:', productsRes.error);
      toast('error', 'Failed to load products. Please refresh.');
    }

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

    setItems(
      items.map((item) => {
        if (item._key !== selectedItemKey) return item;
        return {
          ...item,
          product_id: product.id,
          product_name: product.product_name,
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

    if (!orderNumber.trim()) {
      toast('error', 'Please enter an order number');
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

    setSaving(true);

    try {
      const idemKey = generateIdempotencyKey('create_direct_order', profile.id);
      const rpcItems = validItems.map((item) => ({
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
        price_per_unit: item.price_per_unit,
        unit_cost: item.unit_cost,
        unit_size: item.unit_size,
      }));

      const { data, error } = await supabase.rpc('create_direct_order', {
        p_order_number: orderNumber,
        p_customer_id: customerId,
        p_order_date: orderDate,
        p_notes: notes || null,
        p_items: rpcItems,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;

      const orderId = (data as Record<string, unknown> | null)?.order_id as string | undefined;
      if (!orderId) {
        toast('error', 'Order creation failed — no order ID returned');
        setSaving(false);
        return;
      }
      toast('success', 'Order created successfully');
      trackBusinessEvent('order_created', {
        message: `Direct order ${orderNumber} created`,
        data: { orderId: orderId!, orderNumber, itemCount: items.filter((i) => i.product_id).length },
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
      toast('error', 'Failed to create order: ' + (err instanceof Error ? err.message : String(err)));
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
                Order Number *
              </label>
              <Input
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="e.g., ORD-2024-001"
              />
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
            {filteredProducts.map((product) => (
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
                  {product.current_cost && (
                    <span>
                      Cost:{' '}
                      {new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                      }).format(product.current_cost)}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {filteredProducts.length === 0 && (
            <div className="text-center py-8 text-secondary">No products found</div>
          )}
        </div>
      </Modal>
    </div>
  );
}
