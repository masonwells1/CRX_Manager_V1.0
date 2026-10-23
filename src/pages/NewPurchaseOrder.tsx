import { useEffect, useRef, useState , useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Save } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Skeleton from '../components/ui/Skeleton';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import {
  isWholeCentPurchaseOrderCost,
  purchaseOrderCentsToDollars,
  purchaseOrderLineTotalCents,
  purchaseOrderUnitCostCents,
} from '../lib/purchaseOrderMoney';
import { MONEY_PRECISION_MESSAGE } from '../lib/parseCents';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase, assertRpcResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { formatUSD as fmt } from '../lib/money';
import type { Product } from '../types';
import { Sentry } from '../lib/sentry';
import { ProductOptionDetails, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import { ProductSearchResultRow } from '../components/products/ProductSearchResultRow';
import { PRODUCT_COLUMNS, withAdminCosts } from '../lib/costFields';
import { fetchAllRows, pageWithList } from '../lib/pagedRead';

type PickerProduct = Product & ProductOptionPresentationModel;

interface POItemDraft {
  key: string;
  product_id: string;
  quantity_ordered: number;
  unit_cost: number;
  unit_size: string;
  /** True once unit_cost came from an admin's costed catalog or an admin's typing. A rep's line holds a
   * placeholder 0 that must never be sent as an admin's cost if the session is promoted (Codex). */
  costFromAdmin?: boolean;
}

let keyCounter = 0;
function nextKey() {
  return `poi_${++keyCounter}`;
}

export default function NewPurchaseOrder() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  const { toast } = useToast();
  // Purchase cost is admin-only (Mason, 2026-10-18 and 2026-10-20, Option B): reps create the purchase
  // order without unit cost; the server gives a rep line the catalog cost and flags it for an admin.
  const isAdmin = profile?.role === 'admin';

  const [vendor, setVendor] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<POItemDraft[]>([
    { key: nextKey(), product_id: '', quantity_ordered: 0, unit_cost: 0, unit_size: '' },
  ]);
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedPoId, setSavedPoId] = useState<string | null>(null);
  const [savedPoNumber, setSavedPoNumber] = useState<string | null>(null);
  const [productSearchOpen, setProductSearchOpen] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [productsLoading, setProductsLoading] = useState(true);
  // A failed catalog load blocks save and submit and offers Retry; the draft on screen is kept.
  const [productsLoadFailed, setProductsLoadFailed] = useState(false);

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);
  const saveIdem = useIdempotencyKey('save_purchase_order', profile?.id || '');
  const submitIdem = useIdempotencyKey('submit_purchase_order', profile?.id || '');

  // Codex P2 fix (PR #59, 2026-05-16): reset saveIdem when PO intent changes.
  // Page stays mounted after failed/lost-response submit; without reset,
  // editing vendor/items and resubmitting would replay the cached po_id.
  // Hash MUST cover every submitted field (vendor/date/notes/items + po_id
  // for retry-on-existing-PO). Codex 2026-05-16 follow-up enforcement.
  const poIntentHash = [
    vendor, expectedDate, notes, savedPoId || '',
    items
      .map((i) => `${i.product_id}:${i.quantity_ordered}:${i.unit_cost}:${i.unit_size || ''}`)
      .sort()
      .join(','),
  ].join('|');
  useEffect(() => {
    saveIdem.resetKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poIntentHash]);

  // Only the newest load installs products: the load re-runs when the role resolves, so an older
  // (cost-less) load must not overwrite an admin's costed list (same guard as BulkPOImport).
  const productLoadSeqRef = useRef(0);
  const fetchProducts = useCallback(async () => {
    const seq = ++productLoadSeqRef.current;
    // Goal 4: the catalog is read whole, page by page; one request would stop silently at the row cap.
    const { data, error } = await fetchAllRows((from, to) => pageWithList(supabase
      .from('products')
      .select(`${PRODUCT_COLUMNS}, product_family:product_families(name)`, { count: 'exact' })
      .eq('is_active', true)
      .order('product_name')
      .order('id')
      .range(from, to)));
    let prods: PickerProduct[] = [];
    let loadError: unknown = error;
    if (!error) {
      try {
        prods = await withAdminCosts('products', (data || []) as unknown as PickerProduct[], isAdmin);
      } catch (costErr) {
        loadError = costErr;
      }
    }
    if (seq !== productLoadSeqRef.current) return;
    if (loadError) {
      Sentry.captureException(loadError, { tags: { source: 'fetch', action: 'load_purchase_order_products' } });
      toast('error', 'Failed to load Products. Retry before creating this purchase order.');
      // Never a short or earlier list.
      setProducts([]);
      setProductsLoadFailed(true);
      setProductsLoading(false);
      return;
    }
    setProducts(prods);
    setProductsLoadFailed(false);
    if (isAdmin) {
      // A promoted session: lines picked while cost was hidden take the costed catalog's cost now.
      const byId = new Map(prods.map((p) => [p.id, p]));
      setItems((prev) => prev.map((i) => {
        const prod = i.product_id && !i.costFromAdmin ? byId.get(i.product_id) : undefined;
        return prod ? { ...i, unit_cost: prod.current_cost || 0, costFromAdmin: true } : i;
      }));
    }
    const uniqueVendors = [...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[];
    setVendors(uniqueVendors.sort());
    setProductsLoading(false);
  // The catalog loader is intentionally stable for the initial page fetch (and the role).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [vendor, expectedDate, notes, items]);

  useEffect(() => {
    fetchProducts();
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [fetchProducts]);

  // Reorder deep-link: pre-fill the first line from ?product=<id> once products load.
  const preselectProductId = searchParams.get('product') || '';
  const preselectApplied = useRef(false);
  useEffect(() => {
    if (preselectApplied.current || !preselectProductId || products.length === 0) return;
    const prod = products.find((p) => p.id === preselectProductId);
    if (!prod) return;
    preselectApplied.current = true;
    setItems((prev) => prev.map((i, idx) => (idx === 0
      ? { ...i, product_id: prod.id, unit_cost: prod.current_cost || 0, unit_size: prod.unit_size || '', costFromAdmin: isAdmin }
      : i)));
    if (prod.vendor) setVendor((v) => v || prod.vendor || '');
  }, [products, preselectProductId, isAdmin]);

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { key: nextKey(), product_id: '', quantity_ordered: 0, unit_cost: 0, unit_size: '' },
    ]);
  };

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  };

  const updateItem = (key: string, field: keyof POItemDraft, value: string | number) => {
    setItems((prev) =>
      prev.map((i) => (i.key === key
        ? { ...i, [field]: value, ...(field === 'unit_cost' ? { costFromAdmin: isAdmin } : {}) }
        : i))
    );
  };

  const assignProduct = (itemKey: string, product: Product) => {
    setItems((prev) =>
      prev.map((i) =>
        i.key === itemKey
          ? {
              ...i,
              product_id: product.id,
              unit_cost: product.current_cost || 0,
              unit_size: product.unit_size || '',
              costFromAdmin: isAdmin,
            }
          : i
      )
    );
    setProductSearchOpen(null);
    setProductQuery('');
  };

  const totalCostCents = items.reduce(
    (sum, i) => sum + purchaseOrderLineTotalCents(i.quantity_ordered, i.unit_cost),
    0,
  );
  const totalCost = purchaseOrderCentsToDollars(totalCostCents);

  const handleSave = async (submitStatus: 'draft' | 'submitted') => {
    if (productsLoadFailed) {
      toast('error', 'Products could not be loaded. Use Retry before saving this purchase order.');
      return;
    }
    if (!vendor.trim()) {
      toast('error', 'Please enter a vendor name');
      return;
    }
    const validItems = items.filter((i) => i.product_id && i.quantity_ordered > 0);
    if (validItems.length === 0) {
      toast('error', 'Add at least one item with a product and quantity');
      return;
    }

    // A line still holding a pre-promotion placeholder waits for the costed catalog; never send its 0.
    if (isAdmin && validItems.some((i) => !i.costFromAdmin)) {
      toast('error', 'Unit costs are still loading. Check each unit cost, then save again.');
      return;
    }

    // An admin's typed cost must be exact whole cents: more than two decimals is refused, never rounded.
    if (isAdmin && validItems.some((i) => !isWholeCentPurchaseOrderCost(i.unit_cost))) {
      toast('error', `Check each unit cost. ${MONEY_PRECISION_MESSAGE}`);
      return;
    }

    // Warn about items with zero cost (an admin enters cost; a rep's lines start without it)
    const zeroCostItems = validItems.filter((i) => i.unit_cost === 0);
    if (isAdmin && zeroCostItems.length > 0) {
      const prod = products.find((p) => p.id === zeroCostItems[0].product_id);
      toast('warning', `"${prod?.product_name || 'An item'}" has $0 unit cost — verify this is intentional`);
    }

    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }

    await runCriticalAction({
      action: async () => {
        let poId = savedPoId;
        const isFirstSave = !poId;

        // Only generate a PO number on first save
        let poNumber = savedPoNumber;
        // A retry after the draft was saved but submit's response was uncertain
        // must replay submit directly. Re-saving could try to downgrade an
        // already-submitted PO back to draft.
        const shouldSaveDraft = submitStatus === 'draft' || !poId || isDirty;

        if (shouldSaveDraft) {
          const idemKey = saveIdem.getKey();

          const poPayload = {
            // New PO numbers are allocated atomically by save_purchase_order.
            // Existing edits keep the number already returned by the server.
            po_number: poNumber,
            vendor: vendor.trim(),
            status: 'draft',
            submitted_date: null,
            expected_delivery_date: expectedDate || null,
            notes: notes || null,
          };

          const itemsPayload = validItems.map((i) => {
            const line = {
              product_id: i.product_id,
              product_name: products.find((p) => p.id === i.product_id)?.product_name || null,
              quantity_ordered: i.quantity_ordered,
              unit_size: i.unit_size || null,
              quantity_received: 0,
            };
            // A non-admin sends no cost; save_purchase_order ignores one anyway.
            if (!isAdmin) return line;
            const unitCostCents = purchaseOrderUnitCostCents(i.unit_cost);
            return {
              ...line,
              unit_cost: purchaseOrderCentsToDollars(unitCostCents),
              unit_cost_cents: unitCostCents,
            };
          });

          const { data, error } = await supabase.rpc('save_purchase_order', {
            // Postgres uses NULL to select the create path; generated RPC types
            // cannot express nullability for a uuid parameter without a default.
            p_po_id: poId as string,
            p_po_payload: poPayload,
            p_items: itemsPayload,
            p_performed_by: profile.id,
            p_idempotency_key: idemKey,
          });

          if (error) throw error;

          const result = assertRpcResult<{ po_id: string; po_number?: string }>(data, 'save_purchase_order');
          poId = result.po_id;
          if (!poId) throw new Error('Purchase order save did not return an ID');
          if (!result.po_number) throw new Error('Purchase order save did not return its allocated number');
          poNumber = result.po_number;
          saveIdem.resetKey();

          if (isFirstSave) {
            setSavedPoId(poId);
            setSavedPoNumber(result.po_number);
          }

          // The form now matches the durable draft. If submit fails, the user
          // can retry without recreating or unnecessarily resaving the PO.
          setIsDirty(false);
        }

        if (!poId) throw new Error('Purchase order ID is unavailable');

        if (submitStatus === 'submitted') {
          const submitKey = submitIdem.getKey();
          const { data: submitData, error: submitError } = await supabase.rpc('submit_purchase_order', {
            p_po_id: poId,
            p_performed_by: profile.id,
            p_idempotency_key: submitKey,
          });
          if (submitError) throw submitError;
          assertRpcResult<{ po_id: string; status: string }>(submitData, 'submit_purchase_order');
          submitIdem.resetKey();
        }

        setIsDirty(false);
        navigate(`/purchase-orders/${poId}`, { replace: true });

        return { poNumber, isFirstSave };
      },
      toast,
      successMessage: submitStatus === 'submitted'
        ? 'Purchase order submitted'
        : !savedPoId ? 'Draft created' : 'Draft saved',
      setLoading: setSaving,
      sentryTag: 'save_purchase_order',
    });
  };

  const filteredProducts = products.filter((p) => {
    if (!productQuery.trim()) return true;
    const q = productQuery.toLowerCase();
    return (
      p.product_name.toLowerCase().includes(q) ||
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.vendor && p.vendor.toLowerCase().includes(q))
    );
  });

  if (productsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-10 w-48 ml-auto" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/purchase-orders')}
        className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Purchase Orders
      </button>

      <Card>
        <CardHeader title="New Purchase" accent="Order" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Vendor</label>
            <div className="relative">
              <input
                type="text"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                list="vendor-list"
                placeholder="Enter or select vendor..."
                className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <datalist id="vendor-list">
                {vendors.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </div>
          </div>
          <Input
            label="Expected Delivery Date"
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </div>
        <div className="mt-4">
          <Input
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes about this PO..."
          />
        </div>
      </Card>

      <Card padding={false}>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <CardHeader title="Line" accent="Items" />
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="w-3 h-3" />}
              showChevron={false}
              onClick={addItem}
            >
              Add Item
            </Button>
          </div>

          {productsLoadFailed && (
            <p role="alert" className="px-4 pt-3 text-sm text-red-600">
              Products could not be loaded. This purchase order cannot be saved until they load.
              <button
                type="button"
                onClick={() => { setProductsLoading(true); fetchProducts(); }}
                className="ml-2 font-medium text-red-700 underline hover:text-red-800"
              >
                Retry
              </button>
            </p>
          )}

          {items.length === 0 ? (
            <p className="text-sm text-secondary text-center py-6">
              No items added.{' '}
              <button onClick={addItem} className="text-crx-green hover:underline font-medium">
                Add one
              </button>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-secondary uppercase tracking-wide">
                    <th className="px-4 py-3 font-medium min-w-[220px]">Product</th>
                    <th className="px-4 py-3 font-medium w-28">Qty</th>
                    {isAdmin && <th className="px-4 py-3 font-medium w-32">Unit Cost</th>}
                    <th className="px-4 py-3 font-medium w-24">Unit Size</th>
                    {isAdmin && <th className="px-4 py-3 font-medium w-32">Line Total</th>}
                    <th className="px-4 py-3 font-medium w-10" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const prod = products.find((p) => p.id === item.product_id);
                    return (
                      <tr key={item.key} className="border-b border-gray-50 hover:bg-crx-green-tint transition-colors">
                        <td className="px-4 py-3">
                          {prod ? (
                            <button
                              onClick={() => {
                                setProductSearchOpen(item.key);
                                setProductQuery('');
                              }}
                              className="text-left"
                            >
                              <p className="font-medium text-nav-dark">{prod.product_name}</p>
                              <ProductOptionDetails product={prod} />
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setProductSearchOpen(item.key);
                                setProductQuery('');
                              }}
                              className="text-crx-green hover:underline font-medium text-sm"
                            >
                              Select Product
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={item.quantity_ordered || ''}
                            onChange={(e) =>
                              updateItem(item.key, 'quantity_ordered', parseFloat(e.target.value) || 0)
                            }
                            min="0"
                            step="any"
                            className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                          />
                        </td>
                        {isAdmin && (
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={item.unit_cost || ''}
                            onChange={(e) =>
                              updateItem(item.key, 'unit_cost', parseFloat(e.target.value) || 0)
                            }
                            min="0"
                            step="0.01"
                            className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                          />
                        </td>
                        )}
                        <td className="px-4 py-3">
                          <input
                            type="text"
                            value={item.unit_size}
                            onChange={(e) => updateItem(item.key, 'unit_size', e.target.value)}
                            className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                            placeholder="Gal"
                          />
                        </td>
                        {isAdmin && (
                        <td className="px-4 py-3 font-mono text-nav-dark">
                          {fmt(purchaseOrderCentsToDollars(
                            purchaseOrderLineTotalCents(item.quantity_ordered, item.unit_cost),
                          ))}
                        </td>
                        )}
                        <td className="px-4 py-3">
                          {items.length > 1 && (
                            <button
                              onClick={() => removeItem(item.key)}
                              className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                              aria-label="Remove line item"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {isAdmin && (
                <tfoot>
                  <tr className="border-t border-gray-200">
                    <td colSpan={4} className="px-4 py-3 text-right font-medium text-secondary">
                      Total
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold text-nav-dark">
                      {fmt(totalCost)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
                )}
              </table>
            </div>
          )}
        </div>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={() => navigate('/purchase-orders')}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          icon={<Save className="w-4 h-4" />}
          showChevron={false}
          onClick={() => handleSave('draft')}
          disabled={saving || productsLoadFailed}
        >
          {savedPoId ? 'Save Draft' : 'Save as Draft'}
        </Button>
        <Button
          onClick={() => handleSave('submitted')}
          disabled={saving || productsLoadFailed}
        >
          {saving ? 'Saving...' : 'Submit PO'}
        </Button>
      </div>

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
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green mb-3"
                placeholder="Search by name, SKU, or vendor..."
                // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened picker; user expects to type immediately
                autoFocus
              />
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
                {filteredProducts.length === 0 ? (
                  <p className="text-sm text-secondary py-4 text-center">
                    {productsLoadFailed ? 'Products could not be loaded. Close this and use Retry.' : 'No products found'}
                  </p>
                ) : (
                  filteredProducts.map((p) => (
                    <ProductSearchResultRow
                      key={p.id}
                      product={p}
                      onClick={() => assignProduct(productSearchOpen, p)}
                      trailing={isAdmin ? fmt(p.current_cost || 0) : undefined}
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

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
