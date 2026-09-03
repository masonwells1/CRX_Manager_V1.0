/**
 * OrderDetail.tsx — View and edit orders after creation
 * GAP FIX #13: Edit Orders After Creation
 * AR derived from linked invoices (single source of truth).
 */
import { useEffect, useState , useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Truck, Pencil, Save, X, Trash2, FileText, Users, Plus, AlertTriangle, MessageSquarePlus, Printer, ClipboardList, DollarSign } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { generateIdempotencyKey } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import { notifyOrderStatusChange } from '../lib/notificationTriggers';
import { supabase, checkMutationResult, sanitizeError, assertRpcResult, hasRpcCode, RpcErrorCodes, describePostInvoiceBlock } from '../lib/db';
import { Sentry } from '../lib/sentry';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { runCriticalAction } from '../lib/criticalAction';
import { parseLocalDate } from '../lib/dateUtils';
import { formatUSD as fmt } from '../lib/money';
import { isBelowCostApprovalHandledError, withBelowCostReason } from '../lib/belowCostApproval';
import QuickTaskModal from '../components/team/QuickTaskModal';
import HelpTip from '../components/ui/HelpTip';
import RelatedNotes from '../components/team/RelatedNotes';
import TransactionThread from '../components/ui/TransactionThread';
import { downloadOrderSummaryPdf } from '../lib/orderSummaryPdf';
import { downloadPickListPdf } from '../lib/orderPickListPdf';
import { sumNeedByProduct } from '../lib/inventoryShortage';
import { buildInvoicePostTargets } from '../lib/invoiceBatchPosting';
import type { OrderSummaryData } from '../lib/orderSummaryPdf';
import type { PickListData } from '../lib/orderPickListPdf';
import { validateInventoryPositionShape } from '../lib/inventoryPositionValidator';
import { inventoryPositionByProduct } from '../lib/inventoryPositionLookup';
import { activeInvoiceCoversOrder } from '../lib/deliveryInvoiceCoverage';
import { ProductOptionDetails } from '../components/products/ProductOptionPresentation';
import type { Order, OrderItem, OrderShare, OrderItemFieldAllocation, Customer, Invoice, Delivery, Product, LinkedEntityType, InventoryPositionRow } from '../types';

/** Temporary new item (not yet saved to DB — has no real id) */
interface NewOrderItem {
  _tempKey: string;
  product_id: string;
  product_name: string;
  price_per_unit: number;
  cost_per_unit: number;
  total_units_needed: number;
  unit_size: string | null;
  section_name: string | null;
}

