import { useState, useEffect } from 'react';
import { Plus, Trash2, Save, AlertCircle, Beaker } from 'lucide-react';
import Button from '../ui/Button';
import Card from '../ui/Card';
import Input from '../ui/Input';
import { supabase } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { logActivity } from '../../lib/activityLogger';
import { validateBlendMath } from '../../lib/blendMathValidator';
import { localToday } from '../../lib/dateUtils';
import type { Customer, Product, BlendRecipe, BlendRecipeItem } from '../../types';

interface ManualTicketCreateProps {
  customers: Customer[];
  onComplete: () => void;
}

interface ManualProduct {
  tempId: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  rate_per_acre_unit: string;
  lot_number: string;
}

export function ManualTicketCreate({ customers, onComplete }: ManualTicketCreateProps) {
  const { profile } = useAuth();

  const [formData, setFormData] = useState({
    customer_id: '',
    ticket_date: localToday(),
    ticket_time: '',
    job_number: '',
    invoice_number: '',
    driver_name: '',
    applicator_name: '',
    mixer_name: '',
    tank_number: '',
    vehicle_info: '',
    field_names: '',
    total_acres: '',
    application_rate: '',
    total_volume: '',
    total_volume_unit: '',
    notes: '',
  });

  const [products, setProducts] = useState<ManualProduct[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [recipes, setRecipes] = useState<(BlendRecipe & { items: BlendRecipeItem[] })[]>([]);
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const loadData = async () => {
      const { data: prodData, error: prodError } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('product_name');
      if (prodError) console.error('Failed to load products:', prodError.message);
      if (prodData) setAllProducts(prodData);

      // Fetch active blend recipes with their items
      const { data: recipeData, error: recipeError } = await supabase
        .from('blend_recipes')
        .select('*, items:blend_recipe_items(*)')
        .eq('is_active', true)
        .is('deleted_at', null)
        .order('name');
      if (recipeError) console.error('Failed to load recipes:', recipeError.message);
      if (recipeData) setRecipes(recipeData as unknown as (BlendRecipe & { items: BlendRecipeItem[] })[]);
    };
    loadData();
  }, []);

  function applyRecipe(recipeId: string) {
    setSelectedRecipeId(recipeId);
    if (!recipeId) return;

    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe || !recipe.items) return;

    const recipeProducts: ManualProduct[] = recipe.items
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        tempId: crypto.randomUUID(),
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        rate_per_acre: item.rate_per_acre,
        rate_per_acre_unit: '',
        lot_number: '',
      }));

    setProducts(recipeProducts);
  }

  useEffect(() => {
    const ticketData = {
      total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
      total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
      total_volume_unit: formData.total_volume_unit || null,
    };
    const productData = products.map(p => ({
      product_name: p.product_name,
      quantity: p.quantity,
      unit: p.unit || null,
      rate_per_acre: p.rate_per_acre,
      rate_per_acre_unit: p.rate_per_acre_unit || null,
    }));
    setWarnings(validateBlendMath(ticketData, productData));
  }, [products, formData.total_acres, formData.total_volume, formData.total_volume_unit]);

  function addProduct() {
    setProducts([
      ...products,
      {
        tempId: crypto.randomUUID(),
        product_id: null,
        product_name: '',
        quantity: 0,
        unit: '',
        rate_per_acre: null,
        rate_per_acre_unit: '',
        lot_number: '',
      },
    ]);
  }

  function updateProduct(tempId: string, field: keyof ManualProduct, value: string | number | null) {
    setProducts(products.map(p => (p.tempId === tempId ? { ...p, [field]: value } : p)));
  }

  function removeProduct(tempId: string) {
    setProducts(products.filter(p => p.tempId !== tempId));
  }

  async function handleSave() {
    if (!profile) return;
    setError(null);
    setSaving(true);

    try {
      // Generate ticket number
      const { data: ticketNumberData, error: ticketNumErr } = await supabase.rpc('generate_ticket_number');
      if (ticketNumErr) throw ticketNumErr;
      const ticketNumber = ticketNumberData as string;

      // Insert blend ticket
      const { data: ticket, error: ticketErr } = await supabase
        .from('blend_tickets')
        .insert({
          ticket_number: ticketNumber,
          uploaded_by: profile.id,
          upload_date: new Date().toISOString(),
          status: 'completed',
          review_status: 'unreviewed',
          ocr_confidence_score: 100,
          signature_detected: false,
          customer_id: formData.customer_id || null,
          ticket_date: formData.ticket_date || null,
          ticket_time: formData.ticket_time || null,
          job_number: formData.job_number || null,
          invoice_number: formData.invoice_number || null,
          driver_name: formData.driver_name || null,
          applicator_name: formData.applicator_name || null,
          mixer_name: formData.mixer_name || null,
          tank_number: formData.tank_number || null,
          vehicle_info: formData.vehicle_info || null,
          field_names: formData.field_names || null,
          total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
          application_rate: formData.application_rate || null,
          total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
          total_volume_unit: formData.total_volume_unit || null,
          notes: formData.notes || null,
        })
        .select()
        .single();

      if (ticketErr) throw ticketErr;
      if (!ticket) throw new Error('Failed to create ticket');

      // Insert products
      if (products.length > 0) {
        const productInserts = products.map((p, i) => ({
          blend_ticket_id: ticket.id,
          product_id: p.product_id || null,
          product_name: p.product_name,
          quantity: p.quantity,
          unit: p.unit || null,
          rate_per_acre: p.rate_per_acre || null,
          rate_per_acre_unit: p.rate_per_acre_unit || null,
          lot_number: p.lot_number || null,
          sequence_order: i + 1,
          confidence_score: 100,
          manually_corrected: false,
        }));

        const { error: prodErr } = await supabase
          .from('blend_ticket_products')
          .insert(productInserts);

        if (prodErr) throw prodErr;
      }

      // Log activity
      await logActivity(
        'blend_ticket_created',
        `Blend ticket ${ticketNumber} created manually`,
        profile.id,
        'blend_ticket',
        ticket.id,
        formData.customer_id || undefined
      );

      onComplete();
    } catch (err: unknown) {
      console.error('Error creating manual ticket:', err);
      setError(err instanceof Error ? err.message : 'Failed to create ticket');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">Create Manual Blend Ticket</h2>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
            <select
              value={formData.customer_id}
              onChange={(e) => setFormData({ ...formData, customer_id: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Select Customer</option>
              {customers.map(customer => (
                <option key={customer.id} value={customer.id}>
                  {customer.farm_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ticket Date</label>
            <Input
              type="date"
              value={formData.ticket_date}
              onChange={(e) => setFormData({ ...formData, ticket_date: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ticket Time</label>
            <Input
              type="text"
              value={formData.ticket_time}
              onChange={(e) => setFormData({ ...formData, ticket_time: e.target.value })}
              placeholder="e.g. 2:30 PM"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Job #</label>
            <Input
              type="text"
              value={formData.job_number}
              onChange={(e) => setFormData({ ...formData, job_number: e.target.value })}
              placeholder="Job / work order number"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Invoice #</label>
            <Input
              type="text"
              value={formData.invoice_number}
              onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
              placeholder="Invoice reference"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Driver Name</label>
            <Input
              type="text"
              value={formData.driver_name}
              onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
              placeholder="Enter driver name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Applicator Name</label>
            <Input
              type="text"
              value={formData.applicator_name}
              onChange={(e) => setFormData({ ...formData, applicator_name: e.target.value })}
              placeholder="Enter applicator name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mixer Name</label>
            <Input
              type="text"
              value={formData.mixer_name}
              onChange={(e) => setFormData({ ...formData, mixer_name: e.target.value })}
              placeholder="Person who mixed the blend"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tank #</label>
            <Input
              type="text"
              value={formData.tank_number}
              onChange={(e) => setFormData({ ...formData, tank_number: e.target.value })}
              placeholder="Enter tank number"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle</label>
            <Input
              type="text"
              value={formData.vehicle_info}
              onChange={(e) => setFormData({ ...formData, vehicle_info: e.target.value })}
              placeholder="Vehicle / rig description"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Field Names / Locations</label>
            <Input
              type="text"
              value={formData.field_names}
              onChange={(e) => setFormData({ ...formData, field_names: e.target.value })}
              placeholder="Comma-separated field names"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Total Acres</label>
            <Input
              type="number"
              step="0.01"
              value={formData.total_acres}
              onChange={(e) => setFormData({ ...formData, total_acres: e.target.value })}
              placeholder="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Application Rate</label>
            <Input
              type="text"
              value={formData.application_rate}
              onChange={(e) => setFormData({ ...formData, application_rate: e.target.value })}
              placeholder="e.g. 10 gal/acre"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Total Volume</label>
            <div className="flex gap-2">
              <Input
                type="number"
                step="0.01"
                value={formData.total_volume}
                onChange={(e) => setFormData({ ...formData, total_volume: e.target.value })}
                placeholder="0"
              />
              <Input
                type="text"
                value={formData.total_volume_unit}
                onChange={(e) => setFormData({ ...formData, total_volume_unit: e.target.value })}
                placeholder="gal"
                className="w-24"
              />
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Add notes..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
      </Card>

      {/* Recipe Quick-Fill */}
      {recipes.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-3">
            <Beaker className="h-5 w-5 text-crx-green" />
            <h2 className="text-lg font-semibold">Apply Saved Recipe</h2>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            Select a saved blend recipe to pre-fill the products list below.
          </p>
          <select
            value={selectedRecipeId}
            onChange={(e) => applyRecipe(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">-- Choose a recipe --</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.crop_type ? ` (${r.crop_type})` : ''}
                {r.timing ? ` - ${r.timing}` : ''}
                {` — ${r.items?.length || 0} products`}
              </option>
            ))}
          </select>
        </Card>
      )}

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Products</h2>
          <Button size="sm" onClick={addProduct}>
            <Plus className="h-4 w-4" />
            Add Product
          </Button>
        </div>

        <div className="space-y-4">
          {products.map((product) => (
            <div key={product.tempId} className="grid grid-cols-12 gap-3 items-start p-4 bg-gray-50 rounded-lg">
              <div className="col-span-12 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">Product</label>
                <select
                  value={product.product_id || ''}
                  onChange={(e) => {
                    updateProduct(product.tempId, 'product_id', e.target.value || null);
                    const selected = allProducts.find(p => p.id === e.target.value);
                    if (selected) {
                      updateProduct(product.tempId, 'product_name', selected.product_name);
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Product</option>
                  {allProducts.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.product_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">Qty</label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.quantity || ''}
                  onChange={(e) => updateProduct(product.tempId, 'quantity', parseFloat(e.target.value) || 0)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">Unit</label>
                <Input
                  type="text"
                  value={product.unit}
                  onChange={(e) => updateProduct(product.tempId, 'unit', e.target.value)}
                  placeholder="gal"
                />
              </div>

              <div className="col-span-4 md:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Rate/Acre</label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.rate_per_acre ?? ''}
                  onChange={(e) => updateProduct(product.tempId, 'rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">Rate Unit</label>
                <Input
                  type="text"
                  value={product.rate_per_acre_unit}
                  onChange={(e) => updateProduct(product.tempId, 'rate_per_acre_unit', e.target.value)}
                  placeholder="oz/ac"
                />
              </div>

              <div className="col-span-6 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">Lot Number</label>
                <Input
                  type="text"
                  value={product.lot_number}
                  onChange={(e) => updateProduct(product.tempId, 'lot_number', e.target.value)}
                  placeholder="Lot #"
                />
              </div>

              <div className="col-span-2 md:col-span-1 flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProduct(product.tempId)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}

          {products.length === 0 && (
            <p className="text-center text-gray-500 py-8">
              No products added yet. Click "Add Product" to get started.
            </p>
          )}
        </div>
      </Card>

      {warnings.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-1">
          <div className="flex items-center gap-2 text-yellow-800 font-medium text-sm">
            <AlertCircle className="h-4 w-4" />
            Math Validation Warnings
          </div>
          {warnings.map((w, i) => (
            <p key={i} className="text-sm text-yellow-700 ml-6">- {w}</p>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onComplete}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Create Ticket'}
        </Button>
      </div>
    </div>
  );
}
