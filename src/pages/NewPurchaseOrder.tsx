import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import type { Product } from '../types';

interface POItemDraft {
  key: string;
  product_id: string;
  quantity_ordered: number;
  unit_cost: number;
  unit_size: string;
}

let keyCounter = 0;
function nextKey() {
  return `poi_${++keyCounter}`;
}

export default function NewPurchaseOrder() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();

  const [vendor, setVendor] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<POItemDraft[]>([
    { key: nextKey(), product_id: '', quantity_ordered: 0, unit_cost: 0, unit_size: '' },
  ]);
  const [products, setProducts] = useState<Product[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [productSearchOpen, setProductSearchOpen] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
    const prods = (data || []) as Product[];
    setProducts(prods);
    const uniqueVendors = [...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[];
    setVendors(uniqueVendors.sort());
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { key: nextKey(), product_id: '', quantity_ordered: 0, unit_cost: 0, unit_size: '' },
    ]);
  };

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  };

  const updateItem = (key: string, field: keyof POItemDraft, value: string | number) => {
    setItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, [field]: value } : i))
    );
  };

  const assignProduct = (itemKey: string, product: Product) => {
    setItems((prev) =>
      prev.map((i) =>
        i.key === itemKey
          ? {
              ...i,
              product_id: product.id,
              unit_cost: product.current_cost || 0,
              unit_size: product.unit_size || '',
            }
          : i
      )
    );
    setProductSearchOpen(null);
    setProductQuery('');
  };

  const totalCost = items.reduce(
    (sum, i) => sum + i.quantity_ordered * i.unit_cost,
    0
  );

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const handleSave = async (submitStatus: 'draft' | 'submitted') => {
    if (!vendor.trim()) {
      toast('error', 'Please enter a vendor name');
      return;
    }
    const validItems = items.filter((i) => i.product_id && i.quantity_ordered > 0);
    if (validItems.length === 0) {
      toast('error', 'Add at least one item with a product and quantity');
      return;
    }

    // Guard: Ensure profile is loaded
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    setSaving(true);

    const year = new Date().getFullYear();
    const { count } = await supabase
      .from('purchase_orders')
      .select('*', { count: 'exact', head: true })
      .like('po_number', `PO-${year}-%`);
    const poNumber = `PO-${year}-${String((count || 0) + 1).padStart(4, '0')}`;

    const { data: poData, error: poError } = await supabase
      .from('purchase_orders')
      .insert({
        po_number: poNumber,
        vendor: vendor.trim(),
        status: submitStatus,
        submitted_date: submitStatus === 'submitted' ? new Date().toISOString().split('T')[0] : null,
        expected_delivery_date: expectedDate || null,
        total_cost: totalCost,
        notes: notes || null,
        created_by: profile.id,
      })
      .select('id')
      .maybeSingle();

    if (poError || !poData) {
      toast('error', poError?.message || 'Failed to create purchase order');
      setSaving(false);
      return;
    }

    const itemInserts = validItems.map((i) => ({
      purchase_order_id: poData.id,
      product_id: i.product_id,
      quantity_ordered: i.quantity_ordered,
      unit_cost: i.unit_cost,
      unit_size: i.unit_size || null,
      quantity_received: 0,
    }));

    const { error: itemError } = await supabase
      .from('purchase_order_items')
      .insert(itemInserts);

    if (itemError) {
      toast('error', 'PO created but failed to add some items');
    } else {
      toast('success', `Purchase order ${poNumber} created`);
    }

    navigate(`/purchase-orders/${poData.id}`);
    setSaving(false);
  };

  const filteredProducts = products.filter((p) => {
    if (!productQuery.trim()) return true;
    const q = productQuery.toLowerCase();
    return (
      p.product_name.toLowerCase().includes(q) ||
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.vendor && p.vendor.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/purchase-orders')}
        className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Purchase Orders
      </button>

      <Card>
        <CardHeader title="New Purchase" accent="Order" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Vendor</label>
            <div className="relative">
              <input
                type="text"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                list="vendor-list"
                placeholder="Enter or select vendor..."
                className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <datalist id="vendor-list">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </div>
          </div>
          <Input
            label="Expected Delivery Date"
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </div>
        <div className="mt-4">
          <Input
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes about this PO..."
          />
        </div>
      </Card>

      <Card padding={false}>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <CardHeader title="Line" accent="Items" />
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="w-3 h-3" />}
              showChevron={false}
              onClick={addItem}
            >
              Add Item
            </Button>
          </div>

          {items.length === 0 ? (
            <p className="text-sm text-secondary text-center py-6">
              No items added.{' '}
              <button onClick={addItem} className="text-crx-green hover:underline font-medium">
                Add one
              </button>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-secondary uppercase tracking-wide">
                    <th className="px-4 py-3 font-medium min-w-[220px]">Product</th>
                    <th className="px-4 py-3 font-medium w-28">Qty</th>
                    <th className="px-4 py-3 font-medium w-32">Unit Cost</th>
                    <th className="px-4 py-3 font-medium w-24">Unit Size</th>
                    <th className="px-4 py-3 font-medium w-32">Line Total</th>
                    <th className="px-4 py-3 font-medium w-10" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const prod = products.find((p) => p.id === item.product_id);
                    return (
                      <tr key={item.key} className="border-b border-gray-50 hover:bg-crx-green-tint transition-colors">
                        <td className="px-4 py-3">
                          {prod ? (
                            <button
                              onClick={() => {
                                setProductSearchOpen(item.key);
                                setProductQuery('');
                              }}
                              className="text-left"
                            >
                              <p className="font-medium text-nav-dark">{prod.product_name}</p>
                              {prod.sku && <p className="text-xs text-gray-400">{prod.sku}</p>}
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setProductSearchOpen(item.key);
                                setProductQuery('');
                              }}
                              className="text-crx-green hover:underline font-medium text-sm"
                            >
                              Select Product
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={item.quantity_ordered || ''}
                            onChange={(e) =>
                              updateItem(item.key, 'quantity_ordered', parseInt(e.target.value) || 0)
                            }
                            min="0"
                            className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={item.unit_cost || ''}
                            onChange={(e) =>
                              updateItem(item.key, 'unit_cost', parseFloat(e.target.value) || 0)
                            }
                            min="0"
                            step="0.01"
                            className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="text"
                            value={item.unit_size}
                            onChange={(e) => updateItem(item.key, 'unit_size', e.target.value)}
                            className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                            placeholder="Gal"
                          />
                        </td>
                        <td className="px-4 py-3 font-mono text-nav-dark">
                          {fmt(item.quantity_ordered * item.unit_cost)}
                        </td>
                        <td className="px-4 py-3">
                          {items.length > 1 && (
                            <button
                              onClick={() => removeItem(item.key)}
                              className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-200">
                    <td colSpan={4} className="px-4 py-3 text-right font-medium text-secondary">
                      Total
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold text-nav-dark">
                      {fmt(totalCost)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={() => navigate('/purchase-orders')}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          icon={<Save className="w-4 h-4" />}
          showChevron={false}
          onClick={() => handleSave('draft')}
          disabled={saving}
        >
          Save as Draft
        </Button>
        <Button
          onClick={() => handleSave('submitted')}
          disabled={saving}
        >
          {saving ? 'Creating...' : 'Submit PO'}
        </Button>
      </div>

      {productSearchOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="p-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold font-heading text-nav-dark">
                Select <span className="split-heading-accent">Product</span>
              </h3>
            </div>
            <div className="p-5">
              <input
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green mb-3"
                placeholder="Search by name, SKU, or vendor..."
                autoFocus
              />
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
                {filteredProducts.length === 0 ? (
                  <p className="text-sm text-secondary py-4 text-center">No products found</p>
                ) : (
                  filteredProducts.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => assignProduct(productSearchOpen, p)}
                      className="w-full text-left px-3 py-2.5 hover:bg-crx-green-tint transition-colors flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium text-nav-dark text-sm">{p.product_name}</p>
                        <p className="text-xs text-gray-400">
                          {[p.sku, p.vendor].filter(Boolean).join(' / ')}
                        </p>
                      </div>
                      <span className="font-mono text-sm text-secondary">
                        {fmt(p.current_cost || 0)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="p-5 border-t border-gray-100 flex justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  setProductSearchOpen(null);
                  setProductQuery('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
