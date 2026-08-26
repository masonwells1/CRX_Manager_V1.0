/**
 * NewVendorBill.tsx — Create a new vendor bill
 *
 * Manual bill entry: vendor, bill #, date, due date, amount, payment terms.
 * Option to link to existing PO (auto-fill vendor + amount).
 * Uses the create_vendor_bill() RPC. Admin-only.
 */
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult } from '../lib/db';
import { sanitizeError } from '../lib/errorSanitizer';
import { useUncertainMutationIntent } from '../hooks/useUncertainMutationIntent';
import { useAuth } from '../contexts/AuthContext';
import { localToday, parseLocalDate, formatLocalDate } from '../lib/dateUtils';
import { parseDollarsToCents, parseDollarsToCentsSigned } from '../lib/parseCents';
import { centsToDollarInput, formatCents as fmt } from '../lib/money';
import { getIdempotencyMismatchResult } from '../lib/idempotency';
import type { Vendor, PurchaseOrder } from '../types';

export default function NewVendorBill() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const createBillIntent = useUncertainMutationIntent<{
    args: {
      p_vendor_id: string;
      p_purchase_order_id?: string;
      p_bill_number: string;
      p_bill_date: string;
      p_due_date: string;
      p_payment_terms?: string;
      p_subtotal_cents: number;
      p_adjustment_cents: number;
      p_notes?: string;
    };
  }>({
    operation: 'create_vendor_bill',
    userId: profile?.id || '',
    surface: 'new-vendor-bill',
  });
  const [saving, setSaving] = useState(false);

  // Lookups
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<(PurchaseOrder & { vendor_id_match?: string })[]>([]);

  // Form
  const [vendorId, setVendorId] = useState('');
  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [billDate, setBillDate] = useState(localToday());
  const [paymentTerms, setPaymentTerms] = useState('');
  const [paymentTermsDays, setPaymentTermsDays] = useState(30);
  const [subtotalDollars, setSubtotalDollars] = useState('');
  const [adjustmentDollars, setAdjustmentDollars] = useState('0');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const recovered = createBillIntent.unresolvedIntent?.args;
    if (!recovered) return;
    setVendorId(recovered.p_vendor_id);
    setPurchaseOrderId(recovered.p_purchase_order_id || '');
    setBillNumber(recovered.p_bill_number);
    setBillDate(recovered.p_bill_date);
    setPaymentTerms(recovered.p_payment_terms || '');
    const due = parseLocalDate(recovered.p_due_date).getTime();
    const bill = parseLocalDate(recovered.p_bill_date).getTime();
    setPaymentTermsDays(Math.max(0, Math.round((due - bill) / 86_400_000)));
    setSubtotalDollars(centsToDollarInput(recovered.p_subtotal_cents));
    setAdjustmentDollars(centsToDollarInput(recovered.p_adjustment_cents));
    setNotes(recovered.p_notes || '');
  }, [createBillIntent.unresolvedIntent]);

  // Keep one key until the server confirms success. If a response is lost,
  // editing the page must not mint a fresh key that could create a second bill;
  // the intent-bound RPC will fail closed on changed input under this key.

  const fetchVendors = useCallback(async () => {
    const { data } = await supabase
      .from('vendors')
      .select('*')
      .is('deleted_at', null)
      .order('name');
    setVendors((data || []) as Vendor[]);
  }, []);

  const fetchPOs = useCallback(async () => {
    const { data } = await supabase
      .from('purchase_orders')
      .select('*')
      .in('status', ['submitted', 'partially_received', 'fully_received'])
      .order('created_at', { ascending: false })
      .limit(200);
    setPurchaseOrders((data || []) as PurchaseOrder[]);
  }, []);

  useEffect(() => {
    fetchVendors();
    fetchPOs();
  }, [fetchVendors, fetchPOs]);

  // When vendor selected, apply default terms
  useEffect(() => {
    if (!vendorId || createBillIntent.isIntentLocked) return;
    const v = vendors.find((x) => x.id === vendorId);
    if (v) {
      if (v.default_payment_terms) setPaymentTerms(v.default_payment_terms);
      if (v.default_payment_terms_days) setPaymentTermsDays(v.default_payment_terms_days);
    }
  }, [vendorId, vendors, createBillIntent.isIntentLocked]);

  // When PO selected, auto-fill vendor + amount
  const handlePOSelect = (poId: string) => {
    setPurchaseOrderId(poId);
    if (!poId) return;

    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) return;

    // Try to match vendor by name
    const matchedVendor = vendors.find(
      (v) => v.name.toLowerCase() === po.vendor.toLowerCase()
    );
    if (matchedVendor) {
      setVendorId(matchedVendor.id);
    }

    // Auto-fill amount from PO total
    if (po.total_cost > 0) {
      setSubtotalDollars(po.total_cost.toFixed(2));
    }
  };

  const handleSave = async () => {
    if (!vendorId) { toast('error', 'Select a vendor'); return; }
    if (!billNumber.trim()) { toast('error', 'Enter a bill number'); return; }
    if (!subtotalDollars || Number(subtotalDollars) <= 0) { toast('error', 'Enter a valid amount'); return; }

    setSaving(true);
    try {
      const subtotalCents = parseDollarsToCents(subtotalDollars);
      // adjustment_cents intentionally negative-capable — user may enter "-10" to subtract
      const adjustmentCents = parseDollarsToCentsSigned(adjustmentDollars || '0');

      // (codex audit F4, 2026-05-10): mirror the backend's `v_total > 0`
      // guard at the UI so users see a clear inline message instead of an
      // INVALID_AMOUNT exception thrown out of the RPC. After PR-15's
      // parseDollarsToCents fix preserves negatives, an adjustment can flip
      // the sign of the bill total even when the subtotal is positive.
      const totalCents = subtotalCents + adjustmentCents;
      if (totalCents <= 0) {
        toast('error', `Bill total must be positive. Subtotal + adjustment = ${(totalCents / 100).toFixed(2)}.`);
        setSaving(false);
        return;
      }

      // Compute due_date from bill_date + paymentTermsDays
      const dueDateObj = parseLocalDate(billDate);
      dueDateObj.setDate(dueDateObj.getDate() + paymentTermsDays);
      const computedDueDate = formatLocalDate(dueDateObj);

      const request = createBillIntent.beginIntent({
        args: {
          p_vendor_id: vendorId,
          p_purchase_order_id: purchaseOrderId || undefined,
          p_bill_number: billNumber.trim(),
          p_bill_date: billDate,
          p_due_date: computedDueDate,
          p_payment_terms: paymentTerms || undefined,
          p_subtotal_cents: subtotalCents,
          p_adjustment_cents: adjustmentCents,
          p_notes: notes || undefined,
        },
      });
      const idemKey = createBillIntent.getIdempotencyKey();

      const { data, error } = await supabase.rpc('create_vendor_bill', {
        ...request.args,
        p_idempotency_key: idemKey,
      });

      if (error) {
        const receipt = getIdempotencyMismatchResult(error, 'create_vendor_bill');
        if (typeof receipt?.bill_id === 'string') {
          createBillIntent.resolveIntent();
          toast('warning', 'The earlier vendor bill already completed. Opening it instead of creating a duplicate.');
          navigate(`/accounts-payable/bills/${receipt.bill_id}`);
          return;
        }
        if (createBillIntent.classifyFailure(error) === 'definitive') {
          throw error;
        }
        toast('warning', 'The vendor bill may already exist. The exact request is locked; retry it unchanged to reconcile the result.');
        return;
      }
      const createdBillId = assertRpcResult<string>(data, 'create_vendor_bill');
      createBillIntent.resolveIntent();

      toast('success', 'Vendor bill created');
      navigate(`/accounts-payable/bills/${createdBillId}`);
    } catch (err) {
      toast('error', sanitizeError(err));
    } finally {
      setSaving(false);
    }
  };

  const totalCents = parseDollarsToCents(subtotalDollars || '0') + parseDollarsToCentsSigned(adjustmentDollars || '0');

  // Calculate due date preview
  const dueDate = (() => {
    try {
      const d = parseLocalDate(billDate);
      d.setDate(d.getDate() + paymentTermsDays);
      return d.toLocaleDateString();
    } catch {
      return '-';
    }
  })();

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button type="button" aria-label="Back to vendor bills" disabled={createBillIntent.isIntentLocked} onClick={() => navigate('/accounts-payable/bills')} className="text-crx-green hover:text-crx-green/70 disabled:cursor-not-allowed disabled:opacity-50">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-xl font-semibold font-heading text-nav-dark">New Vendor Bill</h2>
      </div>

      {/* Link to PO (optional) */}
      <Card>
        <h3 className="text-sm font-semibold text-nav-dark mb-3">Link to Purchase Order (Optional)</h3>
        <select
          value={purchaseOrderId}
          onChange={(e) => handlePOSelect(e.target.value)}
          disabled={createBillIntent.isIntentLocked}
          className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">No linked PO</option>
          {purchaseOrders.map((po) => (
            <option key={po.id} value={po.id}>
              {po.po_number} — {po.vendor} — ${po.total_cost.toFixed(2)}
            </option>
          ))}
        </select>
        <p className="text-xs text-secondary mt-1">
          Linking a PO auto-fills vendor and amount. You can still edit them.
        </p>
      </Card>

      {/* Bill Details */}
      <Card>
        <h3 className="text-sm font-semibold text-nav-dark mb-3">Bill Details</h3>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-nav-dark">Vendor *</label>
            <select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              disabled={createBillIntent.isIntentLocked}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select vendor...</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Bill Number *"
              value={billNumber}
              onChange={(e) => setBillNumber(e.target.value)}
              placeholder="Vendor's invoice/bill #"
              disabled={createBillIntent.isIntentLocked}
            />
            <Input
              label="Bill Date"
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              disabled={createBillIntent.isIntentLocked}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-nav-dark">Payment Terms</label>
              <select
                value={paymentTerms}
                disabled={createBillIntent.isIntentLocked}
                onChange={(e) => {
                  setPaymentTerms(e.target.value);
                  const daysMap: Record<string, number> = {
                    'Net 15': 15,
                    'Net 30': 30,
                    'Net 45': 45,
                    'Net 60': 60,
                    'Net 90': 90,
                    'Due on Receipt': 0,
                  };
                  if (daysMap[e.target.value] !== undefined) {
                    setPaymentTermsDays(daysMap[e.target.value]);
                  }
                }}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Select...</option>
                <option value="Due on Receipt">Due on Receipt</option>
                <option value="Net 15">Net 15</option>
                <option value="Net 30">Net 30</option>
                <option value="Net 45">Net 45</option>
                <option value="Net 60">Net 60</option>
                <option value="Net 90">Net 90</option>
              </select>
            </div>
            <Input
              label="Days Until Due"
              type="number"
              value={String(paymentTermsDays)}
              onChange={(e) => setPaymentTermsDays(Number(e.target.value))}
              disabled={createBillIntent.isIntentLocked}
            />
          </div>

          <p className="text-xs text-secondary">
            Due date: <span className="font-semibold">{dueDate}</span>
          </p>
        </div>
      </Card>

      {/* Amount */}
      <Card>
        <h3 className="text-sm font-semibold text-nav-dark mb-3">Amount</h3>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Subtotal ($) *"
              type="number"
              step="0.01"
              min="0"
              value={subtotalDollars}
              onChange={(e) => setSubtotalDollars(e.target.value)}
              placeholder="0.00"
              disabled={createBillIntent.isIntentLocked}
            />
            <Input
              label="Adjustment ($)"
              type="number"
              step="0.01"
              value={adjustmentDollars}
              onChange={(e) => setAdjustmentDollars(e.target.value)}
              placeholder="0.00 (negative for discount)"
              disabled={createBillIntent.isIntentLocked}
            />
          </div>
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <span className="text-sm font-medium text-nav-dark">Total Amount</span>
            <span className="text-lg font-semibold font-heading text-nav-dark">{fmt(totalCents)}</span>
          </div>
        </div>
      </Card>

      {/* Notes */}
      <Card>
        <Input
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes about this bill"
          disabled={createBillIntent.isIntentLocked}
        />
      </Card>

      {/* Actions */}
      {createBillIntent.isIntentLocked && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          The last response was uncertain. These fields are locked so a second bill cannot be created. Retry this exact bill to reconcile it.
        </div>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" disabled={createBillIntent.isIntentLocked} onClick={() => navigate('/accounts-payable/bills')}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={saving}>
          {createBillIntent.isIntentLocked ? 'Retry Exact Bill' : 'Create Bill'}
        </Button>
      </div>
    </div>
  );
}
