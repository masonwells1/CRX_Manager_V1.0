/**
 * VendorBillDetail.tsx — View a vendor bill + record payments
 *
 * Shows bill info, linked PO, payment history, and "Record Payment" modal.
 * Uses record_vendor_payment() and void_vendor_bill() RPCs. Admin-only.
 */
import { useEffect, useState, useCallback, useLayoutEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  DollarSign,
  Calendar,
  FileText,
  CreditCard,
  XCircle,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ReasonModal from '../components/ui/ReasonModal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { sanitizeError } from '../lib/errorSanitizer';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getIdempotencyBindingRejection } from '../lib/idempotency';
import {
  UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE,
  UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE,
  useUncertainMutationIntent,
} from '../hooks/useUncertainMutationIntent';
import { useAuth } from '../contexts/AuthContext';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import {
  isWholeCentDollarInput,
  parseDollarsToCents,
  parseDollarsToCentsSigned,
} from '../lib/parseCents';
import { centsToDollarInput, formatCents as fmt } from '../lib/money';
import { getIdempotencyMismatchResult } from '../lib/idempotency';
import { Sentry } from '../lib/sentry';
import type { VendorBill, VendorPayment } from '../types';

const statusVariant: Record<string, BadgeVariant> = {
  unpaid: 'warning',
  partially_paid: 'info',
  paid: 'success',
  voided: 'default',
};

export default function VendorBillDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const activeBillIdRef = useRef(id);
  useLayoutEffect(() => {
    activeBillIdRef.current = id;
  }, [id]);
  const paymentIntent = useUncertainMutationIntent<{
    amountCents: number;
    args: {
      p_vendor_bill_id: string;
      p_payment_date: string;
      p_amount_cents: number;
      p_payment_method: string | undefined;
      p_reference_number: string | undefined;
      p_notes: string | undefined;
    };
  }>({
    operation: 'record_vendor_payment',
    userId: profile?.id || '',
    surface: 'vendor-bill-detail',
    scope: id || '',
    getIntentIdentity: (intent) => intent.args,
  });
  const voidIdem = useIdempotencyKey('void_vendor_bill', profile?.id || '');
  const voidPaymentIdem = useIdempotencyKey('void_vendor_payment', profile?.id || '');

  const [bill, setBill] = useState<(VendorBill & { vendor_name: string; po_number: string | null }) | null>(null);
  const [payments, setPayments] = useState<(VendorPayment & { creator_name: string })[]>([]);
  const [loading, setLoading] = useState(true);

  // Payment modal
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payModalBillId, setPayModalBillId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(localToday());
  const [payNotes, setPayNotes] = useState('');
  const [paying, setPaying] = useState(false);

  // Void bill
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidModalBillId, setVoidModalBillId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Void payment (PR-13, 2026-05-10) — per-row in the payments table.
  // Allows reversing a wrong vendor payment without voiding the whole bill.
  const [voidPaymentTarget, setVoidPaymentTarget] = useState<(VendorPayment & { creator_name: string }) | null>(null);
  const [voidPaymentReason, setVoidPaymentReason] = useState('');
  const [voidingPayment, setVoidingPayment] = useState(false);

  // Edit bill (PR-14, 2026-05-10) — only for unpaid bills with no active payments.
  const editIdem = useIdempotencyKey('update_vendor_bill', profile?.id || '');
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editModalBillId, setEditModalBillId] = useState<string | null>(null);
  const [editSubtotal, setEditSubtotal] = useState('');
  const [editAdjustment, setEditAdjustment] = useState('');
  const [editBillDate, setEditBillDate] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editing, setEditing] = useState(false);
  const [editOverageMessage, setEditOverageMessage] = useState<string | null>(null);

  // Route changes must retire every visible bill-specific form while preserving
  // any unresolved durable payment record under the old bill's storage scope.
  useEffect(() => {
    setBill(null);
    setPayments([]);
    setLoading(true);
    setPayModalOpen(false);
    setPayModalBillId(null);
    setPayAmount('');
    setPayMethod('check');
    setPayRef('');
    setPayDate(localToday());
    setPayNotes('');
    setVoidModalOpen(false);
    setVoidModalBillId(null);
    setVoidReason('');
    setVoidPaymentTarget(null);
    setVoidPaymentReason('');
    setEditModalOpen(false);
    setEditModalBillId(null);
    setEditSubtotal('');
    setEditAdjustment('');
    setEditBillDate('');
    setEditDueDate('');
    setEditNotes('');
  }, [id]);

  useEffect(() => {
    const recovered = paymentIntent.unresolvedIntent;
    if (!recovered || recovered.args.p_vendor_bill_id !== id) return;
    setPayAmount(centsToDollarInput(recovered.amountCents));
    setPayDate(recovered.args.p_payment_date);
    setPayMethod(recovered.args.p_payment_method || 'check');
    setPayRef(recovered.args.p_reference_number || '');
    setPayNotes(recovered.args.p_notes || '');
    setPayModalBillId(recovered.args.p_vendor_bill_id);
    setPayModalOpen(true);
  }, [id, paymentIntent.unresolvedIntent]);

  const today = localToday();

  const fetchBill = useCallback(async () => {
    if (!id) return;
    const requestedBillId = id;
    setLoading(true);

    const { data, error } = await supabase
      .from('vendor_bills')
      .select('*, vendor:vendors(name), purchase_order:purchase_orders(po_number)')
      .eq('id', id)
      .single();

    if (activeBillIdRef.current !== requestedBillId) return;
    if (error || !data) {
      toast('error', 'Bill not found');
      navigate('/accounts-payable/bills');
      return;
    }

    const d = data as Record<string, unknown>;
    setBill({
      ...d,
      vendor_name: (d.vendor as { name?: string } | null)?.name || 'Unknown',
      po_number: (d.purchase_order as { po_number?: string } | null)?.po_number || null,
    } as VendorBill & { vendor_name: string; po_number: string | null });

    // Fetch payments
    // PR-07 follow-up: dropped creator FK embed; resolved via profile_public_view.
    const { data: payData } = await supabase
      .from('vendor_payments')
      .select('*')
      .eq('vendor_bill_id', id)
      .order('payment_date', { ascending: false });

    const creatorIds = [...new Set(
      ((payData || []) as Array<{ created_by?: string | null }>)
        .map((p) => p.created_by)
        .filter(Boolean) as string[]
    )];
    const creatorMap: Record<string, string> = {};
    if (creatorIds.length > 0) {
      const { data: creators } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', creatorIds);
      ((creators || []) as Array<{ id: string; full_name: string }>).forEach((c) => { creatorMap[c.id] = c.full_name; });
    }

    const mappedPayments = ((payData || []) as Array<Record<string, unknown> & { created_by?: string | null }>).map((p) => ({
      ...p,
      creator_name: p.created_by ? creatorMap[p.created_by] || 'System' : 'System',
    })) as unknown as (VendorPayment & { creator_name: string })[];

    if (activeBillIdRef.current !== requestedBillId) return;
    setPayments(mappedPayments);
    setLoading(false);
  }, [id, toast, navigate]);

  useEffect(() => {
    fetchBill();
  }, [fetchBill]);

  const handleRecordPayment = async () => {
    if (paymentIntent.isForeignIntentLocked) {
      toast('error', UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE);
      return;
    }
    if (paymentIntent.isRetryExpired) {
      toast('error', UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE);
      return;
    }
    if (!id || payModalBillId !== id) {
      setPayModalOpen(false);
      setPayModalBillId(null);
      toast('error', 'The selected vendor bill changed. Reopen Record Payment on the current bill.');
      return;
    }
    if (!isWholeCentDollarInput(payAmount)) {
      toast('error', 'Enter the payment in dollars with no more than two decimal places');
      return;
    }
    const amountCents = parseDollarsToCents(payAmount);
    if (amountCents <= 0) { toast('error', 'Enter a valid payment amount'); return; }

    let request: NonNullable<typeof paymentIntent.unresolvedIntent>;
    let payKey: string;
    try {
      request = await paymentIntent.beginIntent({
        amountCents,
        args: {
          p_vendor_bill_id: id,
          p_payment_date: payDate,
          p_amount_cents: amountCents,
          p_payment_method: payMethod || undefined,
          p_reference_number: payRef || undefined,
          p_notes: payNotes || undefined,
        },
      });
      payKey = paymentIntent.getIdempotencyKey();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { source: 'durable-intent', page: 'vendor-bill-detail' },
      });
      toast('error', 'Payment could not be safely prepared. Nothing was recorded; refresh and try again.');
      return;
    }

    setPaying(true);
    try {
      const { data, error } = await supabase.rpc('record_vendor_payment', {
        ...request.args,
        p_idempotency_key: payKey,
      });
      if (error) throw error;
      assertRpcResult<string>(data, 'record_vendor_payment');
      await paymentIntent.resolveIntent();

      toast('success', `Payment of ${fmt(request.amountCents)} recorded`);
      setPayModalOpen(false);
      setPayModalBillId(null);
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      fetchBill();
    } catch (err) {
      // Durable-intent bookkeeping runs against IndexedDB and can reject on its
      // own (openDurableIntentDb throws DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE
      // in a private window, under a storage-quota failure, or when the
      // connection is blocked). It must never be able to swallow the outcome of
      // a payment that already committed: an unguarded await here left the
      // modal spinning with no refresh and no toast. Each bookkeeping call is
      // isolated, and setPaying(false) moved into finally so no path can strand
      // the button.
      const receipt = getIdempotencyMismatchResult(err, 'record_vendor_payment');
      if (typeof receipt?.payment_id === 'string') {
        try {
          await paymentIntent.resolveIntent();
        } catch (resolveError) {
          Sentry.captureException(
            resolveError instanceof Error ? resolveError : new Error(String(resolveError)),
            { tags: { source: 'durable-intent-resolve', page: 'vendor-bill-detail' } },
          );
        }
        toast('warning', 'The earlier payment already completed. The bill has been refreshed instead of recording a duplicate.');
        setPayModalOpen(false);
        setPayModalBillId(null);
        setPayAmount('');
        setPayRef('');
        setPayNotes('');
        fetchBill();
        return;
      }
      let disposition: Awaited<ReturnType<typeof paymentIntent.classifyFailure>>;
      try {
        disposition = await paymentIntent.classifyFailure(err);
      } catch (classifyError) {
        // classifyFailure already absorbs coordination failures internally; this
        // guard only stops an unexpected rejection from bypassing the toast.
        // 'uncertain' is the fail-closed answer: the payload stays locked.
        Sentry.captureException(
          classifyError instanceof Error ? classifyError : new Error(String(classifyError)),
          { tags: { source: 'durable-intent-classify', page: 'vendor-bill-detail' } },
        );
        disposition = 'uncertain';
      }
      if (disposition === 'resolved') {
        toast('warning', 'This payment completed in another tab. The bill has been refreshed.');
        setPayModalOpen(false);
        setPayModalBillId(null);
        setPayAmount('');
        setPayRef('');
        setPayNotes('');
        fetchBill();
        return;
      }
      if (disposition === 'definitive') {
        toast('error', sanitizeError(err));
      } else {
        toast('warning', 'The payment may already be recorded. The exact payment is locked; retry it unchanged to reconcile the result.');
      }
    } finally {
      setPaying(false);
    }
  };

  const openEditModal = () => {
    if (!bill || bill.id !== id) return;
    setEditSubtotal(centsToDollarInput(bill.subtotal_cents));
    setEditAdjustment(centsToDollarInput(bill.adjustment_cents || 0));
    setEditBillDate(bill.bill_date);
    setEditDueDate(bill.due_date);
    setEditNotes(bill.notes || '');
    setEditModalBillId(bill.id);
    setEditModalOpen(true);
  };

  const handleEditBill = async (confirmPoOverage = false, poOverageReason = '') => {
    if (!bill || bill.id !== id || editModalBillId !== id) {
      setEditModalOpen(false);
      setEditModalBillId(null);
      toast('error', 'The selected vendor bill changed. Reopen Edit Bill on the current bill.');
      return;
    }
    if (!isWholeCentDollarInput(editSubtotal)) {
      toast('error', 'Enter the subtotal in dollars with no more than two decimal places');
      return;
    }
    if (!isWholeCentDollarInput(editAdjustment || '0', { allowNegative: true })) {
      toast('error', 'Enter the adjustment in dollars with no more than two decimal places');
      return;
    }
    const subtotalCents = parseDollarsToCents(editSubtotal);
    if (subtotalCents <= 0) {
      toast('error', 'Subtotal must be positive');
      return;
    }
    // adjustment_cents intentionally negative-capable — user may enter "-10" to subtract
    const adjustmentCents = parseDollarsToCentsSigned(editAdjustment || '0');
    if (!editBillDate || !editDueDate) {
      toast('error', 'Bill date and due date are required');
      return;
    }
    if (editDueDate < editBillDate) {
      toast('error', 'Due date cannot precede bill date');
      return;
    }
    setEditing(true);
    try {
      const key = editIdem.getKey();
      const { data, error } = await supabase.rpc('update_vendor_bill', {
        p_bill_id: bill.id,
        p_subtotal_cents: subtotalCents,
        p_adjustment_cents: adjustmentCents,
        p_bill_date: editBillDate,
        p_due_date: editDueDate,
        p_notes: editNotes || '',
        p_idempotency_key: key,
        p_confirm_po_overage: confirmPoOverage,
        p_po_overage_reason: poOverageReason || undefined,
      });
      if (error) throw error;
      assertRpcResult<{ success: boolean; bill_id: string; old_total_cents: number; new_total_cents: number }>(data, 'update_vendor_bill');
      editIdem.resetKey();
      toast('success', 'Bill updated');
      setEditModalOpen(false);
      setEditModalBillId(null);
      fetchBill();
    } catch (err) {
      if (hasRpcCode(err, RpcErrorCodes.PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED)) {
        setEditOverageMessage(
          'The exact server total shows this edit would raise active billing above 105% of the purchase order. Enter a reason to confirm the overage.',
        );
      } else if (getIdempotencyBindingRejection(err)) {
        editIdem.resetKey();
        toast('warning', 'That retry belongs to a different bill edit. Your current changes were not saved; retry to submit them with a fresh key.');
      } else {
        toast('error', sanitizeError(err));
      }
    }
    setEditing(false);
  };

  const handleVoidPayment = async () => {
    if (!voidPaymentTarget || voidPaymentTarget.vendor_bill_id !== id) {
      setVoidPaymentTarget(null);
      setVoidPaymentReason('');
      toast('error', 'The selected vendor bill changed. Reopen the payment action on the current bill.');
      return;
    }
    if (!voidPaymentReason.trim()) {
      toast('error', 'Please provide a reason for voiding this payment');
      return;
    }
    const voidPaymentScope = JSON.stringify([voidPaymentTarget.id, voidPaymentReason.trim()]);
    setVoidingPayment(true);
    try {
      const key = voidPaymentIdem.getKeyFor(voidPaymentScope);
      const { data, error } = await supabase.rpc('void_vendor_payment', {
        p_payment_id: voidPaymentTarget.id,
        p_reason: voidPaymentReason.trim(),
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult<{
        success: boolean;
        payment_id: string;
        bill_id: string;
        voided_amount_cents: number;
        new_paid_cents: number;
        new_bill_status: string;
      }>(data, 'void_vendor_payment');
      voidPaymentIdem.resetKeyFor(voidPaymentScope);
      toast('success', 'Payment voided');
      setVoidPaymentTarget(null);
      setVoidPaymentReason('');
      fetchBill();
    } catch (err) {
      if (getIdempotencyBindingRejection(err)) {
        voidPaymentIdem.resetKeyFor(voidPaymentScope);
        toast('warning', 'That retry belongs to a different payment void. The payment was not changed; retry with a fresh key.');
      } else {
        toast('error', sanitizeError(err));
      }
    }
    setVoidingPayment(false);
  };

  const handleVoid = async () => {
    if (!id || voidModalBillId !== id) {
      setVoidModalOpen(false);
      setVoidModalBillId(null);
      toast('error', 'The selected vendor bill changed. Reopen Void Bill on the current bill.');
      return;
    }
    const voidBillScope = JSON.stringify([id, voidReason.trim() || null]);
    setVoiding(true);
    try {
      const voidKey = voidIdem.getKeyFor(voidBillScope);
      // RETURNS void — use .throwOnError() (regex coverage skips fire-and-forget).
      await supabase.rpc('void_vendor_bill', {
        p_vendor_bill_id: id,
        p_reason: voidReason.trim() || undefined,
        p_idempotency_key: voidKey,
      }).throwOnError();
      voidIdem.resetKeyFor(voidBillScope);

      toast('success', 'Bill voided');
      setVoidModalOpen(false);
      setVoidModalBillId(null);
      fetchBill();
    } catch (err) {
      if (getIdempotencyBindingRejection(err)) {
        voidIdem.resetKeyFor(voidBillScope);
        toast('warning', 'That retry belongs to a different bill void. This bill was not changed; retry to submit this void with a fresh key.');
      } else {
        toast('error', sanitizeError(err));
      }
    }
    setVoiding(false);
  };

  const isOverdue = bill && bill.status !== 'paid' && bill.status !== 'voided' && bill.due_date < today;

  type PaymentRow = VendorPayment & { creator_name: string };

  const paymentColumns: Column<PaymentRow>[] = [
    {
      key: 'payment_date',
      header: 'Date',
      render: (r) => new Date(r.payment_date + 'T00:00:00').toLocaleDateString(),
    },
    {
      key: 'amount_cents',
      header: 'Amount',
      render: (r) => <span className="font-mono font-semibold text-crx-green">{fmt(r.amount_cents)}</span>,
    },
    {
      key: 'payment_method',
      header: 'Method',
      render: (r) => <span className="capitalize">{r.payment_method || '-'}</span>,
    },
    {
      key: 'reference_number',
      header: 'Reference',
      render: (r) => r.reference_number || '-',
    },
    {
      key: 'creator_name' as keyof PaymentRow,
      header: 'Recorded By',
      render: (r) => r.creator_name,
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (r) => <span className="text-secondary text-xs">{r.notes || '-'}</span>,
    },
    {
      // PR-13: per-payment void action (admin only).
      key: 'voided_at' as keyof PaymentRow,
      header: 'Status',
      render: (r) => {
        if (r.voided_at) {
          return (
            <span className="text-xs text-secondary italic">
              Voided {new Date(r.voided_at).toLocaleDateString()}
              {r.void_reason ? ` — ${r.void_reason}` : ''}
            </span>
          );
        }
        if (profile?.role !== 'admin') {
          return <span className="text-xs text-secondary">—</span>;
        }
        return (
          <button
            onClick={() => {
              setVoidPaymentTarget(r);
              setVoidPaymentReason('');
            }}
            className="text-xs text-red-600 hover:text-red-700 underline"
          >
            Void
          </button>
        );
      },
    },
  ];

  if (loading || !bill) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/accounts-payable/bills')} className="text-crx-green hover:text-crx-green/70">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">
              Bill #{bill.bill_number}
            </h2>
            <p className="text-sm text-secondary">{bill.vendor_name}</p>
          </div>
          <Badge variant={isOverdue ? 'error' : (statusVariant[bill.status] || 'default')}>
            {isOverdue ? 'OVERDUE' : bill.status.replace(/_/g, ' ').toUpperCase()}
          </Badge>
        </div>
        <div className="flex gap-2">
          {/* PR-14 (2026-05-10): Edit Bill button — admin only, unpaid + no active payments */}
          {profile?.role === 'admin' &&
            bill.status === 'unpaid' &&
            payments.filter((p) => !p.voided_at).length === 0 && (
              <Button variant="ghost" onClick={openEditModal}>
                Edit Bill
              </Button>
            )}
          {bill.status !== 'paid' && bill.status !== 'voided' && (
            <>
              <Button
                icon={<CreditCard className="w-4 h-4" />}
                onClick={() => {
                  if (!paymentIntent.isIntentLocked) {
                    setPayAmount(centsToDollarInput(bill.balance_cents));
                  }
                  setPayModalBillId(bill.id);
                  setPayModalOpen(true);
                }}
              >
                Record Payment
              </Button>
              <Button
                variant="ghost"
                icon={<XCircle className="w-4 h-4" />}
                onClick={() => {
                  setVoidModalBillId(bill.id);
                  setVoidModalOpen(true);
                }}
                className="text-red-600 hover:text-red-700"
              >
                Void
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Bill Info Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-secondary" />
            <span className="text-xs text-secondary">Total Amount</span>
          </div>
          <p className="text-xl font-semibold font-heading text-nav-dark">{fmt(bill.total_cents)}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <CreditCard className="w-4 h-4 text-secondary" />
            <span className="text-xs text-secondary">Paid</span>
          </div>
          <p className="text-xl font-semibold font-heading text-crx-green">{fmt(bill.paid_cents)}</p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-secondary" />
            <span className="text-xs text-secondary">Balance Due</span>
          </div>
          <p className={`text-xl font-semibold font-heading ${bill.balance_cents > 0 ? 'text-red-600' : 'text-crx-green'}`}>
            {fmt(bill.balance_cents)}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <Calendar className="w-4 h-4 text-secondary" />
            <span className="text-xs text-secondary">Due Date</span>
          </div>
          <p className={`text-xl font-semibold font-heading ${isOverdue ? 'text-red-600' : 'text-nav-dark'}`}>
            {new Date(bill.due_date + 'T00:00:00').toLocaleDateString()}
          </p>
        </Card>
      </div>

      {/* Details */}
      <Card>
        <h3 className="text-sm font-semibold text-nav-dark mb-3">Bill Details</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-xs text-secondary">Bill Date</span>
            <p className="font-medium">{parseLocalDate(bill.bill_date).toLocaleDateString()}</p>
          </div>
          <div>
            <span className="text-xs text-secondary">Payment Terms</span>
            <p className="font-medium">{bill.payment_terms || '-'}</p>
          </div>
          <div>
            <span className="text-xs text-secondary">Linked PO</span>
            <p className="font-medium">
              {bill.po_number ? (
                <button
                  onClick={() => navigate(`/purchase-orders/${bill.purchase_order_id}`)}
                  className="text-crx-green hover:underline"
                >
                  {bill.po_number}
                </button>
              ) : (
                '-'
              )}
            </p>
          </div>
          {bill.adjustment_cents !== 0 && (
            <>
              <div>
                <span className="text-xs text-secondary">Subtotal</span>
                <p className="font-medium font-mono">{fmt(bill.subtotal_cents)}</p>
              </div>
              <div>
                <span className="text-xs text-secondary">Adjustment</span>
                <p className="font-medium font-mono">{fmt(bill.adjustment_cents)}</p>
              </div>
            </>
          )}
          {bill.notes && (
            <div className="col-span-full">
              <span className="text-xs text-secondary">Notes</span>
              <p className="font-medium">{bill.notes}</p>
            </div>
          )}
        </div>
      </Card>

      {/* Payment History */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-nav-dark flex items-center gap-2">
            <FileText className="w-4 h-4" /> Payment History
          </h3>
          <span className="text-xs text-secondary">{payments.length} payment{payments.length !== 1 ? 's' : ''}</span>
        </div>
        {payments.length > 0 ? (
          <DataTable<PaymentRow>
            columns={paymentColumns}
            data={payments}
            loading={false}
            emptyTitle="No payments"
            emptyDescription=""
          />
        ) : (
          <p className="text-sm text-secondary py-4 text-center">No payments recorded yet.</p>
        )}
      </Card>

      {/* Record Payment Modal */}
      <Modal
        open={payModalOpen}
        onClose={() => {
          if (!paymentIntent.isIntentLocked) {
            setPayModalOpen(false);
            setPayModalBillId(null);
          }
        }}
        title="Record Payment"
      >
        <div className="space-y-4">
          <div className="p-3 bg-gray-50 rounded-lg flex justify-between text-sm">
            <span className="text-secondary">Balance due:</span>
            <span className="font-semibold text-red-600">{fmt(bill.balance_cents)}</span>
          </div>

          {paymentIntent.isIntentLocked && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {paymentIntent.isForeignIntentLocked
                ? UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE
                : paymentIntent.isRetryExpired
                ? UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE
                : 'The last response was uncertain. These fields are locked so a second payment cannot be created. Retry this exact payment to reconcile it.'}
            </div>
          )}

          <Input
            label="Payment Amount ($) *"
            type="number"
            step="0.01"
            min="0.01"
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
            disabled={paymentIntent.isIntentLocked}
          />

          <Input
            label="Payment Date"
            type="date"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
            disabled={paymentIntent.isIntentLocked}
          />

          <div>
            <label htmlFor="vendor-payment-method" className="text-sm font-medium text-nav-dark">Payment Method</label>
            <select
              id="vendor-payment-method"
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value)}
              disabled={paymentIntent.isIntentLocked}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="check">Check</option>
              <option value="ach">ACH</option>
              <option value="wire">Wire</option>
              <option value="credit_card">Credit Card</option>
            </select>
          </div>

          <Input
            label="Reference # (check #, transaction ID)"
            value={payRef}
            onChange={(e) => setPayRef(e.target.value)}
            disabled={paymentIntent.isIntentLocked}
          />

          <Input
            label="Notes"
            value={payNotes}
            onChange={(e) => setPayNotes(e.target.value)}
            disabled={paymentIntent.isIntentLocked}
          />

          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="ghost"
              onClick={() => {
                setPayModalOpen(false);
                setPayModalBillId(null);
              }}
              disabled={paymentIntent.isIntentLocked}
            >
              Cancel
            </Button>
            <Button onClick={handleRecordPayment} loading={paying} disabled={paymentIntent.isForeignIntentLocked || paymentIntent.isRetryExpired}>
              {paymentIntent.isIntentLocked ? 'Retry Exact Payment' : 'Record Payment'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Bill Modal (PR-14, 2026-05-10) */}
      <Modal
        open={editModalOpen}
        onClose={() => {
          setEditModalOpen(false);
          setEditModalBillId(null);
        }}
        title="Edit Vendor Bill"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Editing <strong>#{bill.bill_number}</strong>. Only available for unpaid bills with no active payments.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Subtotal ($)"
              value={editSubtotal}
              onChange={(e) => setEditSubtotal(e.target.value)}
              placeholder="0.00"
            />
            <Input
              label="Adjustment ($, can be negative)"
              value={editAdjustment}
              onChange={(e) => setEditAdjustment(e.target.value)}
              placeholder="0.00"
            />
            <Input
              type="date"
              label="Bill Date"
              value={editBillDate}
              onChange={(e) => setEditBillDate(e.target.value)}
            />
            <Input
              type="date"
              label="Due Date"
              value={editDueDate}
              onChange={(e) => setEditDueDate(e.target.value)}
            />
          </div>
          <Input
            label="Notes"
            value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            placeholder="Optional"
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="ghost"
              onClick={() => {
                setEditModalOpen(false);
                setEditModalBillId(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleEditBill()} loading={editing}>Save Changes</Button>
          </div>
        </div>
      </Modal>

      <ReasonModal
        open={editOverageMessage !== null}
        onClose={() => setEditOverageMessage(null)}
        onConfirm={(reason) => {
          setEditOverageMessage(null);
          void handleEditBill(true, reason);
        }}
        title="Confirm PO billing overage"
        message={editOverageMessage || ''}
        confirmLabel="Save Changes"
        variant="warning"
        loading={editing}
        placeholder="Why should cumulative billing exceed the PO total?"
        minLength={5}
      />

      {/* Void Payment Modal (PR-13, 2026-05-10) */}
      <Modal
        open={voidPaymentTarget !== null}
        onClose={() => { setVoidPaymentTarget(null); setVoidPaymentReason(''); }}
        title="Void Vendor Payment"
      >
        <div className="space-y-4">
          {voidPaymentTarget && (
            <div className="text-sm space-y-1">
              <p>
                Voiding <strong>{fmt(voidPaymentTarget.amount_cents)}</strong>{' '}
                {voidPaymentTarget.payment_method ? `(${voidPaymentTarget.payment_method})` : ''}{' '}
                paid {new Date(voidPaymentTarget.payment_date + 'T00:00:00').toLocaleDateString()}.
              </p>
              <p className="text-secondary text-xs">
                The bill's paid total will be reduced by this amount and its status will be
                recalculated. The audit log will record this void.
              </p>
            </div>
          )}
          <Input
            label="Reason (required)"
            value={voidPaymentReason}
            onChange={(e) => setVoidPaymentReason(e.target.value)}
            placeholder="Why is this payment being voided?"
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => { setVoidPaymentTarget(null); setVoidPaymentReason(''); }}>
              Cancel
            </Button>
            <Button
              onClick={handleVoidPayment}
              loading={voidingPayment}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Void Payment
            </Button>
          </div>
        </div>
      </Modal>

      {/* Void Bill Modal */}
      <Modal
        open={voidModalOpen}
        onClose={() => {
          setVoidModalOpen(false);
          setVoidModalBillId(null);
        }}
        title="Void Bill"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Are you sure you want to void bill <strong>#{bill.bill_number}</strong>?
            This will mark the bill as voided and cannot be undone.
          </p>
          <Input
            label="Reason (optional)"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            placeholder="Why is this bill being voided?"
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="ghost"
              onClick={() => {
                setVoidModalOpen(false);
                setVoidModalBillId(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleVoid} loading={voiding} className="bg-red-600 hover:bg-red-700 text-white">
              Void Bill
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
