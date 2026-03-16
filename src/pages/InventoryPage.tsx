import { useEffect, useState , useCallback } from 'react';
import { Package, ArrowDownToLine, Pencil, Plus, AlertTriangle, ChevronDown, ChevronUp, Trash2, Download, FileText, TrendingUp } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EditableDataTable, { type EditableColumn } from '../components/ui/EditableDataTable';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult, sanitizeError } from '../lib/db';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { computeSeason } from '../utils/season';
import TransactionLedgerModal from '../components/inventory/TransactionLedgerModal';
import BatchAdjustModal from '../components/inventory/BatchAdjustModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import type { Inventory, Product, InventoryHold, Customer } from '../types';

interface InventoryRow extends Inventory {
  product_name: string;
  inventory_unit: string | null;
  container_size: number | null;
  container_type: string | null;
  vendor: string | null;
  current_cost: number | null;
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
  const receivePoIdem = useIdempotencyKey('receive_po_items', profile?.id || '');
  const adjustIdem = useIdempotencyKey('adjust_inventory', profile?.id || '');
  const { toast } = useToast();
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [holds, setHolds] = useState<HoldWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [locationFilter, setLocationFilter] = useState('');
  const [locations, setLocations] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'inventory' | 'forecast'>('inventory');
  const [forecastData, setForecastData] = useState<Array<{
    product_id: string; product_name: string; sku: string | null;
    needed_month: string; planned_demand: number; current_available: number;
    prebooked: number; on_order: number; quote_count: number; customer_count: number;
  }>>([]);
  const [forecastLoading, setForecastLoading] = useState(false);

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
  const [addUnitCost, setAddUnitCost] = useState('');
  const [adding, setAdding] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [holdsExpanded, setHoldsExpanded] = useState(true);

