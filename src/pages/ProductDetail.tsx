import { useEffect, useRef, useState , useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, DollarSign } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Combobox from '../components/ui/Combobox';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { supabase, checkMutationResult } from '../lib/db';
import type { Product, CostHistory, UnitConversion } from '../types';

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
    epa_registration: '',
    is_rup: false,
    signal_word: null,
    product_form: null,
    inventory_unit: null,
    container_unit: null,
    container_type: null,
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
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [vendorOptions, setVendorOptions] = useState<string[]>([]);
  const [manufacturerOptions, setManufacturerOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [costModal, setCostModal] = useState(false);
  const [newCost, setNewCost] = useState('');
  const [costNote, setCostNote] = useState('');

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [product]);

  const fetchProduct = useCallback(async () => {
    const { data } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
    if (data) setProduct(data);
    setLoading(false);
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [id]);

  const fetchCostHistory = useCallback(async () => {
    const { data } = await supabase
      .from('cost_history')
      .select('*')
      .eq('product_id', id)
      .order('changed_at', { ascending: false })
      .limit(20);
    setCostHistory(data || []);
  }, [id]);

  useEffect(() => {
    if (!isNew && id) {
      fetchProduct();
      fetchCostHistory();
    } else {
      setTimeout(() => { initialLoadDone.current = true; }, 0);
    }
  }, [id, isNew, fetchProduct, fetchCostHistory]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data }) => {
      setUnitConversions((data || []) as UnitConversion[]);
    });
    // Fetch distinct values for combobox dropdowns
    supabase.from('products').select('category, vendor, manufacturer').then(({ data }) => {
      if (!data) return;
      const cats = [...new Set(data.map((p) => p.category).filter(Boolean) as string[])].sort();
      const vends = [...new Set(data.map((p) => p.vendor).filter(Boolean) as string[])].sort();
      const mfrs = [...new Set(data.map((p) => p.manufacturer).filter(Boolean) as string[])].sort();
      setCategoryOptions(cats);
      setVendorOptions(vends);
      setManufacturerOptions(mfrs);
    });
  }, []);

  const handleSave = async () => {
    if (!product.product_name) {
      toast('error', 'Product name is required');
      return;
    }

    // Cost must be non-negative
    if (product.current_cost != null && product.current_cost < 0) {
      toast('error', 'Cost cannot be negative');
      return;
    }

    // Tier prices must be non-negative
    if (product.tier1_price != null && product.tier1_price < 0) {
      toast('error', 'Tier 1 price cannot be negative');
      return;
    }
    if (product.tier2_price != null && product.tier2_price < 0) {
      toast('error', 'Tier 2 price cannot be negative');
      return;
    }
    if (product.tier3_price != null && product.tier3_price < 0) {
      toast('error', 'Tier 3 price cannot be negative');
      return;
    }

    // Container size must be positive if set
    if (product.container_size != null && product.container_size <= 0) {
      toast('error', 'Container size must be greater than 0');
      return;
    }

    // Warn (but allow) if price < cost (negative margin)
    const cost = product.current_cost ?? 0;
    const prices = [product.tier1_price, product.tier2_price, product.tier3_price].filter((p): p is number => p != null && p > 0);
    if (cost > 0 && prices.some((p) => p < cost)) {
      toast('warning', 'Warning: One or more tier prices are below cost (negative margin)');
    }

    setSaving(true);
    if (isNew) {
      const { error } = await supabase.from('products').insert([product]);
      if (error) {
        toast('error', error.message);
      } else {
        setIsDirty(false);
        toast('success', 'Product created');
        logActivity('product_created', `Product ${product.product_name} created`, profile!.id, 'product');
        navigate('/products');
      }
    } else {
      // === GAP FIX #16: Detect pricing changes and log to cost_history ===
      const { data: current } = await supabase
        .from('products')
        .select('current_cost, tier1_price, tier2_price, tier3_price')
        .eq('id', id)
        .maybeSingle();

      const pricingChanged = current && (
        Number(current.current_cost) !== Number(product.current_cost) ||
        Number(current.tier1_price) !== Number(product.tier1_price) ||
        Number(current.tier2_price) !== Number(product.tier2_price) ||
        Number(current.tier3_price) !== Number(product.tier3_price)
      );

      if (pricingChanged && profile) {
        await supabase.from('cost_history').insert({
          product_id: id,
          changed_by: profile.id,
          old_cost: current.current_cost,
          new_cost: product.current_cost,
          old_tier1_price: current.tier1_price,
          new_tier1_price: product.tier1_price,
          old_tier2_price: current.tier2_price,
          new_tier2_price: product.tier2_price,
          old_tier3_price: current.tier3_price,
          new_tier3_price: product.tier3_price,
          change_note: 'Updated via product detail save',
        });
      }

      try {
        const result = await supabase
          .from('products')
          .update({ ...product, updated_at: new Date().toISOString() })
          .eq('id', id)
          .select();
        checkMutationResult(result, 'Update product');
        setIsDirty(false);
        toast('success', 'Product updated');
        logActivity('product_updated', `Product ${product.product_name} updated`, profile!.id, 'product', id);
        if (pricingChanged) fetchCostHistory();
      } catch (err: unknown) {
        toast('error', err instanceof Error ? err.message : 'Failed to update product');
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
      try {
        const result = await supabase
          .from('products')
          .update({ current_cost: cost, cost_updated_date: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', id)
          .select();
        checkMutationResult(result, 'Update product cost');
        setProduct((p) => ({ ...p, current_cost: cost }));
        fetchCostHistory();
        setCostModal(false);
        setNewCost('');
        setCostNote('');
        toast('success', 'Cost updated');
        logActivity('product_cost_updated', `Product cost updated to $${cost}`, profile!.id, 'product', id);
      } catch (err: unknown) {
        toast('error', err instanceof Error ? err.message : 'Failed to update product cost');
      }
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

            {/* Basic Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Product Name" required value={product.product_name || ''} onChange={(e) => update('product_name', e.target.value)} disabled={!isAdmin} />
              <Input label="SKU" value={product.sku || ''} onChange={(e) => update('sku', e.target.value)} disabled={!isAdmin} />
              <Combobox label="Category" value={product.category || ''} onChange={(v) => update('category', v)} options={categoryOptions} disabled={!isAdmin} placeholder="Type or select..." />
              <Combobox label="Vendor" value={product.vendor || ''} onChange={(v) => update('vendor', v)} options={vendorOptions} disabled={!isAdmin} placeholder="Type or select..." />
              <Combobox label="Manufacturer" value={product.manufacturer || ''} onChange={(v) => update('manufacturer', v)} options={manufacturerOptions} disabled={!isAdmin} placeholder="Type or select..." />
              <Input label="EPA Registration" value={product.epa_registration || ''} onChange={(e) => update('epa_registration', e.target.value)} disabled={!isAdmin} placeholder="e.g., 34704-69" />
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={product.is_rup || false}
                    onChange={(e) => update('is_rup', e.target.checked)}
                    disabled={!isAdmin}
                    className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                  />
                  <span className="text-sm font-medium text-nav-dark">Restricted Use (RUP)</span>
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Signal Word</label>
                <select
                  value={product.signal_word || ''}
                  onChange={(e) => update('signal_word', e.target.value || null)}
                  disabled={!isAdmin}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">None</option>
                  <option value="Danger">Danger</option>
                  <option value="Warning">Warning</option>
                  <option value="Caution">Caution</option>
                </select>
              </div>
            </div>

            {/* Product Form */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Product Form</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Determines which units are available below</p>
              <div className="max-w-xs">
                <select
                  value={product.product_form || ''}
                  onChange={(e) => {
                    const form = e.target.value || null;
                    update('product_form', form);
                    if (form !== product.product_form) {
                      setProduct((p) => ({ ...p, product_form: form as Product['product_form'], inventory_unit: null, container_unit: null }));
                    }
                  }}
                  disabled={!isAdmin}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">-- Select --</option>
                  <option value="liquid">Liquid</option>
                  <option value="dry">Dry</option>
                </select>
              </div>
            </div>

            {/* Container — grouped as one row */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Container</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Size, unit, and type (e.g. 2.5 Gal Jug)</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Size" type="number" value={product.container_size ?? ''} onChange={(e) => update('container_size', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin} placeholder="e.g. 2.5" />
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">Unit</label>
                  <select
                    value={product.container_unit || ''}
                    onChange={(e) => update('container_unit', e.target.value || null)}
                    disabled={!isAdmin}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    {unitConversions
                      .filter((uc) => {
                        const form = product.product_form;
                        if (!form) return true;
                        return uc.unit_type === form || uc.unit_type === 'both';
                      })
                      .map((uc) => (
                        <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">Type</label>
                  <select
                    value={product.container_type || ''}
                    onChange={(e) => update('container_type', e.target.value || null)}
                    disabled={!isAdmin}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    <option value="Jug">Jug</option>
                    <option value="Drum">Drum</option>
                    <option value="Pallet">Pallet</option>
                    <option value="Mini-Bulk">Mini-Bulk</option>
                    <option value="Shuttle">Shuttle</option>
                    <option value="Bag">Bag</option>
                    <option value="Tote">Tote</option>
                    <option value="Jar">Jar</option>
                    <option value="Ea">Ea</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Inventory Unit */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Inventory Unit</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Unit used for tracking inventory quantities (e.g. Gal, Lb)</p>
              <div className="max-w-xs">
                <select
                  value={product.inventory_unit || ''}
                  onChange={(e) => update('inventory_unit', e.target.value || null)}
                  disabled={!isAdmin}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">-- Select --</option>
                  {unitConversions
                    .filter((uc) => {
                      const form = product.product_form;
                      if (!form) return true;
                      return uc.unit_type === form || uc.unit_type === 'both';
                    })
                    .map((uc) => (
                      <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                    ))}
                </select>
              </div>
            </div>

            {/* Application Rates */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Application Rates</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Per-acre application information</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Suggested Rate" value={product.suggested_rate || ''} onChange={(e) => update('suggested_rate', e.target.value)} disabled={!isAdmin} />
                <Input label="Rate Per Acre" type="number" value={product.rate_per_acre ?? ''} onChange={(e) => update('rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin} />
                <Input label="Rate Unit" value={product.rate_unit || ''} onChange={(e) => update('rate_unit', e.target.value)} disabled={!isAdmin} />
              </div>
            </div>

            {/* Notes */}
            <div className="border-t border-gray-100 pt-4 mt-4">
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
                  <span className="font-medium">All prices are per inventory unit</span> (e.g., per gallon, per pound). Set a <span className="font-semibold">Net Margin %</span> for any tier, and prices will automatically recalculate whenever cost changes.
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

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
