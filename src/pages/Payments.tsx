/**
 * Payments.tsx — Track payments received against orders
 * GAP FIX #2: Payment Tracking & Accounts Receivable
 *
 * The "payments" table was created in the SQL migration.
 * This page lets admins record payments, see balances, and view A/R.
 */
import { useEffect, useState } from 'react';
import { DollarSign, Plus, Search } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { generateIdempotencyKey } from '../lib/idempotency';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { exportToCSV } from '../lib/csvExport';

interface OrderWithBalance {
  id: string;
  order_number: string;
  customer_id: string;
  farm_name: string;
  total_price: number;
  total_paid: number;
  balance_due: number;
  order_date: string;
  status: string;
}

interface Payment {
  id: string;
  order_id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  reference_number: string;
  notes: string;
  recorded_by: string;
  created_at: string;
  order_number?: string;
  farm_name?: string;
}

export default function Payments() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<'ar' | 'history'>('ar');
  const [arData, setArData] = useState<OrderWithBalance[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Record payment modal
  const [payOpen, setPayOpen] = useState(false);
  const [payOrderId, setPayOrderId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);

    // Fetch orders with customer names
    const { data: orders } = await supabase
      .from('orders')
      .select('id, order_number, customer_id, total_price, total_paid, balance_due, order_date, status, customer:customers(farm_name)')
      .order('order_date', { ascending: false });

    const mapped = ((orders || []) as any[]).map((o) => ({
      id: o.id,
      order_number: o.order_number,
      customer_id: o.customer_id,
      farm_name: o.customer?.farm_name || 'Unknown',
      total_price: Number(o.total_price) || 0,
      total_paid: Number(o.total_paid) || 0,
      balance_due: Number(o.balance_due) ?? (Number(o.total_price) - Number(o.total_paid || 0)),
      order_date: o.order_date,
      status: o.status,
    }));
    setArData(mapped);

    // Fetch payment history
    const { data: payData } = await supabase
      .from('payments')
      .select('*, order:orders(order_number, customer:customers(farm_name))')
      .order('payment_date', { ascending: false })
      .limit(200);

    const payMapped = ((payData || []) as any[]).map((p) => ({
      ...p,
      order_number: p.order?.order_number || '',
      farm_name: p.order?.customer?.farm_name || '',
    }));
    setPayments(payMapped);
    setLoading(false);
  };

  const handleRecordPayment = async () => {
    if (!payOrderId || !payAmount || Number(payAmount) <= 0) {
      toast('error', 'Select an order and enter a valid amount');
      return;
    }
    if (!profile) return;
    setSaving(true);

    try {
      // Atomic RPC with idempotency: payment + order balance update in one transaction
      const idemKey = generateIdempotencyKey('record_payment', profile.id);
      const { error } = await supabase.rpc('record_payment', {
        p_order_id: payOrderId,
        p_amount: Number(payAmount),
        p_payment_method: payMethod,
        p_reference_number: payRef || null,
        p_notes: payNotes || null,
        p_recorded_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;

      toast('success', `Payment of ${fmt(Number(payAmount))} recorded`);
      setPayOpen(false);
      setPayOrderId('');
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      setPayMethod('check');
      fetchData();
    } catch (error: any) {
      console.error('Error recording payment:', error);
      toast('error', error.message || 'Failed to record payment');
    }
    setSaving(false);
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const openAr = arData.filter((o) => o.balance_due > 0);
  const totalAr = openAr.reduce((s, o) => s + o.balance_due, 0);
  const totalReceived = payments.reduce((s, p) => s + Number(p.amount), 0);

  const filteredAr = search
    ? arData.filter(
        (o) =>
          o.farm_name.toLowerCase().includes(search.toLowerCase()) ||
          o.order_number.toLowerCase().includes(search.toLowerCase())
      )
    : arData;

  const filteredPayments = search
    ? payments.filter(
        (p) =>
          (p.farm_name || '').toLowerCase().includes(search.toLowerCase()) ||
          (p.order_number || '').toLowerCase().includes(search.toLowerCase()) ||
          (p.reference_number || '').toLowerCase().includes(search.toLowerCase())
      )
    : payments;

  const arColumns: Column<OrderWithBalance>[] = [
    { key: 'order_number', header: 'Order' },
    { key: 'farm_name', header: 'Customer' },
    { key: 'order_date', header: 'Date', render: (r) => new Date(r.order_date).toLocaleDateString() },
    { key: 'total_price', header: 'Total', render: (r) => fmt(r.total_price) },
    { key: 'total_paid', header: 'Paid', render: (r) => <span className="text-crx-green">{fmt(r.total_paid)}</span> },
    {
      key: 'balance_due',
      header: 'Balance',
      render: (r) => (
        <span className={r.balance_due > 0 ? 'text-red-600 font-semibold' : 'text-crx-green'}>
          {fmt(r.balance_due)}
        </span>
      ),
    },
    {
      key: 'id',
      header: '',
      render: (r) =>
        r.balance_due > 0 ? (
          <Button
            size="sm"
            variant="primary"
            onClick={(e) => {
              e.stopPropagation();
              setPayOrderId(r.id);
              setPayAmount(String(r.balance_due));
              setPayOpen(true);
            }}
          >
            Record Payment
          </Button>
        ) : (
          <Badge variant="success">Paid</Badge>
        ),
    },
  ];

  const payColumns: Column<Payment>[] = [
    { key: 'payment_date', header: 'Date', render: (r) => new Date(r.payment_date).toLocaleDateString() },
    { key: 'order_number', header: 'Order', render: (r) => r.order_number || '-' },
    { key: 'farm_name', header: 'Customer', render: (r) => r.farm_name || '-' },
    { key: 'amount', header: 'Amount', render: (r) => <span className="text-crx-green font-semibold">{fmt(r.amount)}</span> },
    { key: 'payment_method', header: 'Method', render: (r) => <Badge variant="default">{r.payment_method}</Badge> },
    { key: 'reference_number', header: 'Ref #', render: (r) => r.reference_number || '-' },
    { key: 'notes', header: 'Notes', render: (r) => r.notes || '-' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Payments & A/R</h1>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              exportToCSV(
                tab === 'ar'
                  ? filteredAr.map((r) => ({
                      Order: r.order_number,
                      Customer: r.farm_name,
                      Date: r.order_date,
                      Total: r.total_price,
                      Paid: r.total_paid,
                      Balance: r.balance_due,
                    }))
                  : filteredPayments.map((r) => ({
                      Date: r.payment_date,
                      Order: r.order_number,
                      Customer: r.farm_name,
                      Amount: r.amount,
                      Method: r.payment_method,
                      Ref: r.reference_number,
                      Notes: r.notes,
                    })),
                tab === 'ar' ? 'accounts_receivable.csv' : 'payment_history.csv'
              )
            }
          >
            Export CSV
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setPayOpen(true)}>
            Record Payment
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-secondary">Outstanding A/R</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-600">{fmt(totalAr)}</p>
          <p className="text-xs text-secondary mt-1">{openAr.length} unpaid orders</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Total Received</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(totalReceived)}</p>
          <p className="text-xs text-secondary mt-1">{payments.length} payments</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Total Orders</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(arData.reduce((s, o) => s + o.total_price, 0))}</p>
          <p className="text-xs text-secondary mt-1">{arData.length} orders</p>
        </Card>
      </div>

      {/* Tabs + Search */}
      <div className="flex items-center gap-4">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(['ar', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                tab === t ? 'bg-white text-nav-dark shadow-sm font-medium' : 'text-secondary hover:text-nav-dark'
              }`}
            >
              {t === 'ar' ? 'Accounts Receivable' : 'Payment History'}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
          />
        </div>
      </div>

      {/* Data Tables */}
      {tab === 'ar' && (
        <DataTable<OrderWithBalance>
          columns={arColumns}
          data={filteredAr}
          loading={loading}
          emptyMessage="No orders found"
        />
      )}
      {tab === 'history' && (
        <DataTable<Payment>
          columns={payColumns}
          data={filteredPayments}
          loading={loading}
          emptyMessage="No payments recorded yet"
        />
      )}

      {/* Record Payment Modal */}
      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Record Payment">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-nav-dark">Order</label>
            <select
              value={payOrderId}
              onChange={(e) => {
                setPayOrderId(e.target.value);
                const order = arData.find((o) => o.id === e.target.value);
                if (order) setPayAmount(String(order.balance_due));
              }}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select order...</option>
              {arData
                .filter((o) => o.balance_due > 0)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.order_number} — {o.farm_name} — Balance: {fmt(o.balance_due)}
                  </option>
                ))}
            </select>
          </div>
          <Input label="Amount" type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
          <div>
            <label className="text-sm font-medium text-nav-dark">Payment Method</label>
            <select
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="check">Check</option>
              <option value="cash">Cash</option>
              <option value="wire">Wire Transfer</option>
              <option value="ach">ACH</option>
              <option value="credit_card">Credit Card</option>
              <option value="other">Other</option>
            </select>
          </div>
          <Input label="Reference # (optional)" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
          <Input label="Notes (optional)" value={payNotes} onChange={(e) => setPayNotes(e.target.value)} />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setPayOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRecordPayment} loading={saving}>
              Record Payment
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
