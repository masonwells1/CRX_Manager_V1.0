import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DollarSign,
  TrendingUp,
  FileText,
  AlertTriangle,
  Clock,
  Wallet,
  CreditCard,
  BarChart3,
  Receipt,
  ShieldCheck,
  ArrowLeftRight,
  CalendarCheck,
  ChevronRight,
  Banknote,
  Package,
  Warehouse,
  ClipboardCheck,
  History,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { SkeletonCard } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';

// --- Types ---

interface MonthlyData {
  month: string;
  revenue: number;
  profit: number;
}

interface TopCustomer {
  farm_name: string;
  total: number;
}

interface QuoteCounts {
  draft: number;
  sent: number;
  accepted: number;
}

interface ArAgingBuckets {
  current: number;
  days_31_60: number;
  days_61_90: number;
  days_90_plus: number;
}

interface CurrentPeriod {
  name: string;
  status: string;
  days_remaining: number;
}

interface FinancialRpc {
  total_revenue: number;
  total_profit: number;
  overall_margin: number;
  quote_counts: QuoteCounts;
  quote_pipeline_value: number;
  monthly_revenue: MonthlyData[];
  top_customers: TopCustomer[];
  open_ar_balance: number;
  customers_over_credit_count: number;
  ar_aging_buckets: ArAgingBuckets;
  total_prepay_unallocated: number;
  total_commission_owed: number;
  current_period: CurrentPeriod;
  po_unreceived_value: number;
  floor_inventory_value: number;
  floor_free_value: number;
  committed_order_value: number;
}

interface FinancialData {
  totalRevenue: number;
  totalProfit: number;
  overallMargin: number;
  quoteCounts: QuoteCounts;
  quotePipelineValue: number;
  monthlyRevenue: MonthlyData[];
  topCustomers: TopCustomer[];
  openArBalance: number;
  customersOverCreditCount: number;
  arAgingBuckets: ArAgingBuckets;
  totalPrepayUnallocated: number;
  totalCommissionOwed: number;
  currentPeriod: CurrentPeriod;
  poUnreceivedValue: number;
  floorInventoryValue: number;
  floorFreeValue: number;
  committedOrderValue: number;
}

// --- Currency formatter ---

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);

const fmtDecimal = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

// --- Quick Access Links ---

interface QuickLink {
  label: string;
  path: string;
  icon: React.ReactNode;
}

const quickLinks: QuickLink[] = [
  { label: 'AR Aging', path: '/ar-aging', icon: <BarChart3 className="w-5 h-5" /> },
  { label: 'Prepayments', path: '/prepayments', icon: <Banknote className="w-5 h-5" /> },
  { label: 'Prepay Workspace', path: '/prepay-workspace', icon: <Wallet className="w-5 h-5" /> },
  { label: 'Payment History', path: '/payment-history', icon: <History className="w-5 h-5" /> },
  { label: 'Commission Pay', path: '/commission-payments', icon: <CreditCard className="w-5 h-5" /> },
  { label: 'Transactions', path: '/customer-transactions', icon: <ArrowLeftRight className="w-5 h-5" /> },
  { label: 'Month-End', path: '/month-end', icon: <CalendarCheck className="w-5 h-5" /> },
  { label: 'Rebates', path: '/rebates', icon: <Receipt className="w-5 h-5" /> },
  { label: 'Reports', path: '/reports', icon: <FileText className="w-5 h-5" /> },
  { label: 'Compliance', path: '/compliance', icon: <ShieldCheck className="w-5 h-5" /> },
];

// --- Default data ---

const defaultData: FinancialData = {
  totalRevenue: 0,
  totalProfit: 0,
  overallMargin: 0,
  quoteCounts: { draft: 0, sent: 0, accepted: 0 },
  quotePipelineValue: 0,
  monthlyRevenue: [],
  topCustomers: [],
  openArBalance: 0,
  customersOverCreditCount: 0,
  arAgingBuckets: { current: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 },
  totalPrepayUnallocated: 0,
  totalCommissionOwed: 0,
  currentPeriod: { name: '', status: 'open', days_remaining: 0 },
  poUnreceivedValue: 0,
  floorInventoryValue: 0,
  floorFreeValue: 0,
  committedOrderValue: 0,
};

// --- Component ---

