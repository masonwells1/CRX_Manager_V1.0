import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import BulkPricingImport from '../components/products/BulkPricingImport';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { Product } from '../types';

export default function Products() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('*')
      .order('product_name');
    const prods = (data || []) as Product[];
    setProducts(prods);

    const cats = [...new Set(prods.map((p) => p.category).filter(Boolean))] as string[];
    const vends = [...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[];
    setCategories(cats.sort());
    setVendors(vends.sort());
    setLoading(false);
  };

  const filtered = products.filter((p) => {
    if (categoryFilter && p.category !== categoryFilter) return false;
    if (vendorFilter && p.vendor !== vendorFilter) return false;
    return true;
  });

  const isAdmin = role === 'admin';

  const columns: Column<Product>[] = [
    {
      key: 'product_name',
      header: 'Product Name',
      sortable: true,
      render: (row) => (
        <div className="max-w-xs">
          <p className="font-medium text-nav-dark truncate">{row.product_name}</p>
          {row.sku && <p className="text-xs text-gray-400">{row.sku}</p>}
        </div>
      ),
    },
    { key: 'category', header: 'Category', sortable: true },
    { key: 'vendor', header: 'Vendor', sortable: true },
    ...(isAdmin
      ? [
          {
            key: 'current_cost' as const,
            header: 'Cost',
            sortable: true,
            render: (row: Product) => (
              <span className="font-mono text-sm">
                {row.current_cost != null ? `$${row.current_cost.toFixed(2)}` : '-'}
              </span>
            ),
          } satisfies Column<Product>,
        ]
      : []),
    {
      key: 'tier1_price',
      header: 'T1 Price',
      sortable: true,
      render: (row) => (
        <span className="font-mono text-sm">
          {row.tier1_price != null ? `$${row.tier1_price.toFixed(2)}` : '-'}
        </span>
      ),
    },
    {
      key: 'tier2_price',
      header: 'T2 Price',
      sortable: true,
      render: (row) => (
        <span className="font-mono text-sm">
          {row.tier2_price != null ? `$${row.tier2_price.toFixed(2)}` : '-'}
        </span>
      ),
    },
    {
      key: 'tier3_price',
      header: 'T3 Price',
      sortable: true,
      render: (row) => (
        <span className="font-mono text-sm">
          {row.tier3_price != null ? `$${row.tier3_price.toFixed(2)}` : '-'}
        </span>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (row) => (
        <Badge variant={row.is_active ? 'success' : 'default'}>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setBulkImportOpen(true)}
          >
            Bulk Update Pricing
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
            Add Product
          </Button>
        </div>
      )}

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search products..."
            searchKeys={['product_name', 'sku', 'category', 'vendor']}
            onRowClick={(row) => navigate(`/products/${(row as unknown as Product).id}`)}
            emptyTitle="No products yet"
            emptyDescription="Add your first product to get started"
            emptyAction={
              isAdmin ? (
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
                  Add Product
                </Button>
              ) : undefined
            }
            loading={loading}
            filters={
              <>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Vendors</option>
                  {vendors.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </>
            }
          />
        </div>
      </Card>

      <BulkPricingImport
        open={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        onSuccess={() => {
          fetchProducts();
          setBulkImportOpen(false);
        }}
      />
    </div>
  );
}
