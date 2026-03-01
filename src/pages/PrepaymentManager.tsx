/**
 * PrepaymentManager — Prepay credit balances, apply remaining, application history
 *
 * Sprint 11: Financial Workflows
 */
import { useEffect, useState , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { DollarSign, Zap, RefreshCw, Plus, ArrowRight, X } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import DataTable, { type Column } from '../components/ui/DataTable';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, checkMutationResult } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import { exportToCSV } from '../lib/csvExport';
import { runCriticalAction } from '../lib/criticalAction';

interface CustomerPrepay {
  [k: string]: unknown;
  id: string;
  farm_name: string;
  prepay_balance_cents: number;
  unpaid_invoice_count: number;
  unpaid_balance_cents: number;
}

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

interface BucketSplit {
  label: string;
  amount: string; // dollar string
}

export default function PrepaymentManager() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [customers, setCustomers] = useState<CustomerPrepay[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmCustomer, setConfirmCustomer] = useState<CustomerPrepay | null>(null);
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchApplying, setBatchApplying] = useState(false);

  // Split Check modal state
  const [showNewCheck, setShowNewCheck] = useState(false);
  const [allCustomers, setAllCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [bucketLabels, setBucketLabels] = useState<string[]>([]);
  const [checkForm, setCheckForm] = useState({ customer_id: '', reference_number: '', total: '' });
  const [bucketSplits, setBucketSplits] = useState<BucketSplit[]>([{ label: '', amount: '' }]);
  const [savingCheck, setSavingCheck] = useState(false);

  const fetchCustomers = useCallback(async () => {
    setLoading(true);

    // Get customers with prepay balances
    const { data: custData, error } = await supabase
      .from('customers')
      .select('id, farm_name, prepay_balance_cents')
      .gt('prepay_balance_cents', 0)
      .eq('is_active', true)
      .order('farm_name')
      .limit(500);

    if (error) {
      toast('error', 'Failed to load prepayments');
      setLoading(false);
      return;
    }

    // Enrich with unpaid invoice info
    const enriched: CustomerPrepay[] = [];
    for (const c of (custData || []) as Array<{ id: string; farm_name: string; prepay_balance_cents: number }>) {
      const { data: invData } = await supabase
        .from('invoices')
        .select('id, balance_cents')
        .eq('customer_id', c.id)
        .eq('status', 'posted')
        .gt('balance_cents', 0)
        .is('deleted_at', null);

      enriched.push({
        id: c.id,
        farm_name: c.farm_name,
        prepay_balance_cents: c.prepay_balance_cents || 0,
        unpaid_invoice_count: (invData || []).length,
        unpaid_balance_cents: (invData || []).reduce((s: number, i: { balance_cents: number }) => s + i.balance_cents, 0),
      });
    }

    setCustomers(enriched);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Fetch bucket labels + all customers for the New Check modal
  useEffect(() => {
    supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'prepay_bucket_labels')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.setting_value) setBucketLabels(JSON.parse(data.setting_value as string));
      });
    supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name')
      .then(({ data }) => setAllCustomers(data || []));
  }, []);

  const openNewCheck = () => {
    setCheckForm({ customer_id: '', reference_number: '', total: '' });
    setBucketSplits([{ label: '', amount: '' }]);
    setShowNewCheck(true);
  };

  const handleSaveCheck = async () => {
    if (!checkForm.customer_id || !checkForm.reference_number || !checkForm.total) {
      toast('error', 'Fill in customer, check #, and total amount');
      return;
    }
    const totalCents = Math.round(parseFloat(checkForm.total) * 100);
    if (totalCents <= 0) { toast('error', 'Total must be positive'); return; }

    const validSplits = bucketSplits.filter((s) => s.label && parseFloat(s.amount) > 0);
    if (validSplits.length === 0) { toast('error', 'Add at least one bucket split'); return; }

    const splitTotal = validSplits.reduce((s, b) => s + Math.round(parseFloat(b.amount) * 100), 0);
    if (splitTotal !== totalCents) {
      toast('error', `Splits total ($${(splitTotal / 100).toFixed(2)}) must equal check total ($${checkForm.total})`);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const rows = validSplits.map((s) => ({
          customer_id: checkForm.customer_id,
          reference_number: checkForm.reference_number,
          bucket_label: s.label,
          original_amount_cents: Math.round(parseFloat(s.amount) * 100),
          balance_cents: Math.round(parseFloat(s.amount) * 100),
          payment_method: 'check',
          notes: `Check #${checkForm.reference_number} — ${s.label}`,
        }));
        const result = await supabase.from('prepay_credits').insert(rows).select();
        checkMutationResult(result, 'Create prepay credits');

        // Update customer aggregate balance
        await supabase.rpc('increment_customer_prepay', {
          p_customer_id: checkForm.customer_id,
          p_amount_cents: totalCents,
        }).then(async ({ error }) => {
          // Fallback: direct update if RPC doesn't exist
          if (error) {
            const { data: custRow, error: fetchErr } = await supabase
              .from('customers')
              .select('prepay_balance_cents')
              .eq('id', checkForm.customer_id)
              .single();
            if (fetchErr || !custRow) throw new Error('Failed to fetch current prepay balance');
            const currentBalance = (custRow as { prepay_balance_cents: number }).prepay_balance_cents || 0;
            const { error: updateErr } = await supabase
              .from('customers')
              .update({ prepay_balance_cents: currentBalance + totalCents })
              .eq('id', checkForm.customer_id);
            if (updateErr) throw new Error('Failed to update prepay balance');
          }
        });
      },
      toast,
      setLoading: setSavingCheck,
      successMessage: `Check #${checkForm.reference_number} split into ${validSplits.length} bucket(s)`,
      sentryTag: 'split_check',
      onSuccess: () => {
        setShowNewCheck(false);
        fetchCustomers();
      },
    });
  };

  const handleApply = async (customer: CustomerPrepay) => {
    setConfirmCustomer(customer);
    setShowConfirm(true);
  };

  const confirmApply = async () => {
    if (!confirmCustomer) return;
    setApplying(confirmCustomer.id);
    setShowConfirm(false);

    try {
      const applyKey = generateIdempotencyKey('apply_remaining_prepayments', profile?.id || '');
      const { data, error } = await supabase.rpc('apply_remaining_prepayments', {
        p_customer_id: confirmCustomer.id,
        p_performed_by: profile?.id,
        p_idempotency_key: applyKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ applied_count: number; applied_cents: number; remaining_prepay_cents: number }>(data, 'apply_remaining_prepayments');
      toast(
        'success',
        `Applied ${fmt(result.applied_cents)} to ${result.applied_count} invoice(s). Remaining: ${fmt(result.remaining_prepay_cents)}`,
      );
      fetchCustomers();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to apply prepayments');
    }
    setApplying(null);
  };

  const confirmBatchApply = async () => {
    setShowBatchConfirm(false);
    setBatchApplying(true);
    try {
      const batchKey = generateIdempotencyKey('batch_apply_all_prepayments', profile?.id || '');
      const { data, error } = await supabase.rpc('batch_apply_all_prepayments', {
        p_performed_by: profile?.id,
        p_idempotency_key: batchKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ total_customers: number; total_applied_cents: number; details: unknown[] }>(data, 'batch_apply_all_prepayments');
      if (result.total_customers === 0) {
        toast('info', 'No prepayments could be applied (no customers with both prepay credits and unpaid invoices)');
      } else {
        toast(
          'success',
          `Applied ${fmt(result.total_applied_cents)} across ${result.total_customers} customer(s)`,
        );
      }
      fetchCustomers();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to apply batch prepayments');
    }
    setBatchApplying(false);
  };

  const totalPrepay = customers.reduce((s, c) => s + c.prepay_balance_cents, 0);
  const totalUnpaid = customers.reduce((s, c) => s + c.unpaid_balance_cents, 0);

  const columns: Column<CustomerPrepay>[] = [
    { key: 'farm_name', header: 'Customer', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.farm_name}</span> },
    {
      key: 'prepay_balance_cents',
      header: 'Prepay Balance',
      sortable: true,
      render: (r) => <span className="font-medium text-crx-green">{fmt(r.prepay_balance_cents)}</span>,
    },
    {
      key: 'unpaid_invoice_count',
      header: 'Unpaid Invoices',
      render: (r) => r.unpaid_invoice_count > 0 ? (
        <Badge variant="warning">{r.unpaid_invoice_count} invoice(s)</Badge>
      ) : (
        <span className="text-secondary">None</span>
      ),
    },
    {
      key: 'unpaid_balance_cents',
      header: 'Unpaid Balance',
      sortable: true,
      render: (r) => r.unpaid_balance_cents > 0 ? (
        <span className="text-red-600 font-medium">{fmt(r.unpaid_balance_cents)}</span>
      ) : (
        <span className="text-crx-green">$0.00</span>
      ),
    },
    {
      key: 'id',
      header: '',
      render: (r) => (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="primary"
            icon={<ArrowRight className="w-3 h-3" />}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              navigate(`/prepay-workspace?customer=${r.id}`);
            }}
            showChevron={false}
          >
            Allocate
          </Button>
          {r.unpaid_invoice_count > 0 && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Zap className="w-3 h-3" />}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                handleApply(r);
              }}
              loading={applying === r.id}
              showChevron={false}
            >
              Quick
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Prepayment Manager</h2>
          <p className="text-sm text-secondary mt-1">Apply prepay credits to outstanding invoices</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-4 h-4" />}
            onClick={openNewCheck}
          >
            New Check
          </Button>
          {customers.some((c) => c.unpaid_invoice_count > 0) && profile?.role === 'admin' && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Zap className="w-4 h-4" />}
              onClick={() => setShowBatchConfirm(true)}
              loading={batchApplying}
            >
              Apply All
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="w-4 h-4" />}
            onClick={fetchCustomers}
            showChevron={false}
          >
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              exportToCSV(
                customers as unknown as Record<string, unknown>[],
                [
                  { key: 'farm_name', header: 'Customer' },
                  { key: 'prepay_balance_cents', header: 'Prepay Balance (cents)' },
                  { key: 'unpaid_invoice_count', header: 'Unpaid Invoices' },
                  { key: 'unpaid_balance_cents', header: 'Unpaid Balance (cents)' },
                ],
                'prepayments',
              )
            }
          >
            Export CSV
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Total Prepay Credits</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(totalPrepay)}</p>
          <p className="text-xs text-secondary mt-1">{customers.length} customer(s) with prepay balances</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-secondary">Total Unpaid Invoices</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-600">{fmt(totalUnpaid)}</p>
          <p className="text-xs text-secondary mt-1">
            {customers.reduce((s, c) => s + c.unpaid_invoice_count, 0)} invoice(s)
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Zap className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Potential Auto-Apply</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-blue-600">
            {fmt(Math.min(totalPrepay, totalUnpaid))}
          </p>
          <p className="text-xs text-secondary mt-1">can be applied now</p>
        </Card>
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={customers as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search customers..."
            searchKeys={['farm_name']}
            emptyTitle="No prepay balances"
            emptyDescription="No customers currently have prepay credit balances"
            loading={loading}
          />
        </div>
      </Card>

      {/* Batch Apply All Confirmation */}
      <Modal open={showBatchConfirm} onClose={() => setShowBatchConfirm(false)} title="Apply All Prepayments">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Apply prepay credits for <strong>all {customers.filter((c) => c.unpaid_invoice_count > 0).length}</strong> customer(s) with
            both prepay balances and unpaid invoices? Credits will be applied to the oldest invoices first.
          </p>
          <div className="bg-gray-50 p-3 rounded-lg space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-secondary">Total Prepay Credits</span>
              <span className="font-medium text-crx-green">{fmt(totalPrepay)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-secondary">Total Unpaid Invoices</span>
              <span className="font-medium text-red-600">{fmt(totalUnpaid)}</span>
            </div>
            <hr />
            <div className="flex justify-between text-sm font-semibold">
              <span>Estimated Apply</span>
              <span>{fmt(Math.min(totalPrepay, totalUnpaid))}</span>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowBatchConfirm(false)}>Cancel</Button>
            <Button onClick={confirmBatchApply} icon={<Zap className="w-4 h-4" />} loading={batchApplying}>
              Apply All
            </Button>
          </div>
        </div>
      </Modal>

      {/* Per-Customer Confirmation Modal */}
      <Modal open={showConfirm} onClose={() => setShowConfirm(false)} title="Apply Prepayments">
        {confirmCustomer && (
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Apply prepay credits for <strong>{confirmCustomer.farm_name}</strong> to their oldest
              unpaid invoices?
            </p>
            <div className="bg-gray-50 p-3 rounded-lg space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Prepay Balance</span>
                <span className="font-medium text-crx-green">{fmt(confirmCustomer.prepay_balance_cents)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Unpaid Invoices</span>
                <span className="font-medium text-red-600">{fmt(confirmCustomer.unpaid_balance_cents)}</span>
              </div>
              <hr />
              <div className="flex justify-between text-sm font-semibold">
                <span>Will Apply</span>
                <span>{fmt(Math.min(confirmCustomer.prepay_balance_cents, confirmCustomer.unpaid_balance_cents))}</span>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setShowConfirm(false)}>Cancel</Button>
              <Button onClick={confirmApply} icon={<Zap className="w-4 h-4" />}>
                Apply Prepayments
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Split Check Modal */}
      <Modal open={showNewCheck} onClose={() => setShowNewCheck(false)} title="New Check — Split Into Buckets">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-nav-dark">Customer *</label>
            <select
              value={checkForm.customer_id}
              onChange={(e) => setCheckForm({ ...checkForm, customer_id: e.target.value })}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select customer...</option>
              {allCustomers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Check # *"
              value={checkForm.reference_number}
              onChange={(e) => setCheckForm({ ...checkForm, reference_number: e.target.value })}
              placeholder="4521"
            />
            <Input
              label="Total Amount *"
              type="number"
              step="0.01"
              min="0"
              value={checkForm.total}
              onChange={(e) => setCheckForm({ ...checkForm, total: e.target.value })}
              placeholder="10000.00"
            />
          </div>

          {/* Bucket Splits */}
          <div>
            <label className="text-sm font-medium text-nav-dark mb-2 block">Bucket Splits</label>
            <div className="space-y-2">
              {bucketSplits.map((split, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={split.label}
                    onChange={(e) => {
                      const updated = [...bucketSplits];
                      updated[idx] = { ...updated[idx], label: e.target.value };
                      setBucketSplits(updated);
                    }}
                    className="flex-1 px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Select bucket...</option>
                    {bucketLabels.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={split.amount}
                    onChange={(e) => {
                      const updated = [...bucketSplits];
                      updated[idx] = { ...updated[idx], amount: e.target.value };
                      setBucketSplits(updated);
                    }}
                    placeholder="0.00"
                    className="w-32"
                  />
                  {bucketSplits.length > 1 && (
                    <button
                      onClick={() => setBucketSplits(bucketSplits.filter((_, i) => i !== idx))}
                      className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={() => setBucketSplits([...bucketSplits, { label: '', amount: '' }])}
              className="mt-2 text-sm text-crx-green hover:underline flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add Bucket
            </button>
          </div>

          {/* Split Total Check */}
          {checkForm.total && (
            <div className="bg-gray-50 p-3 rounded-lg">
              <div className="flex justify-between text-sm">
                <span className="text-secondary">Check Total</span>
                <span className="font-medium">${parseFloat(checkForm.total || '0').toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-secondary">Split Total</span>
                <span className={`font-medium ${
                  Math.abs(bucketSplits.reduce((s, b) => s + parseFloat(b.amount || '0'), 0) - parseFloat(checkForm.total || '0')) < 0.01
                    ? 'text-crx-green' : 'text-red-600'
                }`}>
                  ${bucketSplits.reduce((s, b) => s + parseFloat(b.amount || '0'), 0).toFixed(2)}
                </span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowNewCheck(false)}>Cancel</Button>
            <Button onClick={handleSaveCheck} loading={savingCheck} icon={<Plus className="w-4 h-4" />}>
              Save Check
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
