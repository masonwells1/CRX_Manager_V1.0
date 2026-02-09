import { useEffect, useState } from 'react';
import { Download, CheckCircle2 } from 'lucide-react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';

type TabKey = 'customer' | 'product' | 'commission' | 'revenue';

interface CustomerProfit {
  farm_name: string;
  total_revenue: number;
  total_profit: number;
  margin_pct: number;
  order_count: number;
}

interface ProductProfit {
  product_name: string;
  total_revenue: number;
  total_profit: number;
  units_sold: number;
  margin_pct: number;
}

interface CommissionRow {
  id: string;
  recipient: string;
  order_id: string;
  commission_amount: number;
  split_percentage: number;
  order_profit: number;
  order_date: string;
  status: string;
  paid_date: string | null;
}

interface RevenueSummary {
  month: string;
  revenue: number;
  profit: number;
  orders: number;
}

// === GAP FIX #8: Date range presets ===
function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  switch (preset) {
    case 'this_season':
      // Crop season = July 1 to June 30
      if (month >= 6) {
        // July-December: season started this year
        return { start: `${year}-07-01`, end: `${year + 1}-06-30` };
      } else {
        // Jan-June: season started last year
        return { start: `${year - 1}-07-01`, end: `${year}-06-30` };
      }
    case 'last_season':
      if (month >= 6) {
        return { start: `${year - 1}-07-01`, end: `${year}-06-30` };
      } else {
        return { start: `${year - 2}-07-01`, end: `${year - 1}-06-30` };
      }
    case 'ytd':
      return { start: `${year}-01-01`, end: now.toISOString().split('T')[0] };
    case 'last30':
      const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { start: thirtyAgo.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    case 'last90':
      const ninetyAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      return { start: ninetyAgo.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    default:
      return { start: '', end: '' };
  }
}

export default function Reports() {
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>('customer');
  const [customerData, setCustomerData] = useState<CustomerProfit[]>([]);
  const [productData, setProductData] = useState<ProductProfit[]>([]);
  const [commissionData, setCommissionData] = useState<CommissionRow[]>([]);
  const [revenueData, setRevenueData] = useState<RevenueSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // === GAP FIX #8: Date range state ===
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // === GAP FIX #9: Commission selection state ===
  const [selectedCommissions, setSelectedCommissions] = useState<Set<string>>(new Set());
  const [markingPaid, setMarkingPaid] = useState(false);

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchData();
  }, [tab, startDate, endDate]);

  const fetchData = async () => {
    setLoading(true);
    if (tab === 'customer') await fetchCustomerProfitability();
    if (tab === 'product') await fetchProductProfitability();
    if (tab === 'commission') await fetchCommissions();
    if (tab === 'revenue') await fetchRevenue();
    setLoading(false);
  };

  const fetchCustomerProfitability = async () => {
    let query = supabase
      .from('orders')
      .select('total_price, total_profit, total_margin_pct, customer:customers(farm_name)');
    if (startDate) query = query.gte('order_date', startDate);
    if (endDate) query = query.lte('order_date', endDate);
    const { data, error } = await query;

    if (error) {
      console.error('Failed to load customer profitability:', error.message);
      toast('error', 'Failed to load customer profitability. Please try again.');
      return;
    }

    const grouped: Record<string, CustomerProfit> = {};
    ((data || []) as Array<{ total_price: number; total_profit: number; total_margin_pct: number; customer: { farm_name: string }[] | null }>).forEach((o) => {
      const name = o.customer?.[0]?.farm_name || 'Unknown';
      if (!grouped[name]) {
        grouped[name] = { farm_name: name, total_revenue: 0, total_profit: 0, margin_pct: 0, order_count: 0 };
      }
      grouped[name].total_revenue += o.total_price || 0;
      grouped[name].total_profit += o.total_profit || 0;
      grouped[name].order_count += 1;
    });
    const result = Object.values(grouped).map((g) => ({
      ...g,
      margin_pct: g.total_revenue > 0 ? (g.total_profit / g.total_revenue) * 100 : 0,
    }));
    result.sort((a, b) => b.total_revenue - a.total_revenue);
    setCustomerData(result);
  };

  const fetchProductProfitability = async () => {
    // For product data, we need to filter by order date through the order_items -> orders relationship
    let query = supabase
      .from('order_items')
      .select('product_name, total_price, profit, total_units_needed, order:orders!inner(order_date)');
    if (startDate) query = query.gte('order.order_date', startDate);
    if (endDate) query = query.lte('order.order_date', endDate);
    const { data, error } = await query;

    if (error) {
      console.error('Failed to load product profitability:', error.message);
      toast('error', 'Failed to load product profitability. Please try again.');
      return;
    }

    const grouped: Record<string, ProductProfit> = {};
    ((data || []) as Array<{ product_name: string; total_price: number; profit: number; total_units_needed: number }>).forEach((i) => {
      const name = i.product_name;
      if (!grouped[name]) {
        grouped[name] = { product_name: name, total_revenue: 0, total_profit: 0, units_sold: 0, margin_pct: 0 };
      }
      grouped[name].total_revenue += i.total_price || 0;
      grouped[name].total_profit += i.profit || 0;
      grouped[name].units_sold += i.total_units_needed || 0;
    });
    const result = Object.values(grouped).map((g) => ({
      ...g,
      margin_pct: g.total_revenue > 0 ? (g.total_profit / g.total_revenue) * 100 : 0,
    }));
    result.sort((a, b) => b.total_revenue - a.total_revenue);
    setProductData(result);
  };

  const fetchCommissions = async () => {
    let query = supabase.from('commissions').select('*').order('order_date', { ascending: false });
    if (!isAdmin && profile) {
      query = query.eq('recipient', profile.full_name);
    }
    if (startDate) query = query.gte('order_date', startDate);
    if (endDate) query = query.lte('order_date', endDate);
    const { data, error } = await query;
    if (error) {
      console.error('Failed to load commissions:', error.message);
      toast('error', 'Failed to load commissions. Please try again.');
      return;
    }
    setCommissionData((data || []) as CommissionRow[]);
    setSelectedCommissions(new Set());
  };

  const fetchRevenue = async () => {
    let query = supabase
      .from('orders')
      .select('order_date, total_price, total_profit')
      .order('order_date');
    if (startDate) query = query.gte('order_date', startDate);
    if (endDate) query = query.lte('order_date', endDate);
    const { data, error } = await query;

    if (error) {
      console.error('Failed to load revenue data:', error.message);
      toast('error', 'Failed to load revenue data. Please try again.');
      return;
    }

    const grouped: Record<string, RevenueSummary> = {};
    ((data || []) as Array<{ order_date: string; total_price: number; total_profit: number }>).forEach((o) => {
      const month = o.order_date.substring(0, 7);
      if (!grouped[month]) {
        grouped[month] = { month, revenue: 0, profit: 0, orders: 0 };
      }
      grouped[month].revenue += o.total_price || 0;
      grouped[month].profit += o.total_profit || 0;
      grouped[month].orders += 1;
    });
    setRevenueData(Object.values(grouped).sort((a, b) => b.month.localeCompare(a.month)));
  };

  // === GAP FIX #9: Mark commissions as paid ===
  const handleMarkPaid = async () => {
    if (selectedCommissions.size === 0) {
      toast('error', 'Select at least one commission to mark as paid');
      return;
    }
    setMarkingPaid(true);
    const today = new Date().toISOString().split('T')[0];
    
    const { error, data } = await supabase
      .from('commissions')
      .update({ status: 'paid', paid_date: today })
      .in('id', Array.from(selectedCommissions))
      .select();

    if (error) {
      toast('error', 'Failed to update commissions');
    } else if (!data || data.length === 0) {
      toast('error', 'No commissions were updated. You may not have permission.');
    } else {
      toast('success', `${data.length} commission(s) marked as paid`);
      fetchCommissions();
    }
    setMarkingPaid(false);
  };

  const toggleCommissionSelect = (id: string) => {
    setSelectedCommissions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    const pendingIds = commissionData.filter((c) => c.status === 'pending').map((c) => c.id);
    if (selectedCommissions.size === pendingIds.length && pendingIds.length > 0) {
      setSelectedCommissions(new Set());
    } else {
      setSelectedCommissions(new Set(pendingIds));
    }
  };

  // === GAP FIX #8: Apply preset date range ===
  const applyPreset = (preset: string) => {
    if (preset === 'all') {
      setStartDate('');
      setEndDate('');
    } else {
      const { start, end } = getPresetDates(preset);
      setStartDate(start);
      setEndDate(end);
    }
  };

  // === GAP FIX #11: CSV Export handlers ===
  const handleExportCSV = () => {
    if (tab === 'customer') {
      exportToCSV(customerData, [
        { key: 'farm_name', header: 'Customer' },
        { key: 'total_revenue', header: 'Revenue', format: fmtCSV },
        { key: 'total_profit', header: 'Profit', format: fmtCSV },
        { key: 'margin_pct', header: 'Margin %', format: (v) => `${Number(v).toFixed(1)}%` },
        { key: 'order_count', header: 'Orders' },
      ], 'customer_profitability');
      toast('success', 'Customer report exported');
    } else if (tab === 'product') {
      exportToCSV(productData, [
        { key: 'product_name', header: 'Product' },
        { key: 'total_revenue', header: 'Revenue', format: fmtCSV },
        { key: 'total_profit', header: 'Profit', format: fmtCSV },
        { key: 'units_sold', header: 'Units Sold' },
        { key: 'margin_pct', header: 'Margin %', format: (v) => `${Number(v).toFixed(1)}%` },
      ], 'product_profitability');
      toast('success', 'Product report exported');
    } else if (tab === 'commission') {
      exportToCSV(commissionData, [
        { key: 'order_date', header: 'Date', format: fmtDateCSV },
        { key: 'recipient', header: 'Recipient' },
        { key: 'commission_amount', header: 'Commission', format: fmtCSV },
        { key: 'split_percentage', header: 'Split %', format: (v) => `${v}%` },
        { key: 'order_profit', header: 'Order Profit', format: fmtCSV },
        { key: 'status', header: 'Status' },
        { key: 'paid_date', header: 'Paid Date', format: fmtDateCSV },
      ], 'commissions');
      toast('success', 'Commission report exported');
    } else if (tab === 'revenue') {
      exportToCSV(revenueData, [
        { key: 'month', header: 'Month' },
        { key: 'revenue', header: 'Revenue', format: fmtCSV },
        { key: 'profit', header: 'Profit', format: fmtCSV },
        { key: 'orders', header: 'Orders' },
      ], 'revenue_summary');
      toast('success', 'Revenue report exported');
    }
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'customer', label: 'By Customer' },
    { key: 'product', label: 'By Product' },
    { key: 'commission', label: 'Commissions' },
    { key: 'revenue', label: 'Revenue Summary' },
  ];

  // Compute unpaid commission total
  const unpaidTotal = commissionData
    .filter((c) => c.status === 'pending')
    .reduce((sum, c) => sum + c.commission_amount, 0);

  const customerCols: Column<CustomerProfit>[] = [
    { key: 'farm_name', header: 'Customer', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.farm_name}</span> },
    { key: 'total_revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_revenue)}</span> },
    { key: 'total_profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.total_profit)}</span> },
    { key: 'margin_pct', header: 'Margin', sortable: true, render: (r) => `${r.margin_pct.toFixed(1)}%` },
    { key: 'order_count', header: 'Orders', sortable: true },
  ];

  const productCols: Column<ProductProfit>[] = [
    { key: 'product_name', header: 'Product', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.product_name}</span> },
    { key: 'total_revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_revenue)}</span> },
    { key: 'total_profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.total_profit)}</span> },
    { key: 'units_sold', header: 'Units Sold', sortable: true },
    { key: 'margin_pct', header: 'Margin', sortable: true, render: (r) => `${r.margin_pct.toFixed(1)}%` },
  ];

  const commissionCols: Column<CommissionRow>[] = [
    ...(isAdmin ? [{
      key: '_select' as keyof CommissionRow,
      header: (
        <input
          type="checkbox"
          checked={selectedCommissions.size > 0 && selectedCommissions.size === commissionData.filter((c) => c.status === 'pending').length}
          onChange={toggleSelectAll}
          className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
        />
      ) as unknown as string,
      render: (r: CommissionRow) => r.status === 'pending' ? (
        <input
          type="checkbox"
          checked={selectedCommissions.has(r.id)}
          onChange={() => toggleCommissionSelect(r.id)}
          className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
        />
      ) : null,
    } as Column<CommissionRow>] : []),
    { key: 'order_date', header: 'Date', sortable: true, render: (r) => new Date(r.order_date).toLocaleDateString() },
    { key: 'recipient', header: 'Recipient', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.recipient}</span> },
    { key: 'commission_amount', header: 'Commission', sortable: true, render: (r) => <span className="font-mono font-medium">{fmt(r.commission_amount)}</span> },
    { key: 'split_percentage', header: 'Split %', sortable: true, render: (r) => `${r.split_percentage}%` },
    { key: 'order_profit', header: 'Order Profit', sortable: true, render: (r) => <span className="font-mono">{fmt(r.order_profit)}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge variant={statusToBadgeVariant[r.status] || 'default'}>{r.status}</Badge> },
    { key: 'paid_date', header: 'Paid', sortable: true, render: (r) => r.paid_date ? new Date(r.paid_date).toLocaleDateString() : '-' },
  ];

  const revenueCols: Column<RevenueSummary>[] = [
    { key: 'month', header: 'Month', sortable: true },
    { key: 'revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.revenue)}</span> },
    { key: 'profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.profit)}</span> },
    { key: 'orders', header: 'Orders', sortable: true },
  ];

  return (
    <div className="space-y-6">
      <SplitHeading title="Reports" accent="& Analytics" />

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map((t) => (
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

      {/* === GAP FIX #8: Date range filters === */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div className="flex gap-1.5">
            {[
              { key: 'all', label: 'All Time' },
              { key: 'this_season', label: 'This Season' },
              { key: 'last_season', label: 'Last Season' },
              { key: 'ytd', label: 'YTD' },
              { key: 'last30', label: 'Last 30 Days' },
              { key: 'last90', label: 'Last 90 Days' },
            ].map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset.key)}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              showChevron={false}
              onClick={handleExportCSV}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      {/* === GAP FIX #9: Commission summary bar === */}
      {tab === 'commission' && (
        <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="text-sm text-amber-800">
              <span className="font-semibold">Unpaid commissions:</span> {fmt(unpaidTotal)}
            </span>
            {selectedCommissions.size > 0 && (
              <span className="text-sm text-secondary">
                {selectedCommissions.size} selected
              </span>
            )}
          </div>
          {isAdmin && selectedCommissions.size > 0 && (
            <Button
              size="sm"
              icon={<CheckCircle2 className="w-4 h-4" />}
              onClick={handleMarkPaid}
              loading={markingPaid}
            >
              Mark as Paid
            </Button>
          )}
        </div>
      )}

      <Card padding={false}>
        <div className="p-5">
          {tab === 'customer' && (
            <DataTable
              data={customerData as unknown as Record<string, unknown>[]}
              columns={customerCols as unknown as Column<Record<string, unknown>>[]}
              searchable
              searchPlaceholder="Search customers..."
              searchKeys={['farm_name']}
              emptyTitle="No customer data"
              loading={loading}
            />
          )}
          {tab === 'product' && (
            <DataTable
              data={productData as unknown as Record<string, unknown>[]}
              columns={productCols as unknown as Column<Record<string, unknown>>[]}
              searchable
              searchPlaceholder="Search products..."
              searchKeys={['product_name']}
              emptyTitle="No product data"
              loading={loading}
            />
          )}
          {tab === 'commission' && (
            <DataTable
              data={commissionData as unknown as Record<string, unknown>[]}
              columns={commissionCols as unknown as Column<Record<string, unknown>>[]}
              emptyTitle="No commissions"
              loading={loading}
            />
          )}
          {tab === 'revenue' && (
            <DataTable
              data={revenueData as unknown as Record<string, unknown>[]}
              columns={revenueCols as unknown as Column<Record<string, unknown>>[]}
              emptyTitle="No revenue data"
              loading={loading}
            />
          )}
        </div>
      </Card>
    </div>
  );
}
