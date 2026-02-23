import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, FileUp } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EditableDataTable, { type EditableColumn } from '../components/ui/EditableDataTable';
import Badge from '../components/ui/Badge';
import BulkPricingImport from '../components/products/BulkPricingImport';
import BulkProductImport from '../components/products/BulkProductImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError } from '../lib/db';
import { logActivity } from '../lib/activityLogger';
import type { Product } from '../types';

export default function Products() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkProductImportOpen, setBulkProductImportOpen] = useState(false);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('product_name')
      .limit(500);
    if (error) {
      console.error('Failed to load products:', error.message);
      toast('error', 'Failed to load products. Please try again.');
      setLoading(false);
      return;
    }
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

  const categoryOptions = categories.map((c) => ({ value: c, label: c }));
  const vendorOptions = vendors.map((v) => ({ value: v, label: v }));

  const handleBulkSave = async (changes: Map<string, Record<string, unknown>>) => {
    try {
      // Log cost history for pricing changes
      for (const [productId, fields] of changes) {
        const original = products.find((p) => p.id === productId);
        if (!original || !profile) continue;

        const pricingChanged =
          ('current_cost' in fields && Number(fields.current_cost) !== Number(original.current_cost)) ||
          ('tier1_price' in fields && Number(fields.tier1_price) !== Number(original.tier1_price)) ||
          ('tier2_price' in fields && Number(fields.tier2_price) !== Number(original.tier2_price)) ||
          ('tier3_price' in fields && Number(fields.tier3_price) !== Number(original.tier3_price));

        if (pricingChanged) {
          await supabase.from('cost_history').insert({
            product_id: productId,
            changed_by: profile.id,
            old_cost: original.current_cost,
            new_cost: 'current_cost' in fields ? fields.current_cost : original.current_cost,
            old_tier1_price: original.tier1_price,
            new_tier1_price: 'tier1_price' in fields ? fields.tier1_price : original.tier1_price,
            old_tier2_price: original.tier2_price,
            new_tier2_price: 'tier2_price' in fields ? fields.tier2_price : original.tier2_price,
            old_tier3_price: original.tier3_price,
            new_tier3_price: 'tier3_price' in fields ? fields.tier3_price : original.tier3_price,
            change_note: 'Updated via inline bulk edit',
          });
        }

        // Update product
        const { error } = await supabase
          .from('products')
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq('id', productId);

        if (error) throw error;
      }

      toast('success', `Updated ${changes.size} product(s)`);
      if (profile) {
        logActivity('products_bulk_updated', `${changes.size} product(s) updated via inline edit`, profile.id, 'product', null);
      }
      fetchProducts();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
      throw err; // re-throw so EditableDataTable stays in edit mode
    }
  };

  const columns: EditableColumn<Product>[] = [
    {
      key: 'product_name',
      header: 'Product Name',
      sortable: true,
      editable: isAdmin,
      editType: 'text',
      render: (row) => (
        <div className="max-w-xs">
          <p className="font-medium text-nav-dark truncate">{row.product_name}</p>
          {row.sku && <p className="text-xs text-gray-400">{row.sku}</p>}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editOptions: categoryOptions,
    },
    {
      key: 'vendor',
      header: 'Vendor',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editOptions: vendorOptions,
    },
    ...(isAdmin
      ? [
          {
            key: 'current_cost',
            header: 'Cost',
            sortable: true,
            editable: true,
            editType: 'number' as const,
            editMin: 0,
            editStep: '0.01',
            render: (row: Product) => (
              <span className="font-mono text-sm">
                {row.current_cost != null ? `$${Number(row.current_cost).toFixed(2)}` : '-'}
              </span>
            ),
          } satisfies EditableColumn<Product>,
        ]
      : []),
    {
      key: 'tier1_price',
      header: 'T1 Price',
      sortable: true,
      editable: isAdmin,
      editType: 'number',
      editMin: 0,
      editStep: '0.01',
      render: (row) => (
        <span className="font-mono text-sm">
          {row.tier1_price != null ? `$${Number(row.tier1_price).toFixed(2)}` : '-'}
        </span>
      ),
    },
    {
      key: 'tier2_price',
      header: 'T2 Price',
      sortable: true,
      editable: isAdmin,
      editType: 'number',
      editMin: 0,
      editStep: '0.01',
      render: (row) => (
        <span className="font-mono text-sm">
          {row.tier2_price != null ? `$${Number(row.tier2_price).toFixed(2)}` : '-'}
        </span>
      ),
    },
    {
      key: 'tier3_price',
      header: 'T3 Price',
      sortable: true,
      editable: isAdmin,
      editType: 'number',
      editMin: 0,
      editStep: '0.01',
      render: (row) => (
        <span className="font-mono text-sm">
          {row.tier3_price != null ? `$${Number(row.tier3_price).toFixed(2)}` : '-'}
        </span>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      editable: isAdmin,
      editType: 'toggle',
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
            icon={<FileUp className="w-4 h-4" />}
            onClick={() => setBulkProductImportOpen(true)}
          >
            Import Products
          </Button>
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setBulkImportOpen(true)}
          >
            Update Pricing
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
            Add Product
          </Button>
        </div>
      )}

      <Card padding={false}>
        <div className="p-5">
          <EditableDataTable<Product>
            data={filtered}
            columns={columns}
            rowKey="id"
            searchable
            searchPlaceholder="Search products..."
            searchKeys={['product_name', 'sku', 'category', 'vendor']}
            onRowClick={(row) => navigate(`/products/${row.id}`)}
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
            canEdit={isAdmin}
            onSave={handleBulkSave}
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

      <BulkProductImport
        open={bulkProductImportOpen}
        onClose={() => setBulkProductImportOpen(false)}
        onSuccess={() => {
          fetchProducts();
          setBulkProductImportOpen(false);
        }}
      />
    </div>
  );
}
