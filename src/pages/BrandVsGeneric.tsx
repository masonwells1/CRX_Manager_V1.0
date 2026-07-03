import { useEffect, useState, useMemo, useCallback } from 'react';
import { FlaskConical, Plus, Pencil, Trash2 } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import Combobox from '../components/ui/Combobox';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import EmptyState from '../components/ui/EmptyState';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult, sanitizeError } from '../lib/db';
import { Sentry } from '../lib/sentry';
import type { Product, IngredientMap } from '../types';

type MappingRow = IngredientMap & { generic_product: Product | null };

export default function BrandVsGeneric() {
  const { toast } = useToast();
  const { role } = useAuth();
  const isAdmin = role === 'admin';

  const [products, setProducts] = useState<Product[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [loading, setLoading] = useState(true);

  // Add / edit form state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MappingRow | null>(null);
  const [brandedName, setBrandedName] = useState('');
  const [activeIngredient, setActiveIngredient] = useState('');
  const [genericName, setGenericName] = useState('');
  const [hasBulk, setHasBulk] = useState(false);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<MappingRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [prodRes, mapRes] = await Promise.all([
      supabase.from('products').select('*').eq('is_active', true).order('product_name'),
      supabase
        .from('ingredient_map')
        .select('*, generic_product:products!ingredient_map_generic_product_id_fkey(*)')
        .order('fallback_branded_product'),
    ]);

    if (prodRes.error || mapRes.error) {
      Sentry.captureException(prodRes.error || mapRes.error, {
        tags: { source: 'fetch', action: 'load_ingredient_map' },
      });
      toast('error', 'Failed to load ingredient mappings');
      setLoading(false);
      return;
    }
    setProducts((prodRes.data || []) as Product[]);
    setMappings((mapRes.data || []) as MappingRow[]);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fast name -> product lookup for resolving picker text back to a product row.
  const productByName = useMemo(() => {
    const m = new Map<string, Product>();
    products.forEach((p) => m.set(p.product_name, p));
    return m;
  }, [products]);

  const productNames = useMemo(() => products.map((p) => p.product_name), [products]);

  // Comparison viewer — derived from the loaded mappings (single source of truth).
  const selectedProduct = products.find((p) => p.id === selectedProductId) || null;
  const viewerMapping = selectedProduct
    ? mappings.find((m) => m.fallback_branded_product === selectedProduct.product_name) || null
    : null;
  const genericProduct = viewerMapping?.generic_product || null;

  const fmt = (n: number | null) =>
    n != null
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
      : '-';

  const openAdd = () => {
    setEditing(null);
    setBrandedName('');
    setActiveIngredient('');
    setGenericName('');
    setHasBulk(false);
    setNotes('');
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (row: MappingRow) => {
    setEditing(row);
    setBrandedName(row.fallback_branded_product || '');
    setActiveIngredient(row.branded_ingredient || '');
    setGenericName(row.generic_product?.product_name || '');
    setHasBulk(row.generic_has_bulk);
    setNotes(row.notes || '');
    setFormError('');
    setFormOpen(true);
  };

  const handleSave = async () => {
    setFormError('');
    const branded = brandedName.trim();
    if (!branded) {
      setFormError('Choose a branded product.');
      return;
    }
    if (!productByName.has(branded)) {
      setFormError('The branded product must match an existing product.');
      return;
    }
    const generic = genericName.trim();
    let genericId: string | null = null;
    if (generic) {
      const genericProd = productByName.get(generic);
      if (!genericProd) {
        setFormError('The generic alternative must match an existing product (or leave it blank).');
        return;
      }
      genericId = genericProd.id;
    }

    const payload = {
      fallback_branded_product: branded,
      // branded_ingredient is NOT NULL; default it to the branded product name when left blank.
      branded_ingredient: activeIngredient.trim() || branded,
      generic_product_id: genericId,
      generic_has_bulk: hasBulk,
      notes: notes.trim() || null,
    };

    setSaving(true);
    try {
      const result = editing
        ? await supabase.from('ingredient_map').update(payload).eq('id', editing.id).select()
        : await supabase.from('ingredient_map').insert(payload).select();
      checkMutationResult(result, editing ? 'Update ingredient mapping' : 'Create ingredient mapping');
      toast('success', editing ? 'Mapping updated' : 'Mapping added');
      setFormOpen(false);
      await fetchData();
    } catch (err: unknown) {
      setFormError(sanitizeError(err));
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await supabase.from('ingredient_map').delete().eq('id', deleteTarget.id).select();
      checkMutationResult(result, 'Delete ingredient mapping');
      toast('success', 'Mapping deleted');
      setDeleteTarget(null);
      await fetchData();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
  };

  const dataColumns: Column<MappingRow>[] = [
    {
      key: 'fallback_branded_product',
      header: 'Branded Product',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.fallback_branded_product || '-'}</span>,
    },
    {
      key: 'branded_ingredient',
      header: 'Active Ingredient',
      sortable: true,
      render: (r) => <span className="text-nav-dark">{r.branded_ingredient || '-'}</span>,
    },
    {
      key: 'generic',
      header: 'Generic Alternative',
      render: (r) =>
        r.generic_product ? (
          <span className="text-crx-green font-medium">{r.generic_product.product_name}</span>
        ) : (
          <span className="text-gray-400">&mdash; unmapped</span>
        ),
    },
    {
      key: 'generic_has_bulk',
      header: 'Bulk',
      render: (r) =>
        r.generic_has_bulk ? <Badge variant="success">Bulk</Badge> : <Badge variant="default">No</Badge>,
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (r) => <span className="text-secondary">{r.notes || '-'}</span>,
    },
  ];

  const actionColumn: Column<MappingRow> = {
    key: 'actions',
    header: '',
    render: (r) => (
      <div className="flex items-center justify-end gap-1">
        <button
          onClick={() => openEdit(r)}
          aria-label={`Edit mapping for ${r.fallback_branded_product || 'product'}`}
          className="p-1.5 rounded-lg text-gray-400 hover:text-crx-green hover:bg-gray-100 transition-colors"
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={() => setDeleteTarget(r)}
          aria-label={`Delete mapping for ${r.fallback_branded_product || 'product'}`}
          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-gray-100 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    ),
  };

  const columns = isAdmin ? [...dataColumns, actionColumn] : dataColumns;

  return (
    <div className="space-y-6">
      <SplitHeading title="Brand vs" accent="Generic" />

      {/* Comparison viewer */}
      <Card>
        <label className="block text-sm font-medium text-secondary mb-2">
          Select a Product to Compare
        </label>
        <select
          value={selectedProductId}
          onChange={(e) => setSelectedProductId(e.target.value)}
          className="w-full max-w-md px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">Choose a product...</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.product_name}
            </option>
          ))}
        </select>
      </Card>

      {selectedProduct && !genericProduct && (
        <Card>
          <EmptyState
            icon={<FlaskConical className="w-6 h-6 text-gray-400" />}
            title="No generic alternative found"
            description={
              isAdmin
                ? `No mapping links ${selectedProduct.product_name} to a generic. Use "Add Mapping" below to create one.`
                : `No generic alternative has been mapped for ${selectedProduct.product_name}.`
            }
          />
        </Card>
      )}

      {selectedProduct && genericProduct && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader title="Branded" accent="Product" />
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-secondary">Name</p>
                  <p className="text-sm font-medium text-nav-dark">{selectedProduct.product_name}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Vendor</p>
                  <p className="text-sm text-nav-dark">{selectedProduct.vendor || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Category</p>
                  <p className="text-sm text-nav-dark">{selectedProduct.category || '-'}</p>
                </div>
                <div className="border-t border-gray-100 pt-3">
                  <p className="text-xs text-secondary">Cost</p>
                  <p className="text-lg font-semibold text-nav-dark font-mono">
                    {fmt(selectedProduct.current_cost)}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-xs text-secondary">T1</p>
                    <p className="text-sm font-mono">{fmt(selectedProduct.tier1_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T2</p>
                    <p className="text-sm font-mono">{fmt(selectedProduct.tier2_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T3</p>
                    <p className="text-sm font-mono">{fmt(selectedProduct.tier3_price)}</p>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="border-crx-green/20">
              <CardHeader title="Generic" accent="Alternative" />
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-secondary">Name</p>
                  <p className="text-sm font-medium text-nav-dark">{genericProduct.product_name}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Vendor</p>
                  <p className="text-sm text-nav-dark">{genericProduct.vendor || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-secondary">Category</p>
                  <p className="text-sm text-nav-dark">{genericProduct.category || '-'}</p>
                </div>
                <div className="border-t border-gray-100 pt-3">
                  <p className="text-xs text-secondary">Cost</p>
                  <p className="text-lg font-semibold text-crx-green font-mono">
                    {fmt(genericProduct.current_cost)}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-xs text-secondary">T1</p>
                    <p className="text-sm font-mono">{fmt(genericProduct.tier1_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T2</p>
                    <p className="text-sm font-mono">{fmt(genericProduct.tier2_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-secondary">T3</p>
                    <p className="text-sm font-mono">{fmt(genericProduct.tier3_price)}</p>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          <Card padding={false}>
            <div className="p-5">
              <CardHeader title="Price" accent="Comparison" />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-3 text-left font-medium text-secondary">Metric</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Branded</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Generic</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Savings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Cost', branded: selectedProduct.current_cost, generic: genericProduct.current_cost },
                      { label: 'Tier 1 Price', branded: selectedProduct.tier1_price, generic: genericProduct.tier1_price },
                      { label: 'Tier 2 Price', branded: selectedProduct.tier2_price, generic: genericProduct.tier2_price },
                      { label: 'Tier 3 Price', branded: selectedProduct.tier3_price, generic: genericProduct.tier3_price },
                    ].map((row) => {
                      const savings =
                        row.branded != null && row.generic != null ? row.branded - row.generic : null;
                      return (
                        <tr key={row.label} className="border-b border-gray-50">
                          <td className="px-4 py-3 font-medium text-nav-dark">{row.label}</td>
                          <td className="px-4 py-3 font-mono">{fmt(row.branded)}</td>
                          <td className="px-4 py-3 font-mono">{fmt(row.generic)}</td>
                          <td className="px-4 py-3 font-mono">
                            {savings != null ? (
                              <span className={savings > 0 ? 'text-emerald-600' : 'text-red-600'}>
                                {savings > 0 ? '+' : ''}{fmt(savings)}
                              </span>
                            ) : (
                              '-'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </>
      )}

      {/* Management section */}
      <Card padding={false}>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardHeader title="Manage" accent="Mappings" />
            {isAdmin && (
              <Button icon={<Plus className="w-4 h-4" />} onClick={openAdd}>
                Add Mapping
              </Button>
            )}
          </div>
          <DataTable<MappingRow>
            data={mappings}
            columns={columns}
            searchable
            searchPlaceholder="Search mappings..."
            searchKeys={['fallback_branded_product', 'branded_ingredient', 'notes']}
            emptyTitle="No mappings yet"
            emptyDescription={
              isAdmin
                ? 'Add your first brand-to-generic mapping to power the comparison above.'
                : 'No brand-to-generic mappings have been set up yet.'
            }
            loading={loading}
          />
        </div>
      </Card>

      {/* Add / edit modal (admin only) */}
      {isAdmin && (
        <Modal
          open={formOpen}
          onClose={() => setFormOpen(false)}
          title={editing ? 'Edit' : 'Add'}
          accent="Mapping"
        >
          <div className="space-y-4">
            <div>
              <Combobox
                label="Branded Product *"
                value={brandedName}
                onChange={setBrandedName}
                options={productNames}
                placeholder="Search products..."
              />
              <p className="mt-1 text-xs text-secondary">
                The branded product customers ask for. Must match a product in your catalog.
              </p>
            </div>

            <div>
              <Input
                label="Active Ingredient"
                value={activeIngredient}
                onChange={(e) => setActiveIngredient(e.target.value)}
                placeholder="e.g. Glyphosate"
              />
              <p className="mt-1 text-xs text-secondary">
                Optional. Defaults to the branded product name if left blank.
              </p>
            </div>

            <div>
              <Combobox
                label="Generic Alternative"
                value={genericName}
                onChange={setGenericName}
                options={productNames}
                placeholder="Search products (optional)..."
              />
              <p className="mt-1 text-xs text-secondary">
                The lower-cost generic to suggest. Leave blank if there isn&apos;t one yet.
              </p>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={hasBulk}
                onChange={(e) => setHasBulk(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/20"
              />
              <span className="text-sm text-nav-dark">Generic available in bulk</span>
            </label>

            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Optional notes for the sales team..."
                className="w-full px-3 py-2.5 text-sm text-nav-dark bg-white border border-gray-300 rounded-lg placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green transition-colors duration-150"
              />
            </div>

            {formError && <p className="text-sm text-red-500">{formError}</p>}

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} loading={saving}>
                {editing ? 'Save Changes' : 'Add Mapping'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirm (admin only) */}
      {isAdmin && (
        <ConfirmModal
          open={deleteTarget !== null}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          title="Delete Mapping"
          message={`Delete the brand-to-generic mapping for "${deleteTarget?.fallback_branded_product || 'this product'}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          loading={deleting}
        />
      )}
    </div>
  );
}
