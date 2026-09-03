import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Plus,
  Trash2,
  Search,
  RotateCcw,
  AlertTriangle,
  X,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { supabase, assertRpcResult } from '../lib/db';
import { withBelowCostReason } from '../lib/belowCostApproval';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useFormDraft } from '../hooks/useFormDraft';
import { useCreditLimitCheck } from '../hooks/useGuardrails';
import GuardrailBanner from '../components/ui/GuardrailBanner';
import { notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { sendOrderConfirmedEmail } from '../lib/orderConfirmedEmail';
import { checkRUPCompliance } from '../lib/rupCompliance';
import { logActivity } from '../lib/activityLogger';
import { trackBusinessEvent } from '../lib/metrics';
import { localToday } from '../lib/dateUtils';
import SearchableSelect from '../components/ui/SearchableSelect';
import { fetchOpenBookings, type OpenBooking } from '../lib/openBookings';
import { validateInventoryPositionShape } from '../lib/inventoryPositionValidator';
import { inventoryPositionByProduct } from '../lib/inventoryPositionLookup';
import { ProductOptionDetails } from '../components/products/ProductOptionPresentation';
import type { Product, Customer, InventoryPositionRow } from '../types';

interface LocalItem {
  _key: string;
  product_id: string;
  product_name: string;
  quantity: number;
  price_per_unit: number;
  price_override: number | null;
  unit_cost: number;
  unit_size: string | null;
  notes: string | null;
  profit: number;
  net_margin: number;
  total_price: number;
}

let keyCounter = 0;
function nextKey() {
  return `_k${++keyCounter}`;
}

function makeEmptyItem(): LocalItem {
  return {
    _key: nextKey(),
    product_id: '',
    product_name: '',
    quantity: 0,
    price_per_unit: 0,
    price_override: null,
    unit_cost: 0,
    unit_size: null,
    notes: null,
    profit: 0,
    net_margin: 0,
    total_price: 0,
  };
}

export default function NewOrder() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const createOrderIdem = useIdempotencyKey('create_direct_order', profile?.id || '');
  const rushOrderIdem = useIdempotencyKey('create_rush_order', profile?.id || '');
  const { warning: creditWarning, check: checkCreditLimit, dismiss: dismissCreditWarning } = useCreditLimitCheck();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const customerIdParam = searchParams.get('customer_id') || '';
  const customerParamApplied = useRef(false);
  const [customerId, setCustomerId] = useState('');
  const [orderName, setOrderName] = useState('');
  const [orderDate, setOrderDate] = useState(localToday());
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState('');
  const [customerPoNumber, setCustomerPoNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LocalItem[]>([makeEmptyItem()]);
  // Ship-now/price-later (#2): when on, submit via create_rush_order (unpriced).
  const [priceLater, setPriceLater] = useState(false);
  // DORMANT (Mason 2026-06-13: field-staff rush ordering deferred — routes +
  // create_rush_order are admin/sales only). These guards stay as forward-prep for
  // the future field-staff feature; isFieldStaff is currently always false here, so
  // admin/sales see the full pricing UI unchanged. When the feature is built (with
  // scoped RLS on orders/order_items + PAGE_PERMISSIONS), re-open the routes and
  // these guards already hide all cost/profit/margin from field staff.
  const isFieldStaff = profile?.role === 'driver' || profile?.role === 'applicator';
  useEffect(() => {
    if (isFieldStaff) setPriceLater(true);
  }, [isFieldStaff]);
  // B1 (deep-dive H1): RUP point-of-sale warning — same pattern as QuoteBuilder
  const [rupWarnings, setRupWarnings] = useState<string[]>([]);

  // Codex P2 fix (PR #59, 2026-05-16): reset createOrderIdem when form intent
  // changes. Page stays mounted after a failed/lost-response submit; without
  // reset, editing customer/items/date and resubmitting would replay the
  // prior cached order_id. Stable form = idempotent retry; changed = fresh key.
  // Hash MUST cover every submitted field (RPC sends customer/date/name/notes
  // + items[product_id,product_name,quantity,price,cost,unit_size]). Codex
  // 2026-05-16 follow-up: omitting any field replays prior success silently.
  const orderIntentHash = [
    customerId, orderDate, orderName, notes, customerPoNumber,
    items
      .map((i) => `${i.product_id}:${i.product_name || ''}:${i.quantity}:${i.price_per_unit}:${i.unit_cost}:${i.unit_size || ''}`)
      .sort()
      .join(','),
  ].join('|');
  useEffect(() => {
    createOrderIdem.resetKey();
    // Codex P2: the rush-order path shares this form, so reset its key too —
    // otherwise a lost rush response + edited customer/items would replay the
    // stale cached rush order and silently ignore the edits.
    rushOrderIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderIntentHash]);

  // Draft persistence: auto-saves form to sessionStorage so data survives
  // a PWA reload when the user switches away on mobile (e.g. to the calculator).
  // Codex round-7 P2: include priceLater so a reload doesn't silently downgrade a
  // rush (price-later) order back to a normal priced order on submit.
  const draftState = { customerId, orderName, orderDate, customerPoNumber, notes, items, priceLater };
  const { draft, clearDraft } = useFormDraft<typeof draftState>('new-order', draftState);

  // Restore draft on mount (runs once after loading completes)
  const [draftRestored, setDraftRestored] = useState(false);
  useEffect(() => {
    if (!loading && !draftRestored && draft) {
      setCustomerId(draft.customerId || '');
      setOrderName(draft.orderName || '');
      setOrderDate(draft.orderDate || localToday());
      setCustomerPoNumber(draft.customerPoNumber || '');
      setNotes(draft.notes || '');
      if (draft.priceLater) setPriceLater(true);
      if (draft.items && draft.items.length > 0) {
        // Re-key items to avoid stale React keys
        setItems(draft.items.map((item) => ({ ...item, _key: nextKey() })));
      }
      setDraftRestored(true);
      toast('info', 'Draft restored — your previous entries have been recovered.');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const [duplicateProductNames, setDuplicateProductNames] = useState<string[]>([]);
  const [openBookings, setOpenBookings] = useState<OpenBooking[]>([]);
  const [openBookingsDismissed, setOpenBookingsDismissed] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [inventoryByProduct, setInventoryByProduct] = useState<Record<string, { available: number; prebooked: number; onOrder: number }>>({});

  const fetchData = useCallback(async () => {
    const [customersRes, productsRes] = await Promise.all([
      supabase.from('customers').select('*').order('farm_name'),
      supabase.from('products').select('*, product_family:product_families(name)').eq('is_active', true).order('product_name'),
    ]);
    const { data: positionData, error: positionError } = await supabase.rpc('get_inventory_position');

    if (customersRes.error) {
      Sentry.captureException(customersRes.error, { tags: { source: 'fetch', action: 'load_customers' } });
      toast('error', 'Failed to load customers. Please refresh.');
    }
    if (productsRes.error) {
      Sentry.captureException(productsRes.error, { tags: { source: 'fetch', action: 'load_products' } });
      toast('error', 'Failed to load products. Please refresh.');
    }
    if (positionError) {
      Sentry.captureException(positionError, { tags: { source: 'fetch', action: 'load_inventory_position' } });
      toast('error', 'Failed to load inventory positions. Please refresh.');
    }

    if (positionError) {
      setInventoryByProduct({});
    } else {
      try {
        const positionRows = assertRpcResult<InventoryPositionRow[]>(positionData, 'get_inventory_position');
        validateInventoryPositionShape(positionRows);
        setInventoryByProduct(inventoryPositionByProduct(positionRows));
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'parse_inventory_position' } });
        toast('error', 'Inventory position data was malformed. Please refresh.');
        setInventoryByProduct({});
      }
    }

    setCustomers((customersRes.data || []) as Customer[]);
    setProducts((productsRes.data || []) as Product[]);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Tier price lookup — cascades: tier3 → tier2 → tier1 fallback
  const getTierPrice = useCallback(
    (product: Product, tierNum: number): number => {
      const t1 = product.tier1_price || 0;
      if (tierNum === 1) return t1;
      if (tierNum === 2) return product.tier2_price || t1;
      return product.tier3_price || t1;
    },
    []
  );

  // Recalculate margin fields for a single item
  const recalcItem = useCallback(
    (item: LocalItem, tierNum: number): LocalItem => {
      const product = products.find((p) => p.id === item.product_id);
      if (!product) return item;

      const tierPrice = getTierPrice(product, tierNum);
      const pricePerUnit = item.price_override != null ? item.price_override : tierPrice;
      const qty = item.quantity || 0;
      const cost = product.current_cost || 0;

      const totalPrice = pricePerUnit * qty;
      const profit = (pricePerUnit - cost) * qty;
      const netMargin = totalPrice > 0 ? (profit / totalPrice) * 100 : 0;

      return {
        ...item,
        price_per_unit: pricePerUnit,
        unit_cost: cost,
        total_price: Math.round(totalPrice * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        net_margin: Math.round(netMargin * 100) / 100,
      };
    },
    [products, getTierPrice]
  );

  // Get current customer tier
  // RUP compliance check when customer or product SET changes (B1).
  // Keyed on the sorted product-id string (not the items array identity) so
  // quantity/price keystrokes don't re-fetch, and logged once per
  // customer+product-set so editing doesn't spam activity_feed.
  const rupProductKey = items.map((i) => i.product_id).filter(Boolean).sort().join(',');
  const lastRupLogKey = useRef('');
  useEffect(() => {
    if (!customerId || !rupProductKey) { setRupWarnings([]); return; }
    let cancelled = false;
    checkRUPCompliance(customerId, rupProductKey.split(',')).then((res) => {
      if (!cancelled) {
        setRupWarnings(res.warnings);
        const logKey = `${customerId}|${rupProductKey}`;
        if (res.warnings.length > 0 && profile?.id && lastRupLogKey.current !== logKey) {
          lastRupLogKey.current = logKey;
          logActivity({ event: 'rup_compliance_warning', description: `RUP products (${res.rupProductNames.join(', ')}) on direct order for customer without valid license`, performedBy: profile.id, entityType: 'customer', entityId: customerId, customerId });
        }
      }
    });
    return () => { cancelled = true; };
  }, [customerId, rupProductKey, profile?.id]);

  const customerTier = customers.find((c) => c.id === customerId)?.assigned_tier || 1;

  const handleCustomerChange = useCallback((newId: string) => {
    if (!newId) {
      // An empty id is a cleared picker, not a re-tiering event; overrides must survive until a REAL customer pick re-tiers.
      setCustomerId('');
      return;
    }

    setCustomerId(newId);
    // Recalculate all items with the new customer's tier, clearing overrides.
    const newTier = customers.find((customer) => customer.id === newId)?.assigned_tier || 1;
    setItems((previousItems) =>
      previousItems.map((item) => recalcItem({ ...item, price_override: null }, newTier))
    );
  }, [customers, recalcItem]);

  // A delivery or customer detail page can hand a customer into order entry.
  // Apply the query parameter once after the customer list loads, then leave all
  // subsequent choices to the user.
  useEffect(() => {
    if (loading || customerParamApplied.current) return;
    customerParamApplied.current = true;

    if (customerIdParam && customers.some((customer) => customer.id === customerIdParam)) {
      handleCustomerChange(customerIdParam);
    }
  }, [customerIdParam, customers, handleCustomerChange, loading]);

  useEffect(() => {
    if (!customerId) {
      setOpenBookings([]);
      setOpenBookingsDismissed(false);
      return;
    }

    let cancelled = false;
    setOpenBookings([]);
    setOpenBookingsDismissed(false);
    fetchOpenBookings(customerId).then((bookings) => {
      if (!cancelled) setOpenBookings(bookings);
    });

    return () => { cancelled = true; };
  }, [customerId]);

  const selectedProductKey = [...new Set(items.map((item) => item.product_id).filter(Boolean))]
    .sort()
    .join(',');
  useEffect(() => {
    if (!customerId || !selectedProductKey) {
      setDuplicateProductNames([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const productIds = selectedProductKey.split(',');
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const { data: recentOrders, error: recentOrdersError } = await supabase
          .from('orders')
          .select('id')
          .eq('customer_id', customerId)
          .is('deleted_at', null)
          .gte('created_at', twoDaysAgo);

        if (recentOrdersError) throw recentOrdersError;
        const orderIds = ((recentOrders || []) as Array<{ id: string }>).map((order) => order.id);
        if (!orderIds.length) {
          if (!cancelled) setDuplicateProductNames([]);
          return;
        }

        const { data: recentOrderItems, error: recentOrderItemsError } = await supabase
          .from('order_items')
          .select('product_id')
          .in('order_id', orderIds)
          .in('product_id', productIds);

        if (recentOrderItemsError) throw recentOrderItemsError;
        const duplicateProductIds = [...new Set(
          ((recentOrderItems || []) as Array<{ product_id: string }>).map((item) => item.product_id)
        )];
        const productNames = duplicateProductIds.map(
          (productId) => products.find((product) => product.id === productId)?.product_name || 'Selected product'
        );
        if (!cancelled) setDuplicateProductNames(productNames);
      } catch {
        // This is a best-effort warning only. A failed lookup must never block a sale.
        if (!cancelled) setDuplicateProductNames([]);
      }
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [customerId, products, selectedProductKey]);

  const addItem = () => {
    setItems([...items, makeEmptyItem()]);
  };

  const removeItem = (key: string) => {
    if (items.length === 1) {
      toast('error', 'Cannot remove last item');
      return;
    }
    setItems(items.filter((item) => item._key !== key));
  };

  const updateItemFields = (key: string, updates: Partial<LocalItem>) => {
    setItems(
      items.map((item) => {
        if (item._key !== key) return item;
        const merged = { ...item, ...updates };
        return recalcItem(merged, customerTier);
      })
    );
  };

  // Legacy single-field update (for notes, unit_size, etc.)
  const updateItem = (key: string, field: keyof LocalItem, value: string | number | null) => {
    updateItemFields(key, { [field]: value });
  };

  const openProductModal = (itemKey: string) => {
    setSelectedItemKey(itemKey);
    setShowProductModal(true);
    setProductSearch('');
  };

  const selectProduct = (product: Product) => {
    if (!selectedItemKey) return;

    setItems(
      items.map((item) => {
        if (item._key !== selectedItemKey) return item;
        // Reset override when swapping product — fresh start with tier price
        const merged: LocalItem = {
          ...item,
          product_id: product.id,
          product_name: product.product_name,
          price_override: null,
          unit_cost: product.current_cost || 0,
          unit_size: product.unit_size || null,
        };
        return recalcItem(merged, customerTier);
      })
    );

    setShowProductModal(false);
    setSelectedItemKey(null);
  };

  const handleSave = async () => {
    if (!customerId) {
      toast('error', 'Please select a customer');
      return;
    }

    const validItems = items.filter((item) => item.product_id && item.quantity > 0);
    if (validItems.length === 0) {
      toast('error', 'Please add at least one item with quantity');
      return;
    }

    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    // Guardrail: check credit limit before creating order. SKIP for field staff
    // (#2 Codex round 2 HIGH): their order is an UNPRICED rush order ($0), so the
    // check is meaningless — and the GuardrailBanner it raises would leak the
    // customer's credit limit + over-by $ (computed from the in-state tier price)
    // to a driver/applicator. The real credit exposure is assessed when an admin
    // prices the order (price_order) and at post time.
    if (!isFieldStaff) {
      const totalCents = items.filter(i => i.product_id && i.quantity > 0)
        .reduce((sum, i) => sum + Math.round(i.total_price * 100), 0);
      const creditOk = await checkCreditLimit({ customerId, newAmountCents: totalCents });
      if (!creditOk && !creditWarning?.dismissed) return;
    }

    await submitOrder();
  };

  const submitOrder = async () => {
    if (!profile) return;
    const validItems = items.filter((item) => item.product_id && item.quantity > 0);
    setSaving(true);

    await runCriticalAction({
      action: async () => {
        // Ship-now/price-later (#2): create an UNPRICED rush order (needs_pricing);
        // prices are finalized later via the order's Set Pricing panel → price_order.
        if (priceLater) {
          const rushKey = rushOrderIdem.getKey();
          // Codex round-9 P2: pass the customer PO INTO the SECDEF RPC (it sets it on the
          // INSERT as owner). The old follow-up `orders.update({customer_po_number})` hit
          // the is_admin()-only orders UPDATE RLS, so a sales_rep got a false failure
          // (order already created, PO lost, not retryable) — no direct order UPDATE here.
          const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('create_rush_order', withBelowCostReason('create_rush_order', {
            p_customer_id: customerId,
            p_items: validItems.map((item) => ({ product_id: item.product_id, qty: item.quantity })),
            p_notes: notes || undefined,
            p_customer_po_number: customerPoNumber.trim() || undefined,
            p_performed_by: profile.id,
            p_idempotency_key: rushKey,
          }, reason)));
          if (error) throw error;
          const rushResult = assertRpcResult<{ order_id: string; order_number: string; warnings?: string[] }>(data, 'create_rush_order');
          const rushOrderId = rushResult.order_id;
          rushOrderIdem.resetKey();
          clearDraft();
          if (rushResult.warnings && rushResult.warnings.length > 0) {
            for (const w of rushResult.warnings) toast('warning', 'Inventory: ' + w);
          }
          trackBusinessEvent('order_created', {
            message: `Rush order ${rushResult.order_number} created — needs pricing`,
            data: { orderId: rushOrderId, orderNumber: rushResult.order_number, itemCount: validItems.length, priceLater: true },
          });
          // Admin pricing alert is emitted server-side by create_rush_order (SECDEF,
          // RLS-bypassing) — Codex P2: the frontend insert failed the notifications
          // RLS for sales_rep/driver/applicator creators (now a real case).
          navigate(`/orders/${rushOrderId}`);
          return;
        }
        const idemKey = createOrderIdem.getKey();
        const rpcItems = validItems.map((item) => ({
          product_id: item.product_id,
          product_name: item.product_name,
          quantity: item.quantity,
          price_per_unit: item.price_per_unit,
          unit_cost: item.unit_cost,
          unit_size: item.unit_size,
        }));

        const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('create_direct_order', withBelowCostReason('create_direct_order', {
          p_customer_id: customerId,
          p_order_date: orderDate,
          p_order_name: orderName || undefined,
          p_notes: notes || undefined,
          p_items: rpcItems,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
          p_customer_po_number: customerPoNumber.trim() || undefined,
        }, reason)));

        if (error) throw error;

        const result = assertRpcResult<{ order_id: string; warnings?: string[] }>(data, 'create_direct_order');
        createOrderIdem.resetKey();
        const orderId = result.order_id;

        clearDraft();

        // Show inventory warnings (non-blocking)
        const warnings = result.warnings;
        if (warnings && warnings.length > 0) {
          for (const w of warnings) {
            toast('warning', 'Inventory: ' + w);
          }
        }
        trackBusinessEvent('order_created', {
          message: `Direct order created${orderName ? ` (${orderName})` : ''}`,
          data: { orderId, orderName: orderName || null, itemCount: items.filter((i) => i.product_id).length },
        });

        // Phase 3.3: Credit limit check — warn (not block) if exceeded
        if (customerId) {
          try {
            const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', {
              p_customer_id: customerId,
            });
            const cl = assertRpcResult<{ exceeded?: boolean; farm_name?: string; outstanding_ar?: number; credit_limit?: number } | null>(creditCheck, 'check_customer_credit_limit');
            if (cl && cl.exceeded) {
              const fmtUsd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
              toast('warning', `Credit limit warning: ${cl.farm_name} outstanding AR ${fmtUsd(cl.outstanding_ar ?? 0)} exceeds limit ${fmtUsd(cl.credit_limit ?? 0)}`);
              notifyCreditLimitExceeded(cl.farm_name ?? 'Unknown', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, customerId);
            }
          } catch {
            // Non-blocking — credit limit check failure should not prevent navigation
          }
        }

        // Wave A.2 / P1-7: send the customer "Order Confirmed" email at the
        // creation site (orders are born at status='confirmed' — there is no
        // transition to gate on). Fire-and-forget; helper swallows its own errors.
        sendOrderConfirmedEmail(orderId);

        if (requestedDeliveryDate) {
          navigate(`/deliveries/new?order=${encodeURIComponent(orderId)}&date=${encodeURIComponent(requestedDeliveryDate)}`);
        } else {
          navigate(`/orders/${orderId}`);
        }
      },
      toast,
      successMessage: 'Order created successfully',
      setLoading: setSaving,
      sentryTag: 'create_order',
    });
  };

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.manufacturer?.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products;

  // Currency formatter
  const fmtUsd = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);

  // Order totals
  const validItems = items.filter((i) => i.product_id && i.quantity > 0);
  const orderTotal = validItems.reduce((sum, i) => sum + i.total_price, 0);
  const orderProfit = validItems.reduce((sum, i) => sum + i.profit, 0);
  const orderMargin = orderTotal > 0 ? (orderProfit / orderTotal) * 100 : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/orders')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-nav-dark">New Order</h1>
            <p className="text-sm text-secondary">{priceLater ? 'Ship now, price later — rush order (unpriced)' : 'Create a direct order'}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {duplicateProductNames.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
              <span>This customer ordered {duplicateProductNames.join(', ')} in the last 2 days — possible duplicate.</span>
            </div>
          )}
          <Button onClick={handleSave} disabled={saving}>
            <Save className="w-4 h-4" />
            {saving ? 'Creating...' : 'Create Order'}
          </Button>
        </div>
      </div>

      <GuardrailBanner warning={creditWarning} onDismiss={dismissCreditWarning} />

      {rupWarnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          </div>
        </div>
      )}

      <Card>
        <CardHeader title="Order Information" />
        <div className="p-5 space-y-4">
          {openBookings.length > 0 && !openBookingsDismissed && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              <div className="min-w-0 flex-1">
                <p>
                  This customer has {openBookings.length} open booking{openBookings.length === 1 ? '' : 's'} —{' '}
                  {openBookings.map((booking, index) => (
                    <span key={booking.id}>
                      {index > 0 && ', '}
                      <button
                        type="button"
                        onClick={() => navigate(`/quotes/${booking.id}`)}
                        className="font-medium underline decoration-blue-400 underline-offset-2 hover:text-blue-700"
                      >
                        Quote {booking.quote_number}
                      </button>
                    </span>
                  ))}.
                </p>
                <p className="mt-1 text-blue-800">
                  Product on a booking should usually be DRAWN from it (locked price) instead of a new order.
                </p>
              </div>
              <button
                type="button"
                aria-label="Dismiss open bookings notice"
                onClick={() => setOpenBookingsDismissed(true)}
                className="rounded p-1 text-blue-500 hover:bg-blue-100 hover:text-blue-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={priceLater}
              onChange={(e) => setPriceLater(e.target.checked)}
              disabled={isFieldStaff}
              className="rounded border-gray-300 text-crx-green focus:ring-crx-green disabled:opacity-50"
            />
            <span className="font-medium">Ship now, price later (rush order)</span>
            {isFieldStaff && <span className="text-xs text-secondary">(required for your role — pricing is set by an admin later)</span>}
          </label>
          {priceLater && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm">
              Price-later mode: the order is created <strong>unpriced</strong> (marked “needs pricing”) and inventory is reserved. The price/cost fields below are ignored — finalize prices later on the order's <strong>Set Pricing</strong> panel. The invoice can't be posted until then.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <SearchableSelect
              label="Customer"
              required
              value={customerId}
              onChange={handleCustomerChange}
              options={customers.map((customer) => ({
                value: customer.id,
                label: customer.farm_name,
                sublabel: customer.account_number || undefined,
              }))}
              placeholder="Search by farm name or account number..."
            />

            {/* Codex round-4 P2: hide Order Name + Order Date in rush/price-later
                mode — create_rush_order persists neither (it ships at CURRENT_DATE
                with an auto-generated number), so showing them would silently
                discard whatever the user typed. (Order-level Notes IS persisted
                via p_notes, so it stays visible below.) */}
            {!priceLater && (
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">
                  Order Name
                </label>
                <Input
                  value={orderName}
                  onChange={(e) => setOrderName(e.target.value)}
                  placeholder="e.g., Corn Burndown"
                />
                <p className="text-xs text-secondary mt-1">Optional — order number is auto-generated</p>
              </div>
            )}

            {!priceLater && (
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">
                  Order Date
                </label>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
                />
              </div>
            )}

            {!priceLater && (
              <Input
                label="Requested delivery (optional) — schedules next"
                type="date"
                value={requestedDeliveryDate}
                onChange={(e) => setRequestedDeliveryDate(e.target.value)}
              />
            )}

            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">
                Customer PO#
              </label>
              <Input
                value={customerPoNumber}
                onChange={(e) => setCustomerPoNumber(e.target.value)}
                placeholder="e.g., PO-12345"
              />
              <p className="text-xs text-secondary mt-1">Optional — customer&apos;s purchase order reference</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
              placeholder="Additional notes..."
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Order Items"
          action={
            <Button variant="secondary" size="sm" onClick={addItem}>
              <Plus className="w-4 h-4" />
              Add Item
            </Button>
          }
        />
        <div className="p-5 space-y-3">
          {items.map((item) => (
            <div
              key={item._key}
              className="border border-gray-200 rounded-lg p-4 space-y-3"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Product *
                      </label>
                      <button
                        type="button"
                        onClick={() => openProductModal(item._key)}
                        className="w-full px-3 py-2 text-left border border-gray-200 rounded-lg hover:border-crx-green transition-colors focus:outline-none focus:ring-2 focus:ring-crx-green/20"
                      >
                        {item.product_name ? <>
                          <span>{item.product_name}</span>
                          {products.find((product) => product.id === item.product_id) && <ProductOptionDetails product={products.find((product) => product.id === item.product_id)!} />}
                        </> : (
                          <span className="text-secondary flex items-center gap-2">
                            <Search className="w-4 h-4" />
                            Select product...
                          </span>
                        )}
                      </button>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Quantity *
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.quantity || ''}
                        onChange={(e) =>
                          updateItem(item._key, 'quantity', parseFloat(e.target.value) || 0)
                        }
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    {/* #2 (Codex round 2 BLOCKER): HIDE price/cost inputs from field
                        staff — a disabled input still renders its value (raw cost +
                        tier sell price) as legible greyed text. */}
                    {!isFieldStaff && (<>
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Price per Unit
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          step="any"
                          min={0}
                          disabled={priceLater}
                          value={item.price_per_unit || ''}
                          onChange={(e) => {
                            const val = e.target.value ? parseFloat(e.target.value) : 0;
                            const prod = products.find((p) => p.id === item.product_id);
                            const tierPrice = prod ? getTierPrice(prod, customerTier) : 0;
                            const isOverride = Math.abs(val - tierPrice) > 0.001;
                            updateItemFields(item._key, {
                              price_override: isOverride ? val : null,
                              price_per_unit: val,
                            });
                          }}
                          aria-label="Price per unit"
                          className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green ${
                            item.price_override != null
                              ? 'border-amber-400 bg-amber-50'
                              : 'border-gray-200'
                          }`}
                        />
                        {item.price_override != null && (
                          <button
                            onClick={() =>
                              updateItemFields(item._key, { price_override: null })
                            }
                            title={`Reset to tier ${customerTier} price: ${fmtUsd(
                              products.find((p) => p.id === item.product_id)
                                ? getTierPrice(products.find((p) => p.id === item.product_id)!, customerTier)
                                : 0
                            )}`}
                            aria-label="Reset price to catalog"
                            className="p-1.5 rounded text-amber-500 hover:text-amber-700 hover:bg-amber-100 transition-colors flex-shrink-0"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Wave A (ordering-cycle review 2026-08-09): unit cost is
                        display-only. create_direct_order now resolves cost from
                        products.current_cost and discards whatever the payload
                        carries, so an editable field here would show the rep a
                        profit and margin the saved order will not have. Read the
                        catalogue value, do not let it be typed over. */}
                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Unit Cost
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        value={item.unit_cost || ''}
                        disabled
                        readOnly
                        title="Cost comes from the product catalog and cannot be edited here. Update the product to change it."
                      />
                    </div>
                    </>)}

                    <div>
                      <label className="block text-xs font-medium text-secondary mb-1">
                        Unit Size
                      </label>
                      <Input
                        value={item.unit_size || ''}
                        onChange={(e) => updateItem(item._key, 'unit_size', e.target.value)}
                        placeholder="e.g., 2.5 gal"
                      />
                    </div>

                    {/* Codex round-4 P2: hide per-item Notes in rush/price-later
                        mode — create_rush_order takes only {product_id, qty} per
                        line and never stores item notes, so the field would be
                        silently discarded. */}
                    {!priceLater && (
                      <div>
                        <label className="block text-xs font-medium text-secondary mb-1">
                          Notes
                        </label>
                        <Input
                          value={item.notes || ''}
                          onChange={(e) => updateItem(item._key, 'notes', e.target.value)}
                          placeholder="Item notes..."
                        />
                      </div>
                    )}
                  </div>

                  {!isFieldStaff && item.product_id && item.quantity > 0 && (
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <div className="flex flex-wrap gap-x-6 gap-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-secondary">Total:</span>
                          <span className="font-medium font-mono">
                            {fmtUsd(item.total_price)}
                          </span>
                        </div>
                        {/* #2 (Codex round 2 BLOCKER): never show cost/profit/margin
                            to field staff (driver/applicator) — recalcItem computes
                            real values from product cost/tier price even in rush mode. */}
                        {!isFieldStaff && (<>
                        <div className="flex items-center gap-2">
                          <span className="text-secondary">Profit:</span>
                          <span className={`font-medium font-mono ${item.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {fmtUsd(item.profit)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-secondary">Margin:</span>
                          <span className={`font-medium font-mono ${
                            item.net_margin >= 20 ? 'text-emerald-600' : item.net_margin >= 10 ? 'text-amber-600' : 'text-red-600'
                          }`}>
                            {item.net_margin.toFixed(1)}%
                          </span>
                        </div>
                        </>)}
                        {!isFieldStaff && item.price_override != null && (
                          <span className="text-xs text-amber-600 italic">price overridden</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  onClick={() => removeItem(item._key)}
                  className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title="Remove item"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Order Totals Summary — hidden for field staff (#2 Codex round 2: no pricing/margin) */}
      {!isFieldStaff && validItems.length > 0 && (
        <Card>
          <div className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h3 className="text-sm font-medium text-secondary uppercase tracking-wider">Order Totals</h3>
              <div className="flex flex-wrap items-center gap-6 text-sm">
                <div>
                  <span className="text-secondary mr-2">Total:</span>
                  <span className="font-semibold font-mono text-nav-dark">{fmtUsd(orderTotal)}</span>
                </div>
                {!isFieldStaff && (<>
                <div>
                  <span className="text-secondary mr-2">Profit:</span>
                  <span className={`font-semibold font-mono ${orderProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {fmtUsd(orderProfit)}
                  </span>
                </div>
                <div>
                  <span className="text-secondary mr-2">Margin:</span>
                  <span className={`font-semibold font-mono ${
                    orderMargin >= 20 ? 'text-emerald-600' : orderMargin >= 10 ? 'text-amber-600' : 'text-red-600'
                  }`}>
                    {orderMargin.toFixed(1)}%
                  </span>
                </div>
                </>)}
              </div>
            </div>
          </div>
        </Card>
      )}

      <Modal
        open={showProductModal}
        onClose={() => setShowProductModal(false)}
        title="Select Product"
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
              const tierPrice = getTierPrice(product, customerTier);
              const inv = inventoryByProduct[product.id];
              const onFloor = inv ? inv.available : 0;
              const netPos = inv ? inv.onOrder + inv.available - inv.prebooked : 0;

              return (
              <button
                key={product.id}
                onClick={() => selectProduct(product)}
                className="w-full text-left p-3 border border-gray-200 rounded-lg hover:border-crx-green hover:bg-gray-50 transition-colors"
              >
                <div className="font-medium text-nav-dark">{product.product_name}</div>
                <ProductOptionDetails product={product} />
                {product.manufacturer && (
                  <div className="text-xs text-secondary mt-1">{product.manufacturer}</div>
                )}
                <div className="flex items-center gap-4 mt-2 text-xs text-secondary">
                  {product.unit_size && <span>Size: {product.unit_size}</span>}
                  {!isFieldStaff && tierPrice > 0 && (
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
    </div>
  );
}
