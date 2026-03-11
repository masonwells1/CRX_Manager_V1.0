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
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import { sanitizeError } from '../lib/errorSanitizer';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useAuth } from '../contexts/AuthContext';
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

  const [bill, setBill] = useState<(VendorBill & { vendor_name: string; po_number: string | null }) | null>(null);
  const [payments, setPayments] = useState<(VendorPayment & { creator_name: string })[]>([]);
  const [loading, setLoading] = useState(true);

  // Payment modal
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);
  const [payNotes, setPayNotes] = useState('');
  const [paying, setPaying] = useState(false);

  // Void
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  const today = new Date().toISOString().split('T')[0];

  const fmt = (cents: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

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
    const { data: payData } = await supabase
      .from('vendor_payments')
      .select('*, creator:profiles!vendor_payments_created_by_fkey(full_name)')
      .eq('vendor_bill_id', id)
      .order('payment_date', { ascending: false });

    const mappedPayments = ((payData || []) as Array<Record<string, unknown>>).map((p) => ({
      ...p,
      creator_name: (p.creator as { full_name?: string } | null)?.full_name || 'System',
    })) as unknown as (VendorPayment & { creator_name: string })[];

    setPayments(mappedPayments);
    setLoading(false);
  }, [id, toast, navigate]);

  useEffect(() => {
    fetchBill();
  }, [fetchBill]);

  const handleRecordPayment = async () => {
    if (!id) return;
    const amountCents = Math.round(Number(payAmount) * 100);
    if (amountCents <= 0) { toast('error', 'Enter a valid payment amount'); return; }

    setPaying(true);
    try {
      const payKey = paymentIdem.getKey();
      const { error } = await supabase.rpc('record_vendor_payment', {
        p_vendor_bill_id: id,
        p_payment_date: payDate,
        p_amount_cents: amountCents,
        p_payment_method: payMethod || null,
        p_reference_number: payRef || null,
        p_notes: payNotes || null,
        p_idempotency_key: payKey,
      });
      if (error) throw error;
      paymentIdem.resetKey();

      toast('success', `Payment of ${fmt(amountCents)} recorded`);
      setPayModalOpen(false);
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      fetchBill();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setPaying(false);
  };

  const handleVoid = async () => {
    if (!id) return;
    setVoiding(true);
    try {
      const voidKey = voidIdem.getKey();
      const { error } = await supabase.rpc('void_vendor_bill', {
        p_vendor_bill_id: id,
        p_reason: voidReason || null,
        p_idempotency_key: voidKey,
      });
      if (error) throw error;
      voidIdem.resetKey();

      toast('success', 'Bill voided');
      setVoidModalOpen(false);
      fetchBill();
    } catch (err) {
      toast('error', sanitizeError(err));
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
          {bill.status !== 'paid' && bill.status !== 'voided' && (
            <>
              <Button
                icon={<CreditCard className="w-4 h-4" />}
                onClick={() => {
                  setPayAmount((bill.balance_cents / 100).toFixed(2));
                  setPayModalOpen(true);
                }}
              >
                Record Payment
              </Button>
              <Button
                variant="ghost"
                icon={<XCircle className="w-4 h-4" />}
                onClick={() => setVoidModalOpen(true)}
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
            <p className="font-medium">{new Date(bill.bill_date).toLocaleDateString()}</p>
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

      {/* Void Modal */}
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
