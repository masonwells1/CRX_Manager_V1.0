import { useEffect, useState } from 'react';
import { Plus, Trash2, Copy } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import type { BlendRecipe, Product, RecipeType } from '../types';

type RecipeRow = BlendRecipe & { item_count: number; creator_name: string };

interface RecipeDbRow {
  id: string;
  items?: Array<{ count: number }>;
  creator?: { full_name: string } | null;
  [key: string]: unknown;
}

interface RecipeItemDbRow {
  id: string;
  product_id: string;
  product_name?: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  sort_order: number;
  notes?: string | null;
  product?: { product_name: string } | null;
}

const CROP_OPTIONS = ['corn', 'soybeans', 'wheat', 'cotton', 'rice', 'other'];
const TIMING_OPTIONS = ['pre-emerge', 'post-emerge', 'early-season', 'late-season', 'burndown', 'other'];

interface EditItem {
  id?: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  sort_order: number;
  notes: string;
}

export default function BlendRecipes() {
  useAuth();
  const { toast } = useToast();
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [cropFilter, setCropFilter] = useState('');

  // Editor modal
  const [showEditor, setShowEditor] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    recipe_type: 'generic' as 'crop_specific' | 'generic',
    crop_type: '',
    timing: '',
  });
  const [editItems, setEditItems] = useState<EditItem[]>([]);

  useEffect(() => {
    fetchRecipes();
    fetchProducts();
  }, []);

  const fetchRecipes = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('blend_recipes')
      .select('*, creator:profiles!blend_recipes_created_by_fkey(full_name), items:blend_recipe_items(count)')
      .is('deleted_at', null)
      .order('name');

    if (error) {
      console.error('Failed to load recipes:', error.message);
      toast('error', 'Failed to load recipes');
      setLoading(false);
      return;
    }

    const rows: RecipeRow[] = ((data || []) as RecipeDbRow[]).map((r) => ({
      ...r,
      item_count: r.items?.[0]?.count || 0,
      creator_name: r.creator?.full_name || 'Unknown',
    })) as RecipeRow[];
    setRecipes(rows);
    setLoading(false);
  };

  const fetchProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
    setProducts(data || []);
  };

  const filtered = recipes.filter((r) => {
    if (typeFilter && r.recipe_type !== typeFilter) return false;
    if (cropFilter && r.crop_type !== cropFilter) return false;
    return true;
  });

  // Open editor for new or existing recipe
  const openEditor = async (recipe?: RecipeRow) => {
    if (recipe) {
      setEditId(recipe.id);
      setForm({
        name: recipe.name,
        description: recipe.description || '',
        recipe_type: recipe.recipe_type as RecipeType,
        crop_type: recipe.crop_type || '',
        timing: recipe.timing || '',
      });
      // Load items
      const { data } = await supabase
        .from('blend_recipe_items')
        .select('*, product:products(product_name)')
        .eq('recipe_id', recipe.id)
        .order('sort_order');
      setEditItems(
        ((data || []) as RecipeItemDbRow[]).map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_name: item.product?.product_name || item.product_name || '',
          quantity: item.quantity,
          unit: item.unit,
          rate_per_acre: item.rate_per_acre,
          sort_order: item.sort_order,
          notes: item.notes || '',
        }))
      );
    } else {
      setEditId(null);
      setForm({ name: '', description: '', recipe_type: 'generic', crop_type: '', timing: '' });
      setEditItems([]);
    }
    setShowEditor(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast('error', 'Recipe name is required');
      return;
    }
    if (editItems.length === 0) {
      toast('error', 'Add at least one product');
      return;
    }

    setSaving(true);
    try {
      let recipeId = editId;

      if (editId) {
        // Update existing
        const result = await supabase
          .from('blend_recipes')
          .update({
            name: form.name.trim(),
            description: form.description || null,
            recipe_type: form.recipe_type,
            crop_type: form.recipe_type === 'crop_specific' ? form.crop_type || null : null,
            timing: form.recipe_type === 'crop_specific' ? form.timing || null : null,
          })
          .eq('id', editId)
          .select();
        checkMutationResult(result, 'Update recipe');
      } else {
        // Insert new
        const { data, error } = await supabase
          .from('blend_recipes')
          .insert({
            name: form.name.trim(),
            description: form.description || null,
            recipe_type: form.recipe_type,
            crop_type: form.recipe_type === 'crop_specific' ? form.crop_type || null : null,
            timing: form.recipe_type === 'crop_specific' ? form.timing || null : null,
          })
          .select()
          .single();
        if (error) throw error;
        recipeId = data.id;
      }

      // Sync items: delete all existing, insert fresh
      if (editId) {
        const deleteResult = await supabase.from('blend_recipe_items').delete().eq('recipe_id', editId).select();
        checkMutationResult(deleteResult, 'Delete recipe items');
      }

      if (recipeId && editItems.length > 0) {
        const itemsPayload = editItems.map((item, idx) => ({
          recipe_id: recipeId,
          product_id: item.product_id,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit,
          rate_per_acre: item.rate_per_acre,
          sort_order: idx,
          notes: item.notes || null,
        }));
        const { error: itemsError } = await supabase.from('blend_recipe_items').insert(itemsPayload);
        if (itemsError) throw itemsError;
      }

      toast('success', editId ? 'Recipe updated' : 'Recipe created');
      setShowEditor(false);
      fetchRecipes();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to save recipe');
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async (recipe: RecipeRow) => {
    try {
      // Create copy of recipe
      const { data: newRecipe, error } = await supabase
        .from('blend_recipes')
        .insert({
          name: `${recipe.name} (Copy)`,
          description: recipe.description,
          recipe_type: recipe.recipe_type,
          crop_type: recipe.crop_type,
          timing: recipe.timing,
        })
        .select()
        .single();
      if (error) throw error;

      // Copy items
      const { data: items } = await supabase
        .from('blend_recipe_items')
        .select('*')
        .eq('recipe_id', recipe.id)
        .order('sort_order');

      if (items && items.length > 0) {
        const copies = (items as RecipeItemDbRow[]).map((item) => ({
          recipe_id: newRecipe.id,
          product_id: item.product_id,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit,
          rate_per_acre: item.rate_per_acre,
          sort_order: item.sort_order,
          notes: item.notes,
        }));
        await supabase.from('blend_recipe_items').insert(copies);
      }

      toast('success', 'Recipe duplicated');
      fetchRecipes();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to duplicate');
    }
  };

  const handleDelete = async (recipe: RecipeRow) => {
    if (!confirm(`Delete recipe "${recipe.name}"? This is a soft delete.`)) return;
    try {
      const result = await supabase
        .from('blend_recipes')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', recipe.id)
        .select();
      checkMutationResult(result, 'Delete recipe');
      toast('success', 'Recipe deleted');
      fetchRecipes();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const addItem = () => {
    setEditItems([
      ...editItems,
      { product_id: '', product_name: '', quantity: 0, unit: 'gal', rate_per_acre: null, sort_order: editItems.length, notes: '' },
    ]);
  };

  const updateItem = (idx: number, field: keyof EditItem, value: string | number | null) => {
    const updated = [...editItems];
    updated[idx] = { ...updated[idx], [field]: value };
    setEditItems(updated);
  };

  const removeItem = (idx: number) => {
    setEditItems(editItems.filter((_, i) => i !== idx));
  };

  const columns: Column<RecipeRow>[] = [
    {
      key: 'name',
      header: 'Recipe Name',
      sortable: true,
      render: (row) => (
        <div>
          <span className="font-medium text-nav-dark">{row.name}</span>
          {row.description && <p className="text-xs text-gray-500 mt-0.5">{row.description}</p>}
        </div>
      ),
    },
    {
      key: 'recipe_type',
      header: 'Type',
      sortable: true,
      render: (row) => (
        <Badge variant={row.recipe_type === 'crop_specific' ? 'info' : 'default'}>
          {row.recipe_type === 'crop_specific' ? 'Crop Specific' : 'Generic'}
        </Badge>
      ),
    },
    {
      key: 'crop_type',
      header: 'Crop',
      render: (row) => (row.crop_type ? <span className="capitalize">{row.crop_type}</span> : '-'),
    },
    {
      key: 'timing',
      header: 'Timing',
      render: (row) => (row.timing ? <span className="capitalize">{row.timing.replace('-', ' ')}</span> : '-'),
    },
    {
      key: 'item_count',
      header: 'Products',
      render: (row) => <span>{row.item_count}</span>,
    },
    {
      key: 'creator_name',
      header: 'Created By',
      render: (row) => <span className="text-sm">{row.creator_name}</span>,
    },
    {
      key: 'id',
      header: '',
      className: 'w-28',
      render: (row) => (
        <div className="flex gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); handleDuplicate(row); }}
            title="Duplicate"
            className="p-1.5 text-gray-400 hover:text-crx-green rounded"
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete(row); }}
            title="Delete"
            className="p-1.5 text-gray-400 hover:text-red-500 rounded"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">Blend Recipes</h2>
        <Button icon={<Plus className="w-4 h-4" />} onClick={() => openEditor()}>
          New Recipe
        </Button>
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<RecipeRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search recipes..."
            searchKeys={['name', 'description', 'crop_type']}
            onRowClick={(row) => openEditor(row)}
            emptyTitle="No recipes yet"
            emptyDescription="Save frequently-used blends as recipes for one-click application"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => openEditor()}>
                New Recipe
              </Button>
            }
            loading={loading}
            filters={
              <div className="flex gap-2 items-center">
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  aria-label="Filter by type"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Types</option>
                  <option value="crop_specific">Crop Specific</option>
                  <option value="generic">Generic</option>
                </select>
                <select
                  value={cropFilter}
                  onChange={(e) => setCropFilter(e.target.value)}
                  aria-label="Filter by crop"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Crops</option>
                  {CROP_OPTIONS.map((c) => (
                    <option key={c} value={c} className="capitalize">{c}</option>
                  ))}
                </select>
              </div>
            }
          />
        </div>
      </Card>

      {/* Recipe Editor Modal */}
      <Modal open={showEditor} onClose={() => setShowEditor(false)} title={editId ? 'Edit Recipe' : 'New Recipe'} size="large">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Recipe Name *</label>
            <Input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g., Corn Pre-Emerge Standard"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green text-sm"
              placeholder="Optional description..."
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Recipe Type</label>
              <select
                value={form.recipe_type}
                onChange={(e) => setForm({ ...form, recipe_type: e.target.value as RecipeType })}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="generic">Generic</option>
                <option value="crop_specific">Crop Specific</option>
              </select>
            </div>
            {form.recipe_type === 'crop_specific' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Crop Type</label>
                  <select
                    value={form.crop_type}
                    onChange={(e) => setForm({ ...form, crop_type: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Select Crop</option>
                    {CROP_OPTIONS.map((c) => (
                      <option key={c} value={c} className="capitalize">{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Timing</label>
                  <select
                    value={form.timing}
                    onChange={(e) => setForm({ ...form, timing: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Select Timing</option>
                    {TIMING_OPTIONS.map((t) => (
                      <option key={t} value={t} className="capitalize">{t.replace('-', ' ')}</option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>

          {/* Products */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Products</label>
              <Button size="sm" variant="secondary" onClick={addItem}>
                <Plus className="w-3 h-3" /> Add Product
              </Button>
            </div>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {editItems.map((item, idx) => (
                <div key={idx} className="flex gap-2 items-center p-2 bg-gray-50 rounded-lg">
                  <select
                    value={item.product_id}
                    onChange={(e) => {
                      const p = products.find((pr) => pr.id === e.target.value);
                      updateItem(idx, 'product_id', e.target.value);
                      if (p) updateItem(idx, 'product_name', p.product_name);
                    }}
                    className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  >
                    <option value="">Select Product</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.product_name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={item.quantity || ''}
                    onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)}
                    placeholder="Qty"
                    className="w-20 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  />
                  <input
                    type="text"
                    value={item.unit}
                    onChange={(e) => updateItem(idx, 'unit', e.target.value)}
                    placeholder="Unit"
                    className="w-16 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={item.rate_per_acre ?? ''}
                    onChange={(e) => updateItem(idx, 'rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)}
                    placeholder="Rate/ac"
                    className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  />
                  <button onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-600 p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {editItems.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-4">No products added yet</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="secondary" onClick={() => setShowEditor(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={saving}>
              {editId ? 'Save Changes' : 'Create Recipe'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
