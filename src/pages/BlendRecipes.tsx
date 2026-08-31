import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Trash2, Copy } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import DataTable, { type Column } from '../components/ui/DataTable';
import PageHeader from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult, assertRpcResult } from '../lib/db';
import { parseDollarsToCents } from '../lib/parseCents';
import { runCriticalAction } from '../lib/criticalAction';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { Sentry } from '../lib/sentry';
import UnitSelect from '../components/blendtickets/UnitSelect';
import { blockedUnitSaveMessage, isKnownUnit, type UnitLoadState } from '../lib/units';
import type { BlendRecipe, Product, RecipeType, UnitConversion } from '../types';

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
  price_per_unit_cents?: number | null;
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
  /** Optional per-unit price typed as a raw dollar string (decimal-friendly so
   *  "1.2" doesn't collapse to "12"); converted to bigint cents in the save payload. */
  price_input: string;
  sort_order: number;
  notes: string;
}

export default function BlendRecipes() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const saveRecipeIdem = useIdempotencyKey('save_blend_recipe', profile?.id || '');
  const duplicateRecipeIdem = useIdempotencyKey('save_blend_recipe', profile?.id || '');
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  // Item units are a PICKER, not free text, so a recipe can no longer carry a unit the
  // pricing/conversion path cannot resolve. unitLoad is tracked separately from the array
  // because an empty array means three different things (in flight / fetch failed / table
  // really is empty) and only this caller knows which — see blockedUnitSaveMessage.
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [unitLoad, setUnitLoad] = useState<UnitLoadState>('pending');
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
  const [deleteTarget, setDeleteTarget] = useState<RecipeRow | null>(null);
  const [duplicateBusy, setDuplicateBusy] = useState<Record<string, boolean>>({});
  const duplicateInFlightRef = useRef(new Set<string>());

  const fetchRecipes = useCallback(async () => {
    setLoading(true);
    // PR-07 follow-up: dropped creator FK embed; resolved via profile_public_view.
    const { data, error } = await supabase
      .from('blend_recipes')
      .select('*, items:blend_recipe_items(count)')
      .is('deleted_at', null)
      .order('name');

    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to load recipes');
      setLoading(false);
      return;
    }

    const creatorIds = [...new Set(
      ((data || []) as Array<{ created_by?: string | null }>)
        .map((r) => r.created_by)
        .filter(Boolean) as string[]
    )];
    const creatorMap: Record<string, string> = {};
    if (creatorIds.length > 0) {
      const { data: creators } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', creatorIds);
      ((creators || []) as { id: string; full_name: string }[]).forEach((c: { id: string; full_name: string }) => { creatorMap[c.id] = c.full_name; });
    }

    const rows: RecipeRow[] = ((data || []) as Array<RecipeDbRow & { created_by?: string | null }>).map((r) => ({
      ...r,
      item_count: r.items?.[0]?.count || 0,
      creator_name: r.created_by ? creatorMap[r.created_by] || 'Unknown' : 'Unknown',
    })) as RecipeRow[];
    setRecipes(rows);
    setLoading(false);
  }, [toast]);

  const fetchProducts = useCallback(async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
    if (error) {
      toast('error', 'Failed to load products: ' + error.message);
      return;
    }
    setProducts((data || []) as Product[]);
  }, [toast]);

  const fetchUnitConversions = useCallback(async () => {
    const { data, error } = await supabase
      .from('unit_conversions')
      .select('*')
      .order('unit');
    if (error) {
      // The unit field is a picker, not free text, so a failed load leaves the operator no
      // way to enter a unit at all. Say so rather than failing quietly.
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_unit_conversions' } });
      toast('error', 'Failed to load units: ' + error.message);
      setUnitLoad('failed');
      return;
    }
    setUnitConversions((data || []) as UnitConversion[]);
    setUnitLoad('loaded');
  }, [toast]);

  useEffect(() => {
    fetchRecipes();
    fetchProducts();
    fetchUnitConversions();
  }, [fetchRecipes, fetchProducts, fetchUnitConversions]);

  const filtered = recipes.filter((r) => {
    if (typeFilter && r.recipe_type !== typeFilter) return false;
    if (cropFilter && r.crop_type !== cropFilter) return false;
    return true;
  });

  // Open editor for new or existing recipe
  const openEditor = async (recipe?: RecipeRow) => {
    // Codex P2 fix (PR #59, 2026-05-16): reset saveRecipeIdem on every editor
    // open. The page-scoped key was shared across all recipes; if save A
    // succeeded but the response was lost, opening the editor for recipe B
    // and submitting would replay A's cached success without mutating B.
    saveRecipeIdem.resetKey();
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
      const { data, error: itemsErr } = await supabase
        .from('blend_recipe_items')
        .select('*, product:products(product_name)')
        .eq('recipe_id', recipe.id)
        .order('sort_order');
      if (itemsErr) {
        toast('error', 'Failed to load recipe items: ' + itemsErr.message);
        return;
      }
      setEditItems(
        ((data || []) as RecipeItemDbRow[]).map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_name: item.product?.product_name || item.product_name || '',
          quantity: item.quantity,
          unit: item.unit,
          rate_per_acre: item.rate_per_acre,
          price_input: item.price_per_unit_cents ? (item.price_per_unit_cents / 100).toString() : '',
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
    // The unit field is a picker now: when the list never arrived the operator had no way to
    // choose a unit, so a blank one is the failed request's doing and not a choice they made.
    // Say that plainly instead of telling them to fill in a field they cannot fill in. The
    // healthy-list case is handled by the stricter check below.
    const unitBlock = blockedUnitSaveMessage(
      unitLoad,
      unitConversions,
      editItems.some((item) => !item.unit.trim()),
    );
    if (unitBlock) {
      toast('error', unitBlock);
      return;
    }
    // With a healthy list the picker can always offer a usable unit, so a unit that is blank or
    // that this product's form cannot use is a real error rather than an outage. Checked AFTER
    // blockedUnitSaveMessage so a genuine outage still gets the outage message and is never
    // blamed on the operator. Deliberately not applied while unitLoad is anything but 'loaded':
    // during an outage isKnownUnit is false for everything, and this would reject every item.
    //
    // A blank unit is rejected here even though free text allowed it. A recipe bills off
    // rate_per_acre and a blank unit still bills, so "saved but unpriceable" is the outcome this
    // screen exists to prevent, and the picker makes a blank the easy accident now that there is
    // no seeded default.
    if (unitLoad === 'loaded' && unitConversions.length > 0) {
      // "Product not in the list" is NOT the same as "product whose form is null", even though
      // `?.product_form ?? null` renders them identically — and a null form means isKnownUnit
      // accepts every unit. So an item whose product has not loaded yet (open an existing
      // recipe before fetchProducts returns) would sail through the check below carrying a
      // liquid unit on a dry product. Refuse to guess: if the product is unresolved there is
      // nothing to validate against. This is the same shape as the product_form bug fixed in
      // c461493b — absent data reading as "no restriction".
      const unresolved = editItems.find(
        (item) => item.product_id && !products.some((p) => p.id === item.product_id),
      );
      if (unresolved) {
        toast('error', `Product details for ${unresolved.product_name || 'an item'} have not loaded yet, so its unit cannot be checked. Try saving again in a moment.`);
        return;
      }
      const badItem = editItems.find((item) => {
        // Safe now: either the product resolved, or product_id is blank (nothing picked yet),
        // where a null form correctly means "any real unit is acceptable so far".
        const productForm = products.find((p) => p.id === item.product_id)?.product_form ?? null;
        return !item.unit.trim() || !isKnownUnit(unitConversions, productForm, item.unit);
      });
      if (badItem) {
        const who = badItem.product_name || 'each product';
        toast('error', badItem.unit.trim()
          ? `"${badItem.unit}" is not a unit ${who} can use. Pick one from the list.`
          : `Pick a unit for ${who}.`);
        return;
      }
    }

    await runCriticalAction({
      action: async () => {
        // Audit #34: atomic save — recipe + items in one transaction. Update
        // path replaces all items in the same statement, so a failed insert
        // can't wipe the recipe's items (the DELETE rolls back too).
        const saveKey = saveRecipeIdem.getKey();
        const { data, error } = await supabase.rpc('save_blend_recipe', {
          p_recipe_id: editId as string,
          p_name: form.name.trim(),
          p_recipe_type: form.recipe_type,
          p_items: editItems.map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            quantity: item.quantity,
            unit: item.unit,
            rate_per_acre: item.rate_per_acre,
            price_per_unit_cents: parseDollarsToCents(item.price_input),
            notes: item.notes || null,
          })),
          p_description: form.description || undefined,
          p_crop_type: form.recipe_type === 'crop_specific' ? form.crop_type || undefined : undefined,
          p_timing: form.recipe_type === 'crop_specific' ? form.timing || undefined : undefined,
          p_idempotency_key: saveKey,
        });
        if (error) throw error;
        assertRpcResult<{ recipe_id: string; created: boolean }>(data, 'save_blend_recipe');
        saveRecipeIdem.resetKey();
      },
      toast,
      setLoading: setSaving,
      successMessage: editId ? 'Recipe updated' : 'Recipe created',
      sentryTag: editId ? 'update_recipe' : 'create_recipe',
      onSuccess: () => {
        setShowEditor(false);
        fetchRecipes();
      },
    });
  };

  const handleDuplicate = async (recipe: RecipeRow) => {
    const scope = `duplicate:${recipe.id}`;
    if (duplicateInFlightRef.current.has(scope)) return;
    duplicateInFlightRef.current.add(scope);
    setDuplicateBusy((prev) => ({ ...prev, [recipe.id]: true }));

    try {
      await runCriticalAction({
      action: async () => {
        // Duplicate via save_blend_recipe (atomic recipe+items) rather than a
        // direct blend_recipe_items insert. The RPC is backward-compatible with
        // the price column: the pre-migration body ignores price_per_unit_cents in
        // p_items, the post-migration body carries it — so a frontend deploy that
        // races ahead of migration 20260618230000 can't fail on a missing column
        // (PostgREST schema break). Codex P2.
        const { data: items, error: itemsErr } = await supabase
          .from('blend_recipe_items')
          .select('*')
          .eq('recipe_id', recipe.id)
          .order('sort_order');
        if (itemsErr) throw itemsErr;

        const { data, error } = await supabase.rpc('save_blend_recipe', {
          p_recipe_id: null as unknown as string,
          p_name: `${recipe.name} (Copy)`,
          p_recipe_type: recipe.recipe_type,
          p_items: (items as RecipeItemDbRow[] | null || []).map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            quantity: item.quantity,
            unit: item.unit,
            rate_per_acre: item.rate_per_acre,
            price_per_unit_cents: item.price_per_unit_cents ?? 0,
            notes: item.notes ?? null,
          })),
          p_description: recipe.description || undefined,
          p_crop_type: recipe.recipe_type === 'crop_specific' ? recipe.crop_type || undefined : undefined,
          p_timing: recipe.recipe_type === 'crop_specific' ? recipe.timing || undefined : undefined,
          // Keep the same key for a lost-response retry of this exact source
          // recipe. A different row gets its own scoped intent and cannot
          // replay this duplicate's cached result.
          p_idempotency_key: duplicateRecipeIdem.getKeyFor(scope),
        });
        if (error) throw error;
        assertRpcResult(data, 'save_blend_recipe');
        duplicateRecipeIdem.resetKeyFor(scope);
      },
      toast,
      successMessage: 'Recipe duplicated',
      sentryTag: 'duplicate_recipe',
      onSuccess: () => fetchRecipes(),
      });
    } finally {
      duplicateInFlightRef.current.delete(scope);
      setDuplicateBusy((prev) => ({ ...prev, [recipe.id]: false }));
    }
  };

  const handleDelete = (recipe: RecipeRow) => {
    setDeleteTarget(recipe);
  };

  const executeDeleteRecipe = async () => {
    if (!deleteTarget) return;
    setDeleteTarget(null);
    await runCriticalAction({
      action: async () => {
        const result = await supabase
          .from('blend_recipes')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', deleteTarget.id)
          .select();
        checkMutationResult(result, 'Delete recipe');
      },
      toast,
      successMessage: 'Recipe deleted',
      sentryTag: 'delete_recipe',
      onSuccess: () => fetchRecipes(),
    });
  };

  const addItem = () => {
    setEditItems([
      ...editItems,
      // No seeded unit. Any default is a guess about a product that has not been picked yet,
      // and a NON-BLANK guess is the dangerous kind: it slips past a blank-only save guard, so
      // during a unit-list outage the seed itself would have been saved — a liquid unit landing
      // on a dry product. Blank forces a deliberate pick and is what the save guard below
      // actually checks. (The previous seed was 'gal', which unit_conversions does not even
      // contain; correcting it to 'Gal' would have kept the real hole open.)
      { product_id: '', product_name: '', quantity: 0, unit: '', rate_per_acre: null, price_input: '', sort_order: editItems.length, notes: '' },
    ]);
  };

  // Functional updater, NOT a copy of the `editItems` closure: the product <select> fires
  // two updateItem calls in one handler (product_id then product_name). Reading the closure
  // meant the second call started from pre-first-call state and threw the product_id away —
  // the row kept the product's NAME while its ID silently reverted to ''. That left the unit
  // picker unable to see the product's liquid/dry form, and the saved item carried no product.
  const updateItem = (idx: number, field: keyof EditItem, value: string | number | null) => {
    setEditItems((prev) => prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
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
            disabled={Boolean(duplicateBusy[row.id])}
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
      <PageHeader
        title="Blend"
        accent="Recipes"
        actions={(
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => openEditor()}>
            New Recipe
          </Button>
        )}
      />

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
                      // Switching to a product of the other form leaves the old unit selected
                      // as a grandfathered option — e.g. the 'Gal' seed surviving onto a DRY
                      // product. Clear it so the operator has to pick a unit that fits, rather
                      // than saving a liquid unit on a dry product by not looking.
                      // Only when the list really loaded: during an outage isKnownUnit is false
                      // for everything, and clearing would wipe a stored unit.
                      if (unitLoad === 'loaded' && unitConversions.length > 0
                        && !isKnownUnit(unitConversions, p?.product_form ?? null, item.unit)) {
                        updateItem(idx, 'unit', '');
                      }
                    }}
                    aria-label={`Product ${idx + 1}`}
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
                  <div className="w-28 shrink-0">
                    <UnitSelect
                      unitConversions={unitConversions}
                      // NOT the page's `form` state (that is recipe metadata) — this is the
                      // selected product's liquid/dry form, which filters the unit list.
                      form={products.find((p) => p.id === item.product_id)?.product_form ?? null}
                      value={item.unit}
                      onChange={(value) => updateItem(idx, 'unit', value)}
                      disabled={saving}
                      ariaLabel={`Unit for ${item.product_name || `product ${idx + 1}`}`}
                    />
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    value={item.rate_per_acre ?? ''}
                    onChange={(e) => updateItem(idx, 'rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)}
                    placeholder="Rate/ac"
                    className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={item.price_input}
                    onChange={(e) => updateItem(idx, 'price_input', e.target.value)}
                    placeholder="$/unit"
                    title="Price per unit (optional) — seeds the job's chemical price when this recipe is loaded"
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

      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDeleteRecipe}
        title="Delete Recipe"
        message={`Delete recipe "${deleteTarget?.name}"? This is a soft delete and can be reversed.`}
        confirmLabel="Delete Recipe"
        variant="danger"
      />
    </div>
  );
}
