/**
 * PrepaymentManager — Prepay credit balances, apply remaining, application history
 *
 * Sprint 11: Financial Workflows
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { DollarSign, Zap, RefreshCw, Plus, ArrowRight, X, ChevronDown, ChevronUp, Pencil, Trash2 } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import Input from '../ui/Input';
import DataTable, { type Column } from '../ui/DataTable';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { sanitizeError, supabase, assertRpcResult } from '../../lib/db';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { exportToCSV, fmtCSV } from '../../lib/csvExport';
import { runCriticalAction } from '../../lib/criticalAction';
import { Sentry } from '../../lib/sentry';
import { parseDollarsToCents } from '../../lib/parseCents';
import { logActivity } from '../../lib/activityLogger';
import { formatCents as fmt } from '../../lib/money';

interface CustomerPrepay {
  [k: string]: unknown;
  id: string;
  farm_name: string;
  prepay_balance_cents: number;
  unpaid_invoice_count: number;
  unpaid_balance_cents: number;
}

interface PrepayCredit {
  id: string;
  customer_id: string;
  original_amount_cents: number;
  balance_cents: number;
  reference_number: string | null;
  bucket_label: string | null;
  notes: string | null;
  payment_method: string | null;
  source_type: string | null;
  created_at: string;
}

interface BucketSplit {
  label: string;
  amount: string; // dollar string
}

export default function PrepaymentManagerPanel() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const applyPrepayIdem = useIdempotencyKey('apply_remaining_prepayments', profile?.id || '');
  const batchApplyIdem = useIdempotencyKey('batch_apply_all_prepayments', profile?.id || '');
  const splitCheckIdem = useIdempotencyKey('create_prepay_check_splits', profile?.id || '');

  // Codex P2 fix (PR #59, 2026-05-16): scope edit/delete idempotency keys per
  // credit_id. The page-scoped useIdempotencyKey shared a single key across
  // all credits — if an admin edited credit A, the response was lost, then
  // they opened credit B and edited it, both requests would carry the same
  // key. The server's idempotency cache would replay credit A's "success"
  // for credit B's request, returning success without mutating credit B.
  // Map<credit_id, key> + per-credit reset closes that gap. Pattern is local
  // to this page since other useIdempotencyKey callsites already have
  // single-entity intents per click.
  const editKeysRef = useRef<Map<string, string>>(new Map());
  const deleteKeysRef = useRef<Map<string, string>>(new Map());
  const getScopedKey = useCallback((map: Map<string, string>, operation: string, creditId: string): string => {
    let key = map.get(creditId);
    if (!key) {
      key = `${operation}:${profile?.id || ''}:${creditId}:${crypto.randomUUID()}`;
      map.set(creditId, key);
    }
    return key;
  }, [profile?.id]);
  const resetScopedKey = useCallback((map: Map<string, string>, creditId: string): void => {
    map.delete(creditId);
  }, []);

  const [customers, setCustomers] = useState<CustomerPrepay[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmCustomer, setConfirmCustomer] = useState<CustomerPrepay | null>(null);
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchApplying, setBatchApplying] = useState(false);

  // Individual credits drill-down
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [customerCredits, setCustomerCredits] = useState<PrepayCredit[]>([]);
  const [loadingCredits, setLoadingCredits] = useState(false);

  // Edit credit modal
  const [editCredit, setEditCredit] = useState<PrepayCredit | null>(null);
  const [editForm, setEditForm] = useState({ balance: '', reference_number: '', bucket_label: '', notes: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete credit modal
  const [deleteCredit, setDeleteCredit] = useState<PrepayCredit | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [savingDelete, setSavingDelete] = useState(false);

  // (Assign-to-booking earmark modal removed 2026-06-14 — earmark engine shelved:
  // docs/roadmap/shelved-earmark-engine/)

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
        unpaid_balance_cents: (invData || []).reduce((s: number, i: { balance_cents: number | null }) => s + (i.balance_cents ?? 0), 0),
      });
    }

    setCustomers(enriched);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Fetch individual credits for a customer
  const fetchCredits = useCallback(async (customerId: string) => {
    setLoadingCredits(true);
    const { data, error } = await supabase
      .from('prepay_credits')
      .select('id, customer_id, original_amount_cents, balance_cents, reference_number, bucket_label, notes, payment_method, source_type, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false });
    if (error) {
      toast('error', 'Failed to load credits');
    } else {
      setCustomerCredits((data || []) as PrepayCredit[]);
    }
    setLoadingCredits(false);
  }, [toast]);

  const toggleExpand = (customerId: string) => {
    if (expandedCustomer === customerId) {
      setExpandedCustomer(null);
      setCustomerCredits([]);
    } else {
      setExpandedCustomer(customerId);
      fetchCredits(customerId);
    }
  };

  // Edit credit
  const openEdit = (credit: PrepayCredit) => {
    setEditCredit(credit);
    setEditForm({
      balance: (credit.balance_cents / 100).toFixed(2),
      reference_number: credit.reference_number || '',
      bucket_label: credit.bucket_label || '',
      notes: credit.notes || '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editCredit) return;
    const newBalanceCents = parseDollarsToCents(editForm.balance);
    if (isNaN(newBalanceCents) || newBalanceCents < 0) {
      toast('error', 'Balance must be a non-negative number');
      return;
    }

    await runCriticalAction({
      action: async () => {
        const editKey = getScopedKey(editKeysRef.current, 'edit_prepay_credit', editCredit.id);
        const { data, error } = await supabase.rpc('edit_prepay_credit', {
          p_credit_id: editCredit.id,
          p_new_balance_cents: newBalanceCents,
          p_reference_number: editForm.reference_number || undefined,
          p_bucket_label: editForm.bucket_label || undefined,
          p_notes: editForm.notes || undefined,
          p_performed_by: profile?.id,
          p_idempotency_key: editKey,
        });
        if (error) throw error;
        const result = assertRpcResult<{ success: boolean }>(data, 'edit_prepay_credit');
        if (!result?.success) throw new Error('Edit failed');
        resetScopedKey(editKeysRef.current, editCredit.id);
      },
      toast,
      setLoading: setSavingEdit,
      successMessage: `Updated prepay credit ${editCredit.reference_number || editCredit.id.slice(0, 8)}`,
      sentryTag: 'edit_prepay_credit',
      onSuccess: () => {
        setEditCredit(null);
        fetchCredits(editCredit.customer_id);
        fetchCustomers();
      },
    });
  };

  // Delete credit
  const openDelete = (credit: PrepayCredit) => {
    setDeleteCredit(credit);
    setDeleteReason('');
  };

  const handleConfirmDelete = async () => {
    if (!deleteCredit || !deleteReason.trim()) {
      toast('error', 'A reason is required to delete a prepay credit');
      return;
    }

    await runCriticalAction({
      action: async () => {
        const deleteKey = getScopedKey(deleteKeysRef.current, 'delete_prepay_credit', deleteCredit.id);
        const { data, error } = await supabase.rpc('delete_prepay_credit', {
          p_credit_id: deleteCredit.id,
          p_reason: deleteReason.trim(),
          p_performed_by: profile?.id,
          p_idempotency_key: deleteKey,
        });
        if (error) throw error;
        const result = assertRpcResult<{ success: boolean }>(data, 'delete_prepay_credit');
        if (!result?.success) throw new Error('Delete failed');
        resetScopedKey(deleteKeysRef.current, deleteCredit.id);
      },
      toast,
      setLoading: setSavingDelete,
      successMessage: `Deleted prepay credit ${deleteCredit.reference_number || deleteCredit.id.slice(0, 8)} (${fmt(deleteCredit.balance_cents)})`,
      sentryTag: 'delete_prepay_credit',
      onSuccess: () => {
        setDeleteCredit(null);
        fetchCredits(deleteCredit.customer_id);
        fetchCustomers();
      },
    });
  };

  // (openBooking / handleSaveBooking earmark handlers removed 2026-06-14 — the
  // booking-prepay earmark engine is shelved: docs/roadmap/shelved-earmark-engine/)

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
    // Codex P2 fix (PR #59, 2026-05-16): reset the splitCheckIdem key on
    // every modal open. Without this, if check A succeeds but the response
    // is lost, then the admin edits the still-open form for a different
    // customer/reference and submits check B, both calls share the same
    // page-scoped key and the server replays A's cached success without
    // creating check B's credits or updating B's customer balance.
    // Reset-on-open means each modal-open starts a fresh idempotency
    // intent. Retries of THE SAME submission still reuse the key correctly
    // because resetKey() is only called here and in the onSuccess path.
    splitCheckIdem.resetKey();
    setCheckForm({ customer_id: '', reference_number: '', total: '' });
    setBucketSplits([{ label: '', amount: '' }]);
    setShowNewCheck(true);
  };

  const handleSaveCheck = async () => {
    if (!checkForm.customer_id || !checkForm.reference_number || !checkForm.total) {
      toast('error', 'Fill in customer, check #, and total amount');
      return;
    }
    const totalCents = parseDollarsToCents(checkForm.total);
    if (totalCents <= 0) { toast('error', 'Total must be positive'); return; }

    const validSplits = bucketSplits.filter((s) => s.label && parseFloat(s.amount) > 0);
    if (validSplits.length === 0) { toast('error', 'Add at least one bucket split'); return; }

    // M3: use per-split rounded cents to avoid float rounding mismatch
    const splitAmountsCents = validSplits.map((s) => parseDollarsToCents(s.amount));
    const splitTotal = splitAmountsCents.reduce((sum, c) => sum + c, 0);
    // Money is already integer cents here, so the totals must match exactly.
    if (splitTotal !== totalCents) {
      toast('error', `Splits total ($${(splitTotal / 100).toFixed(2)}) must equal check total ($${checkForm.total})`);
      return;
    }

    await runCriticalAction({
      action: async () => {
        // M6: Use atomic RPC — inserts all credits + updates customer balance in one transaction.
        // RPC restored 2026-05-11 (was never applied originally) — see migration
        // 20260511020000_create_prepay_check_splits.sql for history.
        const splits = validSplits.map((s, i) => ({
          label: s.label,
          amount_cents: splitAmountsCents[i],
        }));
        const splitKey = splitCheckIdem.getKey();
        const performedBy = (await supabase.auth.getUser()).data.user?.id;
        if (!performedBy) throw new Error('Not authenticated');
        const { data, error } = await supabase.rpc('create_prepay_check_splits', {
          p_customer_id: checkForm.customer_id,
          p_reference_number: checkForm.reference_number,
          p_splits: splits,
          p_expected_total_cents: totalCents,
          p_performed_by: performedBy,
          p_idempotency_key: splitKey,
        });
        if (error) throw new Error(error.message);
        const result = assertRpcResult<{ success: boolean; credit_ids: string[]; total_cents: number; split_count: number }>(data, 'create_prepay_check_splits');
        splitCheckIdem.resetKey();
        // Audit #27: surface prepay creation in activity feed.
        if (profile) {
          await logActivity({
            event: 'prepay_check_created',
            description: `Prepay check #${checkForm.reference_number} (${fmt(result.total_cents)}) split into ${result.split_count} bucket(s)`,
            performedBy: profile.id,
            entityType: 'customer',
            entityId: checkForm.customer_id,
            customerId: checkForm.customer_id,
          });
        }
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
    if (!confirmCustomer || !profile) return;
    setApplying(confirmCustomer.id);
    setShowConfirm(false);

    try {
      // F1: scoped by customer. This key is now RETAINED across an ambiguous reply so
      // the retry can replay, but the panel lists every customer and applying to B
      // without leaving the page would otherwise reuse A's unresolved key —
      // check_idempotency matches on key plus operation only and would hand back A's
      // receipt while the screen reported it against B. getKeyFor/resetKeyFor take the
      // scope explicitly, so an in-flight attempt cannot be re-scoped by a re-render.
      // p_customer_id is the only part of this payload a retry can vary, so the
      // customer id binds the request completely (Codex round-4 MEDIUM).
      const applyScope = confirmCustomer.id;
      const applyKey = applyPrepayIdem.getKeyFor(applyScope);
      const { data, error } = await supabase.rpc('apply_remaining_prepayments', {
        p_customer_id: confirmCustomer.id,
        p_performed_by: profile.id,
        p_idempotency_key: applyKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ applied_count: number; applied_cents: number; remaining_prepay_cents: number }>(data, 'apply_remaining_prepayments');
      applyPrepayIdem.resetKeyFor(applyScope);
      // Audit #27: surface prepay application in activity feed.
      if (profile && result.applied_count > 0) {
        await logActivity({
          event: 'prepay_applied',
          description: `Applied ${fmt(result.applied_cents)} prepay to ${result.applied_count} invoice(s) for ${confirmCustomer.farm_name}`,
          performedBy: profile.id,
          entityType: 'customer',
          entityId: confirmCustomer.id,
          customerId: confirmCustomer.id,
        });
      }
      toast(
        'success',
        `Applied ${fmt(result.applied_cents)} to ${result.applied_count} invoice(s). Remaining: ${fmt(result.remaining_prepay_cents)}`,
      );
      fetchCustomers();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'apply_remaining_prepayments' } });
      toast('error', sanitizeError(err));
    }
    setApplying(null);
  };

  const confirmBatchApply = async () => {
    setShowBatchConfirm(false);
    setBatchApplying(true);
    try {
      const batchKey = batchApplyIdem.getKey();
      const { data, error } = await supabase.rpc('batch_apply_all_prepayments', {
        p_performed_by: profile?.id,
        p_idempotency_key: batchKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ total_customers: number; total_applied_cents: number; details: unknown[] }>(data, 'batch_apply_all_prepayments');
      batchApplyIdem.resetKey();
      // Audit #27: surface batch prepay run in activity feed.
      if (profile && result.total_customers > 0) {
        await logActivity({
          event: 'prepay_batch_applied',
          description: `Batch prepay run: applied ${fmt(result.total_applied_cents)} across ${result.total_customers} customer(s)`,
          performedBy: profile.id,
        });
      }
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
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'batch_apply_all_prepayments' } });
      toast('error', sanitizeError(err));
    }
    setBatchApplying(false);
  };

  const totalPrepay = customers.reduce((s, c) => s + c.prepay_balance_cents, 0);
  const totalUnpaid = customers.reduce((s, c) => s + c.unpaid_balance_cents, 0);

  const columns: Column<CustomerPrepay>[] = [
    {
      key: 'farm_name',
      header: 'Customer',
      sortable: true,
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); toggleExpand(r.id); }}
          className="flex items-center gap-2 font-medium text-nav-dark hover:text-crx-green transition-colors text-left"
        >
          {expandedCustomer === r.id ? <ChevronUp className="w-4 h-4 text-secondary" /> : <ChevronDown className="w-4 h-4 text-secondary" />}
          {r.farm_name}
        </button>
      ),
    },
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
              navigate(`/prepay?tab=workspace&customer=${r.id}`);
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
              // codex-driven hunt cycle 5: apply_remaining_prepayments is hard-disabled
              // server-side (RAISE guard) pending the reserved-pool redesign, so this
              // one-click apply always failed. Disable it and route users to Allocate
              // (the working per-bucket flow) until the redesign lands.
              disabled
              title="One-click apply is temporarily disabled pending the reserved-pool redesign — use Allocate to apply this customer's credits per bucket."
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
              // codex-driven hunt cycle 5: batch_apply_all_prepayments is hard-disabled
              // server-side (RAISE guard) pending the reserved-pool redesign, so "Apply
              // All" always failed. Disable until the redesign lands; use Allocate per
              // customer in the meantime.
              disabled
              title="Bulk apply is temporarily disabled pending the reserved-pool redesign — use Allocate to apply each customer's credits per bucket."
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
                  { key: 'prepay_balance_cents', header: 'Prepay Balance ($)', format: (v: unknown) => fmtCSV((Number(v) || 0) / 100) },
                  { key: 'unpaid_invoice_count', header: 'Unpaid Invoices' },
                  { key: 'unpaid_balance_cents', header: 'Unpaid Balance ($)', format: (v: unknown) => fmtCSV((Number(v) || 0) / 100) },
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

          {/* Expanded credits for selected customer */}
          {expandedCustomer && (
            <div className="mt-4 border-t border-gray-100 pt-4">
              <h3 className="text-sm font-semibold text-nav-dark mb-3">
                Individual Credits — {customers.find((c) => c.id === expandedCustomer)?.farm_name}
              </h3>
              {loadingCredits ? (
                <p className="text-sm text-secondary py-4 text-center">Loading credits...</p>
              ) : customerCredits.length === 0 ? (
                <p className="text-sm text-secondary py-4 text-center">No prepay credit records found for this customer</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-2 px-3 text-secondary font-medium">Date</th>
                        <th className="text-left py-2 px-3 text-secondary font-medium">Ref #</th>
                        <th className="text-left py-2 px-3 text-secondary font-medium">Bucket</th>
                        <th className="text-right py-2 px-3 text-secondary font-medium">Original</th>
                        <th className="text-right py-2 px-3 text-secondary font-medium">Balance</th>
                        <th className="text-left py-2 px-3 text-secondary font-medium">Source</th>
                        <th className="text-left py-2 px-3 text-secondary font-medium">Notes</th>
                        <th className="text-right py-2 px-3 text-secondary font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customerCredits.map((cr) => (
                        <tr key={cr.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                          <td className="py-2 px-3 text-secondary">{new Date(cr.created_at).toLocaleDateString()}</td>
                          <td className="py-2 px-3 font-medium">{cr.reference_number || '—'}</td>
                          <td className="py-2 px-3">
                            <div className="flex flex-wrap items-center gap-1">
                              {cr.bucket_label && <Badge variant="default">{cr.bucket_label}</Badge>}
                              {!cr.bucket_label && '—'}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right">{fmt(cr.original_amount_cents)}</td>
                          <td className={`py-2 px-3 text-right font-medium ${cr.balance_cents > 0 ? 'text-crx-green' : 'text-secondary'}`}>
                            {fmt(cr.balance_cents)}
                          </td>
                          <td className="py-2 px-3 text-secondary">{cr.source_type || cr.payment_method || '—'}</td>
                          <td className="py-2 px-3 text-secondary max-w-[200px] truncate" title={cr.notes || ''}>{cr.notes || '—'}</td>
                          <td className="py-2 px-3 text-right">
                            {profile?.role === 'admin' && (
                              <div className="flex justify-end gap-1">
                                <button
                                  onClick={() => openEdit(cr)}
                                  className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                  title="Edit credit"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                {cr.balance_cents > 0 && (
                                  <button
                                    onClick={() => openDelete(cr)}
                                    className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                    title="Delete credit"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Edit Credit Modal */}
      <Modal open={!!editCredit} onClose={() => setEditCredit(null)} title="Edit Prepay Credit">
        {editCredit && (
          <div className="space-y-4">
            <div className="bg-gray-50 p-3 rounded-lg text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-secondary">Credit ID</span>
                <span className="font-mono text-xs">{editCredit.id.slice(0, 8)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-secondary">Current Balance</span>
                <span className="font-medium text-crx-green">{fmt(editCredit.balance_cents)}</span>
              </div>
            </div>
            <Input
              label="Balance ($)"
              type="number"
              step="0.01"
              min="0"
              value={editForm.balance}
              onChange={(e) => setEditForm({ ...editForm, balance: e.target.value })}
            />
            <Input
              label="Reference #"
              value={editForm.reference_number}
              onChange={(e) => setEditForm({ ...editForm, reference_number: e.target.value })}
              placeholder="Check or reference number"
            />
            <div>
              <label className="text-sm font-medium text-nav-dark">Bucket Label</label>
              <select
                value={editForm.bucket_label}
                onChange={(e) => setEditForm({ ...editForm, bucket_label: e.target.value })}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">No bucket</option>
                {bucketLabels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
            <Input
              label="Notes"
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              placeholder="Optional notes"
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setEditCredit(null)}>Cancel</Button>
              <Button onClick={handleSaveEdit} loading={savingEdit} icon={<Pencil className="w-4 h-4" />}>
                Save Changes
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Credit Confirmation Modal */}
      <Modal open={!!deleteCredit} onClose={() => setDeleteCredit(null)} title="Delete Prepay Credit">
        {deleteCredit && (
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              This will zero out the balance for this prepay credit. The record remains for audit purposes.
            </p>
            <div className="bg-red-50 p-3 rounded-lg text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-secondary">Reference</span>
                <span className="font-medium">{deleteCredit.reference_number || deleteCredit.id.slice(0, 8)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-secondary">Bucket</span>
                <span>{deleteCredit.bucket_label || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-secondary">Balance to Remove</span>
                <span className="font-medium text-red-600">{fmt(deleteCredit.balance_cents)}</span>
              </div>
            </div>
            <Input
              label="Reason *"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Why is this credit being deleted?"
              required
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setDeleteCredit(null)}>Cancel</Button>
              <Button
                onClick={handleConfirmDelete}
                loading={savingDelete}
                icon={<Trash2 className="w-4 h-4" />}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                Delete Credit
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* (Assign-to-Booking earmark modal removed 2026-06-14 — earmark engine shelved
          for a reserved-pool redesign: docs/roadmap/shelved-earmark-engine/) */}

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