  // Transaction ledger modal
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerProductId, setLedgerProductId] = useState('');
  const [ledgerProductName, setLedgerProductName] = useState('');

  // Reorder filter chip
  const [reorderFilter, setReorderFilter] = useState(false);

  // Batch adjust
  const [batchAdjustOpen, setBatchAdjustOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Delete confirm modal
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const isAdmin = role === 'admin';
  const [exportingPdf, setExportingPdf] = useState(false);

  const handleExportCSV = () => {
    exportToCSV(filtered as unknown as Record<string, unknown>[], [
      { key: 'product_name', header: 'Product' },
      { key: 'inventory_unit', header: 'Unit' },
      { key: 'quantity_on_order', header: 'On Order' },
      { key: 'total_on_floor', header: 'Total on Floor' },
      { key: 'free_qty', header: 'Net Position' },
      { key: 'planned_qty', header: 'Planned' },
      { key: 'quantity_prebooked', header: 'Committed' },
      { key: 'delivered_ytd', header: 'Delivered YTD' },
      { key: 'location', header: 'Location' },
    ], 'inventory');
    toast('success', `Exported ${filtered.length} inventory row(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExportingPdf(true);
    try {
      await downloadReportPdf({
        title: 'Inventory',
        subtitle: `${filtered.length} product(s)`,
        columns: [
          { header: 'Product', key: 'product_name' },
          { header: 'Unit', key: 'inventory_unit', format: (v) => v ? String(v) : '-' },
          { header: 'On Order', key: 'quantity_on_order', align: 'right' },
          { header: 'On Floor', key: 'total_on_floor', align: 'right' },
          { header: 'Net', key: 'free_qty', align: 'right', format: (v) => v != null ? Number(v).toFixed(1) : '-' },
          { header: 'Committed', key: 'quantity_prebooked', align: 'right' },
        ],
        data: filtered as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${filtered.length} product(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExportingPdf(false);
  };

  const fetchInventory = useCallback(async () => {
    const { data, error } = await supabase
      .from('inventory')
      .select('*, product:products!inner(product_name, inventory_unit, container_size, container_type, vendor, current_cost, is_active)')
      .order('product_id');

    if (error) {
      console.error('Failed to load inventory:', error.message);
      toast('error', 'Failed to load inventory. Please try again.');
      setLoading(false);
      return;
    }

    // H9: !inner join already excludes inventory rows with no matching product;
    // also filter out soft-deactivated products (is_active = false).
    const allRows = (data || []) as Array<Inventory & { product: { product_name: string; inventory_unit: string | null; container_size: number | null; container_type: string | null; vendor: string | null; current_cost: number | null; is_active: boolean } | null; reorder_point: number; min_stock_level: number }>;
    const rawRows = allRows.filter((r) => r.product?.is_active !== false);

    const holdsFetch = supabase
      .from('inventory_holds')
      .select('product_id, quantity')
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gte.${localToday()}`);

    const poFetch = supabase
      .from('purchase_order_items')
      .select('product_id, quantity_ordered, quantity_received, purchase_orders!inner(status)')
      .in('purchase_orders.status', ['submitted', 'partially_received']);

    const quoteFetch = supabase
      .from('quote_items')
      .select('product_id, total_units_needed, quote:quotes!inner(is_planned, status)')
      .eq('quote.is_planned', true)
      .in('quote.status', ['draft', 'sent', 'revised']);

    const now = new Date();
    const season = computeSeason(now);
    const seasonStart = new Date(season - 1, 9, 1); // Oct 1

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

    const onOrderByProduct = (poRes.data || []).reduce((acc, poi: { product_id: string; quantity_ordered: number; quantity_received: number }) => {
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
      item: { id: string; product_id: string; quantity_available: number; quantity_prebooked: number; location: string; unit_size: string | null; product_name: string; inventory_unit?: string | null; container_size?: number | null; container_type?: string | null; vendor?: string | null; current_cost?: number | null; reorder_point: number; min_stock_level: number },
    ): InventoryRow => {
      const onOrderQty = onOrderByProduct[item.product_id] || 0;
      const totalOnFloor = item.quantity_available; // physical stock only; prebooked is a sub-count within available, not separate
      const plannedQty = (holdsByProduct[item.product_id] || 0) + (plannedByProduct[item.product_id] || 0);
      // Net Position = (supply) - (demand)
      // Supply  = on_order (coming in) + quantity_available (physical stock on floor)
      // Demand  = planned (holds + planned quotes) + committed (prebooked orders)
      const freeQty = onOrderQty + item.quantity_available - item.quantity_prebooked - plannedQty;
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
        vendor: item.vendor || null,
        current_cost: item.current_cost || null,
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
          vendor: item.product?.vendor || null,
          current_cost: item.product?.current_cost || null,
          reorder_point: item.reorder_point || 0,
          min_stock_level: item.min_stock_level || 0,
        },
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
          vendor: null,
          current_cost: null,
          reorder_point: 0,
          min_stock_level: 0,
        },
      )
    );

    const rows = [...existingRows, ...virtualRows];

    const locs = [...new Set(rows.map((r) => r.location).filter(Boolean))];
    setLocations(locs.sort());
    setInventory(rows);
    setLoading(false);
  }, [toast]);

  const fetchHolds = useCallback(async () => {
    const { data, error } = await supabase
      .from('inventory_holds')
      .select(`
        *,
        product:products(product_name),
        customer:customers(farm_name),
        creator:profiles!inventory_holds_created_by_fkey(full_name)
      `)
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gte.${localToday()}`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to load holds:', error.message);
      return;
    }

    const holdRows = (data || []).map((h: Record<string, unknown> & { product?: { product_name: string }; customer?: { farm_name: string }; creator?: { full_name: string } }) => ({
      ...h,
      product_name: h.product?.product_name || 'Unknown',
      customer_name: h.customer?.farm_name || null,
      creator_name: h.creator?.full_name || 'Unknown',
    })) as HoldWithRelations[];

    setHolds(holdRows);
  }, []);

  useEffect(() => {
    fetchInventory();
    fetchHolds();
  }, [fetchInventory, fetchHolds]);

  const fetchForecast = useCallback(async () => {
    setForecastLoading(true);
    const { data, error } = await supabase.rpc('get_inventory_forecast', { p_months_ahead: 6 });
    if (error) {
      console.error('Failed to load forecast:', error.message);
      toast('error', 'Failed to load forecast data');
    } else if (data) {
      setForecastData(data as typeof forecastData);
    }
    setForecastLoading(false);
  }, [toast]);

  useEffect(() => {
    if (activeTab === 'forecast' && forecastData.length === 0) fetchForecast();
  }, [activeTab, forecastData.length, fetchForecast]);

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
    setAddUnitCost('');
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

  const [creatingHold, setCreatingHold] = useState(false);
  const [releasingHoldId, setReleasingHoldId] = useState<string | null>(null);

  const handleCreateHold = async () => {
    if (creatingHold) return;
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

    setCreatingHold(true);
    const holdResult = await supabase.from('inventory_holds').insert({
      product_id: holdProductId,
      customer_id: holdCustomerId || null,
      quantity: qty,
      hold_type: 'manual',
      notes: holdNotes || null,
      created_by: profile.id,
      expires_at: holdExpires || null,
    });

    if (holdResult.error) {
      toast('error', sanitizeError(holdResult.error));
    } else {
      checkMutationResult(holdResult, 'Insert inventory hold');
      toast('success', 'Hold created successfully');
      setHoldOpen(false);
      fetchInventory();
      fetchHolds();
    }
    setCreatingHold(false);
  };

  const handleReleaseHold = async (holdId: string) => {
    setReleasingHoldId(holdId);
    try {
      const { error } = await supabase.rpc('release_inventory_hold', {
        p_hold_id: holdId,
        p_performed_by: profile?.id,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;

      toast('success', 'Hold released');
      fetchInventory();
      fetchHolds();
    } catch (error: unknown) {
      toast('error', sanitizeError(error));
    } finally {
      setReleasingHoldId(null);
    }
  };

  const handleAdd = async () => {
    if (!addProductId) {
      toast('error', 'Please select a product');
      return;
    }
    const qty = parseFloat(addQty) || 0;
    if (qty <= 0) {
      toast('error', 'Quantity must be greater than 0');
      return;
    }
    setAdding(true);

    const unitCost = addUnitCost ? parseFloat(addUnitCost) : null;
    const { error } = await supabase.rpc('manual_inventory_add', {
      p_product_id: addProductId,
      p_location: addLocation || 'Main Warehouse',
      p_quantity: qty,
      p_unit_size: addUnitSize || null,
      p_performed_by: profile?.id || null,
      p_notes: qty > 0 ? `Initial inventory record created with ${qty} units` : null,
      p_unit_cost: unitCost && unitCost > 0 ? unitCost : null,
      p_idempotency_key: crypto.randomUUID(),
    });

    if (error) {
      toast('error', sanitizeError(error));
    } else {
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
      .in('purchase_orders.status', ['submitted', 'partially_received']);

    if (!error && data) {
      const pos = (data as unknown as Array<{ id: string; quantity_ordered: number; quantity_received: number; unit_cost: number; unit_size: string | null; product_id: string; purchase_order_id: string; purchase_orders: { po_number: string; status: string } }>).map((item) => ({
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
    const qty = parseFloat(receiveQty);
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
      const idemKey = receivePoIdem.getKey();
      const { error } = await supabase.rpc('receive_po_items', {
        p_items: [{ po_item_id: receivePOItemId, quantity: qty }],
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;

      receivePoIdem.resetKey();
      toast('success', `Received ${qty} units`);
      setReceiveOpen(false);
      setReceiveQty('');
      setReceivePOItemId('');
      fetchInventory();
    } catch (error) {
      console.error('Error receiving inventory:', error);
      toast('error', 'Failed to receive inventory: ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  const handleAdjust = async () => {
    const qty = parseFloat(adjustQty);
    if (isNaN(qty) || qty === 0) {
      toast('error', 'Please enter a non-zero adjustment quantity');
      return;
    }
    if (!profile) return;

    try {
      const idemKey = adjustIdem.getKey();
      const { error } = await supabase.rpc('adjust_inventory', {
        p_inventory_id: selectedId,
        p_delta: qty,
        p_reason: adjustNote || null,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;

      adjustIdem.resetKey();
      toast('success', `Adjusted by ${qty} units`);
      setAdjustOpen(false);
      setAdjustQty('');
      setAdjustNote('');
      fetchInventory();
    } catch (error) {
      console.error('Error adjusting inventory:', error);
      toast('error', 'Failed to adjust inventory: ' + (error instanceof Error ? error.message : String(error)));
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

    // Passed all safety checks — show confirm modal
    setDeleteConfirmId(inventoryId);
  };

  const executeDelete = async () => {
    if (!deleteConfirmId) return;
    const target = inventory.find((i) => i.id === deleteConfirmId);
    if (!target) return;

    // Audit trail: log the deletion before removing the row
    if (profile) {
      const { error: auditErr } = await supabase.from('inventory_transactions').insert({
        product_id: target.product_id,
        transaction_type: 'adjusted',
        quantity: -(target.quantity_available || 0),
        to_location: target.location || 'Main Warehouse',
        performed_by: profile.id,
        notes: `Inventory record deleted (had ${target.quantity_available} available)`,
      });
      if (auditErr) {
        toast('error', 'Failed to create audit trail — delete aborted');
        setDeleteConfirmId(null);
        return;
      }
    }

    try {
      const deleteResult = await supabase
        .from('inventory')
        .delete()
        .eq('id', deleteConfirmId)
        .select();
      checkMutationResult(deleteResult, 'Delete inventory item');

      toast('success', 'Inventory item deleted');
      fetchInventory();
    } catch (error: unknown) {
      console.error('Failed to delete inventory:', error);
      toast('error', sanitizeError(error));
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const filtered = inventory.filter((i) => {
    if (locationFilter && i.location !== locationFilter) return false;
    if (reorderFilter && !i.is_low_stock) return false;
    return true;
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalOnOrder = inventory.reduce((s, i) => s + i.quantity_on_order, 0);
  const totalOnFloor = inventory.reduce((s, i) => s + i.total_on_floor, 0);
  const totalFree = inventory.reduce((s, i) => s + i.free_qty, 0);
  const totalPlanned = inventory.reduce((s, i) => s + i.planned_qty, 0);
  const totalCommitted = inventory.reduce((s, i) => s + i.quantity_prebooked, 0);
  const totalDeliveredYTD = inventory.reduce((s, i) => s + i.delivered_ytd, 0);
  const totalValuation = inventory.reduce((sum, r) => sum + (r.quantity_available * (r.current_cost || 0)), 0);

  const netPositionColor = (n: number) => {
    if (n > 10) return 'text-emerald-600';
    if (n > 0) return 'text-amber-600';
    if (n === 0) return 'text-gray-500';
    return 'text-red-600';
  };

  const locationOptions = locations.map((l) => ({ value: l, label: l }));

  const handleBulkSave = async (changes: Map<string, Record<string, unknown>>) => {
    try {
      for (const [inventoryId, fields] of changes) {
        // Skip virtual rows (they don't have real DB records)
        if (inventoryId.startsWith('virtual-')) {
          continue;
        }

        const result = await supabase
          .from('inventory')
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq('id', inventoryId)
          .select();
        checkMutationResult(result, 'Update inventory item');
      }

      const realChanges = [...changes.keys()].filter((k) => !k.startsWith('virtual-')).length;
      toast('success', `Updated ${realChanges} inventory item(s)`);
      if (profile) {
        logActivity('inventory_bulk_updated', `${realChanges} inventory item(s) updated via inline edit`, profile.id, 'inventory', undefined);
      }
      fetchInventory();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
      throw err;
    }
  };

  const columns: EditableColumn<InventoryRow>[] = [
    ...(isAdmin ? [{
      key: '_select' as const,
      header: '',
      sortable: false,
      className: 'w-10',
      render: (row: InventoryRow) => (
        <input
          type="checkbox"
          checked={selectedIds.has(row.id)}
          onChange={() => toggleSelect(row.id)}
          className="rounded border-gray-300"
        />
      ),
    } satisfies EditableColumn<InventoryRow>] : []),
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1">
          <span className="font-medium text-nav-dark">{row.product_name}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setLedgerProductId(row.product_id);
              setLedgerProductName(row.product_name);
              setLedgerOpen(true);
            }}
            className="p-0.5 rounded hover:bg-gray-100 text-secondary hover:text-nav-dark transition-colors"
            title="View transaction history"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
        </div>
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
    ...(isAdmin ? [
      {
        key: 'current_cost' as const,
        header: 'Unit Cost',
        sortable: true,
        className: 'text-right',
        render: (row: InventoryRow) => (
          <span className="text-sm text-secondary">
            {row.current_cost != null ? `$${Number(row.current_cost).toFixed(2)}` : '-'}
          </span>
        ),
      },
      {
        key: '_total_value' as const,
        header: 'Value',
        sortable: true,
        className: 'text-right',
        render: (row: InventoryRow) => {
          const val = (row.current_cost || 0) * row.quantity_available;
          return (
            <span className="text-sm font-medium text-nav-dark">
              {row.current_cost != null ? `$${val.toFixed(2)}` : '-'}
            </span>
          );
        },
      },
    ] as EditableColumn<InventoryRow>[] : []),
    {
      key: 'location',
      header: 'Location',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editOptions: locationOptions,
    },
    {
      key: 'reorder_point',
      header: 'Reorder Pt',
      sortable: true,
      editable: isAdmin,
      editType: 'number',
      editMin: 0,
      editStep: '1',
      render: (row) => (
        <span className={`font-mono text-sm ${row.is_low_stock ? 'text-red-600 font-semibold' : ''}`}>
          {row.reorder_point || '-'}
        </span>
      ),
    },
    {
      key: 'min_stock_level',
      header: 'Min Stock',
      sortable: true,
      editable: isAdmin,
      editType: 'number',
      editMin: 0,
      editStep: '1',
      render: (row) => (
        <span className="font-mono text-sm">{row.min_stock_level || '-'}</span>
      ),
    },
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
          } satisfies EditableColumn<InventoryRow>,
        ]
      : []),
  ];

  const summaryCards: Array<{ label: string; value: number; color: string; icon: typeof Package; format?: 'currency' }> = [
    { label: 'On Order', value: totalOnOrder, color: 'bg-teal-50 text-teal-600', icon: Package },
    { label: 'Total on Floor', value: totalOnFloor, color: 'bg-blue-50 text-blue-600', icon: Package },
    { label: 'Net Position', value: totalFree, color: totalFree >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600', icon: Package },
    { label: 'Planned', value: totalPlanned, color: 'bg-amber-50 text-amber-600', icon: Package },
    { label: 'Committed', value: totalCommitted, color: 'bg-orange-50 text-orange-600', icon: Package },
    { label: 'Delivered YTD', value: totalDeliveredYTD, color: 'bg-gray-50 text-gray-600', icon: Package },
    { label: 'Inventory Value', value: totalValuation, color: 'bg-emerald-50 text-emerald-600', icon: Package, format: 'currency' },
  ];

  const filteredProducts = products.filter((p) =>
    !productSearch || p.product_name.toLowerCase().includes(productSearch.toLowerCase())
  );

  return (
    <div className="space-y-4">
      {/* Tab Selector */}
      <div className="flex gap-1 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('inventory')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'inventory' ? 'border-crx-green text-crx-green' : 'border-transparent text-secondary hover:text-nav-dark'}`}
        >
          <Package className="w-4 h-4 inline mr-1.5" />
          Inventory
        </button>
        <button
          onClick={() => setActiveTab('forecast')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'forecast' ? 'border-crx-green text-crx-green' : 'border-transparent text-secondary hover:text-nav-dark'}`}
        >
          <TrendingUp className="w-4 h-4 inline mr-1.5" />
          Forecast
        </button>
      </div>

      {activeTab === 'inventory' && (<>
      <div className="flex justify-end gap-2 flex-wrap">
        <Button variant="secondary" size="sm" icon={<Download className="w-4 h-4" />} onClick={handleExportCSV}>
          Export CSV
        </Button>
        <Button variant="secondary" size="sm" icon={<FileText className="w-4 h-4" />} onClick={handleExportPDF} loading={exportingPdf}>
          Download PDF
        </Button>
        {isAdmin && selectedIds.size > 0 && (
          <Button
            variant="secondary"
            icon={<Pencil className="w-4 h-4" />}
            onClick={() => setBatchAdjustOpen(true)}
          >
            Adjust {selectedIds.size} Selected
          </Button>
        )}
        {isAdmin && (
          <>
            <Button icon={<Plus className="w-4 h-4" />} onClick={openHoldModal} variant="secondary">
              Create Hold
            </Button>
            <Button icon={<Plus className="w-4 h-4" />} onClick={openAddModal}>
              Add Inventory
            </Button>
          </>
        )}
      </div>


      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3 sm:gap-4">
        {summaryCards.map((c) => (
          <Card key={c.label}>
            <div className={`w-10 h-10 rounded-lg ${c.color} flex items-center justify-center mb-3`}>
              <c.icon className="w-5 h-5" />
            </div>
            <p className="text-xs text-secondary">{c.label}</p>
            <p className="text-2xl font-semibold font-heading text-nav-dark">
              {c.format === 'currency'
                ? `$${c.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : c.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            </p>
          </Card>
        ))}
      </div>

      {/* Enhanced Reorder Alerts — grouped by vendor */}
      {(() => {
        const lowStockItems = inventory.filter((i) => i.is_low_stock);
        if (lowStockItems.length === 0) return null;

        // Group by vendor
        const byVendor = new Map<string, InventoryRow[]>();
        for (const item of lowStockItems) {
          const vendor = item.vendor || 'No Vendor';
          const group = byVendor.get(vendor) || [];
          group.push(item);
          byVendor.set(vendor, group);
        }
        const vendorGroups = [...byVendor.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        return (
          <Card>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center">
                <AlertTriangle className="w-4 h-4 text-red-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-red-700">
                  ACTION REQUIRED — {lowStockItems.length} Product{lowStockItems.length !== 1 ? 's' : ''} Need Reordering
                </h3>
                <p className="text-xs text-secondary">
                  {vendorGroups.length} vendor{vendorGroups.length !== 1 ? 's' : ''} affected
                </p>
              </div>
            </div>

            {vendorGroups.map(([vendor, items]) => (
              <div key={vendor} className="mt-4">
                <p className="text-sm font-semibold text-nav-dark mb-2 border-b border-gray-200 pb-1">
                  {vendor} ({items.length})
                </p>
                <div className="space-y-2">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-3 bg-red-50 border border-red-100 rounded-lg"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-nav-dark truncate">{item.product_name}</p>
                        <p className="text-xs text-secondary">
                          {item.location || 'No location'} &middot; Unit: {item.inventory_unit || item.unit_size || '-'}
                        </p>
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div className="text-center">
                          <p className="text-xs text-secondary">Available</p>
                          <p className="font-semibold text-red-600">{item.quantity_available}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-secondary">Reorder Pt</p>
                          <p className="font-semibold text-nav-dark">{item.reorder_point}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-secondary">On Order</p>
                          <p className="font-semibold text-teal-600">{item.quantity_on_order}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-secondary">Shortfall</p>
                          <p className="font-semibold text-red-600">
                            {Math.max(0, item.reorder_point - item.quantity_available - item.quantity_on_order)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </Card>
        );
      })()}

      <Card padding={false}>
        <div className="p-5">
          <EditableDataTable<InventoryRow>
            data={filtered}
            columns={columns}
            rowKey="id"
            searchable
            searchPlaceholder="Search products..."
            searchKeys={['product_name']}
            emptyTitle="No inventory records"
            emptyDescription="Inventory will appear as products are stocked"
            loading={loading}
            canEdit={isAdmin}
            onSave={handleBulkSave}
            filters={
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={locationFilter}
                  onChange={(e) => setLocationFilter(e.target.value)}
                  aria-label="Filter by location"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Locations</option>
                  {locations.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <button
                  onClick={() => setReorderFilter(!reorderFilter)}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    reorderFilter
                      ? 'bg-red-50 border-red-200 text-red-700 font-medium'
                      : 'border-gray-200 text-secondary hover:border-red-200 hover:text-red-600'
                  }`}
                >
                  Needs Reorder
                  {(() => {
                    const count = inventory.filter((i) => i.is_low_stock).length;
                    return count > 0 ? (
                      <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${
                        reorderFilter ? 'bg-red-200 text-red-800' : 'bg-red-100 text-red-600'
                      }`}>
                        {count}
                      </span>
                    ) : null;
                  })()}
                </button>
              </div>
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
                        {hold.expires_at ? parseLocalDate(hold.expires_at).toLocaleDateString() : 'No expiration'}
                      </td>
                      <td className="py-3 px-3 text-secondary text-xs">{hold.creator_name}</td>
                      {isAdmin && (
                        <td className="py-3 px-3">
                          <button
                            onClick={() => handleReleaseHold(hold.id)}
                            disabled={releasingHoldId === hold.id}
                            className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                          >
                            {releasingHoldId === hold.id ? 'Releasing...' : 'Release'}
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
      </>)}

      {/* Forecast Tab */}
      {activeTab === 'forecast' && (
        <Card>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-nav-dark">Planned Demand Forecast</h3>
              <Button variant="secondary" size="sm" onClick={fetchForecast} loading={forecastLoading}>
                Refresh
              </Button>
            </div>
            {forecastLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : forecastData.length === 0 ? (
              <p className="text-sm text-secondary py-8 text-center">
                No planned demand data. Create planned programs (quotes with inventory holds) to see forecasts here.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                        <th className="px-4 py-3 text-left font-medium text-secondary">Needed</th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">Planned Demand</th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">Available</th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">On Order</th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">Gap</th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">Quotes</th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">Customers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forecastData.map((row, idx) => {
                        const gap = row.planned_demand - (row.current_available + row.on_order - row.prebooked);
                        return (
                          <tr key={idx} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="px-4 py-3 font-medium text-nav-dark">{row.product_name}</td>
                            <td className="px-4 py-3 text-secondary">
                              {new Date(row.needed_month + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                            </td>
                            <td className="px-4 py-3 text-right font-mono">{row.planned_demand.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right font-mono">{row.current_available.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right font-mono text-teal-600">{row.on_order.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right font-mono">
                              <span className={gap > 0 ? 'text-red-600 font-bold' : 'text-crx-green'}>
                                {gap > 0 ? `-${gap.toLocaleString()}` : 'OK'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">{row.quote_count}</td>
                            <td className="px-4 py-3 text-right">{row.customer_count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {forecastData.some((f) => f.planned_demand > (f.current_available + f.on_order - f.prebooked)) && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                    <AlertTriangle className="w-4 h-4 inline mr-2" />
                    Some products have demand exceeding available supply. Consider placing purchase orders.
                  </div>
                )}
              </>
            )}
          </div>
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
            <Button onClick={handleCreateHold} loading={creatingHold}>Create Hold</Button>
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
            step="any"
            value={addQty}
            onChange={(e) => setAddQty(e.target.value)}
          />
          <Input
            label="Unit Size"
            value={addUnitSize}
            onChange={(e) => setAddUnitSize(e.target.value)}
            placeholder="e.g. Gal, Qt, Lb"
          />
          <div>
            <Input
              label="Unit Cost (optional)"
              type="number"
              min="0"
              step="0.01"
              value={addUnitCost}
              onChange={(e) => setAddUnitCost(e.target.value)}
              placeholder="e.g. 12.50"
            />
            <p className="text-xs text-secondary mt-1">
              For record-keeping only — does not change the product's pricing or cost.
            </p>
          </div>
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
                min="0"
                step="any"
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
            step="any"
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

      <TransactionLedgerModal
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        productId={ledgerProductId}
        productName={ledgerProductName}
      />

      <BatchAdjustModal
        open={batchAdjustOpen}
        onClose={() => setBatchAdjustOpen(false)}
        items={inventory.filter((r) => selectedIds.has(r.id)).map((r) => ({
          id: r.id,
          product_id: r.product_id,
          product_name: r.product_name,
          quantity_available: r.quantity_available,
        }))}
        userId={profile?.id || ''}
        onSuccess={() => {
          setSelectedIds(new Set());
          fetchInventory();
        }}
      />

      <ConfirmModal
        open={deleteConfirmId !== null}
        onClose={() => setDeleteConfirmId(null)}
        onConfirm={executeDelete}
        title="Delete Inventory Item"
        message="Are you sure you want to delete this inventory item? This action cannot be undone and will be recorded in the audit log."
        confirmLabel="Delete Item"
        variant="danger"
        icon={Trash2}
      />
    </div>
  );
}