let _editKeyCounter = 0;
function nextEditKey() { return `_new_${++_editKeyCounter}`; }

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const updateOrderIdem = useIdempotencyKey('update_order_items', profile?.id || '');
  const voidOrderIdem = useIdempotencyKey('void_order', profile?.id || '');
  // F1: scoped by order id. This component does NOT remount when the route id
  // changes (App.tsx renders it without a key, the effects are keyed on [id], and
  // activeOrderIdRef exists precisely to guard the stale in-flight fetch), so the
  // hook's key map survives an order-to-order navigation. These three actions no
  // longer retire their key on click, so without the scope an ambiguous result on
  // order A could replay A's receipt after the user navigated to order B —
  // reporting B cancelled without cancelling it, or opening A's invoice. Scoping
  // keeps retry-under-the-same-key for the SAME order while minting a fresh key
  // per order.
  const cancelOrderIdem = useIdempotencyKey('cancel_order', profile?.id || '', id ?? '');
  const createInvoiceIdem = useIdempotencyKey('create_invoice_from_order', profile?.id || '', id ?? '');
  const priceOrderIdem = useIdempotencyKey('price_order', profile?.id || '');
  const consolidateIdem = useIdempotencyKey('consolidate_draft_invoices', profile?.id || '');
  // F1: order-scoped for the same reason as cancelOrderIdem / createInvoiceIdem —
  // this is the other half of the Create Invoice click path.
  const splitInvoiceIdem = useIdempotencyKey('create_split_invoices_from_order', profile?.id || '', id ?? '');
  // Latest order id the route is showing — older in-flight fetches bail (M6 stale guard).
  const activeOrderIdRef = useRef<string | undefined>(undefined);
  // Per-target idempotency keys for "post all drafts" (M7) — keyed by standalone
  // invoice or split group so a network retry reuses the server dedup boundary.
  const postDraftKeysRef = useRef<Record<string, string>>({});
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [deliveries, setDeliveries] = useState<(Delivery & { driver_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);

  // Parent quote for transaction thread
  const [parentQuote, setParentQuote] = useState<{ id: string; quote_number: string } | null>(null);

  // Related blend tickets
  const [relatedTickets, setRelatedTickets] = useState<{ id: string; ticket_number: string; ticket_date: string | null; order_link_status: string | null; payment_status: string | null }[]>([]);

  // Shares state
  const [shares, setShares] = useState<OrderShare[]>([]);
  const [showShareEditor, setShowShareEditor] = useState(false);
  const [shareCustomers, setShareCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [newShareCustomerId, setNewShareCustomerId] = useState('');
  const [newSharePct, setNewSharePct] = useState('');
  const [savingShares, setSavingShares] = useState(false);

  // Field/acre split state (multi-field split invoicing — entered on the order, billed by acres).
  type AllocField = { id: string; field_name: string; total_acres: number | null; customer_id: string; owners: { customer_id: string; split_pct: number }[] };
  const [allocations, setAllocations] = useState<OrderItemFieldAllocation[]>([]);
  const [allocFields, setAllocFields] = useState<AllocField[]>([]);
  const [custNames, setCustNames] = useState<Record<string, string>>({});
  const [allocEditorItemId, setAllocEditorItemId] = useState<string | null>(null);
  const [newAllocFieldId, setNewAllocFieldId] = useState('');
  const [newAllocAcres, setNewAllocAcres] = useState('');
  const [savingAlloc, setSavingAlloc] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editItems, setEditItems] = useState<OrderItem[]>([]);
  const [newItems, setNewItems] = useState<NewOrderItem[]>([]);
  const [saving, setSaving] = useState(false);

  // Add-product modal state
  const [products, setProducts] = useState<Product[]>([]);
  const [showProductModal, setShowProductModal] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<string, { available: number; prebooked: number; onOrder: number }>>({});

  // Create invoice
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [invoiceWarnOpen, setInvoiceWarnOpen] = useState(false);

  // Status change
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string>('');

  // Void order (fulfilled → voided, admin-only)
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Planned/Committed toggle
  const [togglingPlanned, setTogglingPlanned] = useState(false);

  // Print state
  const [printingSummary, setPrintingSummary] = useState(false);
  const [printingPickList, setPrintingPickList] = useState(false);

  // Ship-now/price-later (#2): per-line price inputs for a needs_pricing order.
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [pricingOrder, setPricingOrder] = useState(false);
  // #4 billing cockpit: post-all-drafts / consolidate-drafts actions.
  const [postingAll, setPostingAll] = useState(false);
  const [consolidating, setConsolidating] = useState(false);

  const isAdmin = role === 'admin';
  // Draw-created orders (booking_draw) mirror their booking's draw ledger —
  // items are locked server-side (BOOKING_DRAW_ORDER_LOCKED); void/cancel the
  // order to return quantity to the booking, then draw again.
  const canEdit = (role === 'admin' || role === 'sales_rep') && order?.status !== 'fulfilled' && order?.status !== 'cancelled' && order?.status !== 'partially_fulfilled' && !order?.booking_draw;

  const fetchOrder = useCallback(async () => {
    // Stale-route guard (M6): on rapid order-to-order navigation an older in-flight
    // fetch must not render the previous order's items/invoices/deliveries.
    const isStale = () => activeOrderIdRef.current !== id;
    const { data: orderData } = await supabase
      .from('orders')
      .select('*')
      .eq('id', id!)
      .maybeSingle();

    if (isStale()) return;
    if (orderData) {
      setOrder(orderData as Order);

      // Fetch parent quote for transaction thread
      if (orderData.quote_id) {
        const { data: qData } = await supabase
          .from('quotes').select('id, quote_number')
          .eq('id', orderData.quote_id).maybeSingle();
        if (isStale()) return;
        setParentQuote(qData as { id: string; quote_number: string } | null);
      } else { setParentQuote(null); }

      const { data: custData } = await supabase
        .from('customers')
        .select('*')
        .eq('id', orderData.customer_id)
        .maybeSingle();
      if (isStale()) return;
      setCustomer(custData as Customer | null);

      const { data: itemsData } = await supabase
        .from('order_items')
        .select('*')
        .eq('order_id', id!)
        .order('section_name');
      const itemsList = (itemsData || []) as OrderItem[];
      if (isStale()) return;
      setItems(itemsList);
      setEditItems(itemsList.map((i) => ({ ...i })));
      // Ship-now/price-later (#2): seed price inputs from each pending line's tier snapshot.
      setPriceInputs(Object.fromEntries(
        itemsList.filter((i) => i.pricing_pending).map((i) => [i.id, i.suggested_price != null ? String(i.suggested_price) : ''])
      ));

      // Load related blend tickets
      const { data: btLinks } = await supabase
        .from('blend_ticket_to_order_items')
        .select('blend_ticket_id, blend_ticket:blend_tickets(id, ticket_number, ticket_date, order_link_status, payment_status)')
        .eq('order_id', id!);
      if (isStale()) return;
      // Deduplicate by blend_ticket_id
      const uniqueTickets = new Map<string, { id: string; ticket_number: string; ticket_date: string | null; order_link_status: string | null; payment_status: string | null }>();
      ((btLinks || []) as unknown as Array<{ blend_ticket_id: string; blend_ticket: { id: string; ticket_number: string; ticket_date: string | null; order_link_status: string | null; payment_status: string | null } | null }>).forEach((link) => {
        if (link.blend_ticket && !uniqueTickets.has(link.blend_ticket_id)) {
          uniqueTickets.set(link.blend_ticket_id, link.blend_ticket);
        }
      });
      setRelatedTickets(Array.from(uniqueTickets.values()));

      // Load linked deliveries
      // PR-07 follow-up: dropped driver FK embed; resolve via profile_public_view.
      const { data: deliveryData } = await supabase
        .from('deliveries')
        .select('*')
        .eq('order_id', id!)
        .order('scheduled_date');
      const deliveryDriverIds = [...new Set(
        (deliveryData || [])
          .map((d: { assigned_driver?: string | null }) => d.assigned_driver)
          .filter(Boolean) as string[]
      )];
      const deliveryDriverMap: Record<string, string> = {};
      if (deliveryDriverIds.length > 0) {
        const { data: driverData } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', deliveryDriverIds);
        (driverData || []).forEach((p: { id: string | null; full_name: string | null }) => { if (p.id) deliveryDriverMap[p.id] = p.full_name ?? ''; });
      }
      if (isStale()) return;
      setDeliveries(
        ((deliveryData || []) as Delivery[]).map((d: Delivery) => ({
          ...d,
          driver_name: d.assigned_driver ? deliveryDriverMap[d.assigned_driver] || undefined : undefined,
        }))
      );

      // Load linked invoices (AR single source of truth)
      const { data: invoiceData } = await supabase
        .from('invoices')
        .select('*')
        .eq('order_id', id!)
        .not('status', 'in', '("voided","cancelled")')
        .order('invoice_number');
      if (isStale()) return;
      setInvoices((invoiceData || []) as Invoice[]);

      // Load order shares
      const { data: shareData } = await supabase
        .from('order_shares')
        .select('*')
        .eq('order_id', id!)
        .order('sort_order');
      if (isStale()) return;
      setShares((shareData || []) as OrderShare[]);

      // Field/acre split: existing per-line allocations for this order, the active fields to pick
      // from (with their owner splits), and a customer-id → name map for the live preview.
      const { data: allocData } = await supabase
        .from('order_item_field_allocations')
        .select('id, order_item_id, field_id, acres, created_at, order_items!inner(order_id)')
        .eq('order_items.order_id', id!);
      if (isStale()) return;
      setAllocations(((allocData || []) as unknown as (OrderItemFieldAllocation & { order_items?: unknown })[])
        .map(({ order_items: _oi, ...a }) => a as OrderItemFieldAllocation));

      const [fieldsRes, fbdRes, custRes] = await Promise.all([
        supabase.from('fields').select('id, field_name, total_acres, customer_id').eq('is_active', true).order('field_name'),
        supabase.from('field_billing_defaults').select('field_id, customer_id, split_pct'),
        supabase.from('customers').select('id, farm_name').is('deleted_at', null).limit(2000),
      ]);
      if (isStale()) return;
      const ownersByField: Record<string, { customer_id: string; split_pct: number }[]> = {};
      for (const r of fbdRes.data || []) {
        (ownersByField[r.field_id] ||= []).push({ customer_id: r.customer_id, split_pct: Number(r.split_pct) });
      }
      setAllocFields(((fieldsRes.data || []) as { id: string; field_name: string; total_acres: number | null; customer_id: string }[])
        .map((f) => ({ ...f, owners: ownersByField[f.id] || [] })));
      const names: Record<string, string> = {};
      for (const c of (custRes.data || []) as { id: string; farm_name: string }[]) names[c.id] = c.farm_name;
      setCustNames(names);
    }
    if (isStale()) return;
    setLoading(false);
  }, [id]);

  useEffect(() => {
    activeOrderIdRef.current = id;
    if (id) fetchOrder();
  }, [id, fetchOrder]);

  // Fetch products + inventory when entering edit mode (lazy load — only when needed)
  const fetchProducts = useCallback(async () => {
    const productsRes = await supabase.from('products').select('*, product_family:product_families(name)').eq('is_active', true).order('product_name');
    const { data: positionData, error: positionError } = await supabase.rpc('get_inventory_position');

    if (productsRes.error) {
      Sentry.captureException(productsRes.error, { tags: { source: 'fetch', action: 'load_products_for_order_edit' } });
      toast('error', 'Failed to load products. Please refresh.');
    }
    if (positionError) {
      Sentry.captureException(positionError, { tags: { source: 'fetch', action: 'load_inventory_position_for_order_edit' } });
      toast('error', 'Failed to load inventory positions. Please refresh.');
    }

    setProducts((productsRes.data || []) as Product[]);

    if (positionError) {
      setInventoryByProduct({});
    } else {
      try {
        const positionRows = assertRpcResult<InventoryPositionRow[]>(positionData, 'get_inventory_position');
        validateInventoryPositionShape(positionRows);
        setInventoryByProduct(inventoryPositionByProduct(positionRows));
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'parse_inventory_position_for_order_edit' } });
        toast('error', 'Inventory position data was malformed. Please refresh.');
        setInventoryByProduct({});
      }
    }
  }, [toast]);

  // Load products when edit mode is activated
  useEffect(() => {
    if (editing && products.length === 0) {
      fetchProducts();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // ── Print Handlers ────────────────────────────────────────────────────

  const handlePrintSummary = async () => {
    if (!order || !customer) return;
    setPrintingSummary(true);
    try {
      const data: OrderSummaryData = {
        order_number: order.order_number,
        order_name: order.order_name,
        order_date: order.order_date,
        status: order.status,
        customer_po_number: order.customer_po_number,
        farm_name: customer.farm_name,
        contact_name: customer.contact_name || null,
        phone: customer.phone || null,
        billing_address: customer.billing_address || null,
        items: items.map((it) => ({
          product_name: it.product_name,
          quantity: it.total_units_needed,
          unit_size: it.unit_size,
          price_per_unit: it.price_per_unit,
          extended_price: it.total_price,
        })),
        total_price: order.total_price,
        notes: order.notes,
      };
      await downloadOrderSummaryPdf(data);
      toast('success', 'Order summary downloaded');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'print_order_summary' } });
      toast('error', 'Failed to generate PDF');
    }
    setPrintingSummary(false);
  };

  const handlePrintPickList = async () => {
    if (!order || !customer) return;
    setPrintingPickList(true);
    try {
      // Fetch customer addresses + inventory in parallel
      const [addrRes, invRes] = await Promise.all([
        supabase.from('customer_addresses').select('*').eq('customer_id', customer.id).order('is_default', { ascending: false }),
        supabase.from('inventory').select('product_id, quantity_available, quantity_prebooked'),
      ]);

      // Build inventory map
      const invMap: Record<string, { available: number; prebooked: number }> = {};
      for (const row of invRes.data || []) {
        const pid = row.product_id as string;
        if (!invMap[pid]) invMap[pid] = { available: 0, prebooked: 0 };
        invMap[pid].available += Number(row.quantity_available);
        invMap[pid].prebooked += Number(row.quantity_prebooked);
      }

      // Flag the shortage against the product's TOTAL remaining on this order.
      // A tier-split booking puts the same product on several lines, and
      // comparing each line alone against the full net-free stock lets two
      // half-sized tier lines both look covered when together they are not.
      // See src/lib/inventoryShortage.ts.
      const remainingByProduct: Record<string, number> = {};
      for (const need of sumNeedByProduct(
        items.map((it) => ({
          productId: it.product_id,
          label: it.product_name,
          quantity: Number(it.quantity_remaining),
        }))
      )) {
        remainingByProduct[need.productId] = need.quantity;
      }

      // Format delivery addresses
      const addresses = (addrRes.data || []).map((a: Record<string, unknown>) => {
        const parts = [a.label, a.address_line, a.city, a.state, a.zip].filter(Boolean);
        return parts.join(', ');
      }).filter((s: string) => s.length > 0);

      // Fall back to billing address if no delivery addresses
      if (addresses.length === 0 && customer.billing_address) {
        addresses.push(customer.billing_address);
      }

      const data: PickListData = {
        order_number: order.order_number,
        order_name: order.order_name,
        order_date: order.order_date,
        farm_name: customer.farm_name,
        contact_name: customer.contact_name || null,
        phone: customer.phone || null,
        delivery_addresses: addresses,
        items: items.map((it) => {
          const inv = invMap[it.product_id];
          const netFree = inv ? inv.available - inv.prebooked : null;
          const remaining = remainingByProduct[it.product_id] ?? it.quantity_remaining;
          return {
            product_name: it.product_name,
            unit_size: it.unit_size,
            total_units_needed: it.total_units_needed,
            quantity_delivered: it.quantity_delivered,
            quantity_remaining: it.quantity_remaining,
            inventory_available: netFree,
            has_shortage: netFree !== null ? remaining > netFree : false,
          };
        }),
        notes: order.notes,
        program_notes: order.program_notes,
      };
      await downloadPickListPdf(data);
      toast('success', 'Pick list downloaded');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'print_pick_list' } });
      toast('error', 'Failed to generate pick list');
    }
    setPrintingPickList(false);
  };

  const handleAddProduct = (product: Product) => {
    const tierNum = customer?.assigned_tier || 1;
    // Cascade: tier3 → tier2 → tier1 fallback (same logic as quoteCalc.getTierPrice)
    const t1 = product.tier1_price || 0;
    const tierPrice =
      tierNum === 1 ? t1
        : tierNum === 2 ? product.tier2_price || t1
          : product.tier3_price || t1;

    const item: NewOrderItem = {
      _tempKey: nextEditKey(),
      product_id: product.id,
      product_name: product.product_name,
      price_per_unit: tierPrice,
      cost_per_unit: product.current_cost || 0,
      total_units_needed: 0,
      unit_size: product.unit_size || null,
      section_name: null,
    };
    setNewItems((prev) => [...prev, item]);
    setShowProductModal(false);
    setProductSearch('');
  };

  const updateNewItem = (key: string, field: keyof NewOrderItem, value: number | string | null) => {
    setNewItems((prev) =>
      prev.map((i) => (i._tempKey === key ? { ...i, [field]: value } : i))
    );
  };

  const removeNewItem = (key: string) => {
    setNewItems((prev) => prev.filter((i) => i._tempKey !== key));
  };

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.manufacturer?.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products;

  const handleSaveEdits = async () => {
    if (!profile) return;
    await runCriticalAction({
      action: async () => {
        // Build payload: existing items (with id) + new items (without id)
        const existingPayload = editItems.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_name: item.product_name,
          unit_size: item.unit_size,
          cost_per_unit: item.cost_per_unit,
          price_per_unit: item.price_per_unit,
          total_units_needed: item.total_units_needed,
        }));

        const newPayload = newItems
          .filter((item) => item.product_id && item.total_units_needed > 0)
          .map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            price_per_unit: item.price_per_unit,
            cost_per_unit: item.cost_per_unit,
            total_units_needed: item.total_units_needed,
            unit_size: item.unit_size,
            section_name: item.section_name,
          }));

        const itemsPayload = [...existingPayload, ...newPayload];

        const idemKey = updateOrderIdem.getKey();
        const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('update_order_items', withBelowCostReason('update_order_items', {
          p_order_id: id!,
          p_items: itemsPayload,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
        }, reason)));

        if (error) {
          // Server-side backstop for the hidden Edit button: a draw-created
          // order's items are locked to the booking ledger (Codex r2 HIGH).
          if (hasRpcCode(error, RpcErrorCodes.BOOKING_DRAW_ORDER_LOCKED)) {
            toast('error', 'This order was created by a booking draw-down — its items are locked to the booking. Void or cancel the order to return quantity to the booking, then draw again.');
            setEditing(false);
            setNewItems([]);
            fetchOrder();
            return;
          }
          throw error;
        }
        assertRpcResult(data, 'update_order_items');

        updateOrderIdem.resetKey();
        const addedCount = newPayload.length;
        toast('success', addedCount > 0 ? `Order updated — ${addedCount} product(s) added` : 'Order updated');
        setEditing(false);
        setNewItems([]);
        fetchOrder();
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'save_order_edits',
    });
  };

  const handleTogglePlanned = async () => {
    if (!order || !profile) return;
    setTogglingPlanned(true);
    try {
      const newValue = !order.is_planned;
      const result = await supabase
        .from('orders')
        .update({ is_planned: newValue, updated_at: new Date().toISOString() })
        .eq('id', order.id)
        .select();
      checkMutationResult(result, 'Toggle planned status');
      setOrder({ ...order, is_planned: newValue });
      toast('success', newValue ? 'Order marked as Planned' : 'Order marked as Committed');
      logActivity({ event: 'order_updated', description: `Order ${order.order_number} marked as ${newValue ? 'planned' : 'committed'}`, performedBy: profile.id, entityType: 'order', entityId: order.id, customerId: order.customer_id });
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'toggle_order_planned' } });
      toast('error', sanitizeError(err));
    }
    setTogglingPlanned(false);
  };

  const executeStatusChange = async () => {
    if (!pendingStatus || !order || !profile) return;
    setStatusConfirmOpen(false);
    const targetStatus = pendingStatus;

    await runCriticalAction({
      action: async () => {
        if (targetStatus === 'cancelled' && order.status !== 'cancelled') {
          // Atomic RPC: a zero-delivery order is cancelled; a partially delivered
          // order keeps its delivered lineage and closes only the remaining quantity.
          const cancelKey = cancelOrderIdem.getKey();
          const { data: cancelResult, error } = await supabase.rpc('cancel_order', {
            p_order_id: id!,
            p_performed_by: profile.id,
            p_idempotency_key: cancelKey,
          });
          if (error) throw error;
          const result = assertRpcResult<{
            success: boolean;
            mode?: 'full_cancel' | 'remainder_closed';
            status?: 'cancelled' | 'fulfilled';
            holds_released: number;
            released_quantity?: number;
            commissions_cancelled: number;
            commissions_recomputed?: number;
            draft_invoices_cancelled: number;
            posted_invoices_flagged: number;
            paid_commissions_flagged: number;
          }>(cancelResult, 'cancel_order');
          cancelOrderIdem.resetKey();
          // Show summary toast with cascade details
          if (result && result.success) {
            const remainderClosed = result.mode === 'remainder_closed';
            const parts: string[] = [
              remainderClosed
                ? 'Remaining quantity cancelled; delivered quantity kept as fulfilled.'
                : 'Order cancelled.',
            ];
            if (remainderClosed && (result.released_quantity ?? 0) > 0)
              parts.push(`${result.released_quantity} undelivered unit(s) released.`);
            if (remainderClosed && (result.commissions_recomputed ?? 0) > 0)
              parts.push(`${result.commissions_recomputed} commission(s) recalculated to delivered profit.`);
            if (result.holds_released > 0) parts.push(`${result.holds_released} hold(s) released.`);
            if (result.commissions_cancelled > 0) parts.push(`${result.commissions_cancelled} commission(s) zeroed.`);
            if (result.draft_invoices_cancelled > 0) parts.push(`${result.draft_invoices_cancelled} draft invoice(s) cancelled.`);
            if (result.posted_invoices_flagged > 0) parts.push(`Admin notified about ${result.posted_invoices_flagged} posted invoice(s) requiring manual void.`);
            if (result.paid_commissions_flagged > 0) parts.push(`Admin notified about ${result.paid_commissions_flagged} paid commission(s).`);
            toast('success', parts.join(' '));
          }

          // Idempotent/status-only responses (for example already_cancelled)
          // are not a new cancellation. Refresh the page state, but do not
          // write duplicate client activity or send a false status notice.
          if (!result.success) {
            await fetchOrder();
            return;
          }

          // A remainder close finishes as fulfilled, so do not write or notify a
          // second, false "cancelled" client event. Preserve the existing client
          // activity/notification behavior for a true full cancellation below.
          if (result.mode === 'remainder_closed') {
            await fetchOrder();
            return;
          }
        } else {
          // Simple status change (no inventory impact) — validate allowed transitions
          // Manual status changes — partially_fulfilled/fulfilled happen via delivery RPCs, not manual update
          const validTransitions: Record<string, string[]> = {
            confirmed: ['cancelled'],
            partially_fulfilled: ['cancelled'],
          };
          const allowed = validTransitions[order.status] || [];
          if (!allowed.includes(targetStatus)) {
            toast('error', `Cannot change status from '${order.status}' to '${targetStatus}'`);
            return;
          }
          const statusResult = await supabase
            .from('orders')
            .update({ status: targetStatus, updated_at: new Date().toISOString() })
            .eq('id', id!)
            .select();
          checkMutationResult(statusResult, 'Update order status');
          toast('success', `Status changed to ${targetStatus.replace('_', ' ')}`);
        }

        logActivity({ event: 'order_status_changed', description: `Order ${order.order_number} status changed to ${targetStatus}`, performedBy: profile.id, entityType: 'order', entityId: order.id, customerId: order.customer_id });
        // NOTE: the `orders` table has no created_by column, so the order-creator
        // notification path is not available here (it would require a migration to
        // add the column). Admins are still notified inside notifyOrderStatusChange.
        notifyOrderStatusChange(order.id, order.order_number, customer?.farm_name || 'customer', targetStatus);

        // The "Order Confirmed" customer email is now sent at the order
        // creation sites (QuoteBuilder.executeConvertToOrder and
        // NewOrder.submitOrder), not from this status-change handler.
        // Orders are born at status='confirmed', so there is no transition
        // INTO confirmed to gate on. Wave A.2 / audit finding P1-7.

        fetchOrder();
      },
      toast,
      setLoading: setChangingStatus,
      sentryTag: 'change_order_status',
    });
  };

  // ── Void Order (fulfilled → voided, admin-only) ───────────────────────
  const handleVoidOrder = async () => {
    if (!order || !profile) return;
    setVoiding(true);
    try {
      const idemKey = voidOrderIdem.getKey();
      const { data: voidResult, error } = await supabase.rpc('void_order', {
        p_order_id: order.id,
        p_performed_by: profile.id,
        p_reason: voidReason.trim() || 'Voided by admin',
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const voided = assertRpcResult<{
        inventory_products_restored?: number;
        commissions_cancelled?: number;
        draft_invoices_voided?: number;
        posted_invoices_flagged?: number;
        paid_commissions_flagged?: number;
      }>(voidResult, 'void_order');
      voidOrderIdem.resetKey();

      const parts: string[] = ['Order voided.'];
      if ((voided.inventory_products_restored ?? 0) > 0)
        parts.push(`Inventory restored for ${voided.inventory_products_restored} product(s).`);
      if ((voided.commissions_cancelled ?? 0) > 0)
        parts.push(`${voided.commissions_cancelled} commission(s) cancelled.`);
      if ((voided.draft_invoices_voided ?? 0) > 0)
        parts.push(`${voided.draft_invoices_voided} draft invoice(s) voided.`);
      if ((voided.posted_invoices_flagged ?? 0) > 0)
        parts.push(`Admin notified about ${voided.posted_invoices_flagged} posted invoice(s).`);
      if ((voided.paid_commissions_flagged ?? 0) > 0)
        parts.push(`Admin notified about ${voided.paid_commissions_flagged} paid commission(s).`);

      toast('success', parts.join(' '));
      setVoidModalOpen(false);
      setVoidReason('');
      fetchOrder();
    } catch (error: unknown) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { source: 'critical_action', action: 'void_order' } });
      toast('error', sanitizeError(error));
    } finally {
      setVoiding(false);
    }
  };

  // ── Share management ──────────────────────────────────────────────────
  const openShareEditor = async () => {
    // Load customers for dropdown
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .is('deleted_at', null)
      .order('farm_name')
      .limit(500);
    setShareCustomers((data || []) as { id: string; farm_name: string }[]);
    setNewShareCustomerId('');
    setNewSharePct('');
    setShowShareEditor(true);
  };

  const handleAddShare = async () => {
    if (!order || !newShareCustomerId || !newSharePct) return;
    const pct = parseFloat(newSharePct);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      toast('error', 'Percentage must be between 0 and 100');
      return;
    }
    const totalExisting = shares.reduce((s, sh) => s + sh.split_percentage, 0);
    if (totalExisting + pct > 100) {
      toast('error', `Total split would exceed 100% (currently ${totalExisting}%)`);
      return;
    }
    const selectedCust = shareCustomers.find((c) => c.id === newShareCustomerId);
    if (!selectedCust) return;

    setSavingShares(true);
    try {
      const amountCents = Math.round(order.total_price * 100 * (pct / 100));
      const result = await supabase.from('order_shares').insert({
        order_id: order.id,
        customer_id: newShareCustomerId,
        customer_name: selectedCust.farm_name,
        split_percentage: pct,
        amount_cents: amountCents,
        is_primary: shares.length === 0,
        sort_order: shares.length + 1,
      }).select();
      checkMutationResult(result, 'Add order share');
      toast('success', `Added ${selectedCust.farm_name} at ${pct}%`);
      setNewShareCustomerId('');
      setNewSharePct('');
      fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'add_order_share' } });
      toast('error', sanitizeError(err));
    }
    setSavingShares(false);
  };

  const handleRemoveShare = async (shareId: string) => {
    setSavingShares(true);
    try {
      const result = await supabase.from('order_shares').delete().eq('id', shareId).select();
      checkMutationResult(result, 'Remove order share');
      toast('success', 'Share removed');
      fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'remove_order_share' } });
      toast('error', sanitizeError(err));
    }
    setSavingShares(false);
  };

  const handleAddAllocation = async (orderItemId: string) => {
    if (!newAllocFieldId || !newAllocAcres) return;
    const acres = parseFloat(newAllocAcres);
    if (isNaN(acres) || acres <= 0) { toast('error', 'Acres must be greater than 0'); return; }
    if (allocations.some((a) => a.order_item_id === orderItemId && a.field_id === newAllocFieldId)) {
      toast('error', 'That field is already allocated on this line'); return;
    }
    setSavingAlloc(true);
    try {
      const result = await supabase.from('order_item_field_allocations').insert({
        order_item_id: orderItemId, field_id: newAllocFieldId, acres,
      }).select();
      checkMutationResult(result, 'Add field allocation');
      toast('success', 'Field allocation added');
      setNewAllocFieldId(''); setNewAllocAcres('');
      fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'add_field_allocation' } });
      toast('error', sanitizeError(err));
    }
    setSavingAlloc(false);
  };

  const handleRemoveAllocation = async (allocId: string) => {
    setSavingAlloc(true);
    try {
      const result = await supabase.from('order_item_field_allocations').delete().eq('id', allocId).select();
      checkMutationResult(result, 'Remove field allocation');
      toast('success', 'Field allocation removed');
      fetchOrder();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'remove_field_allocation' } });
      toast('error', sanitizeError(err));
    }
    setSavingAlloc(false);
  };

  const hasAllocations = allocations.length > 0;

  // Live per-customer preview of the split. Approximate (the server does the penny-exact
  // largest-remainder version at generation); shown only to sanity-check the allocation.
  const splitPreview = useMemo(() => {
    if (allocations.length === 0) return null;
    const perCust: Record<string, number> = {};
    const add = (cid: string, amt: number) => { if (cid) perCust[cid] = (perCust[cid] || 0) + amt; };
    for (const it of items) {
      const lineAllocs = allocations.filter((a) => a.order_item_id === it.id);
      if (lineAllocs.length === 0) { add(order?.customer_id || '', it.total_price); continue; }
      const totalAcres = lineAllocs.reduce((s, a) => s + Number(a.acres), 0);
      if (totalAcres <= 0) continue;
      for (const a of lineAllocs) {
        const fieldShare = it.total_price * Number(a.acres) / totalAcres;
        const fld = allocFields.find((f) => f.id === a.field_id);
        const owners = fld?.owners?.length ? fld.owners : (fld ? [{ customer_id: fld.customer_id, split_pct: 100 }] : []);
        const pctSum = owners.reduce((s, o) => s + o.split_pct, 0) || 100;
        for (const o of owners) add(o.customer_id, fieldShare * o.split_pct / pctSum);
      }
    }
    return Object.entries(perCust)
      .map(([cid, amt]) => ({ customer_id: cid, name: custNames[cid] || 'Unknown', amount: amt }))
      .filter((r) => Math.abs(r.amount) > 0.005)
      .sort((a, b) => b.amount - a.amount);
  }, [allocations, items, allocFields, custNames, order?.customer_id]);

  const handleDeleteItem = async (itemId: string) => {
    setEditItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const updateEditItem = (itemId: string, field: string, value: number) => {
    setEditItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, [field]: value } : i))
    );
  };

  const handleCreateInvoice = async () => {
    if (!profile || !id) return;
    setInvoiceWarnOpen(false);
    await runCriticalAction({
      action: async () => {
        // Field/acre split: when the order's lines have field allocations, generate one draft
        // invoice per field-owner (billed by acres) instead of a single order-level invoice. The
        // RPC itself falls back to a single invoice when there are no allocations, but we branch
        // here so the un-split path keeps its exact existing behavior + idempotency key.
        if (hasAllocations) {
          const splitKey = splitInvoiceIdem.getKey();
          const { data, error } = await supabase.rpc('create_split_invoices_from_order', {
            p_order_id: id,
            p_salesman_id: profile.id,
            p_invoice_type: 'chemical_sale',
            p_idempotency_key: splitKey,
          });
          if (error) throw error;
          const ids = assertRpcResult<string[]>(data, 'create_split_invoices_from_order');
          splitInvoiceIdem.resetKey();
          if (!ids || ids.length === 0) {
            throw new Error('No split invoices were generated — the order has no billable (positive) amount allocated to a customer.');
          }
          navigate(`/invoices/${ids[0]}`);
          return;
        }
        const invoiceKey = createInvoiceIdem.getKey();
        const { data, error } = await supabase.rpc('create_invoice_from_order', {
          p_order_id: id,
          p_salesman_id: profile.id,
          p_idempotency_key: invoiceKey,
        });
        if (error) throw error;
        const invoiceId = assertRpcResult<string>(data, 'create_invoice_from_order');
        createInvoiceIdem.resetKey();
        navigate(`/invoices/${invoiceId}`);
      },
      toast,
      successMessage: hasAllocations
        ? `Split invoices created${splitPreview ? ` (${splitPreview.length} customer${splitPreview.length !== 1 ? 's' : ''})` : ''}`
        : 'Draft invoice created',
      setLoading: setCreatingInvoice,
      sentryTag: hasAllocations ? 'create_split_invoices_from_order' : 'create_invoice_from_order',
    });
  };

  // Wave A.3 / audit finding P1-1: gate Create Invoice when a delivery is
  // already scheduled or in flight. Creating an invoice from the order at
  // that point uses the originally-ordered quantities, but a partial delivery
  // would only patch an invoice it created itself (auto-invoice path matches
  // on invoices.delivery_id). The result is a manual draft frozen at the
  // ordered quantities while the customer was billed for less.
  const hasActiveInvoice = invoices.some((inv) => activeInvoiceCoversOrder(inv, order?.id ?? ''));
  const hasPendingDelivery = deliveries.some(
    (d) => d.status === 'scheduled' || d.status === 'in_progress'
  );
  // W5 (sell-side #4): any non-cancelled/voided delivery means the order is billed
  // per-delivery — create_invoice_from_order now hard-rejects an order-level invoice
  // in that case, so don't even offer the "Create Invoice" button.
  const hasActiveDelivery = deliveries.some(
    (d) => d.status !== 'cancelled' && d.status !== 'voided'
  );

  const onCreateInvoiceClick = () => {
    // F1 click-level repair: do NOT retire the key here.
    //
    // The previous comment claimed "date/notes vary" per attempt, but neither RPC on
    // this path accepts a date or a note: create_invoice_from_order takes only
    // (p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key) and
    // create_split_invoices_from_order the same shape. Every field is fixed for this
    // screen, so two clicks are always the SAME intent — never a new one.
    //
    // Minting a fresh key per click therefore bought nothing and cost duplicate
    // protection: after an ambiguous reply (server committed, response lost or the
    // payload failed assertRpcResult) the user's natural retry travelled under a new
    // key, so the server could not replay and issued a SECOND invoice. Holding the key
    // lets create_invoice_from_order return the original invoice id instead.
    //
    // The key is retired after assertRpcResult confirms the reply (see
    // handleCreateInvoice), which is what makes a later, genuinely new invoice a new
    // intent.
    if (hasPendingDelivery) {
      setInvoiceWarnOpen(true);
      return;
    }
    handleCreateInvoice();
  };

  // #4 billing cockpit: post every draft/unposted invoice on this order in one
  // action. Standalone invoices post independently; split siblings post as one
  // atomic group. PRICING_INCOMPLETE / period errors remain isolated per target.
  const handlePostAllDrafts = async () => {
    if (!profile) { toast('error', 'You must be signed in to post invoices.'); return; }
    const drafts = invoices.filter((i) => i.status === 'draft' || i.status === 'unposted');
    if (drafts.length === 0) { toast('warning', 'No draft invoices to post.'); return; }
    const targets = buildInvoicePostTargets(drafts);
    setPostingAll(true);
    let posted = 0;
    let alreadyPosted = 0;
    const errors: string[] = [];
    // Codex round-6 P2: post_invoice's status guard is NOT a silent no-op — it RAISES
    // on an already-posted invoice. So a lost response (post committed server-side, but
    // the client got a network error) would make a retry report a false failure. Guard
    // each target with a fresh status re-check: if a prior attempt already posted
    // it, skip it (count as done) instead of raising. The idempotency cache is keyed
    // to the exact standalone/group RPC boundary.
    for (const target of targets) {
      try {
        const statusQuery = supabase.from('invoices').select('status').is('deleted_at', null);
        const { data: currentRows, error: curErr } = target.operation === 'post_invoice_group'
          ? await statusQuery.eq('invoice_group_id', target.invoiceGroupId!)
          : await statusQuery.eq('id', target.invoiceId!);
        if (curErr) throw curErr;
        if (currentRows && currentRows.length > 0 && currentRows.every(
          (row) => row.status !== 'draft' && row.status !== 'unposted'
        )) {
          alreadyPosted += target.selectedIds.length;
          continue;
        }
        if (!postDraftKeysRef.current[target.key]) {
          postDraftKeysRef.current[target.key] = generateIdempotencyKey(
            target.operation,
            `${profile.id}:${target.scopeId}`,
          );
        }
        if (target.operation === 'post_invoice_group') {
          const { data, error } = await supabase.rpc('post_invoice_group', {
            p_invoice_group_id: target.invoiceGroupId!,
            p_performed_by: profile.id,
            p_idempotency_key: postDraftKeysRef.current[target.key],
          });
          if (error) throw error;
          assertRpcResult(data, 'post_invoice_group');
        } else {
          await supabase.rpc('post_invoice', {
            p_invoice_id: target.invoiceId!,
            p_idempotency_key: postDraftKeysRef.current[target.key],
          }).throwOnError();
        }
        posted += target.selectedIds.length;
        delete postDraftKeysRef.current[target.key];
      } catch (err) {
        const blocked = describePostInvoiceBlock(err);
        if (blocked) errors.push(`${target.label}: ${blocked}`);
        else {
          const sanitized = sanitizeError(err);
          const message = sanitized.includes('RETURN_CREDIT_SOURCE_CONCURRENT')
            ? 'A related invoice or return credit is being changed elsewhere. Wait a moment and try again.'
            : sanitized;
          errors.push(`${target.label}: ${message}`);
        }
      }
    }
    if (alreadyPosted > 0 && posted === 0 && errors.length === 0) {
      toast('info', `Already posted (${alreadyPosted}).`);
    }
    if (posted > 0) toast('success', `Posted ${posted} invoice(s).`);
    if (errors.length > 0) {
      Sentry.captureException(new Error('post_all_drafts partial failure'), { level: 'warning', tags: { source: 'critical_action', action: 'post_all_drafts' }, extra: { errors } });
      for (const e of errors) toast('error', e);
    }
    if (errors.length === 0) postDraftKeysRef.current = {}; // clean run — mint fresh keys next time
    await fetchOrder();
    setPostingAll(false);
  };

  // #4 billing cockpit: merge this order's draft invoices into one (Agvance pattern).
  const handleConsolidateDrafts = async () => {
    if (!order || !profile) return;
    setConsolidating(true);
    try {
      const idem = consolidateIdem.getKey();
      const { data, error } = await supabase.rpc('consolidate_draft_invoices', { p_order_id: order.id, p_performed_by: profile.id, p_idempotency_key: idem });
      if (error) throw error;
      const result = assertRpcResult<{ success: boolean; consolidated: boolean; merged_count?: number }>(data, 'consolidate_draft_invoices');
      consolidateIdem.resetKey();
      if (result.consolidated) toast('success', `Consolidated ${(result.merged_count ?? 0) + 1} draft invoices into one.`);
      else toast('info', 'Nothing to consolidate — fewer than 2 draft invoices.');
      await fetchOrder();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'consolidate_draft_invoices' } });
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) toast('error', 'Only admin or sales can consolidate invoices.');
      else toast('error', sanitizeError(err));
    } finally {
      setConsolidating(false);
    }
  };

  // (booking-prepay "Apply booking prepay" action removed 2026-06-14 — the earmark
  // engine is shelved for a reserved-pool redesign: docs/roadmap/shelved-earmark-engine/)

  // Codex round-5 P2: reset the price_order idempotency key whenever the normalized
  // pricing payload (order id + the {item:price} pairs) changes, but keep it stable
  // for an identical retry. Without this, a lost price_order response leaves the key
  // in place; editing a price and resubmitting would replay the SAME key and return
  // the cached result, silently discarding the edited prices. Mirrors NewOrder's
  // rushOrderIdem intent-change reset.
  const pricingPayloadHash = useMemo(() => {
    const pairs = items
      .filter((i) => i.pricing_pending)
      .filter((i) => (priceInputs[i.id] ?? '').trim() !== '')
      .map((i) => `${i.id}:${parseFloat(priceInputs[i.id]) || 0}`)
      .sort()
      .join('|');
    return `${order?.id || ''}#${pairs}`;
  }, [items, priceInputs, order?.id]);
  useEffect(() => {
    priceOrderIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingPayloadHash]);

  // Ship-now/price-later (#2 v2): finalize a needs_pricing rush order via price_order.
  const handlePriceOrder = async () => {
    if (!order || !profile) return;
    const priced = items
      .filter((i) => i.pricing_pending)
      .filter((i) => (priceInputs[i.id] ?? '').trim() !== '')
      .map((i) => ({ order_item_id: i.id, price: parseFloat(priceInputs[i.id]) || 0 }));
    if (priced.length === 0) { toast('warning', 'Enter a price for at least one line.'); return; }
    if (priced.some((x) => x.price < 0)) { toast('error', 'Prices cannot be negative.'); return; }
    setPricingOrder(true);
    try {
      const idemKey = priceOrderIdem.getKey();
      const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('price_order', withBelowCostReason('price_order', {
        p_order_id: order.id,
        p_items: priced,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      }, reason)));
      if (error) throw error;
      const result = assertRpcResult<{ success: boolean; pricing_status: string; remaining_pending: number; invoices_swept: number }>(data, 'price_order');
      priceOrderIdem.resetKey();
      toast('success', result.pricing_status === 'priced'
        ? `Order priced${result.invoices_swept ? ` — ${result.invoices_swept} draft invoice(s) updated` : ''}`
        : `Saved — ${result.remaining_pending} line(s) still need a price`);
      await fetchOrder();
    } catch (err) {
      if (isBelowCostApprovalHandledError(err)) return;
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'price_order' } });
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) toast('error', 'Only admin or sales can price orders.');
      else toast('error', sanitizeError(err));
    } finally {
      setPricingOrder(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-16">
        <p className="text-secondary">Order not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/orders')}>
          Back to Orders
        </Button>
      </div>
    );
  }

  const sections = [...new Set((editing ? editItems : items).map((i) => i.section_name || 'General'))];
  const displayItems = editing ? editItems : items;
  // AR derived from invoices (single source of truth — never use order.total_paid / balance_due)
  const totalInvoicedCents = invoices.reduce((sum, inv) => sum + (inv.total_amount_cents || 0), 0);
  const totalPaidCents = invoices.reduce((sum, inv) => sum + (inv.paid_amount_cents || 0) + (inv.prepay_applied_cents || 0), 0);
  const balanceCents = invoices.reduce((sum, inv) => sum + (inv.balance_cents || 0), 0);
  // Written-off amount on the linked invoices. balance_cents is a generated column
  // (total − paid − prepay − write_off), so write-offs are already reflected in
  // Balance Due; surfacing them as their own tile makes Amount Paid + Written Off +
  // Balance Due reconcile to Total Invoiced when part of an invoice was written off.
  const writeOffCents = invoices.reduce((sum, inv) => sum + (inv.write_off_cents || 0), 0);
  const totalInvoiced = totalInvoicedCents / 100;
  const totalPaid = totalPaidCents / 100;
  const balanceDue = balanceCents / 100;
  const writeOff = writeOffCents / 100;

  // Bill split is locked once an invoice on this order is posted/paid/overdue —
  // editing the order_shares row would drift from the invoice's historical
  // invoice_shares snapshot. Enforced at DB level by the
  // prevent_order_shares_edit_after_post() trigger; this is just the UI half.
  const sharesLocked = invoices.some((inv) =>
    ['posted', 'paid', 'overdue'].includes(inv.status)
  );
  const lockingInvoice = sharesLocked
    ? invoices.find((inv) => ['posted', 'paid', 'overdue'].includes(inv.status))
    : null;

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[
        { label: 'Orders', href: '/orders' },
        { label: order?.order_number || 'Order' },
      ]} />
      <TransactionThread
        quoteId={parentQuote?.id}
        quoteNumber={parentQuote?.quote_number}
        orderId={order.id}
        orderNumber={order.order_number}
        deliveries={deliveries.map(d => ({ id: d.id, number: d.delivery_number }))}
        invoices={invoices.map(i => ({ id: i.id, number: i.invoice_number }))}
        currentEntity="order"
        currentEntityId={order.id}
      />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">{order?.order_number || 'Order'}</h2>
        <div className="flex gap-2 flex-wrap">
          {editing ? (
            <>
              <Button variant="ghost" icon={<X className="w-4 h-4" />} showChevron={false} onClick={() => { setEditing(false); setEditItems(items.map((i) => ({ ...i }))); setNewItems([]); }}>
                Cancel
              </Button>
              <Button icon={<Save className="w-4 h-4" />} onClick={handleSaveEdits} loading={saving}>
                Save Changes
              </Button>
            </>
          ) : (
            <>
              {canEdit && (
                <Button
                  variant="secondary"
                  icon={<Pencil className="w-4 h-4" />}
                  showChevron={false}
                  onClick={() => { updateOrderIdem.resetKey(); setEditing(true); }}
                >
                  Edit Order
                </Button>
              )}
              {order.booking_draw && (role === 'admin' || role === 'sales_rep') && order.status !== 'cancelled' && order.status !== 'voided' && (
                <span className="text-xs text-secondary self-center" title="This order was created by a booking draw-down. Its items mirror the booking ledger, so they can't be edited here — void or cancel the order to return quantity to the booking, then draw again.">
                  Booking draw — items locked
                </span>
              )}
              {order.status !== 'cancelled' && order.status !== 'fulfilled' && !hasActiveInvoice && !hasActiveDelivery && (<>
                <Button
                  variant="secondary"
                  icon={<FileText className="w-4 h-4" />}
                  showChevron={false}
                  onClick={onCreateInvoiceClick}
                  loading={creatingInvoice}
                >
                  Create Invoice
                </Button>
                <HelpTip
                  text={hasPendingDelivery
                    ? "A delivery is already scheduled. The recommended path is to wait for the driver to complete the delivery — an invoice will be created automatically with the actual delivered quantities. Clicking this opens a warning."
                    : "Generates a draft invoice from the order. It stays in draft until you review and post it — nothing is sent to the customer yet."}
                  className="ml-1"
                />
              </>)}
              {/* U7 SAFE-SCOPE: a delivered field/acre-allocated order that should be split-billed
                  per owner (complete_delivery skipped the mono-bill auto-draft to avoid over-billing
                  undelivered quantity). Gate on the DERIVABLE state, not the needs_split_billing
                  flag: hasAllocations + fully delivered (status='fulfilled', so the whole-order
                  create_split_invoices_from_order can't over-bill) + no active invoice + no open
                  delivery. Deriving it (rather than requiring needs_split_billing=true) means a
                  fulfilled allocated order whose split group was later VOIDED (flag already cleared,
                  hasActiveInvoice now false) can be RE-billed here — Codex R2 P2. The
                  needs_split_billing flag remains as the Orders-list queue badge/filter. */}
              {hasAllocations && order.status === 'fulfilled' && !hasActiveInvoice && !hasPendingDelivery && (<>
                <Button
                  variant="secondary"
                  icon={<FileText className="w-4 h-4" />}
                  showChevron={false}
                  onClick={onCreateInvoiceClick}
                  loading={creatingInvoice}
                >
                  Create Split Invoices
                </Button>
                <HelpTip
                  text="This order has field/acre allocations, so its auto-invoice was skipped on delivery to avoid over-billing. Generates one draft invoice per field owner, split by acres — nothing is sent to the customer yet."
                  className="ml-1"
                />
              </>)}
              {order.status !== 'cancelled' && order.status !== 'fulfilled' && (<>
                <Button
                  icon={<Truck className="w-4 h-4" />}
                  onClick={() => navigate(`/deliveries/new?order=${order.id}`)}
                >
                  Schedule Delivery
                </Button>
                <HelpTip text="Creates a new delivery from this order's items. The driver will see it on their dashboard and can start it when ready." className="ml-1" />
              </>)}
              <Button
                variant="secondary"
                icon={<Printer className="w-4 h-4" />}
                showChevron={false}
                onClick={handlePrintSummary}
                loading={printingSummary}
              >
                Print Summary
              </Button>
              <Button
                variant="secondary"
                icon={<ClipboardList className="w-4 h-4" />}
                showChevron={false}
                onClick={handlePrintPickList}
                loading={printingPickList}
              >
                Print Pick List
              </Button>
              <Button
                variant="secondary"
                icon={<MessageSquarePlus className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setQuickTaskOpen(true)}
              >
                Create Task
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Ship-now/price-later (#2): finalize pricing for a rush order */}
      {order.pricing_status === 'needs_pricing' && (role === 'admin' || role === 'sales_rep') && (
        <Card>
          <CardHeader title="Set Pricing" />
          <div className="p-5 space-y-3">
            <p className="text-sm text-secondary">
              This order shipped before pricing was finalized. Enter the final price per unit for each line — its invoice cannot be posted until pricing is complete.
            </p>
            {items.filter((i) => i.pricing_pending).map((i) => (
              <div key={i.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{i.product_name}</span>
                  <span className="text-xs text-secondary ml-2">{i.total_units_needed}{i.unit_size ? ` ${i.unit_size}` : ''}</span>
                </div>
                {i.suggested_price != null && (
                  <span className="text-xs text-secondary whitespace-nowrap">tier: {fmt(i.suggested_price)}</span>
                )}
                <input
                  type="number"
                  step="any"
                  min={0}
                  value={priceInputs[i.id] ?? ''}
                  onChange={(e) => setPriceInputs((p) => ({ ...p, [i.id]: e.target.value }))}
                  placeholder="price/unit"
                  aria-label={`Price per unit for ${i.product_name}`}
                  className="w-28 px-2 py-1 text-sm text-right border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            ))}
            <div className="flex justify-end">
              <Button onClick={handlePriceOrder} loading={pricingOrder} icon={<DollarSign className="w-4 h-4" />} showChevron={false}>
                Finalize Pricing
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Active delivery banner — shows when scheduled/in_progress deliveries exist */}
      {(() => {
        const activeDeliveries = deliveries.filter((d) => d.status === 'scheduled' || d.status === 'in_progress');
        if (activeDeliveries.length === 0) return null;
        const scheduledCount = activeDeliveries.filter((d) => d.status === 'scheduled').length;
        const inProgressCount = activeDeliveries.filter((d) => d.status === 'in_progress').length;
        const parts: string[] = [];
        if (scheduledCount > 0) parts.push(`${scheduledCount} scheduled`);
        if (inProgressCount > 0) parts.push(`${inProgressCount} in progress`);
        return (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-blue-50 border border-blue-200">
            <Truck className="w-5 h-5 text-blue-600 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-800">
                {activeDeliveries.length} active {activeDeliveries.length === 1 ? 'delivery' : 'deliveries'} — {parts.join(', ')}
              </p>
              <div className="flex flex-wrap gap-2 mt-1">
                {activeDeliveries.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => navigate(`/deliveries/${d.id}`)}
                    className="text-xs text-blue-700 hover:text-blue-900 underline"
                  >
                    {d.delivery_number} — {parseLocalDate(d.scheduled_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {d.driver_name ? ` (${d.driver_name})` : ''}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">
              {order.order_number}
            </h2>
            {order.order_name && (
              <p className="text-base font-medium text-nav-dark mt-0.5">{order.order_name}</p>
            )}
            <p className="text-sm text-secondary mt-1">
              {customer?.farm_name || 'Unknown Customer'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* #67: the only manual order-status transition the handler allows is
                → cancelled; fulfilled/partially_fulfilled are auto-derived when
                deliveries complete. So this is a plain Cancel Order action, not a
                dropdown of choices that always fail. */}
            {isAdmin && (order.status === 'confirmed' || order.status === 'partially_fulfilled') && (
              <button
                // F1: no per-open reset. cancel_order takes only
                // (p_order_id, p_performed_by, p_idempotency_key) — nothing varies
                // between attempts, so reopening this dialog is the SAME intent and a
                // fresh key would let an ambiguous first attempt cancel twice.
                onClick={() => { setPendingStatus('cancelled'); setStatusConfirmOpen(true); }}
                className="text-xs text-red-500 hover:text-red-700 underline"
              >
                {order.status === 'partially_fulfilled' ? 'Cancel Remaining Quantity' : 'Cancel Order'}
              </button>
            )}
            {isAdmin && order.status === 'fulfilled' && (
              <button
                onClick={() => { voidOrderIdem.resetKey(); setVoidModalOpen(true); }}
                className="text-xs text-red-500 hover:text-red-700 underline font-medium"
              >
                Void Order
              </button>
            )}
            <button
              onClick={handleTogglePlanned}
              disabled={togglingPlanned}
              title={order.is_planned ? 'Click to mark as Committed' : 'Click to mark as Planned'}
              className="cursor-pointer disabled:opacity-50"
            >
              <Badge variant={order.is_planned ? 'warning' : 'success'} size="md">
                {togglingPlanned ? '...' : order.is_planned ? 'Planned' : 'Committed'}
              </Badge>
            </button>
            <Badge variant={statusToBadgeVariant[order.status] || 'default'} size="md">
              {order.status.replace('_', ' ')}
            </Badge>
            {order.needs_split_billing && (
              <span title="This delivered order has field/acre allocations — auto-invoice was skipped; use Create Split Invoices below to bill it.">
                <Badge variant="warning" size="md">
                  Needs split billing
                </Badge>
              </span>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
          <div>
            <p className="text-xs text-secondary">Order Date</p>
            <p className="text-sm font-medium text-nav-dark">
              {new Date(order.order_date + 'T00:00:00').toLocaleDateString()}
            </p>
          </div>
          {order.customer_po_number && (
            <div>
              <p className="text-xs text-secondary">Customer PO#</p>
              <p className="text-sm font-medium text-nav-dark">
                {order.customer_po_number}
              </p>
            </div>
          )}
          <div>
            <p className="text-xs text-secondary">Total Price</p>
            <p className="text-sm font-medium text-nav-dark">{fmt(order.total_price)}</p>
          </div>
          {/* #2 (Codex round 2): field staff (driver/applicator) can now reach this
              page to create/track rush orders — never expose cost/profit/margin to
              them. */}
          {(role === 'admin' || role === 'sales_rep') && (<>
            <div>
              <p className="text-xs text-secondary">Profit</p>
              <p className="text-sm font-medium text-crx-green">{fmt(order.total_profit)}</p>
            </div>
            <div>
              <p className="text-xs text-secondary">Margin</p>
              <p className="text-sm font-medium text-nav-dark">
                {order.total_margin_pct.toFixed(1)}%
              </p>
            </div>
          </>)}
        </div>

        {/* AR summary — derived from linked invoices (single source of truth) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-4 border-t border-gray-100">
          <div>
            <p className="text-xs text-secondary">Total Invoiced</p>
            <p className="text-sm font-medium text-nav-dark">{fmt(totalInvoiced)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Amount Paid</p>
            <p className="text-sm font-medium text-crx-green">{fmt(totalPaid)}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Balance Due</p>
            <p className={`text-sm font-semibold ${balanceDue > 0 ? 'text-red-600' : 'text-crx-green'}`}>
              {fmt(Math.max(0, balanceDue))}
            </p>
          </div>
          {writeOffCents > 0 && (
            <div>
              <p className="text-xs text-secondary">Written Off</p>
              <p className="text-sm font-medium text-amber-600">{fmt(writeOff)}</p>
            </div>
          )}
          <div className="flex items-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/payments')}
            >
              Record Payment →
            </Button>
          </div>
        </div>
      </Card>

      {order.notes && (
        <Card>
          <div className="flex items-start gap-3">
            <FileText className="w-4 h-4 text-secondary mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-secondary font-medium mb-1">Order Notes <HelpTip text="Notes about this order that carry through to the load sheet and delivery. Use for special instructions like 'Call before delivering'." className="ml-1" /></p>
              <p className="text-sm text-nav-dark whitespace-pre-wrap">{order.notes}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Related Notes */}
      <RelatedNotes
        entityType={'order' as LinkedEntityType}
        entityId={id!}
        onCreateTask={() => setQuickTaskOpen(true)}
      />

      {/* Linked Deliveries */}
      {deliveries.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Truck className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Linked Deliveries</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left font-medium text-secondary">Delivery #</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Driver</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((del) => (
                  <tr key={del.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => navigate(`/deliveries/${del.id}`)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        {del.delivery_number}
                      </button>
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={statusToBadgeVariant[del.status] || 'default'} size="sm">
                        {del.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {del.driver_name || 'Unassigned'}
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {parseLocalDate(del.scheduled_date).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Linked Invoices */}
      {invoices.length > 0 && (
        <Card>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-crx-green" />
              <h3 className="font-semibold text-nav-dark">Linked Invoices</h3>
            </div>
            {(role === 'admin' || role === 'sales_rep') && (
              <div className="flex items-center gap-2">
                {invoices.filter((i) => i.status === 'draft').length >= 2 && (
                  <Button variant="secondary" size="sm" showChevron={false} onClick={handleConsolidateDrafts} loading={consolidating}>
                    Consolidate drafts
                  </Button>
                )}
                {invoices.some((i) => i.status === 'draft' || i.status === 'unposted') && (
                  <Button variant="secondary" size="sm" showChevron={false} onClick={handlePostAllDrafts} loading={postingAll}>
                    Post all drafts
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left font-medium text-secondary">Invoice #</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Type</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Status</th>
                  <th className="px-4 py-2 text-right font-medium text-secondary">Total</th>
                  <th className="px-4 py-2 text-right font-medium text-secondary">Paid</th>
                  <th className="px-4 py-2 text-right font-medium text-secondary">Balance</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => navigate(`/invoices/${inv.id}`)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        {inv.invoice_number}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-secondary capitalize">
                      {inv.invoice_type.replace('_', ' ')}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={inv.status === 'posted' ? 'success' : inv.status === 'draft' || inv.status === 'unposted' ? 'default' : inv.status === 'voided' || inv.status === 'cancelled' ? 'error' : 'warning'} size="sm">
                        {inv.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{fmt(inv.total_amount_cents / 100)}</td>
                    <td className="px-4 py-2 text-right font-mono text-crx-green">
                      {fmt((inv.paid_amount_cents + inv.prepay_applied_cents) / 100)}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono font-semibold ${inv.balance_cents > 0 ? 'text-red-600' : 'text-crx-green'}`}>
                      {fmt(inv.balance_cents / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {sections.map((section) => (
        <Card key={section} padding={false}>
          <div className="p-5">
            <CardHeader title={section} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Price/Unit</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Units Needed</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Delivered</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Remaining</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary w-40">Progress <HelpTip text="Shows how much of the order has been delivered, weighted by dollar value. 100% means all items are fully delivered." className="ml-1" /></th>
                    {editing && <th className="px-4 py-3 w-10"></th>}
                  </tr>
                </thead>
                <tbody>
                  {displayItems
                    .filter((i) => (i.section_name || 'General') === section)
                    .map((item) => {
                      const units = item.total_units_needed;
                      const ppu = item.price_per_unit;
                      const pct =
                        units > 0
                          ? Math.round((item.quantity_delivered / units) * 100)
                          : 0;
                      return (
                        <tr key={item.id} className="border-b border-gray-50">
                          <td className="px-4 py-3 font-medium text-nav-dark">
                            {item.product_name}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {editing ? (
                              <input
                                type="number"
                                value={ppu}
                                onChange={(e) => updateEditItem(item.id, 'price_per_unit', Number(e.target.value))}
                                className="w-24 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                                step="0.01"
                              />
                            ) : (
                              fmt(ppu)
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {editing ? (
                              <input
                                type="number"
                                value={units}
                                onChange={(e) => updateEditItem(item.id, 'total_units_needed', Number(e.target.value))}
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                              />
                            ) : (
                              units
                            )}
                          </td>
                          <td className="px-4 py-3">{item.quantity_delivered}</td>
                          <td className="px-4 py-3">{units - item.quantity_delivered}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-crx-green rounded-full transition-all"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs text-secondary w-8">{pct}%</span>
                            </div>
                          </td>
                          {editing && (
                            <td className="px-4 py-3">
                              <button
                                onClick={() => handleDeleteItem(item.id)}
                                className="text-red-400 hover:text-red-600"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                </tbody>
                {editing && (
                  <tfoot>
                    {/* New items being added */}
                    {newItems.map((ni) => (
                      <tr key={ni._tempKey} className="border-b border-green-100 bg-green-50/40">
                        <td className="px-4 py-3 font-medium text-nav-dark">
                          <div className="flex items-center gap-1">
                            <Plus className="w-3 h-3 text-crx-green" />
                            {ni.product_name}
                            <span className="text-xs text-crx-green font-normal">(new)</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono">
                          <input
                            type="number"
                            value={ni.price_per_unit}
                            onChange={(e) => updateNewItem(ni._tempKey, 'price_per_unit', Number(e.target.value))}
                            className="w-24 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                            step="0.01"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={ni.total_units_needed || ''}
                            onChange={(e) => updateNewItem(ni._tempKey, 'total_units_needed', Number(e.target.value))}
                            className="w-20 px-2 py-1 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                            placeholder="Qty"
                          />
                        </td>
                        <td className="px-4 py-3 text-secondary">0</td>
                        <td className="px-4 py-3 text-secondary">{ni.total_units_needed || 0}</td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-secondary">—</span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => removeNewItem(ni._tempKey)}
                            className="text-red-400 hover:text-red-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {/* Add Product button */}
                    <tr className="border-t border-dashed border-gray-300">
                      <td colSpan={7} className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => { setShowProductModal(true); setProductSearch(''); }}
                          className="flex items-center gap-2 text-sm text-crx-green hover:text-crx-green/80 font-medium transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                          Add Product
                        </button>
                      </td>
                    </tr>
                    {/* New total */}
                    <tr className="border-t border-gray-200">
                      <td colSpan={2} className="px-4 py-3 font-medium text-nav-dark">
                        New Total:
                      </td>
                      <td colSpan={5} className="px-4 py-3 font-semibold text-nav-dark">
                        {fmt(
                          editItems.reduce((s, i) => s + i.price_per_unit * i.total_units_needed, 0) +
                          newItems.reduce((s, i) => s + i.price_per_unit * i.total_units_needed, 0)
                        )}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </Card>
      ))}

      {/* Order Shares (Bill Splitting) */}
      {(shares.length > 0 || canEdit) && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-500" />
              <h3 className="font-semibold text-nav-dark">Bill Split</h3>
              {shares.length > 0 && (
                <span className="text-xs text-secondary">({shares.length} customer{shares.length !== 1 ? 's' : ''})</span>
              )}
            </div>
            {canEdit && !showShareEditor && !sharesLocked && (
              <Button variant="secondary" size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={openShareEditor}>
                Add Split
              </Button>
            )}
          </div>

          {sharesLocked && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                Bill split is locked because invoice <strong>{lockingInvoice?.invoice_number}</strong> is already posted.
                Void the invoice first to change the split.
              </span>
            </div>
          )}

          {shares.length === 0 && !showShareEditor && (
            <p className="text-sm text-secondary text-center py-4">No bill splits — 100% billed to primary customer</p>
          )}

          {shares.length > 0 && (
            <div className="space-y-2 mb-3">
              {shares.map((share) => (
                <div key={share.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                      <Users className="w-4 h-4 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-nav-dark">{share.customer_name}</p>
                      <p className="text-xs text-secondary">{fmt(share.amount_cents / 100)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-blue-600">{share.split_percentage}%</span>
                    {canEdit && !sharesLocked && (
                      <button onClick={() => handleRemoveShare(share.id)} className="text-red-400 hover:text-red-600 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between px-3 py-2 bg-blue-50 rounded-lg">
                <span className="text-xs font-medium text-blue-700">Total Allocated</span>
                <span className="text-xs font-semibold text-blue-700">
                  {shares.reduce((s, sh) => s + sh.split_percentage, 0)}%
                  {shares.reduce((s, sh) => s + sh.split_percentage, 0) < 100 && (
                    <span className="text-amber-600 ml-2">
                      ({100 - shares.reduce((s, sh) => s + sh.split_percentage, 0)}% unallocated)
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}

          {showShareEditor && (
            <div className="border border-blue-200 rounded-lg p-4 bg-blue-50/50 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="text-xs font-medium text-secondary mb-1 block">Customer</label>
                  <select
                    value={newShareCustomerId}
                    onChange={(e) => setNewShareCustomerId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Select customer...</option>
                    {shareCustomers.map((c) => (
                      <option key={c.id} value={c.id}>{c.farm_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-secondary mb-1 block">Split %</label>
                  <input
                    type="number"
                    value={newSharePct}
                    onChange={(e) => setNewSharePct(e.target.value)}
                    placeholder="e.g. 35"
                    min="0.01"
                    max="100"
                    step="0.01"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowShareEditor(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAddShare} loading={savingShares} disabled={!newShareCustomerId || !newSharePct}>
                  Add Share
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Field / Acre Split (multi-field split invoicing) */}
      {(hasAllocations || canEdit) && (
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <ClipboardList className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Field / Acre Split</h3>
            <HelpTip text="Spread an order line across multiple fields by acres. When you create the invoice, each field's owner(s) get billed their acre-weighted share — one invoice per customer. A line with no fields is billed normally to this order's customer." />
          </div>
          <p className="text-xs text-secondary mb-3">
            Optional. Assign fields + acres to a line to split its invoice across the fields' owners by acres.
            {allocFields.length === 0 && <span className="text-amber-600"> No active fields are set up yet.</span>}
          </p>

          <div className="space-y-3">
            {items.map((it) => {
              const lineAllocs = allocations.filter((a) => a.order_item_id === it.id);
              const used = new Set(lineAllocs.map((a) => a.field_id));
              const isOpen = allocEditorItemId === it.id;
              return (
                <div key={it.id} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-nav-dark">{it.product_name || 'Line'}</div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-secondary">{fmt(it.total_price)}</span>
                      {canEdit && !isOpen && (
                        <Button variant="ghost" size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false}
                          onClick={() => { setAllocEditorItemId(it.id); setNewAllocFieldId(''); setNewAllocAcres(''); }}>
                          Field
                        </Button>
                      )}
                    </div>
                  </div>

                  {lineAllocs.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {lineAllocs.map((a) => {
                        const fld = allocFields.find((f) => f.id === a.field_id);
                        return (
                          <div key={a.id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1">
                            <span className="text-nav-dark">{fld?.field_name || 'Field'} — {Number(a.acres)} ac</span>
                            {canEdit && (
                              <button onClick={() => handleRemoveAllocation(a.id)} className="text-red-400 hover:text-red-600 disabled:opacity-50" disabled={savingAlloc}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {isOpen && (
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
                      <div className="sm:col-span-2">
                        <label className="text-[11px] font-medium text-secondary mb-1 block">Field</label>
                        <select value={newAllocFieldId}
                          onChange={(e) => {
                            setNewAllocFieldId(e.target.value);
                            const f = allocFields.find((x) => x.id === e.target.value);
                            if (f && f.total_acres != null) setNewAllocAcres(String(f.total_acres));
                          }}
                          className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green">
                          <option value="">Select field...</option>
                          {allocFields.filter((f) => !used.has(f.id)).map((f) => (
                            <option key={f.id} value={f.id}>{f.field_name}{f.total_acres != null ? ` (${f.total_acres} ac)` : ' (no acres on file)'}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-secondary mb-1 block">Acres</label>
                        <input type="number" value={newAllocAcres} onChange={(e) => setNewAllocAcres(e.target.value)}
                          min="0.01" step="0.01" placeholder="acres"
                          className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" />
                      </div>
                      <div className="sm:col-span-3 flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setAllocEditorItemId(null)}>Cancel</Button>
                        <Button size="sm" loading={savingAlloc} disabled={!newAllocFieldId || !newAllocAcres}
                          onClick={() => handleAddAllocation(it.id)}>Add</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {splitPreview && splitPreview.length > 0 && (
            <div className="mt-4 border-t border-gray-100 pt-3">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-crx-green" />
                <span className="text-xs font-semibold text-nav-dark">Projected split (approx.) — one invoice per customer</span>
              </div>
              <div className="space-y-1">
                {splitPreview.map((p) => (
                  <div key={p.customer_id} className="flex items-center justify-between text-xs px-2 py-1 bg-green-50 rounded">
                    <span className="text-nav-dark">{p.name}</span>
                    <span className="font-semibold text-crx-green">{fmt(p.amount)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-secondary mt-2">Exact penny amounts are computed when you create the invoice.</p>
            </div>
          )}
        </Card>
      )}

      {/* Related Blend Tickets */}
      {relatedTickets.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Related Blend Tickets</h3>
          </div>
          <div className="space-y-2">
            {relatedTickets.map((bt) => (
              <div key={bt.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <button
                  onClick={() => navigate(`/blend-tickets/${bt.id}`)}
                  className="text-crx-green hover:underline font-medium text-sm"
                >
                  {bt.ticket_number}
                </button>
                <div className="flex items-center gap-2">
                  {bt.ticket_date && (
                    <span className="text-xs text-gray-500">{parseLocalDate(bt.ticket_date).toLocaleDateString()}</span>
                  )}
                  <Badge variant={bt.payment_status === 'billed' ? 'success' : bt.payment_status === 'prepaid' ? 'info' : 'default'}>
                    {(bt.payment_status || 'unbilled').replace('_', ' ')}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Void Order Modal */}
      <Modal open={voidModalOpen} onClose={() => { setVoidModalOpen(false); setVoidReason(''); }} title="Void Order">
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-red-50 rounded-lg border border-red-200">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-700 space-y-1">
              <p className="font-semibold">This action cannot be undone.</p>
              <ul className="list-disc list-inside space-y-0.5 text-red-600">
                <li>Inventory will be restored for all delivered items</li>
                <li>Draft invoices will be voided</li>
                <li>Pending commissions will be cancelled</li>
                <li>Posted invoices and paid commissions require manual review</li>
              </ul>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">
              Reason <span className="text-secondary font-normal">(optional)</span>
            </label>
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. Customer cancelled, duplicate order, data entry error..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-400 resize-none"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => { setVoidModalOpen(false); setVoidReason(''); }} disabled={voiding}>
              Cancel
            </Button>
            <Button
              onClick={handleVoidOrder}
              loading={voiding}
              disabled={voiding}
              className="bg-red-600 hover:bg-red-700 text-white border-red-600 hover:border-red-700"
            >
              Void Order
            </Button>
          </div>
        </div>
      </Modal>

      {/* Add Product to Order Modal */}
      <Modal
        open={showProductModal}
        onClose={() => setShowProductModal(false)}
        title="Add Product to Order"
        size="large"
      >
        <div className="space-y-4">
          <Input
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder="Search products..."
          />

          <div className="max-h-96 overflow-y-auto space-y-2">
            {filteredProducts.map((product) => {
              const tierNum = customer?.assigned_tier || 1;
              // Cascade: tier3 → tier2 → tier1 fallback
              const t1 = product.tier1_price || 0;
              const tierPrice =
                tierNum === 1
                  ? t1
                  : tierNum === 2
                    ? product.tier2_price || t1
                    : product.tier3_price || t1;
              const inv = inventoryByProduct[product.id];
              const onFloor = inv ? inv.available : 0;
              const netPos = inv ? inv.onOrder + inv.available - inv.prebooked : 0;

              // Check if product is already in order (existing or newly added)
              const alreadyInOrder = editItems.some((ei) => ei.product_id === product.id) ||
                newItems.some((ni) => ni.product_id === product.id);

              return (
                <button
                  key={product.id}
                  onClick={() => handleAddProduct(product)}
                  disabled={alreadyInOrder}
                  className={`w-full text-left p-3 border rounded-lg transition-colors ${
                    alreadyInOrder
                      ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                      : 'border-gray-200 hover:border-crx-green hover:bg-gray-50'
                  }`}
                >
                  <div className="font-medium text-nav-dark">
                    {product.product_name}
                    {alreadyInOrder && (
                      <span className="text-xs text-secondary ml-2">(already in order)</span>
                    )}
                  </div>
                  <ProductOptionDetails product={product} />
                  {product.manufacturer && (
                    <div className="text-xs text-secondary mt-1">{product.manufacturer}</div>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-secondary">
                    {product.unit_size && <span>Size: {product.unit_size}</span>}
                    {tierPrice > 0 && (
                      <span className="text-crx-green font-medium">
                        Price:{' '}
                        {new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD',
                        }).format(tierPrice)}
                      </span>
                    )}
                    <span className={onFloor > 0 ? 'text-blue-600' : 'text-gray-400'}>
                      On Floor: {onFloor.toLocaleString()}
                    </span>
                    <span className={netPos > 0 ? 'text-emerald-600' : netPos < 0 ? 'text-red-600' : 'text-gray-400'}>
                      Net: {netPos.toLocaleString()}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {filteredProducts.length === 0 && (
            <div className="text-center py-8 text-secondary">No products found</div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={statusConfirmOpen}
        onClose={() => setStatusConfirmOpen(false)}
        onConfirm={executeStatusChange}
        title={order?.status === 'partially_fulfilled' ? 'Cancel Remaining Quantity' : 'Cancel Order'}
        message={
          order?.status === 'partially_fulfilled'
            ? 'Cancel only the undelivered remainder? Completed deliveries and their invoices stay intact, undelivered inventory is released, and pending commissions are recalculated to delivered profit. Paid or batched commissions must be voided first. This cannot be undone.'
            : 'Cancel this order? Inventory holds will be released, any draft invoices cancelled, and pending commissions zeroed. Posted invoices or paid commissions are flagged for manual review. This cannot be undone.'
        }
        variant="warning"
        confirmLabel={order?.status === 'partially_fulfilled' ? 'Cancel Remaining' : 'Cancel Order'}
        loading={changingStatus}
      />

      <ConfirmModal
        open={invoiceWarnOpen}
        onClose={() => setInvoiceWarnOpen(false)}
        onConfirm={handleCreateInvoice}
        title="Create invoice before delivery completes?"
        message={
          'A delivery is already scheduled or in progress for this order. ' +
          'Creating an invoice now will lock in the originally-ordered quantities. ' +
          'If the driver delivers a partial load, this manual invoice will NOT auto-update — ' +
          'the customer would be over-billed for the difference. ' +
          'Recommended: wait for the delivery to complete and the invoice will be created automatically with the actual delivered quantities.'
        }
        variant="warning"
        confirmLabel="Create Anyway"
        loading={creatingInvoice}
      />

      <QuickTaskModal
        open={quickTaskOpen}
        onClose={() => setQuickTaskOpen(false)}
        entityType={'order' as LinkedEntityType}
        entityId={id!}
        prefillTitle={`Follow up: ${order.order_number}`}
        prefillContent={`Customer: ${customer?.farm_name || 'Unknown'}`}
      />

    </div>
  );
}
