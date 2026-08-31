/**
 * VendorBillDetail.tsx — View a vendor bill + record payments
 *
 * Shows bill info, linked PO, payment history, and "Record Payment" modal.
 * Uses record_vendor_payment() and void_vendor_bill() RPCs. Admin-only.
 */
import { useEffect, useState, useCallback } from 'react';
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
import { useAuth } from '../contexts/AuthContext';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import { parseDollarsToCents, parseDollarsToCentsSigned } from '../lib/parseCents';
import { formatCents as fmt } from '../lib/money';
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
  const paymentIdem = useIdempotencyKey('record_vendor_payment', profile?.id || '');
  const voidIdem = useIdempotencyKey('void_vendor_bill', profile?.id || '');
  const voidPaymentIdem = useIdempotencyKey('void_vendor_payment', profile?.id || '');

  const [bill, setBill] = useState<(VendorBill & { vendor_name: string; po_number: string | null }) | null>(null);
  const [payments, setPayments] = useState<(VendorPayment & { creator_name: string })[]>([]);
  const [loading, setLoading] = useState(true);

  // Payment modal
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(localToday());
  const [payNotes, setPayNotes] = useState('');
  const [paying, setPaying] = useState(false);

  // Void bill
  const [voidModalOpen, setVoidModalOpen] = useState(false);
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
  const [editSubtotal, setEditSubtotal] = useState('');
  const [editAdjustment, setEditAdjustment] = useState('');
  const [editBillDate, setEditBillDate] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editing, setEditing] = useState(false);
  const [editOverageMessage, setEditOverageMessage] = useState<string | null>(null);

  const today = localToday();

  const fetchBill = useCallback(async () => {
    if (!id) return;
    setLoading(true);

    const { data, error } = await supabase
      .from('vendor_bills')
      .select('*, vendor:vendors(name), purchase_order:purchase_orders(po_number)')
      .eq('id', id)
      .single();

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

    setPayments(mappedPayments);
    setLoading(false);
  }, [id, toast, navigate]);

  useEffect(() => {
    fetchBill();
  }, [fetchBill]);

  const handleRecordPayment = async () => {
    if (!id) return;
    const amountCents = parseDollarsToCents(payAmount);
    if (amountCents <= 0) { toast('error', 'Enter a valid payment amount'); return; }

    setPaying(true);
    try {
      const payKey = paymentIdem.getKey();
      const { data, error } = await supabase.rpc('record_vendor_payment', {
        p_vendor_bill_id: id,
        p_payment_date: payDate,
        p_amount_cents: amountCents,
        p_payment_method: payMethod || undefined,
        p_reference_number: payRef || undefined,
        p_notes: payNotes || undefined,
        p_idempotency_key: payKey,
      });
      if (error) throw error;
      assertRpcResult<string>(data, 'record_vendor_payment');
      paymentIdem.resetKey();

      toast('success', `Payment of ${fmt(amountCents)} recorded`);
      setPayModalOpen(false);
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      fetchBill();
    } catch (err) {
      if (getIdempotencyBindingRejection(err)) {
        paymentIdem.resetKey();
        toast('warning', 'That retry belongs to a different payment request. Your current payment was not recorded; retry to submit it with a fresh key.');
      } else {
        toast('error', sanitizeError(err));
      }
    }
    setPaying(false);
  };

  const openEditModal = () => {
    // Codex P2 fix (PR #59, 2026-05-16): reset editIdem on every open. The
    // bill payload (subtotal/adjustment/dates/notes) is user-editable; if
    // update_vendor_bill succeeded but response was lost, reopening the modal
    // and changing fields would replay prior result without applying edits.
    editIdem.resetKey();
    if (!bill) return;
    setEditSubtotal((bill.subtotal_cents / 100).toFixed(2));
    setEditAdjustment(((bill.adjustment_cents || 0) / 100).toFixed(2));
    setEditBillDate(bill.bill_date);
    setEditDueDate(bill.due_date);
    setEditNotes(bill.notes || '');
    setEditModalOpen(true);
  };

  const handleEditBill = async (confirmPoOverage = false, poOverageReason = '') => {
    if (!bill) return;
    const subtotalCents = parseDollarsToCents(editSubtotal);
    if (subtotalCents <= 0) {
      toast('error', 'Subtotal must be positive');
      return;
    }
    // adjustment_cents intentionally negative-capable — user may enter "-10" to subtract
    const adjustmentCents = parseDollarsToCentsSigned(editAdjustment);
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
    if (!voidPaymentTarget) return;
    if (!voidPaymentReason.trim()) {
      toast('error', 'Please provide a reason for voiding this payment');
      return;
    }
    setVoidingPayment(true);
    try {
      const key = voidPaymentIdem.getKey();
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
      voidPaymentIdem.resetKey();
      toast('success', 'Payment voided');
      setVoidPaymentTarget(null);
      setVoidPaymentReason('');
      fetchBill();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setVoidingPayment(false);
  };

  const handleVoid = async () => {
    if (!id) return;
    setVoiding(true);
    try {
      const voidKey = voidIdem.getKey();
      // RETURNS void — use .throwOnError() (regex coverage skips fire-and-forget).
      await supabase.rpc('void_vendor_bill', {
        p_vendor_bill_id: id,
        p_reason: voidReason || undefined,
        p_idempotency_key: voidKey,
      }).throwOnError();
      voidIdem.resetKey();

      toast('success', 'Bill voided');
      setVoidModalOpen(false);
      fetchBill();
    } catch (err) {
      if (getIdempotencyBindingRejection(err)) {
        voidIdem.resetKey();
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
              // Codex P2 fix: reset per-payment void key when target changes.
              voidPaymentIdem.resetKey();
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
                  // Codex P2 fix: reset payment key per record-payment open.
                  paymentIdem.resetKey();
                  setPayAmount((bill.balance_cents / 100).toFixed(2));
                  setPayModalOpen(true);
                }}
              >
                Record Payment
              </Button>
              <Button
                variant="ghost"
                icon={<XCircle className="w-4 h-4" />}
                onClick={() => { voidIdem.resetKey(); setVoidModalOpen(true); }}
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
      <Modal open={payModalOpen} onClose={() => setPayModalOpen(false)} title="Record Payment">
        <div className="space-y-4">
          <div className="p-3 bg-gray-50 rounded-lg flex justify-between text-sm">
            <span className="text-secondary">Balance due:</span>
            <span className="font-semibold text-red-600">{fmt(bill.balance_cents)}</span>
          </div>

          <Input
            label="Payment Amount ($) *"
            type="number"
            step="0.01"
            min="0.01"
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
          />

          <Input
            label="Payment Date"
            type="date"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
          />

          <div>
            <label className="text-sm font-medium text-nav-dark">Payment Method</label>
            <select
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value)}
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
          />

          <Input
            label="Notes"
            value={payNotes}
            onChange={(e) => setPayNotes(e.target.value)}
          />

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setPayModalOpen(false)}>Cancel</Button>
            <Button onClick={handleRecordPayment} loading={paying}>Record Payment</Button>
          </div>
        </div>
      </Modal>

      {/* Edit Bill Modal (PR-14, 2026-05-10) */}
      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit Vendor Bill">
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
            <Button variant="ghost" onClick={() => setEditModalOpen(false)}>Cancel</Button>
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
      <Modal open={voidModalOpen} onClose={() => setVoidModalOpen(false)} title="Void Bill">
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
            <Button variant="ghost" onClick={() => setVoidModalOpen(false)}>Cancel</Button>
            <Button onClick={handleVoid} loading={voiding} className="bg-red-600 hover:bg-red-700 text-white">
              Void Bill
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
