/**
 * Payments — Unified payment entry page (formerly PaymentAllocation).
 * Select a customer, enter a check amount, allocate to invoices (auto or manual),
 * any remainder becomes prepay credit. Calls allocate_payment RPC.
 *
 * Sprint 16: Unified Payment Allocation
 * AR Single Source of Truth: This is now the sole payment entry point.
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  DollarSign,
  Search,
  Zap,
  RotateCcw,
  CheckCircle,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import ConfirmModal from '../components/ui/ConfirmModal';
import PageHeader from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { parseDollarsToCents } from '../lib/parseCents';
import { formatCents as fmt } from '../lib/money';
import type { PaymentAllocationEntry, PaymentAllocationResult, InvoiceType } from '../types';

/* ─── Helpers ──────────────────────────────────────────────────────────── */

const toDollarDisplay = (cents: number): string => (cents / 100).toFixed(2);

const daysBetween = (from: string, to: Date): number => {
  const d = new Date(from);
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((to.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)));
};

/** Auto-allocate: distribute check amount across invoices, oldest first */
// eslint-disable-next-line react-refresh/only-export-components
export function autoAllocate(
  checkCents: number,
  invoices: { id: string; balance_cents: number }[],
): Map<string, number> {
  if (!Number.isFinite(checkCents) || checkCents <= 0) return new Map();
  const result = new Map<string, number>();
  let remaining = checkCents;
  for (const inv of invoices) {
    if (remaining <= 0) break;
    if (!Number.isFinite(inv.balance_cents) || inv.balance_cents <= 0) continue;
    const apply = Math.min(remaining, inv.balance_cents);
    if (apply > 0) {
      result.set(inv.id, apply);
      remaining -= apply;
    }
  }
  return result;
}

/* ─── Customer Search Result ──────────────────────────────────────────── */

interface CustomerOption {
  id: string;
  farm_name: string;
  account_number: string | null;
  prepay_balance_cents: number;
}

/* ─── Component ────────────────────────────────────────────────────────── */

