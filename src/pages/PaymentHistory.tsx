/**
 * PaymentHistory — View and void past payment allocations
 *
 * Sprint 11: Financial Workflows
 */
import { useEffect, useState, useCallback } from 'react';
import { DollarSign, XCircle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import DataTable, { type Column } from '../components/ui/DataTable';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { exportToCSV } from '../lib/csvExport';

interface AllocationSet {
  [k: string]: unknown;
  id: string;
  customer_id: string;
  farm_name: string;
  total_payment_cents: number;
  total_allocated_cents: number;
  payment_method: string | null;
  check_number: string | null;
  reference_number: string | null;
  payment_date: string | null;
  season: number | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

interface InvoiceAllocation {
  id: string;
  invoice_id: string | null;
  invoice_number?: string;
  amount_cents: number;
  split_percentage: number;
  bill_to_customer_id: string;
  bill_to_farm_name?: string;
}

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function PaymentHistory() {
  const { profile } = useAuth();
  const { toast } = useToast();

  const [payments, setPayments] = useState<AllocationSet[]>([]);
  const [loading, setLoading] = useState(true);

  // Expanded row
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [allocations, setAllocations] = useState<InvoiceAllocation[]>([]);
  const [loadingAllocs, setLoadingAllocs] = useState(false);

  // Void modal
  const [voidPayment, setVoidPayment] = useState<AllocationSet | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [savingVoid, setSavingVoid] = useState(false);

  const fetchPayments = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('allocation_sets')
      .select(`
        id, customer_id, total_payment_cents, total_allocated_cents,
        payment_method, check_number, reference_number, payment_date,
        season, is_active, notes, created_at,
        customers!allocation_sets_customer_id_fkey ( farm_name )
      `)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      toast('error', 'Failed to load payment history');
      setLoading(false);
      return;
    }

    const mapped: AllocationSet[] = (data || []).map((row: Record<string, unknown>) => ({
      ...(row as AllocationSet),
      farm_name: (row.customers as { farm_name: string } | null)?.farm_name || 'Unknown',
    }));

    setPayments(mapped);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  // Fetch allocations for expanded row
  const fetchAllocations = useCallback(async (setId: string) => {
    setLoadingAllocs(true);
    const { data, error } = await supabase
      .from('invoice_line_allocations')
      .select(`
        id, invoice_id, amount_cents, split_percentage, bill_to_customer_id,
        invoices ( invoice_number ),
        customers!invoice_line_allocations_bill_to_customer_id_fkey ( farm_name )
      `)
      .eq('allocation_set_id', setId)
      .order('created_at');

    if (error) {
      toast('error', 'Failed to load allocations');
    } else {
      const mapped: InvoiceAllocation[] = (data || []).map((row: Record<string, unknown>) => ({
        ...(row as unknown as InvoiceAllocation),
        invoice_number: (row.invoices as { invoice_number: string } | null)?.invoice_number || '—',
        bill_to_farm_name: (row.customers as { farm_name: string } | null)?.farm_name || 'Unknown',
      }));
      setAllocations(mapped);
    }
    setLoadingAllocs(false);
  }, [toast]);

  const toggleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setAllocations([]);
    } else {
      setExpandedId(id);
      fetchAllocations(id);
    }
  };

  // Void payment
  const openVoid = (payment: AllocationSet) => {
    setVoidPayment(payment);
    setVoidReason('');
  };

  const handleVoid = async () => {
    if (!voidPayment || !voidReason.trim()) {
      toast('error', 'A reason is required to void a payment');
      return;
    }

    await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('void_payment', {
          p_allocation_set_id: voidPayment.id,
          p_reason: voidReason.trim(),
          p_performed_by: profile?.id,
        });
        if (error) throw error;
        const result = data as { success: boolean; reversed_cents: number; invoices_affected: number };
        if (!result?.success) throw new Error('Void failed');
      },
      toast,
      setLoading: setSavingVoid,
      successMessage: `Voided payment ${voidPayment.check_number || voidPayment.reference_number || voidPayment.id.slice(0, 8)} (${fmt(voidPayment.total_payment_cents)})`,
      sentryTag: 'void_payment',
      onSuccess: () => {
        setVoidPayment(null);
        fetchPayments();
      },
    });
  };

  const totalPayments = payments.filter((p) => p.is_active).reduce((s, p) => s + (p.total_payment_cents || 0), 0);
  const activeCount = payments.filter((p) => p.is_active).length;
  const voidedCount = payments.filter((p) => !p.is_active).length;

  const columns: Column<AllocationSet>[] = [
    {
      key: 'payment_date',
      header: 'Date',
      sortable: true,
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); toggleExpand(r.id); }}
          className="flex items-center gap-2 text-nav-dark hover:text-crx-green transition-colors text-left"
        >
          {expandedId === r.id ? <ChevronUp className="w-4 h-4 text-secondary" /> : <ChevronDown className="w-4 h-4 text-secondary" />}
          <span className="font-medium">
            {r.payment_date ? new Date(r.payment_date + 'T00:00:00').toLocaleDateString() : new Date(r.created_at).toLocaleDateString()}
          </span>
        </button>
      ),
    },
    { key: 'farm_name', header: 'Customer', sortable: true, render: (r) => <span className="font-medium">{r.farm_name}</span> },
    { key: 'payment_method', header: 'Method', render: (r) => <span className="capitalize">{r.payment_method || '—'}</span> },
    { key: 'check_number', header: 'Check #', render: (r) => r.check_number || r.reference_number || '—' },
    {
      key: 'total_payment_cents',
      header: 'Total',
      sortable: true,
      render: (r) => <span className="font-medium">{fmt(r.total_payment_cents || 0)}</span>,
    },
    {
      key: 'total_allocated_cents',
      header: 'Allocated',
      render: (r) => <span>{fmt(r.total_allocated_cents || 0)}</span>,
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (r) => r.is_active
        ? <Badge variant="success">Active</Badge>
        : <Badge variant="danger">Voided</Badge>,
    },
    {
      key: 'id',
      header: '',
      render: (r) => (
        r.is_active && profile?.role === 'admin' ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<XCircle className="w-3 h-3" />}
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); openVoid(r); }}
            showChevron={false}
            className="text-red-600 hover:bg-red-50"
          >
            Void
          </Button>
        ) : null
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Payment History</h2>
          <p className="text-sm text-secondary mt-1">View past payments and void incorrect entries</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="w-4 h-4" />}
            onClick={fetchPayments}
            showChevron={false}
          >
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              exportToCSV(
                payments as unknown as Record<string, unknown>[],
                [
                  { key: 'payment_date', header: 'Date' },
                  { key: 'farm_name', header: 'Customer' },
                  { key: 'payment_method', header: 'Method' },
                  { key: 'check_number', header: 'Check #' },
                  { key: 'total_payment_cents', header: 'Total (cents)' },
                  { key: 'total_allocated_cents', header: 'Allocated (cents)' },
                  { key: 'is_active', header: 'Active' },
                ],
                'payment-history',
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
            <span className="text-sm text-secondary">Active Payments</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmt(totalPayments)}</p>
          <p className="text-xs text-secondary mt-1">{activeCount} payment(s)</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Total Payments</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-blue-600">{payments.length}</p>
          <p className="text-xs text-secondary mt-1">all time</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-secondary">Voided Payments</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-600">{voidedCount}</p>
          <p className="text-xs text-secondary mt-1">reversed</p>
        </Card>
      </div>

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={payments as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search payments..."
            searchKeys={['farm_name', 'check_number', 'reference_number', 'payment_method']}
            emptyTitle="No payments yet"
            emptyDescription="Payment allocations will appear here after you record payments"
            loading={loading}
          />

          {/* Expanded allocations for selected payment */}
          {expandedId && (
            <div className="mt-4 border-t border-gray-100 pt-4">
              <h3 className="text-sm font-semibold text-nav-dark mb-3">Invoice Allocations</h3>
              {loadingAllocs ? (
                <p className="text-sm text-secondary py-4 text-center">Loading allocations...</p>
              ) : allocations.length === 0 ? (
                <p className="text-sm text-secondary py-4 text-center">No invoice allocations for this payment</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-2 px-3 text-secondary font-medium">Invoice #</th>
                        <th className="text-left py-2 px-3 text-secondary font-medium">Bill-To Customer</th>
                        <th className="text-right py-2 px-3 text-secondary font-medium">Amount</th>
                        <th className="text-right py-2 px-3 text-secondary font-medium">Split %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocations.map((a) => (
                        <tr key={a.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                          <td className="py-2 px-3 font-medium">{a.invoice_number || '—'}</td>
                          <td className="py-2 px-3">{a.bill_to_farm_name || '—'}</td>
                          <td className="py-2 px-3 text-right font-medium">{fmt(a.amount_cents)}</td>
                          <td className="py-2 px-3 text-right text-secondary">{Number(a.split_percentage).toFixed(1)}%</td>
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

      {/* Void Payment Modal */}
      <Modal open={!!voidPayment} onClose={() => setVoidPayment(null)} title="Void Payment">
        {voidPayment && (
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Voiding will reverse all invoice allocations and mark this payment as inactive.
              This action cannot be undone — to correct the payment, void it and re-enter.
            </p>
            <div className="bg-red-50 p-3 rounded-lg text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-secondary">Customer</span>
                <span className="font-medium">{voidPayment.farm_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-secondary">Check/Ref</span>
                <span className="font-medium">{voidPayment.check_number || voidPayment.reference_number || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-secondary">Total Payment</span>
                <span className="font-medium text-red-600">{fmt(voidPayment.total_payment_cents || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-secondary">Allocated</span>
                <span>{fmt(voidPayment.total_allocated_cents || 0)}</span>
              </div>
            </div>
            <Input
              label="Reason *"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Why is this payment being voided?"
              required
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setVoidPayment(null)}>Cancel</Button>
              <Button
                onClick={handleVoid}
                loading={savingVoid}
                icon={<XCircle className="w-4 h-4" />}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                Void Payment
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
