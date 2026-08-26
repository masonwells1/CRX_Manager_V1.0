import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Plus,
  Trash2,
  PackageCheck,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  Printer,
  RotateCcw,
  Search,
} from 'lucide-react';
import Card, { CardHeader } from '../ui/Card';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, assertRpcResult } from '../../lib/db';
import {
  UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE,
  UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE,
  useUncertainMutationIntent,
} from '../../hooks/useUncertainMutationIntent';
import { getIdempotencyMismatchResult } from '../../lib/idempotency';
import { Sentry } from '../../lib/sentry';
import HelpTip from '../ui/HelpTip';
import { notifyDamagedReceiving } from '../../lib/notificationTriggers';
import { formatUSD as fmt } from '../../lib/money';
import type {
  Product,
  ReceivingCondition,
  QuickReceiveItem,
  QuickReceiveMatchResult,
} from '../../types';
import { ProductOptionDetails, type ProductOptionPresentationModel } from '../products/ProductOptionPresentation';
import { ProductSearchResultRow } from '../products/ProductSearchResultRow';

type PickerProduct = Product & ProductOptionPresentationModel;

type QuickReceivePayloadItem = {
  po_item_id: string;
  quantity: number;
  condition: string;
  lot_number: string | null;
  notes: string | null;
  storage_location: string;
};

type QuickReceiveIntent = {
  itemsPayload: QuickReceivePayloadItem[];
  performedBy: string;
  receivedByName: string;
  vendor: string;
  storageLocation: string;
  matchResults: QuickReceiveMatchResult[];
  sourceItems: QuickReceiveItem[];
};

/* ─── helpers ─── */
let keyCounter = 0;
function nextKey() {
  return `qr_${++keyCounter}`;
}
const STORAGE_LOCATIONS = [
  'Main Warehouse',
  'Secondary Storage',
  'Cold Storage',
  'Field Storage',
];

const CONDITIONS: { value: ReceivingCondition; label: string }[] = [
  { value: 'good', label: 'Good' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'short', label: 'Short' },
  { value: 'wrong_product', label: 'Wrong Product' },
  { value: 'mixed', label: 'Mixed' },
];

const conditionVariant = (c: string): 'success' | 'error' | 'warning' | 'default' => {
  if (c === 'good') return 'success';
  if (c === 'damaged' || c === 'wrong_product') return 'error';
  if (c === 'short' || c === 'mixed') return 'warning';
  return 'default';
};

