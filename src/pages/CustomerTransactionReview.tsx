/**
 * CustomerTransactionReview — Full per-customer transaction history with running balance
 *
 * Sprint 11: Financial Workflows
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DollarSign, Download, FileText } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import ReportShell from '../components/reports/ReportShell';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import type { CustomerTransactionRow } from '../types';

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function CustomerTransactionReview() {
  const { toast } = useToast();
  const [searchParams] = useSearchParams();

  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [customerId, setCustomerId] = useState(searchParams.get('customer') || '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [data, setData] = useState<CustomerTransactionRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name')
      .limit(500)
      .then(({ data: rows }) => setCustomers((rows || []) as { id: string; farm_name: string }[]))
      .catch(() => { /* non-critical: customer dropdown stays empty */ });
  }, []);

  useEffect(() => {
    if (customerId && startDate && endDate) fetchData();
  }, [customerId, startDate, endDate]);

  const fetchData = async () => {
    setLoading(true);
    const { data: rows, error } = await supabase.rpc('get_customer_transaction_review', {
      p_customer_id: customerId,
      p_start_date: startDate,
      p_end_date: endDate,
    });
    if (error) {
      toast('error', `Failed to load transactions: ${error.message}`);
    } else {
      setData((rows || []) as CustomerTransactionRow[]);
    }
    setLoading(false);
  };

  const customerName = customers.find((c) => c.id === customerId)?.farm_name || '';

  // Totals
  const totalDebits = data.reduce((s, r) => s + (r.debit_cents || 0), 0);
  const totalCredits = data.reduce((s, r) => s + (r.credit_cents || 0), 0);
  const endingBalance = data.length > 0 ? data[data.length - 1].running_balance_cents : 0;

  const handleCSV = () => {
    exportToCSV(data as unknown as Record<string, unknown>[], [
      { key: 'transaction_date', header: 'Date', format: fmtDateCSV },
      { key: 'transaction_type', header: 'Type' },
      { key: 'reference_number', header: 'Reference' },
      { key: 'description', header: 'Description' },
      { key: 'debit_cents', header: 'Debit', format: (v) => ((v as number) / 100).toFixed(2) },
      { key: 'credit_cents', header: 'Credit', format: (v) => ((v as number) / 100).toFixed(2) },
      { key: 'running_balance_cents', header: 'Balance', format: (v) => ((v as number) / 100).toFixed(2) },
    ], `transactions_${customerName.replace(/\s+/g, '_')}`);
    toast('success', 'Transactions exported to CSV');
  };

  const handlePDF = async () => {
    const pdfCols: ReportPdfColumn[] = [
      { header: 'Date', key: 'transaction_date' },
      { header: 'Type', key: 'transaction_type' },
      { header: 'Reference', key: 'reference_number' },
      { header: 'Description', key: 'description' },
      { header: 'Debit', key: 'debit_cents', align: 'right', format: (v) => (v as number) > 0 ? fmt(v as number) : '' },
      { header: 'Credit', key: 'credit_cents', align: 'right', format: (v) => (v as number) > 0 ? fmt(v as number) : '' },
      { header: 'Balance', key: 'running_balance_cents', align: 'right', format: (v) => fmt(v as number) },
    ];

    await downloadReportPdf({
      title: 'Customer Transaction Review',
      subtitle: customerName,
      dateRange: startDate ? { start: startDate, end: endDate } : undefined,
      columns: pdfCols,
      data: data as unknown as Record<string, unknown>[],
      orientation: 'landscape',
      footerNote: `${data.length} transactions  •  Total Debits: ${fmt(totalDebits)}  •  Total Credits: ${fmt(totalCredits)}  •  Ending Balance: ${fmt(endingBalance)}`,
    });
    toast('success', 'Transaction review PDF generated');
  };

  const columns: Column<CustomerTransactionRow>[] = [
    {
      key: 'transaction_date',
      header: 'Date',
      sortable: true,
      render: (r) => new Date(r.transaction_date + 'T00:00:00').toLocaleDateString(),
    },
    {
      key: 'transaction_type',
      header: 'Type',
      sortable: true,
      render: (r) => {
        const variant = r.transaction_type === 'Invoice' ? 'warning' : r.transaction_type === 'Payment' ? 'success' : 'info';
        return <Badge variant={variant}>{r.transaction_type}</Badge>;
      },
    },
    { key: 'reference_number', header: 'Reference', render: (r) => r.reference_number || '-' },
    { key: 'description', header: 'Description', render: (r) => <span className="text-sm">{r.description || '-'}</span> },
    {
      key: 'debit_cents',
      header: 'Debit',
      sortable: true,
      render: (r) => r.debit_cents > 0 ? <span className="text-red-600">{fmt(r.debit_cents)}</span> : '-',
    },
    {
      key: 'credit_cents',
      header: 'Credit',
      sortable: true,
      render: (r) => r.credit_cents > 0 ? <span className="text-crx-green">{fmt(r.credit_cents)}</span> : '-',
    },
    {
      key: 'running_balance_cents',
      header: 'Balance',
      render: (r) => (
        <span className={`font-medium ${r.running_balance_cents > 0 ? 'text-red-600' : 'text-crx-green'}`}>
          {fmt(r.running_balance_cents)}
        </span>
      ),
    },
  ];

  const handleDateChange = (s: string, e: string) => {
    setStartDate(s);
    setEndDate(e);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold font-heading text-nav-dark">Customer Transaction Review</h1>

      <ReportShell
        onDateChange={handleDateChange}
        onExportCSV={data.length > 0 ? handleCSV : undefined}
        onExportPDF={data.length > 0 ? handlePDF : undefined}
        extraControls={
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              aria-label="Select customer"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[200px]"
            >
              <option value="">— Select Customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>
        }
      >
        {/* Summary bar */}
        {data.length > 0 && (
          <div className="flex gap-4 flex-wrap">
            <Card className="flex-1 min-w-[150px]">
              <div className="text-xs text-secondary">Total Debits</div>
              <div className="text-lg font-semibold text-red-600">{fmt(totalDebits)}</div>
            </Card>
            <Card className="flex-1 min-w-[150px]">
              <div className="text-xs text-secondary">Total Credits</div>
              <div className="text-lg font-semibold text-crx-green">{fmt(totalCredits)}</div>
            </Card>
            <Card className="flex-1 min-w-[150px]">
              <div className="text-xs text-secondary">Ending Balance</div>
              <div className={`text-lg font-semibold ${endingBalance > 0 ? 'text-red-600' : 'text-crx-green'}`}>
                {fmt(endingBalance)}
              </div>
            </Card>
          </div>
        )}

        <Card padding={false}>
          <div className="p-5">
            <DataTable
              data={data as unknown as Record<string, unknown>[]}
              columns={columns as unknown as Column<Record<string, unknown>>[]}
              emptyTitle="No transactions"
              emptyDescription={!customerId ? 'Select a customer and date range' : undefined}
              loading={loading}
            />
          </div>
        </Card>
      </ReportShell>
    </div>
  );
}
