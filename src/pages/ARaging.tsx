/**
 * ARaging.tsx — AR Aging Report & Customer Statements
 *
 * Uses the get_ar_aging() and get_customer_statement() RPCs
 * to show aging buckets and generate printable customer statements.
 */
import { useEffect, useState } from 'react';
import { DollarSign, FileText, Printer, TrendingDown, TrendingUp, ArrowLeft, Zap, FileStack } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import { exportToCSV, fmtCSV } from '../lib/csvExport';
import { downloadStatementPdf, downloadBatchStatements } from '../lib/statementPdf';
import StatementPrintDialog from '../components/statements/StatementPrintDialog';
import FinanceChargePreviewModal from '../components/invoices/FinanceChargePreviewModal';
import { useAuth } from '../contexts/AuthContext';
import type { ARAgingRow, CustomerStatementRow, SeasonComparisonRow, DetailedStatementData, StatementOptions } from '../types';

type TabKey = 'aging' | 'statement' | 'season';

export default function ARaging() {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [tab, setTab] = useState<TabKey>('aging');
  const [loading, setLoading] = useState(true);
  const [showFinanceChargePreview, setShowFinanceChargePreview] = useState(false);
  const [showStatementDialog, setShowStatementDialog] = useState(false);
  const [printingStatement, setPrintingStatement] = useState(false);
  const [printCustomerId, setPrintCustomerId] = useState<string | null>(null);
  const [printCustomerName, setPrintCustomerName] = useState('');

  // Batch statement selection
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set());
  const [showBatchStatementDialog, setShowBatchStatementDialog] = useState(false);
  const [batchPrinting, setBatchPrinting] = useState(false);

  // Aging
  const [agingData, setAgingData] = useState<ARAgingRow[]>([]);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split('T')[0]);

  // Statement
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [stmtStart, setStmtStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().split('T')[0];
  });
  const [stmtEnd, setStmtEnd] = useState(new Date().toISOString().split('T')[0]);
  const [statementData, setStatementData] = useState<CustomerStatementRow[]>([]);
  const [stmtCustomerName, setStmtCustomerName] = useState('');

  // Season Comparison
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth();
  const currentSeason = currentMonth >= 6 ? currentYear + 1 : currentYear;
  const [seasonA, setSeasonA] = useState(currentSeason);
  const [seasonB, setSeasonB] = useState(currentSeason - 1);
  const [seasonData, setSeasonData] = useState<SeasonComparisonRow[]>([]);

  useEffect(() => {
    fetchCustomers();
  }, []);

  useEffect(() => {
    if (tab === 'aging') fetchAging();
    if (tab === 'season') fetchSeasonComparison();
  }, [tab, asOfDate, seasonA, seasonB]);

  const fetchCustomers = async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .order('farm_name');
    setCustomers(data || []);
  };

  const fetchAging = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_ar_aging', {
      p_as_of_date: asOfDate,
    });
    if (error) {
      console.error('AR aging error:', error.message);
      toast('error', 'Failed to load AR aging data');
    }
    setAgingData((data || []) as ARAgingRow[]);
    setLoading(false);
  };

  const fetchStatement = async () => {
    if (!selectedCustomer) {
      toast('error', 'Select a customer first');
      return;
    }
    setLoading(true);
    const cust = customers.find((c) => c.id === selectedCustomer);
    setStmtCustomerName(cust?.farm_name || 'Customer');

    const { data, error } = await supabase.rpc('get_customer_statement', {
      p_customer_id: selectedCustomer,
      p_start_date: stmtStart,
      p_end_date: stmtEnd,
    });
    if (error) {
      console.error('Statement error:', error.message);
      toast('error', 'Failed to load customer statement');
    }
    setStatementData((data || []) as CustomerStatementRow[]);
    setTab('statement');
    setLoading(false);
  };

  const fetchSeasonComparison = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_season_comparison', {
      p_season_a: seasonA,
      p_season_b: seasonB,
    });
    if (error) {
      console.error('Season comparison error:', error.message);
      toast('error', 'Failed to load season comparison');
    }
    setSeasonData((data || []) as SeasonComparisonRow[]);
    setLoading(false);
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const fmtCents = (cents: number) => fmt(cents / 100);

  // Totals for aging
  const agingTotals = agingData.reduce(
    (acc, r) => ({
      current: acc.current + r.current_amount,
      d30: acc.d30 + r.days_30,
      d60: acc.d60 + r.days_60,
      d90: acc.d90 + r.days_90,
      over90: acc.over90 + r.over_90,
      total: acc.total + r.total_outstanding,
    }),
    { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 }
  );

  const agingColumns: Column<ARAgingRow>[] = [
    {
      key: 'customer_id' as keyof ARAgingRow,
      header: '',
      className: 'w-10',
      render: (r) => (
        <input
          type="checkbox"
          checked={selectedCustomers.has(r.customer_id)}
          onChange={(e) => {
            e.stopPropagation();
            toggleCustomerSelect(r.customer_id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
        />
      ),
    },
    {
      key: 'farm_name',
      header: 'Customer',
      sortable: true,
      render: (r) => (
        <button
          className="font-medium text-crx-green hover:underline text-left"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedCustomer(r.customer_id);
            fetchStatementForCustomer(r.customer_id, r.farm_name);
          }}
        >
          {r.farm_name}
        </button>
      ),
    },
    {
      key: 'current_amount',
      header: 'Current',
      sortable: true,
      render: (r) => <span className="font-mono">{fmt(r.current_amount)}</span>,
    },
    {
      key: 'days_30',
      header: '30 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_30 > 0 ? 'text-yellow-600' : ''}`}>
          {fmt(r.days_30)}
        </span>
      ),
    },
    {
      key: 'days_60',
      header: '60 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_60 > 0 ? 'text-orange-600' : ''}`}>
          {fmt(r.days_60)}
        </span>
      ),
    },
    {
      key: 'days_90',
      header: '90 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_90 > 0 ? 'text-red-500' : ''}`}>
          {fmt(r.days_90)}
        </span>
      ),
    },
    {
      key: 'over_90',
      header: '120+ Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.over_90 > 0 ? 'text-red-700 font-semibold' : ''}`}>
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
      key: 'invoice_count' as keyof ARAgingRow,
      header: '',
      render: (r) => (
        <button
          className="text-crx-green hover:text-crx-green/70 p-1"
          title="Print Statement"
          onClick={(e) => {
            e.stopPropagation();
            openStatementDialog(r.customer_id, r.farm_name);
          }}
        >
          <Printer className="w-4 h-4" />
        </button>
      ),
    },
  ];

  const stmtColumns: Column<CustomerStatementRow>[] = [
    {
      key: 'transaction_date',
      header: 'Date',
      render: (r) => new Date(r.transaction_date).toLocaleDateString(),
    },
    {
      key: 'transaction_type',
      header: 'Type',
      render: (r) => (
        <Badge
          variant={
            r.transaction_type === 'invoice'
              ? 'default'
              : r.transaction_type === 'payment'
                ? 'success'
                : 'info'
          }
        >
          {r.transaction_type}
        </Badge>
      ),
    },
    { key: 'reference_number', header: 'Ref #', render: (r) => r.reference_number || '-' },
    { key: 'description', header: 'Description' },
    {
      key: 'amount_cents',
      header: 'Amount',
      render: (r) => (
        <span className={`font-mono ${r.amount_cents < 0 ? 'text-crx-green' : 'text-nav-dark'}`}>
          {r.amount_cents < 0 ? '(' + fmtCents(Math.abs(r.amount_cents)) + ')' : fmtCents(r.amount_cents)}
        </span>
      ),
    },
    {
      key: 'running_balance',
      header: 'Balance',
      render: (r) => <span className="font-mono font-semibold">{fmtCents(r.running_balance)}</span>,
    },
  ];

  const seasonColumns: Column<SeasonComparisonRow>[] = [
    { key: 'metric', header: 'Metric', render: (r) => <span className="font-medium">{r.metric}</span> },
    {
      key: 'season_a_val',
      header: `Season ${seasonA}`,
      render: (r) => (
        <span className="font-mono">
          {r.metric === 'Revenue' || r.metric === 'Profit' ? fmt(r.season_a_val) : r.season_a_val.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'season_b_val',
      header: `Season ${seasonB}`,
      render: (r) => (
        <span className="font-mono">
          {r.metric === 'Revenue' || r.metric === 'Profit' ? fmt(r.season_b_val) : r.season_b_val.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'change_pct',
      header: 'Change',
      render: (r) =>
        r.change_pct !== null ? (
          <span className={`flex items-center gap-1 font-semibold ${r.change_pct >= 0 ? 'text-crx-green' : 'text-red-600'}`}>
            {r.change_pct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            {r.change_pct >= 0 ? '+' : ''}{r.change_pct}%
          </span>
        ) : (
          <span className="text-secondary">N/A</span>
        ),
    },
  ];

  const fetchStatementForCustomer = async (custId: string, custName: string) => {
    setLoading(true);
    setStmtCustomerName(custName);
    setSelectedCustomer(custId);
    const { data, error } = await supabase.rpc('get_customer_statement', {
      p_customer_id: custId,
      p_start_date: stmtStart,
      p_end_date: stmtEnd,
    });
    if (error) {
      toast('error', 'Failed to load statement');
    }
    setStatementData((data || []) as CustomerStatementRow[]);
    setTab('statement');
    setLoading(false);
  };

  const handleFinanceChargeSuccess = () => {
    fetchAging();
  };

  const openStatementDialog = (custId: string, custName: string) => {
    setPrintCustomerId(custId);
    setPrintCustomerName(custName);
    setShowStatementDialog(true);
  };

  const handlePrintStatement = async (options: StatementOptions) => {
    if (!printCustomerId) return;
    setShowStatementDialog(false);
    setPrintingStatement(true);
    try {
      const { data, error } = await supabase.rpc('get_detailed_statement_data', {
        p_customer_id: printCustomerId,
        p_as_of_date: options.as_of_date,
        p_mode: options.mode,
      });
      if (error) throw error;

      const stmtData = data as DetailedStatementData;
      if (!stmtData || !stmtData.transactions || stmtData.transactions.length === 0) {
        toast('info', `No outstanding balance for ${printCustomerName}`);
        setPrintingStatement(false);
        return;
      }

      await downloadStatementPdf(stmtData, options);
      toast('success', `Statement downloaded for ${printCustomerName}`);
    } catch (err: any) {
      toast('error', err.message || 'Failed to generate statement');
    }
    setPrintingStatement(false);
  };

  // Batch statement selection helpers
  const toggleCustomerSelect = (id: string) => {
    setSelectedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllCustomers = () => {
    if (selectedCustomers.size === agingData.length && agingData.length > 0) {
      setSelectedCustomers(new Set());
    } else {
      setSelectedCustomers(new Set(agingData.map((r) => r.customer_id)));
    }
  };

  const handleBatchStatements = async (options: StatementOptions) => {
    setShowBatchStatementDialog(false);
    setBatchPrinting(true);
    try {
      const stmtDataList: DetailedStatementData[] = [];
      for (const custId of selectedCustomers) {
        const { data, error } = await supabase.rpc('get_detailed_statement_data', {
          p_customer_id: custId,
          p_as_of_date: options.as_of_date,
          p_mode: options.mode,
        });
        if (error) {
          console.error(`Statement error for ${custId}:`, error.message);
          continue;
        }
        const stmtData = data as DetailedStatementData;
        if (stmtData && stmtData.transactions && stmtData.transactions.length > 0) {
          stmtDataList.push(stmtData);
        }
      }

      if (stmtDataList.length === 0) {
        toast('info', 'No customers had outstanding balances for statements');
      } else {
        await downloadBatchStatements(stmtDataList, options);
        toast('success', `Downloaded ${stmtDataList.length} statement(s)`);
      }
    } catch (err: any) {
      toast('error', err.message || 'Failed to generate batch statements');
    }
    setBatchPrinting(false);
  };

  const seasonOptions = Array.from({ length: 5 }, (_, i) => currentSeason - i);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">AR Aging & Statements</h1>
        <div className="flex gap-2">
          {selectedCustomers.size > 0 && (
            <Button
              variant="secondary"
              size="sm"
              icon={<FileStack className="w-4 h-4" />}
              onClick={() => setShowBatchStatementDialog(true)}
              loading={batchPrinting}
            >
              Batch Statements ({selectedCustomers.size})
            </Button>
          )}
          {profile?.role === 'admin' && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Zap className="w-4 h-4" />}
              onClick={() => setShowFinanceChargePreview(true)}
            >
              Preview Finance Charges
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {[
          { key: 'aging' as TabKey, label: 'AR Aging' },
          { key: 'statement' as TabKey, label: 'Customer Statement' },
          { key: 'season' as TabKey, label: 'Season Comparison' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === t.key
                ? 'bg-white text-nav-dark shadow-sm'
                : 'text-secondary hover:text-nav-dark'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ========== AR AGING TAB ========== */}
      {tab === 'aging' && (
        <>
          {/* Controls */}
          <Card>
            <div className="flex items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">As of Date</label>
                <input
                  type="date"
                  value={asOfDate}
                  onChange={(e) => setAsOfDate(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <Button variant="secondary" size="sm" onClick={fetchAging}>
                Refresh
              </Button>
              {agingData.length > 0 && (
                <button
                  onClick={toggleAllCustomers}
                  className="text-xs text-crx-green hover:underline ml-2"
                >
                  {selectedCustomers.size === agingData.length ? 'Deselect All' : 'Select All'}
                </button>
              )}
              <div className="ml-auto">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    exportToCSV(
                      agingData as unknown as Record<string, unknown>[],
                      [
                        { key: 'farm_name', header: 'Customer' },
                        { key: 'current_amount', header: 'Current', format: fmtCSV },
                        { key: 'days_30', header: '30 Days', format: fmtCSV },
                        { key: 'days_60', header: '60 Days', format: fmtCSV },
                        { key: 'days_90', header: '90 Days', format: fmtCSV },
                        { key: 'over_90', header: '120+ Days', format: fmtCSV },
                        { key: 'total_outstanding', header: 'Total', format: fmtCSV },
                      ],
                      'ar_aging_report'
                    )
                  }
                >
                  Export CSV
                </Button>
              </div>
            </div>
          </Card>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card>
              <p className="text-xs text-secondary mb-1">Total Outstanding</p>
              <p className="text-xl font-semibold font-heading text-red-600">{fmt(agingTotals.total)}</p>
            </Card>
            <Card>
              <p className="text-xs text-secondary mb-1">Current (&lt;30 days)</p>
              <p className="text-xl font-semibold font-heading text-nav-dark">{fmt(agingTotals.current)}</p>
            </Card>
            <Card>
              <p className="text-xs text-secondary mb-1">30-89 Days</p>
              <p className="text-xl font-semibold font-heading text-orange-600">
                {fmt(agingTotals.d30 + agingTotals.d60)}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-secondary mb-1">90+ Days</p>
              <p className="text-xl font-semibold font-heading text-red-700">
                {fmt(agingTotals.d90 + agingTotals.over90)}
              </p>
            </Card>
          </div>

          {/* Aging Table */}
          <Card padding={false}>
            <div className="p-5">
              <DataTable<ARAgingRow>
                columns={agingColumns}
                data={agingData}
                loading={loading}
                searchable
                searchPlaceholder="Search customers..."
                searchKeys={['farm_name']}
                emptyTitle="No outstanding receivables"
                emptyDescription="All customer balances are current."
              />
            </div>
          </Card>

          {/* Totals footer row */}
          {agingData.length > 0 && (
            <Card>
              <div className="grid grid-cols-7 gap-2 text-sm">
                <span className="font-semibold">Totals</span>
                <span className="font-mono font-semibold">{fmt(agingTotals.current)}</span>
                <span className="font-mono font-semibold text-yellow-600">{fmt(agingTotals.d30)}</span>
                <span className="font-mono font-semibold text-orange-600">{fmt(agingTotals.d60)}</span>
                <span className="font-mono font-semibold text-red-500">{fmt(agingTotals.d90)}</span>
                <span className="font-mono font-semibold text-red-700">{fmt(agingTotals.over90)}</span>
                <span className="font-mono font-semibold">{fmt(agingTotals.total)}</span>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ========== CUSTOMER STATEMENT TAB ========== */}
      {tab === 'statement' && (
        <>
          <Card>
            <div className="flex flex-wrap items-end gap-4">
              {statementData.length > 0 && (
                <button
                  onClick={() => {
                    setStatementData([]);
                    setTab('aging');
                  }}
                  className="flex items-center gap-1 text-sm text-crx-green hover:underline"
                >
                  <ArrowLeft className="w-4 h-4" /> Back to Aging
                </button>
              )}
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
                <select
                  value={selectedCustomer}
                  onChange={(e) => setSelectedCustomer(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[200px]"
                >
                  <option value="">Select customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.farm_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">From</label>
                <input
                  type="date"
                  value={stmtStart}
                  onChange={(e) => setStmtStart(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">To</label>
                <input
                  type="date"
                  value={stmtEnd}
                  onChange={(e) => setStmtEnd(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <Button icon={<FileText className="w-4 h-4" />} onClick={fetchStatement}>
                Load Transactions
              </Button>
              {selectedCustomer && (
                <Button
                  variant="secondary"
                  icon={<Printer className="w-4 h-4" />}
                  onClick={() => {
                    const cust = customers.find((c) => c.id === selectedCustomer);
                    openStatementDialog(selectedCustomer, cust?.farm_name || 'Customer');
                  }}
                  loading={printingStatement}
                >
                  Print Statement
                </Button>
              )}
            </div>
          </Card>

          {statementData.length > 0 && (
            <>
              <Card>
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-nav-dark">{stmtCustomerName}</h2>
                    <p className="text-sm text-secondary">
                      Statement period: {new Date(stmtStart).toLocaleDateString()} –{' '}
                      {new Date(stmtEnd).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-secondary">Ending Balance</p>
                    <p className="text-xl font-semibold font-heading text-red-600">
                      {statementData.length > 0
                        ? fmtCents(statementData[statementData.length - 1].running_balance)
                        : '$0.00'}
                    </p>
                  </div>
                </div>
              </Card>

              <Card padding={false}>
                <div className="p-5">
                  <DataTable<CustomerStatementRow>
                    columns={stmtColumns}
                    data={statementData}
                    loading={loading}
                    emptyTitle="No transactions found"
                    emptyDescription="No activity in the selected date range."
                  />
                </div>
              </Card>

              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    exportToCSV(
                      statementData as unknown as Record<string, unknown>[],
                      [
                        { key: 'transaction_date', header: 'Date' },
                        { key: 'transaction_type', header: 'Type' },
                        { key: 'reference_number', header: 'Ref #' },
                        { key: 'description', header: 'Description' },
                        { key: 'amount_cents', header: 'Amount (cents)' },
                        { key: 'running_balance', header: 'Balance (cents)' },
                      ],
                      `statement_${stmtCustomerName.replace(/\s+/g, '_')}`
                    )
                  }
                >
                  Export CSV
                </Button>
              </div>
            </>
          )}

          {statementData.length === 0 && !loading && selectedCustomer && (
            <Card>
              <div className="text-center py-8">
                <DollarSign className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                <p className="text-secondary">Select a customer and date range, then click Generate Statement.</p>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ========== SEASON COMPARISON TAB ========== */}
      {tab === 'season' && (
        <>
          <Card>
            <div className="flex items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Season A</label>
                <select
                  value={seasonA}
                  onChange={(e) => setSeasonA(Number(e.target.value))}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {seasonOptions.map((s) => (
                    <option key={s} value={s}>
                      {s - 1}/{s} Season
                    </option>
                  ))}
                </select>
              </div>
              <span className="text-sm text-secondary pb-2">vs</span>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Season B</label>
                <select
                  value={seasonB}
                  onChange={(e) => setSeasonB(Number(e.target.value))}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {seasonOptions.map((s) => (
                    <option key={s} value={s}>
                      {s - 1}/{s} Season
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          <Card padding={false}>
            <div className="p-5">
              <DataTable<SeasonComparisonRow>
                columns={seasonColumns}
                data={seasonData}
                loading={loading}
                emptyTitle="No comparison data"
                emptyDescription="Select two seasons to compare."
              />
            </div>
          </Card>
        </>
      )}

      {/* Statement Print Dialog */}
      <StatementPrintDialog
        open={showStatementDialog}
        onClose={() => setShowStatementDialog(false)}
        onGenerate={handlePrintStatement}
        loading={printingStatement}
      />

      {/* Batch Statement Print Dialog */}
      <StatementPrintDialog
        open={showBatchStatementDialog}
        onClose={() => setShowBatchStatementDialog(false)}
        onGenerate={handleBatchStatements}
        loading={batchPrinting}
      />

      {/* Finance Charge Preview Modal */}
      <FinanceChargePreviewModal
        open={showFinanceChargePreview}
        onClose={() => setShowFinanceChargePreview(false)}
        asOfDate={asOfDate}
        onSuccess={handleFinanceChargeSuccess}
      />
    </div>
  );
}
