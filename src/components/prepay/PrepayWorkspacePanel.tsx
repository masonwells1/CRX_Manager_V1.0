/**
 * PrepayWorkspace — Split-panel workspace for applying prepay buckets
 * to unpaid invoices. Fully manual — bookkeeper has 100% control.
 *
 * Layout: Left panel (prepay buckets by check) | Right panel (unpaid invoices)
 * Bottom toolbar: Save Allocations | Reset
 */
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, CheckCircle2, DollarSign, RotateCcw, Save,
} from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, assertRpcResult } from '../../lib/db';
import type { Json } from '../../types/supabase';
import { runCriticalAction } from '../../lib/criticalAction';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { parseDollarsToCents } from '../../lib/parseCents';
import { localToday } from '../../lib/dateUtils';
import { formatCents as fmt } from '../../lib/money';

interface PrepayBucket {
  id: string;
  customer_id: string;
  reference_number: string | null;
  bucket_label: string | null;
  original_amount_cents: number;
  balance_cents: number;
  created_at: string;
}

interface UnpaidInvoice {
  id: string;
  invoice_number: string;
  total_amount_cents: number;
  balance_cents: number;
  due_date: string | null;
  created_at: string;
}

interface PendingAllocation {
  prepay_credit_id: string;
  invoice_id: string;
  amount_cents: number;
}