export default function PaymentAllocation() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const allocatePaymentIdem = useIdempotencyKey('allocate_payment', profile?.id || '');

  // Customer search
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerOption[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  // Payment fields
  const [checkAmountInput, setCheckAmountInput] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('check');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [notes, setNotes] = useState('');

  // Invoice list + allocations
  const [invoices, setInvoices] = useState<PaymentAllocationEntry[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<PaymentAllocationResult | null>(null);

  // Prepay confirmation modal
  const [prepayConfirmOpen, setPrepayConfirmOpen] = useState(false);

  /* ── Customer search (typeahead) ─────────────────────────────────────── */

  useEffect(() => {
    if (customerSearch.length < 2 || selectedCustomer) {
      setCustomerResults([]);
      setShowDropdown(false);
      setSearchLoading(false);
      return;
    }
    // L3: cancel flag so a debounced response that resolves after the input
    // changed (or after unmount) never overwrites the current results, and
    // unexpected search failures are reported instead of silently swallowed.
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const { data, error } = await supabase
          .from('customers')
          .select('id, farm_name, account_number, prepay_balance_cents')
          .eq('is_active', true)
          .or(`farm_name.ilike.%${customerSearch}%,account_number.ilike.%${customerSearch}%`)
          .order('farm_name')
          .limit(15);
        if (error) throw error;
        if (cancelled) return;
        setCustomerResults((data || []) as CustomerOption[]);
        setShowDropdown(true);
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'payment_customer_search' } });
        if (!cancelled) {
          setCustomerResults([]);
          setShowDropdown(false);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [customerSearch, selectedCustomer]);

  /* ── Load invoices when customer selected ──────────────────────────── */

  const fetchInvoices = useCallback(async (customerId: string) => {
    setLoadingInvoices(true);
    const today = new Date();
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, due_date, invoice_type, total_amount_cents, balance_cents')
      .eq('customer_id', customerId)
      // U1 (#41): include 'overdue' — the 6am cron flips past-due posted invoices to
      // 'overdue', which made exactly the invoices checks arrive for vanish from this
      // list. allocate_payment already accepts both statuses.
      .in('status', ['posted', 'overdue'])
      .gt('balance_cents', 0)
      .is('deleted_at', null)
      .order('invoice_date', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) {
      toast('error', 'Failed to load invoices');
      setLoadingInvoices(false);
      return;
    }

    const mapped = ((data || []) as Array<{ id: string; invoice_number: string; invoice_date: string; due_date: string | null; invoice_type: string; total_amount_cents: number; balance_cents: number }>).map((inv): PaymentAllocationEntry => ({
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date,
      invoice_type: inv.invoice_type as InvoiceType,
      total_amount_cents: inv.total_amount_cents,
      balance_cents: inv.balance_cents,
      days_aged: daysBetween(inv.invoice_date, today),
      allocated_cents: 0,
    }));

    setInvoices(mapped);
    setLoadingInvoices(false);
  }, [toast]);

  const selectCustomer = useCallback((c: CustomerOption) => {
    setSelectedCustomer(c);
    setCustomerSearch(c.farm_name + (c.account_number ? ` (${c.account_number})` : ''));
    setShowDropdown(false);
    setLastResult(null);
    fetchInvoices(c.id);
  }, [fetchInvoices]);

  const clearCustomer = useCallback(() => {
    setSelectedCustomer(null);
    setCustomerSearch('');
    setInvoices([]);
    setCheckAmountInput('');
    setReferenceNumber('');
    setNotes('');
    setLastResult(null);
  }, []);

  /* ── Allocation helpers ────────────────────────────────────────────── */

  const checkCents = parseDollarsToCents(checkAmountInput);

  const setAllocationForInvoice = useCallback((invoiceId: string, cents: number) => {
    setInvoices((prev) =>
      prev.map((inv) =>
        inv.invoice_id === invoiceId ? { ...inv, allocated_cents: cents } : inv,
      ),
    );
  }, []);

  const handleAutoAllocate = useCallback(() => {
    if (checkCents <= 0) {
      toast('error', 'Enter a check amount first');
      return;
    }
    const allocMap = autoAllocate(
      checkCents,
      invoices.map((inv) => ({ id: inv.invoice_id, balance_cents: inv.balance_cents })),
    );
    setInvoices((prev) =>
      prev.map((inv) => ({
        ...inv,
        allocated_cents: allocMap.get(inv.invoice_id) || 0,
      })),
    );
  }, [checkCents, invoices, toast]);

  const handleClearAllocations = useCallback(() => {
    setInvoices((prev) => prev.map((inv) => ({ ...inv, allocated_cents: 0 })));
  }, []);

  /* ── Computed values ──────────────────────────────────────────────── */

  const totalAllocated = useMemo(
    () => invoices.reduce((s, inv) => s + inv.allocated_cents, 0),
    [invoices],
  );
  const remaining = checkCents - totalAllocated;
  const hasAllocations = totalAllocated > 0;
  const hasValidationError = useMemo(() => {
    return invoices.some((inv) => inv.allocated_cents > inv.balance_cents);
  }, [invoices]);

  /* ── Submit payment ──────────────────────────────────────────────── */

  const handleSubmit = async () => {
    if (!selectedCustomer || !profile) return;
    if (checkCents <= 0) {
      toast('error', 'Enter a check amount');
      return;
    }
    if (totalAllocated > checkCents) {
      toast('error', 'Allocations exceed check amount');
      return;
    }
    if (hasValidationError) {
      toast('error', 'Some allocations exceed invoice balances');
      return;
    }
    // Confirm if 100% of check goes to prepay (no invoice allocations)
    if (!hasAllocations && remaining > 0) {
      setPrepayConfirmOpen(true);
      return;
    }

    executeSubmit();
  };

  const executeSubmit = async () => {
    if (!selectedCustomer || !profile) return;
    setPrepayConfirmOpen(false);
    setSubmitting(true);
    try {
      const allocations = invoices
        .filter((inv) => inv.allocated_cents > 0)
        .map((inv) => ({
          invoice_id: inv.invoice_id,
          amount_cents: inv.allocated_cents,
        }));

      const idemKey = allocatePaymentIdem.getKey();
      const { data, error } = await supabase.rpc('allocate_payment', {
        p_customer_id: selectedCustomer.id,
        p_total_cents: checkCents,
        p_allocations: allocations,
        p_payment_method: paymentMethod,
        p_reference_number: referenceNumber || undefined,
        p_notes: notes || undefined,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;
      const result = assertRpcResult<PaymentAllocationResult>(data, 'allocate_payment');
      allocatePaymentIdem.resetKey();
      setLastResult(result);

      const parts = [`Applied ${fmt(result.total_allocated_cents)} to ${result.invoices_paid} invoice(s)`];
      if (result.prepay_created_cents > 0) {
        parts.push(`${fmt(result.prepay_created_cents)} added as prepay credit`);
      }
      toast('success', parts.join('. '));
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'allocate_payment' } });
      toast('error', sanitizeError(err));
    }
    setSubmitting(false);
  };

  /* ── Post-success actions ──────────────────────────────────────────── */

  const handleNextCheck = () => {
    // Keep customer, clear amounts
    setCheckAmountInput('');
    setReferenceNumber('');
    setNotes('');
    setLastResult(null);
    if (selectedCustomer) fetchInvoices(selectedCustomer.id);
  };

  const handleNewCustomer = () => {
    clearCustomer();
    setPaymentMethod('check');
  };

  /* ── Render ──────────────────────────────────────────────────────── */

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payments"
        subtitle="Allocate a check across multiple invoices. Any remainder becomes a prepay credit."
      />

      {/* Success Banner */}
      {lastResult && (
        <Card>
          <div className="flex items-start gap-3">
            <CheckCircle className="w-6 h-6 text-crx-green flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-nav-dark">Payment Applied Successfully</p>
              <p className="text-sm text-secondary mt-1">
                {fmt(lastResult.total_allocated_cents)} applied to {lastResult.invoices_paid} invoice(s)
                {lastResult.prepay_created_cents > 0 && (
                  <> &middot; {fmt(lastResult.prepay_created_cents)} added as prepay credit</>
                )}
              </p>
              <div className="flex gap-2 mt-3">
                <Button size="sm" variant="primary" onClick={handleNextCheck} icon={<ChevronRight className="w-3 h-3" />}>
                  Next Check (Same Customer)
                </Button>
                <Button size="sm" variant="secondary" onClick={handleNewCustomer}>
                  New Customer
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Top Bar: Customer + Payment Info */}
      {!lastResult && (
        <>
          <Card>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Customer Search */}
              <div className="relative lg:col-span-2">
                <label className="block text-sm font-medium text-nav-dark mb-1">Customer</label>
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search by name or account #..."
                    value={customerSearch}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value);
                      if (selectedCustomer) {
                        setSelectedCustomer(null);
                        setInvoices([]);
                        setLastResult(null);
                      }
                    }}
                    className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                  {selectedCustomer && (
                    <button
                      onClick={clearCustomer}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      aria-label="Clear customer"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {showDropdown && customerResults.length > 0 && (
                  <div className="absolute z-30 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {customerResults.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => selectCustomer(c)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex justify-between items-center"
                      >
                        <span className="font-medium text-nav-dark">{c.farm_name}</span>
                        <span className="text-xs text-secondary">
                          {c.account_number && `#${c.account_number}`}
                          {c.prepay_balance_cents > 0 && ` · Prepay: ${fmt(c.prepay_balance_cents)}`}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {showDropdown && customerResults.length === 0 && !searchLoading && customerSearch.length >= 2 && (
                  <div className="absolute z-30 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm text-secondary">
                    No customers found
                  </div>
                )}
              </div>

              {/* Payment Method */}
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Method</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="check">Check</option>
                  <option value="cash">Cash</option>
                  <option value="wire">Wire Transfer</option>
                  <option value="ach">ACH</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {/* Reference */}
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Reference #</label>
                <input
                  type="text"
                  placeholder="Check # or ref..."
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            </div>

            {/* Notes (full width) */}
            <div className="mt-3">
              <label className="block text-sm font-medium text-nav-dark mb-1">Notes</label>
              <input
                type="text"
                placeholder="Optional payment notes..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
          </Card>

          {/* Check Amount */}
          {selectedCustomer && (
            <Card>
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-sm font-medium text-nav-dark mb-1">Check Amount</label>
                  <div className="relative">
                    <DollarSign className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      placeholder="0.00"
                      value={checkAmountInput}
                      onChange={(e) => setCheckAmountInput(e.target.value)}
                      className="w-full pl-10 pr-3 py-3 text-lg font-semibold bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                    />
                  </div>
                </div>
                <div className="flex gap-2 pt-6">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Zap className="w-4 h-4" />}
                    onClick={handleAutoAllocate}
                    disabled={checkCents <= 0 || invoices.length === 0}
                  >
                    Auto-Allocate
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<RotateCcw className="w-4 h-4" />}
                    onClick={handleClearAllocations}
                    showChevron={false}
                    disabled={!hasAllocations}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* Invoice Table */}
          {selectedCustomer && (
            <Card padding={false}>
              <div className="p-5">
                <h2 className="text-sm font-semibold text-nav-dark mb-3">
                  Open Invoices for {selectedCustomer.farm_name}
                  {invoices.length > 0 && (
                    <span className="ml-2 text-secondary font-normal">
                      ({invoices.length} invoice{invoices.length !== 1 ? 's' : ''}, {fmt(invoices.reduce((s, i) => s + i.balance_cents, 0))} outstanding)
                    </span>
                  )}
                </h2>

                {loadingInvoices ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="w-6 h-6 border-3 border-crx-green border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : invoices.length === 0 ? (
                  <div className="text-center py-12 text-secondary text-sm">
                    No open invoices for this customer
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Invoice #</th>
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Date</th>
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Due</th>
                          <th className="text-left py-2 px-3 text-xs font-semibold text-secondary uppercase">Days Aged</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-secondary uppercase">Total</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-secondary uppercase">Balance</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-secondary uppercase w-[140px]">Allocate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoices.map((inv) => {
                          const overAllocated = inv.allocated_cents > inv.balance_cents;
                          return (
                            <tr key={inv.invoice_id} className="border-b border-gray-50 hover:bg-gray-25">
                              <td className="py-2.5 px-3 font-medium text-nav-dark">{inv.invoice_number}</td>
                              <td className="py-2.5 px-3 text-secondary">{new Date(inv.invoice_date + 'T00:00:00').toLocaleDateString()}</td>
                              <td className="py-2.5 px-3 text-secondary">
                                {inv.due_date ? new Date(inv.due_date + 'T00:00:00').toLocaleDateString() : '—'}
                              </td>
                              <td className="py-2.5 px-3">
                                <Badge variant={inv.days_aged > 90 ? 'danger' : inv.days_aged > 30 ? 'warning' : 'default'}>
                                  {inv.days_aged}d
                                </Badge>
                              </td>
                              <td className="py-2.5 px-3 text-right text-secondary">{fmt(inv.total_amount_cents)}</td>
                              <td className="py-2.5 px-3 text-right font-medium text-red-600">{fmt(inv.balance_cents)}</td>
                              <td className="py-2.5 px-3 text-right">
                                <div className="relative inline-block">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">$</span>
                                  <input
                                    type="text"
                                    value={inv.allocated_cents > 0 ? toDollarDisplay(inv.allocated_cents) : ''}
                                    placeholder="0.00"
                                    onChange={(e) => {
                                      const cents = parseDollarsToCents(e.target.value);
                                      setAllocationForInvoice(inv.invoice_id, cents);
                                    }}
                                    className={`w-[120px] pl-5 pr-2 py-1.5 text-sm text-right border rounded-lg focus:outline-none focus:ring-2 ${
                                      overAllocated
                                        ? 'border-red-300 focus:ring-red-200 bg-red-50'
                                        : inv.allocated_cents > 0
                                          ? 'border-crx-green focus:ring-crx-green/20 bg-crx-green-light/30'
                                          : 'border-gray-200 focus:ring-crx-green/20'
                                    }`}
                                  />
                                </div>
                                {overAllocated && (
                                  <p className="text-xs text-red-500 mt-0.5">Exceeds balance</p>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Summary Bar */}
          {selectedCustomer && checkCents > 0 && (
            <Card>
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex gap-6 text-sm">
                  <div>
                    <span className="text-secondary">Check Total:</span>{' '}
                    <span className="font-semibold text-nav-dark">{fmt(checkCents)}</span>
                  </div>
                  <div>
                    <span className="text-secondary">Allocated:</span>{' '}
                    <span className="font-semibold text-nav-dark">{fmt(totalAllocated)}</span>
                  </div>
                  <div>
                    <span className="text-secondary">Remaining:</span>{' '}
                    <span
                      className={`font-semibold ${
                        remaining === 0
                          ? 'text-crx-green'
                          : remaining > 0
                            ? 'text-amber-600'
                            : 'text-red-600'
                      }`}
                    >
                      {fmt(Math.abs(remaining))}
                      {remaining > 0 && ' → Prepay'}
                      {remaining < 0 && ' over-allocated!'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {remaining > 0 && (
                    <div className="flex items-center gap-1 text-xs text-amber-600 mr-2">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>{fmt(remaining)} will become a prepay credit</span>
                    </div>
                  )}
                  <Button
                    variant="primary"
                    onClick={handleSubmit}
                    loading={submitting}
                    disabled={
                      remaining < 0 ||
                      hasValidationError ||
                      checkCents <= 0 ||
                      (!hasAllocations && remaining <= 0)
                    }
                    icon={<DollarSign className="w-4 h-4" />}
                  >
                    Apply Payment
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      <ConfirmModal
        open={prepayConfirmOpen}
        onClose={() => setPrepayConfirmOpen(false)}
        onConfirm={executeSubmit}
        title="Full Prepay Credit"
        message={`No invoices allocated. ${fmt(checkCents)} will be added as prepay credit. Continue?`}
        confirmLabel="Continue"
        variant="warning"
      />
    </div>
  );
}