export default function FinancialDashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<FinancialData>(defaultData);

  const fetchFinancials = useCallback(async () => {
    setLoading(true);
    try {
      const { data: rpc, error } = await supabase.rpc('financial_dashboard_summary');
      if (error) throw error;

      const d = rpc as FinancialRpc;

      setData({
        totalRevenue: Number(d.total_revenue) || 0,
        totalProfit: Number(d.total_profit) || 0,
        overallMargin: Number(d.overall_margin) || 0,
        quoteCounts: d.quote_counts || { draft: 0, sent: 0, accepted: 0 },
        quotePipelineValue: Number(d.quote_pipeline_value) || 0,
        monthlyRevenue: (d.monthly_revenue || []).map((m) => ({
          month: m.month,
          revenue: Number(m.revenue) || 0,
          profit: Number(m.profit) || 0,
        })),
        topCustomers: (d.top_customers || []).map((c) => ({
          farm_name: c.farm_name,
          total: Number(c.total) || 0,
        })),
        openArBalance: Number(d.open_ar_balance) || 0,
        customersOverCreditCount: Number(d.customers_over_credit_count) || 0,
        arAgingBuckets: d.ar_aging_buckets || { current: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 },
        totalPrepayUnallocated: Number(d.total_prepay_unallocated) || 0,
        totalCommissionOwed: Number(d.total_commission_owed) || 0,
        currentPeriod: d.current_period || { name: '', status: 'open', days_remaining: 0 },
        poUnreceivedValue: Number(d.po_unreceived_value) || 0,
        floorInventoryValue: Number(d.floor_inventory_value) || 0,
        floorFreeValue: Number(d.floor_free_value) || 0,
        committedOrderValue: Number(d.committed_order_value) || 0,
      });
    } catch (err) {
      console.error('Financial dashboard load error:', err);
      toast('error', 'Failed to load financial dashboard. Please refresh.');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchFinancials();
  }, [fetchFinancials]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    );
  }

  // Monthly chart calculations
  const maxRevenue = Math.max(...data.monthlyRevenue.map((m) => m.revenue), 1);
  const totalMonthlyRevenue = data.monthlyRevenue.reduce((sum, m) => sum + m.revenue, 0);
  const totalMonthlyProfit = data.monthlyRevenue.reduce((sum, m) => sum + m.profit, 0);
  const avgMonthlyRevenue = data.monthlyRevenue.length > 0 ? totalMonthlyRevenue / data.monthlyRevenue.length : 0;

  // AR Aging bar calculations
  const agingBuckets = [
    { label: 'Current', value: data.arAgingBuckets.current, color: 'bg-emerald-500' },
    { label: '31-60', value: data.arAgingBuckets.days_31_60, color: 'bg-amber-500' },
    { label: '61-90', value: data.arAgingBuckets.days_61_90, color: 'bg-orange-500' },
    { label: '90+', value: data.arAgingBuckets.days_90_plus, color: 'bg-red-500' },
  ];
  const maxAgingBucket = Math.max(...agingBuckets.map((b) => b.value), 1);

  // Top customer max for progress bars
  const maxCustomerTotal = data.topCustomers.length > 0 ? data.topCustomers[0].total : 1;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold font-heading text-nav-dark">
          Financial <span className="split-heading-accent">Dashboard</span>
        </h1>
        <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
          Operations Dashboard
        </Button>
      </div>

      {/* Section 1: Top Row — 4 Financial KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Total Revenue */}
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-green-600" />
            </div>
            <span className="text-sm text-secondary">Total Revenue</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.totalRevenue)}</p>
          <p className="text-xs text-secondary mt-1">All confirmed orders</p>
        </Card>

        {/* Total Profit */}
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-emerald-600" />
            </div>
            <span className="text-sm text-secondary">Total Profit</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.totalProfit)}</p>
          <p className="text-xs text-secondary mt-1">
            {data.overallMargin.toFixed(1)}% overall margin
          </p>
        </Card>

        {/* Quote Pipeline */}
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <FileText className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Quote Pipeline</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.quotePipelineValue)}</p>
          <div className="flex gap-2 mt-1">
            <Badge variant="draft">{data.quoteCounts.draft} draft</Badge>
            <Badge variant="sent">{data.quoteCounts.sent} sent</Badge>
            <Badge variant="accepted">{data.quoteCounts.accepted} accepted</Badge>
          </div>
        </Card>

        {/* AR Balance */}
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                data.customersOverCreditCount > 0 ? 'bg-red-50' : 'bg-amber-50'
              }`}
            >
              <AlertTriangle
                className={`w-5 h-5 ${data.customersOverCreditCount > 0 ? 'text-red-600' : 'text-amber-600'}`}
              />
            </div>
            <span className="text-sm text-secondary">AR Balance</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.openArBalance)}</p>
          {data.customersOverCreditCount > 0 ? (
            <p className="text-xs text-red-600 mt-1 font-medium">
              {data.customersOverCreditCount} customer(s) over credit limit
            </p>
          ) : (
            <p className="text-xs text-secondary mt-1">No customers over credit limit</p>
          )}
        </Card>
      </div>

      {/* Section 2: Second Row — 4 Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* AR Aging */}
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">AR Aging</span>
          </div>
          <div className="space-y-2">
            {agingBuckets.map((bucket) => (
              <div key={bucket.label} className="flex items-center gap-2">
                <span className="text-xs text-secondary w-12 shrink-0">{bucket.label}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-2.5">
                  <div
                    className={`${bucket.color} h-2.5 rounded-full transition-all`}
                    style={{ width: `${Math.max((bucket.value / maxAgingBucket) * 100, bucket.value > 0 ? 4 : 0)}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-nav-dark w-16 text-right">{fmtDecimal(bucket.value)}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Prepay Balance */}
        <Card
          hover
          className="cursor-pointer"
          onClick={() => navigate('/prepay-workspace')}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
              <Wallet className="w-5 h-5 text-purple-600" />
            </div>
            <span className="text-sm text-secondary">Prepay Balance</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmtDecimal(data.totalPrepayUnallocated)}</p>
          <p className="text-xs text-secondary mt-1 flex items-center gap-1">
            Unallocated prepayments <ChevronRight className="w-3 h-3" />
          </p>
        </Card>

        {/* Commission Owed */}
        <Card
          hover
          className="cursor-pointer"
          onClick={() => navigate('/commission-payments')}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-orange-600" />
            </div>
            <span className="text-sm text-secondary">Commission Owed</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">{fmtDecimal(data.totalCommissionOwed)}</p>
          <p className="text-xs text-secondary mt-1 flex items-center gap-1">
            Unpaid commissions <ChevronRight className="w-3 h-3" />
          </p>
        </Card>

        {/* Month-End Status */}
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center">
              <CalendarCheck className="w-5 h-5 text-indigo-600" />
            </div>
            <span className="text-sm text-secondary">Month-End Status</span>
          </div>
          <p className="text-lg font-semibold font-heading text-nav-dark">{data.currentPeriod.name || 'N/A'}</p>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={data.currentPeriod.status === 'open' ? 'success' : 'default'}>
              {data.currentPeriod.status}
            </Badge>
            {data.currentPeriod.status === 'open' && (
              <span className="text-xs text-secondary flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {data.currentPeriod.days_remaining}d remaining
              </span>
            )}
          </div>
        </Card>
      </div>

      {/* Section 3: Inventory Position */}
      <div>
        <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Inventory Position</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* On Order (POs) */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/purchase-orders')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-sky-50 flex items-center justify-center">
                <Package className="w-5 h-5 text-sky-600" />
              </div>
              <span className="text-sm text-secondary">On Order (POs)</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.poUnreceivedValue)}</p>
            <p className="text-xs text-secondary mt-1 flex items-center gap-1">
              Unreceived supplier PO value <ChevronRight className="w-3 h-3" />
            </p>
          </Card>

          {/* Floor Inventory */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/inventory')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-teal-50 flex items-center justify-center">
                <Warehouse className="w-5 h-5 text-teal-600" />
              </div>
              <span className="text-sm text-secondary">Floor Inventory</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.floorInventoryValue)}</p>
            <p className="text-xs text-secondary mt-1 flex items-center gap-1">
              {fmt(data.floorFreeValue)} uncommitted <ChevronRight className="w-3 h-3" />
            </p>
          </Card>

          {/* Committed Orders */}
          <Card hover className="cursor-pointer" onClick={() => navigate('/orders')}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-violet-50 flex items-center justify-center">
                <ClipboardCheck className="w-5 h-5 text-violet-600" />
              </div>
              <span className="text-sm text-secondary">Committed Orders</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-nav-dark">{fmt(data.committedOrderValue)}</p>
            <p className="text-xs text-secondary mt-1 flex items-center gap-1">
              Undelivered order value at cost <ChevronRight className="w-3 h-3" />
            </p>
          </Card>
        </div>
      </div>

      {/* Section 4: Monthly Revenue & Profit Chart */}
      <Card>
        <CardHeader title="Monthly" accent="Revenue & Profit" />
        {data.monthlyRevenue.length === 0 ? (
          <p className="text-sm text-secondary">No monthly revenue data available</p>
        ) : (
          <>
            <div className="flex items-end gap-1 h-48 mt-2">
              {data.monthlyRevenue.map((m) => {
                const revenueHeight = (m.revenue / maxRevenue) * 100;
                const monthLabel = m.month.length >= 7 ? m.month.slice(5, 7) : m.month;
                return (
                  <div key={m.month} className="flex-1 flex flex-col items-center gap-1 group">
                    <div className="w-full flex flex-col items-center justify-end h-40 relative">
                      {/* Revenue bar */}
                      <div
                        className="w-full max-w-[32px] bg-crx-green/20 rounded-t relative"
                        style={{ height: `${revenueHeight}%` }}
                      >
                        {/* Profit overlay */}
                        <div
                          className="absolute bottom-0 left-0 right-0 bg-emerald-500 rounded-t"
                          style={{ height: `${m.revenue > 0 ? (m.profit / m.revenue) * 100 : 0}%` }}
                        />
                      </div>
                      {/* Tooltip on hover */}
                      <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-nav-dark text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                        {fmt(m.revenue)} / {fmt(m.profit)}
                      </div>
                    </div>
                    <span className="text-xs text-secondary">{monthLabel}</span>
                  </div>
                );
              })}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-4 mt-3 mb-4">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded bg-crx-green/20" />
                <span className="text-xs text-secondary">Revenue</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded bg-emerald-500" />
                <span className="text-xs text-secondary">Profit</span>
              </div>
            </div>
            {/* Summary row */}
            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-100">
              <div>
                <p className="text-xs text-secondary">Total Revenue</p>
                <p className="text-sm font-semibold text-nav-dark">{fmt(totalMonthlyRevenue)}</p>
              </div>
              <div>
                <p className="text-xs text-secondary">Total Profit</p>
                <p className="text-sm font-semibold text-nav-dark">{fmt(totalMonthlyProfit)}</p>
              </div>
              <div>
                <p className="text-xs text-secondary">Avg Monthly Revenue</p>
                <p className="text-sm font-semibold text-nav-dark">{fmt(avgMonthlyRevenue)}</p>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Section 4: Top Customers */}
      <Card>
        <CardHeader
          title="Top"
          accent="Customers"
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate('/customers')}>
              View All
            </Button>
          }
        />
        {data.topCustomers.length === 0 ? (
          <p className="text-sm text-secondary">No customer data available</p>
        ) : (
          <div className="space-y-3">
            {data.topCustomers.map((customer, idx) => (
              <div key={customer.farm_name} className="flex items-center gap-3">
                <span className="text-xs text-secondary w-5 text-right shrink-0">{idx + 1}.</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-nav-dark truncate">{customer.farm_name}</span>
                    <span className="text-sm font-semibold text-nav-dark shrink-0 ml-2">{fmt(customer.total)}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className="bg-crx-green h-2 rounded-full transition-all"
                      style={{ width: `${(customer.total / maxCustomerTotal) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Section 5: Financial Alerts */}
      {(data.openArBalance > 0 || data.customersOverCreditCount > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {data.openArBalance > 0 && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => navigate('/payments')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/payments'); }}
              className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-amber-100 transition-colors"
            >
              <DollarSign className="w-5 h-5 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-amber-800">Outstanding A/R</p>
                <p className="text-xs text-amber-600">{fmtDecimal(data.openArBalance)} in outstanding receivables</p>
              </div>
            </div>
          )}
          {data.customersOverCreditCount > 0 && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => navigate('/customers')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/customers'); }}
              className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:bg-red-100 transition-colors"
            >
              <AlertTriangle className="w-5 h-5 text-red-600" />
              <div>
                <p className="text-sm font-semibold text-red-800">Over Credit Limit</p>
                <p className="text-xs text-red-600">{data.customersOverCreditCount} customer(s) exceeding credit limit</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Section 6: Quick Access Links Grid */}
      <Card>
        <CardHeader title="Financial" accent="Quick Access" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {quickLinks.map((link) => (
            <button
              key={link.path}
              onClick={() => navigate(link.path)}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-gray-100 bg-white hover:bg-crx-green-tint hover:border-crx-green/20 transition-all cursor-pointer group"
            >
              <div className="w-10 h-10 rounded-lg bg-gray-50 group-hover:bg-crx-green/10 flex items-center justify-center transition-colors">
                {link.icon}
              </div>
              <span className="text-sm font-medium text-nav-dark text-center">{link.label}</span>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
