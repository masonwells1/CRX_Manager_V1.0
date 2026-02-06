import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import EmptyState from '../components/ui/EmptyState';
import SplitHeading from '../components/ui/SplitHeading';
import { supabase } from '../lib/db';
import type { Product, IngredientMap } from '../types';

export default function BrandVsGeneric() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [mappings, setMappings] = useState<IngredientMap[]>([]);
  const [genericProduct, setGenericProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
    setProducts((data || []) as Product[]);
  };

  useEffect(() => {
    if (selectedProductId) {
      fetchComparison();
    } else {
      setSelectedProduct(null);
      setMappings([]);
      setGenericProduct(null);
    }
  }, [selectedProductId]);

  const fetchComparison = async () => {
    setLoading(true);
    const prod = products.find((p) => p.id === selectedProductId) || null;
    setSelectedProduct(prod);

    const { data: maps } = await supabase
      .from('ingredient_map')
      .select('*, generic_product:products!ingredient_map_generic_product_id_fkey(*)')
      .eq('fallback_branded_product', prod?.product_name || '');

    const mapResults = (maps || []) as Array<IngredientMap & { generic_product: Product | null }>;
    setMappings(mapResults);

    if (mapResults.length > 0 && mapResults[0].generic_product) {
      setGenericProduct(mapResults[0].generic_product);
    } else {
      setGenericProduct(null);
    }
    setLoading(false);
  };

  const fmt = (n: number | null) =>
    n != null
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
      : '-';

  return (
    <div className="space-y-6">
      <SplitHeading title="Brand vs" accent="Generic" />

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

      {loading && (
        <div className="space-y-4">
          <div className="h-48 bg-gray-100 rounded-xl animate-pulse" />
        </div>
      )}

      {!loading && selectedProduct && mappings.length === 0 && (
        <Card>
          <EmptyState
            icon={<FlaskConical className="w-6 h-6 text-gray-400" />}
            title="No generic alternatives found"
            description={`No ingredient mapping exists for ${selectedProduct.product_name}. Add mappings in the ingredient_map table.`}
          />
        </Card>
      )}

      {!loading && selectedProduct && genericProduct && (
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
      )}

      {!loading && selectedProduct && genericProduct && (
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
      )}
    </div>
  );
}