export default function PrepayWorkspacePanel() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const batchApplyIdem = useIdempotencyKey('batch_apply_prepayments', profile?.id || '');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialCustomerId = searchParams.get('customer') || '';

  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(initialCustomerId);
  const [buckets, setBuckets] = useState<PrepayBucket[]>([]);
  const [invoices, setInvoices] = useState<UnpaidInvoice[]>([]);
  const [pendingAllocations, setPendingAllocations] = useState<PendingAllocation[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  // Apply modal state
  const [applyBucket, setApplyBucket] = useState<PrepayBucket | null>(null);
  const [applyAmounts, setApplyAmounts] = useState<Record<string, string>>({});

  // Fetch customers with prepay balance
  useEffect(() => {
    supabase
      .from('customers')
      .select('id, farm_name')
      .gt('prepay_balance_cents', 0)
      .eq('is_active', true)
      .order('farm_name')
      .then(({ data }) => setCustomers(data || []));
  }, []);

  const fetchData = useCallback(async () => {
    if (!selectedCustomerId) {
      setBuckets([]);
      setInvoices([]);
      return;
    }
    setLoading(true);

    const [bucketsRes, invoicesRes] = await Promise.all([
      supabase
        .from('prepay_credits')
        .select('id, customer_id, reference_number, bucket_label, original_amount_cents, balance_cents, created_at')
        .eq('customer_id', selectedCustomerId)
        .gt('balance_cents', 0)
        .order('created_at', { ascending: true }),
      supabase
        .from('invoices')
        .select('id, invoice_number, total_amount_cents, balance_cents, due_date, created_at')
        .eq('customer_id', selectedCustomerId)
        .eq('status', 'posted')
        .gt('balance_cents', 0)
        .is('deleted_at', null)
        .order('due_date', { ascending: true }),
    ]);

    if (bucketsRes.error) toast('error', 'Failed to load prepay credits');
    if (invoicesRes.error) toast('error', 'Failed to load invoices');
    setBuckets((bucketsRes.data || []) as PrepayBucket[]);
    setInvoices((invoicesRes.data || []) as UnpaidInvoice[]);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomerId]);

  useEffect(() => {
    fetchData();
    setPendingAllocations([]);
  }, [fetchData]);

  // Calculate pending amounts per bucket and per invoice
  const pendingByBucket = (bucketId: string) =>
    pendingAllocations.filter((a) => a.prepay_credit_id === bucketId).reduce((s, a) => s + a.amount_cents, 0);

  const pendingByInvoice = (invoiceId: string) =>
    pendingAllocations.filter((a) => a.invoice_id === invoiceId).reduce((s, a) => s + a.amount_cents, 0);

  // Group buckets by reference_number (check #)
  const checkGroups = buckets.reduce<Record<string, PrepayBucket[]>>((acc, b) => {
    const key = b.reference_number || 'No Check #';
    if (!acc[key]) acc[key] = [];
    acc[key].push(b);
    return acc;
  }, {});

  const handleOpenApply = (bucket: PrepayBucket) => {
    setApplyBucket(bucket);
    setApplyAmounts({});
  };

  const handleConfirmApply = () => {
    if (!applyBucket) return;
    const newAllocations: PendingAllocation[] = [];
    let totalApplied = 0;
    const bucketRemaining = applyBucket.balance_cents - pendingByBucket(applyBucket.id);

    for (const [invoiceId, amountStr] of Object.entries(applyAmounts)) {
      const cents = parseDollarsToCents(amountStr || '0');
      if (cents <= 0) continue;
      totalApplied += cents;
      newAllocations.push({
        prepay_credit_id: applyBucket.id,
        invoice_id: invoiceId,
        amount_cents: cents,
      });
    }

    if (totalApplied > bucketRemaining) {
      toast('error', `Total ($${(totalApplied / 100).toFixed(2)}) exceeds bucket balance (${fmt(bucketRemaining)})`);
      return;
    }

    // Validate per-invoice caps
    for (const alloc of newAllocations) {
      const inv = invoices.find((i) => i.id === alloc.invoice_id);
      if (!inv) continue;
      const invRemaining = inv.balance_cents - pendingByInvoice(inv.id);
      if (alloc.amount_cents > invRemaining) {
        toast('error', `Amount exceeds remaining balance for ${inv.invoice_number}`);
        return;
      }
    }

    setPendingAllocations((prev) => [...prev, ...newAllocations]);
    setApplyBucket(null);
    toast('success', `Staged ${fmt(totalApplied)} in allocations`);
  };

  const handleApplyFull = (invoiceId: string) => {
    if (!applyBucket) return;
    const bucketRemaining = applyBucket.balance_cents - pendingByBucket(applyBucket.id);
    const inv = invoices.find((i) => i.id === invoiceId);
    if (!inv) return;
    const invRemaining = inv.balance_cents - pendingByInvoice(inv.id);
    const max = Math.min(bucketRemaining, invRemaining);
    setApplyAmounts((prev) => ({ ...prev, [invoiceId]: (max / 100).toFixed(2) }));
  };

  const handleSave = async () => {
    if (!pendingAllocations.length) return;
    await runCriticalAction({
      action: async () => {
        const key = batchApplyIdem.getKey();
        const { data, error } = await supabase.rpc('batch_apply_prepayments', {
          p_allocations: pendingAllocations.map((a) => ({
            prepay_credit_id: a.prepay_credit_id,
            invoice_id: a.invoice_id,
            amount_cents: a.amount_cents,
          })) as Json,
          p_performed_by: profile?.id as string,
          p_idempotency_key: key,
        });
        if (error) throw error;
        const result = assertRpcResult<{ applied_count: number; total_applied_cents: number }>(data, 'batch_apply_prepayments');
        batchApplyIdem.resetKey();
        toast('success', `Applied ${fmt(result.total_applied_cents)} across ${result.applied_count} allocation(s)`);
        setPendingAllocations([]);
        fetchData();
      },
      toast,
      setLoading: setSaving,
      successMessage: '',
      sentryTag: 'batch_apply_prepayments',
    });
  };

  const handleReset = () => {
    setPendingAllocations([]);
    toast('info', 'All pending allocations cleared');
  };

  const today = localToday();
  const totalPending = pendingAllocations.reduce((s, a) => s + a.amount_cents, 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button aria-label="Back to prepayments" onClick={() => navigate('/prepay?tab=manager')} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="w-5 h-5 text-secondary" />
        </button>
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Prepay Workspace</h2>
          <p className="text-sm text-secondary">Manually allocate prepay buckets to invoices</p>
        </div>
      </div>

      {/* Customer Selector */}
      <Card>
        <label className="text-sm font-medium text-nav-dark">Customer</label>
        <select
          value={selectedCustomerId}
          onChange={(e) => setSelectedCustomerId(e.target.value)}
          className="mt-1 w-full max-w-md px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        >
          <option value="">Select a customer with prepay balance...</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.farm_name}</option>
          ))}
        </select>
      </Card>

      {selectedCustomerId && !loading && (
        <>
          {/* Split Panel */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Prepay Buckets */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-nav-dark flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-crx-green" /> Prepay Buckets
                <Badge variant="success">{fmt(buckets.reduce((s, b) => s + b.balance_cents, 0))}</Badge>
              </h3>

              {Object.entries(checkGroups).map(([checkRef, group]) => {
                const groupTotal = group.reduce((s, b) => s + b.balance_cents, 0);
                const groupPending = group.reduce((s, b) => s + pendingByBucket(b.id), 0);
                const fullyApplied = groupTotal - groupPending <= 0;

                return (
                  <Card key={checkRef}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-nav-dark">
                          Check #{checkRef}
                        </span>
                        {fullyApplied ? (
                          <Badge variant="success"><CheckCircle2 className="w-3 h-3 mr-1" />Fully Allocated</Badge>
                        ) : (
                          <Badge variant="default">{fmt(groupTotal - groupPending)} remaining</Badge>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2">
                      {group.map((bucket) => {
                        const remaining = bucket.balance_cents - pendingByBucket(bucket.id);
                        return (
                          <div key={bucket.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                            <div>
                              <div className="flex items-center gap-2">
                                <Badge variant="info">{bucket.bucket_label || 'General'}</Badge>
                                <span className="text-sm font-medium text-nav-dark">{fmt(remaining)}</span>
                                {pendingByBucket(bucket.id) > 0 && (
                                  <span className="text-xs text-amber-600">(-{fmt(pendingByBucket(bucket.id))} staged)</span>
                                )}
                              </div>
                              <p className="text-xs text-secondary mt-1">Original: {fmt(bucket.original_amount_cents)}</p>
                            </div>
                            {remaining > 0 && (
                              <Button
                                size="sm"
                                variant="secondary"
                                icon={<ArrowRight className="w-3 h-3" />}
                                onClick={() => handleOpenApply(bucket)}
                                showChevron={false}
                              >
                                Apply
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                );
              })}

              {buckets.length === 0 && (
                <Card>
                  <p className="text-sm text-secondary text-center py-4">No prepay buckets with balance for this customer.</p>
                </Card>
              )}
            </div>

            {/* Right: Unpaid Invoices */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-nav-dark flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-red-600" /> Unpaid Invoices
                <Badge variant="error">{fmt(invoices.reduce((s, i) => s + i.balance_cents, 0))}</Badge>
              </h3>

              {invoices.map((inv) => {
                const pending = pendingByInvoice(inv.id);
                const effectiveBalance = inv.balance_cents - pending;
                const isOverdue = inv.due_date && inv.due_date < today;
                const isCovered = effectiveBalance <= 0;

                return (
                  <Card key={inv.id}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-nav-dark">{inv.invoice_number}</span>
                          {isCovered ? (
                            <Badge variant="success">Covered</Badge>
                          ) : isOverdue ? (
                            <Badge variant="error">Overdue</Badge>
                          ) : pending > 0 ? (
                            <Badge variant="warning">Partial</Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-secondary mt-1">
                          Due: {inv.due_date ? new Date(inv.due_date + 'T00:00:00').toLocaleDateString() : 'N/A'}
                          {' | '}Total: {fmt(inv.total_amount_cents)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-semibold ${isCovered ? 'text-crx-green' : 'text-red-600'}`}>
                          {fmt(effectiveBalance)}
                        </p>
                        {pending > 0 && (
                          <p className="text-xs text-amber-600">-{fmt(pending)} staged</p>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}

              {invoices.length === 0 && (
                <Card>
                  <p className="text-sm text-secondary text-center py-4">No unpaid invoices for this customer.</p>
                </Card>
              )}
            </div>
          </div>

          {/* Bottom Toolbar */}
          {pendingAllocations.length > 0 && (
            <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 -mx-4 flex items-center justify-between shadow-lg rounded-t-xl">
              <div className="text-sm text-secondary">
                <strong className="text-nav-dark">{pendingAllocations.length}</strong> allocation(s) staged
                {' '}totaling <strong className="text-crx-green">{fmt(totalPending)}</strong>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" icon={<RotateCcw className="w-4 h-4" />} onClick={handleReset} showChevron={false}>
                  Reset
                </Button>
                <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
                  Save Allocations
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Apply Modal */}
      <Modal open={!!applyBucket} onClose={() => setApplyBucket(null)} title={`Apply: ${applyBucket?.bucket_label || 'General'}`}>
        {applyBucket && (
          <div className="space-y-4">
            <div className="bg-gray-50 p-3 rounded-lg">
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Available in this bucket</span>
                <span className="font-semibold text-crx-green">
                  {fmt(applyBucket.balance_cents - pendingByBucket(applyBucket.id))}
                </span>
              </div>
              {applyBucket.reference_number && (
                <p className="text-xs text-secondary mt-1">Check #{applyBucket.reference_number}</p>
              )}
            </div>

            <div className="space-y-3 max-h-64 overflow-y-auto">
              {invoices.map((inv) => {
                const invRemaining = inv.balance_cents - pendingByInvoice(inv.id);
                if (invRemaining <= 0) return null;
                return (
                  <div key={inv.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-nav-dark">{inv.invoice_number}</p>
                      <p className="text-xs text-secondary">
                        Remaining: {fmt(invRemaining)}
                        {inv.due_date && inv.due_date < today && <span className="text-red-600 ml-1">(overdue)</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={applyAmounts[inv.id] || ''}
                        onChange={(e) => setApplyAmounts((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                        placeholder="0.00"
                        className="w-28"
                      />
                      <button
                        onClick={() => handleApplyFull(inv.id)}
                        className="text-xs text-crx-green hover:underline whitespace-nowrap"
                      >
                        Full
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setApplyBucket(null)}>Cancel</Button>
              <Button onClick={handleConfirmApply} icon={<ArrowRight className="w-4 h-4" />}>
                Stage Allocations
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
