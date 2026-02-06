import { useEffect, useState } from 'react';
import { Package, ArrowDownToLine, Pencil, Plus } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import type { Inventory, Product } from '../types';

interface InventoryRow extends Inventory {
  product_name: string;
  total_on_floor: number;
  net_position: number;
}

export default function InventoryPage() {
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [locationFilter, setLocationFilter] = useState('');
  const [locations, setLocations] = useState<string[]>([]);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [receiveQty, setReceiveQty] = useState('');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [addProductId, setAddProductId] = useState('');
  const [addLocation, setAddLocation] = useState('Main Warehouse');
  const [addQty, setAddQty] = useState('');
  const [addUnitSize, setAddUnitSize] = useState('');
  const [adding, setAdding] = useState(false);
  const [productSearch, setProductSearch] = useState('');

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchInventory();
  }, []);

  const fetchInventory = async () => {
    const { data } = await supabase
      .from('inventory')
      .select('*, product:products(product_name)')
      .order('product_id');

    const rows = ((data || []) as Array<Inventory & { product: { product_name: string } | null }>).map((item) => {
      const totalOnFloor = item.quantity_available + item.quantity_prebooked;
      return {
        ...item,
        product_name: item.product?.product_name || 'Unknown',
        total_on_floor: totalOnFloor,
        net_position: item.quantity_available - item.quantity_prebooked,
      };
    });

    const locs = [...new Set(rows.map((r) => r.location).filter(Boolean))];
    setLocations(locs.sort());
    setInventory(rows);
    setLoading(false);
  };

  const fetchProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
    setProducts((data || []) as Product[]);
  };

  const openAddModal = () => {
    fetchProducts();
    setAddProductId('');
    setAddLocation('Main Warehouse');
    setAddQty('');
    setAddUnitSize('');
    setProductSearch('');
    setAddOpen(true);
  };

  const handleAdd = async () => {
    if (!addProductId) {
      toast('error', 'Please select a product');
      return;
    }
    const qty = parseInt(addQty) || 0;
    setAdding(true);

    const existing = inventory.find(
      (i) => i.product_id === addProductId && i.location === addLocation
    );
    if (existing) {
      toast('error', 'Inventory record already exists for this product at this location. Use Receive or Adjust instead.');
      setAdding(false);
      return;
    }

    const product = products.find((p) => p.id === addProductId);
    const { error } = await supabase.from('inventory').insert({
      product_id: addProductId,
      location: addLocation || 'Main Warehouse',
      quantity_available: qty,
      unit_size: addUnitSize || product?.unit_size || null,
    });

    if (error) {
      toast('error', error.message || 'Failed to add inventory');
    } else {
      toast('success', 'Inventory record added');
      setAddOpen(false);
      fetchInventory();
    }
    setAdding(false);
  };

  const filtered = inventory.filter((i) => {
    if (locationFilter && i.location !== locationFilter) return false;
    return true;
  });

  const totalAvailable = inventory.reduce((s, i) => s + i.quantity_available, 0);
  const totalPrebooked = inventory.reduce((s, i) => s + i.quantity_prebooked, 0);
  const totalOnOrder = inventory.reduce((s, i) => s + i.quantity_on_order, 0);
  const totalOnFloor = totalAvailable + totalPrebooked;

  const handleReceive = async () => {
    const qty = parseInt(receiveQty);
    if (!qty || qty <= 0) return;
    const target = inventory.find((i) => i.id === selectedId);
    if (!target || !profile) return;
    const { error } = await supabase
      .from('inventory')
      .update({
        quantity_available: target.quantity_available + qty,
        updated_at: new Date().toISOString(),
      })
      .eq('id', selectedId);
    if (error) {
      toast('error', 'Failed to receive shipment');
    } else {
      // Create audit trail record
      await supabase.from('inventory_transactions').insert({
        product_id: target.product_id,
        transaction_type: 'received',
        quantity: qty,
        to_location: target.location || 'Main Warehouse',
        performed_by: profile.id,
        notes: `Received ${qty} units`,
      });
      toast('success', `Received ${qty} units`);
      setReceiveOpen(false);
      setReceiveQty('');
      fetchInventory();
    }
  };

  const handleAdjust = async () => {
    const qty = parseInt(adjustQty);
    if (isNaN(qty)) return;
    const target = inventory.find((i) => i.id === selectedId);
    if (!target || !profile) return;
    const { error } = await supabase
      .from('inventory')
      .update({
        quantity_available: target.quantity_available + qty,
        updated_at: new Date().toISOString(),
      })
      .eq('id', selectedId);
    if (error) {
      toast('error', 'Failed to adjust inventory');
    } else {
      // Create audit trail record (includes the reason/note the user typed)
      await supabase.from('inventory_transactions').insert({
        product_id: target.product_id,
        transaction_type: 'adjusted',
        quantity: qty,
        to_location: target.location || 'Main Warehouse',
        performed_by: profile.id,
        notes: adjustNote || `Manual adjustment of ${qty} units`,
      });
      toast('success', `Adjusted by ${qty} units`);
      setAdjustOpen(false);
      setAdjustQty('');
      setAdjustNote('');
      fetchInventory();
    }
  };

  const netColor = (n: number) => {
    if (n > 10) return 'text-emerald-600';
    if (n > 0) return 'text-amber-600';
    return 'text-red-600';
  };

  const columns: Column<InventoryRow>[] = [
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.product_name}</span>,
    },
    { key: 'quantity_available', header: 'Available', sortable: true },
    { key: 'quantity_prebooked', header: 'Pre-booked', sortable: true },
    { key: 'quantity_on_order', header: 'On Order', sortable: true },
    { key: 'total_on_floor', header: 'Total on Floor', sortable: true },
    {
      key: 'net_position',
      header: 'Net Position',
      sortable: true,
      render: (row) => (
        <span className={`font-semibold ${netColor(row.net_position)}`}>
          {row.net_position}
        </span>
      ),
    },
    { key: 'location', header: 'Location', sortable: true },
    ...(isAdmin
      ? [
          {
            key: 'actions' as const,
            header: 'Actions',
            render: (row: InventoryRow) => (
              <div className="flex gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedId(row.id); setReceiveOpen(true); }}
                  className="p-1.5 rounded hover:bg-gray-100 text-secondary"
                  title="Receive Shipment"
                >
                  <ArrowDownToLine className="w-4 h-4" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedId(row.id); setAdjustOpen(true); }}
                  className="p-1.5 rounded hover:bg-gray-100 text-secondary"
                  title="Manual Adjustment"
                >
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
            ),
          } satisfies Column<InventoryRow>,
        ]
      : []),
  ];

  const summaryCards = [
    { label: 'Total on Floor', value: totalOnFloor, color: 'bg-blue-50 text-blue-600' },
    { label: 'Available', value: totalAvailable, color: 'bg-emerald-50 text-emerald-600' },
    { label: 'Pre-booked', value: totalPrebooked, color: 'bg-amber-50 text-amber-600' },
    { label: 'On Order', value: totalOnOrder, color: 'bg-teal-50 text-teal-600' },
  ];

  const filteredProducts = products.filter((p) =>
    !productSearch || p.product_name.toLowerCase().includes(productSearch.toLowerCase())
  );

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button icon={<Plus className="w-4 h-4" />} onClick={openAddModal}>
            Add Inventory
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {summaryCards.map((c) => (
          <Card key={c.label}>
            <div className={`w-10 h-10 rounded-lg ${c.color} flex items-center justify-center mb-3`}>
              <Package className="w-5 h-5" />
            </div>
            <p className="text-xs text-secondary">{c.label}</p>
            <p className="text-2xl font-semibold font-heading text-nav-dark">
              {c.value.toLocaleString()}
            </p>
          </Card>
        ))}
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search products..."
            searchKeys={['product_name']}
            emptyTitle="No inventory records"
            emptyDescription="Inventory will appear as products are stocked"
            loading={loading}
            filters={
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Locations</option>
                {locations.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            }
          />
        </div>
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add" accent="Inventory">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Product</label>
            <input
              type="text"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="Search products..."
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green mb-2"
            />
            <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg">
              {filteredProducts.length === 0 ? (
                <p className="px-3 py-4 text-sm text-secondary text-center">No products found</p>
              ) : (
                filteredProducts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setAddProductId(p.id);
                      setAddUnitSize(p.unit_size || '');
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0 ${
                      addProductId === p.id ? 'bg-crx-green/10 text-crx-green font-medium' : 'text-nav-dark'
                    }`}
                  >
                    <span>{p.product_name}</span>
                    {p.sku && <span className="text-secondary ml-2">({p.sku})</span>}
                  </button>
                ))
              )}
            </div>
          </div>
          <Input
            label="Location"
            value={addLocation}
            onChange={(e) => setAddLocation(e.target.value)}
            placeholder="e.g. Main Warehouse"
          />
          <Input
            label="Initial Quantity"
            type="number"
            min="0"
            value={addQty}
            onChange={(e) => setAddQty(e.target.value)}
          />
          <Input
            label="Unit Size"
            value={addUnitSize}
            onChange={(e) => setAddUnitSize(e.target.value)}
            placeholder="e.g. Gal, Qt, Lb"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={adding}>
              {adding ? 'Adding...' : 'Add Inventory'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Receive" accent="Shipment">
        <div className="space-y-4">
          <Input
            label="Quantity Received"
            type="number"
            min="1"
            value={receiveQty}
            onChange={(e) => setReceiveQty(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReceiveOpen(false)}>Cancel</Button>
            <Button onClick={handleReceive}>Receive</Button>
          </div>
        </div>
      </Modal>

      <Modal open={adjustOpen} onClose={() => setAdjustOpen(false)} title="Manual" accent="Adjustment">
        <div className="space-y-4">
          <Input
            label="Adjustment Quantity (+ or -)"
            type="number"
            value={adjustQty}
            onChange={(e) => setAdjustQty(e.target.value)}
          />
          <Input
            label="Note"
            value={adjustNote}
            onChange={(e) => setAdjustNote(e.target.value)}
            placeholder="Reason for adjustment"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAdjustOpen(false)}>Cancel</Button>
            <Button onClick={handleAdjust}>Apply Adjustment</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
