import { useEffect, useState , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, ArrowDownToLine, Pencil, Plus, AlertTriangle, ChevronDown, ChevronUp, Trash2, Download, FileText, TrendingUp, ShoppingCart } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EditableDataTable, { type EditableColumn } from '../components/ui/EditableDataTable';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult, sanitizeError, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { validateInventoryPositionShape } from '../lib/inventoryPositionValidator';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import {
  UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE,
  UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE,
  useUncertainMutationIntent,
} from '../hooks/useUncertainMutationIntent';
import { getIdempotencyMismatchResult } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import TransactionLedgerModal from '../components/inventory/TransactionLedgerModal';
import BatchAdjustModal from '../components/inventory/BatchAdjustModal';
import InventoryPositionMobileCards from '../components/inventory/InventoryPositionMobileCards';
import ConfirmModal from '../components/ui/ConfirmModal';
import ReasonModal from '../components/ui/ReasonModal';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import { SkeletonTable, SkeletonCard } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import Tabs from '../components/ui/Tabs';
import type { Inventory, InventoryPositionRow, Product, InventoryHold, Customer } from '../types';
import type { ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import { ProductSearchResultRow } from '../components/products/ProductSearchResultRow';

type PickerProduct = Product & ProductOptionPresentationModel;

interface InventoryRow extends Inventory {
  product_name: string;
  inventory_unit: string | null;
  container_size: number | null;
  container_type: string | null;
  vendor: string | null;
  current_cost: number | null;
  total_on_floor: number;
  holds_qty: number;
  // total_planned_qty = holds_qty + RPC planned_qty (planned-quote demand).
  // Renamed away from `planned_qty` to avoid confusion with the RPC field of
  // the same name, which represents only the planned-quote-demand subset.
  total_planned_qty: number;
  net_position: number;
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
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const receivePoIntent = useUncertainMutationIntent<{
    items: Array<{ po_item_id: string; quantity: number }>;
    performedBy: string;
    quantity: number;
    inventoryId: string;
    selectedPO: {
      id: string;
      po_number: string;
      ordered: number;
      received: number;
      unit_cost: number;
      purchase_order_id: string;
      product_id: string;
      unit_size: string | null;
    };
  }>({
    operation: 'receive_po_items',
    userId: profile?.id || '',
    surface: 'inventory-page',
    getIntentIdentity: (intent) => ({
      p_items: intent.items,
      p_performed_by: intent.performedBy,
      p_allow_over_receive: false,
    }),
  });
  const adjustIdem = useIdempotencyKey('adjust_inventory', profile?.id || '');
  const retireIdem = useIdempotencyKey('retire_inventory_item', profile?.id || '');
  const createHoldIdem = useIdempotencyKey('create_inventory_hold', profile?.id || '');
  const releaseHoldIdem = useIdempotencyKey('release_inventory_hold', profile?.id || '');
  const manualAddIdem = useIdempotencyKey('manual_inventory_add', profile?.id || '');
  const { toast } = useToast();
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [holds, setHolds] = useState<HoldWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [locationFilter, setLocationFilter] = useState('');
  const [mobileSearch, setMobileSearch] = useState('');
  const [locations, setLocations] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'inventory' | 'forecast'>('inventory');
  const [forecastData, setForecastData] = useState<Array<{
    product_id: string; product_name: string; sku: string | null;
    needed_month: string; planned_demand: number; job_demand: number; current_available: number;
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
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [addProductId, setAddProductId] = useState('');
  const [addLocation, setAddLocation] = useState('Main Warehouse');
  const [addQty, setAddQty] = useState('');
  const [addUnitSize, setAddUnitSize] = useState('');
  const [addUnitCost, setAddUnitCost] = useState('');
  const [addReorderPoint, setAddReorderPoint] = useState('');
  const [addMinStock, setAddMinStock] = useState('');
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
      { key: 'net_position', header: 'Net Position' },
      { key: 'total_planned_qty', header: 'Planned' },
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
          { header: 'Net', key: 'net_position', align: 'right', format: (v) => v != null ? Number(v).toFixed(1) : '-' },
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
    // Wave B.3 — single read-only RPC replaces 4 separate fetches + JS reduce.
    // RPC computes net_position = available - prebooked + on_order server-side
    // and returns holds_qty / planned_qty / delivered_ytd alongside.
    const { data, error } = await supabase.rpc('get_inventory_position');

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'inventory' } });
      toast('error', 'Failed to load inventory. Please try again.');
      setLoading(false);
      return;
    }

    const positions = assertRpcResult<InventoryPositionRow[]>(data, 'get_inventory_position');
    validateInventoryPositionShape(positions);

    const rows: InventoryRow[] = positions.map((p) => ({
      id: p.inventory_id ?? `virtual-${p.product_id}`,
      product_id: p.product_id,
      quantity_available: p.quantity_available,
      quantity_prebooked: p.quantity_prebooked,
      quantity_on_order: p.quantity_on_order,
      location: p.location ?? '',
      unit_size: p.unit_size,
      last_counted_at: null,
      // get_inventory_position doesn't return manufactured_at_delivery — it's
      // only surfaced on the IntegrityCleanup page, which queries inventory
      // directly. Default false here is correct for the main grid.
      manufactured_at_delivery: false,
      updated_at: '',
      product_name: p.product_name,
      inventory_unit: p.inventory_unit,
      container_size: p.container_size,
      container_type: p.container_type,
      vendor: p.vendor,
      current_cost: p.current_cost,
      total_on_floor: p.quantity_available,
      holds_qty: p.holds_qty,
      total_planned_qty: p.holds_qty + p.planned_qty,
      net_position: p.net_position,
      delivered_ytd: p.delivered_ytd,
      reorder_point: p.reorder_point,
      min_stock_level: p.min_stock_level,
      is_low_stock: p.is_low_stock,
    }));

    const locs = [...new Set(rows.map((r) => r.location).filter(Boolean))];
    setLocations(locs.sort());
    setInventory(rows);
    setLoading(false);
  }, [toast]);

  const fetchHolds = useCallback(async () => {
    // PR-07 follow-up: dropped creator FK embed; resolved via profile_public_view.
    const { data, error } = await supabase
      .from('inventory_holds')
      .select(`
        *,
        product:products(product_name),
        customer:customers(farm_name)
      `)
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gte.${localToday()}`)
      .order('created_at', { ascending: false });

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'inventory' } });
      return;
    }

    const creatorIds = [...new Set(
      ((data || []) as Array<{ created_by?: string | null }>)
        .map((h) => h.created_by)
        .filter(Boolean) as string[]
    )];
    const creatorMap: Record<string, string> = {};
    if (creatorIds.length > 0) {
      const { data: creators } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', creatorIds);
      ((creators || []) as Array<{ id: string; full_name: string }>).forEach((p) => { creatorMap[p.id] = p.full_name; });
    }

    const holdRows = ((data || []) as Array<Record<string, unknown> & { product?: { product_name: string }; customer?: { farm_name: string }; created_by?: string | null }>).map((h) => ({
      ...h,
      product_name: h.product?.product_name || 'Unknown',
      customer_name: h.customer?.farm_name || null,
      creator_name: h.created_by ? creatorMap[h.created_by] || 'Unknown' : 'Unknown',
    })) as HoldWithRelations[];

    setHolds(holdRows);
  }, []);

  useEffect(() => {
    const recovered = receivePoIntent.unresolvedIntent;
    if (!recovered) return;
    setSelectedId(recovered.inventoryId);
    setReceiveQty(String(recovered.quantity));
    setReceivePOItemId(recovered.selectedPO.id);
    setAvailablePOs([recovered.selectedPO]);
    setReceiveOpen(true);
  }, [receivePoIntent.unresolvedIntent]);

  useEffect(() => {
    fetchInventory();
    fetchHolds();
  }, [fetchInventory, fetchHolds]);

  const fetchForecast = useCallback(async () => {
    setForecastLoading(true);
    const { data, error } = await supabase.rpc('get_inventory_forecast', { p_months_ahead: 6 });
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'inventory' } });
      toast('error', 'Failed to load forecast data');
    } else if (data) {
      setForecastData(assertRpcResult<typeof forecastData>(data, 'get_inventory_forecast'));
    }
    setForecastLoading(false);
  }, [toast]);

  useEffect(() => {
    if (activeTab === 'forecast' && forecastData.length === 0) fetchForecast();
  }, [activeTab, forecastData.length, fetchForecast]);

  const fetchProducts = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*, product_family:product_families(name)')
      .eq('is_active', true)
      .order('product_name');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'inventory' } });
      toast('error', 'Failed to load products. Please try again.');
      return;
    }
    setProducts((data || []) as unknown as PickerProduct[]);
  };

  const fetchCustomers = async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name');
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'inventory' } });
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
    setAddReorderPoint('');
    setAddMinStock('');
    setProductSearch('');
    setAddOpen(true);
  };

  const openHoldModal = () => {
    // Codex P2 fix (PR #59, 2026-05-16): reset page-scoped key on each open
    // so different products/customers can't share an idempotency intent.
    createHoldIdem.resetKey();
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
  // Admin-override flow when the server rejects with INSUFFICIENT_HOLD_INVENTORY
  // (P4-3 — create_inventory_hold RPC blocks negative-going holds by default;
  //  admin can force-create with a reason).
  const [forceHoldOpen, setForceHoldOpen] = useState(false);
  const [forceHoldServerMessage, setForceHoldServerMessage] = useState('');

  const callCreateHoldRpc = async (force: boolean, forceReason: string | null) => {
    if (!profile) return;
    const qty = parseFloat(holdQty);
    const idemKey = createHoldIdem.getKey();
    const { data, error } = await supabase.rpc('create_inventory_hold', {
      p_product_id: holdProductId,
      p_customer_id: (holdCustomerId || null) as string,
      p_quantity: qty,
      p_hold_type: 'manual',
      p_expires_at: (holdExpires || null) as string,
      p_notes: (holdNotes || null) as string,
      p_performed_by: profile.id,
      p_force: force,
      p_force_reason: forceReason ?? undefined,
      p_idempotency_key: idemKey,
    });
    if (error) throw error;
    assertRpcResult(data, 'create_inventory_hold');
    createHoldIdem.resetKey();
  };

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

    // UX preview only — the actual block is server-side. Even if the user
    // bypasses this warning by clicking Create Hold a second time, the RPC's
    // FOR UPDATE recompute will catch a true negative.
    const invItem = inventory.find(i => i.product_id === holdProductId);
    if (invItem) {
      const todaysFree = invItem.quantity_available - invItem.quantity_prebooked - invItem.holds_qty;
      if (todaysFree - qty < 0) {
        if (!holdWarning) {
          setHoldWarning(`Warning: this hold would exceed today's free stock. Only ${todaysFree.toFixed(1)} units are uncommitted right now (Available ${invItem.quantity_available} − Prebooked ${invItem.quantity_prebooked} − Existing Holds ${invItem.holds_qty.toFixed(1)}). On-order quantities don't count toward holds. Click Create Hold again to proceed anyway.`);
          return;
        }
      }
    }

    setCreatingHold(true);
    try {
      await callCreateHoldRpc(false, null);
      toast('success', 'Hold created successfully');
      setHoldOpen(false);
      fetchInventory();
      fetchHolds();
    } catch (err: unknown) {
      // Use the typed `hasRpcCode` helper instead of substring-matching the
      // raw message — substring matching false-positives if the token text
      // ever appears inside a user-supplied note or sub-error.
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_HOLD_INVENTORY)) {
        if (isAdmin) {
          // Pop the ReasonModal so admin can force-create with a documented reason.
          const message = err instanceof Error ? err.message : String(err);
          setForceHoldServerMessage(message);
          setForceHoldOpen(true);
        } else {
          // Sales rep — surface the server's reason; no override path.
          toast('error', sanitizeError(err));
        }
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setCreatingHold(false);
    }
  };

  const handleForceCreateHold = async (reason: string) => {
    setCreatingHold(true);
    try {
      await callCreateHoldRpc(true, reason);
      toast('success', 'Hold created with admin override');
      setForceHoldOpen(false);
      setHoldOpen(false);
      fetchInventory();
      fetchHolds();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    } finally {
      setCreatingHold(false);
    }
  };

  const handleReleaseHold = async (holdId: string) => {
    setReleasingHoldId(holdId);
    try {
      const { data, error } = await supabase.rpc('release_inventory_hold', {
        p_hold_id: holdId,
        p_performed_by: profile?.id,
        p_idempotency_key: releaseHoldIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'release_inventory_hold');
      releaseHoldIdem.resetKey();

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
    const reorderPoint = addReorderPoint ? parseFloat(addReorderPoint) : null;
    const minStock = addMinStock ? parseFloat(addMinStock) : null;
    const { data: manualAddData, error } = await supabase.rpc('manual_inventory_add', {
      p_product_id: addProductId,
      p_location: addLocation || 'Main Warehouse',
      p_quantity: qty,
      p_unit_size: addUnitSize || undefined,
      p_performed_by: profile?.id || undefined,
      p_notes: qty > 0 ? `Initial inventory record created with ${qty} units` : undefined,
      p_unit_cost: unitCost && unitCost > 0 ? unitCost : undefined,
      p_reorder_point: reorderPoint != null && reorderPoint >= 0 ? reorderPoint : undefined,
      p_min_stock_level: minStock != null && minStock >= 0 ? minStock : undefined,
      p_idempotency_key: manualAddIdem.getKey(),
    });
    if (!error) assertRpcResult(manualAddData, 'manual_inventory_add');

    if (error) {
      toast('error', sanitizeError(error));
    } else {
      manualAddIdem.resetKey();
      toast('success', 'Inventory record added');
      setAddOpen(false);
      fetchInventory();
    }
    setAdding(false);
  };

  const openReceiveModal = async (inventoryId: string) => {
    // Do not rotate the key here. A prior receive may have committed before a
    // lost response; reopening must retain that key so edited input fails closed.
    if (receivePoIntent.isIntentLocked) {
      setReceiveOpen(true);
      return;
    }
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

    if (error) {
      // Supabase RETURNS this error (doesn't throw) — surface it instead of
      // silently showing an empty PO list (Field Mode F6 class).
      Sentry.captureException(error, { extra: { context: 'Load receivable POs for product', productId: target.product_id } });
      toast('error', 'Could not load purchase orders for this product.');
    }
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
    if (receivePoIntent.isForeignIntentLocked) {
      toast('error', UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE);
      return;
    }
    if (receivePoIntent.isRetryExpired) {
      toast('error', UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE);
      return;
    }
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

    await runCriticalAction({
      action: async () => {
        const request = await receivePoIntent.beginIntent({
          items: [{ po_item_id: receivePOItemId, quantity: qty }],
          performedBy: profile.id,
          quantity: qty,
          inventoryId: selectedId,
          selectedPO,
        });
        const idemKey = receivePoIntent.getIdempotencyKey();
        const { data, error } = await supabase.rpc('receive_po_items', {
          p_items: request.items,
          p_performed_by: request.performedBy,
          p_idempotency_key: idemKey,
        });
        if (error) {
          const receipt = getIdempotencyMismatchResult(error, 'receive_po_items');
          const recordIds = receipt?.receiving_record_ids;
          if (Array.isArray(recordIds) && recordIds.every((id) => typeof id === 'string')) {
            toast('warning', 'The earlier receipt already completed. Refreshing inventory instead of receiving it twice.');
          } else {
            const disposition = await receivePoIntent.classifyFailure(error);
            if (disposition === 'resolved') {
              toast('warning', 'This receipt completed in another tab. Refreshing inventory instead of receiving it twice.');
            } else if (disposition === 'definitive') {
              throw error;
            } else {
              throw new Error('The receipt may already be recorded. Retry the locked request unchanged to reconcile it.');
            }
          }
        } else {
          assertRpcResult(data, 'receive_po_items');
        }
        await receivePoIntent.resolveIntent();
        return request.quantity;
      },
      toast,
      sentryTag: 'receive_po_items',
      onSuccess: (receivedQuantity) => {
        toast('success', `Received ${receivedQuantity} units`);
        setReceiveOpen(false);
        setReceiveQty('');
        setReceivePOItemId('');
        fetchInventory();
      },
    });
  };

  const handleAdjust = async () => {
    const qty = parseFloat(adjustQty);
    if (isNaN(qty) || qty === 0) {
      toast('error', 'Please enter a non-zero adjustment quantity');
      return;
    }
    if (!profile) return;

    await runCriticalAction({
      action: async () => {
        const idemKey = adjustIdem.getKey();
        const { data, error } = await supabase.rpc('adjust_inventory', {
          p_inventory_id: selectedId,
          p_delta: qty,
          p_reason: (adjustNote || null) as string,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
        });
        if (error) throw error;
        assertRpcResult(data, 'adjust_inventory');
        adjustIdem.resetKey();
      },
      toast,
      successMessage: `Adjusted by ${qty} units`,
      sentryTag: 'adjust_inventory',
      onSuccess: () => {
        setAdjustOpen(false);
        setAdjustQty('');
        setAdjustNote('');
        fetchInventory();
      },
    });
  };

  // Phase 16 (2026-05-01): the previous version did 3 separate validation
  // queries from the browser, then a separate ledger insert, then a separate
  // delete — race-condition window where another user could create a hold/
  // order/delivery between validation and delete. retire_inventory_item RPC
  // does it all in one transaction with FOR UPDATE on the inventory row.
  const handleDelete = (inventoryId: string) => {
    // Codex P2 fix (PR #59, 2026-05-16): reset retire key per inventory target.
    retireIdem.resetKey();
    setDeleteConfirmId(inventoryId);
  };

  const executeDelete = async () => {
    if (!deleteConfirmId || !profile) return;

    await runCriticalAction({
      action: async () => {
        const idemKey = retireIdem.getKey();
        const { data, error } = await supabase.rpc('retire_inventory_item', {
          p_inventory_id: deleteConfirmId,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
        });
        if (error) throw error;
        assertRpcResult(data, 'retire_inventory_item');
        retireIdem.resetKey();
      },
      toast,
      successMessage: 'Inventory item deleted',
      sentryTag: 'retire_inventory_item',
      onSuccess: () => {
        fetchInventory();
        setDeleteConfirmId(null);
      },
    });
    // Also clear on failure
    setDeleteConfirmId(null);
  };

  const filtered = inventory.filter((i) => {
    if (locationFilter && i.location !== locationFilter) return false;
    if (reorderFilter && !i.is_low_stock) return false;
    return true;
  });
  const mobileFiltered = filtered.filter((item) =>
    item.product_name.toLowerCase().includes(mobileSearch.trim().toLowerCase())
  );

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
  const totalNetPosition = inventory.reduce((s, i) => s + i.net_position, 0);
  const totalPlanned = inventory.reduce((s, i) => s + i.total_planned_qty, 0);
  const totalCommitted = inventory.reduce((s, i) => s + i.quantity_prebooked, 0);
  const totalDeliveredYTD = inventory.reduce((s, i) => s + i.delivered_ytd, 0);
  const totalValuation = inventory.reduce((sum, r) => sum + (r.quantity_available * (r.current_cost || 0)), 0);

  const netPositionColor = (n: number) => {
    if (n > 10) return 'text-emerald-600';
    if (n > 0) return 'text-amber-600';
    if (n === 0) return 'text-gray-500';
    return 'text-red-600';
  };

  const BULK_EDITABLE_INVENTORY_FIELDS = new Set(['reorder_point', 'min_stock_level']);

  const handleBulkSave = async (changes: Map<string, Record<string, unknown>>) => {
    try {
      for (const [inventoryId, fields] of changes) {
        // Skip virtual rows (they don't have real DB records)
        if (inventoryId.startsWith('virtual-')) {
          continue;
        }

        const unsafeFields = Object.keys(fields).filter((field) => !BULK_EDITABLE_INVENTORY_FIELDS.has(field));
        if (unsafeFields.length > 0) {
          throw new Error(`Inventory inline edit cannot update: ${unsafeFields.join(', ')}`);
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
        logActivity({ event: 'inventory_bulk_updated', description: `${realChanges} inventory item(s) updated via inline edit`, performedBy: profile.id, entityType: 'inventory' });
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
      key: 'net_position',
      header: 'Net Position',
      sortable: true,
      render: (row) => (
        <span className={`font-semibold ${netPositionColor(row.net_position)}`}>
          {row.net_position.toFixed(1)}
        </span>
      ),
    },
    {
      key: 'total_planned_qty',
      header: 'Planned',
      sortable: true,
      render: (row) => (
        <span className="text-amber-600 font-medium">{row.total_planned_qty.toFixed(1)}</span>
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
                  aria-label="Receive Shipment"
                >
                  <ArrowDownToLine className="w-4 h-4" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); adjustIdem.resetKey(); setSelectedId(row.id); setAdjustOpen(true); }}
                  className="p-1.5 rounded hover:bg-gray-100 text-secondary"
                  title="Manual Adjustment"
                  aria-label="Manual Adjustment"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(row.id); }}
                  className="p-1.5 rounded hover:bg-red-50 text-red-600"
                  title="Delete Inventory Item"
                  aria-label="Delete Inventory Item"
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
    { label: 'Net Position', value: totalNetPosition, color: totalNetPosition >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600', icon: Package },
    { label: 'Planned', value: totalPlanned, color: 'bg-amber-50 text-amber-600', icon: Package },
    { label: 'Committed', value: totalCommitted, color: 'bg-orange-50 text-orange-600', icon: Package },
    { label: 'Delivered YTD', value: totalDeliveredYTD, color: 'bg-gray-50 text-gray-600', icon: Package },
    { label: 'Inventory Value', value: totalValuation, color: 'bg-emerald-50 text-emerald-600', icon: Package, format: 'currency' },
  ];

  const filteredProducts = products.filter((p) =>
    !productSearch || p.product_name.toLowerCase().includes(productSearch.toLowerCase())
  );

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Tabs
        tabs={[
          {
            key: 'inventory',
            label: (
              <>
                <Package className="w-4 h-4" />
                Inventory
                <HelpTip text="Two distinct numbers worth knowing: 'Net Position' = Available − Prebooked + On Order (forward-looking — used for order creation warnings, dashboard widgets, this column, and the field-app shortfall preview). 'Today's Free' = Available − Prebooked − active Holds (right-now physical stock — used internally by the manual-hold modal warning, since a hold competes against today's stock not future PO arrivals). Holds and planned-quote demand are shown separately in the 'Planned' column, NOT subtracted from Net Position. Click the ledger icon on any row to see the full transaction history." className="ml-1" />
              </>
            ),
            content: (
              <>
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
                      className="flex flex-col gap-3 rounded-lg border border-red-100 bg-red-50 p-3 md:flex-row md:items-center md:justify-between"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-nav-dark truncate">{item.product_name}</p>
                        <p className="text-xs text-secondary">
                          {item.location || 'No location'} &middot; Unit: {item.inventory_unit || item.unit_size || '-'}
                        </p>
                      </div>
                      <div className="grid w-full grid-cols-2 gap-3 text-sm sm:grid-cols-4 md:flex md:w-auto md:items-center md:gap-6">
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
                        <button
                          onClick={() => navigate(`/purchase-orders/new?product=${item.product_id}`)}
                          title="Create a purchase order for this product"
                          aria-label={`Reorder ${item.product_name}`}
                          className="col-span-2 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-crx-green px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-crx-green/90 sm:col-span-4 md:min-h-0 md:flex-shrink-0"
                        >
                          <ShoppingCart className="w-3.5 h-3.5" />
                          Reorder
                        </button>
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
        <div className="border-b border-gray-100 p-3 md:hidden">
          <label htmlFor="inventory-mobile-search" className="sr-only">Search products</label>
          <input
            id="inventory-mobile-search"
            type="search"
            value={mobileSearch}
            onChange={(e) => setMobileSearch(e.target.value)}
            placeholder="Search products..."
            className="min-h-11 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-base focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              aria-label="Filter inventory cards by location"
              className="min-h-11 min-w-0 rounded-lg border border-gray-200 px-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
            >
              <option value="">All Locations</option>
              {locations.map((location) => <option key={location} value={location}>{location}</option>)}
            </select>
            <button
              type="button"
              onClick={() => setReorderFilter(!reorderFilter)}
              className={`min-h-11 rounded-lg border px-3 text-sm font-medium ${
                reorderFilter ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 text-secondary'
              }`}
            >
              Needs Reorder
            </button>
          </div>
        </div>

        <InventoryPositionMobileCards
          rows={mobileFiltered}
          isAdmin={isAdmin}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onViewHistory={(row) => {
            setLedgerProductId(row.product_id);
            setLedgerProductName(row.product_name);
            setLedgerOpen(true);
          }}
          onReceive={openReceiveModal}
          onAdjust={(id) => {
            adjustIdem.resetKey();
            setSelectedId(id);
            setAdjustOpen(true);
          }}
          onDelete={handleDelete}
        />

        <div className="hidden p-5 md:block">
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
                          hold.hold_type === 'manual' ? 'bg-blue-100 text-blue-700'
                            : hold.hold_type === 'job' ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-purple-100 text-purple-700'
                        }`}>
                          {hold.hold_type === 'manual' ? 'Manual' : hold.hold_type === 'job' ? 'Job' : 'Program'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-secondary text-xs max-w-xs truncate">{hold.notes || '—'}</td>
                      <td className="py-3 px-3 text-secondary text-xs">
                        {hold.expires_at ? parseLocalDate(hold.expires_at).toLocaleDateString() : 'No expiration'}
                      </td>
                      <td className="py-3 px-3 text-secondary text-xs">{hold.creator_name}</td>
                      {isAdmin && (
                        <td className="py-3 px-3">
                          {hold.hold_type === 'job' ? (
                            <span
                              className="text-xs text-secondary"
                              title="Job reservations release automatically when the job completes, cancels, or is rescheduled."
                            >
                              Auto
                            </span>
                          ) : (
                            <button
                              onClick={() => handleReleaseHold(hold.id)}
                              disabled={releasingHoldId === hold.id}
                              className="text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                            >
                              {releasingHoldId === hold.id ? 'Releasing...' : 'Release'}
                            </button>
                          )}
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
              </>
            ),
          },
          {
            key: 'forecast',
            label: (
              <>
                <TrendingUp className="w-4 h-4" />
                Forecast
              </>
            ),
            content: (
              <Card>
                {/* Forecast Tab */}
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
                        <th className="px-4 py-3 text-right font-medium text-secondary">
                          Jobs
                          <HelpTip text="The portion of Planned Demand from scheduled / in-progress field jobs that reserved this product (bucketed by job date). The remainder is crop-program quote bookings." className="ml-1" />
                        </th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">
                          Available
                          <HelpTip text="Physical stock right now (raw quantity_available). The Inventory tab shows 'Net Position' = Available − Prebooked + On Order; this column shows just the Available component so you can see all three numbers (Available, On Order, Gap) separately." className="ml-1" />
                        </th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">On Order</th>
                        <th className="px-4 py-3 text-right font-medium text-secondary">
                          Gap
                          <HelpTip text="Planned Demand − (Available + On Order − Prebooked). Negative or zero = supply meets demand. Positive (shown in red) = shortfall to plan around." className="ml-1" />
                        </th>
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
                            <td className="px-4 py-3 text-right font-mono text-purple-600">{row.job_demand.toLocaleString()}</td>
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
            ),
          },
        ]}
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as 'inventory' | 'forecast')}
        ariaLabel="Inventory views"
      />

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
                  <div key={p.id} className={holdProductId === p.id ? 'bg-crx-green/10' : ''}>
                    <ProductSearchResultRow
                      onClick={() => {
                        setHoldProductId(p.id);
                        setHoldWarning('');
                      }}
                      product={p}
                      trailing={null}
                    />
                  </div>
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
                  <div key={p.id} className={addProductId === p.id ? 'bg-crx-green/10' : ''}>
                    <ProductSearchResultRow
                      onClick={() => {
                        setAddProductId(p.id);
                        setAddUnitSize(p.unit_size || '');
                      }}
                      product={p}
                      trailing={null}
                    />
                  </div>
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
          <div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Reorder Point (optional)"
                type="number"
                min="0"
                step="any"
                value={addReorderPoint}
                onChange={(e) => setAddReorderPoint(e.target.value)}
                placeholder="e.g. 50"
              />
              <Input
                label="Min Stock (optional)"
                type="number"
                min="0"
                step="any"
                value={addMinStock}
                onChange={(e) => setAddMinStock(e.target.value)}
                placeholder="e.g. 20"
              />
            </div>
            <p className="text-xs text-secondary mt-1">
              Reorder point flags this item on the "Needs Reorder" list when stock runs low. Leave blank to set later.
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
      <Modal open={receiveOpen} onClose={() => { if (!receivePoIntent.isIntentLocked) setReceiveOpen(false); }} title="Receive" accent="Shipment">
        <div className="space-y-4">
          {receivePoIntent.isIntentLocked && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {receivePoIntent.isForeignIntentLocked
                ? UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE
                : receivePoIntent.isRetryExpired
                ? UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE
                : 'The last response was uncertain. This receiving request is locked so stock cannot be received twice. Retry it unchanged to reconcile the result.'}
            </div>
          )}
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
                disabled={receivePoIntent.isIntentLocked}
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
                disabled={receivePoIntent.isIntentLocked}
              />
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={receivePoIntent.isIntentLocked} onClick={() => setReceiveOpen(false)}>Cancel</Button>
            {availablePOs.length > 0 && (
              <Button onClick={handleReceive} disabled={receivePoIntent.isForeignIntentLocked || receivePoIntent.isRetryExpired}>
                {receivePoIntent.isIntentLocked ? 'Retry Exact Receiving' : 'Receive'}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {/* Adjust Modal */}
      <Modal open={adjustOpen} onClose={() => setAdjustOpen(false)} title="Manual" accent="Adjustment">
        {(() => {
          const selectedRow = inventory.find((r) => r.id === selectedId);
          const parsedDelta = parseFloat(adjustQty);
          const hasDelta = adjustQty !== '' && Number.isFinite(parsedDelta);
          const projectedQty = selectedRow && hasDelta ? selectedRow.quantity_available + parsedDelta : null;
          const wouldGoNegative = projectedQty !== null && projectedQty < 0;
          return (
            <div className="space-y-4">
              {selectedRow && (
                <p className="text-sm text-secondary">
                  Current on hand: <strong className="text-nav-dark">{selectedRow.quantity_available}</strong> units
                </p>
              )}
              <Input
                label="Adjustment Quantity (+ or -)"
                type="number"
                step="any"
                value={adjustQty}
                onChange={(e) => setAdjustQty(e.target.value)}
              />
              {selectedRow && hasDelta && projectedQty !== null && (
                <p className={`text-sm ${wouldGoNegative ? 'text-red-600' : 'text-secondary'}`}>
                  After this adjustment: <strong>{projectedQty}</strong> units
                </p>
              )}
              {wouldGoNegative && (
                <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
                  <strong>Warning:</strong> this adjustment will drive inventory below zero ({projectedQty}). Verify with a physical count before proceeding.
                </div>
              )}
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
          );
        })()}
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

      <ReasonModal
        open={forceHoldOpen}
        onClose={() => setForceHoldOpen(false)}
        onConfirm={handleForceCreateHold}
        title="Force-create hold (admin override)"
        message={`The server blocked this hold: ${forceHoldServerMessage.replace(/^.*INSUFFICIENT_HOLD_INVENTORY:\s*/, '').replace(/\.$/, '')}. Provide a reason to override and create the hold anyway.`}
        confirmLabel="Force-create hold"
        variant="warning"
        loading={creatingHold}
        placeholder="e.g. customer prepaid in cash, physical stock confirmed in back room"
        minLength={5}
      />
    </div>
  );
}
