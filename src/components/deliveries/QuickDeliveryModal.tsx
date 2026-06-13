/**
 * QuickDeliveryModal — Creates an ad-hoc delivery with auto-created order + draft invoice.
 * Used when a driver gets a phone call and needs to grab product and go.
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Plus, Search, Trash2, Zap } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import ConfirmModal from '../ui/ConfirmModal';
import { supabase, assertRpcResult } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { localToday } from '../../lib/dateUtils';
import { Sentry } from '../../lib/sentry';
import { notifyCreditLimitExceeded } from '../../lib/notificationTriggers';
import { formatCents as fmtCurrency } from '../../lib/money';
import type { Product, Profile } from '../../types';

interface QuickItem {
  _key: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_size: string;
  price_cents: number;
}

interface CustomerOption {
  id: string;
  farm_name: string;
  account_number: string | null;
  assigned_tier: number;
}

interface QuickDeliveryModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

export default function QuickDeliveryModal({
  open,
  onClose,
  onCreated,
}: QuickDeliveryModalProps) {
  const navigate = useNavigate();
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const quickDeliveryIdem = useIdempotencyKey('create_quick_delivery', profile?.id || '');

  // Customer search
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerOption[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);

  // Products
  const [products, setProducts] = useState<Product[]>([]);
  const [showProductModal, setShowProductModal] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [items, setItems] = useState<QuickItem[]>([]);

  // Drivers
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [selectedDriver, setSelectedDriver] = useState<string>('');

  // Other
  const [scheduledDate, setScheduledDate] = useState(localToday());
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createInvoice, setCreateInvoice] = useState(true);
  const [showConfirm, setShowConfirm] = useState(false);

  // Fetch products and drivers on open
  useEffect(() => {
    if (!open) return;
    const fetchData = async () => {
      try {
        const [prodResult, driverResult] = await Promise.all([
          supabase.from('products').select('*').eq('is_active', true).order('product_name'),
          // PR-07 follow-up: driver picker only uses d.id + d.full_name; safe via view.
          supabase.from('profile_public_view').select('id, full_name, role, is_active').in('role', ['driver', 'admin', 'sales_rep']).eq('is_active', true).order('full_name'),
        ]);
        if (prodResult.error || driverResult.error) {
          toast('error', 'Failed to load products or drivers. Please close and try again.');
          Sentry.captureException(prodResult.error || driverResult.error, { extra: { context: 'QuickDeliveryModal.fetchData' } });
          return;
        }
        setProducts((prodResult.data || []) as Product[]);
        setDrivers((driverResult.data || []) as Profile[]);

        // Auto-select current user as driver if they're a driver
        if (profile?.role === 'driver') {
          setSelectedDriver(profile.id);
        }
      } catch (err) {
        toast('error', 'Failed to load products or drivers. Please close and try again.');
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'QuickDeliveryModal.fetchData' } });
      }
    };
    fetchData();
  }, [open, profile, toast]);

  // Customer search debounce
  useEffect(() => {
    if (customerSearch.length < 2 || selectedCustomer) {
      setCustomerResults([]);
      setShowCustomerDropdown(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const { data, error } = await supabase
          .from('customers')
          .select('id, farm_name, account_number, assigned_tier')
          .eq('is_active', true)
          .or(`farm_name.ilike.%${customerSearch}%,account_number.ilike.%${customerSearch}%`)
          .order('farm_name')
          .limit(15);
        if (error) {
          toast('error', 'Customer search failed. Please try again.');
          setCustomerResults([]);
          setShowCustomerDropdown(false);
        } else {
          setCustomerResults((data || []) as CustomerOption[]);
          setShowCustomerDropdown(true);
        }
      } catch {
        toast('error', 'Customer search failed. Please try again.');
        setCustomerResults([]);
        setShowCustomerDropdown(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch, selectedCustomer, toast]);

  const selectCustomer = useCallback((c: CustomerOption) => {
    setSelectedCustomer(c);
    setCustomerSearch(c.farm_name + (c.account_number ? ` (${c.account_number})` : ''));
    setShowCustomerDropdown(false);

    // Re-price existing items for the new customer's tier
    setItems((prev) =>
      prev.map((item) => {
        const product = products.find((p) => p.id === item.product_id);
        if (!product) return item;
        const tier = c.assigned_tier ?? 1;
        let priceCents: number;
        if (tier === 3 && product.tier3_price != null) priceCents = Math.round(product.tier3_price * 100);
        else if (tier === 2 && product.tier2_price != null) priceCents = Math.round(product.tier2_price * 100);
        else priceCents = Math.round((product.tier1_price || 0) * 100);
        return { ...item, price_cents: priceCents };
      })
    );
  }, [products]);

  const clearCustomer = () => {
    setSelectedCustomer(null);
    setCustomerSearch('');
  };

  // Get the correct tier price for the selected customer
  const getTierPrice = (product: Product): number => {
    const tier = selectedCustomer?.assigned_tier ?? 1;
    if (tier === 3 && product.tier3_price != null) return Math.round(product.tier3_price * 100);
    if (tier === 2 && product.tier2_price != null) return Math.round(product.tier2_price * 100);
    return Math.round((product.tier1_price || 0) * 100);
  };

  // Product selection
  const addProduct = (product: Product) => {
    const existing = items.find((i) => i.product_id === product.id);
    if (existing) {
      setItems(items.map((i) => i.product_id === product.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      setItems([
        ...items,
        {
          _key: crypto.randomUUID(),
          product_id: product.id,
          product_name: product.product_name,
          quantity: 1,
          unit_size: product.unit_size || '',
          price_cents: getTierPrice(product),
        },
      ]);
    }
    setShowProductModal(false);
    setProductSearch('');
  };

  const removeItem = (key: string) => {
    setItems(items.filter((i) => i._key !== key));
  };

  const updateItemQty = (key: string, qty: number) => {
    if (qty < 1) return;
    setItems(items.map((i) => (i._key === key ? { ...i, quantity: qty } : i)));
  };

  const filteredProducts = productSearch
    ? products.filter(
        (p) =>
          p.product_name.toLowerCase().includes(productSearch.toLowerCase()) ||
          p.manufacturer?.toLowerCase().includes(productSearch.toLowerCase())
      )
    : products;

  const totalCents = items.reduce((sum, i) => sum + Math.round(i.price_cents * i.quantity), 0);
  const showPricing = role === 'admin' || role === 'sales_rep';

  const handleSubmit = async () => {
    if (!selectedCustomer) {
      toast('error', 'Please select a customer');
      return;
    }
    if (items.length === 0) {
      toast('error', 'Please add at least one product');
      return;
    }
    // M16: Prevent $0 total quick deliveries
    if (totalCents === 0) {
      toast('error', 'Order total cannot be $0 — update product prices before submitting');
      return;
    }

    setSubmitting(true);
    try {
      const key = quickDeliveryIdem.getKey();
      const { data, error } = await supabase.rpc('create_quick_delivery', {
        p_customer_id: selectedCustomer.id,
        p_items: items.map((i) => ({
          product_id: i.product_id,
          quantity: i.quantity,
          unit_size: i.unit_size,
          price_cents: i.price_cents,
        })),
        p_driver_id: selectedDriver || null,
        p_scheduled_date: scheduledDate,
        p_delivery_notes: deliveryNotes || null,
        p_performed_by: profile?.id,
        p_idempotency_key: key,
        p_skip_invoice: !createInvoice,
      });

      if (error) throw error;
      quickDeliveryIdem.resetKey();

      const result = assertRpcResult<{ delivery_id: string; delivery_number: string; invoice_number: string | null }>(data, 'create_quick_delivery');
      const invoiceMsg = result.invoice_number
        ? ` with draft invoice ${result.invoice_number}`
        : ' (no invoice created)';
      toast('success', `Quick delivery ${result.delivery_number} created${invoiceMsg}`);

      // #7 (G4 = warn-but-allow): a quick delivery creates an order + draft
      // invoice immediately, so surface over-limit credit exposure + notify
      // admins — non-blocking, never affects the already-created delivery.
      const creditCustomerId = selectedCustomer.id;
      try {
        const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', { p_customer_id: creditCustomerId });
        const cl = assertRpcResult<{ exceeded?: boolean; farm_name?: string; outstanding_ar?: number; credit_limit?: number } | null>(creditCheck, 'check_customer_credit_limit');
        if (cl && cl.exceeded) {
          const fmtUsd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
          toast('warning', `Credit limit warning: ${cl.farm_name} outstanding AR ${fmtUsd(cl.outstanding_ar ?? 0)} exceeds limit ${fmtUsd(cl.credit_limit ?? 0)}`);
          notifyCreditLimitExceeded(cl.farm_name ?? 'Unknown', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, creditCustomerId);
        }
      } catch {
        // Non-blocking — a credit-check failure must not affect the delivery.
      }

      // Reset form
      setSelectedCustomer(null);
      setCustomerSearch('');
      setItems([]);
      setDeliveryNotes('');
      setSelectedDriver(profile?.role === 'driver' ? profile.id : '');
      setScheduledDate(localToday());
      setCreateInvoice(true);

      onClose();
      onCreated?.();
      navigate(`/deliveries/${result.delivery_id}`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'QuickDeliveryModal.handleSubmit' } });
      const msg = err instanceof Error ? err.message : 'Failed to create quick delivery';
      toast('error', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!submitting) {
      setSelectedCustomer(null);
      setCustomerSearch('');
      setItems([]);
      setDeliveryNotes('');
      setSelectedDriver(profile?.role === 'driver' ? profile.id : '');
      onClose();
    }
  };

  return (
    <>
      <Modal open={open} onClose={handleClose} title="Quick Delivery" size="large">
        <div className="space-y-5">
          {/* Info banner */}
          <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">
                This will create an order and delivery{createInvoice ? ', plus a draft invoice' : ''}.
              </p>
              {createInvoice && (
                <p className="text-xs text-amber-700 mt-1">
                  The invoice must be reviewed and posted by a sales rep before it can be billed.
                </p>
              )}
            </div>
          </div>

          {/* Customer search */}
          <div className="relative">
            <Input
              label="Customer"
              required
              value={customerSearch}
              onChange={(e) => {
                setCustomerSearch(e.target.value);
                if (selectedCustomer) setSelectedCustomer(null);
              }}
              placeholder="Search by farm name or account number..."
            />
            {selectedCustomer && (
              <div className="absolute right-2 top-7 flex items-center gap-2">
                <span className="text-xs font-medium text-brand-dark bg-brand-light px-1.5 py-0.5 rounded">
                  Tier {selectedCustomer.assigned_tier || 1}
                </span>
                <button
                  onClick={clearCustomer}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  clear
                </button>
              </div>
            )}
            {showCustomerDropdown && customerResults.length > 0 && (
              <div className="absolute z-30 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => selectCustomer(c)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex justify-between items-center"
                  >
                    <span className="font-medium text-nav-dark">{c.farm_name}</span>
                    {c.account_number && (
                      <span className="text-xs text-secondary">#{c.account_number}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-secondary">
                Products <span className="text-red-500">*</span>
              </label>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus className="w-4 h-4" />}
                onClick={() => { setShowProductModal(true); setProductSearch(''); }}
              >
                Add Product
              </Button>
            </div>

            {items.length === 0 ? (
              <div className="text-center py-6 border border-dashed border-gray-200 rounded-lg text-sm text-secondary">
                No products added yet. Click "Add Product" to begin.
              </div>
            ) : (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-3 py-2 font-medium text-secondary">Product</th>
                      <th className="text-center px-3 py-2 font-medium text-secondary w-24">Qty</th>
                      <th className="text-left px-3 py-2 font-medium text-secondary">Unit</th>
                      {showPricing && <th className="text-right px-3 py-2 font-medium text-secondary">Price</th>}
                      {showPricing && <th className="text-right px-3 py-2 font-medium text-secondary">Total</th>}
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item._key} className="border-b border-gray-100 last:border-0">
                        <td className="px-3 py-2 text-nav-dark">{item.product_name}</td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={item.quantity}
                            onChange={(e) => updateItemQty(item._key, parseFloat(e.target.value) || 0)}
                            className="w-20 text-center px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
                          />
                        </td>
                        <td className="px-3 py-2 text-secondary">{item.unit_size || '—'}</td>
                        {showPricing && (
                          <td className="px-3 py-2 text-right font-mono text-secondary">
                            {fmtCurrency(item.price_cents)}
                          </td>
                        )}
                        {showPricing && (
                          <td className="px-3 py-2 text-right font-mono font-medium">
                            {fmtCurrency(Math.round(item.price_cents * item.quantity))}
                          </td>
                        )}
                        <td className="px-3 py-2">
                          <button
                            onClick={() => removeItem(item._key)}
                            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {showPricing && (
                    <tfoot>
                      <tr className="bg-gray-50 border-t border-gray-200">
                        <td colSpan={4} className="px-3 py-2 text-right font-medium text-nav-dark">
                          Total:
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-crx-green">
                          {fmtCurrency(totalCents)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>

          {/* Driver + Date row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Driver</label>
              <select
                value={selectedDriver}
                onChange={(e) => setSelectedDriver(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Unassigned</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.full_name}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="Scheduled Date"
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">Delivery Notes</label>
            <textarea
              value={deliveryNotes}
              onChange={(e) => setDeliveryNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
            />
          </div>

          {/* Invoice option */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={createInvoice}
              onChange={(e) => setCreateInvoice(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green/30"
            />
            <span className="text-sm text-secondary">Create draft invoice</span>
          </label>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              icon={<Zap className="w-4 h-4" />}
              onClick={() => setShowConfirm(true)}
              disabled={!selectedCustomer || items.length === 0 || submitting}
            >
              Create Quick Delivery
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirmation dialog */}
      <ConfirmModal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={() => { setShowConfirm(false); handleSubmit(); }}
        title="Create Quick Delivery"
        message={`Create delivery for ${selectedCustomer?.farm_name || 'customer'} with ${items.length} product(s) totaling ${fmtCurrency(totalCents)}${selectedDriver ? ` assigned to ${drivers.find(d => d.id === selectedDriver)?.full_name || 'driver'}` : ''}${createInvoice ? '. A draft invoice will also be created.' : '. No invoice will be created.'}`}
        confirmLabel="Create"
        variant="warning"
        loading={submitting}
      />

      {/* Product picker sub-modal */}
      <Modal
        open={showProductModal}
        onClose={() => setShowProductModal(false)}
        title="Select Product"
        size="large"
      >
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="Search products..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened modal; user expects to type immediately
              autoFocus
            />
          </div>

          <div className="max-h-96 overflow-y-auto space-y-2">
            {filteredProducts.map((product) => (
              <button
                key={product.id}
                onClick={() => addProduct(product)}
                className="w-full text-left p-3 border border-gray-200 rounded-lg hover:border-crx-green hover:bg-gray-50 transition-colors"
              >
                <div className="font-medium text-nav-dark">{product.product_name}</div>
                {product.manufacturer && (
                  <div className="text-xs text-secondary mt-1">{product.manufacturer}</div>
                )}
                <div className="flex items-center gap-4 mt-2 text-xs text-secondary">
                  {product.unit_size && <span>Size: {product.unit_size}</span>}
                  {product.tier1_price != null && (
                    <span>Price: {fmtCurrency(Math.round(product.tier1_price * 100))}</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {filteredProducts.length === 0 && (
            <div className="text-center py-8 text-secondary text-sm">No products found</div>
          )}
        </div>
      </Modal>
    </>
  );
}
