/**
 * AccountsPayable.tsx — AP Dashboard
 *
 * Shows summary cards (Total Owed, Due This Week, Due This Month, Overdue),
 * AP aging buckets, and a vendor breakdown. Admin-only.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { DollarSign, Clock, AlertTriangle, FileText, Plus } from 'lucide-react';
import Card from '../components/ui/Card';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { supabase, assertRpcResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { exportToCSV, fmtCSV } from '../lib/csvExport';
import { localToday } from '../lib/dateUtils';
import { formatCents as fmt } from '../lib/money';
import type { APAgingRow, APDashboardSummary } from '../types';

export default function AccountsPayable() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<APDashboardSummary | null>(null);
  const [agingData, setAgingData] = useState<APAgingRow[]>([]);
  const [asOfDate, setAsOfDate] = useState(localToday());

  // Audit #35: split the dashboard fetch into two so changing the as-of-date
  // only re-runs the aging query (which depends on it). The summary query is
  // current-state and only needs to fire on mount.
  const fetchSummary = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_ap_dashboard_summary');
    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to load AP summary');
      return;
    }
    setSummary(assertRpcResult<APDashboardSummary>(data, 'get_ap_dashboard_summary'));
  }, [toast]);

  const fetchAging = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_ap_aging', { p_as_of_date: asOfDate });
    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to load AP aging data');
      return;
    }
    setAgingData(assertRpcResult<APAgingRow[]>(data, 'get_ap_aging'));
  }, [asOfDate, toast]);

  // Initial load: both queries fire in parallel, drop loading state when both settle.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchSummary(), fetchAging()]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // asOfDate changes only re-run the aging query (summary doesn't depend on it).
  // Skip the initial render — the mount effect above already fetched aging.
  const isInitialDateRef = useRef(true);
  useEffect(() => {
    if (isInitialDateRef.current) {
      isInitialDateRef.current = false;
      return;
    }
    fetchAging();
  }, [asOfDate, fetchAging]);

  const agingTotals = agingData.reduce(
    (acc, r) => ({
      current: acc.current + r.current_amount,
      d31_60: acc.d31_60 + r.days_31_60,
      d61_90: acc.d61_90 + r.days_61_90,
      over90: acc.over90 + r.over_90,
      total: acc.total + r.total_outstanding,
    }),
    { current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 }
  );

  const agingColumns: Column<APAgingRow>[] = [
    {
      key: 'vendor_name',
      header: 'Vendor',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.vendor_name}</span>,
    },
    {
      key: 'current_amount',
      header: 'Current',
      sortable: true,
      render: (r) => <span className="font-mono">{fmt(r.current_amount)}</span>,
    },
    {
      key: 'days_31_60',
      header: '31-60 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_31_60 > 0 ? 'text-yellow-600' : ''}`}>
          {fmt(r.days_31_60)}
        </span>
      ),
    },
    {
      key: 'days_61_90',
      header: '61-90 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_61_90 > 0 ? 'text-orange-600' : ''}`}>
          {fmt(r.days_61_90)}
        </span>
      ),
    },
    {
      key: 'over_90',
      header: '90+ Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.over_90 > 0 ? 'text-red-600 font-semibold' : ''}`}>
          {fmt(r.over_90)}
        </span>
      ),
    },
    {
      key: 'total_outstanding',
      header: 'Total',
      sortable: true,
      render: (r) => <span className="font-mono font-semibold">{fmt(r.total_outstanding)}</span>,
    },
    {
      key: 'bill_count',
      header: 'Bills',
      sortable: true,
      render: (r) => <span className="text-secondary">{r.bill_count}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Accounts"
        accent="Payable"
        actions={(
          <div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/accounts-payable/bills')}>
            <FileText className="w-4 h-4 mr-1" /> View All Bills
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/accounts-payable/bills/new')}>
            New Bill
          </Button>
          </div>
        )}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-red-600" />
            </div>
            <span className="text-sm text-secondary">Total Owed</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-600">
            {summary ? fmt(summary.total_owed_cents) : '--'}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-yellow-50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-yellow-600" />
            </div>
            <span className="text-sm text-secondary">Due This Week</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-yellow-600">
            {summary ? fmt(summary.due_this_week_cents) : '--'}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Due This Month</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-blue-600">
            {summary ? fmt(summary.due_this_month_cents) : '--'}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-red-700" />
            </div>
            <span className="text-sm text-secondary">Overdue</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-red-700">
            {summary ? fmt(summary.overdue_cents) : '--'}
          </p>
          {summary && summary.overdue_count > 0 && (
            <p className="text-xs text-red-500 mt-1">{summary.overdue_count} bill{summary.overdue_count !== 1 ? 's' : ''} past due</p>
          )}
        </Card>
      </div>

      {/* AP Aging */}
      <Card>
        <div className="flex items-end gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">As of Date</label>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => { setLoading(true); Promise.all([fetchSummary(), fetchAging()]).finally(() => setLoading(false)); }}>
            Refresh
          </Button>
          <div className="ml-auto">
            {agingData.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  exportToCSV(
                    agingData as unknown as Record<string, unknown>[],
                    [
                      { key: 'vendor_name', header: 'Vendor' },
                      { key: 'current_amount', header: 'Current', format: (v) => fmtCSV((v as number) / 100) },
                      { key: 'days_31_60', header: '31-60 Days', format: (v) => fmtCSV((v as number) / 100) },
                      { key: 'days_61_90', header: '61-90 Days', format: (v) => fmtCSV((v as number) / 100) },
                      { key: 'over_90', header: '90+ Days', format: (v) => fmtCSV((v as number) / 100) },
                      { key: 'total_outstanding', header: 'Total', format: (v) => fmtCSV((v as number) / 100) },
                      { key: 'bill_count', header: 'Bills' },
                    ],
                    'ap_aging_report'
                  )
                }
              >
                Export CSV
              </Button>
            )}
          </div>
        </div>

        <DataTable<APAgingRow>
          columns={agingColumns}
          data={agingData}
          loading={loading}
          searchable
          searchPlaceholder="Search vendors..."
          searchKeys={['vendor_name']}
          emptyTitle="No outstanding payables"
          emptyDescription="All vendor bills are paid."
        />
      </Card>

      {/* Aging Totals */}
      {agingData.length > 0 && (
        <Card>
          <div className="grid grid-cols-6 gap-2 text-sm">
            <span className="font-semibold">Totals</span>
            <span className="font-mono font-semibold">{fmt(agingTotals.current)}</span>
            <span className="font-mono font-semibold text-yellow-600">{fmt(agingTotals.d31_60)}</span>
            <span className="font-mono font-semibold text-orange-600">{fmt(agingTotals.d61_90)}</span>
            <span className="font-mono font-semibold text-red-600">{fmt(agingTotals.over90)}</span>
            <span className="font-mono font-semibold">{fmt(agingTotals.total)}</span>
          </div>
        </Card>
      )}
    </div>
  );
}
