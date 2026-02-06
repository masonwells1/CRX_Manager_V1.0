import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, DollarSign } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { Product, CostHistory } from '../types';

export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const isNew = id === 'new';
  const isAdmin = role === 'admin';

  const [product, setProduct] = useState<Partial<Product>>({
    product_name: '',
    sku: '',
    category: '',
    vendor: '',
    manufacturer: '',
    container_size: undefined,
    unit_size: '',
    current_cost: undefined,
    tier1_price: undefined,
    tier2_price: undefined,
    tier3_price: undefined,
    suggested_rate: '',
    rate_per_acre: undefined,
    rate_unit: '',
    notes: '',
    is_active: true,
  });
  const [costHistory, setCostHistory] = useState<CostHistory[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [costModal, setCostModal] = useState(false);
  const [newCost, setNewCost] = useState('');
  const [costNote, setCostNote] = useState('');

  useEffect(() => {
    if (!isNew && id) {
      fetchProduct();
      fetchCostHistory();
    }
  }, [id]);

  const fetchProduct = async () => {
    const { data } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
    if (data) setProduct(data);
    setLoading(false);
  };

  const fetchCostHistory = async () => {
    const { data } = await supabase
      .from('cost_history')
      .select('*')
      .eq('product_id', id)
      .order('changed_at', { ascending: false })
      .limit(20);
    setCostHistory(data || []);
  };

  const handleSave = async () => {
    if (!product.product_name) {
      toast('error', 'Product name is required');
      return;
    }
    setSaving(true);
    if (isNew) {
      const { error } = await supabase.from('products').insert([product]);
      if (error) {
        toast('error', error.message);
      } else {
        toast('success', 'Product created');
        navigate('/products');
      }
    } else {
      const { error } = await supabase
        .from('products')
        .update({ ...product, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) {
        toast('error', error.message);
      } else {
        toast('success', 'Product updated');
      }
    }
    setSaving(false);
  };

  const handleCostUpdate = async () => {
    const cost = parseFloat(newCost);
    if (isNaN(cost)) {
      toast('error', 'Enter a valid cost');
      return;
    }
    const { error } = await supabase.from('cost_history').insert([
      {
        product_id: id,
        changed_by: profile?.id,
        old_cost: product.current_cost,
        new_cost: cost,
        old_tier1_price: product.tier1_price,
        old_tier2_price: product.tier2_price,
        old_tier3_price: product.tier3_price,
        change_note: costNote,
      },
    ]);
    if (!error) {
      await supabase
        .from('products')
        .update({ current_cost: cost, cost_updated_date: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', id);
      setProduct((p) => ({ ...p, current_cost: cost }));
      fetchCostHistory();
      setCostModal(false);
      setNewCost('');
      setCostNote('');
      toast('success', 'Cost updated');
    }
  };

  const update = (field: string, value: unknown) => setProduct((p) => ({ ...p, [field]: value }));

  if (loading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 bg-gray-200 rounded w-1/3" /><div className="h-64 bg-gray-200 rounded" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/products')} className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold font-heading text-nav-dark">
          {isNew ? 'New Product' : product.product_name}
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader title="Product" accent="Information" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Product Name" value={product.product_name || ''} onChange={(e) => update('product_name', e.target.value)} disabled={!isAdmin} />
              <Input label="SKU" value={product.sku || ''} onChange={(e) => update('sku', e.target.value)} disabled={!isAdmin} />
              <Input label="Category" value={product.category || ''} onChange={(e) => update('category', e.target.value)} disabled={!isAdmin} />
              <Input label="Vendor" value={product.vendor || ''} onChange={(e) => update('vendor', e.target.value)} disabled={!isAdmin} />
              <Input label="Manufacturer" value={product.manufacturer || ''} onChange={(e) => update('manufacturer', e.target.value)} disabled={!isAdmin} />
              <Input label="Container Size" type="number" value={product.container_size ?? ''} onChange={(e) => update('container_size', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin} />
              <Input label="Unit Size" value={product.unit_size || ''} onChange={(e) => update('unit_size', e.target.value)} disabled={!isAdmin} />
              <Input label="Suggested Rate" value={product.suggested_rate || ''} onChange={(e) => update('suggested_rate', e.target.value)} disabled={!isAdmin} />
              <Input label="Rate Per Acre" type="number" value={product.rate_per_acre ?? ''} onChange={(e) => update('rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin} />
              <Input label="Rate Unit" value={product.rate_unit || ''} onChange={(e) => update('rate_unit', e.target.value)} disabled={!isAdmin} />
            </div>
            <div className="mt-4">
              <label className="block text-sm font-medium text-secondary mb-1">Notes</label>
              <textarea
                value={product.notes || ''}
                onChange={(e) => update('notes', e.target.value)}
                disabled={!isAdmin}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
              />
            </div>
          </Card>

          {isAdmin && (
            <Card>
              <CardHeader title="Pricing" accent="& Margins" />
              <div className="p-3 mb-4 bg-blue-50 border border-blue-100 rounded-lg">
                <p className="text-xs text-secondary mb-2">
                  <span className="font-medium">Auto-Calculate:</span> Set a <span className="font-semibold">Net Margin %</span> for any tier, and prices will automatically recalculate whenever cost changes.
                </p>
                <div className="text-xs text-gray-600 space-y-1">
                  <p><span className="font-medium">Net Margin</span> = Profit % of price (e.g., 20% net → $100 price on $80 cost)</p>
                  <p><span className="font-medium">Gross Margin</span> = Markup % (auto-calculated, e.g., 25%)</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Cost</h4>
                  <div className="flex items-center gap-2">
                    <Input label="Current Cost" type="number" value={product.current_cost ?? ''} onChange={(e) => update('current_cost', e.target.value ? parseFloat(e.target.value) : null)} />
                    {!isNew && (
                      <Button variant="secondary" size="sm" icon={<DollarSign className="w-3 h-3" />} showChevron={false} onClick={() => setCostModal(true)} className="mt-5">
                        Update
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 1</h4>
                  <Input label="Price" type="number" value={product.tier1_price ?? ''} onChange={(e) => update('tier1_price', e.target.value ? parseFloat(e.target.value) : null)} placeholder={product.tier1_margin != null ? 'Auto-calculated on save' : ''} />
                  <Input label="Net Margin %" type="number" value={product.tier1_margin != null ? (product.tier1_margin * 100).toFixed(1) : ''} onChange={(e) => update('tier1_margin', e.target.value ? parseFloat(e.target.value) / 100 : null)} placeholder="e.g., 20 for 20%" />
                  {product.tier1_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Gross Margin: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier1_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 2</h4>
                  <Input label="Price" type="number" value={product.tier2_price ?? ''} onChange={(e) => update('tier2_price', e.target.value ? parseFloat(e.target.value) : null)} placeholder={product.tier2_margin != null ? 'Auto-calculated on save' : ''} />
                  <Input label="Net Margin %" type="number" value={product.tier2_margin != null ? (product.tier2_margin * 100).toFixed(1) : ''} onChange={(e) => update('tier2_margin', e.target.value ? parseFloat(e.target.value) / 100 : null)} placeholder="e.g., 25 for 25%" />
                  {product.tier2_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Gross Margin: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier2_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
                <div />
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 3</h4>
                  <Input label="Price" type="number" value={product.tier3_price ?? ''} onChange={(e) => update('tier3_price', e.target.value ? parseFloat(e.target.value) : null)} placeholder={product.tier3_margin != null ? 'Auto-calculated on save' : ''} />
                  <Input label="Net Margin %" type="number" value={product.tier3_margin != null ? (product.tier3_margin * 100).toFixed(1) : ''} onChange={(e) => update('tier3_margin', e.target.value ? parseFloat(e.target.value) / 100 : null)} placeholder="e.g., 30 for 30%" />
                  {product.tier3_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Gross Margin: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier3_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )}

          {isAdmin && (
            <div className="flex justify-end">
              <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
                {isNew ? 'Create Product' : 'Save Changes'}
              </Button>
            </div>
          )}
        </div>

        {!isNew && isAdmin && (
          <div className="space-y-4">
            <Card>
              <CardHeader title="Cost" accent="History" />
              {costHistory.length === 0 ? (
                <p className="text-sm text-secondary">No cost changes recorded</p>
              ) : (
                <div className="space-y-3">
                  {costHistory.map((ch) => (
                    <div key={ch.id} className="border-b border-gray-50 pb-3 last:border-0">
                      <div className="flex justify-between text-sm">
                        <span className="text-red-500 line-through">${ch.old_cost?.toFixed(2)}</span>
                        <span className="text-crx-green font-medium">${ch.new_cost?.toFixed(2)}</span>
                      </div>
                      {ch.change_note && <p className="text-xs text-secondary mt-1">{ch.change_note}</p>}
                      <p className="text-xs text-gray-400 mt-1">{new Date(ch.changed_at).toLocaleDateString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      <Modal open={costModal} onClose={() => setCostModal(false)} title="Update" accent="Cost">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Current cost: <strong>${product.current_cost?.toFixed(2) ?? 'N/A'}</strong>
          </p>
          <Input label="New Cost" type="number" value={newCost} onChange={(e) => setNewCost(e.target.value)} placeholder="0.00" />
          <Input label="Change Note (optional)" value={costNote} onChange={(e) => setCostNote(e.target.value)} placeholder="e.g. Supplier price increase" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" showChevron={false} onClick={() => setCostModal(false)}>Cancel</Button>
            <Button onClick={handleCostUpdate}>Update Cost</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
