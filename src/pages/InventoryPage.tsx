import { useEffect, useState } from 'react';
import { Package, ArrowDownToLine, Pencil, Plus, AlertTriangle, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import type { Inventory, Product, InventoryHold, Customer } from '../types';

interface InventoryRow extends Inventory {
  product_name: string;
  inventory_unit: string | null;
  container_size: number | null;
  container_type: string | null;
  total_on_floor: number;
  planned_qty: number;
  free_qty: number;
  delivered_ytd: number;
  reorder_point: number;
  min_stock_level: number;
  is_low_stock: boolean;
}

interface HoldWithRelations extends InventoryHold {
  product_name: string;
  customer_name: string | null;
  creator_name: string;
}

export default function InventoryPage() {
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [holds, setHolds] = useState<HoldWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [locationFilter, setLocationFilter] = useState('');
  const [locations, setLocations] = useState<string[]>([]);

  // Existing modals
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // New hold modal
  const [holdOpen, setHoldOpen] = useState(false);
  const [holdProductId, setHoldProductId] = useState('');
  const [holdQty, setHoldQty] = useState('');
  const [holdCustomerId, setHoldCustomerId] = useState('');
  const [holdNotes, setHoldNotes] = useState('');
  const [holdExpires, setHoldExpires] = useState('');
  const [holdWarning, setHoldWarning] = useState('');

  const [selectedId, setSelectedId] = useState('');
  const [receiveQty, setReceiveQty] = useState('');
  const [receivePOItemId, setReceivePOItemId] = useState('');
  const [availablePOs, setAvailablePOs] = useState<Array<{id: string; po_number: string; ordered: number; received: number; unit_cost: number; purchase_order_id: string; product_id: string; unit_size: string | null}>>([]);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [addProductId, setAddProductId] = useState('');
  const [addLocation, setAddLocation] = useState('Main Warehouse');
  const [addQty, setAddQty] = useState('');
  const [addUnitSize, setAddUnitSize] = useState('');
  const [adding, setAdding] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [holdsExpanded, setHoldsExpanded] = useState(true);

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchInventory();
    fetchHolds();
  }, []);

  const fetchInventory = async () => {
    const { data, error } = await supabase
      .from('inventory')
      .select('*, product:products(product_name, inventory_unit, container_size, container_type)')
      .order('product_id');

    if (error) {
      console.error('Failed to load inventory:', error.message);
      toast('error', 'Failed to load inventory. Please try again.');
      setLoading(false);
      return;
    }

    const rawRows = (data || []) as Array<Inventory & { product: { product_name: string; inventory_unit: string | null; container_size: number | null; container_type: string | null } | null; reorder_point: number; min_stock_level: number }>;

    const holdsFetch = supabase
      .from('inventory_holds')
      .select('product_id, quantity')
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString().split('T')[0]}`);

    const poFetch = supabase
      .from('purchase_order_items')
      .select('product_id, quantity_ordered, quantity_received, purchase_orders!inner(status)')
      .in('purchase_orders.status', ['draft', 'submitted', 'partially_received']);

    const quoteFetch = supabase
      .from('quote_items')
      .select('product_id, total_units_needed, quote:quotes!inner(is_planned, status)')
      .eq('quote.is_planned', true)
      .in('quote.status', ['draft', 'sent', 'revised']);

    const now = new Date();
    const seasonStart = now.getMonth() >= 6
      ? new Date(now.getFullYear(), 6, 1)
      : new Date(now.getFullYear() - 1, 6, 1);

    const deliveredFetch = supabase
      .from('inventory_transactions')
      .select('product_id, quantity')
      .eq('transaction_type', 'delivered')
      .gte('created_at', seasonStart.toISOString());

    const [holdsRes, poRes, quoteRes, deliveredRes] = await Promise.all([
      holdsFetch, poFetch, quoteFetch, deliveredFetch,
    ]);

    const holdsByProduct = (holdsRes.data || []).reduce((acc, h) => {
      acc[h.product_id] = (acc[h.product_id] || 0) + Number(h.quantity);
      return acc;
    }, {} as Record<string, number>);

    const onOrderByProduct = (poRes.data || []).reduce((acc, poi: any) => {
      const remaining = Number(poi.quantity_ordered) - Number(poi.quantity_received);
      acc[poi.product_id] = (acc[poi.product_id] || 0) + remaining;
      return acc;
    }, {} as Record<string, number>);

    const plannedByProduct = (quoteRes.data || []).reduce((acc, qi) => {
      acc[qi.product_id] = (acc[qi.product_id] || 0) + Number(qi.total_units_needed || 0);
      return acc;
    }, {} as Record<string, number>);

    const deliveredByProduct = (deliveredRes.data || []).reduce((acc, t) => {
      acc[t.product_id] = (acc[t.product_id] || 0) + Number(t.quantity);
      return acc;
    }, {} as Record<string, number>);

    const inventoryProductIds = new Set(rawRows.map((r) => r.product_id));

    const missingProductIds = Object.keys(onOrderByProduct).filter(
      (pid) => !inventoryProductIds.has(pid)
    );

    let missingProducts: Array<{ id: string; product_name: string }> = [];
    if (missingProductIds.length > 0) {
      const { data: mpData } = await supabase
        .from('products')
        .select('id, product_name')
        .in('id', missingProductIds);
      missingProducts = (mpData || []) as Array<{ id: string; product_name: string }>;
    }

    const buildRow = (
      item: { id: string; product_id: string; quantity_available: number; quantity_prebooked: number; location: string; unit_size: string | null; product_name: string; inventory_unit?: string | null; container_size?: number | null; container_type?: string | null; reorder_point: number; min_stock_level: number },
      _isVirtual: boolean
    ): InventoryRow => {
      const onOrderQty = onOrderByProduct[item.product_id] || 0;
      const totalOnFloor = item.quantity_available + item.quantity_prebooked;
      const plannedQty = (holdsByProduct[item.product_id] || 0) + (plannedByProduct[item.product_id] || 0);
      const freeQty = item.quantity_available - plannedQty - item.quantity_prebooked;
      const deliveredYtd = deliveredByProduct[item.product_id] || 0;
      const reorderPt = item.reorder_point || 0;
      const minStock = item.min_stock_level || 0;

      return {
        id: item.id,
        product_id: item.product_id,
        quantity_available: item.quantity_available,
        quantity_prebooked: item.quantity_prebooked,
        quantity_on_order: onOrderQty,
        location: item.location,
        unit_size: item.unit_size,
        last_counted_at: null,
        updated_at: '',
        product_name: item.product_name,
        inventory_unit: item.inventory_unit || null,
        container_size: item.container_size || null,
        container_type: item.container_type || null,
        total_on_floor: totalOnFloor,
        planned_qty: plannedQty,
        free_qty: freeQty,
        delivered_ytd: deliveredYtd,
        reorder_point: reorderPt,
        min_stock_level: minStock,
        is_low_stock: reorderPt > 0 && item.quantity_available <= reorderPt,
      } as InventoryRow;
    };

    const existingRows = rawRows.map((item) =>
      buildRow(
        {
          id: item.id,
          product_id: item.product_id,
          quantity_available: item.quantity_available,
          quantity_prebooked: item.quantity_prebooked,
          location: item.location,
          unit_size: item.unit_size,
          product_name: item.product?.product_name || 'Unknown',
          inventory_unit: item.product?.inventory_unit || null,
          container_size: item.product?.container_size || null,
          container_type: item.product?.container_type || null,
          reorder_point: item.reorder_point || 0,
          min_stock_level: item.min_stock_level || 0,
        },
        false
      )
    );

    const virtualRows = missingProducts.map((mp) =>
      buildRow(
        {
          id: `virtual-${mp.id}`,
          product_id: mp.id,
          quantity_available: 0,
          quantity_prebooked: 0,
          location: '',
          unit_size: null,
          product_name: mp.product_name,
          reorder_point: 0,
          min_stock_level: 0,
        },
        true
      )
    );

    const rows = [...existingRows, ...virtualRows];

    const locs = [...new Set(rows.map((r) => r.location).filter(Boolean))];
    setLocations(locs.sort());
    setInventory(rows);
    setLoading(false);
  };

  const fetchHolds = async () => {
    const { data, error } = await supabase
      .from('inventory_holds')
      .select(`
        *,
        product:products(product_name),
        customer:customers(farm_name),
        creator:profiles!inventory_holds_created_by_fkey(full_name)
      `)
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString().split('T')[0]}`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to load holds:', error.message);
      return;
    }

    const holdRows = (data || []).map((h: any) => ({
      ...h,
      product_name: h.product?.product_name || 'Unknown',
      customer_name: h.customer?.farm_name || null,
      creator_name: h.creator?.full_name || 'Unknown',
    })) as HoldWithRelations[];

    setHolds(holdRows);
  };

  const fetchProducts = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
    if (error) {
      console.error('Failed to load products:', error.message);
      toast('error', 'Failed to load products. Please try again.');
      return;
    }
    setProducts((data || []) as Product[]);
  };

  const fetchCustomers = async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name');
    if (error) {
      console.error('Failed to load customers:', error.message);
      return;
    }
    setCustomers((data || []) as Customer[]);
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

  const openHoldModal = () => {
    fetchProducts();
    fetchCustomers();
    setHoldProductId('');
    setHoldQty('');
    setHoldCustomerId('');
    setHoldNotes('');
    setHoldExpires('');
    setHoldWarning('');
    setProductSearch('');
    setHoldOpen(true);
  };

  const handleCreateHold = async () => {
    if (!holdProductId) {
      toast('error', 'Please select a product');
      return;
    }
    const qty = parseFloat(holdQty);
    if (!qty || qty <= 0) {
      toast('error', 'Please enter a valid quantity');
      return;
    }
    if (!profile) return;

    const invItem = inventory.find(i => i.product_id === holdProductId);
    if (invItem && invItem.free_qty < qty) {
      const newFree = invItem.free_qty - qty;
      if (!holdWarning) {
        setHoldWarning(`Warning: This hold will make Free inventory negative (${newFree.toFixed(1)}). Only ${invItem.free_qty.toFixed(1)} units currently available. Click Create Hold again to proceed anyway.`);
        return;
      }
    }

    const { error } = await supabase.from('inventory_holds').insert({
      product_id: holdProductId,
      customer_id: holdCustomerId || null,
      quantity: qty,
      hold_type: 'manual',
      notes: holdNotes || null,
      created_by: profile.id,
      expires_at: holdExpires || null,
    });

    if (error) {
      toast('error', error.message || 'Failed to create hold');
    } else {
      toast('success', 'Hold created successfully');
      setHoldOpen(false);
      fetchInventory();
      fetchHolds();
    }
  };

  const handleReleaseHold = async (holdId: string) => {
    const { error } = await supabase
      .from('inventory_holds')
      .update({ is_active: false })
      .eq('id', holdId);

    if (error) {
      toast('error', 'Failed to release hold');
    } else {
      toast('success', 'Hold released');
      fetchInventory();
      fetchHolds();
    }
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
      if (qty > 0 && profile) {
        await supabase.from('inventory_transactions').insert({
          product_id: addProductId,
          transaction_type: 'adjusted',
          quantity: qty,
          to_location: addLocation || 'Main Warehouse',
          performed_by: profile.id,
          notes: `Initial inventory record created with ${qty} units`,
        });
      }
      toast('success', 'Inventory record added');
      setAddOpen(false);
      fetchInventory();
    }
    setAdding(false);
  };

  const openReceiveModal = async (inventoryId: string) => {
    const target = inventory.find((i) => i.id === inventoryId);
    if (!target) return;

    setSelectedId(inventoryId);
    setReceiveQty('');
    setReceivePOItemId('');

    const { data, error } = await supabase
      .from('purchase_order_items')
      .select('id, quantity_ordered, quantity_received, unit_cost, unit_size, product_id, purchase_order_id, purchase_orders!inner(po_number, status)')
      .eq('product_id', target.product_id)
      .in('purchase_orders.status', ['draft', 'submitted', 'partially_received']);

    if (!error && data) {
      const pos = data.map((item: any) => ({
        id: item.id,
        po_number: item.purchase_orders.po_number,
        ordered: item.quantity_ordered,
        received: item.quantity_received || 0,
        unit_cost: item.unit_cost || 0,
        purchase_order_id: item.purchase_order_id,
        product_id: item.product_id,
        unit_size: item.unit_size,
      }));
      setAvailablePOs(pos);
    } else {
      setAvailablePOs([]);
    }

    setReceiveOpen(true);
  };

  const handleReceive = async () => {
    const qty = parseInt(receiveQty);
    if (!qty || qty <= 0) {
      toast('error', 'Please enter a valid quantity');
      return;
    }

    if (!profile) return;

    if (!receivePOItemId) {
      toast('error', 'Please select a purchase order');
      return;
    }

    const selectedPO = availablePOs.find(po => po.id === receivePOItemId);
    if (!selectedPO) {
      toast('error', 'Invalid purchase order selection');
      return;
    }

    const newReceived = selectedPO.received + qty;
    if (newReceived > selectedPO.ordered) {
      toast('error', `Cannot receive more than ordered. Ordered: ${selectedPO.ordered}, Already received: ${selectedPO.received}`);
      return;
    }

    try {
      const idemKey = generateIdempotencyKey('receive_po_items', profile.id);
      const { error } = await supabase.rpc('receive_po_items', {
        p_items: [{ po_item_id: receivePOItemId, quantity: qty }],
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;

      toast('success', `Received ${qty} units`);
      setReceiveOpen(false);
      setReceiveQty('');
      setReceivePOItemId('');
      fetchInventory();
    } catch (error) {
      console.error('Error receiving inventory:', error);
      toast('error', 'Failed to receive inventory: ' + (error as any).message);
    }
  };

  const handleAdjust = async () => {
    const qty = parseInt(adjustQty);
    if (isNaN(qty) || qty === 0) {
      toast('error', 'Please enter a non-zero adjustment quantity');
      return;
    }
    if (!profile) return;

    try {
      const idemKey = generateIdempotencyKey('adjust_inventory', profile.id);
      const { error } = await supabase.rpc('adjust_inventory', {
        p_inventory_id: selectedId,
        p_delta: qty,
        p_reason: adjustNote || null,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;

      toast('success', `Adjusted by ${qty} units`);
      setAdjustOpen(false);
      setAdjustQty('');
      setAdjustNote('');
      fetchInventory();
    } catch (error) {
      console.error('Error adjusting inventory:', error);
      toast('error', 'Failed to adjust inventory: ' + (error as any).message);
    }
  };

  const handleDelete = async (inventoryId: string) => {
    const target = inventory.find((i) => i.id === inventoryId);
    if (!target) return;

    const { data: activeHolds } = await supabase
      .from('inventory_holds')
      .select('id')
      .eq('product_id', target.product_id)
      .eq('is_active', true)
      .limit(1);

    if (activeHolds && activeHolds.length > 0) {
      toast('error', 'Cannot delete: this product has active inventory holds. Release holds first.');
      return;
    }

    if (target.quantity_prebooked > 0) {
      toast('error', 'Cannot delete: this product has committed (prebooked) inventory from orders.');
      return;
    }

    const { data: pendingDeliveries } = await supabase
      .from('delivery_items')
      .select('id, delivery:deliveries!inner(status)')
      .eq('product_id', target.product_id)
      .in('delivery.status', ['scheduled', 'in_progress'])
      .limit(1);

    if (pendingDeliveries && pendingDeliveries.length > 0) {
      toast('error', 'Cannot delete: this product has pending deliveries.');
      return;
    }

    if (!confirm('Are you sure you want to delete this inventory item? This action cannot be undone.')) {
      return;
    }

    // Audit trail: log the deletion before removing the row
    if (profile) {
      await supabase.from('inventory_transactions').insert({
        product_id: target.product_id,
        transaction_type: 'adjusted',
        quantity: -(target.quantity_available || 0),
        to_location: target.location || 'Main Warehouse',
        performed_by: profile.id,
        notes: `Inventory record deleted (had ${target.quantity_available} available)`,
      });
    }

    const { error } = await supabase
      .from('inventory')
      .delete()
      .eq('id', inventoryId);

    if (error) {
      console.error('Failed to delete inventory:', error);
      toast('error', 'Failed to delete inventory item');
    } else {
      toast('success', 'Inventory item deleted');
      fetchInventory();
    }
  };

  const filtered = inventory.filter((i) => {
    if (locationFilter && i.location !== locationFilter) return false;
    return true;
  });

  const totalOnOrder = inventory.reduce((s, i) => s + i.quantity_on_order, 0);
  const totalOnFloor = inventory.reduce((s, i) => s + i.total_on_floor, 0);
  const totalFree = inventory.reduce((s, i) => s + i.free_qty, 0);
  const totalPlanned = inventory.reduce((s, i) => s + i.planned_qty, 0);
  const totalCommitted = inventory.reduce((s, i) => s + i.quantity_prebooked, 0);
  const totalDeliveredYTD = inventory.reduce((s, i) => s + i.delivered_ytd, 0);

  const netPositionColor = (n: number) => {
    if (n > 10) return 'text-emerald-600';
    if (n > 0) return 'text-amber-600';
    if (n === 0) return 'text-gray-500';
    return 'text-red-600';
  };

  const columns: Column<InventoryRow>[] = [
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
      render: (row) => (
        <span className="font-medium text-nav-dark">{row.product_name}</span>
      ),
    },
    {
      key: 'inventory_unit',
      header: 'Unit',
      sortable: true,
      render: (row) => (
        <span className="text-secondary text-xs">{row.inventory_unit || row.unit_size || '-'}</span>
      ),
    },
    {
      key: 'quantity_on_order',
      header: 'On Order',
      sortable: true,
      render: (row) => (
        <span className="text-teal-600 font-medium">{row.quantity_on_order}</span>
      ),
    },
    { key: 'total_on_floor', header: 'Total on Floor', sortable: true },
    {
      key: 'free_qty',
      header: 'Net Position',
      sortable: true,
      render: (row) => (
        <span className={`font-semibold ${netPositionColor(row.free_qty)}`}>
          {row.free_qty.toFixed(1)}
        </span>
      ),
    },
    {
      key: 'planned_qty',
      header: 'Planned',
      sortable: true,
      render: (row) => (
        <span className="text-amber-600 font-medium">{row.planned_qty.toFixed(1)}</span>
      ),
    },
    {
      key: 'quantity_prebooked',
      header: 'Committed',
      sortable: true,
      render: (row) => (
        <span className="text-orange-600 font-medium">{row.quantity_prebooked}</span>
      ),
    },
    {
      key: 'delivered_ytd',
      header: 'Delivered YTD',
      sortable: true,
      render: (row) => (
        <span className="text-gray-500">{row.delivered_ytd.toFixed(1)}</span>
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
                  onClick={(e) => { e.stopPropagation(); openReceiveModal(row.id); }}
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
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(row.id); }}
                  className="p-1.5 rounded hover:bg-red-50 text-red-600"
                  title="Delete Inventory Item"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ),
          } satisfies Column<InventoryRow>,
        ]
      : []),
  ];

  const summaryCards = [
    { label: 'On Order', value: totalOnOrder, color: 'bg-teal-50 text-teal-600', icon: Package },
    { label: 'Total on Floor', value: totalOnFloor, color: 'bg-blue-50 text-blue-600', icon: Package },
    { label: 'Net Position', value: totalFree, color: totalFree >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600', icon: Package },
    { label: 'Planned', value: totalPlanned, color: 'bg-amber-50 text-amber-600', icon: Package },
    { label: 'Committed', value: totalCommitted, color: 'bg-orange-50 text-orange-600', icon: Package },
    { label: 'Delivered YTD', value: totalDeliveredYTD, color: 'bg-gray-50 text-gray-600', icon: Package },
  ];

  const filteredProducts = products.filter((p) =>
    !productSearch || p.product_name.toLowerCase().includes(productSearch.toLowerCase())
  );

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end gap-2">
          <Button icon={<Plus className="w-4 h-4" />} onClick={openHoldModal} variant="secondary">
            Create Hold
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={openAddModal}>
            Add Inventory
          </Button>
        </div>
      )}


      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {summaryCards.map((c) => (
          <Card key={c.label}>
            <div className={`w-10 h-10 rounded-lg ${c.color} flex items-center justify-center mb-3`}>
              <c.icon className="w-5 h-5" />
            </div>
            <p className="text-xs text-secondary">{c.label}</p>
            <p className="text-2xl font-semibold font-heading text-nav-dark">
              {c.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}
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

      {/* Active Holds Panel */}
      {holds.length > 0 && (
        <Card>
          <button
            onClick={() => setHoldsExpanded(!holdsExpanded)}
            className="w-full flex items-center justify-between text-left"
          >
            <h3 className="text-lg font-semibold text-nav-dark">
              Active Holds ({holds.length} {holds.length === 1 ? 'hold' : 'holds'})
            </h3>
            {holdsExpanded ? <ChevronUp className="w-5 h-5 text-secondary" /> : <ChevronDown className="w-5 h-5 text-secondary" />}
          </button>

          {holdsExpanded && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 px-3 font-medium text-secondary">Product</th>
                    <th className="text-left py-2 px-3 font-medium text-secondary">Qty</th>
                    <th className="text-left py-2 px-3 font-medium text-secondary">Customer</th>
                    <th className="text-left py-2 px-3 font-medium text-secondary">Type</th>
                    <th className="text-left py-2 px-3 font-medium text-secondary">Notes</th>
                    <th className="text-left py-2 px-3 font-medium text-secondary">Expires</th>
                    <th className="text-left py-2 px-3 font-medium text-secondary">Created By</th>
                    {isAdmin && <th className="text-left py-2 px-3 font-medium text-secondary">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {holds.map((hold) => (
                    <tr key={hold.id} className="border-b border-gray-100 last:border-0">
                      <td className="py-3 px-3 font-medium text-nav-dark">{hold.product_name}</td>
                      <td className="py-3 px-3 text-amber-600 font-medium">{hold.quantity}</td>
                      <td className="py-3 px-3 text-secondary">{hold.customer_name || '—'}</td>
                      <td className="py-3 px-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          hold.hold_type === 'manual' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                        }`}>
                          {hold.hold_type === 'manual' ? 'Manual' : 'Program'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-secondary text-xs max-w-xs truncate">{hold.notes || '—'}</td>
                      <td className="py-3 px-3 text-secondary text-xs">
                        {hold.expires_at ? new Date(hold.expires_at).toLocaleDateString() : 'No expiration'}
                      </td>
                      <td className="py-3 px-3 text-secondary text-xs">{hold.creator_name}</td>
                      {isAdmin && (
                        <td className="py-3 px-3">
                          <button
                            onClick={() => handleReleaseHold(hold.id)}
                            className="text-xs text-red-600 hover:text-red-700 font-medium"
                          >
                            Release
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Create Hold Modal */}
      <Modal open={holdOpen} onClose={() => setHoldOpen(false)} title="Create" accent="Hold">
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
                      setHoldProductId(p.id);
                      setHoldWarning('');
                    }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0 ${
                      holdProductId === p.id ? 'bg-crx-green/10 text-crx-green font-medium' : 'text-nav-dark'
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
            label="Quantity"
            type="number"
            min="0"
            step="0.1"
            value={holdQty}
            onChange={(e) => {
              setHoldQty(e.target.value);
              setHoldWarning('');
            }}
          />

          {holdWarning && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-800">{holdWarning}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Customer (Optional)</label>
            <select
              value={holdCustomerId}
              onChange={(e) => setHoldCustomerId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">No customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>

          <Input
            label="Notes (Optional)"
            value={holdNotes}
            onChange={(e) => setHoldNotes(e.target.value)}
            placeholder="e.g., Holding for spring burndown"
          />

          <Input
            label="Expiration Date (Optional)"
            type="date"
            value={holdExpires}
            onChange={(e) => setHoldExpires(e.target.value)}
          />

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setHoldOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateHold}>Create Hold</Button>
          </div>
        </div>
      </Modal>

      {/* Add Inventory Modal */}
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

      {/* Receive Modal */}
      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Receive" accent="Shipment">
        <div className="space-y-4">
          {availablePOs.length === 0 ? (
            <div className="text-amber-600 text-sm bg-amber-50 p-3 rounded">
              No open purchase orders found for this product. Create a purchase order first.
            </div>
          ) : (
            <>
              <Select
                label="Purchase Order"
                value={receivePOItemId}
                onChange={(e) => setReceivePOItemId(e.target.value)}
                required
                placeholder="Select a PO..."
                options={availablePOs.map((po) => ({
                  value: po.id,
                  label: `${po.po_number} - Ordered: ${po.ordered}, Received: ${po.received}, Remaining: ${po.ordered - po.received}`,
                }))}
              />
              <Input
                label="Quantity Received"
                type="number"
                min="1"
                value={receiveQty}
                onChange={(e) => setReceiveQty(e.target.value)}
              />
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReceiveOpen(false)}>Cancel</Button>
            {availablePOs.length > 0 && (
              <Button onClick={handleReceive}>Receive</Button>
            )}
          </div>
        </div>
      </Modal>

      {/* Adjust Modal */}
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
