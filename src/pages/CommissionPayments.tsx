/**
 * CommissionPayments — Commission payment management page
 * Unposted/Posted/Voided tabs, create from unpaid commissions, post workflow.
 *
 * Sprint 10: Commission Payment Lifecycle
 */
import { useEffect, useState , useCallback } from 'react';
import { DollarSign, Send, Plus, Check, Clock, RotateCcw } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import PageHeader from '../components/ui/PageHeader';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getIdempotencyBindingRejection } from '../lib/idempotency';
import { exportToCSV, fmtCSV } from '../lib/csvExport';
import { localToday } from '../lib/dateUtils';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { formatUSD as fmt } from '../lib/money';

interface CommissionPaymentRow {
  [k: string]: unknown;
  id: string;
  payment_number: string;
  recipient_id: string;
  recipient_name: string;
  total_amount: number;
  status: string;
  payment_method: string | null;
  reference_number: string | null;
  payment_date: string;
  posted_at: string | null;
  notes: string | null;
  created_at: string;
  item_count: number | null;
}

interface UnpaidCommission {
  id: string;
  order_number: string;
  customer_name: string;
  order_date: string;
  commission_amount: number;
  recipient_name: string;
  recipient_user_id: string;
}

export default function CommissionPayments() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const createPaymentIdem = useIdempotencyKey('create_commission_payment', profile?.id || '');

  const [tab, setTab] = useState<'unposted' | 'posted' | 'voided'>('unposted');
  const [payments, setPayments] = useState<CommissionPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState<string | null>(null);
  const [showPostConfirm, setShowPostConfirm] = useState(false);
  const [postTargetId, setPostTargetId] = useState<string | null>(null);

  // Void payment modal (admin only, posted payments)
  const [showVoid, setShowVoid] = useState(false);
  const [voidTarget, setVoidTarget] = useState<CommissionPaymentRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Scoped to the row being acted on. Posting closes its dialog before the RPC
  // returns, so EVERY retry goes back through the row button — resetting the key
  // there (the old PR #59 behaviour) threw away the only thing that could replay
  // an uncertain post, and the server then refused the retry as already posted.
  // Target scoping keeps the key for a retry of the SAME payment and still mints
  // a fresh one the moment the admin picks a different row, which is what the
  // PR #59 reset was for.
  const postPaymentIdem = useIdempotencyKey('post_commission_payment', profile?.id || '', postTargetId || '');
  const voidPaymentIdem = useIdempotencyKey('void_commission_payment', profile?.id || '', voidTarget?.id || '');

  // Create payment modal
  const [showCreate, setShowCreate] = useState(false);
  const [unpaidCommissions, setUnpaidCommissions] = useState<UnpaidCommission[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState('');
  const [selectedCommissions, setSelectedCommissions] = useState<Set<string>>(new Set());
  const [payMethod, setPayMethod] = useState('check');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(localToday());
  const [payNotes, setPayNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchPayments = useCallback(async () => {
    setLoading(true);
    // PR-07 follow-up: dropped recipient FK embed; resolve via profile_public_view.
    const { data, error } = await supabase
      .from('commission_payments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      toast('error', 'Failed to load commission payments');
      setLoading(false);
      return;
    }

    const recipientIds = [...new Set(
      ((data || []) as Array<{ recipient_id?: string | null }>)
        .map((p) => p.recipient_id)
        .filter(Boolean) as string[]
    )];
    const recipientMap: Record<string, string> = {};
    if (recipientIds.length > 0) {
      const { data: recipients } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', recipientIds);
      (recipients || []).forEach((r: { id: string | null; full_name: string | null }) => { if (r.id) recipientMap[r.id] = r.full_name ?? ''; });
    }

    // Get item counts
    const rows: CommissionPaymentRow[] = [];
    let hasUnverifiedItemCount = false;
    for (const p of (data || []) as Array<Record<string, unknown> & { recipient_id?: string | null }>) {
      const { count, error: itemCountError } = await supabase
        .from('commission_payment_items')
        .select('*', { count: 'exact', head: true })
        .eq('commission_payment_id', p.id as string);

      if (itemCountError || count === null) {
        hasUnverifiedItemCount = true;
        Sentry.captureException(
          itemCountError ?? new Error('Commission item count was unavailable'),
          { extra: { context: 'load_commission_payment_item_count', paymentId: p.id } },
        );
      }

      rows.push({
        ...p,
        recipient_name: p.recipient_id ? recipientMap[p.recipient_id] || 'Unknown' : 'Unknown',
        item_count: itemCountError || count === null ? null : count,
      } as CommissionPaymentRow);
    }

    setPayments(rows);
    if (hasUnverifiedItemCount) {
      toast('error', 'Some commission payment item counts could not be verified. Posting is disabled for those rows.');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  const fetchUnpaid = async () => {
    // PR-07 follow-up: dropped recipient FK embed; resolve via profile_public_view.
    // commissions.order_number / customer_name are denormalized columns that
    // _insert_commissions_for_order never populates (always NULL), so the payout
    // modal showed a blank order # and blank customer. Select the FK ids instead and
    // resolve order # / farm name live (same pattern as recipient resolution below).
    const { data, error } = await supabase
      .from('commissions')
      .select(`
        id, order_id, job_id, customer_id, order_date, commission_amount,
        recipient_user_id
      `)
      // Only PENDING commissions are payable. `.neq('status','paid')` also leaked
      // CANCELLED commissions (lifecycle: pending → paid → cancelled) into the
      // pay-selection list and the unpaid totals. (overnight-bug-hunt finding)
      .eq('status', 'pending')
      .order('order_date', { ascending: false })
      .limit(500);

    if (error) {
      toast('error', 'Failed to load unpaid commissions: ' + error.message);
      return;
    }

    const rowsRaw = (data || []) as Array<Record<string, unknown> & {
      recipient_user_id?: string | null;
      order_id?: string | null;
      job_id?: string | null;
      customer_id?: string | null;
    }>;

    const recipientUserIds = [...new Set(rowsRaw.map((c) => c.recipient_user_id).filter(Boolean) as string[])];
    const orderIds = [...new Set(rowsRaw.map((c) => c.order_id).filter(Boolean) as string[])];
    const jobIds = [...new Set(rowsRaw.map((c) => c.job_id).filter(Boolean) as string[])];
    const customerIds = [...new Set(rowsRaw.map((c) => c.customer_id).filter(Boolean) as string[])];

    const recipientMap: Record<string, string> = {};
    if (recipientUserIds.length > 0) {
      const { data: recipients } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', recipientUserIds);
      (recipients || []).forEach((r: { id: string | null; full_name: string | null }) => { if (r.id) recipientMap[r.id] = r.full_name ?? ''; });
    }

    const orderMap: Record<string, string> = {};
    if (orderIds.length > 0) {
      const { data: orders } = await supabase
        .from('orders')
        .select('id, order_number')
        .in('id', orderIds);
      (orders || []).forEach((o: { id: string | null; order_number: string | null }) => { if (o.id) orderMap[o.id] = o.order_number ?? ''; });
    }

    // U8: job-sourced commissions (application channel) have order_id NULL —
    // resolve their job_number so the source column isn't blank.
    const jobMap: Record<string, string> = {};
    if (jobIds.length > 0) {
      const { data: jobs } = await supabase
        .from('jobs')
        .select('id, job_number')
        .in('id', jobIds);
      (jobs || []).forEach((j: { id: string | null; job_number: string | null }) => { if (j.id) jobMap[j.id] = j.job_number ?? ''; });
    }

    const customerMap: Record<string, string> = {};
    if (customerIds.length > 0) {
      const { data: customers } = await supabase
        .from('customers')
        .select('id, farm_name')
        .in('id', customerIds);
      (customers || []).forEach((c: { id: string | null; farm_name: string | null }) => { if (c.id) customerMap[c.id] = c.farm_name ?? ''; });
    }

    setUnpaidCommissions(
      rowsRaw.map((c) => ({
        ...c,
        order_number: c.order_id
          ? orderMap[c.order_id as string] || ''
          : c.job_id
            ? (jobMap[c.job_id as string] ? `Job ${jobMap[c.job_id as string]}` : '')
            : '',
        customer_name: c.customer_id ? customerMap[c.customer_id as string] || '' : '',
        recipient_name: c.recipient_user_id ? recipientMap[c.recipient_user_id] || 'Unknown' : 'Unknown',
      })) as unknown as UnpaidCommission[],
    );
  };

  const openCreate = async () => {
    // Codex P2 fix (PR #59, 2026-05-16): reset page-scoped key on each open.
    createPaymentIdem.resetKey();
    await fetchUnpaid();
    setSelectedRecipient('');
    setSelectedCommissions(new Set());
    setPayMethod('check');
    setPayRef('');
    setPayDate(localToday());
    setPayNotes('');
    setShowCreate(true);
  };

  // Unique recipients from unpaid commissions
  const recipients = Array.from(
    new Map(unpaidCommissions.map((c) => [c.recipient_user_id, c.recipient_name])),
  ).map(([id, name]) => ({ id, name }));

  const recipientCommissions = selectedRecipient
    ? unpaidCommissions.filter((c) => c.recipient_user_id === selectedRecipient)
    : [];

  const selectedTotal = recipientCommissions
    .filter((c) => selectedCommissions.has(c.id))
    .reduce((sum, c) => sum + c.commission_amount, 0);

  const fetchCreatedPaymentSummary = async (paymentId: string) => {
    const [paymentResult, itemResult] = await Promise.all([
      supabase
        .from('commission_payments')
        .select('payment_number,total_amount')
        .eq('id', paymentId)
        .maybeSingle(),
      supabase
        .from('commission_payment_items')
        .select('*', { count: 'exact', head: true })
        .eq('commission_payment_id', paymentId),
    ]);

    if (paymentResult.error || itemResult.error || !paymentResult.data) {
      return null;
    }

    return {
      paymentNumber: paymentResult.data.payment_number || '',
      totalAmount: Number(paymentResult.data.total_amount || 0),
      itemCount: itemResult.count || 0,
    };
  };

  const toggleCommission = (id: string) => {
    setSelectedCommissions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedCommissions.size === recipientCommissions.length) {
      setSelectedCommissions(new Set());
    } else {
      setSelectedCommissions(new Set(recipientCommissions.map((c) => c.id)));
    }
  };

  const handleCreate = async () => {
    if (selectedCommissions.size === 0) {
      toast('error', 'Select at least one commission');
      return;
    }
    setCreating(true);
    try {
      const createKey = createPaymentIdem.getKey();
      const { data, error } = await supabase.rpc('create_commission_payment', {
        p_commission_ids: Array.from(selectedCommissions),
        p_payment_method: payMethod,
        p_reference: (payRef || null) as string,
        p_payment_date: payDate,
        p_notes: (payNotes || null) as string,
        p_performed_by: profile?.id,
        p_idempotency_key: createKey,
      });
      if (error) throw error;
      const paymentId = assertRpcResult<string>(data, 'create_commission_payment');
      createPaymentIdem.resetKey();
      const createdSummary = await fetchCreatedPaymentSummary(paymentId);
      // Audit #11: surface commission events in the activity feed (DB side
      // already writes financial_audit_log; activity_feed is the user-facing one).
      if (profile) {
        await logActivity({
          event: 'commission_payment_created',
          description: createdSummary
            ? `Commission payment ${createdSummary.paymentNumber} created for ${fmt(createdSummary.totalAmount)} (${createdSummary.itemCount} commission(s))`
            : 'Commission payment created',
          performedBy: profile.id,
          entityType: 'commission_payment',
          entityId: paymentId,
        });
      }
      toast('success', createdSummary
        ? `Commission payment ${createdSummary.paymentNumber} created: ${fmt(createdSummary.totalAmount)}`
        : 'Commission payment created');
      setShowCreate(false);
      fetchPayments();
    } catch (err: unknown) {
      // The retry key is bound to one actor and one exact request. When the
      // database refuses it, no payment was created for THIS request, so the
      // key can be retired and the next click starts a clean action. A 'receipt'
      // refusal means the key is permanently unusable, so retiring it is what
      // keeps the admin from retrying the same dead key forever.
      const rejection = getIdempotencyBindingRejection(err);
      if (rejection) {
        createPaymentIdem.resetKey();
        if (rejection !== 'intent') {
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: `create_commission_payment_${rejection}_mismatch` } });
        }
        // Refresh BEFORE the toast: the message tells the admin to check the list
        // below it, so the list must already show post-refusal state when they
        // read that. Toasting first points them at stale financial data.
        setShowCreate(false);
        await fetchPayments();
        // Wording notes: on a pre-migration receipt the database cannot prove the
        // earlier request DIFFERED from this one, only that the key is already
        // spent — so the text says "already used" and claims no difference. And
        // a 'receipt' refusal covers two different situations: an EARLIER
        // receipt whose stored result is unusable (IDEMPOTENCY_RESULT_INVALID),
        // and THIS attempt failing to bind its own receipt after the payout ran
        // (IDEMPOTENCY_RECEIPT_MISSING — that raise rolls the whole statement
        // back, so there may be no earlier attempt at all). The text therefore
        // says "this request" and asserts nothing about a prior one.
        toast('warning', rejection === 'actor'
          ? 'That retry belongs to another user, so nothing was created. Reload the page and try again.'
          : rejection === 'receipt'
            ? 'The database could not confirm the outcome of this request, so nothing was created now. Check the payment list below before creating another.'
            : 'This retry was already used by an earlier commission payment, so nothing new was created. Check the payment list below before creating another.');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'create_commission_payment' } });
        toast('error', err instanceof Error ? err.message : 'Failed to create payment');
      }
    }
    setCreating(false);
  };

  const handlePost = async (paymentId: string) => {
    setShowPostConfirm(false);
    setPosting(paymentId);
    try {
      const postKey = postPaymentIdem.getKey();
      const { data, error } = await supabase.rpc('post_commission_payment', {
        p_payment_id: paymentId,
        p_performed_by: profile?.id,
        p_idempotency_key: postKey,
      });
      if (error) throw error;
      assertRpcResult(data, 'post_commission_payment');
      postPaymentIdem.resetKey();
      // Audit #11: surface in activity feed.
      if (profile) {
        await logActivity({
          event: 'commission_payment_posted',
          description: `Commission payment posted`,
          performedBy: profile.id,
          entityType: 'commission_payment',
          entityId: paymentId,
        });
      }
      toast('success', 'Commission payment posted');
      fetchPayments();
    } catch (err: unknown) {
      // See handleCreate: a refused retry key means this posting did not run.
      const rejection = getIdempotencyBindingRejection(err);
      if (rejection) {
        postPaymentIdem.resetKey();
        if (rejection !== 'intent') {
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: `post_commission_payment_${rejection}_mismatch` } });
        }
        // See handleCreate: refresh before the toast that points at the list.
        await fetchPayments();
        toast('warning', rejection === 'actor'
          ? 'That retry belongs to another user, so nothing was posted. Reload the page and try again.'
          : rejection === 'receipt'
            ? 'The database could not confirm the outcome of this request, so nothing was posted now. Check the payment list below before posting again.'
            : 'This retry was already used by an earlier posting, so nothing was posted now. Check the payment list below before posting again.');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'post_commission_payment' } });
        toast('error', err instanceof Error ? err.message : 'Failed to post');
      }
    }
    setPosting(null);
  };

  const handleVoidPayment = async () => {
    if (!voidTarget || !profile) return;
    setVoiding(true);
    try {
      const voidKey = voidPaymentIdem.getKey();
      const { data: voidResult, error } = await supabase.rpc('void_commission_payment', {
        p_payment_id: voidTarget.id,
        p_reason: voidReason.trim(),
        p_performed_by: profile.id,
        p_idempotency_key: voidKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ commissions_reset: number; commissions_cancelled_dead_order?: number }>(voidResult, 'void_commission_payment');
      voidPaymentIdem.resetKey();
      // codex-driven hunt cycle 2: void_commission_payment resets live-order
      // commissions to 'pending' (re-payable) but CLOSES OUT (cancels, amount→0)
      // any commission whose order was since cancelled/voided. Report both counts
      // so the admin isn't told a closed-out commission is repayable.
      const resetCount = result.commissions_reset || 0;
      const cancelledCount = result.commissions_cancelled_dead_order || 0;
      const outcome = cancelledCount > 0
        ? `${resetCount} commission(s) reset to pending, ${cancelledCount} closed out (order cancelled/voided)`
        : `${resetCount} commission(s) reset to pending`;
      // Audit #11: surface void in activity feed.
      await logActivity({
        event: 'commission_payment_voided',
        description: `Commission payment ${voidTarget.payment_number} voided (${outcome}). Reason: ${voidReason.trim()}`,
        performedBy: profile.id,
        entityType: 'commission_payment',
        entityId: voidTarget.id,
      });
      toast('success', `Payment ${voidTarget.payment_number} voided. ${outcome}.`);
      setShowVoid(false);
      setVoidReason('');
      setVoidTarget(null);
      fetchPayments();
    } catch (err: unknown) {
      // See handleCreate: a refused retry key means this void did not run.
      const rejection = getIdempotencyBindingRejection(err);
      if (rejection) {
        voidPaymentIdem.resetKey();
        if (rejection !== 'intent') {
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: `void_commission_payment_${rejection}_mismatch` } });
        }
        // See handleCreate: refresh before the toast that points at the list.
        setShowVoid(false);
        setVoidReason('');
        setVoidTarget(null);
        await fetchPayments();
        toast('warning', rejection === 'actor'
          ? 'That retry belongs to another user, so nothing was voided. Reload the page and try again.'
          : rejection === 'receipt'
            ? 'The database could not confirm the outcome of this request, so nothing was voided now. Check the payment list below before voiding again.'
            : 'This retry was already used by an earlier void, so nothing was voided now. Check the payment list below before voiding again.');
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'void_commission_payment' } });
        toast('error', err instanceof Error ? err.message : 'Failed to void payment');
      }
    }
    setVoiding(false);
  };

  const filtered = payments.filter((p) => p.status === tab);

  const unpostedTotal = payments
    .filter((p) => p.status === 'unposted')
    .reduce((sum, p) => sum + p.total_amount, 0);
  const postedTotal = payments
    .filter((p) => p.status === 'posted')
    .reduce((sum, p) => sum + p.total_amount, 0);

  const columns: Column<CommissionPaymentRow>[] = [
    {
      key: 'payment_number',
      header: 'Payment #',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.payment_number}</span>,
    },
    { key: 'recipient_name', header: 'Recipient', sortable: true },
    {
      key: 'total_amount',
      header: 'Amount',
      sortable: true,
      render: (r) => <span className="font-medium">{fmt(r.total_amount)}</span>,
    },
    { key: 'payment_method', header: 'Method', render: (r) => r.payment_method || '-' },
    { key: 'reference_number', header: 'Reference', render: (r) => r.reference_number || '-' },
    {
      key: 'payment_date',
      header: 'Date',
      sortable: true,
      render: (r) => new Date(r.payment_date + 'T00:00:00').toLocaleDateString(),
    },
    {
      key: 'item_count',
      header: 'Items',
      render: (r) => r.item_count === null ? (
        <span
          className="text-xs font-medium text-amber-700"
          title="The linked commission count could not be verified. Refresh before posting."
        >
          Count unavailable
        </span>
      ) : (
        <span className="text-secondary">{r.item_count} commission(s)</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge variant={r.status === 'posted' ? 'success' : r.status === 'voided' ? 'error' : 'warning'}>
          {r.status === 'posted' ? 'Posted' : r.status === 'voided' ? 'Voided' : 'Unposted'}
        </Badge>
      ),
    },
    ...(tab === 'unposted'
      ? [
          {
            key: 'id',
            header: '',
            render: (r: CommissionPaymentRow) => (
              <div className="flex justify-end gap-2">
                {r.item_count === null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Send className="w-3 h-3" />}
                    disabled
                    title="Posting is disabled because the linked commission count could not be verified. Refresh and try again."
                    showChevron={false}
                  >
                    Post
                  </Button>
                ) : r.item_count > 0 ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Send className="w-3 h-3" />}
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      // No resetKey here: the key is scoped to postTargetId, so a
                      // different row already mints a fresh one. Resetting would
                      // also discard the retained key for a retry of THIS row.
                      setPostTargetId(r.id);
                      setShowPostConfirm(true);
                    }}
                    loading={posting === r.id}
                    showChevron={false}
                  >
                    Post
                  </Button>
                ) : (
                  <span
                    className="inline-flex items-center rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700"
                    title="This legacy payment batch has no commission items and cannot be posted. Void it or rebuild it."
                  >
                    Empty batch
                  </span>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  icon={<RotateCcw className="w-3 h-3" />}
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    // No resetKey here: the key is scoped to voidTarget.id.
                    setVoidTarget(r);
                    setVoidReason('');
                    setShowVoid(true);
                  }}
                  showChevron={false}
                >
                  Void
                </Button>
              </div>
            ),
          },
        ] as Column<CommissionPaymentRow>[]
      : tab === 'posted'
        ? [
            {
              key: 'id',
              header: '',
              render: (r: CommissionPaymentRow) => (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<RotateCcw className="w-3 h-3" />}
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    // No resetKey here: the key is scoped to voidTarget.id, so a
                    // different row mints a fresh key on its own and a retry of
                    // THIS row keeps the key that can replay it.
                    setVoidTarget(r);
                    setVoidReason('');
                    setShowVoid(true);
                  }}
                  showChevron={false}
                >
                  Void
                </Button>
              ),
            },
          ] as Column<CommissionPaymentRow>[]
        : ([] as Column<CommissionPaymentRow>[])),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Commission"
        accent="Payments"
        actions={(
          <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              exportToCSV(
                filtered as unknown as Record<string, unknown>[],
                [
                  { key: 'payment_number', header: 'Payment #' },
                  { key: 'recipient_name', header: 'Recipient' },
                  { key: 'total_amount', header: 'Amount ($)', format: (v: unknown) => fmtCSV(Number(v) || 0) },
                  { key: 'payment_method', header: 'Method' },
                  { key: 'reference_number', header: 'Reference' },
                  { key: 'payment_date', header: 'Date' },
                  { key: 'status', header: 'Status' },
                ],
                'commission_payments',
              )
            }
          >
            Export CSV
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
            New Payment
          </Button>
          </div>
        )}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-secondary">Unposted</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-amber-600">{fmt(unpostedTotal)}</p>
          <p className="text-xs text-secondary mt-1">
            {payments.filter((p) => p.status === 'unposted').length} payment(s) awaiting posting
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <Check className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Posted Total</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(postedTotal)}</p>
          <p className="text-xs text-secondary mt-1">
            {payments.filter((p) => p.status === 'posted').length} payment(s) posted
          </p>
        </Card>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {(['unposted', 'posted', 'voided'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === t ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'
            }`}
          >
            {t === 'unposted' ? 'Unposted' : t === 'posted' ? 'Posted' : 'Voided'}
          </button>
        ))}
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search payments..."
            searchKeys={['payment_number', 'recipient_name', 'reference_number']}
            emptyTitle="No commission payments"
            emptyDescription={tab === 'unposted' ? 'Create a payment to get started' : tab === 'posted' ? 'No posted payments yet' : 'No voided payments yet'}
            loading={loading}
          />
        </div>
      </Card>

      {/* Void Payment Modal */}
      <Modal open={showVoid} onClose={() => setShowVoid(false)} title="Void Commission Payment">
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
            <RotateCcw className="w-5 h-5 text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-800">
              You are about to void payment <strong>{voidTarget?.payment_number}</strong> ({fmt(voidTarget?.total_amount || 0)}).
              Its {voidTarget?.item_count ?? 'unverified number of'} linked commission(s) will be reset to <strong>pending</strong> and can be re-paid later &mdash;
              except any whose order was since cancelled or voided, which will be <strong>closed out</strong> (not re-payable).
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Void Reason <span className="text-red-500">*</span></label>
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Enter reason for voiding this payment..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowVoid(false)}>Go Back</Button>
            <Button
              variant="danger"
              icon={<RotateCcw className="w-4 h-4" />}
              onClick={handleVoidPayment}
              loading={voiding}
              disabled={!voidReason.trim()}
            >
              Void Payment
            </Button>
          </div>
        </div>
      </Modal>

      {/* Post Payment Confirm Modal */}
      <ConfirmModal
        open={showPostConfirm}
        onClose={() => setShowPostConfirm(false)}
        onConfirm={() => {
          if (postTargetId) handlePost(postTargetId);
        }}
        title="Post Commission Payment"
        message="Post these commission payments? This action cannot be undone."
        confirmLabel="Post Payments"
        variant="warning"
        loading={posting !== null}
      />

      {/* Create Payment Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Commission Payment" size="large">
        <div className="space-y-4">
          {/* Recipient selector */}
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Recipient</label>
            <select
              value={selectedRecipient}
              onChange={(e) => {
                setSelectedRecipient(e.target.value);
                setSelectedCommissions(new Set());
              }}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">— Select Recipient —</option>
              {recipients.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({unpaidCommissions.filter((c) => c.recipient_user_id === r.id).length} unpaid)
                </option>
              ))}
            </select>
          </div>

          {/* Commission list */}
          {selectedRecipient && recipientCommissions.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-nav-dark">
                  Unpaid Commissions ({recipientCommissions.length})
                </label>
                <button onClick={selectAll} className="text-xs text-crx-green hover:underline">
                  {selectedCommissions.size === recipientCommissions.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <div className="max-h-60 overflow-auto border border-gray-200 rounded-lg divide-y divide-gray-50">
                {recipientCommissions.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedCommissions.has(c.id)}
                      onChange={() => toggleCommission(c.id)}
                      className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-nav-dark">{c.order_number}</div>
                      <div className="text-xs text-secondary">{c.customer_name} • {new Date(c.order_date + 'T00:00:00').toLocaleDateString()}</div>
                    </div>
                    <span className="text-sm font-medium">{fmt(c.commission_amount)}</span>
                  </label>
                ))}
              </div>
              {selectedCommissions.size > 0 && (
                <div className="mt-2 text-right text-sm font-semibold text-crx-green">
                  Selected Total: {fmt(selectedTotal)}
                </div>
              )}
            </div>
          )}

          {selectedRecipient && recipientCommissions.length === 0 && (
            <p className="text-sm text-secondary text-center py-4">No unpaid commissions for this recipient</p>
          )}

          {/* Payment details */}
          {selectedCommissions.size > 0 && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Payment Method</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="check">Check</option>
                  <option value="direct_deposit">Direct Deposit</option>
                  <option value="cash">Cash</option>
                  <option value="wire">Wire Transfer</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Payment Date</label>
                <input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Reference # (optional)</label>
                <input
                  type="text"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="Check #, transaction ID..."
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              loading={creating}
              disabled={selectedCommissions.size === 0}
              icon={<DollarSign className="w-4 h-4" />}
            >
              Create Payment ({fmt(selectedTotal)})
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