/* ═══════════════════════════════════════════════════════════════════ */
export default function QuickReceivePanel() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const receiveIntent = useUncertainMutationIntent<QuickReceiveIntent>({
    operation: 'receive_po_items',
    userId: profile?.id || '',
    surface: 'quick-receive',
    getIntentIdentity: (intent) => ({
      p_items: intent.itemsPayload,
      p_performed_by: intent.performedBy,
      p_allow_over_receive: false,
    }),
  });

  /* ─── step control ─── */
  type Step = 'add_items' | 'review' | 'success';
  const [step, setStep] = useState<Step>('add_items');

  /* ─── step 1 state ─── */
  const [vendor, setVendor] = useState('');
  const [storageLocation, setStorageLocation] = useState('Main Warehouse');
  const [items, setItems] = useState<QuickReceiveItem[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  /* ─── product search modal ─── */
  const [productSearchOpen, setProductSearchOpen] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');

  /* ─── step 2 state ─── */
  const [matchResults, setMatchResults] = useState<QuickReceiveMatchResult[] | null>(null);
  const [matching, setMatching] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({}); // productId -> poItemId
  const [unmatchedActions, setUnmatchedActions] = useState<Record<string, 'over_receive' | 'skip'>>({});

  /* ─── step 3 / submission ─── */
  const [saving, setSaving] = useState(false);
  const [receiveCount, setReceiveCount] = useState(0);

  useEffect(() => {
    const recovered = receiveIntent.unresolvedIntent;
    if (!recovered) return;
    setVendor(recovered.vendor);
    setStorageLocation(recovered.storageLocation);
    setItems(recovered.sourceItems);
    setMatchResults(recovered.matchResults);
    setOverrides({});
    setUnmatchedActions({});
    setStep('review');
  }, [receiveIntent.unresolvedIntent]);

  /* ─── load products + vendors ─── */
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('products')
        .select('*, product_family:product_families(name)')
        .eq('is_active', true)
        .order('product_name');
      if (error) {
        Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_quick_receive_products' } });
        toast('error', 'Failed to load Products. Retry before receiving inventory.');
        return;
      }
      const prods = (data || []) as unknown as PickerProduct[];
      setProducts(prods);
      const uv = [...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[];
      setVendors(uv.sort());
    })();
  // Toast identity is not a data dependency; this catalog loads once per panel mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─── item crud ─── */
  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        key: nextKey(),
        product_id: '',
        product_name: '',
        sku: null,
        quantity: 0,
        condition: 'good',
        lot_number: '',
        notes: '',
      },
    ]);
  };

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
    setExpandedItems((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const updateItem = (key: string, field: keyof QuickReceiveItem, value: string | number) => {
    setItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, [field]: value } : i))
    );
  };

  const assignProduct = (itemKey: string, product: Product) => {
    setItems((prev) =>
      prev.map((i) =>
        i.key === itemKey
          ? { ...i, product_id: product.id, product_name: product.product_name, sku: product.sku }
          : i
      )
    );
    setProductSearchOpen(null);
    setProductQuery('');
  };

  const toggleExpanded = (key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* ─── product search filter ─── */
  const filteredProducts = products.filter((p) => {
    if (!productQuery.trim()) return true;
    const q = productQuery.toLowerCase();
    return (
      p.product_name.toLowerCase().includes(q) ||
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.vendor && p.vendor.toLowerCase().includes(q))
    );
  });

  /* ─── valid items for review ─── */
  const validItems = items.filter((i) => i.product_id && i.quantity > 0);

  /* ═══════════════════════════════════════════════════════════════════
     STEP 2: Match items to open POs
  ═══════════════════════════════════════════════════════════════════ */
  const handleReview = async () => {
    if (validItems.length === 0) {
      toast('error', 'Add at least one product with a quantity');
      return;
    }
    setMatching(true);
    try {
      const payload = validItems.map((i) => ({
        product_id: i.product_id,
        quantity: i.quantity,
        lot_number: i.lot_number || null,
      }));
      const { data, error } = await supabase.rpc('match_quick_receive_items', {
        p_items: payload,
        p_vendor: vendor || undefined,
      });
      if (error) throw error;
      setMatchResults(assertRpcResult<QuickReceiveMatchResult[]>(data, 'match_quick_receive_items'));
      setOverrides({});
      setUnmatchedActions({});
      setStep('review');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'match_quick_receive_items' } });
      toast('error', err instanceof Error ? err.message : 'Failed to match items');
    }
    setMatching(false);
  };

  /* ═══════════════════════════════════════════════════════════════════
     STEP 3: Confirm & receive
  ═══════════════════════════════════════════════════════════════════ */
  const submitQuickReceive = async (request: QuickReceiveIntent) => {
    const { data, error } = await supabase.rpc('receive_po_items', {
      p_items: request.itemsPayload,
      p_performed_by: request.performedBy,
      p_idempotency_key: receiveIntent.getIdempotencyKey(),
      p_allow_over_receive: false,
    });

    let result: Record<string, unknown>;
    if (error) {
      const receipt = getIdempotencyMismatchResult(error, 'receive_po_items');
      const committedRecordIds = receipt?.receiving_record_ids;
      if (
        receipt
        && Array.isArray(committedRecordIds)
        && committedRecordIds.every((recordId) => typeof recordId === 'string')
      ) {
        result = receipt;
        toast('warning', 'The earlier receipt already completed. Showing its result instead of receiving it twice.');
      } else {
        throw error;
      }
    } else {
      result = assertRpcResult<Record<string, unknown>>(data, 'receive_po_items');
    }

    await receiveIntent.resolveIntent();

    // Notifications and the PDF are non-critical side effects after the
    // database result is proven. Their failure must never retain a mutation
    // lock or cause another stock receipt.
    try {
      const damagedItems = request.itemsPayload.filter((item) => item.condition !== 'good');
      if (damagedItems.length > 0) {
        const damagedInfo = damagedItems.map((item) => {
          const match = request.matchResults.find((candidate) =>
            candidate.allocations.some((allocation) => allocation.po_item_id === item.po_item_id)
          );
          return {
            productName: match?.product_name || 'Unknown',
            quantity: item.quantity,
            condition: item.condition,
          };
        });
        const firstPO = request.matchResults[0]?.allocations?.[0]?.po_number || 'Quick Receive';
        const firstPOId = request.matchResults[0]?.allocations?.[0]?.purchase_order_id || '';
        notifyDamagedReceiving(firstPO, damagedInfo, firstPOId);
      }
    } catch {
      // Damaged-item notification is non-critical after a proven receipt.
    }

    const receivingRecordIds = result.receiving_record_ids;
    if (
      Array.isArray(receivingRecordIds)
      && receivingRecordIds.length > 0
      && receivingRecordIds.every((recordId) => typeof recordId === 'string')
    ) {
      try {
        const { downloadReceivingPdf } = await import('../../lib/receivingPdf');
        await downloadReceivingPdf({
          po_number: 'Quick Receive',
          vendor: request.vendor || 'Multiple / Unknown',
          received_at: new Date().toISOString(),
          received_by_name: request.receivedByName,
          storage_location: request.storageLocation,
          items: request.itemsPayload.map((item) => {
            const match = request.matchResults.find((candidate) =>
              candidate.allocations.some((allocation) => allocation.po_item_id === item.po_item_id)
            );
            return {
              product_name: match?.product_name || 'Unknown',
              quantity_received: item.quantity,
              condition: item.condition,
              lot_number: item.lot_number || undefined,
              notes: item.notes || undefined,
            };
          }),
        });
      } catch {
        // PDF is non-critical after a proven receipt.
      }
    }

    setReceiveCount(request.itemsPayload.length);
    setStep('success');
    toast('success', `Successfully received ${request.itemsPayload.length} item(s)`);
  };

  const handleConfirmReceive = async () => {
    if (receiveIntent.isForeignIntentLocked) {
      toast('error', UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE);
      return;
    }
    if (receiveIntent.isRetryExpired) {
      toast('error', UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE);
      return;
    }
    if (!profile) return;

    let request = receiveIntent.unresolvedIntent;
    if (!request) {
      if (!matchResults) return;

      // Defense in depth: refuse to submit if any price-variance product is missing an explicit PO choice.
      const unresolvedVariance = matchResults.find(
        (match) => match.has_multiple_costs && match.allocations.length > 0 && !overrides[match.product_id],
      );
      if (unresolvedVariance) {
        toast('error', `Choose which PO to receive ${unresolvedVariance.product_name} against — multiple POs at different prices.`);
        return;
      }

      const unresolvedUnmatched = matchResults.find(
        (match) => match.allocations.length > 0 && match.quantity_unmatched > 0 && !unmatchedActions[match.product_id],
      );
      if (unresolvedUnmatched) {
        toast(
          'error',
          `Choose what to do with the ${unresolvedUnmatched.quantity_unmatched} extra ${unresolvedUnmatched.product_name} unit(s) — over-receive or skip.`,
        );
        return;
      }

      const itemsPayload: QuickReceivePayloadItem[] = [];
      for (const match of matchResults) {
        const sourceItem = validItems.find((item) => item.product_id === match.product_id);
        if (!sourceItem) continue;
        if (match.allocations.length === 0 && unmatchedActions[match.product_id] === 'skip') continue;
        if (match.allocations.length === 0 && !unmatchedActions[match.product_id]) continue;

        const manualOverride = overrides[match.product_id];
        if (manualOverride) {
          itemsPayload.push({
            po_item_id: manualOverride,
            quantity: match.quantity_requested,
            condition: sourceItem.condition,
            lot_number: sourceItem.lot_number || null,
            notes: sourceItem.notes || null,
            storage_location: storageLocation,
          });
        } else {
          for (const allocation of match.allocations) {
            itemsPayload.push({
              po_item_id: allocation.po_item_id,
              quantity: allocation.quantity_allocated,
              condition: sourceItem.condition,
              lot_number: sourceItem.lot_number || null,
              notes: sourceItem.notes || null,
              storage_location: storageLocation,
            });
          }

          if (match.quantity_unmatched > 0 && unmatchedActions[match.product_id] === 'over_receive') {
            const lastAllocation = match.allocations[match.allocations.length - 1];
            if (lastAllocation) {
              itemsPayload.push({
                po_item_id: lastAllocation.po_item_id,
                quantity: match.quantity_unmatched,
                condition: sourceItem.condition,
                lot_number: sourceItem.lot_number || null,
                notes: `Quick Receive over-receive: ${match.quantity_unmatched} extra units`,
                storage_location: storageLocation,
              });
            }
          }
        }
      }

      if (itemsPayload.length === 0) {
        toast('error', 'No items to receive — all were skipped or unmatched');
        return;
      }

      try {
        request = await receiveIntent.beginIntent({
          itemsPayload,
          performedBy: profile.id,
          receivedByName: profile.full_name || 'Unknown',
          vendor,
          storageLocation,
          matchResults,
          sourceItems: validItems,
        });
      } catch (error) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          extra: { context: 'persist_quick_receive_intent' },
        });
        toast('error', 'Cannot safely save this receipt for exact retry. No inventory was changed.');
        return;
      }
    }

    setSaving(true);
    try {
      await submitQuickReceive(request);
    } catch (error: unknown) {
      const disposition = await receiveIntent.classifyFailure(error);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'confirm_quick_receive', disposition },
      });
      if (disposition === 'definitive') {
        toast('error', error instanceof Error ? error.message : 'Failed to receive items');
      } else {
        toast('warning', 'The receipt may already be recorded. Retry the locked request unchanged to reconcile it.');
      }
    } finally {
      setSaving(false);
    }
  };

  /* ─── reset for another receive ─── */
  const handleReset = () => {
    setStep('add_items');
    setItems([]);
    setExpandedItems(new Set());
    setMatchResults(null);
    setOverrides({});
    setUnmatchedActions({});
    setReceiveCount(0);
    setVendor('');
    setStorageLocation('Main Warehouse');
  };

  /* ═══════════════════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════════════════ */
  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <button
        onClick={() => navigate('/receiving?tab=log')}
        className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Receiving Log
      </button>

      <div className="flex items-center gap-3">
        <PackageCheck className="w-6 h-6 text-crx-green" />
        <h2 className="text-xl font-semibold font-heading text-nav-dark">
          Quick <span className="split-heading-accent">Receive</span>
          <HelpTip text="Fast-track receiving without opening a specific PO. Add products, enter quantities and conditions, then submit. The system auto-matches items to open PO line items (oldest PO first)." className="ml-1" />
        </h2>
        {step !== 'add_items' && step !== 'success' && (
          <Badge variant="default">Step 2 of 2</Badge>
        )}
      </div>
      <p className="text-sm text-secondary -mt-2">
        Receive shipments without knowing the PO number. Enter vendor + products and we'll match to open POs automatically.
      </p>

      {/* ═══════════════════════════════════════════════════════════════
         STEP 1: ADD ITEMS
      ═══════════════════════════════════════════════════════════════ */}
      {step === 'add_items' && (
        <>
          {/* Vendor + Storage */}
          <Card>
            <CardHeader title="Shipment" accent="Info" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4" data-testid="quick-receive-shipment-fields">
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Vendor <span className="text-xs text-gray-400">(optional — helps match POs)</span>
                </label>
                <input
                  type="text"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  list="qr-vendor-list"
                  placeholder="Enter or select vendor..."
                  className="min-h-11 w-full px-3 py-2.5 text-base md:text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
                <datalist id="qr-vendor-list">
                  {vendors.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Storage Location</label>
                <select
                  value={storageLocation}
                  onChange={(e) => setStorageLocation(e.target.value)}
                  className="min-h-11 w-full px-3 py-2.5 text-base md:text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {STORAGE_LOCATIONS.map((loc) => (
                    <option key={loc} value={loc}>
                      {loc}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          {/* Items list */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <CardHeader title="Items" accent="Received" />
              <Button
                icon={<Plus className="w-4 h-4" />}
                showChevron={false}
                onClick={addItem}
              >
                Add Product
              </Button>
            </div>

            {items.length === 0 ? (
              <div className="text-center py-12">
                <PackageCheck className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm text-secondary mb-3">No products added yet</p>
                <Button
                  icon={<Plus className="w-4 h-4" />}
                  showChevron={false}
                  onClick={addItem}
                >
                  Add First Product
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {items.map((item) => (
                  <div
                    key={item.key}
                    className="border border-gray-100 rounded-lg p-4 hover:border-crx-green/30 transition-colors"
                  >
                    {/* Main row: product + qty */}
                    <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
                      {/* Product selector */}
                      <div className="w-full min-w-0 md:flex-1">
                        {item.product_id ? (
                          <button
                            onClick={() => {
                              setProductSearchOpen(item.key);
                              setProductQuery('');
                            }}
                            className="text-left w-full"
                          >
                            <p className="font-medium text-nav-dark text-sm truncate">
                              {item.product_name}
                            </p>
                            {products.find((candidate) => candidate.id === item.product_id) && (
                              <ProductOptionDetails product={products.find((candidate) => candidate.id === item.product_id)!} />
                            )}
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setProductSearchOpen(item.key);
                              setProductQuery('');
                            }}
                            className="flex items-center gap-2 text-crx-green hover:underline font-medium text-sm"
                          >
                            <Search className="w-4 h-4" />
                            Select Product
                          </button>
                        )}
                      </div>

                      {/* Quantity */}
                      <div className="w-full md:w-28">
                        <input
                          type="number"
                          inputMode="decimal"
                          aria-label="Quantity received"
                          value={item.quantity || ''}
                          onChange={(e) =>
                            updateItem(item.key, 'quantity', parseFloat(e.target.value) || 0)
                          }
                          min="0"
                          placeholder="Qty"
                          className="min-h-11 w-full px-3 py-2.5 text-base md:text-sm text-center font-medium border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                        />
                      </div>

                      {/* Expand/collapse details */}
                      <button
                        onClick={() => toggleExpanded(item.key)}
                        className="p-2 rounded-lg text-gray-400 hover:text-nav-dark hover:bg-gray-50 transition-colors"
                        title="Details"
                        aria-label={expandedItems.has(item.key) ? 'Collapse details' : 'Expand details'}
                      >
                        {expandedItems.has(item.key) ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>

                      {/* Remove */}
                      <button
                        onClick={() => removeItem(item.key)}
                        className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        aria-label="Remove line item"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Expanded detail fields */}
                    {expandedItems.has(item.key) && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 pt-3 border-t border-gray-50">
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">Condition</label>
                          <select
                            value={item.condition}
                            onChange={(e) => updateItem(item.key, 'condition', e.target.value)}
                            className="min-h-11 w-full px-3 py-2.5 text-base md:text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                          >
                            {CONDITIONS.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">
                            Lot / Tote #
                          </label>
                          <input
                            type="text"
                            value={item.lot_number}
                            onChange={(e) => updateItem(item.key, 'lot_number', e.target.value)}
                            placeholder="e.g. T-1234"
                            className="min-h-11 w-full px-3 py-2.5 text-base md:text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">Notes</label>
                          <input
                            type="text"
                            value={item.notes}
                            onChange={(e) => updateItem(item.key, 'notes', e.target.value)}
                            placeholder="Any issues..."
                            className="min-h-11 w-full px-3 py-2.5 text-base md:text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Review button */}
            {items.length > 0 && (
              <div className="mt-6 flex justify-end">
                <Button
                  onClick={handleReview}
                  disabled={matching || validItems.length === 0}
                  icon={<PackageCheck className="w-4 h-4" />}
                >
                  {matching ? 'Matching...' : `Review & Match (${validItems.length} item${validItems.length !== 1 ? 's' : ''})`}
                </Button>
              </div>
            )}
          </Card>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════
         STEP 2: REVIEW ALLOCATIONS
      ═══════════════════════════════════════════════════════════════ */}
      {step === 'review' && matchResults && (
        <>
          <Card>
            <CardHeader title="PO" accent="Matching Results" />
            <p className="text-sm text-secondary mt-1 mb-4">
              Review how products were matched to open Purchase Orders. Adjust if needed.
            </p>
            {receiveIntent.isIntentLocked && (
              <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                {receiveIntent.isForeignIntentLocked
                  ? UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE
                  : receiveIntent.isRetryExpired
                  ? UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE
                  : 'The last response was uncertain. This exact receiving request is locked so inventory cannot be received twice.'}
              </div>
            )}

            <div className="space-y-4">
              {matchResults.map((match) => {
                const sourceItem = validItems.find((i) => i.product_id === match.product_id);
                const hasUnmatched = match.quantity_unmatched > 0;
                const allUnmatched = match.allocations.length === 0;

                // Find max cost to identify no-return (cheaper) POs
                const maxCost = match.allocations.length > 0
                  ? Math.max(...match.allocations.map((a) => a.unit_cost))
                  : 0;

                return (
                  <div
                    key={match.product_id}
                    className={`border rounded-lg p-4 ${
                      allUnmatched
                        ? 'border-red-200 bg-red-50/50'
                        : hasUnmatched
                          ? 'border-amber-200 bg-amber-50/30'
                          : 'border-gray-100'
                    }`}
                  >
                    {/* Product header */}
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="font-medium text-nav-dark">{match.product_name}</p>
                        <p className="text-xs text-secondary">
                          {match.quantity_requested} units received
                          {sourceItem?.lot_number && (
                            <span className="ml-2 font-mono bg-gray-100 px-1.5 py-0.5 rounded">
                              Lot: {sourceItem.lot_number}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {sourceItem && sourceItem.condition !== 'good' && (
                          <Badge variant={conditionVariant(sourceItem.condition)}>
                            {sourceItem.condition.replace(/_/g, ' ')}
                          </Badge>
                        )}
                        {match.has_multiple_costs && (
                          <Badge variant="warning">Price Variance</Badge>
                        )}
                        {allUnmatched && <Badge variant="error">Unmatched</Badge>}
                        {!allUnmatched && !hasUnmatched && (
                          <Badge variant="success">Matched</Badge>
                        )}
                      </div>
                    </div>

                    {/* Allocations */}
                    {match.allocations.length > 0 && !match.has_multiple_costs && (
                      <div className="space-y-2">
                        {match.allocations.map((alloc) => (
                          <div
                            key={alloc.po_item_id}
                            className="flex items-center gap-3 bg-white rounded-lg px-3 py-2 border border-gray-50"
                          >
                            <CheckCircle2 className="w-4 h-4 text-crx-green shrink-0" />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-nav-dark">
                                {alloc.po_number}
                              </span>
                              <span className="text-xs text-secondary ml-2">
                                {alloc.po_vendor}
                              </span>
                            </div>
                            <span className="text-sm font-mono text-nav-dark">
                              {alloc.quantity_allocated} units
                            </span>
                            <span className="text-xs text-secondary">
                              ({alloc.po_remaining_after} left on PO)
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Multiple costs (no-return) — show radio picker */}
                    {match.has_multiple_costs && match.allocations.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-amber-700 mb-2">
                          ⚠ Same product on multiple POs at different prices. Pick the correct PO:
                        </p>
                        {!overrides[match.product_id] && (
                          <p className="text-xs font-medium text-red-600 mb-1">
                            Required — pick one to enable Confirm.
                          </p>
                        )}
                        {match.allocations.map((alloc) => {
                          const isNoReturn = alloc.unit_cost < maxCost;
                          return (
                            <label
                              key={alloc.po_item_id}
                              className={`flex items-center gap-3 bg-white rounded-lg px-3 py-2.5 border cursor-pointer transition-colors ${
                                overrides[match.product_id] === alloc.po_item_id
                                  ? 'border-crx-green bg-crx-green-tint'
                                  : 'border-gray-100 hover:border-gray-200'
                              }`}
                            >
                              <input
                                type="radio"
                                name={`override_${match.product_id}`}
                                value={alloc.po_item_id}
                                checked={overrides[match.product_id] === alloc.po_item_id}
                                disabled={receiveIntent.isIntentLocked}
                                onChange={() =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    [match.product_id]: alloc.po_item_id,
                                  }))
                                }
                                className="accent-crx-green"
                              />
                              <div className="flex-1">
                                <span className="text-sm font-medium text-nav-dark">
                                  {alloc.po_number}
                                </span>
                                <span className="text-sm ml-2 font-mono">
                                  @ {fmt(alloc.unit_cost)}/unit
                                </span>
                                {isNoReturn && (
                                  <Badge variant="warning" className="ml-2">
                                    NO-RETURN
                                  </Badge>
                                )}
                                {!isNoReturn && (
                                  <Badge variant="default" className="ml-2">
                                    REGULAR
                                  </Badge>
                                )}
                              </div>
                              <span className="text-xs text-secondary">
                                {alloc.po_remaining_before} remaining
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {/* Unmatched remainder */}
                    {hasUnmatched && (
                      <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-amber-800">
                              {allUnmatched
                                ? `No open PO found for ${match.quantity_unmatched} units`
                                : `${match.quantity_unmatched} units exceed open PO capacity`}
                            </p>
                            <div className="mt-2 space-y-1.5">
                              {!allUnmatched && (
                                <label className="flex items-center gap-2 text-sm cursor-pointer">
                                  <input
                                    type="radio"
                                    name={`unmatched_${match.product_id}`}
                                    value="over_receive"
                                    checked={unmatchedActions[match.product_id] === 'over_receive'}
                                    disabled={receiveIntent.isIntentLocked}
                                    onChange={() =>
                                      setUnmatchedActions((prev) => ({
                                        ...prev,
                                        [match.product_id]: 'over_receive',
                                      }))
                                    }
                                    className="accent-crx-green"
                                  />
                                  <span>Over-receive the last matched PO</span>
                                </label>
                              )}
                              <label className="flex items-center gap-2 text-sm cursor-pointer">
                                <input
                                  type="radio"
                                  name={`unmatched_${match.product_id}`}
                                  value="skip"
                                  checked={
                                    unmatchedActions[match.product_id] === 'skip' ||
                                    (allUnmatched && !unmatchedActions[match.product_id])
                                  }
                                  disabled={receiveIntent.isIntentLocked}
                                  onChange={() =>
                                    setUnmatchedActions((prev) => ({
                                      ...prev,
                                      [match.product_id]: 'skip',
                                    }))
                                  }
                                  className="accent-crx-green"
                                />
                                <span>{allUnmatched ? 'Skip this product entirely' : 'Skip the extra units'}</span>
                              </label>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Action buttons */}
          {(() => {
            const hasUnresolvedVariance = matchResults.some(
              (m) => m.has_multiple_costs && m.allocations.length > 0 && !overrides[m.product_id],
            );
            // F6 fix: symmetric guard for partially-unmatched products
            const hasUnresolvedUnmatched = matchResults.some(
              (m) => m.allocations.length > 0 && m.quantity_unmatched > 0 && !unmatchedActions[m.product_id],
            );
            const blocked = !receiveIntent.isIntentLocked && (hasUnresolvedVariance || hasUnresolvedUnmatched);
            const blockReason = hasUnresolvedVariance
              ? 'Pick a PO for each price-variance product before continuing.'
              : hasUnresolvedUnmatched
                ? 'Choose over-receive or skip for each product with extra units before continuing.'
                : undefined;
            return (
              <div className="flex justify-between">
                <Button
                  variant="secondary"
                  onClick={() => setStep('add_items')}
                  disabled={receiveIntent.isIntentLocked}
                >
                  ← Back to Edit
                </Button>
                <Button
                  onClick={handleConfirmReceive}
                  disabled={receiveIntent.isForeignIntentLocked || receiveIntent.isRetryExpired || saving || blocked}
                  icon={<PackageCheck className="w-4 h-4" />}
                  title={blockReason}
                >
                  {saving
                    ? 'Receiving...'
                    : receiveIntent.isIntentLocked
                      ? 'Retry Exact Receiving'
                      : 'Confirm & Receive'}
                </Button>
              </div>
            );
          })()}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════
         STEP 3: SUCCESS
      ═══════════════════════════════════════════════════════════════ */}
      {step === 'success' && (
        <Card>
          <div className="text-center py-10">
            <CheckCircle2 className="w-16 h-16 mx-auto mb-4 text-crx-green" />
            <h2 className="text-xl font-semibold font-heading text-nav-dark mb-2">
              Shipment Received!
            </h2>
            <p className="text-sm text-secondary mb-8">
              Successfully received {receiveCount} item allocation{receiveCount !== 1 ? 's' : ''}.
              PO statuses and inventory have been updated.
            </p>
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="secondary"
                icon={<Printer className="w-4 h-4" />}
                showChevron={false}
                onClick={() => {
                  // PDF was auto-downloaded on success; this is a re-print hint
                  toast('info', 'Receipt PDF was downloaded automatically after receiving');
                }}
              >
                Receipt Downloaded
              </Button>
              <Button
                icon={<RotateCcw className="w-4 h-4" />}
                showChevron={false}
                onClick={handleReset}
              >
                Receive Another Shipment
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════
         PRODUCT SEARCH MODAL
      ═══════════════════════════════════════════════════════════════ */}
      {productSearchOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="p-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold font-heading text-nav-dark">
                Select <span className="split-heading-accent">Product</span>
              </h3>
            </div>
            <div className="p-5">
              <input
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green mb-3"
                placeholder="Search by name, SKU, or vendor..."
                // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened picker; user expects to type immediately
                autoFocus
              />
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
                {filteredProducts.length === 0 ? (
                  <p className="text-sm text-secondary py-4 text-center">No products found</p>
                ) : (
                  filteredProducts.map((p) => (
                    <ProductSearchResultRow
                      key={p.id}
                      product={p}
                      onClick={() => assignProduct(productSearchOpen, p)}
                      trailing={p.vendor || null}
                    />
                  ))
                )}
              </div>
            </div>
            <div className="p-5 border-t border-gray-100 flex justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  setProductSearchOpen(null);
                  setProductQuery('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
